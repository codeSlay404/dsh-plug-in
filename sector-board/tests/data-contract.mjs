#!/usr/bin/env node
/**
 * 数据可靠性契约测试。
 * 只读：本地 ETL/paper/ETF/公告快照 + Host API + 天天基金 ETF 持仓。
 * 不写任何业务文件，不触发 ETL。
 *
 * 运行：
 *   node tests/data-contract.mjs
 *   SB_BASE=http://127.0.0.1:52896 node tests/data-contract.mjs
 *   SB_SKIP_NETWORK=1 node tests/data-contract.mjs   # 只跑本地/API，不测外部基金接口
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

const ROOT = new URL('..', import.meta.url).pathname;
const DATA = process.env.SB_DATA || join(homedir(), '.dsh', 'sector-board');
const BASE = (process.env.SB_BASE || 'http://127.0.0.1:52896').replace(/\/+$/, '');
const API = `${BASE}/api/sector-board`;
const NETWORK = process.env.SB_SKIP_NETWORK !== '1';
const TIMEOUT = 12000;

let pass = 0;
const failures = [];
const warnings = [];

function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`PASS  ${name}`); })
    .catch((e) => { failures.push({ name, error: String(e && e.message || e) }); console.log(`FAIL  ${name}\n      ${e.message}`); });
}
function warn(name, detail) {
  warnings.push({ name, detail });
  console.log(`WARN  ${name} — ${detail}`);
}
function readJson(name) {
  return JSON.parse(readFileSync(join(DATA, name), 'utf8'));
}
async function getJson(path, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || TIMEOUT);
  try {
    const res = await fetch(path.startsWith('http') ? path : `${API}/${path.replace(/^\/+/, '')}`, { signal: ctrl.signal, headers: opts.headers || {} });
    assert.equal(res.status, 200, `${path} HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
function code6(x) { return String(x || '').replace(/^(sh|sz|bj)/i, '').slice(-6); }
function parseThemeLeaders() {
  const src = readFileSync(join(ROOT, 'docs/assets/ui-v3.js'), 'utf8');
  const start = src.indexOf('const THEME_LEADERS = {');
  const end = src.indexOf('\n  };', start);
  assert.ok(start >= 0 && end > start, 'THEME_LEADERS not found');
  const body = src.slice(start + 'const THEME_LEADERS = '.length, end + 4);
  return vm.runInNewContext(`(${body})`, Object.create(null), { timeout: 1000 });
}
function parseUniverse() {
  const src = readFileSync(join(ROOT, 'docs/assets/universe-data.js'), 'utf8');
  const m = src.match(/window\.SB_UNIVERSE\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
  assert.ok(m, 'SB_UNIVERSE not found');
  return vm.runInNewContext(`(${m[1]})`, Object.create(null), { timeout: 5000 });
}

const dashboard = readJson('dashboard.json');
const paper = readJson('paper.json');
const etf = readJson('etf.json');
const announcements = readJson('announcements.json');
const html = readFileSync(join(ROOT, 'docs/ui-v3.html'), 'utf8');
const uiJs = readFileSync(join(ROOT, 'docs/assets/ui-v3.js'), 'utf8');

console.log(`\n数据可靠性测试`);
console.log(`data: ${DATA}`);
console.log(`api : ${API}`);
console.log(`dashboard: as_of=${dashboard.as_of} total=${dashboard.total}\n`);

await ok('dashboard 基本字段与市场宽度', () => {
  assert.match(String(dashboard.as_of), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(String(dashboard.generated_at), /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(dashboard.total >= 4000, `total=${dashboard.total}`);
  const m = dashboard.market || {};
  assert.ok(m.total >= 4000);
  assert.ok(m.up >= 0 && m.down >= 0 && m.flat >= 0);
  assert.ok(m.up + m.down + m.flat <= m.total + 5, '涨跌平超过总数');
  assert.ok(m.limit_up >= 0 && m.limit_down >= 0);
  assert.ok(m.median_pct == null || (m.median_pct > -30 && m.median_pct < 30));
  const s = dashboard.decision?.sentiment || {};
  assert.ok(s.score >= 0 && s.score <= 100, `sentiment=${s.score}`);
});

await ok('行业 / 概念 / 主题结构完整', () => {
  assert.ok(Array.isArray(dashboard.sectors) && dashboard.sectors.length >= 30, `sectors=${dashboard.sectors.length}`);
  assert.ok(Array.isArray(dashboard.boards?.concept) && dashboard.boards.concept.length >= 100, `concepts=${dashboard.boards?.concept?.length}`);
  assert.equal(dashboard.themes.length, 11, `themes=${dashboard.themes.length}`);
  for (const s of dashboard.sectors) {
    assert.equal(typeof s.name, 'string');
    assert.ok(s.count >= 0);
    assert.ok(s.avg_pct == null || Number.isFinite(Number(s.avg_pct)));
  }
  for (const t of dashboard.themes) {
    assert.equal(typeof t.name, 'string');
    assert.ok(Array.isArray(t.stocks), `${t.name}.stocks`);
    if (t.count > 0) assert.ok(t.stocks.length > 0, `${t.name} 无成分`);
    assert.ok(t.pos250_med == null || (t.pos250_med >= 0 && t.pos250_med <= 1));
  }
});

await ok('THEME_LEADERS 全部在 dashboard 股票池，且光伏命中光伏成分', () => {
  const leaders = parseThemeLeaders();
  const names = Object.keys(leaders);
  assert.ok(names.length >= 10, `leaders=${names.length}`);
  const themes = new Map(dashboard.themes.map((t) => [t.name, t]));
  const allCodes = new Set();
  const nameByCode = new Map();
  for (const t of dashboard.themes) for (const s of t.stocks || []) {
    allCodes.add(code6(s.code)); nameByCode.set(code6(s.code), s.name);
  }
  const forbidden = new Set(['002594', '000651', '600025', '601985', '600406']);
  for (const [theme, codes] of Object.entries(leaders)) {
    const t = themes.get(theme);
    assert.ok(t, `缺少主题 ${theme}`);
    assert.equal(codes.length, 6, `${theme} 龙头数量`);
    assert.equal(new Set(codes.map(code6)).size, 6, `${theme} 龙头重复`);
    const themeCodes = new Set((t.stocks || []).map((s) => code6(s.code)));
    for (const c of codes) {
      assert.ok(allCodes.has(code6(c)), `${theme} 龙头 ${c} 不在 dashboard 股票池`);
      if (theme === '光伏') assert.ok(themeCodes.has(code6(c)), `光伏龙头 ${c} 不在光伏成分`);
      if (theme === '光伏') assert.ok(!forbidden.has(code6(c)), `光伏混入跨行业 ${c}`);
      if (!themeCodes.has(code6(c))) warn(`${theme} 龙头跨主题`, `${c} ${nameByCode.get(code6(c)) || ''}`);
    }
  }
  const photo = leaders['光伏'].map((c) => nameByCode.get(code6(c)));
  assert.equal(JSON.stringify(photo), JSON.stringify(['隆基绿能', '通威股份', '阳光电源', '晶澳科技', '天合光能', '福斯特']));
});

await ok('paper.json 账本字段与净值恒等式', () => {
  assert.ok(Array.isArray(paper.positions));
  assert.ok(Array.isArray(paper.trades));
  assert.ok(Array.isArray(paper.equity) && paper.equity.length > 0);
  assert.ok(paper.cash >= 0);
  for (const p of paper.positions) {
    assert.match(code6(p.code), /^\d{6}$/);
    assert.ok(Number(p.qty) > 0, `${p.code} qty`);
    assert.ok(Number(p.cost) > 0, `${p.code} cost`);
  }
  const last = paper.equity[paper.equity.length - 1];
  assert.ok(Number(last.equity) > 0);
  assert.match(String(paper.updated_at), /^\d{4}-\d{2}-\d{2}/);
});

await ok('Host /paper.json 净值 = 现金 + 持仓市值', async () => {
  const p = await getJson('paper.json');
  assert.ok(Number(p.nav) > 0);
  const mv = (p.positions || []).reduce((a, x) => a + Number(x.mv || 0), 0);
  const calc = Number(p.cash || 0) + mv;
  assert.ok(Math.abs(calc - Number(p.nav)) < 0.05, `nav=${p.nav} calc=${calc}`);
  for (const x of p.positions || []) {
    assert.ok(Number(x.price) > 0, `${x.code} 缺 price`);
    assert.ok(Number(x.pnl_pct) > -100 && Number(x.pnl_pct) < 1000, `${x.code} pnl_pct`);
  }
});

await ok('ETF / 公告快照字段', () => {
  assert.ok(Array.isArray(etf.rows) && etf.rows.length > 500, `etf=${etf.rows.length}`);
  const e = etf.rows.find((x) => code6(x.code) === '515790');
  assert.ok(e, '缺少 515790');
  assert.ok(e.name.includes('光伏'));
  assert.ok(Number.isFinite(Number(e.price)));
  assert.ok(Array.isArray(announcements.rows) && announcements.rows.length > 0);
  assert.match(String(announcements.as_of), /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(announcements.rows.some((x) => code6(x.code) === '600519'), '公告缺 600519');
  for (const x of announcements.rows.slice(0, 20)) {
    assert.match(code6(x.code), /^\d{6}$/);
    assert.ok(x.title && x.date && x.url);
    assert.ok(/^https?:\/\//.test(x.url));
  }
});

await ok('universe-data 与 dashboard 规模一致（容差 10）', () => {
  const u = parseUniverse();
  assert.ok(Array.isArray(u.codes));
  assert.equal(new Set(u.codes.map(code6)).size, u.codes.length, 'universe codes 重复');
  assert.ok(Math.abs(u.codes.length - dashboard.total) <= 10, `universe=${u.codes.length} dashboard=${dashboard.total}`);
  if (u.codes.length !== dashboard.total) warn('universe 与 dashboard 数量差异', `${u.codes.length} vs ${dashboard.total}`);
  assert.ok(u.industry && typeof u.industry === 'object');
});

await ok('前端不再加载/生成演示数据', () => {
  assert.ok(!/assets\/mock-data/.test(html), 'HTML 仍加载 mock-data');
  assert.ok(!/window\.MOCK/.test(uiJs), 'JS 仍读 window.MOCK');
  assert.ok(!/genBars\s*\(/.test(uiJs), 'JS 仍有 genBars');
  assert.ok(!/demoLive\s*\(/.test(uiJs), 'JS 仍有 demoLive');
  assert.ok(!/PULSE/.test(uiJs), 'JS 仍有 PULSE');
  assert.ok(!/演示数据|演示快照|演示行情/.test(uiJs), 'JS 仍有演示文案');
});

await ok('Host dashboard / stock / search / live 契约', async () => {
  const d = await getJson('dashboard.json');
  assert.equal(d.as_of, dashboard.as_of);
  assert.ok(Array.isArray(d.themes) && d.themes.length === 11);

  const day = await getJson('stock.json?code=600519&period=day');
  assert.equal(code6(day.code), '600519');
  assert.ok(Array.isArray(day.bars) && day.bars.length >= 30, `bars=${day.bars?.length}`);
  assert.ok(Number(day.quote?.price) > 0, 'quote.price');
  assert.ok(day.bars[0].d && day.bars[0].c != null);

  const min = await getJson('stock.json?code=600519&period=min');
  assert.ok(Array.isArray(min.points) && min.points.length > 10, `min=${min.points?.length}`);
  assert.ok(min.points[0].t && Number(min.points[0].p) > 0);

  const search = await getJson('search?q=' + encodeURIComponent('茅台'));
  assert.ok(Array.isArray(search.rows) && search.rows.some((x) => code6(x.code) === '600519'));

  const live = await getJson('live.json?codes=600519,000001');
  assert.ok(Array.isArray(live.rows) && live.rows.length >= 2);
  for (const r of live.rows) assert.ok(Number.isFinite(Number(r.pct)), `${r.code} pct`);
});

if (NETWORK) {
  await ok('外部 ETF 持仓接口返回前十大且权重合法', async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch('https://fundmobapi.eastmoney.com/FundMNewApi/FundMNInverstPosition?FCODE=515790&deviceid=1&plat=Android&product=EFund&version=1', { signal: ctrl.signal });
      assert.equal(res.status, 200);
      const j = await res.json();
      const rows = j?.Datas?.fundStocks || [];
      assert.ok(rows.length >= 8, `holdings=${rows.length}`);
      const sum = rows.reduce((a, x) => a + Number(x.JZBL || 0), 0);
      assert.ok(sum > 20 && sum <= 100.01, `weight sum=${sum}`);
      assert.ok(j.Expansion && /2026-\d{2}-\d{2}/.test(String(j.Expansion)), `as_of=${j.Expansion}`);
      for (const x of rows.slice(0, 3)) assert.ok(code6(x.GPDM).match(/^\d{6}$/) && x.GPJC);
    } finally { clearTimeout(timer); }
  });
} else {
  warn('外部 ETF 持仓接口', 'SB_SKIP_NETWORK=1，已跳过');
}

if (announcements.as_of < dashboard.as_of) {
  warn('公告快照落后于 dashboard', `announcements=${announcements.as_of} dashboard=${dashboard.as_of}`);
}

console.log(`\n结果: ${pass} passed, ${failures.length} failed, ${warnings.length} warnings`);
if (warnings.length) console.log('WARNINGS', JSON.stringify(warnings, null, 2));
if (failures.length) {
  console.log('FAILURES', JSON.stringify(failures, null, 2));
  process.exit(1);
}
