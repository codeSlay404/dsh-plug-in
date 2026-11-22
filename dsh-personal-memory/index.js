/**
 * dsh-personal-memory —— 个人记忆面板（host 半）+ 每轮自动召回。
 *
 * 两件事：
 * 1. 召回：在模型开始思考之前，把「和用户这句话最接近的既往笔记」塞进上下文。
 * 2. 面板数据：把磁盘上的三层记录（personal/ 认知、memory/ 时间长河、project/ 产物）
 *    变成一组只读（外加一个只追加的速记）的 HTTP 接口，供 client 半整页面板用。
 *
 * 设计取舍：
 * - 不新建存储、不复制笔记。真相源永远是磁盘上的 md；这里是派生层，随时可丢。
 * - 检索走本地常驻服务 ctx-server（launchd 托管，127.0.0.1:17878），它包装 contextdb、
 *   模型预热常驻内存。索引在哪、怎么切块、怎么算分全归它管；这里只负责
 *   「什么时候查、查什么、注入多少」。
 * - 不依赖 dsh-knowledge：它每次会话重启被 pnpm prune 掉，且中文检索要额外配向量模型。
 * - 只在 agent/pre-step 触发。systemPrompt 的 PromptContext 拿不到用户消息文本，
 *   拿不到文本就没法做召回。
 * - 同一个用户消息只处理一次；同一份文档在一次会话里只注入一次。
 *   否则多轮之后上下文会被同一批笔记灌满。
 * - 任何异常都放过：召回是可选的增益，绝不能挡住正常对话。
 * - 工作区不在 process.cwd()（DSH 由 GUI 启动），所以靠 workingDirectory 服务 +
 *   向上找「同时有 personal/ 和 memory/ 的目录」来定位，config.workspace 可显式覆盖。
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { appendFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { guardOptions, isTrustedRequest } from './guard.js'

export const name = 'personal-memory'
/** webServer 给面板提供数据接口；workingDirectory 用来定位工作区（DSH 的 cwd 不是工作区）。 */
export const inject = ['webServer', 'workingDirectory', 'workspaceRegistry']

const SOURCE_KIND = 'plugin:dsh-personal-memory'
const MARKER_RE = /<!--\s*pm-ids:([^>]*?)\s*-->/
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const LOG_FILE = join(DSH_HOME, 'logs', 'personal-memory.jsonl')
const LOG_MAX_LINES = 3000
const LOG_BEACON_KEEP = 200
let logWrites = 0
// stage:rev → 是否已记过（只为压掉 HMR 重复打点）
const beaconSeen = new Map()
// 配置片段要指向真正在跑的那份 profile，不能写死 desktop
const PROFILE_DIR = (() => {
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR
  const name = process.env.DSH_PROFILE
  return name ? join(DSH_HOME, 'profiles', name) : ''
})()

/** 找「真正在跑、而且确实带本插件」的那份 profile 配置：写死 desktop 会在别的 profile 上指错文件 */
async function resolveProfileFile() {
  if (PROFILE_DIR) return join(PROFILE_DIR, 'cordis.patch.yml')
  try {
    const profilesDir = join(DSH_HOME, 'profiles')
    const names = await readdir(profilesDir)
    for (const name of names) {
      // 插件可能是通过 profile 的 package.json / bundle 装进来的，patch 文件里不一定有名字
      try {
        const pkg = await readFile(join(profilesDir, name, 'package.json'), 'utf8')
        if (!pkg.includes('dsh-personal-memory')) continue
        const file = join(profilesDir, name, 'cordis.patch.yml')
        await stat(file)
        return file
      } catch { /* 这份 profile 没装本插件就跳过 */ }
    }
  } catch { /* 没有 profiles 目录就返回空 */ }
  return ''
}
const CTX_SERVER = 'http://127.0.0.1:17878'
// 词面检索用的全文缓存：path → {key: mtimeMs, text}。纯派生数据，删掉不丢信息。
const TEXT_CACHE = new Map()

/** patch 里只写了关心的字段，其余走默认。 */
const DEFAULTS = {
  /** 总开关。 */
  enabled: true,
  /** 只查这一个知识库；留空 = 查所有库。 */
  baseId: '',
  /** 注入几条。 */
  topK: 4,
  /** 检索模式：hybrid | vector | lexical。中文必须 hybrid 或 vector。 */
  mode: 'hybrid',
  /** 用 MMR 打散结果，避免十几块全来自同一篇笔记。 */
  mmr: true,
  /** 低于这个分数的命中直接丢掉（RRF 融合分，0~1）。 */
  threshold: 0.12,
  /** 每条命中保留多少字的正文。 */
  excerptChars: 260,
  semanticSnippetRatio: 0.55,
  /** 一次注入的总字数上限。 */
  maxChars: 1600,
  /** 用户消息短于这个长度就不查（「好」「继续」这类不值得召回）。 */
  minQueryChars: 6,
  /** 送进检索的查询最多截多少字。 */
  maxQueryChars: 300,
  /** 检索超时（毫秒），超过就当这次没召回。 */
  timeoutMs: 2500,
  /** 一次会话里最多注入多少份文档。 */
  perSessionDocLimit: 12,
  /** 面板里一次检索最多返回几条。 */
  panelTopK: 12,
  /** 面板目录缓存时间（毫秒）。磁盘改动用刷新按钮或超过这个时间后重新扫。 */
  cacheMs: 2000,
  /** 工作区绝对路径。留空 = 自动找（workingDirectory → cwd → 逐级向上找 personal/+memory/）。 */
  workspace: '',
  /** 允许面板「速记」往今天的长河里追加一行。 */
  quickNote: true,
  /** 速记后自动热重建 contextdb 索引，让召回立刻跟上。 */
  autoReindex: true,
  /** 写调试日志到 ~/.dsh/logs/personal-memory.jsonl。 */
  debug: false,
  log: true,
}

const NUMBER_KEYS = new Set(['topK', 'threshold', 'excerptChars', 'semanticSnippetRatio', 'maxChars', 'minQueryChars', 'maxQueryChars', 'timeoutMs', 'perSessionDocLimit', 'panelTopK', 'cacheMs'])
const BOOLEAN_KEYS = new Set(['enabled', 'mmr', 'debug', 'log', 'quickNote', 'autoReindex'])

function readConfig(raw) {
  const cfg = { ...DEFAULTS }
  if (!raw || typeof raw !== 'object') return cfg
  for (const key of Object.keys(DEFAULTS)) {
    const given = raw[key]
    if (given === undefined || given === null) continue
    if (NUMBER_KEYS.has(key)) cfg[key] = Number(given)
    else if (BOOLEAN_KEYS.has(key)) cfg[key] = Boolean(given)
    else cfg[key] = String(given)
  }
  if (!Number.isFinite(cfg.topK) || cfg.topK < 1) cfg.topK = DEFAULTS.topK
  // 比例写成 0 会把语义摘录压到只剩 60 字，写成负数/NaN 会算出奇怪的长度：夹到 0.2–1
  if (!Number.isFinite(cfg.semanticSnippetRatio) || cfg.semanticSnippetRatio <= 0) cfg.semanticSnippetRatio = DEFAULTS.semanticSnippetRatio
  cfg.semanticSnippetRatio = Math.min(1, Math.max(0.2, cfg.semanticSnippetRatio))
  if (!Number.isFinite(cfg.timeoutMs) || cfg.timeoutMs <= 0) cfg.timeoutMs = DEFAULTS.timeoutMs
  if (!Number.isFinite(cfg.panelTopK) || cfg.panelTopK < 1) cfg.panelTopK = DEFAULTS.panelTopK
  if (!Number.isFinite(cfg.cacheMs) || cfg.cacheMs < 0) cfg.cacheMs = DEFAULTS.cacheMs
  return cfg
}

/** 消息里的纯文本；非文本块（图片等）忽略。 */
function textOf(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/**
 * 会话里最后一条真人消息。
 *
 * 不用 `decision.messages`：那是「这一步新进来」的消息，turn 中途的步是空的，
 * 而召回需要的是「用户刚刚问了什么」。会话事件里才有完整、权威的记录。
 * 真人的消息 source.kind 是 'user'；其余 user 角色消息是 time-context /
 * runtime-context / agent-instructions / skill-catalog 这类系统代打，一律跳过。
 */
function latestUserEvent(session) {
  const events = session?.snapshotEvents?.() ?? session?.events ?? []
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type !== 'user/message') continue
    const message = event.data
    if (message?.source?.kind !== 'user') continue
    const text = textOf(message).trim()
    if (text) return { id: message.id ?? text, text }
  }
  return undefined
}

/** 会话里已经注入过的文档 id —— 用来避免同一份笔记反复出现。 */
function alreadyInjected(session) {
  const seen = new Set()
  const events = session?.snapshotEvents?.() ?? session?.events ?? []
  for (const event of events) {
    if (event?.type !== 'user/message') continue
    const message = event.data
    if (message?.source?.kind !== SOURCE_KIND) continue
    const match = MARKER_RE.exec(textOf(message))
    if (!match) continue
    for (const id of match[1].split(',')) {
      const trimmed = id.trim()
      if (trimmed) seen.add(trimmed)
    }
  }
  return seen
}

function compact(text, limit) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms)
  if (!signal) return timeout
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : signal
}

/**
 * 调本地常驻检索服务 ctx-server。返回与旧 knowledge.search 对齐的 hits 结构，
 * 这样下面的筛选/注入逻辑几乎不用动。
 * 超时放宽到 config.timeoutMs（本地服务热查询只要几十毫秒，留足余量）。
 */
async function localSearch(query, cfg, topK, signal) {
  const res = await fetch(`${CTX_SERVER}/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, topK }),
    signal: signal ?? AbortSignal.timeout(cfg.timeoutMs),
  })
  if (!res.ok) throw new Error(`ctx-server HTTP ${res.status}`)
  const env = await res.json()
  if (env.ok !== true) throw new Error(env.error ?? 'ctx-server 检索失败')
  const value = env.value ?? {}
  return {
    mode: value.mode ?? 'vector',
    hits: (value.hits ?? []).map((h) => ({
      docId: h.docId,
      documentTitle: h.title,
      heading: h.heading,
      text: h.text,
      score: typeof h.score === 'number' ? h.score : 0,
      path: h.path,
    })),
  }
}

function renderBlock(rows) {
  const lines = [
    '【记忆召回 · 自动】下面是本工作区笔记里与你这句话最接近的既往记录（来自本地 contextdb 索引，可能已过时或已被推翻，用之前先核对原文）：',
  ]
  rows.forEach((row, index) => {
    const heading = row.heading ? ` › ${row.heading}` : ''
    // 来源标记：`[原话]` 表示正文里真的出现过这几个字（不是语义猜的）；
    // 纯语义的不标，避免每行都多一段噪音。
    const origin = row.via === 'keyword' ? ' ·[原话]' : row.via === 'both' ? ' ·[原话+语义]' : ''
    lines.push(`${index + 1}. 《${row.title}》${heading}（score ${row.score.toFixed(3)}${origin}）`)
    lines.push(`   ${row.excerpt}`)
    if (row.path) lines.push(`   原文：${row.path}`)
  })
  lines.push('—— 以上由 dsh-personal-memory 自动注入，不是用户发言；需要更多时用 `ctx search "问题"`。')
  lines.push(`<!--pm-ids:${rows.map((row) => row.docId).join(',')}-->`)
  return lines.join('\n')
}

function injectionMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: SOURCE_KIND, form: 'recall' },
  }
}

async function writeLog(cfg, entry) {
  if (!cfg.log) return
  try {
    await mkdir(dirname(LOG_FILE), { recursive: true })
    await appendFile(LOG_FILE, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch {
    /* 日志写不了不影响主流程 */
    return
  }
  logWrites += 1
  // beacon 是排障用的、量又大（每次 HMR 三条），攒多了会把召回行挤出读取窗口，
  // 面板就会显示「累计召回 0」——所以定期清掉旧 beacon，保留最近 200 条
  if (logWrites % 50 === 0) void pruneLog()
}

/** 日志瘦身：超过上限时只丢 client-beacon，召回/mounted 这些信号一条不动 */
async function pruneLog() {
  try {
    const text = await readFile(LOG_FILE, 'utf8')
    const lines = text.split('\n').filter((line) => line.trim())
    if (lines.length <= LOG_MAX_LINES) return
    const keep = []
    const beacons = []
    for (const line of lines) {
      try {
        if (JSON.parse(line).event === 'client-beacon') beacons.push(line)
        else keep.push(line)
      } catch { /* 坏行直接丢 */ }
    }
    await writeFile(LOG_FILE, [...keep, ...beacons.slice(-LOG_BEACON_KEEP)].join('\n') + '\n', 'utf8')
  } catch { /* 瘦身失败不影响主流程 */ }
}

/**
 * 给召回行标「后来有没有被用上」。
 * 判断很保守：这一篇的打开时间晚于那次召回的时间，才算用上（不做会话归属猜测）。
 */
async function markUsage(workspace, rows) {
  if (!workspace || rows.length === 0) return rows
  let used = {}
  try {
    used = (await readPanelState(workspace)).used ?? {}
  } catch {
    return rows
  }
  if (Object.keys(used).length === 0) return rows
  return rows.map((row) => {
    const recalledAt = Date.parse(row.at ?? '') || 0
    const items = Array.isArray(row.items) ? row.items : []
    let usedCount = 0
    const marked = items.map((item) => {
      const at = Number(used[item.path]?.at ?? used[item.path] ?? 0)
      const hit = at > 0 && at >= recalledAt
      if (hit) usedCount += 1
      return hit ? { ...item, used: true, usedAt: at } : item
    })
    return { ...row, items: marked, usedCount }
  })
}

/**
 * 近 days 天的召回命中率：注入篇数 / 其中后来被打开的篇数。
 * 只统计带 items 的新日志（老日志没有路径，算进来会把分母撑大、把命中率压低）。
 */
function usageOf(rows, days, rollup) {
  const span = Math.max(1, Number(days) || 7)
  const since = Date.now() - span * 86400000
  // 有日汇总就优先用它：日志里的明细会被清理，汇总不会
  const rollupRecalls = rollup && Object.keys(rollup).length > 0
    ? Object.entries(rollup).reduce((sum, [day, row]) => (Date.parse(`${day}T00:00:00`) < since - 86400000 ? sum : sum + (Number(row.recalls) || 0)), 0)
    : 0
  const rollupInjected = rollup && Object.keys(rollup).length > 0
    ? Object.entries(rollup).reduce((sum, [day, row]) => (Date.parse(`${day}T00:00:00`) < since - 86400000 ? sum : sum + (Number(row.injected) || 0)), 0)
    : 0
  let recalls = 0
  let injected = 0
  let used = 0
  for (const row of rows ?? []) {
    const at = Date.parse(row?.at ?? '') || 0
    if (!at || at < since) continue
    // 召回次数照数（老日志没有 items，但「召回过」这件事是确定的）；
    // 注入篇数和「被打开」只能从明细里算，没有明细就不参与命中率
    recalls += 1
    const items = Array.isArray(row.items) ? row.items.filter((item) => item && item.path) : []
    if (items.length === 0) continue
    injected += items.length
    used += items.filter((item) => item.used === true).length
  }
  // 汇总只覆盖「召回了多少」；「后来被打开多少」只能从日志明细里数（items[].used）
  if (rollupRecalls > recalls) {
    return {
      days: span,
      recalls: rollupRecalls,
      injected: Math.max(injected, rollupInjected),
      used,
      rate: Math.max(injected, rollupInjected) > 0 ? Math.round((used / Math.max(injected, rollupInjected)) * 100) : null,
      source: 'rollup',
    }
  }
  return {
    days: span,
    recalls,
    injected,
    used,
    // 没有样本就是 null，不要用 0% 冒充「召回了但都没用」
    rate: injected > 0 ? Math.round((used / injected) * 100) : null,
    source: 'log',
  }
}

/** 读最近的召回日志给面板用；坏行跳过，只留最后 limit 条。 */
// 「下一步 / 在等什么 / 为什么挪」是面板自己的状态表（.dsh/personal-memory/state.json），
// 不在任何 .md 里——但它们正是「我脑子里还在转的事」，检索不该只在正文里找。
// 状态表的 key 只有待办正文，落点路径要回日记里查一次，命中才能点开定位。
function stateKindLabel(kind) {
  if (kind === 'next') return '下一步'
  if (kind === 'wait') return '在等'
  if (kind === 'moved') return '改期'
  return '待办'
}

/**
 * 线索也进检索：`- 想找：X` 这一行本身就是「我搜过、没搜到」的记录。
 * 搜「止损线」时它最该出现——它说明的不是「有这篇笔记」，而是「这个缺口还开着」。
 */
async function clueHits(workspace, cache, cfg, q, scopes, limit) {
  if (!workspace) return []
  const needle = String(q ?? '').trim().toLowerCase()
  if (needle.length < 2) return []
  let panelState
  try { panelState = await readPanelState(workspace) } catch { panelState = { clues: {} } }
  const clues = panelState?.clues ?? {}
  const out = []
  let docs = []
  try { docs = await scanWorkspace(workspace, cache, cfg) } catch { return [] }
  for (const doc of docs) {
    if (scopes.length > 0 && !scopes.includes(doc.scope)) continue
    let text = ''
    try {
      const absPath = join(workspace, doc.path)
      const stats = await stat(absPath)
      const key = String(stats.mtimeMs)
      const cached = TEXT_CACHE.get(absPath)
      if (cached && cached.key === key) text = cached.text
      else {
        text = await readFile(absPath, 'utf8')
        TEXT_CACHE.set(absPath, { key, text })
      }
    } catch { continue }
    const lines = String(text ?? '').split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const match = /^\s*-\s*想找[:：]\s*(.+)$/.exec(lines[index])
      if (!match) continue
      const body = String(match[1] ?? '').trim()
      if (!body || !body.toLowerCase().includes(needle)) continue
      const entry = clues[`${doc.path}\u0000${body}`]
      out.push({
        docId: `clue:${doc.path}:${index + 1}`,
        title: `线索 · ${doc.title ?? doc.name ?? ''}`,
        heading: '',
        score: 0.82,
        path: doc.path,
        excerpt: body,
        via: 'clue',
        clueKind: CLUE_KINDS.includes(entry?.kind) ? entry.kind : 'find',
        line: index + 1,
      })
      if (out.length >= Math.max(1, limit)) return out
    }
  }
  return out
}

async function stateHits(workspace, cache, cfg, q, scopes, limit) {
  if (!workspace) return []
  const needle = String(q ?? '').trim().toLowerCase()
  if (needle.length < 2) return []
  // 待办只存在于日记里：调用方限定到别的范围时就不该混进来
  if (scopes.length > 0 && !scopes.includes('memory')) return []
  let state
  try {
    state = await readPanelState(workspace)
  } catch {
    return []
  }
  const matched = []
  for (const [text, next] of Object.entries(state.next ?? {})) {
    if (String(text).toLowerCase().includes(needle) || String(next).toLowerCase().includes(needle)) {
      matched.push({ kind: 'next', text, note: String(next ?? '') })
    }
  }
  for (const [text, wait] of Object.entries(state.wait ?? {})) {
    if (!String(text).toLowerCase().includes(needle)) continue
    const kind = typeof wait === 'string' ? wait : wait?.kind
    matched.push({ kind: 'wait', text, note: WAIT_KINDS.includes(kind) ? `等${kind === 'market' ? '行情' : kind === 'reply' ? '人回' : '决定'}` : '' })
  }
  for (const [text, chain] of Object.entries(state.moved ?? {})) {
    const notes = (Array.isArray(chain) ? chain : []).map((step) => String(step?.note ?? '')).filter(Boolean)
    const hitNote = notes.find((note) => note.toLowerCase().includes(needle))
    if (!String(text).toLowerCase().includes(needle) && !hitNote) continue
    matched.push({ kind: 'moved', text, note: hitNote ?? notes[notes.length - 1] ?? '' })
  }
  if (matched.length === 0) return []
  let docs = []
  try {
    docs = await scanWorkspace(workspace, cache, cfg)
  } catch {
    return []
  }
  const where = new Map()
  for (const doc of docs) {
    if (doc.scope !== 'memory') continue
    for (const item of doc.diary?.todos ?? []) if (!where.has(item.text)) where.set(item.text, { path: doc.path, date: doc.file, section: item.section })
  }
  const out = []
  const seen = new Set()
  for (const row of matched) {
    const at = where.get(row.text)
    if (!at) continue
    const key = `${at.path}|${row.kind}|${row.text}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      docId: `state:${row.kind}:${row.text.slice(0, 40)}`,
      title: `${stateKindLabel(row.kind)} · ${at.date}`,
      heading: at.section ?? '',
      score: 0.9,
      path: at.path,
      excerpt: row.note,
      via: 'state',
      stateKind: row.kind,
      stateText: row.text,
    })
  }
  return out.slice(0, Math.max(1, limit))
}

