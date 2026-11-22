// 离线冒烟：用假的 ctx / fetch / session 跑一遍 pre-step 逻辑，
// 不开 DSH、不开 ctx-server 也能验证注入、去重、限额。node smoke.mjs
import { apply } from './index.js'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 用一个临时工作区跑：既让 workspace 解析成功（会写日汇总），又不碰真工作区
const WORKSPACE = mkdtempSync(join(tmpdir(), 'pm-recall-'))
mkdirSync(join(WORKSPACE, 'personal'), { recursive: true })
mkdirSync(join(WORKSPACE, 'memory', '2026', '11'), { recursive: true })
writeFileSync(join(WORKSPACE, 'personal', 'index.md'), '# 个人记忆\n\n- 索引\n')
writeFileSync(join(WORKSPACE, 'memory', 'index.md'), '# memory\n\n- 索引\n')
writeFileSync(join(WORKSPACE, 'memory', '2026', '11', '2026-11-20.md'), '# 2026-11-20 周五\n\n## 产出\n\n- 09:00 一条\n')

const HITS = [
  {
    docId: 'doc-stop-loss',
    title: '计划买点没到就下手等于把止损线提前',
    heading: '止损位怎么定',
    path: 'personal/stock/计划买点没到就下手等于把止损线提前.md',
    text: '止损位用买入价倒推，不要用「前低」。买入价向下 8% 就是止损线，先算好再下单。',
    score: 0.976,
  },
  {
    docId: 'doc-noise',
    title: '无关笔记',
    heading: '别的',
    path: 'personal/noise.md',
    text: '这条分数低于门槛，应该被丢掉。',
    score: 0.02,
  },
]

const fetchState = { calls: 0, lastBody: null }
globalThis.fetch = async (url, init) => {
  fetchState.calls += 1
  fetchState.lastBody = JSON.parse(init.body)
  return {
    ok: true,
    async json() {
      return { ok: true, value: { query: fetchState.lastBody.query, mode: 'vector', hits: HITS, ms: 1 } }
    },
  }
}

const listeners = {}
const ctx = {
  on(event, fn) { listeners[event] = fn },
  // smoke 里没有 webServer/effect，host 会防御性跳过路由注册
}

apply(ctx, { log: false, workspace: WORKSPACE, cacheMs: 0 })
const preStep = listeners['agent/pre-step']
if (typeof preStep !== 'function') throw new Error('没有注册 agent/pre-step')

const signal = new AbortController().signal

function userMessage(id, text) {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}
const userEvent = (id, text) => ({ type: 'user/message', data: userMessage(id, text) })
// pre-step 给的 messages 是「这一步新进来的」增量，turn 的后续步是空的。
const emptyStep = async () => ({ kind: 'enter', messages: [] })

const session = { header: { id: 's1' }, events: [] }
const payload = () => ({ agent: { id: 's1', session }, signal, turn: 1, step: 1 })

session.events.push(userEvent('m1', '止损线怎么定的'))
const first = await preStep(payload(), emptyStep)
console.log('第一次注入:', first.kind, '消息数', first.messages.length)
console.log(first.messages.at(-1).content[0].text.split('\n').slice(0, 4).join('\n'))
if (first.messages.length !== 1) throw new Error('应该多一条召回消息')
const firstText = first.messages.at(-1).content[0].text
if (!firstText.includes('止损位用买入价倒推')) throw new Error('召回正文缺失')
if (!firstText.includes('personal/stock/')) throw new Error('原文路径缺失')

// 把注入消息记进 session 历史，模拟真实会话
session.events.push({ type: 'user/message', data: first.messages.at(-1) })

const second = await preStep(payload(), emptyStep)
console.log('同一消息第二次:', second.messages.length === 0 ? '跳过 ✓' : '重复注入 ✗')

session.events.push(userEvent('m2', '止损线怎么定的'))
const third = await preStep(payload(), emptyStep)
console.log('新消息但文档已注入:', third.messages.length === 0 ? '跳过 ✓' : '重复注入 ✗')

