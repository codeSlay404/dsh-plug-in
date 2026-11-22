// 路由边界冒烟：/personal-memory 的每个请求都要过「Host / Sec-Fetch-Site / Origin」三道栅栏。
//
// 为什么必须有「放行」用例：只测拒绝的话，一个「全拒」的实现也能全绿，
// 而全拒等于把面板打死——浏览器同源 fetch 是带 Origin 的，别把它一起拒了。
//
// 用法：node smoke-guard.mjs

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot } from './harness.mjs'

const workspace = mkdtempSync(join(tmpdir(), 'pm-guard-'))
mkdirSync(join(workspace, 'personal'), { recursive: true })
writeFileSync(join(workspace, 'personal', '关于我.md'), '# 关于我\n\n更新:2026-11-22\n来源:smoke\n\n正文\n')

const { hostCall } = await boot({ workspace })

const results = []
function check(label, ok, detail = '') {
  results.push({ label, ok: Boolean(ok) })
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

async function expectStatus(label, status, run) {
  try {
    const value = await run()
    check(label, false, `没有报错（返回 ${JSON.stringify(value).slice(0, 60)}），期望 ${status}`)
  } catch (error) {
    check(label, error.status === status, `实际 ${error.status ?? '无状态'}：${error.message}`)
  }
}

const ok = { host: '127.0.0.1:49700', origin: 'http://127.0.0.1:49700', 'sec-fetch-site': 'same-origin' }

// --- 放行：同一来源的正常请求必须还能用 ---
{
  const status = await hostCall('GET', '/status', undefined, ok)
  check('同源请求放行', status && typeof status === 'object', '')

  const noOrigin = await hostCall('GET', '/status', undefined, { host: '127.0.0.1:49700', 'sec-fetch-site': 'same-origin' })
  check('浏览器不带 Origin 时放行（导航/部分 fetch）', noOrigin && typeof noOrigin === 'object', '')

  const loopbackOnly = await hostCall('GET', '/status', undefined, { host: 'localhost:49700', origin: 'http://localhost:49700', 'sec-fetch-site': 'same-origin' })
  check('localhost 同源放行', loopbackOnly && typeof loopbackOnly === 'object', '')

  const ipv6 = await hostCall('GET', '/status', undefined, { host: '[::1]:49700', origin: 'http://[::1]:49700', 'sec-fetch-site': 'same-origin' })
  check('IPv6 loopback 同源放行', ipv6 && typeof ipv6 === 'object', '')
}

// --- 拒绝：跨站页面、DNS rebinding、不透明 Origin、缺 Host ---
await expectStatus('缺 Host 拒绝', 403, () => hostCall('GET', '/status', undefined, { origin: 'http://127.0.0.1:49700' }))

await expectStatus('别的站点发起的请求拒绝（sec-fetch-site: cross-site）', 403,
  () => hostCall('GET', '/status', undefined, { host: '127.0.0.1:49700', origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' }))

await expectStatus('别的站点带 Origin 也拒绝', 403,
  () => hostCall('GET', '/status', undefined, { host: '127.0.0.1:49700', origin: 'http://evil.example', 'sec-fetch-site': 'same-site' }))

await expectStatus('DNS rebinding（Host 不是本机）拒绝', 403,
  () => hostCall('GET', '/status', undefined, { host: 'evil.example:49700', origin: 'http://evil.example:49700', 'sec-fetch-site': 'same-origin' }))

await expectStatus('不透明 Origin（null）拒绝', 403,
  () => hostCall('GET', '/status', undefined, { host: '127.0.0.1:49700', origin: 'null', 'sec-fetch-site': 'cross-site' }))

await expectStatus('跨端口拒绝', 403,
  () => hostCall('GET', '/status', undefined, { host: '127.0.0.1:49700', origin: 'http://127.0.0.1:49780', 'sec-fetch-site': 'same-origin' }))

// --- 写接口同样被挡住：不是只有 GET 挂了栅栏 ---
await expectStatus('跨站 POST 速记拒绝', 403,
  () => hostCall('POST', '/note', { text: '跨站写一条' }, { host: '127.0.0.1:49700', origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' }))

// --- Headers 风格（Fetch Request）也要认 ---
{
  const { isTrustedRequest } = await import('./guard.js')
  const headers = new Headers({ host: '127.0.0.1:49700', origin: 'http://127.0.0.1:49700', 'sec-fetch-site': 'same-origin' })
  check('Fetch Headers 入参可判定', isTrustedRequest({ headers }, {}) === true, '')
  const cross = new Headers({ host: '127.0.0.1:49700', origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' })
  check('Fetch Headers 跨站也拒', isTrustedRequest({ headers: cross }, {}) === false, '')
}

// --- 尾巴：给 guard.js 本身的边界值兜一遍 ---
{
  const { isLoopbackHost } = await import('./guard.js')
  check('127.0.0.1 是 loopback', isLoopbackHost('127.0.0.1') === true, '')
  check('127.0.0.2 是 loopback', isLoopbackHost('127.0.0.2') === true, '')
  check('0.0.0.0 不是 loopback', isLoopbackHost('0.0.0.0') === false, '')
  check('127.0.0.1.evil.example 不是 loopback', isLoopbackHost('127.0.0.1.evil.example') === false, '')
  check('::1 是 loopback', isLoopbackHost('::1') === true, '')
  check('::ffff:127.0.0.1 是 loopback', isLoopbackHost('::ffff:127.0.0.1') === true, '')
}

const failed = results.filter((row) => !row.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  console.log(`失败：${failed.map((row) => row.label).join('、')}`)
  process.exit(1)
}
