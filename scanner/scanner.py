#!/usr/bin/env python3
"""
Jupiter Prediction Market scanner (sports + esports only).

Prices:   Jupiter prediction API (prices in micro-USD; a YES contract pays $1).
Fair odds: Pinnacle (sharpest sportsbook) via its public guest API, de-vigged.
Edge:     fair_prob - (ask + Jupiter fee)   fee/contract = 0.07 * p * (1-p)
EV/$1:    fair_prob / (ask + fee) - 1

No fair price -> reported as "no edge data" (never invented).
Stdlib only. Usage:  python3 scanner.py [--csv out.csv] [--json out.json]
"""
import json, re, sys, urllib.error, time, math, unicodedata, urllib.request, urllib.parse, argparse, os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from difflib import SequenceMatcher
try:
    from zoneinfo import ZoneInfo
    NY = ZoneInfo("America/New_York")
except Exception:
    NY = timezone.utc

JUP_BASE = os.environ.get("JUP_BASE", "https://prediction-market-api.jup.ag/api/v1")
JUP_KEY = os.environ.get("JUP_API_KEY", "")          # only needed if you switch JUP_BASE to api.jup.ag/prediction/v1
PIN_BASE = os.environ.get("PINNACLE_BASE", "https://guest.api.arcadia.pinnacle.com/0.1")
# Public key embedded in pinnacle.com's own web front-end (not a personal credential).
PIN_KEY = os.environ.get("PINNACLE_GUEST_KEY", "CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R")
FEE_COEF = float(os.environ.get("JUP_FEE_COEF", "0.07"))
UA = "Mozilla/5.0 (jup-scanner)"

PIN_SPORTS = {3: "baseball", 4: "basketball", 6: "boxing", 8: "cricket", 12: "esports", 15: "football",
              18: "handball", 19: "hockey", 22: "mma", 27: "rugby", 29: "soccer", 33: "tennis", 34: "volleyball"}

def http_json(url, headers=None, timeout=60, retries=3):
    h = {"User-Agent": UA, "Accept": "application/json"}
    if headers: h.update(headers)
    last = None
    for i in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=timeout) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (401, 451) or (e.code == 403 and i == retries - 1):   # blocked / geo-restricted
                raise RuntimeError(f"HTTP {e.code} from {urllib.parse.urlparse(url).netloc} "
                                   f"(blocked - likely geo/datacenter-IP restriction or bad key)") from e
            time.sleep(1.5 * (i + 1))
        except Exception as e:
            last = e
            time.sleep(1.5 * (i + 1))
    raise RuntimeError(f"{urllib.parse.urlparse(url).netloc}: {last}")

# ---------------------------------------------------------------- Jupiter
def jup_get(path, **params):
    url = f"{JUP_BASE}{path}"
    if params: url += "?" + urllib.parse.urlencode(params)
    return http_json(url, {"x-api-key": JUP_KEY} if JUP_KEY else None)

def fetch_jupiter_events(category, log=print):
    out, start, page, wave = [], 0, 100, 6
    with ThreadPoolExecutor(wave) as ex:
        while True:
            starts = [start + i * page for i in range(wave)]
            res = list(ex.map(lambda s: jup_get("/events", category=category, includeMarkets="true",
                                                 includeAllMarkets="true", start=s, end=s + page), starts))
            done = False
            for r in res:
                out += r.get("data", [])
                if not r.get("data") or not r.get("pagination", {}).get("hasNext"):
                    done = True
            if done: break
            start += wave * page
    seen, uniq = set(), []
    for e in out:
        if e["eventId"] not in seen:
            seen.add(e["eventId"]); uniq.append(e)
    log(f"Jupiter {category}: {len(uniq)} events")
    return uniq

def fetch_orderbook(mid):
    try: return jup_get(f"/orderbook/{mid}")
    except Exception: return None