session.events.push(userEvent('m3', '好'))
const short = await preStep(payload(), emptyStep)
console.log('短提问:', short.messages.length === 0 ? '跳过 ✓' : '未跳过 ✗')

session.events.push(userEvent('m4', '/compact 一下'))
const slash = await preStep(payload(), emptyStep)
console.log('斜杠命令:', slash.messages.length === 0 ? '跳过 ✓' : '未跳过 ✗')

const subSession = { header: { id: 's2', origin: 'subagent' }, events: [userEvent('m5', '止损线怎么定的')] }
const sub = await preStep({ agent: { id: 's2', session: subSession }, signal }, emptyStep)
console.log('子代理:', sub.messages.length === 0 ? '跳过 ✓' : '未跳过 ✗')

// 日用量汇总：召回成功后应该落到 state.json（日志被清空也不该归零）
const stateFile = join(WORKSPACE, '.dsh/personal-memory/state.json')
// 日汇总是 fire-and-forget（统计不该拖慢召回），所以这里等一下文件出现
for (let i = 0; i < 40 && !existsSync(stateFile); i += 1) await new Promise((done) => setTimeout(done, 25))
const usageState = JSON.parse(readFileSync(stateFile, 'utf8'))
const usageDays = Object.keys(usageState.usage ?? {})
const usageRow = usageDays.length > 0 ? usageState.usage[usageDays[0]] : null
console.log('日汇总:', JSON.stringify(usageState.usage))
if (!usageRow || usageRow.recalls < 1) throw new Error('召回没有写进日汇总')
if (usageRow.injected < 1) throw new Error('日汇总里没有注入篇数')
// chars 曾经因为默认对象少了字段而被算成 NaN → 洗成 0，这里钉住它
if (!(usageRow.chars > 0)) throw new Error('日汇总里没有注入字数')

// 混合召回：向量层漏掉的「精确词」，词面层要能补进来（模拟查端口号 / 代码号）
const hybridDoc = join(WORKSPACE, 'personal', 'hybrid-probe.md')
writeFileSync(hybridDoc, '# 混合召回探针\n\n这条只有字面命中：PMHYBRID77 对应的端口是 17878。\n', 'utf8')
const hybridSession = { header: { id: 's3' }, events: [userEvent('h1', 'PMHYBRID77')] }
let hybrid
try {
  hybrid = await preStep({ agent: { id: 's3', session: hybridSession }, signal, turn: 1, step: 1 }, emptyStep)
} catch (error) {
  console.log('混合召回抛错:', error?.message)
  throw error
}
const hybridText = hybrid.messages.at(-1)?.content?.[0]?.text ?? ''
console.log('混合召回注入篇数:', hybrid.messages.length ? hybridText.split('\n').filter((line) => line.trim().startsWith('原文：')).length : 0)
if (hybrid.messages.length === 0) throw new Error('字面命中的文档没有被注入')
if (!hybridText.includes('personal/hybrid-probe.md')) throw new Error('词面层没把精确词命中的文档补进来')
if (!hybridText.includes('[原话]')) throw new Error('注入块没有标出「原话命中」的来源')
// 摘录别以 `# 标题` 开头：注入块里已经有《标题》了
const probeBlock = hybridText.split('原文：personal/hybrid-probe.md')[0].trimEnd().split('\n').slice(-2, -1)[0] ?? ''
if (/^\s*#/.test(probeBlock)) throw new Error('词面摘录带了标题行')
if (!hybridText.includes('PMHYBRID77 对应的端口是 17878')) throw new Error('词面摘录没有正文内容')
if (/原文：personal\/hybrid-probe\.md/.test(hybridText.split('原文：personal/hybrid-probe.md')[0].split('\n').slice(-3).join('\n')) && /^-{0,0}# /.test('')) throw new Error('unreachable')

console.log('localSearch(fetch) 调用次数:', fetchState.calls, '| 检索参数:', JSON.stringify({
  query: fetchState.lastBody.query,
  topK: fetchState.lastBody.topK,
}))
