import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPORTER = join(import.meta.dirname, "..", "bin", "herdr-report.js");

/**
 * Fake Herdr server. Collects each request twice: the JSON.parse'd object
 * (convenient for field assertions) and the raw line (so seq — a nanosecond
 * timestamp beyond Number.MAX_SAFE_INTEGER — can be compared exactly as text).
 */
function startFakeHerdr() {
  const requests = [];
  const rawSeqs = [];
  const server = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const m = line.match(/"seq":(\d+)/);
        rawSeqs.push(m ? m[1] : null);
        try { requests.push(JSON.parse(line)); } catch { requests.push({ raw: line }); }
      }
    });
    conn.on("end", () => { conn.end('{\"ok\":true}\n'); });
  });
  return new Promise((resolve) => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-test-"));
    const sockPath = join(dir, "herdr.sock");
    server.listen(sockPath, () => resolve({ server, requests, rawSeqs, sockPath, dir }));
  });
}

function runReporter(env, stdinJson) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [REPORTER], { env: { ...process.env, ...env } });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out }));
    if (stdinJson !== null) child.stdin.end(JSON.stringify(stdinJson));
    else child.stdin.end();
  });
}

function baseEnv(fake, tmp, pane = "w1:p1") {
  return {
    HERDR_ENV: "1",
    HERDR_PANE_ID: pane,
    HERDR_SOCKET_PATH: fake.sockPath,
    HERDR_BIN_PATH: "",
    TMPDIR: tmp,
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Send SessionStart to establish identity, then clear captured requests. */
async function establishSession(env, fake, sid = "s1") {
  await runReporter(env, { hook_event_name: "SessionStart", session_id: sid, source: "startup" });
  await wait(120);
  fake.requests.length = 0;
  fake.rawSeqs.length = 0;
}

test("no-op outside Herdr", async (t) => {
  const fake = await startFakeHerdr();
  t.after(() => { fake.server.close(); rmSync(fake.dir, { recursive: true, force: true }); });
  await runReporter({ HERDR_ENV: "", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: fake.sockPath, TMPDIR: fake.dir }, { hook_event_name: "Stop" });
  await wait(50);
  assert.equal(fake.requests.length, 0);
});

test("SessionStart: report_agent_session (identity+resume) then report_agent (idle)", async (t) => {
  const fake = await startFakeHerdr();
  const tmp = mkdtempSync(join(tmpdir(), "herdr-state-"));
  t.after(() => { fake.server.close(); rmSync(fake.dir, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true }); });
  await runReporter(baseEnv(fake, tmp), {
    hook_event_name: "SessionStart",
    session_id: "sess-abc",
    transcript_path: "/tmp/t.jsonl",
    source: "startup",
  });
  await wait(150);
  assert.equal(fake.requests.length, 2);
  const [sess, state] = fake.requests;
  assert.equal(sess.method, "pane.report_agent_session");
  assert.equal(sess.params.agent_session_id, "sess-abc");
  assert.equal(sess.params.agent_session_path, "/tmp/t.jsonl");
  assert.equal(sess.params.session_start_source, "startup");
  assert.deepEqual(sess.params.resume_argv, ["codebuddy", "--resume", "sess-abc"]);
  assert.equal(sess.params.source, "codebuddy-pro");
  assert.equal(state.method, "pane.report_agent");
  assert.equal(state.params.state, "idle");
  assert.equal(state.params.agent_session_id, "sess-abc");
  // seq compared as exact text (nanosecond values exceed Number precision).
  assert.ok(BigInt(fake.rawSeqs[1]) > BigInt(fake.rawSeqs[0]), "state seq must exceed session seq");
});

test("unknown session_start_source is dropped (Herdr whitelist)", async (t) => {
  const fake = await startFakeHerdr();
  const tmp = mkdtempSync(join(tmpdir(), "herdr-state-"));
  t.after(() => { fake.server.close(); rmSync(fake.dir, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true }); });
  await runReporter(baseEnv(fake, tmp), { hook_event_name: "SessionStart", session_id: "s1", source: "weird" });
  await wait(100);
  assert.equal(fake.requests[0].params.session_start_source, undefined);
});

