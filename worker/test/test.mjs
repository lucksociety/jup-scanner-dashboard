// Local tests: node test/test.mjs   (no network, no accounts; everything external is mocked)
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import http from "node:http";
import worker, { _resetGuard } from "../src/index.js";
import { buildMessage, sealToken, openToken, topPicks, refreshForCard } from "../src/embed.js";
import { handleLive } from "../src/index.js";
import { applyLiveRow, liveRow, devig, feeOf, gameState, modelFair, targetFor, noteObs, stateAt, MODEL_SPORTS, settleFor, queryFor, queryString, parseQuery } from "../../docs/live-core.js";

const hex = u8 => Buffer.from(u8).toString("hex");
const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const pub = hex(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
const env = { DISCORD_PUBLIC_KEY: pub, GITHUB_TOKEN: "ghp_test", GITHUB_REPO: "o/r", GITHUB_BRANCH: "main", WORKFLOW_FILE: "scan.yml",
  DASHBOARD_URL: "https://o.github.io/r/", COOLDOWN_SECONDS: "60", RELAY_KEY: "relay-secret-123" };
const results = JSON.parse(readFileSync(new URL("../../docs/data/results.json", import.meta.url)));
// the snapshot's lines age in real time (picks skip lines > 5 min old), so pretend it was just scanned: tests must not depend on the clock
{ const shift = Math.floor(Date.now() / 1000) - (results.scanned_at_unix || Math.floor(Date.now() / 1000));
  for (const r of results.rows || []) for (const k of ["line_as_of", "price_ts", "scanned_at_unix"]) if (typeof r[k] === "number") r[k] += shift;
  if (results.scanned_at_unix) results.scanned_at_unix += shift; }
const RESULTS_FILE = `${tmpdir()}/livebets-test-results.json`; writeFileSync(RESULTS_FILE, JSON.stringify(results));

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
let r = await call(cmd("1001"));
assert.deepEqual(r.json, { type: 5 });
const d = calls.find(c => c.url.endsWith("/dispatches")); assert.ok(d, "dispatched");
const inp = JSON.parse(d.body).inputs;
assert.equal(inp.mode, "live"); assert.equal(inp.request_id, "discord-1001"); assert.equal(inp.discord_count, "5");
assert.ok(inp.discord_token.startsWith("enc1.")); assert.equal(await openToken(inp.discord_token, env.RELAY_KEY), "itok_1001");
console.log("✓ /livebets -> type 5, workflow_dispatch inputs", Object.keys(inp).join(","), "(token sealed)");

// 3 cooldown: immediate repeat in same isolate -> ephemeral wait
r = await call(cmd("1002"));
assert.equal(r.json.type, 4); assert.equal(r.json.data.flags, 64); console.log("✓ double-click guard:", r.json.data.content);

// 4 cooldown: a run of this mode in progress -> ephemeral wait
runs = [{ display_title: "scan live discord-999", status: "in_progress", created_at: new Date(Date.now() - 20e3).toISOString(), run_started_at: new Date(Date.now() - 20e3).toISOString(), updated_at: new Date().toISOString() }];
r = await call(cmd("1003")); assert.equal(r.json.type, 4); console.log("✓ running scan:", r.json.data.content);

// 5 no reuse: a scan completed < 60s ago still starts a fresh live scan (top 5); stray old options are ignored
runs = [{ display_title: "scan live abc", status: "completed", conclusion: "success", created_at: new Date(Date.now() - 50e3).toISOString(), run_started_at: new Date(Date.now() - 50e3).toISOString(), updated_at: new Date(Date.now() - 15e3).toISOString() }];
_resetGuard(); calls = []; r = await call(cmd("1004", [{ name: "mode", value: "upcoming" }, { name: "count", value: 9 }]));
assert.deepEqual(r.json, { type: 5 });
const i5 = JSON.parse(calls.find(c => c.url.endsWith("/dispatches")).body).inputs;
assert.equal(i5.mode, "live"); assert.equal(i5.discord_count, "5"); console.log("✓ always a fresh live scan, top 5");

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
    DISCORD_COUNT: "5", DISCORD_USER: "Tester", REQUEST_ID: results.request_id || "", RESULTS_PATH: RESULTS_FILE, DASHBOARD_URL: env.DASHBOARD_URL, ...extra } });
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
// 9 in-game model (docs/live-core.js): parses Jupiter's scoreboard, moves Pinnacle's last line to the current state
{
  const near = (a, b, e, m) => assert.ok(Math.abs(a - b) <= e, `${m}: ${a} vs ${b}`);
  // Jupiter score text follows the title order; pin_sh says which Pinnacle side that first team is
  assert.deepEqual([gameState(4, "NBA", { score: "36-30", period: "Q2", elapsed: "09:37" }, "away")].map(s => [s.h, s.a, +s.rem.toFixed(2)])[0], [30, 36, 33.62]);
  assert.equal(gameState(29, "", { score: "0-2", period: "2H", elapsed: "59" }, "home").a, 2);
  assert.equal(gameState(19, "NHL", { score: "3-0", period: "P2", elapsed: "10:00" }, "away").a, 3);
  assert.deepEqual(gameState(3, "MLB", { score: "2-0", period: "Bot 3rd" }, "away"), { h: 0, a: 2, sid: 3, ra: 6, rh: 6.5, inning: 3, half: "BOT" });
  const ts = gameState(33, "ATP", { score: "6-2, 6-6(5-3)", period: "TB2" }, "home");
  assert.deepEqual([ts.sets, ts.g, ts.tb], [[1, 0], [6, 6], [5, 3]]);
  assert.equal(gameState(29, "", { score: "1-1", period: "FT", ended: true }, "home"), null, "finished game -> no state");
  // soccer: no change -> exactly Pinnacle's line; home goal -> home up; time passing at 0-0 -> draw + under up
  const SL = { "s;0;m": [["home", null, 0.40], ["away", null, 0.25], ["draw", null, 0.35]], "s;0;ou;1.5": [["over", 1.5, 0.45], ["under", 1.5, 0.55]] };
  const sA = gameState(29, "", { score: "0-0", period: "2H", elapsed: "60" }, "home");
  const same = modelFair(29, "", SL, sA, sA).fair;
  near(same["s;0;m|home"], 0.40, 1e-6, "identity home"); near(same["s;0;ou;1.5|over"], 0.45, 1e-6, "identity over");
  const goal = modelFair(29, "", SL, sA, gameState(29, "", { score: "1-0", period: "2H", elapsed: "61" }, "home")).fair;
  assert.ok(goal["s;0;m|home"] > 0.7 && goal["s;0;ou;1.5|over"] > 0.45, "home goal");
  const later = modelFair(29, "", SL, sA, gameState(29, "", { score: "0-0", period: "2H", elapsed: "80" }, "home")).fair;
  assert.ok(later["s;0;m|draw"] > 0.5 && later["s;0;ou;1.5|under"] > 0.7, "20 scoreless minutes");
  // basketball: a 10-0 run for the home side moves the home win chance up; a target total that isn't in the anchor copy is priced
  const BL = { "s;0;m": [["home", null, 0.6], ["away", null, 0.4]], "s;0;s;-3.5": [["home", -3.5, 0.5], ["away", 3.5, 0.5]], "s;0;ou;220.5": [["over", 220.5, 0.5], ["under", 220.5, 0.5]] };
  const bA = gameState(4, "NBA", { score: "50-50", period: "Q3", elapsed: "12:00" }, "away"), bB = gameState(4, "NBA", { score: "50-60", period: "Q3", elapsed: "09:00" }, "away");
  const bm = modelFair(4, "NBA", BL, bA, bB, { ...BL, ...targetFor("s;0;ou;225.5") }).fair;
  assert.ok(bm["s;0;m|home"] > 0.75, "home run"); assert.ok(bm["s;0;ou;225.5|over"] < bm["s;0;ou;220.5|over"], "higher total line -> lower over");
  // hockey + MLB + tennis move the right way
  const HL = { "s;0;m": [["home", null, 0.55], ["away", null, 0.45]], "s;0;ou;6.5": [["over", 6.5, 0.45], ["under", 6.5, 0.55]] };
  const h = modelFair(19, "NHL", HL, gameState(19, "NHL", { score: "0-0", period: "P1", elapsed: "15:00" }, "away"), gameState(19, "NHL", { score: "1-0", period: "P1", elapsed: "14:00" }, "away")).fair;
  assert.ok(h["s;0;m|home"] < 0.4, "away (listed first) scores -> home down");
  const ML = { "s;0;m": [["home", null, 0.55], ["away", null, 0.45]], "s;0;ou;8.5": [["over", 8.5, 0.5], ["under", 8.5, 0.5]] };
  const b = modelFair(3, "MLB", ML, gameState(3, "MLB", { score: "0-0", period: "Top 1st" }, "away"), gameState(3, "MLB", { score: "0-3", period: "Top 4th" }, "away")).fair;
  assert.ok(b["s;0;m|home"] > 0.75, "home up 3 in the 4th");
  const TL = { "s;0;m": [["home", null, 0.6], ["away", null, 0.4]] };
  assert.ok(!MODEL_SPORTS.has(33) && !MODEL_SPORTS.has(15) && MODEL_SPORTS.has(4), "football + tennis off after the backtest"); assert.equal(settleFor(4), 8); assert.equal(settleFor(19), 30);
  MODEL_SPORTS.add(33); MODEL_SPORTS.add(15);   // the math is still tested while those sports are switched off
  const t = modelFair(33, "ATP Challenger", TL, gameState(33, "ATP Challenger", { score: "3-3", period: "S1" }, "home"), gameState(33, "ATP Challenger", { score: "6-3, 2-0", period: "S2" }, "home")).fair;
  assert.ok(t["s;0;m|home"] > 0.85, "won the first set and leads the second");
  MODEL_SPORTS.delete(33); MODEL_SPORTS.delete(15);
  // scoreboard history -> the state at the moment the line was made (unknown around a score change)
  const T0 = 1.8e12; noteObs("H1", { score: "0-0", period: "2H", elapsed: "50" }, T0); noteObs("H1", { score: "0-0", period: "2H", elapsed: "51" }, T0 + 60e3);
  noteObs("H1", { score: "1-0", period: "2H", elapsed: "52" }, T0 + 120e3); noteObs("H1", { score: "1-0", period: "2H", elapsed: "55" }, T0 + 300e3);
  assert.equal(stateAt("H1", T0 + 61e3 - 1000).score, "0-0"); assert.equal(stateAt("H1", T0 + 90e3), null, "between the readings around a goal");
  assert.equal(stateAt("H1", T0 + 130e3), null, "just after a goal"); assert.equal(stateAt("H1", T0 + 200e3).score, "1-0");
  assert.equal(stateAt("H1", T0 - 5e3), null, "before our history");
  assert.equal(stateAt("H1", T0 + 130e3, 8).score, "1-0", "basketball-style 8 s settle"); assert.equal(stateAt("H1", T0 + 130e3, 0).since_s, 10);
  // liveRow blend: stale line + score changed -> "model"; fresh line -> "sharp live"; sport without a model -> paused
  const at = T0 + 300e3, anchor = { as_of: T0 + 30e3, lines: SL };
  const g = (o = {}) => ({ found: true, status: "started", suspended: false, fair: { "s;0;m|home": 0.4, "s;0;m|away": 0.25, "s;0;m|draw": 0.35 }, as_of: { "s;0;m": anchor.as_of }, line_as_of: anchor.as_of, anchor, ...o });
  const live = { at, pin: { "7": g(), "8": g({ as_of: { "s;0;m": at - 20e3 }, line_as_of: at - 20e3 }) }, jup: { H1: { score: "1-0", period: "2H", elapsed: "55", score_changed_at: T0 + 120e3 } } };
  const mrow = { pin_id: 7, pin_sport: 29, pin_key: "s;0;m", pin_d: "home", pin_sh: "home", event_id: "H1", side: "YES" };
  const m1 = liveRow(mrow, live); assert.equal(m1.src, "model"); assert.equal(m1.flag, null); assert.ok(m1.fair > 0.7, "goal priced in: " + m1.fair);
  assert.equal(m1.line_flag, "line behind score");
  assert.equal(liveRow({ ...mrow, side: "NO" }, live).fair, +(1 - m1.fair).toFixed(4));
  const f1 = liveRow({ ...mrow, pin_id: 8 }, { ...live, jup: { H1: { ...live.jup.H1, score_changed_at: T0 } } });
  assert.equal(f1.src, "sharp live"); assert.equal(f1.fair, 0.4);
  const p1 = liveRow({ ...mrow, pin_sport: 34 }, live); assert.equal(p1.src, "paused"); assert.equal(p1.flag, "line behind score"); assert.match(p1.model_why, /no model/);
  // the dashboard's query carries event~matchup pairs so /live can return the anchor's scoreboard
  const q = queryFor([mrow]); assert.deepEqual(q.pairs, [["H1", "7"]]); assert.deepEqual(parseQuery(new URLSearchParams(queryString(q))).pairs, [["H1", "7"]]);
  console.log("✓ in-game model: scoreboard parsing, soccer/basketball/hockey/MLB/tennis moves, identity at no change, history anchor, sharp live / model / paused");
}
console.log("\nALL TESTS PASSED");
