#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""模拟盘 agent：ETF 趋势轮动 v1。

规则（与 PRD 11.4 一致）：
  1. 标的池 12 只 ETF；收盘后按最近日线计算 MA20 与 20 日涨幅。
  2. 候选 = 收盘价 > MA20 且 20 日涨幅 > 0；按 20 日涨幅降序。
  3. 最多持有 3 只、等权目标；持仓跌出候选先卖。
  4. 每次运行最多新开 1 只（降低换手）；双边手续费 0.05%，滑点 0.05%。
  5. 每次运行都写决策记录（含不交易）；按日记录净值。

用法：
  python3 paper.py --init      # 建初始账户
  python3 paper.py --decide    # 跑一次决策
  python3 paper.py --status    # 打印当前账户
"""
import argparse
import datetime as dt
import json
import os
import sys
import urllib.request

DATA_DIR = os.path.expanduser(os.environ.get("SECTOR_BOARD_DIR", "~/.dsh/sector-board"))
PAPER_PATH = os.path.join(DATA_DIR, "paper.json")
SINA_KLINE = ("https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData"
              "?symbol={sym}&scale=240&ma=no&datalen=320")
UA = {"User-Agent": "Mozilla/5.0", "Referer": "https://finance.sina.com.cn/"}
INITIAL = 100000.0
FEE = 0.0005
SLIP = 0.0005

UNIVERSE = [
    ("510300", "沪深300ETF"), ("510500", "中证500ETF"), ("159915", "创业板ETF"),
    ("588000", "科创50ETF"), ("510880", "红利ETF"), ("513130", "恒生科技ETF"),
    ("159941", "纳指ETF"), ("518880", "黄金ETF"), ("512400", "有色金属ETF"),
    ("512480", "半导体ETF"), ("512010", "医药ETF"), ("512660", "军工ETF"),
]
HOLD_MAX = 3


def now_cn():
    return dt.datetime.now(dt.timezone(dt.timedelta(hours=8)))


def symbol(code):
    return ("sh" if code[0] in "569" else "bj" if code[0] == "4" or code[:2] in ("83", "87", "88", "92") else "sz") + code


def bars(code):
    req = urllib.request.Request(SINA_KLINE.format(sym=symbol(code)), headers=UA)
    with urllib.request.urlopen(req, timeout=20) as resp:
        rows = json.loads(resp.read().decode("utf-8", "replace"))
    out = []
    for r in rows or []:
        try:
            out.append({"date": r["day"], "close": float(r["close"])})
        except (KeyError, TypeError, ValueError):
            continue
    return out


def metrics(code, name):
    try:
        bs = bars(code)
    except Exception as exc:  # noqa: BLE001
        print(f"warn {code} bars failed: {exc}", file=sys.stderr)
        return None
    if len(bs) < 25:
        return None
    closes = [b["close"] for b in bs]
    ma20 = sum(closes[-20:]) / 20
    ret20 = closes[-1] / closes[-21] - 1 if closes[-21] else 0.0
    return {"code": code, "name": name, "price": closes[-1], "ma20": round(ma20, 4),
            "ret20": round(ret20, 4), "date": bs[-1]["date"],
            "above_ma": closes[-1] > ma20, "eligible": closes[-1] > ma20 and ret20 > 0}


class PaperCorrupt(RuntimeError):
    """账户文件存在但读不出来。这种情况必须 fail-loud：静默重建等于丢掉全部交易历史。"""


def load():
    """读账户。文件不存在返回 None；文件存在但损坏则抛 PaperCorrupt（绝不吞成 None）。"""
    try:
        with open(PAPER_PATH, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return None
    except Exception as exc:  # noqa: BLE001
        raise PaperCorrupt(f"模拟盘账户文件损坏，拒绝覆盖：{PAPER_PATH}（{exc}）") from exc
    if not isinstance(data, dict):
        raise PaperCorrupt(f"模拟盘账户文件格式不对，拒绝覆盖：{PAPER_PATH}")
    return data


def save(acc):
    os.makedirs(DATA_DIR, exist_ok=True)
    # 临时文件名带 pid：robot 与 HTTP /decide 并发时不会互相踩同一个 .tmp
    tmp = f"{PAPER_PATH}.{os.getpid()}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(acc, f, ensure_ascii=False, indent=2)
        os.replace(tmp, PAPER_PATH)
    finally:
        if os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass


def init(force=False):
    """建初始账户。

    force=False 时若账户已存在就直接返回它 —— decide() 首跑走的是 `load() or init()`，
    不能因为「已经有账户」在这里把账户清掉；写穿账户只允许显式 --force。
    """
    if not force and os.path.exists(PAPER_PATH):
        # 用「文件是否存在」判断，而不是「load() 是否拿到东西」：文件损坏时 load() 抛错，
        # 绝不能在这里静默重建一个新账户把原文件覆盖掉。
        return load()
    acc = {"created_at": now_cn().isoformat(timespec="seconds"), "strategy": "trend-rotation-v1",
           "initial": INITIAL, "cash": INITIAL, "positions": [], "trades": [],
           "equity": [], "decisions": []}
    save(acc)
    return acc


def equity_of(acc, prices=None):
    prices = prices or {}
    mv = 0.0
    for p in acc["positions"]:
        mv += p["qty"] * prices.get(p["code"], p["cost"])
    return round(acc["cash"] + mv, 2)


def decide():
    acc = load() or init()
    ms = []
    for code, name in UNIVERSE:
        m = metrics(code, name)
        if m:
            ms.append(m)
    if not ms:
        print("no metrics, abort", file=sys.stderr)
        return 1
    as_of = max(m["date"] for m in ms)
    prices = {m["code"]: m["price"] for m in ms}
    held = {p["code"]: p for p in acc["positions"]}

    # 先卖：不在候选中
    eligible = sorted([m for m in ms if m["eligible"]], key=lambda m: -m["ret20"])
    keep = {m["code"] for m in eligible[:HOLD_MAX]}
    actions = []
    for code, pos in list(held.items()):
        if code in keep:
            continue
        m = next((x for x in ms if x["code"] == code), None)
        if not m:
            continue
        px = m["price"] * (1 - SLIP)
        gross = pos["qty"] * px
        fee = gross * FEE
        acc["cash"] += gross - fee
        acc["positions"] = [p for p in acc["positions"] if p["code"] != code]
        acc["trades"].append({"date": as_of, "side": "sell", "code": code, "name": pos["name"],
                              "qty": pos["qty"], "price": round(px, 4), "amount": round(gross, 2),
                              "fee": round(fee, 2),
                              "reason": "跌破 MA20 或 20 日涨幅转负" if not m["eligible"] else "跌出前三"})
        actions.append(f"卖出 {pos['name']} {pos['qty']} 份 @{px:.3f}")

    held = {p["code"]: p for p in acc["positions"]}
    equity = equity_of(acc, prices)
    slots = HOLD_MAX - len(acc["positions"])
    bought = 0
    for m in eligible:
        if bought >= 1 or slots <= 0:
            break
        if m["code"] in held:
            continue
        budget = equity / HOLD_MAX
        px = m["price"] * (1 + SLIP)
        qty = int(budget // (px * 100)) * 100  # ETF 按 100 份取整
        if qty <= 0:
            continue
        gross = qty * px
        fee = gross * FEE
        if gross + fee > acc["cash"]:
            continue
        acc["cash"] -= gross + fee
        acc["positions"].append({"code": m["code"], "name": m["name"], "qty": qty,
                                 "cost": round(px, 4), "opened_at": as_of,
                                 "reason": f"MA20 上方且 20 日涨幅 {m['ret20'] * 100:.1f}%"})
        acc["trades"].append({"date": as_of, "side": "buy", "code": m["code"], "name": m["name"],
                              "qty": qty, "price": round(px, 4), "amount": round(gross, 2),
                              "fee": round(fee, 2),
                              "reason": f"20 日涨幅 {m['ret20'] * 100:.1f}%，收盘 > MA20"})
        actions.append(f"买入 {m['name']} {qty} 份 @{px:.3f}")
        slots -= 1
        bought += 1

    nav = equity_of(acc, prices)
    acc.setdefault("equity", [])
    if not acc["equity"] or acc["equity"][-1]["date"] != as_of:
        acc["equity"].append({"date": as_of, "equity": nav, "cash": round(acc["cash"], 2),
                              "positions": len(acc["positions"])})
    detail = [f"{m['name']} 20日{m['ret20'] * 100:+.1f}% {'站上' if m['above_ma'] else '跌破'}MA20"
              for m in ms]
    acc.setdefault("decisions", []).append({
        "date": as_of, "at": now_cn().isoformat(timespec="seconds"),
        "action": "trade" if actions else "hold",
        "summary": "；".join(actions) if actions else "无交易：持仓仍在候选内，或没有符合条件的 ETF",
        "detail": detail, "nav": nav, "cash": round(acc["cash"], 2),
        "positions": [{"code": p["code"], "name": p["name"], "qty": p["qty"]} for p in acc["positions"]],
    })
    acc["updated_at"] = now_cn().isoformat(timespec="seconds")
    save(acc)
    print(json.dumps({"as_of": as_of, "nav": nav, "actions": actions,
                      "positions": len(acc["positions"])}, ensure_ascii=False))
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--init", action="store_true", help="建初始账户（已存在时不覆盖）")
    ap.add_argument("--force", action="store_true", help="与 --init 连用：清空已有账户重建")
    ap.add_argument("--decide", action="store_true")
    ap.add_argument("--status", action="store_true")
    args = ap.parse_args()
    try:
        if args.init:
            init(force=args.force)
        if args.decide:
            return decide()
        acc = load()
    except PaperCorrupt as exc:
        print(str(exc), file=sys.stderr)
        print("账户文件已保留原样；请手工修复或确认后用 --init --force 重建。", file=sys.stderr)
        return 2
    if not acc:
        print("no account; run --init")
        return 1
    print(json.dumps({"nav": equity_of(acc), "cash": acc["cash"],
                      "positions": acc["positions"], "trades": len(acc["trades"])},
                     ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
