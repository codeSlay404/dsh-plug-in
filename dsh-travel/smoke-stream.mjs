// travel 流终止语义冒烟：假 llm，不联网、不调用真模型。
//   node smoke-stream.mjs
//
// 覆盖方案 D：
//   1. 成功流：status → delta… → done
//   2. 同参数第二次：仍是 text/event-stream（不是 JSON），且带 done.cached
//   3. 模型超时：必须有 event: error 终止帧（不能静默 res.end）
//   4. 客户端已走（res.writableEnded）：超时后不再发帧
//   5. 非超时异常：error 帧带原因
import { apply } from './index.js'

const HOST = '127.0.0.1:49700'
const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: Boolean(cond) })
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}${cond || !detail ? '' : `  ${detail}`}`)
}

function fakeHeaders() {
  return { host: HOST, origin: `http://${HOST}`, 'sec-fetch-site': 'same-origin' }
}

function fakeReq(bodyObj) {
  const chunks = bodyObj === undefined ? [] : [Buffer.from(JSON.stringify(bodyObj))]
  return {
    method: 'POST',
    url: '/api/travel/ai',
    headers: fakeHeaders(),
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }),
      }
    },
    on() {},
  }
}

function fakeRes() {
  const res = {
    status: null,
    headers: null,
    writes: [],
    ended: false,
    writableEnded: false,
    writable: true,
    closeHandlers: [],
    writeHead(s, h) {
      res.status = s
      res.headers = h
    },
    write(s) {
      res.writes.push(s)
    },
    end() {
      res.ended = true
      res.writableEnded = true
    },
    on(event, fn) {
      if (event === 'close') res.closeHandlers.push(fn)
    },
  }
  return res
}

function parseSse(writes) {
  return writes
    .join('')
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      const ev = (frame.match(/^event: (.+)$/m) ?? [])[1]
      const data = (frame.match(/^data: (.+)$/m) ?? [])[1]
      return { ev, data: data === undefined ? null : JSON.parse(data) }
    })
}

/* ---------------- 假 ctx ---------------- */
let mode = 'ok'
const GOOD_REPLY = [
  '廊坊这时候正舒服。\n```json\n[',
  '{"name":"香河第一城","region":"河北廊坊","tagline":"仿古建筑群","kinds":["人文"],',
  '"x":[{"e":"🏛️","n":"第一城","w":"半天","d":"仿古建筑群"}],"f":["香河肉饼"],"t":["自驾方便"]}',
  ']```',
]
const fakeCtx = {
  config: { timeoutMs: 120 },
  effect(setup) {
    return setup()
  },
  agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'test-model' }) },
  llm: {
    async *stream(options) {
      if (mode === 'hang') {
        await new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const error = new Error('This operation was aborted')
            error.name = 'AbortError'
            reject(error)
          })
        })
        return
      }
      if (mode === 'throw') throw new Error('上游 502')
      for (const text of GOOD_REPLY) yield { type: 'text-delta', index: 0, text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  },
  webServer: {
    host: '127.0.0.1',
    protocol: 'http:',
    register(entry) {
      fakeCtx._handler = entry.handler
      return () => {}
    },
  },
}
apply(fakeCtx, fakeCtx.config)
const handler = fakeCtx._handler

async function call(body) {
  const res = fakeRes()
  await handler(fakeReq(body), res)
  return res
}

/* ---------------- 1. 成功流 ---------------- */
console.log('\n[1] 成功流')
const body = { q: '廊坊-stream', season: 'spring', months: [3, 4, 5] }
let res = await call(body)
let frames = parseSse(res.writes)
check('content-type 是 SSE', String(res.headers?.['content-type']).includes('text/event-stream'), JSON.stringify(res.headers))
check('帧序列 status→delta→done', frames[0]?.ev === 'status' && frames.at(-1)?.ev === 'done', JSON.stringify(frames.map((f) => f.ev)))
check('done 带 1 条推荐', frames.at(-1)?.data?.items?.length === 1, JSON.stringify(frames.at(-1)?.data))
check('流结束 res.end()', res.ended)

/* ---------------- 2. 缓存命中仍走 SSE ---------------- */
console.log('\n[2] 缓存命中')
res = await call(body)
frames = parseSse(res.writes)
check('缓存命中 content-type 仍是 SSE', String(res.headers?.['content-type']).includes('text/event-stream'), JSON.stringify(res.headers))
check('缓存命中 status→done 两帧', frames.length === 2 && frames[0].ev === 'status' && frames[1].ev === 'done', JSON.stringify(frames.map((f) => f.ev)))
check('done.cached 为 true', frames[1]?.data?.cached === true, JSON.stringify(frames[1]?.data))
check('缓存命中也有推荐条目', frames[1]?.data?.items?.length === 1)

/* ---------------- 3. 超时必须给终止帧 ---------------- */
console.log('\n[3] 模型超时')
mode = 'hang'
res = await call({ q: '超时测试-stream', season: 'autumn', months: [9] })
frames = parseSse(res.writes)
check('超时出现 event: error', frames.some((f) => f.ev === 'error'), JSON.stringify(frames.map((f) => f.ev)))
check('error 帧说明超时秒数', frames.at(-1)?.ev === 'error' && /秒没有响应/.test(String(frames.at(-1)?.data?.message)), JSON.stringify(frames.at(-1)?.data))
check('超时后仍然 res.end()', res.ended)

/* ---------------- 4. 客户端已走就不要发帧 ---------------- */
console.log('\n[4] 客户端已断开')
const resGone = fakeRes()
const running = handler(fakeReq({ q: '断开测试-stream', season: 'winter', months: [12] }), resGone)
await new Promise((resolve) => setTimeout(resolve, 30))
resGone.writableEnded = true // 模拟浏览器已关闭
await running
const goneFrames = parseSse(resGone.writes)
check('客户端已走时不再追加 error 帧', goneFrames.every((f) => f.ev !== 'error'), JSON.stringify(goneFrames.map((f) => f.ev)))

/* ---------------- 5. 非超时异常 ---------------- */
console.log('\n[5] 上游异常')
mode = 'throw'
res = await call({ q: '异常测试-stream', season: 'summer', months: [6] })
frames = parseSse(res.writes)
check('异常也给 error 帧', frames.at(-1)?.ev === 'error', JSON.stringify(frames.map((f) => f.ev)))
check('error 帧带上游原因', /502/.test(String(frames.at(-1)?.data?.message)), JSON.stringify(frames.at(-1)?.data))

const failed = results.filter((row) => !row.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  console.log(`失败：${failed.map((row) => row.name).join('、')}`)
  process.exit(1)
}
