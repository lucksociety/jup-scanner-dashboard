#!/usr/bin/env python3
"""Run a scan and write docs/data/results.json for the dashboard.
Never crashes the workflow on a data-source failure: it writes status="error" plus the
error text, and keeps the last good rows (marked stale) so the dashboard still renders."""
import json, os, sys, time
from datetime import datetime
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scanner

OUT = os.environ.get("RESULTS_PATH", os.path.join(os.path.dirname(__file__), "..", "docs", "data", "results.json"))
DAYS = int(os.environ.get("SCAN_DAYS", "14"))
MIN_EDGE_KEEP = float(os.environ.get("KEEP_MIN_EDGE", "-0.05"))  # drop rows worse than -5 pts to keep the file small
ALT_BASE = "https://api.jup.ag/prediction/v1"
KEEP = ["event", "league", "category", "market_type", "selection", "side", "price", "fee", "implied_prob",
        "fair_prob", "edge_pts", "ev_per_dollar", "fair_source", "pin_match", "in_play", "closes", "close_ts",
        "starts", "link", "depth_best", "depth_ok", "warn", "market_id", "score", "period", "elapsed",
        "price_ts", "fair_ts", "lag_s", "price_src", "book_src", "list_price", "scan_price", "price_move", "meter", "meter_ts",
        "event_id", "pin_id", "pin_sport", "pin_key", "pin_d", "pin_sh", "pin_league", "line_as_of"]   # pin_* = the exact Pinnacle line, so it can be re-priced live
# price      = executable ask from jup.ag's live order-book websocket (= the Buy button), the ONLY price used for edge
# list_price = Jupiter's card quote at scan start (info only); meter = jup.ag's "% chance" meter (display only)
MAX_ROWS = int(os.environ.get("MAX_ROWS", "1500"))
MODE = os.environ.get("SCAN_MODE", "live").lower()
REQUEST_ID = os.environ.get("SCAN_REQUEST_ID", "")

def now_et():
    return datetime.now(scanner.NY).strftime("%Y-%m-%d %I:%M:%S %p ET")

def load_prev():
    try:
        with open(OUT) as f: return json.load(f)
    except Exception: return {}

def main():
    started = time.time()
    runner = {"request_id": REQUEST_ID, "github_run": os.environ.get("GITHUB_RUN_ID"), "runner": os.environ.get("RUNNER_NAME", "local")}
    res, err = None, None
    try:
        res = scanner.scan(log=lambda s: print(s, flush=True), max_days=DAYS, mode=MODE)
    except Exception as e:
        err = str(e)
        print("primary scan failed:", err, file=sys.stderr)
        if os.environ.get("JUP_API_KEY") and scanner.JUP_BASE != ALT_BASE:
            print("retrying via official api.jup.ag with JUP_API_KEY", flush=True)
            scanner.JUP_BASE = ALT_BASE
            try:
                res = scanner.scan(log=lambda s: print(s, flush=True), max_days=DAYS, mode=MODE)
                res["stats"]["errors"].insert(0, f"primary Jupiter host failed, used api.jup.ag: {err}")
                err = None
            except Exception as e2:
                err = f"{err} | fallback api.jup.ag: {e2}"
    if res is not None and res["stats"]["pinnacle_games"] == 0:
        e = res["stats"]["errors"]
        err = f"Pinnacle fair-odds feed unavailable ({len(e)} errors), e.g. {e[0] if e else 'no games'}"
        res = None
    if res is not None:
        rows = res["rows"]
        st = res["stats"]
        live = st["mode"] == "live"
        # final self-check: re-read the live Buy-button ask (order-book websocket) for every row that could be shown
        recheck_min = MIN_EDGE_KEEP - 0.05
        cands = [r for r in rows if r["fair_prob"] is not None and r["edge_pts"] is not None and r["edge_pts"] >= recheck_min]
        checked_ids = {id(r) for r in cands}
        cands, recheck = scanner.recheck_prices(cands, live, log=lambda s: print(s, flush=True))
        rest = [r for r in rows if id(r) not in checked_ids]
        rows = sorted(cands + rest, key=lambda r: (r["edge_pts"] is None, -(r["fair_prob"] or 0)))
        st["positive"] = sum(1 for r in rows if r["edge_pts"] is not None and r["edge_pts"] >= 0)
        priced = [{k: r.get(k) for k in KEEP} for r in rows
                  if r["fair_prob"] is not None and r["edge_pts"] is not None and r["edge_pts"] >= MIN_EDGE_KEEP]
        if len(priced) > MAX_ROWS:              # keep the file small: best edges win, then back to win-chance order
            keep = {id(r) for r in sorted(priced, key=lambda r: -r["edge_pts"])[:MAX_ROWS]}
            priced = [r for r in priced if id(r) in keep]
        try: scanner.add_meter(sorted(priced, key=lambda r: -r["edge_pts"]))          # jup.ag's lagging "% chance" meter, shown separately for reference
        except Exception as e: print("meter lookup failed:", e, flush=True)
        out = dict(status="ok" if not st["errors"] else "partial", errors=st["errors"], mode=st["mode"],
                   request_id=REQUEST_ID,
                   scanned_at=now_et(), scanned_at_unix=int(time.time()), last_success=now_et(),
                   counts=dict(events=st["events"], markets_scanned=st["markets_scanned"], bets=st["rows"],
                               with_fair=st["with_fair"], positive_ev=st["positive"],
                               no_edge_data=st["rows"] - st["with_fair"], pinnacle_games=st["pinnacle_games"],
                               events_matched=st["events_matched"], rows_in_file=len(priced),
                               live_events=st["live_events"], live_markets=st["live_markets"],
                               events_with_fair=st["events_with_fair"]),
                   seconds=round(time.time() - started, 1), runner=runner, price_check=recheck, rows=priced)
    else:
        prev = load_prev()
        out = dict(status="error", errors=[err], mode=MODE, request_id=REQUEST_ID,
                   scanned_at=now_et(), scanned_at_unix=int(time.time()),
                   last_success=prev.get("last_success"), counts=prev.get("counts", {}),
                   seconds=round(time.time() - started, 1), runner=runner,
                   stale=True, rows=prev.get("rows", []))
    os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
    with open(OUT, "w") as f: json.dump(out, f, separators=(",", ":"))
    print(f"wrote {OUT}: status={out['status']} rows={len(out['rows'])} errors={out['errors']}")
    # exit 0 so the commit step still publishes the error to the dashboard
    return 0

if __name__ == "__main__":
    sys.exit(main())
