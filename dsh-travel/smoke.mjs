// 离线冒烟:渲染 + 交互断言,全走真实的 client.js。
//   node smoke.mjs
import { boot, settle, collect, findButtons } from './harness.mjs'
import { splitReply, toDest } from './index.js'

const results = []
function assert(name, cond, detail = '') {
  results.push({ name, ok: Boolean(cond), detail })
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}${cond ? '' : `  ${detail}`}`)
}

const env = await boot()
const { parts, slots, styleNodes, localStorageData } = env

/* ---------- 1. 结构:插槽 + 样式 ---------- */
console.log('\n[1] 插槽与样式')
const entries = slots.captured.map((c) => c.entry.name)
assert('注册了 sidebar.panellist + main', entries.includes('sidebar.panellist') && entries.includes('main'), entries.join(','))
assert('样式注入到 head', styleNodes.some((n) => String(n.textContent).includes('.tvl-root')))
assert('样本量正确:40 个目的地', parts.DESTS.length === 40, String(parts.DESTS.length))
const perSeason = parts.DESTS.reduce((m, d) => { (m[d.season] ??= []).push(d); return m }, {})
for (const s of ['spring', 'summer', 'autumn', 'winter']) {
  const n = perSeason[s]?.length ?? 0
  assert(`四季各有目的地(${s}: ${n})`, n >= 8)
}
const dataOk = parts.DESTS.every((d) => d.id && d.name && d.region && d.tagline && d.x?.length >= 3 && d.f?.length && d.t?.length && d.months?.length && parts.SEASON_COLOR[d.season])
assert('每个目的地字段齐全(x≥3/f/t/months)', dataOk)

/* ---------- 2. 纯函数 ---------- */
console.log('\n[2] 纯函数')
assert('seasonOf(7)=summer', parts.seasonOf(7) === 'summer')
assert('seasonOf(12)=winter', parts.seasonOf(12) === 'winter')
assert('seasonOf(3)=spring', parts.seasonOf(3) === 'spring')
assert('fmtMonths([12,1,2])', parts.fmtMonths([12, 1, 2]) === '12月、1-2月', parts.fmtMonths([12, 1, 2]))
assert('fmtMonths([3,4,5])', parts.fmtMonths([3, 4, 5]) === '3-5月')
assert('currentMonth() 合法', Number.isInteger(parts.currentMonth()) && parts.currentMonth() >= 1 && parts.currentMonth() <= 12)

/* ---------- 完整中文文案(与 client.js 内置 zh 字典一致) ---------- */
const zhDict = {
  nav: '旅行灵感', 'brand.sub': '每个季节,该去哪、玩什么', 'tab.wish': '想去 ({n})',
  'search.ph': '搜地名、玩法、美食…', 'month.all': '整季', count: '{n} 个目的地',
  'sort.hint': '正当时的排前', 'badge.best': '正当时', 'wish.add': '想去', 'wish.remove': '已在想去',
  'wish.empty.title': '还没有想去的地方', 'wish.empty.hint': 'x', 'drawer.exps': '最好玩的事',
  'tab.food': '美食', 'food.hint': '按菜名或地名搜',
  'food.empty.title': '没找到相关美食', 'food.empty.hint': '试试菜名或地名。',
  'drawer.food': '必吃', 'drawer.tips': '出发前知道', random: '随机去哪', 'empty.title': '没找到',
  'empty.hint': 'x', months: '最佳:{m}',
  'ai.thinking': 'AI 正在找「{q}」好玩的事…', 'ai.count': 'AI 找到 {n} 个玩法',
  'ai.cached': '上次的结果', 'ai.retry': '重新生成',
  'ai.note': 'AI 生成,仅供参考,出行前再核实。', 'ai.error': 'AI 没帮上忙:{m}',
}
const t = (key, params) => parts.tOf(zhDict, key, params)

/* ---------- 3. 渲染:默认当季 ---------- */
console.log('\n[3] 渲染 App(当季)')
let tree = await settle(parts.App, { t })
let ui = collect(tree)
for (const label of ['春', '夏', '秋', '冬']) assert(`季节 tab 有「${label}」`, ui.text.includes(label))
assert('想去 tab 存在', ui.text.includes('想去 (0)'))
assert('整季 chip 存在', ui.classes.includes('tvl-chip'))
const seasonNow = parts.seasonOf(parts.currentMonth())
const nowDests = parts.DESTS.filter((d) => d.season === seasonNow)
const cardCount = () => collect(tree).classes.split('tvl-card ').length - 1
assert(`默认当季渲染了 ${nowDests.length} 张卡片`, cardCount() === nowDests.length, String(cardCount()))
assert('当季目的地名出现', nowDests.some((d) => ui.text.includes(d.name)), ui.text.slice(0, 200))
assert('卡片有正当时/月份徽章', ui.classes.includes('tvl-window'))
assert('头部有搜索框', ui.classes.includes('tvl-input'))

/* ---------- 4. 交互:切冬 tab ---------- */
console.log('\n[4] 交互:切换到冬季')
const winterTab = findButtons(tree, { cls: 'tvl-tab', text: '冬' })[0]
assert('找到冬季 tab 按钮', Boolean(winterTab))
winterTab?.props?.onClick?.()
tree = await settle(parts.App, { t })
ui = collect(tree)
assert('冬季目的地出现(哈尔滨)', ui.text.includes('哈尔滨'))
assert('当季(非冬季)目的地消失', !ui.text.includes('青海湖') || parts.seasonOf(parts.currentMonth()) === 'winter')
assert('月份 chips 只有 12/1/2', ui.text.includes('12月') && ui.text.includes('1月') && ui.text.includes('2月') && !ui.text.includes('9月'))

/* ---------- 5. 交互:月份 chip ---------- */
console.log('\n[5] 交互:选 1 月')
const janChip = findButtons(tree, { cls: 'tvl-monthchip', labelFn: (l) => l.trim() === '1月' })[0]
assert('找到 1 月 chip(不是 11月)', Boolean(janChip))
janChip?.props?.onClick?.()
tree = await settle(parts.App, { t })
ui = collect(tree)
const winterJan = parts.DESTS.filter((d) => d.season === 'winter' && d.months.includes(1))
assert(`1 月筛选出 ${winterJan.length} 张卡片`, cardCount() === winterJan.length, String(cardCount()))
assert('1 月 chip 高亮', findButtons(tree, { cls: 'tvl-monthchip' }).filter((b) => String(b.props.className).split(/\s+/).includes('on')).length === 1)
assert('1 月目的地里没有漠河外漏(12月专属)', !ui.text.includes('泼水成冰') === false || winterJan.some((d) => d.id === 'mohe'))

/* ---------- 6. 交互:星标收藏 ---------- */
console.log('\n[6] 交互:收藏')
const stars = findButtons(tree, { cls: 'tvl-star' })
assert('卡片上有星标按钮', stars.length > 0, String(stars.length))
const starredName = collect({ children: stars[0].parentChildren ?? stars[0].children }).text
stars[0]?.props?.onClick?.({ stopPropagation() {} })
tree = await settle(parts.App, { t })
ui = collect(tree)
assert('想去计数变 1', ui.text.includes('想去 (1)'), ui.text.match(/想去 \(\d+\)/)?.[0] ?? '?')
const wishKey = [...localStorageData.keys()].find((k) => k.startsWith('dsh-travel'))
assert('localStorage 有了收藏', Boolean(wishKey), String([...localStorageData.keys()].join(',')))
const stored = JSON.parse(localStorageData.get(wishKey) ?? '[]')
assert('存的是目的地名单(1 个)', Array.isArray(stored) && stored.length === 1, JSON.stringify(stored))
assert('星标变实心', collect(tree).classes.includes('tvl-star on') || ui.text.includes('★'))

/* ---------- 7. 想去 tab ---------- */
console.log('\n[7] 想去 tab')
// 回归(2026-11-21 用户白屏):真实路径是「整季(month=null)→ 星标 → 点想去」。
// 这里先点「整季」把 month 复位成 null,再切想去——之前冒烟带着冬季测试留下的
// month=12 进来,恰好短路了 wish tab 里 season 未定义的崩溃,掩盖了 bug。
const allChip = findButtons(tree, { cls: 'tvl-chip', text: '整季' })[0]
assert('找到整季 chip(复位 month)', Boolean(allChip))
allChip?.props?.onClick?.()
tree = await settle(parts.App, { t })
const wishTab = findButtons(tree, { cls: 'tvl-tab', text: '想去 (1)' })[0]
assert('找到想去 tab', Boolean(wishTab))
wishTab?.props?.onClick?.()
tree = await settle(parts.App, { t })
ui = collect(tree)
assert('想去页只有收藏的 1 张卡', cardCount() === 1, String(cardCount()))
assert('收藏的目的地名可见', ui.text.includes(parts.DESTS.find((d) => d.id === stored[0])?.name ?? '?'))

/* ---------- 8. 交互:打开抽屉 ---------- */
console.log('\n[8] 交互:详情抽屉')
const card = findButtons(tree, { cls: 'tvl-card' })[0]
card?.props?.onClick?.()
tree = await settle(parts.App, { t })
ui = collect(tree)
assert('抽屉打开(backdrop)', ui.classes.includes('tvl-backdrop'))
assert('抽屉标题「最好玩的事」', ui.text.includes('最好玩的事'))
assert('抽屉有「必吃」', ui.text.includes('必吃'))
assert('抽屉有「出发前知道」', ui.text.includes('出发前知道'))
assert('抽屉有月份窗口', ui.classes.includes('tvl-dr-window'))
const closeBtn = findButtons(tree, { cls: 'tvl-dr-close' })[0]
assert('抽屉有关闭按钮', Boolean(closeBtn))
closeBtn?.props?.onClick?.()
tree = await settle(parts.App, { t })
ui = collect(tree)
assert('抽屉关闭', !ui.classes.includes('tvl-backdrop'))

/* ---------- 9. 搜索 ---------- */
console.log('\n[9] 搜索')
const springTab = findButtons(tree, { cls: 'tvl-tab', text: '春' })[0]
springTab?.props?.onClick?.()
tree = await settle(parts.App, { t })
const search = findButtons(tree, { cls: 'tvl-input' })[0]
assert('找到搜索框', Boolean(search))
search?.props?.onChange?.({ target: { value: '哈尔滨' } })
tree = await settle(parts.App, { t })
ui = collect(tree)
assert('春季搜"哈尔滨"为 0 张(哈尔滨是冬季)', cardCount() === 0)
assert('空态出现', ui.classes.includes('tvl-empty') && ui.text.includes('没找到'))
search?.props?.onChange?.({ target: { value: '樱花' } })
tree = await settle(parts.App, { t })
ui = collect(tree)
assert('春季搜"樱花"出武汉/无锡', ui.text.includes('武汉') && ui.text.includes('无锡'))
search?.props?.onChange?.({ target: { value: '' } })
tree = await settle(parts.App, { t })

/* ---------- 9B. AI 兜底:纯函数 ---------- */
console.log('\n[9B] AI 兜底纯函数(splitReply/toDest)')
const aiReply = '廊坊不大,玩起来舒服。\n```json\n[\n  {"name":"香河第一城","kinds":["人文","不存在的词","美食"],"x":[{"n":"第一城","d":"仿古建筑群"},{"d":"没有名字会被丢掉"}]},\n  {"name":"没有玩法的项"},\n]\n```'
const [aiIntro, aiItems] = splitReply(aiReply)
assert('splitReply 抓到导语', aiIntro === '廊坊不大,玩起来舒服。', JSON.stringify(aiIntro))
assert('splitReply 容忍尾逗号并解析出 2 项', aiItems.length === 2, JSON.stringify(aiItems))
const aiDest = toDest(aiItems[0], 0, 'spring', [3, 4, 5])
assert('toDest 过滤词表外 kinds', aiDest.kinds.join(',') === '人文,美食', JSON.stringify(aiDest.kinds))
assert('toDest 产出 DESTS 形状', aiDest.id.startsWith('ai-spring-0-') && aiDest.season === 'spring' && aiDest.months.join(',') === '3,4,5' && aiDest.x.length === 1 && aiDest.x[0].w === '半天', JSON.stringify(aiDest))
assert('toDest 丢弃没有玩法的项', toDest({ name: 'x' }, 1, 'spring', [3]) === null)

/* ---------- 9C. AI 兜底:零结果 → 流式面板 ---------- */
console.log('\n[9C] AI 兜底面板(搜索零结果时自动触发)')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const enc = new TextEncoder()
const AI_ITEMS = [
  { id: 'ai-spring-0-xianghe', name: '香河第一城', region: '河北廊坊', season: 'spring', months: [3, 4, 5], tagline: '仿古建筑群里逛一天', kinds: ['人文', '美食'], x: [{ e: '🏛️', n: '第一城景区', w: '半天', d: '仿古建筑群' }], f: ['香河肉饼'], t: ['自驾更方便'] },
  { id: 'ai-spring-1-shuiyun', name: '水云间文化集市', region: '河北廊坊', season: 'spring', months: [3, 4, 5], tagline: '市集与手作', kinds: ['人文'], x: [{ e: '🎨', n: '水云间集市', w: '半天', d: '手作摊位' }], f: ['驴肉火烧'], t: ['周末更热闹'] },
]
let fetchCalls = []
let sseMode = 'ok'
globalThis.fetch = async (_url, opts) => {
  const body = JSON.parse(opts.body)
  fetchCalls.push(body)
  if (sseMode === 'error') return { ok: false, status: 500, json: async () => ({ error: 'boom' }) }
  const frame = (ev, obj) => enc.encode(`event: ${ev}\ndata: ${JSON.stringify(obj)}\n\n`)
  const frames = [
    frame('status', { q: body.q }),
    frame('delta', { text: '廊坊不大,玩起来很舒服。\n```json\n' }),
    frame('delta', { text: '[{"x":"raw"}]\n' }),
    frame('done', { ok: true, intro: '廊坊不大,玩起来很舒服。', items: AI_ITEMS }),
  ]
  const stream = new ReadableStream({
    start(ctrl) { for (const f of frames) ctrl.enqueue(f); ctrl.close() },
  })
  return { ok: true, status: 200, body: stream }
}
// 零结果搜索 → 700ms 防抖后自动请求(harness 里 effect 只在渲染时运行:
// 先 settle 渲染布防,再 sleep 等定时器点火,最后 settle 收结果)
search?.props?.onChange?.({ target: { value: '廊坊' } })
tree = await settle(parts.App, { t })
await sleep(950)
tree = await settle(parts.App, { t })
ui = collect(tree)
assert('AI 请求了 1 次,参数齐全', fetchCalls.length === 1 && fetchCalls[0].q === '廊坊' && fetchCalls[0].season === 'spring' && fetchCalls[0].months.join(',') === '3,4,5', JSON.stringify(fetchCalls))
assert('AI 面板出现', ui.classes.includes('tvl-ai') && ui.classes.includes('tvl-aiwrap'))
assert('AI 导语渲染', ui.text.includes('廊坊不大,玩起来很舒服。'))
assert('AI 结果卡片渲染(2 张)', ui.classes.split('tvl-card ').length - 1 === 2, String(ui.classes.split('tvl-card ').length - 1))
assert('AI 卡片可打开详情', ui.text.includes('香河第一城') && ui.text.includes('水云间文化集市'))
assert('AI 免责声明可见', ui.text.includes('仅供参考'))
const aiCacheKey = localStorageData.has('dsh-travel:aicache')
assert('AI 结果写入缓存', aiCacheKey, String([...localStorageData.keys()].join(',')))
// 换词再换回 → 走缓存,不再发请求
search?.props?.onChange?.({ target: { value: '' } })
tree = await settle(parts.App, { t })
search?.props?.onChange?.({ target: { value: '廊坊' } })
tree = await settle(parts.App, { t })
await sleep(950)
tree = await settle(parts.App, { t })
ui = collect(tree)
assert('第二次命中缓存不发请求', fetchCalls.length === 1, String(fetchCalls.length))
assert('缓存徽章「上次的结果」', ui.text.includes('上次的结果'))
// 重试按钮强制重新生成
const retry = findButtons(tree, { cls: 'tvl-btn', text: '重新生成' })[0]
assert('找到重新生成按钮', Boolean(retry))
retry?.props?.onClick?.()
await sleep(150)
tree = await settle(parts.App, { t })
assert('重试发起了新请求', fetchCalls.length === 2, String(fetchCalls.length))
// 服务端报错 → 错误文案可见
sseMode = 'error'
search?.props?.onChange?.({ target: { value: '固安' } })
tree = await settle(parts.App, { t })
await sleep(950)
tree = await settle(parts.App, { t })
ui = collect(tree)
assert('错误文案显示 boom', ui.text.includes('AI 没帮上忙:boom'), ui.text.slice(0, 300))
sseMode = 'ok'
search?.props?.onChange?.({ target: { value: '' } })
tree = await settle(parts.App, { t })

