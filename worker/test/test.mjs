// Local tests: node test/test.mjs   (no network, no accounts; everything external is mocked)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import http from "node:http";
import worker, { _resetGuard } from "../src/index.js";
import { buildMessage, sealToken, openToken, topPicks } from "../src/embed.js";

const hex = u8 => Buffer.from(u8).toString("hex");
const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const pub = hex(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
const env = { DISCORD_PUBLIC_KEY: pub, GITHUB_TOKEN: "ghp_test", GITHUB_REPO: "o/r", GITHUB_BRANCH: "main", WORKFLOW_FILE: "scan.yml",
  DASHBOARD_URL: "https://o.github.io/r/", COOLDOWN_SECONDS: "60", RELAY_KEY: "relay-secret-123" };
const results = JSON.parse(readFileSync(new URL("../../docs/data/results.json", import.meta.url)));

let calls = [], runs = [];
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), method: init.method || "GET", body: init.body });
  if (String(url).includes("/runs?")) return new Response(JSON.stringify({ workflow_runs: runs }));
  if (String(url).endsWith("/dispatches")) return new Response(null, { status: 204 });
  if (String(url).includes("/contents/docs/data/results.json")) return new Response(JSON.stringify(results));
  if (String(url).includes("discord.com")) return new Response("{}", { status: 200 });
  return new Response("not mocked", { status: 500 });
};
async function call(payload, { sign = true, tamper = false } = {}) {
  const body = JSON.stringify(payload), ts = String(Math.floor(Date.now() / 1000));
  const sig = hex(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, new TextEncoder().encode(ts + body))));
  const waits = [];
  const res = await worker.fetch(new Request("https://w.example/", { method: "POST", body: tamper ? body.replace("}", ',"x":1}') : body,
    headers: sign ? { "x-signature-ed25519": sig, "x-signature-timestamp": ts } : {} }), env, { waitUntil: p => waits.push(p) });
  await Promise.all(waits);
  return { status: res.status, json: res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text() };
}
const cmd = (id, options = []) => ({ type: 2, id, application_id: "app123", token: "itok_" + id, data: { name: "livebets", options },
  member: { user: { username: "tester", global_name: "Tester" } } });

// 1 signatures
assert.equal((await call({ type: 1 }, { sign: false })).status, 401, "missing signature rejected");
assert.equal((await call({ type: 1 }, { tamper: true })).status, 401, "tampered body rejected");
assert.deepEqual((await call({ type: 1 })).json, { type: 1 }, "PING -> PONG");
console.log("✓ Ed25519 verification + PING");

// 2 /livebets -> deferred + dispatch with sealed token
calls = []; runs = [];
let r = await call(cmd("1001", [{ name: "mode", value: "live" }, { name: "count", value: 3 }]));
assert.deepEqual(r.json, { type: 5 });
const d = calls.find(c => c.url.endsWith("/dispatches")); assert.ok(d, "dispatched");
const inp = JSON.parse(d.body).inputs;
assert.equal(inp.mode, "live"); assert.equal(inp.request_id, "discord-1001"); assert.equal(inp.discord_count, "3");
assert.ok(inp.discord_token.startsWith("enc1.")); assert.equal(await openToken(inp.discord_token, env.RELAY_KEY), "itok_1001");
console.log("✓ /livebets -> type 5, workflow_dispatch inputs", Object.keys(inp).join(","), "(token sealed)");

// 3 cooldown: immediate repeat in same isolate -> ephemeral wait
r = await call(cmd("1002"));
assert.equal(r.json.type, 4); assert.equal(r.json.data.flags, 64); console.log("✓ double-click guard:", r.json.data.content);

// 4 cooldown: a run of this mode in progress -> ephemeral wait
runs = [{ display_title: "scan live discord-999", status: "in_progress", created_at: new Date(Date.now() - 20e3).toISOString(), run_started_at: new Date(Date.now() - 20e3).toISOString(), updated_at: new Date().toISOString() }];
r = await call(cmd("1003")); assert.equal(r.json.type, 4); console.log("✓ running scan:", r.json.data.content);

// 5 cooldown: completed < 60s ago -> deferred + reuse results (PATCH from the Worker, no new dispatch)
runs = [{ display_title: "scan live abc", status: "completed", conclusion: "success", created_at: new Date(Date.now() - 50e3).toISOString(), run_started_at: new Date(Date.now() - 50e3).toISOString(), updated_at: new Date(Date.now() - 15e3).toISOString() }];
calls = []; r = await call(cmd("1004"));
assert.deepEqual(r.json, { type: 5 }); assert.ok(!calls.some(c => c.url.endsWith("/dispatches")), "no new dispatch");
const patch = calls.find(c => c.method === "PATCH"); assert.ok(patch.url.endsWith("/webhooks/app123/itok_1004/messages/@original"));
assert.match(JSON.parse(patch.body).embeds[0].description, /Reusing the scan/); console.log("✓ reuse within cooldown -> PATCH @original");

// 6 upcoming mode is independent of the live cooldown
runs = []; calls = []; r = await call(cmd("1005", [{ name: "mode", value: "upcoming" }]));
assert.deepEqual(r.json, { type: 5 }); assert.equal(JSON.parse(calls.find(c => c.url.endsWith("/dispatches")).body).inputs.mode, "upcoming");
console.log("✓ upcoming mode dispatch");

