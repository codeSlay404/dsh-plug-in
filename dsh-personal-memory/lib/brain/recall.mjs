// lib/brain/recall.mjs —— 只做「脑图侧」检索：关键词种子 → 扩散 → 与语义分融合。
// 注入块的渲染仍由 index.js 的 renderBlock 负责，保证一轮对话只有一块召回。
import { spreadActivation } from './spread.mjs'
import { clamp01, compact, nowIso } from './util.mjs'

export const BRAIN_DEFAULTS = {
  alpha: 0.7,
  beta: 0.3,
  seedK: 5,
  hopCount: 3,
  hopDecay: 0.65,
  minWeight: 0.15,
  minActivation: 0.02,
  maxNodes: 256,
  fanout: 32,
  inhibitionScale: 1,
  threshold: 0.1,
  topK: 4,
  maxChars: 600,
  fuseTopK: 3,
  minQueryChars: 4,
  /** 两类节点的召回权重：笔记优先，会话片段降权（不删，只降）。 */
  noteWeight: 1,
  episodeWeight: 0.6,
}

const NODE_SQL = `
SELECT node_key, node_kind, source, heading, title, content, node_type, salience, activation, access_count, last_activated
FROM nodes WHERE merged_into IS NULL AND node_kind IN ('note', 'memory', 'episode')
LIMIT 20000
`

/** 查询分词：中文 bigram + 拉丁词，按经验停用表过滤。 */
export function queryTokens(query) {
  const text = String(query ?? '').toLowerCase()
  const tokens = new Set()
  for (const word of text.match(/[a-z0-9_]{2,}/g) || []) tokens.add(word)
  const cjk = text.replace(/[^\p{Script=Han}]+/gu, ' ')
  for (const run of cjk.split(/\s+/)) {
    if (!run) continue
    if (run.length === 1) tokens.add(run)
    for (let i = 0; i < run.length - 1; i += 1) tokens.add(run.slice(i, i + 2))
  }
  return [...tokens].slice(0, 160)
}

