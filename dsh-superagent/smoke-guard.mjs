// superagent 路由闸门冒烟：不真起 agent、不碰真实 ~/.dsh/superagent。
//   node smoke-guard.mjs
//
// 覆盖：7 条路由一律先过闸门（403），同源请求能进到 handler（400/405/500 都算进到了）。
// 注意：这里**不测**「/stream?session=other → 403」——当前代码没有归属校验，
// DSH 的 session 本身也没有归属概念，写这条只会得到一个假红或逼我们加个没用的 if。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'sa-guard-'))
process.env.DSH_SUPERAGENT_HOME = home

const { apply } = await import('./index.js')

const HOST = '127.0.0.1:49700'
const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: Boolean(cond) })
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}${cond || !detail ? '' : `  ${detail}`}`)
}

/* ---------------- 假 ctx ---------------- */
const routes = new Map()
const ctx = {
  effect(setup) {
    return setup()
  },
  config: {},
  sessionController: {},
  webServer: {
    host: '127.0.0.1',
    protocol: 'http:',
    register(entry) {
      routes.set(entry.path, entry.handler)
      return () => {}
    },
  },
}
apply(ctx)

check('7 条路由都注册了', routes.size === 7, [...routes.keys()].join(','))

/* ---------------- 假 req/res ---------------- */
function fakeHeaders(overrides = {}) {
  return { host: HOST, origin: `http://${HOST}`, 'sec-fetch-site': 'same-origin', ...overrides }
}

function fakeReq(method, bodyObj, headers = fakeHeaders()) {
  const chunks = bodyObj === undefined ? [] : [Buffer.from(JSON.stringify(bodyObj))]
  return {
    method,
    url: '/',
    headers,
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }),
      }
    },
    on() {},
  }
}

async function call(path, { method = 'GET', body, headers } = {}) {
  const handler = routes.get(path)
  const res = {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, h) {
      res.status = status
      res.headers = h
    },
    write() {},
    end(chunk) {
      if (chunk) res.body += chunk.toString()
    },
    on() {},
    writableEnded: true,
    writable: false,
  }
  await handler(fakeReq(method, body, headers), res)
  return res
}

/* ---------------- 1. 跨站一律 403 ---------------- */
console.log('\n[1] 跨站请求')
const crossHeaders = { host: HOST, origin: 'http://evil.example' }
for (const [path, method] of Object.entries({
  '/api/superagent/stream': 'GET',
  '/api/superagent/state': 'GET',
  '/api/superagent/send': 'POST',
  '/api/superagent/cancel': 'POST',
  '/api/superagent/models': 'GET',
  '/api/superagent/model': 'POST',
  '/api/superagent/reset': 'POST',
})) {
  const res = await call(path, { method, body: method === 'POST' ? { text: 'hi' } : undefined, headers: crossHeaders })
  check(`跨站 ${method} ${path.replace('/api/superagent', '')} → 403`, res.status === 403, `${res.status} ${res.body}`)
}

const noHost = await call('/api/superagent/state', { headers: { origin: `http://${HOST}` } })
check('缺 Host → 403', noHost.status === 403, `${noHost.status}`)
const crossSite = await call('/api/superagent/send', { method: 'POST', body: { text: 'hi' }, headers: { host: HOST, 'sec-fetch-site': 'cross-site' } })
check('Sec-Fetch-Site: cross-site → 403', crossSite.status === 403, `${crossSite.status}`)

/* ---------------- 2. 同源能进 handler ---------------- */
console.log('\n[2] 同源请求进到 handler')
const empty = await call('/api/superagent/send', { method: 'POST', body: { text: '   ' } })
check('同源空文本 /send → 400（handler 可达，不是 403）', empty.status === 400 && empty.body.includes('empty text'), `${empty.status} ${empty.body}`)
const getSend = await call('/api/superagent/send', { method: 'GET' })
check('GET /send → 405（不是 403）', getSend.status === 405, `${getSend.status} ${getSend.body}`)
const state = await call('/api/superagent/state')
check('同源 GET /state 不是 403', state.status !== 403, `${state.status}`)

const failed = results.filter((row) => !row.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  console.log(`失败：${failed.map((row) => row.name).join('、')}`)
  process.exit(1)
}
