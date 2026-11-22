// 视觉验收:把 harness 展开的组件树序列化成静态 HTML,再用本机 Chrome 无头截图。
//   node preview.mjs                     # 生成两张 /tmp/travel-preview/*.png 并打印路径
//   node preview.mjs --open              # 截完用系统看图打开
import { boot, settle, collect, findButtons, walk } from './harness.mjs'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { homedir } from 'node:os'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/* ---------- 组件树 → HTML ---------- */
const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
const styleStr = (style) => {
  if (!style || typeof style !== 'object') return typeof style === 'string' ? style : ''
  return Object.entries(style)
    .filter(([, v]) => v !== null && v !== undefined && v !== false)
    .map(([k, v]) => `${kebab(k)}:${typeof v === 'number' && !/^(opacity|z-index|flex)/.test(kebab(k)) ? `${v}px` : v}`)
    .join(';')
}
const SKIP = new Set(['children', 'onClick', 'onChange', 'onKeyDown', 'dangerouslySetInnerHTML'])
const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link'])

function toHtml(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  }
  if (Array.isArray(node)) return node.map(toHtml).join('')
  const tag = String(node.type)
  if (!/^[a-z][a-z0-9-]*$/i.test(tag)) return toHtml(node.children)
  const attrs = Object.entries(node.props ?? {})
    .filter(([k, v]) => !SKIP.has(k) && v !== undefined && v !== null && v !== false)
    .map(([k, v]) => {
      if (k === 'className') return `class="${esc(String(v))}"`
      if (k === 'style') { const s = styleStr(v); return s ? `style="${esc(s)}"` : '' }
      if (v === true) return esc(k)
      return `${k === 'stroke-width' ? 'stroke-width' : k}="${esc(String(v))}"`
    })
    .filter(Boolean)
    .join(' ')
  const open = attrs ? `<${tag} ${attrs}>` : `<${tag}>`
  if (VOID.has(tag)) return open
  return `${open}${toHtml(node.children)}</${tag}>`
}
const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function collectStyles(node) {
  const out = []
  walk(node, (el) => {
    if (el && typeof el === 'object' && el.type === 'style' && typeof el.props?.children === 'string') out.push(el.props.children)
  })
  return out
}

/* ---------- 场景渲染 ---------- */
const zhDict = {
  nav: '旅行灵感', 'brand.sub': '每个季节,该去哪、玩什么', 'tab.food': '美食', 'food.hint': '按菜名或地名搜', 'food.empty.title': '没找到相关美食', 'food.empty.hint': '试试菜名或地名。', 'tab.wish': '想去 ({n})',
  'search.ph': '搜地名、玩法、美食…', 'month.all': '整季', count: '{n} 个目的地',
  'sort.hint': '正当时的排前', 'badge.best': '正当时', 'wish.add': '想去', 'wish.remove': '已在想去',
  'wish.empty.title': '还没有想去的地方', 'drawer.exps': '最好玩的事',
  'wish.empty.hint': '点亮卡片右上角的 ☆,想去的地方会收在这里。',
  'drawer.food': '必吃', 'drawer.tips': '出发前知道', random: '随机去哪', 'empty.title': '没找到',
  'empty.hint': '换个关键词、月份或玩法标签试试。', months: '最佳:{m}',
  'ai.thinking': 'AI 正在找「{q}」好玩的事…', 'ai.count': 'AI 找到 {n} 个玩法',
  'ai.cached': '上次的结果', 'ai.retry': '重新生成',
  'ai.note': 'AI 生成,仅供参考,出行前再核实。', 'ai.error': 'AI 没帮上忙:{m}',
}
const t = (key, params) => env.parts.tOf(zhDict, key, params)

const env = await boot()

async function sceneShot(name, width, height, mutate) {
  let tree = await settle(env.parts.App, { t })
  if (mutate) await mutate(tree)
  tree = await settle(env.parts.App, { t })
  const styles = env.styleNodes.map((n) => String(n.textContent ?? ''))
  const html = `<!doctype html>
<html><head><meta charset="utf-8">
<style>
:root{--dsw-alias-bg-base:#f6f7f9;--dsw-alias-bg-layer-1:#ffffff;--dsw-alias-bg-layer-2:#f1f2f5;--dsw-alias-label-primary:#1f2329;--dsw-alias-border-l2:#c7ccd4;--dsw-alias-brand-primary:#3b6ef6;--dsw-alias-state-warn-primary:#f5a623;--dsw-alias-state-success-primary:#30a46c}
html,body{margin:0;padding:0;background:#e9ebee;font-family:-apple-system,"PingFang SC","Helvetica Neue",sans-serif}
#frame{display:flex;justify-content:center;padding:24px 0}
#app{width:${width}px;background:#f6f7f9;border-radius:14px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,.15);position:relative;min-height:640px}
/* headless 截图会把 CSS 动画冻在第一帧(opacity:0),这里禁掉动画只影响预览,不影响插件 */
#app *{animation:none!important;transition:none!important}
</style>
<style>${styles.join('\n')}</style>
</head>
<body><div id="frame"><div id="app">${toHtml(tree)}</div></div></body></html>`
  const htmlPath = `/tmp/travel-preview/${name}.html`
  mkdirSync(dirname(htmlPath), { recursive: true })
  writeFileSync(htmlPath, html)
  const pngPath = `/tmp/travel-preview/${name}.png`
  execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--force-device-scale-factor=2', `--window-size=${width + 48},${height + 48}`,
    '--virtual-time-budget=2500', '--user-data-dir=/tmp/travel-chrome-profile',
    `--screenshot=${pngPath}`, `file://${htmlPath}`,
  ], { maxBuffer: 8 * 1024 * 1024 })
  return pngPath
}