# ---------------------------------------------------------------- Pinnacle
def fetch_pinnacle(log=print, errors=None):
    H = {"X-API-Key": PIN_KEY}
    def one(sid):
        try:
            m = http_json(f"{PIN_BASE}/sports/{sid}/matchups", H)
            k = http_json(f"{PIN_BASE}/sports/{sid}/markets/straight", H)
            return sid, m, k
        except Exception as e:
            log(f"Pinnacle sport {sid} failed: {e}")
            if errors is not None: errors.append(f"Pinnacle {PIN_SPORTS[sid]}: {e}")
            return sid, [], []
    with ThreadPoolExecutor(4) as ex:
        res = list(ex.map(one, PIN_SPORTS))
    games = []   # one per real game; live child preferred
    for sid, matchups, markets in res:
        mk = {}
        for x in markets:
            if x.get("status", "open") == "open":
                mk.setdefault(x["matchupId"], []).append(x)
        byid = {}
        for m in matchups:
            if m.get("type") != "matchup" or m.get("special") or m.get("units") not in (None, "Regular"):
                continue
            ps = m.get("participants") or []
            home = next((p["name"] for p in ps if p.get("alignment") == "home"), None)
            away = next((p["name"] for p in ps if p.get("alignment") == "away"), None)
            if not home or not away: continue
            byid[m["id"]] = dict(id=m["id"], parent=m.get("parentId"), sport=sid, league=m["league"]["name"],
                                 home=home, away=away, start=m.get("startTime"), live=bool(m.get("isLive")),
                                 markets=mk.get(m["id"], []))
        # merge live child into parent slot
        for g in list(byid.values()):
            if g["parent"] and g["parent"] in byid and g["markets"]:
                byid[g["parent"]]["markets"] = g["markets"]; byid[g["parent"]]["live"] = True
                byid.pop(g["id"], None)
        games += [g for g in byid.values() if g["markets"]]
    log(f"Pinnacle: {len(games)} priced games")
    return games

# ---------------------------------------------------------------- odds math
def am_to_dec(a):
    a = float(a)
    return 1 + (a / 100 if a > 0 else 100 / -a)

def devig(prices):
    """proportional de-vig: list of american odds -> fair probabilities"""
    imp = [1 / am_to_dec(p) for p in prices]
    s = sum(imp)
    return [i / s for i in imp], s - 1

def fee_per_contract(p):
    return FEE_COEF * p * (1 - p)

# ---------------------------------------------------------------- name matching
STOP = set("fc cf sc ac afc ssc us ss as cd ud sd rc rcd club calcio de la le the of fk sk bk if cfc sv vfb vfl tsg "
           "esports esport gaming team clan academy st saint".split())
FLAGS = set("w women womens u17 u18 u19 u20 u21 u23 ii b reserves youth".split())
ALIASES = {"natus vincere": "navi", "manchester united": "man utd", "manchester city": "man city",
           "paris saint germain": "psg", "internazionale": "inter", "tottenham hotspur": "tottenham", "athletic bilbao": "athletic club"}