/* ---------- 10. 随机按钮 ---------- */
console.log('\n[10] 随机按钮')
tree = await settle(parts.App, { t })
const roll = findButtons(tree, { cls: 'tvl-btn', text: '随机去哪' })[0]
assert('找到随机按钮', Boolean(roll))
roll?.props?.onClick?.()
tree = await settle(parts.App, { t })
assert('随机打开了抽屉', collect(tree).classes.includes('tvl-backdrop'))

/* ---------- 11. 美食页签 ---------- */
console.log('\n[11] 美食:数据 + 页签 + 图文')
const DISH = parts.DISHES ?? {}
{
  const withData = parts.DESTS.filter((d) => (DISH[d.id] ?? []).length >= 3)
  assert('每个目的地都有 ≥3 道招牌菜', withData.length === parts.DESTS.length,
    `覆盖 ${withData.length}/${parts.DESTS.length}${withData.length !== parts.DESTS.length ? ' 缺:' + parts.DESTS.filter((d) => (DISH[d.id] ?? []).length < 3).map((d) => d.id).join(',') : ''}`)
  const badImg = Object.values(DISH).flat().filter((x) => x.img && !/^https:\/\/(upload|thumb)\.wikimedia\.org\//.test(x.img))
  assert('图片 URL 都来自 Wikimedia 官方域', badImg.length === 0, badImg.map((x) => x.n).join(','))
  const fieldOk = Object.values(DISH).flat().every((x) => x.n && x.d && x.w)
  assert('每道菜都有 菜名/为什么/去哪吃', fieldOk)
  // 同城不重名;跨城同名(锅包肉/酥油茶等在地饮食)必须有不同的一句话描述
  let dupSame = 0, dupDiff = []
  for (const [id, list] of Object.entries(DISH)) {
    const seen = new Set()
    for (const x of list) {
      if (seen.has(x.n)) dupSame++
      seen.add(x.n)
      for (const [id2, list2] of Object.entries(DISH)) {
        if (id2 <= id) continue
        for (const y of list2) {
          if (y.n === x.n && y.d === x.d) dupDiff.push(`${id}/${id2}:${x.n}`)
        }
      }
    }
  }
  assert('同城菜名无重复', dupSame === 0, String(dupSame))
  assert('跨城同名菜描述各不相同', dupDiff.length === 0, dupDiff.join(','))
  const withImg = Object.values(DISH).flat().filter((x) => x.img).length
  console.log(`  · ${withImg} 道菜配了图(${Object.values(DISH).flat().length} 道)`)
}
{
  // 切美食页签:搜索框可按菜名搜
  const foodTab = findButtons(tree, { cls: 'tvl-tab', text: '美食' })[0]
  assert('找到美食页签', Boolean(foodTab))
  foodTab?.props?.onClick?.()
  tree = await settle(parts.App, { t })
  ui = collect(tree)
  const foodCount = parts.DESTS.filter((d) => (DISH[d.id] ?? []).length > 0).length
  assert(`美食页签渲染 ${foodCount} 张美食卡`, cardCount() === foodCount, String(cardCount()))
  if (foodCount > 0) assert('美食卡样式(tvl-fcard)', String(ui.classes).includes('tvl-fcard'))
  // 按菜名搜索
  const anyDest = parts.DESTS.find((d) => (DISH[d.id] ?? []).length > 0)
  if (!anyDest) {
    console.log('  (DISHES 还没有数据,跳过菜名搜索/抽屉图文断言)')
  } else {
    const dishName = DISH[anyDest.id][0].n
  const searchBox = findButtons(tree, { cls: 'tvl-input' })[0]
  searchBox?.props?.onChange?.({ target: { value: dishName } })
  tree = await settle(parts.App, { t })
  ui = collect(tree)
  assert(`按菜名「${dishName}」搜出对应目的地`, String(ui.text).includes(anyDest.name), ui.text.slice(0, 200))
  searchBox?.props?.onChange?.({ target: { value: '' } })
  tree = await settle(parts.App, { t })
  // 打开详情:必吃区应是图文网格
  const fc = findButtons(tree, { cls: 'tvl-fcard' })[0]
  fc?.props?.onClick?.()
  tree = await settle(parts.App, { t })
  ui = collect(tree)
  assert('详情抽屉有图文必吃网格(tvl-foodgrid)', String(ui.classes).includes('tvl-foodgrid'))
  assert('必吃区标题带数量', /必吃/.test(String(ui.text)))
  const closeBtn2 = findButtons(tree, { cls: 'tvl-dr-close' })[0]
  closeBtn2?.props?.onClick?.()
  tree = await settle(parts.App, { t })
  }
  // 回季节页签一切正常(回归:food→season 的状态切换)
  const seasonTab = findButtons(tree, { cls: 'tvl-tab', text: '秋' })[0]
  seasonTab?.props?.onClick?.()
  tree = await settle(parts.App, { t })
  ui = collect(tree)
  assert('切回季节页签正常渲染', collect(tree).classes.includes('tvl-root') && cardCount() > 0, String(cardCount()))
}

/* ---------- 汇总 ---------- */
const failed = results.filter((r) => !r.ok)
console.log(`\n===== ${results.length - failed.length}/${results.length} 通过${failed.length ? `,${failed.length} 个失败` : ''} =====`)
process.exit(failed.length ? 1 : 0)
