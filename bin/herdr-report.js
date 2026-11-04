#!/usr/bin/env node
/**
 * codebuddy-herdr-pro reporter.
 *
 * Reads a CodeBuddy hook payload from stdin and reports the agent state to
 * Herdr. Two Herdr products exist and they report state differently, so the
 * reporter picks a backend from the environment:
 *
 *   Backend "tui"  — the herdr terminal multiplexer (herdr.dev).
 *     Detected by HERDR_ENV=1 + HERDR_PANE_ID. Talks to the local socket API
 *     (HERDR_SOCKET_PATH), falling back to the herdr CLI (HERDR_BIN_PATH).
 *     Protocol layering follows Herdr's own first-party integrations
 *     (src/integration/assets/{claude,kimi}/herdr-agent-state.sh in
 *     herdrdev/herdr):
 *       - Session identity  -> pane.report_agent_session
 *         (agent_session_id, agent_session_path, session_start_source, resume_argv)
 *       - Lifecycle state   -> pane.report_agent   (idle / working / blocked)
 *       - Display metadata  -> pane.report_metadata (sidebar title; never state)
 *       - Exit              -> pane.release_agent
 *
 *   Backend "core" — the Herdr desktop app (herdr-app + herdr-core / hc).
 *     Detected by HC_TERMINAL_SOCKET. herdr-core has no report_agent RPC; per
 *     herdr-app defaults/AGENTS.md, "Agents are terminals whose program reports
 *     a status (OSC 7501)". So state is emitted as an OSC 7501 Program Status
 *     escape sequence written to the terminal's own pty.
 *
 * Outside both, the reporter is a no-op.
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
/**
 * OSC 7501 "app" key: a stable program name, [A-Za-z0-9_.+-]{1,32}. herdr-app
 * shows it as the agent's name.
 */
const OSC_APP = "codebuddy";
/** OSC 7501 decoded-byte limits from the spec (rev 0.3). */
const OSC_TITLE_MAX_BYTES = 192;
const OSC_MSG_MAX_BYTES = 2048;
/** Whole OSC sequence must stay under 4096 bytes. */
const OSC_SEQ_MAX_BYTES = 4096;
/** herdr-core terminal id env var (e.g. "t1"). */
const HC_TERMINAL_ID_ENV = "HC_TERMINAL_ID";
const MAX_MESSAGE_LEN = 200;
const MAX_TITLE_LEN = 80;
const TITLE_TTL_MS = 60 * 60 * 1000;
const MAX_RESUME_ARGS = 64;
const MAX_RESUME_BYTES = 8 * 1024;
/**
 * Herdr normalises session_start_source against a fixed whitelist
 * (herdrdev/herdr src/agent_resume.rs normalize_session_start_source).
 * CodeBuddy SessionStart sources are startup/resume/clear/compact.
 */
