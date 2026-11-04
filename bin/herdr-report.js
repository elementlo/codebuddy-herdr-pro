#!/usr/bin/env node
/**
 * codebuddy-herdr-pro reporter.
 *
 * Reads a CodeBuddy hook payload from stdin and reports the agent state to
 * Herdr through its local socket API (HERDR_SOCKET_PATH), falling back to the
 * Herdr CLI (HERDR_BIN_PATH) when the socket is unavailable.
 *
 * Design goals, in order:
 *   1. Never break or slow down a CodeBuddy session (every failure is swallowed).
 *   2. Never emit an out-of-order report (monotonic per-pane seq, persisted).
 *   3. Never emit a redundant report (state dedup + heartbeat refresh).
 *
 * Compiled output lives in bin/herdr-report.js and is checked in so hooks need
 * neither TypeScript nor any npm dependency at runtime.
 */
import { closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync, } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */
/** Stable, plugin-owned integration source. Must not use the reserved "herdr:" prefix. */
const SOURCE = "codebuddy-pro";
/** User-visible agent name in the Herdr sidebar. */
const AGENT = "CodeBuddy";
/** First word of the resume command; must be a plain command name on PATH. */
const RESUME_BIN = "codebuddy";
const SOCKET_TIMEOUT_MS = 400;
const CLI_TIMEOUT_MS = 1200;
const STDIN_TIMEOUT_MS = 1000;
const LOCK_TIMEOUT_MS = 250;
const STALE_LOCK_MS = 5000;
/**
 * Re-report an unchanged state after this long. Herdr clears agent records when
 * its server restarts; a periodic refresh lets a long-running session reappear
 * without waiting for the next state transition.
 */
const HEARTBEAT_MS = 5 * 60 * 1000;
const MAX_MESSAGE_LEN = 200;
const MAX_RESUME_ARGS = 64;
const MAX_RESUME_BYTES = 8 * 1024;
const EMPTY_STATE = { seq: "0", state: "", message: "", sessionId: "", sentAt: 0 };
/* ------------------------------------------------------------------ *
 * Small utilities
 * ------------------------------------------------------------------ */
function asString(value) {
    return typeof value === "string" ? value : "";
}
/** Synchronous sleep that does not spawn a process. */
function sleepMs(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function stateDir() {
    return process.env.TMPDIR || tmpdir();
}
/**
 * Pane IDs normally only contain ':' as punctuation. Sanitising keeps an
 * unexpected value from escaping the temp directory.
 */
function safePane(pane) {
    return pane.replace(/[^A-Za-z0-9._-]/g, "_") || "none";
}
function statePath(pane) {
    return join(stateDir(), `herdr-codebuddy-pro-${safePane(pane)}.json`);
}
function lockPath(pane) {
    return join(stateDir(), `herdr-codebuddy-pro-${safePane(pane)}.lock`);
}
/** Strip control characters and collapse whitespace, then truncate. */
function sanitizeMessage(raw) {
    const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    return cleaned.length > MAX_MESSAGE_LEN ? cleaned.slice(0, MAX_MESSAGE_LEN - 1) + "\u2026" : cleaned;
}
/* ------------------------------------------------------------------ *
 * Locking
 *
 * Node core exposes no flock(2). An O_EXCL create is atomic on both POSIX and
 * Windows, so it makes a serviceable mutex. Stale locks (a reporter killed
 * mid-write) are reclaimed by age so a crash cannot wedge the pane forever.
 * ------------------------------------------------------------------ */
function acquireLock(path) {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
        try {
            const fd = openSync(path, "wx");
            try {
                writeSync(fd, String(process.pid));
            }
            finally {
                closeSync(fd);
            }
            return true;
        }
        catch {
            try {
                if (Date.now() - statSync(path).mtimeMs > STALE_LOCK_MS) {
                    unlinkSync(path);
                    continue;
                }
            }
            catch {
                continue; // Lock vanished between create and stat: retry at once.
            }
            if (Date.now() >= deadline)
                return false;
            sleepMs(4);
        }
    }
}
function releaseLock(path) {
    try {
        unlinkSync(path);
    }
    catch {
        /* already gone */
    }
}
function readState(path) {
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (!parsed || typeof parsed !== "object")
            return { ...EMPTY_STATE };
        const p = parsed;
        return {
            seq: typeof p.seq === "string" && /^\d+$/.test(p.seq) ? p.seq : "0",
            state: p.state === "idle" || p.state === "working" || p.state === "blocked" ? p.state : "",
            message: typeof p.message === "string" ? p.message : "",
            sessionId: typeof p.sessionId === "string" ? p.sessionId : "",
            sentAt: typeof p.sentAt === "number" && Number.isFinite(p.sentAt) ? p.sentAt : 0,
        };
    }
    catch {
        return { ...EMPTY_STATE };
    }
}
/** Atomic write: temp file in the same directory, then rename(2). */
function writeState(path, state) {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), "utf8");
    renameSync(tmp, path);
}
/* ------------------------------------------------------------------ *
 * Sequence numbers
 *
 * Herdr ignores any report whose seq is not greater than the last accepted one
 * from the same source, so seq must be strictly increasing across processes,
 * sessions and agent restarts. Wall-clock nanoseconds give a good base; the
 * persisted counter fixes same-millisecond collisions and clock rollback.
 * ------------------------------------------------------------------ */
