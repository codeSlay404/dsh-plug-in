/**
 * Host half of the A-share sector board bundle.
 *
 * Serves ETL output and realtime proxies over the DSH web server so the
 * browser panel can fetch everything same-origin:
 *   GET  /api/sector-board/dashboard.json   A股看板数据（ETL）
 *   GET  /api/sector-board/etf.json         ETF 列表 + 日线指标（ETL）
 *   GET  /api/sector-board/search.json      股票/ETF 搜索索引（ETL）
 *   GET  /api/sector-board/global.json      外股/商品/外汇目录 + 实时报价
 *   GET  /api/sector-board/quotes.json?codes=sh600000,usAAPL   实时报价
 *   GET  /api/sector-board/paper.json       模拟盘账户 + 实时标记
 *   POST /api/sector-board/paper/decide     跑一次模拟盘决策
 *   GET  /api/sector-board/status.json      ETL 状态
 *   POST /api/sector-board/refresh          spawn 全量 ETL
 *
 * Data lives outside the bundle so reinstalling the plugin never wipes it:
 *   ${SECTOR_BOARD_DIR:-~/.dsh/sector-board}/
 */
import { execFile, spawn } from 'node:child_process'
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { guardOptions, isTrustedRequest } from './guard.js'

export const name = 'dsh-sector-board'
export const inject = ['webServer']

const DATA_DIR = process.env.SECTOR_BOARD_DIR || join(homedir(), '.dsh', 'sector-board')
const ETL = fileURLToPath(new URL('./etl.py', import.meta.url))
const PAPER = fileURLToPath(new URL('./paper.py', import.meta.url))
const ROBOT = fileURLToPath(new URL('./robot.py', import.meta.url))
const ANNOUNCEMENTS = fileURLToPath(new URL('./announcements.py', import.meta.url))
const DOCS_DIR = fileURLToPath(new URL('./docs', import.meta.url))
const V3_FILES = new Map([
  ['ui-v3.html', 'text/html; charset=utf-8'],
  ['assets/ui-v3.css', 'text/css; charset=utf-8'],
  ['assets/ui-v3.js', 'text/javascript; charset=utf-8'],
  ['assets/universe-data.js', 'text/javascript; charset=utf-8'],
])
const STATUS_STALE_MS = 12 * 60 * 1000
const QUOTE_TTL = 5000
const EXEC = promisify(execFile)
const PY = process.platform === 'win32' ? 'python' : 'python3'
const GBK = new TextDecoder('gbk')

let child = null
const cache = new Map()

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

async function cached(key, ttl, fn) {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < ttl) return hit.value
  const value = await fn()
  cache.set(key, { at: Date.now(), value })
  if (cache.size > 200) cache.delete(cache.keys().next().value)
  return value
}

function statusNow() {
  try {
    return JSON.parse(readFileSync(join(DATA_DIR, 'status.json'), 'utf8'))
  } catch {
    return null
  }
}

function isRunning() {
  if (child && child.exitCode === null) return true
  const s = statusNow()
  if (!s || s.state !== 'running') return false
  const age = Date.now() - new Date(s.updated_at || s.started_at || 0).getTime()
  return age >= 0 && age < STATUS_STALE_MS
}

function startRefresh() {
  if (isRunning()) return { started: false, reason: 'running', status: statusNow() }
  mkdir(DATA_DIR, { recursive: true }).catch(() => {})
  const log = openSync(join(DATA_DIR, 'etl.log'), 'a')
  child = spawn(PY, [ETL], {
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, SECTOR_BOARD_DIR: DATA_DIR },
  })
  child.on('error', (err) => {
    child = null
    try {
      writeFileSync(join(DATA_DIR, 'status.json'), JSON.stringify({
        state: 'error', error: `spawn failed: ${err.message}`, updated_at: new Date().toISOString(),
      }))
    } catch { /* ignore */ }
  })
  child.unref()
  // fd 已交给子进程（stdio），父进程这份必须关掉，否则每刷新一次泄一个 fd。
  try { closeSync(log) } catch { /* ignore */ }
  return { started: true, pid: child.pid }
}

/* ------------------------------------------------------------------ quotes */

function canon(code) {
  const c = String(code || '').trim()
  if (/^(sh|sz|bj)\d{6}$/i.test(c)) return c.toLowerCase().replace(/^bj/, 'bj')
  if (/^hk[a-z0-9]+$/i.test(c)) {
    const rest = c.slice(2)
    return 'hk' + (/^\d+$/.test(rest) ? rest : rest.toUpperCase())
  }
  if (/^us[a-z0-9.]+$/i.test(c)) {
    const rest = c.slice(2).toUpperCase()
    const US_INDEX = ['.DJI', '.IXIC', '.INX', '.SPX', '.NDX', '.RUT', '.VIX']
    if (US_INDEX.includes(rest)) return 'us' + rest
    return 'us' + rest.replace(/\./g, '')
  }
  if (/^\d{6}$/.test(c)) {
    if (c[0] === '6' || c[0] === '9' || c[0] === '5') return 'sh' + c
    if (c[0] === '4' || /^(83|87|88|92)/.test(c)) return 'bj' + c
    return 'sz' + c
  }
  const suf = c.match(/^(hf_|fx_|int_)(.+)$/i)
  if (suf) {
    const kind = suf[1].toLowerCase()
    const tail = kind === 'hf_' ? suf[2].toUpperCase() : suf[2].toLowerCase()
    return kind + tail
  }
  if (c.toUpperCase() === 'DINIW') return 'DINIW'
  return null
}

async function fetchText(url, headers = {}) {
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(9000) })
  if (!resp.ok) throw new Error('http ' + resp.status)
  return GBK.decode(await resp.arrayBuffer())
}

async function fetchUtf8(url, headers = {}) {
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(9000) })
  if (!resp.ok) throw new Error('http ' + resp.status)
  return resp.text()
}

function tencentParse(key, body) {
  const f = body.split('~')
  const price = Number(f[3])
  if (!Number.isFinite(price) || price <= 0) return null
  const prev = Number(f[4]) || null
  const pct = Number(f[32])
  return {
    code: key, name: f[1] || key, price, prev,
    open: Number(f[5]) || null, high: Number(f[33]) || null, low: Number(f[34]) || null,
    chg: Number.isFinite(Number(f[31])) ? Number(f[31]) : (prev ? price - prev : null),
    pct: Number.isFinite(pct) ? pct : (prev ? (price / prev - 1) * 100 : null),
    amount: Number(f[37]) || null,        // 成交额（万）
    turnover: Number(f[38]) || null,      // 换手率 %
    limit_up: Number(f[47]) || null,      // 涨停价
    limit_down: Number(f[48]) || null,    // 跌停价
    vol_ratio: Number(f[49]) || null,     // 量比
    time: f[30] || null, source: 'tencent',
  }
}