test("UserPromptSubmit: working + report_metadata title", async (t) => {
  const fake = await startFakeHerdr();
  const tmp = mkdtempSync(join(tmpdir(), "herdr-state-"));
  t.after(() => { fake.server.close(); rmSync(fake.dir, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true }); });
  const env = baseEnv(fake, tmp);
  await establishSession(env, fake);
  await runReporter(env, { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: "Fix the login bug" });
  await wait(150);
  const methods = fake.requests.map((r) => r.method);
  assert.deepEqual(methods, ["pane.report_agent", "pane.report_metadata"]);
  assert.equal(fake.requests[0].params.state, "working");
  assert.equal(fake.requests[1].params.title, "Fix the login bug");
  assert.equal(fake.requests[1].params.ttl_ms, 3600000);
});

test("AskUserQuestion PreToolUse -> blocked; PostToolUse -> working", async (t) => {
  const fake = await startFakeHerdr();
  const tmp = mkdtempSync(join(tmpdir(), "herdr-state-"));
  t.after(() => { fake.server.close(); rmSync(fake.dir, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true }); });
  const env = baseEnv(fake, tmp);
  await establishSession(env, fake);
  await runReporter(env, { hook_event_name: "UserPromptSubmit", session_id: "s1" });
  await runReporter(env, { hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", session_id: "s1" });
  await runReporter(env, { hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", session_id: "s1" });
  await wait(200);
  const states = fake.requests.map((r) => r.params.state);
  assert.deepEqual(states, ["working", "blocked", "working"]);
  assert.equal(fake.requests[1].params.message, "asking the user a question");
});

test("state dedup: repeated working events send once", async (t) => {
  const fake = await startFakeHerdr();
  const tmp = mkdtempSync(join(tmpdir(), "herdr-state-"));
  t.after(() => { fake.server.close(); rmSync(fake.dir, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true }); });
  const env = baseEnv(fake, tmp);
  await establishSession(env, fake);
  await runReporter(env, { hook_event_name: "UserPromptSubmit", session_id: "s1" });
  await runReporter(env, { hook_event_name: "SubagentStart", session_id: "s1" });
  await runReporter(env, { hook_event_name: "PreCompact", session_id: "s1" });
  await runReporter(env, { hook_event_name: "PermissionDenied", session_id: "s1" });
  await wait(200);
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].params.state, "working");
});

test("seq strictly increases across processes and requests", async (t) => {
  const fake = await startFakeHerdr();
  const tmp = mkdtempSync(join(tmpdir(), "herdr-state-"));
  t.after(() => { fake.server.close(); rmSync(fake.dir, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true }); });
  const env = baseEnv(fake, tmp);
  await runReporter(env, { hook_event_name: "SessionStart", session_id: "s1" });
  await runReporter(env, { hook_event_name: "UserPromptSubmit", session_id: "s1" });
  await runReporter(env, { hook_event_name: "Stop", session_id: "s1" });
  await wait(200);
  const seqs = fake.rawSeqs.map((s) => BigInt(s));
  assert.ok(seqs.length >= 3);
  for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], `seq not increasing at ${i}: ${fake.rawSeqs}`);
});

test("Notification permission -> blocked with message; idle_prompt -> idle", async (t) => {
  const fake = await startFakeHerdr();
  const tmp = mkdtempSync(join(tmpdir(), "herdr-state-"));
  t.after(() => { fake.server.close(); rmSync(fake.dir, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true }); });
  const env = baseEnv(fake, tmp);
  await establishSession(env, fake);
  await runReporter(env, { hook_event_name: "Notification", notification_type: "permission_prompt", message: "Allow Bash?", session_id: "s1" });
  await runReporter(env, { hook_event_name: "Notification", notification_type: "idle_prompt", session_id: "s1" });
  await wait(150);
  assert.equal(fake.requests.length, 2);
  assert.equal(fake.requests[0].params.state, "blocked");
  assert.equal(fake.requests[0].params.message, "Allow Bash?");
  assert.equal(fake.requests[1].params.state, "idle");
});