async function keywordHits(workspace, cache, cfg, q, scopes, limit) {
  if (!workspace) return []
  const docs = await scanWorkspace(workspace, cache, cfg)
  const tokens = q.toLowerCase().split(/\s+/).filter((token) => token.length >= 2)
  if (tokens.length === 0) return []
  // scopes 传 null 表示「全范围」——之前这里直接读 .length，null 会抛 TypeError，
  // 又被上层 catch 吞成「没有词面命中」，表现是混合召回静默失效
  const scopeList = Array.isArray(scopes) ? scopes : []
  const rows = []
  for (const doc of docs) {
    if (scopeList.length > 0 && !scopeList.includes(doc.scope)) continue
    // 只搜标题/路径/摘录会漏掉正文里的精确 token（股票代码、端口号），
    // 所以按 mtime 缓存全文再比；45 篇 × 几 KB，第一次之后就是内存比对。
    const absPath = join(workspace, doc.path)
    let text = ''
    try {
      const stats = await stat(absPath)
      const key = String(stats.mtimeMs)
      const cached = TEXT_CACHE.get(absPath)
      if (cached && cached.key === key) text = cached.text
      else {
        text = await readFile(absPath, 'utf8')
        TEXT_CACHE.set(absPath, { key, text })
      }
    } catch {
      text = doc.excerpt ?? ''
    }
    const hay = `${doc.title} ${doc.path} ${text}`.toLowerCase()
    if (!tokens.every((token) => hay.includes(token))) continue
    // 摘录别以标题行开头：注入块里已经有《标题》，再贴一行 `# 标题` 是噪音
    const body = text.replace(/^(\s*#+[^\n]*\n)+\s*/, '')
    const at = body.toLowerCase().indexOf(tokens[0])
    const from = Math.max(0, at - 90)
    rows.push({
      docId: doc.path,
      title: doc.title,
      heading: '',
      score: 0.95,
      path: doc.path,
      mtimeMs: Number(doc.mtimeMs) || Date.parse(doc.mtime) || 0,
      excerpt: compact(String(body).slice(from, from + Math.max(cfg.excerptChars, 320)), Math.max(cfg.excerptChars, 320)),
      via: 'keyword',
    })
    if (rows.length >= limit) break
  }
  return rows
}

async function readLog(limit = 100) {
  try {
    const text = await readFile(LOG_FILE, 'utf8')
    const rows = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        rows.push(JSON.parse(line))
      } catch {
        /* 半行/坏行跳过 */
      }
    }
    return rows.slice(-Math.max(1, Math.min(limit, 5000))).reverse()
  } catch {
    return []
  }
}

/* ------------------------------------------------------------------ *
 * 工作区定位
 * ------------------------------------------------------------------ */

/** 面板能读的三层；也决定了 /doc 的路径白名单。 */
const SCOPES = ['personal', 'memory', 'project']
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv-ctx', '.digest', '.dsh', 'dist', 'build', 'out', '.cache', '__pycache__', '.next', 'target'])
const MAX_WALK_DEPTH = 7
const MAX_DOC_BYTES = 512 * 1024

let cachedWorkspace = null
// 同一进程里工作区只解析一次、且按「第一条显式线索」记住结果：
// 否则线索目录里某些子目录（如 memory/）临时不存在时会一路往上走到 cwd，
// 解析结果在进程内漂移到别的目录（2026-11-22 测试写坏真实工作区就是这个路径）。
const workspaceCache = new Map()

function looksLikeWorkspace(dir) {
  try {
    return existsSync(join(dir, 'personal')) && existsSync(join(dir, 'memory'))
  } catch {
    return false
  }
}

/**
 * 定位工作区。DSH 的 process.cwd() 是 GUI 进程的工作目录，不一定是用户的工作区，
 * 所以顺序是：config → env → workingDirectory 服务 → cwd，然后每一级都向上找
 * 「同时有 personal/ 和 memory/ 的目录」。找不到就返回 null（面板会显示提示而不是报错）。
 */
function resolveWorkspace(ctx, cfg) {
  const firstSeed = [cfg?.workspace, process.env.DSH_PERSONAL_MEMORY_WORKSPACE, process.env.DSH_WORKSPACE, ctx?.workingDirectory?.defaultDirectory]
    .find((value) => typeof value === 'string' && value.trim())
  if (firstSeed && workspaceCache.has(firstSeed.trim())) return workspaceCache.get(firstSeed.trim())
  const seeds = []
  const push = (value) => {
    if (typeof value === 'string' && value.trim()) seeds.push(value.trim())
  }
  push(cfg.workspace)
  push(process.env.DSH_PERSONAL_MEMORY_WORKSPACE)
  push(process.env.DSH_WORKSPACE)
  try {
    push(ctx?.workingDirectory?.defaultDirectory)
  } catch {
    /* 服务没就绪就当没配 */
  }
  // 工作区注册表：GUI 里开过的目录，通常是用户真正在用的那个
  try {
    const registry = ctx?.workspaceRegistry
    if (registry && typeof registry.list === 'function') {
      for (const entry of registry.list() ?? []) {
        push(entry?.path ?? entry?.directory ?? entry?.root)
      }
    }
  } catch {
    /* 注册表不可用就当没配 */
  }
  // 最后一条兜底：环境变量里可能带着工作区
  push(process.env.DSH_WORKSPACE_ROOT)
  push(process.env.DSH_CWD)
  push(process.cwd())
  const seen = new Set()
  for (const seed of seeds) {
    let dir = resolve(seed)
    for (let depth = 0; depth < 8; depth += 1) {
      if (seen.has(dir)) break
      seen.add(dir)
      if (looksLikeWorkspace(dir)) {
        cachedWorkspace = dir
        workspaceCache.set((firstSeed ?? seed).trim(), dir)
        return dir
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return null
}

/* ------------------------------------------------------------------ *
 * Markdown 扫描与解析（只读，派生态）
 * ------------------------------------------------------------------ */

async function collectMarkdown(dir, out, depth = 0) {
  if (depth > MAX_WALK_DEPTH) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await collectMarkdown(full, out, depth + 1)
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full)
    }
  }
}

function weekdayOf(date) {
  const parsed = new Date(`${date}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return ''
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][parsed.getDay()] ?? ''
}

function firstHeading(text) {
  for (const line of text.split('\n')) {
    const match = /^#{1,3}\s+(.+)$/.exec(line.trim())
    if (match) return match[1].trim()
  }
  return ''
}

/** `更新: 2026-11-19` / `来源: xxx` 这类约定行 —— personal/AGENTS.md 要求每条都带。 */
function metaOf(text) {
  const meta = { updated: '', source: '' }
  for (const line of text.split('\n').slice(0, 24)) {
    const match = /^\s*[-*]?\s*(更新|来源)\s*[:：]\s*(.+)$/.exec(line)
    if (!match) continue
    if (match[1] === '更新' && !meta.updated) meta.updated = match[2].trim()
    if (match[1] === '来源' && !meta.source) meta.source = match[2].trim()
  }
  return meta
}

function tocOf(text) {
  const toc = []
  let offset = 0
  for (const line of text.split('\n')) {
    const match = /^(#{1,4})\s+(.+)$/.exec(line)
    if (match) toc.push({ level: match[1].length, text: match[2].trim(), offset })
    offset += line.length + 1
  }
  return toc
}

/** 正文首段（跳过标题与元信息行），给列表做预览。 */
function excerptOf(text) {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('#')) continue
    if (/^(更新|来源)\s*[:：]/.test(trimmed)) continue
    if (trimmed.startsWith('|')) continue // 表格
    if (/^[-=]{3,}$/.test(trimmed)) continue
    return compact(trimmed.replace(/^[-*]\s+/, '').replace(/^\[[ x]\]\s*/, ''), 120)
  }
  return ''
}

/** 日记体（memory/YYYY/MM/YYYY-MM-DD.md）：按 `## 小节` 数条目、未完成项。 */
function diaryShape(text) {
  const sections = []
  let current = null
  let entries = 0
  let openTodos = 0
  let doneTodos = 0
  let preview = ''
  const todos = []
  let lineNo = 0
  for (const line of text.split('\n')) {
    lineNo += 1
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) {
      current = { name: heading[1], entries: 0, open: 0 }
      sections.push(current)
      continue
    }
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (!item) continue
    entries += 1
    if (current) current.entries += 1
    const check = /^\[([ xX])\]\s*(.*)$/.exec(item[1])
    if (check) {
      const done = Boolean(check[1].trim())
      const body = compact(check[2], 200)
      if (done) doneTodos += 1
      else {
        openTodos += 1
        if (current) current.open += 1
        if (!preview && check[2].trim()) preview = compact(check[2], 110)
      }
      if (todos.length < 60) todos.push({ done, text: body, section: current?.name ?? '', line: lineNo })
    } else if (!preview) {
      preview = compact(item[1].replace(/^\d{1,2}:\d{2}\s*/, ''), 110)
    }
  }
  return { sections, entries, openTodos, doneTodos, preview, todos }
}

function describeFile(absPath, workspace, text, stats) {
  const rel = workspace ? absPath.slice(workspace.length + 1).split(sep).join('/') : basename(absPath)
  const scope = rel.split('/')[0]
  const name = basename(absPath, '.md')
  const isDiary = /^\d{4}-\d{2}-\d{2}$/.test(name)
  const lineCount = text ? text.split('\n').length : 0
  const doc = {
    path: rel,
    scope,
    dir: dirname(rel).split(sep).join('/'),
    name: isDiary ? name : (firstHeading(text) || name),
    file: name,
    title: firstHeading(text) || name,
    bytes: stats?.size ?? Buffer.byteLength(text, 'utf8'),
    mtime: stats?.mtime ? stats.mtime.toISOString() : null,
    lines: lineCount,
    chars: text.length,
    excerpt: text ? excerptOf(text) : '',
    meta: text ? metaOf(text) : { updated: '', source: '' },
  }
  if (isDiary) doc.diary = text ? diaryShape(text) : { sections: [], entries: 0, openTodos: 0, doneTodos: 0, preview: '', todos: [] }
  return doc
}

/** 目录索引结果缓存：面板切 tab / 反复点文件时不要每次重扫磁盘。 */
function createCache(cfg) {
  return { at: 0, workspace: null, docs: null, locked: null }
}

async function scanWorkspace(workspace, cache, cfg, force) {
  const now = Date.now()
  if (!force && cache.docs && cache.workspace === workspace && now - cache.at < cfg.cacheMs) return cache.docs
  if (cache.locked) return cache.locked
  cache.locked = (async () => {
    const files = []
    for (const scope of SCOPES) {
      const root = join(workspace, scope)
      if (!existsSync(root)) continue
      await collectMarkdown(root, files)
    }
    const docs = []
    for (const absPath of files) {
      try {
        const stats = await stat(absPath)
        if (stats.size > MAX_DOC_BYTES) continue
        const text = await readFile(absPath, 'utf8')
        docs.push(describeFile(absPath, workspace, text, stats))
      } catch {
        /* 单个文件读不了就跳过 */
      }
    }
    docs.sort((a, b) => (b.mtime ?? '').localeCompare(a.mtime ?? ''))
    return docs
  })()
  try {
    const docs = await cache.locked
    cache.docs = docs
    cache.workspace = workspace
    cache.at = Date.now()
    return docs
  } finally {
    cache.locked = null
  }
}

/**
 * 归一化面板传来的相对路径：去掉开头的斜杠、折叠 `.`、拒绝任何 `..` 段。
 * 只靠 resolve() 后比对前缀是不够的 —— `personal/../AGENTS.md` 会落在工作区内，
 * 但已经跑出了 personal/ 这个白名单目录。
 */
function normalizeRel(input) {
  if (typeof input !== 'string') return null
  const raw = input.trim().replace(/^[/\\]+/, '').split(/[/\\]+/).filter(Boolean)
  if (raw.length === 0) return null
  const out = []
  for (const part of raw) {
    if (part === '.') continue
    if (part === '..') return null
    out.push(part)
  }
  const rel = out.join('/')
  if (!rel.endsWith('.md')) return null
  return rel
}

/** /doc：读一篇全文 + 目录 + 元信息。路径必须落在白名单目录里，防目录穿越。 */
function safeDocPath(workspace, relPath) {
  if (typeof relPath !== 'string' || !relPath.trim()) return null
  const rel = normalizeRel(relPath)
  if (!rel) return null
  const scope = rel.split('/')[0]
  if (!SCOPES.includes(scope)) return null
  const abs = resolve(workspace, rel)
  if (!abs.startsWith(workspace + sep)) return null
  if (!existsSync(abs)) return null
  // 字面路径在工作区里还不够：中间目录或文件本身可能是指向外面的软链。
  if (!writePathAllowed(workspace, abs, { mustExist: true })) return null
  return { abs, rel: rel.split(sep).join('/') }
}

/* ------------------------------------------------------------------ *
 * 知识库体检的判据（只读）。跟 .dsh/skills/kb-audit 同一套，结果进面板。
 * ------------------------------------------------------------------ */

const AUDIT_HEAD_LINES = 24
// 更新与来源允许出现在引用块、列表、以及被反引号包起来的形式里——
// 这些写法在历史笔记里都真实存在过，别让格式差异变成「缺失」。
const META_UPDATED_RE = /^[\s>*`-]*更新\s*[:：]\s*(\d{4}-\d{2}-\d{2})/m
const META_SOURCE_RE = /^[\s>*`-]*来源\s*[:：]\s*\S/m

/** 读一篇笔记的全文，走 TEXT_CACHE（同一套 mtime 缓存，体检和检索不重复读盘）。 */
async function readDocText(workspace, relPath) {
  const found = safeDocPath(workspace, relPath)
  if (!found) return ''
  const absPath = found.abs
  const stats = await stat(absPath)
  const key = String(stats.mtimeMs)
  const cached = TEXT_CACHE.get(absPath)
  if (cached && cached.key === key) return cached.text
  const text = await readFile(absPath, 'utf8')
  TEXT_CACHE.set(absPath, { key, text })
  return text
}

/* ------------------------------------------------------------------ *
 * 面板自己的小状态：最近查询 + 星标。
 * 落在 <workspace>/.dsh/personal-memory/state.json，跟工作区走，不进 git 也不进索引。
 * 它只是「用起来方便」的派生数据：丢了不影响任何笔记。
 * ------------------------------------------------------------------ */

const STATE_REL = '.dsh/personal-memory/state.json'
const STATE_QUERY_CAP = 20
const STATE_STAR_CAP = 200
// 折叠偏好：哪个月份/分档/目录是收起的。多个面板共用一份，键形如 "month:2026-11"
const STATE_UI_CAP = 300
const STATE_UI_KEYS = ['collapsed', 'todoSort']
// 清单排序：今天新加的在前 / 最久没动的在前。两种都是合理诉求，别替人决定，记住就行
const TODO_SORTS = ['fresh', 'oldest']
// 检索结果排序：相关度 / 最近改过。查「止损线」要分数，查「11 月做了什么」要时间
const SEARCH_SORTS = ['score', 'recent']
// 「这篇被召回过，而且后来真的被打开了」——召回有没有用，只有这一个弱信号能自证
const STATE_USED_CAP = 200
const STATE_CLUES_CAP = 200
// 「这条线索我解决了」：key 是线索正文（不是行号——行号会随正文增删漂移）
const STATE_RESOLVED_CAP = 300
function clueKeyOf(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
}
/** resolved: { 线索正文: at } —— 「这页没改」和「我已经知道了」是两件事，得分开记。 */
function sanitizeResolved(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  const rows = Object.entries(raw)
    .filter(([key]) => typeof key === 'string' && key.length > 0 && key.length <= 80)
    .map(([key, value]) => ({ key, at: Math.max(0, Number(value) || Number(value?.at) || 0) }))
    .filter((row) => row.at > 0)
    .sort((a, b) => b.at - a.at)
    .slice(0, STATE_RESOLVED_CAP)
  for (const row of rows) out[row.key] = row.at
  return out
}
/** 补过线索的目录页，一周内不再当「翻过没动」提醒——不然刚补完又出现在同一张表上 */
const CLUE_QUIET_MS = 7 * 86400000
// 「这条线索想要什么」：想知道答案 / 想确认已有答案对不对 / 想找回原话出处。
// 同一句「想找：止损线怎么定」，前两种该去补索引，第三种该去翻旧日记——动作不同，得先分得开
const CLUE_KINDS = ['find', 'check', 'cite']
// 「这条在等什么」：等行情 / 等人回 / 等自己决定。key 用待办正文前 60 字，
// 所以改期挪到另一天之后标记还跟着走（行号会变，正文不会）
const STATE_WAIT_CAP = 300
const WAIT_KINDS = ['market', 'reply', 'decide']
// 「变成行动」时顺手写下的一步：key 与 wait 同一套（正文摘要），值是一句动词短语。
// 为什么要有：「不再等了」只是否定，人落地时还需要一个具体的下一动。
const STATE_NEXT_CAP = 200
// 日用量汇总（天 → {recalls, injected, used}）：日志是明细、会被清理，趋势不能只活在日志里
const STATE_USAGE_CAP = 60
// 挪过几次：待办被改期时留一条 {from, to, at}。同一个 key（正文摘要）累计，
// 所以一条老债挪了五周也认得出来——这是「为什么一直没做」唯一的客观证据
// 面板状态里能单独清空的表：导出/清空时按这个白名单，不认识的一律拒绝
const STATE_TABLES = ['queries', 'stars', 'ui', 'used', 'wait', 'next', 'moved', 'usage', 'clues', 'resolved']
// state.json 的版本。每次字段形状变了就 +1，并在 migrateState 里写清「旧形状 → 新形状」。
// 之前 wait 从字符串升级成 {kind, at} 时，是靠 sanitize 里顺手兼容的——那种隐式兼容散在八个
// sanitize 里，改一个字段要翻八处；有显式版本号之后，迁移集中在一个函数里，也能被断言钉住。
const STATE_VERSION = 2
const STATE_MOVED_CAP = 300
const STATE_MOVED_PER_KEY = 6

/** 改期链的清洗：只留 {from,to} 都是 YYYY-MM-DD 的条目，每条链最多 STATE_MOVED_PER_KEY 步 */
function sanitizeMoved(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  const day = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '')) ? String(value) : '')
  const rows = Object.entries(raw)
    .filter(([key, value]) => typeof key === 'string' && key.length > 0 && key.length <= 60 && Array.isArray(value))
    .slice(-STATE_MOVED_CAP)
  for (const [key, chain] of rows) {
    const steps = chain
      .map((step) => ({
        from: day(step?.from),
        to: day(step?.to),
        at: Number(step?.at) || 0,
        // 「为什么挪」只在人顺手写了的时候才有；不写就留空，不编
        note: typeof step?.note === 'string' ? step.note.replace(/\s+/g, ' ').trim().slice(0, 80) : '',
      }))
      .filter((step) => step.from && step.to)
      .slice(-STATE_MOVED_PER_KEY)
    if (steps.length > 0) out[key] = steps
  }
  return out
}

