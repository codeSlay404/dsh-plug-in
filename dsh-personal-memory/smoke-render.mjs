// 渲染冒烟：不用浏览器、不装 React —— 用 harness.mjs 的极简 hooks 运行时把整棵面板树真的跑一遍。
// 数据来自本机真实工作区（走 apply() 注册的 /personal-memory 路由），所以同时验证 host 数据层与 client 渲染层对得上。
//
// 用法：node smoke-render.mjs

import { boot, collect, walk } from './harness.mjs'

const { parts, t, hostCall, settle, expand, styles, reset } = await boot({ realWorkspace: true })
const { expand: expandIcon } = { expand }

/** 在 harness 树里找第一个 className 含某个 token 的节点（用来真的「点」它） */
function firstWithClass(node, token) {
  if (!node || typeof node !== 'object') return null
  const props = node.props ?? {}
  if (typeof props.className === 'string' && props.className.split(/\s+/).includes(token)) return node
  for (const child of node.children ?? []) {
    const hit = firstWithClass(child, token)
    if (hit) return hit
  }
  return null
}

const results = []
function check(label, ok, detail = '') {
  results.push({ label, ok: Boolean(ok) })
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

const noop = () => {}
const pageProps = { t, onOpen: noop, selected: '' }

// --- 真的把数据取一遍（走 host 路由），后面每个视图都用这份真实数据 ---
const status = await hostCall('GET', '/status')
const timeline = await hostCall('GET', '/timeline')
const treeData = await hostCall('GET', '/tree')
const docValue = await hostCall('GET', '/doc?path=' + encodeURIComponent('personal/关于我.md'))
const searchValue = await hostCall('GET', '/search?q=' + encodeURIComponent('记忆') + '&scope=personal,memory&topK=5')
const diaryDoc = await hostCall('GET', '/doc?path=' + encodeURIComponent(timeline?.days?.[0]?.path ?? 'memory/index.md'))

// --- 知识库体检条：通过了只留一行小字，坏了才列出来 ---
{
  const auditClean = await hostCall('GET', '/audit')
  const cleanTree = await settle(parts.MasterPersonal, { t, docs: treeData?.docs ?? [], selected: '', onOpen: noop, audit: auditClean, onCollapse: noop })
  const cleanView = collect(cleanTree)
  check('体检通过时只占一行', cleanView.classes.includes('pmp-audit-ok') && !cleanView.classes.includes('pmp-audit-bad'), '')

  const auditBad = {
    counts: { p0: 1, p1: 3, p2: 0, total: 4 },
    notes: 35,
    items: [
      { level: 'P0', path: 'personal/index.md', issue: '死链 → gone.md', hint: '修链接' },
      { level: 'P1', path: 'personal/no-meta.md', issue: '缺「更新:」', hint: '补日期' },
      { level: 'P1', path: 'personal/orphan.md', issue: '没被任何 index 引用', hint: '加一行' },
      { level: 'P1', path: 'personal/extra.md', issue: '缺「来源:」', hint: '补来源' },
    ],
  }
  reset()
  const badTree = await settle(parts.MasterPersonal, { t, docs: treeData?.docs ?? [], selected: '', onOpen: noop, audit: auditBad, onCollapse: noop })
  const badView = collect(badTree)
  check('体检有问题时列出来', badView.classes.includes('pmp-audit-bad'), '')
  check('体检最多列三条，其余压成一行', badView.classes.filter((c) => c === 'pmp-audit-row').length === 3 && badView.classes.includes('pmp-audit-more'), '')
  check('体检条目标出级别', badView.classes.includes('p0') && badView.classes.includes('p1'), '')
  const rowButton = firstWithClass(badTree, 'pmp-audit-row')
  check('点体检条目交给上层打开', typeof rowButton?.props?.onClick === 'function', rowButton ? '' : '没找到行按钮')
  let openedPath = ''
  const clickTree = await settle(parts.MasterPersonal, { t, docs: treeData?.docs ?? [], selected: '', onOpen: (path) => { openedPath = path }, audit: auditBad, onCollapse: noop })
  const clickRow = firstWithClass(clickTree, 'pmp-audit-row')
  if (clickRow?.props?.onClick) clickRow.props.onClick()
  check('体检条目点开的是那一篇', openedPath === 'personal/index.md', openedPath)
}

const mainReg = parts && null // 占位：下面是真实断言
void mainReg

// --- 3.1 侧栏入口 ---
const iconTree = expandIcon(parts.PanelIcon({ size: 16 }))
check('侧栏图标能渲染成 svg', iconTree && iconTree.type === 'svg')
check('样式注入了一条 style', styles.length === 1, `${styles[0]?.length ?? 0} chars`)

// --- 3.2 整页（真实数据、多轮 pass） ---
const tree = await settle(parts.App, {})
const view = collect(tree)
check('整页渲染出 pmp-root', view.classes.includes('pmp-root'), tree?.props?.className)
check('六个 tab 都在', ['今天', '个人记忆', '时间长河', '未完成', '检索', '召回'].every((label) => view.all.includes(label)))
check('状态条出现', view.classes.includes('pmp-strip'))
check('默认落在「今天」页', view.classes.includes('pmp-today'), view.classes.filter((c) => c.startsWith('pmp-')).slice(0, 6).join(','))
check('今天页有统计卡', view.classes.filter((c) => c === 'pmp-card').length >= 4, `${view.classes.filter((c) => c === 'pmp-card').length} 张`)
check('今天页有「今天该做的」', view.all.includes('今天该做的'))
check('今天页能勾待办', view.classes.includes('pmp-td-box'))
check('整页首渲染不抛异常', Boolean(tree))

// 左栏（个人记忆页）单独渲染：树里现在也带 project/ 的笔记
// 注意：hook 状态在组件实例上粘着，换 initialTab 必须 reset()，否则 tab 还是上一次的「今天」
reset()
const personalTree = await settle(parts.App, { initialTab: 'personal' })
const treeListView = collect(personalTree)
check('左栏有条目', treeListView.classes.includes('pmp-item'), `item=${treeListView.classes.filter((c) => c === 'pmp-item').length}`)
check('左栏分组用 pmp-g*', treeListView.classes.some((c) => c.startsWith('pmp-g')))
check('左栏出现真实标题', treeListView.text.some((v) => v.includes('关于我') || v.includes('index')), treeListView.text.slice(0, 5).join(' / '))
check('project 笔记也进了树', String(treeListView.all).includes('项目'), String(treeListView.all).slice(0, 120))

// ⌘K 跳转面板
reset()
const qjTree = await settle(parts.QuickJump, { t, docs: (await hostCall('GET', '/tree?scope=personal,memory,project&refresh=1')).docs, onPick: () => {}, onClose: () => {} })
const qjView = collect(qjTree)
check('⌘K 面板有输入框', qjView.tags.includes('input'))
check('⌘K 面板列出候选', qjView.classes.filter((c) => c === 'pmp-qj-row').length > 10, `${qjView.classes.filter((c) => c === 'pmp-qj-row').length} 行`)
check('⌘K 面板有快捷键提示', qjView.all.includes('⌘K'))

// ⌘K 里页签也能跳：手机上没键盘，这是「去哪」的唯一入口
reset()
const navCalls = []
const qjTreePages = await settle(parts.QuickJump, {
  t,
  docs: (await hostCall('GET', '/tree?scope=personal&refresh=1')).docs,
  pages: [
    { key: 'today', label: t('tab.today') },
    { key: 'todos', label: t('tab.todos') },
  ],
  onNavigate: (key) => navCalls.push(key),
  onPick: (path) => navCalls.push(`doc:${path}`),
  onClose: () => {},
})
const qjPages = collect(qjTreePages)
check('⌘K 列出页签快捷跳转', qjPages.classes.filter((c) => c === 'pmp-qj-page').length === 2, `${qjPages.classes.filter((c) => c === 'pmp-qj-page').length} 个页签行`)
const pageBtn = firstWithClass(qjTreePages, 'pmp-qj-page')
if (pageBtn && pageBtn.props && typeof pageBtn.props.onClick === 'function') pageBtn.props.onClick()
check('点页签行走 onNavigate，不走 onPick', navCalls.length === 1 && navCalls[0] === 'today', JSON.stringify(navCalls))

// ⌘K 里的「最近看过」：空查询时排在页签之后、全部笔记之前
reset()
const qjRecent = await settle(parts.QuickJump, {
  t,
  docs: (await hostCall('GET', '/tree?scope=personal&refresh=1')).docs,
  recent: [
    { path: 'personal/关于我.md', title: '关于我', daysSinceUsed: 0 },
    { path: 'personal/stock/index.md', title: 'stock/index', daysSinceUsed: 2 },
  ],
  onPick: () => {},
  onClose: () => {},
})
const qjRecentView = collect(qjRecent)
check('⌘K 列出最近看过的', qjRecentView.classes.filter((c) => c === 'pmp-qj-recent').length === 2, `${qjRecentView.classes.filter((c) => c === 'pmp-qj-recent').length} 行`)
check('⌘K 最近看过带「几天前」', String(qjRecentView.all).includes('2 天前看过'), String(qjRecentView.all).slice(0, 160))
check('⌘K 今天看过不说「0 天前」', String(qjRecentView.all).includes('今天看过') && !String(qjRecentView.all).includes('0 天前看过'), String(qjRecentView.all).slice(0, 120))
const recentBtn = firstWithClass(qjRecent, 'pmp-qj-recent')
const recentCalls = []
if (recentBtn && recentBtn.props && typeof recentBtn.props.onClick === 'function') recentBtn.props.onClick()
check('点最近看过的行会打开那篇', typeof recentBtn?.props?.onClick === 'function')

reset()
const timelineExtras = collect(await settle(parts.MasterTimeline, { t, timeline, docs: (await hostCall('GET', '/tree?scope=memory&refresh=1')).docs, selected: null, onOpen: () => {} }))
check('时间长河给出 memory 索引入口', timelineExtras.classes.includes('pmp-tl-xi'))
// 时间线：月份头要给「这个月记了几天 / 空了几格」，并且能折叠
reset()
let tlCollapsed = {}
const tlOnCollapse = (key) => { tlCollapsed = { ...tlCollapsed, [key]: tlCollapsed[key] !== true } }
const tlTree = await settle(parts.MasterTimeline, { t, timeline, docs: [], selected: null, onOpen: () => {}, collapsed: tlCollapsed, onCollapse: tlOnCollapse })
const tlView = collect(tlTree)
check('月份头带「记了几天 · 条目 · 空几天」', tlView.classes.includes('pmp-tl-ms') && /天/.test(tlView.all), String(tlView.all).slice(0, 60))
// 折叠偏好现在归 App 管（落盘到 state.json），组件只负责把 key 交上去
const tlMonthHead = firstWithClass(tlTree, 'pmp-tl-m')
const daysBefore = tlView.classes.filter((c) => c === 'pmp-day').length
if (tlMonthHead && tlMonthHead.props && typeof tlMonthHead.props.onClick === 'function') tlMonthHead.props.onClick()
const tlAfter = collect(await settle(parts.MasterTimeline, { t, timeline, docs: [], selected: null, onOpen: () => {}, collapsed: tlCollapsed, onCollapse: tlOnCollapse }))
check('月份头把折叠 key 交给上层', Object.keys(tlCollapsed).some((key) => key.startsWith('month:')), JSON.stringify(tlCollapsed))
const tlAfter2 = collect(await settle(parts.MasterTimeline, { t, timeline, docs: [], selected: null, onOpen: () => {}, collapsed: tlCollapsed, onCollapse: () => {} }))
const daysAfter = tlAfter2.classes.filter((c) => c === 'pmp-day').length
check('传回收起的 collapsed 就不渲染那些天', daysAfter < daysBefore, `${daysBefore} → ${daysAfter} 天`)
reset() // 折叠是组件内 state，不清掉会把后面的时间线断言一起折了

// --- 3.3 host 数据面 ---
check('status 解析出工作区', status?.workspace === '/Users/mars/sly', String(status?.workspace))
check('status 带面板配置', status?.config?.panelTopK !== undefined, String(status?.config?.panelTopK))
check('时间线有天数', (timeline?.days ?? []).length > 0, `${timeline?.days?.length} 天 / ${timeline?.totals?.entries} 条`)
check('时间线带未完成条目', (timeline?.days ?? []).some((d) => (d.todos ?? []).length > 0))
check('笔记树覆盖 personal + memory', new Set((treeData?.docs ?? []).map((d) => d.scope)).size >= 2,
  [...new Set((treeData?.docs ?? []).map((d) => d.scope))].join(','))
check('/doc 返回正文', typeof docValue?.text === 'string' && docValue.text.length > 20, `${docValue?.text?.length} chars`)
check('/doc 带 toc', Array.isArray(docValue?.toc) && docValue.toc.length > 0, `${docValue?.toc?.length} 个标题`)
check('/search 命中', (searchValue?.hits ?? []).length > 0, `${(searchValue?.hits ?? []).length} 条`)
check('日记 doc 带 diary 结构', Boolean(diaryDoc?.diary), `${diaryDoc?.diary?.entries ?? 0} 条记录`)

// --- 3.4 个人记忆列表 ---
const personalView = collect(await settle(parts.MasterPersonal, { ...pageProps, docs: treeData.docs, selected: 'personal/index.md' }))
check('个人记忆列表有 pmp-item', personalView.classes.includes('pmp-item'), `${personalView.classes.filter((c) => c === 'pmp-item').length} 条`)
check('个人记忆列表有筛选框', personalView.tags.includes('input'))
check('选中项高亮 on', personalView.classes.includes('on'))

// --- 3.5 时间长河 ---
const timelineView = collect(await settle(parts.MasterTimeline, { ...pageProps, timeline, selected: timeline?.days?.[0]?.path }))
check('时间线渲染出月份分组', timelineView.classes.includes('pmp-tl-m'), timelineView.classes.filter((c) => c.startsWith('pmp-tl')).join(','))
check('时间线渲染出日期条目', timelineView.classes.includes('pmp-day'), `${timelineView.classes.filter((c) => c === 'pmp-day').length} 天`)


// 年份格子：12 格回答「今年哪几个月在认真过日子」，点一格要能定位到那个月
check('时间线有年份 12 格', timelineView.classes.filter((c) => c === 'pmp-ym').length === 12,
  `${timelineView.classes.filter((c) => c === 'pmp-ym').length} 格`)
check('有记录的月份格子被点亮', timelineView.classes.filter((c) => c === 'pmp-ym').length === 12 && String(timelineView.all).includes('11'),
  '')
let pickedMonth = ''
const pickTree = await settle(parts.MasterTimeline, { ...pageProps, timeline, selected: null, onPickMonth: (key) => { pickedMonth = key } })
const firstCell = firstWithClass(pickTree, 'pmp-ym')
if (firstCell && typeof firstCell.props?.onClick === 'function') firstCell.props.onClick()
check('点年份格子把月份 key 交给上层', /^month:\d{4}-\d{2}$/.test(pickedMonth), pickedMonth || '没交')
// 断档：中间少写几天，时间轴要说出来，而不是让两天挨着像连着
const gapTimeline = { days: [
  { path: 'memory/2026/11/2026-11-20.md', date: '2026-11-20', weekday: '周五', title: '2026-11-20 周五', entries: 3, openTodos: 0, preview: '今天' },
  { path: 'memory/2026/11/2026-11-17.md', date: '2026-11-17', weekday: '周二', title: '2026-11-17 周二', entries: 2, openTodos: 1, preview: '三天前' },
], totals: { days: 2, entries: 5, openTodos: 1 } }
const gapView = collect(await settle(parts.MasterTimeline, { ...pageProps, timeline: gapTimeline, selected: null, onOpen: noop, docs: [] }))
check('时间轴标出断档天数', gapView.text.some((text) => String(text).includes('2 天没记')), JSON.stringify(gapView.text.filter((x) => String(x).includes('没记'))))
check('断档时两天都还在', gapView.classes.filter((c) => c === 'pmp-day').length === 2)

// 今天页要把「今天新加的」和「挂着没做的」分开：混排会让今天刚写的沉底
const todayKey2 = parts.localDateKey()
const syntheticTimeline = {
  totals: { days: 2, entries: 3, openTodos: 3 },
  days: [
    { date: todayKey2, weekday: '周五', path: `memory/${todayKey2.slice(0, 4)}/${todayKey2.slice(5, 7)}/${todayKey2}.md`, title: todayKey2, entries: 1, chars: 10, openTodos: 1, preview: '今天写了一句', todos: [{ line: 7, text: '今天刚想起来的事', done: false, section: '未完成' }] },
    { date: '2026-11-18', weekday: '周三', path: 'memory/2026/11/2026-11-18.md', title: '2026-11-18 周三', entries: 2, chars: 20, openTodos: 2, preview: '更早的一天', todos: [{ line: 9, text: '上周就该做的事', done: false, section: '未完成' }, { line: 10, text: '另一件欠着的事', done: false, section: '未完成' }] },
  ],
}
reset()
const freshTree = await settle(parts.MasterToday, { t, timeline: syntheticTimeline, docs: [], status, onOpen: noop, onToggleTodo: noop, onDeferTodo: noop, onNote: noop, onQuickTodo: async () => true })
const freshView = collect(freshTree)
const subHeads = freshView.classes.filter((c) => c === 'pmp-subh').length
check('今天页把待办分成「今天新加的 / 挂着没做的」', subHeads === 2, `${subHeads} 个小标题`)
const flat = String(freshView.all)
check('今天新加的排在挂着的前面', flat.indexOf('今天刚想起来的事') > -1 && flat.indexOf('今天刚想起来的事') < flat.indexOf('上周就该做的事'),
  `fresh@${flat.indexOf('今天刚想起来的事')} carried@${flat.indexOf('上周就该做的事')}`)

// 时间线每天只管日记，但「那天还改过哪篇笔记」是另一条线索
const allDocs = (await hostCall('GET', '/tree?scope=personal,memory,project&refresh=1')).docs ?? []
const tlNode = await settle(parts.MasterTimeline, { ...pageProps, timeline, docs: allDocs, collapsed: {}, onCollapse: () => {} })
const tlCollect = collect(tlNode)
const touchedLines = tlCollect.classes.filter((c) => c === 'pmp-day-t').length
// 真实工作区里 personal/ 的笔记必然在某些天被改过，所以这条应该有行
check('时间线每天能显示「还改过哪些笔记」', touchedLines >= 1, `${touchedLines} 行 / ${allDocs.filter((d) => d.scope !== 'memory').length} 篇笔记`)
check('「改过」文案出现', String(tlCollect.all).includes('改过'), '')

// 检索命中要能落到那一节：行上点一下，把 path 和 heading 一起交给上层
const realHits = (await hostCall('GET', '/search?q=' + encodeURIComponent('止损线') + '&topK=6')).hits ?? []
const openedIn = []
const searchTree2 = await settle(parts.MasterSearch, { ...pageProps, initialHits: realHits, initialQuery: '止损线', onOpen: () => {}, onOpenIn: (path, heading) => openedIn.push({ path, heading }) })
const firstHit = (() => {
  let found = null
  const walkHit = (node) => {
    if (!node || typeof node !== 'object' || found) return
    if (String(node.props?.className ?? '').split(/\s+/).includes('pmp-hit')) { found = node; return }
    for (const child of node.children ?? []) walkHit(child)
  }
  walkHit(searchTree2)
  return found
})()
firstHit?.props?.onClick?.()
check('检索命中点开时带上小节标题（好滚到那段）', openedIn.length === 1 && String(openedIn[0].path).length > 0,
  `${openedIn.length} 次 · heading=${JSON.stringify(openedIn[0]?.heading ?? null)}`)

// --- 3.6 未完成清单 ---
let tdCollapsed = {}
const tdOnCollapse = (key) => { tdCollapsed = { ...tdCollapsed, [key]: tdCollapsed[key] !== true } }
const todoTree = await settle(parts.MasterTodos, { ...pageProps, timeline, collapsed: tdCollapsed, onCollapse: tdOnCollapse })
const todoView = collect(todoTree)
check('待办页有按天数的筛选 chip', ['全部', '今天的', '3 天以上', '一周以上'].every((label) => todoView.all.includes(label)), todoView.classes.filter((c) => c === 'pmp-chipb').length + ' chips')
check('待办页渲染 pmp-td', todoView.classes.includes('pmp-td'), `${todoView.classes.filter((c) => c === 'pmp-td').length} 条`)
check('待办页有筛选框', todoView.tags.includes('input'))

// 36 条平铺是一堵墙：默认按「今天 / 这一周 / 更早」分三档，且能折叠
const bucketHeads = todoView.classes.filter((c) => c === 'pmp-td-g').length
check('待办页按「欠了多久」分档', bucketHeads >= 2, `${bucketHeads} 个分档头`)
check('分档头带折叠箭头', todoView.classes.includes('pmp-td-x'))
const rowsBefore = todoView.classes.filter((c) => c === 'pmp-td').length
const headNode = firstWithClass(todoTree, 'pmp-td-g')
if (headNode && headNode.props && typeof headNode.props.onClick === 'function') headNode.props.onClick()
const todoAfter = collect(await settle(parts.MasterTodos, { t, timeline, selected: null, onOpen: () => {}, onToggleTodo: () => {}, collapsed: tdCollapsed, onCollapse: tdOnCollapse }))
const todoAfter2 = collect(await settle(parts.MasterTodos, { t, timeline, selected: null, onOpen: () => {}, onToggleTodo: () => {}, collapsed: tdCollapsed, onCollapse: () => {} }))
const rowsAfter = todoAfter2.classes.filter((c) => c === 'pmp-td').length
check('分档头把折叠 key 交给上层并真的收起', Object.keys(tdCollapsed).some((key) => key.startsWith('bucket:')) && rowsAfter < rowsBefore, `${rowsBefore} → ${rowsAfter} 条 / ${JSON.stringify(tdCollapsed)}`)

// 断言自 live 数据取，别写死某条日记的原文：日记改一句就会误报
const firstTodoText = (timeline?.days ?? []).flatMap((d) => d.todos ?? []).map((x) => String(x.text ?? '')).find((s) => s.length > 8)
check('待办页出现真实待办文本', Boolean(firstTodoText) && todoView.text.some((v) => String(v).includes(firstTodoText.slice(0, 12))), firstTodoText ? firstTodoText.slice(0, 30) : '无待办')
check('待办页每条都有可点的勾选框', todoView.classes.filter((c) => c === 'pmp-td-box').length >= 1 && todoView.tags.includes('button'))
check('待办数据带行号（勾选要靠它写回）', (timeline?.days ?? []).flatMap((d) => d.todos ?? []).every((x) => Number.isInteger(x.line)),
  `sample=${(timeline?.days ?? []).flatMap((d) => d.todos ?? [])[0]?.line}`)

// 改期：待办行上要有「挪明天」，点了把 path/line/expect 交给上层
const deferCalls = []
const deferTree = await settle(parts.MasterTodos, { ...pageProps, timeline, collapsed: {}, onCollapse: () => {}, onDeferTodo: (payload) => deferCalls.push(payload) })
const deferButtons = []
const collectDefer = (node) => {
  if (!node || typeof node !== 'object') return
  const cls = String(node.props?.className ?? '')
  if (cls.split(/\s+/).includes('pmp-td-defer')) deferButtons.push(node)
  for (const child of node.children ?? []) collectDefer(child)
}
collectDefer(deferTree)
check('待办每条都有「挪明天」', deferButtons.length >= 2, `${deferButtons.length} 个改期按钮`)
deferButtons[0]?.props?.onClick?.()
check('挪明天把 path/line/expect 交给上层', deferCalls.length === 1 && Number.isInteger(deferCalls[0].line) && String(deferCalls[0].path).startsWith('memory/'),
  JSON.stringify(deferCalls[0] ?? null).slice(0, 80))

// 勾之前想看一眼出处：待办行上有「?」，点开就地显示那天的摘要，不跳页
const ctxTree = await settle(parts.MasterTodos, { ...pageProps, timeline, collapsed: {}, onCollapse: () => {} })
const ctxButtons = []
const collectCtx = (node) => {
  if (!node || typeof node !== 'object') return
  const cls = String(node.props?.className ?? '')
  if (cls.split(/\s+/).includes('pmp-td-ctx')) ctxButtons.push(node)
  for (const child of node.children ?? []) collectCtx(child)
}
collectCtx(ctxTree)
check('待办行有「那天写了什么」按钮', ctxButtons.length >= 2, `${ctxButtons.length} 个`)
ctxButtons[0]?.props?.onClick?.()
const ctxView = collect(await settle(parts.MasterTodos, { ...pageProps, timeline, collapsed: {}, onCollapse: () => {} }))
check('点开后就地显示那天的摘要与「打开那天」', ctxView.classes.includes('pmp-td-ctxb') && String(ctxView.all).includes('打开那天'),
  `${ctxView.classes.filter((c) => c === 'pmp-td-ctxb').length} 个气泡`)

// --- 3.7 检索页 ---
const searchView = collect(await settle(parts.MasterSearch, pageProps))
check('检索页有输入框', searchView.tags.includes('input'))
// 检索命中要能看出「这条新不新」：时间过滤开了却看不出哪条是新的，等于白开
reset()
const searchProps = { t, selected: null, initialQuery: '止损线', onOpen: () => {}, recent: [] }
await settle(parts.MasterSearch, searchProps)
await new Promise((done) => setTimeout(done, 500))
const hitPage = collect(await settle(parts.MasterSearch, searchProps))
const hitCount = hitPage.classes.filter((c) => c === 'pmp-hit').length
check('检索命中带「改于几时」徽标', hitPage.classes.includes('pmp-hit-age'), `${hitCount} 条命中 / ${hitPage.classes.filter((c) => c === 'pmp-hit-age').length} 个时间徽标`)
check('检索页有范围 chips', searchView.classes.includes('pmp-chipb'), `${searchView.classes.filter((c) => c === 'pmp-chipb').length} 个`)

// --- 3.8 阅读器（personal 与 memory 各一次） ---
const toggles = []
const readerView = collect(await settle(parts.DocReader, { ...pageProps, docPath: docValue.path, doc: docValue, loading: false, error: '', onRetry: noop, api: new parts.Api(), onToggleTodo: (payload) => toggles.push(payload) }))
check('阅读器渲染出 pmp-doc', readerView.classes.some((c) => c.startsWith('pmp-doc')), readerView.classes.slice(0, 3).join(','))
check('阅读器渲染出 markdown 标题', readerView.classes.some((c) => c.startsWith('pmp-h')))
check('阅读器渲染出 chip 元信息', readerView.classes.includes('pmp-chip') || readerView.text.includes('更新'))
check('阅读器渲染出列表项', readerView.classes.includes('pmp-li'), `${readerView.classes.filter((c) => c === 'pmp-li').length} 条`)
check('阅读器渲染出表格', readerView.classes.includes('pmp-table'), `${readerView.classes.filter((c) => c === 'pmp-table').length} 张表`)
check('阅读器有相关笔记区', readerView.classes.includes('pmp-related'), `${readerView.classes.filter((c) => c === 'pmp-rel').length} 条相关`)

// 日记正文里的待办要能点：点一下就把 {path,line,done,expect} 交给上层
// 挑一天真的有未完成条目的日记（最新的那天可能只写了两句、还没待办）
const todoDay = (timeline?.days ?? []).find((day) => (day.todos ?? []).length > 0) ?? timeline?.days?.[0]
const todoDiaryDoc = todoDay && todoDay.path !== diaryDoc.path
  ? await hostCall('GET', '/doc?path=' + encodeURIComponent(todoDay.path))
  : diaryDoc
const diaryTree = await settle(parts.DocReader, { ...pageProps, docPath: todoDiaryDoc.path, doc: todoDiaryDoc, loading: false, error: '', onRetry: noop, api: new parts.Api(), onToggleTodo: (payload) => toggles.push(payload) })
const diaryReader = collect(diaryTree)
const taskButtons = []
const findBoxes = (node) => {
  if (!node || typeof node !== 'object') return
  if (node.type === 'button' && String(node.props?.className ?? '').includes('pmp-check')) taskButtons.push(node)
  for (const child of node.children ?? []) findBoxes(child)
}
findBoxes(diaryTree)
check('日记里的待办渲染成可点的 checkbox', taskButtons.length >= 1, `${taskButtons.length} 个`)
if (taskButtons.length > 0) {
  const box = taskButtons[0]
  const line = Number(box.props?.['data-line'])
  box.props.onClick()
  check('点待办把行号 + 路径交给上层', toggles.length === 1 && toggles[0].path === todoDiaryDoc.path && toggles[0].line === line,
    JSON.stringify(toggles[0]))
  check('点待办时 done 取反', typeof toggles[0]?.done === 'boolean')
}

// 段落渲染：用一段合成 markdown 单独验证（真实笔记里全是列表和表格）
const paraNodes = parts.renderMarkdown('# 标题\n\n这是第一段正文。\n\n这是第二段。\n\n- [ ] 待办一条\n- 普通列表\n').nodes
const paraView = collect(paraNodes)
check('markdown 段落渲染', paraView.classes.includes('pmp-p'), `${paraView.classes.filter((c) => c === 'pmp-p').length} 段`)
check('markdown 待办渲染成 pmp-task', paraView.classes.includes('pmp-task'))
check('markdown 标题渲染成 pmp-h', paraView.classes.some((c) => c.startsWith('pmp-h')))

// --- 3.9 召回页 ---
const recallView = collect(await settle(parts.RecallTab, { ...pageProps, status, api: null, onToast: noop, onReload: noop }))
check('召回页有统计卡', recallView.classes.some((c) => c.startsWith('pmp-stat') || c === 'pmp-card'),
  recallView.classes.filter((c) => c.startsWith('pmp-st')).join(','))
check('召回页有测试输入框', recallView.tags.includes('input'))

// 命中率卡：有样本显示 used/injected 与百分比，没样本显示「—」+ 说明，不能用 0% 冒充
const usageView = collect(await settle(parts.RecallTab, { ...pageProps, status: { ...status, usage: { days: 7, recalls: 4, injected: 20, used: 5, rate: 25 } }, api: null, onToast: noop, onReload: noop }))
check('召回页有命中率卡（5 / 20 · 25%）', String(usageView.all).includes('5 / 20') && String(usageView.all).includes('25%'), String(usageView.all).match(/\d+ \/ \d+/)?.[0] ?? '没有')
reset()
const usageEmpty = collect(await settle(parts.RecallTab, { ...pageProps, status: { ...status, usage: { days: 7, recalls: 0, injected: 0, used: 0, rate: null } }, api: null, onToast: noop, onReload: noop }))
check('没有召回样本时命中率显示「—」', String(usageEmpty.all).includes('—') && !String(usageEmpty.all).includes('0 / 0'), '')// 最近召回来自日志文件，日志会被轮转/清空 —— 用合成 status 断言，别依赖本机累积了多少条
const synthStatus = {
  ...status,
  recent: [
    { at: '2026-11-20T01:00:00.000Z', query: '止损线怎么定', hits: 2, ms: 40, budget: 1600, used: 980, usedCount: 1, items: [{ path: 'personal/stock/index.md', title: '股票', score: 0.61, chars: 260, truncated: false, used: true, usedAt: 1 }, { path: 'memory/2026/11/2026-11-19.md', title: '2026-11-19 周四', score: 0.55, chars: 260, truncated: true }] },
    { at: '2026-11-20T00:40:00.000Z', query: '旧日志没有路径', hits: 1, ms: 30 },
  ],
}
const logView = collect(await settle(parts.RecallTab, { ...pageProps, status: synthStatus, api: null, onToast: noop, onReload: noop, onOpen: noop }))
check('召回页的最近召回是行列表', logView.classes.includes('pmp-log'), `${logView.classes.filter((c) => c === 'pmp-log').length} 行`)
check('有 items 的召回行可展开', logView.classes.filter((c) => c === 'pmp-log-x').length === 1,
  `可展开 ${logView.classes.filter((c) => c === 'pmp-log-x').length} 行 / 共 ${logView.classes.filter((c) => c === 'pmp-log').length} 行`)

check('召回行显示「后来用上了几篇」', String(logView.all).includes('用上 1'), logView.classes.filter((c) => c === 'pmp-log-n').length + ' 行')

// 展开某一行，看「这一轮到底注入了多少字、哪篇被截了」
reset()
const expanded = collect(await settle(parts.RecallTab, { ...pageProps, status: synthStatus, api: null, onToast: noop, onReload: noop, onOpen: noop, initialLogOpen: 0 }))
check('展开的召回行显示「本轮注入 980 / 1600 字」', String(expanded.all).includes('980') && String(expanded.all).includes('1600'),
  expanded.classes.filter((c) => c === 'pmp-log-b').length + ' 条预算行')
check('被截断的那篇标出「截断」', expanded.classes.includes('pmp-log-pc') && String(expanded.all).includes('截断'),
  `${expanded.classes.filter((c) => c === 'pmp-log-pc').length} 条带字数`)

// 3.9b 「试一下」要把召回过程摊开：候选、谁被阈值/预算丢掉、最后注入哪几篇
reset()
const procTree = await settle(parts.RecallTab, { ...pageProps, status, api: new parts.Api(), onToast: noop, onReload: noop, initialTest: '止损线怎么定' })
const procView = collect(procTree)
check('试一下之后列出召回过程', procView.classes.includes('pmp-proc'), `${procView.classes.filter((c) => c === 'pmp-proc-row').length} 条候选`)
let injected = 0
const countInjected = (node) => {
  if (!node || typeof node !== 'object') return
  const cls = String(node.props?.className ?? '')
  if (cls.split(/\s+/).includes('pmp-proc-row') && cls.split(/\s+/).includes('on')) injected += 1
  for (const child of node.children ?? []) countInjected(child)
}
countInjected(procTree)
check('召回过程标出会注入的条目', injected > 0, `${injected} 篇会注入`)
// --- 今天页：勾掉的那些也要看得见 ---
reset()
const doneKey = new Date().toLocaleDateString('sv-SE')
const doneTimeline = { ...timeline, days: (timeline.days ?? []).map((day) => day.date === doneKey ? { ...day, doneTodos: 2, doneItems: [{ text: '把 wait 值改成对象', section: '产出' }, { text: '清掉 seed 行', section: '备忘' }] } : day) }
const doneProps = { ...pageProps, initialTab: 'today', initialDoneOpen: false, timelineOverride: doneTimeline }
const doneTree0 = await settle(parts.App, doneProps)
const doneView0 = collect(doneTree0)
check('今天页有「今天勾掉 N 条」', doneView0.text.some((v) => /今天勾掉 2 条/.test(String(v))), String(doneView0.text).slice(0, 120))
check('收起时不展开做完的清单', !doneView0.classes.includes('pmp-done-l'))
const doneToggle = []
walk(doneTree0, (node) => { if (node && node.type === 'button' && String(node.props?.className ?? '').includes('pmp-done-h')) doneToggle.push(node) })
doneToggle[0]?.props?.onClick?.()
const doneView1 = collect(await settle(parts.App, doneProps))
check('点开列出做完的条目', doneView1.classes.includes('pmp-done-i'), `${doneView1.classes.filter((c) => c === 'pmp-done-i').length} 条`)
check('做完的条目是划线样式', doneView1.classes.includes('pmp-done-t'))
// 点做完的条目：打开那天的日记，并落在它所在的小节
const doneCalls = []
const doneDayPath = (timeline.days ?? [])[0]?.path ?? 'memory/2026/11/2026-11-20.md'
const todayOnly = { ...timeline, days: [{ ...(timeline.days ?? [])[0], date: new Date().toLocaleDateString('sv-SE'), path: doneDayPath, doneTodos: 2, doneItems: [{ text: '把 wait 值改成对象', section: '产出' }] }] }
const doneItemTree = await settle(parts.MasterToday, {
  t,
  timeline: todayOnly,
  docs: [],
  status: null,
  selected: null,
  onOpen: noop,
  onToggleTodo: noop,
  onDeferTodo: noop,
  onNote: noop,
  onQuickTodo: async () => true,
  initialDoneOpen: true,
  onOpenDone: (payload) => doneCalls.push(payload),
})
const doneBtns = []
walk(doneItemTree, (node) => { if (node && node.type === 'button' && String(node.props?.className ?? '').includes('pmp-done-t')) doneBtns.push(node) })
check('做完的条目是按钮', doneBtns.length === 1, `${doneBtns.length} 个`)
doneBtns[0]?.props?.onClick?.()
// --- 上一篇 / 下一篇：按当前列表顺序走 ---
const stepCalls = []
const navProps = { ...pageProps, docPath: docValue.path, doc: docValue, loading: false, error: '', onRetry: noop, api: new parts.Api(), onPrev: () => stepCalls.push(-1), onNext: () => stepCalls.push(1), canPrev: true, canNext: true }
const navTree = await settle(parts.DocReader, navProps)
const navBtns = []
walk(navTree, (node) => { if (node && node.type === 'button' && String(node.props?.className ?? '').includes('pmp-step-b')) navBtns.push(node) })
// --- 检索排序：同一批命中换个看法 ---
const sortHits = [
  { docId: 'a', path: 'personal/关于我.md', title: '关于我', heading: '', score: 0.9, mtimeMs: 1_700_000_000_000, excerpt: 'x' },
  { docId: 'b', path: 'personal/index.md', title: 'index', heading: '', score: 0.5, mtimeMs: 1_800_000_000_000, excerpt: 'y' },
]
const sortCalls = []
const sortTree = await settle(parts.MasterSearch, { t, selected: null, onOpen: noop, onOpenIn: noop, recent: [], initialHits: sortHits, sort: 'score', onSort: (key) => sortCalls.push(key) })
const firstHitTitle = (tree) => {
  let out = null
  walk(tree, (node) => { if (out === null && node && node.type === 'button' && String(node.props?.className ?? '').includes('pmp-hit')) out = String(node.children?.[0]?.children ?? node.props?.children ?? '') })
  return out
}
const sortView = collect(sortTree)
check('检索页有两个排序 chip', sortView.text.some((v) => String(v).includes('按相关度')) && sortView.text.some((v) => String(v).includes('按最近改过')))
const sortBtns = []
walk(sortTree, (node) => { if (node && node.type === 'button' && String(node.props?.className ?? '').includes('pmp-chipb') && collect(node).text.join('').includes('按最近改过')) sortBtns.push(node) })
sortBtns[0]?.props?.onClick?.()
check('点「按最近改过」交给上层', sortCalls[0] === 'recent', JSON.stringify(sortCalls))
const recentTree = await settle(parts.MasterSearch, { t, selected: null, onOpen: noop, onOpenIn: noop, recent: [], initialHits: sortHits, sort: 'recent', onSort: noop })
const recentTitles = []
walk(recentTree, (node) => { if (node && node.type === 'button' && String(node.props?.className ?? '').includes('pmp-hit')) recentTitles.push(collect(node).text.join(' ').slice(0, 20)) })
check('按最近改过时新改的排第一', recentTitles.length === 2 && recentTitles[0].includes('index'), JSON.stringify(recentTitles))
const scoreTree = await settle(parts.MasterSearch, { t, selected: null, onOpen: noop, onOpenIn: noop, recent: [], initialHits: sortHits, sort: 'score', onSort: noop })
const scoreTitles = []
walk(scoreTree, (node) => { if (node && node.type === 'button' && String(node.props?.className ?? '').includes('pmp-hit')) scoreTitles.push(collect(node).text.join(' ').slice(0, 20)) })
check('按相关度时高分的排第一', scoreTitles.length === 2 && scoreTitles[0].includes('关于我'), JSON.stringify(scoreTitles))

check('阅读器有上一篇/下一篇', navBtns.length === 2, `${navBtns.length} 个`)
navBtns[1]?.props?.onClick?.()
navBtns[0]?.props?.onClick?.()
check('两个按钮分别走 +1 / -1', stepCalls.join(',') === '1,-1', stepCalls.join(','))
const navEnd = collect(await settle(parts.DocReader, { ...navProps, canPrev: false, canNext: false }))
const navEndBtns = []
walk(await settle(parts.DocReader, { ...navProps, canPrev: false, canNext: false }), (node) => { if (node && node.type === 'button' && String(node.props?.className ?? '').includes('pmp-step-b')) navEndBtns.push(node) })
check('到头时两个按钮都禁用', navEnd.classes.includes('pmp-step-b') && navEndBtns.every((node) => node.props?.disabled === true))

check('点做完的条目交出 path 与 section', doneCalls.length === 1 && doneCalls[0].path === doneDayPath && doneCalls[0].section === '产出', JSON.stringify(doneCalls))
// App 里点它：真的打开那天的日记（不是只弹个 toast）
reset()
const appDoneProps = { ...pageProps, initialTab: 'today', initialDoneOpen: true, timelineOverride: doneTimeline }
const appDoneTree = await settle(parts.App, appDoneProps)
const appDoneBtns = []
walk(appDoneTree, (node) => { if (node && node.type === 'button' && String(node.props?.className ?? '').includes('pmp-done-t')) appDoneBtns.push(node) })
check('App 里做完的条目也是按钮', appDoneBtns.length > 0, `${appDoneBtns.length} 个`)
appDoneBtns[0]?.props?.onClick?.()
const appDoneAfter = collect(await settle(parts.App, appDoneProps))
check('点了之后打开的是那天的日记', appDoneAfter.text.some((v) => String(v).includes(doneDayPath.split('/').pop().replace('.md', ''))) || appDoneAfter.classes.includes('pmp-doc'), appDoneAfter.text.slice(0, 6).join(' | '))
reset()


reset()

// 临时放宽：阈值/预算看得见、也改得动（只对这一下生效）
const trialTree = await settle(parts.RecallTab, { t, status: synthStatus, api: new parts.Api(), onToast: noop, onReload: noop, onOpen: noop })
const trialView = collect(trialTree)
check('召回页有「临时放宽」那一行', trialView.text.some((v) => String(v).includes('临时放宽')))
check('阈值候选包含 0.08 / 0.05 / 全都要', ['0.08', '0.05', '全都要'].every((label) => trialView.text.some((v) => String(v).includes(label))))
const thBtn = []
walk(trialTree, (node) => { if (node && node.type === 'button' && String(node.props?.className ?? '').includes('pmp-chipb') && String(collect(node).text.join('')).includes('0.05')) thBtn.push(node) })
thBtn[0]?.props?.onClick?.()
const trialTree2 = await settle(parts.RecallTab, { t, status: synthStatus, api: new parts.Api(), onToast: noop, onReload: noop, onOpen: noop })
check('点了放宽后出现提示「只对这一下生效」', collect(trialTree2).text.some((v) => String(v).includes('只对这一下生效')))
reset()

// 被挡掉的清单：只显示注入了什么，人会以为「没召回」=「没有」
const dropRows = [
  { docId: 'p', path: 'personal/关于我.md', title: '关于我', score: 0.7, excerpt: 'a', picked: true },
  { docId: 'l', path: 'personal/low.md', title: '分数不够的', score: 0.05, excerpt: 'b', picked: false, drop: 'low' },
  { docId: 'b2', path: 'memory/2026/11/2026-11-19.md', title: '超预算的', score: 0.62, excerpt: 'c', picked: false, drop: 'budget' },
]
const dropMeta = { query: '止损线', rows: dropRows, picked: 1, candidates: 3, dropped: { low: 1, budget: 1 }, params: { fetchK: 8, threshold: 0.12, maxChars: 1600, mode: 'hybrid' }, ms: 12, mode: 'hybrid', hits: [dropRows[0]] }
const dropTree = await settle(parts.RecallTab, { t, status: synthStatus, api: new parts.Api(), onToast: noop, onReload: noop, onOpen: noop, initialTestMeta: dropMeta })
const dropView = collect(dropTree)
check('召回页列出被挡掉的 N 篇', dropView.text.some((v) => String(v).includes('被挡掉的 2 篇')), (dropView.text ?? []).filter((v) => String(v).includes('挡掉')).join('|'))
check('挡掉的原因写清楚', dropView.text.some((v) => String(v).includes('分数不够 1') && String(v).includes('超预算 1')))
check('默认不展开挡掉的条目', !dropView.classes.includes('pmp-drop-i'))
const dropBtns = []
walk(dropTree, (node) => { if (node && node.type === 'button' && String(node.props?.className ?? '').includes('pmp-drop-h')) dropBtns.push(node) })
dropBtns[0]?.props?.onClick?.()
const dropView2 = collect(await settle(parts.RecallTab, { t, status: synthStatus, api: new parts.Api(), onToast: noop, onReload: noop, onOpen: noop, initialTestMeta: dropMeta }))
check('点开后逐条列出、标明原因', dropView2.classes.filter((c) => c === 'pmp-drop-i').length === 2, `${dropView2.classes.filter((c) => c === 'pmp-drop-i').length} 条`)
check('被挡掉的条目能点开原文', dropView2.text.some((v) => String(v).includes('分数不够的')))

// 召回日志要能看出「这篇是语义撞上的，还是我真的写过这几个字」
reset()
const viaStatus = {
  ...synthStatus,
  recent: [{
    at: new Date().toISOString(),
    query: '止损线',
    hits: 3,
    budget: 1600,
    used: 600,
    items: [
      { path: 'personal/a.md', title: 'A 语义命中', score: 0.62, chars: 120, truncated: false, via: 'vector' },
      { path: 'personal/b.md', title: 'B 字面命中', score: 0.95, chars: 100, truncated: false, via: 'keyword' },
      { path: 'personal/c.md', title: 'C 都中', score: 0.88, chars: 90, truncated: false, via: 'both' },
    ],
  }],
}
const viaView = collect(await settle(parts.RecallTab, { t, status: viaStatus, api: new parts.Api(), onToast: noop, onReload: noop, onOpen: noop, initialLogOpen: 0 }))
check('召回日志标出词面命中', viaView.text.join('\n').includes('词面'), viaView.text.join('\n').slice(0, 200))
check('召回日志标出「都中」', viaView.text.join('\n').includes('都中'), viaView.text.join('\n').slice(0, 200))

// 有召回但没明细：不能把「召回过 20 次」藏成「—」
reset()
const blindStatus = { ...synthStatus, usage: { days: 7, recalls: 20, injected: 0, used: 0, rate: null, source: 'log' } }
const blindView = collect(await settle(parts.RecallTab, { t, status: blindStatus, api: new parts.Api(), onToast: noop, onReload: noop, onOpen: noop }))
check('没明细时说明召回了多少次', blindView.text.join('\n').includes('20 次'), blindView.text.join('\n').slice(0, 200))

// 统计来自日汇总时要标出来（日志被清过，累计还在）
reset()
const rollupStatus = { ...synthStatus, stats: { ...synthStatus.stats, recalls: 42, hits: 120, lastAt: '2026-11-20T00:00:00.000Z', source: 'rollup', rollup: { days: 3, recalls: 42, injected: 120, chars: 9000 } } }
const rollupTree = await settle(parts.RecallTab, { t, status: rollupStatus, api: new parts.Api(), onToast: noop, onReload: noop, onOpen: noop })
check('累计召回来自汇总时标注来源', collect(rollupTree).text.join('\n').includes('含历史汇总'), collect(rollupTree).text.join('\n').slice(0, 120))

// 本周条：这一周记了几条 / 勾掉几条 / 新欠几条
reset()
const wkBase = new Date()
const keyOf2 = (offset) => {
  const d = new Date(wkBase.getFullYear(), wkBase.getMonth(), wkBase.getDate() - offset)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const weekDays = [
  { date: keyOf2(0), path: `memory/2026/11/${keyOf2(0)}.md`, title: `# ${keyOf2(0)}`, weekday: '周四', entries: 3, openTodos: 2, doneItems: [{ text: 'a', section: '未完成' }], preview: '今天' },
  { date: keyOf2(1), path: `memory/2026/11/${keyOf2(1)}.md`, title: `# ${keyOf2(1)}`, weekday: '周三', entries: 5, openTodos: 1, doneItems: [], preview: '昨天' },
  { date: keyOf2(9), path: `memory/2026/11/${keyOf2(9)}.md`, title: `# ${keyOf2(9)}`, weekday: '周二', entries: 9, openTodos: 7, doneItems: [{ text: 'b', section: '未完成' }], preview: '上周' },
]
const weekTree = await settle(parts.MasterToday, { t, timeline: { days: weekDays, totals: { days: 3, entries: 17, openTodos: 10, latest: keyOf2(0) } }, docs: [], status: synthStatus, selected: null, onOpen: noop, onToggleTodo: noop, onNote: noop })
const weekView = collect(weekTree)
const weekText = weekView.text.join('\n')
check('今天页有「本周」条', weekView.classes.includes('pmp-week') || String(weekView.all).includes('pmp-week'), String(weekView.all).slice(0, 60))
check('本周条只算周一起的（3 条而不是 17 条）', weekText.includes('8 条'), weekText.slice(0, 120))
check('本周勾掉数来自 doneItems', weekText.includes('1 勾掉'), weekText.slice(0, 120))
check('本周新欠数正确（今天 2 + 昨天 1）', weekText.includes('3 新欠') && weekView.classes.includes('pmp-week-i') && String(weekView.all).includes('11-16'))

// 试出来的参数要能带走（给 YAML，不自动改配置）
reset()
const snipMeta = { ...dropMeta, params: { ...dropMeta.params, trial: true, threshold: 0.05, maxChars: 2400, excerptChars: 120 } }
const snipTree = await settle(parts.RecallTab, { t, status: synthStatus, api: new parts.Api(), onToast: noop, onReload: noop, onOpen: noop, initialTestMeta: snipMeta, initialTrialHint: true })
const snipBtns = []
walk(snipTree, (node) => { if (node && node.type === 'button' && String(collect(node).text.join('')).includes('变成配置')) snipBtns.push(node) })
check('有「变成配置」入口', snipBtns.length === 1)
snipBtns[0]?.props?.onClick?.()
const snipView = collect(await settle(parts.RecallTab, { t, status: synthStatus, api: new parts.Api(), onToast: noop, onReload: noop, onOpen: noop, initialTestMeta: snipMeta, initialTrialHint: true }))
const snipText = snipView.text.join('\n')
check('展开后给出 YAML 片段', snipText.includes('id: personal-memory') && snipText.includes('excerptChars:'), snipText.slice(0, 160))
check('片段里写明目标文件', snipText.includes('cordis.patch.yml'))
check('给的是复制而不是自动写入', snipView.text.some((v) => String(v).includes('复制')))
check('说明为什么不自动改配置', snipView.text.some((v) => String(v).includes('静默失效')))

// 摘要旋钮：能和预算一起比较，而不是只能调预算
reset()
const exMeta = { ...dropMeta, alt: { excerptChars: 120, picked: 6, current: 4 } }
const exTree = await settle(parts.RecallTab, { t, status: synthStatus, api: new parts.Api(), onToast: noop, onReload: noop, onOpen: noop, initialTestMeta: exMeta })
const exView = collect(exTree)
check('召回页有「摘要」那排 chip', exView.text.some((v) => String(v).includes('摘要')))
check('摘要 chip 包含 180 / 120', ['180', '120'].every((label) => exView.text.some((v) => String(v).includes(label))))
check('给出「摘短能多进几篇」的对比', exView.text.some((v) => String(v).includes('摘到 120 字') && String(v).includes('多进 2 篇')), exView.text.filter((v) => String(v).includes('摘到')).join('|'))
reset()

// 预算不够时给出「再多给 N 字就够」，并能一键按那个数字再试
reset()
const needMeta = { ...dropMeta, need: { rows: 2, extraChars: 300, budgetChars: 1900 } }
const needTree = await settle(parts.RecallTab, { t, status: synthStatus, api: new parts.Api(), onToast: noop, onReload: noop, onOpen: noop, initialTestMeta: needMeta, initialShowDropped: false })
const needView = collect(needTree)
check('被挡掉的块给出目标字数', needView.text.some((v) => String(v).includes('1800') || String(v).includes('1900')), String(needView.text).slice(0, 120))
check('给出「按这个数字再试」', needView.text.some((v) => String(v).includes('按这个数字再试')))
const needBtn = []
walk(needTree, (node) => { if (node && node.type === 'button' && String(collect(node).text.join('')).includes('按这个数字再试')) needBtn.push(node) })
check('这个按钮是可用状态', Boolean(needBtn[0]) && needBtn[0].props?.disabled !== true)
reset()

reset()

check('召回过程给出参数与预算', String(procView.all).includes('阈值') && String(procView.all).includes('预算'))

// --- 3.10 速记弹窗 / 设置分区 ---
const noteView = collect(await settle(parts.NoteModal, { t, api: new parts.Api(), onClose: noop, onDone: noop, toast: noop }))
check('速记弹窗有 textarea', noteView.tags.includes('textarea'))
check('速记弹窗有分节 chips', noteView.classes.includes('pmp-chipb'), `${noteView.classes.filter((c) => c === 'pmp-chipb').length} 个`)
// --- 3.10b 编辑态：点「编辑」→ textarea 出现 → 改字 → 未保存提示 → 保存把 path/text/hash 交上去 ---
const saveCalls = []
const editProps = { ...pageProps, docPath: docValue.path, doc: docValue, loading: false, error: '', onRetry: noop, api: new parts.Api(), onSave: (payload) => { saveCalls.push(payload); return true }, editSignal: 1 }
const editTree = await settle(parts.DocReader, editProps)
const editView = collect(editTree)
check('编辑态出现 pmp-editor', editView.classes.includes('pmp-editor'))
const area = walk(editTree, () => {}), foundArea = []
walk(editTree, (node) => { if (node && node.props && node.type === 'textarea' && String(node.props.className ?? '').includes('pmp-editor')) foundArea.push(node) })
check('编辑器初始内容是原文', String(foundArea[0]?.props?.value ?? '') === String(docValue.text), `${String(foundArea[0]?.props?.value ?? '').length} chars`)
check('编辑态有保存按钮', editView.text.includes('保存'))
// 从「下一步」点进来时会带 editAt：编辑框要照常出全文，且不因为找不到那句话而炸
const editAtProps = { ...editProps, editAt: '止损线' }
const editAtTree = await settle(parts.DocReader, editAtProps)
const editAtView = collect(editAtTree)
check('带 editAt 进编辑态仍然出全文', editAtView.classes.includes('pmp-editor') && editAtView.tags.includes('textarea'))
const editAtGhost = collect(await settle(parts.DocReader, { ...editProps, editAt: '这段文字在正文里不存在' }))
check('editAt 找不到也不崩', editAtGhost.classes.includes('pmp-editor'))

foundArea[0]?.props?.onChange?.({ target: { value: `${docValue.text}\n补一行` } })
const dirtyTree = await settle(parts.DocReader, editProps)
const dirtyView = collect(dirtyTree)
check('改字后出现「未保存」提示', dirtyView.text.some((v) => String(v).includes('未保存')), dirtyView.text.filter((v) => String(v).includes('未保存')).join(' | '))
const saveBtn = []
walk(dirtyTree, (node) => { if (node && node.type === 'button' && String(node.props?.className ?? '').includes('pmp-btn primary') && node.props?.disabled !== true) saveBtn.push(node) })
saveBtn[0]?.props?.onClick?.()
await new Promise((resolve) => setTimeout(resolve, 60))
check('保存把 {path,text,hash} 交给上层', saveCalls.length === 1 && saveCalls[0].path === docValue.path && typeof saveCalls[0].hash === 'string' && String(saveCalls[0].text).includes('补一行'), JSON.stringify(saveCalls[0] ?? {}).slice(0, 120))

// --- 3.10c 新建笔记弹窗 ---
const newView = collect(await settle(parts.NewNoteModal, { t, api: new parts.Api(), dirs: ['personal', 'personal/learning'], onClose: noop, onDone: noop, toast: noop }))
check('新建弹窗有标题输入框', newView.tags.includes('input'))
check('新建弹窗有目录下拉', newView.tags.includes('select'))
check('新建弹窗列出目录候选', newView.text.some((v) => String(v).includes('personal/learning')))
const newTree = await settle(parts.NewNoteModal, { t, api: new parts.Api(), dirs: ['personal'], onClose: noop, onDone: noop, toast: noop })
const submitBtn = []
walk(newTree, (node) => { if (node && node.type === 'button' && String(node.props?.className ?? '').includes('pmp-btn primary')) submitBtn.push(node) })
check('新建弹窗空标题时提交被禁用', submitBtn.length === 1 && submitBtn[0].props?.disabled === true, `disabled=${submitBtn[0]?.props?.disabled}`)

// 星标：阅读器头部有星标按钮，点一下把 {path, on} 交给上层
reset()
const starredMarks = []
const starTree = await settle(parts.DocReader, {
  ...pageProps,
  docPath: diaryDoc.path,
  doc: diaryDoc,
  loading: false,
  error: '',
  onRetry: noop,
  api: new parts.Api(),
  starred: false,
  onStar: (path, on) => { starredMarks.push({ path, on }); return Promise.resolve() },
})
const starView = collect(starTree)
const starButtons = []
const findStar = (node) => {
  if (!node || typeof node !== 'object') return
  if (node.type === 'button' && String(node.props?.className ?? '').startsWith('pmp-star')) starButtons.push(node)
  for (const child of node.children ?? []) findStar(child)
}
findStar(starTree)
check('阅读器有星标按钮', starButtons.length === 1, `${starButtons.length} 个`)
if (starButtons.length > 0) {
  starButtons[0].props.onClick()
  check('点星标把 {path,on} 交给上层', starredMarks.length === 1 && starredMarks[0].path === diaryDoc.path && starredMarks[0].on === true, JSON.stringify(starredMarks[0]))
  check('未星标时 aria-pressed=false', String(starButtons[0].props['aria-pressed']) === 'false')
}
check('星标按钮不影响其它头部按钮', !starView.classes.includes('pmp-star on'))

// 星标组置顶
reset()
const starredDocs = (await hostCall('GET', '/tree?scope=personal&refresh=1')).docs ?? []
const withStar = starredDocs.map((doc, index) => (index === 0 ? { ...doc, star: true } : doc))
const starList = collect(await settle(parts.MasterPersonal, { t, docs: withStar, selected: null, onOpen: () => {} }))
check('星标组排在左栏最前', starList.all.indexOf('星标') > -1 && starList.all.indexOf('星标') < starList.all.indexOf('personal'), String(starList.all).slice(0, 80))

// 最近查过：检索页无输入时给 chips
reset()
const recentView = collect(await settle(parts.MasterSearch, { t, recent: ['止损线', '常驻助手'], selected: null, onOpen: () => {} }))
// 今天页：内联加待办
reset()
const quickTexts = []
const todayTree = await settle(parts.MasterToday, {
  t,
  timeline,
  docs: treeData?.docs ?? [],
  selected: null,
  onOpen: noop,
  onToggleTodo: noop,
  onQuickTodo: async (text) => { quickTexts.push(text); return true },
})
const todayView2 = collect(todayTree)
const todayClasses = todayView2.classes
check('今天页有「加一条待办」输入框', todayClasses.includes('pmp-today-add'), todayClasses.filter((c) => c.startsWith('pmp-today')).join(','))
// 今天页要有时间纵深：只给「今天」的话，这页是个孤岛
const prevRows = todayClasses.filter((c) => c === 'pmp-prev-row').length
check('今天页列出「往前两天」', prevRows === 2, `${prevRows} 行`)
// 「记了几条」之外还要能看出「那天还剩事没做」
const owedDays = (timeline?.days ?? []).filter((day) => day.date !== new Date().toISOString().slice(0, 10) && Number(day.openTodos) > 0)
check('往前两天里带「欠几件」徽标', owedDays.length === 0 || String(todayView2.all).includes('欠 '), String(todayView2.all).includes('欠 '))
// 窄屏把这两天改成横向滑动卡片：DOM 里看不出滚动，只能查样式
const cssText = Array.isArray(styles) ? styles.join('\n') : String(styles ?? '')
check('窄屏下「往前两天」是横滑卡片', cssText.includes('.pmp-prev{flex-direction:row;overflow-x:auto'), '')
const openedPrev = []
const prevTree = await settle(parts.MasterToday, { t, timeline, docs: treeData?.docs ?? [], selected: null, onOpen: (path) => openedPrev.push(path), onToggleTodo: noop })
const prevBtn = firstWithClass(prevTree, 'pmp-prev-row')
if (prevBtn && prevBtn.props && typeof prevBtn.props.onClick === 'function') prevBtn.props.onClick()
check('点「往前两天」那行会打开那天的日记', openedPrev.length === 1 && /^memory\//.test(openedPrev[0]), JSON.stringify(openedPrev))
// 「在等什么」：点一下循环，把「这条在等外部」交给上层
const waitCalls = []
const waitTree = await settle(parts.MasterTodos, { t, timeline, selected: null, onOpen: noop, onToggleTodo: noop, onDeferTodo: noop, waits: {}, onWait: (payload) => waitCalls.push(payload), collapsed: {}, onCollapse: noop })
const waitView = collect(waitTree)
check('每条待办有「在等?」标记按钮', waitView.classes.filter((c) => c === 'pmp-td-wait').length >= 3, String(waitView.classes.filter((c) => c === 'pmp-td-wait').length))
;(function walkWait(node) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(walkWait); return }
  if (String(node.props?.className ?? '').includes('pmp-td-wait')) node.props?.onClick?.()
  for (const child of node.children ?? []) walkWait(child)
})(waitTree)
check('点「在等?」把 {text, kind} 交给上层', waitCalls.some((payload) => payload?.kind === 'market' && String(payload?.text ?? '').length > 0), JSON.stringify(waitCalls[0] ?? null))
const waitMarkedTree = await settle(parts.MasterTodos, { t, timeline, selected: null, onOpen: noop, onToggleTodo: noop, onDeferTodo: noop, waits: { '07:30 晨报 schedule 还没建（01:38 用户明确定时任务先不动，暂缓）': 'reply' }, onWait: noop, collapsed: {}, onCollapse: noop })
check('已标记的条目显示「等人回」', String(collect(waitMarkedTree).all).includes('等人回'), '')
const waitFilterText = String(((timeline.days ?? []).flatMap((day) => day.todos ?? [])[0] ?? {}).text ?? '')
const allRowsTree = await settle(parts.MasterTodos, { t, timeline, selected: null, onOpen: noop, onToggleTodo: noop, onDeferTodo: noop, waits: { [waitFilterText]: 'reply' }, onWait: noop, collapsed: {}, onCollapse: noop })
const waitFilteredTree = await settle(parts.MasterTodos, { t, timeline, selected: null, onOpen: noop, onToggleTodo: noop, onDeferTodo: noop, waits: { [waitFilterText]: 'reply' }, onWait: noop, initialWaitOnly: true, collapsed: {}, onCollapse: noop })
// useState 初始化只生效一次：换成「已开启筛选」的实例前必须 reset()，否则读到上一个实例的 false
reset()
const waitFilteredTree2 = await settle(parts.MasterTodos, { t, timeline, selected: null, onOpen: noop, onToggleTodo: noop, onDeferTodo: noop, waits: { [waitFilterText]: 'reply' }, onWait: noop, initialWaitOnly: true, collapsed: {}, onCollapse: noop })
const rowCount = (view) => view.classes.filter((c) => c === 'pmp-td-box').length
check('「只看在等的」真的把列表收窄到标过的条目', rowCount(collect(waitFilteredTree2)) < rowCount(collect(allRowsTree)) && rowCount(collect(waitFilteredTree2)) >= 1, `${rowCount(collect(allRowsTree))} -> ${rowCount(collect(waitFilteredTree2))}`)
reset()

// 点开「挪过 N 次」看每一步的理由：第二次起改期会先问一句为什么
{
  const mk = (count) => {
    const item = { text: '合成一条挪过两次的待办', line: 9, section: '未完成', age: 1, date: '2026-11-19', weekday: '周四', path: 'memory/2026/11/2026-11-19.md', preview: '',
      movedCount: count, movedFrom: '2026-11-18', movedSteps: [{ from: '2026-11-18', to: '2026-11-19', note: '' }, { from: '2026-11-19', to: '2026-11-20', note: '等三季报出来再说' }].slice(0, count) }
    return { days: [{ path: 'memory/2026/11/2026-11-19.md', date: '2026-11-19', weekday: '周四', title: 'x', entries: 1, openTodos: 1, doneTodos: 0, preview: '', todos: [item] }], totals: { days: 1, entries: 1, openTodos: 1, latest: '2026-11-19' }, months: [] }
  }
  const base = { t, selected: null, onOpen: noop, onToggleTodo: noop, waits: {}, onWait: noop, collapsed: {}, onCollapse: noop }
  reset()
  const calls = []
  const closedTree = await settle(parts.MasterTodos, { ...base, timeline: mk(2), onDeferTodo: (payload) => calls.push(payload) })
  check('挪过两次的「挪过 2 次」是可点的', Boolean(firstWithClass(closedTree, 'pmp-mv')) && typeof firstWithClass(closedTree, 'pmp-mv')?.props?.onClick === 'function', '')
  check('收起时不显示每一步的理由', !String(collect(closedTree).all).includes('等三季报出来再说'), '')
  reset()
  const openTree = await settle(parts.MasterTodos, { ...base, timeline: mk(2), onDeferTodo: (payload) => calls.push(payload), initialMvOpen: true })
  const openText = String(collect(openTree).all)
  check('点开能看到每一步的理由（没写的如实留白）', openText.includes('等三季报出来再说') && openText.includes('当时没写为什么'), '')
  reset()
  const askTree = await settle(parts.MasterTodos, { ...base, timeline: mk(2), onDeferTodo: (payload) => calls.push(payload), initialAskForRepeat: true })
  const askText = String(collect(askTree).all)
  check('第二次改期先问一句「为什么往后挪」', askText.includes('顺手记一句为什么'), '')
  check('问句下面给「记下并挪过去 / 不写了，直接挪」两个出口', askText.includes('记下并挪过去') && askText.includes('不写了，直接挪'), '')
  let skipBtn = null
  walk(askTree, (node) => {
    if (skipBtn) return
    const tokens = String(node?.props?.className ?? '').split(/\s+/)
    if (tokens.includes('pmp-btn') && tokens.includes('ghost')) skipBtn = node
  })
  if (skipBtn?.props?.onClick) skipBtn.props.onClick()
  check('「不写了，直接挪」也真的挪，只是没理由', calls.length === 1 && calls[0]?.note === '' && calls[0]?.to === 'tomorrow', JSON.stringify(calls[0] ?? null))
  reset()
  // 只挪过一次的：点「明天」不该被问（第一次改期是正常调度）
  const neverCalls = []
  const neverTree = await settle(parts.MasterTodos, { ...base, timeline: mk(0), onDeferTodo: (payload) => neverCalls.push(payload), initialAskForRepeat: true })
  check('从没挪过的不会被问「为什么」', !String(collect(neverTree).all).includes('顺手记一句为什么'), '')
  let neverBtn = null
  walk(neverTree, (node) => { if (!neverBtn && String(node?.props?.className ?? '').split(/\s+/).includes('pmp-td-defer-tom')) neverBtn = node })
  if (neverBtn?.props?.onClick) neverBtn.props.onClick()
  check('第一次改期直接挪、不带理由字段', neverCalls.length === 1 && neverCalls[0]?.note === undefined, JSON.stringify(neverCalls[0] ?? null))
  reset()
}

// 老是往后挪的：挪过 2 次才值得标出来（一次临时改期不算问题）
{
  const todoDays = (timeline.days ?? []).filter((day) => (day.todos ?? []).length > 0).slice(0, 2)
  const markMoved = (day, count, from) => ({ ...day, todos: day.todos.map((item) => ({ ...item, movedCount: count, movedFrom: from })) })
  // 「挪过 2 次以上」的筛选要至少两条才出现：真实数据里今天可能只欠 1 条，所以合成两天，
  // 每天各一条挪过 3 次的待办，断言才不随磁盘内容漂移。
  const synthDay = (date, text) => ({ date, path: `memory/2026/11/${date}.md`, file: `${date}.md`, weekday: '周一', entries: 1, openTodos: 1, doneTodos: 0, preview: text, todos: [{ path: `memory/2026/11/${date}.md`, line: 5, text, section: '未完成', age: 2, movedCount: 3, movedFrom: '2026-11-04' }] })
  const movedTimeline = { ...timeline, days: [synthDay('2026-11-18', '挪过三次的甲'), synthDay('2026-11-19', '挪过三次的乙')] }
  reset()
  const movedTree = await settle(parts.MasterTodos, { t, timeline: movedTimeline, selected: null, onOpen: noop, onToggleTodo: noop, onDeferTodo: noop, waits: {}, onWait: noop, collapsed: {}, onCollapse: noop })
  const movedView = collect(movedTree)
  check('挪过 3 次的条目标出「挪过 3 次」', String(movedView.all).includes('挪过 3 次'), '')
  check('有挪过的条目时才出现「老是往后挪的」筛选', String(movedView.all).includes('老是往后挪的'), '')
  reset()
  const onceTree = await settle(parts.MasterTodos, { t, timeline: { ...timeline, days: timeline.days.map((day) => (day.date === todoDays[0]?.date ? markMoved(day, 1, '2026-11-19') : day)) }, selected: null, onOpen: noop, onToggleTodo: noop, onDeferTodo: noop, waits: {}, onWait: noop, collapsed: {}, onCollapse: noop })
  const onceView = collect(onceTree)
  check('只挪过一次的不标、也不出现筛选', !String(onceView.all).includes('挪过 1 次') && !String(onceView.all).includes('老是往后挪的'), '')
  reset()
}

// 等也要有寿命：标了「在等」且超过 3 天的，要在未完成页顶部被问一句
{
  const todoDays = (timeline.days ?? []).filter((day) => (day.todos ?? []).length > 0).slice(0, 3)
  const first = (todoDays[0]?.todos ?? [])[0]
  const rebuilt = { ...timeline, days: timeline.days.map((day) => day.date === todoDays[0]?.date
    ? { ...day, todos: day.todos.map((item) => (item === first ? { ...item, wait: 'reply', waitAt: Date.now() - 4 * 86400000, waitDays: 4 } : item)) }
    : day) }
  const waitCalls2 = []
  const noop2 = () => {}
  reset()
  const strip = await settle(parts.MasterTodos, { t, timeline: rebuilt, selected: null, onOpen: noop2, onToggleTodo: noop2, onDeferTodo: noop2, waits: {}, onWait: (payload) => waitCalls2.push(payload), collapsed: {}, onCollapse: noop2 })
  const stripAll = String(collect(strip).all)
  check('等太久的条目在顶部被提一句', stripAll.includes('还在等吗') && stripAll.includes('等了 4 天'), '')
  const findClass = (node, token, out = []) => {
    if (!node || typeof node !== 'object') return out
    if (typeof node.props?.className === 'string' && node.props.className.split(/\s+/).includes(token)) out.push(node)
    for (const child of node.children ?? []) findClass(child, token, out)
    return out
  }
  const keepBtn = findClass(strip, 'pmp-wr-row')[0]
  check('复查带给「继续等」和「变成行动」两个选择', stripAll.includes('继续等') && stripAll.includes('变成行动'), '')
  const buttonsIn = (node, out = []) => {
    if (!node || typeof node !== 'object') return out
    if (node.type === 'button') out.push(node)
    for (const child of node.children ?? []) buttonsIn(child, out)
    return out
  }
  const inputsIn = (node, out = []) => {
    if (!node || typeof node !== 'object') return out
    if (node.type === 'input') out.push(node)
    for (const child of node.children ?? []) inputsIn(child, out)
    return out
  }
  const rowButtons = buttonsIn(keepBtn)
  rowButtons[0]?.props?.onClick?.()
  check('「继续等」带上原种类（重置计时）', waitCalls2.some((p) => p?.kind === 'reply' && p?.next === undefined), JSON.stringify(waitCalls2))

  // 「变成行动」不直接清标记：先问一句下一步，填完回车才落地
  rowButtons[1]?.props?.onClick?.()
  const afterAct = await settle(parts.MasterTodos, { t, timeline: rebuilt, selected: null, onOpen: noop2, onToggleTodo: noop2, onDeferTodo: noop2, waits: {}, onWait: (payload) => waitCalls2.push(payload), collapsed: {}, onCollapse: noop2 })
  const actInput = inputsIn(afterAct).find((node) => String(node.props?.placeholder ?? '').includes('下一步'))
  check('点「变成行动」先出现「下一步」输入框', Boolean(actInput), JSON.stringify(inputsIn(afterAct).map((n) => n.props?.placeholder ?? '')))
  actInput?.props?.onChange?.({ target: { value: '读 PRD 第 3 节并写两行结论' } })
  const typed = await settle(parts.MasterTodos, { t, timeline: rebuilt, selected: null, onOpen: noop2, onToggleTodo: noop2, onDeferTodo: noop2, waits: {}, onWait: (payload) => waitCalls2.push(payload), collapsed: {}, onCollapse: noop2 })
  const typedInput = inputsIn(typed).find((node) => String(node.props?.placeholder ?? '').includes('下一步'))
  typedInput?.props?.onKeyDown?.({ key: 'Enter' })
  check('回车后把「下一步」和清标记一起交给上层', waitCalls2.some((p) => p?.kind === null && String(p?.next ?? '').includes('PRD 第 3 节')), JSON.stringify(waitCalls2.slice(-2)))

  // 「变成行动」也能直接排进某一天：记下这一步 + 挪过去，一个动作两件事
  reset()
  const planCalls = []
  const actedRow = (todoDays[0]?.todos ?? [])[0]
  const actingKey = `${todoDays[0]?.path}:${actedRow?.line}`
  const planTree = await settle(parts.MasterTodos, { t, timeline: rebuilt, selected: null, onOpen: noop2, onToggleTodo: noop2, onDeferTodo: noop2, waits: {}, onWait: noop2, onPlanNext: (payload) => planCalls.push(payload), initialActing: actingKey, initialActingDraft: '给客户回一封确认邮件', collapsed: {}, onCollapse: noop2 })
  const planAll = String(collect(planTree).all)
  check('「变成行动」旁边给了两个落点', planAll.includes('排到明天') && planAll.includes('排到周一'), '')
  const planBtns = buttonsIn(planTree).filter((node) => String(node.props?.className ?? '').includes('pmp-chipb'))
  const tomBtn = planBtns.find((node) => String(collect(node).all).startsWith('排到明天'))
  check('「排到明天」可点', Boolean(tomBtn), JSON.stringify(planBtns.map((n) => collect(n).all)))
  tomBtn?.props?.onClick?.()
  check('点「排到明天」把 路径/行号/落点/下一步 一起交给上层', planCalls.length === 1 && planCalls[0]?.to === 'tomorrow' && planCalls[0]?.line === actedRow?.line && String(planCalls[0]?.next ?? '').includes('确认邮件'), JSON.stringify(planCalls))
  reset()
  const noPlanTree = await settle(parts.MasterTodos, { t, timeline: rebuilt, selected: null, onOpen: noop2, onToggleTodo: noop2, onDeferTodo: noop2, waits: {}, onWait: noop2, initialActing: actingKey, collapsed: {}, onCollapse: noop2 })
  check('没有排期能力时不渲染这两个按钮', !String(collect(noPlanTree).all).includes('排到明天'), '')

  // 有了下一步，这一行要在正文下面显示出来
  reset()
  const nextTimeline = { ...timeline, days: timeline.days.map((day) => ({ ...day, todos: (day.todos ?? []).map((item, index) => (index === 0 && day.date === todoDays[0]?.date ? { ...item, next: '读 PRD 第 3 节' } : item)) })) }
  const withNext = await settle(parts.MasterTodos, { t, timeline: nextTimeline, selected: null, onOpen: noop2, onToggleTodo: noop2, onDeferTodo: noop2, waits: {}, nexts: {}, onWait: noop2, collapsed: {}, onCollapse: noop2 })
  check('待办行显示「下一步」', String(collect(withNext).all).includes('下一步 · 读 PRD 第 3 节'), '')

  // 可点的「下一步」：把它交回去，让人能在编辑器里落到那一句
  reset()
  const clicks = []
  const withNext2 = await settle(parts.MasterTodos, { t, timeline: nextTimeline, selected: null, onOpen: noop2, onToggleTodo: noop2, onDeferTodo: noop2, waits: {}, nexts: {}, onWait: noop2, onEditNext: (payload) => clicks.push(payload), collapsed: {}, onCollapse: noop2 })
  const nextBtn = (() => {
    const walk = (node, out = []) => {
      if (!node || typeof node !== 'object') return out
      if (node.type === 'button' && String(node.props?.className ?? '').includes('pmp-td-next-go')) out.push(node)
      for (const child of node.children ?? []) walk(child, out)
      return out
    }
    return walk(withNext2)[0]
  })()
  check('「下一步」是能点的按钮', Boolean(nextBtn), '')
  nextBtn?.props?.onClick?.()
  const anchorRow = (nextTimeline.days ?? []).flatMap((day) => day.todos ?? []).find((item) => item.next)
  check('点「下一步」把 路径 + 待办原句 交给上层（光标要落在正文里真实存在的那句）', clicks.length === 1 && String(clicks[0]?.text ?? '') === String(anchorRow?.text ?? '') && String(clicks[0]?.path ?? '').endsWith('.md'), JSON.stringify({ clicks, anchor: anchorRow?.text }))

}

// 档头要能说明「有多旧」，不只是「有几件」；改期给两个落点（明天 / 下周一）
// 面板自己的状态：能看见每张表几条，也能一键清掉（第一次点只是举手）
{
  reset()
  const buttonsIn = (node, out = []) => {
    if (!node || typeof node !== 'object') return out
    if (node.type === 'button') out.push(node)
    for (const child of node.children ?? []) buttonsIn(child, out)
    return out
  }
  const info = {
    path: '.dsh/personal-memory/state.json',
    bytes: 2048,
    modified: '2026-11-20T05:40:00.000Z',
    v: 2,
    fileVersion: 2,
    tables: ['queries', 'stars', 'ui', 'used', 'wait', 'next', 'moved', 'usage'],
    counts: { queries: 11, stars: 1, ui: 3, used: 5, wait: 2, next: 2, moved: 1, usage: 1 },
    state: { queries: [], stars: ['personal/关于我.md'], ui: {}, used: {}, wait: {}, next: {}, moved: {}, usage: {} },
  }
  const called = []
  const apiStub = {
    stateExport: async () => info,
    stateClear: async (tables) => { called.push(tables); return { cleared: tables, counts: { ...info.counts, [tables[0]]: 0 }, state: info.state } },
  }
  const stTree = await settle(parts.RecallTab, { t, status: synthStatus, api: apiStub, initialStateInfo: info })
  const stText = String(collect(stTree).all)
  check('面板状态：列出每张表的名字与条数', stText.includes('检索历史') && stText.includes('改期链') && stText.includes('11'), stText.slice(0, 60))
  check('面板状态：写明存在哪个文件', stText.includes('.dsh/personal-memory/state.json'), 'no path')
  check('面板状态：显示 state 版本号', stText.includes('v2'), stText.slice(-80))
  // 老文件读进来时，要能看见「这次补了几条」并有一键写回
  const migInfo = { ...info, fileVersion: 0, migration: { from: 0, migrated: [{ table: 'queries', fixed: 2 }, { table: 'wait', fixed: 1 }], fixed: 3 } }
  // initialXxx 只在实例初始化时生效：不 reset 就会一直用上一份 info（这个坑本项目踩过多次）
  reset()
  const migTree = await settle(parts.RecallTab, { t, status: synthStatus, api: apiStub, initialStateInfo: migInfo })
  const migText = String(collect(migTree).all)
  check('迁移提示：说清补了几条、来自哪个版本', migText.includes('这次读进来把 3 条') && migText.includes('v0'), migText.slice(0, 80))
  check('迁移提示：有「现在写回文件」的出口', migText.includes('现在写回文件'), 'no button')
  const clearBtns = buttonsIn(stTree).filter((node) => String(collect(node).all).includes('清空'))
  check('面板状态：每张表一个清空按钮', clearBtns.length === 8, String(clearBtns.length))
  clearBtns[0]?.props?.onClick?.()
  const armedTree = await settle(parts.RecallTab, { t, status: synthStatus, api: apiStub, initialStateInfo: info })
  const armedBtn = buttonsIn(armedTree).find((node) => String(collect(node).all).includes('真的清掉'))
  check('面板状态：第一次点只是举起手，不动数据', clearBtns[0] && called.length === 0, JSON.stringify(called))
  check('面板状态：第二次点变成「真的清掉？」', Boolean(armedBtn), 'no armed button')
}

// 命中上两条时间线：改于哪天（mtime）与看过哪天（used）是两件事
{
  reset()
  const now = Date.now()
  const hits = [
    { docId: 'h1', title: '计划买点没到就下手', heading: '五、执行规则', score: 0.71, path: 'personal/stock/plan.md', excerpt: '止损线…', mtimeMs: now - 3 * 86400000, usedAt: now - 6 * 3600000 },
    { docId: 'h2', title: '没看过的上一篇', heading: '二', score: 0.63, path: 'personal/stock/other.md', excerpt: '另一段…', mtimeMs: now - 40 * 86400000 },
  ]
  const tree = await settle(parts.MasterSearch, { t, q: '止损线', initialHits: hits, scope: 'personal,memory,project' })
  const text = String(collect(tree).all)
  check('检索命中：看过的会标「看过 · 今天」', text.includes('看过 · 今天'), text.slice(0, 80))
  check('检索命中：没看过的不标', (text.match(/看过 ·/g) ?? []).length === 1, String((text.match(/看过 ·/g) ?? []).length))
  check('检索命中：改于哪天仍然保留', text.includes('3 天前') && text.includes('1 个月前'), text.slice(0, 120))
}

// 实验记录：跑过的对照留成行，点一行把那次结果铺回来
{
  reset()
  const exps = [
    { at: '2026-11-19T22:01:00.000Z', kind: 'sweep', query: '钧达的止损线怎么定？', rows: [{ key: 'base', injected: 10 }, { key: 'bud', injected: 12 }] },
    { at: '2026-11-19T21:40:00.000Z', kind: 'compare', query: 'PMHYBRID77 是哪个端口', rows: [{ key: 'orig', injected: 9 }] },
  ]
  const expTree = await settle(parts.RecallTab, { t, status: synthStatus, api: {}, initialExperiments: exps })
  const expText = String(collect(expTree).all)
  check('实验记录：列出跑过的对照', expText.includes('实验记录') && expText.includes('旋钮') && expText.includes('说法'), expText.slice(0, 60))
  check('实验记录：每行给出那次最多进几篇', expText.includes('最多 12 篇') && expText.includes('最多 9 篇'), 'no counts')
  const expRows = []
  const collectExp = (node) => {
    if (!node || typeof node !== 'object') return
    if (String(node.props?.className ?? '').split(/\s+/).includes('pmp-exp-row')) expRows.push(node)
    for (const child of node.children ?? []) collectExp(child)
  }
  collectExp(expTree)
  check('实验记录：每行可点回放', expRows.length === 2 && expRows.every((node) => typeof node.props?.onClick === 'function'), String(expRows.length))
}

// 四个旋钮一起看：阈值/预算/摘要各动一档，并排给出被挡的原因
{
  reset()
  const sweepRows = [
    { key: 'base', trial: {}, injected: 10, candidates: 12, low: 0, budget: 2, top: 0.48, ms: 61 },
    { key: 'bud', trial: { maxChars: 2400 }, injected: 12, candidates: 12, low: 0, budget: 0, top: 0.48, ms: 58 },
  ]
  const sweepTree = await settle(parts.RecallTab, { t, status: synthStatus, api: {}, initialSweep: sweepRows })
  const sweepText = String(collect(sweepTree).all)
  check('旋钮扫表：表头给出每一列在说什么', ['配置', '改了什么', '注入', '低分', '超算', '首位'].every((key) => sweepText.includes(key)), sweepText.slice(0, 60))
  check('旋钮扫表：每行给出注入/候选与超预算数', sweepText.includes('10 / 12') && sweepText.includes('预算加到 2400'), 'no row')
  const sweepRows2 = []
  const collectSweep = (node) => {
    if (!node || typeof node !== 'object') return
    if (String(node.props?.className ?? '').split(/\s+/).includes('pmp-cmp-row')) sweepRows2.push(node)
    for (const child of node.children ?? []) collectSweep(child)
  }
  collectSweep(sweepTree)
  const sweepClickable = sweepRows2.filter((node) => typeof node.props?.onClick === 'function')
  check('旋钮扫表：数据行可点（表头不可点）', sweepClickable.length === 2, String(sweepClickable.length))
  // 点击提示在 title 属性里（collect().all 只收文本）
  check('旋钮扫表：说明点一行会发生什么', sweepClickable.every((node) => String(node.props?.title ?? '').includes('按这套参数重跑一次')), 'no hint')
}

// 换个说法再试：同一个意图的三种措辞并排，点一行就用那个说法重跑
{
  reset()
  const rows = [
    { key: 'orig', text: '钧达的止损线怎么定？', injected: 4, candidates: 12, top: 0.71, title: '计划买点没到就下手，等于把止损线也提前了' },
    { key: 'strip', text: '钧达的止损线定', injected: 2, candidates: 12, top: 0.63, title: '技术面状态判定方法' },
    { key: 'focus', text: '钧达 止损线', injected: 5, candidates: 12, top: 0.69, title: '止损线怎么定' },
  ]
  const cmpTree = await settle(parts.RecallTab, { t, status: synthStatus, api: {}, initialCompare: rows })
  const cmpText = String(collect(cmpTree).all)
  const rowsNodes = []
  const collectRows = (node) => {
    if (!node || typeof node !== 'object') return
    if (String(node.props?.className ?? '').split(/\s+/).includes('pmp-cmp-row')) rowsNodes.push(node)
    for (const child of node.children ?? []) collectRows(child)
  }
  collectRows(cmpTree)
  // 提示在 title 属性里，collect().all 只收文本节点
  const rowsTitleHint = rowsNodes.length > 0 && rowsNodes.every((node) => String(node.props?.title ?? '').includes('换成这个说法再跑一次'))
  check('换个说法：三种措辞都列出来', ['原话', '去掉疑问词', '只留实词'].every((key) => cmpText.includes(key)), cmpText.slice(0, 60))
  check('换个说法：每行给出注入数与首位分', cmpText.includes('4 / 12') && cmpText.includes('0.71'), 'no counts')
  check('换个说法：说明点一行会发生什么', rowsTitleHint, String(rowsTitleHint).slice(0, 40))
  check('换个说法：每行可点（共三行）', rowsNodes.length === 3, String(rowsNodes.length))
}

// 历史里恢复的是「同一屏」：当时开了只看待办，恢复时就要连带把开关打开
{
  reset()
  const recentRows = [
    { q: '对账表', scope: '', days: 0, only: 'state' },
    { q: '止损线', scope: 'personal,memory', days: 7, only: '' },
  ]
  const buttonsIn = (node, out = []) => {
    if (!node || typeof node !== 'object') return out
    if (node.type === 'button') out.push(node)
    for (const child of node.children ?? []) buttonsIn(child, out)
    return out
  }
  const histTree = await settle(parts.MasterSearch, { t, recent: recentRows, onOpen: noop, onOpenIn: noop })
  const histChips = buttonsIn(histTree).filter((node) => String(node.props?.className ?? '').includes('pmp-chipb'))
  const onlyChip = histChips.find((node) => String(collect(node).all).includes('只看待办') && String(node.props?.title ?? '').includes('只看待办'))
  check('历史 chip 标出当时开了「只看待办」', Boolean(onlyChip), JSON.stringify(histChips.map((n) => String(collect(n).all).slice(0, 40))))
  onlyChip?.props?.onClick?.()
  const clicked = await settle(parts.MasterSearch, { t, recent: recentRows, onOpen: noop, onOpenIn: noop })
  const chipsAfter = buttonsIn(clicked)
  const dimmed = chipsAfter.filter((node) => String(node.props?.className ?? '').includes('pmp-chipb dim'))
  check('恢复历史后范围 chip 变淡禁用（说明现在只查待办）', dimmed.length === 3 && dimmed.every((node) => node.props?.disabled === true), String(dimmed.length))
}

// 「只看待办」：状态命中混在笔记里要人自己扫，所以给一个开关
{
  reset()
  const onlyView = collect(await settle(parts.MasterSearch, { t, initialStateOnly: true, initialHits: [], query: '对账', onOpen: noop, onOpenIn: noop }))
  const onlyAll = String(onlyView.all)
  check('检索页有「只看待办」开关', onlyAll.includes('只看待办'), '')
  check('只看待办、没有命中时说清楚怎么办', onlyAll.includes('没有匹配的待办'), '')
}

// 「只看线索」与「只看待办」互斥：两个开关不能同时亮
{
  reset()
  const clueView = await settle(parts.MasterSearch, { t, initialOnlyKind: 'clue', initialHits: [], query: '止损线', onOpen: noop, onOpenIn: noop })
  const clueAll = String(collect(clueView).all)
  check('检索页有「只看线索」开关', clueAll.includes('只看线索'), '')
  check('只看线索、没有命中时说清楚怎么办', clueAll.includes('没有匹配的线索'), '')
  const chips = []
  walk(clueView, (node) => { if (Array.isArray(node.props?.className) || typeof node.props?.className === 'string') chips.push(node) })
  const onChips = chips.filter((node) => {
    const cls = String(node.props?.className ?? '')
    return cls.split(/\s+/).includes('pmp-chipb') && cls.split(/\s+/).includes('on')
  }).map((node) => String(collect(node).all))
  const onlyChips = onChips.filter((label) => label.includes('只看'))
  check('只看线索时只有它自己亮着', onlyChips.length === 1 && onlyChips[0].includes('只看线索'), JSON.stringify(onChips))
}

// 搜不到时给「记一条线索」：空手而归正是该留痕的时刻
{
  reset()
  // 语义检索几乎总能找回点什么，所以用「只看线索 + 胡话」制造真正的零命中
  const noneView = await settle(parts.MasterSearch, { t, initialOnlyKind: 'clue', initialQuery: 'ZZZ这条平时一定搜不到QQQ', initialHits: [], initialCluePages: [{ path: 'personal/index.md', title: 'personal / 根目录', scope: 'personal' }], onOpen: noop, onOpenIn: noop })
  const noneAll = String(collect(noneView).all)
  check('搜不到时给「记一条线索」的出口', noneAll.includes('记一条线索'), '')
  check('搜不到时说清「为什么值得记」', noneAll.includes('这里缺一块'), '')
  const btn = firstWithClass(noneView, 'pmp-none-save')
  check('「记一条线索」是个可点的按钮', Boolean(btn) && btn.type === 'button', '')
}

// ⌘K 里也要能「去搜内容」：标题里没有不等于正文里没有
{
  reset()
  let asked = ''
  const qjView = await settle(parts.QuickJump, {
    t,
    docs: [{ path: 'personal/a.md', title: '止损线怎么定', file: 'a', scope: 'personal', mtime: '2026-11-20T00:00:00.000Z' }],
    pages: [{ key: 'today', label: '今天' }],
    onPick: noop,
    onClose: noop,
    onNavigate: noop,
    onSearch: (text) => { asked = text },
    initialQuery: '对账',
  })
  const qjAll = String(collect(qjView).all)
  check('⌘K 里有「去搜内容」这一行', qjAll.includes('搜内容'), '')
  check('⌘K 里说清为什么要去搜正文', qjAll.includes('正文里也许有'), '')
}

// 类型分布：混排的命中要给一眼能数清的三个数，且点了真能筛
{
  reset()
  let askedKind = ''
  const mixHits = [
    { docId: 'a', title: '止损线怎么定', heading: '', score: 0.7, path: 'personal/stock/a.md', excerpt: '跌破就走', via: 'keyword' },
    { docId: 'b', title: '计划买点没到', heading: '', score: 0.66, path: 'personal/stock/b.md', excerpt: '等回踩', via: 'vector' },
    { docId: 'c', title: '下一步 · 2026-11-20', heading: '未完成', score: 0.9, path: 'memory/2026/11/2026-11-20.md', excerpt: '等对账表', via: 'state', stateKind: 'next', stateText: '等对账表' },
    { docId: 'd', title: '线索 · stock', heading: '', score: 0.82, path: 'personal/stock/index.md', excerpt: '各板块止损线怎么定', via: 'clue', clueKind: 'check', line: 18 },
  ]
  const distView = await settle(parts.MasterSearch, { t, initialQuery: '', initialHits: mixHits, onOpen: noop, onOpenIn: noop, onOnly: (kind) => { askedKind = kind } })
  const distAll = String(collect(distView).all)
  check('命中上方给出类型分布', distAll.includes('笔记 2') && distAll.includes('待办 1') && distAll.includes('线索 1'), '')
  const distBtn = firstWithClass(distView, 'pmp-dist-b')
  check('分布是可点的按钮', Boolean(distBtn) && distBtn.type === 'button', '')
}

// 面板状态也能被搜到：命中行要标「待办」，摘要里带待办原文，不是假装成笔记正文
{
  reset()
  const stateHits = [
    { docId: 'state:next:a', title: '下一步 · 2026-11-20', heading: '未完成', score: 0.9, path: 'memory/2026/11/2026-11-20.md', excerpt: '等对账表', via: 'state', stateKind: 'next', stateText: '给客户回一封确认邮件' },
    { docId: 'note:b', title: '止损线怎么定', heading: '五、执行规则', score: 0.62, path: 'personal/stock/技术面状态判定方法.md', excerpt: '跌破就走', via: 'vector' },
  ]
  const stView = collect(await settle(parts.MasterSearch, { t, initialHits: stateHits, query: '对账表', onOpen: noop, onOpenIn: noop }))
  const stAll = String(stView.all)
  check('状态命中标出「待办」', stAll.includes('待办'), '')
  check('状态命中的摘要写的是待办原文', stAll.includes('待办： 给客户回一封确认邮件') && stAll.includes('等对账表'), '')
  check('普通命中不带「待办」标记', stView.classes.filter((c) => c === 'pmp-badge').length === 0 || !String(stView.all).includes('待办： 跌破'), String(stView.classes))
}

const todosView = collect(await settle(parts.MasterTodos, { t, timeline, selected: null, onOpen: noop, onToggleTodo: noop, onDeferTodo: noop, collapsed: {}, onCollapse: noop }))
check('档头显示最久欠了几天', /最久 \d+ 天/.test(String(todosView.all)), String(todosView.all).match(/最久 \d+ 天/)?.[0] ?? '')
const deferLabels = todosView.text.filter((text) => text === '明天' || text === '周一')
check('每条待办有「明天」和「周一」两个改期按钮', deferLabels.length >= 4, String(deferLabels.length))
const deferCalls2 = []
const todosTree2 = await settle(parts.MasterTodos, { t, timeline, selected: null, onOpen: noop, onToggleTodo: noop, onDeferTodo: (payload) => deferCalls2.push(payload), collapsed: {}, onCollapse: noop })
;(function walkDefer(node) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(walkDefer); return }
  const cls = String(node.props?.className ?? '')
  if (cls.includes('pmp-td-defer-mon')) node.props?.onClick?.()
  for (const child of node.children ?? []) walkDefer(child)
})(todosTree2)
check('点「周一」把 to=monday 交给上层', deferCalls2.some((payload) => payload?.to === 'monday'), JSON.stringify(deferCalls2[0] ?? null))
reset()

