// Luck Society /livebets: Discord Interactions endpoint on Cloudflare Workers.
// Flow: verify Ed25519 signature -> PING/PONG -> /livebets: deferred reply (type 5) -> GitHub workflow_dispatch
// (scan.yml) with the interaction token -> the workflow edits the reply with the top bets when the scan is done.
import { buildMessage, sealToken } from "./embed.js";
import { fetchLive, parseQuery, asOfFrom } from "../../docs/live-core.js";

const DISCORD = "https://discord.com/api/v10";
const GH = "https://api.github.com";
let lastDispatch = { live: 0, upcoming: 0 };   // per-isolate guard against double clicks before GitHub lists the run
export const _resetGuard = () => { lastDispatch = { live: 0, upcoming: 0 }; };   // tests only

const hexToBytes = h => Uint8Array.from(h.match(/.{2}/g).map(b => parseInt(b, 16)));
export async function verifySignature(publicKeyHex, signatureHex, timestamp, body) {
  if (!publicKeyHex || !signatureHex || !timestamp || !/^[0-9a-f]+$/i.test(signatureHex)) return false;
  try {
    const key = await crypto.subtle.importKey("raw", hexToBytes(publicKeyHex), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, hexToBytes(signatureHex), new TextEncoder().encode(timestamp + body));
  } catch { return false; }
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const ephemeral = content => json({ type: 4, data: { content, flags: 64 } });

function gh(env, path, init = {}) {
  return fetch(GH + path, { ...init, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "luck-society-livebets", ...(init.headers || {}) } });
}
async function editOriginal(env, appId, token, msg) {
  const r = await fetch(`${DISCORD}/webhooks/${appId}/${token}/messages/@original`, { method: "PATCH",
    headers: { "content-type": "application/json" }, body: JSON.stringify(msg) });
  if (!r.ok) console.log("discord edit failed", r.status, await r.text());
  return r.ok;
}
const errMsg = text => ({ content: "", embeds: [{ color: 0xe5533d, title: "⚠️ Couldn't start the scan", description: text.slice(0, 3900),
  footer: { text: "Luck Society Live Edge Scanner" } }] });

async function latestRun(env, mode) {
  const r = await gh(env, `/repos/${env.GITHUB_REPO}/actions/workflows/${env.WORKFLOW_FILE}/runs?per_page=10`);
  if (!r.ok) throw new Error(`GitHub runs list ${r.status}`);
  const runs = (await r.json()).workflow_runs || [];
  return runs.find(x => (x.display_title || "").startsWith(`scan ${mode} `) || (mode === "live" && x.display_title === "scan")) || null;
}
async function fetchResults(env) {
  const r = await gh(env, `/repos/${env.GITHUB_REPO}/contents/docs/data/results.json?ref=${env.GITHUB_BRANCH}`,
    { headers: { Accept: "application/vnd.github.raw+json" } });
  if (!r.ok) throw new Error(`results.json ${r.status}`);
  return r.json();
}
const msgOpts = (env, count, user, note) => ({ count, dashboardUrl: env.DASHBOARD_URL, logoUrl: env.DASHBOARD_URL ? env.DASHBOARD_URL.replace(/\/?$/, "/") + "assets/logo.jpg" : "", requestedBy: user, note });

async function handleLivebets(env, it, ctx) {
  const opts = Object.fromEntries((it.data.options || []).map(o => [o.name, o.value]));
  const mode = opts.mode === "upcoming" ? "upcoming" : "live";
  const count = Math.max(1, Math.min(10, parseInt(opts.count || 5, 10) || 5));
  const user = (it.member?.user || it.user || {}).global_name || (it.member?.user || it.user || {}).username || "";
  const cool = parseInt(env.COOLDOWN_SECONDS || "60", 10) * 1000, now = Date.now();
  if (!env.GITHUB_TOKEN) return ephemeral("The scanner isn't configured yet (missing GITHUB_TOKEN secret on the Worker).");

  // cooldown: a scan of this mode started or finished within the cooldown -> reuse it / ask to wait
  let run = null;
  try { run = await latestRun(env, mode); } catch (e) { console.log(e.message); }
  if (run) {
    const started = Date.parse(run.run_started_at || run.created_at), ended = Date.parse(run.updated_at);
    if (run.status !== "completed" && now - started < 5 * 60e3) {
      return ephemeral(`⏳ A ${mode} scan started ${Math.round((now - started) / 1000)}s ago and its results will be posted in a few seconds. Try /livebets again in about 30s.`);
    }
    if (run.status === "completed" && run.conclusion === "success" && now - ended < cool) {
      ctx.waitUntil((async () => {
        try {
          const data = await fetchResults(env);
          await editOriginal(env, it.application_id, it.token, buildMessage(data, msgOpts(env, count, user, `♻️ Reusing the scan from ${Math.round((Date.now() - ended) / 1000)}s ago (cooldown ${cool / 1000}s).`)));
        } catch (e) { await editOriginal(env, it.application_id, it.token, errMsg(`Couldn't load the latest results: ${e.message}`)); }
      })());
      return json({ type: 5 });
    }
  }
  if (now - lastDispatch[mode] < cool) {
    return ephemeral(`⏳ A ${mode} scan was just requested. Its results will be posted shortly; try again in ${Math.ceil((cool - (now - lastDispatch[mode])) / 1000)}s.`);
  }
  lastDispatch[mode] = now;
  ctx.waitUntil((async () => {
    try {
      const sealed = await sealToken(it.token, env.RELAY_KEY);
      const r = await gh(env, `/repos/${env.GITHUB_REPO}/actions/workflows/${env.WORKFLOW_FILE}/dispatches`, { method: "POST",
        body: JSON.stringify({ ref: env.GITHUB_BRANCH, inputs: { mode, request_id: `discord-${it.id}`, discord_app_id: it.application_id,
          discord_token: sealed, discord_count: String(count), discord_user: user.slice(0, 60) } }) });
      if (r.status !== 204) throw new Error(`GitHub said ${r.status}: ${(await r.text()).slice(0, 300)}`);
    } catch (e) {
      lastDispatch[mode] = 0;
      await editOriginal(env, it.application_id, it.token, errMsg(`${e.message}\nCheck the Worker's GITHUB_TOKEN (classic token, public_repo scope).`));
    }
  })());
  return json({ type: 5 });   // "Luck Society is thinking…" until the workflow edits it (~30-60s)
}

