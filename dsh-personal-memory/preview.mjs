// 静态预览：把面板在真实数据下渲染成一张 HTML（内联样式 + 面板自带 CSS），
// 再用本机 Chrome 无头模式截图，肉眼检查版面 —— 这台机器上 GUI 需要 token、也没有调试端口，
// 这是唯一能「真的看见」面板的办法。
//
// 用法：
//   node preview.mjs --out /tmp/pm.html                     # 默认：个人记忆 + 浅色
//   node preview.mjs --tab timeline --theme dark --out ...  # 时间长河 + 深色
//   node preview.mjs --shot /tmp/pm.png                     # 顺手调用 Chrome 截图
//   node preview.mjs --all                                  # 五个页签 × 深浅两色，全出一遍
//
// 说明：颜色 token 的值是本地近似（真实值由宿主主题提供），版面/排版/数据是真的。

import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { boot } from './harness.mjs'

const run = promisify(execFile)

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const THEMES = {
  light: {
    '--dsw-alias-bg-base': '#ffffff',
    '--dsw-alias-bg-layer-1': '#fbfbfc',
    '--dsw-alias-bg-layer-2': '#f3f4f6',
    '--dsw-alias-bg-overlay': '#ffffff',
    '--dsw-alias-border-l1': '#ededf0',
    '--dsw-alias-border-l2': '#e1e2e7',
    '--dsw-alias-brand-primary': '#4d6bfe',
    '--dsw-alias-label-primary': '#1f2024',
    '--dsw-alias-label-secondary': '#6b6f7a',
    '--dsw-alias-state-error-primary': '#d92d20',
    '--dsw-alias-state-idle-primary': '#98a2b3',
    '--dsw-alias-state-success-primary': '#12b76a',
    '--dsw-alias-state-warn-primary': '#f79009',
    '--dsw-specific-sidebar-fill': '#f7f7f9',
  },
  dark: {
    '--dsw-alias-bg-base': '#17181b',
    '--dsw-alias-bg-layer-1': '#1e1f23',
    '--dsw-alias-bg-layer-2': '#26272c',
    '--dsw-alias-bg-overlay': '#2a2b31',
    '--dsw-alias-border-l1': '#2c2d33',
    '--dsw-alias-border-l2': '#3a3b43',
    '--dsw-alias-brand-primary': '#6d8bff',
    '--dsw-alias-label-primary': '#e8e9ee',
    '--dsw-alias-label-secondary': '#9a9daa',
    '--dsw-alias-state-error-primary': '#f97066',
    '--dsw-alias-state-idle-primary': '#667085',
    '--dsw-alias-state-success-primary': '#32d583',
    '--dsw-alias-state-warn-primary': '#fdb022',
    '--dsw-specific-sidebar-fill': '#131417',
  },
}