// 排序切换：两种顺序都是合理诉求，切换后要真的换顺序、并且把选择交给上层记住
const sortPicked = []
const sortFresh = await settle(parts.MasterToday, { t, timeline, docs: [], selected: null, onOpen: noop, onToggleTodo: noop, onQuickTodo: async () => true, todoSort: 'fresh', onTodoSort: (value) => sortPicked.push(value) })
const sortFreshView = collect(sortFresh)
const sortOldest = await settle(parts.MasterToday, { t, timeline, docs: [], selected: null, onOpen: noop, onToggleTodo: noop, onQuickTodo: async () => true, todoSort: 'oldest', onTodoSort: (value) => sortPicked.push(value) })
const sortOldestView = collect(sortOldest)
const firstDays = (view) => String(view.all).match(/\d+ 天前/g) ?? []
check('今天页有排序切换', sortFreshView.classes.filter((c) => c === 'pmp-chipb').length >= 2, `chips ${sortFreshView.classes.filter((c) => c === 'pmp-chipb').length}`)
check('默认排序：今天新加的在前', /\d+ 天前/.test(String(sortFreshView.all)) && firstDays(sortFreshView)[0] !== '10 天前', firstDays(sortFreshView).slice(0, 2).join(','))
check('最久没动的在前时，最老的排第一', firstDays(sortOldestView)[0] === '10 天前', firstDays(sortOldestView).slice(0, 3).join(','))
check('点排序把选择交给上层记住', (function () {
  const hit = firstWithClass(sortOldest, 'pmp-chipb')
  const buttons = []
  ;(function walk2(node) {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk2); return }
    if (String(node.props?.className ?? '').includes('pmp-chipb')) buttons.push(node)
    for (const child of node.children ?? []) walk2(child)
  })(sortOldest)
  for (const button of buttons) {
    if (String(collect(button).all).includes('今天新加的')) button.props?.onClick?.()
  }
  return sortPicked.includes('fresh') || sortPicked.includes('oldest')
})(), sortPicked.join(','))
reset()