function sinaParse(key, f) {
  const num = (i) => (Number.isFinite(Number(f[i])) ? Number(f[i]) : null)
  if (/^hf_/i.test(key)) {
    const price = num(0)
    if (!price) return null
    const prev = num(7)
    return { code: key, name: f[13] || key, price, prev, open: num(8), high: num(4), low: num(5),
             chg: prev ? price - prev : null, pct: prev ? (price / prev - 1) * 100 : null,
             time: `${f[12] || ''} ${f[6] || ''}`.trim(), source: 'sina' }
  }
  if (/^DINIW$/i.test(key)) {
    const price = num(1)
    const prev = num(5)
    if (!price) return null
    return { code: key, name: f[9] || '美元指数', price, prev, open: null, high: null, low: null,
             chg: prev ? price - prev : null, pct: prev ? (price / prev - 1) * 100 : null,
             time: `${f[10] || ''} ${f[0] || ''}`.trim(), source: 'sina' }
  }
  if (/^fx_/i.test(key)) {
    const price = num(1)
    if (!price) return null
    const pct = num(10)
    const chg = num(11)
    return { code: key, name: f[9] || key, price,
             prev: chg != null ? price - chg : null, open: null, high: null, low: null,
             chg, pct, time: f[0] || null, source: 'sina' }
  }
  return null
}

async function fetchQuotes(codes) {
  const want = [...new Set(codes.map(canon).filter(Boolean))]
  if (!want.length) return new Map()
  const out = new Map()
  const tencent = want.filter((c) => /^(sh|sz|bj|hk|us)/.test(c))
  const sina = want.filter((c) => !/^(sh|sz|bj|hk|us)/.test(c))
  const jobs = []
  for (let i = 0; i < tencent.length; i += 50) jobs.push(['tencent', tencent.slice(i, i + 50)])
  for (let i = 0; i < sina.length; i += 40) jobs.push(['sina', sina.slice(i, i + 40)])
  await Promise.all(jobs.map(async ([kind, list]) => {
    try {
      if (kind === 'tencent') {
        const txt = await fetchText('https://qt.gtimg.cn/q=' + list.join(','), { referer: 'https://gu.qq.com/' })
        for (const chunk of txt.split(';')) {
          const m = chunk.match(/v_([^=]+)="([^"]*)"/)
          if (!m) continue
          const q = tencentParse(m[1], m[2])
          if (q) out.set(q.code, q)
        }
      } else {
        const txt = await fetchText('https://hq.sinajs.cn/list=' + list.join(','), { referer: 'https://finance.sina.com.cn/' })
        for (const m of txt.matchAll(/hq_str_([^=]+)="([^"]*)"/g)) {
          const f = m[2].split(',')
          const q = sinaParse(m[1], f)
          if (q) out.set(q.code, q)
        }
      }
    } catch { /* group failed; other groups still return */ }
  }))
  return out
}

async function quotesPayload(codes) {
  return cached('q:' + [...codes].sort().join(','), QUOTE_TTL, async () => {
    const m = await fetchQuotes(codes)
    return codes.map((raw) => {
      const c = canon(raw)
      return m.get(c) || { code: raw, name: raw, price: null, pct: null, error: 'no-quote' }
    })
  })
}

/* ---------------------------------------------------------- live monitor */

const LIVE_SNAP = new Map()      // code -> { t, price }
const LIVE_LAST_EVENT = new Map() // code:type -> ts
const LIVE_EVENTS = []           // newest first, capped

export function detectLiveEvents(prev, cur, now) {
  if (!prev || !cur || !prev.price || !cur.price) return []
  const out = []
  const dt = now - prev.t
  if (cur.limit_down && prev.price <= cur.limit_down * 1.001 && cur.price >= cur.limit_down * 1.005) {
    out.push({ type: 'limit_down_open', text: '跌停撬板' })
  }
  if (cur.limit_up && prev.price >= cur.limit_up * 0.999 && cur.price <= cur.limit_up * 0.998) {
    out.push({ type: 'limit_up_break', text: '涨停打开' })
  }
  if (dt >= 20000 && dt <= 300000) {
    const sp = (cur.price / prev.price - 1) * 100
    if (sp >= 1.5) out.push({ type: 'surge', text: `急拉 +${sp.toFixed(1)}%` })
    if (sp <= -1.5) out.push({ type: 'plunge', text: `急跌 ${sp.toFixed(1)}%` })
  }
  return out
}

async function livePayload(codes) {
  const now = Date.now()
  const rows = await quotesPayload(codes)
  const fresh = []
  const outRows = rows.map((q) => {
    if (!q || !q.price) return q
    const prev = LIVE_SNAP.get(q.code)
    if (prev) {
      for (const ev of detectLiveEvents(prev, q, now)) {
        const lk = q.code + ':' + ev.type
        if (now - (LIVE_LAST_EVENT.get(lk) || 0) < 120000) continue
        LIVE_LAST_EVENT.set(lk, now)
        fresh.push({ ...ev, code: q.code, name: q.name, price: q.price, pct: q.pct, at: now })
      }
    }
    LIVE_SNAP.set(q.code, { t: now, price: q.price })
    const speed = prev && prev.price ? +(((q.price / prev.price) - 1) * 100).toFixed(2) : null
    return { ...q, speed }
  })
  if (fresh.length) {
    LIVE_EVENTS.unshift(...fresh)
    if (LIVE_EVENTS.length > 80) LIVE_EVENTS.length = 80
  }
  return {
    updated_at: new Date(now).toISOString(),
    count: outRows.length,
    rows: outRows,
    events: LIVE_EVENTS.slice(0, 40),
  }
}

/* ------------------------------------------------------- global catalogue */