// ---- GET /live: read-only live fair odds + scores for the dashboard (no secrets involved, Discord flow untouched)
const ALLOWED_ORIGINS = ["https://lucksociety.github.io", "http://127.0.0.1:8765", "http://localhost:8765"];
const LIVE_TTL_MS = 3000;
const upstream = new Map();   // per-isolate micro-cache of upstream JSON (url -> {t, p}) so many viewers share one fetch
const answers = new Map();    // per-isolate cache of whole answers (normalized query -> {t, body})
async function cachedJSON(url, headers) {
  const hit = upstream.get(url), now = Date.now();
  if (hit && now - hit.t < LIVE_TTL_MS) return hit.p;
  const p = fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (luck-society-live)", ...headers } }).then(async r => {
    if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`); return { __live: 1, body: await r.json(), asOf: asOfFrom(r.headers) }; });
  upstream.set(url, { t: now, p }); p.catch(() => upstream.delete(url));
  if (upstream.size > 200) for (const [k, v] of upstream) if (now - v.t > LIVE_TTL_MS) upstream.delete(k);
  return p;
}
function cors(req) {
  const o = req.headers.get("origin");
  return { "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(o) ? o : ALLOWED_ORIGINS[0], "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Max-Age": "86400" };
}
export async function handleLive(req, env) {
  const h = { ...cors(req), "content-type": "application/json", "Cache-Control": "public, max-age=3" };
  if (env.LIVE_LIMITER) {   // per-IP rate limit (Workers Rate Limiting binding, see wrangler.toml)
    const ip = req.headers.get("cf-connecting-ip") || "unknown";
    const { success } = await env.LIVE_LIMITER.limit({ key: ip });
    if (!success) return new Response(JSON.stringify({ error: "rate limited, slow down" }), { status: 429, headers: { ...h, "Retry-After": "10" } });
  }
  const q = parseQuery(new URL(req.url).searchParams);
  if (!q.ids.length && !q.events.length) return new Response(JSON.stringify({ error: "pass ids=<pinnacle matchup ids>&sports=<pinnacle sport ids>&events=<jupiter event ids> (max 30 each)" }), { status: 400, headers: h });
  const key = JSON.stringify([q.ids.slice().sort(), q.sports.slice().sort(), q.events.slice().sort()]), now = Date.now();
  const hit = answers.get(key);
  if (hit && now - hit.t < LIVE_TTL_MS) return new Response(hit.body, { headers: { ...h, "X-Cache": "HIT" } });
  const out = await fetchLive(q, cachedJSON);
  const body = JSON.stringify({ ...out, served_at: Date.now(), ttl_ms: LIVE_TTL_MS });
  answers.set(key, { t: now, body });
  if (answers.size > 100) for (const [k, v] of answers) if (now - v.t > LIVE_TTL_MS) answers.delete(k);
  return new Response(body, { headers: { ...h, "X-Cache": "MISS" } });
}

export default {
  async fetch(req, env, ctx) {
    const path = new URL(req.url).pathname;
    if (path === "/live") {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
      if (req.method === "GET") {
        try { return await handleLive(req, env); }
        catch (e) { return new Response(JSON.stringify({ error: "live feed failed: " + e.message }), { status: 502, headers: { ...cors(req), "content-type": "application/json" } }); }
      }
      return new Response("method not allowed", { status: 405 });
    }
    if (req.method === "GET") return new Response("Luck Society /livebets endpoint is running. 🍀", { status: 200 });
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    const body = await req.text();
    const ok = await verifySignature(env.DISCORD_PUBLIC_KEY, req.headers.get("x-signature-ed25519"), req.headers.get("x-signature-timestamp"), body);
    if (!ok) return new Response("invalid request signature", { status: 401 });
    const it = JSON.parse(body);
    if (it.type === 1) return json({ type: 1 });                                      // PING
    if (it.type === 2 && it.data?.name === "livebets") return handleLivebets(env, it, ctx);
    return ephemeral("Unknown command.");
  },
};
