#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""机器人交易员：在模拟盘里按「底部反转龙头」买卖，决策可由 opencode 免费模型给出。

数据来源：
  - 候选与情绪：~/.dsh/sector-board/dashboard.json 的 decision.leaders / risks / sentiment
  - 实时/收盘价：腾讯 qt.gtimg.cn（A 股、ETF）
  - 账户：~/.dsh/sector-board/paper.json（与 paper.py 共用）

决策模式（自动降级）：
  1. opencode CLI：PATH 里有 `opencode` 时，调用 `opencode run --model <model> "<prompt>"`
  2. opencode HTTP：设置 OPENCODE_API_KEY（可选 OPENCODE_BASE_URL / OPENCODE_MODEL），
     走 OpenAI 兼容 /chat/completions
  3. rules：没有可用模型时用确定性规则（只买候选里分数最高的，跌破止损/进入风险名单卖出）

硬约束（无论谁决策都执行）：
  - 最多 3 只持仓，单只目标权重 ≤ 34%
  - A 股/ETF 按 100 股/份取整；双边手续费 0.05%、滑点 0.05%
  - 只允许买卖候选池或已持仓；持仓亏损 ≤ -8% 强制卖出
  - 所有动作写进 decisions，包含来源（model/rules）、理由、被拒原因

用法：
  python3 robot.py --run            # 跑一次（自动选模式）
  python3 robot.py --run --dry-run  # 只出决策，不落账
  python3 robot.py --status
"""
import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request

DATA_DIR = os.path.expanduser(os.environ.get("SECTOR_BOARD_DIR", "~/.dsh/sector-board"))
PAPER_PATH = os.path.join(DATA_DIR, "paper.json")
DASH_PATH = os.path.join(DATA_DIR, "dashboard.json")
INITIAL = 100000.0
FEE = 0.0005
SLIP = 0.0005
MAX_POS = 3
MAX_WEIGHT = 0.34
STOP_LOSS = -0.08
MIN_SCORE = 55.0

UA = {"User-Agent": "Mozilla/5.0", "Referer": "https://finance.sina.com.cn/"}


def load_env_file():
    """读取 DATA_DIR/robot.env（KEY=VALUE），让 launchd 任务也能拿到 opencode 凭据。"""
    path = os.path.join(DATA_DIR, "robot.env")
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    except FileNotFoundError:
        pass


def now_cn():
    return dt.datetime.now(dt.timezone(dt.timedelta(hours=8)))


def previous_weekday(day):
    """最近一个已收盘的工作日（周一取上周五；不含节假日日历）。"""
    day = day - dt.timedelta(days=1)
    while day.weekday() >= 5:
        day = day - dt.timedelta(days=1)
    return day


def symbol(code):
    code = str(code)
    if code.startswith(("sh", "sz", "bj")):
        return code
    if code[0] in "569":
        return "sh" + code
    if code[0] == "4" or code[:2] in ("83", "87", "88", "92"):
        return "bj" + code
    return "sz" + code


def load_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return default


def save(acc):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = PAPER_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(acc, f, ensure_ascii=False, indent=2)
    os.replace(tmp, PAPER_PATH)


def quotes(codes):
    """腾讯实时报价，返回 {code: {price, pct, name, prev_close}}。"""
    out = {}
    codes = [c for c in dict.fromkeys(codes) if c]
    for i in range(0, len(codes), 50):
        batch = codes[i:i + 50]
        url = "https://qt.gtimg.cn/q=" + ",".join(symbol(c) for c in batch)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                text = resp.read().decode("gbk", "replace")
        except Exception as exc:  # noqa: BLE001
            print(f"warn quotes failed: {exc}", file=sys.stderr)
            continue
        for line in text.split(";"):
            if "=" not in line or "~" not in line:
                continue
            try:
                body = line.split('="', 1)[1].rstrip('"')
                parts = body.split("~")
                code = parts[2]
                out[code] = {
                    "name": parts[1],
                    "price": float(parts[3]),
                    "prev_close": float(parts[4]) if parts[4] else None,
                    "pct": float(parts[32]) / 100 if len(parts) > 32 and parts[32] else 0.0,
                    "time": parts[30] if len(parts) > 30 else "",
                }
            except (IndexError, ValueError):
                continue
    return out


def positions_with_pnl(acc, q):
    rows = []
    for p in acc.get("positions", []):
        quote = q.get(p["code"]) or {}
        price = quote.get("price") or p["cost"]
        pnl = price / p["cost"] - 1 if p["cost"] else 0.0
        rows.append({
            "code": p["code"], "name": p.get("name") or quote.get("name") or p["code"],
            "qty": p["qty"], "cost": p["cost"], "price": round(price, 4),
            "pnl": round(pnl, 4), "mcap": p.get("mcap"),
            "opened_at": p.get("opened_at"), "reason": p.get("reason"),
        })
    return rows


def market_context():
    dash = load_json(DASH_PATH, {}) or {}
    dec = dash.get("decision") or {}
    return {
        "as_of": dash.get("as_of"),
        "sentiment": dec.get("sentiment") or {},
        "leaders": [x for x in (dec.get("leaders") or []) if (x.get("score") or 0) >= MIN_SCORE],
        "risks": {x["code"]: x for x in (dec.get("risks") or []) if x.get("code")},
        "market": dash.get("market") or {},
    }


PROMPT = """你是一个 A 股模拟盘交易员，资金 {equity:.0f} 元，持有周期以周/月为主，偏好「周期底部出现反转趋势」的龙头股。