def norm(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    s = " ".join(s.split())
    return ALIASES.get(s, s)

def toks(s): return set(norm(s).split())

GENERIC = set("state st university univ college united city town county athletic athletics sporting real inter "
              "north south east west northern southern eastern western central atletico olympique racing dynamo "
              "deportivo sport sports".split())

def name_score(a, b, person=False):
    ta, tb = toks(a), toks(b)
    if (ta & FLAGS) != (tb & FLAGS): return 0.0
    ca, cb = ta - STOP - FLAGS, tb - STOP - FLAGS
    if not ca or not cb: ca, cb = ta, tb
    if ca == cb: return 1.0
    da, db = ca - GENERIC, cb - GENERIC
    if da and db and not (da & db):
        # distinctive words disjoint -> only allow near-identical spelling (e.g. accents/typos)
        r = SequenceMatcher(None, " ".join(sorted(da)), " ".join(sorted(db))).ratio()
        return 0.75 if r >= 0.9 and min(len(" ".join(da)), len(" ".join(db))) >= 5 else 0.0
    if ca <= cb or cb <= ca:
        small = ca if len(ca) <= len(cb) else cb
        if any(len(t) >= 3 and t not in GENERIC for t in small): return 0.9
    if person:
        la, lb = norm(a).split()[-1], norm(b).split()[-1]
        if la == lb and len(la) >= 4: return 0.8
    jac = len(ca & cb) / len(ca | cb)
    r = SequenceMatcher(None, " ".join(sorted(ca)), " ".join(sorted(cb))).ratio()
    if r >= 0.88: return 0.8
    if jac >= 0.5 and (da & db): return 0.7
    return 0.0

def jup_sport_ids(e):
    words = set([e.get("subcategory", "")] + e.get("tags", []))
    if e.get("category") == "esports": return {12}
    m = [({"tennis", "atp", "wta", "itf", "atp-doubles", "wta-doubles"}, 33),
         ({"basketball", "nba", "cbb", "wnba", "euroleague"}, 4), ({"football", "nfl", "cfb"}, 15),
         ({"hockey", "nhl", "khl"}, 19), ({"baseball", "mlb"}, 3), ({"soccer"}, 29), ({"ufc", "mma"}, 22),
         ({"boxing"}, 6), ({"cricket", "crint", "ipl"}, 8)]
    for ks, sid in m:
        if words & ks: return {sid}
    if "table-tennis" in words or "pickleball" in words or "chess" in words or "f1" in words: return set()
    return set(PIN_SPORTS)

def jup_teams(e):
    ms = e.get("markets") or []
    for m in ms:
        if m.get("sportsMarketType") == "moneyline" and len(m.get("outcomes") or []) == 2 \
                and m["outcomes"] != ["Yes", "No"]:
            return m["outcomes"]
    for m in ms:
        if m.get("sportsMarketType") == "spreads" and len(m.get("outcomes") or []) == 2:
            return m["outcomes"]
    ml = [m["title"] for m in ms if m.get("sportsMarketType") == "moneyline" and m["title"].lower() != "draw"]
    if len(ml) == 2: return ml
    t = re.sub(r"^[^:]*:\s*", "", e["metadata"]["title"])
    t = re.sub(r"\(.*?\)|\s-\s.*$", "", t)
    parts = re.split(r"\s+vs\.?\s+", t)
    return [p.strip() for p in parts] if len(parts) == 2 else None

def match_game(e, games_by_sport):
    teams = jup_teams(e)
    if not teams: return None, None
    sids = jup_sport_ids(e)
    try: begin = int(e.get("beginAt") or 0)
    except ValueError: begin = 0
    window = 36 * 3600 if (sids & {12, 33}) else 14 * 3600
    best, bs, orient = None, 0, None
    for sid in sids:
        for g in games_by_sport.get(sid, []):
            if begin:
                gs = datetime.fromisoformat(g["start"].replace("Z", "+00:00")).timestamp()
                if abs(gs - begin) > window: continue
            pp = sid in (33, 22, 6)
            s1 = min(name_score(teams[0], g["home"], pp), name_score(teams[1], g["away"], pp))
            s2 = min(name_score(teams[0], g["away"], pp), name_score(teams[1], g["home"], pp))
            s = max(s1, s2)
            if s > bs:
                best, bs = g, s
                orient = {teams[0]: "home", teams[1]: "away"} if s1 >= s2 else {teams[0]: "away", teams[1]: "home"}
    return (best, orient) if bs >= 0.7 else (None, None)

def side_of(name, orient):
    best, bs = None, 0
    for t, d in orient.items():
        s = name_score(name, t)
        if s > bs: best, bs = d, s
    return best if bs >= 0.7 else None

def pin_market(g, key):
    return next((x for x in g["markets"] if x["key"] == key), None)

def fair_for(m, g, orient):
    """returns (fair_prob_yes, desc, vig) or None"""
    smt = m.get("sportsMarketType")
    if m.get("periodType") or m.get("gameNumber"): return None
    label = (m.get("marketOptions") or [{}])[0].get("label", "") or ""
    title = m.get("title", "")
    if smt == "moneyline":
        ml = pin_market(g, "s;0;m")
        if not ml: return None
        des = [p["designation"] for p in ml["prices"]]
        probs, vig = devig([p["price"] for p in ml["prices"]])
        fp = dict(zip(des, probs))
        if title.strip().lower() == "draw":
            d = "draw"
        else:
            d = side_of(title, orient)
        if d not in fp: return None
        if d != "draw" and "draw" not in fp and g["sport"] == 29: return None
        return fp[d], f"Pinnacle ML {'/'.join(f'{p['price']:+d}' for p in ml['prices'])}", vig
    if g["sport"] == 33 or g["sport"] == 12: return None   # tennis/esports handicaps use different units
    num = re.search(r"([+-]?\d+(?:\.\d+)?)\s*$", label)
    if not num: return None
    line = float(num.group(1))
    if smt == "spreads":
        d = side_of(title, orient)
        if not d: return None
        for x in g["markets"]:
            if not x["key"].startswith("s;0;s;"): continue
            pr = {p["designation"]: p for p in x["prices"]}
            if d in pr and abs(float(pr[d].get("points", 1e9)) - line) < 1e-9 and len(pr) == 2:
                probs, vig = devig([pr["home"]["price"], pr["away"]["price"]])
                q = probs[0] if d == "home" else probs[1]
                return q, f"Pinnacle spread {d} {line:+g} {pr[d]['price']:+d}", vig
        return None
    if smt == "totals":
        d = "over" if title.lower().startswith("over") or label.upper().startswith("O") else \
            "under" if title.lower().startswith("under") or label.upper().startswith("U") else None
        if not d: return None
        x = pin_market(g, f"s;0;ou;{abs(line):.1f}")
        if not x: return None
        pr = {p["designation"]: p for p in x["prices"]}
        if set(pr) != {"over", "under"}: return None
        probs, vig = devig([pr["over"]["price"], pr["under"]["price"]])
        return (probs[0] if d == "over" else probs[1]), f"Pinnacle total {d} {abs(line):g} {pr[d]['price']:+d}", vig
    return None

# ---------------------------------------------------------------- depth
def depth_info(ob, side, fair):
    """Buying YES consumes NO bids (ask = 1 - no bid) and vice versa.
    returns (best_ask, $ at best ask, $ fillable while edge >= 0)"""
    if not ob: return None, None, None
    opp = ob.get("no_dollars" if side == "YES" else "yes_dollars") or []
    asks = sorted(((1 - float(p), float(sz)) for p, sz in opp), key=lambda t: t[0])
    if not asks: return None, 0.0, 0.0
    best = asks[0][0]
    at_best = sum(p * s for p, s in asks if abs(p - best) < 1e-9)
    ok = sum(p * s for p, s in asks if fair is not None and fair - (p + fee_per_contract(p)) >= 0)
    return round(best, 4), round(at_best, 2), round(ok, 2)

# ---------------------------------------------------------------- scan
def fmt_time(ts):
    try:
        return datetime.fromtimestamp(int(ts), timezone.utc).astimezone(NY).strftime("%a %b %d %I:%M %p ET")
    except Exception:
        return ""

def scan(log=print, max_days=14, orderbooks=True, ob_limit=250):
    t0 = time.time()
    errors = []
    with ThreadPoolExecutor(3) as ex:
        fs = ex.submit(fetch_jupiter_events, "sports", log)
        fe = ex.submit(fetch_jupiter_events, "esports", log)
        fp = ex.submit(fetch_pinnacle, log, errors)
        events = []
        for name, f in (("sports", fs), ("esports", fe)):
            try: events += f.result()
            except Exception as e:
                errors.append(f"Jupiter {name}: {e}"); log(f"Jupiter {name} failed: {e}")
        games = fp.result()
    if not events:
        raise RuntimeError("Jupiter feed unavailable: " + " | ".join(errors))
    if not games:
        errors.append("Pinnacle returned no priced games - every bet will show 'no edge data'")
    games_by_sport = {}
    for g in games: games_by_sport.setdefault(g["sport"], []).append(g)
    now = time.time()
    rows, n_markets, n_matched_events = [], 0, 0
    for e in events:
        if e.get("category") not in ("sports", "esports") or not e.get("isActive", True): continue
        g, orient = match_game(e, games_by_sport)
        if g: n_matched_events += 1
        slug = e["metadata"].get("slug") or ""
        link = f"https://jup.ag/prediction/{e['eventId']}"
        for m in e.get("markets") or []:
            if m.get("status") != "open": continue
            ct = int(m.get("closeTime") or 0)
            if ct and ct < now: continue
            if max_days and ct and ct > now + max_days * 86400: continue
            pr = m.get("pricing") or {}
            n_markets += 1
            fair = fair_for(m, g, orient) if g else None
            for side, key in (("YES", "buyYesPriceUsd"), ("NO", "buyNoPriceUsd")):
                p = (pr.get(key) or 0) / 1e6
                if not (0.005 < p < 0.995): continue
                q = desc = vig = None
                if fair:
                    q = fair[0] if side == "YES" else 1 - fair[0]
                    desc, vig = fair[1], fair[2]
                label = m.get("title", "")
                opt = (m.get("marketOptions") or [{}])[0].get("label")
                if opt and opt not in ("Yes", "No"): label = opt
                if side == "NO" or (m.get("outcomes") == ["Yes", "No"]): label = f"{label} — {side}"
                cost = p + fee_per_contract(p)
                rows.append(dict(
                    event=e["metadata"]["title"], league=e["metadata"].get("league") or e.get("subcategory"),
                    category=e["category"], sub=e.get("subcategory"), market_type=m.get("sportsMarketType") or "other",
                    selection=label, side=side, market_id=m["marketId"], price=round(p, 4),
                    fee=round(fee_per_contract(p), 4), implied_prob=round(p, 4),
                    fair_prob=None if q is None else round(q, 4),
                    edge_pts=None if q is None else round(q - cost, 4),
                    ev_per_dollar=None if q is None else round(q / cost - 1, 4),
                    fair_source=desc, book_vig=None if vig is None else round(vig, 4),
                    pin_match=None if not g else f"{g['away']} @ {g['home']} ({g['league']})",
                    in_play=bool(e.get("isLive")), volume=pr.get("volume"),
                    closes=fmt_time(ct or e.get("beginAt")), starts=fmt_time(e.get("beginAt")),
                    close_ts=ct, link=link, depth_best=None, depth_ok=None, ob_ask=None))
    # order books for +EV candidates (depth = how much $ you can buy while edge >= 0)
    cands = sorted([r for r in rows if r["edge_pts"] is not None and r["edge_pts"] >= -0.005],
                   key=lambda r: -r["fair_prob"])[:ob_limit]
    if orderbooks and cands:
        with ThreadPoolExecutor(8) as ex:
            obs = list(ex.map(lambda r: fetch_orderbook(r["market_id"]), cands))
        if cands and not any(obs): errors.append("Jupiter /orderbook unavailable - depth columns empty")
        for r, ob in zip(cands, obs):
            a, b, c = depth_info(ob, r["side"], r["fair_prob"])
            r["ob_ask"], r["depth_best"], r["depth_ok"] = a, b, c
    for r in rows:
        w = []
        if r["edge_pts"] is not None and r["edge_pts"] > 0.10: w.append("edge >10pts: verify match/rules")
        if r["in_play"]: w.append("in-play: prices move fast")
        if r["edge_pts"] is not None and r["edge_pts"] >= 0 and r["depth_ok"] == 0: w.append("no fill at +EV price")
        r["warn"] = "; ".join(w)
    rows.sort(key=lambda r: (r["edge_pts"] is None, -(r["fair_prob"] or 0)))
    stats = dict(errors=errors, events=len(events), markets_scanned=n_markets, rows=len(rows),
                 events_matched=n_matched_events, pinnacle_games=len(games),
                 with_fair=sum(r["fair_prob"] is not None for r in rows),
                 positive=sum((r["edge_pts"] or -1) >= 0 for r in rows),
                 seconds=round(time.time() - t0, 1),
                 scanned_at=datetime.now(NY).strftime("%Y-%m-%d %I:%M:%S %p ET"))
    log(f"done: {stats}")
    return dict(stats=stats, rows=rows)

def best_bets(result, min_edge=0.0, min_depth=0):
    return [r for r in result["rows"] if r["edge_pts"] is not None and r["edge_pts"] >= min_edge
            and (r["depth_ok"] is None or r["depth_ok"] >= min_depth)]

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv"); ap.add_argument("--json"); ap.add_argument("--top", type=int, default=25)
    ap.add_argument("--days", type=int, default=14, help="only markets closing within N days (0 = all)")
    ap.add_argument("--min-depth", type=float, default=0)
    a = ap.parse_args()
    res = scan(log=lambda s: print(s, file=sys.stderr), max_days=a.days)
    if a.json: json.dump(res, open(a.json, "w"))
    bb = best_bets(res, 0.0, a.min_depth)
    if a.csv:
        import csv
        with open(a.csv, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(res["rows"][0].keys())); w.writeheader(); w.writerows(bb)
    print(f"{'fair':>6} {'price':>6} {'edge':>6} {'EV/$':>6} {'$ok':>8}  event | selection | closes")
    for r in bb[:a.top]:
        print(f"{r['fair_prob']:6.1%} {r['price']:6.3f} {r['edge_pts']*100:5.1f}p {r['ev_per_dollar']:6.1%} "
              f"{(r['depth_ok'] if r['depth_ok'] is not None else float('nan')):8.0f}  {r['event']} | {r['selection']} | {r['closes']}")
