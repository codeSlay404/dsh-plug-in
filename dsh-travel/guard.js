// 浏览器信任闸门。
//
// 与 DSH 官方 @deepseek-ai/dsh-client-connection/src/api-request-trust.ts 同语义，
// 三道，顺序也一致：
//   1. Host 必须是本机（防 DNS rebinding：evil.example 解析到 127.0.0.1 也过不了）
//   2. Sec-Fetch-Site: cross-site 直接拒（浏览器明确告诉我们这是跨站来的）
//   3. 带 Origin 时必须与 Host 同 authority（防 CSRF；不带 Origin 的 curl 放行，'null' 不透明 origin 拒）
//
// 插件可能收到两种入参：Node IncomingMessage（req.headers 是普通对象，键已小写）和
// Fetch Request（headers 是 Headers，要 .get）。这里都吃。

function stripBrackets(hostname) {
  const h = String(hostname ?? '').trim().toLowerCase()
  if (h.startsWith('[') && h.endsWith(']')) return h.slice(1, -1)
  return h
}

function normalizeHost(hostname) {
  // IPv6 zone（fe80::1%eth0）在比较时去掉；尾点在 IPv4 上不合法，留着让它落选
  return stripBrackets(hostname).split('%')[0]
}

function normalizePort(port) {
  return String(port ?? '').trim()
}

function headerOf(source, name) {
  const headers = source?.headers ?? source
  if (!headers) return undefined
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined
  const direct = headers[name]
  if (direct !== undefined) return Array.isArray(direct) ? direct[0] : direct
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== name) continue
    const value = headers[key]
    return Array.isArray(value) ? value[0] : value
  }
  return undefined
}

function parseAuthority(authority) {
  if (typeof authority !== 'string' || !authority.trim()) return null
  try {
    const url = new URL(`http://${authority.trim()}`)
    if (!url.hostname) return null
    return { hostname: url.hostname, port: url.port }
  } catch {
    return null
  }
}

function parseOrigin(origin) {
  try {
    const url = new URL(String(origin))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (!url.hostname) return null
    return { hostname: url.hostname, port: url.port }
  } catch {
    return null
  }
}

/** 逐段数字比较：Number('1.') === 1 会放过 127.0.0.1. 这种写法，所以不用 Number 直接吃。 */
export function isLoopbackHost(hostname) {
  const h = normalizeHost(hostname)
  if (h === 'localhost' || h === 'localhost.') return true
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true
  // 双栈监听时真实 Host 可能是 IPv4-mapped IPv6（::ffff:127.0.0.1），把 v4 部分摘出来再判
  const mapped = /^::ffff:(.+)$/.exec(h)
  if (mapped) {
    const tail = mapped[1]
    if (tail.includes('.')) return isLoopbackHost(tail)
    const groups = tail.split(':')
    if (groups.length === 2 && groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) {
      const value = Number.parseInt(groups[0], 16) * 65536 + Number.parseInt(groups[1], 16)
      return Math.floor(value / 16777216) === 127
    }
    return false
  }
  const parts = h.split('.')
  if (parts.length !== 4) return false
  const nums = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false
    const n = Number(part)
    if (n > 255) return false
    nums.push(n)
  }
  return nums[0] === 127
}

function sameHost(a, b) {
  return normalizeHost(a) === normalizeHost(b)
}

function isBindHost(hostname, bindHost) {
  if (!bindHost) return false
  const bind = normalizeHost(bindHost)
  // DSH 拒绝 wildcard bind，这里只做保险：0.0.0.0 / :: 不算可信目标
  if (bind === '0.0.0.0' || bind === '::') return false
  return sameHost(hostname, bindHost)
}

function sameAuthority(origin, host) {
  const a = parseOrigin(origin)
  const b = parseAuthority(host)
  if (!a || !b) return false
  return sameHost(a.hostname, b.hostname) && normalizePort(a.port) === normalizePort(b.port)
}

function trustedMatch(entry, parsed) {
  const clean = String(entry ?? '').trim().replace(/^https?:\/\//i, '')
  const e = parseAuthority(clean)
  if (!e) return false
  if (!sameHost(e.hostname, parsed.hostname)) return false
  return e.port ? normalizePort(e.port) === normalizePort(parsed.port) : true
}

/**
 * 是否可信：可信 = 本机浏览器同源发来的、或者明确配置过的 Host。
 * @param {object} source Node req / Fetch Request / 裸 headers 对象
 * @param {{bindHost?: string, protocol?: string, trustedHosts?: string[]}} opts
 */
/**
 * 目标 authority：优先 Host 头；Fetch Request 的 Host 万一被上游剥掉，
 * 用它自己的 URL authority 兜底（同源路由本来就知道自己被挂在哪个 authority 上）。
 * 否则 prefix 路由在 Request 形态下会全 403。
 */
function authorityOf(source) {
  const header = headerOf(source, 'host')
  if (header) return header
  if (typeof source?.url === 'string') {
    try {
      const url = new URL(source.url)
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.host
    } catch {
      /* 相对 url（Node req.url）走不到这里 */
    }
  }
  return undefined
}

export function isTrustedRequest(source, opts = {}) {
  const host = authorityOf(source)
  if (!host) return false // HTTP/1.1 必带 Host；连 URL 都不是绝对地址时只能是非 HTTP 调用
  const parsed = parseAuthority(host)
  if (!parsed) return false

  const trustedHosts = Array.isArray(opts.trustedHosts) ? opts.trustedHosts : []
  const hostOk =
    isLoopbackHost(parsed.hostname) ||
    isBindHost(parsed.hostname, opts.bindHost) ||
    trustedHosts.some((entry) => trustedMatch(entry, parsed))
  if (!hostOk) return false

  const fetchSite = String(headerOf(source, 'sec-fetch-site') ?? '').toLowerCase()
  if (fetchSite === 'cross-site') return false

  const origin = headerOf(source, 'origin')
  if (origin === undefined || origin === null || origin === '') return true
  if (String(origin).trim().toLowerCase() === 'null') return false
  return sameAuthority(origin, host)
}

/** 从 ctx 里取闸门选项；取不到按本机 http 兜底（DSH 默认只绑 loopback）。 */
export function guardOptions(ctx, config) {
  const server = ctx?.webServer
  return {
    bindHost: typeof server?.host === 'string' ? server.host : '127.0.0.1',
    protocol: server?.protocol === 'https:' ? 'https:' : 'http:',
    trustedHosts: Array.isArray(config?.trustedHosts) ? config.trustedHosts : [],
  }
}