今天 {date}，市场情绪：{sentiment_label}（{sentiment_score}/100，涨 {up} 跌 {down}，涨停 {lu} 跌停 {ld}），中位涨跌 {median:+.2f}%。

当前持仓：
{positions}

候选池（ETL 按「底部 + 反转确认」筛出，已按得分排序，不要买列表外的股票）：
{candidates}

硬约束：
1. 最多持有 {max_pos} 只，单只目标权重不超过 {max_weight:.0%} 的当前净值。
2. 买入按 100 股整数倍；只能买候选池里的代码。
3. 持仓亏损达到 -8% 必须卖出；进入风险名单（高位超买/死叉）也应卖出。
4. 没有合适机会就少动，不要为了交易而交易。
5. 卖出理由必须是失效条件（跌破支撑、趋势破坏、进入风险名单、止损）。

请只输出 JSON，不要解释：
{{"summary":"一句话结论","orders":[{{"code":"600519","side":"buy|sell","weight":0.3,"reason":"..."}}],"watch":["最值得盯但今天不买的代码"]}}

要求：orders 最多 4 条；weight 仅对 buy 生效，0.1–0.34；sell 表示清仓。如果今天不交易，orders 返回空数组。
"""


def build_prompt(acc, ctx, pos, q, date):
    cand_lines = []
    for i, x in enumerate(ctx["leaders"][:12], 1):
        cand_lines.append(
            f"{i}. {x['code']} {x['name']}｜{x.get('industry','')}｜现价 {x.get('price')} "
            f"今日 {(x.get('pct') or 0):+.1f}% 5日 {((x.get('pct5') or 0)*100):+.1f}% "
            f"1年位置 {((x.get('pos250') or 0)*100):.0f}% 5年位置 {((x.get('pos1250') or 0)*100):.0f}% "
            f"MA20 距离 {((x.get('ma20_dist') or 0)*100):+.1f}% 斜率 {((x.get('ma20_slope') or 0)*100):+.1f}% "
            f"MACD {x.get('macd_zone','')} RSI {x.get('rsi14','')} 量比 {x.get('vol_ratio','')} "
            f"得分 {x.get('score')}｜触发：{x.get('trigger','')}｜失效：{x.get('invalid','')}"
        )
    pos_lines = [f"- {p['code']} {p['name']} {p['qty']} 股 成本 {p['cost']} 现价 {p['price']} 浮盈亏 {((p.get('pnl') or 0)*100):+.1f}%"
                 for p in pos] or ["（空仓）"]
    eq = account_equity(acc, q)
    s = ctx["sentiment"]
    return PROMPT.format(
        equity=eq, date=date, sentiment_label=s.get("label"), sentiment_score=s.get("score"),
        up=(s.get("parts") or {}).get("up", 0), down=(s.get("parts") or {}).get("down", 0),
        lu=(s.get("parts") or {}).get("limit_up", 0), ld=(s.get("parts") or {}).get("limit_down", 0),
        median=s.get("median_pct", 0), positions="\n".join(pos_lines),
        candidates="\n".join(cand_lines) or "（今天没有符合底部反转条件的候选）",
        max_pos=MAX_POS, max_weight=MAX_WEIGHT,
    )


def account_equity(acc, q):
    mv = 0.0
    for p in acc.get("positions", []):
        price = (q.get(p["code"]) or {}).get("price") or p["cost"]
        mv += p["qty"] * price
    return acc["cash"] + mv


def call_opencode_cli(prompt, model):
    exe = os.environ.get("OPENCODE_BIN") or shutil.which("opencode")
    if not exe:
        return None, "opencode-cli-not-installed"
    cmd = [exe, "run"] + (["--model", model] if model else []) + [prompt]
    sandbox = tempfile.mkdtemp(prefix="opencode-sandbox-")
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=240, cwd=sandbox)
    except Exception as exc:  # noqa: BLE001
        return None, f"opencode-cli-error:{exc}"
    if proc.returncode != 0:
        return None, f"opencode-cli-exit:{proc.returncode}:{proc.stderr[-300:]}"
    return proc.stdout, "opencode-cli"


def call_opencode_http(prompt, model):
    key = os.environ.get("OPENCODE_API_KEY") or os.environ.get("ZEN_API_KEY")
    if not key:
        return None, "no-OPENCODE_API_KEY"
    base = os.environ.get("OPENCODE_BASE_URL", "https://opencode.ai/zen/v1").rstrip("/")
    model = model or "opencode/grok-code"
    body = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": "你是严格输出 JSON 的 A 股模拟盘交易员。"},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.2,
    }).encode("utf-8")
    req = urllib.request.Request(base + "/chat/completions", data=body, headers={
        "Content-Type": "application/json", "Authorization": "Bearer " + key,
    })
    try:
        with urllib.request.urlopen(req, timeout=240) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
        return data["choices"][0]["message"]["content"], "opencode-http"
    except Exception as exc:  # noqa: BLE001
        return None, f"opencode-http-error:{exc}"


def parse_orders(text):
    if not text:
        return None
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    try:
        obj = json.loads(m.group(0))
    except json.JSONDecodeError:
        return None
    orders = obj.get("orders")
    if not isinstance(orders, list):
        return None
    clean = []
    for o in orders:
        if not isinstance(o, dict) or not o.get("code") or o.get("side") not in ("buy", "sell"):
            continue
        clean.append({
            "code": str(o["code"])[:6], "side": o["side"],
            "weight": float(o.get("weight") or 0), "reason": str(o.get("reason") or "")[:200],
        })
    return {"summary": str(obj.get("summary") or "")[:300], "orders": clean[:4],
            "watch": [str(c)[:6] for c in (obj.get("watch") or [])][:5]}


def rule_orders(acc, ctx, pos, q, eq):
    """确定性兜底：卖出风险/止损，买入得分最高的候选，等权 1/3。"""
    held = {p["code"]: p for p in pos}
    orders = []
    for p in pos:
        reason = None
        if p["pnl"] <= STOP_LOSS:
            reason = f"浮亏 {p['pnl']*100:.1f}%，触发止损"
        elif p["code"] in ctx["risks"]:
            reason = "进入高位/死叉风险名单：" + str(ctx["risks"][p["code"]].get("reason") or "")
        if reason:
            orders.append({"code": p["code"], "side": "sell", "weight": 0, "reason": reason})
    kept = {p["code"] for p in pos if p["code"] not in {o["code"] for o in orders}}
    slots = MAX_POS - len(kept)
    for x in ctx["leaders"]:
        if slots <= 0:
            break
        if x["code"] in kept:
            continue
        if x.get("score", 0) < MIN_SCORE:
            break
        orders.append({"code": x["code"], "side": "buy", "weight": min(MAX_WEIGHT, 1.0 / MAX_POS),
                       "reason": f"底部反转候选，得分 {x.get('score')}；{x.get('trigger','')}"})
        slots -= 1
    return {"summary": "规则模式：按止损/风险名单卖出，按得分买入候选" if orders else "规则模式：无动作",
            "orders": orders, "watch": []}


def execute(acc, orders, q, ctx, date, dry):
    cand_codes = {x["code"] for x in ctx["leaders"]}
    held = {p["code"]: p for p in acc.get("positions", [])}
    executed, rejected = [], []
    eq = account_equity(acc, q)
    for o in orders:
        code, side = o["code"], o["side"]
        quote = q.get(code)
        price = (quote or {}).get("price")
        if side == "sell":
            pos = held.get(code)
            if not pos:
                rejected.append({**o, "why": "未持仓"})
                continue
            if not price:
                rejected.append({**o, "why": "无报价"})
                continue
            px = price * (1 - SLIP)
            gross = pos["qty"] * px
            fee = gross * FEE
            if dry:
                executed.append({"side": "sell", "code": code, "name": pos.get("name"), "qty": pos["qty"],
                                 "price": round(px, 4), "reason": o.get("reason")})
                continue
            acc["cash"] += gross - fee
            acc["positions"] = [p for p in acc["positions"] if p["code"] != code]
            held.pop(code, None)
            acc.setdefault("trades", []).append({
                "date": date, "side": "sell", "code": code, "name": pos.get("name"),
                "qty": pos["qty"], "price": round(px, 4), "amount": round(gross, 2),
                "fee": round(fee, 2), "reason": o.get("reason"), "source": "robot"})
            executed.append({"side": "sell", "code": code, "name": pos.get("name"), "qty": pos["qty"],
                             "price": round(px, 4), "reason": o.get("reason")})
            eq = account_equity(acc, q)
            continue

        if code not in cand_codes:
            rejected.append({**o, "why": "不在候选池"})
            continue
        if code in held:
            rejected.append({**o, "why": "已持仓"})
            continue
        if len(acc.get("positions", [])) >= MAX_POS:
            rejected.append({**o, "why": f"已满 {MAX_POS} 只"})
            continue
        if not price:
            rejected.append({**o, "why": "无报价"})
            continue
        w = max(0.05, min(MAX_WEIGHT, float(o.get("weight") or 1.0 / MAX_POS)))
        budget = eq * w
        px = price * (1 + SLIP)
        qty = int(budget // (px * 100)) * 100
        if qty <= 0:
            rejected.append({**o, "why": "预算不足 100 股"})
            continue
        gross = qty * px
        fee = gross * FEE
        if gross + fee > acc["cash"]:
            rejected.append({**o, "why": "现金不足"})
            continue
        x = next(x for x in ctx["leaders"] if x["code"] == code)
        if dry:
            executed.append({"side": "buy", "code": code, "name": x.get("name"), "qty": qty,
                             "price": round(px, 4), "reason": o.get("reason")})
            continue
        acc["cash"] -= gross + fee
        acc.setdefault("positions", []).append({
            "code": code, "name": x.get("name"), "qty": qty, "cost": round(px, 4),
            "opened_at": date, "reason": o.get("reason"), "mcap": x.get("mcap"),
        })
        acc.setdefault("trades", []).append({
            "date": date, "side": "buy", "code": code, "name": x.get("name"),
            "qty": qty, "price": round(px, 4), "amount": round(gross, 2),
            "fee": round(fee, 2), "reason": o.get("reason"), "source": "robot"})
        executed.append({"side": "buy", "code": code, "name": x.get("name"), "qty": qty,
                         "price": round(px, 4), "reason": o.get("reason")})
        eq = account_equity(acc, q)
    return executed, rejected


def run(dry=False, model=None, force_rules=False, force=False):
    acc = load_json(PAPER_PATH)
    if not acc:
        acc = {"created_at": now_cn().isoformat(timespec="seconds"), "strategy": "bottom-reversal-robot",
               "initial": INITIAL, "cash": INITIAL, "positions": [], "trades": [],
               "equity": [], "decisions": []}
    ctx = market_context()
    now = now_cn()
    today = now.date().isoformat()
    # 账本永远按“今天”记账；dashboard.as_of 只作为分析快照日期。
    # 如果分析快照还停留在更早的交易日，宁可跳过，也不要把今天的行情
    # 写到旧日期上（否则会出现“11-20 的决策用了 11-23 的价格”）。
    date = today
    ctx_asof = str(ctx.get("as_of") or "")[:10]
    expected = previous_weekday(now.date()).isoformat()
    if ctx_asof and ctx_asof < expected and not force:
        print(json.dumps({"skip": "stale-dashboard", "dashboard_as_of": ctx_asof,
                          "expected_analysis_date": expected, "ledger_date": today},
                         ensure_ascii=False))
        return 0
    codes = [p["code"] for p in acc.get("positions", [])] + [x["code"] for x in ctx["leaders"][:12]]
    q = quotes(codes)
    pos = positions_with_pnl(acc, q)

    if now.weekday() >= 5 and not force:
        print(json.dumps({"skip": "weekend", "date": today}, ensure_ascii=False))
        return 0
    quote_days = {str(v.get("time", ""))[:8] for v in q.values() if v.get("time")}
    if q and not force and quote_days and today.replace("-", "") not in quote_days:
        print(json.dumps({"skip": "stale-quotes", "date": today, "quote_days": sorted(quote_days)},
                         ensure_ascii=False))
        return 0
    if not q and not force:
        print(json.dumps({"skip": "no-quotes", "date": today}, ensure_ascii=False))
        return 0

    model = model or os.environ.get("OPENCODE_MODEL") or None
    mode, note = "rules", ""
    decision = None
    if not force_rules:
        prompt = build_prompt(acc, ctx, pos, q, date)
        for fn, label in ((lambda p, m: call_opencode_cli(p, m), "cli"),
                          (lambda p, m: call_opencode_http(p, m), "http")):
            text, tag = fn(prompt, model)
            if text:
                decision = parse_orders(text)
                if decision:
                    mode, note = ("opencode-" + label), tag
                    break
                note = f"{tag}: 输出无法解析为 JSON"
            else:
                note = tag
    if not decision:
        mode, note = "rules", note or "no-model"
        decision = rule_orders(acc, ctx, pos, q, account_equity(acc, q))

    executed, rejected = execute(acc, decision["orders"], q, ctx, date, dry)
    nav = round(account_equity(acc, q), 2)
    if not dry:
        acc.setdefault("equity", [])
        if not acc["equity"] or acc["equity"][-1]["date"] != date:
            acc["equity"].append({"date": date, "equity": nav, "cash": round(acc["cash"], 2),
                                  "positions": len(acc["positions"])})
        acc.setdefault("decisions", []).append({
            "date": date, "at": now_cn().isoformat(timespec="seconds"), "mode": mode,
            "model": model if mode.startswith("opencode") else None,
            "action": "trade" if executed else "hold",
            "summary": decision.get("summary") or "无动作",
            "orders": decision["orders"], "executed": executed, "rejected": rejected,
            "watch": decision.get("watch") or [],
            "sentiment": ctx["sentiment"].get("score"),
            "note": note, "nav": nav, "cash": round(acc["cash"], 2),
            "positions": [{"code": p["code"], "name": p["name"], "qty": p["qty"]} for p in acc["positions"]],
        })
        acc["robot"] = {"last_run": now_cn().isoformat(timespec="seconds"), "mode": mode,
                        "model": model if mode.startswith("opencode") else None, "note": note,
                        "next_run": "工作日 14:50（launchd）"}
        acc["updated_at"] = now_cn().isoformat(timespec="seconds")
        save(acc)
    print(json.dumps({"date": date, "mode": mode, "model": model if mode.startswith("opencode") else None,
                      "note": note, "nav": nav, "summary": decision.get("summary"),
                      "executed": executed, "rejected": rejected}, ensure_ascii=False, indent=2))
    return 0


def status():
    acc = load_json(PAPER_PATH, {})
    print(json.dumps({"robot": acc.get("robot"), "cash": acc.get("cash"),
                      "positions": acc.get("positions", []),
                      "decisions": (acc.get("decisions") or [])[-3:]}, ensure_ascii=False, indent=2))


def main():
    load_env_file()
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--rules", action="store_true", help="强制规则模式（不调用模型）")
    ap.add_argument("--model", default=None)
    ap.add_argument("--force", action="store_true", help="忽略周末/行情日期守卫")
    args = ap.parse_args()
    if args.status:
        return status()
    return run(dry=args.dry_run, model=args.model, force_rules=args.rules, force=args.force)


if __name__ == "__main__":
    sys.exit(main())