const GLOBAL = [
  { group: 'A股指数', code: 'sh000001', name: '上证指数' },
  { group: 'A股指数', code: 'sz399001', name: '深证成指' },
  { group: 'A股指数', code: 'sz399006', name: '创业板指' },
  { group: 'A股指数', code: 'sh000688', name: '科创50' },
  { group: 'A股指数', code: 'sh000300', name: '沪深300' },
  { group: 'A股指数', code: 'sh000905', name: '中证500' },
  { group: 'A股指数', code: 'sh000852', name: '中证1000' },
  { group: '港股指数', code: 'hkHSI', name: '恒生指数' },
  { group: '港股指数', code: 'hkHSTECH', name: '恒生科技' },
  { group: '美股指数', code: 'us.DJI', name: '道琼斯' },
  { group: '美股指数', code: 'us.IXIC', name: '纳斯达克' },
  { group: '美股指数', code: 'us.INX', name: '标普500' },
  { group: '日股', code: 'usEWJ', name: '日本ETF(EWJ)' },
  { group: '日股', code: 'usTM', name: '丰田汽车 ADR' },
  { group: '日股', code: 'usSONY', name: '索尼 ADR' },
  { group: '韩股', code: 'usEWY', name: '韩国ETF(EWY)' },
  { group: '韩股', code: 'usSSNLF', name: '三星电子 ADR' },
  { group: '欧股', code: 'usEWG', name: '德国ETF(EWG)' },
  { group: '欧股', code: 'usEWU', name: '英国ETF(EWU)' },
  { group: '美股', code: 'usAAPL', name: '苹果' },
  { group: '美股', code: 'usNVDA', name: '英伟达' },
  { group: '美股', code: 'usTSLA', name: '特斯拉' },
  { group: '美股', code: 'usMSFT', name: '微软' },
  { group: '港股', code: 'hk00700', name: '腾讯控股' },
  { group: '港股', code: 'hk09988', name: '阿里巴巴-W' },
  { group: '商品', code: 'hf_XAU', name: '伦敦金' },
  { group: '商品', code: 'hf_GC', name: '纽约金' },
  { group: '商品', code: 'hf_XAG', name: '伦敦银' },
  { group: '商品', code: 'hf_SI', name: '纽约银' },
  { group: '商品', code: 'hf_CL', name: 'WTI 原油' },
  { group: '商品', code: 'hf_OIL', name: '布伦特原油' },
  { group: '外汇', code: 'DINIW', name: '美元指数' },
  { group: '外汇', code: 'fx_susdcny', name: '美元/人民币' },
  { group: '外汇', code: 'fx_susdjpy', name: '美元/日元' },
  { group: '外汇', code: 'fx_seurusd', name: '欧元/美元' },
]

async function globalPayload() {
  return cached('global', QUOTE_TTL, async () => {
    const m = await fetchQuotes(GLOBAL.map((g) => g.code))
    return {
      generated_at: new Date().toISOString(),
      items: GLOBAL.map((g) => {
        const q = m.get(canon(g.code)) || {}
        return { ...g, price: q.price ?? null, prev: q.prev ?? null, pct: q.pct ?? null,
                 chg: q.chg ?? null, time: q.time ?? null, source: q.source ?? null, name: q.name || g.name }
      }),
    }
  })
}

/* ---------------------------------------------------------------- search */

let searchCache = null

async function searchIndex() {
  if (searchCache && Date.now() - searchCache.at < 30000) return searchCache.rows
  const doc = await readJson(join(DATA_DIR, 'search.json'))
  const rows = []
  for (const r of doc?.rows || []) {
    rows.push({ code: r.code, name: r.name, type: r.type || 'stock', industry: r.industry || '', group: '', tags: r.tags || '' })
  }
  for (const g of GLOBAL) rows.push({ code: g.code, name: g.name, type: 'global', industry: '', group: g.group })
  searchCache = { at: Date.now(), rows }
  return rows
}

async function searchPayload(q) {
  const query = String(q || '').trim().toLowerCase()
  if (!query) return { rows: [] }
  const rows = await searchIndex()
  const scored = []
  for (const r of rows) {
    const name = String(r.name || '').toLowerCase()
    const code = String(r.code || '').toLowerCase()
    let score = -1
    if (name === query) score = 0
    else if (code === query) score = 1
    else if (name.startsWith(query)) score = 2
    else if (code.startsWith(query) && query.length >= 3) score = 3
    else if (name.includes(query)) score = 4
    else if (r.tags && r.tags.includes(query)) score = 5
    if (score >= 0) scored.push({ r, score: score - (r.type === 'board' ? 0.5 : 0) })
  }
  scored.sort((a, b) => a.score - b.score || a.r.name.length - b.r.name.length)
  return { rows: scored.slice(0, 15).map((x) => x.r) }
}

/* ------------------------------------------------------------------ paper */

async function announcementsPayload(code) {
  const data = await readJson(join(DATA_DIR, 'announcements.json'))
  if (!data) return null
  const c = String(code || '').replace(/^[a-z]{2}/i, '').trim()
  if (!c) return data
  const rows = (data.rows || []).filter((r) => String(r.code) === c)
  return { ...data, count: rows.length, rows }
}

async function announcementsRefresh(codes = []) {
  const args = [ANNOUNCEMENTS, '--merge']
  if (codes.length) args.push('--codes', codes.join(','))
  const { stdout } = await EXEC(PY, args, { timeout: 180000, maxBuffer: 2 * 1024 * 1024 })
  return { ok: true, summary: String(stdout || '').trim() }
}

async function paperPayload() {
  // 文件存在但读不出来 = 损坏：不能当成「还没有账户」，否则界面会劝人去建一个新的，
  // 而 paper.py 现在遇到损坏是拒绝覆盖的，两边说法要一致。
  const paperFile = join(DATA_DIR, 'paper.json')
  let rawPaper = null
  try {
    rawPaper = await readFile(paperFile, 'utf8')
  } catch { /* 没有文件：真的还没建 */ }
  let acc = null
  if (rawPaper !== null) {
    try {
      acc = JSON.parse(rawPaper)
    } catch {
      return {
        exists: true,
        corrupt: true,
        error: `模拟盘账户文件损坏：${paperFile}；已拒绝自动重建，请手工修复或显式重建`,
        strategy: 'ETF 趋势轮动 v1',
        initial: 100000,
      }
    }
  }
  if (!acc) return { exists: false, strategy: 'ETF 趋势轮动 v1', initial: 100000 }
  const held = acc.positions || []
  let quotes = new Map()
  try {
    quotes = await fetchQuotes([...held.map((p) => p.code), ...(acc.watch || [])])
  } catch { /* fall back to cost */ }
  const positions = held.map((p) => {
    const q = quotes.get(canon(p.code))
    const price = q?.price ?? p.cost
    const mv = price * p.qty
    return { ...p, price: Number(price.toFixed(4)), pct: q?.pct ?? null,
             mv: Number(mv.toFixed(2)), pnl: Number((mv - p.cost * p.qty).toFixed(2)),
             pnl_pct: p.cost ? (price / p.cost - 1) * 100 : 0, quote_time: q?.time ?? null }
  })
  const mv = positions.reduce((s, p) => s + p.mv, 0)
  const nav = Number((acc.cash + mv).toFixed(2))
  return {
    exists: true, strategy: acc.strategy, initial: acc.initial, cash: Number(acc.cash.toFixed(2)),
    nav, pnl_pct: (nav / acc.initial - 1) * 100, mv: Number(mv.toFixed(2)),
    positions, trades: (acc.trades || []).slice(-60).reverse(),
    decisions: (acc.decisions || []).slice(-30).reverse(),
    equity: (acc.equity || []).slice(-60), created_at: acc.created_at, updated_at: acc.updated_at,
    robot: acc.robot || null,
  }
}

async function paperInit() {
  try {
    await EXEC(PY, [PAPER, '--init'], { env: { ...process.env, SECTOR_BOARD_DIR: DATA_DIR }, timeout: 30000 })
    return await paperDecide()
  } catch (err) {
    return { ok: false, error: String(err.stderr || err.message).slice(0, 800) }
  }
}

