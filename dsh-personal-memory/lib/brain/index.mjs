// lib/brain/index.mjs —— 脑图控制器：懒开库、按笔记指纹重建、召回融合、面板数据。
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defaultBrainPath, brainStats, openBrain } from './db.mjs'
import { rebuildFromNotes, loadCtxEmbeddings, NOTE_ROOT_NAMES } from './index-notes.mjs'
import { BRAIN_DEFAULTS, brainRecall, commitTouch } from './recall.mjs'
import { scanSessions } from './sessions.mjs'
import { consolidate as runConsolidate } from './consolidate.mjs'
import { brainLog, clamp, clamp01, compact, nowIso, sha256 } from './util.mjs'
import { classifyNode } from './classify.mjs'

const GRAPH_LIMIT = 4000
const KIND_FILTERS = { all: null, note: ['note'], episode: ['episode'], memory: ['memory'] }

const NODE_COLS = `node_key, node_kind, source, heading, title, content, node_type, salience, valence, arousal,
  activation, access_count, last_activated, pinned, created_at, updated_at`

function toGraphNode(row, degree) {
  const type = row.node_type || classifyNode(row)
  return {
    id: row.node_key,
    type,
    strength: clamp01(row.salience ?? 0.5),
    valence: clamp(Number(row.valence ?? 0), -1, 1),
    ts: Date.parse(row.last_activated || row.valid_from || row.created_at) || Date.now(),
    label: row.heading ? `${row.title || ''}·${row.heading}` : row.title || compact(row.content, 24),
    content: compact(row.content, 400),
    memoryId: row.node_key,
    source: row.source,
    degree: degree ?? 0,
    activation: Number(row.activation ?? 0),
    nodeKind: row.node_kind,
    heading: row.heading || '',
    pinned: Boolean(row.pinned),
    title: row.title || '',
  }
}

