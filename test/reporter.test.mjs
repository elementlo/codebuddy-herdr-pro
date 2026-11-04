import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";

const REPORTER = join(import.meta.dirname, "..", "bin", "herdr-report.js");

const ESC = "\u001b";
const ST = ESC + "\\";

function run(stdinJson, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [REPORTER], {
      env: {
        ...process.env,
        HERDR_ENV: "",
        HERDR_PANE_ID: "",
        HERDR_SOCKET_PATH: "",
        HERDR_BIN_PATH: "",
        HC_TERMINAL_SOCKET: "/tmp/fake-hc.sock",
        HC_TERMINAL_ID: "t1",
        HERDR_PRO_OSC_TO_STDOUT: "1",
        ...extraEnv,
      },
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out }));
    if (stdinJson === null) child.stdin.end();
    else child.stdin.end(JSON.stringify(stdinJson));
  });
}

/** Parse an OSC 7501 body into a key->value map. */
function parseOsc(out) {
  const start = out.indexOf("]7501;");
  if (start < 0) return null;
  const end = out.indexOf(ST, start);
  const body = end >= 0 ? out.slice(start + 6, end) : out.slice(start + 6);
  const pairs = {};
  for (const p of body.split(":")) {
    const i = p.indexOf("=");
    if (i > 0) pairs[p.slice(0, i)] = p.slice(i + 1);
  }
  return pairs;
}

const b64d = (v) => Buffer.from(v, "base64").toString("utf8");

test("no-op outside the Herdr app", async () => {
  const { out, code } = await run({ hook_event_name: "Stop" }, { HC_TERMINAL_SOCKET: "" });
  assert.equal(out, "");
  assert.equal(code, 0);
});

test("SessionStart -> idle", async () => {
  const { out } = await run({ hook_event_name: "SessionStart", session_id: "s1" });
  const p = parseOsc(out);
  assert.equal(p.state, "idle");
  assert.equal(p.app, "codebuddy");
});

test("UserPromptSubmit -> working + base64 title", async () => {
  const { out } = await run({ hook_event_name: "UserPromptSubmit", prompt: "Fix login" });
  const p = parseOsc(out);
  assert.equal(p.state, "working");
  assert.equal(b64d(p.title), "Fix login");
});

test("PermissionRequest -> blocked kind=permission + msg", async () => {
  const { out } = await run({ hook_event_name: "PermissionRequest", tool_name: "Bash", message: "Allow rm?" });
  const p = parseOsc(out);
  assert.equal(p.state, "blocked");
  assert.equal(p.kind, "permission");
  assert.equal(b64d(p.msg), "Allow rm?");
});