async function robotRun() {
  try {
    const fd = openSync(join(DATA_DIR, 'robot.log'), 'a')
    const child = spawn(PY, [ROBOT, '--run'], {
      detached: true, stdio: ['ignore', fd, fd],
      env: { ...process.env, SECTOR_BOARD_DIR: DATA_DIR },
    })
    child.unref()
    closeSync(fd)
    return { ok: true, started: true, pid: child.pid, account: await paperPayload() }
  } catch (err) {
    return { ok: false, error: String(err.message).slice(0, 500) }
  }
}

async function paperDecide() {
  try {
    const { stdout } = await EXEC(PY, [PAPER, '--decide'], {
      env: { ...process.env, SECTOR_BOARD_DIR: DATA_DIR }, timeout: 90000,
    })
    return { ok: true, run: stdout.trim(), account: await paperPayload() }
  } catch (err) {
    return { ok: false, error: String(err.stderr || err.message).slice(0, 800) }
  }
}

/* ------------------------------------------------------------- analytics */

const SINA_LONG = 'https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData'
const SINA_KLINE = 'https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData'

function ashareSymbol(code) {
  const c = String(code || '').replace(/\D/g, '').slice(0, 6)
  if (!c) return ''
  if (c[0] === '6' || c[0] === '5' || c[0] === '9') return 'sh' + c
  if (c[0] === '4' || c[0] === '8') return 'bj' + c
  return 'sz' + c
}

async function fetchSinaBars(symbol, datalen = 320) {
  const url = `${SINA_KLINE}?symbol=${symbol}&scale=240&ma=no&datalen=${datalen}`
  const txt = await fetchText(url, { referer: 'https://finance.sina.com.cn/' })
  const rows = JSON.parse(txt)
  if (!Array.isArray(rows)) return []
  return rows.map((r) => ({
    d: r.day, o: Number(r.open), h: Number(r.high), l: Number(r.low),
    c: Number(r.close), v: Number(r.volume) || 0,
  })).filter((b) => Number.isFinite(b.c) && b.c > 0)
}

function emaSeries(values, n) {
  const k = 2 / (n + 1)
  const out = []
  let e = null
  for (const v of values) {
    if (v == null) { out.push(null); continue }
    e = e == null ? v : e + k * (v - e)
    out.push(e)
  }
  return out
}

function rsiSeries(closes, n = 14) {
  const out = new Array(closes.length).fill(null)
  let gain = 0, loss = 0
  for (let i = 1; i < closes.length; i += 1) {
    const ch = closes[i] - closes[i - 1]
    const g = Math.max(ch, 0), l = Math.max(-ch, 0)
    if (i <= n) {
      gain += g; loss += l
      if (i === n) {
        const rs = loss === 0 ? 100 : gain / loss
        out[i] = 100 - 100 / (1 + rs)
      }
    } else {
      gain = (gain * (n - 1) + g) / n
      loss = (loss * (n - 1) + l) / n
      const rs = loss === 0 ? 100 : gain / loss
      out[i] = 100 - 100 / (1 + rs)
    }
  }
  return out
}

function moveAvg(closes, n) {
  const out = new Array(closes.length).fill(null)
  let sum = 0
  for (let i = 0; i < closes.length; i += 1) {
    sum += closes[i]
    if (i >= n) sum -= closes[i - n]
    if (i >= n - 1) out[i] = sum / n
  }
  return out
}


function aggBars(bars, period) {
  if (period !== 'week' && period !== 'month') return bars
  const map = new Map()
  for (const b of bars) {
    let key
    if (period === 'week') {
      const t = new Date(b.d + 'T00:00:00Z')
      const dow = (t.getUTCDay() + 6) % 7
      t.setUTCDate(t.getUTCDate() - dow)
      key = t.toISOString().slice(0, 10)
    } else key = b.d.slice(0, 7)
    const g = map.get(key)
    if (!g) map.set(key, { d: b.d, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })
    else { g.d = b.d; g.h = Math.max(g.h, b.h); g.l = Math.min(g.l, b.l); g.c = b.c; g.v += b.v }
  }
  return [...map.values()]
}

function bollSeries(closes, n = 20, k = 2) {
  const mid = [], up = [], low = []
  for (let i = 0; i < closes.length; i += 1) {
    if (i < n - 1) { mid.push(null); up.push(null); low.push(null); continue }
    const win = closes.slice(i - n + 1, i + 1)
    const m = win.reduce((a, b) => a + b, 0) / n
    const sd = Math.sqrt(win.reduce((a, b) => a + (b - m) ** 2, 0) / n)
    mid.push(m); up.push(m + k * sd); low.push(m - k * sd)
  }
  return { mid, up, low }
}

function kdjSeries(bars, n = 9) {
  const k = [], d = [], j = []
  let pk = 50, pd = 50
  for (let i = 0; i < bars.length; i += 1) {
    if (i < n - 1) { k.push(null); d.push(null); j.push(null); continue }
    const win = bars.slice(i - n + 1, i + 1)
    const hh = Math.max(...win.map((b) => b.h))
    const ll = Math.min(...win.map((b) => b.l))
    const rsv = hh === ll ? 50 : ((bars[i].c - ll) / (hh - ll)) * 100
    pk = (2 / 3) * pk + (1 / 3) * rsv
    pd = (2 / 3) * pd + (1 / 3) * pk
    k.push(pk); d.push(pd); j.push(3 * pk - 2 * pd)
  }
  return { k, d, j }
}

function atrSeries(bars, n = 14) {
  const out = []
  let prev = null
  for (let i = 0; i < bars.length; i += 1) {
    if (i === 0) { out.push(null); prev = bars[i].c; continue }
    const b = bars[i], pc = bars[i - 1].c
    const tr = Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc))
    out.push(prev == null ? tr : (prev * (n - 1) + tr) / n)
    prev = tr
    if (i === 1) out[1] = tr
  }
  return out
}

function crossIdx(fast, slow, from) {
  const hits = []
  for (let i = Math.max(1, from); i < fast.length; i += 1) {
    if (fast[i] == null || slow[i] == null || fast[i - 1] == null || slow[i - 1] == null) continue
    if (fast[i] > slow[i] && fast[i - 1] <= slow[i - 1]) hits.push({ i, type: 'golden' })
    if (fast[i] < slow[i] && fast[i - 1] >= slow[i - 1]) hits.push({ i, type: 'death' })
  }
  return hits
}