function seqBase() {
    return BigInt(Date.now()) * 1000000n + (process.hrtime.bigint() % 1000000n);
}
function nextSeq(prev) {
    const base = seqBase();
    let last = 0n;
    try {
        last = BigInt(prev.seq);
    }
    catch {
        last = 0n;
    }
    return base > last ? base : last + 1n;
}
/* ------------------------------------------------------------------ *
 * Resume command validation (Herdr rejects invalid_resume_argv otherwise)
 * ------------------------------------------------------------------ */
function validResumeArgv(argv) {
    if (argv.length === 0 || argv.length > MAX_RESUME_ARGS)
        return false;
    const first = argv[0];
    if (typeof first !== "string" || first.length === 0)
        return false;
    // First word must be a bare command name resolvable on PATH, not a path.
    if (first.includes("/") || first.includes("\\"))
        return false;
    let bytes = 0;
    for (const arg of argv) {
        if (typeof arg !== "string")
            return false;
        if (/[\u0000-\u001f\u007f']/.test(arg))
            return false;
        bytes += Buffer.byteLength(arg, "utf8") + 1;
    }
    return bytes <= MAX_RESUME_BYTES;
}
/* ------------------------------------------------------------------ *
 * Transport: socket first, CLI as fallback
 * ------------------------------------------------------------------ */
function requestLine(method, params) {
    // JSON.stringify cannot encode BigInt. Serialise seq separately so it stays a
    // JSON number rather than a rounded Number or a quoted string.
    const { seq, ...rest } = params;
    const head = JSON.stringify({ id: `${SOURCE}:${Date.now()}:${process.pid}`, method });
    const body = JSON.stringify(rest);
    return `${head.slice(0, -1)},"params":${body.slice(0, -1)},"seq":${seq.toString()}}}\n`;
}
function sendSocket(socketPath, line) {
    return new Promise((resolve) => {
        let settled = false;
        let client;
        const finish = (ok) => {
            if (settled)
                return;
            settled = true;
            try {
                client.destroy();
            }
            catch {
                /* ignore */
            }
            resolve(ok);
        };
        try {
            client = net.createConnection({ path: socketPath });
        }
        catch {
            resolve(false);
            return;
        }
        client.setTimeout(SOCKET_TIMEOUT_MS, () => finish(false));
        client.once("error", () => finish(false));
        // Herdr replies with a short acknowledgement. Waiting for it (or EOF)
        // avoids resetting the connection while the server is still writing.
        client.once("data", () => finish(true));
        client.once("end", () => finish(true));
        client.once("close", () => finish(false));
        client.once("connect", () => {
            client.write(line, (err) => {
                if (err)
                    finish(false);
                else
                    client.end();
            });
        });
    });
}
function cliArgs(method, params) {
    const bin = process.env.HERDR_BIN_PATH;
    if (!bin)
        return undefined;
    const common = [params.pane_id, "--source", params.source, "--agent", params.agent, "--seq", params.seq.toString()];
    if (method === "pane.release_agent")
        return ["pane", "release-agent", ...common];
    if (method !== "pane.report_agent")
        return undefined;
    const args = ["pane", "report-agent", ...common];
    if (params.state)
        args.push("--state", params.state);
    if (params.message)
        args.push("--message", params.message);
    if (params.agent_session_id)
        args.push("--agent-session-id", params.agent_session_id);
    if (params.resume_argv && validResumeArgv(params.resume_argv))
        args.push("--", ...params.resume_argv);
    return args;
}
/**
 * Detached + unref'd so the CLI child survives our exit without keeping the
 * hook process (and therefore the agent turn) alive.
 */
function sendCli(args) {
    const bin = process.env.HERDR_BIN_PATH;
    if (!bin)
        return;
    try {
        const child = spawn(bin, args, {
            detached: true,
            stdio: "ignore",
            timeout: CLI_TIMEOUT_MS,
        });
        child.on("error", () => {
            /* ignore */
        });
        child.unref();
    }
    catch {
        /* ignore */
    }
}
async function send(method, params) {
    const socketPath = process.env.HERDR_SOCKET_PATH;
    if (socketPath) {
        const ok = await sendSocket(socketPath, requestLine(method, params));
        if (ok)
            return true;
    }
    const args = cliArgs(method, params);
    if (!args)
        return false;
    const bin = process.env.HERDR_BIN_PATH;
    if (!bin)
        return false;
    // Verify the CLI is actually runnable before detaching, so a missing binary
    // does not silently swallow every report.
    try {
        const probe = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: CLI_TIMEOUT_MS });
        if (probe.error || probe.status !== 0)
            return false;
    }
    catch {
        return false;
    }
    sendCli(args);
    return true;
}
/* ------------------------------------------------------------------ *
 * Hook input
 * ------------------------------------------------------------------ */