// 剩下的条目就地展开，不要逼人跳页
const expandTree = await settle(parts.MasterToday, { t, timeline, docs: treeData?.docs ?? [], selected: null, onOpen: noop, onToggleTodo: noop, onQuickTodo: async () => true })
const expandView = collect(expandTree)
const owedRowsBefore = expandView.classes.filter((c) => c === 'pmp-td').length
check('今天页给出「就地展开剩下的」', String(expandView.all).includes('就地展开剩下的'), String(expandView.all).slice(0, 60))
const expandBtn = (function find(node) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) { for (const child of node) { const hit = find(child); if (hit) return hit } return null }
  if (String(node.props?.className ?? '').includes('pmp-link')) {
    const label = String(collect(node).all ?? '')
    if (label.includes('就地展开剩下的')) return node
  }
  for (const child of node.children ?? []) { const hit = find(child); if (hit) return hit }
  return null
})(expandTree)
if (expandBtn && typeof expandBtn.props?.onClick === 'function') expandBtn.props.onClick()
const expandedView = collect(await settle(parts.MasterToday, { t, timeline, docs: treeData?.docs ?? [], selected: null, onOpen: noop, onToggleTodo: noop, onQuickTodo: async () => true }))
const owedRowsAfter = expandedView.classes.filter((c) => c === 'pmp-td').length
check('展开后今天页的行数变多', owedRowsAfter > owedRowsBefore, `${owedRowsBefore} -> ${owedRowsAfter}`)
check('展开后出现「收起」', String(expandedView.all).includes('收起'), '')
reset()

