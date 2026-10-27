#!/usr/bin/env node
// Run by the scan workflow after a /livebets scan: edits the deferred Discord reply with the top bets.
// env: DISCORD_APP_ID, DISCORD_TOKEN (plain or enc1.* sealed by the Worker), DISCORD_RELAY_KEY, DISCORD_COUNT, DISCORD_USER,
//      REQUEST_ID, RESULTS_PATH, DASHBOARD_URL, RUN_URL, DISCORD_API (override for tests)
import { readFileSync } from "node:fs";
import { buildMessage, openToken } from "../worker/src/embed.js";
const E = process.env;
const api = E.DISCORD_API || "https://discord.com/api/v10";
const dash = E.DASHBOARD_URL || "";
let data;
try { data = JSON.parse(readFileSync(E.RESULTS_PATH || "docs/data/results.json", "utf8")); } catch (e) { data = { status: "error", errors: ["results file missing: " + e.message] }; }
if (E.REQUEST_ID && data.request_id !== E.REQUEST_ID) data = { status: "error", errors: [`the scanner step didn't produce results for this request${E.RUN_URL ? ` (log: ${E.RUN_URL})` : ""}`] };
const msg = buildMessage(data, { count: Math.max(1, Math.min(10, +E.DISCORD_COUNT || 5)), dashboardUrl: dash,
  logoUrl: dash ? dash.replace(/\/?$/, "/") + "assets/logo.jpg" : "", requestedBy: E.DISCORD_USER || "" });
const token = await openToken(E.DISCORD_TOKEN, E.DISCORD_RELAY_KEY);
const r = await fetch(`${api}/webhooks/${E.DISCORD_APP_ID}/${token}/messages/@original`, { method: "PATCH",
  headers: { "content-type": "application/json" }, body: JSON.stringify(msg) });
console.log("discord edit:", r.status, r.ok ? "ok" : (await r.text()).slice(0, 300));
process.exit(r.ok ? 0 : 1);
