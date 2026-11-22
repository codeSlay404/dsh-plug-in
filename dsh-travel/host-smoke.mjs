// Host 半离线冒烟:不依赖 DSH/真 LLM,用假 ctx 驱动真实的 apply()/路由 handler。
//   node host-smoke.mjs
import { apply } from './index.js'

const results = []
function assert(name, cond, detail = '') {
  results.push({ name, ok: Boolean(cond) })
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}${cond ? '' : `  ${detail}`}`)
}

/* ---------------- 假 req/res ---------------- */
// 与浏览器同源请求同形：Host 必带，同源 fetch 也带 Origin 与 Sec-Fetch-Site。
const HOST = '127.0.0.1:49700'
function fakeHeaders() {
  return { host: HOST, origin: `http://${HOST}`, 'sec-fetch-site': 'same-origin' }
}

function fakeReq(method, bodyObj, headers = fakeHeaders()) {
  const chunks = bodyObj === undefined ? [] : [Buffer.from(JSON.stringify(bodyObj))]
  return {
    method,
    headers,
    [Symbol.asyncIterator]() {
      let i = 0
      return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) }
    },
    on() {},
  }
}

function fakeRes() {
  const res = {
    status: null, headers: null, writes: [], body: '', ended: false,
    writeHead(s, h) { res.status = s; res.headers = h },
    write(s) { res.writes.push(s) },
    end(chunk) { if (chunk) res.body += chunk; res.ended = true },
    on() {},
  }
  return res
}

function parseSse(writes) {
  return writes.join('').split('\n\n').filter(Boolean).map((frame) => {
    const ev = (frame.match(/^event: (.+)$/m) ?? [])[1]
    const data = (frame.match(/^data: (.+)$/m) ?? [])[1]
    return { ev, data: data === undefined ? null : JSON.parse(data) }
  })
}

/* ---------------- 假 ctx ---------------- */
let streamScript = null
let selection = { provider: 'deepseek', model: 'test-model' }
const llmCalls = []
const fakeCtx = {
  effect(setup) { const c = setup(); if (typeof c === 'function') fakeCtx._cleanup = c },
  agentDefaultModel: { currentSelection: () => selection },
  llm: {
    async *stream(options) {
      llmCalls.push(options)
      for (const piece of streamScript) yield piece
    },
  },
  webServer: {
    register(entry) { fakeCtx._handler = entry.handler; return () => {} },
  },
}

apply(fakeCtx)
const handler = fakeCtx._handler
assert('apply 注册了路由 handler', typeof handler === 'function')

async function call(method, body, headers = undefined) {
  const req = headers === undefined ? fakeReq(method, body) : fakeReq(method, body, headers)
  const res = fakeRes()
  await handler(req, res)
  return res
}

const GOOD_REPLY = [
  '廊坊这时候正舒服。\n```json\n[',
  '{"name":"香河第一城","region":"河北廊坊","tagline":"仿古建筑群","kinds":["人文","瞎写的","美食"],',
  '"x":[{"e":"🏛️","n":"第一城","w":"半天","d":"仿古建筑群"},{"n":"没有emoji也行"}],',
  '"f":["香河肉饼"],"t":["自驾方便"]},',
  '{"name":"没有玩法的项"},',
  ']```',
]

/* ---------------- 1. 正常流式 ---------------- */
console.log('\n[1] 正常 SSE 流式')
streamScript = GOOD_REPLY.map((text) => ({ type: 'text-delta', index: 0, text })).concat([{ type: 'finish', reason: { kind: 'stop' } }])
const body = { q: '廊坊', season: 'spring', months: [3, 4, 5] }
let res = await call('POST', body)
assert('SSE content-type', String(res.headers?.['content-type']).includes('text/event-stream'), JSON.stringify(res.headers))
const frames = parseSse(res.writes)
assert('帧序列 status→delta…→done', frames[0]?.ev === 'status' && frames[frames.length - 1]?.ev === 'done' && frames.slice(1, -1).every((f) => f.ev === 'delta'), JSON.stringify(frames.map((f) => f.ev)))
assert('status 带回 q', frames[0]?.data?.q === '廊坊')
assert('delta 拼回全文', frames.slice(1, -1).map((f) => f.data.text).join('') === GOOD_REPLY.join(''))
const done = frames[frames.length - 1].data
assert('done.items 过滤成 1 条(无 x 的被丢)', done.items.length === 1, JSON.stringify(done.items))
assert('done.items kinds 清洗到词表', done.items[0].kinds.join(',') === '人文,美食', JSON.stringify(done.items[0].kinds))
assert('done.items 是 DEST 形状', done.items[0].id.startsWith('ai-spring-0-') && done.items[0].months.join(',') === '3,4,5')
assert('done.intro', done.intro === '廊坊这时候正舒服。')
assert('llm 收到 system+user+signal', llmCalls[0].system.includes('旅行向导') && llmCalls[0].messages[0].content[0].text === '地点:廊坊' && llmCalls[0].signal instanceof AbortSignal)
assert('llm 参数来自默认模型', llmCalls[0].provider === 'deepseek' && llmCalls[0].model === 'test-model')
assert('res.end() 收尾', res.ended)

