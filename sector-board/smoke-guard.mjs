// sector-board 路由闸门冒烟：不 spawn 真 ETL、不碰真实数据目录。
//   node smoke-guard.mjs
//
// 覆盖方案 C 的正反两面：
//   - 跨站 Origin / Sec-Fetch-Site: cross-site / 缺 Host → 403
//   - 同源（Host+Origin+same-origin）→ 放行
//   - GET /refresh?run=1 → 405，且不认为 ETL 被触发（status 仍 idle）
//   - POST /paper/init 无 confirm → 400；带 confirm=1 → 进 handler（临时目录里落 paper.json）
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'sb-guard-'))
process.env.SECTOR_BOARD_DIR = dataDir

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
    const cleanup = setup()
    if (typeof cleanup === 'function') ctx._cleanups ??= []
    return cleanup
  },
  config: {},
  webServer: {
    host: '127.0.0.1',
    protocol: 'http:',
    register(entry) {
      routes.set(entry.path, entry)
      return () => {}
    },
  },
}
apply(ctx)

check('注册了 4 条 exact 路由', routes.size === 5, [...routes.keys()].join(','))
check('有 admin POST 路由', routes.has('/api/sector-board/refresh') && routes.has('/api/sector-board/paper/init'))

/* ---------------- 两种入参形态 ---------------- */
function sameOrigin(method) {
  return { host: HOST, origin: `http://${HOST}`, 'sec-fetch-site': 'same-origin' }
}

function nodeCall(path, { method = 'POST', headers = sameOrigin(), url = path } = {}) {
  const handler = routes.get(path).handler
  return new Promise((resolve) => {
    const res = {
      status: 0,
      headers: null,
      body: '',
      writeHead(status, h) {
        res.status = status
        res.headers = h
      },
      end(chunk) {
        if (chunk) res.body += chunk.toString()
        resolve(res)
      },
      on() {},
      writableEnded: false,
      writable: true,
    }
    void handler({ method, url, headers, on() {} }, res)
  })
}

async function resourceCall(pathAndQuery, headers = sameOrigin()) {
  const resource = routes.get('/api/sector-board').resource
  const response = await resource(new Request(`http://${HOST}${pathAndQuery}`, { method: 'GET', headers }))
  const text = await response.text()
  return { status: response.status, body: text, json: safeJson(text) }
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/* ---------------- 1. 写路由：拒 ---------------- */
console.log('\n[1] admin 路由闸门')
let res = await nodeCall('/api/sector-board/refresh', { headers: { host: HOST, origin: 'http://evil.example' } })
check('跨站 Origin POST /refresh → 403', res.status === 403, `${res.status} ${res.body}`)
res = await nodeCall('/api/sector-board/refresh', { headers: { host: HOST, 'sec-fetch-site': 'cross-site' } })
check('Sec-Fetch-Site: cross-site POST /refresh → 403', res.status === 403, `${res.status}`)
res = await nodeCall('/api/sector-board/refresh', { headers: { origin: `http://${HOST}` } })
check('缺 Host POST /refresh → 403', res.status === 403, `${res.status}`)
res = await nodeCall('/api/sector-board/paper/init', { headers: { host: 'evil.example', origin: 'http://evil.example' } })
check('DNS rebinding Host POST /paper/init → 403', res.status === 403, `${res.status}`)
check('被拒的请求没有落 paper.json', !existsSync(join(dataDir, 'paper.json')))

/* ---------------- 2. GET 不再触发 ETL ---------------- */
console.log('\n[2] GET /refresh 不再能拉起 ETL')
res = await nodeCall('/api/sector-board/refresh', { method: 'GET', url: '/api/sector-board/refresh?run=1' })
check('同源 GET ?run=1 → 405', res.status === 405, `${res.status} ${res.body}`)
check('405 提示改走 POST', String(res.body).includes('POST /api/sector-board/refresh'))
const status = await resourceCall('/api/sector-board/status.json')
check('GET 之后 ETL 状态仍是 idle', status.json?.state === 'idle', JSON.stringify(status.json))

/* ---------------- 3. prefix 路由：正反两面 ---------------- */
console.log('\n[3] GET 资源闸门')
let r = await resourceCall('/api/sector-board/status.json', { host: HOST, origin: 'http://evil.example' })
check('跨站 Origin GET status.json → 403', r.status === 403, `${r.status}`)
r = await resourceCall('/api/sector-board/status.json', { origin: `http://${HOST}` })
check('缺 Host 的 Fetch Request 用 URL authority 兜底 → 200', r.status === 200, `${r.status} ${r.body}`)
r = await resourceCall('/api/sector-board/status.json', { host: HOST, 'sec-fetch-site': 'cross-site' })
check('Sec-Fetch-Site: cross-site GET → 403', r.status === 403, `${r.status}`)
r = await resourceCall('/api/sector-board/status.json')
check('同源 GET status.json → 200', r.status === 200 && r.json?.state === 'idle', `${r.status} ${r.body}`)
r = await resourceCall('/api/sector-board/dashboard.json')
check('数据不存在时 dashboard.json → 404（不是 500）', r.status === 404, `${r.status} ${r.body}`)

/* ---------------- 4. 模拟盘重置要 confirm ---------------- */
console.log('\n[4] POST /paper/init 的 confirm 闸门')
res = await nodeCall('/api/sector-board/paper/init')
check('无 confirm → 400', res.status === 400, `${res.status} ${res.body}`)
check('400 说明了 confirm=1', String(res.body).includes('confirm=1'), res.body)
check('无 confirm 时账户没被动过', !existsSync(join(dataDir, 'paper.json')))
res = await nodeCall('/api/sector-board/paper/init', { url: '/api/sector-board/paper/init?confirm=1' })
check('confirm=1 进到 handler（不是 403/400）', res.status === 200, `${res.status} ${String(res.body).slice(0, 200)}`)
check('confirm=1 之后 paper.json 落盘', existsSync(join(dataDir, 'paper.json')))
if (existsSync(join(dataDir, 'paper.json'))) {
  const account = JSON.parse(readFileSync(join(dataDir, 'paper.json'), 'utf8'))
  check('账户是重置后的空账（无持仓）', Object.keys(account.holdings ?? {}).length === 0, JSON.stringify(account.holdings))
}

const failed = results.filter((row) => !row.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  console.log(`失败：${failed.map((row) => row.name).join('、')}`)
  process.exit(1)
}
