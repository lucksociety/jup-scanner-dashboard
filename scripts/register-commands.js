#!/usr/bin/env node
// Registers the /livebets slash command. Node 18+, no dependencies.
//   DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... node scripts/register-commands.js            (global: can take up to ~1h to appear)
//   DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... node scripts/register-commands.js   (one server: instant)
const { DISCORD_APP_ID: app, DISCORD_BOT_TOKEN: tok, DISCORD_GUILD_ID: guild } = process.env;
if (!app || !tok) { console.error("Set DISCORD_APP_ID and DISCORD_BOT_TOKEN (and optionally DISCORD_GUILD_ID)."); process.exit(1); }
const commands = [{
  name: "livebets", type: 1, description: "Run a fresh scan of live games on Jupiter and post the top 5 bets",
  options: [],   // no options: /livebets always runs a fresh live scan and posts the top 5
}];
const url = `https://discord.com/api/v10/applications/${app}${guild ? `/guilds/${guild}` : ""}/commands`;
const r = await fetch(url, { method: "PUT", headers: { Authorization: `Bot ${tok}`, "content-type": "application/json" }, body: JSON.stringify(commands) });
console.log(r.status, r.ok ? `registered /livebets ${guild ? "in server " + guild : "globally"}` : await r.text());
process.exit(r.ok ? 0 : 1);
