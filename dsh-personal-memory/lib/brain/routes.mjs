// lib/brain/routes.mjs —— /personal-memory/brain/* 的全部接口与面板静态文件。
import { createReadStream, realpathSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PANEL_DIR = fileURLToPath(new URL('../../brain/panel/', import.meta.url))
/** 去掉结尾斜杠的版本：拼 sep 做前缀校验时不能出现 `panel//`。 */
const PANEL_ROOT = resolve(PANEL_DIR)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}
const ALLOWED = new Set(Object.keys(MIME))

/** 面板文件解析：逐段校验 + realpath 必须落在 PANEL_DIR 内。 */
export function resolvePanelAsset(pathname) {
  // 兼容两种入参：宿主已剥掉前缀的 '/brain/panel/x'，以及未剥前缀的
  // '/personal-memory/brain/panel/x'（旧宿主会原样传 req.url 的 pathname）。
  const raw = String(pathname || '').replace(/^.*\/brain\/panel\/?/, '')
  if (!raw) return join(PANEL_DIR, 'index.html')
  const parts = raw.split('/').filter(Boolean)
  if (!parts.length || parts.some((part) => part === '.' || part === '..')) return null
  const abs = resolve(PANEL_DIR, ...parts)
  if (!(abs === PANEL_ROOT || abs.startsWith(PANEL_ROOT + sep))) return null
  if (!ALLOWED.has(extname(abs).toLowerCase())) return null
  try {
    if (!statSync(abs).isFile()) return null
    const real = realpathSync(abs)
    if (!(real === PANEL_ROOT || real.startsWith(PANEL_ROOT + sep))) return null
  } catch {
    return null
  }
  return abs
}

/** 直接写二进制响应；返回 true 表示已经处理。 */
export function servePanel(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  const file = resolvePanelAsset(pathname)
  if (!file) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ok: false, error: { code: 'not-found', message: 'no such panel asset' } }))
    return true
  }
  let stats
  try {
    stats = statSync(file)
  } catch {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: { code: 'not-found' } }))
    return true
  }
  res.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': stats.size,
    'cache-control': 'no-cache',
  })
  if (req.method === 'HEAD') {
    res.end()
    return true
  }
  createReadStream(file).pipe(res)
  return true
}

/** 把 brain 控制器包成 apiRoute 里的路由表。 */
export function createBrainRoutes(brain) {
  return {
    'GET /brain/health': async () => brain.health(),
    'GET /brain/graph': async ({ query }) =>
      brain.graph({
        limit: query.get('limit'),
        minWeight: query.get('minWeight'),
        kind: query.get('kind') || 'all',
      }),
    'GET /brain/node': async ({ query }) => brain.node(query.get('key')),
    'GET /brain/recall': async ({ query }) => {
      const q = String(query.get('q') || '').trim()
      if (!q) return { query: q, rows: [], seeds: 0, activated: 0 }
      return { query: q, ...brain.recall(q, { sessionId: query.get('session') || null }) }
    },
    'POST /brain/touch': async ({ body }) => brain.touch(body ?? {}),
    'POST /brain/rebuild': async () => brain.rebuild(),
    'POST /brain/ingest': async ({ body }) => brain.ingestSessions(body ?? {}),
    'POST /brain/consolidate': async ({ body }) => brain.consolidate(body ?? {}),
  }
}