export function createBrain(options = {}) {
  const getConfig = options.getConfig ?? (() => ({}))
  const resolveWorkspace = options.resolveWorkspace ?? (() => null)
  const log = options.log ?? ((entry) => brainLog({}, entry))

  let brain = null
  let openedFor = ''

  function cfg() {
    const base = getConfig() || {}
    return {
      ...BRAIN_DEFAULTS,
      enabled: base.enabled !== false,
      ingestSessions: base.ingestSessions !== false,
      sessionsRoot: base.sessionsRoot || '',
      maxSessionFiles: Number(base.maxSessionFiles) || 400,
      consolidateLimit: Number(base.consolidateLimit) || 400,
      ...base,
    }
  }

  function ensureWorkspace() {
    const workspace = resolveWorkspace()
    if (!workspace) throw Object.assign(new Error('找不到工作区（需要含 personal/ 与 memory/ 的目录）'), { statusCode: 400 })
    return workspace
  }

  /**
   * 库路径：主工作区用 ~/.dsh/personal-memory/brain.db；换到别的工作区（比如离线冒烟）
   * 时另开 brain-<hash8>.db，避免一次 rebuild 把真库的笔记节点清空。
   */
  function resolvePath(workspace) {
    const c = cfg()
    if (c.dbPath) return String(c.dbPath)
    if (process.env.PM_BRAIN_DB) return String(process.env.PM_BRAIN_DB)
    const primary = defaultBrainPath()
    if (!workspace || !existsSync(primary)) return primary
    try {
      const probe = openBrain({ path: primary })
      const owner = probe.meta('workspace')
      probe.close()
      if (!owner || owner === workspace) return primary
      return join(dirname(primary), `brain-${sha256(workspace).slice(0, 8)}.db`)
    } catch {
      return primary
    }
  }

  /** 打开脑库；路径变了就重开。 */
  function ensureBrain() {
    const c = cfg()
    const path = resolvePath(resolveWorkspace())
    if (brain && openedFor === path) return brain
    if (brain) {
      try {
        brain.close()
      } catch {
        /* 忽略 */
      }
      brain = null
    }
    brain = openBrain({ path })
    openedFor = path
    return brain
  }

  /** 笔记指纹变了就重建（默认 true）；失败不抛，返回 ok:false。 */
  function ensureIndexed(force = false) {
    const started = Date.now()
    const instance = ensureBrain()
    const workspace = ensureWorkspace()
    const c = cfg()
    if (instance.meta('workspace') && instance.meta('workspace') !== workspace) force = true
    let embeddings = null
    try {
      embeddings = loadCtxEmbeddings(resolveCtxDb(workspace), workspace)
    } catch {
      embeddings = null
    }
    try {
      const result = rebuildFromNotes(instance, { workspace, embeddings, force })
      if (!result.skipped) instance.setMeta('workspace', workspace)
      if (!result.skipped) {
        log({ event: 'brain-rebuild', nodes: result.nodes, edges: result.edges, edgeSource: result.source, ms: result.ms ?? Date.now() - started })
      }
      return { ok: true, ...result }
    } catch (error) {
      log({ event: 'brain-rebuild-failed', error: String(error?.message ?? error) })
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  /**
   * ctx.db 探测：ctx-server 自报路径经常是旧家目录，这里按「工作区 .dsh 优先」找真实库。
   * 找不到就返回 null，边退回本地 bigram 相似度。
   */
  function resolveCtxDb(workspace) {
    const home = process.env.DSH_HOME || join(process.env.HOME || '', '.dsh')
    const candidates = [
      process.env.PM_CTX_DB,
      workspace ? join(workspace, '.dsh', 'contextdb', 'ctx.db') : null,
      join(home, 'contextdb', 'ctx.db'),
    ].filter(Boolean)
    for (const path of candidates) {
      try {
        if (existsSync(path)) return path
      } catch {
        /* 继续找 */
      }
    }
    return null
  }

  function counts() {
    try {
      const instance = ensureBrain()
      const rows = instance.db
        .prepare("SELECT node_kind, COUNT(*) AS n FROM nodes WHERE merged_into IS NULL GROUP BY node_kind")
        .all()
      const edges = Number(instance.db.prepare('SELECT COUNT(*) AS n FROM synapses').get()?.n ?? 0)
      const notes = rows.find((row) => row.node_kind === 'note')?.n ?? 0
      const episodes = rows.find((row) => row.node_kind === 'episode')?.n ?? 0
      return { notes: Number(notes), episodes: Number(episodes), edges, byKind: Object.fromEntries(rows.map((row) => [row.node_kind, Number(row.n)])) }
    } catch {
      return { notes: 0, episodes: 0, edges: 0, byKind: {} }
    }
  }

  function health() {
    const workspace = resolveWorkspace()
    let stats = null
    if (workspace) {
      try {
        stats = brainStats(ensureBrain())
      } catch (error) {
        return { ok: false, workspace, error: String(error?.message ?? error) }
      }
    }
    const c = cfg()
    return {
      ok: Boolean(workspace),
      workspace,
      enabled: c.enabled !== false,
      dbPath: stats?.dbPath ?? String(c.dbPath || defaultBrainPath()),
      nodes: stats?.nodes ?? 0,
      synapses: stats?.synapses ?? 0,
      archived: stats?.archived ?? 0,
      edgeSource: stats?.lastIndexSource ?? null,
      lastIndexAt: stats?.lastIndexAt ?? null,
      alpha: c.alpha,
      beta: c.beta,
      episodeWeight: c.episodeWeight,
      ingestSessions: Boolean(c.ingestSessions),
      lastSessionIngestAt: brain?.meta('last_session_ingest_at') ?? null,
      lastConsolidateAt: brain?.meta('last_consolidate_at') ?? null,
      counts: counts(),
      now: nowIso(),
    }
  }

  function graph(options = {}) {
    const instance = ensureBrain()
    const c = cfg()
    const limit = Math.min(Math.max(Number(options.limit) || 2500, 50), GRAPH_LIMIT)
    const minWeight = clamp01(options.minWeight ?? c.minEdgeWeight ?? 0.2)
    const kindKey = String(options.kind || 'all')
    const kinds = KIND_FILTERS[kindKey] ?? null
    const where = kinds ? `merged_into IS NULL AND node_kind IN (${kinds.map(() => '?').join(',')})` : 'merged_into IS NULL'
    const db = instance.db
    const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM nodes WHERE ${where}`).get(...(kinds ?? []))?.n ?? 0)
    const rows = db
      .prepare(
        `SELECT ${NODE_COLS} FROM nodes WHERE ${where}
         ORDER BY pinned DESC, salience DESC, access_count DESC, updated_at DESC LIMIT ?`,
      )
      .all(...(kinds ?? []), limit)
    const keys = rows.map((row) => row.node_key)
    const ids = JSON.stringify(keys)
    const edges = keys.length
      ? db
          .prepare(
            `SELECT src, dst, kind, weight FROM synapses
             WHERE weight >= ? AND src IN (SELECT value FROM json_each(?)) AND dst IN (SELECT value FROM json_each(?))
             ORDER BY weight DESC LIMIT ?`,
          )
          .all(minWeight, ids, ids, limit * 8)
          .map((edge) => ({ source: edge.src, target: edge.dst, kind: edge.kind, weight: Number(edge.weight) }))
      : []
    const degree = new Map()
    for (const edge of edges) {
      degree.set(edge.source, (degree.get(edge.source) || 0) + 1)
      degree.set(edge.target, (degree.get(edge.target) || 0) + 1)
    }
    return {
      meta: {
        title: 'personal-memory brain',
        synthetic: false,
        nodes: rows.length,
        edges: edges.length,
        total,
        truncated: total > rows.length,
        limit,
        minWeight,
        kind: kindKey,
        counts: counts(),
        workspace: resolveWorkspace(),
        dbPath: instance.path,
        revision: Number(instance.meta('notes_fingerprint') ? 1 : 0),
        generatedAt: nowIso(),
      },
      nodes: rows.map((row) => toGraphNode(row, degree.get(row.node_key) ?? 0)),
      edges,
    }
  }

  function node(key) {
    const instance = ensureBrain()
    const row = instance.db.prepare(`SELECT ${NODE_COLS} FROM nodes WHERE node_key = ?`).get(String(key ?? ''))
    if (!row) throw Object.assign(new Error('节点不存在'), { statusCode: 404 })
    const edges = instance.db
      .prepare('SELECT dst AS target, kind, weight FROM synapses WHERE src = ? ORDER BY weight DESC LIMIT 64')
      .all(row.node_key)
    return { node: toGraphNode(row, edges.length), edges }
  }

  function recall(query, extra = {}) {
    const c = { ...cfg(), ...extra }
    const workspace = resolveWorkspace()
    if (!workspace) return { rows: [], seeds: 0, activated: 0 }
    const instance = ensureBrain()
    // 第一次调用时按需建库（避免面板打开前一句召回要等重建）
    if (!instance.meta('notes_fingerprint')) ensureIndexed(false)
    const result = brainRecall(instance, query, c)
    if (result.rows.length) {
      try {
        commitTouch(instance, result.rows.map((row) => row.nodeKey), {
          session: extra.sessionId ?? null,
          queryHash: sha256(String(query)).slice(0, 16),
          source: 'recall',
        })
      } catch {
        /* 激活写回失败不影响注入 */
      }
    }
    const rows = result.rows.map((row) => ({
      docId: `brain:${row.nodeKey}`,
      nodeKey: row.nodeKey,
      documentTitle: row.title,
      heading: row.heading,
      text: row.text,
      score: row.final,
      path: row.path,
      nodeKind: row.nodeKind,
      final: row.final,
      via: 'brain',
      hop: row.hop,
      cos: row.cos,
      act: row.act,
    }))
    return { ...result, rows }
  }

  function touch(payload = {}) {
    const instance = ensureBrain()
    const keys = Array.isArray(payload.keys) ? payload.keys : payload.nodeKey ? [payload.nodeKey] : []
    const n = commitTouch(instance, keys, { source: payload.source ?? 'panel', session: payload.session ?? null })
    return { touched: n, at: nowIso() }
  }

  /** 会话回合入库：默认按 (size, mtime) 跳过未变化的文件。 */
  function ingestSessions(options = {}) {
    const c = cfg()
    const instance = ensureBrain()
    const root = options.root || c.sessionsRoot || undefined
    const result = scanSessions(instance, {
      root,
      force: options.force === true || c.force === true,
      maxFiles: options.maxFiles || c.maxSessionFiles,
    })
    try {
      log({ event: 'brain-ingest-sessions', ...result })
    } catch {
      /* 日志失败不影响 */
    }
    return { ...result, counts: counts() }
  }

  /** 巩固：episode 聚类成 note 型节点，原 episode 降权不删。 */
  function consolidate(options = {}) {
    const c = cfg()
    const result = runConsolidate(ensureBrain(), { limit: options.limit || c.consolidateLimit })
    try {
      log({ event: 'brain-consolidate', ...result })
    } catch {
      /* 忽略 */
    }
    return { ...result, counts: counts() }
  }

  function rebuild() {
    return ensureIndexed(true)
  }

  function stats() {
    try {
      return brainStats(ensureBrain())
    } catch (error) {
      return { error: String(error?.message ?? error), dbPath: openedFor || defaultBrainPath() }
    }
  }

  function close() {
    if (brain) {
      try {
        brain.close()
      } catch {
        /* 忽略 */
      }
      brain = null
      openedFor = ''
    }
  }

  return {
    ensureBrain,
    ensureIndexed,
    health,
    graph,
    node,
    recall,
    touch,
    rebuild,
    ingestSessions,
    consolidate,
    counts,
    stats,
    close,
    roots: NOTE_ROOT_NAMES,
  }
}