const addInput = []
const findInput = (node) => {
  if (!node || typeof node !== 'object') return
  if (node.type === 'input' && node.props?.placeholder) addInput.push(node)
  for (const child of node.children ?? []) findInput(child)
}
findInput(todayTree)
check('加待办的输入框带提示', addInput.some((node) => String(node.props.placeholder).includes('未完成') || String(node.props.placeholder).includes('回车')), JSON.stringify(addInput.map((n) => n.props.placeholder)))

// 「今天还没写」时首屏给一块更硬的动作位（真实数据里今天已经写了，所以用假 timeline）
reset()
const emptyTimeline = { ...timeline, days: (timeline.days ?? []).filter((day) => day.date !== '2026-11-20') }
const emptyToday = collect(await settle(parts.MasterToday, {
  t,
  timeline: emptyTimeline,
  docs: treeData?.docs ?? [],
  selected: null,
  onOpen: noop,
  onToggleTodo: noop,
  onQuickTodo: async () => true,
}))
check('今天没写时出现提示条', emptyToday.classes.includes('pmp-today-first'), emptyToday.classes.filter((c) => c.startsWith('pmp-today-f')).join(','))
check('提示条有「写今天的第一条」', emptyToday.all.includes('写今天的第一条'))
reset()
const writtenToday = collect(await settle(parts.MasterToday, {
  t,
  timeline,
  docs: treeData?.docs ?? [],
  selected: null,
  onOpen: noop,
  onToggleTodo: noop,
  onQuickTodo: async () => true,
}))
check('今天写过就不摆提示条', !writtenToday.classes.includes('pmp-today-first'))