/** 日汇总的清洗：只留合法日期、非负整数，保留最近 STATE_USAGE_CAP 天 */
function sanitizeUsage(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  const num = (input) => (Number.isFinite(Number(input)) && Number(input) > 0 ? Math.floor(Number(input)) : 0)
  for (const [day, value] of Object.entries(raw)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
    if (!value || typeof value !== 'object') continue
    const recalls = num(value.recalls)
    if (recalls === 0) continue
    // chars 是「注入内容一共多少字」，不是「被打开几篇」——后者要靠日志里 items[].used 才算得出来
    out[day] = { recalls, injected: num(value.injected), chars: num(value.chars) }
  }
  const kept = Object.keys(out).sort().slice(-STATE_USAGE_CAP)
  const trimmed = {}
  for (const day of kept) trimmed[day] = out[day]
  return trimmed
}

/**
 * 把任意历史形状的 state.json 迁到当前版本。只做「形状」迁移，字段合法性仍交给各表的 sanitize。
 * v0（没有 v 字段）：
 *   - queries 是字符串数组  → {q, scope:'', days:0, only:'', at:0}
 *   - wait 是字符串 kind     → {kind, at:0}
 *   - ui 直接是 {key: bool}  → {collapsed: {key: bool}}
 * v1 → v2：只补版本号（形状已一致）
 */
function migrateState(raw) {
  const data = raw && typeof raw === 'object' ? raw : {}
  const from = Number.isFinite(Number(data.v)) ? Number(data.v) : 0
  // 每张表补了多少条：迁移要是可数的，不然它只是个传说
  const migrated = []
  let fixedQueries = 0
  const queries = Array.isArray(data.queries)
    ? data.queries.map((item) => {
      if (typeof item !== 'string') return item
      fixedQueries += 1
      return { q: item, scope: '', days: 0, only: '', at: 0 }
    })
    : []
  if (fixedQueries > 0) migrated.push({ table: 'queries', fixed: fixedQueries })
  let ui = data.ui && typeof data.ui === 'object' ? data.ui : {}
  if (ui && typeof ui === 'object' && !('collapsed' in ui) && !('todoSort' in ui) && !('searchSort' in ui)) {
    // 很老的一版把折叠偏好直接平铺在 ui 上
    const flat = {}
    for (const [key, value] of Object.entries(ui)) if (typeof value === 'boolean') flat[key] = value
    ui = { collapsed: flat }
    if (Object.keys(flat).length > 0) migrated.push({ table: 'ui', fixed: Object.keys(flat).length })
  }
  const wait = {}
  let fixedWait = 0
  const waitRaw = data.wait && typeof data.wait === 'object' ? data.wait : {}
  for (const [key, value] of Object.entries(waitRaw)) {
    if (typeof value === 'string') {
      fixedWait += 1
      wait[key] = { kind: value, at: 0 }
      continue
    }
    wait[key] = value
  }
  if (fixedWait > 0) migrated.push({ table: 'wait', fixed: fixedWait })
  return {
    v: STATE_VERSION,
    from,
    migrated,
    fixed: migrated.reduce((sum, item) => sum + item.fixed, 0),
    state: {
      queries,
      stars: Array.isArray(data.stars) ? data.stars : [],
      ui,
      used: data.used && typeof data.used === 'object' ? data.used : {},
      wait,
      next: data.next && typeof data.next === 'object' ? data.next : {},
      moved: data.moved && typeof data.moved === 'object' ? data.moved : {},
      usage: data.usage && typeof data.usage === 'object' ? data.usage : {},
      // 每加一张表都要在这里登记一次：migrateState 是重建 state 的唯一出口，
      // 漏一行不会报错，只会让那张表「写得进、读不回」（clues 就栽在这）
      clues: data.clues && typeof data.clues === 'object' ? data.clues : {},
      resolved: data.resolved && typeof data.resolved === 'object' ? data.resolved : {},
    },
  }
}

/** 每张表有几条：面板上要能看见「我攒了什么」，而不是只有一个打不开的 json */
function stateCounts(state) {
  const count = (value) => (value && typeof value === 'object' ? Object.keys(value).length : 0)
  return {
    queries: Array.isArray(state.queries) ? state.queries.length : 0,
    stars: Array.isArray(state.stars) ? state.stars.length : 0,
    ui: count(state.ui?.collapsed),
    used: count(state.used),
    wait: count(state.wait),
    next: count(state.next),
    moved: count(state.moved),
    usage: count(state.usage),
  }
}

/**
 * 清空指定的几张表（其余原样保留）。
 * 只认白名单里的表名——宁可拒绝，也不要让一次笔误把笔记相关的状态洗掉。
 */
async function clearPanelState(workspace, tables) {
  const want = Array.isArray(tables) ? tables.filter((name) => STATE_TABLES.includes(name)) : []
  if (want.length === 0) throw Object.assign(new Error(`要清空的表名必须是 ${STATE_TABLES.join(' / ')} 里的一或多张`), { statusCode: 400 })
  return withLock(`state:${workspace}`, async () => {
    const state = await readPanelState(workspace)
    const empty = { queries: [], stars: [], ui: {}, used: {}, wait: {}, next: {}, moved: {}, usage: {}, clues: {}, resolved: {} }
    for (const name of want) state[name] = empty[name]
    await writePanelState(workspace, state)
    return { cleared: want, state, counts: stateCounts(state) }
  })
}

/* ------------------------------------------------------------------ *
 * 写盘基础设施：串行化、原子写、真实路径裁决
 * ------------------------------------------------------------------ */

/**
 * 同一个 key 上的「读→改→写」串行执行。
 * 锁必须是事务级的：两个并发 /star 各自读到同一份旧 state，后写者就会覆盖前者，
 * 所以锁包住整次读改写，而不是只包住 writeFile。
 */
const writeLocks = new Map()

function withLock(key, fn) {
  const prev = writeLocks.get(key) ?? Promise.resolve()
  const run = prev.catch(() => {}).then(fn)
  writeLocks.set(key, run)
  return run.finally(() => {
    if (writeLocks.get(key) === run) writeLocks.delete(key)
  })
}

function withStateLock(workspace, fn) {
  return withLock(`state:${workspace}`, fn)
}

let tmpCounter = 0