test("AskUserQuestion PreToolUse -> blocked kind=question", async () => {
  const { out } = await run({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" });
  const p = parseOsc(out);
  assert.equal(p.state, "blocked");
  assert.equal(p.kind, "question");
});

test("PostToolUse AskUserQuestion -> working", async () => {
  const { out } = await run({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion" });
  assert.equal(parseOsc(out).state, "working");
});

test("SubagentStart / PreCompact / PermissionDenied -> working", async () => {
  for (const ev of ["SubagentStart", "PreCompact", "PermissionDenied"]) {
    const { out } = await run({ hook_event_name: ev });
    assert.equal(parseOsc(out).state, "working", ev);
  }
});

test("Stop -> idle", async () => {
  const { out } = await run({ hook_event_name: "Stop" });
  assert.equal(parseOsc(out).state, "idle");
});

test("StopFailure -> blocked with msg", async () => {
  const { out } = await run({ hook_event_name: "StopFailure", reason: "api_error" });
  const p = parseOsc(out);
  assert.equal(p.state, "blocked");
  assert.match(b64d(p.msg), /turn failed/);
});

test("Notification permission -> blocked; idle_prompt -> idle; auth_success -> none", async () => {
  const a = await run({ hook_event_name: "Notification", notification_type: "permission_prompt", message: "Allow Bash?" });
  assert.equal(parseOsc(a.out).state, "blocked");
  assert.equal(b64d(parseOsc(a.out).msg), "Allow Bash?");

  const b = await run({ hook_event_name: "Notification", notification_type: "idle_prompt" });
  assert.equal(parseOsc(b.out).state, "idle");

  const c = await run({ hook_event_name: "Notification", notification_type: "auth_success" });
  assert.equal(c.out, "");
});

test("SessionEnd -> clear (no app key)", async () => {
  const { out } = await run({ hook_event_name: "SessionEnd" });
  const p = parseOsc(out);
  assert.equal(p.state, "clear");
  assert.equal(p.app, undefined);
});

test("OSC body only contains spec-legal characters", async () => {
  const { out } = await run({ hook_event_name: "PermissionRequest", message: "Allow; rm -rf /: yes?" });
  const start = out.indexOf("]7501;") + 6;
  const body = out.slice(start, out.indexOf(ST, start));
  assert.ok(/^[A-Za-z0-9_.,+/=:-]+$/.test(body), "illegal chars: " + JSON.stringify(body));
});

test("long message is truncated, sequence stays under 4096 bytes", async () => {
  const { out } = await run({ hook_event_name: "StopFailure", reason: "x".repeat(9000) });
  assert.ok(Buffer.byteLength(out, "utf8") <= OSC_LIMIT(), "sequence too long");
  function OSC_LIMIT() { return 4096; }
  const p = parseOsc(out);
  assert.equal(p.state, "blocked");
});

test("malformed stdin does not crash", async () => {
  const child = spawn(process.execPath, [REPORTER], {
    env: { ...process.env, HC_TERMINAL_SOCKET: "/tmp/x.sock", HERDR_PRO_OSC_TO_STDOUT: "1" },
  });
  const code = await new Promise((res) => { child.on("close", res); child.stdin.end("not json {{{"); });
  assert.equal(code, 0);
});

test("--doctor prints diagnostics JSON", async () => {
  const child = spawn(process.execPath, [REPORTER, "--doctor"], {
    env: { ...process.env, HC_TERMINAL_SOCKET: "/tmp/x.sock", HC_TERMINAL_ID: "t1" },
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  const code = await new Promise((res) => { child.on("close", res); child.stdin.end(); });
  assert.equal(code, 0);
  const info = JSON.parse(out);
  assert.equal(info.insideHerdrApp, true);
  assert.equal(info.hcTerminalId, "t1");
});

test("regression: permission blocked is cleared by the next tool's PreToolUse", async () => {
  // PermissionRequest -> blocked; user approves; the tool starts -> PreToolUse
  // (a normal tool, not AskUserQuestion) must report working, not stay blocked.
  const a = await run({ hook_event_name: "PermissionRequest", tool_name: "Bash", message: "Allow rm?" });
  assert.equal(parseOsc(a.out).state, "blocked");
  const b = await run({ hook_event_name: "PreToolUse", tool_name: "Bash" });
  assert.equal(parseOsc(b.out).state, "working");
});

test("regression: AskUserQuestion blocked is cleared by its PostToolUse", async () => {
  const a = await run({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" });
  assert.equal(parseOsc(a.out).state, "blocked");
  const b = await run({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion" });
  assert.equal(parseOsc(b.out).state, "working");
});

test("Elicitation -> blocked(question); ElicitationResult -> working", async () => {
  const a = await run({ hook_event_name: "Elicitation", message: "MCP needs a token" });
  const pa = parseOsc(a.out);
  assert.equal(pa.state, "blocked");
  assert.equal(pa.kind, "question");
  const b = await run({ hook_event_name: "ElicitationResult" });
  assert.equal(parseOsc(b.out).state, "working");
});

test("regression: MCP elicitation blocked is cleared by ElicitationResult", async () => {
  // The pairing that prevents a permanent 'needs you' for MCP input dialogs.
  const a = await run({ hook_event_name: "Elicitation" });
  assert.equal(parseOsc(a.out).state, "blocked");
  const b = await run({ hook_event_name: "ElicitationResult" });
  assert.equal(parseOsc(b.out).state, "working");
});
