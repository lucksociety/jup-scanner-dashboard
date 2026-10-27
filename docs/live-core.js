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
  return { ids, sports, events };
}
export function queryFor(rows) {   // build the /live query for the rows on screen
  const r = rows.filter(r => r.pin_id && r.pin_key), ids = [...new Set(r.map(r => String(r.pin_id)))].slice(0, MAX_IDS);
  const keep = new Set(ids);
  return { ids, sports: [...new Set(r.filter(r => keep.has(String(r.pin_id))).map(r => r.pin_sport))].slice(0, 6),
    events: [...new Set(rows.filter(r => r.event_id && r.in_play !== false).map(r => r.event_id))].slice(0, MAX_IDS) };
}

// Freshness note: Pinnacle's public guest feed sits behind Pinnacle's CDN (Cache-Control max-age≈900 s): each URL is
// refreshed only every ~15 min, so a line can be minutes old. Different URLs carrying the same market expire at different
// times, so we read several copies (per-matchup, "related", per-sport live), keep the newest version of each market, record
// how old that copy is (Last-Modified / Date-Age), and flag a row whenever the line is too old or the score changed after it.
export const SUBREQ_BUDGET = 48;            // Workers free plan: 50 subrequests per request
export const LINE_MAX_AGE_S = 300;          // Pinnacle line older than this -> "line old" flag (hidden from picks)
const versions = new Map();   // matchup id -> {v, at}: when we saw its Pinnacle line change (per process / Worker isolate)
const scores = new Map();     // jupiter event id -> {score, changed_at}: when we saw the score change
export const asOfFrom = h => {             // when a (possibly CDN-cached) response was produced, ms
  const lm = Date.parse(h.get("last-modified") || ""), d = Date.parse(h.get("date") || ""), age = +h.get("age") || 0;
  return Number.isFinite(lm) ? lm : Number.isFinite(d) ? d - age * 1000 : null;
};
export async function fetchLive({ ids, sports, events }, getJSON) {
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
      pin[id] = { found: true, sport: sid, status: m.status, live_mode: m.liveMode || null, units: m.units || null,
        score: sc.every(Number.isInteger) ? sc : null, score_as_of: mus.asOf ?? null, clock: m.state || null,
        suspended: m.status !== "started" || p0.status !== "open" || !open.length,
        danger: m.liveMode === "danger_zone", fair, line, version: v, as_of: asOfKey,
        line_as_of: asOf, line_age_s: asOf ? Math.max(0, Math.round((now - asOf) / 1000)) : null,
        line_changed_at: versions.get(id).at, fetched_at: fetched };
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
  if (scores.size > 2000) scores.clear();
  if (versions.size > 2000) versions.clear();
  return { at: now, pin, jup, errors };
}

const sortedEq = (a, b) => a.length === b.length && [...a].sort((x, y) => x - y).every((v, i) => v === [...b].sort((x, y) => x - y)[i]);
// what the live feed says about one scan row: {fair, flag, score, period, elapsed, ...}
export function liveRow(r, live, scoreChangedAt) {
  const g = live.pin?.[String(r.pin_id)], j = live.jup?.[r.event_id], out = { flag: null, fair: null };
  if (j) Object.assign(out, { score: j.score, period: j.period, elapsed: j.elapsed, ended: !!j.ended, score_at: j.updated_at });
  if (!r.pin_id || !r.pin_key || !g) return out;      // not part of this live query: leave the scan's values alone
  out.pin_score = g.score; out.line_changed_at = g.line_changed_at; out.danger = g.danger;
  const ka = g.as_of?.[r.pin_key] ?? g.line_as_of ?? null;   // when the copy holding this row's market was fetched by Pinnacle's CDN
  out.line_as_of = ka; out.line_age_s = ka ? Math.max(0, Math.round((live.at - ka) / 1000)) : null;
  if (!g.found || g.suspended) out.flag = "suspended";
  else {
    const q = g.fair[`${r.pin_key}|${r.pin_d}`];
    if (q == null) out.flag = "line off";
    else out.fair = r.side === "NO" ? +(1 - q).toFixed(4) : q;
  }
  if (!out.flag && out.line_age_s != null && out.line_age_s > LINE_MAX_AGE_S) out.flag = "line old";
  // the score moved after Pinnacle's line was produced -> the win chance doesn't know about it yet
  const chg = Math.max(j?.score_changed_at || 0, scoreChangedAt || 0);
  if (!out.flag && ka && chg && chg > ka) out.flag = "line behind score";
  if (j && j.ended) out.flag = "ended";
  // Pinnacle's score is a CDN copy too: a mismatch only means something if that copy is at least as new as the line
  if (j && g.score && /^\d+-\d+$/.test(String(j.score || "")) && !sortedEq(j.score.split("-").map(Number), g.score) &&
    !(g.score_as_of && ka && g.score_as_of < ka)) out.flag = "score mismatch";
  return out;
}
// mutate a row in place with the live view; recompute edge from its current Buy price (never from the meter)
// scoreChangedAt (optional, ms): when the caller itself saw this game's score change (the dashboard tracks it across polls)
export function applyLiveRow(r, live, scoreChangedAt) {
  if (!live || (!live.pin && !live.jup)) return r;
  const j = live.jup?.[r.event_id];   // the score we had for this row differs from now -> it changed since we last looked
  // changed after the last time we saw the old score (r.score_at, unix s): a safe lower bound for when it changed
  if (j && j.score != null && r.score != null && String(j.score) !== String(r.score)) r.score_changed_at = r.score_at ? r.score_at * 1000 : live.at;
  const x = liveRow(r, live, Math.max(scoreChangedAt || 0, r.score_changed_at || 0) || null);
  if (x.score != null) { r.score = x.score; r.period = x.period; r.elapsed = x.elapsed; r.score_at = x.score_at; }
  r.live_flag = x.flag; r.pin_score = x.pin_score; r.line_changed_at = x.line_changed_at;
  if (x.line_as_of) r.line_as_of = Math.floor(x.line_as_of / 1000);   // unix s, same unit as the scanner's line_as_of
  if (x.fair != null) { r.fair_prob = x.fair; r.fair_ts = Math.floor(live.at / 1000); r.fair_live = true; }
  if (r.price != null && r.fair_prob != null && ["order book", "jupiter live"].includes(r.price_src)) {
    const c = r.price + feeOf(r.price); r.edge_pts = +(r.fair_prob - c).toFixed(4); r.ev_per_dollar = +(r.fair_prob / c - 1).toFixed(4);
  }
  return r;
}
// a row's sharp line is too old to trust (works for scan rows and live-refreshed rows alike)
export const lineTooOld = (r, nowS = Date.now() / 1000) => !!r.line_as_of && nowS - r.line_as_of > LINE_MAX_AGE_S;
// ask for one side from a Jupiter order book (REST /orderbook or the websocket): buying YES fills NO bids
export function bookAsk(book, side) {
  const opp = (side === "NO" ? book?.yes_dollars : book?.no_dollars) || [];
  return opp.length ? +Math.min(...opp.map(([p]) => 1 - +p)).toFixed(4) : null;
}