function stockSummary(bars, ind) {
  const n = bars.length
  const last = bars[n - 1]
  const c = last.c
  const ma = ind.ma, dif = ind.macd.dif, dea = ind.macd.dea, hist = ind.macd.hist
  const rsi = ind.rsi.r14
  const volma5 = ind.volma5
  const boll = ind.boll
  const atr = ind.atr
  const maNow = (arr) => (arr && arr.length ? arr[n - 1] : null)
  const m5 = maNow(ma.ma5), m10 = maNow(ma.ma10), m20 = maNow(ma.ma20), m60 = maNow(ma.ma60)
  const difNow = dif[n - 1], deaNow = dea[n - 1], rsiNow = rsi[n - 1], v5 = volma5[n - 1]
  const bollUp = boll.up[n - 1], bollLow = boll.low[n - 1], bollMid = boll.mid[n - 1]
  const atrNow = atr[n - 1]
  const highs = bars.map((b) => b.h), lows = bars.map((b) => b.l)
  const winHigh = (w) => Math.max(...highs.slice(Math.max(0, n - w)))
  const winLow = (w) => Math.min(...lows.slice(Math.max(0, n - w)))
  const h20 = winHigh(20), l20 = winLow(20), h60 = winHigh(60), l60 = winLow(60), h120 = winHigh(120), l120 = winLow(120)
  const posWin = bars.slice(Math.max(0, n - 250)).map((b) => b.c)
  const posMax = Math.max(...posWin), posMin = Math.min(...posWin)
  const pos = posMax === posMin ? 0.5 : (c - posMin) / (posMax - posMin)
  const golden = crossIdx(dif, dea, n - 6).filter((x) => x.type === 'golden')
  const death = crossIdx(dif, dea, n - 6).filter((x) => x.type === 'death')
  const maBull = m5 != null && m5 > m10 && m10 > m20 && m20 > (m60 ?? m20)
  const maBear = m5 != null && m5 < m10 && m10 < m20 && m20 < (m60 ?? m20)
  const signals = []
  signals.push(maBull ? '均线多头排列' : maBear ? '均线空头排列' : '均线纠缠')
  if (m20 != null) signals.push(c > m20 ? '站上 MA20' : '低于 MA20')
  if (m60 != null) signals.push(c > m60 ? '站上 MA60' : '低于 MA60')
  signals.push(difNow > 0 && deaNow > 0 ? 'MACD 水上' : difNow < 0 && deaNow < 0 ? 'MACD 水下' : 'MACD 零轴')
  if (difNow > deaNow) signals.push('DIF 在 DEA 上方')
  const lastCross = [...golden, ...death].sort((a, b) => b.i - a.i)[0]
  if (lastCross) signals.push(`${lastCross.type === 'golden' ? '金叉' : '死叉'}（${bars[lastCross.i].d}，近 5 日）`)
  if (rsiNow != null) {
    if (rsiNow >= 80) signals.push('RSI 超买')
    else if (rsiNow >= 70) signals.push('RSI 偏高')
    else if (rsiNow <= 20) signals.push('RSI 超卖')
    else if (rsiNow <= 30) signals.push('RSI 偏低')
  }
  const kLast = ind.kdj && ind.kdj.k.length ? ind.kdj.k[n - 1] : null
  const dLast = ind.kdj && ind.kdj.d.length ? ind.kdj.d[n - 1] : null
  if (kLast != null && dLast != null) {
    if (kLast > 80 && dLast > 80) signals.push('KDJ 高位钝化')
    else if (kLast < 20 && dLast < 20) signals.push('KDJ 低位')
    else if (kLast > dLast && kLast < 50) signals.push('KDJ 偏低位')
  }
  if (v5 && last.v > v5 * 1.5) signals.push('放量（>1.5×5日均量）')
  if (c > h20 * 0.999 && n > 21) signals.push('创 20 日新高')
  if (c < l20 * 1.001 && n > 21) signals.push('创 20 日新低')
  if (bollUp != null && c > bollUp) signals.push('突破布林上轨')
  if (bollLow != null && c < bollLow) signals.push('跌破布林下轨')
  signals.push(`1年位置 ${Math.round(pos * 100)}%`)

  let score = 50
  if (m20 != null) score += c > m20 ? 8 : -8
  if (m60 != null && m20 != null) score += m20 > m60 ? 6 : -6
  if (maBull) score += 10
  if (maBear) score -= 10
  score += difNow > deaNow ? 8 : -8
  if (hist[n - 1] != null && hist[n - 2] != null && hist[n - 3] != null && hist[n - 1] > hist[n - 2] && hist[n - 2] > hist[n - 3]) score += 4
  if (rsiNow != null) {
    if (rsiNow > 80) score -= 8
    else if (rsiNow >= 50 && rsiNow <= 70) score += 6
    else if (rsiNow < 30) score -= 2
  }
  if (v5 && last.v > v5 * 1.5) score += 4
  score = Math.max(0, Math.min(100, Math.round(score)))
  const label = score >= 75 ? '强势' : score >= 60 ? '偏强' : score >= 45 ? '震荡' : score >= 30 ? '偏弱' : '弱势'

  const notes = []
  if (maBull) notes.push('均线呈多头排列，价格在所有均线上方，趋势结构完整。')
  else if (maBear) notes.push('均线呈空头排列，反弹先按修复看待，除非重新站上 MA20。')
  else notes.push('均线纠缠，方向未定，等待区间突破或回踩确认。')
  const lastGolden = golden.length ? bars[golden[golden.length - 1].i].d : null
  const lastDeath = death.length ? bars[death[death.length - 1].i].d : null
  if (difNow > deaNow) {
    notes.push(lastGolden
      ? `MACD 在${difNow > 0 ? '水上' : '零轴附近'}，${lastGolden} 金叉后 DIF 仍高于 DEA，动能偏多。`
      : `MACD 在${difNow > 0 ? '水上' : '零轴附近'}且 DIF 高于 DEA，动能仍在多方。`)
  } else {
    notes.push(lastDeath
      ? `MACD 已在${difNow < 0 ? '水下' : '零轴附近'}出现死叉（${lastDeath}），动能偏弱，等重新金叉再确认。`
      : `MACD DIF 低于 DEA，${difNow < 0 ? '且在水下，动能偏弱' : '动能转弱，留意是否形成死叉'}。`)
  }
  if (rsiNow != null && rsiNow >= 70) notes.push(`RSI ${rsiNow.toFixed(0)} 已进入偏热区，追高性价比下降，等回踩 MA20 更稳。`)
  else if (rsiNow != null && rsiNow <= 30) notes.push(`RSI ${rsiNow.toFixed(0)} 处于偏冷区，可能是超跌反弹，但需要放量站上 MA20 确认。`)
  if (pos >= 0.85) notes.push(`价格在近一年 ${Math.round(pos * 100)}% 分位，属于高位区，注意兑现节奏。`)
  else if (pos <= 0.15) notes.push(`价格在近一年 ${Math.round(pos * 100)}% 分位，属于低位区，反转需要催化与量能。`)
  if (atrNow != null && c) notes.push(`ATR14 约 ${atrNow.toFixed(2)}（占价格 ${((atrNow / c) * 100).toFixed(1)}%），可作为止损宽度参考。`)

  return {
    score, label, signals, notes, pos: Number(pos.toFixed(3)),
    levels: { h20, l20, h60, l60, h120, l120 },
    last: { ma5: m5, ma10: m10, ma20: m20, ma60: m60, dif: difNow, dea: deaNow, rsi: rsiNow, atr: atrNow, bollUp, bollMid, bollLow, volma5: v5 },
  }
}