/* ---------------- React 树 → HTML ---------------- */
const VOID_TAGS = new Set(['input', 'img', 'br', 'hr', 'meta', 'link', 'source', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon'])
const UNITLESS = new Set(['zIndex', 'opacity', 'lineHeight', 'flex', 'flexGrow', 'flexShrink', 'order', 'fontWeight', 'zoom', 'gridColumn', 'gridRow'])
const RENAMED = { colSpan: 'colspan', rowSpan: 'rowspan', htmlFor: 'for', className: 'class', tabIndex: 'tabindex', strokeWidth: 'stroke-width', strokeLinecap: 'stroke-linecap', strokeLinejoin: 'stroke-linejoin', fillRule: 'fill-rule', clipRule: 'clip-rule', stopColor: 'stop-color' }

function esc(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function styleText(style) {
  if (!style || typeof style !== 'object') return ''
  const parts = []
  for (const [rawKey, rawValue] of Object.entries(style)) {
    if (rawValue === null || rawValue === undefined || rawValue === false) continue
    if (rawKey.startsWith('--')) { parts.push(`${rawKey}:${rawValue}`); continue }
    const key = rawKey.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)
    const value = typeof rawValue === 'number' && !UNITLESS.has(rawKey) ? `${rawValue}px` : String(rawValue)
    parts.push(`${key}:${value}`)
  }
  return parts.join(';')
}

function attrText(props) {
  const out = []
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue
    if (key === 'children' || key === 'key' || key === 'style') continue
    if (typeof value === 'function' || typeof value === 'object') continue
    if (key === 'className') { out.push(`class="${esc(value)}"`); continue }
    if (key === 'value' && value === '') continue
    const name = RENAMED[key] ?? key
    if (value === true) { out.push(name); continue }
    out.push(`${name}="${esc(value)}"`)
  }
  return out.length > 0 ? ` ${out.join(' ')}` : ''
}

function toHtml(node) {
  if (node === null || node === undefined || node === false) return ''
  if (Array.isArray(node)) return node.map(toHtml).join('')
  if (typeof node === 'string' || typeof node === 'number') return esc(node)
  if (typeof node !== 'object') return ''
  if (node.type === undefined) return ''
  const props = node.props ?? {}
  const tag = String(node.type)
  const attrs = attrText(props) + (props.style ? ` style="${esc(styleText(props.style))}"` : '')
  // textarea 的内容要靠子文本，`value` 属性在 HTML 里是无效的（不写这一步截图里编辑器全是空的）
  if (tag === 'textarea') {
    const text = props.value !== undefined ? String(props.value) : (node.children ?? []).map((child) => (typeof child === 'string' ? child : '')).join('')
    const rest = attrText({ ...props, value: undefined })
    return `<textarea${rest}${props.style ? ` style="${esc(styleText(props.style))}"` : ''}>${esc(text)}</textarea>`
  }
  const inner = (node.children ?? []).map(toHtml).join('')
  if (VOID_TAGS.has(tag)) return `<${tag}${attrs} />`
  return `<${tag}${attrs}>${inner}</${tag}>`
}

/* ---------------- 主流程 ---------------- */
function parseArgs(argv) {
  const args = { tab: 'today', theme: 'light', out: '/tmp/pm-preview/index.html', shot: '', width: 1440, height: 900, all: false }
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]
    const next = argv[i + 1]
    if (item === '--all') args.all = true
    else if (item === '--tab') { args.tab = next; i += 1 }
    else if (item === '--theme') { args.theme = next; i += 1 }
    else if (item === '--out') { args.out = next; i += 1 }
    else if (item === '--shot') { args.shot = next; i += 1 }
    else if (item === '--width') { args.width = Number(next); i += 1 }
    else if (item === '--height') { args.height = Number(next); i += 1 }
    else if (item === '--log-open') { args.logOpen = Number(next); i += 1 }
    else if (item === '--test') { args.test = next; i += 1 }
  }
  return args
}

const { parts, t, settle, reset, hostCall, styles: panelStyles } = await boot({ realWorkspace: true })

