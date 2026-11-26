// End-to-end test of AI Buddy and the session summaries against the built relay:
// settings, screen text from the viewer, knowledge base matching, the
// summary written when the session ends, and the knowledge base API.
// Run after `pnpm --filter @workspace/api-server run build`:
//   node --test artifacts/api-server/tests/buddy-e2e.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}/api`;
const dataDir = mkdtempSync(path.join(tmpdir(), "winrss-buddy-e2e-"));
let server;

before(async () => {
  server = spawn(process.execPath, [path.join(here, "..", "dist", "index.mjs")], {
    env: { ...process.env, PORT: String(port), MSFWR_DATA_DIR: dataDir, ADMIN_USERNAME: "root", ADMIN_PASSWORD: "admin-pass-123", SESSION_SECRET: "buddy-e2e", ADMIN_CREATION_PIN: "654321", NODE_ENV: "production", DATABASE_URL: "" },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("relay did not start");
});
after(() => { server?.kill(); rmSync(dataDir, { recursive: true, force: true }); });

function client(root = base) {
  let cookie = "";
  return async function call(method, route, body, headers = {}) {
    const res = await fetch(root + route, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0].endsWith("=") ? "" : set.split(";")[0];
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
    return { status: res.status, json };
  };
}

const admin = client();
const acme = client();
const pc = client();
const pcKey = (c) => c.repeat(43);
let viewer;
let host;
let sessionId;

test("AI Buddy is ON by default and seeds a starter knowledge base", async () => {
  assert.equal((await admin("POST", "/auth/login", { username: "root", password: "admin-pass-123" })).status, 200);
  const settings = (await admin("GET", "/admin/buddy/settings")).json;
  // Defaults flipped to enabled/ai/autoAssist=true so a fresh relay works
  // out of the box; the API key is still empty until an admin adds one.
  assert.deepEqual([settings.enabled, settings.ai, settings.apiKeySet], [true, true, false]);
  assert.equal(settings.model, "claude-opus-5-5");
  const kb = (await admin("GET", "/admin/buddy/kb")).json.entries;
  assert.ok(kb.length >= 8);
  assert.ok(kb.some((e) => e.keywords.includes("0x80070005")));
  assert.equal((await client()("GET", "/admin/buddy/settings")).status, 401, "admins only");
  const bad = await admin("PATCH", "/admin/buddy/settings", { apiKey: "not-a-key" });
  assert.equal(bad.status, 400);
});

test("a live session's viewer reads screen text (and captures stay paced)", async () => {
  await admin("POST", "/admin/users", { username: "acme", displayName: "Acme", password: "acme-temp-1234", role: "company", raId: "424242" });
  await acme("POST", "/auth/login", { username: "acme", password: "acme-temp-1234" });
  await acme("POST", "/auth/password", { current: "acme-temp-1234", next: "acme-pass-1234" });
  const reg = await pc("POST", "/msfwr/standing", { key: pcKey("b"), name: "FRONT-DESK", ra: "RA-424242" });
  assert.equal(reg.status, 201, JSON.stringify(reg.json));
  host = { authorization: `Bearer ${reg.json.token}` };
  assert.equal((await pc("POST", "/msfwr/call", { name: "FRONT-DESK" }, host)).status, 204);
  const inbox = (await acme("GET", "/msfwr/inbox")).json;
  const accepted = await acme("POST", "/msfwr/accept", { id: inbox.requests[0].id });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
  assert.equal((await pc("POST", "/msfwr/tick", undefined, host)).json.state, "live");
  viewer = { authorization: `Bearer ${accepted.json.token}` };
  sessionId = (await admin("GET", "/admin/overview")).json.live[0].id;

  // AI Buddy is on by default now, so the viewer sees enabled=true (but no
  // Claude until a key is set).
  assert.deepEqual((await client()("GET", "/buddy/config", undefined, viewer)).json.enabled, true);
  // Captures work out of the box — and they are paced per session, so this
  // first capture also sets the pacing mark for the next one.
  const first = await client()("POST", "/buddy/capture", { text: "hello" }, viewer);
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal((await client()("POST", "/buddy/capture", { text: "hello" }, viewer)).status, 429, "paced per session");
  assert.equal((await client()("POST", "/buddy/capture", { text: "hello" })).status, 410, "needs a viewer token");
  assert.equal((await client()("POST", "/buddy/capture", { text: "hello" }, host)).status, 410, "a host token is not a viewer");

  const on = await admin("PATCH", "/admin/buddy/settings", { enabled: true, captureSeconds: 5 });
  assert.deepEqual([on.json.enabled, on.json.captureSeconds, on.json.aiReady], [true, 5, false]);
  assert.deepEqual((await client()("GET", "/buddy/config", undefined, viewer)).json, { enabled: true, ai: false, autoAssist: false, captureSeconds: 5 });
});

test("screen text with an error is flagged and matched to the knowledge base", async () => {
  const text = "Windows Update\nSome updates failed to install\nError 0x80070005\nAccess is denied.\nRetry";
  // Wait out the 2 s per-session capture pacing from the previous test.
  await new Promise((r) => setTimeout(r, 2100));
  const res = await client()("POST", "/buddy/capture", { text }, viewer);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.ok(res.json.issues.some((i) => i.includes("0x80070005")));
  assert.equal(res.json.matches[0].title, "Access is denied (0x80070005)");
  assert.equal((await client()("POST", "/buddy/capture", { text }, viewer)).status, 429, "paced per session");

  const assist = await client()("POST", "/buddy/assist", { text }, viewer);
  assert.equal(assist.status, 200);
  assert.deepEqual([assist.json.ai, assist.json.advice], [false, ""], "no Claude without a key");

  const live = (await admin("GET", "/admin/session-summaries")).json.sessions.find((s) => s.id === sessionId);
  assert.deepEqual([live.live, live.pcName, live.company, live.captureCount], [true, "FRONT-DESK", "Acme", 1]);
});

test("ending the session writes a summary, and the fix can become a knowledge base entry", async () => {
  assert.equal((await acme("POST", "/msfwr/end", undefined, viewer)).status, 204);
  let row;
  for (let i = 0; i < 40 && !row?.summary; i++) {
    await new Promise((r) => setTimeout(r, 100));
    row = (await admin("GET", "/admin/session-summaries")).json.sessions.find((s) => s.id === sessionId);
  }
  assert.equal(row.live, false);
  assert.equal(row.summaryBy, "auto");
  assert.match(row.summary, /0x80070005/);
  assert.match(row.summary, /Access is denied \(0x80070005\)/, "names the suggested article");

  const detail = (await admin("GET", `/admin/buddy/sessions/${sessionId}`)).json;
  assert.equal(detail.captures.length, 1);
  const saved = await admin("PATCH", `/admin/buddy/sessions/${sessionId}`, { resolution: "Ran the Windows Update troubleshooter\nReset the SoftwareDistribution folder" });
  assert.match(saved.json.resolution, /troubleshooter/);
  const entry = await admin("POST", `/admin/buddy/sessions/${sessionId}/kb`, {});
  assert.equal(entry.status, 201, JSON.stringify(entry.json));
  assert.deepEqual([entry.json.source, entry.json.sessionId], ["session", sessionId]);
  assert.ok(entry.json.keywords.includes("0x80070005"));
});

test("admins add, edit and delete knowledge base entries", async () => {
  assert.equal((await admin("POST", "/admin/buddy/kb", { title: "VPN", steps: "Reconnect" })).status, 400, "needs keywords");
  const made = await admin("POST", "/admin/buddy/kb", { title: "VPN will not connect", keywords: "vpn connection failed, error 809", steps: "Check the internet\nRestart the VPN client" });
  assert.equal(made.status, 201);
  assert.deepEqual(made.json.keywords, ["vpn connection failed", "error 809"]);
  const edited = await admin("PATCH", `/admin/buddy/kb/${made.json.id}`, { title: "VPN error 809" });
  assert.equal(edited.json.title, "VPN error 809");
  assert.equal((await admin("DELETE", `/admin/buddy/kb/${made.json.id}`)).status, 204);
  assert.equal((await admin("DELETE", `/admin/buddy/kb/${made.json.id}`)).status, 404);
});