async function minutePayload(code) {
  const c = canon(code)
  if (!/^(sh|sz|bj)\d{6}$/.test(c)) return { error: 'not-ashare' }
  return cached('min:' + c, 20000, async () => {
    const raw = await fetchUtf8('https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=' + c)
    let j
    try { j = JSON.parse(raw) } catch { return { error: 'bad-minute' } }
    const node = j && j.data && j.data[c]
    const rows = node && node.data && node.data.data
    if (!Array.isArray(rows) || !rows.length) return { error: 'no-minute', code: c }
    const qt = (node.qt && node.qt[c]) || []
    const prev = Number(qt[4]) > 0 ? Number(qt[4]) : null
    const points = []
    let lastV = 0, lastA = 0
    for (const line of rows) {
      const parts = String(line).trim().split(/\s+/)
      if (parts.length < 3) continue
      const tm = parts[0]
      const price = Number(parts[1])
      const cumV = Number(parts[2]) || 0
      const cumA = Number(parts[3]) || 0
      if (!Number.isFinite(price) || price <= 0) continue
      if (tm > '1500') continue
      const v = Math.max(0, cumV - lastV)
      const a = Math.max(0, cumA - lastA)
      lastV = cumV; lastA = cumA
      points.push({ t: tm, p: price, v, avg: cumV > 0 ? Number((cumA / (cumV * 100)).toFixed(3)) : null })
    }
    if (!points.length) return { error: 'no-minute', code: c }
    const prices = points.map((x) => x.p)
    const quote = (await quotesPayload([c]))[0] || null
    return {
      period: 'min', code: c, name: (qt[1] || '').trim(),
      date: (node.data.date || '') || '', prev_close: prev,
      open: Number(qt[5]) > 0 ? Number(qt[5]) : points[0].p,
      high: (quote && Number(quote.high) > 0) ? Number(quote.high) : Math.max(...prices),
      low: (quote && Number(quote.low) > 0) ? Number(quote.low) : Math.min(...prices),
      last: points[points.length - 1],
      count: points.length, points, quote,
    }
  })
}

async function stockPayload(code, period = 'day') {
  const symbol = ashareSymbol(code)
  if (!symbol) return { error: 'bad-code' }
  const key = 'stock:' + symbol + ':' + period
  return cached(key, 60000, async () => {
    const raw = await fetchSinaBars(symbol, period === 'day' ? 320 : 1300)
    if (!raw.length) return { error: 'no-bars', code: symbol }
    const bars = aggBars(raw, period)
    const closes = bars.map((b) => b.c)
    const ma5 = moveAvg(closes, 5)
    const ma10 = moveAvg(closes, 10)
    const ma20 = moveAvg(closes, 20)
    const ma60 = moveAvg(closes, 60)
    const ema12 = emaSeries(closes, 12)
    const ema26 = emaSeries(closes, 26)
    const dif = closes.map((_, i) => (ema12[i] != null && ema26[i] != null ? ema12[i] - ema26[i] : null))
    const dea = emaSeries(dif, 9)
    const hist = dif.map((d, i) => (d != null && dea[i] != null ? (d - dea[i]) * 2 : null))
    const rsi14 = rsiSeries(closes, 14)
    const rsi6 = rsiSeries(closes, 6)
    const rsi12 = rsiSeries(closes, 12)
    const boll = bollSeries(closes, 20, 2)
    const kdj = kdjSeries(bars, 9)
    const atr = atrSeries(bars, 14)
    const vols = bars.map((b) => b.v)
    const volma5 = moveAvg(vols, 5)
    const volma10 = moveAvg(vols, 10)
    const keep = period === 'day' ? 240 : bars.length
    const from = Math.max(0, bars.length - keep)
    const slice = (arr) => arr.slice(from)
    const ind = {
      ma: { ma5: slice(ma5), ma10: slice(ma10), ma20: slice(ma20), ma60: slice(ma60) },
      macd: { dif: slice(dif), dea: slice(dea), hist: slice(hist) },
      rsi: { r6: slice(rsi6), r12: slice(rsi12), r14: slice(rsi14) },
      boll: { mid: slice(boll.mid), up: slice(boll.up), low: slice(boll.low) },
      kdj: { k: slice(kdj.k), d: slice(kdj.d), j: slice(kdj.j) },
      atr: slice(atr),
      volma5: slice(volma5),
      volma10: slice(volma10),
    }
    const barsOut = bars.slice(from)
    const summary = stockSummary(barsOut, ind)
    return {
      code: symbol, as_of: bars[bars.length - 1].d, period, count: bars.length,
      bars: barsOut, ma: ind.ma, macd: ind.macd,
      rsi: ind.rsi.r14, rsiAll: ind.rsi,
      boll: ind.boll, kdj: ind.kdj, atr: ind.atr, volma: { v5: ind.volma5, v10: ind.volma10 },
      volma5: ind.volma5,
      summary,
      quote: (await quotesPayload([symbol]))[0] || null,
    }
  })
}

function thirdFriday(year, month) {
  const d = new Date(Date.UTC(year, month - 1, 1))
  const firstFri = 1 + ((5 - d.getUTCDay() + 7) % 7)
  return new Date(Date.UTC(year, month - 1, firstFri + 14))
}

function ymd(d) { return typeof d === 'string' ? d : d.toISOString().slice(0, 10) }

const FOMC_CN = [
  '2022-01-27', '2022-03-17', '2022-05-05', '2022-06-16', '2022-07-28', '2022-09-22', '2022-11-03', '2022-12-15',
  '2023-02-02', '2023-03-23', '2023-05-04', '2023-06-15', '2023-07-27', '2023-09-21', '2023-11-02', '2023-12-14',
  '2024-02-01', '2024-03-21', '2024-05-02', '2024-06-13', '2024-08-01', '2024-09-19', '2024-11-08', '2024-12-19',
  '2025-01-30', '2025-03-20', '2025-05-08', '2025-06-19', '2025-07-31', '2025-09-18', '2025-10-30', '2025-12-11',
  '2026-01-29', '2026-03-19', '2026-04-30', '2026-06-18', '2026-07-30', '2026-09-17', '2026-10-29', '2026-12-10',
]