function readHook() {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve({}), STDIN_TIMEOUT_MS);
        const chunks = [];
        process.stdin.on("data", (c) => chunks.push(c));
        process.stdin.on("error", () => {
            clearTimeout(timer);
            resolve({});
        });
        process.stdin.on("end", () => {
            clearTimeout(timer);
            try {
                const text = Buffer.concat(chunks).toString("utf8").trim();
                if (!text) {
                    resolve({});
                    return;
                }
                const parsed = JSON.parse(text);
                resolve(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {});
            }
            catch {
                resolve({});
            }
        });
    });
}
function classify(hook) {
    const event = asString(hook.hook_event_name);
    switch (event) {
        case "SessionStart":
            return { kind: "report", state: "idle", force: true };
        case "UserPromptSubmit":
        case "PreToolUse":
        case "PostToolUse":
        case "PostToolUseFailure":
        case "PermissionDenied":
            // A denied permission does not end the turn: the model keeps going.
            return { kind: "report", state: "working" };
        case "PermissionRequest":
            return {
                kind: "report",
                state: "blocked",
                message: sanitizeMessage(asString(hook.message) || `permission: ${asString(hook.tool_name) || "tool"}`),
            };
        case "Stop":
            return { kind: "report", state: "idle" };
        case "StopFailure": {
            // The turn died on an API error; the user has to decide what next.
            const reason = sanitizeMessage(asString(hook.reason) || asString(hook.message));
            return { kind: "report", state: "blocked", message: reason ? `turn failed: ${reason}` : "turn failed" };
        }
        case "Notification": {
            const type = asString(hook.notification_type).toLowerCase();
            if (!type || type === "idle_prompt") {
                // idle_prompt means the turn finished and the agent awaits input. The
                // "prompt" substring must not misclassify it as blocked, or the wrong
                // state sticks until the next turn.
                return { kind: "report", state: "idle" };
            }
            if (/(permission|elicitation|decision|confirm|approval)/.test(type)) {
                return {
                    kind: "report",
                    state: "blocked",
                    message: sanitizeMessage(asString(hook.message)) || "needs input",
                };
            }
            // auth_success and friends carry no state change.
            return { kind: "none" };
        }
        case "SessionEnd":
            return { kind: "release" };
        default:
            return { kind: "none" };
    }
}
/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */
async function report(pane, hook, decision) {
    const sPath = statePath(pane);
    const lPath = lockPath(pane);
    const sessionId = asString(hook.session_id);
    const transcript = asString(hook.transcript_path);
    const locked = acquireLock(lPath);
    let params;
    try {
        const prev = locked ? readState(sPath) : { ...EMPTY_STATE };
        const seq = nextSeq(prev);
        const state = decision.state ?? "idle";
        const message = decision.message ?? "";
        // Session change must always be reported: it carries the resume command.
        const sessionChanged = Boolean(sessionId) && sessionId !== prev.sessionId;
        const stateChanged = state !== prev.state || message !== prev.message;
        const stale = Date.now() - prev.sentAt > HEARTBEAT_MS;
        if (!decision.force && !stateChanged && !sessionChanged && !stale) {
            // Nothing to do. Persist the seq we burned so it is never reused.
            if (locked)
                writeState(sPath, { ...prev, seq: seq.toString() });
            return;
        }
        params = {
            pane_id: pane,
            source: SOURCE,
            agent: AGENT,
            state,
            seq,
            ...(message ? { message } : {}),
        };
        const effectiveSession = sessionId || prev.sessionId;
        if (effectiveSession) {
            const argv = [RESUME_BIN, "--resume", effectiveSession];
            if (validResumeArgv(argv)) {
                params.agent_session_id = effectiveSession;
                params.resume_argv = argv;
            }
        }
        if (transcript)
            params.agent_session_path = transcript;
        if (locked) {
            writeState(sPath, {
                seq: seq.toString(),
                state,
                message,
                sessionId: effectiveSession,
                sentAt: Date.now(),
            });
        }
    }
    finally {
        if (locked)
            releaseLock(lPath);
    }
    await send("pane.report_agent", params);
}
async function release(pane) {
    const sPath = statePath(pane);
    const lPath = lockPath(pane);
    const locked = acquireLock(lPath);
    let params;
    try {
        const prev = locked ? readState(sPath) : { ...EMPTY_STATE };
        const seq = nextSeq(prev);
        params = { pane_id: pane, source: SOURCE, agent: AGENT, seq };
        if (locked) {
            writeState(sPath, { ...EMPTY_STATE, seq: seq.toString() });
        }
    }
    finally {
        if (locked)
            releaseLock(lPath);
    }
    await send("pane.release_agent", params);
}
async function doctor() {
    const pane = process.env.HERDR_PANE_ID ?? "";
    const info = {
        herdrEnv: process.env.HERDR_ENV ?? "",
        paneId: pane,
        binPath: process.env.HERDR_BIN_PATH ?? "",
        socketPath: process.env.HERDR_SOCKET_PATH ?? "",
        insideHerdr: process.env.HERDR_ENV === "1" && Boolean(pane),
        stateFile: pane ? statePath(pane) : "",
        persistedState: pane ? readState(statePath(pane)) : null,
    };
    if (pane) {
        const bin = process.env.HERDR_BIN_PATH;
        if (bin) {
            for (const args of [["agent", "list"], ["pane", "get", pane]]) {
                try {
                    const r = spawnSync(bin, args, { encoding: "utf8", timeout: 3000 });
                    info[`cli_${args.join("_")}`] = (r.stdout || r.stderr || "").trim().slice(0, 4000);
                }
                catch {
                    /* ignore */
                }
            }
        }
        if (process.env.HERDR_SOCKET_PATH) {
            info.socketReachable = await sendSocket(process.env.HERDR_SOCKET_PATH, `${JSON.stringify({ id: "doctor", method: "ping" })}\n`);
        }
    }
    process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
}
async function main() {
    if (process.argv.includes("--doctor")) {
        await doctor();
        return;
    }
    if (process.env.HERDR_ENV !== "1")
        return;
    const pane = process.env.HERDR_PANE_ID;
    if (!pane)
        return;
    const hook = await readHook();
    const decision = classify(hook);
    if (decision.kind === "none")
        return;
    if (decision.kind === "release") {
        await release(pane);
        return;
    }
    await report(pane, hook, decision);
}
main().catch(() => {
    // Hook failures must never affect a CodeBuddy session.
});