// 7 GitHub dispatch failure -> error embed edited into the reply
const f0 = globalThis.fetch; _resetGuard();
globalThis.fetch = async (u, i) => String(u).endsWith("/dispatches") ? new Response('{"message":"Bad credentials"}', { status: 401 }) : f0(u, i);
calls = []; runs = []; r = await call(cmd("1006"));
assert.deepEqual(r.json, { type: 5 });
const p7 = calls.find(c => c.method === "PATCH"); assert.match(JSON.parse(p7.body).embeds[0].title, /Couldn't start/);
assert.match(JSON.parse(p7.body).embeds[0].description, /401/);
globalThis.fetch = f0; console.log("✓ dispatch failure -> error embed");

// 8 embed limits on current results.json + edge cases
function checkLimits(m) {
  let total = 0;
  for (const e of m.embeds) {
    assert.ok((e.title || "").length <= 256); assert.ok((e.description || "").length <= 4096); assert.ok((e.fields || []).length <= 25);
    for (const f of e.fields || []) { assert.ok(f.name.length <= 256); assert.ok(f.value.length <= 1024); total += f.name.length + f.value.length; }
    total += (e.title || "").length + (e.description || "").length + (e.footer?.text || "").length + (e.author?.name || "").length;
  }
  assert.ok(total <= 6000, "embed total " + total);
  return total;
}
const msg = buildMessage(results, { count: 5, dashboardUrl: env.DASHBOARD_URL, logoUrl: env.DASHBOARD_URL + "assets/logo.jpg", requestedBy: "Tester" });
console.log("✓ embed from current results.json:", topPicks(results, 5).length, "picks,", checkLimits(msg), "chars");
checkLimits(buildMessage(results, { count: 10 }));
const noLive = buildMessage({ ...results, counts: { ...results.counts, live_events: 0 }, rows: [] }); assert.match(noLive.embeds[0].title, /No live games/);
const err = buildMessage({ status: "error", errors: ["Pinnacle 403"], mode: "live" }); assert.match(err.embeds[0].title, /failed/);
const noEv = buildMessage({ ...results, rows: [] }); assert.match(noEv.embeds[0].title, /No live value bets/);
console.log("✓ no-live-games / error / no-value-bets embeds");
import("node:fs").then(fs => fs.writeFileSync("/tmp/livebets-embed.json", JSON.stringify(msg, null, 2)));

// 9 workflow step against a mock Discord endpoint
const got = [];
const srv = http.createServer((q, s) => { let b = ""; q.on("data", c => b += c); q.on("end", () => { got.push({ method: q.method, url: q.url, body: b }); s.writeHead(200, { "content-type": "application/json" }); s.end("{}"); }); });
await new Promise(res => srv.listen(0, res));
const sealed = await sealToken("itok_wf", env.RELAY_KEY);
import { spawn } from "node:child_process";
const runAsync = extra => new Promise(res => { const p = spawn("node", ["../scripts/post-discord.mjs"], { cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env, DISCORD_API: `http://127.0.0.1:${srv.address().port}`, DISCORD_APP_ID: "app123", DISCORD_TOKEN: sealed, DISCORD_RELAY_KEY: env.RELAY_KEY,
    DISCORD_COUNT: "5", DISCORD_USER: "Tester", REQUEST_ID: results.request_id || "", RESULTS_PATH: "../docs/data/results.json", DASHBOARD_URL: env.DASHBOARD_URL, ...extra } });
  let out = ""; p.stdout.on("data", c => out += c); p.stderr.on("data", c => out += c); p.on("close", code => res({ code, out })); });
let w = await runAsync({});
assert.equal(w.code, 0, w.out); assert.equal(got[0].method, "PATCH"); assert.equal(got[0].url, "/webhooks/app123/itok_wf/messages/@original");
assert.ok(JSON.parse(got[0].body).embeds[0].fields.length >= 1);
w = await runAsync({ REQUEST_ID: "someone-else" }); assert.match(JSON.parse(got[1].body).embeds[0].title, /failed/);
w = await runAsync({ DISCORD_TOKEN: "plain_tok", DISCORD_RELAY_KEY: "" }); assert.equal(got[2].url, "/webhooks/app123/plain_tok/messages/@original");
srv.close();
console.log("✓ workflow step: decrypts token, PATCHes @original with embed; mismatched request -> error embed; plain token works");
{ // prices come only from the order-book ask (jup.ag's Buy button); meter / quote / missing asks never make a pick
  const base = { event: "A vs B", selection: "A", market_type: "moneyline", fair_prob: 0.7, edge_pts: 0.03, depth_ok: 100, link: "https://jup.ag/x" };
  const d = { mode: "live", status: "ok", counts: { live_events: 3 }, rows: [
    { ...base, event: "E1", price: 0.65, price_src: "order book", meter: 0.52 },
    { ...base, event: "E2", price: 0.60, price_src: "quote" },
    { ...base, event: "E3", price: null, price_src: "no asks", edge_pts: null } ] };
  const p = topPicks(d, 5);
  assert.deepEqual(p.map(r => r.event), ["E1"]);
  const m = JSON.stringify(buildMessage(d));
  assert.ok(m.includes("Buy price **$0.65**") && !m.includes("0.52"), "embed shows the order-book ask, not the meter");
  console.log("✓ picks/embeds use only the order-book ask (meter, quote and no-seller rows excluded)");
}
console.log("\nALL TESTS PASSED");
