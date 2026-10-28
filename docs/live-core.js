// Luck Society live re-pricing core. ONE copy, used by:
//   - the Cloudflare Worker's GET /live endpoint (worker/src/index.js imports this file),
//   - the dashboard (docs/index.html loads it with import()),
//   - the Discord card refresh (worker/src/embed.js -> refreshForCard, used by the Worker and scripts/post-discord.mjs).
// Fair odds = Pinnacle live line for the exact market the scan matched (pin_id + pin_key + pin_d), de-vigged proportionally,
// exactly like scanner/scanner.py. Scores = Jupiter's scoreboard feed (/events/scores) + Pinnacle's own score.
export const PIN_BASE = "https://guest.api.arcadia.pinnacle.com/0.1";
export const PIN_KEY = "CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R";   // public key embedded in pinnacle.com's web front-end (same as the scanner)
export const JUP_BASE = "https://prediction-market-api.jup.ag/api/v1";
export const PIN_SPORTS = new Set([3, 4, 6, 8, 12, 15, 18, 19, 22, 27, 29, 33, 34]);
export const MAX_IDS = 30;
export const feeOf = p => 0.07 * p * (1 - p);
const amDec = a => 1 + (a > 0 ? a / 100 : 100 / -a);
export function devig(prices) {
  const imp = prices.map(p => 1 / amDec(+p)), s = imp.reduce((a, b) => a + b, 0);
  return { probs: imp.map(i => i / s), vig: s - 1 };
}

// validate + cap the query (ids: Pinnacle matchup ids, sports: Pinnacle sport ids, events: Jupiter event ids)
export function parseQuery(sp) {
  const list = (k, re) => [...new Set(String(sp.get(k) || "").split(",").map(s => s.trim()).filter(s => re.test(s)))];
  const ids = list("ids", /^\d{1,12}$/).slice(0, MAX_IDS);
  const sports = list("sports", /^\d{1,3}$/).map(Number).filter(s => PIN_SPORTS.has(s)).slice(0, 6);
  const events = list("events", /^[A-Za-z0-9_-]{1,40}$/).slice(0, MAX_IDS);
  // g = "event~pinId" pairs: which Jupiter game each Pinnacle matchup is, so /live can say what the score was when the line was made
  const pairs = list("g", /^[A-Za-z0-9_-]{1,40}~\d{1,12}$/).slice(0, MAX_IDS).map(s => s.split("~"));
  return { ids, sports, events, pairs };
}
export function queryFor(rows) {   // build the /live query for the rows on screen
  const r = rows.filter(r => r.pin_id && r.pin_key), ids = [...new Set(r.map(r => String(r.pin_id)))].slice(0, MAX_IDS);
  const keep = new Set(ids);
  return { ids, sports: [...new Set(r.filter(r => keep.has(String(r.pin_id))).map(r => r.pin_sport))].slice(0, 6),
    events: [...new Set(rows.filter(r => r.event_id && r.in_play !== false).map(r => r.event_id))].slice(0, MAX_IDS),
    pairs: [...new Set(r.filter(r => r.event_id && keep.has(String(r.pin_id))).map(r => `${r.event_id}~${r.pin_id}`))].slice(0, MAX_IDS).map(s => s.split("~")) };
}
export const queryString = q => `ids=${q.ids.join(",")}&sports=${q.sports.join(",")}&events=${q.events.map(encodeURIComponent).join(",")}` +
  (q.pairs?.length ? `&g=${q.pairs.map(p => p.join("~")).join(",")}` : "");

