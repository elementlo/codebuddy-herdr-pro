#!/usr/bin/env node
/**
 * codebuddy-herdr-pro reporter for the Herdr desktop app (herdr-app + herdr-core).
 *
 * Reads a CodeBuddy hook payload from stdin and reports the agent state as an
 * OSC 7501 Program Status escape sequence written to the terminal pty that
 * herdr-core reads. Per herdr-app defaults/AGENTS.md: "Agents are terminals
 * whose program reports a status (OSC 7501)". herdr-core has no report RPC;
 * the terminal output stream is the only channel.
 *
 * OSC 7501 wire grammar (spec rev 0.3):
 *
 *   report = ESC ] 7501 ; body ST        ST = ESC \ or BEL
 *   body   = pair *( ":" pair )          pair = key "=" value
 *   value  = [A-Za-z0-9_.,+/=-]*         (no ":" or ";", so nothing escapes)
 *
 * Keys used: state (idle|working|blocked|clear), app, kind (blocked only:
 * permission|question|auth), title and msg (standard base64 of UTF-8).
 * Each report replaces the terminal's record wholesale, and herdr-core drops
 * working/blocked records when the process exits — so no seq, lock, dedup or
 * heartbeat is needed.
 *
 * Design goals:
 *   1. Never break or slow down a CodeBuddy session (every failure swallowed).
 *   2. No-op outside the Herdr app (HC_TERMINAL_SOCKET unset).
 *
 * Compiled output lives in bin/herdr-report.js and is checked in so hooks need
 * neither TypeScript nor any npm dependency at runtime.
 */

import { closeSync, openSync, writeSync } from "node:fs";
import { spawnSync } from "node:child_process";

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/** OSC 7501 "app" key: a stable program name, [A-Za-z0-9_.+-]{1,32}. */
const OSC_APP = "codebuddy";
/** Decoded-byte limits from the spec (rev 0.3). */
const OSC_TITLE_MAX_BYTES = 192;
const OSC_MSG_MAX_BYTES = 2048;
/** Whole OSC sequence must stay under 4096 bytes. */
const OSC_SEQ_MAX_BYTES = 4096;

const PS_TIMEOUT_MS = 1200;
const STDIN_TIMEOUT_MS = 1000;
const HC_TIMEOUT_MS = 3000;

const MAX_MESSAGE_LEN = 200;
const MAX_TITLE_LEN = 80;

type AgentState = "idle" | "working" | "blocked";
/** OSC 7501 "kind" key: only meaningful with blocked. */
type BlockKind = "permission" | "question" | "auth";

interface HookPayload {
  hook_event_name?: unknown;
  notification_type?: unknown;
  message?: unknown;
  reason?: unknown;
  tool_name?: unknown;
  prompt?: unknown;
}

interface Decision {
  kind: "report" | "release" | "none";
  state?: AgentState;
  message?: string;
  title?: string;
  blockKind?: BlockKind;
}

/* ------------------------------------------------------------------ *
 * Small utilities
 * ------------------------------------------------------------------ */

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Strip control characters, collapse whitespace, truncate. */
function sanitizeText(raw: string, maxLen: number): string {
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen - 1) + "…" : cleaned;
}

/* ------------------------------------------------------------------ *
 * OSC 7501 encoding
 * ------------------------------------------------------------------ */

const ESC = "\u001b";
const ST = ESC + "\\";

/** base64 of UTF-8, truncated to the spec's decoded-byte limit. */
function oscB64(text: string, maxDecodedBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  const clipped = buf.length > maxDecodedBytes ? buf.subarray(0, maxDecodedBytes) : buf;
  return clipped.toString("base64");
}

/** Only the spec's value charset is legal; anything else must be dropped. */
function oscSafeValue(value: string): string {
  return value.replace(/[^A-Za-z0-9_.,+/=-]/g, "");
}