function eventCalendar(today) {
  const year = today.getUTCFullYear()
  const out = []
  const add = (kind, title, dates, estimate = false) => {
    out.push({ kind, title, estimate, dates: dates.map(ymd) })
  }
  const deliver = []
  for (let y = year - 1; y <= year + 1; y += 1) {
    for (let m = 1; m <= 12; m += 1) deliver.push(ymd(thirdFriday(y, m)))
  }
  add('futures', '股指期货交割日（每月第三个周五）', deliver)
  const lpr = []
  for (let y = year - 1; y <= year + 1; y += 1) {
    for (let m = 1; m <= 12; m += 1) lpr.push(`${y}-${String(m).padStart(2, '0')}-20`)
  }
  add('lpr', 'LPR 报价日（每月 20 日）', lpr)
  add('fomc', '美联储 FOMC 利率决议（北京时间次日）', FOMC_CN)
  const twoSessions = []
  for (let y = year - 2; y <= year + 1; y += 1) twoSessions.push(`${y}-03-05`)
  add('twoSessions', '全国两会开幕（3 月 5 日）', twoSessions)
  const politburo = []
  for (let y = year - 2; y <= year + 1; y += 1) {
    politburo.push(`${y}-04-30`, `${y}-07-30`, `${y}-10-30`, `${y}-12-08`)
  }
  add('politburo', '政治局会议（4/7/10/12 月底，日期为惯例估计）', politburo, true)
  const cewc = []
  for (let y = year - 2; y <= year + 1; y += 1) cewc.push(`${y}-12-11`)
  add('cewc', '中央经济工作会议（12 月中，日期为惯例估计）', cewc, true)
  return out
}

function medianNum(arr) {
  const a = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y)
  if (!a.length) return null
  const mid = Math.floor(a.length / 2)
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2
}

async function eventsPayload() {
  return cached('events', 6 * 3600 * 1000, async () => {
    const bars = await fetchSinaBars('sh000001', 1600)
    const byDate = new Map(bars.map((b, i) => [b.d, i]))
    const dates = bars.map((b) => b.d)
    const today = new Date()
    const cal = eventCalendar(today)
    const snap = (target) => {
      if (byDate.has(target)) return byDate.get(target)
      const t = new Date(target + 'T00:00:00Z').getTime()
      let best = null, bestDiff = Infinity
      for (let i = 0; i < dates.length; i += 1) {
        const diff = Math.abs(new Date(dates[i] + 'T00:00:00Z').getTime() - t) / 86400000
        if (diff < bestDiff) { bestDiff = diff; best = i }
      }
      return bestDiff <= 6 ? best : null
    }
    const ret = (i, j) => (i >= 1 && j < bars.length ? (bars[j].c / bars[i].c - 1) * 100 : null)
    const events = cal.map((ev) => {
      const dayR = [], preR = [], nextR = [], w5R = []
      for (const d of ev.dates) {
        const i = snap(d)
        if (i == null || i < 1) continue
        dayR.push(ret(i - 1, i))
        preR.push(ret(i - 2, i - 1))
        nextR.push(ret(i, Math.min(i + 1, bars.length - 1)))
        w5R.push(ret(i, Math.min(i + 5, bars.length - 1)))
      }
      const stat = (arr) => {
        const vals = arr.filter((x) => Number.isFinite(x))
        if (!vals.length) return { n: 0, win: null, avg: null, med: null }
        return {
          n: vals.length,
          win: Math.round((vals.filter((x) => x > 0).length / vals.length) * 100),
          avg: Number((vals.reduce((s, x) => s + x, 0) / vals.length).toFixed(2)),
          med: Number(medianNum(vals).toFixed(2)),
        }
      }
      const future = ev.dates.filter((d) => d >= ymd(today)).sort().slice(0, 3)
      return {
        kind: ev.kind, title: ev.title, estimate: ev.estimate,
        stats: { day: stat(dayR), pre1: stat(preR), next1: stat(nextR), next5: stat(w5R) },
        upcoming: future,
      }
    })
    return { as_of: dates[dates.length - 1], index: 'sh000001', events,
             note: '统计为 2022 年以来上证指数在同一类日期的历史涨跌频率，样本有限，只描述历史规律，不构成预测。' }
  })
}


/* ------------------------------------------------------------------ 热点（讨论热度） */

const HOT_TTL = 3 * 60 * 1000

async function quickTech(code) {
  const symbol = ashareSymbol(code)
  if (!symbol) return null
  return cached('tech:' + symbol, 5 * 60 * 1000, async () => {
    const bars = await fetchSinaBars(symbol, 320)
    if (bars.length < 60) return null
    const closes = bars.map((b) => b.c)
    const ma5 = moveAvg(closes, 5), ma10 = moveAvg(closes, 10)
    const ma20 = moveAvg(closes, 20)
    const e12 = emaSeries(closes, 12), e26 = emaSeries(closes, 26)
    const dif = closes.map((_, i) => (e12[i] != null && e26[i] != null ? e12[i] - e26[i] : null))
    const dea = emaSeries(dif, 9)
    const rsi = rsiSeries(closes, 14)
    const last = closes.length - 1
    const d = dif[last], e = dea[last]
    const window = closes.slice(-250)
    const m5 = ma5[last], m10 = ma10[last], m20 = ma20[last]
    return {
      price: closes[last],
      pct5: closes.length > 6 ? Number((closes[last] / closes[last - 5] - 1) * 100).toFixed(2) : null,
      pos250: window.length ? Number((window.filter((c) => c <= closes[last]).length / window.length).toFixed(3)) : null,
      ma_state: m5 > m10 && m10 > m20 ? '多头' : (m5 < m10 && m10 < m20 ? '空头' : '纠缠'),
      macd_zone: d > 0 && e > 0 ? '水上' : (d < 0 && e < 0 ? '水下' : '零轴'),
      rsi14: rsi[last] == null ? null : Number(rsi[last].toFixed(1)),
      ma20_dist: m20 ? Number((closes[last] / m20 - 1) * 100).toFixed(2) : null,
    }
  })
}

async function hotPayload() {
  return cached('hot', HOT_TTL, async () => {
    let rows = []
    let source = '10jqka'
    try {
      const txt = await fetchUtf8(
        'https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/stock?stock_type=a&type=hour&list_type=normal',
        { referer: 'https://eq.10jqka.com.cn/', 'user-agent': 'Mozilla/5.0' },
      )
      const d = JSON.parse(txt)
      rows = ((d && d.data && d.data.stock_list) || []).map((x, i) => ({
        rank: Number(x.order) || i + 1,
        code: String(x.code || '').padStart(6, '0'),
        name: x.name || '',
        heat: Number(x.rate) || null,
        pct: Number.isFinite(Number(x.rise_and_fall)) ? Number(x.rise_and_fall) : null,
        rank_chg: Number.isFinite(Number(x.hot_rank_chg)) ? Number(x.hot_rank_chg) : null,
        popularity: (x.tag && x.tag.popularity_tag) || '',
        concepts: ((x.tag && x.tag.concept_tag) || []).slice(0, 4),
      })).filter((r) => /^\d{6}$/.test(r.code))
    } catch (e) {
      rows = []
    }
    if (!rows.length) {
      source = 'guba'
      try {
        const resp = await fetch('https://emappdata.eastmoney.com/stockrank/getAllCurrentList', {
          method: 'POST',
          headers: { 'content-type': 'application/json', referer: 'https://guba.eastmoney.com/', 'user-agent': 'Mozilla/5.0' },
          body: JSON.stringify({ appId: 'appId01', globalId: '786e4c21-70dc-435a-93bb-38', marketType: '', pageNo: 1, pageSize: 100 }),
          signal: AbortSignal.timeout(9000),
        })
        const d = await resp.json()
        rows = ((d && d.data) || []).map((x) => ({
          rank: Number(x.rk) || 0, code: String(x.sc || '').slice(2), name: '',
          heat: null, pct: null, rank_chg: Number(x.hisRc) || 0, popularity: '', concepts: [],
        })).filter((r) => /^\d{6}$/.test(r.code))
      } catch (e) {
        rows = []
      }
    }
    const top = rows.slice(0, 30)
    for (let i = 0; i < top.length; i += 6) {
      await Promise.all(top.slice(i, i + 6).map(async (r) => {
        try {
          const t = await quickTech(r.code)
          if (t) Object.assign(r, t)
        } catch (e) { /* 单只失败不阻塞列表 */ }
      }))
    }
    return { as_of: new Date().toISOString(), source, total: rows.length, rows }
  })
}

