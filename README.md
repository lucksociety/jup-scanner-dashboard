# Jupiter Prediction · Sports + Esports Edge Scanner (GitHub dashboard)

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
docs/index.html              the dashboard (static, no build step)
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
   - Go to https://github.com/settings/personal-access-tokens/new (Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token).
   - Name: `jup-scanner`; Expiration: your choice (e.g. 90 days).
   - Repository access: **Only select repositories** → pick this repo.
   - Repository permissions: **Actions → Read and write** (start + watch the scan) and **Contents → Read-only** (read fresh results). Nothing else.
   - Generate, copy the `github_pat_…` value.
   - On the dashboard click **⚙ Settings**, paste it, check owner/repo (auto-detected from the github.io URL), click **Save**. It shows "✓ token works".
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

## Live mode details
- Jupiter: `/events?filter=live`, then only `isLive` events that started < 12 h ago (cricket < 5 days) and whose `/events/scores` entry is not ended. Score, period and clock are shown per row.
- Pinnacle: only the live child matchups (`isLive`, status `started`, period 0 open); tennis uses the "Sets" line. Each matched game is re-fetched with
  `/matchups/{id}/markets/straight` right before pricing; markets that are not `open` or past their `cutoffAt` are dropped. "danger zone" lines are flagged.
- Live soccer handicaps are skipped (Pinnacle's in-running Asian handicap settles on the rest of the match, which doesn't map to Jupiter's spread).
- Price = best ask from a fresh Jupiter order book for every priced live row (falls back to the listed price; rows with no asks get no edge).
- **Age** column = how long ago the price was read; "Jup↔Pin lag" = seconds between the Jupiter price and the Pinnacle line.
  Live edges disappear fast: re-scan and check the Age before you bet.

## Math
- p = Jupiter ask price; a contract pays $1.
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
