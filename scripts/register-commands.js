#!/usr/bin/env node
// Registers the /livebets slash command. Node 18+, no dependencies.
//   DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... node scripts/register-commands.js            (global: can take up to ~1h to appear)
//   DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... node scripts/register-commands.js   (one server: instant)
const { DISCORD_APP_ID: app, DISCORD_BOT_TOKEN: tok, DISCORD_GUILD_ID: guild } = process.env;
if (!app || !tok) { console.error("Set DISCORD_APP_ID and DISCORD_BOT_TOKEN (and optionally DISCORD_GUILD_ID)."); process.exit(1); }
const commands = [{
  name: "livebets", type: 1, description: "Scan Jupiter for the best live bets right now (Luck Society Live Edge Scanner)",
  options: [
    { type: 3, name: "mode", description: "Live games (default) or upcoming games", required: false,
      choices: [{ name: "Live games", value: "live" }, { name: "Upcoming games", value: "upcoming" }] },
    { type: 4, name: "count", description: "How many picks to post (1-10, default 5)", required: false, min_value: 1, max_value: 10 },
  ],
}];
const url = `https://discord.com/api/v10/applications/${app}${guild ? `/guilds/${guild}` : ""}/commands`;
const r = await fetch(url, { method: "PUT", headers: { Authorization: `Bot ${tok}`, "content-type": "application/json" }, body: JSON.stringify(commands) });
console.log(r.status, r.ok ? `registered /livebets ${guild ? "in server " + guild : "globally"}` : await r.text());
process.exit(r.ok ? 0 : 1);
