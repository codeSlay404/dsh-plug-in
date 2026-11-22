#!/usr/bin/env python3
"""Fetch latest company announcements from cninfo (巨潮资讯).

Output: ${SECTOR_BOARD_DIR:-~/.dsh/sector-board}/announcements.json

Examples:
  python3 announcements.py --codes 600519,000001
  python3 announcements.py --days 120 --max-codes 80
  python3 announcements.py --codes 300750 --limit-per-code 30
"""
import argparse
import concurrent.futures as cf
import datetime as dt
import html
import json
import os
import re
import sys
import threading
import time
import urllib.parse
import urllib.request

DATA_DIR = os.environ.get("SECTOR_BOARD_DIR") or os.path.expanduser("~/.dsh/sector-board")
OUT = os.path.join(DATA_DIR, "announcements.json")
STOCK_CACHE = os.path.join(DATA_DIR, "cninfo_stocks.json")
STOCK_URL = "https://www.cninfo.com.cn/new/data/szse_stock.json"
QUERY_URL = "https://www.cninfo.com.cn/new/hisAnnouncement/query"
EM_URL = "https://np-anotice-stock.eastmoney.com/api/security/ann"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
HEADERS = {"User-Agent": UA, "Referer": "https://www.cninfo.com.cn/", "Accept": "application/json, text/javascript, */*; q=0.01"}
EM_HEADERS = {"User-Agent": UA, "Referer": "https://data.eastmoney.com/", "Accept": "application/json, text/plain, */*", "Origin": "https://data.eastmoney.com"}
RATE_LOCK = threading.Lock()
LAST_REQ = [0.0]


def pace(interval=0.15):
    with RATE_LOCK:
        wait = max(0.0, LAST_REQ[0] + interval - time.time())
        if wait:
            time.sleep(wait)
        LAST_REQ[0] = time.time()