async function renderPage({ tab, theme, width, height, extra = {} }) {
  globalThis.__pmViewportWidth = width  // 让 useNarrow() 和 CSS 媒体查询用同一个宽度
  const tokens = THEMES[theme] ?? THEMES.light
  const rootCss = Object.entries(tokens).map(([k, v]) => `  ${k}: ${v};`).join('\n')
  let body = ''
  let note = ''

  reset() // 同一进程里连续渲染多张图时，必须清掉上一次的 hook 状态，否则 tab 会粘住

  if (extra.modal === 'note') {
    // 速记弹窗：面板压暗 + 弹窗本体的合成画面
    const page = toHtml(await settle(parts.App, { initialTab: 'personal' }))
    const modal = toHtml(await settle(parts.NoteModal, { api: new parts.Api(), onClose() {}, onDone() {}, toast() {} }))
    body = `${page.replace('</div>', `<div class="pmp-mask" style="position:absolute;inset:0">${modal}</div></div>`)}`
    note = '速记弹窗（合成画面）'
  } else if (extra.modal === 'newnote') {
    // 新建笔记弹窗：面板 + 新建表单
    const page = toHtml(await settle(parts.App, { initialTab: 'personal' }))
    const modal = toHtml(await settle(parts.NewNoteModal, { api: new parts.Api(), dirs: ['personal', 'personal/health', 'personal/learning', 'personal/stock', 'personal/work'], onClose() {}, onDone() {}, toast() {} }))
    body = `${page.replace('</div>', `<div class="pmp-mask" style="position:absolute;inset:0">${modal}</div></div>`)}`
    note = '新建笔记弹窗（合成画面）'
  } else if (extra.modal === 'histback') {
    // 回退按钮：合成一条「刚读过两篇」的路径，真实工作区首开时没有它
    const docs = (await hostCall('GET', '/tree?scope=personal,memory,project&refresh=1')).docs ?? []
    const history = docs.filter((doc) => doc.path !== 'personal/关于我.md').slice(0, 2).map((doc) => doc.path)
    const html = toHtml(await settle(parts.App, { initialTab: 'personal', initialPath: 'personal/关于我.md', initialHistory: history }))
    body = html
    note = '阅读路径回退（合成历史）'
  } else if (extra.quickQuery) {
    body = toHtml(await settle(parts.App, { initialTab: 'today', initialQuickQuery: extra.quickQuery }))
  } else if (extra.modal === 'quick') {
    const docs = (await hostCall('GET', '/tree?scope=personal,memory,project&refresh=1')).docs ?? []
    const page = toHtml(await settle(parts.App, { initialTab: 'personal' }))
    const visited = await hostCall('GET', '/visited?limit=5').catch(() => null)
    const quick = toHtml(await settle(parts.QuickJump, {
      docs,
      recent: Array.isArray(visited?.items) ? visited.items : [],
      pages: [
        { key: 'today', label: t('tab.today') },
        { key: 'personal', label: t('tab.personal') },
        { key: 'timeline', label: t('tab.timeline') },
        { key: 'todos', label: t('tab.todos') },
        { key: 'search', label: t('tab.search') },
        { key: 'recall', label: t('tab.recall') },
      ],
      onNavigate() {},
      onPick() {},
      onClose() {},
    }))
    body = `${page.replace('</div>', `<div class="pmp-mask" style="position:absolute;inset:0">${quick}</div></div>`)}`
  } else if (extra.mixed) {
    // 类型分布：笔记 + 待办 + 线索混排，上方三个可点的数
    const now = Date.now()
    body = toHtml(await settle(parts.App, {
      initialTab: 'search',
      initialQuery: '',
      initialHits: [
        { docId: 'a', title: '各板块止损线怎么定', heading: '五、执行规则', score: 0.83, path: 'personal/stock/技术面状态判定方法.md', excerpt: '跌破就走，不猜反弹。', via: 'keyword', mtimeMs: now - 3 * 86400000 },
        { docId: 'b', title: '计划买点没到就下手，等于把止损线也提前了', heading: '', score: 0.79, path: 'personal/stock/计划买点没到就下手等于把止损线提前.md', excerpt: '买点没到就动手，止损失去了意义。', via: 'vector', mtimeMs: now - 9 * 86400000 },
        { docId: 'c', title: '下一步 · 2026-11-19', heading: '未完成', score: 0.9, path: 'memory/2026/11/2026-11-19.md', excerpt: '等对账表', via: 'state', stateKind: 'next', stateText: '等对账表回来再定仓位' },
        { docId: 'd', title: '线索 · stock', heading: '', score: 0.82, path: 'personal/stock/index.md', excerpt: '各板块止损线怎么定', via: 'clue', clueKind: 'check', line: 18 },
      ],
    }))
  } else if (extra.noneClue) {
    // 搜不到时的那一屏：真实工作区里语义检索总能捞回东西，所以用「只看线索 + 胡话」制造零命中
    const props = { initialTab: 'search', initialOnlyKind: 'clue', initialQuery: 'ZZZ这条平时一定搜不到QQQ', initialCluePages: [{ path: 'personal/index.md', title: 'personal / 根目录', scope: 'personal' }] }
    await settle(parts.App, props)
    await new Promise((done) => setTimeout(done, 400))
    body = toHtml(await settle(parts.App, props))
  } else if (extra.onlyClue) {
    body = toHtml(await settle(parts.App, {
      initialTab: 'search',
      initialQuery: '',
      initialOnlyKind: 'clue',
      initialHits: [
        { docId: 'clue:1', title: '线索 · stock', path: 'personal/stock/index.md', excerpt: '各板块止损线怎么定', score: 0.82, via: 'clue', clueKind: 'check', line: 18, mtimeMs: Date.now() - 4 * 86400000 },
        { docId: 'clue:2', title: '线索 · learning', path: 'personal/learning/index.md', excerpt: '怎么看一个 agent 是不是真的在记忆', score: 0.82, via: 'clue', clueKind: 'find', line: 11, mtimeMs: Date.now() - 9 * 86400000 },
      ],
    }))
  } else if (extra.auditBad) {
    // 体检报错那一屏：真实工作区刚体完检（0 条），平时看不到「坏掉」长什么样
    const liveAudit = (await hostCall('GET', '/audit')) ?? null
    const fake = {
      counts: { p0: 1, p1: 3, p2: 0, total: 4 },
      notes: liveAudit?.notes ?? 0,
      items: [
        { level: 'P0', path: 'personal/stock/index.md', issue: '死链 → desk/gone.md', hint: '修链接或补文件' },
        { level: 'P1', path: 'personal/stock/事件日历.md', issue: '缺「更新:」', hint: '补一行 更新:YYYY-MM-DD' },
        { level: 'P1', path: 'personal/learning/个人记忆面板.md', issue: '缺「来源:」', hint: '补一行 来源:…，不明就写「对话」' },
        { level: 'P1', path: 'personal/work/index.md', issue: '没被任何 index 引用', hint: '在所属主题的 index.md 加一行' },
      ],
    }
    body = toHtml(await settle(parts.App, { initialTab: 'personal', initialAudit: fake }))
  } else if (extra.clueHit) {
    // 线索进检索：合成一条「线索」命中，看它在结果里长什么样
    body = toHtml(await settle(parts.App, {
      initialTab: 'search',
      initialHits: [
        { docId: 'clue:1', title: '线索 · stock', path: 'personal/stock/index.md', excerpt: '各板块止损线怎么定', score: 0.82, via: 'clue', clueKind: 'check', line: 18, mtimeMs: Date.now() - 4 * 86400000 },
        { docId: 'note:1', title: '计划买点没到就下手，等于把止损线也提前了', path: 'personal/stock/计划买点没到就下手等于把止损线提前.md', excerpt: '40.88 买入 vs 计划 35–38，买贵 8–17% 后止损空间被压到 0.5%', score: 0.7, heading: '五、执行规则', mtimeMs: Date.now() - 6 * 86400000 },
      ],
    }))
  } else if (extra.query) {
    // 检索页带一个真实 query：空态截图看不出命中长什么样。
    // 检索是异步 fetch，settle() 只看渲染是否稳定，等不到网络回来，所以要「渲一次 → 等 → 再渲」。
    const props = { initialTab: 'search', initialQuery: extra.query, initialSearchSort: extra.searchSort ?? 'score', initialStateOnly: extra.onlyState === true }
    await settle(parts.App, props)
    await new Promise((done) => setTimeout(done, 400))
    body = toHtml(await settle(parts.App, props))
  } else if (extra.modal === 'trial') {
    // 临时放宽那一行：默认态看不出它做了什么，所以截「放宽到 0.05 之后」的样子
    const liveStatus = await hostCall('GET', '/status')
    const q = '止损线怎么定'
    const strict = await hostCall('POST', '/test', { query: q })
    const looseMeta = await hostCall('POST', '/test', { query: q, threshold: 0.05 })
    if (!looseMeta || !Array.isArray(looseMeta.rows)) throw new Error('试一下没返回 rows')
    body = toHtml(await settle(parts.RecallTab, { t, status: liveStatus, api: new parts.Api(), onToast() {}, onReload() {}, onOpen() {}, initialTestMeta: looseMeta, initialShowDropped: true, initialTrialHint: true, initialSnippetOpen: true }))
    note = strict ? `放宽前注入 ${strict.picked} 篇 / 放宽后 ${looseMeta.picked} 篇` : ''
  } else if (extra.modal === 'drop') {
    // 「被挡掉的 N 篇」展开态：真实 /test 的丢弃项取决于阈值，截图要看的是这一块本身
    const seeded = {
      query: '止损线怎么定', mode: 'hybrid', ms: 41, candidates: 6, picked: 2,
      dropped: { low: 3, budget: 1 },
      params: { fetchK: 8, threshold: 0.12, maxChars: 1600, mode: 'hybrid' },
      rows: [
        { docId: 'a', path: 'personal/stock/技术面状态判定方法.md', title: '技术面状态判定方法', score: 0.681, excerpt: '跌破 20 日线之后要重新看趋势…', picked: true },
        { docId: 'b', path: 'personal/stock/计划买点没到就下手，等于把止损线提前了.md', title: '计划买点没到就下手，等于把止损线提前了', score: 0.700, excerpt: '买点没到就下手，等于把止损线提前…', picked: true },
        { docId: 'c', path: 'personal/stock/持仓账本只能有一个口径.md', title: '持仓账本只能有一个口径', score: 0.091, excerpt: '两个口径会让人对同一笔仓位产生两种判断…', picked: false, drop: 'low' },
        { docId: 'd', path: 'memory/2026/11/2026-11-13.md', title: '2026-11-13 周五', score: 0.087, excerpt: '今天没怎么动，主要是看…', picked: false, drop: 'low' },
        { docId: 'e', path: 'personal/learning/contextdb只当索引层不当真相源.md', title: 'contextdb 只当索引层，不当真相源', score: 0.081, excerpt: '索引是可重建的…', picked: false, drop: 'low' },
        { docId: 'f', path: 'personal/stock/短线中线候选清单.md', title: '短线中线候选清单', score: 0.615, excerpt: '候选清单每周更新一次…', picked: false, drop: 'budget' },
      ],
    }
    seeded.hits = seeded.rows.filter((row) => row.picked)
    const liveStatus = await hostCall('GET', '/status')
    body = toHtml(await settle(parts.RecallTab, { t, status: liveStatus, api: new parts.Api(), onToast() {}, onReload() {}, onOpen() {}, initialTestMeta: seeded, initialShowDropped: true }))
  } else if (extra.modal === 'done') {
    // 「今天勾掉 N 条」：真实工作区今天可能一条都没勾，用合成 timeline 展示
    const todayKey = new Date().toLocaleDateString('sv-SE')
    const live = (await hostCall('GET', '/timeline?refresh=1'))
    const doneDays = (live.days ?? []).map((day) => day.date === todayKey
      ? { ...day, doneTodos: 3, doneItems: [
        { text: '把 state.json 的 wait 值改成 {kind, at}', section: '产出' },
        { text: '给改期加「周一」落点', section: '产出' },
        { text: '清掉召回日志里的 seed 行', section: '备忘' },
      ] }
      : day)
    body = toHtml(await settle(parts.App, { initialTab: 'today', initialDoneOpen: true, timelineOverride: { ...live, days: doneDays } }))
  } else if (extra.modal === 'act') {
    // 「变成行动」会先问一句下一步，还能直接排到明天/周一：真实数据里没有「等了 4 天」的条目，只能合成一条
    const live = await hostCall('GET', '/timeline?refresh=1')
    const seedIdx = (live.days ?? []).findIndex((day) => (day.todos ?? []).length >= 1)
    const days = (live.days ?? []).map((day, index) => (index === seedIdx
      ? { ...day, todos: (day.todos ?? []).map((item, at) => (at === 0 ? { ...item, wait: 'reply', waitAt: Date.now() - 4 * 86400000, waitDays: 4 } : item)) }
      : day))
    body = toHtml(await settle(parts.App, { initialTab: 'todos', initialActing: true, initialActingText: '给客户回一封确认邮件，约下周对账', timelineOverride: { ...live, days } }))
  } else if (extra.moved) {
    // 真实工作区里没有「挪了三次」的条目，只能合成一条来看徽标长什么样
    const live = await hostCall('GET', '/timeline?refresh=1')
    // 第一天（今天）常常一条待办都没有，所以要找「第一个真有未完成的那天」来造数据
    const seedIdx = (live.days ?? []).findIndex((day) => (day.todos ?? []).length >= 2)
    const days = (live.days ?? []).map((day, index) => ({
      ...day,
      todos: (day.todos ?? []).map((item, at) => (index === seedIdx && at < 2
        ? {
          ...item,
          movedCount: at + 2,
          movedFrom: '2026-11-04',
          // 合成链：第一条没写理由（截图里要看得出「没写就留白」），第二条写了
          movedSteps: [{ from: '2026-11-04', to: item.date, note: at === 0 ? '' : '等三季报出来再说' }],
        }
        : item)),
    }))
    // 顺带把「为什么挪」那一块展开，一张图说明「点开能看到什么」
    const whying = process.argv.slice(2).includes('--why')
    body = toHtml(await settle(parts.App, { initialTab: 'todos', timelineOverride: { ...live, days }, initialMvOpen: true, initialAskForRepeat: whying }))
  } else if (extra.visited) {
    // 翻过没动：真实工作区的历史打点只有零星几条，这里合成两条典型
    const seed = [
      { path: 'personal/stock/index.md', title: 'stock/index', scope: 'personal', kind: 'index', dwell: 4000, usedAt: Date.now() - 2 * 86400000, mtimeMs: Date.now() - 12 * 86400000, daysSinceUsed: 2 },
      { path: 'personal/learning/常驻助手的四层.md', title: '常驻助手的四层', scope: 'personal', kind: 'note', dwell: 168000, usedAt: Date.now() - 6 * 86400000, mtimeMs: Date.now() - 40 * 86400000, daysSinceUsed: 6 },
      { path: 'personal/work/index.md', title: 'work/index', scope: 'personal', kind: 'index', dwell: 0, usedAt: Date.now() - 9 * 86400000, mtimeMs: Date.now() - 55 * 86400000, daysSinceUsed: 9 },
    ]
    // 预览里注入假 api：线索入口只在「能写」的面板出现，真实宿主里 api 一直在
    const realApi = new (parts.Api)()
    // 读接口照旧走真路由，只把写接口换成假的：预览不该往工作区写东西
    const fakeApi = Object.assign(Object.create(realApi), { append: async () => ({ appended: true }) })
    body = toHtml(await settle(parts.App, { initialTab: 'search', initialVisited: seed, api: fakeApi }))
  } else if (extra.experiments) {
    // 实验记录：真读一次 /experiments，再合成两条（真实文件可能还没攒出历史）
    const liveExp = await hostCall('GET', '/experiments?limit=12')
    const items = Array.isArray(liveExp?.items) ? liveExp.items.slice(0, 6) : []
    while (items.length < 2) {
      items.push({ at: new Date().toISOString(), kind: items.length === 0 ? 'sweep' : 'compare', query: items.length === 0 ? '钧达的止损线怎么定？' : 'PMHYBRID77 是哪个端口', rows: [{ key: 'base', injected: items.length === 0 ? 10 : 9 }, { key: 'bud', injected: items.length === 0 ? 12 : 9 }] })
    }
    body = toHtml(await settle(parts.App, { initialTab: 'recall', initialExperiments: items, initialQuery: '钧达的止损线怎么定？' }))
  } else if (extra.sweep) {
    // 「四个旋钮一起看」：五套组合各打一次 /test（时间和面板上真按一次一样）
    const combos = [
      { key: 'base', trial: {} },
      { key: 'th', trial: { threshold: 0.05 } },
      { key: 'bud', trial: { maxChars: 2400 } },
      { key: 'snip', trial: { excerptChars: 120 } },
      { key: 'all', trial: { threshold: 0.05, maxChars: 2400, excerptChars: 120 } },
    ]
    const rows = []
    for (const combo of combos) {
      const value = await hostCall('POST', '/test', { query: extra.sweep, ...combo.trial })
      const picked = Array.isArray(value?.picked) ? value.picked : (value?.hits ?? [])
      const dropped = value?.dropped ?? {}
      rows.push({ key: combo.key, trial: combo.trial, injected: picked.length, candidates: (value?.rows ?? []).length, low: Number(dropped.low) || 0, budget: Number(dropped.budget) || 0, top: Number(picked[0]?.score ?? 0), ms: Number(value?.ms) || 0 })
    }
    body = toHtml(await settle(parts.App, { initialTab: 'recall', initialSweep: rows, initialQuery: extra.sweep }))
  } else if (extra.compare) {
    // 「换个说法再试」：三种措辞各打一次 /test，把结果塞给 RecallTab（不猜变体，和组件同一套规则）
    const base = extra.compare
    // 变体规则必须和组件同一份，否则截图里会出现「面板不会这么拆」的假象
    const variants = parts.phraseVariants ? parts.phraseVariants(base) : [{ key: 'orig', text: base }]
    const rows = []
    for (const item of variants) {
      const value = await hostCall('POST', '/test', { query: item.text })
      const picked = Array.isArray(value?.picked) ? value.picked : (value?.hits ?? [])
      rows.push({ key: item.key, text: item.text, injected: picked.length, candidates: (value?.rows ?? []).length, top: Number(picked[0]?.score ?? 0), title: picked[0]?.title ?? '', path: picked[0]?.path ?? '' })
    }
    body = toHtml(await settle(parts.App, { initialTab: 'recall', initialCompare: rows, initialQuery: base }))
  } else if (extra.state) {
    // 「面板自己的状态」：每次都是现读现算，截图要的是「有数据时」的样子
    const liveState = await hostCall('GET', '/state/export')
    if (extra.migrate) {
      // 真实文件早就是 v2 了，迁移提示平时看不到：合成一份「刚从 v0 读进来」的样子
      liveState.fileVersion = 0
      liveState.migration = { from: 0, migrated: [{ table: 'queries', fixed: 6 }, { table: 'wait', fixed: 2 }, { table: 'ui', fixed: 1 }], fixed: 9 }
    }
    body = toHtml(await settle(parts.App, { initialTab: 'recall', initialStateInfo: liveState, initialStateOpen: extra.migrate !== true }))
  } else if (extra.sort) {
    // 排序切换：默认「今天新加的在前」，换成「最久没动的在前」是另一个视图
    body = toHtml(await settle(parts.App, { initialTab: 'today', initialTodoSort: extra.sort }))
  } else if (extra.clues) {
    // 「线索」那一屏：真实工作区还没有 - 想找： 记录，只能合成，否则截出来永远是空态
    const rows = [
      { path: 'personal/stock/index.md', title: 'stock', kind: 'index', text: '各板块止损线怎么定', line: 18, open: true, ageDays: 11, clueKind: 'check' },
      { path: 'personal/learning/index.md', title: 'learning', kind: 'index', text: '常驻助手到底缺哪一层', line: 7, open: true, ageDays: 4, clueKind: 'find' },
      { path: 'personal/work/index.md', title: 'work', kind: 'index', text: '周报模板放哪了', line: 24, open: false, clueKind: 'cite', resolvedAt: Date.now() - 3 * 86400000 },
    ]
    const recent = [
      { text: '周报模板放哪了', at: Date.now() - 3600000, days: 0 },
      { text: '止损线的历史判断', at: Date.now() - 2 * 86400000, days: 2 },
    ]
    const pages = [
      { path: 'personal/index.md', title: '个人记忆', scope: 'personal' },
      { path: 'personal/stock/index.md', title: 'stock', scope: 'personal' },
      { path: 'personal/learning/index.md', title: 'learning', scope: 'personal' },
    ]
    body = toHtml(await settle(parts.App, { initialTab: 'search', initialClueRows: rows, initialClueRecent: recent, initialCluePages: pages }))
  } else if (extra.modal === 'empty-today') {
    // 「今天还没写」那一屏：真实工作区里今天已经写了，这块提示平时看不到，
    // 所以用一份「只有昨天」的 timeline 单独渲染今天页。
    const timeline = await hostCall('GET', '/timeline?refresh=1')
    const now = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const todayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    const days = (timeline.days ?? []).filter((day) => day.date !== todayKey)
    const page = toHtml(await settle(parts.App, { initialTab: 'today', timelineOverride: { ...timeline, days } }))
    body = page
    note = '今天没写时的首屏（合成 timeline）'
  } else if (extra.modal === 'sidebar') {
    // 侧栏入口：图标 + 标题，模拟 sidebar.panellist 的一行
    const icon = toHtml(await settle(parts.PanelIcon, { size: 16 }))
    body = `<div style="display:flex;height:100vh">
      <div style="width:232px;background:var(--dsw-specific-sidebar-fill);border-right:1px solid var(--dsw-alias-border-l1);padding:14px 10px;display:flex;flex-direction:column;gap:6px">
        <div style="font-size:12px;color:var(--dsw-alias-label-secondary);padding:4px 8px 8px">全局面板</div>
        <div class="pmp-side-entry" style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px">${icon}<span>${esc(t('nav'))}</span></div>
        <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;color:var(--dsw-alias-label-secondary);font-size:13px">${icon}<span>sector-board 同级入口</span></div>
      </div>
      <div style="flex:1;min-width:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);display:flex;align-items:center;justify-content:center;font-size:13px">点侧栏图标 → 整页面板</div>
    </div>`
    note = '侧栏入口示意'
  } else {
    body = toHtml(await settle(parts.App, { initialTab: tab, initialQuery: extra.query ?? null, initialEdit: extra.edit === true, initialLogOpen: extra.logOpen ?? undefined, initialTest: extra.test ?? null, initialCtx: extra.ctx === true }))
    note = `页签：${tab} · 主题：${theme}${extra.edit ? ' · 编辑态' : ''}`
  }

  const html = `<!doctype html>
<html lang="zh-CN" data-pm-theme="${theme}">
<head>
<meta charset="utf-8" />
<title>个人记忆面板 · ${esc(note)}</title>
<style>
:root {
${rootCss}
  --dsh-frame-top-clearance: 0px;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; height: 100%; }
body {
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-family: -apple-system, "SF Pro SC", "PingFang SC", "Helvetica Neue", Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
#pm-mount { width: ${width}px; height: ${height}px; overflow: hidden; position: relative; }
/* 截图时把入场动画压掉，否则无头浏览器会停在 opacity<1 的中间帧 */
.pmp-fade, .pmp-spin { animation: none !important; opacity: 1 !important; transform: none !important; }
</style>
<style id="pm-panel-styles">${panelStyles[0] ?? ''}</style>
</head>
<body>
<div id="pm-mount">${body}</div>
</body>
</html>`
  return html
}

