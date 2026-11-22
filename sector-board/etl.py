#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""全 A 股板块看板 ETL。

数据源
  1. 新浪 hs_a：全 A 股列表（东财 clist 常被限流时兜底）
  2. 东财 emweb F10：申万一级行业（本地缓存，缺失才请求）
  3. 雪球 / 新浪 / 腾讯：320 根前复权日线，算 MACD / 涨跌 / 横盘 / 250 日分位
  4. 东财 datacenter：当日 PE_TTM / PB_MRQ 快照、龙虎榜与席位、近一年分红
  5. 新浪 1300 根日线：周期行业 5 年价格分位与年化波动

输出（默认 ~/.dsh/sector-board/）
  dashboard.json  看板数据：总览 / 龙虎榜 / 游资 / 板块周期 / 红利
  status.json     运行状态，供页面显示进度

用法
  python3 etl.py                # 全量
  python3 etl.py --limit 200    # 只跑前 200 只，调试
  python3 etl.py --if-fresh     # 今天已跑过且收盘，直接退出
"""
import argparse
import concurrent.futures as cf
import gzip
import http.cookiejar
import threading
import datetime as dt
import json
import os
import re
import sys
import tempfile
import time
import urllib.parse
import urllib.request

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "Referer": "https://quote.eastmoney.com/"}
SINA_UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
           "Referer": "https://finance.sina.com.cn/"}
EMWEB_UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
            "Referer": "https://emweb.securities.eastmoney.com/"}
TENCENT_UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
              "Referer": "https://gu.qq.com/"}
DATA_DIR = os.path.expanduser(os.environ.get("SECTOR_BOARD_DIR", "~/.dsh/sector-board"))
LIST_URL = ("https://push2.eastmoney.com/api/qt/clist/get?pn={pn}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3"
            "&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048"
            "&fields=f12,f14,f2,f3,f8,f9,f10,f20,f21,f23,f100")
SINA_LIST_URL = ("https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/"
                 "Market_Center.getHQNodeData?page={page}&num=100&sort=code&asc=1&node={node}")
SINA_COUNT_URL = ("https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/"
                  "Market_Center.getHQNodeStockCount?node={node}")
EMWEB_INDUSTRY_URL = "https://emweb.securities.eastmoney.com/PC_HSF10/CoreConception/PageAjax?code={sym}"
BOARD_MIN_SIZE = 5
BOARD_NOISE = re.compile(
    "板块$|风格$|指数|融|通$|仓|金股|新高|新低|重仓|标普|富时|MSCI|HS300|上证|深证|中证|央视|"
    "创业板|深成|AH股|转债|茅指数|宁组合|百元|低价|小盘|大盘|中盘|权重|龙头|趋势股|周期股|热股|"
    "亏损|破增发|振幅|换手|多板|做市|增持|减持|社保|私募|基金|保险|券商|股价|股$|A股|B股|H股|"
    "R$|_$|预盈|预增|ST|摘帽|填权|举牌|质押|高送转|回购|股权|员工持股|融资|北向|南向|QFII|"
    "市盈率|市净率|派息|股息率|重组|并购|借壳|退市|新股|次新|涨停|跌停|超跌|强势|弱势")
CONCEPT_EXTRA = {
    "白酒", "猪肉", "光伏", "影视", "半导体", "军工", "医药", "消费", "新能源", "储能", "氢能源",
    "机器人", "芯片", "游戏", "虚拟现实", "网红经济", "区块链", "跨境支付", "乡村振兴", "合成生物",
    "冰雪经济", "谷子经济", "短剧互动游戏", "数据要素", "算力租赁", "超级品牌", "央国企改革",
    "西部大开发", "电商", "旅游", "体育产业", "元宇宙", "人工智能", "大数据", "云计算", "物联网",
    "5G", "数字经济", "新型工业化", "低空经济", "车联网", "智能驾驶", "无人驾驶", "固态电池",
}
XQ_KLINE_URL = ("https://stock.xueqiu.com/v5/stock/chart/kline.json?symbol={sym}"
                "&begin={begin}&period=day&type=before&count=-320&indicator=kline")
SINA_KLINE_URL = ("https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData"
                  "?symbol={sym}&scale=240&ma=no&datalen=320")
KLINE_URL = "https://{host}/appstock/app/fqkline/get?param={sym},day,,,{n},qfq"
KLINE_HOSTS = ("proxy.finance.qq.com/ifzqgtimg", "ifzq.gtimg.cn")

SINA_KLINE_LONG_URL = ("https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData"
                       "?symbol={sym}&scale=240&ma=no&datalen={n}")
DATACENTER_URL = ("https://datacenter-web.eastmoney.com/api/data/v1/get?reportName={rn}"
                  "&columns=ALL&pageNumber={pn}&pageSize=100&sortColumns={sc}&sortTypes={st}{flt}")
DC_UA = {**UA, "Referer": "https://data.eastmoney.com/"}


SINA_ETF_LIST_URL = ("https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/"
                     "Market_Center.getHQNodeData?page={page}&num=100&sort=amount&asc=0&node=etf_hq_fund")
ETF_CATEGORIES = [
    ("跨境", ["恒生", "港股", "中概", "纳指", "纳斯达克", "标普", "日经", "东证", "德国", "法国",
              "英国", "欧洲", "东南亚", "亚太", "美国", "海外", "全球", "日本", "韩国", "越南"]),
    ("商品", ["黄金", "白银", "豆粕", "原油", "能源化工", "铜", "铝", "稀土"]),
    ("债券", ["国债", "政金", "债", "短融", "信用", "城投", "可转债"]),
    ("货币", ["货币", "日利", "现金", "添益", "快线"]),
    ("宽基", ["沪深300", "中证500", "中证1000", "中证2000", "上证50", "科创50", "科创100",
              "创业板", "深证", "上证", "北证", "中证A", "中证全指", "央视50", "基本面"]),
    ("行业", ["半导体", "芯片", "医药", "医疗", "生物", "军工", "证券", "银行", "保险", "非银",
              "地产", "基建", "建材", "煤炭", "钢铁", "有色", "化工", "农业", "食品", "饮料",
              "白酒", "家电", "汽车", "新能源", "光伏", "电力", "环保", "机械", "传媒", "游戏",
              "通信", "计算机", "软件", "人工智能", "机器人", "消费", "旅游", "教育"]),
    ("主题", ["红利", "价值", "成长", "低波", "质量", "央企", "国企", "ESG", "科技", "创新",
              "碳中和", "养老", "数字经济", "专精特新"]),
]

CYCLIC_SECTORS = ["有色金属", "钢铁", "煤炭", "石油石化", "基础化工", "建筑材料", "房地产",
                  "农林牧渔", "交通运输", "机械设备", "电力设备", "国防军工"]
CYCLE_META = {
    "有色金属": ("强周期", "金属价格 + 全球流动性"),
    "钢铁": ("强周期", "地产基建需求"),
    "煤炭": ("强周期", "能源价格 + 供给"),
    "石油石化": ("强周期", "油价"),
    "基础化工": ("强周期", "库存周期"),
    "建筑材料": ("强周期", "地产竣工"),
    "房地产": ("强周期", "销售 + 政策"),
    "农林牧渔": ("强周期", "猪价 / 农产品"),
    "交通运输": ("弱周期", "运价 + 出行"),
    "机械设备": ("弱周期", "制造业投资"),
    "电力设备": ("成长周期", "新能源装机"),
    "国防军工": ("成长周期", "订单 + 预算"),
}
STAGE_RULES = "底部: 大周期≤35% 且 小周期≤35% | 顶部: 大周期≥70% 且 小周期≥70% | 上行: 大周期≤55% 且 小周期>大周期+8pct | 下行: 大周期≥45% 且 小周期<大周期-8pct | 其余: 震荡"

THEME_GROUPS = ["科技周期", "消费周期", "新能源周期", "地产链", "资源周期"]
THEMES = [
    {"name": "半导体", "group": "科技周期", "boards": ["半导体概念", "半导体"],
     "character": "成长周期", "desc": "库存周期 + AI 资本开支。看存储价格、费城半导体与国内晶圆厂稼动率。"},
    {"name": "CPO/光模块", "group": "科技周期", "boards": ["CPO概念"],
     "character": "成长周期", "desc": "算力集群互联需求，跟随北美云厂与英伟达资本开支；订单能见度看头部厂商指引。"},
    {"name": "恒生科技", "group": "科技周期", "kind": "index", "proxy": "sh513130",
     "character": "成长周期", "desc": "港股互联网与硬科技，无 A 股成分；用恒生科技 ETF 513130 的走势代理，估值看恒指科技 PE。"},
    {"name": "机器人", "group": "科技周期", "boards": ["机器人概念", "人形机器人"],
     "character": "成长周期", "desc": "人形机器人产业化预期驱动，看量产节点、订单与灵巧手/丝杠等环节进展。"},
    {"name": "猪肉", "group": "消费周期", "boards": ["猪肉概念"],
     "character": "强周期", "desc": "猪周期核心是能繁母猪存栏与猪价；产能去化到价格上行通常有约 10 个月传导。"},
    {"name": "影视", "group": "消费周期", "boards": ["影视概念"],
     "character": "弱周期", "desc": "内容供给 + 票房，春节/暑期档是旺季；单片爆款对板块是脉冲式催化。"},
    {"name": "光伏", "group": "新能源周期", "boards": ["光伏概念"],
     "character": "强周期", "desc": "产能周期 + 装机需求，硅料价格与组件排产是核心变量；产能出清看资本开支收缩。"},
    {"name": "电池", "group": "新能源周期", "boards": ["锂电池概念", "固态电池", "燃料电池概念"],
     "character": "成长周期", "desc": "锂价 + 电池排产，固态电池是技术迭代变量；看装车量与储能招标。"},
    {"name": "房地产", "group": "地产链", "sector": "房地产",
     "character": "强周期", "desc": "销售/拿地/政策三要素；跟踪 30 城成交、按揭利率与收储进展。"},
    {"name": "有色金属", "group": "资源周期", "sector": "有色金属",
     "character": "强周期", "desc": "铜金铝价格 + 美元流动性；供给刚性、需求看电网与新能源。"},
    {"name": "稀土永磁", "group": "资源周期", "boards": ["稀土永磁"],
     "character": "强周期", "desc": "稀土配额与磁材需求，政策属性强；出口管制与收储是脉冲催化。"},
]

SIGNAL_KEYS = ["golden_above", "golden_below", "surge", "plunge", "plunge_flat", "cycle_low", "cycle_high"]
SIGNAL_LABEL = {
    "golden_above": "水上金叉", "golden_below": "水下金叉", "surge": "近期大涨",
    "plunge": "近期大跌", "plunge_flat": "大跌后横盘", "cycle_low": "周期底部", "cycle_high": "周期高点",
}


def now_iso():
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def shanghai_now():
    return dt.datetime.now(dt.timezone(dt.timedelta(hours=8)))


def atomic_write_json(path, obj):
    d = os.path.dirname(path)
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def write_status(**kw):
    try:
        atomic_write_json(os.path.join(DATA_DIR, "status.json"), dict(kw, updated_at=now_iso()))
    except OSError:
        pass


def http_json(url, headers, timeout=20, retries=2):
    last = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(0.4 * (attempt + 1))
    raise last


def market_symbol(code):
    """腾讯行情代码前缀。"""
    if code[0] in "69" or code[0] == "5":
        return "sh" + code
    if code[0] == "4" or code[:2] in ("83", "87", "88", "92"):
        return "bj" + code
    return "sz" + code


def board_limit(code):
    if code.startswith(("300", "301", "688", "689")):
        return 19.6
    if code[0] in "48" or code[:2] in ("83", "87", "88", "92"):
        return 29.4
    return 9.8


def http_text(url, headers, timeout=20, retries=2, encoding="utf-8"):
    last = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
            if raw[:2] == b"\x1f\x8b":
                raw = gzip.decompress(raw)
            return raw.decode(encoding, "replace")
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(0.4 * (attempt + 1))
    raise last


def em_secid(code):
    return ("1." if code[0] in "69" else "0.") + code


def fetch_list_em():
    def page(pn):
        data = http_json(LIST_URL.format(pn=pn), UA)
        d = data.get("data") or {}
        return d.get("diff") or [], int(d.get("total") or 0)

    rows, total = page(1)
    pages = max(1, (total + 99) // 100)
    with cf.ThreadPoolExecutor(max_workers=6) as ex:
        futures = {ex.submit(page, pn): pn for pn in range(2, pages + 1)}
        for fut in cf.as_completed(futures):
            try:
                part, _ = fut.result()
                rows.extend(part)
            except Exception as exc:  # noqa: BLE001
                print("list page failed:", futures[fut], exc, file=sys.stderr)
    out, seen = [], set()
    for r in rows:
        code = str(r.get("f12") or "")
        if not code or code in seen:
            continue
        seen.add(code)
        out.append({
            "code": code,
            "name": str(r.get("f14") or "").strip() or code,
            "industry": str(r.get("f100") or "").strip(),
            "price": num(r.get("f2")),
            "pct": num(r.get("f3")),
            "turnover": num(r.get("f8")),
            "pe": num(r.get("f9")),
            "pb": num(r.get("f23")),
            "mcap": num(r.get("f20")),
            "float_mcap": num(r.get("f21")),
        })
    if len(out) < 3000:
        raise ValueError(f"eastmoney list too short: {len(out)}")
    return out, total


def fetch_list_sina():
    out, seen = [], set()
    total = 0
    # 2026 起新浪 hs_a 已包含北交所（920xxx），hs_bjs 仅作兜底去重
    for node in ("hs_a", "hs_bjs"):
        time.sleep(0.6)
        try:
            count = int(http_text(SINA_COUNT_URL.format(node=node), SINA_UA).strip().strip('"'))
        except Exception:  # noqa: BLE001
            count = 0
        pages = max(1, (count + 99) // 100)
        for page in range(1, pages + 1):
            rows = None
            for attempt in range(4):
                try:
                    txt = http_text(SINA_LIST_URL.format(page=page, node=node), SINA_UA)
                    rows = json.loads(txt)
                    break
                except Exception as exc:  # noqa: BLE001
                    print("sina list retry", node, page, attempt, str(exc)[:60], file=sys.stderr)
                    time.sleep(0.8 * (attempt + 1))
            if rows is None:
                print("sina list failed", node, page, file=sys.stderr)
                continue
            for r in rows or []:
                code = str(r.get("code") or "")
                if not code or code in seen:
                    continue
                seen.add(code)
                mc, fmc = num(r.get("mktcap")), num(r.get("nmc"))
                out.append({
                    "code": code,
                    "name": (r.get("name") or "").replace(" ", "").strip() or code,
                    "industry": "",
                    "price": num(r.get("trade")),
                    "pct": num(r.get("changepercent")),
                    "turnover": num(r.get("turnoverratio")),
                    "pe": num(r.get("per")),
                    "pb": num(r.get("pb")),
                    "mcap": mc * 10000 if mc else None,
                    "float_mcap": fmc * 10000 if fmc else None,
                })
            time.sleep(0.05)
    return out, total or len(out)


def fetch_stock_list():
    try:
        rows, total = fetch_list_em()
        print("      list: eastmoney", len(rows), file=sys.stderr)
        return rows, total
    except Exception as exc:  # noqa: BLE001
        print("      eastmoney list blocked:", str(exc)[:80], "-> sina", file=sys.stderr)
    rows, total = fetch_list_sina()
    print("      list: sina", len(rows), "count", total, file=sys.stderr)
    return rows, total


def load_industry_cache():
    try:
        with open(os.path.join(DATA_DIR, "industry_cache.json"), encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return {}


def save_industry_cache(cache):
    try:
        atomic_write_json(os.path.join(DATA_DIR, "industry_cache.json"), cache)
    except OSError:
        pass


def emweb_industry(code):
    if code[0] == "6" or (code[0] == "9" and not code.startswith("92")):
        sym = "SH" + code
    elif code[0] in "03":
        sym = "SZ" + code
    else:
        sym = "BJ" + code
    txt = http_text(EMWEB_INDUSTRY_URL.format(sym=sym), EMWEB_UA, timeout=15)
    d = json.loads(txt)
    for b in (d.get("ssbk") or []):
        name = (b.get("BOARD_NAME") or "").strip()
        if name:
            return name
    return ""


def fill_industry(stocks, workers=6):
    cache = load_industry_cache()
    for s in stocks:
        if s["code"] in cache:
            s["industry"] = cache[s["code"]]
    missing = [s for s in stocks if not s.get("industry")]
    print(f"      industry cache {len(stocks)-len(missing)}/{len(stocks)}, fetch {len(missing)}", file=sys.stderr)
    if not missing:
        return
    done, ok = 0, 0
    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        for code, name in ex.map(lambda s: (s["code"], _safe_industry(s["code"])), missing):
            done += 1
            if name:
                cache[code] = name
                ok += 1
            if done % 200 == 0:
                save_industry_cache(cache)
                write_status(state="running", phase="industry", done=done, total=len(missing))
                print(f"      industry {done}/{len(missing)}", file=sys.stderr)
    save_industry_cache(cache)
    for s in stocks:
        if not s.get("industry") and cache.get(s["code"]):
            s["industry"] = cache[s["code"]]


def load_board_cache():
    try:
        with open(os.path.join(DATA_DIR, "board_cache.json"), encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return {}


def save_board_cache(cache):
    try:
        atomic_write_json(os.path.join(DATA_DIR, "board_cache.json"), cache)
    except OSError:
        pass


def emweb_boards(code):
    if code[0] == "6" or (code[0] == "9" and not code.startswith("92")):
        sym = "SH" + code
    elif code[0] in "03":
        sym = "SZ" + code
    else:
        sym = "BJ" + code
    txt = http_text(EMWEB_INDUSTRY_URL.format(sym=sym), EMWEB_UA, timeout=15)
    d = json.loads(txt)
    out = []
    for b in (d.get("ssbk") or []):
        name = (b.get("BOARD_NAME") or "").strip()
        if name and name not in out:
            out.append(name)
    return out


def _safe_boards(code):
    try:
        return emweb_boards(code)
    except Exception:  # noqa: BLE001
        return []


def fill_boards(stocks, workers=8):
    cache = load_board_cache()
    for s in stocks:
        s["boards"] = list(cache.get(s["code"]) or [])
    missing = [s for s in stocks if s["code"] not in cache]
    print(f"      board cache {len(stocks)-len(missing)}/{len(stocks)}, fetch {len(missing)}", file=sys.stderr)
    if not missing:
        return
    done = 0
    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        for code, names in ex.map(lambda s: (s["code"], _safe_boards(s["code"])), missing):
            done += 1
            if names:
                cache[code] = names
            if done % 200 == 0:
                save_board_cache(cache)
                write_status(state="running", phase="boards", done=done, total=len(missing),
                             started_at=now_iso())
                print(f"      boards {done}/{len(missing)}", file=sys.stderr)
    save_board_cache(cache)
    for s in stocks:
        if not s.get("boards"):
            s["boards"] = list(cache.get(s["code"]) or [])


def _safe_industry(code):
    try:
        return emweb_industry(code)
    except Exception:  # noqa: BLE001
        return ""


def num(v):
    try:
        if v in (None, "", "-", "—"):
            return None
        return float(v)
    except (TypeError, ValueError):
        return None


_XQ = {"opener": None, "lock": threading.Lock()}


def xq_opener():
    with _XQ["lock"]:
        if _XQ["opener"] is None:
            cj = http.cookiejar.CookieJar()
            op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
            op.open(urllib.request.Request("https://xueqiu.com/", headers=TENCENT_UA), timeout=15).read()
            _XQ["opener"] = op
        return _XQ["opener"]


def xq_symbol(code):
    if code[0] in "69":
        return "SH" + code
    if code[0] in "03":
        return "SZ" + code
    return "BJ" + code


def fetch_kline_xq(code):
    op = xq_opener()
    url = XQ_KLINE_URL.format(sym=xq_symbol(code), begin=int(time.time() * 1000))
    req = urllib.request.Request(url, headers={**TENCENT_UA, "Referer": "https://xueqiu.com/"})
    with op.open(req, timeout=20) as resp:
        data = json.loads(resp.read().decode("utf-8", "replace"))
    item = ((data.get("data") or {}).get("item") or [])
    if not item:
        raise ValueError("empty xq kline")
    tz = dt.timezone(dt.timedelta(hours=8))
    bars = []
    for r in item:
        try:
            day = dt.datetime.fromtimestamp(r[0] / 1000.0, tz).strftime("%Y-%m-%d")
            bars.append((day, float(r[2]), float(r[5]), float(r[3]), float(r[4]), float(r[1])))
        except (TypeError, ValueError, IndexError):
            continue
    if not bars:
        raise ValueError("unparsable xq kline")
    bars.sort(key=lambda x: x[0])
    return bars


def fetch_kline_sina(code):
    sym = market_symbol(code)
    txt = http_text(SINA_KLINE_URL.format(sym=sym), SINA_UA, timeout=20)
    rows = json.loads(txt)
    bars = []
    for r in rows or []:
        try:
            bars.append((str(r["day"]), float(r["open"]), float(r["close"]),
                         float(r["high"]), float(r["low"]), float(r["volume"])))
        except (KeyError, TypeError, ValueError):
            continue
    if not bars:
        raise ValueError("empty sina kline")
    bars.sort(key=lambda x: x[0])
    return bars


def fetch_kline_tencent(code):
    sym = market_symbol(code)
    data = http_json(KLINE_URL.format(host=KLINE_HOSTS[0], sym=sym, n=320), TENCENT_UA, timeout=25)
    node = (data.get("data") or {}).get(sym) or {}
    rows = node.get("qfqday") or node.get("day") or []
    if not rows:
        raise ValueError("empty tencent kline")
    bars = []
    for r in rows:
        if len(r) < 6:
            continue
        try:
            bars.append((str(r[0]), float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5])))
        except (TypeError, ValueError):
            continue
    if not bars:
        raise ValueError("unparsable tencent kline")
    bars.sort(key=lambda x: x[0])
    return bars


def fetch_kline(stock):
    code = stock["code"]
    errs = []
    for name, fn in (("xq", fetch_kline_xq), ("sina", fetch_kline_sina), ("tencent", fetch_kline_tencent)):
        try:
            return fn(code)
        except Exception as exc:  # noqa: BLE001
            errs.append(f"{name}:{type(exc).__name__}")
    raise RuntimeError(",".join(errs))


def ema(values, span):
    k = 2.0 / (span + 1.0)
    out = []
    prev = None
    for v in values:
        prev = v if prev is None else v * k + prev * (1 - k)
        out.append(prev)
    return out


def rsi(closes, span=14):
    if len(closes) <= span + 1:
        return None
    gains = losses = 0.0
    for i in range(-span, 0):
        ch = closes[i] - closes[i - 1]
        if ch >= 0:
            gains += ch
        else:
            losses -= ch
    avg_gain, avg_loss = gains / span, losses / span
    if avg_loss == 0:
        return 100.0
    return round(100 - 100 / (1 + avg_gain / avg_loss), 1)


def tech_fields(r):
    return {"ma_state": r.get("ma_state"), "macd_zone": r.get("macd_zone"),
            "rsi14": r.get("rsi14"), "golden_cross": r.get("golden_cross"),
            "ma20_dist": r.get("ma20_dist")}


def dc_rows(report, filter_expr="", sort_col="", sort_type=-1, max_pages=200):
    """东财 datacenter 通用分页读取。"""
    rows, pn = [], 1
    while pn <= max_pages:
        flt = ("&filter=" + urllib.parse.quote(filter_expr)) if filter_expr else ""
        url = DATACENTER_URL.format(rn=report, pn=pn, sc=sort_col, st=sort_type, flt=flt)
        try:
            d = http_json(url, DC_UA, timeout=25)
        except Exception:  # noqa: BLE001
            break
        res = d.get("result") or {}
        data = res.get("data") or []
        rows.extend(data)
        pages = res.get("pages") or 0
        if not data or pn >= pages:
            break
        pn += 1
        time.sleep(0.04)
    return rows


def fetch_valuation(as_of):
    """当日全市场 PE(TTM) / PB(MRQ) 快照。"""
    rows = dc_rows("RPT_VALUEANALYSIS_DET", f"(TRADE_DATE='{as_of}')", "SECURITY_CODE", 1)
    out = {}
    for r in rows:
        code = r.get("SECURITY_CODE")
        if not code:
            continue
        out[code] = {"pe": num(r.get("PE_TTM")), "pb": num(r.get("PB_MRQ")),
                     "board": r.get("BOARD_NAME")}
    return out


def fetch_lhb(as_of):
    """当日龙虎榜。"""
    rows = dc_rows("RPT_DAILYBILLBOARD_DETAILSNEW", f"(TRADE_DATE='{as_of}')",
                   "BILLBOARD_NET_AMT", -1)
    out = []
    for r in rows:
        code = r.get("SECURITY_CODE")
        if not code:
            continue
        out.append({
            "code": code, "name": r.get("SECURITY_NAME_ABBR"),
            "pct": num(r.get("CHANGE_RATE")), "turnover": num(r.get("TURNOVERRATE")),
            "reason": r.get("EXPLANATION"), "explain": r.get("EXPLAIN"),
            "buy": num(r.get("BILLBOARD_BUY_AMT")), "sell": num(r.get("BILLBOARD_SELL_AMT")),
            "net": num(r.get("BILLBOARD_NET_AMT")),
            "net_ratio": num(r.get("DEAL_NET_RATIO")), "deal_ratio": num(r.get("DEAL_AMOUNT_RATIO")),
            "amount": num(r.get("ACCUM_AMOUNT")),
            "seat_buy": r.get("BUY_SEAT"), "seat_sell": r.get("SELL_SEAT"),
        })
    return out


def fetch_lhb_seats(as_of):
    """当日龙虎榜买卖席位，按股票聚合。"""
    rows = dc_rows("RPT_BILLBOARD_DAILYDETAILSBUY", f"(TRADE_DATE='{as_of}')",
                   "TRADE_DATE", -1, max_pages=80)
    per = {}
    for r in rows:
        code = r.get("SECURITY_CODE")
        name = r.get("OPERATEDEPT_NAME") or ""
        if not code or not name:
            continue
        per.setdefault(code, []).append({
            "name": name,
            "buy": num(r.get("BUY")), "sell": num(r.get("SELL")), "net": num(r.get("NET")),
            "inst": "机构专用" in name,
        })
    for seats in per.values():
        seats.sort(key=lambda x: -(x.get("net") or 0))
    return per


def fetch_dividends(days=370):
    """近 N 天已实施/预案的分红，折算每股分红。"""
    start = (shanghai_now().date() - dt.timedelta(days=days)).isoformat()
    rows = dc_rows("RPT_SHAREBONUS_DET", f"(EX_DIVIDEND_DATE>='{start}')",
                   "EX_DIVIDEND_DATE", -1, max_pages=80)
    dps, times = {}, {}
    for r in rows:
        code = r.get("SECURITY_CODE")
        amt = num(r.get("PRETAX_BONUS_RMB"))
        if not code or not amt:
            continue
        dps[code] = dps.get(code, 0.0) + amt / 10.0
        times[code] = times.get(code, 0) + 1
    return dps, times


def fetch_long_bars(code):
    """新浪 1300 根日线（不复权），用于 5 年分位。"""
    sym = market_symbol(code)
    txt = http_text(SINA_KLINE_LONG_URL.format(sym=sym, n=1300), SINA_UA, timeout=25)
    rows = json.loads(txt)
    bars = []
    for r in rows or []:
        try:
            bars.append((str(r["day"]), float(r["open"]), float(r["close"]),
                         float(r["high"]), float(r["low"]), float(r["volume"])))
        except (KeyError, TypeError, ValueError):
            continue
    bars.sort(key=lambda x: x[0])
    return bars


def pct_rank(window, value):
    if not window or value is None:
        return None
    return round(sum(1 for c in window if c <= value) / len(window), 4)


def long_metrics(bars):
    closes = [b[2] for b in bars]
    n = len(closes)
    if n < 60:
        return None
    last = closes[-1]
    pos1250 = pct_rank(closes[-min(n, 1250):], last)
    rets = []
    for i in range(max(1, n - 250), n):
        if closes[i - 1] > 0:
            rets.append(closes[i] / closes[i - 1] - 1)
    vol = None
    if len(rets) > 20:
        mean = sum(rets) / len(rets)
        var = sum((x - mean) ** 2 for x in rets) / (len(rets) - 1)
        vol = round((var ** 0.5) * (252 ** 0.5), 4)
    return {"pos1250": pos1250, "vol250": vol,
            "pct250": round(last / closes[-251] - 1, 4) if n >= 251 else None}


def stage_of(pos250, pos1250):
    if pos250 is None or pos1250 is None:
        return "—"
    if pos1250 <= 0.35 and pos250 <= 0.35:
        return "底部"
    if pos1250 >= 0.70 and pos250 >= 0.70:
        return "顶部"
    if pos1250 <= 0.55 and pos250 > pos1250 + 0.08:
        return "上行"
    if pos1250 >= 0.45 and pos250 < pos1250 - 0.08:
        return "下行"
    return "震荡"


def median(vals):
    vals = sorted(v for v in vals if v is not None)
    if not vals:
        return None
    k = len(vals) // 2
    return round(vals[k] if len(vals) % 2 else (vals[k - 1] + vals[k]) / 2, 4)


def analyze(stock, bars):
    closes = [b[2] for b in bars]
    highs = [b[3] for b in bars]
    lows = [b[4] for b in bars]
    n = len(closes)
    rec = {"code": stock["code"], "name": stock["name"], "industry": stock["industry"],
           "price": closes[-1], "pct": stock.get("pct"), "last_date": bars[-1][0]}
    if n < 60:
        rec["note"] = "次新"
        return rec
    e12, e26 = ema(closes, 12), ema(closes, 26)
    dif = [a - b for a, b in zip(e12, e26)]
    dea = ema(dif, 9)
    d, e = dif[-1], dea[-1]
    d_prev, e_prev = dif[-2], dea[-2]
    cross = d > e and d_prev <= e_prev
    rec["dif"] = round(d, 4)
    rec["dea"] = round(e, 4)
    rec["golden_cross"] = bool(cross)
    if cross:
        rec["cross_zone"] = "above" if (d > 0 and e > 0) else ("below" if (d < 0 and e < 0) else "zero")
    rec["pct5"] = round(closes[-1] / closes[-6] - 1, 4) if n >= 6 else None
    rec["pct20"] = round(closes[-1] / closes[-21] - 1, 4) if n >= 21 else None
    win = min(n, 5)
    if min(lows[-win:]) > 0:
        rec["amp5"] = round((max(highs[-win:]) - min(lows[-win:])) / min(lows[-win:]), 4)
    window = closes[-min(n, 250):]
    rec["pos250"] = round(sum(1 for c in window if c <= closes[-1]) / len(window), 4) if window else None
    # 技术指标快照：均线排列 / MACD 区域 / RSI / 到 MA20 距离
    ma5 = sum(closes[-5:]) / 5
    ma10 = sum(closes[-10:]) / 10
    ma20 = sum(closes[-20:]) / 20
    ma60 = sum(closes[-60:]) / 60
    rec["ma5"], rec["ma10"], rec["ma20"], rec["ma60"] = [round(x, 3) for x in (ma5, ma10, ma20, ma60)]
    rec["ma_state"] = "多头" if ma5 > ma10 > ma20 else ("空头" if ma5 < ma10 < ma20 else "纠缠")
    rec["ma20_dist"] = round(closes[-1] / ma20 - 1, 4)
    ma20_prev = sum(closes[-25:-5]) / 20
    rec["ma20_slope"] = round(ma20 / ma20_prev - 1, 4) if ma20_prev else None
    vols = [b[5] for b in bars]
    avg_vol20 = sum(vols[-21:-1]) / 20 if len(vols) >= 21 else None
    rec["vol_ratio"] = round(vols[-1] / avg_vol20, 2) if avg_vol20 else None
    rec["pct60"] = round(closes[-1] / closes[-61] - 1, 4) if n >= 61 else None
    rec["macd_zone"] = "水上" if (d > 0 and e > 0) else ("水下" if (d < 0 and e < 0) else "零轴")
    rec["death_cross"] = bool(d < e and d_prev >= e_prev)
    rec["rsi14"] = rsi(closes)
    return rec


def signals_of(rec):
    out = []
    if rec.get("golden_cross"):
        if rec.get("cross_zone") == "above":
            out.append("golden_above")
        elif rec.get("cross_zone") == "below":
            out.append("golden_below")
    p5, p20, pos = rec.get("pct5"), rec.get("pct20"), rec.get("pos250")
    if p5 is not None and p5 >= 0.10:
        out.append("surge")
    if p5 is not None and p5 <= -0.10:
        out.append("plunge")
    if (p20 is not None and p5 is not None and rec.get("amp5") is not None
            and p20 <= -0.12 and rec["amp5"] <= 0.06 and abs(p5) <= 0.03):
        out.append("plunge_flat")
    if pos is not None:
        if pos <= 0.10:
            out.append("cycle_low")
        elif pos >= 0.90:
            out.append("cycle_high")
    return out


def latest_trading_date():
    now = shanghai_now()
    day = now.date()
    # 收盘 15:00 前按上一交易日；周末回退到周五
    if now.hour < 15:
        day -= dt.timedelta(days=1)
    while day.weekday() >= 5:
        day -= dt.timedelta(days=1)
    return day.isoformat()



def etf_category(name):
    for cat, words in ETF_CATEGORIES:
        for w in words:
            if w in name:
                return cat
    return "主题"


def fetch_etf_list():
    rows, page = [], 1
    while page <= 12:
        txt = http_text(SINA_ETF_LIST_URL.format(page=page), SINA_UA, timeout=20, retries=2)
        try:
            batch = json.loads(txt)
        except json.JSONDecodeError:
            break
        if not batch:
            break
        rows += batch
        if len(batch) < 100:
            break
        page += 1
    out = []
    for r in rows:
        sym = str(r.get("symbol") or "")
        code = str(r.get("code") or "")
        name = str(r.get("name") or "")
        if not sym or not code or not name:
            continue
        if not (sym.startswith("sh") or sym.startswith("sz")):
            continue
        try:
            price = float(r.get("trade") or 0)
        except (TypeError, ValueError):
            price = 0.0
        try:
            pct = float(r.get("changepercent") or 0)
        except (TypeError, ValueError):
            pct = 0.0
        try:
            amount = float(r.get("amount") or 0)
        except (TypeError, ValueError):
            amount = 0.0
        out.append({"symbol": sym, "code": code, "name": name, "cat": etf_category(name),
                    "price": price, "pct": round(pct, 2), "amount": amount})
    return out


def etf_metrics(etf):
    bars = fetch_kline_sina(etf["code"])
    if not bars or len(bars) < 25:
        return etf
    closes = [b[2] for b in bars]
    etf["last_date"] = bars[-1][0]
    if len(closes) >= 6 and closes[-6]:
        etf["pct5"] = round(closes[-1] / closes[-6] - 1, 4)
    if len(closes) >= 21 and closes[-21]:
        etf["pct20"] = round(closes[-1] / closes[-21] - 1, 4)
    window = closes[-250:]
    etf["pos250"] = round(sum(1 for c in window if c <= closes[-1]) / len(window), 4)
    return etf


def build_etf(as_of, limit=0, workers=8):
    rows = fetch_etf_list()
    if limit:
        rows = rows[:limit]
    done = 0
    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(_safe_etf_metrics, e) for e in rows]
        for fut in futs:
            fut.result()
            done += 1
            if done % 200 == 0:
                write_status(state="running", phase="etf", done=done, total=len(rows), started_at=now_iso())
                print(f"      etf {done}/{len(rows)}", file=sys.stderr)
    cats = {}
    for e in rows:
        cats.setdefault(e["cat"], 0)
        cats[e["cat"]] += 1
    return {"as_of": as_of, "generated_at": now_iso(), "total": len(rows),
            "categories": [{"id": k, "name": k, "count": v} for k, v in cats.items()],
            "rows": rows}


def _safe_etf_metrics(e):
    try:
        return etf_metrics(e)
    except Exception:  # noqa: BLE001
        return e


def board_bucket(name, rows):
    b = {"name": name, "count": len(rows), "up": 0, "down": 0, "flat": 0,
         "limit_up": 0, "limit_down": 0, "signals": {k: 0 for k in SIGNAL_KEYS},
         "lists": {k: [] for k in SIGNAL_KEYS}}
    vals = []
    for r in rows:
        p = r.get("pct")
        if p is not None:
            vals.append(p)
            b["up" if p > 0 else ("down" if p < 0 else "flat")] += 1
            lim = board_limit(r["code"])
            if p >= lim:
                b["limit_up"] += 1
            elif p <= -lim:
                b["limit_down"] += 1
        for k in signals_of(r):
            b["signals"][k] += 1
            b["lists"][k].append({"code": r["code"], "name": r["name"], "pct": p,
                                  "pct5": r.get("pct5"), "pct20": r.get("pct20"),
                                  "pos250": r.get("pos250"), **tech_fields(r)})
    b["avg_pct"] = round(sum(vals) / len(vals), 2) if vals else None
    for k in SIGNAL_KEYS:
        b["lists"][k].sort(key=lambda x: (x.get("pct") is None, -(x.get("pct") or 0)))
    return b


def build_boards(records, stocks):
    by_code = {r["code"]: r for r in records}
    industry_names = {s.get("industry") for s in stocks if s.get("industry")}
    groups = {}
    for s in stocks:
        r = by_code.get(s["code"])
        if not r:
            continue
        for name in s.get("boards") or []:
            if not name or BOARD_NOISE.search(name) or name in industry_names:
                continue
            groups.setdefault(name, []).append(r)
    concept = []
    for name, rows in groups.items():
        if len(rows) < BOARD_MIN_SIZE:
            continue
        if "概念" not in name and name not in CONCEPT_EXTRA:
            continue
        b = board_bucket(name, rows)
        b["kind"] = "concept"
        concept.append(b)
    concept.sort(key=lambda x: (-x["count"], x["name"]))
    return {"concept": concept}


def build_search(stocks, etf_rows, as_of, boards=None):
    rows = []
    for s in stocks:
        tags = [t for t in (s.get("boards") or []) if not BOARD_NOISE.search(t)]
        rows.append({"code": s["code"], "name": s.get("name") or s["code"],
                     "type": "stock", "industry": s.get("industry") or "未分类",
                     "tags": " ".join(tags[:14])})
    seen = set()
    for e in etf_rows:
        if e["code"] in seen:
            continue
        seen.add(e["code"])
        rows.append({"code": e["code"], "symbol": e["symbol"], "name": e["name"],
                     "type": "etf", "industry": e["cat"]})
    if boards:
        for b in boards.get("concept") or []:
            rows.append({"code": "board:" + b["name"], "name": b["name"],
                         "type": "board", "industry": "概念"})
    return {"as_of": as_of, "total": len(rows), "rows": rows}


def main():
    global DATA_DIR
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--workers", type=int, default=10)
    ap.add_argument("--out", default=DATA_DIR)
    ap.add_argument("--if-fresh", action="store_true")
    ap.add_argument("--etfs-only", action="store_true")
    args = ap.parse_args()

    out_dir = os.path.expanduser(args.out)
    DATA_DIR = out_dir
    os.makedirs(out_dir, exist_ok=True)
    dash_path = os.path.join(out_dir, "dashboard.json")

    if args.if_fresh and os.path.exists(dash_path):
        try:
            with open(dash_path, encoding="utf-8") as f:
                old = json.load(f)
            if old.get("as_of") == latest_trading_date():
                print("fresh, skip:", old.get("as_of"))
                return 0
        except Exception:  # noqa: BLE001
            pass

    started = time.time()
    if args.etfs_only:
        etf_path = os.path.join(out_dir, "etf.json")
        stocks, _total = fetch_stock_list()
        etf = build_etf(latest_trading_date(), limit=args.limit, workers=8)
        atomic_write_json(etf_path, etf)
        atomic_write_json(os.path.join(out_dir, "search.json"),
                          build_search(stocks, etf["rows"], etf["as_of"]))
        print(f"etf done: {etf['total']} 只 / {len(etf['categories'])} 类", file=sys.stderr)
        return 0
    write_status(state="running", phase="list", done=0, total=0, started_at=now_iso())
    print("[1/8] 拉股票列表 ...", file=sys.stderr)
    stocks, total = fetch_stock_list()
    if args.limit:
        stocks = stocks[:args.limit]
    print(f"      {len(stocks)} 只（接口 total={total}）", file=sys.stderr)

    write_status(state="running", phase="industry", done=0, total=len(stocks), started_at=now_iso())
    print("[2/8] 补齐行业分类 ...", file=sys.stderr)
    fill_industry(stocks)
    for s in stocks:
        s["industry"] = (s.get("industry") or "").strip() or "未分类"

    write_status(state="running", phase="boards", done=0, total=len(stocks), started_at=now_iso())
    print("[3/8] 补齐概念板块归属 ...", file=sys.stderr)
    fill_boards(stocks)

    write_status(state="running", phase="kline", done=0, total=len(stocks), started_at=now_iso())
    print("[4/8] 拉日线并算指标 ...", file=sys.stderr)
    records, fails = [], []

    def work(s):
        try:
            return s, fetch_kline(s), None
        except Exception as exc:  # noqa: BLE001
            return s, None, str(exc)[:120]

    done = 0
    with cf.ThreadPoolExecutor(max_workers=args.workers) as ex:
        for stock, bars, err in ex.map(work, stocks):
            done += 1
            if bars:
                records.append(analyze(stock, bars))
            else:
                fails.append({"code": stock["code"], "name": stock["name"], "error": err})
                records.append({"code": stock["code"], "name": stock["name"],
                                "industry": stock["industry"], "price": stock.get("price"),
                                "pct": stock.get("pct"), "note": "无k线"})
            if done % 300 == 0 or done == len(stocks):
                write_status(state="running", phase="kline", done=done, total=len(stocks),
                             started_at=now_iso())
                print(f"      {done}/{len(stocks)}", file=sys.stderr)

    date_counts = {}
    for r in records:
        d = r.get("last_date")
        if d:
            date_counts[d] = date_counts.get(d, 0) + 1
    as_of = max(date_counts, key=date_counts.get) if date_counts else latest_trading_date()
    boards = build_boards(records, stocks)
    print(f"      boards {len(boards['concept'])} 概念",
          file=sys.stderr)

    # ---- 主题周期成员（申万行业 + 概念板块并集） ----
    board_cache = load_board_cache()
    stock_codes = {s["code"] for s in stocks}
    theme_members = {}
    for spec in THEMES:
        if spec.get("kind") == "index":
            theme_members[spec["name"]] = set()
            continue
        if spec.get("sector"):
            codes = {s["code"] for s in stocks if (s.get("industry") or "") == spec["sector"]}
        else:
            names = set(spec.get("boards") or [])
            codes = {code for code, arr in board_cache.items() if names.intersection(arr or [])}
        theme_members[spec["name"]] = codes & stock_codes
    theme_codes = set().union(*theme_members.values()) if theme_members else set()
    print(f"      themes {len(THEMES)} / 成分 {len(theme_codes)}", file=sys.stderr)

    # ---- [4/6] 周期行业 5 年长线 ----
    cyclic = [s for s in stocks if (s.get("industry") or "") in CYCLIC_SECTORS]
    long_targets = {s["code"]: s for s in cyclic}
    for s in stocks:
        if s["code"] in theme_codes:
            long_targets.setdefault(s["code"], s)
    long_targets = list(long_targets.values())
    long_map, long_fails = {}, []
    if long_targets:
        write_status(state="running", phase="cycle", done=0, total=len(long_targets), started_at=now_iso())
        print(f"[5/8] 周期行业 5 年日线（{len(long_targets)} 只）...", file=sys.stderr)
        cdone = 0

        def work_long(s):
            try:
                return s["code"], fetch_long_bars(s["code"]), None
            except Exception as exc:  # noqa: BLE001
                return s["code"], None, str(exc)[:100]

        with cf.ThreadPoolExecutor(max_workers=args.workers) as ex:
            for code, bars, err in ex.map(work_long, long_targets):
                cdone += 1
                if bars:
                    m = long_metrics(bars)
                    if m:
                        long_map[code] = m
                    else:
                        long_fails.append({"code": code, "error": "bars<60"})
                else:
                    long_fails.append({"code": code, "error": err})
                if cdone % 200 == 0 or cdone == len(long_targets):
                    write_status(state="running", phase="cycle", done=cdone, total=len(long_targets),
                                 started_at=now_iso())
                    print(f"      cycle {cdone}/{len(long_targets)}", file=sys.stderr)

    # ---- [5/6] 估值 / 龙虎榜 / 分红 ----
    write_status(state="running", phase="funds", done=0, total=1, started_at=now_iso())
    print(f"[6/8] 估值 / 龙虎榜 / 分红（as_of={as_of}）...", file=sys.stderr)
    funds = {"valuation": {}, "lhb": [], "seats": {}, "dps": {}, "div_times": {},
             "long_fails": long_fails}
    try:
        funds["valuation"] = fetch_valuation(as_of)
        print(f"      valuation {len(funds['valuation'])}", file=sys.stderr)
    except Exception as exc:  # noqa: BLE001
        print("      valuation failed:", str(exc)[:100], file=sys.stderr)
    try:
        funds["lhb"] = fetch_lhb(as_of)
        funds["seats"] = fetch_lhb_seats(as_of)
        print(f"      lhb {len(funds['lhb'])} / seats {sum(len(v) for v in funds['seats'].values())}",
              file=sys.stderr)
    except Exception as exc:  # noqa: BLE001
        print("      lhb failed:", str(exc)[:100], file=sys.stderr)
    try:
        funds["dps"], funds["div_times"] = fetch_dividends()
        print(f"      dividend {len(funds['dps'])}", file=sys.stderr)
    except Exception as exc:  # noqa: BLE001
        print("      dividend failed:", str(exc)[:100], file=sys.stderr)

    # ---- [6/7] ETF ----
    write_status(state="running", phase="etf", done=0, total=1, started_at=now_iso())
    print("[7/8] ETF 列表与日线 ...", file=sys.stderr)
    etf = {"as_of": as_of, "generated_at": now_iso(), "total": 0, "categories": [], "rows": []}
    try:
        etf = build_etf(as_of, limit=args.limit if args.limit else 0, workers=8)
        atomic_write_json(os.path.join(out_dir, "etf.json"), etf)
        atomic_write_json(os.path.join(out_dir, "search.json"),
                          build_search(stocks, etf["rows"], as_of, boards))
        print(f"      etf {etf['total']} 只 / {len(etf['categories'])} 类", file=sys.stderr)
    except Exception as exc:  # noqa: BLE001
        print("      etf failed:", str(exc)[:120], file=sys.stderr)

    write_status(state="running", phase="aggregate", done=len(stocks), total=len(stocks),
                 started_at=now_iso())
    print("[8/8] 汇总板块 ...", file=sys.stderr)
    payload = aggregate(stocks, records, started, fails, long_map, funds, as_of, boards, theme_members)
    atomic_write_json(dash_path, payload)
    write_status(state="done", phase="done", done=len(stocks), total=len(stocks),
                 as_of=payload["as_of"], elapsed=round(time.time() - started, 1), started_at=now_iso())
    print(f"done: {payload['as_of']} {payload['total']} 只 / {len(payload['sectors'])} 板块, "
          f"{round(time.time() - started, 1)}s", file=sys.stderr)
    return 0


def aggregate(stocks, records, started, fails, long_map=None, funds=None, as_of=None, boards=None,
              theme_members=None):
    funds = funds or {}
    long_map = long_map or {}
    theme_members = theme_members or {}
    val = funds.get("valuation") or {}
    stock_by = {s["code"]: s for s in stocks}

    def valuation_of(code):
        v = val.get(code) or {}
        st = stock_by.get(code) or {}
        pe = v.get("pe") if v.get("pe") is not None else st.get("pe")
        pb = v.get("pb") if v.get("pb") is not None else st.get("pb")
        if pe is not None and not (0 < pe < 1000):
            pe = None
        if pb is not None and not (0 < pb < 100):
            pb = None
        return pe, pb

    by_code = {r["code"]: r for r in records}
    groups = {}
    for s in stocks:
        r = by_code.get(s["code"], {"code": s["code"], "name": s["name"], "industry": s["industry"],
                                    "price": s.get("price"), "pct": s.get("pct")})
        groups.setdefault(r.get("industry") or "其他", []).append(r)

    market = {"total": len(records), "up": 0, "down": 0, "flat": 0, "limit_up": 0, "limit_down": 0}
    sig_counts = {k: 0 for k in SIGNAL_KEYS}
    pcts = []
    for r in records:
        p = r.get("pct")
        if p is None:
            continue
        pcts.append(p)
        if p > 0:
            market["up"] += 1
        elif p < 0:
            market["down"] += 1
        else:
            market["flat"] += 1
        lim = board_limit(r["code"])
        if p >= lim:
            market["limit_up"] += 1
        elif p <= -lim:
            market["limit_down"] += 1
        for k in signals_of(r):
            sig_counts[k] += 1
    pcts.sort()
    market["avg_pct"] = round(sum(pcts) / len(pcts), 2) if pcts else None
    market["median_pct"] = round(pcts[len(pcts) // 2], 2) if pcts else None
    market["signal_counts"] = sig_counts
    market["tech"] = {
        "ma_bull": sum(1 for r in records if r.get("ma_state") == "多头"),
        "ma_bear": sum(1 for r in records if r.get("ma_state") == "空头"),
        "macd_above": sum(1 for r in records if r.get("macd_zone") == "水上"),
        "macd_below": sum(1 for r in records if r.get("macd_zone") == "水下"),
        "rsi_over": sum(1 for r in records if (r.get("rsi14") or 0) >= 70),
        "rsi_under": sum(1 for r in records if (r.get("rsi14") or 100) <= 30),
        "golden_above": sig_counts.get("golden_above", 0),
        "golden_below": sig_counts.get("golden_below", 0),
    }

    stock_by = {s["code"]: s for s in stocks}

    def mcap_of(code):
        return (stock_by.get(code) or {}).get("mcap") or 0

    sectors = []
    for name, rows in groups.items():
        sec = {"name": name, "count": len(rows), "up": 0, "down": 0, "flat": 0,
               "limit_up": 0, "limit_down": 0, "signals": {k: 0 for k in SIGNAL_KEYS},
               "lists": {k: [] for k in SIGNAL_KEYS}}
        vals = []
        for r in rows:
            p = r.get("pct")
            if p is not None:
                vals.append(p)
                sec["up" if p > 0 else ("down" if p < 0 else "flat")] += 1
                lim = board_limit(r["code"])
                if p >= lim:
                    sec["limit_up"] += 1
                elif p <= -lim:
                    sec["limit_down"] += 1
            for k in signals_of(r):
                sec["signals"][k] += 1
                sec["lists"][k].append({
                    "code": r["code"], "name": r["name"], "pct": p,
                    "pct5": r.get("pct5"), "pct20": r.get("pct20"), "pos250": r.get("pos250"),
                    **tech_fields(r),
                })
        sec["avg_pct"] = round(sum(vals) / len(vals), 2) if vals else None
        for k in SIGNAL_KEYS:
            sec["lists"][k].sort(key=lambda x: (x.get("pct") is None, -(x.get("pct") or 0)))
        sectors.append(sec)
    sectors.sort(key=lambda s: (s["name"] in ("其他",), -s["count"], s["name"]))

    # ---------------- 板块周期 ----------------
    cyc = []
    for name in CYCLIC_SECTORS:
        rows = [r for r in records if (r.get("industry") or "") == name]
        pes, pbs = [], []
        for r in rows:
            pe, pb = valuation_of(r["code"])
            if pe is not None:
                pes.append(pe)
            if pb is not None:
                pbs.append(pb)
        pos250s = [r["pos250"] for r in rows if r.get("pos250") is not None]
        pos1250s = [long_map[r["code"]]["pos1250"] for r in rows
                    if long_map.get(r["code"], {}).get("pos1250") is not None]
        vols = [long_map[r["code"]]["vol250"] for r in rows
                if long_map.get(r["code"], {}).get("vol250") is not None]
        pos250_med, pos1250_med = median(pos250s), median(pos1250s)
        label, desc = CYCLE_META.get(name, ("—", ""))
        sec = {"name": name, "character": label, "desc": desc, "count": len(rows),
               "pe_median": median(pes), "pb_median": median(pbs),
               "pos250_med": pos250_med, "pos1250_med": pos1250_med,
               "stage": stage_of(pos250_med, pos1250_med),
               "vol_median": median(vols), "pe_pct_x": None, "stocks": []}
        for r in rows:
            code = r["code"]
            pe, pb = valuation_of(code)
            lm = long_map.get(code) or {}
            pe_pct = pct_rank(pes, pe) if pe is not None else None
            sec["stocks"].append({
                "code": code, "name": r.get("name"), "pe": pe, "pb": pb,
                "pe_pct_in": pe_pct,
                "pos250": r.get("pos250"), "pos1250": lm.get("pos1250"),
                "stage": stage_of(r.get("pos250"), lm.get("pos1250")),
                "pct5": r.get("pct5"), "pct20": r.get("pct20"), "pct": r.get("pct"),
                **tech_fields(r),
            })
        sec["stocks"].sort(key=lambda x: (x.get("pe_pct_in") is None, x.get("pe_pct_in") or 1))
        cyc.append(sec)
    meds = [s["pe_median"] for s in cyc if s["pe_median"] is not None]
    for s in cyc:
        s["pe_pct_x"] = pct_rank(meds, s["pe_median"]) if s["pe_median"] is not None else None
    cycle_block = {"sectors": cyc, "rules": STAGE_RULES,
                   "meta": {k: {"character": v[0], "desc": v[1]} for k, v in CYCLE_META.items()},
                   "long_fails": (funds.get("long_fails") or [])[:10], "long_count": len(long_map)}

    # ---------------- 龙虎榜 ----------------
    seats_all = funds.get("seats") or {}
    lhb_rows = []
    for row in (funds.get("lhb") or []):
        r = dict(row)
        r["seats"] = (seats_all.get(r["code"]) or [])[:12]
        lhb_rows.append(r)
    lhb_rows.sort(key=lambda x: -(x.get("net") or 0))
    lhb = {"date": as_of, "count": len(lhb_rows),
           "net_sum": round(sum(x.get("net") or 0 for x in lhb_rows), 2),
           "buy_sum": round(sum(x.get("buy") or 0 for x in lhb_rows), 2),
           "rows": lhb_rows}

    # ---------------- 游资（剔除机构专用席位） ----------------
    ystocks, seats_active = [], {}
    for row in lhb_rows:
        ss = row.get("seats") or []
        buy_y = sum(s.get("buy") or 0 for s in ss if not s.get("inst"))
        sell_y = sum(s.get("sell") or 0 for s in ss if not s.get("inst"))
        net_y = round(buy_y - sell_y, 2)
        inst_net = round(sum(s.get("net") or 0 for s in ss if s.get("inst")), 2)
        if net_y > 0:
            amount = row.get("amount")
            ystocks.append({
                "code": row["code"], "name": row.get("name"), "pct": row.get("pct"),
                "turnover": row.get("turnover"), "reason": row.get("reason"),
                "net": net_y, "buy": round(buy_y, 2), "inst_net": inst_net,
                "seat_count": sum(1 for s in ss if not s.get("inst")),
                "net_ratio": round(net_y / amount * 100, 2) if amount else None,
            })
        for s in ss:
            if s.get("inst"):
                continue
            a = seats_active.setdefault(s["name"], {"name": s["name"], "buy": 0.0,
                                                    "sell": 0.0, "codes": []})
            a["buy"] += s.get("buy") or 0
            a["sell"] += s.get("sell") or 0
            if row["code"] not in a["codes"]:
                a["codes"].append(row["code"])
    ystocks.sort(key=lambda x: -x["net"])
    act = sorted(seats_active.values(), key=lambda x: -x["buy"])[:20]
    for a in act:
        a["net"] = round(a["buy"] - a["sell"], 2)
        a["buy"], a["sell"] = round(a["buy"], 2), round(a["sell"], 2)
        a["stocks"] = len(a["codes"])
        a["codes"] = a["codes"][:3]
    youzi = {"stocks": ystocks, "seats": act, "count": len(ystocks)}

    # ---------------- 红利 ----------------
    dps, dtimes = funds.get("dps") or {}, funds.get("div_times") or {}
    div_rows = []
    for code, d in dps.items():
        r = by_code.get(code) or {}
        st = stock_by.get(code) or {}
        name = r.get("name") or st.get("name") or code
        price = r.get("price") or st.get("price")
        if not price or not d or d <= 0:
            continue
        if "ST" in name or "退" in name:
            continue
        mcap = st.get("mcap")
        if mcap is not None and mcap < 5e9:
            continue
        y = d / price
        if y < 0.03:
            continue
        pe, pb = valuation_of(code)
        industry = r.get("industry") or st.get("industry") or "未分类"
        div_rows.append({"code": code, "name": name, "industry": industry,
                         "yield": round(y, 4), "dps": round(d, 4), "price": price,
                         "pe": pe, "pb": pb, "pos250": r.get("pos250"),
                         "pct5": r.get("pct5"), "ma_state": r.get("ma_state"),
                         "rsi14": r.get("rsi14"), "times": dtimes.get(code, 1),
                         "cyclic": industry in CYCLIC_SECTORS})
    div_rows.sort(key=lambda x: -x["yield"])
    div_rows = div_rows[:120]
    dividend = {"count": len(div_rows), "median_yield": median([x["yield"] for x in div_rows]),
                "median_pe": median([x["pe"] for x in div_rows if x["pe"]]),
                "median_pb": median([x["pb"] for x in div_rows if x["pb"]]),
                "up": sum(1 for x in div_rows if (x.get("pct5") or 0) > 0),
                "down": sum(1 for x in div_rows if (x.get("pct5") or 0) < 0),
                "rows": div_rows}

    # ---------------- 市场情绪 / 决策候选 ----------------
    breadth = (market["up"] / (market["up"] + market["down"])) if (market["up"] + market["down"]) else 0.5
    lu, ld = market.get("limit_up") or 0, market.get("limit_down") or 0
    limit_ratio = lu / (lu + ld) if (lu + ld) else 0.5
    med = market.get("median_pct") or 0
    sent_score = 50 + (breadth - 0.5) * 80 + (limit_ratio - 0.5) * 20 + med * 3
    sent_score = max(0, min(100, round(sent_score)))
    sent_label = ("冰点" if sent_score < 20 else "偏冷" if sent_score < 40
                  else "中性" if sent_score < 60 else "偏热" if sent_score < 80 else "过热")
    sentiment = {
        "score": sent_score, "label": sent_label, "breadth": round(breadth, 3),
        "limit_ratio": round(limit_ratio, 3), "median_pct": med,
        "advice": ("防守，等确认" if sent_score < 40 else
                   "中性，按计划执行" if sent_score < 60 else "偏热，注意兑现"),
        "parts": {"up": market["up"], "down": market["down"], "limit_up": lu, "limit_down": ld},
    }

    # 龙头池：行业内市值前 40% 且市值 ≥ 50 亿；底部区 + 反转确认
    by_ind = {}
    for sr in records:
        by_ind.setdefault(sr.get("industry") or "未分类", []).append(sr)
    leader_codes = set()
    for ind, rows in by_ind.items():
        ranked = sorted(rows, key=lambda x: -(mcap_of(x["code"])))
        keep_n = max(1, int(len(ranked) * 0.4))
        for sr in ranked[:keep_n]:
            if mcap_of(sr["code"]) >= 5e9:
                leader_codes.add(sr["code"])

    leaders, risks = [], []
    for r in records:
        if r["code"] not in leader_codes:
            continue
        pos = r.get("pos250")
        if pos is None:
            continue
        base = {
            "code": r["code"], "name": r.get("name"), "industry": r.get("industry"),
            "mcap": mcap_of(r["code"]), "price": r.get("price"), "pct": r.get("pct"),
            "pct5": r.get("pct5"), "pct20": r.get("pct20"), "pct60": r.get("pct60"),
            "pos250": pos, "pos1250": (long_map.get(r["code"]) or {}).get("pos1250"),
            "ma_state": r.get("ma_state"), "ma20_dist": r.get("ma20_dist"),
            "ma20_slope": r.get("ma20_slope"), "macd_zone": r.get("macd_zone"),
            "rsi14": r.get("rsi14"), "vol_ratio": r.get("vol_ratio"),
            "golden_cross": r.get("golden_cross"), "death_cross": r.get("death_cross"),
        }
        # 底部反转：位置低 + 站上 MA20 + MA20 走平向上 + 量能放大 + MACD 不深水
        if (pos <= 0.40 and (r.get("ma20_slope") or 0) > 0
                and (r.get("ma20_dist") or -1) > 0
                and (r.get("vol_ratio") or 0) >= 1.1
                and (r.get("macd_zone") != "水下" or r.get("golden_cross"))):
            conf = 0
            conf += 1 if r.get("ma20_dist") > 0 else 0
            conf += 1 if (r.get("ma20_slope") or 0) > 0.005 else 0
            conf += 1 if r.get("macd_zone") == "水上" else 0
            conf += 1 if r.get("golden_cross") else 0
            conf += 1 if (r.get("vol_ratio") or 0) >= 1.3 else 0
            cand = dict(base)
            cand["score"] = conf * 10 + round((0.40 - pos) * 100, 1)
            cand["evidence"] = [
                f"1年分位 {round(pos * 100)}%" + (f"，5年分位 {round(cand['pos1250'] * 100)}%" if cand.get("pos1250") is not None else ""),
                ("站上 MA20" if r.get("ma20_dist") > 0 else "未站上 MA20") + f"，MA20 斜率 {round((r.get('ma20_slope') or 0) * 100, 1)}%",
                f"量比 {r.get('vol_ratio')}，MACD {r.get('macd_zone')}" + ("，金叉" if r.get("golden_cross") else ""),
            ]
            cand["trigger"] = "收盘站稳 MA20 且量能维持 1.2 倍以上 → 试仓"
            cand["invalid"] = "跌破近 20 日低点，或 MA20 重新拐头向下"
            leaders.append(cand)
        # 高位风险：位置高 + 超买或死叉
        if pos >= 0.75 and ((r.get("rsi14") or 0) >= 70 or r.get("death_cross")):
            rr = dict(base)
            rr["reason"] = "；".join([p for p in (("RSI 超买" if (r.get("rsi14") or 0) >= 70 else ""), ("MACD 死叉" if r.get("death_cross") else "")) if p])
            risks.append(rr)
    leaders.sort(key=lambda x: -x["score"])
    risks.sort(key=lambda x: -(x.get("pos250") or 0))
    leaders, risks = leaders[:15], risks[:15]

    decisions = {
        "sentiment": sentiment,
        "leaders": leaders,
        "risks": risks,
        "rules": {
            "leader_pool": "行业内市值前 40% 且 ≥ 50 亿",
            "bottom": "1 年价格分位 ≤ 40%",
            "reversal": "站上 MA20、MA20 斜率 > 0、量比 ≥ 1.1、MACD 不在水下或金叉",
            "risk": "1 年价格分位 ≥ 75%，且 RSI ≥ 70 或 MACD 死叉",
        },
    }

    # ---------------- 主题周期（相似周期分组） ----------------
    by_code = {r["code"]: r for r in records}
    themes = []
    for spec in THEMES:
        name = spec["name"]
        base = {"name": name, "group": spec.get("group"), "kind": spec.get("kind") or "stocks",
                "proxy": spec.get("proxy"), "character": spec.get("character"),
                "desc": spec.get("desc"), "boards": spec.get("boards") or [],
                "sector": spec.get("sector")}
        if base["kind"] == "index":
            base.update({"count": 0, "avg_pct": None, "up": 0, "down": 0, "flat": 0,
                         "limit_up": 0, "limit_down": 0, "pos250_med": None, "pos1250_med": None,
                         "pct5_med": None, "pe_median": None, "pb_median": None,
                         "vol_median": None, "pe_pct_x": None, "stage": None, "stocks": []})
            themes.append(base)
            continue
        codes = theme_members.get(name) or set()
        rows = [r for r in records if r["code"] in codes]
        pes, pbs = [], []
        for r in rows:
            pe, pb = valuation_of(r["code"])
            if pe is not None:
                pes.append(pe)
            if pb is not None:
                pbs.append(pb)
        pos250s = [r["pos250"] for r in rows if r.get("pos250") is not None]
        pos1250s = [long_map[r["code"]]["pos1250"] for r in rows
                    if long_map.get(r["code"], {}).get("pos1250") is not None]
        vols = [long_map[r["code"]]["vol250"] for r in rows
                if long_map.get(r["code"], {}).get("vol250") is not None]
        pct5s = [r["pct5"] for r in rows if r.get("pct5") is not None]
        pcts = [r["pct"] for r in rows if r.get("pct") is not None]
        pos250_med, pos1250_med = median(pos250s), median(pos1250s)
        stock_rows = []
        for r in rows:
            code = r["code"]
            pe, pb = valuation_of(code)
            lm = long_map.get(code) or {}
            stock_rows.append({
                "code": code, "name": r.get("name"), "price": r.get("price"),
                "pct": r.get("pct"), "pct5": r.get("pct5"), "pct20": r.get("pct20"),
                "pe": pe, "pb": pb, "mcap": (stock_by.get(code) or {}).get("mcap"),
                "pos250": r.get("pos250"), "pos1250": lm.get("pos1250"),
                "stage": stage_of(r.get("pos250"), lm.get("pos1250")),
                **tech_fields(r),
            })
        stock_rows.sort(key=lambda x: -(x.get("mcap") or 0))
        base.update({
            "count": len(rows),
            "avg_pct": round(sum(pcts) / len(pcts), 2) if pcts else None,
            "up": sum(1 for p in pcts if p > 0), "down": sum(1 for p in pcts if p < 0),
            "flat": sum(1 for p in pcts if p == 0),
            "limit_up": sum(1 for r in rows if (r.get("pct") or 0) >= 9.8),
            "limit_down": sum(1 for r in rows if (r.get("pct") or 0) <= -9.8),
            "pos250_med": pos250_med, "pos1250_med": pos1250_med,
            "pct5_med": median(pct5s), "pe_median": median(pes), "pb_median": median(pbs),
            "vol_median": median(vols), "stage": stage_of(pos250_med, pos1250_med),
            "stocks": stock_rows[:150],
        })
        themes.append(base)
    meds = [tm["pe_median"] for tm in themes if tm.get("pe_median") is not None]
    for tm in themes:
        tm["pe_pct_x"] = pct_rank(meds, tm["pe_median"]) if tm.get("pe_median") is not None else None

    # as_of 取日线里出现最多的最后日期（腾讯日线含当日），比日历更可靠（避开节假日）
    if not as_of:
        date_counts = {}
        for r in records:
            d = r.get("last_date")
            if d:
                date_counts[d] = date_counts.get(d, 0) + 1
        as_of = max(date_counts, key=date_counts.get) if date_counts else latest_trading_date()
    return {
        "as_of": as_of,
        "generated_at": now_iso(),
        "source": "sina 清单 + emweb 申万一级 + 雪球/新浪/腾讯日线 + 东财估值/龙虎榜/分红",
        "total": len(records),
        "sectors_count": len(sectors),
        "market": market,
        "signals": market["signal_counts"],
        "signal_labels": SIGNAL_LABEL,
        "thresholds": {"surge_pct5": 0.10, "plunge_pct5": -0.10,
                       "flat_pct20": -0.12, "flat_amp5": 0.06, "flat_pct5_abs": 0.03,
                       "cycle_pos250_low": 0.10, "cycle_pos250_high": 0.90},
        "fails": fails[:20],
        "sectors": sectors,
        "boards": boards or {"concept": []},
        "cycle": cycle_block,
        "decision": decisions,
        "themes": themes,
        "theme_groups": THEME_GROUPS,
        "lhb": lhb,
        "youzi": youzi,
        "dividend": dividend,
        "elapsed": round(time.time() - started, 1),
    }


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        write_status(state="error", error=str(exc)[:300], at=now_iso())
        print("FATAL:", exc, file=sys.stderr)
        raise
