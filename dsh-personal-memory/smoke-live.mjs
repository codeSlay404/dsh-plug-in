#!/usr/bin/env node
/**
 * 真实宿主自检：只读。
 *
 * 其他四套冒烟都在本地跑（假 ctx / 沙箱目录），证明「代码对不对」。
 * 这一套打的是**正在运行的 GUI 宿主**（`/personal-memory/*` 免 token），
 * 所以它能回答另一个问题：代码真的装进去了吗、路由真的活着吗。
 *
 * 用法：node smoke-live.mjs            # 自动找端口
 *      node smoke-live.mjs 50838       # 指定端口
 */
import { execSync } from 'node:child_process'

const PORTS = process.argv[2] ? [Number(process.argv[2])] : []
if (PORTS.length === 0) {
  // 从监听端口里挑：dsh web 的端口每次重启会变，扫描 49xxx–52xxx 太慢，直接用 lsof
  try {
    const out = execSync("lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -i 'node\\|Electron' | awk '{print $9}'", { encoding: 'utf8' })
    for (const line of out.split('\n')) {
      const match = line.match(/:(\d{5})$/)
      if (match) PORTS.push(Number(match[1]))
    }
  } catch { /* lsof 没有就靠手传端口 */ }
}

const BODY = (path) => `/personal-memory${path}`
const encode = (value) => encodeURIComponent(String(value))

async function get(port, path) {
  const url = `http://127.0.0.1:${port}${BODY(path)}`
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON 就是错页 */ }
  return { status: response.status, json }
}

let failures = 0
const ok = (label, extra = '') => console.log(`  ✓ ${label}${extra ? `  ${extra}` : ''}`)
const bad = (label, detail) => { failures += 1; console.log(`  ✗ ${label}  ${detail}`) }
const check = (label, condition, detail = '') => (condition ? ok(label, detail) : bad(label, detail))

async function probe(port) {
  try {
    const health = await get(port, '/status')
    return health.status === 200 && health.json?.ok !== false
  } catch { return false }
}

const candidates = PORTS.filter((port) => port >= 1024 && port <= 65535)
let port = 0
for (const candidate of candidates) {
  if (await probe(candidate)) { port = candidate; break }
}
if (!port) {
  console.log('找不到运行中的面板路由。先确认 GUI 开着，或手动传端口：node smoke-live.mjs 50838')
  process.exit(2)
}
console.log(`\n对活着的宿主自检（端口 ${port}）\n`)

// ---- 只读路由全扫：每一条都该 200，且形状对 ----
const status = await get(port, '/status')
const workspace = status.json?.value?.workspace ?? ''
check('/status 认出工作区', workspace.endsWith('sly'), workspace)
const counts = status.json?.value?.counts ?? {}
check('/status 数得出笔记', Number(counts.personal) > 0, JSON.stringify(counts))

const tree = await get(port, '/tree?scope=personal,memory,project')
const docs = tree.json?.value?.docs ?? []
check('/tree 列出三类文档', docs.length > 40, `${docs.length} 篇`)
check('/tree 每篇都带 dir 与 mtime', docs.every((doc) => typeof doc.dir === 'string' && doc.mtime), '')

const timeline = await get(port, '/timeline?refresh=1')
const days = timeline.json?.value?.days ?? []
check('/timeline 有日记天', days.length > 0, `${days.length} 天`)
check('/timeline 每天带 todos 数组', days.every((day) => Array.isArray(day.todos)), '')

if (docs.length > 0) {
  const target = docs.find((doc) => doc.path.startsWith('personal/')) ?? docs[0]
  const doc = await get(port, `/doc?path=${encode(target.path)}`)
  const value = doc.json?.value ?? {}
  check('/doc 读得到正文', typeof value.text === 'string' && value.text.length > 0, target.path)
  check('/doc 带指纹与 mtime', typeof value.hash === 'string' && Number(value.mtimeMs) > 0, `hash=${value.hash}`)
}

const search = await get(port, `/search?q=${encode('止损线')}&topK=6`)
const hits = search.json?.value?.hits ?? []
check('/search 有命中', hits.length > 0, `${hits.length} 条 · ${search.json?.value?.ms} ms`)
check('/search 每条带路径与分数', hits.every((hit) => hit.path && Number.isFinite(hit.score)), '')

for (const kind of ['note', 'state', 'clue']) {
  const only = await get(port, `/search?q=${encode('止损线')}&only=${kind}`)
  const value = only.json?.value ?? {}
  check(`/search?only=${kind} 生效`, only.status === 200 && value.only === kind, JSON.stringify({ only: value.only, n: (value.hits ?? []).length }))
}

const state = await get(port, '/state')
check('/state 八张表齐全', ['queries', 'stars', 'ui', 'used', 'wait', 'next', 'moved', 'clues'].every((key) => key in (state.json?.value ?? {})), Object.keys(state.json?.value ?? {}).join(','))
const exportState = await get(port, '/state/export')
check('/state/export 标出版本', Number(exportState.json?.value?.v) >= 2, `v=${exportState.json?.value?.v}`)

const clues = await get(port, '/clues?limit=5')
check('/clues 带索引页候选', Array.isArray(clues.json?.value?.indexPages) && clues.json.value.indexPages.length > 0, `${(clues.json?.value?.indexPages ?? []).length} 个目录页`)
const visited = await get(port, '/visited?limit=5')
check('/visited 可用', Array.isArray(visited.json?.value?.items), `${(visited.json?.value?.items ?? []).length} 篇`)
const experiments = await get(port, '/experiments?limit=3')
check('/experiments 可用', Array.isArray(experiments.json?.value?.items), '')

const audit = await get(port, '/audit')
const auditValue = audit.json?.value ?? {}
check('/audit 体检可用', audit.status === 200 && typeof auditValue.counts?.total === 'number', `notes=${auditValue.notes} issues=${auditValue.counts?.total}`)
check('/audit 默认只看 personal', (auditValue.topics ?? []).every((topic) => String(topic).startsWith('personal')), (auditValue.topics ?? []).join(' '))

const debug = await get(port, '/debug/client')
const mentions = debug.json?.value?.mentions ?? {}
check('/debug/client 证明本插件在模块图里', mentions.loadedInGraph === true, `rev=${mentions.rev}`)

// ---- 越权与坏输入：这些必须被拒绝，而不是「顺手读了」 ----
const traversal = await get(port, `/doc?path=${encode('../../../etc/passwd')}`)
check('目录穿越被拒', traversal.status === 403, `status=${traversal.status}`)
const escape = await get(port, `/doc?path=${encode('personal/../AGENTS.md')}`)
check('逃出白名单被拒', escape.status === 403, `status=${escape.status}`)
const empty = await get(port, '/unknown-route')
check('未知路由回 404', empty.status === 404, `status=${empty.status}`)

const usage = status.json?.value?.usage ?? {}
console.log(`\n统计：召回 ${status.json?.value?.stats?.recalls ?? 0} 次 · 命中 ${status.json?.value?.stats?.hits ?? 0} 篇 · 命中率 ${usage.rate === null ? '—' : `${usage.rate}%`} · 日记 ${counts.diaries ?? 0} 天 · 未完成 ${counts.openTodos ?? 0} 条`)

if (failures > 0) {
  console.log(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\nlive smoke: 全部通过 ✓')