/** 先写同目录临时文件再 rename：写到一半崩掉只会留下 .tmp，不会把原文件截成 0 字节。 */
async function atomicWrite(file, data) {
  const dir = dirname(file)
  await mkdir(dir, { recursive: true })
  tmpCounter += 1
  const tmp = join(dir, `.${basename(file)}.${process.pid}.${tmpCounter}.tmp`)
  try {
    await writeFile(tmp, data, 'utf8')
    await rename(tmp, file)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
}

/** 工作区的真实路径：macOS 上 /var、/tmp 都是软链，比较一律以真实路径为基准。 */
const realRootCache = new Map()

function realRootOf(workspace) {
  const key = resolve(workspace)
  if (realRootCache.has(key)) return realRootCache.get(key)
  let real = key
  try { real = realpathSync(key) } catch { /* 工作区还不存在：用字面路径 */ }
  realRootCache.set(key, real)
  return real
}

function isInsideRealRoot(workspace, realPath) {
  const root = realRootOf(workspace)
  return realPath === root || realPath.startsWith(root + sep)
}

/**
 * 写路径裁决：目标目录（realpath 后）必须还在工作区里；目标本身是软链一律拒
 * （悬空软链也要拒——existsSync 对它是 false，只有 lstat 看得见）。
 * 判定基准是「工作区的真实路径」，不是字面路径：否则工作区本身在软链下就全量误杀。
 */
/** 目标目录可能还没建（今天的第一条速记）：往上找到第一个存在的祖先，用它的真实路径做判定。 */
function realAncestorOf(abs) {
  let dir = dirname(abs)
  for (let step = 0; step < 64; step += 1) {
    try {
      return realpathSync(dir)
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') return null
      const up = dirname(dir)
      if (up === dir) return null
      dir = up
    }
  }
  return null
}

function writePathAllowed(workspace, abs, { mustExist = false } = {}) {
  if (!abs.startsWith(workspace + sep)) return false
  // 目录可能还不存在：用最近的既有祖先的真实路径判定，软链目录照样会被拆穿。
  const dirReal = realAncestorOf(abs)
  if (!dirReal) return false
  if (!isInsideRealRoot(workspace, dirReal)) return false
  let info = null
  try { info = lstatSync(abs) } catch { info = null }
  if (info) {
    if (info.isSymbolicLink()) return false
    if (!info.isFile()) return false
    return true
  }
  return !mustExist
}

/** 目录读写裁决：目录本身（realpath 后）必须还在工作区里。 */
function dirAllowed(workspace, dirAbs) {
  let real
  try { real = realpathSync(dirAbs) } catch { return null }
  return isInsideRealRoot(workspace, real) ? real : null
}

async function readPanelState(workspace) {
  try {
    const raw = await readFile(join(workspace, STATE_REL), 'utf8')
    const { state: data } = migrateState(JSON.parse(raw))
    return {
      queries: sanitizeQueries(data?.queries),
      stars: Array.isArray(data?.stars) ? data.stars.filter((x) => typeof x === 'string').slice(0, STATE_STAR_CAP) : [],
      ui: sanitizeUi(data?.ui),
      used: sanitizeUsed(data?.used),
      clues: sanitizeClues(data?.clues),
      resolved: sanitizeResolved(data?.resolved),
      wait: sanitizeWait(data?.wait),
      next: sanitizeNext(data?.next),
      usage: sanitizeUsage(data?.usage),
      moved: sanitizeMoved(data?.moved),
    }
  } catch {
    return { queries: [], stars: [], ui: {}, used: {}, wait: {}, next: {}, usage: {}, moved: {}, clues: {}, resolved: {} }
  }
}

/**
 * clues: { 相对路径: { at, text } } —— 目录页上补过的「想找：…」。
 * 它的作用不是记录内容（那段文字已经在笔记里了），而是「这一页最近补过，别再提醒我」。
 */
function sanitizeClues(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  const rows = Object.entries(raw)
    .filter(([key]) => typeof key === 'string' && key.length < 300)
    .map(([key, value]) => ({
      key,
      at: Math.max(0, Number(value?.at) || 0),
      text: String(value?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
      // 记下补完那一刻的文件指纹：之后这页变没变，比时间戳可靠（同一秒内多次写盘分不出来）
      hash: String(value?.hash ?? '').slice(0, 32),
      kind: CLUE_KINDS.includes(value?.kind) ? value.kind : 'find',
    }))
    .filter((row) => row.at > 0)
    .sort((a, b) => b.at - a.at)
    .slice(0, STATE_CLUES_CAP)
  for (const row of rows) out[row.key] = { at: row.at, text: row.text, hash: row.hash, kind: row.kind }
  return out
}

/**
 * used: { 相对路径: { at, dwell } }，按最近一次打开留最新 STATE_USED_CAP 条。
 * 老格式（值是毫秒时间戳）照读不误，迁移成 at + dwell:0 —— 「打开过」这件事没变，
 * 只是从这一版起才知道「停了多久」。
 */
function sanitizeUsed(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  const rows = Object.entries(raw)
    .filter(([key]) => typeof key === 'string' && key.length < 300)
    .map(([key, value]) => {
      const plain = Number(value)
      const at = Number.isFinite(plain) ? plain : Number(value?.at)
      const dwell = Math.max(0, Math.trunc(Number(value?.dwell) || 0))
      return { key, at: Number.isFinite(at) && at > 0 ? at : 0, dwell }
    })
    .filter((row) => row.at > 0)
    .sort((a, b) => b.at - a.at)
    .slice(0, STATE_USED_CAP)
  for (const row of rows) out[row.key] = { at: row.at, dwell: row.dwell }
  return out
}

/** 只留布尔值的、键名带 : 的折叠偏好，别把任意东西塞进 state.json */
function sanitizeUi(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  const collapsed = raw.collapsed
  let count = 0
  // 只传排序、不传折叠时也要能写进去（早返回会让 {todoSort} 这种补丁整个被吞掉）
  for (const [key, value] of Object.entries(collapsed && typeof collapsed === 'object' ? collapsed : {})) {
    if (count >= STATE_UI_CAP) break
    if (typeof key !== 'string' || key.length > 80) continue
    if (typeof value !== 'boolean') continue
    out[key] = value
    count += 1
  }
  const sort = raw.todoSort
  if (typeof sort === 'string' && TODO_SORTS.includes(sort)) out.todoSort = sort
  const searchSort = raw.searchSort
  if (typeof searchSort === 'string' && SEARCH_SORTS.includes(searchSort)) out.searchSort = searchSort
  return {
    collapsed: out,
    ...(out.todoSort ? { todoSort: out.todoSort } : {}),
    ...(out.searchSort ? { searchSort: out.searchSort } : {}),
  }
}

/** 「在等什么」只认三种；key 是正文摘要，所以换天、换行号都不丢 */
function waitKeyOf(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
}

/** wait: { 正文摘要: { kind, at } }；老格式（值是字符串）当成「很久以前标的」
 *  等也要有寿命：没有 at 就永远不知道「这条已经等了 4 天」。 */
/** next: { 正文摘要: 「打开 PRD 第 3 节」 } —— 一句话，别让它长成第二个备注系统 */
function sanitizeNext(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  let count = 0
  for (const [key, value] of Object.entries(raw)) {
    if (count >= STATE_NEXT_CAP) break
    if (typeof key !== 'string' || !key || key.length > 120) continue
    const text = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
    if (!text) continue
    out[key] = text
    count += 1
  }
  return out
}

function sanitizeWait(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  let count = 0
  for (const [key, value] of Object.entries(raw)) {
    if (count >= STATE_WAIT_CAP) break
    if (typeof key !== 'string' || !key || key.length > 120) continue
    const kind = typeof value === 'string' ? value : value?.kind
    if (!WAIT_KINDS.includes(kind)) continue
    const at = Number(typeof value === 'object' && value ? value.at : 0)
    out[key] = { kind, at: Number.isFinite(at) && at > 0 ? at : 0 }
    count += 1
  }
  return out
}

async function markWait(workspace, text, kind, next) {
  const key = waitKeyOf(text)
  if (!key) throw Object.assign(new Error('缺少待办正文'), { statusCode: 400 })
  return withLock(`state:${workspace}`, async () => {
    const state = await readPanelState(workspace)
    const wait = { ...state.wait }
    if (kind === null || kind === '' || kind === undefined) delete wait[key]
    else if (WAIT_KINDS.includes(kind)) wait[key] = { kind, at: Date.now() }
    else throw Object.assign(new Error('kind 只能是 market / reply / decide，或留空清除'), { statusCode: 400 })
    const capped = Object.fromEntries(Object.entries(wait).slice(-STATE_WAIT_CAP))
    // next 只有显式传字符串时才动；循环切换 ⌛ 不能顺手把「下一步」抹掉
    let nextTable = { ...state.next }
    if (typeof next === 'string') {
      const clean = next.replace(/\s+/g, ' ').trim().slice(0, 120)
      if (clean) nextTable[key] = clean
      else delete nextTable[key]
      nextTable = Object.fromEntries(Object.entries(nextTable).slice(-STATE_NEXT_CAP))
    }
    await writePanelState(workspace, { ...state, wait: capped, next: nextTable })
    return { text: key, wait: capped[key] ?? null, next: nextTable[key] ?? null, count: Object.keys(capped).length }
  })
}

async function writePanelState(workspace, state) {
  const file = join(workspace, STATE_REL)
  const dir = dirname(file)
  await mkdir(dir, { recursive: true })
  // .dsh 这一级可能被人换成指向外部的软链：落盘前按真实路径确认它没跑出工作区。
  if (!dirAllowed(workspace, dir)) {
    throw Object.assign(new Error('状态目录不在工作区内'), { statusCode: 403 })
  }
  // 每次落盘都打版本号：读的时候才知道要不要迁移
  await atomicWrite(file, `${JSON.stringify({ v: STATE_VERSION, ...state }, null, 2)}\n`)
}

/** 记一次「这篇被打开了」。面板里的打开动作会打这个点，用来判断某次召回后来有没有被用上。 */
/**
 * 记一步改期：{from, to, at}。key 与 wait/next 同一套（正文摘要前 60 字），
 * 所以同一条债被挪到哪天都还是同一条；只留最近几步，够看出「这条一直在挪」就行。
 */
async function recordMove(workspace, text, from, to, note) {
  if (!workspace) return 0
  const key = waitKeyOf(text)
  if (!key) return 0
  return withLock(`state:${workspace}`, async () => {
    const state = await readPanelState(workspace)
    const moved = { ...state.moved }
    const chain = Array.isArray(moved[key]) ? moved[key].slice(-(STATE_MOVED_PER_KEY - 1)) : []
    const why = typeof note === 'string' ? note.replace(/\s+/g, ' ').trim().slice(0, 80) : ''
    chain.push(why ? { from, to, at: Date.now(), note: why } : { from, to, at: Date.now() })
    moved[key] = chain
    const kept = Object.fromEntries(Object.entries(moved).slice(-STATE_MOVED_CAP))
    await writePanelState(workspace, { ...state, moved: kept })
    return chain.length
  })
}

/**
 * 实验记录：召回页的「换个说法 / 四个旋钮」每跑一次就留一行。
 * 存在 state.json 之外（单独 jsonl），因为它是流水、会长，不该让每次读状态都解析它。
 */
const EXPERIMENTS_REL = '.dsh/personal-memory/experiments.jsonl'
const EXPERIMENT_KEEP = 200

function sanitizeExperiment(raw) {
  const kind = raw?.kind === 'compare' ? 'compare' : raw?.kind === 'sweep' ? 'sweep' : ''
  const query = String(raw?.query ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
  if (!kind || !query) return null
  const rows = (Array.isArray(raw?.rows) ? raw.rows : []).slice(0, 8).map((row) => ({
    key: String(row?.key ?? '').slice(0, 24),
    text: String(row?.text ?? row?.label ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
    injected: Math.max(0, Math.trunc(Number(row?.injected) || 0)),
    candidates: Math.max(0, Math.trunc(Number(row?.candidates) || 0)),
    low: Math.max(0, Math.trunc(Number(row?.low) || 0)),
    budget: Math.max(0, Math.trunc(Number(row?.budget) || 0)),
    top: Number(row?.top) || 0,
  }))
  if (rows.length === 0) return null
  return { at: new Date().toISOString(), kind, query, rows }
}

async function appendExperiment(workspace, payload) {
  const record = sanitizeExperiment(payload)
  if (!record) throw Object.assign(new Error('实验记录需要 kind（compare|sweep）与 rows'), { statusCode: 400 })
  const file = join(workspace, EXPERIMENTS_REL)
  await mkdir(dirname(file), { recursive: true })
  const lines = await withLock(`file:${file}`, async () => {
    let rows = []
    try {
      rows = (await readFile(file, 'utf8')).split('\n').filter(Boolean)
    } catch {
      rows = []
    }
    rows.push(JSON.stringify(record))
    if (rows.length > EXPERIMENT_KEEP) rows = rows.slice(rows.length - EXPERIMENT_KEEP)
    await atomicWrite(file, `${rows.join('\n')}\n`)
    return rows
  })
  return { at: record.at, kind: record.kind, query: record.query, rows: record.rows, total: lines.length }
}

async function readExperiments(workspace, limit = 20) {
  const file = join(workspace, EXPERIMENTS_REL)
  let raw = ''
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return { path: EXPERIMENTS_REL, total: 0, items: [] }
  }
  const lines = raw.split('\n').filter(Boolean)
  const cap = Math.min(Math.max(1, Math.trunc(Number(limit) || 20)), 100)
  const items = lines.slice(lines.length - cap).reverse().map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  }).filter(Boolean)
  return { path: EXPERIMENTS_REL, total: lines.length, items }
}

async function markUsed(workspace, relPath, dwell) {
  const target = String(relPath ?? '').trim()
  if (!target) throw Object.assign(new Error('缺少 path'), { statusCode: 400 })
  return withLock(`state:${workspace}`, async () => {
    const state = await readPanelState(workspace)
    const prev = state.used?.[target]
    const prevDwell = Math.max(0, Math.trunc(Number(prev?.dwell) || 0))
    const next = Math.max(prevDwell, Math.max(0, Math.trunc(Number(dwell) || 0)))
    const used = { ...state.used, [target]: { at: Date.now(), dwell: next } }
    if (Object.keys(used).length > STATE_USED_CAP) {
      const keep = Object.entries(used).sort((a, b) => Number(b[1]?.at) - Number(a[1]?.at)).slice(0, STATE_USED_CAP)
      for (const key of Object.keys(used)) delete used[key]
      for (const [key, value] of keep) used[key] = value
    }
    await writePanelState(workspace, { ...state, used })
    return { path: target, at: used[target].at, dwell: used[target].dwell, count: Object.keys(used).length }
  })
}

/**
 * 「最近查过」存的是「查询 + 范围 + 时间窗」的组合，不是一句裸文本。
 * 老格式（纯字符串）照样读得进来，当成默认范围 / 不限时间。
 */
function sanitizeQueries(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seenKey = new Set()
  for (const item of raw) {
    let entry = null
    if (typeof item === 'string') {
      const q = item.trim()
      if (q) entry = { q, scope: '', days: 0, only: '', at: 0 }
    } else if (item && typeof item === 'object' && typeof item.q === 'string') {
      const q = item.q.trim()
      if (!q || q.length > 200) continue
      const scope = String(item.scope ?? '')
        .split(',')
        .map((v) => v.trim())
        .filter((v) => SCOPES.includes(v))
        .join(',')
      const days = Math.min(Math.max(Number(item.days) || 0, 0), 3650)
      // 「只看待办」也是那次检索的一部分：恢复历史时要回到同一屏，不能悄悄把开关关掉
      const only = item.only === 'state' ? 'state' : ''
      entry = { q, scope, days, only, at: Number(item.at) || 0 }
    }
    if (!entry) continue
    // 去重键要带上 only：同一句、同一个范围，开关过「只看待办」就是另一屏
    const key = `${entry.q}\u0000${entry.scope}\u0000${entry.days}\u0000${entry.only}`
    if (seenKey.has(key)) continue
    seenKey.add(key)
    out.push(entry)
    if (out.length >= STATE_QUERY_CAP) break
  }
  return out
}

/**
 * 记一次真实召回：只累加当天计数，不存明细（明细留在日志里）。
 * 失败不抛——统计不该影响召回主流程。
 */
async function bumpRecallUsage(workspace, injected, used) {
  if (!workspace) return
  try {
    const state = await readPanelState(workspace)
    const today = localDateKey()
    // 默认值必须和写入字段一一对应：少了 chars 会算出 NaN，被 sanitize 洗成 0（静默丢数）
    const row = state.usage[today] ?? { recalls: 0, injected: 0, chars: 0 }
    state.usage[today] = {
      recalls: row.recalls + 1,
      injected: row.injected + Math.max(0, Math.floor(Number(injected) || 0)),
      chars: row.chars + Math.max(0, Math.floor(Number(used) || 0)),
    }
    state.usage = sanitizeUsage(state.usage)
    await writePanelState(workspace, state)
  } catch { /* 统计失败忽略 */ }
}

async function rememberQuery(workspace, entry) {
  const item = typeof entry === 'string' ? { q: entry } : (entry ?? {})
  const text = String(item.q ?? '').trim()
  if (!text) return
  const scope = String(item.scope ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => SCOPES.includes(v))
    .join(',')
  const days = Math.min(Math.max(Number(item.days) || 0, 0), 3650)
  const only = item.only === 'state' ? 'state' : ''
return withLock(`state:${workspace}`, async () => {
    const state = await readPanelState(workspace)
    const row = { q: text, scope, days, only, at: Date.now() }
    const same = (a) => a.q === row.q && String(a.scope ?? '') === scope && (Number(a.days) || 0) === days && (a.only === 'state' ? 'state' : '') === only
    // 同一句 + 同样的筛选条件只留最新一条；换了范围或时间窗就算另一条
    const next = [row, ...state.queries.filter((q) => !same(q))].slice(0, STATE_QUERY_CAP)
    const unchanged = state.queries.length === next.length && next.every((q, i) => same(state.queries[i]))
    if (unchanged) return
    await writePanelState(workspace, { ...state, queries: next })
})
}

async function toggleStar(workspace, relPath, on) {
  const found = safeDocPath(workspace, relPath)
  if (!found) throw Object.assign(new Error('这篇不在可星标的范围里'), { statusCode: 403 })
  return withLock(`state:${workspace}`, async () => {
    const state = await readPanelState(workspace)
    const has = state.stars.includes(found.rel)
    const want = typeof on === 'boolean' ? on : !has
    if (want === has) return { path: found.rel, starred: has, stars: state.stars }
    const stars = want ? [found.rel, ...state.stars].slice(0, STATE_STAR_CAP) : state.stars.filter((x) => x !== found.rel)
    await writePanelState(workspace, { ...state, stars })
    return { path: found.rel, starred: want, stars }
  })
}

/** 记一条折叠偏好：key 形如 "month:2026-11" / "bucket:old" / "dir:personal/stock" */
async function setPanelUi(workspace, patch) {
  return withLock(`state:${workspace}`, async () => {
    const state = await readPanelState(workspace)
    const next = { ...(state.ui?.collapsed ?? {}) }
    const incoming = sanitizeUi(patch).collapsed ?? {}
    for (const [key, value] of Object.entries(incoming)) next[key] = value
    const capped = Object.fromEntries(Object.entries(next).slice(-STATE_UI_CAP))
    const clean = sanitizeUi(patch)
    const nextSort = clean.todoSort ?? state.ui?.todoSort ?? 'fresh'
    const nextSearchSort = clean.searchSort ?? state.ui?.searchSort ?? 'score'
    const ui = { collapsed: capped, todoSort: nextSort, searchSort: nextSearchSort }
    await writePanelState(workspace, { ...state, ui })
    return { ui }
  })
}

/* ------------------------------------------------------------------ *
 * 只追加的「速记」：往今天的长河里加一行
 * ------------------------------------------------------------------ */

function pad2(value) {
  return String(value).padStart(2, '0')
}

function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function addDaysKey(dateKey, days) {
  const [y, m, d] = String(dateKey).split('-').map(Number)
  const at = new Date(y, m - 1, d)
  at.setDate(at.getDate() + days)
  return localDateKey(at)
}

/** 从 `memory/2026/11/2026-11-20.md` 这种路径里取回日期 */
// 下一个周几（1=周一 … 7=周日）：今天就是那天时给下一天，避免「挪到周一」变成原地不动
function nextWeekdayKey(target) {
  const now = new Date()
  const current = now.getDay() === 0 ? 7 : now.getDay()
  const delta = (target - current + 7) % 7 || 7
  return addDaysKey(localDateKey(), delta)
}

function dateKeyOfPath(rel) {
  const match = /(\d{4}-\d{2}-\d{2})\.md$/.exec(String(rel ?? ''))
  return match ? match[1] : ''
}

function localTimeKey(date = new Date()) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/**
 * 在指定 `## 小节` 的末尾插一行，其余字节原样保留。
 * 小节不存在就在文件末尾补一个（追加，不改动已有内容）。
 */
function insertIntoSection(text, section, line) {
  const lines = text.split('\n')
  const target = `## ${section}`
  let start = lines.findIndex((l) => l.trim() === target)
  if (start === -1) {
    const trimmed = text.replace(/\s*$/, '')
    return `${trimmed}\n\n${target}\n\n${line}\n`
  }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) {
      end = i
      break
    }
  }
  let insertAt = start + 1
  for (let i = start + 1; i < end; i += 1) {
    if (lines[i].trim()) insertAt = i + 1
  }
  // 小节标题和第一行之间留一个空行，和模板保持一致
  if (insertAt === start + 1) {
    lines.splice(insertAt, 0, '', line)
  } else {
    lines.splice(insertAt, 0, line)
  }
  return lines.join('\n')
}

async function appendQuickNote(workspace, { text, section, dateKey, todo }) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dateKey ?? '') ? dateKey : localDateKey()
  const [year, month] = day.split('-')
  const rel = `memory/${year}/${month}/${day}.md`
  const abs = join(workspace, rel)
  // 这条路径不经过 safeDocPath（文件可能还不存在），要自己裁决：目录软链、文件软链都拒。
  if (!writePathAllowed(workspace, abs)) {
    throw Object.assign(new Error('这天的日记文件不在可写范围里'), { statusCode: 403 })
  }
  const body = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!body) throw new Error('内容不能为空')
  const clipped = body.length > 600 ? `${body.slice(0, 600)}…` : body
  // 待办不加时间前缀：它是「要做的事」，不是「发生的事」
  const line = todo === true ? `- [ ] ${clipped}` : `- ${localTimeKey()} ${clipped}`
  const target = section || (todo === true ? '未完成' : '产出')
  return withLock(`file:${abs}`, async () => {
    let current = null
    try {
      current = await readFile(abs, 'utf8')
    } catch {
      current = null
    }
    if (current === null) {
      await mkdir(dirname(abs), { recursive: true })
      const weekday = weekdayOf(day)
      const skeleton = `# ${day} ${weekday}\n\n## 产出\n\n- \n\n## 判断\n\n- \n\n## 未完成\n\n- [ ] \n\n## 备忘\n\n- \n`
      const next = insertIntoSection(skeleton, target, line)
      await atomicWrite(abs, next.endsWith('\n') ? next : `${next}\n`)
      return { path: rel, created: true, line }
    }
    const next = insertIntoSection(current, target, line)
    const normalized = next.endsWith('\n') ? next : `${next}\n`
    if (normalized === current) return { path: rel, created: false, line, unchanged: true }
    await atomicWrite(abs, normalized)
    return { path: rel, created: false, line }
  })
}

/* ------------------------------------------------------------------ *
 * 挪待办：从这一天删掉这一行，再在目标那天落一条同样的 `- [ ]`
 * ------------------------------------------------------------------ */

/**
 * 「今天不做了」和「做完了」是两件事。勾掉会把这条债抹掉，改期才是它该有的动作：
 * 源文件里删掉那一行（文本要逐字对得上），目标日期里补一条同样的待办。
 * 不做跨文件事务：先写目标，成功后再删源；两步之间失败至少不会丢文字。
 */