function gramsOf(text) {
  const clean = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*`|_\-\[\]()（）「」《》：:，,。.！!？?、；;"'“”‘’\s]/g, '')
    .toLowerCase()
  const set = new Set()
  for (let i = 0; i < clean.length - 1; i += 1) set.add(clean.slice(i, i + 2))
  return set
}

/** 关键词打分：idf 加权 bigram 覆盖率，归一到 0..1。 */
export function scoreByQuery(rows, query) {
  const tokens = queryTokens(query).filter((t) => t.length > 1)
  if (!tokens.length) return []
  const df = new Map()
  const grams = new Map()
  for (const row of rows) {
    const set = gramsOf(`${row.title} ${row.heading} ${row.content}`)
    grams.set(row.node_key, set)
    for (const token of tokens) if (set.has(token)) df.set(token, (df.get(token) || 0) + 1)
  }
  const total = Math.max(1, rows.length)
  const weights = new Map(tokens.map((t) => [t, Math.log(1 + total / (1 + (df.get(t) || 0))) ]))
  const weighted = tokens.reduce((sum, t) => sum + weights.get(t), 0) || 1
  const scored = []
  for (const row of rows) {
    const set = grams.get(row.node_key)
    let hit = 0
    for (const token of tokens) if (set.has(token)) hit += weights.get(token)
    if (!hit) continue
    scored.push({ row, cos: clamp01(hit / weighted) })
  }
  scored.sort((a, b) => b.cos - a.cos)
  return scored
}

/**
 * 脑图召回：种子 = 关键词命中 × 显著性；扩散后 final = alpha*cos + beta*act。
 * @returns {{rows:Array, seeds:number, activated:number, ms:number}}
 */
export function brainRecall(brain, query, options = {}) {
  const opts = { ...BRAIN_DEFAULTS, ...options }
  const started = Date.now()
  const db = brain.db
  const rows = db.prepare(NODE_SQL).all()
  if (!rows.length) return { rows: [], seeds: 0, activated: 0, ms: 0 }

  const scored = scoreByQuery(rows, query).slice(0, Math.max(opts.seedK, 1))
  const seeds = new Map()
  for (const item of scored) {
    const salience = clamp01(item.row.salience ?? 0.5)
    const activation = item.cos * (0.55 + 0.45 * salience)
    if (activation >= opts.minActivation) seeds.set(item.row.node_key, activation)
  }

  let act = seeds
  let hop = new Map([...seeds.keys()].map((key) => [key, 0]))
  let traversed = new Set()
  if (seeds.size) {
    const spread = spreadActivation(db, seeds, {
      hops: opts.hopCount,
      decay: opts.hopDecay,
      minWeight: opts.minWeight,
      minActivation: opts.minActivation,
      maxNodes: opts.maxNodes,
      fanout: opts.fanout,
      inhibitionScale: opts.inhibitionScale,
    })
    act = spread.act
    hop = spread.hop
    traversed = spread.traversed
  }

  const cosOf = new Map(scored.map((item) => [item.row.node_key, item.cos]))
  const actMax = Math.max(opts.minActivation, ...act.values())
  const byKey = new Map(rows.map((row) => [row.node_key, row]))
  const fused = []
  for (const [key, activation] of act) {
    const row = byKey.get(key)
    if (!row) continue
    const cos = cosOf.get(key) || 0
    const actNorm = activation / actMax
    // note×1.0 / episode×0.6：同一句话命中会话片段时，别把随机聊天顶到笔记前面
    const kindWeight = row.node_kind === 'episode' ? Number(opts.episodeWeight) : Number(opts.noteWeight ?? 1)
    const final = (Number.isFinite(kindWeight) ? kindWeight : 1) * (opts.alpha * cos + opts.beta * actNorm)
    if (final < opts.threshold) continue
    fused.push({
      nodeKey: key,
      path: row.source,
      title: row.title || compact(row.content, 24),
      heading: row.heading || '',
      text: row.content,
      nodeType: row.node_type,
      nodeKind: row.node_kind,
      salience: row.salience,
      cos: Number(cos.toFixed(4)),
      act: Number(actNorm.toFixed(4)),
      hop: hop.get(key) ?? 0,
      final: Number(final.toFixed(4)),
      seed: seeds.has(key),
    })
  }
  fused.sort((a, b) => b.final - a.final || b.cos - a.cos)

  // 字符预算：与主召回共享 maxChars 的语义，这里单独截断，避免挤爆注入块。
  const picked = []
  let used = 0
  for (const item of fused) {
    if (picked.length >= opts.topK) break
    const cost = item.text.length
    if (used + cost > opts.maxChars && picked.length) break
    picked.push(item)
    used += cost
  }
  return { rows: picked, seeds: seeds.size, activated: act.size, traversed: traversed.size, ms: Date.now() - started }
}

/** 写回激活痕迹（LTP/LTD 轻量版），供下次召回与面板热力。 */
export function commitTouch(brain, keys, extra = {}) {
  const list = [...new Set((keys || []).filter(Boolean))].slice(0, 32)
  if (!list.length) return 0
  const at = nowIso()
  const db = brain.db
  const stmt = db.prepare(
    'UPDATE nodes SET activation = MIN(3.0, activation + 0.35), access_count = access_count + 1, last_activated = ?, updated_at = ? WHERE node_key = ?',
  )
  const log = db.prepare(
    'INSERT INTO activation_log (node_key, at, amount, source, hop, query_hash, session_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  let n = 0
  for (const key of list) {
    try {
      stmt.run(at, at, key)
      log.run(key, at, 0.35, extra.source ?? 'panel', 0, extra.queryHash ?? null, extra.session ?? null)
      n += 1
    } catch {
      /* 单条失败不影响 */
    }
  }
  return n
}

export { gramsOf }
