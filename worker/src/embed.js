// Shared by the Worker (cooldown reuse) and the GitHub Action (post after a scan).
// Builds the Luck Society Discord message from a results.json object.
export const GOLD = 0xf9d832, GREEN = 0x1fae4e, RED = 0xe5533d;
const TYPE = { moneyline: "Moneyline", spreads: "Spread", totals: "Total" };
const CAVEAT = "Live prices move fast: an edge can vanish before you click. Re-check the price on Jupiter and the market rules. Not financial advice. Bet responsibly. 🍀";

const pct = x => x == null ? "-" : (x * 100).toFixed(1) + "%";
const money = x => x == null ? "-" : x >= 10000 ? "$" + Math.round(x / 1000) + "k" : "$" + Math.round(x).toLocaleString("en-US");
const clip = (s, n) => (s = String(s ?? "")).length > n ? s.slice(0, n - 1) + "…" : s;
const etTime = unix => new Date(unix * 1000).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", month: "short", day: "numeric" }) + " ET";

// same rule as the dashboard's Top picks: edge >= 0, not a suspicious >10pt edge, some size available, one per game, highest win chance first
export function topPicks(data, count = 5) {
  const seen = new Set(), out = [];
  // price = executable ask from Jupiter's live order book (what the Buy button charges); never the "% chance" meter
  const rows = (data.rows || []).filter(r => r.price != null && r.price_src === "order book" && r.edge_pts != null && r.edge_pts >= 0 && r.edge_pts <= 0.10 &&
    (r.depth_ok == null || r.depth_ok >= 5)).sort((a, b) => b.fair_prob - a.fair_prob);
  for (const r of rows) { if (out.length >= count) break; if (!seen.has(r.event)) { seen.add(r.event); out.push(r); } }
  return out;
}

export function buildMessage(data, { count = 5, dashboardUrl = "", logoUrl = "", requestedBy = "", note = "" } = {}) {
  const live = (data.mode || "live") === "live", c = data.counts || {};
  const scanned = data.scanned_at_unix ? etTime(data.scanned_at_unix) : (data.scanned_at || "?");
  const links = dashboardUrl ? `[Open the dashboard](${dashboardUrl})` : "";
  const footer = { text: `Luck Society Live Edge Scanner · scanned ${scanned}${requestedBy ? " · requested by " + requestedBy : ""}` };
  if (logoUrl) footer.icon_url = logoUrl;
  const base = { author: { name: "Luck Society Live Edge Scanner", ...(logoUrl ? { icon_url: logoUrl } : {}), ...(dashboardUrl ? { url: dashboardUrl } : {}) }, footer };
  if (logoUrl) base.thumbnail = { url: logoUrl };

  if (data.status === "error") {
    return { content: "", embeds: [{ ...base, color: RED, title: "⚠️ The scan failed",
      description: clip(`Couldn't get fresh odds right now${(data.errors || [])[0] ? `: ${data.errors[0]}` : "."}\nTry /livebets again in a minute. ${links}`, 4000) }] };
  }
  if (live && !c.live_events) {
    return { content: "", embeds: [{ ...base, color: GOLD, title: "🍀 No live games right now",
      description: `Nothing is in progress on Jupiter at the moment. Run /livebets again once games are underway.\n${links}`.trim() }] };
  }
  const picks = topPicks(data, count);
  const summary = live
    ? `**${c.live_events}** live games · **${(c.live_markets || 0).toLocaleString("en-US")}** markets · **${c.positive_ev || 0}** value bets`
    : `**${(c.events || 0).toLocaleString("en-US")}** upcoming games · **${(c.markets_scanned || 0).toLocaleString("en-US")}** markets · **${c.positive_ev || 0}** value bets`;
  if (!picks.length) {
    return { content: "", embeds: [{ ...base, color: GOLD, title: live ? "🍀 No live value bets right now" : "🍀 No upcoming value bets right now",
      description: `${summary}\nNo bet has zero or positive edge with money available. Try again in a few minutes.\n${links}\n\n*${CAVEAT}*`.trim() }] };
  }
  const fields = picks.map((r, i) => {
    const clock = [r.score, [r.period, r.elapsed ? r.elapsed + "'" : ""].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
    return {
      name: clip(`${["🥇", "🥈", "🥉"][i] || "#" + (i + 1)} ${r.selection} (${TYPE[r.market_type] || r.market_type})`, 256),
      value: clip([
        `${r.in_play ? "🔴 " : ""}${r.event}${clock ? ` · **${clock}**` : ""}`,
        `Win chance **${pct(r.fair_prob)}** · Buy price **$${r.price.toFixed(2)}** · Edge **+${(r.edge_pts * 100).toFixed(1)}%** · Available **${money(r.depth_ok)}**`,
        `[Bet on Jupiter ↗](${r.link})`,
      ].join("\n"), 1024),
    };
  });
  return {
    content: "",
    embeds: [{
      ...base, color: live ? GREEN : GOLD,
      title: live ? `🔥 Top ${picks.length} live bets` : `🔥 Top ${picks.length} upcoming bets`,
      ...(dashboardUrl ? { url: dashboardUrl } : {}),
      description: `${summary}${note ? `\n${note}` : ""}\nRanked by win chance. Buy price = Jupiter's order-book ask (the Buy button), fees included. ${links}`.trim(),
      fields: [...fields, { name: "\u200b", value: `*${CAVEAT}*` }],
    }],
    allowed_mentions: { parse: [] },
  };
}

// ---- interaction-token relay encryption (AES-GCM, key = SHA-256(RELAY_KEY)); works in Workers and Node 20
const b64 = u8 => btoa(String.fromCharCode(...u8));
const unb64 = s => Uint8Array.from(atob(s), ch => ch.charCodeAt(0));
async function aesKey(secret) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", h, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function sealToken(token, secret) {
  if (!secret) return token;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), new TextEncoder().encode(token)));
  return `enc1.${b64(iv)}.${b64(ct)}`;
}
export async function openToken(value, secret) {
  if (!value.startsWith("enc1.")) return value;
  if (!secret) throw new Error("interaction token is encrypted but DISCORD_RELAY_KEY is not set");
  const [, iv, ct] = value.split(".");
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await aesKey(secret), unb64(ct)));
}