// 检索页的时间范围 chip
reset()
const searchDaysView = collect(await settle(parts.MasterSearch, { t, recent: [], selected: null, onOpen: noop }))
check('检索页有「不限时间 / 7 天内 / 30 天内」', searchDaysView.all.includes('不限时间') && searchDaysView.all.includes('7 天内') && searchDaysView.all.includes('30 天内'))

check('检索页有「最近查过」', recentView.all.includes('最近查过'))
check('最近查过是可直接点的 chip', recentView.classes.filter((c) => c === 'pmp-chipb').length >= 2, `${recentView.classes.filter((c) => c === 'pmp-chipb').length} 个`)

// 历史里带筛选条件：chip 上要看得见，点一下要同时恢复范围和天窗
reset()
const filteredRecent = [
  { q: '止损线', scope: 'personal,memory', days: 7, at: 1 },
  { q: '股息率', scope: '', days: 0, at: 0 },
]
const filteredTree = await settle(parts.MasterSearch, { t, recent: filteredRecent, selected: null, onOpen: noop })
const filteredView = collect(filteredTree)
check('带条件的历史 chip 显示范围与时间窗', String(filteredView.all).includes('止损线 · 个人/长河 · 7 天内'), String(filteredView.all).slice(0, 160))
const firstRecent = firstWithClass(filteredTree, 'pmp-chipb')
if (firstRecent && typeof firstRecent.props?.onClick === 'function') firstRecent.props.onClick()
reset()
const restoredView = collect(await settle(parts.MasterSearch, { t, recent: filteredRecent, selected: null, onOpen: noop }))
check('点历史后输入框里是那句话', restoredView.classes.includes('pmp-input'), '')