const shots = []
shots.push(await sceneShot('01-default', 1180, 900))
shots.push(await sceneShot('02-winter-drawer', 1180, 900, (tree) => {
  findButtons(tree, { cls: 'tvl-tab', text: '冬' })[0]?.props?.onClick?.()
}))
shots.push(await sceneShot('03-drawer', 1180, 900, (tree) => {
  const card = findButtons(tree, { cls: 'tvl-card' })[0]
  card?.props?.onClick?.()
}))

/* AI 兜底面板:装一个桩 fetch,搜「廊坊」(静态列表没有)后等防抖触发 */
{
  const enc = new TextEncoder()
  const AI_ITEMS = [
    { id: 'ai-spring-0-xianghe', name: '香河第一城', region: '河北廊坊', season: 'spring', months: [3, 4, 5], tagline: '仿古建筑群里逛一天,京津冀自驾顺路', kinds: ['人文', '美食'], x: [{ e: '🏛️', n: '第一城景区', w: '半天', d: '仿古建筑群,适合拍照和慢逛' }, { e: '🎡', n: '景区夜场灯光秀', w: '2小时', d: '傍晚亮灯后更好看' }], f: ['香河肉饼', '驴肉火烧'], t: ['自驾更方便', '工作日人少'] },
    { id: 'ai-spring-1-shuiyun', name: '水云间文化集市', region: '河北廊坊', season: 'spring', months: [3, 4, 5], tagline: '手作市集与小吃街,遛娃好去处', kinds: ['人文'], x: [{ e: '🎨', n: '周末手作市集', w: '半天', d: '手作摊位+现场小吃' }], f: ['糖画'], t: ['周末更热闹'] },
  ]
  const frame = (ev, obj) => enc.encode(`event: ${ev}\ndata: ${JSON.stringify(obj)}\n\n`)
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body)
    const stream = new ReadableStream({
      start(ctrl) {
        for (const f of [
          frame('status', { q: body.q }),
          frame('delta', { text: '廊坊不大,春天来正舒服。\n```json\n[{"x":1}]\n```' }),
          frame('done', { ok: true, intro: '廊坊不大,春天来正舒服:城区小、人不多,主打市集、公园和周边小镇。', items: AI_ITEMS }),
        ]) ctrl.enqueue(f)
        ctrl.close()
      },
    })
    return { ok: true, status: 200, body: stream }
  }
  shots.push(await sceneShot('04-ai-panel', 1180, 900, async () => {
    // 关掉上一场景遗留的抽屉
    const drawerTree = await settle(env.parts.App, { t })
    findButtons(drawerTree, { cls: 'tvl-dr-close' })[0]?.props?.onClick?.()
    const springTree = await settle(env.parts.App, { t })
    findButtons(springTree, { cls: 'tvl-tab', text: '春' })[0]?.props?.onClick?.()
    const armed = await settle(env.parts.App, { t })
    findButtons(armed, { cls: 'tvl-input' })[0]?.props?.onChange?.({ target: { value: '廊坊' } })
    await settle(env.parts.App, { t })
    await new Promise((r) => setTimeout(r, 950))
  }))
  shots.push(await sceneShot('05-food', 1180, 900, async () => {
    const tree = await settle(env.parts.App, { t })
    findButtons(tree, { cls: 'tvl-input' })[0]?.props?.onChange?.({ target: { value: '' } })
    const armed = await settle(env.parts.App, { t })
    findButtons(armed, { cls: 'tvl-tab', text: '美食' })[0]?.props?.onClick?.()
    await settle(env.parts.App, { t })
  }))
  shots.push(await sceneShot('06-food-drawer', 1180, 900, async () => {
    const tree = await settle(env.parts.App, { t })
    const cards = findButtons(tree, { cls: 'tvl-fcard' })
    const kunming = cards.find((c) => (c.props['aria-label'] ?? '').includes('昆明')) ?? cards[0]
    kunming?.props?.onClick?.()
    await settle(env.parts.App, { t })
    await new Promise((r) => setTimeout(r, 2800)) // 等 lazy 图加载
  }))
}
console.log(shots.join('\n'))