/* ---------------- 2. 缓存命中 ---------------- */
console.log('\n[2] 缓存命中')
llmCalls.length = 0
res = await call('POST', body)
const cachedFrames = parseSse(res.writes)
const cachedDone = cachedFrames[cachedFrames.length - 1] ?? { data: null }
assert('命中缓存回 SSE（不再是 JSON）', res.status === 200 && String(res.headers?.['content-type'] || '').startsWith('text/event-stream'), JSON.stringify(res.headers))
assert('命中缓存 status→done 两帧', cachedFrames[0]?.ev === 'status' && cachedFrames.length === 2 && cachedDone.ev === 'done', JSON.stringify(cachedFrames.map((f) => f.ev)))
assert('done 带 cached 与 items', cachedDone.data?.cached === true && cachedDone.data?.items?.length === 1, JSON.stringify(cachedDone.data).slice(0, 120))
assert('缓存命中不再调 llm', llmCalls.length === 0, String(llmCalls.length))

/* ---------------- 3. 方法/参数校验 ---------------- */
console.log('\n[3] 校验')
res = await call('GET', undefined)
assert('GET → 405', res.status === 405)
res = await call('POST', { q: '  ' })
assert('空 q → 400', res.status === 400)
selection = null
res = await call('POST', { q: '新乡' })
assert('无默认模型 → 500', res.status === 500 && JSON.parse(res.body || '{}').error.includes('默认模型'), res.body)
selection = { provider: 'deepseek', model: 'test-model' }

/* ---------------- 4. 模型输出不可用 ---------------- */
console.log('\n[4] 模型输出不可用')
streamScript = [{ type: 'text-delta', index: 0, text: '抱歉,这个我不知道。' }, { type: 'finish', reason: { kind: 'stop' } }]
res = await call('POST', { q: '无名小城', season: 'summer', months: [7] })
const frames4 = parseSse(res.writes)
assert('无 fence → error 帧', frames4[frames4.length - 1].ev === 'error' && frames4[frames4.length - 1].data.message.includes('没有给出可用的推荐'), JSON.stringify(frames4[frames4.length - 1]))

streamScript = [{ type: 'finish', reason: { kind: 'error', failure: { message: '上游超时' } } }]
res = await call('POST', { q: '另一个地方', season: 'summer', months: [7] })
const frames5 = parseSse(res.writes)
assert('finish error → error 帧带原因', frames5[frames5.length - 1].ev === 'error' && frames5[frames5.length - 1].data.message.includes('上游超时'), JSON.stringify(frames5[frames5.length - 1]))

/* ---------------- 5. 来源栅栏 ---------------- */
console.log('\n[5] 来源栅栏')
res = await call('POST', { q: '廊坊' }, { host: HOST, origin: `http://${HOST}`, 'sec-fetch-site': 'same-origin' })
assert('同源放行（不是全拒）', res.status === 200, String(res.status))

res = await call('POST', { q: '廊坊' }, { host: HOST, origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' })
assert('跨站 Origin → 403', res.status === 403, String(res.status))

res = await call('POST', { q: '廊坊' }, { host: 'evil.example:49700', 'sec-fetch-site': 'same-origin' })
assert('DNS rebinding Host → 403', res.status === 403, String(res.status))

res = await call('POST', { q: '廊坊' }, { 'sec-fetch-site': 'same-origin' })
assert('缺 Host → 403', res.status === 403, String(res.status))

res = await call('POST', { q: '廊坊' }, { host: HOST, origin: 'null' })
assert('Origin: null → 403', res.status === 403, String(res.status))

res = await call('POST', { q: '廊坊' }, { host: HOST, origin: 'http://127.0.0.1:50000', 'sec-fetch-site': 'same-origin' })
assert('跨端口 Origin → 403', res.status === 403, String(res.status))

/* ---------------- 汇总 ---------------- */
const failed = results.filter((r) => !r.ok)
console.log(`\n===== ${results.length - failed.length}/${results.length} 通过${failed.length ? `,${failed.length} 个失败` : ''} =====`)
process.exit(failed.length ? 1 : 0)