interface OscOptions {
  state: AgentState | "clear";
  blockKind?: BlockKind;
  title?: string;
  msg?: string;
}

function buildOsc(opts: OscOptions): string {
  const pairs: string[] = ["state=" + opts.state];
  if (opts.state !== "clear") pairs.push("app=" + oscSafeValue(OSC_APP));
  if (opts.state === "blocked" && opts.blockKind) pairs.push("kind=" + opts.blockKind);
  if (opts.title) pairs.push("title=" + oscB64(opts.title, OSC_TITLE_MAX_BYTES));
  if (opts.msg) pairs.push("msg=" + oscB64(opts.msg, OSC_MSG_MAX_BYTES));

  let seq = ESC + "]7501;" + pairs.join(":") + ST;
  // Hard spec limit: at most 4096 bytes. Drop the optional msg first, then
  // the title, rather than sending an invalid report.
  if (Buffer.byteLength(seq, "utf8") > OSC_SEQ_MAX_BYTES && opts.msg) {
    seq = buildOsc({ ...opts, msg: undefined });
  }
  if (Buffer.byteLength(seq, "utf8") > OSC_SEQ_MAX_BYTES && opts.title) {
    seq = buildOsc({ ...opts, title: undefined });
  }
  return seq;
}

/* ------------------------------------------------------------------ *
 * Terminal discovery
 * ------------------------------------------------------------------ */

/**
 * Find the pty that herdr-core actually reads.
 *
 * CodeBuddy runs hook commands in a nested pty of its own, so writing to
 * /dev/tty reaches that inner pty and herdr-core never sees it. Walk the
 * parent chain and take the outermost controlling terminal — that is the
 * Herdr terminal's pty. Returns a device path, or undefined when there is
 * none.
 */
function findOuterTty(): string | undefined {
  if (process.platform === "win32") return undefined;
  try {
    const out = spawnSync("ps", ["-axo", "pid=,ppid=,tty="], {
      encoding: "utf8",
      timeout: PS_TIMEOUT_MS,
    });
    if (out.error || out.status !== 0 || !out.stdout) return undefined;

    const rows = new Map<string, { ppid: string; tty: string }>();
    for (const line of out.stdout.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)/);
      const [, pidStr, ppidStr, ttyStr] = m ?? [];
      if (pidStr && ppidStr && ttyStr) rows.set(pidStr, { ppid: ppidStr, tty: ttyStr });
    }

    let pid = String(process.pid);
    let outer: string | undefined;
    for (let i = 0; i < 16; i++) {
      const row = rows.get(pid);
      if (!row) break;
      // "??" / "-" means no controlling terminal.
      if (row.tty !== "??" && row.tty !== "-" && row.tty.length > 0) {
        outer = row.tty.startsWith("/") ? row.tty : "/dev/" + row.tty;
      }
      if (row.ppid === pid || row.ppid === "0" || row.ppid === "1") break;
      pid = row.ppid;
    }
    return outer;
  } catch {
    return undefined;
  }
}

function writeTty(device: string, data: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(device, "w");
    writeSync(fd, data);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Emit an OSC sequence. Prefers the outer terminal pty (what herdr-core
 * reads); falls back to our own stdout. HERDR_PRO_OSC_TO_STDOUT=1 forces
 * stdout, which keeps tests deterministic and helps when the outer pty
 * cannot be resolved.
 */
function emitOsc(seq: string): void {
  if (process.env.HERDR_PRO_OSC_TO_STDOUT !== "1") {
    const device = findOuterTty();
    if (device && writeTty(device, seq)) return;
  }
  try {
    process.stdout.write(seq);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ *
 * Hook input
 * ------------------------------------------------------------------ */

function readHook(): Promise<HookPayload> {
  return new Promise<HookPayload>((resolve) => {
    const timer = setTimeout(() => resolve({}), STDIN_TIMEOUT_MS);
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
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
        const parsed: unknown = JSON.parse(text);
        resolve(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as HookPayload) : {});
      } catch {
        resolve({});
      }
    });
  });
}