test("StopFailure -> blocked", async (t) => {
  const fake = await startFakeHerdr();
  const tmp = mkdtempSync(join(tmpdir(), "herdr-state-"));
  t.after(() => { fake.server.close(); rmSync(fake.dir, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true }); });
  const env = baseEnv(fake, tmp);
  await establishSession(env, fake);
  await runReporter(env, { hook_event_name: "StopFailure", reason: "api_error", session_id: "s1" });
  await wait(100);
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].params.state, "blocked");
  assert.match(fake.requests[0].params.message, /turn failed/);
});

test("SessionEnd releases the pane", async (t) => {
  const fake = await startFakeHerdr();
  const tmp = mkdtempSync(join(tmpdir(), "herdr-state-"));
  t.after(() => { fake.server.close(); rmSync(fake.dir, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true }); });
  const env = baseEnv(fake, tmp);
  await establishSession(env, fake);
  await runReporter(env, { hook_event_name: "SessionEnd", session_id: "s1" });
  await wait(120);
  const last = fake.requests[fake.requests.length - 1];
  assert.equal(last.method, "pane.release_agent");
  assert.equal(last.params.source, "codebuddy-pro");
});

test("remembered session id rides on later state reports", async (t) => {
  const fake = await startFakeHerdr();
  const tmp = mkdtempSync(join(tmpdir(), "herdr-state-"));
  t.after(() => { fake.server.close(); rmSync(fake.dir, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true }); });
  const env = baseEnv(fake, tmp);
  await establishSession(env, fake, "s9");
  await runReporter(env, { hook_event_name: "UserPromptSubmit" });
  await wait(120);
  const working = fake.requests.find((r) => r.params.state === "working");
  assert.equal(working.params.agent_session_id, "s9");
});

test("session switch re-reports identity with new resume command", async (t) => {
  const fake = await startFakeHerdr();
  const tmp = mkdtempSync(join(tmpdir(), "herdr-state-"));
  t.after(() => { fake.server.close(); rmSync(fake.dir, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true }); });
  const env = baseEnv(fake, tmp);
  await establishSession(env, fake, "s1");
  await runReporter(env, { hook_event_name: "SessionStart", session_id: "s2", source: "clear" });
  await wait(150);
  const sessReports = fake.requests.filter((r) => r.method === "pane.report_agent_session");
  assert.equal(sessReports.length, 1);
  assert.deepEqual(sessReports[0].params.resume_argv, ["codebuddy", "--resume", "s2"]);
  assert.equal(sessReports[0].params.session_start_source, "clear");
});

test("metadata-only update still advances persisted seq (no regression)", async (t) => {
  const fake = await startFakeHerdr();
  const tmp = mkdtempSync(join(tmpdir(), "herdr-state-"));
  t.after(() => { fake.server.close(); rmSync(fake.dir, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true }); });
  const env = baseEnv(fake, tmp);
  await establishSession(env, fake);
  // working with a title, then a second prompt while still working: state is
  // deduped but the title metadata must carry a strictly greater seq.
  await runReporter(env, { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: "first" });
  await runReporter(env, { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: "second" });
  await wait(180);
  const metaIdx = fake.requests.map((r) => r.method).lastIndexOf("pane.report_metadata");
  const seqs = fake.rawSeqs.map((s) => BigInt(s));
  for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], `seq regression at ${i}`);
  assert.ok(metaIdx >= 1);
});

test("socket failure falls back silently (no crash, exit 0)", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "herdr-state-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const { code } = await runReporter(
    { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p9", HERDR_SOCKET_PATH: join(tmp, "dead.sock"), HERDR_BIN_PATH: "", TMPDIR: tmp },
    { hook_event_name: "Stop", session_id: "s1" },
  );
  assert.equal(code, 0);
});

test("malformed stdin does not crash", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "herdr-state-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const child = spawn(process.execPath, [REPORTER], {
    env: { ...process.env, HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: join(tmp, "x.sock"), TMPDIR: tmp },
  });
  const code = await new Promise((res) => { child.on("close", res); child.stdin.end("not json {{{"); });
  assert.equal(code, 0);
});

test("--doctor prints diagnostics JSON", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "herdr-state-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const child = spawn(process.execPath, [REPORTER, "--doctor"], {
    env: { ...process.env, HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", TMPDIR: tmp },
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  const code = await new Promise((res) => { child.on("close", res); child.stdin.end(); });
  assert.equal(code, 0);
  const info = JSON.parse(out);
  assert.equal(info.paneId, "w1:p1");
  assert.equal(info.insideHerdr, true);
});