const SESSION_START_SOURCES = new Set(["startup", "resume", "clear", "compact", "branch", "new", "fork", "select"]);
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
function sanitizeText(raw, maxLen) {
    const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    return cleaned.length > maxLen ? cleaned.slice(0, maxLen - 1) + "\u2026" : cleaned;
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
 * sessions and agent restarts. Wall-clock nanoseconds give a good base (same
 * approach as Herdr's own kimi hook); the persisted counter additionally fixes
 * same-millisecond collisions and clock rollback.
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
    const p = params;
    const common = [p.pane_id, "--source", p.source, "--agent", p.agent, "--seq", p.seq.toString()];
    switch (method) {
        case "pane.release_agent":
            return ["pane", "release-agent", ...common];
        case "pane.report_agent": {
            const args = ["pane", "report-agent", ...common];
            if (p.state)
                args.push("--state", p.state);
            if (p.message)
                args.push("--message", p.message);
            if (p.agent_session_id)
                args.push("--agent-session-id", p.agent_session_id);
            if (p.agent_session_path)
                args.push("--agent-session-path", p.agent_session_path);
            if (p.resume_argv && validResumeArgv(p.resume_argv))
                args.push("--", ...p.resume_argv);
            return args;
        }
        case "pane.report_agent_session": {
            const args = ["pane", "report-agent-session", ...common];
            if (p.agent_session_id)
                args.push("--agent-session-id", p.agent_session_id);
            if (p.agent_session_path)
                args.push("--agent-session-path", p.agent_session_path);
            if (p.session_start_source)
                args.push("--session-start-source", p.session_start_source);
            if (p.resume_argv && validResumeArgv(p.resume_argv))
                args.push("--", ...p.resume_argv);
            return args;
        }
        case "pane.report_metadata": {
            const m = params;
            return ["pane", "report-metadata", ...common, "--title", m.title, "--ttl-ms", String(m.ttl_ms)];
        }
        default:
            return undefined;
    }
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
    const tool = asString(hook.tool_name);
    switch (event) {
        case "SessionStart":
            return { kind: "report", state: "idle", force: true };
        case "UserPromptSubmit": {
            const prompt = sanitizeText(asString(hook.prompt), MAX_TITLE_LEN);
            return { kind: "report", state: "working", ...(prompt ? { title: prompt } : {}) };
        }
        case "PreToolUse":
            // hooks.json only matches ^AskUserQuestion$ for this event; the tool_name
            // check keeps the reporter correct if it is ever invoked generically.
            if (tool === "AskUserQuestion") {
                return {
                    kind: "report",
                    state: "blocked",
                    blockKind: "question",
                    message: "asking the user a question",
                };
            }
            return { kind: "report", state: "working" };
        case "PostToolUse":
        case "PostToolUseFailure":
        case "PermissionDenied":
        case "SubagentStart":
        case "PreCompact":
            // Clear any blocked state (permission granted, question answered) and
            // keep the turn working. A denied permission does not end the turn.
            return { kind: "report", state: "working" };
        case "PermissionRequest":
            return {
                kind: "report",
                state: "blocked",
                blockKind: "permission",
                message: sanitizeText(asString(hook.message) || `permission: ${tool || "tool"}`, MAX_MESSAGE_LEN),
            };
        case "Stop":
            return { kind: "report", state: "idle" };
        case "StopFailure": {
            // The turn died on an API error; the user has to decide what next.
            const reason = sanitizeText(asString(hook.reason) || asString(hook.message), MAX_MESSAGE_LEN);
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
                    blockKind: /auth/.test(type) ? "auth" : "permission",
                    message: sanitizeText(asString(hook.message), MAX_MESSAGE_LEN) || "needs input",
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
function detectBackend() {
    if (process.env.HERDR_ENV === "1" && process.env.HERDR_PANE_ID)
        return "tui";
    // herdr-core (the Herdr desktop app) injects HC_* instead of HERDR_*.
    if (process.env.HC_TERMINAL_SOCKET)
        return "core";
    return "none";
}
/* ------------------------------------------------------------------ *
 * OSC 7501 (Program Status Protocol) — herdr-core backend
 *
 * herdr-core derives agent status from what the program writes to its own
 * terminal, not from an RPC. Wire grammar (spec rev 0.3):
 *
 *   report = ESC ] 7501 ; body ST        ST = ESC \\  or BEL
 *   body   = pair *( ":" pair )          pair = key "=" value
 *   value  = [A-Za-z0-9_.,+/=-]*         (no ":" or ";", so nothing escapes)
 *
 * Keys used here: state (required), app, kind (blocked only), title and msg
 * (standard base64 of UTF-8). A report replaces its record entirely.
 * ------------------------------------------------------------------ */
const ESC = "\u001b";
const ST = ESC + "\\";
/** base64 of UTF-8, truncated to the spec's decoded-byte limit. */
function oscB64(text, maxDecodedBytes) {
    const buf = Buffer.from(text, "utf8");
    const clipped = buf.length > maxDecodedBytes ? buf.subarray(0, maxDecodedBytes) : buf;
    return clipped.toString("base64");
}
/** Only the spec's value charset is legal; anything else must be dropped. */
function oscSafeValue(value) {
    return value.replace(/[^A-Za-z0-9_.,+/=-]/g, "");
}
function buildOsc(opts) {
    const pairs = [`state=${opts.state}`];
    if (opts.state !== "clear")
        pairs.push(`app=${oscSafeValue(OSC_APP)}`);
    if (opts.state === "blocked" && opts.blockKind)
        pairs.push(`kind=${opts.blockKind}`);
    if (opts.title)
        pairs.push(`title=${oscB64(opts.title, OSC_TITLE_MAX_BYTES)}`);
    if (opts.msg)
        pairs.push(`msg=${oscB64(opts.msg, OSC_MSG_MAX_BYTES)}`);
    let seq = `${ESC}]7501;${pairs.join(":")}${ST}`;
    // Hard spec limit: the whole sequence is at most 4096 bytes. Drop the
    // optional msg first, then the title, rather than sending an invalid report.
    if (Buffer.byteLength(seq, "utf8") > OSC_SEQ_MAX_BYTES && opts.msg) {
        seq = buildOsc({ ...opts, msg: undefined });
    }
    if (Buffer.byteLength(seq, "utf8") > OSC_SEQ_MAX_BYTES && opts.title) {
        seq = buildOsc({ ...opts, title: undefined });
    }
    return seq;
}
/**
 * Find the pty that herdr-core actually reads.
 *
 * CodeBuddy runs hook commands in a nested pty of its own, so writing to
 * /dev/tty reaches that inner pty and herdr-core never sees it. Walk the parent
 * chain and take the outermost controlling terminal — that is the Herdr
 * terminal's pty. Returns a device path, or undefined when there is none.
 */
function findOuterTty() {
    if (process.platform === "win32")
        return undefined;
    try {
        const out = spawnSync("ps", ["-axo", "pid=,ppid=,tty="], {
            encoding: "utf8",
            timeout: CLI_TIMEOUT_MS,
        });
        if (out.error || out.status !== 0 || !out.stdout)
            return undefined;
        const rows = new Map();
        for (const line of out.stdout.split("\n")) {
            const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)/);
            const [, pidStr, ppidStr, ttyStr] = m ?? [];
            if (pidStr && ppidStr && ttyStr)
                rows.set(pidStr, { ppid: ppidStr, tty: ttyStr });
        }
        let pid = String(process.pid);
        let outer;
        for (let i = 0; i < 16; i++) {
            const row = rows.get(pid);
            if (!row)
                break;
            // "??" / "-" means no controlling terminal.
            if (row.tty !== "??" && row.tty !== "-" && row.tty.length > 0) {
                outer = row.tty.startsWith("/") ? row.tty : `/dev/${row.tty}`;
            }
            if (row.ppid === pid || row.ppid === "0" || row.ppid === "1")
                break;
            pid = row.ppid;
        }
        return outer;
    }
    catch {
        return undefined;
    }
}
function writeTty(device, data) {
    let fd;
    try {
        fd = openSync(device, "w");
        writeSync(fd, data);
        return true;
    }
    catch {
        return false;
    }
    finally {
        if (fd !== undefined) {
            try {
                closeSync(fd);
            }
            catch {
                /* ignore */
            }
        }
    }
}
/* ------------------------------------------------------------------ *
 * herdr-core backend: emit OSC 7501 to the outer terminal pty
 *
 * herdr-core keeps no seq and needs no lock: each report replaces the
 * terminal's record wholesale, and the terminal drops working/blocked records
 * on its own when the process exits or a new shell prompt begins. So this
 * backend is stateless — no state file, no dedup, no heartbeat.
 * ------------------------------------------------------------------ */
/**
 * Emit an OSC sequence. Prefers the outer terminal pty (what herdr-core reads);
 * falls back to our own stdout. HERDR_PRO_OSC_TO_STDOUT=1 forces stdout, which
 * keeps tests deterministic and helps when the outer pty cannot be resolved.
 */
function emitOsc(seq) {
    if (process.env.HERDR_PRO_OSC_TO_STDOUT !== "1") {
        const device = findOuterTty();
        if (device && writeTty(device, seq))
            return;
    }
    try {
        process.stdout.write(seq);
    }
    catch {
        /* ignore */
    }
}
function coreReport(decision) {
    const state = decision.state ?? "idle";
    // msg is one line of current status; reuse the TUI backend's message.
    emitOsc(buildOsc({ state, blockKind: decision.blockKind, title: decision.title, msg: decision.message || undefined }));
}
function coreRelease() {
    // "clear" removes this program's record. herdr-core also drops the record
    // when the process exits, so this is belt-and-braces.
    emitOsc(buildOsc({ state: "clear" }));
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
    let sessionParams;
    let titleParams;
    try {
        const prev = locked ? readState(sPath) : { ...EMPTY_STATE };
        const state = decision.state ?? "idle";
        const message = decision.message ?? "";
        const effectiveSession = sessionId || prev.sessionId;
        // Session change is reported through pane.report_agent_session, the same
        // split Herdr's own claude/kimi integrations use.
        const sessionChanged = Boolean(sessionId) && sessionId !== prev.sessionId;
        const stateChanged = state !== prev.state || message !== prev.message;
        const stale = Date.now() - prev.sentAt > HEARTBEAT_MS;
        let seq = nextSeq(prev);
        if (sessionChanged) {
            sessionParams = {
                pane_id: pane,
                source: SOURCE,
                agent: AGENT,
                seq,
                agent_session_id: sessionId,
            };
            if (transcript)
                sessionParams.agent_session_path = transcript;
            const startSource = asString(hook.source).trim();
            if (SESSION_START_SOURCES.has(startSource))
                sessionParams.session_start_source = startSource;
            const argv = [RESUME_BIN, "--resume", sessionId];
            if (validResumeArgv(argv))
                sessionParams.resume_argv = argv;
            seq = seq + 1n;
        }
        if (decision.force || stateChanged || stale || sessionChanged) {
            params = {
                pane_id: pane,
                source: SOURCE,
                agent: AGENT,
                state,
                seq,
                ...(message ? { message } : {}),
                ...(effectiveSession ? { agent_session_id: effectiveSession } : {}),
            };
            seq = seq + 1n;
        }
        if (decision.title) {
            titleParams = {
                pane_id: pane,
                source: SOURCE,
                agent: AGENT,
                seq,
                title: decision.title,
                ttl_ms: TITLE_TTL_MS,
            };
        }
        // Persist only when something is actually sent, so deduped events cost no
        // disk write. seq recorded is the highest one used (title > state > session
        // by allocation order), so a metadata-only update still advances the
        // persisted seq and the next state report cannot regress below it.
        if (locked && (params || sessionParams || titleParams)) {
            const lastSeq = titleParams ? titleParams.seq : params ? params.seq : sessionParams.seq;
            writeState(sPath, {
                seq: lastSeq.toString(),
                state: params ? state : prev.state,
                message: params ? message : prev.message,
                sessionId: effectiveSession,
                sentAt: params ? Date.now() : prev.sentAt,
            });
        }
    }
    finally {
        if (locked)
            releaseLock(lPath);
    }
    // Order matters: identity first (so the pane is held under our source),
    // then state, then display-only metadata.
    if (sessionParams)
        await send("pane.report_agent_session", sessionParams);
    if (params)
        await send("pane.report_agent", params);
    if (titleParams)
        await send("pane.report_metadata", titleParams);
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
    const backend = detectBackend();
    const info = {
        backend,
        herdrEnv: process.env.HERDR_ENV ?? "",
        paneId: pane,
        binPath: process.env.HERDR_BIN_PATH ?? "",
        socketPath: process.env.HERDR_SOCKET_PATH ?? "",
        hcTerminalSocket: process.env.HC_TERMINAL_SOCKET ?? "",
        hcTerminalId: process.env[HC_TERMINAL_ID_ENV] ?? "",
        outerTty: backend === "core" ? findOuterTty() ?? "" : "",
        insideHerdr: backend !== "none",
        stateFile: pane ? statePath(pane) : "",
        persistedState: pane ? readState(statePath(pane)) : null,
    };
    if (backend === "core") {
        const term = process.env[HC_TERMINAL_ID_ENV];
        const hc = spawnSync("hc", term ? ["get", term, "--json"] : ["get", "--json"], {
            encoding: "utf8",
            timeout: 3000,
        });
        if (!hc.error) {
            try {
                const d = JSON.parse(hc.stdout);
                info.coreTerminal = { status: d.status, reported: d.reported, turn: d.turn, title: d.title };
            }
            catch {
                info.coreTerminalRaw = (hc.stdout || hc.stderr || "").trim().slice(0, 2000);
            }
        }
        else {
            info.coreTerminalError = "hc not on PATH or terminal not found";
        }
    }
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
    const backend = detectBackend();
    if (backend === "none")
        return;
    const hook = await readHook();
    const decision = classify(hook);
    if (decision.kind === "none")
        return;
    if (backend === "core") {
        if (decision.kind === "release")
            coreRelease();
        else
            coreReport(decision);
        return;
    }
    const pane = process.env.HERDR_PANE_ID;
    if (!pane)
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
