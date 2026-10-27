// Local tests: node test/test.mjs   (no network, no accounts; everything external is mocked)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import http from "node:http";
import worker, { _resetGuard } from "../src/index.js";
import { buildMessage, sealToken, openToken, topPicks, refreshForCard } from "../src/embed.js";
import { handleLive } from "../src/index.js";
import { applyLiveRow, liveRow, devig, feeOf } from "../../docs/live-core.js";

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
{ // GET /live: caps, CORS, rate limit, de-vig, flags, line age; refreshForCard + topPicks exclude paused rows
  const T = Date.now(), lm = new Date(T - 120000).toUTCString(), old = new Date(T - 900000).toUTCString();
  const mk = (id, key, prices, extra = {}) => ({ matchupId: id, period: 0, key, status: "open", version: 10, prices, ...extra });
  const mus = [1, 2, 3, 4].map(id => ({ id, status: "started", liveMode: null, periods: [{ period: 0, status: "open" }],
    participants: [{ alignment: "home", state: { score: id === 3 ? 1 : 0 } }, { alignment: "away", state: { score: 0 } }] }));
  mus[1].periods[0].status = "offline";   // matchup 2 suspended
  const per = { 1: [mk(1, "s;0;m", [{ designation: "home", price: -150 }, { designation: "away", price: 130 }], { version: 12 })],
    4: [mk(4, "s;0;m", [{ designation: "home", price: 100 }, { designation: "away", price: -120 }])] };
  const sportMk = [mk(1, "s;0;m", [{ designation: "home", price: 200 }, { designation: "away", price: -250 }], { version: 11 }),   // older copy than per-matchup
    mk(3, "s;0;ou;2.5", [{ designation: "over", points: 2.5, price: -110 }, { designation: "under", points: 2.5, price: -110 }])];
  const seen = [];
  const f0 = globalThis.fetch;
  globalThis.fetch = async (u) => { u = String(u); seen.push(u); const H = h => ({ status: 200, headers: { "content-type": "application/json", ...h } });
    if (u.includes("/matchups/live")) return new Response(JSON.stringify(mus), H({ "last-modified": lm }));
    if (u.includes("/markets/live/straight")) return new Response(JSON.stringify(sportMk), H({ "last-modified": lm }));
    let m = u.match(/matchups\/(\d+)\/markets\/straight/); if (m) return per[m[1]] ? new Response(JSON.stringify(per[m[1]]), H({ "last-modified": m[1] === "4" ? old : lm })) : new Response("no", { status: 403 });
    if (u.includes("/events/scores")) return new Response(JSON.stringify({ data: [{ eventId: "E1", score: "0-0", live: true }, { eventId: "E3", score: "0-0", live: true }, { eventId: "E4", score: "0-0" }] }), H({}));
    return new Response("x", { status: 500 }); };
  const req = (q, o = {}) => new Request("https://w.example/live?" + q, { headers: { origin: "https://lucksociety.github.io", "cf-connecting-ip": "1.2.3.4", ...o } });
  let r = await handleLive(req("ids=1,2,3,4,abc&sports=19,999&events=E1,E3,E4,bad%20id"), {});
  assert.equal(r.status, 200); assert.equal(r.headers.get("access-control-allow-origin"), "https://lucksociety.github.io");
  assert.match(r.headers.get("cache-control"), /max-age=3/);
  const L = await r.json();
  assert.ok(!seen.some(u => u.includes("/sports/999/")), "unknown sport dropped");
  const [ph, pa] = devig([-150, 130]).probs;
  assert.equal(L.pin["1"].fair["s;0;m|home"], +ph.toFixed(4), "newer per-matchup copy (version 12) wins over the per-sport copy");
  assert.ok(Math.abs(L.pin["1"].as_of["s;0;m"] - (T - 120000)) < 2000, "line age from Last-Modified"); assert.ok(Math.abs(L.pin["1"].line_age_s - 120) <= 2);
  assert.equal(L.pin["2"].suspended, true);
  assert.ok(!JSON.stringify(L).includes("CmX2"), "no keys in the response");
  // rows -> flags + recomputed edge with the live Buy price
  const row = (o) => ({ event: "G" + o.pin_id, selection: "x", market_type: "moneyline", side: "YES", price: 0.55, price_src: "jupiter live", depth_ok: 50, fair_prob: 0.9, edge_pts: 0.3, link: "https://jup.ag", pin_d: "home", pin_key: "s;0;m", ...o });
  const rows = [row({ pin_id: 1, event_id: "E1", score: "0-0" }), row({ pin_id: 2, event_id: "E2" }), row({ pin_id: 3, event_id: "E3", score: "0-0", pin_key: "s;0;ou;2.5", pin_d: "under" }),
    row({ pin_id: 4, event_id: "E4", score: "0-0" }), row({ pin_id: 1, event_id: "E1", side: "NO", event: "G1b" }), row({ event: "nopin", pin_id: undefined, event_id: "E9" })];
  rows.forEach(x => applyLiveRow(x, L));
  assert.equal(rows[0].fair_prob, +ph.toFixed(4)); assert.equal(rows[0].live_flag, null);
  assert.equal(rows[0].edge_pts, +(rows[0].fair_prob - (0.55 + feeOf(0.55))).toFixed(4), "edge = fair - (Buy price + fee)");
  assert.equal(rows[4].fair_prob, +(1 - +ph.toFixed(4)).toFixed(4), "NO side = 1 - fair");
  assert.equal(rows[1].live_flag, "suspended");
  assert.equal(rows[2].live_flag, "score mismatch", "Jupiter 0-0 vs Pinnacle 1-0");
  assert.equal(rows[3].live_flag, "line old", "15-min-old line");
  assert.equal(rows[5].live_flag, null, "rows without a Pinnacle match are not flagged"); assert.equal(rows[5].fair_prob, 0.9, "...and keep the scan's win chance");
  // score changed after the line was produced -> paused
  const x = row({ pin_id: 1, event_id: "E1", score: "1-0", score_at: Math.floor(T / 1000) - 30 });
  applyLiveRow(x, L); assert.equal(x.live_flag, "line behind score");
  const y = row({ pin_id: 1, event_id: "E1", score: "1-0", score_at: Math.floor(T / 1000) - 600 });   // could have changed before the line: not flagged
  applyLiveRow(y, L); assert.equal(y.live_flag, null);
  const tp = topPicks({ rows: rows.map(r => ({ ...r, edge_pts: 0.02 })) }, 9);
  assert.ok(tp.length && tp.every(r => !r.live_flag) && tp.some(r => r.event === "G1"), "paused rows never picks");
  // second identical request is served from the 3 s memo
  const n = seen.length; r = await handleLive(req("events=E4,E3,E1&ids=4,3,2,1&sports=19"), {}); assert.equal(r.headers.get("x-cache"), "HIT"); assert.equal(seen.length, n);
  // caps
  const many = Array.from({ length: 80 }, (_, i) => 1000 + i).join(",");
  seen.length = 0; await handleLive(req(`ids=${many}&sports=19`), {}); assert.ok(seen.filter(u => /matchups\/\d+\/markets/.test(u)).length >= 30, "all 30 (capped) matchups fetched");
  assert.ok(seen.length <= 50, "within the free-plan 50 subrequests: " + seen.length);
  // bad input, other origin, rate limit, preflight
  r = await handleLive(req("ids=;drop"), {}); assert.equal(r.status, 400);
  r = await handleLive(req("ids=1&sports=19", { origin: "https://evil.example" }), {}); assert.equal(r.headers.get("access-control-allow-origin"), "https://lucksociety.github.io");
  r = await handleLive(req("ids=1&sports=19"), { LIVE_LIMITER: { limit: async ({ key }) => ({ success: key !== "1.2.3.4" }) } }); assert.equal(r.status, 429);
  r = await worker.fetch(new Request("https://w.example/live", { method: "OPTIONS", headers: { origin: "http://127.0.0.1:8765" } }), env); assert.equal(r.status, 204);
  assert.equal(r.headers.get("access-control-allow-origin"), "http://127.0.0.1:8765");
  r = await worker.fetch(new Request("https://w.example/"), env); assert.match(await r.text(), /running/, "plain GET unchanged");
  // Discord card refresh: re-prices fair + flags right before posting; paused rows never become picks
  const data = { mode: "live", status: "ok", scanned_at_unix: Math.floor(T / 1000) - 20, counts: { live_events: 4 }, rows: [
    row({ pin_id: 1, event_id: "E1", score: "0-0", edge_pts: 0.02, market_id: "M1" }), row({ pin_id: 2, event_id: "E2", edge_pts: 0.05, market_id: "M2", event: "G2" }) ] };
  const note = await refreshForCard(data, { prices: false });
  assert.match(note, /refreshed live/); assert.equal(data.rows[0].fair_prob, +ph.toFixed(4)); assert.equal(data.rows[1].live_flag, "suspended");
  assert.ok(!topPicks(data, 5).some(r => r.event === "G2"), "suspended row is not a pick");
  assert.match(JSON.stringify(buildMessage(data, { note })), /refreshed live/);
  globalThis.fetch = f0;
  console.log("✓ GET /live: caps, CORS, 3 s memo, 429 rate limit, de-vig + newest copy, line age, flags; Discord card refresh + paused rows excluded");
}
console.log("\nALL TESTS PASSED");
