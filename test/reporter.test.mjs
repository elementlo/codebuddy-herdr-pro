import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPORTER = join(import.meta.dirname, "..", "bin", "herdr-report.js");

/** Fake Herdr server: collects newline-delimited JSON requests, replies "ok". */
function startFakeHerdr() {
  const requests = [];
  const server = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) {
          try { requests.push(JSON.parse(line)); } catch { requests.push({ raw: line }); }
        }
      }
    });
    conn.on("end", () => { conn.end('{\"ok\":true}\n'); });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      // Reporter uses a unix socket path; listen on a temp unix socket instead.
      server.close(() => {
        const dir = mkdtempSync(join(tmpdir(), "herdr-test-"));
        const sockPath = join(dir, "herdr.sock");
        server.listen(sockPath, () => resolve({ server, requests, sockPath, dir }));
      });
    });
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

test("no-op outside Herdr", async (t) => {
  const fake = await startFakeHerdr();
  t.after(() => { fake.server.close(); rmSync(fake.dir, { recursive: true, force: true }); });
  await runReporter({ HERDR_ENV: "", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: fake.sockPath, TMPDIR: fake.dir }, { hook_event_name: "Stop" });
  await wait(50);
  assert.equal(fake.requests.length, 0);
});

test("SessionStart reports idle with resume command", async (t) => {
  const fake = await startFakeHerdr();
  const tmp = mkdtempSync(join(tmpdir(), "herdr-state-"));
  t.after(() => { fake.server.close(); rmSync(fake.dir, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true }); });
  await runReporter(baseEnv(fake, tmp), {
    hook_event_name: "SessionStart",
    session_id: "sess-abc",
    transcript_path: "/tmp/t.jsonl",
  });
  await wait(100);
  assert.equal(fake.requests.length, 1);
  const req = fake.requests[0];
  assert.equal(req.method, "pane.report_agent");
  assert.equal(req.params.state, "idle");
  assert.equal(req.params.source, "codebuddy-pro");
  assert.equal(req.params.agent, "CodeBuddy");
  assert.equal(req.params.agent_session_id, "sess-abc");
  assert.deepEqual(req.params.resume_argv, ["codebuddy", "--resume", "sess-abc"]);
  assert.equal(req.params.agent_session_path, "/tmp/t.jsonl");
  assert.equal(typeof req.params.seq, "number");
});

test("state dedup: repeated working events send once", async (t) => {
  const fake = await startFakeHerdr();
  const tmp = mkdtempSync(join(tmpdir(), "herdr-state-"));
  t.after(() => { fake.server.close(); rmSync(fake.dir, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true }); });
  const env = baseEnv(fake, tmp);
  await runReporter(env, { hook_event_name: "SessionStart", session_id: "s1" });
  await runReporter(env, { hook_event_name: "UserPromptSubmit", session_id: "s1" });
  await runReporter(env, { hook_event_name: "PreToolUse", session_id: "s1" });
  await runReporter(env, { hook_event_name: "PostToolUse", session_id: "s1" });
  await runReporter(env, { hook_event_name: "PreToolUse", session_id: "s1" });
  await wait(150);
  // SessionStart(idle) + first working; the other three are deduped.
  assert.equal(fake.requests.length, 2);
  assert.equal(fake.requests[1].params.state, "working");
});

test("seq strictly increases across processes", async (t) => {
  const fake = await startFakeHerdr();
  const tmp = mkdtempSync(join(tmpdir(), "herdr-state-"));
  t.after(() => { fake.server.close(); rmSync(fake.dir, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true }); });
  const env = baseEnv(fake, tmp);
  await runReporter(env, { hook_event_name: "SessionStart", session_id: "s1" });
  await runReporter(env, { hook_event_name: "UserPromptSubmit", session_id: "s1" });
  await runReporter(env, { hook_event_name: "Stop", session_id: "s1" });
  await wait(150);
  const seqs = fake.requests.map((r) => r.params.seq);
  assert.equal(seqs.length, 3);
  for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], `seq not increasing: ${seqs}`);
});

test("Notification permission -> blocked with message; idle_prompt -> idle", async (t) => {
  const fake = await startFakeHerdr();
  const tmp = mkdtempSync(join(tmpdir(), "herdr-state-"));
  t.after(() => { fake.server.close(); rmSync(fake.dir, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true }); });
  const env = baseEnv(fake, tmp);
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
  await runReporter(baseEnv(fake, tmp), { hook_event_name: "StopFailure", reason: "api_error", session_id: "s1" });
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
  await runReporter(env, { hook_event_name: "SessionStart", session_id: "s1" });
  await runReporter(env, { hook_event_name: "SessionEnd", session_id: "s1" });
  await wait(150);
  assert.equal(fake.requests.length, 2);
  assert.equal(fake.requests[1].method, "pane.release_agent");
  assert.equal(fake.requests[1].params.source, "codebuddy-pro");
});

test("resume command survives later events without session_id", async (t) => {
  const fake = await startFakeHerdr();
  const tmp = mkdtempSync(join(tmpdir(), "herdr-state-"));
  t.after(() => { fake.server.close(); rmSync(fake.dir, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true }); });
  const env = baseEnv(fake, tmp);
  await runReporter(env, { hook_event_name: "SessionStart", session_id: "s9" });
  await runReporter(env, { hook_event_name: "UserPromptSubmit" });
  await wait(150);
  assert.equal(fake.requests[1].params.agent_session_id, "s9");
  assert.deepEqual(fake.requests[1].params.resume_argv, ["codebuddy", "--resume", "s9"]);
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
