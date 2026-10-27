// Luck Society /livebets: Discord Interactions endpoint on Cloudflare Workers.
// Flow: verify Ed25519 signature -> PING/PONG -> /livebets: deferred reply (type 5) -> GitHub workflow_dispatch
// (scan.yml) with the interaction token -> the workflow edits the reply with the top bets when the scan is done.
import { buildMessage, sealToken } from "./embed.js";

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

export default {
  async fetch(req, env, ctx) {
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
