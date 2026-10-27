# 🍀 Luck Society Live Edge Scanner

A GitHub Pages dashboard for Jupiter prediction markets (sports + esports), branded for [@LuckSociety](https://x.com/lucksociety).

This dashboard runs on GitHub Pages. By default it scans **live (in-progress) sports and esports games** on Jupiter's prediction market
(switch the dropdown to "Upcoming" for pre-match markets).
Crypto, politics, culture, economics and tech markets are never fetched.

Each live bet is priced against **de-vigged Pinnacle LIVE odds** (in-play lines only; pre-match prices of a started game are never used,
suspended/closed/expired lines are dropped, and the line is rejected if Pinnacle's score disagrees with Jupiter's scoreboard) (Pinnacle's odds with the bookmaker's margin removed), with Jupiter's fee included.
Results are ranked by win probability. By default you only see bets with edge ≥ 0.

- **Scan:** click **▶ Scan** on the dashboard. It starts the `scan` workflow through the GitHub API, shows progress,
  and loads the fresh results into the same page as soon as the run finishes (~1 min; no waiting for Pages to redeploy).
- **Dashboard:** `docs/index.html` loads `docs/data/results.json`. It's a sortable, filterable table with the last-scan time in ET and error banners.

```
.github/workflows/scan.yml   manual "Run workflow" (+ optional cron) -> runs scanner, commits docs/data/results.json
scanner/scanner.py           fetch Jupiter + Pinnacle, match games, compute fair prob / edge / EV / depth
scanner/run_scan.py          wraps a scan, writes results.json (status ok | partial | error, keeps last good rows if a scan fails)
docs/index.html, style.css   the dashboard (static, no build step)
docs/assets/                 Luck Society logo, favicon, banner
docs/config.js               optional owner/repo/branch override (never put a token here)
docs/data/results.json       latest results (seed data from a local test scan)
```

## Setup (about 5 minutes)

1. **Create the repo.** On github.com, go to **New repository** and name it, e.g. `jup-scanner-dashboard`.
   - It can be Public, or Private if your plan allows Pages on private repos.
   - Don't add a README.
2. **Push this folder:**
   ```bash
   cd jup-scanner-dashboard
   git init -b main            # skip if already a git repo
   git add . && git commit -m "Jupiter scanner dashboard"
   git remote add origin https://github.com/<you>/jup-scanner-dashboard.git
   git push -u origin main
   ```
3. **Allow the workflow to commit.** Go to Repo → **Settings → Actions → General → Workflow permissions**, select
   **Read and write permissions**, and click Save. The workflow also requests `contents: write` itself.
4. **Turn on Pages.** Go to Repo → **Settings → Pages → Build and deployment**:
   - Source: **Deploy from a branch**
   - Branch: **main**, folder **/docs**
   - Click Save. After about a minute the site is live at `https://<you>.github.io/jup-scanner-dashboard/`.
5. **(Optional) Jupiter API key.** Go to Settings → Secrets and variables → Actions → **New repository secret**,
   name it `JUP_API_KEY`, and paste your key (from https://developers.jup.ag/portal).
   - The scan works without a key.
   - The key is only used as a fallback to the official `api.jup.ag` host if the primary feed fails.
6. **Create a token for the Scan button (one time).**
   - **Recommended: classic token.** Open https://github.com/settings/tokens/new (Settings → Developer settings → Personal access tokens → Tokens (classic)).
     Note: `Luck Society Scanner`, pick an expiration, tick only **`public_repo`**, click Generate, and copy the `ghp_…` value.
   - Alternative: fine-grained token at https://github.com/settings/personal-access-tokens/new. Choose **Only select repositories** → this repo, then
     **Actions: Read and write** and **Contents: Read-only**.
   - On the dashboard click **⚙**, paste the token, check owner/repo (auto-detected from the github.io URL), click **Save & test**. It should say "Connected".
   - The token is stored only in that browser's `localStorage`. It is never committed or sent anywhere except api.github.com.
     Anyone using that browser profile could use it, so revoke it on GitHub if the device is shared or lost. **Forget token** removes it.
7. **Run a scan.** Pick **Live games** (default) or **Upcoming**, click **▶ Scan**.
   - The page dispatches the workflow (with a unique request id), finds the run, polls it every ~4 s showing the current step, then
     reads the new `results.json` straight from the repo via the GitHub contents API and renders it.
   - Without a token the page still shows the last published results (Pages copy, refreshed every 2 minutes).
   - You can also run it from the **Actions** tab → `scan` → **Run workflow**.
8. **(Optional) Automatic scans.** In `.github/workflows/scan.yml`, uncomment the `schedule:` block (every 30 min).
   - Note: in upcoming mode each scan commits a ~2.4 MB JSON file (live mode is ~30–100 KB) (~0.3 MB compressed), so frequent cron runs grow the git history over time.
   - Every 30–60 minutes is fine for months. To reset history, squash it occasionally.

## Discord `/livebets` command (share the scanner without sharing your token)

Anyone in your server types `/livebets`. A Discord message saying "thinking…" appears, the scan runs on GitHub (about 30–60 seconds), and the top bets are edited into that message as a Luck Society card. Your GitHub token stays in a Cloudflare secret, so nobody else ever sees it.

```
Discord ──/livebets──▶ Cloudflare Worker (free) ──workflow_dispatch──▶ GitHub Actions scan
   ▲                     checks Discord signature                         │
   └──────────── top 5 bets edited into the reply ◀───────────────────────┘
```

Options: `/livebets mode:upcoming` (pre-game instead of live) and `/livebets count:3` (1–10 picks, default 5).
Cooldown: if a scan of the same mode finished in the last 60 s, that result is reused instead of starting a new one. If one is already running, the user is asked to wait (only they see that message).

### Values you need and where each one goes

| Value | Where you get it | Where it goes |
|---|---|---|
| Application ID | Discord Developer Portal → your app → General Information | Only for the register command and the invite link (step 5–6) |
| Public Key | Same page | Worker secret `DISCORD_PUBLIC_KEY` |
| Bot token | Developer Portal → Bot → Reset Token | Only for the one-time register command (step 5). Do not store it anywhere |
| GitHub token | The same classic token (`public_repo` scope) you use on the dashboard, or a new one | Worker secret `GITHUB_TOKEN` |
| Relay key | You generate it: `openssl rand -hex 32` | Worker secret `RELAY_KEY` **and** GitHub repo secret `DISCORD_RELAY_KEY` (same value) |
| Worker URL | Printed by `npx wrangler deploy` (`https://luck-society-livebets.<you>.workers.dev`) | Developer Portal → General Information → Interactions Endpoint URL |
| Server (guild) ID, optional | Discord: Settings → Advanced → Developer Mode on, then right-click your server → Copy Server ID | Register command (makes `/livebets` appear instantly in that server) |

Why the relay key: on a public repo, the inputs of each Actions run are visible. Discord gives each `/livebets` a reply token that is valid for 15 minutes, so the Worker encrypts it before passing it to the workflow. The workflow decrypts it with the same key. It works without the key, but then someone reading the Actions page could edit that one reply during those 15 minutes.

### Setup steps

1. **Create the Discord app.** Go to <https://discord.com/developers/applications> → **New Application** → name it "Luck Society Live Edge Scanner" (and upload the logo if you like). On **General Information**, copy the **Application ID** and **Public Key**. On the **Bot** tab, click **Reset Token** and copy the bot token (needed once, in step 5).
2. **Create a free Cloudflare account** at <https://dash.cloudflare.com/sign-up>. Then deploy the Worker from this repo (requires Node 18+):
   ```bash
   cd worker
   npm install
   npx wrangler login                      # opens the browser, then click Allow
   npx wrangler secret put DISCORD_PUBLIC_KEY   # paste the Public Key
   npx wrangler secret put GITHUB_TOKEN         # paste your classic public_repo token
   openssl rand -hex 32                         # copy the output: this is your relay key
   npx wrangler secret put RELAY_KEY            # paste the relay key
   npx wrangler deploy                          # prints https://luck-society-livebets.<you>.workers.dev
   ```
   (The first `secret put` may ask to create the Worker: answer yes.)
3. **Add the relay key to GitHub.** Repo → Settings → Secrets and variables → Actions → **New repository secret**. Name: `DISCORD_RELAY_KEY`. Value: the same relay key.
4. **Point Discord at the Worker.** Developer Portal → General Information → **Interactions Endpoint URL** = your workers.dev URL → **Save Changes**. Discord pings the Worker right away. If the save is rejected, the Public Key secret is wrong.
5. **Register the command** (from the repo root):
   ```bash
   DISCORD_APP_ID=<Application ID> DISCORD_BOT_TOKEN=<bot token> DISCORD_GUILD_ID=<server ID> node scripts/register-commands.js
   ```
   With `DISCORD_GUILD_ID`, the command appears in that server immediately. Without it, the command is global (all servers the app is in), which can take up to an hour.
6. **Add the app to your server.** Open this link (replace the ID) and choose your server:
   `https://discord.com/oauth2/authorize?client_id=<Application ID>&scope=applications.commands`
   (Add `%20bot` after `applications.commands` if you also want a bot user to appear in the member list. It's not required.)
7. Type **`/livebets`** in any channel.

To restrict who can use it: Server Settings → Integrations → Luck Society Live Edge Scanner → choose the roles/channels.

### Notes and limits
- **Costs:** Cloudflare Workers' free plan (100k requests/day) and GitHub Actions on a public repo are both free.
- **Speed:** each new scan takes about 30–60 s. Discord allows edits to a reply for 15 minutes, so a queued run still lands in time.
- **Sharing scans:** the Worker and the dashboard share scans. A `/livebets` run also updates the dashboard, and a dashboard scan finished in the last 60 s is reused by `/livebets`.
- **Changing the token:** run `npx wrangler secret put GITHUB_TOKEN` again. Changing anything else in `worker/` requires `npx wrangler deploy` again.
- **Troubleshooting:** for "⚠️ Couldn't start the scan", the GitHub token is invalid or expired. For "⚠️ The scan failed", open the linked run in the Actions tab. If nothing is posted, check the run's "Post top bets to Discord" step, and `npx wrangler tail` for Worker logs.
- **Tests:** `cd worker && node test/test.mjs` (signature checks, reply flow, cooldown, and the embed rendered from the current `results.json`).

## Live mode details
- Jupiter: `/events?filter=live`, then only `isLive` events that started < 12 h ago (cricket < 5 days) and whose `/events/scores` entry is not ended. Score, period and clock are shown per row.
- Pinnacle: only the live child matchups (`isLive`, status `started`, period 0 open); tennis uses the "Sets" line. Each matched game is re-fetched with
  `/matchups/{id}/markets/straight` right before pricing; markets that are not `open` or past their `cutoffAt` are dropped. "danger zone" lines are flagged.
- Live soccer handicaps are skipped (Pinnacle's in-running Asian handicap settles on the rest of the match, which doesn't map to Jupiter's spread).
- **Price = the Buy button price, nothing else.** jup.ag's Buy Yes / Buy No buttons and order ticket read Jupiter's live order-book
  websocket (`wss://prediction-market-price-service.fly.dev/ws/orderbook`, `{"type":"subscribe","marketId":…}`). Buying YES fills
  against NO bids, so ask(YES) = 1 − best NO bid and vice versa. The scanner reads that same socket for every row with a sharp line
  (stdlib client, ~2 s for 700 markets), with REST `/orderbook/{id}` only as a fallback (it is cached and was seen 5-10 s behind).
  Fee is added on top. Rows with no seller on that side get **no edge** and are not shown.
- **Not used for edge:** (1) jup.ag's "% chance" meter / chart legend. It is the last point of `/forecast`, a chart updated in
  5-minute steps, and it was measured up to 36¢ away from the Buy price on live games. It is stored as `meter` / `meter_ts` and
  shown greyed under the price as "Jupiter meter" for reference only. (2) the `pricing.buyYesPriceUsd` card quote (`list_price`),
  which only tells the scanner which sides exist.
- **Price self-check:** right before `results.json` is written, every row is re-priced from a fresh websocket snapshot. Rows whose ask
  moved ≥ 2¢ during the scan are flagged; `price_ts`, `scan_price`, `price_move`, `book_src` are stored.
- **Live prices on the dashboard:** the page subscribes to the same order-book websocket for the shown bets (no token needed),
  recomputes ask, edge and "$ available" on every update, and shows "live · ▲/▼ X¢ since scan" or "no sellers". Every 15 s it also
  checks market status (closed markets are marked) and uses REST `/orderbook` for any market the socket hasn't updated. In live mode,
  win chances older than 5 minutes are marked "old win chance" and are left out of Top picks. Scan again for fresh edges.
- **Updated** column = how long ago the price was read.

## Math
- p = Jupiter ask price (the Buy button: 1 − best bid on the opposite side); a contract pays $1.
- Fee per contract ≈ `0.07·p·(1−p)`. This is fitted to Jupiter's published fee table; Jupiter rounds the fee up to the cent per order.
- Fair prob q = Pinnacle odds with the margin removed proportionally (2-way, or 3-way for soccer and cricket with a draw).
- Edge = q − (p + fee).  EV per $1 = q/(p + fee) − 1.
- "$ at +EV" = dollars of order book you can buy while edge stays ≥ 0.

**Priced bets:**
- Full-game moneyline, spreads and totals for team sports.
- Match winner for tennis, MMA, boxing and esports.

**Everything else is "no edge data":** props, futures, exact scores, halves, corners, F1, table tennis and so on. These bets are counted but never given an invented probability.

Edges under about 1 pt are within model error. Always check a market's rules (overtime, extra time, retirements) before betting.

## Errors & blocking
Every run writes a `status` into results.json, and the dashboard shows it as a banner:
- `ok`: the scan worked.
- `partial`: the scan worked, but some sources failed (e.g. one Pinnacle sport). Listed under "Warnings".
- `error`: Jupiter or Pinnacle failed completely.
  - The previous good rows are kept and marked **STALE**, along with the last successful scan time.
  - The workflow still succeeds, so the error reaches the dashboard.

The workflow's "Connectivity check" step logs the runner's IP/location and the HTTP status of each data source.

**Known risk:** GitHub-hosted runners are Azure datacenter IPs, mostly in the US.
- Jupiter says US IPs are blocked from its Prediction API. In practice the read-only endpoints answered from a US IP when tested (see below), but this could change.
- Pinnacle's unofficial guest API sits behind a bot firewall that may reject datacenter IPs.

If runs keep reporting `error`, choose one of these fallbacks:
- **Run the scan locally and push.** Run `python3 scanner/run_scan.py && git add docs/data/results.json && git commit -m scan && git push`. Pages updates the same way.
- **Use a self-hosted runner** on your own machine. Settings → Actions → Runners → New self-hosted runner, then change `runs-on: ubuntu-latest` to `runs-on: self-hosted`.

## Local test
```bash
python3 scanner/run_scan.py                  # writes docs/data/results.json
cd docs && python3 -m http.server 8000       # open http://localhost:8000
```
Env overrides: `SCAN_DAYS`, `KEEP_MIN_EDGE`, `JUP_BASE`, `JUP_API_KEY`, `PINNACLE_BASE`, `PINNACLE_GUEST_KEY`, `JUP_FEE_COEF`, `RESULTS_PATH`.