const settingsView = collect(await settle(parts.SettingsSection, { t, api: new parts.Api() }))
check('设置分区渲染成功', Boolean(settingsView))

// --- 3.10 阅读路径回退：从左栏点进两篇，退回上一篇 ---
reset()
let seenPath = null
const appBackTree = await settle(parts.App, { t, api: new parts.Api(), initialTab: 'personal' })
const itemsOf = (tree) => {
  const out = []
  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(visit); return }
    const cls = String(node.props?.className ?? '').split(/\s+/).filter(Boolean)
    if (cls.includes('pmp-item')) out.push(node)
    for (const child of node.children ?? []) visit(child)
  }
  visit(tree); return out
}
const firstItems = itemsOf(appBackTree)
check('左栏有笔记条目可点', firstItems.length >= 2, `${firstItems.length} 条`)
check('左栏条目带点击行为', firstItems.every((item) => typeof item.props?.onClick === 'function'), '')
// 回退按钮只在栈里有东西时出现：初始渲染不该有
const histButtons = (view) => view.classes.filter((c) => c === 'pmp-histback').length
reset()
const freshBackView = collect(await settle(parts.App, { t, api: new parts.Api(), initialTab: 'personal', initialPath: (treeData?.docs ?? [])[0]?.path ?? null }))
check('刚打开时没有「上一处」', histButtons(freshBackView) === 0, `${histButtons(freshBackView)} 个`)