async function deferTodo(workspace, { relPath, line, expect, to, note }) {
  const target = safeDocPath(workspace, relPath)
  if (!target) throw Object.assign(new Error('路径不在可写范围里'), { statusCode: 403 })
  const lineNo = Number(line)
  if (!Number.isInteger(lineNo) || lineNo < 1) {
    throw Object.assign(new Error('line 必须是正整数'), { statusCode: 400 })
  }
  const sourceDay = dateKeyOfPath(target.rel)
  // to 支持两种写法：具体日期，或 'tomorrow' / 'monday'（多数事不是明天要做，而是本周某个工作日）
  const wanted = to === 'monday'
    ? nextWeekdayKey(1)
    : /^\d{4}-\d{2}-\d{2}$/.test(to ?? '') && to !== 'tomorrow'
      ? to
      : addDaysKey(localDateKey(), 1)
  if (wanted === sourceDay) {
    throw Object.assign(new Error('挪到同一天没有意义'), { statusCode: 400 })
  }
return withLock(`file:${target.abs}`, async () => {
    const current = await readFile(target.abs, 'utf8')
    const lines = current.split('\n')
    const row = lines[lineNo - 1]
    if (typeof row !== 'string') {
      throw Object.assign(new Error(`这一行不存在（文件共 ${lines.length} 行）`), { statusCode: 400 })
    }
    const match = /^(\s*-\s+)\[([ xX])\](\s*)(.*)$/.exec(row)
    if (!match) throw Object.assign(new Error('这一行不是待办'), { statusCode: 400 })
    if (match[2].trim() === 'x') {
      throw Object.assign(new Error('这条已经勾掉了'), { statusCode: 400 })
    }
    const body = match[4].replace(/\s+/g, ' ').trim()
    if (!body) throw Object.assign(new Error('这一行待办没有内容'), { statusCode: 400 })
    const want = expect == null ? '' : String(expect).replace(/\s+/g, ' ').trim().slice(0, 40)
    if (want && !body.includes(want)) {
      throw Object.assign(new Error('这一行和面板上看到的不一样，刷新后再挪'), { statusCode: 400 })
    }
    // 先落目标那天，成功了再删源：中途出错最多是多出一条，不会丢文字
    const landed = await appendQuickNote(workspace, {
      text: body,
      section: '未完成',
      dateKey: wanted,
      todo: true,
    })
    lines.splice(lineNo - 1, 1)
    // 删掉后若该节只剩空行，留一个空行占位，别把结构弄坏
    await atomicWrite(target.abs, lines.join('\n'))
    // 记一步改期：面板上就能显示「这条挪了 3 次、从 11-04 起」
    let movedCount = 0
    try {
      movedCount = await recordMove(workspace, body, sourceDay, wanted, note)
    } catch {}
    return {
      text: body,
      from: { path: target.rel, line: lineNo, date: sourceDay },
      to: { path: landed.path, date: wanted, created: landed.created === true },
      moved: movedCount,
    }
})
}

/* ------------------------------------------------------------------ *
 * 勾待办：只改那一行的 `- [ ]` / `- [x]`，别的一个字都不动
 * ------------------------------------------------------------------ */

/**
 * 把第 line 行的待办勾上/取消。只写回该行，行号与文本都要对得上，
 * 对不上就拒绝（避免面板上的旧数据把别的东西改坏）。
 */
async function toggleTodo(workspace, { relPath, line, done, expect }) {
  const target = safeDocPath(workspace, relPath)
  if (!target) throw Object.assign(new Error('路径不在可写范围里'), { statusCode: 403 })
  const lineNo = Number(line)
  if (!Number.isInteger(lineNo) || lineNo < 1) {
    throw Object.assign(new Error('line 必须是正整数'), { statusCode: 400 })
  }
  if (typeof done !== 'boolean') throw Object.assign(new Error('done 必须是布尔值'), { statusCode: 400 })
return withLock(`file:${target.abs}`, async () => {
    const current = await readFile(target.abs, 'utf8')
    const lines = current.split('\n')
    const row = lines[lineNo - 1]
    if (typeof row !== 'string') {
      throw Object.assign(new Error(`这一行不存在（文件共 ${lines.length} 行）`), { statusCode: 400 })
    }
    const match = /^(\s*-\s+)\[([ xX])\](\s*)(.*)$/.exec(row)
    if (!match) throw Object.assign(new Error('这一行不是待办'), { statusCode: 400 })
    const want = expect == null ? '' : String(expect).replace(/\s+/g, ' ').trim().slice(0, 40)
    if (want && !match[4].replace(/\s+/g, ' ').includes(want)) {
      throw Object.assign(new Error('这一行和面板上看到的不一样，刷新后再勾'), { statusCode: 400 })
    }
    if (Boolean(match[2].trim()) === done) {
      return { path: target.rel, line: lineNo, done, unchanged: true }
    }
    lines[lineNo - 1] = `${match[1]}[${done ? 'x' : ' '}]${match[3]}${match[4]}`
    await atomicWrite(target.abs, lines.join('\n'))
    return { path: target.rel, line: lineNo, done }
})
}

/* ------------------------------------------------------------------ *
 * 编辑与新建：面板里能改字，才算「能写」
 * ------------------------------------------------------------------ */

/** 内容指纹：编辑保存时用它判断「磁盘上的这篇还是我打开时的那篇吗」。 */
function hashText(text) {
  return createHash('sha1').update(String(text), 'utf8').digest('hex').slice(0, 16)
}

/** 统一换行 + 结尾补一个换行，避免每次保存都把整个文件的末尾搅动。 */
function normalizeBody(text) {
  const next = String(text).replace(/\r\n?/g, '\n')
  if (!next) return ''
  return next.endsWith('\n') ? next : `${next}\n`
}

/**
 * 保存一篇已存在的笔记。
 * 只覆盖白名单目录里的 .md；hash 对不上就拒绝（409），否则「面板上的旧版本」
 * 会把别处刚写进去的内容整段抹掉。
 */
/**
 * 往一篇笔记末尾补一行（给「翻过没动」的目录页用）：只追加、整篇的并发校验交给 hash。
 * 不新开写入口径，仍然走 safeDocPath —— 路径白名单跟 /save 是同一把锁。
 */
async function appendDocLine(workspace, payload) {
  const target = safeDocPath(workspace, payload?.path)
  if (!target) throw Object.assign(new Error('路径不在可写范围里'), { statusCode: 403 })
  const line = String(payload?.line ?? '').replace(/\s+/g, ' ').trim()
  if (!line) throw Object.assign(new Error('要补的那一行是空的'), { statusCode: 400 })
  if (line.length > 200) throw Object.assign(new Error('一行最多 200 字'), { statusCode: 400 })
return withLock(`file:${target.abs}`, async () => {
    const current = await readFile(target.abs, 'utf8')
    const want = typeof payload?.hash === 'string' ? payload.hash.trim() : ''
    if (want && want !== hashText(current)) {
      throw Object.assign(new Error('这篇在磁盘上已经变了，刷新后再补'), { statusCode: 409 })
    }
    // 已经补过同一句就别重复写（同一个入口点两次不该长两行）
    if (current.split('\n').some((row) => row.trim() === line)) {
      return { path: target.rel, hash: hashText(current), appended: false, line }
    }
    const body = normalizeBody(current)
    const next = `${body}${line}\n`
    await atomicWrite(target.abs, next)
    return { path: target.rel, hash: hashText(next), appended: true, line, bytes: Buffer.byteLength(next, 'utf8') }
})
}

async function saveDoc(workspace, payload) {
  const target = safeDocPath(workspace, payload?.path)
  if (!target) throw Object.assign(new Error('路径不在可写范围里'), { statusCode: 403 })
  const text = payload?.text
  if (typeof text !== 'string') throw Object.assign(new Error('text 必须是字符串'), { statusCode: 400 })
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_DOC_BYTES) {
    throw Object.assign(new Error(`正文太大（${Math.round(bytes / 1024)}KB），单个文件上限 512KB`), { statusCode: 400 })
  }
return withLock(`file:${target.abs}`, async () => {
    const current = await readFile(target.abs, 'utf8')
    const want = typeof payload?.hash === 'string' ? payload.hash.trim() : ''
    if (want && want !== hashText(current)) {
      throw Object.assign(new Error('这篇在磁盘上已经变了，刷新后再改'), { statusCode: 409 })
    }
    const next = normalizeBody(text)
    if (next === current) {
      const stats = await stat(target.abs)
      return { path: target.rel, changed: false, bytes: stats.size, chars: next.length, lines: next.split('\n').length, mtime: stats.mtime.toISOString(), mtimeMs: stats.mtimeMs, hash: hashText(next) }
    }
    await atomicWrite(target.abs, next)
    const stats = await stat(target.abs)
    return { path: target.rel, changed: true, bytes: stats.size, chars: next.length, lines: next.split('\n').length, mtime: stats.mtime.toISOString(), mtimeMs: stats.mtimeMs, hash: hashText(next) }
})
}