/* ------------------------------------------------------------------ *
 * herdr-core backend (OSC 7501). Forced to stdout for determinism.
 * ------------------------------------------------------------------ */

const ESC = "\u001b";
const ST = ESC + "\\";

function runCore(stdinJson) {
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
      },
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(stdinJson));
  });
}

/** Parse an OSC 7501 body into a key->value map. */
function parseOsc(out) {
  const m = out.match(new RegExp(ESC.replace(/\\/g, "\\\\") + "\\]7501;([^" + ESC.replace(/\\/g,"\\\\") + "]*)" + ST.replace(/\\/g,"\\\\")));
  if (!m) return null;
  const pairs = {};
  for (const p of m[1].split(":")) {
    const i = p.indexOf("=");
    if (i > 0) pairs[p.slice(0, i)] = p.slice(i + 1);
  }
  return pairs;
}

test("core: no-op when neither backend env present", async () => {
  const { out } = await new Promise((resolve) => {
    const child = spawn(process.execPath, [REPORTER], {
      env: { ...process.env, HERDR_ENV: "", HC_TERMINAL_SOCKET: "", PATH: process.env.PATH },
    });
    let o = "";
    child.stdout.on("data", (c) => (o += c));
    child.on("close", () => resolve({ out: o }));
    child.stdin.end(JSON.stringify({ hook_event_name: "Stop" }));
  });
  assert.equal(out, "");
});

test("core: UserPromptSubmit emits OSC 7501 working + base64 title", async () => {
  const { out } = await runCore({ hook_event_name: "UserPromptSubmit", prompt: "Fix login" });
  const p = parseOsc(out);
  assert.ok(p, "no OSC 7501 emitted: " + JSON.stringify(out));
  assert.equal(p.state, "working");
  assert.equal(p.app, "codebuddy");
  assert.equal(Buffer.from(p.title, "base64").toString("utf8"), "Fix login");
});

test("core: PermissionRequest emits blocked with kind=permission and msg", async () => {
  const { out } = await runCore({ hook_event_name: "PermissionRequest", tool_name: "Bash", message: "Allow rm?" });
  const p = parseOsc(out);
  assert.equal(p.state, "blocked");
  assert.equal(p.kind, "permission");
  assert.equal(Buffer.from(p.msg, "base64").toString("utf8"), "Allow rm?");
});

test("core: AskUserQuestion PreToolUse emits blocked kind=question", async () => {
  const { out } = await runCore({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" });
  const p = parseOsc(out);
  assert.equal(p.state, "blocked");
  assert.equal(p.kind, "question");
});

test("core: Stop emits idle", async () => {
  const { out } = await runCore({ hook_event_name: "Stop" });
  assert.equal(parseOsc(out).state, "idle");
});

test("core: SessionEnd emits clear (no app key)", async () => {
  const { out } = await runCore({ hook_event_name: "SessionEnd" });
  const p = parseOsc(out);
  assert.equal(p.state, "clear");
  assert.equal(p.app, undefined);
});

test("core: OSC value charset is sanitized (no ':' or ';' in app)", async () => {
  const { out } = await runCore({ hook_event_name: "Stop" });
  // The raw body must contain exactly the pairs we expect, no stray separators.
  const body = out.slice(out.indexOf("7501;") + 5, out.indexOf(ST));
  assert.ok(/^[A-Za-z0-9_.,+/=:-]+$/.test(body), "illegal chars in body: " + JSON.stringify(body));
});

test("core: --doctor reports backend=core and outerTty", async () => {
  const { out } = await new Promise((resolve) => {
    const child = spawn(process.execPath, [REPORTER, "--doctor"], {
      env: { ...process.env, HERDR_ENV: "", HC_TERMINAL_SOCKET: "/tmp/x.sock", HC_TERMINAL_ID: "t1" },
    });
    let o = "";
    child.stdout.on("data", (c) => (o += c));
    child.on("close", () => resolve({ out: o }));
    child.stdin.end();
  });
  const info = JSON.parse(out);
  assert.equal(info.backend, "core");
  assert.equal(info.insideHerdr, true);
});
