#!/usr/bin/env node
/**
 * 浏览器 E2E：真实 Host 页面 + Chrome DevTools Protocol。
 * 覆盖：6 tab、周期/行业切换、全部主题龙头、ETF 持仓、搜索、个股抽屉/周期、
 * 盘中排序/刷新、模拟盘、更多、学习、明暗、响应式、控制台错误。
 *
 * 运行：
 *   node tests/ui-e2e.mjs
 *   SB_BASE=http://127.0.0.1:52896 node tests/ui-e2e.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const BASE = (process.env.SB_BASE || 'http://127.0.0.1:52896').replace(/\/+$/, '');
const PAGE = `${BASE}/api/sector-board/v3/ui-v3.html`;
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9400 + (process.pid % 300);
const PROFILE = `/tmp/sb-ui-e2e-${process.pid}`;
const TIMEOUT = 30000;

let pass = 0;
const failures = [];
const pageErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`PASS  ${name}`); })
    .catch((e) => { failures.push({ name, error: String(e?.stack || e?.message || e) }); console.log(`FAIL  ${name}\n      ${e.message}`); });
}

mkdirSync(PROFILE, { recursive: true });
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--window-size=1500,1100', 'about:blank',
], { stdio: 'ignore' });

let ws;
let id = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => {
      if (pending.has(i)) { pending.delete(i); reject(new Error(`CDP timeout: ${method}`)); }
    }, TIMEOUT);
  });
}
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'Runtime exception');
  return r.result.value;
}
async function waitFor(expression, timeout = 15000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { if (await ev(expression)) return true; } catch (e) { last = e; }
    await sleep(200);
  }
  throw new Error(`waitFor timeout: ${expression}${last ? ` (${last.message})` : ''}`);
}
async function click(selector) {
  const ok = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
  assert.ok(ok, `找不到可点击元素: ${selector}`);
  await sleep(180);
}
async function closeDrawer() {
  if (await ev(`document.querySelector('#drawer')?.classList.contains('open')`)) {
    await click('#closeDrawer');
    await waitFor(`!document.querySelector('#drawer')?.classList.contains('open')`, 3000);
  }
}
async function text(selector) {
  return ev(`document.querySelector(${JSON.stringify(selector)})?.innerText || ''`);
}

async function main() {
  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((x) => x.type === 'page');
      if (target) break;
    } catch {}
    await sleep(200);
  }
  assert.ok(target, 'Chrome 未启动');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push({ type: 'exception', text: m.params.exceptionDetails?.text || 'exception' });
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      pageErrors.push({ type: 'console.error', text: (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ') });
    }
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: PAGE });
  await sleep(1200);
  await waitFor(`document.querySelector('#boot')?.hidden === true`, 30000).catch(async () => {
    const boot = await text('#boot');
    throw new Error(`页面未进入可用状态: ${boot}`);
  });
  await sleep(2500);

  await test('页面加载：6 tab、实盘页脚、无演示数据', async () => {
    assert.equal(await ev(`document.querySelectorAll('.nav button').length`), 6);
    assert.equal(await ev(`document.querySelectorAll('.page').length`), 6);
    const foot = await text('#footNote');
    assert.ok(foot.includes('Host ETL') || foot.includes('数据源'), `foot=${foot}`);
    assert.ok(!(await ev(`document.body.innerText.includes('演示')`)), '页面仍出现“演示”');
    assert.ok(!(await ev(`document.body.innerText.includes('模拟数据')`)), '页面仍出现“模拟数据”');
    assert.ok((await text('#page-today')).length > 500);
  });

  await test('今日：7 指数、4 格数据健康、阶段卡、梯队/主线', async () => {
    assert.equal(await ev(`document.querySelectorAll('#ribbon .idx').length`), 7);
    assert.equal(await ev(`document.querySelectorAll('#page-today .health-item').length`), 4);
    await waitFor(`document.querySelector('#page-today .phase-card .phase-badge')`, 15000);
    const phase = await text('#page-today .phase-card');
    assert.ok(phase.includes('市场阶段'));
    assert.ok(phase.includes('涨停') && phase.includes('连板') && phase.includes('晋级率'));
    const health = await text('#page-today .health-strip');
    assert.ok(health.includes('ETL 快照') && health.includes('全市场行情') && health.includes('连板梯队'));
  });

  await test('主导航 6 个 tab 均可切换且内容非空', async () => {
    const tabs = ['today', 'sectors', 'live', 'paper', 'more', 'learn'];
    for (const tab of tabs) {
      await click(`.nav button[data-tab="${tab}"]`);
      const visible = await ev(`!document.querySelector('#page-${tab}').hidden`);
      assert.ok(visible, `${tab} 未显示`);
      const len = (await text(`#page-${tab}`)).length;
      assert.ok(len > 400, `${tab} 内容过少: ${len}`);
    }
    await click('.nav button[data-tab="sectors"]');
  });

  await test('板块：行业/周期切换、光伏龙头业务纯度', async () => {
    await click('[data-mode="industry"]');
    const indRows = await ev(`document.querySelectorAll('#page-sectors tbody tr').length`);
    assert.ok(indRows >= 30, `industry rows=${indRows}`);
    await click('#page-sectors tbody tr');
    assert.ok((await text('#page-sectors .detail-title h2')).length > 0);
    await click('[data-mode="theme"]');
    const themeRows = await ev(`document.querySelectorAll('#page-sectors tbody tr').length`);
    assert.equal(themeRows, 11);
    await click('[data-theme="光伏"]');
    await waitFor(`document.querySelector('#page-sectors .detail-title h2')?.innerText === '光伏'`, 3000);
    const names = await ev(`[...document.querySelectorAll('#page-sectors .stock-mini .nm')].map(x => x.innerText)`);
    assert.equal(JSON.stringify(names), JSON.stringify(['隆基绿能', '通威股份', '阳光电源', '晶澳科技', '天合光能', '福斯特']));
    const lead = await text('#page-sectors .detail-title .meta');
    assert.ok(lead.includes('隆基绿能'), `lead=${lead}`);
    assert.ok(!(await ev(`document.querySelector('#page-sectors').innerText.includes('比亚迪')`)), '光伏详情仍出现比亚迪');
  });

  await test('ETF：可点击并显示前十大持仓，持仓股可再打开', async () => {
    await click('[data-etf="515790"]');
    await waitFor(`document.querySelector('#drawer')?.classList.contains('open')`, 4000);
    await waitFor(`document.querySelectorAll('#drawerContent .hold-row').length >= 8`, 15000);
    const title = await text('#drawerContent h2');
    assert.ok(title.includes('光伏ETF'), `drawer=${title}`);
    const holds = await ev(`document.querySelectorAll('#drawerContent .hold-row').length`);
    assert.equal(holds, 10);
    const body = await text('#drawerContent');
    assert.ok(body.includes('2026-09-30'), '缺少披露截止日');
    assert.ok(body.includes('前十大'), '缺少“前十大”说明');
    await click('#drawerContent .hold-row');
    await waitFor(`document.querySelector('#drawerContent h2')?.innerText === '特变电工'`, 10000);
    await closeDrawer();
  });

  await test('搜索：600519 打开贵州茅台，周期按钮可切换', async () => {
    await click('#q');
    await ev(`(() => { const q = document.querySelector('#q'); q.value = '600519'; q.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitFor(`document.querySelector('#sugg').classList.contains('on')`, 5000);
    await waitFor(`document.querySelectorAll('#sugg .row').length > 0`, 5000);
    await click('#sugg .row');
    await waitFor(`document.querySelector('#drawer')?.classList.contains('open')`, 5000);
    await waitFor(`document.querySelector('#drawerContent h2')?.innerText === '贵州茅台'`, 10000);
    for (const p of ['week', 'month', 'day', 'intraday']) {
      const ok = await ev(`(() => { const b = document.querySelector('[data-period="${p}"]'); if (!b) return false; b.click(); return b.classList.contains('active'); })()`);
      assert.ok(ok, `周期按钮 ${p}`);
      await sleep(120);
    }
    await closeDrawer();
    await ev(`(() => { const q = document.querySelector('#q'); q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  });

  await test('盘中：5 KPI、3 个排序按钮、手动刷新', async () => {
    await click('.nav button[data-tab="live"]');
    await waitFor(`document.querySelector('#page-live') && !document.querySelector('#page-live').hidden`, 3000);
    assert.equal(await ev(`document.querySelectorAll('#page-live .live-kpis > div').length`), 5);
    for (const s of ['speed', 'vr', 'pct']) {
      await click(`[data-live-sort="${s}"]`);
      assert.ok(await ev(`document.querySelector('[data-live-sort="${s}"]').classList.contains('on')`), `sort ${s}`);
    }
    await click('[data-live-refresh]');
    await sleep(1800);
  });

  await test('模拟盘：KPI/持仓点击/提示按钮', async () => {
    await click('.nav button[data-tab="paper"]');
    assert.equal(await ev(`document.querySelectorAll('#page-paper .kpis > div').length`), 4);
    const paperMeta = await (await fetch(`${BASE}/api/sector-board/paper.json`)).json();
    const paperText = await text('#page-paper');
    const latestDecision = (paperMeta.decisions || [])[0] || {};
    const ledgerDate = String(paperMeta.updated_at || '').slice(0, 16).replace('T', ' ');
    assert.ok(paperText.includes(String(latestDecision.date || '')), `最近决策日期未显示: ${latestDecision.date}`);
    assert.ok(paperText.includes(String(ledgerDate)), `账本更新时间未显示: ${ledgerDate}`);
    assert.ok(paperText.includes(String(latestDecision.action || '')), `最近决策动作未显示: ${latestDecision.action}`);
    const pos = await ev(`document.querySelector('#page-paper tbody tr[data-stock]')?.dataset.stock || ''`);
    if (pos) {
      await click('#page-paper tbody tr[data-stock]');
      await waitFor(`document.querySelector('#drawer')?.classList.contains('open')`, 4000);
      await closeDrawer();
    }
    await click('#page-paper [data-toast]');
    await waitFor(`document.querySelector('#toast')?.classList.contains('on')`, 2000);
  });

  await test('更多：红利/全球/事件均非空，红利行可打开', async () => {
    await click('.nav button[data-tab="more"]');
    assert.equal(await ev(`document.querySelectorAll('#page-more .event-card').length`), 6);
    assert.ok(await ev(`document.querySelectorAll('#page-more .global-col').length`) >= 4);
    assert.ok(await ev(`document.querySelectorAll('#page-more tbody tr').length`) >= 5);
    const code = await ev(`document.querySelector('#page-more tbody tr[data-stock]')?.dataset.stock || ''`);
    if (code) {
      await click('#page-more tbody tr[data-stock]');
      await waitFor(`document.querySelector('#drawer')?.classList.contains('open')`, 4000);
      await closeDrawer();
    }
  });

  await test('学习：30 天网格、切换天、标记完成持久化', async () => {
    await click('.nav button[data-tab="learn"]');
    assert.equal(await ev(`document.querySelectorAll('#page-learn .lday').length`), 30);
    await click('[data-learn-day="2"]');
    assert.ok((await text('#page-learn h1')).includes('第 2 天'));
    await click('[data-learn-done="2"]');
    const saved = await ev(`localStorage.getItem('sb-learn-done-v1') || ''`);
    assert.ok(saved.includes('2'), `learn storage=${saved}`);
  });

  await test('明暗切换与无控制台错误', async () => {
    await click('#themeBtn');
    assert.equal(await ev(`document.documentElement.dataset.theme`), 'dark');
    await click('#themeBtn');
    assert.equal(await ev(`document.documentElement.dataset.theme`), 'light');
    assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  });

  await test('按钮可访问性：文本/aria/title 不为空', async () => {
    const bad = await ev(`[...document.querySelectorAll('button')].filter(b => !(b.innerText.trim() || b.getAttribute('aria-label') || b.getAttribute('title'))).map(b => b.outerHTML.slice(0,120))`);
    assert.deepEqual(bad, []);
  });

  await test('响应式 1500/1280/960/860/720 无横向溢出', async () => {
    for (const w of [1500, 1280, 960, 860, 720]) {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: 1000, deviceScaleFactor: 1, mobile: false });
      await sleep(250);
      const r = await ev(`({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, nav: document.querySelector('.nav').scrollWidth, top: document.querySelector('.top-in').scrollWidth })`);
      assert.ok(r.sw <= r.cw + 1, `width ${w}: sw=${r.sw} cw=${r.cw}`);
      assert.ok(r.nav <= r.cw + 1, `nav overflow at ${w}`);
    }
    await send('Emulation.clearDeviceMetricsOverride');
  });

  console.log(`\n结果: ${pass} passed, ${failures.length} failed`);
  if (pageErrors.length) console.log('PAGE ERRORS', JSON.stringify(pageErrors, null, 2));
  if (failures.length) {
    console.log('FAILURES', JSON.stringify(failures, null, 2));
    process.exitCode = 1;
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    try { ws?.close(); } catch {}
    chrome.kill('SIGKILL');
    await sleep(200);
    try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  });
