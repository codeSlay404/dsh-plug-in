// 脑图冒烟：用假的 ctx 把 apply() 注册的 /personal-memory 路由挂到一个真 http.Server 上，
// 再用 fetch 打真实端口，验证 brain/graph、brain/panel/* 静态、以及「一轮只注入一块」。
// 需要本机 ctx-server（127.0.0.1:17878）可选：拿不到 embedding 时走本地 bigram 兜底也能跑。
// node smoke-brain.mjs
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = process.env.DSH_MEMORY_WORKSPACE || join(HERE, '..', '..')
if (!existsSync(join(WORKSPACE, 'personal')) || !existsSync(join(WORKSPACE, 'memory'))) {
  console.error('smoke-brain 需要真实工作区：设置 DSH_MEMORY_WORKSPACE=/path/to/workspace')
  process.exit(2)
}

const { apply, name, readConfig } = await import('./index.js')
const captured = []
const handlers = {}
const ctx = {
  on(event, fn) { handlers[event] = fn },
  effect(setup) { return setup() },
  webServer: { register(route) { captured.push(route); return () => {} } },
  workingDirectory: { defaultDirectory: WORKSPACE },
  get() { return undefined },
}
apply(ctx, { workspace: WORKSPACE, log: false, autoReindex: false, cacheMs: 0, brain: { dbPath: process.env.PM_BRAIN_DB || '' } })
if (!captured.length) {
  console.error('✗ 没有注册 /personal-memory 路由')
  process.exit(1)
}

const server = createServer((req, res) => {
  for (const route of captured) {
    if (route.kind === 'prefix' && (req.url === route.path || req.url.startsWith(route.path + '/'))) {
      route.handler(req, res)
      return
    }
    if (route.kind === 'exact' && req.url.split('?')[0] === route.path) {
      route.handler(req, res)
      return
    }
  }
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ ok: false, error: { code: 'not-found' } }))
})

const results = []
const check = (label, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? '  ' + detail : ''}`)
}

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const sameOrigin = { origin: base, host: base.replace('http://', ''), 'sec-fetch-site': 'same-origin' }
const get = (path, init = {}) => fetch(base + path, { ...init, headers: { ...sameOrigin, ...(init.headers || {}) } })

console.log(`插件：${name}  工作区：${WORKSPACE}  端口：${server.address().port}`)

// 0) 配置开关：任务书里的 ingest.sessions 分组写法要能关掉会话摄入
const offCfg = readConfig({ brain: { ingest: { sessions: false } } })
check('brain.ingest.sessions=false 能关掉会话摄入', offCfg.brain.ingestSessions === false, `ingestSessions=${offCfg.brain.ingestSessions}`)
const defCfg = readConfig({})
check('不配置时默认收会话（新方向：三类全进脑）', defCfg.brain.ingestSessions === true, `ingestSessions=${defCfg.brain.ingestSessions}`)
const flatCfg = readConfig({ brain: { ingestSessions: false, alpha: 0.6, beta: 0.4 } })
check('平铺 ingestSessions / alpha / beta 也认', flatCfg.brain.ingestSessions === false && flatCfg.brain.alpha === 0.6 && flatCfg.brain.beta === 0.4,
  `alpha=${flatCfg.brain.alpha} beta=${flatCfg.brain.beta}`)

// 1) health
const health = await (await get('/personal-memory/brain/health')).json()
check('GET /personal-memory/brain/health → ok', health.ok === true && health.value?.ok === true,
  `nodes=${health.value?.nodes} synapses=${health.value?.synapses} counts=${JSON.stringify(health.value?.counts)} db=${health.value?.dbPath}`)

// 2) graph 真实笔记节点
const graph = await (await get('/personal-memory/brain/graph?limit=400&kind=all')).json()
const nodes = graph.value?.nodes ?? []
check('GET /personal-memory/brain/graph → 有节点和边', nodes.length > 0 && (graph.value?.edges ?? []).length > 0,
  `nodes=${nodes.length} edges=${graph.value?.edges?.length} total=${graph.value?.meta?.total}`)
const noteRows = nodes.filter((n) => n.nodeKind !== 'episode' && /^(personal|memory)\//.test(String(n.source || '')))
check('graph 里有来自 personal/ 或 memory/ 的笔记节点', noteRows.length > 0, `笔记节点 ${noteRows.length} 个`)
for (const n of noteRows.slice(0, 3)) {
  console.log(`   样例：${n.source} › ${n.heading || '(文件级)'}  ${String(n.label || '').slice(0, 40)}`)
}

// 3) 面板静态
const panel = await get('/personal-memory/brain/panel/index.html')
check('GET /personal-memory/brain/panel/index.html → 200', panel.status === 200, `HTTP ${panel.status}`)
const html = await panel.text()
check('面板首页指向 brain.js', /brain\.js/.test(html), `${html.length} 字节`)
const css = await get('/personal-memory/brain/panel/brain.css')
check('GET …/brain/panel/brain.css → 200', css.status === 200, `HTTP ${css.status}`)
const js = await get('/personal-memory/brain/panel/brain.js')
check('GET …/brain/panel/brain.js → 200', js.status === 200, `HTTP ${js.status}`)
const traversal = await get('/personal-memory/brain/panel/../index.js')
check('面板目录外的东西不给（路径穿越被挡）', traversal.status === 404 || traversal.status === 400, `HTTP ${traversal.status}`)

// 4) 一轮对话只注入一块（把 preStep 真的跑一遍，用真 ctx-server 检索 + 真脑库扩散）
const preStep = handlers['agent/pre-step']
check('apply 注册了 agent/pre-step', typeof preStep === 'function')
const signal = new AbortController().signal
const session = { header: { id: 'session-smoke-brain' }, events: [] }
const userMessage = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
session.events.push({ type: 'user/message', data: userMessage('smoke-brain-m1', '股票仓位该怎么控制，止损线怎么定') })
const step = await preStep({ agent: { id: 'session-smoke-brain', session }, signal, turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }))
const injected = (step.messages || []).map((m) => (Array.isArray(m.content) ? m.content.map((c) => c.text || '').join('\n') : String(m.content || '')))
const blockCount = injected.filter((text) => text.includes('【记忆召回 · 自动】')).length
const brainStyleCount = injected.filter((text) => text.includes('【联想记忆')).length
check('一轮对话只注入一条召回消息', injected.length === 1, `messages=${injected.length}`)
check('召回块只有一个（没有第二套 superbrain 块）', blockCount === 1 && brainStyleCount === 0, `记忆召回块=${blockCount} 联想记忆块=${brainStyleCount}`)
if (injected.length) {
  const text = injected[0]
  const lines = text.split('\n').filter((line) => line.trim().startsWith('原文：'))
  console.log(`   注入 ${text.length} 字 / ${lines.length} 篇：`)
  console.log('   ' + text.split('\n').slice(0, 7).join('\n   '))
}

server.close()
const failed = results.filter((ok) => !ok).length
console.log(`\nbrain smoke: ${results.length - failed}/${results.length} 通过${failed ? ' ✗' : ' ✓'}`)
process.exit(failed ? 1 : 0)
