/* 股票分析 v3 — signal-first UI. All data comes from the Host API; no demo fallback. */
(() => {
  function emptyModel() {
    return {
      meta: { as_of: '', generated_at: '', source: '', demo: false, ready: false },
      market: { total: 0, up: 0, down: 0, flat: 0, limit_up: 0, limit_down: 0, avg_pct: null, median_pct: null, tech: {} },
      signals: {}, decision: { sentiment: {}, leaders: [], risks: [] },
      sectors: [], concepts: [], themes: [], theme_groups: [],
      lhb: { rows: [], summary: {} }, youzi: { stocks: [], seats: [] },
      dividend: { rows: [], summary: {} },
      paper: { initial: 0, cash: 0, nav: 0, total_pnl: 0, total_pnl_pct: 0, positions_value: 0, positions: [], trades: [], decisions: [], equity: [], robot: {} },
      events: { rows: [] }, global: [], indices: [], etfs: [], hot: { rows: [], total: 0 },
      stock: null, liveIndices: null, liveUpdatedAt: null,
      ladder: { as_of: '', days: [], today: null, phase: null, loading: false, error: '', updated_at: '' },
    };
  }
  const M = emptyModel();
  const FULL = (typeof window !== 'undefined' && window.SB_UNIVERSE) || null;

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  function showBoot(text, title = '正在读取真实数据') {
    const el = $('#boot');
    if (!el) return;
    el.hidden = false;
    el.classList.remove('err');
    const t = $('#bootTitle'), p = $('#bootText'), b = $('#bootRetry');
    if (t) t.textContent = title;
    if (p) p.textContent = text || '连接 Host 数据接口…';
    if (b) b.hidden = true;
  }
  function failBoot(text, title = '真实数据加载失败') {
    const el = $('#boot');
    if (!el) return;
    el.hidden = false;
    el.classList.add('err');
    const t = $('#bootTitle'), p = $('#bootText'), b = $('#bootRetry');
    if (t) t.textContent = title;
    if (p) p.textContent = text || '无法连接 Host 数据接口。请从 DSH 面板打开，或检查服务是否在运行。';
    if (b) b.hidden = false;
  }
  function hideBoot() {
    const el = $('#boot');
    if (el) el.hidden = true;
  }
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  const nf = (v, d = 0) => {
    const x = num(v);
    return x == null ? '—' : x.toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
  };
  const pt = (v, d = 2) => {
    const x = num(v);
    return x == null ? '—' : `${x > 0 ? '+' : ''}${x.toFixed(d)}%`;
  };
  const cls = (v) => (num(v) == null ? 'flat' : v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
  const money = (v) => {
    const x = num(v);
    if (x == null) return '—';
    if (Math.abs(x) >= 1e8) return `${(x / 1e8).toFixed(2)} 亿`;
    if (Math.abs(x) >= 1e4) return `${(x / 1e4).toFixed(0)} 万`;
    return `${x.toFixed(0)}`;
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /* ---------- tiny deterministic PRNG ---------- */
  const hash = (s) => {
    let h = 2166136261;
    for (let i = 0; i < String(s).length; i++) {
      h ^= String(s).charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  };
  const rng = (seed) => {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  /* ---------- dates / bars / indicators ---------- */
  const pad = (n) => String(n).padStart(2, '0');
  const dstr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  function businessDays(end, n) {
    const out = [];
    const d = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    while (out.length < n) {
      const day = d.getDay();
      if (day !== 0 && day !== 6) out.unshift(dstr(d));
      d.setDate(d.getDate() - 1);
    }
    return out;
  }

  /* ---------- limit-up ladder / emotion phase ---------- */
  const LADDER_UT = '7eea3edcaed734bea9cbfc24409ed989';
  const LADDER_CACHE = 'sb-ladder-v2:';
  const PHASE_LABEL = { ice: '冰点', ignite: '启动', main: '主升', climax: '高潮', ebb: '退潮', repair: '修复' };
  const PHASE_CLS = { ice: 'cold', ignite: 'accent', main: 'hot', climax: 'hot', ebb: 'warn', repair: '' };

  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        out[i] = await fn(items[i], i);
      }
    });
    await Promise.all(workers);
    return out;
  }

  function ladderCacheRead(asof) {
    try {
      const raw = localStorage.getItem(LADDER_CACHE + asof);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || !Array.isArray(obj.days) || !obj.days.length) return null;
      if (Date.now() - (obj.ts || 0) > 20 * 60 * 1000) return null;
      return obj;
    } catch { return null; }
  }
  function ladderCacheWrite(asof, days) {
    try { localStorage.setItem(LADDER_CACHE + asof, JSON.stringify({ ts: Date.now(), days })); } catch { /* quota / privacy */ }
  }

  function ladderDayFromJson(date, data) {
    if (!data || !Array.isArray(data.pool) || !data.pool.length) return null;
    const pool = data.pool.map((x) => ({
      code: String(x.c || ''), name: x.n || '', pct: num(x.zdp),
      lbc: Number(x.lbc) || 0, industry: x.hybk || '', amount: num(x.amount),
      first: x.fbt || null, last: x.lbt || null,
    })).filter((x) => /^\d{6}$/.test(x.code));
    if (!pool.length) return null;
    const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let max = 0;
    for (const x of pool) {
      if (x.lbc >= 5) counts[5] += 1; else if (x.lbc >= 1) counts[x.lbc] += 1;
      if (x.lbc > max) max = x.lbc;
    }
    const lu = pool.length;
    const first = counts[1];
    return { date, lu, first, ge2: lu - first, max, counts, pool, codes: pool.map((x) => x.code) };
  }

  function ladderMetrics(days) {
    for (let i = 0; i < days.length; i++) {
      const d = days[i], prev = days[i - 1];
      if (!prev) { d.promo = null; continue; }
      const prevCodes = new Set(prev.codes || []);
      const cont = (d.codes || []).filter((c) => prevCodes.has(c)).length;
      d.promo = prevCodes.size ? cont / prevCodes.size : null;
    }
    return days;
  }

  function rawEmotionPhase(d, prev) {
    if (!d) return 'ice';
    if (d.lu <= 20) return 'ice';
    if (d.ge2 >= 50 || d.first >= 180 || d.max >= 10) return 'climax';
    if (d.max >= 7 && d.ge2 >= 18 && d.promo != null && d.promo >= 0.25) return 'main';
    if ((prev && d.ge2 - prev.ge2 >= 3 && d.ge2 >= 8) || (d.max >= 5 && d.promo != null && d.promo >= 0.18)) return 'ignite';
    if (d.promo != null && d.promo < 0.15 && prev && (prev.ge2 >= 10 || prev.lu >= 60)) return 'ebb';
    if (d.lu < 35 && d.ge2 <= 8) return 'ice';
    return 'repair';
  }

  function emotionPhase(days) {
    if (!days.length) return null;
    const raw = days.map((d, i) => rawEmotionPhase(d, days[i - 1]));
    const confirmed = [];
    for (let i = 0; i < raw.length; i++) {
      if (i === 0) confirmed.push(raw[0]);
      else if (raw[i] === raw[i - 1]) confirmed.push(raw[i]);
      else confirmed.push(confirmed[i - 1]);
    }
    let stage = confirmed[confirmed.length - 1];
    let duration = 1;
    for (let i = confirmed.length - 2; i >= 0 && confirmed[i] === stage; i--) duration += 1;
    const last = days[days.length - 1];
    const weak = M.market.total ? M.market.down / M.market.total > 0.8 : false;
    const vetoed = weak && ['ignite', 'main', 'climax'].includes(stage);
    if (vetoed) stage = 'ebb';
    return {
      stage, raw: raw[raw.length - 1], duration, vetoed, weak,
      label: PHASE_LABEL[stage] || stage, cls: PHASE_CLS[stage] || '',
      date: last.date, lu: last.lu, first: last.first, ge2: last.ge2, max: last.max,
      promo: last.promo, counts: last.counts, pool: last.pool,
    };
  }

  function mainlineRows(n = 4) {
    return (M.concepts || [])
      .filter((c) => c && c.name && num(c.avg_pct) != null && (c.count || 0) >= 5)
      .map((c) => {
        const count = c.count || 1;
        const upRatio = (c.up || 0) / count;
        const luRatio = (c.limit_up || 0) / count;
        const score = (c.avg_pct || 0) * 10 + upRatio * 30 + luRatio * 60;
        const lead = (c.peers || [])[0];
        return { ...c, upRatio, score, lead };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, n);
  }

  async function fetchLadder(force = false) {
    if (M.ladder.loading) return;
    const asof = String(M.meta.as_of || '').slice(0, 10);
    if (!asof) return;
    if (!force && M.ladder.days && M.ladder.days.length && M.ladder.as_of === asof) return;
    const cached = force ? null : ladderCacheRead(asof);
    if (cached) {
      M.ladder = { ...M.ladder, as_of: asof, days: cached.days, today: cached.days[cached.days.length - 1], phase: emotionPhase(cached.days), loading: false, error: '', updated_at: new Date(cached.ts).toISOString() };
      refreshCurrent();
      return;
    }
    M.ladder = { ...M.ladder, loading: true, error: '', as_of: asof };
    refreshCurrent();
    try {
      if (!canFetchApi()) throw new Error('静态预览无法读取连板数据');
      const dates = businessDays(new Date(`${asof}T00:00:00`), 20).filter((d) => d <= asof);
      const results = await mapLimit(dates, 5, async (date) => {
        const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = ctl ? setTimeout(() => ctl.abort(), 10000) : null;
        try {
          const url = `https://push2ex.eastmoney.com/getTopicZTPool?ut=${LADDER_UT}&dpt=wz.ztzt&Pageindex=0&pagesize=1000&sort=fbt%3Aasc&date=${date.replace(/-/g, '')}`;
          const r = await fetch(url, { cache: 'no-store', signal: ctl ? ctl.signal : undefined });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const j = await r.json();
          return ladderDayFromJson(date, j && j.data);
        } catch { return null; } finally { if (timer) clearTimeout(timer); }
      });
      const days = ladderMetrics(results.filter(Boolean));
      if (!days.length) throw new Error('连板数据为空');
      const today = days[days.length - 1];
      M.ladder = { as_of: asof, days, today, phase: emotionPhase(days), loading: false, error: '', updated_at: new Date().toISOString() };
      ladderCacheWrite(asof, days);
    } catch (err) {
      M.ladder = { ...M.ladder, loading: false, error: String(err && err.message ? err.message : err) };
    } finally {
      refreshCurrent();
    }
  }

  function healthStrip() {
    const stale = staleInfo();
    const asof = String(M.meta.as_of || '').slice(0, 10) || '—';
    const gen = M.meta.generated_at ? clockText(M.meta.generated_at) : '—';
    const cov = LIVE.coverage == null ? null : Math.round(LIVE.coverage * 100);
    const liveTxt = LIVE.source === 'api' ? `${cov == null ? '—' : `${cov}%`} · ${clockText(LIVE.updated_at)}` : LIVE.source === 'error' ? '接口不可用' : '读取中';
    const ladder = M.ladder || {};
    const ladderTxt = ladder.loading ? '读取中' : ladder.error ? '不可用' : ladder.today ? `${ladder.today.date} · ${ladder.today.lu} 只` : '待读取';
    const members = FULL && FULL.codes ? FULL.codes.length : null;
    const item = (k, v, ok, note) => `<span class="health-item"><i class="health-dot ${ok ? 'ok' : 'warn'}"></i><span><b>${esc(k)}</b> ${esc(v)}${note ? `<em>${esc(note)}</em>` : ''}</span></span>`;
    return `<div class="health-strip">
      ${item('ETL 快照', `${asof} ${gen}`, !stale, stale ? '滞后' : '每日')}
      ${item('全市场行情', liveTxt, LIVE.source === 'api' && (cov == null || cov >= 99), cov != null && cov < 99 ? '部分覆盖' : '15 秒')}
      ${item('连板梯队', ladderTxt, !!ladder.today && !ladder.error, ladder.days ? `${ladder.days.length} 日样本` : '东财')}
      ${item('成员表', members ? `${nf(members)} 只` : '未加载', !!members, FULL ? '本地' : '')}
    </div>`;
  }

  function phaseCard() {
    const L = M.ladder || {};
    const p = L.phase;
    if (L.loading) return `<section class="card phase-card"><div class="card-h"><h2>市场阶段</h2><span class="meta">连板模型</span></div><div class="empty">正在读取涨停池与连板梯队…</div></section>`;
    if (L.error) return `<section class="card phase-card"><div class="card-h"><h2>市场阶段</h2><span class="meta">连板模型</span></div><div class="empty">连板数据不可用：${esc(L.error)}<br><button class="btn tiny" data-action="ladder">重试</button></div></section>`;
    if (!p) return `<section class="card phase-card"><div class="card-h"><h2>市场阶段</h2><span class="meta">连板模型</span></div><div class="empty">等待连板数据。</div></section>`;
    const counts = p.counts || {};
    const pool = p.pool || [];
    const byBoard = (n) => pool.filter((x) => (n === 5 ? x.lbc >= 5 : x.lbc === n)).slice(0, 4);
    const ladderRow = (n, label) => {
      const arr = byBoard(n);
      if (!arr.length) return '';
      return `<div class="ladder-row"><span class="lb">${label}</span><div class="ladder-names">${arr.map((x) => `<span data-stock="${esc(x.code)}">${esc(x.name)}<em>${esc(x.industry || '')}</em></span>`).join('')}</div><b>${counts[n] || arr.length}</b></div>`;
    };
    const main = mainlineRows(4);
    const mainTitle = main.length && num(main[0].avg_pct) >= 0 ? '今日主线 · 概念' : '今日相对强势 · 概念';
    const promoTxt = p.promo == null ? '—' : `${Math.round(p.promo * 100)}%`;
    return `<section class="card phase-card">
      <div class="card-h"><h2>市场阶段</h2><span class="meta">连板模型 · 东财 · ${L.days.length} 日</span></div>
      <div class="phase-head">
        <span class="phase-badge ${p.cls}">${esc(p.label)}</span>
        <div class="phase-copy"><b>${esc(p.label)} · 第 ${p.duration} 天</b><small>${esc(p.date)} · 原始 ${esc(PHASE_LABEL[p.raw] || p.raw)}${p.vetoed ? ' · 弱档否决' : ''}</small></div>
      </div>
      <div class="phase-metrics">
        <span><b>${nf(p.lu)}</b><em>涨停</em></span>
        <span><b>${nf(p.ge2)}</b><em>连板</em></span>
        <span><b>${nf(p.max)}</b><em>最高板</em></span>
        <span><b>${promoTxt}</b><em>晋级率</em></span>
      </div>
      <div class="ladder-bars">
        ${[1, 2, 3, 4, 5].map((n) => `<div class="ladder-bar"><span>${n === 5 ? '5+' : n} 板</span><i style="width:${Math.max(4, ((counts[n] || 0) / Math.max(1, p.lu)) * 100)}%"></i><b>${counts[n] || 0}</b></div>`).join('')}
      </div>
      <div class="ladder-list">${ladderRow(5, '5板+')}${ladderRow(4, '4板')}${ladderRow(3, '3板')}${ladderRow(2, '2板')}${ladderRow(1, '首板')}</div>
      <div class="mainline">
        <div class="rank-sep">${mainTitle}</div>
        ${main.map((c, i) => `<div class="mainline-row" data-stock="${c.lead ? esc(c.lead.code) : ''}"><span class="idx">${i + 1}</span><span class="nm">${esc(c.name)}</span><span class="why">${c.count} 只 · ${Math.round(c.upRatio * 100)}% 上涨 · 涨停 ${c.limit_up || 0}</span><span class="pct up">${pt(c.avg_pct)}</span></div>`).join('')}
      </div>
    </section>`;
  }

  function auctionRows() {
    const phase = marketPhase();
    if (phase.label !== '集合竞价') return [];
    const indexSet = new Set(Object.values(INDEX_CODE));
    return (LIVE.rows || [])
      .filter((r) => r && /^\d{6}$/.test(code6(r.code)) && !indexSet.has(canonRow(r.code)) && num(r.pct) != null)
      .filter((r) => Math.abs(r.pct) >= 3 || (num(r.amount) || 0) >= 5000)
      .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
      .slice(0, 8)
      .map((r) => ({ ...r, tag: r.pct >= 5 ? '高开' : r.pct <= -3 ? '低开' : '放量' }));
  }

  function auctionCard() {
    const phase = marketPhase();
    const rows = auctionRows();
    const body = phase.label !== '集合竞价'
      ? `<div class="live-empty"><b>当前${esc(phase.label)}，不在竞价时段。</b><br>下一交易日 09:15–09:25 自动扫描：高开 ≥5%、低开 ≤-3%、成交额 ≥5000 万。</div>`
      : rows.length
        ? rows.map((r) => `<div class="auction-row" data-stock="${esc(r.code)}"><span class="tag ${r.tag === '低开' ? 'cold' : 'hot'}">${r.tag}</span><span class="who"><b>${esc(r.name || r.code)}</b><small>${esc(r.code)}</small></span><span class="pct ${cls(r.pct)}">${pt(r.pct)}</span><span class="amt">${money((r.amount || 0) * 1e4)}</span></div>`).join('')
        : `<div class="live-empty">竞价扫描已开启，本轮没有触发阈值。</div>`;
    return `<section class="card auction-card"><div class="card-h"><h2>竞价异动</h2><span class="meta">09:15–09:25 · 高开/低开/放量</span></div>${body}</section>`;
  }

  /* ---------- live API helpers ---------- */
  function apiAvailable() {
    return canFetchApi();
  }
  async function jget(path) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), 15000) : null;
    try {
      const r = await fetch('/api/sector-board/' + path, { credentials: 'same-origin', signal: ctl ? ctl.signal : undefined });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  function ma(closes, p) {
    const out = [];
    let sum = 0;
    for (let i = 0; i < closes.length; i++) {
      sum += closes[i];
      if (i >= p) sum -= closes[i - p];
      out.push(i >= p - 1 ? sum / p : null);
    }
    return out;
  }
  function ema(closes, p) {
    const k = 2 / (p + 1);
    const out = [];
    let e = closes[0];
    for (let i = 0; i < closes.length; i++) {
      e = i === 0 ? closes[0] : closes[i] * k + e * (1 - k);
      out.push(e);
    }
    return out;
  }
  function macd(closes) {
    const e12 = ema(closes, 12);
    const e26 = ema(closes, 26);
    const dif = closes.map((_, i) => e12[i] - e26[i]);
    const dea = ema(dif, 9);
    const hist = dif.map((v, i) => (v - dea[i]) * 2);
    return { dif, dea, hist };
  }
  function rsi(closes, p = 14) {
    const out = [null];
    let gain = 0, loss = 0;
    for (let i = 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      const g = Math.max(0, d), l = Math.max(0, -d);
      if (i <= p) {
        gain += g; loss += l;
        if (i === p) {
          gain /= p; loss /= p;
          out.push(loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
        } else out.push(null);
      } else {
        gain = (gain * (p - 1) + g) / p;
        loss = (loss * (p - 1) + l) / p;
        out.push(loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
      }
    }
    return out;
  }
  function lastCross(dif, dea) {
    for (let i = dif.length - 1; i > 0; i--) {
      const prev = dif[i - 1] - dea[i - 1];
      const now = dif[i] - dea[i];
      if (prev <= 0 && now > 0) return { type: '金叉', i };
      if (prev >= 0 && now < 0) return { type: '死叉', i };
    }
    return { type: '无', i: -1 };
  }

  /* ---------- theme notes / etfs ---------- */
  const NOTES = {
    '半导体': {
      what: '设计、制造、封测、设备材料。A 股最大的科技权重，也是科创 50 的主要构成。',
      cycle: '成长周期。库存周期 + AI 资本开支，看存储价格、晶圆厂稼动率、设备招标。',
      clear: '出清看库存周转见顶回落、资本开支下修、落后产能退出；反转确认看存储价格止跌、龙头稼动率回升。',
      watch: ['存储价格', '晶圆厂稼动率', '设备招标', '费城半导体'],
    },
    'CPO/光模块': {
      what: 'AI 算力网络里的光互联环节，跟着北美云厂商的资本开支走。',
      cycle: '成长周期。看 800G/1.6T 出货、北美云厂商 capex、光芯片供给。',
      clear: '出清看订单下修、库存积压、二线厂商退出；反转看大客户上修资本开支、龙头订单回暖。',
      watch: ['北美云 capex', '800G 出货', '光芯片价格', '在手订单'],
    },
    '机器人': {
      what: '人形机器人、工业自动化、核心零部件。A 股主题覆盖 700 多只，估值弹性大。',
      cycle: '渗透率早期。看特斯拉 Optimus 产量、零部件定点、降本曲线。',
      clear: '出清看融资收缩、项目暂停、估值回落；反转看定点落地、量产时间表前移。',
      watch: ['Optimus 产量', '零部件定点', '单台成本', '融资额'],
    },
    '猪肉': {
      what: '养殖、饲料、屠宰。猪价决定利润，能繁母猪存栏决定约 10 个月后的供给。',
      cycle: '强周期。猪价跌破现金成本 → 养殖户亏损 → 能繁母猪去化 → 供给收缩 → 猪价反转。',
      clear: '出清确认看三件事：能繁母猪存栏同比转负、行业连续亏损、猪价止跌。反转通常先涨预期，再涨价格。',
      watch: ['能繁母猪存栏', '猪粮比', '自繁自养利润', '行业资产负债率'],
    },
    '影视': {
      what: '院线、内容制作、发行。票房和排片是短期最直接的变量。',
      cycle: '内容周期。看票房大盘、档期排片、单银幕产出。',
      clear: '出清看中小影院退出、内容公司减值；反转看爆款影片、票房同比转正。',
      watch: ['票房大盘', '档期排片', '单银幕产出', '内容储备'],
    },
    '光伏': {
      what: '硅料、硅片、电池、组件、逆变器。典型的产能周期。',
      cycle: '产能周期。看硅料价格、开工率、组件出口、落后产能退出。',
      clear: '出清看价格跌破现金成本、二三线停产、资本开支下修；反转看价格企稳、开工率回升。',
      watch: ['硅料价格', '开工率', '组件出口', '资本开支'],
    },
    '电池': {
      what: '锂电、储能、材料。跟着新能源车和储能排产走。',
      cycle: '产能周期。看锂价、排产、库存、二三线开工。',
      clear: '出清看锂价止跌、二三线退出、库存去化；反转看排产回升、龙头盈利修复。',
      watch: ['锂价', '排产', '库存', '开工率'],
    },
    '房地产': {
      what: '开发、物业、建材链。政策和销售决定估值修复的斜率。',
      cycle: '政策周期。看销售面积、拿地、开工、房企债务。',
      clear: '出清看弱资质房企退出、债务重组落地；反转看销售同比转正、核心城市拿地回暖。',
      watch: ['销售面积', '拿地金额', '开工率', '房企债务'],
    },
    '有色金属': {
      what: '铜、铝、金、锂等资源品。美元和供给是两条主线。',
      cycle: '资源周期。看美元指数、库存、成本曲线、矿产供给。',
      clear: '出清看高成本产能退出、库存去化；反转看库存拐点、美元走弱、需求预期上修。',
      watch: ['美元指数', '库存', '成本曲线', '矿产供给'],
    },
    '稀土永磁': {
      what: '稀土开采、分离、磁材。配额和价格是核心变量。',
      cycle: '资源周期。看配额、分离厂开工、磁材订单。',
      clear: '出清看分离厂减产、价格跌破成本；反转看配额收紧、价格止跌、磁材订单回暖。',
      watch: ['配额', '氧化镨钕价格', '分离厂开工', '磁材订单'],
    },
    '恒生科技': {
      what: '港股科技龙头，受美元流动性和平台经济政策影响。',
      cycle: '流动性 + 政策周期。看美债利率、南向资金、平台监管。',
      clear: '出清看估值回到历史底部、南向持续流入；反转看美债利率下行、盈利上修。',
      watch: ['美债利率', '南向资金', '平台政策', '盈利增速'],
    },
  };
  const ETFS = {
    '半导体': [['512480', '半导体ETF'], ['588200', '科创芯片ETF']],
    'CPO/光模块': [['515880', '通信ETF'], ['159583', '通信设备ETF']],
    '机器人': [['562500', '机器人ETF']],
    '猪肉': [['159865', '养殖ETF'], ['516670', '畜牧ETF']],
    '影视': [['159855', '影视ETF']],
    '光伏': [['515790', '光伏ETF']],
    '电池': [['159755', '电池ETF']],
    '房地产': [['512200', '房地产ETF']],
    '有色金属': [['512400', '有色金属ETF']],
    '稀土永磁': [['516780', '稀土ETF']],
    '恒生科技': [['513130', '恒生科技ETF']],
    '通信': [['515880', '通信ETF']],
    '电子': [['512480', '半导体ETF'], ['159997', '电子ETF']],
    '计算机': [['512720', '计算机ETF']],
    '医药生物': [['512010', '医药ETF']],
    '电力设备': [['515790', '光伏ETF'], ['159755', '电池ETF']],
    '食品饮料': [['159928', '消费ETF']],
    '有色金属': [['512400', '有色金属ETF']],
    '煤炭': [['515220', '煤炭ETF']],
    '银行': [['512800', '银行ETF']],
    '非银金融': [['512880', '证券ETF']],
    '国防军工': [['512660', '军工ETF']],
    '汽车': [['516110', '汽车ETF']],
    '家用电器': [['159996', '家电ETF']],
  };

  /* 业务纯度优先的代表股：避免按市值排序把比亚迪、格力、核电等混进光伏/半导体/机器人。 */
  const THEME_LEADERS = {
    '半导体': ['688981', '002371', '688041', '688256', '688012', '603986'],
    'CPO/光模块': ['300308', '300502', '300394', '002281', '603083', '000988'],
    '机器人': ['300124', '002747', '688017', '300607', '300024', '002050'],
    '猪肉': ['002714', '300498', '000876', '002124', '002567', '603477'],
    '影视': ['002739', '300251', '600977', '300133', '001330', '601595'],
    '光伏': ['601012', '600438', '300274', '002459', '688599', '603806'],
    '电池': ['300750', '300014', '002074', '300207', '300450', '002812'],
    '房地产': ['600048', '000002', '001979', '600383', '002244', '600325'],
    '有色金属': ['601899', '603993', '600547', '601600', '000807', '000630'],
    '稀土永磁': ['600111', '000831', '300748', '600392', '600259', '600366'],
  };

  /* 政策样本：用于展示“周期板块也要看政策”，不是实时政策库。 */
  const POLICIES = {
    '半导体': {
      tone: '强支持', cls: 'hot',
      items: [
        ['2024-05-24', '财政部 / 国开行等', '国家集成电路产业投资基金三期成立', '注册资本 3,440 亿元，重点投向设备、材料、先进制程。'],
        ['2023-08-29', '财政部 / 税务总局', '集成电路企业研发费用加计扣除', '研发费用加计扣除比例提高至 120%，鼓励持续投入。'],
        ['2021-12-12', '国务院', '“十四五”数字经济发展规划', '集成电路列为关键核心技术攻关方向。'],
      ],
    },
    'CPO/光模块': {
      tone: '支持', cls: 'hot',
      items: [
        ['2022-02-17', '国家发改委等', '“东数西算”工程全面启动', '八大枢纽、十大数据中心集群，带动算力网络投资。'],
        ['2023-10-08', '工信部等六部门', '算力基础设施高质量发展行动计划', '提出 2025 年算力规模与运载力目标，光互联直接受益。'],
        ['2025-03-05', '国务院', '政府工作报告首提“人工智能+”', '推动大模型与算力基础设施落地，云厂商资本开支上修。'],
      ],
    },
    '机器人': {
      tone: '强支持', cls: 'hot',
      items: [
        ['2023-11-02', '工信部', '人形机器人创新发展指导意见', '提出 2025 年整机批量生产、2027 年形成安全可靠产业链。'],
        ['2024-01-29', '工信部等七部门', '推动未来产业创新发展的实施意见', '人形机器人列为未来制造重点方向。'],
        ['2025-03-05', '国务院', '政府工作报告首提“具身智能”', '具身智能进入国家产业政策视野，主题催化增加。'],
      ],
    },
    '猪肉': {
      tone: '逆周期调控', cls: 'warn',
      items: [
        ['2024-03-01', '农业农村部', '生猪产能调控实施方案（2024 年修订）', '能繁母猪正常保有量调整为 3,900 万头，区间调控。'],
        ['2024-02-03', '国务院', '中央一号文件：稳定生猪生产', '落实产能调控，防止生产大起大落。'],
        ['2024-06-01', '国家发改委', '猪肉储备收储与投放机制', '猪价过低时启动收储，托底但难改周期方向。'],
      ],
    },
    '影视': {
      tone: '支持', cls: 'hot',
      items: [
        ['2021-11-09', '国家电影局', '“十四五”中国电影发展规划', '提出 2025 年银幕总数、票房与内容供给目标。'],
        ['2025-03-16', '国务院', '提振消费专项行动方案', '文旅、电影消费纳入服务消费扩容重点。'],
        ['2024-08-01', '国家电影局', '电影创作座谈会', '鼓励现实题材与档期供给，改善内容端预期。'],
      ],
    },
    '光伏': {
      tone: '规范产能', cls: 'warn',
      items: [
        ['2024-07-09', '工信部', '光伏制造行业规范条件（2024 年本）', '提高资本金、技术、能耗门槛，约束低效扩产。'],
        ['2024-12-12', '中央经济工作会议', '综合整治“内卷式”竞争', '点名光伏等行业的低价无序竞争，推动供给侧出清。'],
        ['2025-07-03', '工信部', '光伏行业企业座谈会', '推动行业自律、落后产能退出与价格企稳。'],
      ],
    },
    '电池': {
      tone: '支持', cls: 'hot',
      items: [
        ['2020-11-02', '国务院', '新能源汽车产业发展规划（2021—2035 年）', '2025 年新能源车销量占比 20% 目标，带动锂电链。'],
        ['2024-08-06', '国家发改委等', '加快构建新型电力系统行动方案', '新型储能规模化，储能电池需求受益。'],
        ['2025-01-08', '国家发改委 / 财政部', '大规模设备更新和消费品以旧换新', '汽车、家电以旧换新延续，托底终端需求。'],
      ],
    },
    '房地产': {
      tone: '托底', cls: 'warn',
      items: [
        ['2024-09-26', '中共中央政治局会议', '促进房地产市场止跌回稳', '首次明确提出“止跌回稳”，政策转向托底。'],
        ['2024-05-17', '央行 / 金融监管总局', '“517” 房地产金融新政', '降首付、取消房贷利率下限、设立保障房再贷款。'],
        ['2025-03-05', '国务院', '政府工作报告：收储与城中村改造', '推进存量商品房收储、城中村和危旧房改造。'],
      ],
    },
    '有色金属': {
      tone: '中性', cls: '',
      items: [
        ['2023-08-25', '工信部等七部门', '有色金属行业稳增长工作方案', '稳增长与新材料并重，支持铜铝等精深加工。'],
        ['2024-11-15', '自然资源部', '新一轮找矿突破战略行动', '锂、铜、镍等战略性矿产增储上产。'],
        ['2025-04-01', '商务部 / 海关总署', '部分有色金属出口管制', '对镓、锗等关键金属实施出口许可，供给端扰动。'],
      ],
    },
    '稀土永磁': {
      tone: '规范收紧', cls: 'warn',
      items: [
        ['2024-06-29', '国务院', '《稀土管理条例》公布', '2024-10-01 施行，稀土开采、冶炼分离实行总量调控。'],
        ['2024-08-01', '商务部 / 海关总署', '稀土相关物项出口管制', '永磁材料、稀土氧化物出口需许可。'],
        ['2023-12-15', '工信部 / 自然资源部', '2024 年稀土开采、冶炼分离总量控制指标', '配额增速放缓，供给端刚性增强。'],
      ],
    },
    '恒生科技': {
      tone: '规范转支持', cls: 'accent',
      items: [
        ['2022-04-29', '中共中央政治局会议', '平台经济完成专项整改、进入常态化监管', '政策底出现，平台经济预期修复。'],
        ['2025-05-20', '全国人大常委会', '《民营经济促进法》施行', '从法律层面保障民营经济，改善港股风险偏好。'],
        ['2025-06-01', '证监会', '港股通标的扩容与互联互通优化', '南向资金可投范围扩大，流动性改善。'],
      ],
    },
  };

  const PLAYBOOK = {
    futures: {
      stance: '会前降杠杆', cls: 'warn',
      pre: '会前 1 日不追高，降低两融与杠杆',
      post: 'T+1 反弹胜率 78%，但幅度有限，不重仓赌方向',
      pos: '轻仓 · 对冲',
    },
    lpr: {
      stance: '等报价', cls: '',
      pre: '报价前不押方向，观察 MLF、逆回购与银行报价',
      post: 'T+1 胜率 70% 但均值 -0.02%，等落地再动',
      pos: '观察',
    },
    fomc: {
      stance: '会前减仓', cls: 'cold',
      pre: '会前减成长与港股，回避隔夜波动',
      post: 'T+1 胜率仅 41%，不抢反弹；看美债利率与点阵图',
      pos: '低仓 · 对冲',
    },
    politburo: {
      stance: '会前布局', cls: 'hot',
      pre: '政策预期升温，提前看政策受益方向',
      post: 'T+1 / T+5 胜率均 73%，会后利好兑现要减',
      pos: '试仓',
    },
    cewc: {
      stance: '会前布局', cls: 'hot',
      pre: '稳增长预期升温，关注政策定调与产业方向',
      post: 'T+1 强、T+5 分化，不追高，等细则',
      pos: '试仓 · 小仓',
    },
    twoSessions: {
      stance: '会前布局', cls: 'hot',
      pre: '会前主题活跃，关注新质生产力、基建、消费',
      post: 'T+5 胜率 100%，但样本仅 3 次，别当规律',
      pos: '小仓 · 主题',
    },
  };

  const LEARN_DAYS = [
    { w: 1, t: '指数与个股背离', act: '看今日页：上证、涨跌家数、中位涨跌，找出背离。', f: '为什么上证 +0.09%，却有 3,202 只下跌？' },
    { w: 1, t: '市场温度', act: '看情绪分、涨停/跌停比，写一句“今天适合动手吗”。', f: '情绪 41 分代表什么？它不能预测什么？' },
    { w: 1, t: '涨停与跌停', act: '找 2 只涨停股，看看它们属于哪个板块。', f: '涨停家数多，等于赚钱效应好吗？' },
    { w: 1, t: '成交量与换手', act: '找一只量比 > 1.5 的股票，看它今天发生了什么。', f: '放量上涨和缩量上涨，差别在哪？' },
    { w: 1, t: '板块与概念', act: '看通信 +2.10%、有色 -1.24%，再看 8 个概念热点。', f: '板块平均涨幅会掩盖什么？' },
    { w: 1, t: '本周复盘', act: '用 3 句话解释本周市场，录音或写 200 字。', f: '我这周最没讲清的一个词是什么？' },
    { w: 1, t: '补课', act: '把第 1 周最卡的概念重讲一遍，只用大白话。', f: '能不能不用术语讲明白？' },

    { w: 2, t: '行业分类', act: '看板块页行业 tab，数一数申万一级行业有几组。', f: '行业和概念有什么区别？' },
    { w: 2, t: '板块轮动', act: '找领涨板块，再看它产业链的上下游是谁。', f: '领涨、补涨、退潮，分别看什么信号？' },
    { w: 2, t: '周期位置', act: '看主题的 1 年 / 5 年位置，找一个低位主题。', f: '位置低，为什么不等于马上涨？' },
    { w: 2, t: '出清与反转', act: '看猪周期：能繁母猪 → 供给 → 猪价。', f: '为什么母猪存栏是先行指标？' },
    { w: 2, t: '政策与板块', act: '看半导体/光伏/稀土的政策追踪，各挑一条。', f: '政策底等于市场底吗？' },
    { w: 2, t: '主题 vs 行业', act: '选一个主题，写 5 行：逻辑/证据/风险/触发/失效。', f: '这个主题靠什么赚钱？' },
    { w: 2, t: '本周复盘', act: '把第 13 天的 5 行讲给一个没买过股票的人。', f: '他听懂了哪句？卡在哪句？' },

    { w: 3, t: 'K 线', act: '打开一只股票的日 K，认开高低收和上下影线。', f: '长上影通常说明什么？' },
    { w: 3, t: '均线', act: '看 MA5/10/20/60 的排列，找多头排列和纠缠。', f: '多头排列和均线纠缠，分别意味着什么？' },
    { w: 3, t: 'MACD', act: '看金叉/死叉、水上/水下，找一只刚金叉的。', f: '金叉一定涨吗？为什么？' },
    { w: 3, t: 'RSI 与量价', act: '找一只 RSI > 80 的股票，看它最近 5 天。', f: 'RSI 高，是风险还是强势？' },
    { w: 3, t: '估值入门', act: '看 PE/PB/股息率，找一只低 PE 股。', f: '低 PE 可能是什么陷阱？' },
    { w: 3, t: '财报三张表', act: '看营收、净利润、经营现金流，找一组背离。', f: '利润增长但现金流差，说明什么？' },
    { w: 3, t: '本周复盘', act: '用费曼法讲一只你感兴趣的股票，3 分钟。', f: '你讲的是事实，还是观点？' },

    { w: 4, t: '仓位与单笔风险', act: '算一笔：10 万本金，单笔最多亏 2% 是多少？', f: '为什么先想亏多少，再想赚多少？' },
    { w: 4, t: '止损与交易计划', act: '写一张交易卡：理由/触发/失效/最大亏损。', f: '没有失效条件的交易，问题在哪？' },
    { w: 4, t: '模拟盘下单', act: '在模拟盘找一笔交易，先写理由再下单。', f: '这笔交易赚的是哪种钱？' },
    { w: 4, t: '盘后复盘', act: '对/错/运气，各写一条。', f: '赚钱的交易，也可能是错的？' },
    { w: 4, t: '行为偏差', act: '回想一次追涨或拿不住，写下当时的情绪。', f: '当时是哪个情绪在驱动？' },
    { w: 4, t: '自选池', act: '建 10 只观察股，写关注理由。', f: '为什么是这 10 只，不是 50 只？' },
    { w: 4, t: '月度复盘', act: '写 30 天收获、最弱模块、下月计划。', f: '我现在能独立解释今日页的 6 个数字吗？' },
    { w: 4, t: '补课', act: '补最弱的一个模块，再讲一遍。', f: '还卡在哪？' },
    { w: 4, t: '结业小测', act: '做 5 道题 + 3 分钟讲解。', f: '我能不能教会一个新手？' },
  ];

  const LEARN_MONTHS = [
    { t: '市场语言与交易规则', focus: '指数、涨跌家数、涨跌停、T+1、费用、板块', out: '30 天结业小测' },
    { t: '行业与公司研究', focus: '产业链、竞争格局、龙头、商业模式', out: '一页行业地图' },
    { t: '财务报表', focus: '三张表、营收/利润/现金流、应收/存货', out: '一家公司财务体检' },
    { t: '估值', focus: 'PE/PB/PS、DCF 入门、股息率、历史分位', out: '一只股票估值区间' },
    { t: '技术分析与量价', focus: 'K 线、均线、MACD、RSI、成交量、支撑压力', out: '一套技术检查表' },
    { t: '周期与政策', focus: '库存周期、产能周期、政策传导', out: '一个周期出清/反转报告' },
    { t: '策略与回测', focus: '趋势、均值回归、事件驱动、回测偏差', out: '一个策略回测' },
    { t: '风险管理', focus: '仓位、相关性、最大回撤、止损', out: '一份风险预算表' },
    { t: '行为金融', focus: '追涨、损失厌恶、过度自信、羊群', out: '一份自己的错误清单' },
    { t: '宏观与流动性', focus: '利率、汇率、信用、财政、外部市场', out: '一页宏观观察' },
    { t: '组合管理', focus: '核心/卫星、再平衡、相关性', out: '一个模拟组合' },
    { t: '全年复盘与体系化', focus: '把 11 个月串成自己的研究流程', out: '年度复盘 + 研究手册' },
  ];

  const LEARN_WEEK_TITLES = ['W1 · 市场语言', 'W2 · 板块与周期', 'W3 · 个股与技术', 'W4 · 交易与复盘'];

  /* ---------- state ---------- */
  const state = {
    tab: 'today',
    sectorMode: 'theme',
    selectedTheme: '猪肉',
    selectedSector: '通信',
    period: 'day',
    stock: null,
    searchSel: 0,
    searchItems: [],
    index: [],
    theme: localStorage.getItem('sa-theme') || 'light',
    liveSort: 'speed',
    learnDay: null,
    annCache: new Map(),
  };

  /* ---------- search index ---------- */
  function addIndex(map, item, priority = 1) {
    if (!item || !item.code) return;
    const old = map.get(item.code);
    if (!old || priority > old.priority) map.set(item.code, { ...item, priority });
  }
  function buildIndex() {
    const map = new Map();
    if (M.stock) addIndex(map, { code: M.stock.code, name: M.stock.name, type: '股票', sub: M.stock.industry, price: M.stock.price, pct: M.stock.pct, priority: 4 }, 4);
    M.themes.forEach((t) => {
      (t.stocks || []).forEach((s) => addIndex(map, { code: s.code, name: s.name, type: '股票', sub: t.name, price: s.price, pct: s.pct, industry: s.industry || t.name, mcap: s.mcap, pe: s.pe, pb: s.pb }, 1));
      addIndex(map, { code: `T:${t.name}`, name: t.name, type: '主题', sub: t.group || '周期主题', theme: t.name, price: null, pct: t.avg_pct, priority: 3 }, 3);
    });
    M.sectors.filter((s) => s.name !== '-').forEach((s) => {
      (s.peers || []).forEach((p) => addIndex(map, { code: p.code, name: p.name, type: '股票', sub: s.name, price: p.price, pct: p.pct, industry: s.name, mcap: p.mcap, pe: p.pe, pb: p.pb }, 1));
      addIndex(map, { code: `I:${s.name}`, name: s.name, type: '行业', sub: '申万一级', industry: s.name, price: null, pct: s.avg_pct, priority: 2 }, 2);
    });
    M.concepts.forEach((c) => (c.peers || []).forEach((p) => addIndex(map, { code: p.code, name: p.name, type: '股票', sub: c.name, price: p.price, pct: p.pct, industry: p.industry || c.name, mcap: p.mcap, pe: p.pe, pb: p.pb }, 1)));
    M.hot.rows.forEach((h) => addIndex(map, { code: h.code, name: h.name, type: '股票', sub: h.popularity || '人气榜', price: h.price, pct: h.pct }, 1));
    [...M.lhb.rows, ...M.youzi.stocks].forEach((x) => addIndex(map, { code: x.code, name: x.name, type: '股票', sub: '龙虎榜', price: null, pct: x.pct }, 1));
    [...M.decision.leaders, ...M.decision.risks].forEach((x) => addIndex(map, { code: x.code, name: x.name, type: '股票', sub: x.industry, price: x.price, pct: x.pct, industry: x.industry, mcap: x.mcap }, 2));
    M.paper.positions.forEach((p) => addIndex(map, { code: p.code, name: p.name, type: '股票', sub: '模拟盘持仓', price: p.price, pct: p.pct }, 2));
    M.dividend.rows.forEach((d) => addIndex(map, { code: d.code, name: d.name, type: '股票', sub: '红利策略', price: d.price, pct: d.pct }, 1));
    M.etfs.forEach((e) => addIndex(map, { code: `E:${e.code}`, name: e.name, type: 'ETF', sub: e.cat, etfCode: e.code, price: e.price, pct: e.pct }, 2));
    state.index = [...map.values()];
  }
  function search(q) {
    const s = String(q || '').trim().toLowerCase();
    if (!s) return [];
    return state.index
      .map((x) => {
        const name = String(x.name).toLowerCase();
        const code = String(x.code).replace(/^[TEI]:/, '').toLowerCase();
        let score = -1;
        if (code === s) score = 100;
        else if (code.startsWith(s)) score = 80;
        else if (name === s) score = 70;
        else if (name.includes(s)) score = 50;
        else if (String(x.sub || '').toLowerCase().includes(s)) score = 20;
        return { x, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || (a.x.type === '股票' ? -1 : 1))
      .slice(0, 24)
      .map((r) => r.x);
  }

  /* ---------- live monitor / quote overlay ---------- */
  const INDEX_CODE = {
    '上证指数': 'sh000001', '深证成指': 'sz399001', '创业板指': 'sz399006',
    '科创50': 'sh000688', '沪深300': 'sh000300', '中证500': 'sh000905',
    '中证1000': 'sh000852', '上证50': 'sh000016',
  };
  const LIVE = {
    rows: [],
    byCode: new Map(),
    events: [],
    updated_at: null,
    source: 'loading',
    error: '',
    busy: false,
    timer: null,
    coverage: null,
    failedChunks: 0,
  };

  function code6(v) {
    return String(v == null ? '' : v).replace(/^[a-z]{2}/i, '').replace(/^[TEI]:/i, '');
  }
  function canonRow(v) {
    const c = String(v == null ? '' : v).toLowerCase();
    if (/^(sh|sz|bj)\d{6}$/.test(c)) return c;
    if (/^\d{6}$/.test(c)) return ((c[0] === '6' || c[0] === '5' || c[0] === '9') ? 'sh' : (c[0] === '4' || /^(83|87|88|92)/.test(c)) ? 'bj' : 'sz') + c;
    return c;
  }

  function cnNow() {
    return new Date(Date.now() + 8 * 3600 * 1000);
  }

  function marketPhase() {
    const d = cnNow();
    const day = d.getUTCDay();
    const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (day === 0 || day === 6) return { open: false, label: '周末休市' };
    if (mins >= 9 * 60 + 15 && mins < 9 * 60 + 25) return { open: true, label: '集合竞价' };
    if (mins >= 9 * 60 + 25 && mins <= 11 * 60 + 30) return { open: true, label: '上午交易' };
    if (mins > 11 * 60 + 30 && mins < 13 * 60) return { open: false, label: '午间休市' };
    if (mins >= 13 * 60 && mins <= 15 * 60) return { open: true, label: '下午交易' };
    if (mins > 15 * 60) return { open: false, label: '已收盘' };
    return { open: false, label: '未开盘' };
  }

  function liveCodes() {
    const set = new Set();
    const add = (code) => {
      const c = code6(code);
      if (/^\d{6}$/.test(c)) set.add(c);
    };
    Object.values(INDEX_CODE).forEach((c) => set.add(c));
    add(M.stock && M.stock.code);
    M.themes.forEach((t) => (t.stocks || []).slice(0, 24).forEach((s) => add(s.code)));
    M.sectors.forEach((s) => (s.peers || []).forEach((p) => add(p.code)));
    M.concepts.forEach((c) => (c.peers || []).forEach((p) => add(p.code)));
    [...M.decision.leaders, ...M.decision.risks].forEach((s) => add(s.code));
    M.hot.rows.forEach((s) => add(s.code));
    M.lhb.rows.forEach((s) => add(s.code));
    M.youzi.stocks.forEach((s) => add(s.code));
    M.dividend.rows.forEach((s) => add(s.code));
    M.paper.positions.forEach((s) => add(s.code));
    M.etfs.forEach((s) => add(s.code));
    return [...set].slice(0, 820);
  }

  function liveQuote(code) {
    return LIVE.byCode.get(canonRow(code)) || null;
  }
  function putQuote(obj, q) {
    if (!obj || !q) return;
    if (q.price != null) obj.price = q.price;
    if (q.pct != null) obj.pct = q.pct;
    if (q.amount != null) obj.amount = q.amount;
    if (q.turnover != null) obj.turnover = q.turnover;
    if (q.vol_ratio != null) obj.vol_ratio = q.vol_ratio;
  }
  function patchLiveQuotes() {
    putQuote(M.stock, liveQuote(M.stock && M.stock.code));
    M.themes.forEach((t) => (t.stocks || []).forEach((s) => putQuote(s, liveQuote(s.code))));
    M.sectors.forEach((s) => (s.peers || []).forEach((p) => putQuote(p, liveQuote(p.code))));
    M.concepts.forEach((c) => (c.peers || []).forEach((p) => putQuote(p, liveQuote(p.code))));
    [...M.decision.leaders, ...M.decision.risks].forEach((s) => putQuote(s, liveQuote(s.code)));
    M.hot.rows.forEach((s) => putQuote(s, liveQuote(s.code)));
    M.lhb.rows.forEach((s) => putQuote(s, liveQuote(s.code)));
    M.youzi.stocks.forEach((s) => putQuote(s, liveQuote(s.code)));
    M.dividend.rows.forEach((s) => putQuote(s, liveQuote(s.code)));
    M.paper.positions.forEach((s) => putQuote(s, liveQuote(s.code)));
    M.etfs.forEach((s) => putQuote(s, liveQuote(s.code)));
    M.liveIndices = (M.indices || []).map((i) => {
      const q = liveQuote(INDEX_CODE[i.name]);
      return q ? { ...i, value: q.price != null ? q.price : i.value, pct: q.pct != null ? q.pct : i.pct } : i;
    });
    M.liveUpdatedAt = LIVE.updated_at;
  }

  function medianOf(values) {
    const a = values.filter((x) => typeof x === 'number' && isFinite(x)).slice().sort((x, y) => x - y);
    if (!a.length) return null;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  function statsOf(rows) {
    const qs = rows.filter((q) => q && q.price != null && q.pct != null);
    if (!qs.length) return null;
    let up = 0, down = 0, flat = 0, lu = 0, ld = 0;
    const pcts = [];
    for (const q of qs) {
      const p = q.pct;
      pcts.push(p);
      if (p > 0) up += 1; else if (p < 0) down += 1; else flat += 1;
      if (q.limit_up != null && q.price >= q.limit_up - 0.001) lu += 1;
      if (q.limit_down != null && q.price <= q.limit_down + 0.001) ld += 1;
    }
    return {
      count: qs.length, up, down, flat, limit_up: lu, limit_down: ld,
      avg_pct: +(pcts.reduce((a, b) => a + b, 0) / pcts.length).toFixed(2),
      median_pct: +(medianOf(pcts) ?? 0).toFixed(2),
    };
  }
  function applyFullMarket(rows) {
    if (!FULL || !Array.isArray(FULL.codes)) return;
    const qmap = new Map();
    for (const q of rows) {
      const c = code6(q.code);
      if (/^\d{6}$/.test(c)) qmap.set(c, q);
    }
    const stockSet = new Set(FULL.codes);
    const stockRows = [...qmap.entries()].filter(([code]) => stockSet.has(code)).map(([, q]) => q);
    const market = statsOf(stockRows);
    if (!market) return;
    M.market = { ...M.market, ...market };

    const byIndustry = new Map();
    for (const [code, q] of qmap) {
      if (!stockSet.has(code)) continue;
      const ind = (FULL.industry && FULL.industry[code]) || '未分类';
      if (!byIndustry.has(ind)) byIndustry.set(ind, []);
      byIndustry.get(ind).push(q);
    }
    M.sectors = M.sectors.map((s) => {
      const key = s.name === '-' ? '未分类' : s.name;
      const st = statsOf(byIndustry.get(key) || []);
      return st ? { ...s, ...st } : s;
    });

    M.concepts = M.concepts.map((c) => {
      const members = (FULL.concepts && FULL.concepts[c.name]) || [];
      const st = statsOf(members.map((code) => qmap.get(code)).filter(Boolean));
      return st ? { ...c, ...st } : c;
    });

    M.themes = M.themes.map((t) => {
      const members = (FULL.themes && FULL.themes[t.name]) || (t.stocks || []).map((s) => code6(s.code));
      const qs = members.map((code) => qmap.get(code)).filter(Boolean);
      const st = statsOf(qs);
      return st ? { ...t, ...st, count: members.length || st.count } : t;
    });

    const breadth = (market.up + market.down) ? market.up / (market.up + market.down) : 0.5;
    const lr = (market.limit_up + market.limit_down) ? market.limit_up / (market.limit_up + market.limit_down) : 0.5;
    const score = Math.max(0, Math.min(100, Math.round(50 + (breadth - 0.5) * 80 + (lr - 0.5) * 20 + (market.median_pct || 0) * 3)));
    const label = score < 20 ? '冰点' : score < 40 ? '偏冷' : score < 60 ? '中性' : score < 80 ? '偏热' : '过热';
    M.decision.sentiment = {
      ...M.decision.sentiment,
      score, label, breadth: +breadth.toFixed(3), limit_ratio: +lr.toFixed(3),
      median_pct: market.median_pct,
      advice: score < 40 ? '防守，等确认' : score < 60 ? '中性，按计划执行' : '偏热，注意兑现',
      parts: { up: market.up, down: market.down, limit_up: market.limit_up, limit_down: market.limit_down },
    };
  }

  async function fetchFullMarket() {
    if (LIVE.busy) return;
    LIVE.busy = true;
    try {
      if (!canFetchApi()) throw new Error('静态预览无实时接口');
      if (!FULL || !Array.isArray(FULL.codes) || !FULL.codes.length) throw new Error('全市场代码表未加载');
      const etfCodes = (M.etfs || []).map((x) => x.code).filter((c) => /^\d{6}$/.test(c));
      const all = [...new Set([...Object.values(INDEX_CODE), ...FULL.codes, ...etfCodes])];
      const chunks = [];
      for (let i = 0; i < all.length; i += 300) chunks.push(all.slice(i, i + 300));
      const settled = await Promise.allSettled(chunks.map((c) => jget('live.json?codes=' + c.join(','))));
      const rows = [], events = [];
      let updated = null;
      let failed = 0;
      for (const r of settled) {
        if (r.status !== 'fulfilled' || !r.value || !Array.isArray(r.value.rows)) { failed += 1; continue; }
        rows.push(...r.value.rows);
        if (Array.isArray(r.value.events)) events.push(...r.value.events);
        if (r.value.updated_at) updated = r.value.updated_at;
      }
      if (!rows.length) throw new Error('全市场行情为空');
      const stockSet = new Set((FULL.codes || []).map(code6).filter(Boolean));
      const covered = new Set(rows
        .filter((r) => num(r.pct) != null)
        .map((r) => code6(r.code))
        .filter((c) => stockSet.has(c)));
      const coverage = stockSet.size ? covered.size / stockSet.size : null;
      LIVE.rows = rows;
      LIVE.byCode = new Map(rows.map((r) => [canonRow(r.code), r]).filter(([c]) => c));
      const seen = new Set();
      LIVE.events = events.filter((e) => {
        const k = `${e.type}:${e.code}:${e.at}`;
        if (seen.has(k)) return false;
        seen.add(k); return true;
      }).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 40);
      LIVE.updated_at = updated || new Date().toISOString();
      LIVE.source = 'api';
      LIVE.error = '';
      LIVE.coverage = coverage;
      LIVE.failedChunks = failed;
      patchLiveQuotes();
      applyFullMarket(rows);
      M.liveFullAt = LIVE.updated_at;
    } catch (err) {
      LIVE.error = String(err && err.message ? err.message : err);
      LIVE.coverage = null;
      LIVE.failedChunks = 0;
      if (!LIVE.rows.length) {
        LIVE.byCode = new Map(); LIVE.events = []; LIVE.updated_at = null; LIVE.source = 'error';
      }
    } finally {
      LIVE.busy = false;
      renderRibbon();
      if (state.tab === 'live') renderLive(); else refreshCurrent();
    }
  }

  function clockText(v) {
    if (v == null || v === '') return '—';
    const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
    if (!isNaN(d.getTime())) {
      try {
        return new Intl.DateTimeFormat('zh-CN', {
          timeZone: 'Asia/Shanghai', hour12: false,
          hour: '2-digit', minute: '2-digit', second: '2-digit',
        }).format(d);
      } catch { /* fall through */ }
    }
    const s = String(v);
    const m = s.match(/(\d{2}:\d{2}(?::\d{2})?)/);
    return m ? m[1] : s.slice(0, 19);
  }

  function canFetchApi() {
    // The panel runs inside an iframe srcdoc under the DSH desktop custom scheme
    // (dsh-app://). Only a real file:// page has no Host API to talk to.
    if (location.protocol === 'file:') return false;
    try {
      if (window.parent && window.parent !== window && window.parent.location.protocol === 'file:') return false;
    } catch { /* cross-origin: assume the host is available */ }
    return true;
  }

  async function fetchLive(force = false) {
    if (FULL) { await fetchFullMarket(); return; }
    if (LIVE.busy) return;
    LIVE.busy = true;
    try {
      if (!canFetchApi()) throw new Error('静态预览无实时接口');
      if (typeof fetch !== 'function') throw new Error('当前环境不支持实时接口');
      const codes = liveCodes().join(',');
      const res = await fetch(`/api/sector-board/live.json?codes=${encodeURIComponent(codes)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (!body || !Array.isArray(body.rows)) throw new Error('接口返回格式不正确');
      LIVE.rows = body.rows;
      LIVE.byCode = new Map(body.rows.map((r) => [canonRow(r.code), r]).filter(([c]) => c));
      LIVE.events = Array.isArray(body.events) ? body.events : [];
      LIVE.updated_at = body.updated_at || null;
      LIVE.source = 'api';
      LIVE.error = '';
      patchLiveQuotes();
    } catch (err) {
      LIVE.error = String(err && err.message ? err.message : err);
      if (!LIVE.rows.length) {
        LIVE.byCode = new Map();
        LIVE.events = [];
        LIVE.updated_at = null;
        LIVE.source = 'error';
      }
    } finally {
      LIVE.busy = false;
      renderRibbon();
      if (state.tab === 'live') renderLive(); else refreshCurrent();
    }
  }

  function startLive() {
    if (LIVE.timer) return;
    fetchLive(true);
    LIVE.timer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      if (!marketPhase().open) return;
      fetchLive(true);
    }, 15000);
  }

  function stopLive() {
    if (LIVE.timer) clearInterval(LIVE.timer);
    LIVE.timer = null;
  }

  function cadence(text, kind = '') {
    return `<span class="cadence ${kind}"><i></i>${esc(text)}</span>`;
  }

  /* ---------- common render ---------- */
  function liveCoverageNote() {
    if (LIVE.source !== 'api' || LIVE.coverage == null) return '';
    const pct = Math.round(LIVE.coverage * 100);
    if (pct >= 99 && !LIVE.failedChunks) return '';
    return ` · 覆盖 ${pct}%${LIVE.failedChunks ? `（${LIVE.failedChunks} 批失败）` : ''}`;
  }
  function renderRibbon() {
    const list = (M.liveIndices && M.liveIndices.length ? M.liveIndices : M.indices).slice(0, 7);
    const phase = marketPhase();
    const cov = liveCoverageNote();
    const asof = !M.meta.as_of
      ? '读取中…'
      : (M.liveUpdatedAt
        ? `${String(M.meta.as_of).slice(5)} 分析 · ${phase.open ? `行情 ${clockText(M.liveUpdatedAt).slice(0, 8)}` : phase.label}${cov}`
        : `${M.meta.as_of} 收盘 · 实盘快照`);
    $('#ribbon').innerHTML = list
      .map((i) => `<div class="idx"><span>${esc(i.name)}</span><b>${nf(i.value, 2)}</b><b class="${cls(i.pct)}">${pt(i.pct)}</b></div>`)
      .join('') + `<div class="stamp" title="价格/指数/市场宽度/板块与概念均涨每 15 秒；技术信号与周期阶段来自每日 ETL 收盘快照${cov ? `；当前${cov.slice(3)}，市场宽度可能偏小` : ''}">${esc(asof)}</div>`;
  }

  function paperDay() {
    const p = M.paper || emptyModel().paper;
    const eq = Array.isArray(p.equity) ? p.equity : [];
    if (!eq.length) {
      const base = p.nav || p.initial || 0;
      return { last: { date: p.updated_at ? String(p.updated_at).slice(0, 10) : '—', equity: base }, prev: { equity: p.initial || base }, pnl: 0, pct: 0 };
    }
    const last = eq[eq.length - 1];
    const prev = eq[eq.length - 2] || { equity: p.initial || last.equity };
    return { last, prev, pnl: last.equity - prev.equity, pct: ((last.equity - prev.equity) / prev.equity) * 100 };
  }

  const SIGNAL_LABEL = { golden_above: '金叉', golden_below: '死叉', surge: '大涨', plunge: '大跌', plunge_flat: '大跌横盘', cycle_low: '周期底', cycle_high: '周期顶' };
  function peersFromLists(x) {
    const seen = new Set();
    const rows = [];
    Object.keys(x.lists || {}).forEach((k) => {
      (x.lists[k] || []).forEach((s) => {
        if (!s || !s.code || seen.has(s.code)) return;
        seen.add(s.code);
        rows.push({ ...s, signal: SIGNAL_LABEL[k] || '', price: s.price == null ? null : s.price });
      });
    });
    return rows.sort((a, b) => (num(b.pct) ?? -99) - (num(a.pct) ?? -99)).slice(0, 8);
  }
  function normalizeSector(x) {
    if (!x) return x;
    return { ...x, peers: (x.peers && x.peers.length ? x.peers : peersFromLists(x)) };
  }
  function applyDashboard(d) {
    if (!d || !d.as_of) return false;
    M.meta = {
      as_of: String(d.as_of).slice(0, 10),
      generated_at: d.generated_at || '',
      source: d.source || '',
      demo: false,
    };
    M.market = d.market || M.market;
    M.signals = d.signals || M.signals;
    M.decision = d.decision || M.decision;
    M.sectors = (d.sectors || []).map(normalizeSector);
    M.concepts = (d.boards && d.boards.concept ? d.boards.concept : []).map(normalizeSector);
    M.themes = d.themes || M.themes;
    M.theme_groups = d.theme_groups || M.theme_groups;
    M.lhb = d.lhb || M.lhb;
    M.youzi = d.youzi || M.youzi;
    M.dividend = d.dividend || M.dividend;
    return true;
  }
  function applyGlobal(g) {
    if (!g || !Array.isArray(g.items)) return;
    const order = ['A股指数', '港股指数', '美股指数', '商品', '外汇'];
    const groups = order.map((name) => ({
      group: name,
      rows: g.items.filter((x) => x.group === name).map((x) => ({ name: x.name, value: x.price, pct: x.pct })),
    })).filter((x) => x.rows.length);
    if (groups.length) M.global = groups;
    const a = g.items.filter((x) => x.group === 'A股指数');
    if (a.length) M.indices = a.slice(0, 7).map((x) => ({ name: x.name, value: x.price, pct: x.pct }));
  }
  function applyPaper(p) {
    if (!p || !p.exists) return;
    const nav = p.nav == null ? M.paper.nav : p.nav;
    const initial = p.initial == null ? M.paper.initial : p.initial;
    M.paper = {
      ...M.paper, initial, cash: p.cash, nav, total_pnl: nav - initial,
      total_pnl_pct: p.pnl_pct == null ? ((nav - initial) / initial) * 100 : p.pnl_pct,
      positions_value: p.mv == null ? (p.positions || []).reduce((a, x) => a + (x.mv || 0), 0) : p.mv,
      positions: (p.positions || []).map((x) => ({ ...x, value: x.mv, pnl: x.pnl })),
      trades: p.trades || [], decisions: p.decisions || [], equity: p.equity || [], robot: p.robot || {},
    };
  }
  function applyHot(h) {
    if (h && Array.isArray(h.rows)) M.hot = { ...M.hot, ...h };
  }
  function applyEvents(e) {
    if (!e || !Array.isArray(e.events)) return;
    const rules = {
      futures: '每月第三个周五', lpr: '每月 20 日', fomc: '美联储议息，北京时间次日',
      politburo: '季度政治局会议', cewc: '每年 12 月中央经济工作会议', twoSessions: '每年 3 月两会',
    };
    M.events = { ...M.events, as_of: e.as_of, rows: e.events.map((x) => ({ ...x, rule: x.rule || rules[x.kind] || '' })) };
  }
  function applyEtfs(e) {
    if (!e || !Array.isArray(e.rows)) return;
    M.etfs = e.rows.map((x) => ({ ...x, code: String(x.code || x.symbol || '').replace(/^[a-z]+/i, '') })).filter((x) => /^\d{6}$/.test(x.code));
  }
  function syncFooter() {
    const f = document.querySelector('.foot span:last-child');
    if (!f) return;
    f.textContent = M.meta.as_of
      ? `数据源：Host ETL 收盘快照（${M.meta.as_of}） · 全市场行情 15 秒 · 不构成投资建议`
      : '正在读取 Host 数据…';
  }
  function hydrate(force = false) {
    if (!apiAvailable()) {
      failBoot('无法连接 Host 数据接口。请从 DSH 面板打开「股票分析」，或确认 DSH 服务正在运行。');
      return Promise.resolve(false);
    }
    showBoot('正在读取 dashboard / paper / hot / events / global / etf…');
    let core = false;
    return jget('dashboard.json').then((d) => {
      core = applyDashboard(d);
      if (!core) throw new Error('dashboard 返回为空');
      M.meta.ready = true;
      buildIndex(); renderRibbon(); syncFooter();
      go(state.tab);
      hideBoot();
      return Promise.allSettled([jget('paper.json'), jget('hot.json'), jget('events.json'), jget('global.json'), jget('etf.json')]);
    }).then((rs) => {
      if (!core) return false;
      const val = (i) => rs[i].status === 'fulfilled' ? rs[i].value : null;
      applyPaper(val(0)); applyHot(val(1)); applyEvents(val(2)); applyGlobal(val(3)); applyEtfs(val(4));
      if (LIVE.rows.length) patchLiveQuotes();
      buildIndex(); renderRibbon(); syncFooter();
      if (state.tab === 'live') renderLive(); else go(state.tab);
      startLive();
      startAux();
      if (!M.ladder.days.length && !M.ladder.loading) fetchLadder();
      return true;
    }).catch((err) => {
      M.meta.ready = false;
      failBoot(`真实数据加载失败：${String(err && err.message ? err.message : err)}`);
      console.error('[stock analysis] real data load failed', err);
      return false;
    });
  }

  function sectorRank(s) {
    if (s.name === '-') return 99;
    const p = s.avg_pct;
    if (num(p) == null) return 90;
    return -p;
  }
  function topSectors(n = 5) {
    return [...M.sectors].filter((s) => s.name !== '-' && num(s.avg_pct) != null).sort((a, b) => sectorRank(a) - sectorRank(b)).slice(0, n);
  }
  function bottomSectors(n = 5) {
    return [...M.sectors].filter((s) => s.name !== '-' && num(s.avg_pct) != null).sort((a, b) => sectorRank(b) - sectorRank(a)).slice(0, n);
  }
  function topConcepts(n = 8) {
    return [...M.concepts].filter((c) => c.name && (c.count ?? 0) >= 3 && num(c.avg_pct) != null)
      .sort((a, b) => b.avg_pct - a.avg_pct).slice(0, n);
  }
  function policySearchUrl(name) {
    return `https://sousuo.www.gov.cn/sousuo/search.shtml?searchWord=${encodeURIComponent(`${name} 政策`)}`;
  }
  function daysUntil(dateStr) {
    if (!dateStr) return null;
    const parts = String(dateStr).split('-').map(Number);
    if (parts.length !== 3 || parts.some((x) => !isFinite(x))) return null;
    const d = Date.UTC(parts[0], parts[1] - 1, parts[2]);
    const now = new Date();
    const base = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((d - base) / 86400000);
  }

  /* ---------- today ---------- */
  function weekdayCN(dateStr) {
    const d = new Date(`${dateStr}T00:00:00`);
    return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()] || '';
  }

  function expectedTradingDate() {
    const d = new Date();
    if (d.getHours() < 16) d.setDate(d.getDate() - 1);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
    return dstr(d);
  }

  function staleInfo() {
    const asof = String(M.meta.as_of || '').slice(0, 10);
    if (!asof) return null;
    const expected = expectedTradingDate();
    return asof < expected ? { asof, expected } : null;
  }

  function staleNote() {
    const s = staleInfo();
    if (!s) return '';
    return `<div class="stale-note"><b>数据滞后</b> 截至 ${esc(s.asof)}，最近交易日 ${esc(s.expected)}。 <button class="btn tiny" data-action="etl">更新数据</button><span>更新约 4–6 分钟，期间可继续看当前快照。</span></div>`;
  }
  function avgIndexPct() {
    const list = (M.indices || []).filter((x) => num(x.pct) != null);
    return list.length ? list.reduce((a, x) => a + x.pct, 0) / list.length : null;
  }
  function themeForSector(name) {
    const t = (M.themes || []).find((x) => x.name === name || x.sector === name);
    return t ? t.name : '';
  }
  function makeStories() {
    const m = M.market || {};
    const sent = (M.decision && M.decision.sentiment) || {};
    const tops = topSectors(8);
    const bottoms = bottomSectors(8);
    const concepts = topConcepts(8);
    const lead = tops[0] || { name: '—', avg_pct: null, up: 0, count: 0 };
    const weak = bottoms[0] || { name: '—', avg_pct: null, down: 0, count: 0 };
    const concept = concepts[0] || null;
    const leadStock = (lead.peers || [])[0] || (concept && concept.peers ? concept.peers[0] : null);
    const leadTheme = themeForSector(lead.name);
    const weakTheme = themeForSector(weak.name);
    const breadth = num(m.total) ? (m.down / m.total) * 100 : null;
    const downCount = num(m.down) == null ? 0 : m.down;
    const upCount = num(m.up) == null ? 0 : m.up;
    const limitDown = num(m.limit_down) == null ? 0 : m.limit_down;
    const score = sent.score == null ? null : sent.score;

    const s1 = {
      no: '01', tag: '主线',
      title: lead.name === '—' ? '今天没有明显主线。' : `${lead.name}${lead.avg_pct >= 0 ? '领涨' : '相对抗跌'}${concept ? `，${concept.name}最强` : '，资金没有扩散'}`,
      val: pt(lead.avg_pct),
      vcls: cls(lead.avg_pct),
      body: lead.name === '—' ? '全市场没有可比较的板块均涨数据，先等 ETL 完成。' :
        `${lead.name}均涨 ${pt(lead.avg_pct)}，${lead.up}/${lead.count} 只上涨。` +
        (concept ? `概念里 ${concept.name} ${pt(concept.avg_pct)}，${concept.count ? `${concept.count} 只成分，` : ''}${concept.peers && concept.peers[0] ? `${concept.peers[0].pct >= 0 ? '领涨' : '相对抗跌'} ${concept.peers[0].name} ${pt(concept.peers[0].pct)}。` : '资金没有明显扩散。'}` : '') +
        (leadStock ? `板块内 ${leadStock.name} ${pt(leadStock.pct)}。` : ''),
      chips: [`${lead.name} ${pt(lead.avg_pct)}`, concept ? `${concept.name} ${pt(concept.avg_pct)}` : '无概念热点', leadStock ? `${leadStock.name} ${pt(leadStock.pct)}` : '等信号'],
      go: 'sectors', theme: leadTheme || undefined, industry: leadTheme ? undefined : lead.name,
    };
    const s2 = {
      no: '02', tag: '风险',
      title: `${nf(downCount)} 只下跌，${weak.name === '—' ? '结构偏弱' : `${weak.name}领跌`}`,
      val: `中位 ${pt(m.median_pct)}`,
      vcls: 'down',
      body: `下跌占比 ${breadth == null ? '—' : `${breadth.toFixed(0)}%`}，中位 ${pt(m.median_pct)}。` +
        (weak.name !== '—' ? `${weak.name} 均 ${pt(weak.avg_pct)}，${weak.down}/${weak.count} 只下跌。` : '') +
        `跌停 ${limitDown} 家，近 20 日大跌 ${M.signals && M.signals.plunge != null ? nf(M.signals.plunge) : '—'} 只。指数和个股不是一回事。`,
      chips: [`下跌 ${nf(downCount)}`, `中位 ${pt(m.median_pct)}`, `跌停 ${limitDown}`],
      go: 'sectors', theme: weakTheme || undefined, industry: weakTheme ? undefined : weak.name,
    };
    const s3 = {
      no: '03', tag: '情绪',
      title: `情绪 ${score == null ? '—' : score} 分，${sent.label || '待更新'}`,
      val: `涨停 ${nf(m.limit_up)} / 跌停 ${nf(limitDown)}`,
      vcls: 'flat',
      body: `结论：${sent.advice || '先观察，不追高'}。上涨 ${nf(upCount)} 家、下跌 ${nf(downCount)} 家，涨跌家数比 ${sent.breadth == null ? '—' : sent.breadth.toFixed(2)}。${score != null && score < 35 ? '情绪偏冷，先控制仓位。' : score != null && score > 65 ? '情绪偏热，注意兑现。' : '情绪中性，按计划执行。'}`,
      chips: [`情绪 ${score == null ? '—' : score}`, `涨停 ${nf(m.limit_up)}`, `跌停 ${nf(limitDown)}`],
      go: 'paper',
    };
    return [s1, s2, s3];
  }

  function renderToday() {
    const m = M.market;
    const pd = paperDay();
    const tops = topSectors(8);
    const bottoms = bottomSectors(8);
    const concepts = topConcepts(8);
    const stories = makeStories();
    const sectorsUp = tops.concat(bottoms).filter((s) => num(s.avg_pct) > 0).length;
    const sectorsAll = M.sectors.filter((s) => s.name !== '-' && num(s.avg_pct) != null).length;
    const maxAbs = Math.max(...tops.concat(bottoms).map((s) => Math.abs(s.avg_pct || 0)), 0.5);
    const lhbSeen = new Set();
    const lhb = [...M.lhb.rows].sort((a, b) => b.net - a.net).filter((x) => {
      const key = x.code || x.name;
      if (lhbSeen.has(key)) return false;
      lhbSeen.add(key);
      return true;
    }).slice(0, 3);
    const yzNames = new Set(lhb.map((x) => x.name));
    const yzSeen = new Set();
    const yz = [...M.youzi.stocks].sort((a, b) => b.net - a.net).filter((x) => {
      const key = x.code || x.name;
      if (yzNames.has(x.name) || Math.abs(x.net) >= 1.2e9 || yzSeen.has(key)) return false;
      yzSeen.add(key);
      return true;
    }).slice(0, 2);
    const hot = (M.hot.rows || []).slice(0, 6);
    const sent = (M.decision && M.decision.sentiment) || {};
    const score = sent.score == null ? null : sent.score;
    const idx = (M.indices || [])[0];
    const ip = avgIndexPct();
    const med = num(m.median_pct);
    const headline =
      med == null ? '先看结构。' :
      ip != null && ip > 0 && med < -0.8 ? '指数微红，个股很冷。' :
      ip != null && ip <= -0.2 && med < -0.5 ? '指数回落，个股更冷。' :
      med < -0.5 ? '指数撑着，个股在跌。' :
      ip != null && ip < -0.2 && med > 0.6 ? '指数弱，个股在涨。' :
      med > 0.6 ? '普涨，赚钱效应回来。' :
      '分化，先看结构。';
    const contrast = idx && num(idx.pct) != null && num(idx.pct) >= 0 ? '但 ' : '';
    const liveK = M.liveUpdatedAt
      ? ` · ${marketPhase().open ? `行情 ${clockText(M.liveUpdatedAt).slice(0, 5)}` : marketPhase().label}${liveCoverageNote()}`
      : '';
    const lede = `${idx ? `${idx.name} ${pt(idx.pct)}，` : ''}${contrast}${nf(m.down)} 只下跌、中位 ${pt(m.median_pct)}。` +
      (tops[0] ? `${tops[0].name} ${pt(tops[0].avg_pct)} ${tops[0].avg_pct >= 0 ? '领涨' : '相对抗跌'}` : '') +
      (concepts[0] ? `，${concepts[0].name} 是今天最强概念` : '') +
      (bottoms[0] ? `；${bottoms[0].name} ${pt(bottoms[0].avg_pct)} 最弱` : '') +
      '。先看今天发生了什么，再看哪些板块在出清。';
    const lastDec = (M.paper.decisions || [])[M.paper.decisions.length - 1];
    const todayTrades = (M.paper.trades || []).filter((t) => t.date === pd.last.date);
    const maBull = M.market.tech && M.market.tech.ma_bull;
    const maBear = M.market.tech && M.market.tech.ma_bear;

    $('#page-today').innerHTML = `
      <div class="page-head">
        <div>
          <div class="kicker">${esc(M.meta.as_of)} ${weekdayCN(M.meta.as_of)} · 全市场行情${liveK}${cadence('全市场 15 秒 · 分析每日', 'live')}</div>
          ${staleNote()}
          <h1>${esc(headline)}</h1>
          <p class="lede">${esc(lede)}</p>
        </div>
        <div class="head-actions">
          <button class="btn" data-action="refresh">刷新数据</button>
          <button class="btn primary" data-go="sectors">看板块周期</button>
        </div>
      </div>

      <div class="pulse">
        <div><b>${score == null ? '—' : score}</b><span>情绪 · ${esc(sent.label || '待更新')}</span></div>
        <div><b class="up">${nf(m.up)}</b><span>上涨</span><em class="down">&nbsp;/ ${nf(m.down)} 下跌</em></div>
        <div><b class="up">${nf(m.limit_up)}</b><span>涨停</span><em>&nbsp;/ 跌停 ${nf(m.limit_down)}</em></div>
        <div><b class="${cls(m.median_pct)}">${pt(m.median_pct)}</b><span>个股中位涨跌</span></div>
        <div><b>${M.signals && M.signals.plunge != null ? nf(M.signals.plunge) : '—'}</b><span>近 20 日大跌</span></div>
        <div><b>${maBull == null ? '—' : nf(maBull)} / ${maBear == null ? '—' : nf(maBear)}</b><span>日线 MA 多头 / 空头</span></div>
      </div>
      ${healthStrip()}

      <div class="today-grid">
        <div class="stack">
          <section class="card">
            <div class="card-h"><h2>今天资金在炒什么</h2><span class="meta">按强度排序 · 收盘数据</span></div>
            ${stories.map((s) => `
              <div class="story" data-go="${s.go}" ${s.theme ? `data-theme="${esc(s.theme)}"` : s.industry ? `data-industry="${esc(s.industry)}"` : ''}>
                <div class="no">${s.no}</div>
                <div>
                  <h3>${esc(s.title)}</h3>
                  <p>${esc(s.body)}</p>
                  <div class="chips">${s.chips.map((c) => `<span class="chip ${s.tag === '风险' ? 'cold' : s.tag === '主线' ? 'hot' : ''}">${esc(c)}</span>`).join('')}</div>
                </div>
                <div class="val"><b class="${s.vcls}">${esc(s.val)}</b><span>${esc(s.tag)}</span></div>
              </div>`).join('')}
          </section>

          <section class="card">
            <div class="card-h"><h2>概念热点</h2><span class="meta">领涨 ${concepts.length} 个 · 全部 ${M.concepts.length} 个概念</span></div>
            <div class="concept-grid">
              ${concepts.map((c) => {
                const lead = (c.peers || [])[0];
                return `<div class="concept-row" data-stock="${lead ? esc(lead.code) : ''}" title="${lead ? `领涨 ${esc(lead.name)}` : esc(c.name)}">
                  <span class="cn">${esc(c.name)}</span><span class="pct up">${pt(c.avg_pct)}</span>
                  <span class="lead">${c.count ? `${c.count} 只` : '—'}${lead ? ` · ${esc(lead.name)} ${pt(lead.pct)}` : ''}</span>
                </div>`;
              }).join('')}
            </div>
            <div class="small-note" style="padding:10px 20px 12px">点击概念跳到领涨个股；概念成分与板块明细在「板块」页。</div>
          </section>

          <section class="card">
            <div class="card-h"><h2>人气榜 <span class="live-inline"><i></i>3 分钟</span></h2><span class="meta">同花顺热度 · <a href="#" data-go="live">去盘中看实时异动 →</a></span></div>
            ${hot.length ? hot.map((h) => `
              <div class="tape-row" data-stock="${esc(h.code)}">
                <span class="time">#${h.rank}</span>
                <span class="who"><b>${esc(h.name)}</b><small>${esc(h.popularity || (h.concepts && h.concepts[0]) || '人气榜')}${h.heat ? ` · 热度 ${nf(h.heat)}` : ''}</small></span>
                <span class="tag hot">热度</span>
                <span class="pct ${cls(h.pct)}">${pt(h.pct)}</span>
              </div>`).join('') : '<div class="empty">暂无热度数据</div>'}
          </section>
        </div>

        <div class="stack">
          ${phaseCard()}
          <section class="card">
            <div class="card-h"><h2>板块红黑榜</h2><span class="meta">${sectorsUp}/${sectorsAll} 上涨 · 各取 8 · <a href="#" data-go="sectors">全部 →</a></span></div>
            <div class="rank-sep">领涨</div>
            ${tops.map((s, i) => `<div class="rank-row" data-industry="${esc(s.name)}"><span class="idx">${i + 1}</span><span class="nm">${esc(s.name)}</span><span class="bar"><i style="width:${Math.max(6, (Math.abs(s.avg_pct) / maxAbs) * 100)}%;background:var(--up)"></i></span><span class="pct up">${pt(s.avg_pct)}</span></div>`).join('')}
            <div class="rank-sep">领跌</div>
            ${bottoms.map((s, i) => `<div class="rank-row" data-industry="${esc(s.name)}"><span class="idx">${i + 1}</span><span class="nm">${esc(s.name)}</span><span class="bar"><i style="width:${Math.max(6, (Math.abs(s.avg_pct) / maxAbs) * 100)}%;background:var(--down)"></i></span><span class="pct down">${pt(s.avg_pct)}</span></div>`).join('')}
          </section>

          <section class="card">
            <div class="card-h"><h2>资金在关注</h2><span class="meta">龙虎榜 / 游资</span></div>
            ${lhb.map((x) => `<div class="money-row" data-stock="${esc(x.code)}"><span class="src">龙虎榜</span><span class="who">${esc(x.name)} <small class="${cls(x.pct)}">${pt(x.pct)}</small></span><span class="val up">净买 ${money(x.net)}</span></div>`).join('')}
            ${yz.map((x) => `<div class="money-row" data-stock="${esc(x.code)}"><span class="src">游资</span><span class="who">${esc(x.name)} <small class="${cls(x.pct)}">${pt(x.pct)}</small></span><span class="val up">净买 ${money(x.net)}</span></div>`).join('')}
          </section>

          <section class="card paper-mini" data-go="paper">
            <div class="top">
              <div>
                <div class="label">模拟盘 · ${esc(pd.last.date)}</div>
                <div class="big ${cls(pd.pct)}">${pt(pd.pct)}</div>
                <div class="note">${M.paper.positions.length} 只持仓 · ${esc(pd.last.date)} ${todayTrades.length} 笔交易 · 决策 ${esc(lastDec ? lastDec.action : '—')}</div>
              </div>
              <span class="tag accent">看日结 →</span>
            </div>
          </section>
        </div>
      </div>
    `;
  }

  /* ---------- sector states ---------- */
  function themeState(t) {
    if (!t.count) return { label: '无成分', cls: '' };
    const p = t.avg_pct;
    if (t.stage === '底部' && num(p) != null && p > 0) return { label: '反转观察', cls: 'accent' };
    if (t.stage === '底部' && (t.pos1250_med ?? 1) < 0.12) return { label: '底部出清', cls: 'warn' };
    if (t.stage === '底部') return { label: '底部', cls: '' };
    if (t.stage === '下行' && num(p) != null && p > 1) return { label: '超跌反弹', cls: 'accent' };
    if (t.stage === '下行') return { label: '下行', cls: 'cold' };
    if ((t.pos250_med ?? 1) < 0.15) return { label: '底部震荡', cls: '' };
    if ((t.pos250_med ?? 0) > 0.6) return { label: '高位震荡', cls: 'hot' };
    return { label: '震荡', cls: '' };
  }
  function themeOrder(t) {
    const order = { '底部出清': 0, '反转观察': 1, '底部': 2, '超跌反弹': 3, '底部震荡': 4, '震荡': 5, '下行': 6, '高位震荡': 7, '无成分': 8 };
    return order[themeState(t).label] ?? 9;
  }
  const OPP_BASE = {
    '反转观察': { score: 92, label: '机会', cls: 'accent', why: '底部阶段今日转强，进入反转观察区' },
    '底部出清': { score: 86, label: '机会', cls: 'warn', why: '5 年分位极低，处于出清末端' },
    '超跌反弹': { score: 72, label: '机会', cls: 'accent', why: '下行后出现反弹，短线修复窗口' },
    '底部': { score: 64, label: '关注', cls: '', why: '仍在底部，等右侧确认' },
    '底部震荡': { score: 54, label: '关注', cls: '', why: '1 年分位偏低，底部反复' },
    '震荡': { score: 34, label: '中性', cls: '', why: '周期位置居中，等方向选择' },
    '下行': { score: 18, label: '回避', cls: 'cold', why: '仍在下行，未见止跌信号' },
    '高位震荡': { score: 8, label: '回避', cls: 'hot', why: '位置偏高，性价比不足' },
    '无成分': { score: 0, label: '无成分', cls: '', why: '暂无 A 股成分，无法判断' },
  };
  function themeOpportunity(t) {
    const st = themeState(t);
    const base = OPP_BASE[st.label] || OPP_BASE['震荡'];
    const reasons = [];
    const p1250 = num(t.pos1250_med);
    const p250 = num(t.pos250_med);
    const p5 = num(t.pct5_med);
    const today = num(t.avg_pct);
    let score = base.score;
    if (p1250 != null) {
      reasons.push(`5年分位 ${(p1250 * 100).toFixed(0)}%`);
      score += (0.45 - p1250) * 18;
    }
    if (p250 != null) {
      reasons.push(`1年分位 ${(p250 * 100).toFixed(0)}%`);
      score += (0.4 - p250) * 8;
    }
    if (p5 != null) reasons.push(`近5日 ${pt(p5 * 100, 1)}`);
    if (today != null) reasons.push(`今日 ${pt(today)}`);
    const note = NOTES[t.name] || {};
    if (note.watch && note.watch.length) reasons.push(`盯 ${note.watch[0]}`);
    if (!t.count) score = 0;
    return {
      ...base,
      score: Math.round(clamp(score, 0, 100)),
      reasons,
      reason: reasons.slice(0, 3).join(' · '),
    };
  }
  function themeProgress(v) {
    if (num(v) == null) return `<span class="flat">—</span>`;
    const p = clamp(v * 100, 0, 100);
    const color = p < 25 ? 'low' : p > 75 ? 'high' : '';
    return `<span class="pos"><span class="track"><i class="${color}" style="width:${Math.max(4, p)}%"></i></span><span>${p.toFixed(0)}%</span></span>`;
  }
  function themeStock(t, n = 1) {
    const list = t.stocks || [];
    const codes = THEME_LEADERS[t.name] || [];
    if (codes.length) {
      const picked = [];
      for (const code of codes) {
        const s = list.find((x) => x.code === code) || state.index.find((x) => x.code === code);
        if (s) picked.push(s);
      }
      if (picked.length) return picked.slice(0, n);
    }
    return list.slice(0, n);
  }

  function renderSectors() {
    const isTheme = state.sectorMode === 'theme';
    const themes = [...M.themes].sort((a, b) => {
      const d = themeOpportunity(b).score - themeOpportunity(a).score;
      return d || themeOrder(a) - themeOrder(b);
    });
    const industries = [...M.sectors].filter((s) => s.name !== '-').sort((a, b) => (b.avg_pct ?? -99) - (a.avg_pct ?? -99));
    const selTheme = M.themes.find((t) => t.name === state.selectedTheme) || themes[0];
    const selIndustry = M.sectors.find((s) => s.name === state.selectedSector) || industries[0];

    $('#page-sectors').innerHTML = `
      <div class="page-head">
        <div>
          <div class="kicker">板块与周期${cadence('全市场 15 秒 · 分析每日', 'live')}${liveCoverageNote()}</div>
          <h1>谁在涨，谁在出清。</h1>
          <p class="lede">先看今天谁强，再看小周期 / 大周期位置。点一行，右侧给出 ETF、龙头股和出清逻辑。猪周期看母猪，光伏看硅料价格——每个板块有自己的先行指标。</p>
        </div>
        <div class="seg">
          <button data-mode="theme" class="${isTheme ? 'active' : ''}">周期主题 11</button>
          <button data-mode="industry" class="${!isTheme ? 'active' : ''}">行业涨跌 35</button>
        </div>
      </div>

      <div class="sector-layout">
        <section class="card">
          <div class="card-h"><h2>${isTheme ? '周期主题 · 机会优先' : '申万一级行业'}</h2><span class="meta">${isTheme ? '机会分从高到低 · 均涨实时 · 小/大周期为成分股分位中位数（每日）' : '按今日平均涨跌排序 · 均涨实时 · 周期位置见「周期主题」'}</span></div>
          <div class="table-wrap">
            <table class="t">
              <thead><tr>
                <th>${isTheme ? '主题' : '行业'}</th>
                <th class="r">今日</th>
                ${isTheme ? '<th class="hide-720">5 日</th><th>小周期</th><th>大周期</th>' : '<th class="r">涨 / 跌</th><th class="r hide-720">涨停</th><th class="r hide-720">大跌</th>'}
                <th>状态</th>
                <th class="hide-720">${isTheme ? '龙头' : '领涨'}</th>
              </tr></thead>
              <tbody>
                ${isTheme ? themes.map((t) => {
                  const st = themeState(t);
                  const opp = themeOpportunity(t);
                  const lead = themeStock(t, 1)[0];
                  return `<tr data-theme="${esc(t.name)}" class="${t.name === state.selectedTheme ? 'sel' : ''}">
                    <td><div class="nm">${esc(t.name)} <span class="tag ${opp.cls} opp-tag" title="${esc(opp.why)}">${opp.label}</span></div><div class="sub">${esc(t.group || '')}${t.count ? ` · ${t.count} 只` : ''}</div><div class="opp-line" title="${esc(opp.why)} · ${esc(opp.reason)}">${esc(opp.reason || opp.why)}</div></td>
                    <td class="r num ${cls(t.avg_pct)}">${pt(t.avg_pct)}</td>
                    <td class="r num hide-720 ${cls(t.pct5_med)}">${t.pct5_med == null ? '—' : pt(t.pct5_med * 100, 1)}</td>
                    <td>${themeProgress(t.pos250_med)}</td>
                    <td>${themeProgress(t.pos1250_med)}</td>
                    <td><span class="tag ${st.cls}">${st.label}</span></td>
                    <td class="hide-720">${lead ? `<span class="nm">${esc(lead.name)}</span> <span class="num ${cls(lead.pct)}">${pt(lead.pct)}</span>` : '<span class="flat">—</span>'}</td>
                  </tr>`;
                }).join('') : industries.map((s) => {
                  const lead = (s.peers || [])[0];
                  const st = s.avg_pct > 0.5 ? { label: '强势', cls: 'hot' } : s.avg_pct < -0.8 ? { label: '弱势', cls: 'cold' } : s.avg_pct < -0.2 ? { label: '偏弱', cls: '' } : { label: '平', cls: '' };
                  return `<tr data-industry="${esc(s.name)}" class="${s.name === state.selectedSector ? 'sel' : ''}">
                    <td><div class="nm">${esc(s.name)}</div><div class="sub">${s.count} 只</div></td>
                    <td class="r num ${cls(s.avg_pct)}">${pt(s.avg_pct)}</td>
                    <td class="r num">${s.up} / ${s.down}</td>
                    <td class="r num hide-720">${s.limit_up}</td>
                    <td class="r num hide-720">${s.signals?.plunge ?? '—'}</td>
                    <td><span class="tag ${st.cls}">${st.label}</span></td>
                    <td class="hide-720">${lead ? `<span class="nm">${esc(lead.name)}</span> <span class="num ${cls(lead.pct)}">${pt(lead.pct)}</span>` : '<span class="flat">—</span>'}</td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
        </section>

        <aside class="card sector-detail" id="sectorDetail">${isTheme ? themeDetail(selTheme) : industryDetail(selIndustry)}</aside>
      </div>
    `;
  }

  function etfRows(themeName) {
    const list = ETFS[themeName] || [];
    if (!list.length) return `<div class="empty">暂无对应 ETF</div>`;
    return list.map(([code, name]) => {
      const e = M.etfs.find((x) => x.code === code);
      return `<div class="etf-row" data-etf="${esc(code)}" role="button" tabindex="0" aria-label="查看 ${esc(name)} 持仓">
        <div><div>${esc(name)}</div><div class="code">${esc(code)}</div></div>
        <div class="etf-side">${e ? `<span class="num ${cls(e.pct)}">${pt(e.pct)}</span>` : '<span class="flat">—</span>'}<span class="etf-arrow">持仓 →</span></div>
      </div>`;
    }).join('');
  }
  function policyBlock(name) {
    const p = POLICIES[name];
    if (!p) return '';
    return `<div class="section-mini">政策追踪 <span class="tag ${p.cls}" style="font-size:9px">${esc(p.tone)}</span></div>
      <div class="policy-list">
        ${p.items.map(([date, issuer, title, impact]) => `<div class="policy-row">
          <span class="policy-date">${esc(date)}</span>
          <div><div class="policy-title">${esc(title)}</div><div class="policy-sub">${esc(issuer)} · ${esc(impact)}</div></div>
        </div>`).join('')}
      </div>
      <div class="policy-note">政策摘要 · 公开资料整理；最新原文以政府网站为准。<a class="policy-link" href="${policySearchUrl(name)}" target="_blank" rel="noreferrer">去政策库查 →</a></div>`;
  }
  function stockRows(list, max = 6) {
    if (!list || !list.length) return `<div class="empty">暂无 A 股成分</div>`;
    return list.slice(0, max).map((s) => `<div class="stock-mini" data-stock="${esc(s.code)}"><div><div class="nm">${esc(s.name)}</div><div class="code">${esc(s.code)}</div></div>${s.price == null ? `<div class="pct">${pt(s.pct)}</div><div class="signal">${esc(s.signal || '信号')}</div>` : `<div class="num">${nf(s.price, 2)}</div><div class="pct ${cls(s.pct)}">${pt(s.pct)}</div>`}</div>`).join('');
  }

  function themeDetail(t) {
    if (!t) return '';
    const st = themeState(t);
    const opp = themeOpportunity(t);
    const notes = NOTES[t.name] || { what: '', cycle: '', clear: '', watch: [] };
    const leads = themeStock(t, 6);
    const lead = leads[0];
    return `<div class="detail-pad">
      <div class="detail-kicker">${esc(t.group || '周期主题')} · ${t.count ? `${t.count} 只成分` : '暂无 A 股成分'} · 均涨实时 · 周期每日</div>
      <div class="detail-title"><h2>${esc(t.name)}</h2><span class="tag ${st.cls}">${st.label}</span></div>
      <div class="detail-title" style="margin-top:0"><b class="num ${cls(t.avg_pct)}" style="font-size:20px">${pt(t.avg_pct)}</b>${lead ? `<span class="meta" style="font-size:11px;color:var(--text-3)">龙头 ${esc(lead.name)} ${pt(lead.pct)}</span>` : ''}</div>
      <p class="detail-quote">${esc(t.desc || notes.what || '')}</p>

      <div class="opp-box ${opp.cls}">
        <div class="opp-head"><span class="tag ${opp.cls}">${opp.label}</span><b>机会分 ${opp.score}</b></div>
        <p>${esc(opp.why)}。${esc(opp.reasons.join(' · '))}</p>
        <small>${esc(notes.clear || '出清看亏损与产能退出；反转看价格止跌与需求回升。')}</small>
      </div>

      <div class="metric-grid">
        <div><span>小周期位置（1 年）</span><b>${t.pos250_med == null ? '—' : `${(t.pos250_med * 100).toFixed(0)}%`}</b></div>
        <div><span>大周期位置（5 年）</span><b>${t.pos1250_med == null ? '—' : `${(t.pos1250_med * 100).toFixed(0)}%`}</b></div>
        <div><span>PE 中位 / PB 中位</span><b>${t.pe_median == null ? '—' : t.pe_median.toFixed(1)} / ${t.pb_median == null ? '—' : t.pb_median.toFixed(2)}</b></div>
        <div><span>今日涨停</span><b>${t.limit_up ?? 0}</b></div>
      </div>

      <div class="section-mini">怎么看出清 / 反转</div>
      <ol class="chain">
        <li><b>${esc(notes.cycle || '先看周期位置，再看价格和供给。')}</b></li>
        <li>${esc(notes.clear || '出清看亏损与产能退出；反转看价格止跌与需求回升。')}</li>
        <li>${esc(notes.what || '')}</li>
      </ol>

      ${notes.watch && notes.watch.length ? `<div class="section-mini">先行指标</div><div class="kv">${notes.watch.map((w) => `<span class="chip">${esc(w)}</span>`).join('')}</div>` : ''}

      ${policyBlock(t.name)}

      <div class="section-mini">相关 ETF <span class="tag" style="font-size:9px">点开看持仓</span></div>
      ${etfRows(t.name)}

      <div class="section-mini">龙头股 <span class="tag" style="font-size:9px">按业务纯度</span></div>
      ${stockRows(leads, 6)}
      <div class="drawer-actions"><button class="btn" data-stock="${lead ? esc(lead.code) : ''}">看龙头技术面</button><button class="btn ghost" data-toast="已在现有插件中保留全部成分股">全部成分</button></div>
    </div>`;
  }

  function industryDetail(s) {
    if (!s) return '';
    const notes = NOTES[s.name] || {};
    return `<div class="detail-pad">
      <div class="detail-kicker">申万一级 · ${s.count} 只成分 · 均涨实时</div>
      <div class="detail-title"><h2>${esc(s.name)}</h2><span class="tag ${s.avg_pct > 0.5 ? 'hot' : s.avg_pct < -0.8 ? 'cold' : ''}">${s.avg_pct > 0.5 ? '今日强势' : s.avg_pct < -0.8 ? '今日弱势' : '今日平'}</span></div>
      <div class="detail-title" style="margin-top:0"><b class="num ${cls(s.avg_pct)}" style="font-size:20px">${pt(s.avg_pct)}</b><span class="meta" style="font-size:11px;color:var(--text-3)">${s.up} 涨 / ${s.down} 跌 · 涨停 ${s.limit_up}</span></div>
      <p class="detail-quote">${esc(notes.what || `${s.name}行业今日平均 ${pt(s.avg_pct)}，${s.up} 只上涨、${s.down} 只下跌。行业表只看当日强弱，周期位置请切到「周期主题」看对应赛道。`)}</p>

      <div class="metric-grid">
        <div><span>今日平均</span><b class="${cls(s.avg_pct)}">${pt(s.avg_pct)}</b></div>
        <div><span>上涨 / 下跌</span><b>${s.up} / ${s.down}</b></div>
        <div><span>涨停 / 跌停</span><b>${s.limit_up} / ${s.limit_down}</b></div>
        <div><span>近 20 日大跌</span><b>${s.signals?.plunge ?? '—'}</b></div>
      </div>

      <div class="section-mini">行业速读</div>
      <ol class="chain">
        <li>${esc(notes.cycle || '行业当日强弱受权重股和资金流向影响，先看龙头是否共振。')}</li>
        <li>${esc(notes.clear || '行业级出清指标尚未接入；建议切换到周期主题，看库存、价格和产能。')}</li>
      </ol>

      <div class="section-mini">相关 ETF <span class="tag" style="font-size:9px">点开看持仓</span></div>
      ${etfRows(s.name)}

      <div class="section-mini">今日信号股 <span class="tag" style="font-size:9px">按涨幅</span></div>
      ${stockRows(s.peers, 6)}
      <div class="drawer-actions"><button class="btn" data-stock="${s.peers?.[0]?.code || ''}">看龙头技术面</button><button class="btn ghost" data-toast="已在现有插件中保留全部成分股">全部成分</button></div>
    </div>`;
  }

  /* ---------- stock drawer ---------- */
  function getStock(code) {
    const item = state.index.find((x) => x.code === code || x.etfCode === code);
    if (!item) return null;
    return {
      code: item.etfCode || item.code,
      name: item.name,
      industry: item.industry || item.sub || '—',
      price: item.price == null ? null : item.price,
      pct: item.pct == null ? null : item.pct,
      pe: item.pe, pb: item.pb, mcap: item.mcap,
      turnover: item.turnover, pos250: item.pos250, pos1250: item.pos1250,
      bars: null, intra: null, loading: true, error: '',
      isEtf: item.type === 'ETF', sub: item.sub,
    };
  }

  async function fetchStock(code, base) {
    const q = String(code).replace(/^[a-z]{2}/i, '');
    const [day, min] = await Promise.all([
      jget(`stock.json?code=${encodeURIComponent(q)}&period=day`),
      jget(`stock.json?code=${encodeURIComponent(q)}&period=min`).catch(() => null),
    ]);
    if (!day || day.error || !Array.isArray(day.bars) || !day.bars.length) return null;
    const bars = day.bars.map((b) => [b.d, b.o, b.h, b.l, b.c, b.v]);
    const quote = day.quote || {};
    const last = bars[bars.length - 1];
    const price = quote.price ?? last[4];
    const pct = quote.pct ?? (quote.prev ? (price / quote.prev - 1) * 100 : base.pct);
    const points = min && Array.isArray(min.points) ? min.points : null;
    return {
      ...base,
      code: q,
      name: quote.name || base.name,
      price,
      pct,
      prev: quote.prev ?? (price / (1 + (pct || 0) / 100)),
      open: quote.open, high: quote.high, low: quote.low,
      amount: quote.amount, turnover: quote.turnover, vol_ratio: quote.vol_ratio,
      rsi14: day.rsi && day.rsi.length ? day.rsi[day.rsi.length - 1] : base.rsi14,
      pos250: day.summary && day.summary.pos != null ? day.summary.pos : base.pos250,
      bars,
      intra: points,
      intraDate: min ? min.date : null,
      loading: false,
      error: '',
      real: true,
      isEtf: !!base.isEtf,
      sub: base.sub,
      industry: base.industry,
    };
  }

  async function fetchAnnouncements(code) {
    const q = code6(code);
    if (state.annCache.has(q)) return state.annCache.get(q);
    const data = await jget(`announcements.json?code=${encodeURIComponent(q)}`);
    const rows = data && Array.isArray(data.rows) ? data.rows : [];
    state.annCache.set(q, rows);
    return rows;
  }

  function annBlock(s) {
    if (!s || s.isEtf) return '';
    if (s.annLoading) return `<div class="read-block"><h3>公司公告</h3><p>正在读取最近公告…</p></div>`;
    if (s.annError) return `<div class="read-block"><h3>公司公告</h3><p>公告读取失败：${esc(s.annError)}。公告脚本可单独运行。</p></div>`;
    const list = s.announcements || [];
    if (!list.length) return `<div class="read-block"><h3>公司公告</h3><p>暂无最近公告。运行 <code>python3 announcements.py</code> 抓取后刷新。</p></div>`;
    return `<div class="read-block"><h3>公司公告 <span style="font-weight:400;color:var(--text-3)">最近 ${list.length} 条 · 巨潮资讯</span></h3>
      <div class="ann-list">${list.slice(0, 8).map((a) => `<div class="ann-row">
        <span class="ann-date">${esc(a.date || '')}</span>
        <div class="ann-main"><a href="${esc(a.url || '#')}" target="_blank" rel="noreferrer">${esc(a.title || '公告')}</a><small>${esc(a.type || '公告')}</small></div>
      </div>`).join('')}</div>
    </div>`;
  }

  async function fetchEtfHoldings(code) {
    if (!apiAvailable()) throw new Error('无法连接 Host 接口');
    const url = `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNInverstPosition?FCODE=${encodeURIComponent(code)}&deviceid=1&plat=Android&product=EFund&version=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`持仓接口 HTTP ${res.status}`);
    const d = await res.json();
    const stocks = d && d.Datas && d.Datas.fundStocks;
    if (!d || !d.Success || !Array.isArray(stocks) || !stocks.length) {
      throw new Error((d && (d.ErrMsg || d.Message)) || '暂无持仓数据');
    }
    return {
      as_of: d.Expansion || '',
      source: '天天基金',
      holdings: stocks.slice(0, 10).map((x) => ({
        code: String(x.GPDM || '').padStart(6, '0'),
        name: x.GPJC || '',
        weight: Number.isFinite(Number(x.JZBL)) ? Number(x.JZBL) : null,
        change: Number.isFinite(Number(x.PCTNVCHG)) ? Number(x.PCTNVCHG) : null,
        change_type: x.PCTNVCHGTYPE || '',
        industry: x.INDEXNAME || '',
      })).filter((x) => /^\d{6}$/.test(x.code)),
    };
  }

  function etfHoldingsBlock(s) {
    if (s.holdingsLoading) return `<div class="read-block"><h3>前十大持仓</h3><p>正在读取基金持仓…</p></div>`;
    if (s.holdingsError) return `<div class="read-block"><h3>前十大持仓</h3><p>持仓加载失败：${esc(s.holdingsError)}</p></div>`;
    const h = s.holdings;
    if (!h || !h.holdings || !h.holdings.length) return `<div class="read-block"><h3>前十大持仓</h3><p>暂无持仓数据。</p></div>`;
    const max = Math.max(...h.holdings.map((x) => x.weight || 0), 1);
    return `<div class="read-block"><h3>前十大持仓 <span style="font-weight:400;color:var(--text-3)">截至 ${esc(h.as_of || '—')} · ${esc(h.source || '天天基金')}</span></h3>
      <div class="hold-list">${h.holdings.map((x) => `<div class="hold-row" data-stock="${esc(x.code)}">
        <div class="hold-name"><b>${esc(x.name)}</b><small>${esc(x.code)}${x.industry ? ` · ${esc(x.industry)}` : ''}</small></div>
        <div class="hold-bar"><i style="width:${Math.max(3, (x.weight || 0) / max * 100)}%"></i></div>
        <b class="num">${x.weight == null ? '—' : x.weight.toFixed(2) + '%'}</b>
      </div>`).join('')}</div>
      <p class="hold-note">ETF 披露的前十大持仓，非全部；权重为基金资产净值占比。点击个股可看行情。</p>
    </div>`;
  }

  async function openStock(code) {
    const s = getStock(code);
    if (!s) return toast('没有找到这只股票');
    state.stock = { ...s, annLoading: !s.isEtf, announcements: [], annError: '', holdingsLoading: !!s.isEtf, holdings: null, holdingsError: '' };
    state.period = s.isEtf ? 'intraday' : 'day';
    renderDrawer();
    $('#mask').classList.add('on');
    $('#drawer').classList.add('open');
    $('#closeDrawer').focus();
    if (!apiAvailable()) {
      state.stock = { ...s, loading: false, error: '无法连接 Host 接口', annLoading: false, announcements: [], annError: '' };
      renderDrawer();
      return;
    }
    const annP = s.isEtf
      ? Promise.resolve([])
      : fetchAnnouncements(s.code).catch((err) => ({ error: String(err && err.message ? err.message : err) }));
    const holdP = s.isEtf
      ? fetchEtfHoldings(s.code).catch((err) => ({ error: String(err && err.message ? err.message : err) }))
      : Promise.resolve(null);
    try {
      const [live, ann, hold] = await Promise.all([fetchStock(s.code, s), annP, holdP]);
      if (state.stock && state.stock.code === s.code) {
        state.stock = {
          ...(live || { ...s, loading: false, error: '个股接口返回为空' }),
          announcements: Array.isArray(ann) ? ann : [],
          annLoading: false,
          annError: ann && ann.error ? ann.error : '',
          holdings: hold && hold.holdings ? hold : null,
          holdingsLoading: false,
          holdingsError: hold && hold.error ? hold.error : '',
        };
        renderDrawer();
      }
    } catch (err) {
      const [ann, hold] = await Promise.all([annP, holdP]);
      if (state.stock && state.stock.code === s.code) {
        state.stock = {
          ...s,
          loading: false,
          error: String(err && err.message ? err.message : err),
          announcements: Array.isArray(ann) ? ann : [],
          annLoading: false,
          annError: ann && ann.error ? ann.error : '',
          holdings: hold && hold.holdings ? hold : null,
          holdingsLoading: false,
          holdingsError: hold && hold.error ? hold.error : '',
        };
        renderDrawer();
      }
    }
  }

  function closeStock() {
    $('#drawer').classList.remove('open');
    $('#mask').classList.remove('on');
    state.stock = null;
  }

  function renderDrawer() {
    const s = state.stock;
    if (!s) return;
    const pctCls = cls(s.pct);
    const loading = !s.bars && !s.error;
    const tabs = s.isEtf ? [['intraday', '分时']] : [['intraday', '分时'], ['day', '日 K'], ['week', '周 K'], ['month', '月 K']];
    const metaText = loading ? '读取真实行情…' : s.error ? '加载失败' : '真实日线 · ETL 快照';
    $('#drawerContent').innerHTML = `
      <div class="drawer-head">
        <div class="who">
          <div class="nm"><h2>${esc(s.name)}</h2><span>${esc(s.code)}</span></div>
          <div class="px"><b class="${pctCls}">${s.price == null ? '—' : nf(s.price, s.price < 10 ? 3 : 2)}</b><span class="${pctCls}">${pt(s.pct)}</span><span style="color:var(--text-3);font-size:10.5px">${esc(s.isEtf ? 'ETF' : (s.industry || s.sub || ''))}</span></div>
        </div>
        <button class="x" id="closeDrawer" aria-label="关闭">✕</button>
      </div>
      <div class="drawer-tabs">
        ${tabs.map(([k, l]) => `<button data-period="${k}" class="${state.period === k ? 'active' : ''}">${l}</button>`).join('')}
        <span class="spacer"></span>
        <span class="meta" id="chartMeta" style="font-size:10px;color:var(--text-3);padding:0 4px 9px">${metaText}</span>
      </div>
      <div class="ma-legend" id="chartLegend">
        <span><i style="background:#d9a300"></i>MA5</span>
        <span><i style="background:#3156d3"></i>MA10</span>
        <span><i style="background:#8b5cf6"></i>MA20</span>
        <span><i style="background:#7c8494"></i>MA60</span>
        <span style="margin-left:auto">${s.isEtf ? 'ETF 技术指标以跟踪指数为准' : '前复权 · 真实行情'}</span>
      </div>
      <div class="chart-box">${loading || s.error ? `<div class="drawer-state">${loading ? '正在读取真实日线 / 分时…' : `行情加载失败：${esc(s.error)}`}</div>` : '<svg id="stockChart" viewBox="0 0 760 410" preserveAspectRatio="xMidYMid meet"></svg>'}</div>
      <div class="drawer-body">
        ${loading ? `<div class="read-block"><h3>正在读取</h3><p>请求 /api/sector-board/stock.json；返回前不生成假 K 线。</p></div>` : s.error ? `<div class="read-block"><h3>无法加载</h3><p>${esc(s.error)}。请关闭后重试，或检查 Host 服务。</p></div>` : (s.isEtf ? '' : stockRead(s))}
        ${s.isEtf ? etfHoldingsBlock(s) : ''}
        ${s.isEtf ? `<div class="read-block"><h3>ETF 说明</h3><p>这是 ${esc(s.name)}（${esc(s.code)}）的行情概览。ETF 的技术指标应看跟踪指数；个股 MACD / 均线分析请在股票上使用。</p></div>` : ''}
        ${annBlock(s)}
        <div class="drawer-actions"><button class="btn primary" data-toast="自选功能待接入">加入自选</button><button class="btn" data-toast="完整行情来自 Host stock.json">查看完整行情</button></div>
      </div>
    `;
    requestAnimationFrame(() => drawChart(s));
  }

  function drawChart(s) {
    const el = $('#stockChart');
    if (!el || !s || !s.bars || !s.bars.length) return;
    const intraday = state.period === 'intraday';
    if (intraday && (!s.intra || s.intra.length < 2)) {
      el.outerHTML = '<div class="drawer-state">暂无分时数据</div>';
      const meta = $('#chartMeta'), legend = $('#chartLegend');
      if (meta) meta.textContent = '暂无分时';
      if (legend) legend.innerHTML = '';
      return;
    }
    el.innerHTML = intraday ? intradaySvg(s) : klineSvg(s, state.period);
    const meta = $('#chartMeta'), legend = $('#chartLegend');
    if (intraday) {
      if (meta) meta.textContent = '分时 · 真实行情';
      if (legend) legend.innerHTML = `<span><i style="background:var(--up)"></i>价格</span><span><i style="background:#d9a300"></i>均价</span><span style="margin-left:auto">ETL 快照 · 非逐笔</span>`;
    } else {
      if (meta) meta.textContent = '真实日线 · ETL 快照';
      if (legend) legend.innerHTML = `<span><i style="background:#d9a300"></i>MA5</span><span><i style="background:#3156d3"></i>MA10</span><span><i style="background:#8b5cf6"></i>MA20</span><span><i style="background:#7c8494"></i>MA60</span><span style="margin-left:auto">${s.isEtf ? 'ETF 技术指标以跟踪指数为准' : '前复权 · 真实行情'}</span>`;
    }
  }

  function intradaySvg(s) {
    const W = 760, H = 410, L = 54, R = 16, T = 18, B = 300;
    const real = s.intra && s.intra.length > 1 ? s.intra : null;
    const prev = s.prev != null ? s.prev : s.price / (1 + (s.pct || 0) / 100);
    let vals = [], avg = [], times = [];
    if (real) {
      vals = real.map((x) => num(x.p)).filter((v) => v != null);
      avg = real.map((x, i) => num(x.avg) ?? (vals.slice(0, i + 1).reduce((a, b) => a + b, 0) / (i + 1)));
      times = real.map((x) => String(x.t || ''));
    }
    if (!vals.length) return '';
    const n = vals.length;
    const lo = Math.min(...vals, prev), hi = Math.max(...vals, prev);
    const pad = Math.max((hi - lo) * 0.12, 0.01);
    const y = (v) => T + (1 - (v - lo + pad) / (hi - lo + pad * 2)) * (B - T);
    const x = (i) => L + (i / Math.max(1, n - 1)) * (W - L - R);
    const line = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    const area = `${line}L${x(n - 1).toFixed(1)},${B}L${x(0).toFixed(1)},${B}Z`;
    const avgLine = avg.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    const color = s.pct >= 0 ? 'var(--up)' : 'var(--down)';
    const grid = [0, 1, 2, 3].map((i) => {
      const gy = T + (i / 3) * (B - T);
      const v = hi - (i / 3) * (hi - lo);
      return `<line x1="${L}" y1="${gy}" x2="${W - R}" y2="${gy}" stroke="var(--line-2)"/><text x="${L - 7}" y="${gy + 3}" text-anchor="end" font-size="9" fill="var(--text-3)">${v.toFixed(2)}</text>`;
    }).join('');
    const pick = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.min(n - 1, Math.max(0, Math.round((n - 1) * f))));
    const label = (i) => {
      const t = times[i];
      if (!t) return '';
      if (t.length >= 4 && /^\d{3,4}$/.test(t)) return `${t.slice(0, 2)}:${t.slice(2, 4)}`;
      return t;
    };
    const xl = pick.filter((v, i, arr) => arr.indexOf(v) === i).map((i, k, arr) => `<text x="${x(i)}" y="${H - 8}" text-anchor="${k === 0 ? 'start' : k === arr.length - 1 ? 'end' : 'middle'}" font-size="9" fill="var(--text-3)">${esc(label(i))}</text>`).join('');
    return `<defs><linearGradient id="ig" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".18"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
      ${grid}<line x1="${L}" y1="${y(prev)}" x2="${W - R}" y2="${y(prev)}" stroke="var(--text-3)" stroke-dasharray="3 3" opacity=".7"/>
      <path d="${area}" fill="url(#ig)"/><path d="${line}" fill="none" stroke="${color}" stroke-width="1.5"/>
      <path d="${avgLine}" fill="none" stroke="#d9a300" stroke-width=".9" opacity=".85"/>
      <text x="${L}" y="${B + 18}" font-size="9" fill="var(--text-3)">昨收 ${prev.toFixed(2)} · 均价 ${avg[avg.length - 1].toFixed(2)} · 真实分时</text>
      ${xl}`;
  }

  function aggBars(bars, size) {
    const out = [];
    for (let i = 0; i < bars.length; i += size) {
      const chunk = bars.slice(i, i + size);
      if (!chunk.length) continue;
      out.push([chunk[chunk.length - 1][0], chunk[0][1], Math.max(...chunk.map((b) => b[2])), Math.min(...chunk.map((b) => b[3])), chunk[chunk.length - 1][4], chunk.reduce((a, b) => a + b[5], 0)]);
    }
    return out;
  }

  function klineSvg(s, period) {
    const all = s.bars || [];
    if (all.length < 30) return '';
    const size = period === 'week' ? 5 : period === 'month' ? 21 : 1;
    const view = aggBars(all, size).slice(-64);
    if (!view.length) return '';
    const closes = all.map((b) => b[4]);
    const ma5 = ma(closes, 5), ma10 = ma(closes, 10), ma20 = ma(closes, 20), ma60 = ma(closes, 60);
    const mac = macd(closes);
    const offset = all.length - view.length * size;
    const W = 760, H = 410, L = 54, R = 58, T = 18, PB = 238, V1 = 258, V2 = 300, M1 = 322, M2 = 398;
    const lo = Math.min(...view.map((b) => b[3]));
    const hi = Math.max(...view.map((b) => b[2]));
    const pad = (hi - lo) * 0.07 || 0.1;
    const y = (v) => T + (1 - (v - (lo - pad)) / (hi - lo + pad * 2)) * (PB - T);
    const step = (W - L - R) / view.length;
    const x = (i) => L + step * i + step / 2;
    const maxVol = Math.max(...view.map((b) => b[5]));
    const maxHist = Math.max(...view.map((b, i) => Math.abs(mac.hist[offset + i] ?? 0)), 0.01);
    const volY = (v) => V2 - (v / maxVol) * (V2 - V1);
    const macY = (v) => M1 + (1 - (v / maxHist + 1) / 2) * (M2 - M1);
    const grid = [0, 1, 2, 3, 4].map((i) => {
      const gy = T + (i / 4) * (PB - T);
      const v = hi - (i / 4) * (hi - lo);
      return `<line x1="${L}" y1="${gy}" x2="${W - R}" y2="${gy}" stroke="var(--line-2)"/><text x="${W - R + 6}" y="${gy + 3}" font-size="9" fill="var(--text-3)">${v.toFixed(2)}</text>`;
    }).join('');
    const candles = view.map((b, i) => {
      const [_, o, h, l, c, v] = b;
      const up = c >= o;
      const col = up ? 'var(--up)' : 'var(--down)';
      const bodyT = y(Math.max(o, c)), bodyB = y(Math.min(o, c));
      const bw = Math.max(1.4, step * 0.55);
      return `<line x1="${x(i)}" y1="${y(h)}" x2="${x(i)}" y2="${y(l)}" stroke="${col}" stroke-width="1"/>
        <rect x="${x(i) - bw / 2}" y="${bodyT}" width="${bw}" height="${Math.max(1, bodyB - bodyT)}" fill="${col}" opacity="${up ? '.9' : '.9'}"/>
        <rect x="${x(i) - bw / 2}" y="${volY(v)}" width="${bw}" height="${V2 - volY(v)}" fill="${col}" opacity=".35"/>`;
    }).join('');
    const path = (arr, color, w = 1) => {
      let d = '', started = false;
      view.forEach((b, i) => {
        const v = arr[offset + i];
        if (v == null) return;
        d += `${started ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
        started = true;
      });
      return d ? `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" opacity=".95"/>` : '';
    };
    const macLines = (() => {
      let d1 = '', d2 = '', started = false;
      view.forEach((b, i) => {
        const di = mac.dif[offset + i], de = mac.dea[offset + i];
        if (di == null || de == null) return;
        d1 += `${started ? 'L' : 'M'}${x(i).toFixed(1)},${macY(di).toFixed(1)}`;
        d2 += `${started ? 'L' : 'M'}${x(i).toFixed(1)},${macY(de).toFixed(1)}`;
        started = true;
      });
      return `<path d="${d1}" fill="none" stroke="#d9a300" stroke-width=".9"/><path d="${d2}" fill="none" stroke="#3156d3" stroke-width=".9"/>`;
    })();
    const hist = view.map((b, i) => {
      const v = mac.hist[offset + i] ?? 0;
      const yy = macY(v), base = macY(0);
      return `<rect x="${x(i) - Math.max(1, step * 0.3)}" y="${Math.min(yy, base)}" width="${Math.max(1.2, step * 0.6)}" height="${Math.max(.6, Math.abs(base - yy))}" fill="${v >= 0 ? 'var(--up)' : 'var(--down)'}" opacity=".5"/>`;
    }).join('');
    const labels = [0, Math.floor(view.length / 3), Math.floor((view.length * 2) / 3), view.length - 1].map((i) => `<text x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === view.length - 1 ? 'end' : 'middle'}" font-size="9" fill="var(--text-3)">${esc(view[i][0].slice(5))}</text>`).join('');
    return `${grid}
      <text x="${L}" y="${T - 5}" font-size="9" fill="var(--text-3)">价格 · 成交量 · MACD (12,26,9)</text>
      ${candles}
      ${path(ma5, '#d9a300')}${path(ma10, '#3156d3')}${path(ma20, '#8b5cf6')}${path(ma60, '#7c8494')}
      <line x1="${L}" y1="${M1 - 8}" x2="${W - R}" y2="${M1 - 8}" stroke="var(--line-2)"/>
      ${macLines}${hist}
      <line x1="${L}" y1="${macY(0)}" x2="${W - R}" y2="${macY(0)}" stroke="var(--line)" stroke-dasharray="2 3"/>
      ${labels}`;
  }

  function stockRead(s) {
    const bars = s.bars || [];
    if (bars.length < 30) return '<div class="read-block"><h3>K 线数据不足</h3><p>真实日线少于 30 根，无法计算稳定的均线 / MACD 指标。</p></div>';
    const closes = bars.map((b) => b[4]);
    const ma5 = ma(closes, 5), ma10 = ma(closes, 10), ma20 = ma(closes, 20), ma60 = ma(closes, 60);
    const mac = macd(closes);
    const r = rsi(closes);
    const cross = lastCross(mac.dif, mac.dea);
    const i = closes.length - 1;
    const c = closes[i];
    const m5 = ma5[i], m10 = ma10[i], m20 = ma20[i], m60 = ma60[i];
    const maText = m5 == null ? '均线数据不足' : m5 > m10 && m10 > m20 ? '均线多头排列' : m5 < m10 && m10 < m20 ? '均线空头排列' : '均线纠缠';
    const zone = mac.dif[i] > 0 && mac.dea[i] > 0 ? '零轴上方' : mac.dif[i] < 0 && mac.dea[i] < 0 ? '零轴下方' : '零轴附近';
    const crossText = cross.i < 0 ? '近期无交叉' : `${cross.type} · ${bars[cross.i]?.[0]?.slice(5) || ''}`;
    const rv = s.rsi14 != null ? s.rsi14 : (r[i] == null ? null : r[i]);
    const rText = rv == null ? '—' : rv > 70 ? '超买' : rv < 30 ? '超卖' : '中性';
    const sup = Math.min(...bars.slice(-20).map((b) => b[3]));
    const res = Math.max(...bars.slice(-20).map((b) => b[2]));
    const loAll = Math.min(...closes), hiAll = Math.max(...closes);
    const posNum = s.pos250 ?? (hiAll > loAll ? (s.price - loAll) / (hiAll - loAll) : null);
    const pos = posNum == null ? null : `${(posNum * 100).toFixed(0)}%`;
    const vols = bars.map((b) => b[5]).filter((v) => v > 0);
    const avg5 = vols.length >= 5 ? vols.slice(-5).reduce((a, b) => a + b, 0) / 5 : null;
    const volNum = s.vol_ratio ?? (avg5 ? vols[vols.length - 1] / avg5 : null);
    const ma20Dist = s.ma20_dist ?? (m20 ? s.price / m20 - 1 : null);
    const posLabel = '1 年位置';
    const volLabel = '量比';
    const read = `${esc(s.name)} 今日 ${pt(s.pct)}，收于 ${nf(s.price, s.price < 10 ? 3 : 2)}。${maText}；MACD ${crossText}，位于${zone}；RSI ${rv == null ? '—' : rv.toFixed(1)}（${rText}）。短期支撑 ${nf(sup, 2)}，压力 ${nf(res, 2)}。`;
    return `<div class="read-grid">
        <div><span>MACD</span><b>${crossText}</b></div>
        <div><span>均线</span><b>${maText}</b></div>
        <div><span>RSI14</span><b>${rv == null ? '—' : rv.toFixed(1)} · ${rText}</b></div>
        <div><span>零轴</span><b>${zone}</b></div>
        <div><span>${posLabel}</span><b>${pos || '—'}</b></div>
        <div><span>${volLabel}</span><b>${volNum == null ? '—' : volNum.toFixed(2)}</b></div>
      </div>
      <div class="read-block"><h3>技术解读</h3><p>${read}</p></div>
      <div class="read-block"><h3>关键位</h3><ul class="read-list">
        <li><span>20 日支撑</span><b class="num">${nf(sup, 2)}</b></li>
        <li><span>20 日压力</span><b class="num">${nf(res, 2)}</b></li>
        <li><span>MA20 距离</span><b class="num">${ma20Dist == null ? '—' : `${(ma20Dist * 100).toFixed(2)}%`}</b></li>
      </ul></div>
      ${s.real ? `<div class="read-block"><h3>候选证据</h3><p>${esc(s.evidence || '—')}</p></div>
      <div class="read-block"><h3>触发 / 失效</h3><p>触发：${esc(s.trigger || '—')}<br/>失效：${esc(s.invalid || '—')}</p></div>` : ''}`;
  }

  /* ---------- paper ---------- */
  function equitySvg() {
    const eq = M.paper.equity || [];
    if (!eq.length) return '<div class="empty" style="padding:24px 16px">暂无净值记录</div>';
    const W = 720, H = 150, L = 42, R = 12, T = 12, B = 128;
    const vals = eq.map((e) => e.equity);
    const lo = Math.min(...vals) - 80, hi = Math.max(...vals) + 80;
    const x = (i) => L + (eq.length === 1 ? 0 : (i / (eq.length - 1)) * (W - L - R));
    const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (B - T);
    const d = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    const base = y(M.paper.initial);
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <line x1="${L}" y1="${base}" x2="${W - R}" y2="${base}" stroke="var(--line)" stroke-dasharray="3 4"/>
      <text x="${W - R}" y="${base - 5}" text-anchor="end" font-size="9" fill="var(--text-3)">本金 ${nf(M.paper.initial, 0)}</text>
      <path d="${d}" fill="none" stroke="var(--accent)" stroke-width="1.6"/>
      <text x="${L}" y="${H - 4}" font-size="9" fill="var(--text-3)">${esc(String(eq[0].date).slice(5))}</text>
      <text x="${W - R}" y="${H - 4}" text-anchor="end" font-size="9" fill="var(--text-3)">${esc(String(eq[eq.length - 1].date).slice(5))}</text>
    </svg>`;
  }

  function renderPaper() {
    const P = M.paper || emptyModel().paper;
    const pd = paperDay();
    const lastDate = pd.last.date;
    const todaysTrades = (P.trades || []).filter((t) => t.date === lastDate);
    const decisions = [...(P.decisions || [])].sort((a, b) => String(b.at || b.date).localeCompare(String(a.at || a.date)));
    const decision = decisions[0];
    const recentTrades = [...(P.trades || [])]
      .sort((a, b) => String(b.at || b.date).localeCompare(String(a.at || a.date)))
      .slice(0, 5);
    const updatedAt = P.updated_at ? String(P.updated_at).slice(0, 16).replace('T', ' ') : '—';
    const eq = P.equity || [];
    const rows = [];
    for (let i = eq.length - 1; i >= Math.max(1, eq.length - 10); i--) {
      const pnl = eq[i].equity - eq[i - 1].equity;
      const pc = (pnl / eq[i - 1].equity) * 100;
      const ts = (M.paper.trades || []).filter((t) => t.date === eq[i].date);
      rows.push(`<tr><td class="num">${esc(eq[i].date)}</td><td class="num ${cls(pnl)}">${pnl > 0 ? '+' : ''}${nf(pnl, 2)}</td><td class="num ${cls(pc)}">${pt(pc)}</td><td class="num">${nf(eq[i].equity, 2)}</td><td class="num">${ts.length} 笔</td></tr>`);
    }
    const alloc = (v) => ((v / M.paper.nav) * 100).toFixed(1);
    const paperTitle = todaysTrades.length
      ? `最近交易日做了 ${todaysTrades.length} 笔，账户${pd.pnl >= 0 ? '小赚' : '小亏'}。`
      : `最近交易日没有交易，先看账户。`;
    const robot = M.paper.robot || {};
    const lastRun = robot.last_run ? String(robot.last_run).slice(0, 16).replace('T', ' ') : '—';
    $('#page-paper').innerHTML = `
      <div class="page-head">
        <div>
          <div class="kicker">模拟盘 · 每日交易成果${cadence('净值 10 秒 · 决策每日 14:50')}</div>
          <h1>${esc(paperTitle)}</h1>
          <p class="lede">${esc(lastDate)} 收盘净值 ${nf(pd.last.equity, 2)}，当日 ${pt(pd.pct)}，累计 ${pt(M.paper.total_pnl_pct)}。${decision ? `最近决策 ${esc(decision.action)}（${esc(decision.date)} ${esc(String(decision.at || '').slice(11, 16))}）。` : ''}机器人最近运行 ${esc(lastRun)}；账本更新 ${esc(updatedAt)}；只做模拟，不接实时下单。</p>
        </div>
        <div class="head-actions"><button class="btn" data-toast="模拟盘不接实时下单">交易记录</button><button class="btn primary" data-toast="机器人每个交易日 14:50 自动运行；此页只读展示">决策规则</button></div>
      </div>

      <div class="kpis">
        <div><span>最近交易日盈亏</span><b class="${cls(pd.pnl)}">${pd.pnl > 0 ? '+' : ''}${nf(pd.pnl, 2)}</b><small>${pt(pd.pct)}</small></div>
        <div><span>累计收益</span><b class="${cls(M.paper.total_pnl)}">${M.paper.total_pnl > 0 ? '+' : ''}${nf(M.paper.total_pnl, 2)}</b><small>${pt(M.paper.total_pnl_pct)}</small></div>
        <div><span>持仓市值</span><b>${nf(M.paper.positions_value, 2)}</b><small>仓位 ${((M.paper.positions_value / M.paper.nav) * 100).toFixed(1)}%</small></div>
        <div><span>现金</span><b>${nf(M.paper.cash, 2)}</b><small>初始 ${nf(M.paper.initial, 0)}</small></div>
      </div>

      <div class="paper-grid">
        <div class="stack">
          <section class="card">
            <div class="card-h"><h2>净值曲线</h2><span class="meta">${eq.length} 个交易日 · 以收盘净值计</span></div>
            <div class="equity-box">${equitySvg()}</div>
          </section>
          <section class="card">
            <div class="card-h"><h2>每日结果</h2><span class="meta">最近 10 个交易日</span></div>
            <div class="table-wrap"><table class="t">
              <thead><tr><th>日期</th><th class="r">当日盈亏</th><th class="r">当日</th><th class="r">净值</th><th class="r">交易</th></tr></thead>
              <tbody>${rows.join('')}</tbody>
            </table></div>
          </section>
          <section class="card">
            <div class="card-h"><h2>当前持仓</h2><span class="meta">${M.paper.positions.length} 只 · 仓位 ${((M.paper.positions_value / M.paper.nav) * 100).toFixed(1)}%</span></div>
            <div class="table-wrap"><table class="t">
              <thead><tr><th>标的</th><th class="r">数量</th><th class="r">成本</th><th class="r">现价</th><th class="r">盈亏</th><th class="r">仓位</th></tr></thead>
              <tbody>${M.paper.positions.map((p) => `<tr data-stock="${esc(p.code)}"><td><div class="nm">${esc(p.name)}</div><div class="sub">${esc(p.code)}</div></td><td class="r num">${nf(p.qty)}</td><td class="r num">${nf(p.cost, 3)}</td><td class="r num">${nf(p.price, 3)}</td><td class="r num ${cls(p.pnl)}">${p.pnl > 0 ? '+' : ''}${nf(p.pnl, 2)}</td><td class="r num">${alloc(p.value)}%</td></tr>`).join('')}</tbody>
            </table></div>
          </section>
        </div>

        <div class="stack">
          <section class="card">
            <div class="card-h"><h2>最近决策</h2><span class="meta">${esc(decision?.mode || '')}</span></div>
            <div class="decision">
              <div class="h"><span>${esc(decision?.date || '')} · ${esc(decision?.action || '')}</span><span>情绪 ${decision?.sentiment ?? '—'}</span></div>
              <p>${esc(decision?.summary || '—')}</p>
              <div class="warnline">机器人最近运行 ${esc(lastRun)} · 下次 ${esc(robot.next_run || '工作日 14:50')}</div>
            </div>
          </section>
          <section class="card">
            <div class="card-h"><h2>最近成交</h2><span class="meta">最近 ${Math.min(5, M.paper.trades.length)} 笔 · ${esc(lastDate)} ${todaysTrades.length} 笔 · 更新 ${esc(updatedAt)}</span></div>
            ${recentTrades.map((t) => `<div class="money-row" data-stock="${esc(t.code)}"><span class="src">${t.side === 'buy' ? '买入' : '卖出'}</span><span class="who">${esc(t.name)} <small>${nf(t.qty)} 股</small></span><span class="val">${nf(t.amount, 2)}</span></div>`).join('') || '<div class="empty" style="padding:14px 20px">暂无成交</div>'}
          </section>
          <section class="card">
            <div class="card-h"><h2>规则</h2></div>
            <div class="detail-pad" style="padding-top:12px">
              <div class="kv"><span class="chip">周/月持有</span><span class="chip">底部反转</span><span class="chip">不追高</span></div>
              <p class="detail-quote">初始资金 10 万，只做模拟，不接实时下单。每个交易日 14:50 由 launchd 触发机器人；规则或 opencode 两种决策模式。</p>
            </div>
          </section>
        </div>
      </div>
    `;
  }

  /* ---------- more ---------- */
  let learnLS;
  function learnStorage() {
    if (learnLS !== undefined) return learnLS;
    learnLS = null;
    try {
      const s = window.localStorage;
      s.setItem('__sb_probe', '1'); s.removeItem('__sb_probe');
      learnLS = s;
    } catch (e) {
      try {
        const p = window.parent.localStorage;
        p.setItem('__sb_probe', '1'); p.removeItem('__sb_probe');
        learnLS = p;
      } catch (e2) { learnLS = null; }
    }
    return learnLS;
  }

  function learnDoneSet() {
    try {
      const ls = learnStorage();
      const raw = JSON.parse((ls && ls.getItem('sb-learn-done-v1')) || '[]');
      return new Set(Array.isArray(raw) ? raw.filter((n) => Number.isInteger(n) && n >= 1 && n <= 30) : []);
    } catch (e) { return new Set(); }
  }

  function saveLearnDone(set) {
    try {
      const ls = learnStorage();
      if (ls) ls.setItem('sb-learn-done-v1', JSON.stringify([...set].sort((a, b) => a - b)));
    } catch (e) {}
  }

  function learnCurrent(done) {
    for (let i = 1; i <= 30; i++) if (!done.has(i)) return i;
    return 30;
  }

  function renderLearn() {
    const done = learnDoneSet();
    const day = Math.min(30, Math.max(1, state.learnDay || learnCurrent(done)));
    const d = LEARN_DAYS[day - 1];
    const complete = done.has(day);
    const allDone = done.size >= 30;
    const pct = Math.round((done.size / 30) * 100);
    const m = M.market || {};
    const idx = (M.indices || [])[0] || {};
    const top = (topSectors(1)[0] || {});
    const sent = (M.decision && M.decision.sentiment) || {};
    const src = '实盘快照';
    const weeksHtml = [0, 1, 2, 3].map((w) => {
      const days = LEARN_DAYS.map((x, i) => ({ ...x, n: i + 1 })).filter((x) => x.w === w + 1);
      return `<div class="lweek"><h4>${LEARN_WEEK_TITLES[w]}<span>${days.filter((x) => done.has(x.n)).length}/${days.length}</span></h4>${days.map((x) => `<button class="lday ${done.has(x.n) ? 'done' : ''} ${x.n === day ? 'cur' : ''}" data-learn-day="${x.n}" title="第 ${x.n} 天 · ${esc(x.t)}"><span class="dot">${done.has(x.n) ? '✓' : x.n}</span><span>${esc(x.t)}</span></button>`).join('')}</div>`;
    }).join('');
    const monthsHtml = LEARN_MONTHS.map((x, i) => `<div class="lmonth"><small>M${String(i + 1).padStart(2, '0')}</small><b>${esc(x.t)}</b><p>${esc(x.focus)}<br>产出：${esc(x.out)}</p></div>`).join('');
    const next = Math.min(30, day + 1);
    $('#page-learn').innerHTML = `
      <div class="learn-head">
        <div>
          <div class="kicker">学习计划 · 费曼学习法 ${cadence('每天 25 分钟', 'daily')}</div>
          <h1>第 ${day} 天 · ${esc(d.t)}</h1>
          <p class="lede">不用赶进度，每天完成一件事就算进步。今天只练一个概念：先看懂，再用自己的话讲清楚。</p>
          <div class="learn-now">
            <span>今日现场 <b>${esc(idx.name || '上证')} ${idx.pct == null ? '—' : pt(idx.pct)}</b></span>
            <span>上涨 <b>${m.up == null ? '—' : nf(m.up)}</b> / 下跌 <b>${m.down == null ? '—' : nf(m.down)}</b></span>
            <span>最强板块 <b>${esc(top.name || '—')} ${top.avg_pct == null ? '' : pt(top.avg_pct)}</b></span>
            <span>情绪 <b>${sent.score == null ? '—' : sent.score}</b> · ${esc(src)}</span>
          </div>
        </div>
        <div class="learn-progress">
          <div class="lp-top"><div><div class="lp-num">${done.size}<small> / 30 天</small></div><div class="lp-label">30 天入门进度</div></div><span class="tag ${allDone ? 'ok' : ''}">${allDone ? '已完成' : '进行中'}</span></div>
          <div class="lp-bar"><i style="width:${pct}%"></i></div>
          <div class="lp-foot"><span>当前第 ${day} 天</span><span>${pct}%</span></div>
        </div>
      </div>
      <div class="learn-grid">
        <div class="learn-stack">
          <div class="card learn-today">
            <div class="lt-head"><div><div class="kicker">今天 · 25 分钟</div><h3>${esc(d.t)}</h3></div><span class="lt-meta">${complete ? '今天已完成' : '完成后打勾'}</span></div>
            <ul class="learn-tasks">
              <li class="learn-task"><span class="n">1</span><div><b>看 5 分钟</b><p>打开今日页，找出「指数、上涨/下跌、中位涨跌」三个数，先不下结论。</p></div><span class="mins">5 min</span></li>
              <li class="learn-task"><span class="n">2</span><div><b>讲 10 分钟</b><p>${esc(d.f)}</p></div><span class="mins">10 min</span></li>
              <li class="learn-task"><span class="n">3</span><div><b>练 10 分钟</b><p>${esc(d.act)}</p></div><span class="mins">10 min</span></li>
            </ul>
            <div class="learn-cta">
              ${allDone ? `<button class="btn primary" data-learn-reset="1">30 天完成，重新开始</button><span class="learn-done-note">你已经走完入门路径，接下来按月推进。</span>` : complete ? `<button class="btn primary" data-learn-next="${next}">进入第 ${next} 天 →</button><button class="btn" data-learn-day="${day}">重看今天</button>` : `<button class="btn primary" data-learn-done="${day}">标记今天完成</button><span class="learn-done-note">完成一项也算；明天从这里继续。</span>`}
            </div>
          </div>
          <div class="card learn-weeks">
            <h3>30 天入门路径</h3>
            <div class="learn-days">${weeksHtml}</div>
          </div>
          <div class="card learn-year">
            <h3>一年学透 · 12 个月</h3>
            <div class="ly-sub">每月只加一个主题，每月交一份输出；不追求每天学很多，追求一年不断线。</div>
            <div class="lmonths">${monthsHtml}</div>
          </div>
        </div>
        <div class="learn-stack">
          <div class="card learn-feynman">
            <div class="kicker">核心方法</div>
            <h3>费曼四步</h3>
            <div class="fq"><span>今天讲这个</span>${esc(d.f)}</div>
            <ol class="fsteps">
              <li>选一个概念，只选一个。</li>
              <li>用 3 句话讲给完全没买过股票的人，不许用术语。</li>
              <li>卡住的地方就是漏洞，回面板找数字或查来源。</li>
              <li>用一句比喻 + 一个反例重讲；每周录 3 分钟。</li>
            </ol>
          </div>
          <div class="card learn-rules">
            <h3>新手红线</h3>
            <ul>
              <li>前 3 个月只做模拟盘，不融资、不加杠杆。</li>
              <li>每笔交易先写最大亏损，再写目标。</li>
              <li>不把单日热点当长期逻辑，不把学习计划当荐股。</li>
              <li>没有机会就不动手，也是进步。</li>
              <li>每周日 20 分钟复盘：我原来以为……现在发现……。</li>
            </ul>
            <p class="learn-quote">「学透」不是保证赚钱，而是能独立研究、能说清失效条件、能控制回撤。</p>
          </div>
        </div>
      </div>`;
  }

  function renderMore() {
    const div = [...M.dividend.rows].sort((a, b) => b.yield - a.yield).slice(0, 8);
    const evs = [...M.events.rows].sort((a, b) => String(a.upcoming?.[0] || '').localeCompare(String(b.upcoming?.[0] || ''))).slice(0, 6);
    const groups = M.global;
    $('#page-more').innerHTML = `
      <div class="page-head">
        <div>
          <div class="kicker">更多工具${cadence('红利 / 事件每日 · 全球 10 秒')}</div>
          <h1>红利、全球、事件。</h1>
          <p class="lede">不放在首屏，但需要的时候能找到。红利看股息率，全球看外部风险，事件看历史基准率。</p>
        </div>
      </div>
      <div class="more-grid">
        <section class="card">
          <div class="card-h"><h2>红利策略</h2><span class="meta">股息率 ≥ 3% · 按股息率排序</span></div>
          <div class="table-wrap"><table class="t">
            <thead><tr><th>标的</th><th class="r">股息率</th><th class="r">PE</th><th class="r">1 年位置</th></tr></thead>
            <tbody>${div.map((d) => `<tr data-stock="${esc(d.code)}"><td><div class="nm">${esc(d.name)}</div><div class="sub">${esc(d.industry)}</div></td><td class="r num up">${(d.yield * 100).toFixed(2)}%</td><td class="r num">${nf(d.pe, 1)}</td><td class="r num">${d.pos250 == null ? '—' : `${(d.pos250 * 100).toFixed(0)}%`}</td></tr>`).join('')}</tbody>
          </table></div>
        </section>

        <section class="card">
          <div class="card-h"><h2>全球市场</h2><span class="meta">外部风险</span></div>
          <div class="global-grid">
            ${groups.map((g) => `<div class="global-col"><h3>${esc(g.group)}</h3>${g.rows.map((r) => `<div class="global-row"><span>${esc(r.name)}</span><span class="v ${cls(r.pct)}">${pt(r.pct)}</span></div>`).join('')}</div>`).join('')}
          </div>
        </section>

        <section class="card wide">
          <div class="card-h"><h2>事件日历</h2><span class="meta">会前 / 会后怎么做 · 历史基准率 · 每日更新</span></div>
          <div class="event-list">
            ${evs.map((e) => {
              const p = PLAYBOOK[e.kind] || { stance: '观察', cls: '', pre: '等事件落地再动', post: '不追涨杀跌', pos: '观察' };
              const days = daysUntil(e.upcoming?.[0]);
              const dayText = days == null ? '' : days === 0 ? '今天' : days > 0 ? `${days} 天后` : `${Math.abs(days)} 天前`;
              return `<div class="event-card">
                <div class="event-head">
                  <div class="date">${esc(e.upcoming?.[0] || '—')}<small>${esc(dayText)}</small></div>
                  <div class="ttl">${esc(e.title)}<div class="sub">${esc(e.rule || '')}${e.estimate ? ' · 惯例估计' : ''}</div></div>
                  <span class="tag ${p.cls}">${esc(p.stance)}</span>
                </div>
                <div class="event-stats">
                  ${[['pre1', 'T-1'], ['day', '当日'], ['next1', 'T+1'], ['next5', 'T+5']].map(([k, label]) => {
                    const s = e.stats?.[k] || {};
                    const avg = num(s.avg);
                    return `<div class="event-stat"><span>${label} 胜率</span><b>${s.win == null ? '—' : `${s.win}%`}</b><em class="${avg == null ? 'flat' : cls(avg)}">${avg == null ? '—' : `${avg > 0 ? '+' : ''}${avg.toFixed(2)}%`}</em><small>n=${s.n ?? '—'}</small></div>`;
                  }).join('')}
                </div>
                <div class="event-play">
                  <b>推荐做法</b>
                  <span>${esc(p.pre)}</span>
                  <span>${esc(p.post)}</span>
                  <span class="pos">${esc(p.pos)}</span>
                </div>
              </div>`;
            }).join('')}
          </div>
          <div class="small-note" style="padding:4px 20px 14px">历史基准率只描述同类日期的涨跌频率，样本有限，不构成预测；推荐做法为规则化示例，不构成投资建议。</div>
        </section>
      </div>
    `;
  }

  /* ---------- live page ---------- */
  function liveSortLabel() {
    return { speed: '涨速', vr: '量比', pct: '涨跌幅' }[state.liveSort] || '涨速';
  }

  function renderLive() {
    const phase = marketPhase();
    const indexSet = new Set(Object.values(INDEX_CODE));
    const rows = (LIVE.rows || []).filter((r) => r && (num(r.price) != null || r.name) && !indexSet.has(canonRow(r.code)));
    const up = rows.filter((r) => num(r.pct) > 0).length;
    const down = rows.filter((r) => num(r.pct) < 0).length;
    const events = LIVE.events || [];
    const loading = LIVE.source === 'loading' && !rows.length;
    const error = LIVE.source === 'error';
    const isApi = LIVE.source === 'api';
    const liveOn = phase.open && isApi;
    const coveragePct = isApi && LIVE.coverage != null ? Math.round(LIVE.coverage * 100) : null;
    const partial = isApi && (LIVE.failedChunks > 0 || (coveragePct != null && coveragePct < 99));
    const sourceText = error ? '接口不可用' : isApi ? `实时接口${partial ? ` · ${coveragePct}%` : ''}` : '读取中';
    const updated = isApi ? clockText(LIVE.updated_at) : '—';
    let topPct = null;
    let topSpeed = null;
    rows.forEach((r) => {
      if (num(r.pct) != null && (!topPct || r.pct > topPct.pct)) topPct = r;
      if (num(r.speed) != null && num(r.speed) > 0 && (!topSpeed || r.speed > topSpeed.speed)) topSpeed = r;
    });
    const sortKey = state.liveSort || 'speed';
    const shown = [...rows].sort((a, b) => {
      if (sortKey === 'speed') return (num(b.speed) ?? -1e9) - (num(a.speed) ?? -1e9) || (num(b.pct) ?? -1e9) - (num(a.pct) ?? -1e9);
      if (sortKey === 'vr') return (num(b.vol_ratio) ?? -1e9) - (num(a.vol_ratio) ?? -1e9) || (num(b.pct) ?? -1e9) - (num(a.pct) ?? -1e9);
      return (num(b.pct) ?? -1e9) - (num(a.pct) ?? -1e9);
    }).slice(0, 60);
    const eventText = (e) => e.text || e.tag || ({ limit_down_open: '跌停撬板', limit_up_break: '涨停打开', surge: '急拉', plunge: '急跌' }[e.type] || '异动');
    const eventCls = (e) => {
      if (e.type === 'plunge' || e.kind === 'cold') return 'cold';
      if (e.kind === 'accent') return 'accent';
      return 'hot';
    };
    const eventTime = (e) => clockText(e.at != null ? e.at : e.time);
    const h1 = error ? '实时行情暂不可用。' : loading ? '正在读取实时行情。' : phase.open ? (isApi ? '现在，钱在往哪跑。' : '等待实时接口。') : phase.label === '未开盘' ? '还没开盘，先看上一交易日。' : '休市了，看最近一次异动。';
    const lede = error
      ? `实时接口请求失败：${esc(LIVE.error || '未知错误')}。页面不会用静态样本替代；请检查 DSH 服务后手动刷新。`
      : loading
        ? '正在请求 /api/sector-board/live.json；返回前不显示任何假数据。'
        : phase.open
          ? '交易日 09:15–11:30、13:00–15:00 每 15 秒刷新监控池。异动规则：跌停撬板、涨停打开、5 分钟内急拉 / 急跌 ≥ 1.5%。'
          : `当前${esc(phase.label)}。页面保留最近一次真实快照；下一个交易日 09:15 恢复自动刷新。`;

    $('#page-live').innerHTML = `
      <div class="page-head">
        <div>
          <div class="kicker">盘中异动 ${cadence('实时 · 15 秒', 'live')}</div>
          <h1>${h1}</h1>
          <p class="lede">${lede}</p>
        </div>
        <div class="head-actions">
          <button class="btn" data-live-refresh>手动刷新</button>
          <button class="btn primary" data-go="today">回今日</button>
        </div>
      </div>

      <div class="live-bar">
        <span class="live-state ${liveOn ? 'on' : ''}"><i></i>${error ? '接口不可用' : isApi ? (phase.open ? phase.label : `${phase.label} · 快照`) : '读取中'}</span>
        <span>最近更新 <b>${esc(updated)}</b></span>
        <span>${liveOn ? '15 秒后自动刷新' : (phase.open ? '等待实时接口' : '恢复时间 下一交易日 09:15')}</span>
        <span class="spacer"></span>
        <span>监控池 <b>${rows.length}</b> 只</span>
        ${partial ? `<span>覆盖 <b>${coveragePct}%</b>${LIVE.failedChunks ? ` · ${LIVE.failedChunks} 批失败` : ''}</span>` : ''}
        <span class="live-src ${error ? 'error' : isApi ? 'api' : 'loading'}">${sourceText}</span>
      </div>

      ${error ? `<div class="live-notice err"><b>实时接口不可用：</b>${esc(LIVE.error || '请求失败')}。不会伪造数据；请检查 Host 服务后点「手动刷新」。</div>` : ''}
      ${loading ? `<div class="live-notice"><b>正在读取：</b>实时接口返回前，本页保持空态。</div>` : ''}
      ${partial ? `<div class="live-notice"><b>行情覆盖不足：</b>本次只拿到 ${coveragePct}% 的股票行情${LIVE.failedChunks ? `，${LIVE.failedChunks} 批请求失败` : ''}。市场宽度和板块均涨只统计已返回的股票，可能偏小；请稍后手动刷新。</div>` : ''}

      ${auctionCard()}

      <div class="live-kpis">
        <div><b>${rows.length}</b><span>监控池</span><em>${partial ? `覆盖 ${coveragePct}%` : '主题 / 决策 / 人气 / 持仓'}</em></div>
        <div><b class="up">${up}</b><span>上涨</span><em class="down">${down} 只下跌</em></div>
        <div><b>${events.length}</b><span>异动</span><em>2 分钟去重</em></div>
        <div><b class="${topPct ? cls(topPct.pct) : 'flat'}">${topPct ? pt(topPct.pct) : '—'}</b><span>最大涨幅</span><em>${esc(topPct ? topPct.name : '—')}</em></div>
        <div><b class="${topSpeed ? cls(topSpeed.speed) : 'flat'}">${topSpeed ? pt(topSpeed.speed) : '—'}</b><span>最快涨速</span><em>${esc(topSpeed ? topSpeed.name : '本轮暂无涨速')}</em></div>
      </div>

      <div class="live-grid">
        <section class="card">
          <div class="card-h"><h2>异动流</h2><span class="meta">${events.length} 条 · 最近 40 条</span></div>
          <div class="live-feed">
            ${events.length ? events.slice(0, 18).map((e) => `
              <div class="live-event" data-stock="${esc(e.code || '')}">
                <span class="time">${esc(eventTime(e))}</span>
                <span class="who"><b>${esc(e.name || e.code || '—')}</b><small>${esc(eventText(e))}</small></span>
                <span class="pct ${cls(e.pct)}">${pt(e.pct)}</span>
              </div>`).join('') : `<div class="live-empty"><b>${error ? '实时接口不可用。' : loading ? '正在读取实时行情…' : '本轮还没有触发异动。'}</b><br>${error ? '不会伪造数据；请检查服务后刷新。' : '规则是跌停撬板、涨停打开、5 分钟内急拉 / 急跌 ≥ 1.5%。'}</div>`}
          </div>
        </section>

        <section class="card">
          <div class="card-h">
            <h2>监控池</h2>
            <div class="live-sort">
              <button data-live-sort="speed" class="${sortKey === 'speed' ? 'on' : ''}">涨速</button>
              <button data-live-sort="vr" class="${sortKey === 'vr' ? 'on' : ''}">量比</button>
              <button data-live-sort="pct" class="${sortKey === 'pct' ? 'on' : ''}">涨跌幅</button>
            </div>
          </div>
          <div class="live-table-wrap">
            <table class="t">
              <thead><tr><th>标的</th><th class="r">现价</th><th class="r">涨跌幅</th>${isApi ? '<th class="r hide-720">涨速</th><th class="r hide-720">量比</th><th class="r hide-720">成交额</th>' : ''}</tr></thead>
              <tbody>
                ${shown.map((r) => `<tr data-stock="${esc(r.code)}">
                  <td><div class="nm">${esc(r.name || r.code)}</div><div class="sub">${esc(r.code)}</div></td>
                  <td class="r num">${r.price == null ? '—' : nf(r.price, 2)}</td>
                  <td class="r num ${cls(r.pct)}">${pt(r.pct)}</td>
                  ${isApi ? `<td class="r num hide-720 ${cls(r.speed)}">${r.speed == null ? '—' : pt(r.speed)}</td>
                  <td class="r num hide-720">${r.vol_ratio == null ? '—' : r.vol_ratio.toFixed(2)}</td>
                  <td class="r num hide-720">${r.amount == null ? '—' : money(r.amount * 1e4)}</td>` : ''}
                </tr>`).join('')}
              </tbody>
            </table>
            ${!shown.length ? `<div class="live-empty">${error ? '接口不可用，监控池为空。' : loading ? '正在读取…' : '监控池为空。'}</div>` : ''}
          </div>
        </section>
      </div>
    `;
  }

  function paintTab(tab) {
    if (tab === 'today') renderToday();
    if (tab === 'sectors') renderSectors();
    if (tab === 'live') renderLive();
    if (tab === 'paper') renderPaper();
    if (tab === 'more') renderMore();
    if (tab === 'learn') renderLearn();
  }

  // 行情轮询只重画当前页，保留滚动位置；用户正在搜索/看抽屉时不打扰。
  function refreshCurrent() {
    if (state.tab === 'learn') return;
    const ae = document.activeElement;
    if (ae && (ae.id === 'q' || ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
    const drawer = $('#drawer');
    if (drawer && drawer.classList.contains('open')) return;
    const y = window.scrollY;
    paintTab(state.tab);
    window.scrollTo(0, y);
  }

  function go(tab) {
    state.tab = tab;
    $$('.page').forEach((p) => (p.hidden = p.id !== `page-${tab}`));
    $$('.nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    paintTab(tab);
    if (tab === 'live') startLive();
    closeSugg();
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }

  function closeSugg() {
    $('#sugg').classList.remove('on');
    $('#search').classList.remove('open');
  }
  let suggSeq = 0;
  function drawSugg(q, items) {
    state.searchItems = items;
    state.searchSel = 0;
    const box = $('#sugg');
    if (!q.trim()) { box.classList.remove('on'); return; }
    if (!items.length) {
      box.innerHTML = `<div class="empty">没有找到「${esc(q)}」</div>`;
      box.classList.add('on');
      return;
    }
    const order = ['股票', 'ETF', '主题', '行业'];
    const groups = order.map((t) => [t, items.filter((x) => x.type === t)]).filter(([, a]) => a.length);
    const ordered = groups.flatMap(([, arr]) => arr);
    state.searchItems = ordered;
    let idx = 0;
    box.innerHTML = groups.map(([t, arr]) => `<div class="group">${t}</div>${arr.map((x) => {
      const i = idx++;
      return `<div class="row ${i === 0 ? 'sel' : ''}" data-si="${i}"><span>${esc(x.name)} <small>${esc(x.code.replace(/^[TEI]:/, ''))}</small></span><small>${esc(x.sub || '')}</small><span class="num ${cls(x.pct)}">${x.price ? nf(x.price, 2) : ''} ${pt(x.pct)}</span></div>`;
    }).join('')}`).join('') + `<div class="foot"><span>↑↓ 选择 · Enter 打开</span><span>${items.length} 个结果</span></div>`;
    box.classList.add('on');
  }
  function renderSugg(q) {
    const seq = ++suggSeq;
    const local = search(q);
    drawSugg(q, local);
    if (!q.trim() || !apiAvailable()) return;
    jget(`search?q=${encodeURIComponent(q)}`).then((d) => {
      if (seq !== suggSeq) return;
      const rows = (d && d.rows ? d.rows : []).map((x) => ({
        code: String(x.code || '').replace(/^[a-z]{2}/i, ''),
        name: x.name, type: '股票', sub: x.industry || '', industry: x.industry || '',
        price: null, pct: null, remote: true,
      })).filter((x) => /^\d{6}$/.test(x.code));
      const byCode = new Map(rows.map((x) => [x.code, x]));
      local.forEach((x) => {
        const r = byCode.get(String(x.code).replace(/^[TEI]:/, ''));
        if (r) { x.industry = r.industry; x.sub = r.industry; x.name = r.name; }
      });
      const seen = new Set(local.map((x) => x.code.replace(/^[TEI]:/, '')));
      const extra = rows.filter((x) => !seen.has(x.code));
      extra.forEach((x) => {
        const old = state.index.find((y) => y.code === x.code);
        if (old) { old.industry = x.industry; old.sub = x.industry; old.name = x.name; }
        else state.index.push(x);
      });
      if (!extra.length && !local.some((x) => byCode.has(String(x.code).replace(/^[TEI]:/, '')))) return;
      drawSugg(q, local.concat(extra));
    }).catch(() => {});
  }
  function selectResult(i) {
    const x = state.searchItems[i];
    if (!x) return;
    $('#q').value = '';
    closeSugg();
    if (x.type === '主题') { state.selectedTheme = x.theme; go('sectors'); return; }
    if (x.type === '行业') { state.sectorMode = 'industry'; state.selectedSector = x.industry; go('sectors'); return; }
    openStock(x.code);
  }

  /* ---------- data refresh ---------- */
  let refreshPoll = null;
  async function triggerRefresh() {
    if (!apiAvailable()) { toast('无法连接 Host 数据接口'); return; }
    toast('正在启动数据更新，约 4–6 分钟');
    try {
      const r = await fetch('/api/sector-board/refresh', { method: 'POST', credentials: 'same-origin' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || ('HTTP ' + r.status));
      if (body.started === false && body.reason === 'running') toast('数据正在更新中');
    } catch (err) {
      toast('启动更新失败：' + String(err && err.message ? err.message : err));
      return;
    }
    if (refreshPoll) clearInterval(refreshPoll);
    refreshPoll = setInterval(async () => {
      try {
        const st = await jget('status.json');
        if (st.state === 'running') {
          toast(`数据更新中 ${st.done || 0}/${st.total || 0}`);
          return;
        }
        clearInterval(refreshPoll); refreshPoll = null;
        if (st.state === 'error') { toast('更新失败：' + (st.error || '未知错误')); return; }
        toast('数据已更新');
        await hydrate(true);
      } catch { /* keep polling */ }
    }, 5000);
  }

  /* ---------- events ---------- */
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('on'), 1800);
  }

  function bind() {
    $$('.nav button').forEach((b) => b.addEventListener('click', () => go(b.dataset.tab)));

    document.addEventListener('click', (e) => {
      const nav = e.target.closest('[data-tab]');
      if (nav) { go(nav.dataset.tab); return; }
      const goEl = e.target.closest('[data-go]');
      if (goEl) {
        e.preventDefault();
        if (goEl.dataset.theme) {
          state.sectorMode = 'theme';
          state.selectedTheme = goEl.dataset.theme;
        }
        if (goEl.dataset.industry) {
          state.sectorMode = 'industry';
          state.selectedSector = goEl.dataset.industry;
        }
        go(goEl.dataset.go);
        return;
      }
      const mode = e.target.closest('[data-mode]');
      if (mode) {
        state.sectorMode = mode.dataset.mode;
        renderSectors();
        return;
      }
      const theme = e.target.closest('[data-theme]');
      if (theme && theme !== document.documentElement && !theme.dataset.go) {
        state.sectorMode = 'theme';
        state.selectedTheme = theme.dataset.theme;
        renderSectors();
        return;
      }
      const ind = e.target.closest('[data-industry]');
      if (ind) {
        state.sectorMode = 'industry';
        state.selectedSector = ind.dataset.industry;
        renderSectors();
        return;
      }
      const etf = e.target.closest('[data-etf]');
      if (etf && etf.dataset.etf) { openStock(etf.dataset.etf); return; }
      const learnDay = e.target.closest('[data-learn-day]');
      if (learnDay) {
        state.learnDay = Number(learnDay.dataset.learnDay) || 1;
        renderLearn();
        return;
      }
      const learnDone = e.target.closest('[data-learn-done]');
      if (learnDone) {
        const n = Number(learnDone.dataset.learnDone) || 1;
        const set = learnDoneSet();
        set.add(n);
        saveLearnDone(set);
        const next = learnCurrent(set);
        state.learnDay = next;
        renderLearn();
        toast(`第 ${n} 天完成，继续第 ${next} 天`);
        return;
      }
      const learnNext = e.target.closest('[data-learn-next]');
      if (learnNext) {
        state.learnDay = Number(learnNext.dataset.learnNext) || 1;
        renderLearn();
        return;
      }
      const learnReset = e.target.closest('[data-learn-reset]');
      if (learnReset) {
        if (window.confirm('重置 30 天入门进度？')) {
          try { const ls = learnStorage(); if (ls) ls.removeItem('sb-learn-done-v1'); } catch (err) {}
          state.learnDay = 1;
          renderLearn();
          toast('学习进度已重置');
        }
        return;
      }
      const st = e.target.closest('[data-stock]');
      if (st && st.dataset.stock) { openStock(st.dataset.stock); return; }
      const period = e.target.closest('[data-period]');
      if (period) {
        state.period = period.dataset.period;
        $$('.drawer-tabs button').forEach((b) => b.classList.toggle('active', b === period));
        drawChart(state.stock);
        return;
      }
      if (e.target.closest('#closeDrawer') || e.target.id === 'mask') { closeStock(); return; }
      const liveSort = e.target.closest('[data-live-sort]');
      if (liveSort) {
        state.liveSort = liveSort.dataset.liveSort;
        renderLive();
        return;
      }
      const liveRefresh = e.target.closest('[data-live-refresh]');
      if (liveRefresh) {
        toast('正在刷新盘中监控池');
        fetchLive(true);
        return;
      }
      const action = e.target.closest('[data-action]');
      if (action) {
        if (action.dataset.action === 'refresh') {
          toast('正在刷新页面数据');
          hydrate(true);
        } else if (action.dataset.action === 'etl') {
          triggerRefresh();
        } else if (action.dataset.action === 'ladder') {
          M.ladder.days = []; M.ladder.as_of = ''; fetchLadder(true);
        }
        return;
      }
      const toastEl = e.target.closest('[data-toast]');
      if (toastEl) { toast(toastEl.dataset.toast); return; }
      const si = e.target.closest('[data-si]');
      if (si) selectResult(Number(si.dataset.si));
    });

    const q = $('#q');
    q.addEventListener('input', () => renderSugg(q.value));
    q.addEventListener('focus', () => { if (q.value.trim()) renderSugg(q.value); });
    q.addEventListener('keydown', (e) => {
      const items = state.searchItems;
      if (e.key === 'Escape') { closeSugg(); q.blur(); return; }
      if (e.key === 'ArrowDown' && items.length) {
        e.preventDefault();
        state.searchSel = (state.searchSel + 1) % items.length;
        $$('#sugg .row').forEach((r, i) => r.classList.toggle('sel', i === state.searchSel));
      } else if (e.key === 'ArrowUp' && items.length) {
        e.preventDefault();
        state.searchSel = (state.searchSel - 1 + items.length) % items.length;
        $$('#sugg .row').forEach((r, i) => r.classList.toggle('sel', i === state.searchSel));
      } else if (e.key === 'Enter' && items.length) {
        e.preventDefault();
        selectResult(state.searchSel);
      }
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.search') && !e.target.closest('#sugg')) closeSugg();
    });
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        q.focus();
        if (q.value.trim()) renderSugg(q.value);
      }
      if (e.key === 'Escape') { closeSugg(); if (state.stock) closeStock(); }
    });

    $('#themeBtn').addEventListener('click', () => {
      state.theme = state.theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = state.theme;
      localStorage.setItem('sa-theme', state.theme);
      $('#themeBtn').textContent = state.theme === 'light' ? '◐' : '☀';
      toast(state.theme === 'light' ? '浅色模式' : '深色模式');
    });
  }

  /* ---------- secondary auto refresh ---------- */
  const AUX = { timer: null, paper: false, global: false, lastDash: 0, hot: 0 };
  function startAux() {
    if (AUX.timer) return;
    AUX.timer = setInterval(() => {
      if (!apiAvailable() || document.visibilityState === 'hidden') return;
      if (state.tab === 'paper' && !AUX.paper) {
        AUX.paper = true;
        jget('paper.json').then((p) => {
          applyPaper(p);
          if (state.tab === 'paper') { const y = window.scrollY; renderPaper(); window.scrollTo(0, y); }
        }).catch(() => {}).finally(() => { AUX.paper = false; });
      }
      if (Date.now() - AUX.hot > 180000) {
        AUX.hot = Date.now();
        jget('hot.json').then((h) => {
          applyHot(h);
          if (state.tab === 'today') { const y = window.scrollY; renderToday(); window.scrollTo(0, y); }
        }).catch(() => {});
      }
      if (state.tab === 'more' && !AUX.global) {
        AUX.global = true;
        jget('global.json').then((g) => {
          applyGlobal(g);
          if (LIVE.rows.length) patchLiveQuotes();
          renderRibbon();
          if (state.tab === 'more') { const y = window.scrollY; renderMore(); window.scrollTo(0, y); }
        }).catch(() => {}).finally(() => { AUX.global = false; });
      }
      if (AUX.lastDash && Date.now() - AUX.lastDash < 300000) return;
      AUX.lastDash = Date.now();
      jget('dashboard.json').then((d) => {
        if (!d || d.generated_at === M.meta.generated_at) return;
        applyDashboard(d); buildIndex(); renderRibbon(); syncFooter();
        if (state.tab === 'live') renderLive(); else refreshCurrent();
      }).catch(() => {});
    }, 10000);
  }

  /* ---------- init ---------- */
  document.documentElement.dataset.theme = state.theme;
  $('#themeBtn').textContent = state.theme === 'light' ? '◐' : '☀';
  buildIndex();
  renderRibbon();
  syncFooter();
  bind();
  $('#bootRetry')?.addEventListener('click', () => hydrate(true));
  showBoot('连接 Host 数据接口…');
  if (apiAvailable()) hydrate();
  else failBoot('无法连接 Host 数据接口。请从 DSH 面板打开「股票分析」，或确认 DSH 服务正在运行。');
})();