async function shoot(htmlPath, pngPath, width, height) {
  await mkdir(dirname(pngPath), { recursive: true })
  await run(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--force-device-scale-factor=2',
    `--window-size=${width},${height}`,
    '--virtual-time-budget=2000',
    '--user-data-dir=/tmp/pm-chrome-profile',
    `--screenshot=${pngPath}`,
    `file://${htmlPath}`,
  ], { maxBuffer: 8 * 1024 * 1024 })
  return pngPath
}

const args = parseArgs(process.argv.slice(2))

if (args.all) {
  const outDir = '/tmp/pm-preview'
  await mkdir(outDir, { recursive: true })
  const jobs = []
  for (const theme of ['light', 'dark']) {
    for (const tab of ['today', 'personal', 'timeline', 'todos', 'search', 'recall']) {
      const htmlPath = resolve(outDir, `${theme}-${tab}.html`)
      const pngPath = resolve(outDir, `${theme}-${tab}.png`)
      const html = await renderPage({ tab, theme, width: args.width, height: args.height })
      await writeFile(htmlPath, html, 'utf8')
      jobs.push({ htmlPath, pngPath, theme, tab })
    }
  }
  for (const job of jobs) {
    await shoot(job.htmlPath, job.pngPath, args.width, args.height)
    console.log(`✓ ${job.pngPath}`)
  }
} else {
  const modal = process.argv.slice(2).find((item) => item.startsWith('--modal='))?.split('=')[1]
  const qArg = process.argv.slice(2).find((item) => item.startsWith('--search='))?.split('=')[1]
  const edit = process.argv.slice(2).includes('--edit')
  const sortArg = process.argv.slice(2).find((item) => item.startsWith('--sort='))?.split('=')[1]
  const cluesArg = process.argv.slice(2).includes('--clues')
  const clueHitArg = process.argv.slice(2).includes('--clue-hit')
  const onlyClueArg = process.argv.slice(2).includes('--only-clue')
  const auditBadArg = process.argv.slice(2).includes('--audit')
  const noneClueArg = process.argv.slice(2).includes('--none-clue')
  const quickQueryArg = process.argv.slice(2).find((item) => item.startsWith('--quick-search='))?.split('=')[1]
  const mixedArg = process.argv.slice(2).includes('--mixed')
  const stateArg = process.argv.slice(2).includes('--state')
  const migrateArg = process.argv.slice(2).includes('--migrate')
  const compareArg = process.argv.slice(2).find((item) => item.startsWith('--compare='))?.split('=')[1]
  const sweepArg = process.argv.slice(2).find((item) => item.startsWith('--sweep='))?.split('=')[1]
  const expArg = process.argv.slice(2).includes('--experiments')
  const visitedArg = process.argv.slice(2).includes('--visited')
  const movedArg = process.argv.slice(2).includes('--moved')
  const searchSortArg = process.argv.slice(2).find((item) => item.startsWith('--hit-sort='))?.split('=')[1]
  const onlyStateArg = process.argv.slice(2).includes('--only-state')
  const html = await renderPage({ tab: args.tab, theme: args.theme, width: args.width, height: args.height, extra: { modal, edit, query: qArg, sort: sortArg, clues: cluesArg, clueHit: clueHitArg, onlyClue: onlyClueArg, noneClue: noneClueArg, quickQuery: quickQueryArg, mixed: mixedArg, state: stateArg, migrate: migrateArg, compare: compareArg, sweep: sweepArg, experiments: expArg, visited: visitedArg, moved: movedArg, searchSort: searchSortArg, onlyState: onlyStateArg, auditBad: auditBadArg, ctx: modal === 'ctx', logOpen: Number.isFinite(args.logOpen) ? args.logOpen : undefined, test: args.test } })
  await mkdir(dirname(args.out), { recursive: true })
  await writeFile(args.out, html, 'utf8')
  console.log(`✓ ${args.out}（${html.length} bytes）`)
  if (args.shot) {
    await shoot(resolve(args.out), resolve(args.shot), args.width, args.height)
    console.log(`✓ ${resolve(args.shot)}`)
  }
}