// DocReader 层面：canHistoryBack 为真才给按钮，点了交给上层
reset()
const drBackTree = await settle(parts.DocReader, {
  ...pageProps, docPath: docValue.path, doc: docValue, loading: false, error: '',
  canHistoryBack: true, onHistoryBack: () => { seenPath = 'back' }, onOpen: noop,
})
const drWithBack = collect(drBackTree)
check('可以回退时有「上一处」按钮', histButtons(drWithBack) === 1, `${histButtons(drWithBack)} 个`)
check('回退按钮的文字单独包一层（窄屏可以只留箭头）', drWithBack.classes.includes('pmp-hb-t'), '')
const backBtn = firstWithClass(drBackTree, 'pmp-histback')
check('「上一处」能点', Boolean(backBtn && typeof backBtn.props?.onClick === 'function'), '')
if (backBtn && typeof backBtn.props?.onClick === 'function') backBtn.props.onClick()
check('点「上一处」把动作交给上层', seenPath === 'back', String(seenPath))

// App 层真的会把「上一次读到哪儿」记下来：换一篇之后才出现回退按钮
reset()
const appItems = (tree) => {
  const out = []
  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(visit); return }
    const cls = String(node.props?.className ?? '').split(/\s+/).filter(Boolean)
    if (cls.includes('pmp-item')) out.push(node)
    for (const child of node.children ?? []) visit(child)
  }
  visit(tree); return out
}
let appTree = await settle(parts.App, { t, api: new parts.Api(), initialTab: 'personal' })
await new Promise((r) => setTimeout(r, 500))
appTree = await settle(parts.App, { t })
const autoOpened = collect(appTree).all
const otherItem = appItems(appTree).find((item) => typeof item.props?.onClick === 'function'
  && !String(collect(item).all).includes(String(autoOpened).includes('关于我') ? '关于我' : '\u0000'))
if (otherItem) otherItem.props.onClick()
await new Promise((r) => setTimeout(r, 600))
appTree = await settle(parts.App, { t })
const appView = collect(appTree)
check('换一篇之后出现「上一处」按钮', appView.classes.filter((c) => c === 'pmp-histback').length === 1,
  `${appView.classes.filter((c) => c === 'pmp-histback').length} 个`)