/* ----------------------------------------------------------------- routes */

function postRoute(ctx, path, fn) {
  return ctx.webServer.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      // 浏览器信任闸门：refresh / paper/init 这类写接口不能被任意网页触发。
      if (!isTrustedRequest(req, guardOptions(ctx))) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'forbidden' }))
        return
      }
      // exact 路由按 path 命中，不分方法：GET 打 POST 端口会直接执行。
      // 写类动作只认 POST（顺带堵住 <img src=...?run=1> 这种 GET 触发器）。
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'POST' })
        res.end(JSON.stringify({ error: 'method-not-allowed', hint: `POST ${path}` }))
        return
      }
      try {
        const out = await fn(req)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(out))
      } catch (err) {
        const code = err && err.statusCode === 400 ? 400 : 500
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: String(err && err.message || err).slice(0, 500) }))
      }
    },
  })
}

export function apply(ctx) {
  ctx.effect(() => postRoute(ctx, '/api/sector-board/refresh', () => startRefresh()), 'sector-board: refresh route')
  ctx.effect(() => postRoute(ctx, '/api/sector-board/paper/decide', () => paperDecide()), 'sector-board: paper decide route')
  ctx.effect(() => postRoute(ctx, '/api/sector-board/paper/init', (req) => {
    const confirm = new URL(req.url ?? '/', 'http://dsh.internal').searchParams.get('confirm')
    if (confirm !== '1') {
      // 这个端点会把模拟盘账户清空重来（5 笔交易 / 7 条决策），必须显式带上 confirm=1。
      const error = new Error('重置模拟盘需要 confirm=1（会清空账户与交易记录）')
      error.statusCode = 400
      throw error
    }
    return paperInit()
  }), 'sector-board: paper init route')
  ctx.effect(() => postRoute(ctx, '/api/sector-board/robot/run', () => robotRun()), 'sector-board: robot route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/sector-board',
    resource: async (request) => {
      // 闸门同样罩住 GET：Fetch Request 也带 Host/Origin/Sec-Fetch-Site。
      if (!isTrustedRequest(request, guardOptions(ctx))) return json({ error: 'forbidden' }, 403)
      const url = new URL(request.url)
      const path = url.pathname.replace(/\/+$/, '')
      if (path === '/api/sector-board/dashboard.json' || path === '/api/sector-board/data.json') {
        const data = await readJson(join(DATA_DIR, 'dashboard.json'))
        return data ? json(data) : json({ error: 'no-data', dataDir: DATA_DIR }, 404)
      }
      if (path === '/api/sector-board/etf.json') {
        const data = await readJson(join(DATA_DIR, 'etf.json'))
        return data ? json(data) : json({ error: 'no-data', dataDir: DATA_DIR }, 404)
      }
      if (path === '/api/sector-board/status.json') {
        return json(statusNow() || { state: 'idle' })
      }
      if (path === '/api/sector-board/refresh') {
        // GET 不再触发 ETL：以前 `?run=1` 能被任意网页的一个 <img> 打起来，跑满 4 分钟。
        // 刷新只认 POST（走上面那条 exact 路由，带闸门）。
        return json({ error: 'method-not-allowed', hint: 'POST /api/sector-board/refresh' }, 405)
      }
      if (path === '/api/sector-board/quotes.json') {
        const codes = String(url.searchParams.get('codes') || '').split(',').map((s) => s.trim()).filter(Boolean)
        if (!codes.length) return json({ rows: [] })
        return json({ rows: await quotesPayload(codes) })
      }
      if (path === '/api/sector-board/live.json') {
        const codes = String(url.searchParams.get('codes') || '').split(',').map((s) => s.trim()).filter(Boolean)
        if (!codes.length) return json({ error: 'no-codes', rows: [], events: [] }, 400)
        return json(await livePayload(codes))
      }
      if (path === '/api/sector-board/global.json') {
        return json(await globalPayload())
      }
      if (path === '/api/sector-board/search') {
        return json(await searchPayload(url.searchParams.get('q')))
      }
      if (path === '/api/sector-board/events.json') {
        return json(await eventsPayload())
      }
      if (path === '/api/sector-board/hot.json') {
        return json(await hotPayload())
      }
      if (path === '/api/sector-board/stock.json') {
        const code = String(url.searchParams.get('code') || '').trim()
        const period = String(url.searchParams.get('period') || 'day')
        if (!code) return json({ error: 'no-code' }, 400)
        if (period === 'min') return json(await minutePayload(code))
        return json(await stockPayload(code, period))
      }
      if (path === '/api/sector-board/announcements.json') {
        const code = String(url.searchParams.get('code') || '').replace(/^[a-z]{2}/i, '').trim()
        let data = await announcementsPayload(code)
        if (code && (!data || !data.rows.length)) {
          try {
            await announcementsRefresh([code])
            data = await announcementsPayload(code)
          } catch (err) {
            return json({ error: 'fetch-failed', code, detail: String(err && err.message || err).slice(0, 300) }, 502)
          }
        }
        return data ? json(data) : json({ error: 'no-data', hint: 'run python3 announcements.py' }, 404)
      }
      if (path === '/api/sector-board/paper.json') {
        return json(await paperPayload())
      }
      if (path === '/api/sector-board/v3/ui-v3.html') {
        const body = await readFile(join(DOCS_DIR, 'ui-v3.html'))
        return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
      }
      if (path.startsWith('/api/sector-board/v3/')) {
        const rel = path.slice('/api/sector-board/v3/'.length)
        const mime = V3_FILES.get(rel)
        if (!mime) return json({ error: 'not-found', path }, 404)
        const body = await readFile(join(DOCS_DIR, rel))
        return new Response(body, { headers: { 'content-type': mime, 'cache-control': 'no-store' } })
      }
      return json({ error: 'not-found', path }, 404)
    },
  }), 'sector-board: web route')
}