/** 文件名只做最小净化：中文原样留着（笔记标题就是中文），危险字符换掉。 */
function slugOf(title) {
  const slug = String(title).replace(/[\\/:*?"<>|#]+/g, ' ').replace(/\s+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  return slug || 'note'
}

/**
 * 新建一篇笔记（只建 personal/，日记由速记按日期生成）。
 * 骨架跟工作区约定一致：H1 标题 + `更新:` + `来源:`，正文留空给用户写。
 */
async function createDoc(workspace, payload) {
  const scope = String(payload?.scope ?? 'personal').trim()
  if (!SCOPES.includes(scope)) throw Object.assign(new Error('scope 只能是 personal / memory / project'), { statusCode: 400 })
  if (scope === 'memory') throw Object.assign(new Error('日记按日期自动生成，用「速记」写今天'), { statusCode: 400 })
  const rawDir = String(payload?.dir ?? scope).trim().replace(/^[/\\]+/, '').replace(/[/\\]+$/, '')
  const parts = rawDir.split(/[/\\]+/).filter(Boolean)
  if (parts.length === 0 || parts[0] !== scope) {
    throw Object.assign(new Error(`目录必须落在 ${scope}/ 下面`), { statusCode: 400 })
  }
  if (parts.some((part) => part === '.' || part === '..')) {
    throw Object.assign(new Error('目录不合法'), { statusCode: 403 })
  }
  const dirRel = parts.join('/')
  const dirAbs = resolve(workspace, dirRel)
  if (!dirAbs.startsWith(workspace + sep)) throw Object.assign(new Error('目录不合法'), { statusCode: 403 })
  // 目录本身可能是指向工作区外面的软链：按真实路径再判一次。
  let stat_ = null
  try {
    stat_ = await stat(dirAbs)
  } catch (error) {
    throw Object.assign(new Error(`目录不存在：${dirRel}`), { statusCode: 400 })
  }
  if (!dirAllowed(workspace, dirAbs)) throw Object.assign(new Error(`目录不在工作区里：${dirRel}`), { statusCode: 403 })
  if (!stat_.isDirectory()) throw Object.assign(new Error(`不是目录：${dirRel}`), { statusCode: 400 })
  const title = String(payload?.title ?? '').replace(/\s+/g, ' ').trim()
  if (!title) throw Object.assign(new Error('标题不能为空'), { statusCode: 400 })
  if (title.length > 80) throw Object.assign(new Error('标题太长（上限 80 字）'), { statusCode: 400 })
  const base = slugOf(title)
  let rel = ''
  let body = ''
  let created = false
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const file = attempt === 1 ? `${base}.md` : `${base}-${attempt}.md`
    rel = `${dirRel}/${file}`
    const abs = resolve(workspace, rel)
    // 同名文件已存在就换下一个；悬空软链 existsSync 是 false，得看 lstat 才挡得住。
    let taken = false
    try { lstatSync(abs); taken = true } catch { taken = false }
    if (taken) continue
    if (!writePathAllowed(workspace, abs)) {
      throw Object.assign(new Error('目标文件不在可写范围里'), { statusCode: 403 })
    }
    body = `# ${title}\n\n更新:${localDateKey()}\n来源:面板新建\n\n`
    try {
      await writeFile(abs, body, { encoding: 'utf8', flag: 'wx' })
      created = true
      break
    } catch (error) {
      if (error?.code === 'EEXIST') continue
      throw error
    }
  }
  if (!created) throw Object.assign(new Error('同名文件太多，换个标题'), { statusCode: 409 })
  const abs = resolve(workspace, rel)
  const stats = await stat(abs)
  const described = describeFile(abs, workspace, body, stats)
  return { ...described, text: body, toc: tocOf(body), hash: hashText(body), mtimeMs: stats.mtimeMs, created: true }
}

/* ------------------------------------------------------------------ *
 * HTTP 接口
 * ------------------------------------------------------------------ */

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

async function ctxServerGet(path) {
  const res = await fetch(`${CTX_SERVER}${path}`, { signal: AbortSignal.timeout(4000) })
  if (!res.ok) throw new Error(`ctx-server HTTP ${res.status}`)
  const env = await res.json()
  if (env.ok !== true) throw new Error(env.error ?? `ctx-server 失败`)
  // ctx-server 的 /health 是平铺字段（{ok, ready, db...}），/search 才是 {ok, value} 包装，两种都要认。
  return env.value ?? env
}

/** 面板的所有数据接口。全部只读，除了 /note（只追加）和 /reindex（重建索引）。 */
function apiRoute(cfg, ctx, cache) {
  const prefix = '/personal-memory'

  const status = async () => {
    // 读多点：日志里 beacon 占大头，窗口太窄会把召回行挤出去（表现为「累计召回 0」）
    const rows = await readLog(2000)
    const recalls = rows.filter((r) => r.query !== undefined)
    const hits = recalls.reduce((sum, r) => sum + (Number(r.hits) || 0), 0)
    const mounted = rows.find((r) => r.event === 'mounted') ?? null
    const workspace = resolveWorkspace(ctx, cfg)
    let docs = []
    if (workspace) {
      try {
        docs = await scanWorkspace(workspace, cache, cfg, false)
      } catch {
        docs = []
      }
    }
    const personal = docs.filter((d) => d.scope === 'personal')
    const diaries = docs.filter((d) => d.scope === 'memory' && d.diary)
    const project = docs.filter((d) => d.scope === 'project')
    let index = null
    try {
      const health = await ctxServerGet('/health')
      index = {
        ready: Boolean(health.ready),
        db: health.db ?? '',
        bytes: Number(health.indexBytes) || 0,
        searchCount: Number(health.searchCount) || 0,
        lastSearchAt: health.lastSearchAt ?? null,
        reindexCount: Number(health.reindexCount) || 0,
        startedAt: health.startedAt ?? null,
        url: CTX_SERVER,
      }
    } catch (error) {
      index = { ready: false, error: String(error?.message ?? error), url: CTX_SERVER }
    }
    const recentRows = await markUsage(workspace, rows.filter((row) => row.query !== undefined).slice(0, 100))
    const panel = await readPanelState(workspace)
    const rollup = Object.values(panel.usage)
    const rollupRecalls = rollup.reduce((sum, row) => sum + row.recalls, 0)
    const rollupInjected = rollup.reduce((sum, row) => sum + row.injected, 0)
    const rollupChars = rollup.reduce((sum, row) => sum + row.chars, 0)
    return {
      enabled: cfg.enabled,
      workspace,
      workspaceSource: cfg.workspace ? 'config' : workspace ? 'auto' : 'missing',
      config: { ...cfg },
      stats: {
        // 日志是明细、会被轮转；日汇总是累计口径，两者取大的那个，清日志也不至于显示成 0
        recalls: Math.max(recalls.length, rollupRecalls),
        hits: Math.max(hits, rollupInjected),
        lastAt: recalls[0]?.at ?? null,
        mountedAt: mounted?.at ?? null,
        source: rollupRecalls > recalls.length ? 'rollup' : 'log',
        rollup: { days: rollup.length, recalls: rollupRecalls, injected: rollupInjected, chars: rollupChars },
      },
      counts: {
        personal: personal.length,
        diaries: diaries.length,
        memoryEntries: diaries.reduce((sum, d) => sum + (d.diary?.entries ?? 0), 0),
        openTodos: diaries.reduce((sum, d) => sum + (d.diary?.openTodos ?? 0), 0),
        project: project.length,
        chars: docs.reduce((sum, d) => sum + (d.chars ?? 0), 0),
        lastDiary: diaries.slice().sort((a, b) => (b.path > a.path ? 1 : -1))[0]?.path ?? null,
      },
      index,
      // 只回真实召回行（挂载/跳过行不要混进「最近召回」）。
      // used 是弱信号：这篇在那次召回之后被打开过，说明召回至少没白跑
      recent: recentRows,
      // 命中率：近 N 天注入的每一篇里，有多少后来真的被打开过 —— 阈值该不该调的凭据
      usage: usageOf(recentRows, 7, panel.usage),
      logPath: LOG_FILE,
      logLines: rows.length,
      logSince: rows.length > 0 ? (rows[rows.length - 1]?.at ?? rows.find((row) => typeof row?.at === 'string')?.at ?? null) : null,
      profileFile: await resolveProfileFile(),
      ctxServer: CTX_SERVER,
    }
  }

  const used = async ({ body }) => {
    const workspace = resolveWorkspace(ctx, cfg)
    if (!workspace) throw Object.assign(new Error('没有找到工作区'), { statusCode: 500 })
    return markUsed(workspace, body?.path, body?.dwell)
  }

  const tree = async ({ query }) => {
    const workspace = resolveWorkspace(ctx, cfg)
    if (!workspace) return { workspace: null, docs: [], warning: '没有找到工作区（既没有 config.workspace，也没在 cwd 上级找到 personal/ + memory/）' }
    const docs = await scanWorkspace(workspace, cache, cfg, query.get('refresh') === '1')
    const panelState = await readPanelState(workspace)
    const starred = new Set(panelState.stars)
    for (const doc of docs) doc.star = starred.has(doc.path)
    const wanted = (query.get('scope') ?? 'personal,memory')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => SCOPES.includes(s))
    const scoped = docs.filter((doc) => wanted.includes(doc.scope))
    return {
      workspace,
      docs: scoped,
      counts: {
        personal: docs.filter((d) => d.scope === 'personal').length,
        memory: docs.filter((d) => d.scope === 'memory').length,
        project: docs.filter((d) => d.scope === 'project').length,
      },
      scannedAt: new Date().toISOString(),
    }
  }

  const doc = async ({ query }) => {
    const workspace = resolveWorkspace(ctx, cfg)
    if (!workspace) throw new Error('没有找到工作区')
    const found = safeDocPath(workspace, query.get('path'))
    // 读路径也走同一道白名单：越界是「不允许」而不是「服务器坏了」，该是 403 不是 500
    if (!found) throw Object.assign(new Error('path 不合法：只允许 personal/ memory/ project/ 下的 .md 文件'), { statusCode: 403 })
    const stats = await stat(found.abs)
    if (stats.size > MAX_DOC_BYTES) throw new Error(`文件太大（${Math.round(stats.size / 1024)}KB），面板不渲染超过 512KB 的笔记`)
    const text = await readFile(found.abs, 'utf8')
    const described = describeFile(found.abs, workspace, text, stats)
    return { ...described, text, toc: tocOf(text), hash: hashText(text), mtimeMs: stats.mtimeMs }
  }

  const timeline = async ({ query }) => {
    const workspace = resolveWorkspace(ctx, cfg)
    if (!workspace) return { workspace: null, days: [], months: [] }
    const docs = await scanWorkspace(workspace, cache, cfg, query.get('refresh') === '1')
    const panelState = await readPanelState(workspace)
    const waitTable = panelState.wait
    const nextTable = panelState.next ?? {}
    const movedTable = panelState.moved ?? {}
    const days = docs
      .filter((d) => d.scope === 'memory' && d.diary)
      .map((d) => ({
        path: d.path,
        date: d.file,
        weekday: (d.title.match(/\s(\S+)$/) ?? [])[1] ?? weekdayOf(d.file),
        title: d.title,
        mtime: d.mtime,
        chars: d.chars,
        bytes: d.bytes,
        entries: d.diary.entries,
        openTodos: d.diary.openTodos,
        doneTodos: d.diary.doneTodos,
        todos: (d.diary.todos ?? [])
          .filter((item) => !item.done)
          .slice(0, 12)
          .map((item) => {
            const marked = waitTable[waitKeyOf(item.text)] ?? null
            // 「下一步」跟 wait 用同一个 key，所以改期挪到另一天也还在
            const at = Number(marked?.at) || 0
            const days = at > 0 ? Math.max(0, Math.floor((Date.now() - at) / 86400000)) : 0
            const chain = movedTable[waitKeyOf(item.text)] ?? []
            const steps = chain.slice(-4).map((step) => ({ from: step.from, to: step.to, note: step.note ?? '' }))
            const first = chain[0] ?? null
            return {
              ...item,
              wait: marked?.kind ?? null,
              waitAt: at,
              waitDays: days,
              next: nextTable[waitKeyOf(item.text)] ?? null,
              // 挪过几次 + 最早从哪天开始挪：一直往后推的事，值得单独看一眼
              movedCount: chain.length,
              movedSteps: steps,
              movedFrom: first?.from ?? null,
              movedTo: chain.length > 0 ? chain[chain.length - 1].to : null,
            }
          }),
        // 今天勾掉的也要看得见：只显示「做完了」不给正反馈，人就只记得欠的
        doneItems: (d.diary.todos ?? [])
          .filter((item) => item.done)
          .slice(-12)
          .map((item) => ({ text: item.text, section: item.section })),
        preview: d.diary.preview,
        sections: d.diary.sections,
      }))
      .sort((a, b) => (a.date < b.date ? 1 : -1))
    const monthMap = new Map()
    for (const day of days) {
      const key = day.date.slice(0, 7)
      const bucket = monthMap.get(key) ?? { month: key, days: 0, entries: 0, openTodos: 0 }
      bucket.days += 1
      bucket.entries += day.entries
      bucket.openTodos += day.openTodos
      monthMap.set(key, bucket)
    }
    return {
      workspace,
      days,
      months: [...monthMap.values()].sort((a, b) => (a.month < b.month ? 1 : -1)),
      totals: {
        days: days.length,
        entries: days.reduce((sum, d) => sum + d.entries, 0),
        openTodos: days.reduce((sum, d) => sum + d.openTodos, 0),
        latest: days[0]?.date ?? null,
      },
    }
  }

  /**
   * 词面检索：向量召回对「600519」「31.5」「openCode」这类精确 token 很弱
   * （语义相近但字面不对），所以在向量结果之外再扫一遍标题/路径/摘录。
   * 只扫已缓存的 describe 结果（几十篇，微秒级），不额外读盘。
   */

  const search = async ({ query }) => {
    const q = (query.get('q') ?? '').trim()
    if (!q) return { query: q, hits: [], ms: 0, mode: 'vector' }
    const startedAt = Date.now()
    const topK = Math.min(Math.max(Number(query.get('topK')) || cfg.panelTopK, 1), 50)
    const scopes = (query.get('scope') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => SCOPES.includes(s))
    // 时间范围：只留最近 N 天改过的笔记（0/缺省 = 不限）
    const days = Math.min(Math.max(Number(query.get('days')) || 0, 0), 3650)
    const since = days > 0 ? Date.now() - days * 86400000 : 0
    // 「只看某一类」：待办状态 / 线索都不在正文里，混在笔记里要人自己扫。
    // 目前只支持单类（'state' | 'clue'），因为「同时只看两类」跟「都不看」差别不大
    const onlyKindAsked = String(query.get('only') ?? '')
    const onlyState = onlyKindAsked === 'state'
    const onlyClue = onlyKindAsked === 'clue'
    // 「只看笔记」：把待办与线索两路关掉，只留向量 + 词面 —— 分布在面板上可点，点了就得真筛
    const onlyNote = onlyKindAsked === 'note'
    const onlyOne = onlyState || onlyClue || onlyNote
    const skipVector = onlyState || onlyClue
    let result = { hits: [], mode: onlyState ? 'state' : onlyClue ? 'clue' : 'vector' }
    if (!skipVector) {
      try {
        result = await localSearch(q, cfg, topK, AbortSignal.timeout(Math.max(cfg.timeoutMs, 4000)))
      } catch (err) {
        // ctx-server 挂了也还能给出词面结果，不要整个检索页变成报错
        if (!cfg.debug) result = { hits: [], mode: 'keyword-only', error: String(err?.message ?? err) }
        else throw err
      }
    }
    const seen = new Set()
    const hits = []
    for (const hit of result.hits ?? []) {
      const path = hit.path || ''
      if (scopes.length > 0 && !scopes.includes(String(path).split('/')[0])) continue
      seen.add(path)
      hits.push({
        docId: hit.docId,
        title: hit.documentTitle || '未命名',
        heading: hit.heading || '',
        score: hit.score,
        path,
        excerpt: compact(hit.text, Math.max(cfg.excerptChars, 320)),
        via: 'vector',
      })
    }
    // 词面命中的补进来：向量没召回的（精确 token）appended，向量也召回的标 literal
    const workspace = resolveWorkspace(ctx, cfg)
    // 命中只带路径，没有 mtime：时间过滤要用它，面板上也要显示「改于哪天」。
    // 回扫一次（有 cacheMs 缓存，不贵），顺手给每条命中的 path 配上 mtime。
    let mtimeOf = null
    if (workspace) {
      mtimeOf = new Map()
      try {
        const docs = await scanWorkspace(workspace, cache, cfg)
        for (const doc of docs) mtimeOf.set(doc.path, Number(doc.mtimeMs) || Date.parse(doc.mtime) || 0)
      } catch (err) {
        if (cfg.debug) throw err
        mtimeOf = null
      }
    }
    if (mtimeOf) {
      for (const hit of hits) {
        const at = mtimeOf.get(hit.path)
        if (at) hit.mtimeMs = at
      }
    }
    const recentOf = since > 0 ? mtimeOf : null
    if (recentOf) {
      const kept = hits.filter((hit) => (recentOf.get(hit.path) ?? 0) >= since)
      hits.length = 0
      hits.push(...kept)
    }
    const extra = workspace && !skipVector ? await keywordHits(workspace, cache, cfg, q, scopes, topK) : []
    const literal = new Set(extra.map((hit) => hit.path))
    for (const hit of hits) if (literal.has(hit.path)) hit.literal = true
    // 面板状态（下一步 / 在等 / 改期理由）也进来：这些是「我脑子里正在转的事」，
    // 不在正文里，但搜的时候最该被找回来。
    const stateRows = workspace && !onlyClue && !onlyNote ? await stateHits(workspace, cache, cfg, q, scopes, onlyState ? topK : 4) : []
    for (const hit of stateRows) {
      if (recentOf && (recentOf.get(hit.path) ?? 0) < since) continue
      if (mtimeOf && !hit.mtimeMs) {
        const at = mtimeOf.get(hit.path)
        if (at) hit.mtimeMs = at
      }
      hits.push(hit)
    }
    // 线索：「我搜过、没搜到」也是记忆。搜同一句话时，缺口本身要能浮出来
    const clueRows = workspace && !onlyNote ? await clueHits(workspace, cache, cfg, q, scopes, onlyClue ? topK : 4) : []
    for (const hit of clueRows) {
      if (recentOf && (recentOf.get(hit.path) ?? 0) < since) continue
      if (mtimeOf && !hit.mtimeMs) {
        const at = mtimeOf.get(hit.path)
        if (at) hit.mtimeMs = at
      }
      hits.push(hit)
    }
    let merged = false
    for (const hit of extra) {
      if (seen.has(hit.path)) continue
      if (recentOf && (recentOf.get(hit.path) ?? 0) < since) continue
      if (mtimeOf && !hit.mtimeMs) {
        const at = mtimeOf.get(hit.path)
        if (at) hit.mtimeMs = at
      }
      seen.add(hit.path)
      hits.push(hit)
      merged = true
    }
    // 「我什么时候为它停下来过」：改于哪天（mtime）和看于哪天（used）是两条不同的线。
    if (workspace) {
      try {
        const panelState = await readPanelState(workspace)
        const usedTable = panelState.used ?? {}
        for (const hit of hits) {
          const at = Number(usedTable[hit.path]?.at ?? usedTable[hit.path]) || 0
          if (at > 0) hit.usedAt = at
        }
      } catch { /* 状态读不到不影响检索 */ }
    }
    // 「最近查过」只记人来输入的那种检索：相关笔记是拿正文当 query，记进去就是噪声。
    // 零命中也要记：查过没找到，本身就是「最近查过」该留下的信息。
    if (workspace && query.get('record') !== '0' && q.length <= 60 && !/[\n\r]/.test(q)) {
      try { await rememberQuery(workspace, { q, scope: scopes.join(','), days, only: onlyState ? 'state' : onlyClue ? 'clue' : onlyNote ? 'note' : '' }) } catch { /* 面板状态写不进去不影响检索 */ }
    }
    return {
      query: q,
      hits,
      ms: Date.now() - startedAt,
      only: onlyState ? 'state' : onlyClue ? 'clue' : onlyNote ? 'note' : '',
      mode: onlyState ? 'state' : onlyClue ? 'clue' : (merged ? 'hybrid' : (result.mode ?? 'vector')),
      topK,
      days,
      total: hits.length,
    }
  }

  // 「试一下」不只是给结果，是把这次召回的过程摊开：候选里有谁、谁因为分数不够被丢、
  // 谁因为预算不够被丢、最后到底注入了哪几篇。人问「为什么是这几篇」时要有答案。
  const test = async ({ body }) => {
    const q = typeof body?.query === 'string' ? body.query.trim() : ''
    if (!q) throw Object.assign(new Error('query 不能为空'), { statusCode: 400 })
    const startedAt = Date.now()
    // 临时放宽：只在这一次「试一下」里生效，不写配置。想判断「该不该调阈值」，
    // 得先看得见「放宽之后会多进来哪几篇」，否则只能盲调。
    const trial = {}
    if (Number.isFinite(Number(body?.threshold)) && body.threshold !== null && body.threshold !== '') {
      trial.threshold = Math.min(1, Math.max(0, Number(body.threshold)))
    }
    if (Number.isFinite(Number(body?.maxChars)) && body.maxChars !== null && body.maxChars !== '') {
      trial.maxChars = Math.min(8000, Math.max(200, Math.round(Number(body.maxChars))))
    }
    if (Number.isFinite(Number(body?.excerptChars)) && body.excerptChars !== null && body.excerptChars !== '') {
      trial.excerptChars = Math.min(900, Math.max(60, Math.round(Number(body.excerptChars))))
    }
    const active = { ...cfg, ...trial }
    const fetchK = Math.max(active.topK * 3, 8)
    const workspace = resolveWorkspace(ctx, cfg)
    const result = await localSearch(q.slice(0, cfg.maxQueryChars), cfg, fetchK, AbortSignal.timeout(cfg.timeoutMs))
    const vectors = result?.hits ?? []
    let extras = []
    if (workspace) {
      try { extras = await keywordHits(workspace, cache, cfg, q, null, fetchK) } catch { extras = [] }
    }
    const literal = new Set(extras.map((hit) => hit.path))
    const rows = []
    const seen = new Set()
    // 摘录长度按来源分（与 pre-step 同一套规则）：字面命中留整句，语义命中只要够认事
    const snippetLimit = (via) => (via === 'keyword'
      ? active.excerptChars
      : Math.max(60, Math.round(active.excerptChars * active.semanticSnippetRatio)))
    const push = (hit, via) => {
      const path = hit.path || ''
      if (path && seen.has(path)) return
      if (path) seen.add(path)
      rows.push({
        docId: hit.docId ?? '',
        title: hit.title || hit.documentTitle || '未命名',
        heading: hit.heading || '',
        score: Number(hit.score) || 0,
        excerpt: compact(String(hit.excerpt ?? hit.text ?? ''), snippetLimit(via)),
        path,
        via,
        literal: via === 'keyword' || literal.has(path),
      })
    }
    for (const hit of vectors) push(hit, 'vector')
    for (const hit of extras) push(hit, 'keyword')
    // 复刻 pre-step 的挑选规则：先过阈值，再按 maxChars 预算逐条放
    let budget = active.maxChars
    let pickedCount = 0
    for (const row of rows) {
      if (row.score < active.threshold) { row.drop = 'low'; continue }
      const cost = (row.excerpt ?? '').length + (row.title ?? '').length + 8
      if (pickedCount > 0 && budget - cost < 0) { row.drop = 'budget'; continue }
      budget -= cost
      pickedCount += 1
      row.picked = true
    }
    const dropped = { low: 0, budget: 0 }
    for (const row of rows) if (row.drop) dropped[row.drop] += 1
    const picked = rows.filter((row) => row.picked)
    // 「再多给多少字才够」：只报数字不自动改配置，但能让人有目标值可调
    const budgetDropped = rows.filter((row) => row.drop === 'budget')
    const extraChars = budgetDropped.reduce((sum, row) => sum + (row.excerpt ?? '').length + (row.title ?? '').length + 8, 0)
    const need = budgetDropped.length === 0
      ? null
      : { rows: budgetDropped.length, extraChars, budgetChars: active.maxChars - budget + extraChars }
    // 两个旋钮要能一起比：预算加大 vs 摘要收短。摘要短一点、同样的预算就装得下更多篇，
    // 而「多进来的那几篇」往往比拼上全文更有用。这里只做一次纯算术模拟，不碰真实配置。
    const simulate = (excerptChars) => {
      let left = active.maxChars
      let taken = 0
      for (const row of rows) {
        if (row.score < active.threshold) continue
        const chars = Math.min((row.excerpt ?? '').length, snippetLimit(row.via))
        const cost = chars + (row.title ?? '').length + 8
        if (taken > 0 && left - cost < 0) continue
        left -= cost
        taken += 1
      }
      return taken
    }
    const ALT_EXCERPT = 120
    const altPicked = active.excerptChars > ALT_EXCERPT ? simulate(ALT_EXCERPT) : 0
    const alt = active.excerptChars > ALT_EXCERPT && altPicked > picked.length
      ? { excerptChars: ALT_EXCERPT, picked: altPicked, current: picked.length }
      : null
    return {
      query: q,
      hits: picked,
      rows,
      picked: picked.length,
      candidates: rows.length,
      dropped,
      params: {
        topK: active.topK,
        fetchK,
        threshold: active.threshold,
        maxChars: active.maxChars,
        mode: active.mode,
        perSessionDocLimit: active.perSessionDocLimit,
        excerptChars: active.excerptChars,
        trial: Object.keys(trial).length > 0,
        base: cfg.threshold !== active.threshold || cfg.maxChars !== active.maxChars || cfg.excerptChars !== active.excerptChars
          ? { threshold: cfg.threshold, maxChars: cfg.maxChars, excerptChars: cfg.excerptChars }
          : null,
      },
      need,
      alt,
      ms: Date.now() - startedAt,
      mode: result?.mode ?? 'vector',
    }
  }

  const reindex = async () => {
    const res = await fetch(`${CTX_SERVER}/reindex`, { method: 'POST', signal: AbortSignal.timeout(180000) })
    if (!res.ok) throw new Error(`ctx-server HTTP ${res.status}`)
    const env = await res.json()
    if (env.ok !== true) throw new Error(env.error ?? '重建索引失败')
    if (cache.docs) cache.at = 0
    return env.value ?? {}
  }

  const note = async ({ body }) => {
    if (!cfg.quickNote) throw Object.assign(new Error('面板已关闭速记（config.quickNote=false）'), { statusCode: 403 })
    const workspace = resolveWorkspace(ctx, cfg)
    if (!workspace) throw new Error('没有找到工作区')
    if (typeof body?.text !== 'string' || body.text.trim() === '') {
      throw Object.assign(new Error('速记内容不能为空'), { statusCode: 400 })
    }
    const result = await appendQuickNote(workspace, {
      text: body?.text,
      section: typeof body?.section === 'string' ? body.section : (body?.todo === true ? '未完成' : '产出'),
      dateKey: typeof body?.date === 'string' ? body.date : undefined,
      todo: body?.todo === true,
    })
    if (cache.docs) cache.at = 0
    let reindexed = false
    if (cfg.autoReindex) {
      try {
        await reindex()
        reindexed = true
      } catch {
        /* 索引重建失败不影响落盘 */
      }
    }
    return { ...result, reindexed, section: typeof body?.section === 'string' ? body.section : '产出' }
  }

  /**
   * 客户端探针：client 半每加载一次就来打一次点，写进同一份日志。
   * 意义：GUI 有 token 挡着、拿不到页面控制权时，这是唯一能证明
   * 「面板的 client 半真的在活页面里跑起来了」的证据链。
   */
  /**
   * 页面打点：证明 client 半真的在活页面里跑起来了。
   * 只记「新 bundle 的第一次」——同一个 rev 的 factory/apply/registered 重复上报会
   * 把日志刷成几千行，最后把自己的召回行挤出读取窗口（上一轮就是这么把统计弄成 0 的）。
   */
  const beacon = async ({ query }) => {
    const stage = String(query.get('stage') ?? 'unknown').slice(0, 120)
    const rev = (() => {
      try {
        return String(ctx.get?.('clientModules')?.composed?.rev ?? '')
      } catch {
        return ''
      }
    })()
    const key = `${stage}:${rev}`
    const now = Date.now()
    const seen = beaconSeen.get(key)
    // 有 rev 就只认一次；没 rev（服务不可用）时退化成 5 分钟内不重复
    if (rev ? seen !== undefined : seen !== undefined && now - Number(seen) < 300000) {
      return { recorded: false, skipped: 'duplicate', rev }
    }
    beaconSeen.set(key, rev ? 1 : now)
    if (beaconSeen.size > 60) {
      for (const oldKey of [...beaconSeen.keys()].slice(0, 30)) beaconSeen.delete(oldKey)
    }
    await writeLog(cfg, {
      event: 'client-beacon',
      stage,
      rev: rev || null,
      href: String(query.get('href') ?? '').slice(0, 400),
      ua: String(query.get('ua') ?? '').slice(0, 200),
      at: new Date().toISOString(),
    })
    return { recorded: true, rev: rev || null }
  }

  /**
   * 自省：client 半到底有没有被装进页面的模块图。
   * 页面需要 token、拿不到控制台，所以把宿主的 clientModules 服务形状摊开看。
   */
  const debugClient = async () => {
    const cm = ctx.get('clientModules')
    if (!cm) return { hasService: false }
    const shape = {}
    for (const key of Object.keys(cm)) {
      let value = cm[key]
      shape[key] = typeof value === 'function' ? `function/${value.length}` : typeof value
    }
    const out = { hasService: true, shape }
    const probe = (label, value) => {
      try {
        if (!value || typeof value !== 'object') return [label, typeof value]
        const keys = Object.keys(value)
        return [label, { kind: Array.isArray(value) ? 'array' : 'object', count: keys.length, keys: keys.slice(0, 200) }]
      } catch (error) {
        return [label, 'error: ' + String(error?.message ?? error)]
      }
    }
    Object.assign(shape, Object.fromEntries([
      probe('sources', cm.sources),
      probe('composed', cm.composed),
      probe('table', cm.table),
      probe('responses', cm.responses),
    ]))
    try {
      const entries = cm.composed?.entries
      const batches = cm.composed?.batches
      const list = (value) => {
        if (!value) return null
        if (Array.isArray(value)) return value.slice(0, 300).map((item) => (typeof item === 'string' ? item : Object.keys(item ?? {})))
        if (typeof value === 'object') return Object.keys(value).slice(0, 300)
        return null
      }
      out.composed = {
        rev: cm.composed?.rev ?? null,
        entries: list(entries),
        ids: Array.isArray(entries) ? entries.map((item) => (typeof item === 'string' ? item : String(item?.id ?? '?')).slice(0, 80)).filter(Boolean) : null,
        own: Array.isArray(entries) ? entries.filter((item) => String(item?.id ?? '').includes('personal-memory')).map((item) => ({ id: item.id, url: String(item.url ?? '').slice(0, 300), rev: item.rev ?? null })) : null,
        batches: list(batches),
      }
      // 别拿整份 composed 的字符串前缀去找自己：模块图有几十个条目，序列化后必定被截断，
      // 于是「找得到自己」会变成假阴性。直接在条目数组里按 id 找。
      const ownEntry = Array.isArray(entries)
        ? entries.find((item) => String(item?.id ?? item?.name ?? '').includes('personal-memory'))
        : null
      out.mentions = {
        loadedInGraph: Boolean(ownEntry),
        id: ownEntry?.id ?? null,
        rev: ownEntry?.rev ?? null,
        batchCount: Array.isArray(batches) ? batches.length : null,
      }
    } catch (error) {
      out.composedError = String(error?.message ?? error)
    }
    return out
  }

  /** 勾掉/取消一条待办：面板上把「看得见」变成「清得掉」。 */
  const todo = async ({ body }) => {
    const workspace = resolveWorkspace(ctx, cfg)
    if (!workspace) throw new Error('找不到工作区')
    const result = await toggleTodo(workspace, {
      relPath: body?.path,
      line: body?.line,
      done: body?.done,
      expect: body?.expect,
    })
    if (cache.docs) cache.at = 0
    return result
  }

  /** 改期：从今天删掉这条待办，在目标那天落一条同文的。 */
  const defer = async ({ body }) => {
    const workspace = resolveWorkspace(ctx, cfg)
    if (!workspace) throw new Error('找不到工作区')
    const result = await deferTodo(workspace, {
      relPath: body?.path,
      line: body?.line,
      expect: body?.expect,
      to: body?.to,
      note: body?.note,
    })
    if (cache.docs) cache.at = 0
    return result
  }

  /** 保存一篇已存在的笔记：hash 对不上就 409，不静默覆盖。 */
  const save = async ({ body }) => {
    const workspace = resolveWorkspace(ctx, cfg)
    if (!workspace) throw Object.assign(new Error('找不到工作区'), { statusCode: 400 })
    const result = await saveDoc(workspace, body)
    if (cache.docs) cache.at = 0
    return result
  }

  /** 往末尾补一行：路径白名单、hash 校验、重复行去重都在 appendDocLine 里 */
  const append = async ({ body }) => {
    const workspace = resolveWorkspace(ctx, cfg)
    if (!workspace) throw Object.assign(new Error('找不到工作区'), { statusCode: 400 })
    const result = await appendDocLine(workspace, body)
    if (cache.docs) cache.at = 0
    // 「补一条线索」不只是往文件里加一行：它意味着这一页刚被改过，别再当「翻过没动」提醒
    const line = String(result?.line ?? '')
    if (workspace && result?.appended && line.startsWith('- 想找')) {
      try {
        // 状态是整份读改写：必须和 /star 用同一把事务锁，否则并发时后写者会用旧 state 覆盖星标。
        await withStateLock(workspace, async () => {
          const state = await readPanelState(workspace)
          const clues = { ...(state.clues ?? {}) }
          clues[`${result.path}\u0000${line.replace(/^-\s*想找[:：]\s*/, '').slice(0, 120)}`] = {
            at: Date.now(),
            text: line.replace(/^-\s*想找[:：]\s*/, '').slice(0, 120),
            hash: String(result.hash ?? ''),
            kind: CLUE_KINDS.includes(body?.clueKind) ? body.clueKind : 'find',
          }
          await writePanelState(workspace, { ...state, clues: sanitizeClues(clues) })
        })
      } catch (err) {
        // 记不上不影响这一行已经写进文件，但至少要留个痕（比如 .dsh 被换成软链）。
        console.warn(`[personal-memory] 线索状态没记上：${err?.message ?? err}`)
      }
    }
    return result
  }

  /** 新建一篇 personal 笔记：按工作区约定生成骨架，正文留空。 */
  const create = async ({ body }) => {
    const workspace = resolveWorkspace(ctx, cfg)
    if (!workspace) throw Object.assign(new Error('找不到工作区'), { statusCode: 400 })
    const result = await createDoc(workspace, body)
    if (cache.docs) cache.at = 0
    return result
  }

  /** 面板自身状态：最近查询 + 星标（派生数据，丢了不影响笔记）。 */
  const state = async () => {
    // wait 表跟 queries/stars/ui 一起返回，客户端 reload 一次就够
    const workspace = resolveWorkspace(ctx, cfg)
    if (!workspace) return { queries: [], stars: [], ui: {}, used: {}, wait: {}, next: {}, usage: {}, moved: {}, clues: {}, resolved: {} }
    return readPanelState(workspace)
  }

  /** 面板状态的全貌：导出一份人看得懂的 json，附上条数与文件位置。 */
  const stateExport = async () => {
    const workspace = resolveWorkspace(ctx, cfg)
    if (!workspace) throw Object.assign(new Error('找不到工作区'), { statusCode: 400 })
    const state = await readPanelState(workspace)
    const file = join(workspace, STATE_REL)
    let bytes = 0
    let modified = null
    try {
      const info = await stat(file)
      bytes = info.size
      modified = info.mtime.toISOString()
    } catch { /* 文件还没建过：就是空的 */ }
    let fileVersion = 0
    let migration = { from: 0, migrated: [], fixed: 0 }
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      fileVersion = Number.isFinite(Number(parsed?.v)) ? Number(parsed.v) : 0
      const plan = migrateState(parsed)
      migration = { from: plan.from, migrated: plan.migrated, fixed: plan.fixed }
    } catch { /* 没有文件就是 0 */ }
    return { path: STATE_REL, bytes, modified, v: STATE_VERSION, fileVersion, migration, counts: stateCounts(state), tables: STATE_TABLES, state }
  }

  /**
   * 把「读的时候就地迁移」变成落盘：老文件只有在下次写状态时才会被打上版本号，
   * 在那之前每次读都要重新迁一遍。这个接口就是给人一个「现在就把版本写回去」的按钮。
   */
  const stateMigrate = async () => {
    const workspace = resolveWorkspace(ctx, cfg)
    if (!workspace) throw Object.assign(new Error('找不到工作区'), { statusCode: 400 })
    const file = join(workspace, STATE_REL)
    let plan = { from: 0, migrated: [], fixed: 0 }
    try {
      plan = migrateState(JSON.parse(await readFile(file, 'utf8')))
    } catch { /* 没有文件：写一份空的就是了 */ }
    const state = await withLock(`state:${workspace}`, async () => {
      const current = await readPanelState(workspace)
      await writePanelState(workspace, current)
      return current
    })
    return { v: STATE_VERSION, from: plan.from, migrated: plan.migrated, fixed: plan.fixed, state, counts: stateCounts(state) }
  }

  /** 清空某几张表：queries / stars / used / wait / next / moved / usage / ui */
  const stateClear = async ({ body }) => {
    const workspace = resolveWorkspace(ctx, cfg)
    if (!workspace) throw Object.assign(new Error('找不到工作区'), { statusCode: 400 })
    if (!body || typeof body !== 'object') throw Object.assign(new Error('body 必须是对象'), { statusCode: 400 })
    if (body.confirm !== true) throw Object.assign(new Error('清空是删除动作，要带 confirm: true 才执行'), { statusCode: 400 })
    const result = await clearPanelState(workspace, body.tables)
    if (cache.docs) cache.at = 0
    return result
  }

  /** 折叠偏好：{collapsed: {"month:2026-11": true}}，按 key 合并 */
  const ui = async ({ body }) => {
    const workspace = resolveWorkspace(ctx, cfg)
    if (!workspace) throw Object.assign(new Error('找不到工作区'), { statusCode: 400 })
    if (!body || typeof body !== 'object') throw Object.assign(new Error('ui 必须是对象'), { statusCode: 400 })
    return setPanelUi(workspace, body)
  }

  /** 「这条在等什么」：等行情 / 等人回 / 等自己决定。kind 留空就是清除。 */
  const wait = async ({ body }) => {
    const workspace = resolveWorkspace(ctx, cfg)
    if (!workspace) throw Object.assign(new Error('找不到工作区'), { statusCode: 400 })
    if (!body || typeof body !== 'object') throw Object.assign(new Error('body 必须是对象'), { statusCode: 400 })
    return markWait(workspace, body.text, body.kind === undefined ? null : body.kind, body.next)
  }

  /** 星标 / 取消星标。on 省略就是取反。 */
  const star = async ({ body }) => {
    const workspace = resolveWorkspace(ctx, cfg)
    if (!workspace) throw Object.assign(new Error('找不到工作区'), { statusCode: 400 })
    return toggleStar(workspace, body?.path, body?.on)
  }

  /**
   * 知识库体检：只读。
   * 和 skill kb-audit 同一套判据，但结果进面板——「笔记有没有烂掉」这件事
   * 不该只在有人主动跑脚本时才知道。
   */
  const audit = async ({ query }) => {
    const workspace = resolveWorkspace(ctx, cfg)
    if (!workspace) throw Object.assign(new Error('找不到工作区'), { statusCode: 400 })
    const docs = await scanWorkspace(workspace, cache, cfg)
    const byPath = new Set(docs.map((doc) => doc.path))
    const isIndexDoc = (path) => /(^|\/)(index|readme)\.md$/i.test(path)
    const indexDocs = docs.filter((doc) => isIndexDoc(doc.path))
    const notes = docs.filter((doc) => !isIndexDoc(doc.path))

    // 默认只体检 personal/：更新/来源/索引这些约定是给知识库定的，日记没有也不该有
    const scopes = query.get('scope')
      ? String(query.get('scope')).split(',').map((part) => part.trim()).filter(Boolean)
      : ['personal']

    // 索引引用：以 index 文档里出现的相对链接为准（`](path)` 形式）
    const referenced = new Set()
    const deadLinks = []
    for (const doc of indexDocs) {
      if (!scopes.includes(doc.scope)) continue
      const text = await readDocText(workspace, doc.path)
      const dir = doc.path.includes('/') ? doc.path.slice(0, doc.path.lastIndexOf('/')) : ''
      for (const match of text.matchAll(/\]\(([^)\s#]+)\)/g)) {
        const target = match[1]
        if (/^[a-z]+:/i.test(target)) continue
        const rel = target.startsWith('/')
          ? target.slice(1)
          : join(dir, target).split(sep).join('/')
        const norm = rel.replace(/^\.\//, '')
        // 目录链接（以 / 结尾）指向文件夹不指向文件，别当成死链
        if (norm.endsWith('/')) {
          if (existsSync(join(workspace, norm))) continue
          deadLinks.push({ path: doc.path, target: norm })
          continue
        }
        if (!byPath.has(norm)) {
          deadLinks.push({ path: doc.path, target: norm })
          continue
        }
        referenced.add(norm)
      }
    }

    const items = []
    const inScope = (doc) => scopes.length === 0 || scopes.includes(doc.scope)

    for (const doc of notes) {
      if (!inScope(doc)) continue
      // AGENTS.md 是目录的规矩说明，不是一条知识，不要求 更新/来源
      if (/(^|\/)AGENTS\.md$/i.test(doc.path)) continue
      const text = await readDocText(workspace, doc.path)
      const head = text.split('\n').slice(0, AUDIT_HEAD_LINES).join('\n').replace(/[`>]/g, ' ')
      if (!META_UPDATED_RE.test(head)) items.push({ level: 'P1', path: doc.path, issue: '缺「更新:」', hint: '补一行 更新:YYYY-MM-DD' })
      if (!META_SOURCE_RE.test(head)) items.push({ level: 'P1', path: doc.path, issue: '缺「来源:」', hint: '补一行 来源:…，不明就写「对话」' })
      if (doc.scope === 'personal' && !referenced.has(doc.path) && !/^personal\/[^/]+\.md$/.test(doc.path)) {
        items.push({ level: 'P1', path: doc.path, issue: '没被任何 index 引用', hint: '在所属主题的 index.md 加一行' })
      }
    }
    for (const dead of deadLinks) {
      items.push({ level: 'P0', path: dead.path, issue: `死链 → ${dead.target}`, hint: '修链接或补文件' })
    }
    for (const doc of notes) {
      if (doc.scope !== 'personal') continue
      if (/^personal\/[^/]+\.md$/.test(doc.path) && !/(^|\/)(index|AGENTS)\.md$/i.test(doc.path) && !/关于我\.md$/.test(doc.path)) {
        items.push({ level: 'P1', path: doc.path, issue: '根目录裸文件', hint: '归入某个主题目录' })
      }
    }

    const order = { P0: 0, P1: 1, P2: 2 }
    items.sort((left, right) => (order[left.level] ?? 9) - (order[right.level] ?? 9) || left.path.localeCompare(right.path))
    return {
      items: items.slice(0, 80),
      counts: {
        p0: items.filter((item) => item.level === 'P0').length,
        p1: items.filter((item) => item.level === 'P1').length,
        p2: items.filter((item) => item.level === 'P2').length,
        total: items.length,
      },
      // 只数体检范围内的笔记：默认只看 personal/，写到面板上的数字就得是同一范围
      notes: notes.filter((doc) => scopes.includes(doc.scope)).length,
      topics: [...new Set(docs.filter((doc) => doc.scope === 'personal').map((doc) => doc.dir))].sort(),
      at: new Date().toISOString(),
    }
  }

  /** 路由表：统一签名 ({ query, body }) → value，避免 GET/POST 参数错位。 */
  const routes = {
    'GET /status': status,
    'GET /beacon': beacon,
    'POST /todo': todo,
    'POST /todo/defer': defer,
    'GET /debug/client': debugClient,
    'GET /tree': tree,
    'GET /doc': doc,
    'GET /timeline': timeline,
    'GET /search': search,
    'POST /test': test,
    'POST /reindex': reindex,
    'POST /note': note,
    'POST /save': save,
    'POST /create': create,
    'GET /state': state,
    'GET /audit': audit,
    // 「翻过但没动」：打开过、但之后再没改过的笔记。这类通常是「当时觉得有用，后来忘了」。
    'GET /visited': async ({ query }) => {
      const workspace = resolveWorkspace(ctx, cfg)
      if (!workspace) return { items: [], total: 0 }
      const limit = Math.min(Math.max(1, Math.trunc(Number(query.get('limit')) || 20)), 60)
      const state = await readPanelState(workspace)
      const used = state.used ?? {}
      const clues = state.clues ?? {}
      const docs = await scanWorkspace(workspace, cache, cfg)
      const items = []
      for (const doc of docs) {
        const at = Number(used[doc.path]?.at ?? used[doc.path]) || 0
        const dwell = Math.max(0, Math.trunc(Number(used[doc.path]?.dwell) || 0))
        if (at <= 0) continue
        const mtimeMs = Number(doc.mtimeMs) || Date.parse(doc.mtime) || 0
        // 打开之后没再改过才算「翻了没动」：差 1 分钟内的算作「打开时顺手改了」
        if (mtimeMs >= at - 60000) continue
        // 刚补过线索的目录页先别提醒：补完立刻又出现在同一张表上，等于告诉人「你刚才做的事没用」
        // 线索按「页 + 正文」建档，所以这一页上任意一条刚补过，都算刚补过
        const quiet = Object.entries(clues).some(([key, entry]) => (
          (key === doc.path || key.startsWith(`${doc.path}\u0000`))
          && Number(entry?.at) >= at
          && Date.now() - Number(entry?.at) < CLUE_QUIET_MS
        ))
        if (quiet) continue
        // 目录页（index/README）被打开通常只是「进去找东西」，跟正文页的「看了没动」不是一回事
        // doc.file 是去掉扩展名的 basename（describeFile 里 name = basename(abs, '.md')）
        const kind = /^(index|readme)$/i.test(String(doc.file ?? '')) ? 'index' : 'note'
        items.push({ path: doc.path, title: doc.title, scope: doc.scope, dir: doc.dir, kind, usedAt: at, dwell, mtimeMs, daysSinceUsed: Math.max(0, Math.floor((Date.now() - at) / 86400000)) })
      }
      items.sort((a, b) => b.usedAt - a.usedAt)
      return { items: items.slice(0, limit), total: items.length }
    },
    // 「这页的线索」：把所有 `- 想找：…` 收在一处。
    // 单看一行看不出名堂，攒起来才看得出「我反复在找什么」。
    'GET /clues': async ({ query }) => {
      const workspace = resolveWorkspace(ctx, cfg)
      if (!workspace) return { items: [], total: 0 }
      const limit = Math.min(Math.max(1, Math.trunc(Number(query.get('limit')) || 100)), 300)
      const scopes = (query.get('scope') ?? '').split(',').filter((item) => /^(personal|memory|project)$/.test(item))
      const state = await readPanelState(workspace)
      const clues = state.clues ?? {}
      const resolved = state.resolved ?? {}
      const docs = await scanWorkspace(workspace, cache, cfg)
      const items = []
      for (const doc of docs) {
        if (scopes.length > 0 && !scopes.includes(doc.scope)) continue
        let text = ''
        try { text = await readFile(join(workspace, doc.path), 'utf8') } catch { continue }
        const lines = text.split('\n')
        for (let index = 0; index < lines.length; index += 1) {
          const match = /^\s*-\s*想找[:：]\s*(.+)$/.exec(lines[index])
          if (!match) continue
          const body = String(match[1] ?? '').trim()
          if (!body) continue
          const clue = clues[`${doc.path}\u0000${body}`] ?? clues[doc.path]
          const mtimeMs = Number(doc.mtimeMs) || Date.parse(doc.mtime) || 0
          // 「还悬着」= 补了线索之后这页没再被改过；改过就说明当时那条线索已经落进正文了。
          // 用文件指纹判断而不是时间戳：判据要能解释「改了一次就算处理」，不该受同一秒内写盘影响
          const clueHash = String(clue?.hash ?? '')
          const touchedAfter = clueHash ? hashText(text) !== clueHash : false
          // 「我自己标过解决」跟「这页被改过」是两件不同的事：前者不该被文件变动抹掉
          const resolvedAt = Number(resolved[clueKeyOf(body)]) || 0
          // 「悬了多久」：从补下这条线索那天算。没记录（老线索/手动写的）就如实给 null，
          // 别拿文件 mtime 冒充——那说明的是「这页最后改过」，不是「这条等了多少天」
          const clueAt = Number(clue?.at) || 0
          items.push({
            clueKind: CLUE_KINDS.includes(clue?.kind) ? clue.kind : 'find',
            path: doc.path,
            title: doc.title,
            scope: doc.scope,
            dir: doc.dir,
            kind: /^(index|readme)$/i.test(String(doc.file ?? '')) ? 'index' : 'note',
            text: body,
            line: index + 1,
            mtimeMs,
            resolvedAt,
            clueAt,
            ageDays: clueAt > 0 ? Math.max(0, Math.floor((Date.now() - clueAt) / 86400000)) : null,
            open: !touchedAfter && resolvedAt === 0,
          })
        }
      }
      // 还悬着的排前面；同一档里「悬得越久越靠前」——挂了两周的线索比刚记的十条更值得看
      items.sort((a, b) => {
        if (a.open !== b.open) return a.open ? -1 : 1
        const ageA = a.ageDays === null ? -1 : a.ageDays
        const ageB = b.ageDays === null ? -1 : b.ageDays
        if (ageA !== ageB) return ageB - ageA
        return b.mtimeMs - a.mtimeMs
      })
      const open = items.filter((item) => item.open).length
      // 线索可以「直接记」，不必先路过某一页：把可落点的目录页一起给出去
      const indexPages = docs
        .filter((doc) => /^(index|readme)$/i.test(String(doc.file ?? '')))
        .map((doc) => ({ path: doc.path, title: doc.title, scope: doc.scope }))
        .sort((a, b) => (a.scope === 'personal' ? -1 : 0) - (b.scope === 'personal' ? -1 : 0))
      // 最近解决的留在视线里一周：解决完就消失，看不出「我最近在补哪些缺口」
      const week = 7 * 86400000
      const recent = Object.entries(resolved)
        .map(([text, at]) => ({ text, at: Number(at) || 0 }))
        .filter((row) => row.at > 0 && Date.now() - row.at < week)
        .sort((a, b) => b.at - a.at)
        .slice(0, 10)
        .map((row) => ({ ...row, days: Math.max(0, Math.floor((Date.now() - row.at) / 86400000)) }))
      return { items: items.slice(0, limit), total: items.length, open, recent, indexPages }
    },
    // 线索的「我解决了」：跟「这页改过」分开记（写在别处也算解决，改过也不一定解决）
    'POST /clue/resolve': async ({ body }) => {
      const workspace = resolveWorkspace(ctx, cfg)
      if (!workspace) throw Object.assign(new Error('找不到工作区'), { statusCode: 400 })
      const text = clueKeyOf(body?.text)
      if (!text) throw Object.assign(new Error('缺少线索正文'), { statusCode: 400 })
return withLock(`state:${workspace}`, async () => {
        const state = await readPanelState(workspace)
        const resolved = { ...(state.resolved ?? {}) }
        const on = body?.resolved === undefined ? !resolved[text] : body.resolved === true
        if (on) resolved[text] = Date.now()
        else delete resolved[text]
        const next = sanitizeResolved(resolved)
        await writePanelState(workspace, { ...state, resolved: next })
        return { text, resolved: on, count: Object.keys(next).length, at: next[text] ?? 0 }
})
    },
    'GET /experiments': async ({ query }) => {
      const workspace = resolveWorkspace(ctx, cfg)
      if (!workspace) return { path: EXPERIMENTS_REL, total: 0, items: [] }
      return readExperiments(workspace, query.get('limit'))
    },
    'POST /experiment': async ({ body }) => {
      const workspace = resolveWorkspace(ctx, cfg)
      if (!workspace) throw Object.assign(new Error('找不到工作区'), { statusCode: 400 })
      return appendExperiment(workspace, body)
    },
    'GET /state/export': stateExport,
    'POST /state/clear': stateClear,
    'POST /state/migrate': stateMigrate,
    'POST /star': star,
    'POST /used': used,
    'POST /append': append,
    'POST /ui': ui,
    'POST /wait': wait,
  }

  return {
    kind: 'prefix',
    path: prefix,
    handler: (req, res) => {
      // 浏览器信任闸门（与官方 api-request-trust 同语义），放在读 body 之前：
      // 跨站页面、DNS rebinding、任意 Origin 都进不来；curl 不带 Origin 照常放行。
      if (!isTrustedRequest(req, guardOptions(ctx, cfg))) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: false, error: { code: 'forbidden', message: '来源不可信' } }))
        return
      }
      void (async () => {
        let pathname = '/'
        let query = new URLSearchParams()
        try {
          const parsed = new URL(req.url ?? '/', 'http://dsh.internal')
          pathname = parsed.pathname.slice(prefix.length) || '/'
          query = parsed.searchParams
        } catch {
          /* 用默认 */
        }
        const send = (statusCode, value) => {
          res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(value))
        }
        const key = `${req.method} ${pathname}`
        const route = routes[key]
        if (!route) {
          send(404, { ok: false, error: { code: 'not-found', message: `no route for ${key}` } })
          return
        }
        try {
          const body = req.method === 'POST' ? await readJsonBody(req) : undefined
          const value = await route({ query, body })
          send(200, { ok: true, value })
        } catch (error) {
          const code = error?.statusCode === 400 ? 400 : error?.statusCode === 403 ? 403 : error?.statusCode === 409 ? 409 : 500
          const name = code === 400 ? 'invalid_request' : code === 403 ? 'forbidden' : code === 409 ? 'conflict' : 'error'
          send(code, { ok: false, error: { code: name, message: String(error?.message ?? error) } })
        }
      })()
    },
  }
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */

export function apply(ctx, rawConfig) {
  const cfg = readConfig(rawConfig)
  if (!cfg.enabled) return

  /** sessionId -> 已经处理过的用户消息 id */
  const handled = new Map()
  const cache = createCache(cfg)

  async function preStep(payload, next) {
    const decision = await next()
    if (decision?.kind !== 'enter') return decision
    if (payload?.signal?.aborted) return decision

    const agent = payload?.agent
    const header = agent?.session?.header
    // 子代理不召回：它拿到的任务是父代理写的，注入会污染上下文。
    if (header?.origin === 'subagent') return decision

    const sessionId = header?.id ?? agent?.id ?? 'unknown'
    /** 放弃这次召回；只有 debug 开时才写一行原因，正常运行时保持安静。 */
    async function bail(reason) {
      if (cfg.debug) {
        await writeLog(cfg, {
          at: new Date().toISOString(),
          event: 'skip',
          session: sessionId,
          turn: payload?.turn,
          step: payload?.step,
          reason,
        })
      }
      return decision
    }
    if (cfg.debug) {
      await writeLog(cfg, {
        at: new Date().toISOString(),
        event: 'pre-step',
        session: sessionId,
        origin: header?.origin ?? null,
        turn: payload?.turn,
        step: payload?.step,
        messages: (decision.messages ?? []).slice(-4).map((m) => `${m?.role}/${m?.source?.kind ?? '?'}/${textOf(m).length}`),
      })
    }
    const incoming = latestUserEvent(agent?.session)
    if (!incoming) return bail('no-user-message')
    if (handled.get(sessionId) === incoming.id) return bail('already-handled')

    const query = incoming.text.slice(0, cfg.maxQueryChars)
    if (query.length < cfg.minQueryChars) return bail('query-too-short')
    if (/^[/!]/.test(query)) return bail('slash-command') // 斜杠命令不是问题

    const startedAt = Date.now()
    let hits = []
    let usedChars = 0
    try {
      const seen = alreadyInjected(agent?.session)
      const quota = cfg.perSessionDocLimit - seen.size
      if (quota <= 0) return bail('quota-exhausted')
      const result = await localSearch(query, cfg, Math.max(cfg.topK * 3, 8), withTimeout(payload.signal, cfg.timeoutMs))
      const ranked = (result?.hits ?? [])
        .filter((hit) => hit && typeof hit.text === 'string' && hit.score >= cfg.threshold && !seen.has(hit.docId))
        .sort((a, b) => b.score - a.score)

      const picked = []
      const claimed = new Set()
      let budget = cfg.maxChars
      for (const hit of ranked) {
        if (picked.length >= Math.min(cfg.topK, quota)) break
        if (claimed.has(hit.docId)) continue
        // 摘录长度按来源分：字面命中的句子是「他真写过的话」，值得整句留着；
        // 语义命中的只需要够认出「讲的是哪件事」，省下的预算能多装一篇。
        const limit = hit.via === 'keyword' ? cfg.excerptChars : Math.max(60, Math.round(cfg.excerptChars * cfg.semanticSnippetRatio))
        const excerpt = compact(hit.text, limit)
        if (excerpt.length > budget) continue
        budget -= excerpt.length
        claimed.add(hit.docId)
        picked.push({
          docId: hit.docId,
          title: (hit.documentTitle || '未命名').trim(),
          heading: (hit.heading || '').trim(),
          score: hit.score,
          excerpt,
          path: hit.path || '',
        })
      }
      // 混合召回：向量只认「意思像」，查代码号/端口/股票代号这类精确词它会漏。
      // 所以向量挑完之后，预算还有就补几条「字面命中」的，并且记下来源——
      // 面板里要能回答「这篇是被语义撞上的，还是我真的写过这几个字」。
      if (cfg.mode === 'hybrid' && picked.length < Math.min(cfg.topK, quota) && budget > 0) {
        let extras = []
        try {
          extras = await keywordHits(resolveWorkspace(ctx, cfg), cache, cfg, query, null, Math.max(cfg.topK * 3, 8))
        } catch {
          extras = [] // 词面层失败不影响向量结果
        }
        const pickedPaths = new Set(picked.map((hit) => hit.path).filter(Boolean))
        for (const hit of extras) {
          if (picked.length >= Math.min(cfg.topK, quota)) break
          if (!hit.path || pickedPaths.has(hit.path)) continue
          const excerpt = compact(hit.text ?? hit.excerpt ?? '', cfg.excerptChars)
          if (!excerpt || excerpt.length > budget) continue
          budget -= excerpt.length
          pickedPaths.add(hit.path)
          picked.push({
            docId: hit.docId,
            title: (hit.title || '未命名').trim(),
            heading: '',
            score: Number(hit.score) || 0,
            excerpt,
            path: hit.path,
            via: 'keyword',
          })
        }
        // 向量与词面都命中的，标成 both：分数是向量的，但字面也中
        const literalPaths = new Set(extras.map((hit) => hit.path).filter(Boolean))
        for (const hit of picked) {
          if (!hit.via) hit.via = hit.path && literalPaths.has(hit.path) ? 'both' : 'vector'
        }
      } else {
        for (const hit of picked) hit.via = 'vector'
      }
      hits = picked
      usedChars = cfg.maxChars - budget
    } catch (error) {
      await writeLog(cfg, {
        at: new Date().toISOString(),
        session: sessionId,
        query: compact(query, 80),
        error: String(error?.message ?? error),
      })
      return decision
    }

    handled.set(sessionId, incoming.id)
    if (hits.length === 0) {
      await writeLog(cfg, {
        at: new Date().toISOString(),
        session: sessionId,
        query: compact(query, 80),
        hits: 0,
        ms: Date.now() - startedAt,
      })
      return decision
    }

    await writeLog(cfg, {
      at: new Date().toISOString(),
      session: sessionId,
      query: compact(query, 80),
      hits: hits.length,
      docs: hits.map((hit) => `${hit.title}:${hit.score.toFixed(3)}`),
      // items 带路径：面板里能点进去看当时召回的是哪几篇（老日志没有这一项，只显示标题）
      // chars/truncated 让面板能回答「这一轮注入的内容到底有多密、哪几篇被截了」
      items: hits.map((hit) => ({
        path: hit.path ?? '',
        title: hit.title ?? '',
        score: Number(hit.score) || 0,
        chars: String(hit.excerpt ?? '').length,
        truncated: String(hit.excerpt ?? '').length >= cfg.excerptChars,
        via: hit.via ?? 'vector',
      })),
      budget: cfg.maxChars,
      used: usedChars,
      ms: Date.now() - startedAt,
    })
    // 日志之外再存一份日汇总：日志被清空，累计召回和命中率也不该归零
    void bumpRecallUsage(resolveWorkspace(ctx, cfg), hits.length, usedChars)

    return { kind: 'enter', messages: [...decision.messages, injectionMessage(renderBlock(hits))] }
  }

  void writeLog(cfg, {
    at: new Date().toISOString(),
    event: 'mounted',
    baseId: cfg.baseId || '(all)',
    topK: cfg.topK,
    mode: cfg.mode,
    workspace: resolveWorkspace(ctx, cfg),
  })

  // Web 面板的数据接口。client 半 fetch('/personal-memory/…')。
  // 没有 webServer / effect 的环境（比如离线冒烟）直接跳过，不影响召回主流程。
  if (typeof ctx.effect === 'function' && typeof ctx.webServer?.register === 'function') {
    ctx.effect(() => ctx.webServer.register(apiRoute(cfg, ctx, cache)), 'personal-memory: /personal-memory route')
  }

  ctx.on('agent/pre-step', preStep, { prepend: true })
  ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = agent?.session?.header?.id ?? agent?.id
    if (sessionId) handled.delete(sessionId)
  })
}

export default { name, inject, apply }