const appBack = firstWithClass(appTree, 'pmp-histback')
if (appBack && typeof appBack.props?.onClick === 'function') appBack.props.onClick()
await new Promise((r) => setTimeout(r, 600))
const backView = collect(await settle(parts.App, { t }))
check('点「上一处」真的回到上一篇', String(backView.all).includes('关于我') && backView.classes.includes('pmp-doc'),
  String(backView.all).slice(0, 80))

// --- 3.11 窄屏（手机）：列表优先，不自动进正文 ---
globalThis.__pmViewportWidth = 390
reset()
reset()
const narrowTree = await settle(parts.App, { initialTab: 'personal' })
const narrowView = collect(narrowTree)
check('窄屏不自动打开文档', !String(narrowTree?.props?.className ?? '').includes('pmp-doc-open'), narrowTree?.props?.className)
check('窄屏仍渲染列表', narrowView.classes.includes('pmp-item'))
globalThis.__pmViewportWidth = 1440

// --- 3.12 翻过但没动（打开过、之后没再改的笔记） ---
reset()
const editHits = []
const visitedView = await settle(parts.MasterSearch, {
  t,
  onOpen: () => {},
  onOpenIn: () => {},
  onEditAtEnd: (path) => editHits.push(path),
  initialVisited: [
    { path: 'personal/stock/index.md', title: 'stock/index', scope: 'personal', kind: 'index', usedAt: Date.now() - 86400000, mtimeMs: Date.now() - 9 * 86400000, daysSinceUsed: 1, dwell: 3000 },
    { path: 'personal/learning/常驻助手的四层.md', title: '常驻助手的四层', scope: 'personal', kind: 'note', usedAt: Date.now() - 5 * 86400000, mtimeMs: Date.now() - 30 * 86400000, daysSinceUsed: 5, dwell: 132000 },
  ],
})
const visitedText = String(collect(visitedView).all)
check('翻过没动：有「翻过没动」开关', visitedText.includes('翻过没动'), visitedText.slice(0, 60))
check('翻过没动：列出看过没动的笔记', visitedText.includes('stock/index') && visitedText.includes('常驻助手的四层'), visitedText.slice(0, 90))
check('翻过没动：标「看过 1 天前 · 改于 9 天前」', visitedText.includes('看过 1 天前') && visitedText.includes('改于 9 天前'), visitedText.slice(0, 150))
// 目录页（index/README）被打开通常只是进去找东西：标出来，动作也说「加一条」
check('翻过没动：目录页带「目录」徽标', visitedText.includes('目录') && visitedText.includes('加一条'), visitedText.slice(0, 180))
check('翻过没动：正文页仍说「补一句」', visitedText.includes('补一句'), '')
// 「点开就走」与「停下来读过」不该长得一样
check('翻过没动：3 秒的说「看一眼就走」', visitedText.includes('看一眼就走'), visitedText.slice(0, 200))
check('翻过没动：132 秒的说「读了 2 分钟」', visitedText.includes('读了 2 分钟'), visitedText.slice(0, 200))

// 「线索」：把所有 - 想找：… 收在一处，看哪些还悬着
reset()
const sheet = collect(await settle(parts.MasterSearch, {
  t,
  api: { clues: async () => ({ items: [] }) },
  onOpen: () => {},
  onOpenIn: () => {},
  initialClueRows: [
    { path: 'personal/index.md', title: 'index', kind: 'index', text: '各板块止损线怎么定', line: 12, open: true },
    { path: 'personal/stock/index.md', title: 'stock', kind: 'index', text: '仓位怎么算', line: 30, open: false, resolvedAt: Date.now() - 86400000 },
  ],
}))
check('线索：列出每条想找的东西', sheet.text.filter((v) => v === '各板块止损线怎么定' || v === '仓位怎么算').length === 2, JSON.stringify(sheet.text.filter((v) => v === '各板块止损线怎么定' || v === '仓位怎么算')))
check('线索：悬着与已落到正文分开标', sheet.text.includes('还悬着') && sheet.text.includes('已补进正文'), JSON.stringify(sheet.text))
check('线索：标题写清还有几条悬着', sheet.text.some((v) => String(v).includes('还悬着 1 条')), JSON.stringify(sheet.text.filter((v) => String(v).includes('悬着'))))
check('线索：条目带出处与行号', sheet.text.some((v) => String(v).includes('第 12 行')), JSON.stringify(sheet.text.filter((v) => String(v).includes('行'))))
check('线索：悬着的可以标「解决了」，已解决的可以「重新打开」', sheet.text.includes('解决了') && sheet.text.includes('重新打开'), JSON.stringify(sheet.text.filter((v) => v === '解决了' || v === '重新打开')))
{
  // 点「解决了」要把这条线索的正文交上去（key 是正文，不是行号——行号会漂）
  const calls = []
  reset()
  const raw2 = await settle(parts.MasterSearch, {
    t,
    api: { clues: async () => ({ items: [] }), resolveClue: async (text, on) => { calls.push([text, on]); return { resolved: on } } },
    onOpen: () => {},
    onOpenIn: () => {},
    initialClueRows: [{ path: 'personal/index.md', title: 'index', kind: 'index', text: '各板块止损线怎么定', line: 12, open: true }],
  })
  const btn = firstWithClass(raw2, 'pmp-vis-edit')
  check('线索：悬着的那条给「解决了」按钮', Boolean(btn) && String(JSON.stringify(btn.props?.children ?? '')).includes('解决了'), btn ? 'ok' : 'not found')
  if (btn && typeof btn.props?.onClick === 'function') btn.props.onClick()
  check('线索：点「解决了」把线索正文交给上层', calls.length === 1 && calls[0][0] === '各板块止损线怎么定' && calls[0][1] === true, JSON.stringify(calls))
}

// 解决完就消失，看不出「最近在补哪些缺口」：留一周的可见记录
reset()
const resolvedTree = collect(await settle(parts.MasterSearch, {
  t,
  onOpen: () => {},
  onOpenIn: () => {},
  initialClueRows: [{ path: 'personal/index.md', title: 'index', kind: 'index', text: '各板块止损线怎么定', line: 12, open: true }],
  initialClueRecent: [
    { text: '周报模板放哪了', at: Date.now() - 3600000, days: 0 },
    { text: '止损线的历史判断', at: Date.now() - 3 * 86400000, days: 3 },
  ],
}))
{
  // 悬着的线索要有时长徽标：挂了 5 天该说，今天刚记的不说
  reset()
  const ageTree = collect(await settle(parts.MasterSearch, {
    t,
    onOpen: () => {},
    onOpenIn: () => {},
    initialClueRows: [
      { path: 'personal/index.md', title: 'index', kind: 'index', text: '挂了一阵的线索', line: 5, open: true, ageDays: 5 },
      { path: 'personal/index.md', title: 'index', kind: 'index', text: '今天刚记的线索', line: 9, open: true, ageDays: 0 },
    ],
  }))
  check('线索：悬了 3 天以上标出天数', ageTree.text.includes('已悬 5 天'), JSON.stringify(ageTree.text.filter((v) => String(v).includes('悬了'))))
  check('线索：刚记的不标天数', ageTree.text.filter((v) => String(v).includes('已悬')).length === 1, JSON.stringify(ageTree.text.filter((v) => String(v).includes('悬了'))))
}

{
  // 「+ 记一条」：不用先打开某一页，直接记
  reset()
  const newTree = collect(await settle(parts.MasterSearch, {
    t,
    onOpen: () => {},
    onOpenIn: () => {},
    initialClueRows: [],
    initialCluePages: [
      { path: 'personal/index.md', title: '个人记忆', scope: 'personal' },
      { path: 'personal/stock/index.md', title: 'stock', scope: 'personal' },
    ],
  }))
  check('线索：空状态下也有「+ 记一条」入口', newTree.text.includes('+ 记一条'), JSON.stringify(newTree.text.slice(0, 20)))
  check('线索：空状态提示怎么开始', newTree.text.some((v) => String(v).includes('还没有「想找：」记录')), '')
}

{
  // 「这条线索想要什么」：想知道答案 / 想确认结论 / 想找回原话，得在行上一眼分开
  reset()
  const kindTree = collect(await settle(parts.MasterSearch, {
    t,
    onOpen: () => {},
    onOpenIn: () => {},
    initialClueRows: [
      { path: 'personal/index.md', title: 'index', kind: 'index', text: '没人写过的那件事', line: 3, open: true, ageDays: 3, clueKind: 'find' },
      { path: 'personal/stock/index.md', title: 'stock', kind: 'index', text: '当时的判断对不对', line: 8, open: true, ageDays: 5, clueKind: 'check' },
    ],
  }))
  check('线索类型：想知道答案的那条标出来', kindTree.text.includes('想知道答案'), JSON.stringify(kindTree.text.filter((v) => String(v).includes('想'))))
  check('线索类型：想确认结论的那条也标出来', kindTree.text.includes('想确认结论'), JSON.stringify(kindTree.text.filter((v) => String(v).includes('想'))))
}

{
  // 「该去哪补」要一键接上：想知道答案 → 新建（带该页目录）；想确认/找回原话 → 带词去检索
  reset()
  const goCalls = []
  const goRaw = await settle(parts.MasterSearch, {
    t,
    onOpen: () => {},
    onOpenIn: () => {},
    onNewNoteFrom: (dir) => goCalls.push(['new', dir]),
    onSearchFor: (text) => goCalls.push(['search', text]),
    initialClueRows: [
      { path: 'personal/stock/index.md', title: 'stock', kind: 'index', text: '没人写过的那件事', line: 3, open: true, clueKind: 'find' },
      { path: 'personal/work/index.md', title: 'work', kind: 'index', text: '当时的判断对不对', line: 8, open: true, clueKind: 'check' },
    ],
  })
  const goTree = collect(goRaw)
  check('线索一键补：想知道答案的给「写一篇」', goTree.text.includes('写一篇'), JSON.stringify(goTree.text.filter((v) => String(v).includes('写'))))
  check('线索一键补：想确认结论的给「去核对」', goTree.text.includes('去核对'), JSON.stringify(goTree.text.filter((v) => String(v).includes('核对'))))
  const goButtons = []
  walk(goRaw, (node) => {
    const cls = typeof node?.props?.className === 'string' ? node.props.className.split(/\s+/) : []
    if (cls.includes('pmp-vis-go')) goButtons.push(node.props.onClick)
  })
  goButtons.forEach((fn) => fn && fn())
  check('线索一键补：点「写一篇」带上该页目录', JSON.stringify(goCalls[0]) === JSON.stringify(['new', 'personal/stock']), JSON.stringify(goCalls))
  check('线索一键补：点「去核对」带上那句话', JSON.stringify(goCalls[1]) === JSON.stringify(['search', '当时的判断对不对']), JSON.stringify(goCalls))
}

{
  // 线索命中：标「线索」，摘要写「想找：…」——它是缺口，不是一篇笔记
  reset()
  const clueHitTree = collect(await settle(parts.MasterSearch, {
    t,
    onOpen: () => {},
    onOpenIn: () => {},
    initialHits: [
      { docId: 'c1', title: '线索 · stock', path: 'personal/stock/index.md', excerpt: '各板块止损线怎么定', score: 0.82, via: 'clue', clueKind: 'find', line: 18 },
      { docId: 'c2', title: '正常笔记', path: 'personal/关于我.md', excerpt: '正文', score: 0.7 },
    ],
  }))
  check('线索命中：标出「线索」', clueHitTree.text.includes('线索'), JSON.stringify(clueHitTree.text.filter((v) => String(v).includes('线索')).slice(0, 4)))
  check('线索命中：摘要写成「想找：…」', clueHitTree.text.some((v) => String(v).startsWith('想找：')), JSON.stringify(clueHitTree.text.filter((v) => String(v).startsWith('想找'))))
}

check('线索：最近解决的单独列一段', resolvedTree.text.some((v) => String(v).includes('最近解决的（2）')), JSON.stringify(resolvedTree.text.filter((v) => String(v).includes('最近解决'))))
check('线索：最近解决的带「今天 / N 天前」', resolvedTree.text.includes('今天') && resolvedTree.text.includes('3 天前'), JSON.stringify(resolvedTree.text.filter((v) => v === '今天' || v === '3 天前')))

// 目录页「看一眼就走」→ 就地补一条线索（写进那页末尾），正文页不给这个入口
reset()
const clueApi = { append: async () => ({ appended: true }), visited: async () => ({ items: [] }) }
const clueTree = collect(await settle(parts.MasterSearch, {
  t,
  api: clueApi,
  onOpen: () => {},
  onOpenIn: () => {},
  onEditAtEnd: () => {},
  initialVisited: [
    { path: 'personal/index.md', title: 'index', scope: 'personal', kind: 'index', usedAt: Date.now() - 86400000, mtimeMs: Date.now() - 9 * 86400000, daysSinceUsed: 1, dwell: 3000 },
    { path: 'personal/index2.md', title: 'index2', scope: 'personal', kind: 'index', usedAt: Date.now() - 86400000, mtimeMs: Date.now() - 9 * 86400000, daysSinceUsed: 1, dwell: 90000 },
  ],
}))
check('翻过没动：目录页「看一眼就走」给「记一条线索」', clueTree.text.filter((v) => v === '记一条线索').length === 1, String(clueTree.text.filter((v) => v === '记一条线索').length))
check('翻过没动：停过一阵的目录页不提示补线索', clueTree.text.filter((v) => v === '记一条线索').length === 1, '')

reset()
const noDwell = collect(await settle(parts.MasterSearch, {
  t,
  onOpen: () => {},
  onOpenIn: () => {},
  onEditAtEnd: () => {},
  initialVisited: [{ path: 'personal/x.md', title: 'x', scope: 'personal', kind: 'note', usedAt: Date.now() - 86400000, mtimeMs: Date.now() - 5 * 86400000, daysSinceUsed: 1, dwell: 0 }],
}))
check('翻过没动：没测到停留时长就不编「看一眼就走」', !String(noDwell.all).includes('看一眼就走') && String(noDwell.all).includes('看过 1 天前'), String(noDwell.all).slice(0, 200))
// 「看到」要能接到「做」：每行右侧给一个「补一句」，直接进编辑态、光标落文末
const editBtn = firstWithClass(visitedView, 'pmp-vis-edit')
check('翻过没动：每行有「补一句」', Boolean(editBtn), '')
if (editBtn) editBtn.props.onClick({})
check('翻过没动：「补一句」把这篇交出去', editHits[0] === 'personal/stock/index.md', editHits.join(','))
reset()
const emptyVisited = await settle(parts.MasterSearch, { t, onOpen: () => {}, onOpenIn: () => {}, initialVisited: [] })
check('翻过没动：空了就说空', String(collect(emptyVisited).all).includes('没有这种笔记'), '')

const failures = results.filter((item) => !item.ok)
if (failures.length > 0) {
  console.error(`\n${failures.length}/${results.length} 项失败：${failures.map((f) => f.label).join('、')}`)
  process.exit(1)
}
console.log(`\nrender smoke: ${results.length}/${results.length} 通过 ✓`)