// Freshness note: Pinnacle's public guest feed sits behind Pinnacle's CDN (Cache-Control max-age≈900 s): each URL is
// refreshed only every ~15 min, so a line can be minutes old. Different URLs carrying the same market expire at different
// times, so we read several copies (per-matchup, "related", per-sport live), keep the newest version of each market, record
// how old that copy is (Last-Modified / Date-Age), and flag a row whenever the line is too old or the score changed after it.
export const SUBREQ_BUDGET = 48;            // Workers free plan: 50 subrequests per request
export const LINE_MAX_AGE_S = 300;          // Pinnacle line older than this -> "line old" flag (hidden from picks)
const versions = new Map();   // matchup id -> {v, at}: when we saw its Pinnacle line change (per process / Worker isolate)
const scores = new Map();     // jupiter event id -> {score, changed_at}: when we saw the score change
// Scoreboard history per Jupiter event (this process / Worker isolate / browser tab): lets us say what the score and clock
// were at the moment Pinnacle's CDN copy was made, which is what the model needs to move that line to the current state.
export const SCORE_SETTLE_S = 30;           // a line made < 30 s after a score change may not know about it yet
// per sport (Pinnacle sport id): basketball scores every ~20 s and its lines catch up within seconds (backtest: 8 s works, 15 s leaves almost no anchors)
export const SCORE_SETTLE = { 4: 8 };
export const settleFor = sid => SCORE_SETTLE[sid] ?? SCORE_SETTLE_S;
const hist = new Map();
export function noteObs(ev, j, t) {
  if (!ev || !j || j.score == null) return;
  let h = hist.get(ev); if (!h) hist.set(ev, h = []);
  const last = h[h.length - 1];
  const o = { t, t2: t, score: j.score, period: j.period, elapsed: j.elapsed, ended: !!j.ended };
  if (last && t < last.t2) {   // an older reading (e.g. the scan's score when the tab opens): only useful before our history
    if (t < h[0].t) { if (h[0].score === o.score && h[0].period === o.period && h[0].elapsed === o.elapsed) h[0].t = t; else h.unshift(o); }
    return;
  }
  if (last && last.score === j.score && last.period === j.period && last.elapsed === j.elapsed) { last.t2 = t; return; }
  h.push(o);
  while (h.length > 500 || (h.length && t - h[0].t2 > 45 * 60e3)) h.shift();
  if (hist.size > 300) hist.delete(hist.keys().next().value);
}
export const noteLive = live => { for (const [ev, j] of Object.entries(live?.jup || {})) noteObs(ev, j, live.at); };
// the scoreboard at time t (ms), or null if we can't be sure (outside our history, a score change around t, or too soon after one)
export function stateAt(ev, t, settleS = SCORE_SETTLE_S) {
  const h = hist.get(ev); if (!h || !h.length || t == null) return null;
  let i = -1; for (let k = h.length - 1; k >= 0; k--) if (h[k].t <= t) { i = k; break; }
  if (i < 0) return null;
  const e = h[i], n = h[i + 1];
  if (t > e.t2 + 20e3 && (!n || n.score !== e.score)) return null;     // gap in our readings around t
  if (n && n.score !== e.score && t > e.t2) return null;               // the score changed somewhere between two readings around t
  if (t > e.t2 + 600e3) return null;                                  // > 10 min gap: the clock can't be interpolated
  let k = i; while (k > 0 && h[k - 1].score === e.score) k--;
  if (t - h[k].t < settleS * 1000) return null;                       // this score had only just appeared
  const out = { score: e.score, period: e.period, elapsed: e.elapsed, ended: e.ended, since_s: (t - h[k].t) / 1000 };
  if (t > e.t2 + 6e3 && n) Object.assign(out, { next: { period: n.period, elapsed: n.elapsed }, w: (t - e.t2) / (n.t - e.t2) });   // clock between two readings
  return out;
}
const ANCHOR_KEY = /^s;0;(m$|ou;|s;)/;
function copyLines(body, id, now) {   // one CDN copy -> de-vigged open lines of the main markets {key: [[designation, points, prob]]}
  const lines = {};
  for (const y of body || []) {
    if (String(y.matchupId) !== id || y.period !== 0 || y.status !== "open" || !ANCHOR_KEY.test(y.key) || (y.cutoffAt && Date.parse(y.cutoffAt) <= now)) continue;
    const pr = (y.prices || []).filter(p => p.price != null && p.designation); if (pr.length < 2) continue;
    const { probs } = devig(pr.map(p => p.price));
    lines[y.key] = pr.map((p, i) => [p.designation, p.points ?? null, +probs[i].toFixed(4)]);
  }
  const trim = pre => Object.keys(lines).filter(k => k.startsWith(pre)).sort((a, b) => Math.abs(lines[a][0][2] - 0.5) - Math.abs(lines[b][0][2] - 0.5)).slice(4);
  for (const k of [...trim("s;0;ou;"), ...trim("s;0;s;")]) delete lines[k];   // keep the 4 most balanced totals / spreads
  return lines;
}
export const asOfFrom = h => {             // when a (possibly CDN-cached) response was fetched from Pinnacle's origin, ms
  // Date - Age = CDN fill time. Last-Modified is only a fallback: the CDN rewrites it on revalidation (seen later than the content)
  const lm = Date.parse(h.get("last-modified") || ""), d = Date.parse(h.get("date") || ""), age = +h.get("age") || 0;
  return Number.isFinite(d) ? d - age * 1000 : Number.isFinite(lm) ? lm : null;
};
export async function fetchLive({ ids, sports, events, pairs }, getJSON) {
  getJSON = getJSON || (async (url, headers) => { const r = await fetch(url, { headers }); if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`); return { __live: 1, body: await r.json(), asOf: asOfFrom(r.headers) }; });
  const get = async (u, h) => { const x = await getJSON(u, h); return x && x.__live ? x : { body: x, asOf: null }; };
  const ph = { "X-API-Key": PIN_KEY, Accept: "application/json" }, now = Date.now(), errors = [], want = new Set(ids.map(String));
  const sportJobs = sports.map(async sid => {
    const [mus, mks] = await Promise.all([get(`${PIN_BASE}/sports/${sid}/matchups/live`, ph), get(`${PIN_BASE}/sports/${sid}/markets/live/straight`, ph).catch(() => null)]);
    return { sid, mus, mks };
  });
  const nJup = Math.ceil(events.length / 20), budget = Math.max(0, SUBREQ_BUDGET - 2 * sports.length - nJup);
  const idl = [...want], n1 = Math.min(idl.length, budget), n2 = Math.min(idl.length, budget - n1);   // related copy for the top ids if budget allows
  const perJobs = [...idl.slice(0, n1).map(id => [id, `${PIN_BASE}/matchups/${id}/markets/straight`]), ...idl.slice(0, n2).map(id => [id, `${PIN_BASE}/matchups/${id}/markets/related/straight`])]
    .map(([id, u]) => get(u, ph).then(x => [id, x], () => [id, null]));
  const jupJobs = [];
  for (let i = 0; i < events.length; i += 20) jupJobs.push(get(`${JUP_BASE}/events/scores?eventIds=${events.slice(i, i + 20).map(encodeURIComponent).join(",")}`, { Accept: "application/json" }));
  const per = new Map();
  for (const [id, x] of await Promise.all(perJobs)) if (x) per.set(id, [...(per.get(id) || []), x]);
  const pin = {}, jup = {};
  for (const id of want) pin[id] = { found: false, suspended: true };
  for (const res of await Promise.allSettled(sportJobs)) {
    if (res.status !== "fulfilled") { errors.push("pinnacle: " + res.reason?.message); continue; }
    const { sid, mus, mks } = res.value, fetched = Date.now();
    for (const m of mus.body || []) {
      const id = String(m.id); if (!want.has(id)) continue;
      const ps = m.participants || [], sc = ["home", "away"].map(a => ps.find(p => p.alignment === a)?.state?.score);
      const p0 = (m.periods || []).find(p => p.period === 0) || {};
      // several cached copies of the same markets: per market key keep the highest version (ties: the most recently fetched copy)
      const pick = new Map();
      for (const x of [...(per.get(id) || []), mks].filter(Boolean))
        for (const y of x.body || []) {
          if (String(y.matchupId) !== id || y.period !== 0) continue;
          const c = pick.get(y.key), v = +y.version || 0;
          if (!c || v > c.v || (v === c.v && (x.asOf || 0) > (c.asOf || 0))) pick.set(y.key, { m: y, v, asOf: x.asOf ?? null });
        }
      const best = { own: [...pick.values()].map(c => c.m) };
      const asOfKey = Object.fromEntries([...pick].map(([k, c]) => [k, c.asOf]));
      const open = best.own.filter(x => x.status === "open" && (!x.cutoffAt || Date.parse(x.cutoffAt) > now) && !String(x.key).includes(";tt;"));
      const fair = {}, line = {};
      for (const x of open) {
        const pr = (x.prices || []).filter(p => p.price != null && p.designation);
        if (pr.length < 2) continue;
        const { probs, vig } = devig(pr.map(p => p.price));
        pr.forEach((p, i) => { fair[`${x.key}|${p.designation}`] = +probs[i].toFixed(4); });
        line[x.key] = { prices: pr.map(p => `${p.designation} ${p.points != null ? p.points + " " : ""}${p.price > 0 ? "+" : ""}${p.price}`).join(" / "), vig: +vig.toFixed(4) };
      }
      const v = Math.max(0, ...[...pick.values()].map(c => c.v)), prev = versions.get(id);
      if (!prev || prev.v !== v) versions.set(id, { v, at: prev ? fetched : null });
      const ao = Object.values(asOfKey).filter(Boolean), asOf = ao.length ? Math.min(...ao) : null;   // oldest copy in use
      // model anchor: the most recently made copy that still has open lines (all its lines share one moment, as_of)
      let anchor = null;
      for (const x of [...(per.get(id) || []), mks].filter(Boolean)) {
        if (!x.asOf || (anchor && x.asOf <= anchor.as_of)) continue;
        const lines = copyLines(x.body, id, now); if (Object.keys(lines).length) anchor = { as_of: x.asOf, lines };
      }
      pin[id] = { found: true, sport: sid, status: m.status, live_mode: m.liveMode || null, units: m.units || null,
        score: sc.every(Number.isInteger) ? sc : null, score_as_of: mus.asOf ?? null, clock: m.state || null,
        suspended: m.status !== "started" || p0.status !== "open" || !open.length,
        danger: m.liveMode === "danger_zone", fair, line, version: v, as_of: asOfKey,
        line_as_of: asOf, line_age_s: asOf ? Math.max(0, Math.round((now - asOf) / 1000)) : null,
        line_changed_at: versions.get(id).at, fetched_at: fetched, anchor };
    }
  }
  for (const res of await Promise.allSettled(jupJobs)) {
    if (res.status !== "fulfilled") { errors.push("jupiter: " + res.reason?.message); continue; }
    for (const x of res.value.body?.data || []) {
      const prev = scores.get(x.eventId);
      if (!prev || prev.score !== x.score) scores.set(x.eventId, { score: x.score, changed_at: prev ? now : null });
      jup[x.eventId] = { score: x.score, period: x.period, elapsed: x.elapsed, status: x.status, live: x.live, ended: x.ended,
        updated_at: x.updatedAt ? Math.floor(Date.parse(x.updatedAt) / 1000) : null, score_changed_at: scores.get(x.eventId).changed_at };
    }
  }
  for (const [ev, j] of Object.entries(jup)) noteObs(ev, j, now);
  for (const [ev, id] of pairs || []) { const a = pin[id]?.anchor; if (a) (a.state ||= {})[ev] = stateAt(ev, a.as_of, 0); }   // settle is checked per sport in modelFor
  if (scores.size > 2000) scores.clear();
  if (versions.size > 2000) versions.clear();
  return { at: now, pin, jup, errors };
}

const sortedEq = (a, b) => a.length === b.length && [...a].sort((x, y) => x - y).every((v, i) => v === [...b].sort((x, y) => x - y)[i]);
// game state for the model, with the clock interpolated when the moment falls between two scoreboard readings
function stateFor(sid, league, o, sh) {
  const A = gameState(sid, league, o, sh); if (!A || !o.next) return A;
  const N = gameState(sid, league, { ...o, ...o.next }, sh);
  if (N && N.rem != null && A.rem != null) { A.rem += (N.rem - A.rem) * o.w; if (A.w != null) A.w = soccerWeight(A.rem); }
  return A;
}
const fits = new Map();       // fitted model per (matchup, anchor copy, anchor state): the fit is the expensive part
let fitBudget = Infinity;     // callers on tight CPU (the Worker) can cap how many new fits one request may do
export const setFitBudget = n => { fitBudget = n; };
// the model's win chance for this row's exact market, or {why} when it can't give one
export function modelFor(r, g, j, live) {
  const sid = +r.pin_sport;
  if (!MODEL_SPORTS.has(sid)) return { why: "no model for this sport" };
  if (!r.pin_sh) return { why: "teams' score order unknown" };
  const an = g?.anchor; if (!an) return { why: "no open Pinnacle line" };
  const age = (live.at - an.as_of) / 1000; if (age > MODEL_MAX_ANCHOR_S) return { why: "Pinnacle line too old for the model" };
  const ao = an.state?.[r.event_id] || stateAt(r.event_id, an.as_of, settleFor(sid));
  if (!ao) return { why: "score at the line's time unknown" };
  if (ao.since_s != null && ao.since_s < settleFor(sid)) return { why: "Pinnacle line made right after a score change" };
  if (!j || j.score == null) return { why: "no live score" };
  const lg = r.pin_league || r.league || "", A = stateFor(sid, lg, ao, r.pin_sh), B = gameState(sid, lg, j, r.pin_sh);
  if (!A || !B) return { why: "game clock not readable" };
  const ck = `${r.pin_id}|${an.as_of}|${ao.score}|${ao.period}|${ao.elapsed}|${ao.w ?? ""}|${r.pin_sh}|${lg}`;
  let f = fits.get(ck);
  if (f === undefined) { if (fitBudget <= 0) return { why: "model busy" }; fitBudget--; f = fitModel(sid, lg, an.lines, A); fits.set(ck, f); if (fits.size > 400) fits.delete(fits.keys().next().value); }
  if (!f) return { why: "model can't read this line" };
  if (f.fit != null && f.fit > MODEL_MAX_FIT) return { why: "model doesn't fit Pinnacle's line" };
  const T = targetFor(r.pin_key), pr = T && movedLine(f, an.lines, A, B, T), q = pr?.[`${r.pin_key}|${r.pin_d}`];
  if (q == null || !Number.isFinite(q)) return { why: "model can't price this market" };
  return { q: clamp(q, 0.005, 0.995), anchor_age_s: Math.round(age), anchor_score: ao.score };
}
// what the live feed says about one scan row: {fair, flag, src, score, period, elapsed, ...}
// src: "sharp live" = Pinnacle's own line, < 60 s old and made after the last score change
//      "model"      = Pinnacle's latest line moved to the current score + clock by the in-game model
//      "sharp line" = Pinnacle line 1-5 min old, same score (only when the model can't price the row)
//      "paused"     = nothing trustworthy (flag says why)
export function liveRow(r, live, scoreChangedAt) {
  const g = live.pin?.[String(r.pin_id)], j = live.jup?.[r.event_id], out = { flag: null, fair: null, src: null };
  if (j) Object.assign(out, { score: j.score, period: j.period, elapsed: j.elapsed, ended: !!j.ended, score_at: j.updated_at });
  if (!r.pin_id || !r.pin_key || !g) return out;      // not part of this live query: leave the scan's values alone
  out.pin_score = g.score; out.line_changed_at = g.line_changed_at; out.danger = g.danger;
  const ka = g.as_of?.[r.pin_key] ?? g.line_as_of ?? null;   // when the copy holding this row's market was fetched by Pinnacle's CDN
  out.line_as_of = ka; out.line_age_s = ka ? Math.max(0, Math.round((live.at - ka) / 1000)) : null;
  let lineFair = null;
  if (!g.found || g.suspended) out.flag = "suspended";
  else {
    const q = g.fair[`${r.pin_key}|${r.pin_d}`];
    if (q == null) out.flag = "line off";
    else lineFair = r.side === "NO" ? +(1 - q).toFixed(4) : q;
  }
  if (!out.flag && out.line_age_s != null && out.line_age_s > LINE_MAX_AGE_S) out.flag = "line old";
  // the score moved after Pinnacle's line was produced -> the line doesn't know about it yet
  const chg = Math.max(j?.score_changed_at || 0, scoreChangedAt || 0);
  if (!out.flag && ka && chg && chg > ka) out.flag = "line behind score";
  let hard = null;
  if (j && j.ended) hard = "ended";
  // Pinnacle's score is a CDN copy too: a mismatch only means something if that copy is at least as new as the line
  if (j && g.score && /^\d+-\d+$/.test(String(j.score || "")) && !sortedEq(j.score.split("-").map(Number), g.score) &&
    !(g.score_as_of && ka && g.score_as_of < ka)) hard = "score mismatch";
  if (hard) { out.flag = hard; out.src = "paused"; return out; }
  if (!out.flag && lineFair != null && out.line_age_s != null && out.line_age_s <= FRESH_LINE_S) { out.fair = lineFair; out.src = "sharp live"; return out; }
  if (g.found && g.status === "started") {
    const m = modelFor(r, g, j, live);
    if (m.q != null) { out.fair = +(r.side === "NO" ? 1 - m.q : m.q).toFixed(4); out.src = "model"; out.model_why = null;
      out.anchor_age_s = m.anchor_age_s; out.anchor_score = m.anchor_score; out.line_flag = out.flag; out.flag = null; return out; }
    out.model_why = m.why;
  }
  if (!out.flag && lineFair != null) { out.fair = lineFair; out.src = "sharp line"; return out; }
  out.src = "paused"; return out;
}
// mutate a row in place with the live view; recompute edge from its current Buy price (never from the meter)
// scoreChangedAt (optional, ms): when the caller itself saw this game's score change (the dashboard tracks it across polls)
export function applyLiveRow(r, live, scoreChangedAt) {
  if (!live || (!live.pin && !live.jup)) return r;
  const j = live.jup?.[r.event_id];   // the score we had for this row differs from now -> it changed since we last looked
  // the scan's own scoreboard reading (an older observation) helps say what the score was when an old line was made
  if (r.event_id && r._seed !== 1 && r.score != null && r.price_ts) { noteObs(r.event_id, { score: r.score, period: r.period, elapsed: r.elapsed }, r.price_ts * 1000); r._seed = 1; }
  noteLive(live);
  // changed after the last time we saw the old score (r.score_at, unix s): a safe lower bound for when it changed
  if (j && j.score != null && r.score != null && String(j.score) !== String(r.score)) r.score_changed_at = r.score_at ? r.score_at * 1000 : live.at;
  const x = liveRow(r, live, Math.max(scoreChangedAt || 0, r.score_changed_at || 0) || null);
  if (x.score != null) { r.score = x.score; r.period = x.period; r.elapsed = x.elapsed; r.score_at = x.score_at; }
  r.live_flag = x.flag; r.pin_score = x.pin_score; r.line_changed_at = x.line_changed_at;
  if (x.src) { r.fair_src = x.src; r.model_why = x.model_why ?? null; r.anchor_age_s = x.anchor_age_s ?? null; }
  if (x.line_as_of) r.line_as_of = Math.floor(x.line_as_of / 1000);   // unix s, same unit as the scanner's line_as_of
  if (x.fair != null) { r.fair_prob = x.fair; r.fair_ts = Math.floor(live.at / 1000); r.fair_live = true; }
  if (r.price != null && r.fair_prob != null && ["order book", "jupiter live"].includes(r.price_src)) {
    const c = r.price + feeOf(r.price); r.edge_pts = +(r.fair_prob - c).toFixed(4); r.ev_per_dollar = +(r.fair_prob / c - 1).toFixed(4);
  }
  return r;
}
// a row's sharp line is too old to trust (works for scan rows and live-refreshed rows alike)
export const lineTooOld = (r, nowS = Date.now() / 1000) => r.fair_src !== "model" && !!r.line_as_of && nowS - r.line_as_of > LINE_MAX_AGE_S;
// ask for one side from a Jupiter order book (REST /orderbook or the websocket): buying YES fills NO bids
export function bookAsk(book, side) {
  const opp = (side === "NO" ? book?.yes_dollars : book?.no_dollars) || [];
  return opp.length ? +Math.min(...opp.map(([p]) => 1 - +p)).toFixed(4) : null;
}

// ============================================================================================================
// In-game win-probability MODEL (free, seconds-fresh). Pinnacle's live line is the anchor: at the moment Pinnacle
// produced its last open line (as_of) we know the game state (score + clock, from Jupiter's scoreboard). We fit a small
// sport model to that line at that state, then move the model to the CURRENT state (new score, less time left).
// So the model only has to explain what changed since the line - not the whole game. Used when the line is stale or
// behind the score; a fresh line (< FRESH_LINE_S, not behind the score) is used as-is ("sharp live").
// ============================================================================================================
export const FRESH_LINE_S = 60;            // line younger than this and not behind the score -> use it directly
export const MODEL_MAX_ANCHOR_S = 900;     // never extrapolate from a line older than this (15 min)
export const MODEL_MAX_FIT = 0.05;         // the fitted model must reproduce the anchor line within 5 pts (RMS) before we trust its moves
// sports with a validated model (backtest vs fresh Pinnacle lines; see README). Others fall back to the line / paused.
// enabled after tonight's backtest (MAE vs fresh Pinnacle lines ≤ ~5 pts and better than the stale line): soccer, basketball, hockey, baseball.
// Off: football (15, MAE 13–17 pts: possession/field position matter too much) and tennis (33, too few samples and worse than the stale line).
export const MODEL_SPORTS = new Set([29, 4, 19, 3]);
export const MODEL_CFG = {
  soccer: { stop1: 2, stop2: 5, ramp: 0.25 },            // stoppage minutes; goal-rate ramp over the match (+25% at 90')
  hockey: { otShrink: 0.6, en: 0.0 },                     // OT/shootout winner leans toward the stronger side; empty-net boost
  bball: { NBA: { len: 48, per: 4, sd: 14, sdT: 18 }, NCAA: { len: 40, per: 2, sd: 12.5, sdT: 16 }, WNBA: { len: 40, per: 4, sd: 12, sdT: 15 }, def: { len: 40, per: 4, sd: 12.5, sdT: 16 } },
  football: { NFL: { len: 60, per: 4, sd: 13.5, sdT: 13 }, NCAA: { len: 60, per: 4, sd: 15.5, sdT: 15 }, def: { len: 60, per: 4, sd: 14, sdT: 14 } },
  baseball: { innings: 9 },
  tennis: { ATP: 0.64, WTA: 0.56, ITFW: 0.55, ITFM: 0.62, CH: 0.63, def: 0.60 },
};
const SQ2 = Math.SQRT2;
function erf(x) { const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x);
  return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)); }
const Phi = z => 0.5 * (1 + erf(z / SQ2));
function PhiInv(p) { p = Math.min(1 - 1e-9, Math.max(1e-9, p)); let lo = -9, hi = 9; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (Phi(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; }
function pois(l, n) { const o = new Array(n + 1); o[0] = Math.exp(-l); for (let k = 1; k <= n; k++) o[k] = o[k - 1] * l / k; return o; }
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

// ---- game state from Jupiter's scoreboard (score text in TITLE order; sh = which Pinnacle side the title's first team is)
const num = s => { const m = String(s ?? "").match(/(\d+)(?:\s*\+\s*(\d+))?/); return m ? [+m[1], +(m[2] || 0)] : null; };
const clockMin = s => { const m = String(s ?? "").match(/^(\d{1,2}):(\d{2})$/); return m ? +m[1] + +m[2] / 60 : null; };
export function gameState(sid, league, j, sh) {
  if (!j || j.score == null) return null;
  const P = String(j.period || "").toUpperCase(), lg = String(league || "");
  if (j.ended || /^(FT|FINAL|F|ENDED|AET|PEN)/.test(P)) return null;
  if (sid === 33) return tennisState(j.score, P, sh);
  const m = String(j.score).match(/^(\d+)\s*-\s*(\d+)$/); if (!m) return null;
  const s0 = +m[1], s1 = +m[2], h = sh === "away" ? s1 : s0, a = sh === "away" ? s0 : s1;
  const st = { h, a, sid };
  if (sid === 29) {   // soccer: elapsed minute
    const c = MODEL_CFG.soccer, e = num(j.elapsed);
    if (P === "HT") st.rem = 45 + c.stop2; else if (P === "1H" && e) st.rem = Math.max(0, 45 - e[0]) + Math.max(0, c.stop1 - e[1] - Math.max(0, e[0] - 45)) + 45 + c.stop2;
    else if (P === "2H" && e) { const over = e[1] + Math.max(0, e[0] - 90); st.rem = Math.max(0, 90 - Math.min(90, e[0])) + Math.max(0.5, c.stop2 - over); }
    else if (P === "NS" || P === "") st.rem = 90 + c.stop1 + c.stop2; else return null;
    st.w = soccerWeight(st.rem); return st;
  }
  if (sid === 4 || sid === 15 || sid === 19) {
    const cfg = sid === 19 ? { len: 60, per: 3 } : sportCfg(sid, lg), q = cfg.len / cfg.per, c = clockMin(j.elapsed);
    let n = (P.match(/^(?:Q|P|H)(\d)/) || [])[1];
    if (/^(HT|HALF)/.test(P)) { st.rem = cfg.len / 2; st.per = cfg.per; return st; }
    if (/OT|SO/.test(P)) { st.rem = 0; st.ot = true; st.otClock = c ?? (sid === 19 ? 5 : 5); return st; }
    if (/^END/.test(P)) { n = (P.match(/(\d)/) || [])[1]; if (!n) return null; st.rem = Math.max(0, (cfg.per - +n) * q); return st; }
    if (!n || c == null) return null;
    st.rem = Math.max(0, (cfg.per - +n) * q + Math.min(c, q)); return st;
  }
  if (sid === 3) {   // baseball: "Top 5th" / "Bot 5th" / "Mid 5th" / "End 5th"
    const mm = P.match(/^(TOP|BOT|BOTTOM|MID|MIDDLE|END)\s*(\d+)/); if (!mm) return null;
    const n = +mm[2], half = mm[1].slice(0, 3), N = MODEL_CFG.baseball.innings;
    // remaining half-innings for each side (an in-progress half counts as 0.5)
    const ra = half === "TOP" ? N - n + 0.5 : N - n, rh = half === "TOP" || half === "MID" ? N - n + 1 : half === "BOT" ? N - n + 0.5 : N - n;
    st.ra = Math.max(0, ra); st.rh = Math.max(0, rh); st.inning = n; st.half = half; return st;
  }
  return null;
}
function soccerWeight(rem) {   // goal-rate-weighted minutes left: rate rises linearly by `ramp` over the match
  const r = MODEL_CFG.soccer.ramp, T = 90 + MODEL_CFG.soccer.stop1 + MODEL_CFG.soccer.stop2, t0 = Math.max(0, T - rem);
  const f = t => t + r * t * t / (2 * T); return f(T) - f(t0);
}
function sportCfg(sid, lg) {
  const c = sid === 4 ? MODEL_CFG.bball : MODEL_CFG.football;
  if (/WNBA/i.test(lg)) return c.WNBA || c.def;
  if (/\bNBA\b/i.test(lg)) return c.NBA; if (/\bNFL\b/i.test(lg)) return c.NFL;
  if (/NCAA|College|CFB|CBB/i.test(lg)) return c.NCAA; return c.def;
}

// ---- tennis
function tennisState(score, P, sh) {
  const sets = String(score).split(",").map(s => s.trim()).filter(Boolean); if (!sets.length) return null;
  const parsed = []; for (const s of sets) { const m = s.match(/^(\d+)-(\d+)(?:\((\d+)-(\d+)\))?$/); if (!m) return null; parsed.push(m.slice(1).map(x => x == null ? null : +x)); }
  let sa = 0, sb = 0, cur = null;
  parsed.forEach(([g0, g1, t0, t1], i) => {
    const done = (Math.max(g0, g1) >= 6 && Math.abs(g0 - g1) >= 2) || (Math.max(g0, g1) === 7 && Math.min(g0, g1) >= 5);
    if (done && !(i === parsed.length - 1 && /^TB/.test(P) && g0 === 6 && g1 === 6)) { if (g0 > g1) sa++; else sb++; }
    else if (i === parsed.length - 1) cur = [g0, g1, t0 ?? 0, t1 ?? 0];
    else return;
  });
  if (!cur) cur = [0, 0, 0, 0];
  const sw = sh === "away";   // title's first player is Pinnacle's away side -> swap so index 0 = home
  return sw ? { sid: 33, sets: [sb, sa], g: [cur[1], cur[0]], tb: [cur[3], cur[2]], games: totalGames(parsed) } : { sid: 33, sets: [sa, sb], g: [cur[0], cur[1]], tb: [cur[2], cur[3]], games: totalGames(parsed) };
}
const totalGames = p => p.reduce((s, [a, b]) => s + a + b, 0);
function pGame(p) { const q = 1 - p, d = p * p / (1 - 2 * p * q); return p ** 4 * (1 + 4 * q + 10 * q * q) + 20 * p ** 3 * q ** 3 * d; }
function pTB(pa, pb, a, b, aServesFirst, memo) {   // P(home wins tiebreak) from points a-b; first TB point served by aServesFirst
  const key = a * 100 + b; if (memo.has(key)) return memo.get(key);
  let r;
  if (a >= 7 && a - b >= 2) r = 1; else if (b >= 7 && b - a >= 2) r = 0;
  else if (a >= 6 && b >= 6 && a === b) {   // deuce in TB: two points, one each server -> closed form
    const x = pa * (1 - pb), y = (1 - pa) * pb; r = x / (x + y);
  } else {
    const n = a + b, homeServes = ((Math.floor((n + 1) / 2)) % 2 === 0) === aServesFirst, p = homeServes ? pa : 1 - pb;
    r = p * pTB(pa, pb, a + 1, b, aServesFirst, memo) + (1 - p) * pTB(pa, pb, a, b + 1, aServesFirst, memo);
  }
  memo.set(key, r); return r;
}
function pSet(pa, pb, ga, gb, homeServes, tb, memo) {   // P(home wins set) from games ga-gb, homeServes next game
  const key = ga * 1000 + gb * 10 + (homeServes ? 1 : 0); if (!tb && memo.has(key)) return memo.get(key);
  let r;
  if ((ga >= 6 && ga - gb >= 2) || ga === 7) r = 1; else if ((gb >= 6 && gb - ga >= 2) || gb === 7) r = 0;
  else if (ga === 6 && gb === 6) r = pTB(pa, pb, tb ? tb[0] : 0, tb ? tb[1] : 0, homeServes, new Map());
  else { const g = homeServes ? pGame(pa) : 1 - pGame(pb); r = g * pSet(pa, pb, ga + 1, gb, !homeServes, null, memo) + (1 - g) * pSet(pa, pb, ga, gb + 1, !homeServes, null, memo); }
  if (!tb) memo.set(key, r); return r;
}
function pMatch(pa, pb, st, best, homeServes) {
  const need = (best + 1) / 2, memo = new Map();
  const ps0 = pSet(pa, pb, 0, 0, true, null, new Map()), ps1 = pSet(pa, pb, 0, 0, false, null, new Map()), psN = (ps0 + ps1) / 2;   // later sets: server unknown
  const cur = pSet(pa, pb, st.g[0], st.g[1], homeServes, st.g[0] === 6 && st.g[1] === 6 ? st.tb : null, memo);
  const rest = (a, b) => { if (a >= need) return 1; if (b >= need) return 0; return psN * rest(a + 1, b) + (1 - psN) * rest(a, b + 1); };
  return cur * rest(st.sets[0] + 1, st.sets[1]) + (1 - cur) * rest(st.sets[0], st.sets[1] + 1);
}
function tennisBase(lg) { const c = MODEL_CFG.tennis, s = String(lg || "");
  if (/ITF/i.test(s)) return /women|\bW\d|ITF W/i.test(s) ? c.ITFW : c.ITFM; if (/Challenger/i.test(s)) return c.CH;
  if (/WTA/i.test(s)) return c.WTA; if (/ATP/i.test(s)) return c.ATP; return c.def; }
const tennisWin = (d, base, st, best) => { const pa = clamp(base + d, 0.3, 0.95), pb = clamp(base - d, 0.3, 0.95);
  return 0.5 * (pMatch(pa, pb, st, best, true) + pMatch(pa, pb, st, best, false)); };   // who serves now: unknown -> average

// ---- fit + move. lines: {key: [[designation, points, prob], ...]} all from ONE Pinnacle copy (same as_of).
// A = game state when that copy was produced. fitModel -> {fit, predict(B, targets)} ; predict returns {"key|designation": prob}
// for every key in targets (default: the anchor's own keys), at game state B (now).
export function fitModel(sid, league, lines, A) {
  if (!A || !MODEL_SPORTS.has(sid) || A.sid !== sid) return null;
  try {
    if (sid === 29 || sid === 19) return goalsModel(sid, lines, A);
    if (sid === 4 || sid === 15) return marginModel(sid, league, lines, A);
    if (sid === 3) return runsModel(lines, A);
    if (sid === 33) return tennisModel(league, lines, A);
  } catch { return null; }
  return null;
}
export function modelFair(sid, league, lines, A, B, targets) {
  const f = fitModel(sid, league, lines, A); if (!f || !B) return null;
  try { const fair = movedLine(f, lines, A, B, targets || lines); return fair ? { fair, fit: f.fit } : null; } catch { return null; }
}
// The model is used for the CHANGE only: logit(now) = logit(Pinnacle at A) + [logit(model at B) - logit(model at A)].
// So with no change in the game the answer is exactly Pinnacle's line, and model bias (no empty net, no possession...) mostly cancels.
const logit = p => Math.log(p / (1 - p)), sig = x => 1 / (1 + Math.exp(-x));
export function movedLine(f, lines, A, B, T) {
  const pB = f.predict(B, T); if (!pB) return null;
  const pA = f.predict(A, T) || {}, out = {};
  for (const k of Object.keys(T)) {
    const ds = Object.keys(pB).filter(x => x.startsWith(k + "|")); if (!ds.length) continue;
    const L = lines[k] ? Object.fromEntries(lines[k].map(([d, , p]) => [d, p])) : null;
    let sum = 0;
    for (const kd of ds) {
      const d = kd.slice(k.length + 1), b = clamp(pB[kd], 1e-4, 1 - 1e-4), a = pA[kd], l = L?.[d];
      out[kd] = l != null && a != null && l > 0 && l < 1 ? sig(logit(clamp(l, 1e-4, 1 - 1e-4)) + logit(b) - logit(clamp(a, 1e-4, 1 - 1e-4))) : b;
      sum += out[kd];
    }
    for (const kd of ds) out[kd] /= sum;
  }
  return out;
}
// a target key for the row's market even when the anchor copy has a different line (e.g. total 5.5 vs 6.5)
export function targetFor(key) {
  const p = String(key).split(";");
  if (key === "s;0;m") return { [key]: [["home"], ["away"], ["draw"]] };
  if (p[2] === "ou") return { [key]: [["over", +p[3]], ["under", +p[3]]] };
  if (p[2] === "s") return { [key]: [["home", +p[3]], ["away", -p[3]]] };
  return null;
}
const ml = lines => lines["s;0;m"] ? Object.fromEntries(lines["s;0;m"].map(([d, , p]) => [d, p])) : null;
const totals = lines => Object.entries(lines).filter(([k]) => k.startsWith("s;0;ou;")).map(([k, v]) => ({ k, L: +k.split(";")[3], over: (v.find(x => x[0] === "over") || [])[2] })).filter(x => x.over != null);
const spreads = lines => Object.entries(lines).filter(([k]) => k.startsWith("s;0;s;")).map(([k, v]) => { const h = v.find(x => x[0] === "home"); return h && h[1] != null ? { k, p: +h[1], home: h[2] } : null; }).filter(Boolean);

// soccer / hockey / baseball: independent Poisson scoring for the rest of the game -> distributions of the final margin
// and final total (a tie at the end goes to OT / extra innings: +1 to the winner, who leans to the stronger side)
function scoreDist(h0, a0, lh, la, tieHome) {
  const N = Math.max(10, Math.ceil(lh + la + 4 * Math.sqrt(lh + la + 1) + 4)), ph = pois(lh, N), pa = pois(la, N);
  const off = N + a0 + 2, marg = new Float64Array(2 * N + h0 + a0 + 6), tot = new Float64Array(2 * N + h0 + a0 + 4);
  for (let x = 0; x <= N; x++) { const px = ph[x]; if (px < 1e-12) continue;
    for (let y = 0; y <= N; y++) { const p = px * pa[y]; if (p < 1e-12) continue; const d = h0 + x - a0 - y, t = h0 + a0 + x + y;
      if (d === 0 && tieHome != null) { marg[off + 1] += p * tieHome; marg[off - 1] += p * (1 - tieHome); tot[t + 1] += p; }
      else { marg[off + d] += p; tot[t] += p; } } }
  return { marg, tot, off };
}
function distProbs(D, lines, noSpread) {
  const out = {}, { marg, tot, off } = D, sumM = (f) => { let s = 0; for (let i = 0; i < marg.length; i++) if (marg[i] && f(i - off)) s += marg[i]; return s; };
  const S = sumM(() => true);
  for (const [k, v] of Object.entries(lines)) {
    if (k === "s;0;m") { const h = sumM(d => d > 0), dr = sumM(d => d === 0); out[`${k}|home`] = h / S; out[`${k}|away`] = (S - h - dr) / S; if (v.some(x => x[0] === "draw")) out[`${k}|draw`] = dr / S; }
    else if (k.startsWith("s;0;ou;")) { const L = +k.split(";")[3]; let o = 0, u = 0; for (let t = 0; t < tot.length; t++) { if (t > L) o += tot[t]; else if (t < L) u += tot[t]; }
      if (o + u > 0) { out[`${k}|over`] = o / (o + u); out[`${k}|under`] = u / (o + u); } }
    else if (k.startsWith("s;0;s;") && !noSpread) { const pts = +k.split(";")[3]; if (!Number.isFinite(pts)) continue;
      const w = sumM(d => d + pts > 0), l = sumM(d => d + pts < 0); if (w + l > 0) { out[`${k}|home`] = w / (w + l); out[`${k}|away`] = l / (w + l); } }
  }
  return out;
}
function fitErr(pr, lines, noSpread) {
  let e = 0, n = 0;
  for (const [k, v] of Object.entries(lines)) { if (noSpread && k.startsWith("s;0;s;")) continue;
    for (const [d, , p] of v) { const q = pr[`${k}|${d}`]; if (q != null && d !== "under" && !(k.startsWith("s;0;s;") && d === "away")) { e += (q - p) ** 2; n++; } } }
  return n ? e / n : Infinity;
}
function fit2(err, mu0, muMax) {   // minimise err(mu, s): coarse grid in log(mu) x s, then zoom
  let best = [Infinity, mu0, 0.5];
  for (let i = 0; i < 10; i++) for (let j = 1; j < 10; j++) { const mu = muMax * Math.pow(0.6, 9 - i), s = j / 10, e = err(mu, s); if (e < best[0]) best = [e, mu, s]; }
  for (const [fm, ds] of [[0.25, 0.05], [0.08, 0.015], [0.025, 0.005]]) { const [, m0, s0] = best;
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) { const mu = m0 * (1 + i * fm), s = clamp(s0 + j * ds, 0.01, 0.99); if (mu <= 0) continue; const e = err(mu, s); if (e < best[0]) best = [e, mu, s]; } }
  return best;
}
function goalsModel(sid, lines, A) {
  const noSp = sid === 29;   // Pinnacle's live soccer handicaps count goals from the current score -> not modelled
  const otS = s => sid === 19 ? 0.5 + (s - 0.5) * MODEL_CFG.hockey.otShrink : null;
  const wA = sid === 29 ? A.w : A.rem; if (!(wA > 0.5)) return null;
  const err = (mu, s) => fitErr(distProbs(scoreDist(A.h, A.a, mu * s, mu * (1 - s), otS(s)), lines, noSp), lines, noSp);
  const best = fit2(err, 1, sid === 29 ? 5 * wA / 90 : 9 * wA / 60);
  const [, mu, s] = best;
  return { fit: Math.sqrt(best[0]), mu, s, predict(B, T) { if (B.sid !== sid) return null; const f = Math.max(0, sid === 29 ? B.w : B.rem) / wA;
    return distProbs(scoreDist(B.h, B.a, mu * s * f, mu * (1 - s) * f, otS(s)), T, noSp); } };
}
// basketball / football: Brownian margin + total. sd per sport (full game), scaled by sqrt(fraction of time left)
function marginModel(sid, league, lines, A) {
  const cfg = sportCfg(sid, league); if (A.ot) return null;
  const rA = A.rem / cfg.len; if (!(rA > 0.01)) return null;
  const sA = cfg.sd * Math.sqrt(rA), tA = cfg.sdT * Math.sqrt(rA), DA = A.h - A.a, TA = A.h + A.a;
  const est = [], add = (mu, p) => { if (p > 0.003 && p < 0.997) { const z = PhiInv(p); est.push([mu, Math.exp(-z * z / 2)]); } };
  const M = ml(lines); if (M && M.home != null) add(sA * PhiInv(M.home) - DA, M.home);
  for (const x of spreads(lines)) add(sA * PhiInv(x.home) - DA - x.p, x.home);
  if (!est.length) return null;
  const mu = est.reduce((s, [m, w]) => s + m * w, 0) / est.reduce((s, [, w]) => s + w, 0);   // expected rest-of-game margin (home)
  const tt = totals(lines).filter(t => t.over > 0.003 && t.over < 0.997).map(t => { const z = PhiInv(t.over); return [tA * z - TA + t.L, Math.exp(-z * z / 2)]; });
  const tau = tt.length ? tt.reduce((s, [m, w]) => s + m * w, 0) / tt.reduce((s, [, w]) => s + w, 0) : null;   // expected rest-of-game points
  const fit = Math.max(0, ...est.map(([m]) => Math.abs(Phi((DA + mu) / sA) - Phi((DA + m) / sA))));
  return { fit, mu, tau, predict(B, T) {
    if (B.sid !== sid || B.ot) return null;
    const rB = Math.max(0, B.rem) / cfg.len, f = rB / rA, sB = cfg.sd * Math.sqrt(Math.max(rB, 1e-6)), tB = cfg.sdT * Math.sqrt(Math.max(rB, 1e-6));
    const DB = B.h - B.a, TB = B.h + B.a, out = {}, pm = x => Phi((DB + mu * f + x) / sB);
    for (const k of Object.keys(T)) {
      if (k === "s;0;m") { const ph = pm(0); out[`${k}|home`] = ph; out[`${k}|away`] = 1 - ph; }
      else if (k.startsWith("s;0;s;")) { const pts = +k.split(";")[3]; if (Number.isFinite(pts)) { const p = pm(pts); out[`${k}|home`] = p; out[`${k}|away`] = 1 - p; } }
      else if (k.startsWith("s;0;ou;") && tau != null) { const L = +k.split(";")[3], p = Phi((TB + tau * f - L) / tB); out[`${k}|over`] = p; out[`${k}|under`] = 1 - p; }
    }
    return out; } };
}
// baseball: Poisson runs per remaining half-inning for each side (mu = runs per 9 innings for both teams together)
function runsModel(lines, A) {
  if (!(A.ra + A.rh > 0.4)) return null; const N = MODEL_CFG.baseball.innings;
  const dist = (st, mu, s) => scoreDist(st.h, st.a, mu * s * st.rh / N, mu * (1 - s) * st.ra / N, 0.5 + (s - 0.5) * 0.5);
  const best = fit2((mu, s) => fitErr(distProbs(dist(A, mu, s), lines), lines), 9, 20), [, mu, s] = best;
  return { fit: Math.sqrt(best[0]), mu, s, predict(B, T) { return B.sid === 3 ? distProbs(dist(B, mu, s), T) : null; } };
}
// tennis: point-on-serve Markov chain; the serve-strength gap is fitted to the moneyline at the anchor state
function tennisModel(league, lines, A) {
  const M = ml(lines); if (!M || M.home == null) return null;
  const best = /Grand Slam|Wimbledon|US Open|French Open|Roland|Australian Open/i.test(league) && !/WTA|Women/i.test(league) ? 5 : 3;
  const base = tennisBase(league); let lo = -0.3, hi = 0.3;
  for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (tennisWin(m, base, A, best) < M.home) lo = m; else hi = m; }
  const d = (lo + hi) / 2, fit = Math.abs(tennisWin(d, base, A, best) - M.home);
  return { fit, d, predict(B, T) { if (B.sid !== 33 || !T["s;0;m"]) return null; const ph = tennisWin(d, base, B, best); return { "s;0;m|home": ph, "s;0;m|away": 1 - ph }; } };
}