def load_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def http_get(url, timeout=20, headers=None):
    req = urllib.request.Request(url, headers=headers or HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def http_post(url, fields, timeout=25):
    body = urllib.parse.urlencode(fields).encode()
    req = urllib.request.Request(url, data=body, headers={**HEADERS, "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def stock_map(force=False):
    """code -> {orgId, name} from cninfo's full A-share list (cached 7 days)."""
    cached = load_json(STOCK_CACHE)
    if cached and not force:
        age = time.time() - os.path.getmtime(STOCK_CACHE)
        if age < 7 * 86400 and cached.get("stockList"):
            return {x["code"]: x for x in cached["stockList"]}
    raw = http_get(STOCK_URL, timeout=30)
    data = json.loads(raw.decode("utf-8"))
    save_json(STOCK_CACHE, data)
    return {x["code"]: x for x in data.get("stockList", [])}


def clean_title(s):
    s = html.unescape(s or "")
    s = re.sub(r"<[^>]+>", "", s)
    return re.sub(r"\s+", " ", s).strip()


def day(ms):
    try:
        return dt.datetime.fromtimestamp(int(ms) / 1000, tz=dt.timezone(dt.timedelta(hours=8))).strftime("%Y-%m-%d")
    except Exception:
        return ""


def default_codes():
    """Codes worth watching: decision leaders/risks, theme leaders, paper positions, LHB/youzi."""
    dash = load_json(os.path.join(DATA_DIR, "dashboard.json"), {}) or {}
    out = []

    def add(code):
        c = str(code or "").strip()
        if re.fullmatch(r"\d{6}", c) and c not in out:
            out.append(c)

    for key in ("leaders", "risks"):
        for x in (dash.get("decision") or {}).get(key, []) or []:
            add(x.get("code"))
    for t in dash.get("themes", []) or []:
        for s in (t.get("stocks") or [])[:3]:
            add(s.get("code"))
    for x in (dash.get("lhb") or {}).get("rows", []) or []:
        add(x.get("code"))
    for x in (dash.get("youzi") or {}).get("stocks", []) or []:
        add(x.get("code"))
    paper = load_json(os.path.join(DATA_DIR, "paper.json"), {}) or {}
    for p in paper.get("positions", []) or []:
        add(p.get("code"))
    return out


def fetch_eastmoney(code, days, limit):
    cutoff = dt.date.today() - dt.timedelta(days=days)
    params = urllib.parse.urlencode({
        "sr": -1, "page_size": max(10, min(100, limit)), "page_index": 1,
        "ann_type": "A", "client_source": "web", "stock_list": code,
    })
    try:
        raw = http_get(EM_URL + "?" + params, timeout=20, headers=EM_HEADERS)
        data = json.loads(raw.decode("utf-8"))
    except Exception as e:
        return code, [], f"eastmoney: {e}"
    rows = []
    for a in (data.get("data") or {}).get("list") or []:
        d = str(a.get("notice_date") or "")[:10]
        if d and d < cutoff.isoformat():
            continue
        cols = a.get("columns") or []
        typ = clean_title(cols[0].get("column_name")) if cols else "公告"
        title = clean_title(a.get("title") or "")
        nm = ((a.get("codes") or [{}])[0].get("short_name") or "").strip()
        if nm and title.startswith(nm + ":"):
            title = title[len(nm) + 1:].strip()
        if nm and title.startswith(nm + "："):
            title = title[len(nm) + 1:].strip()
        art = a.get("art_code") or ""
        rows.append({
            "code": code,
            "name": ((a.get("codes") or [{}])[0].get("short_name") or ""),
            "title": title,
            "type": typ or "公告",
            "date": d,
            "url": f"https://data.eastmoney.com/notices/detail/{code}/{art}.html" if art else "",
            "announcementId": art,
        })
    rows.sort(key=lambda x: x["date"], reverse=True)
    return code, rows[:limit], ""


def fetch_one(code, info, days, limit, attempt=0):
    org = (info or {}).get("orgId")
    if not org:
        return code, [], "no-orgId"
    cutoff = dt.date.today() - dt.timedelta(days=days)
    try:
        pace()
        raw = http_post(QUERY_URL, {
            "pageNum": 1,
            "pageSize": max(10, min(100, limit)),
            "column": "szse",
            "tabName": "fulltext",
            "plate": "",
            "stock": f"{code},{org}",
            "searchkey": "",
            "secdate": "",
            "tdate": "",
            "type": "",
            "isHLtitle": "true",
        })
        data = json.loads(raw.decode("utf-8"))
    except Exception as e:
        if attempt < 1 and "403" in str(e):
            time.sleep(1.2)
            return fetch_one(code, info, days, limit, attempt + 1)
        return fetch_eastmoney(code, days, limit)
    rows = []
    for a in data.get("announcements") or []:
        d = day(a.get("announcementTime"))
        if d and d < cutoff.isoformat():
            continue
        adj = a.get("adjunctUrl") or ""
        rows.append({
            "code": a.get("secCode") or code,
            "name": a.get("secName") or (info or {}).get("zwjc") or "",
            "title": clean_title(a.get("announcementTitle")),
            "type": clean_title(a.get("announcementTypeName") or a.get("columnName") or "公告"),
            "date": d,
            "url": ("https://static.cninfo.com.cn/" + adj.lstrip("/")) if adj else "",
            "announcementId": a.get("announcementId") or "",
        })
    rows.sort(key=lambda x: x["date"], reverse=True)
    return code, rows[:limit], ""


def main():
    ap = argparse.ArgumentParser(description="Fetch latest A-share company announcements from cninfo")
    ap.add_argument("--codes", help="comma-separated 6-digit codes; default: watchlist from dashboard/paper")
    ap.add_argument("--days", type=int, default=180, help="lookback days (default 180)")
    ap.add_argument("--limit-per-code", type=int, default=20, help="max announcements per stock (default 20)")
    ap.add_argument("--max-codes", type=int, default=60, help="cap number of stocks (default 60)")
    ap.add_argument("--workers", type=int, default=2, help="parallel requests (default 2)")
    ap.add_argument("--source", choices=["eastmoney", "cninfo"], default="eastmoney", help="announcement source (default eastmoney)")
    ap.add_argument("--force-list", action="store_true", help="refresh cninfo stock list cache")
    ap.add_argument("--merge", action="store_true", help="merge into existing announcements.json instead of replacing")
    args = ap.parse_args()

    codes = [c.strip() for c in (args.codes or "").split(",") if c.strip()] if args.codes else default_codes()
    codes = list(dict.fromkeys([c for c in codes if re.fullmatch(r"\d{6}", c)]))[: max(1, args.max_codes)]
    if not codes:
        print("no codes: pass --codes or run ETL first", file=sys.stderr)
        return 2

    try:
        stocks = stock_map(args.force_list)
    except Exception as e:
        print(f"failed to load cninfo stock list: {e}", file=sys.stderr)
        return 3

    all_rows, errors = [], []
    with cf.ThreadPoolExecutor(max_workers=max(1, args.workers)) as ex:
        if args.source == "eastmoney":
            futs = [ex.submit(fetch_eastmoney, c, args.days, args.limit_per_code) for c in codes]
        else:
            futs = [ex.submit(fetch_one, c, stocks.get(c), args.days, args.limit_per_code) for c in codes]
        for fut in cf.as_completed(futs):
            code, rows, err = fut.result()
            all_rows.extend(rows)
            if err:
                errors.append({"code": code, "error": err})

    old = load_json(OUT, {}) if args.merge else {}
    if old and old.get("rows"):
        merged = old["rows"] + all_rows
        seen, dedup = set(), []
        for r in merged:
            key = r.get("announcementId") or (r.get("code"), r.get("date"), r.get("title"))
            if key in seen:
                continue
            seen.add(key)
            dedup.append(r)
        all_rows = dedup
        codes = sorted(set(old.get("codes") or []) | set(codes))
    all_rows.sort(key=lambda x: (x["date"], x["code"]), reverse=True)
    dash = load_json(os.path.join(DATA_DIR, "dashboard.json"), {}) or {}
    payload = {
        "as_of": dash.get("as_of") or dt.date.today().isoformat(),
        "generated_at": dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(timespec="seconds"),
        "source": args.source,
        "count": len(all_rows),
        "codes": codes,
        "rows": all_rows,
        "errors": errors,
    }
    save_json(OUT, payload)
    print(json.dumps({"ok": True, "out": OUT, "count": len(all_rows), "codes": len(codes), "errors": len(errors)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