/* ------------------------------------------------------------------ *
 * Event classification
 *
 * Mirrors the event table Herdr ships for Kimi Code CLI (KIMI_HOOK_EVENTS
 * in herdrdev/herdr), adapted to CodeBuddy's hook events. Generic
 * PreToolUse is intentionally NOT hooked: UserPromptSubmit already marks
 * the turn working, and only AskUserQuestion needs a matcher-scoped
 * blocked transition. That saves one node spawn per tool call.
 * ------------------------------------------------------------------ */

function classify(hook: HookPayload): Decision {
  const event = asString(hook.hook_event_name);
  const tool = asString(hook.tool_name);
  switch (event) {
    case "SessionStart":
      return { kind: "report", state: "idle" };

    case "UserPromptSubmit": {
      const prompt = sanitizeText(asString(hook.prompt), MAX_TITLE_LEN);
      return { kind: "report", state: "working", ...(prompt ? { title: prompt } : {}) };
    }

    case "PreToolUse":
      // hooks.json only matches ^AskUserQuestion$ for this event; the
      // tool_name check keeps the reporter correct if invoked generically.
      if (tool === "AskUserQuestion") {
        return { kind: "report", state: "blocked", blockKind: "question", message: "asking the user a question" };
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
        message: sanitizeText(asString(hook.message) || "permission: " + (tool || "tool"), MAX_MESSAGE_LEN),
      };

    case "Stop":
      return { kind: "report", state: "idle" };

    case "StopFailure": {
      // The turn died on an API error; the user has to decide what next.
      const reason = sanitizeText(asString(hook.reason) || asString(hook.message), MAX_MESSAGE_LEN);
      return { kind: "report", state: "blocked", message: reason ? "turn failed: " + reason : "turn failed" };
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

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

function report(decision: Decision): void {
  emitOsc(
    buildOsc({
      state: decision.state ?? "idle",
      blockKind: decision.blockKind,
      title: decision.title,
      msg: decision.message || undefined,
    }),
  );
}

function release(): void {
  // "clear" removes this program's record. herdr-core also drops the record
  // when the process exits, so this is belt-and-braces.
  emitOsc(buildOsc({ state: "clear" }));
}

/* ------------------------------------------------------------------ *
 * Diagnostics
 * ------------------------------------------------------------------ */

function doctor(): void {
  const info: Record<string, unknown> = {
    hcTerminalSocket: process.env.HC_TERMINAL_SOCKET || "",
    hcTerminalId: process.env.HC_TERMINAL_ID || "",
    insideHerdrApp: Boolean(process.env.HC_TERMINAL_SOCKET),
    outerTty: findOuterTty() || "",
  };
  const term = process.env.HC_TERMINAL_ID;
  try {
    const hc = spawnSync("hc", term ? ["get", term, "--json"] : ["get", "--json"], {
      encoding: "utf8",
      timeout: HC_TIMEOUT_MS,
    });
    if (!hc.error && hc.stdout) {
      const d = JSON.parse(hc.stdout) as Record<string, unknown>;
      info.coreTerminal = { status: d.status, reported: d.reported, turn: d.turn, title: d.title };
    } else {
      info.coreTerminalError = "hc not on PATH or terminal not found";
    }
  } catch {
    info.coreTerminalError = "hc invocation failed";
  }
  process.stdout.write(JSON.stringify(info, null, 2) + "\n");
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (process.argv.includes("--doctor")) {
    doctor();
    return;
  }
  if (!process.env.HC_TERMINAL_SOCKET) return;

  const hook = await readHook();
  const decision = classify(hook);
  if (decision.kind === "none") return;
  if (decision.kind === "release") release();
  else report(decision);
}

main().catch(() => {
  // Hook failures must never affect a CodeBuddy session.
});
