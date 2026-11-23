// lib/brain/index-notes.mjs —— 从 personal/ 与 memory/ 的 markdown 笔记重建脑图。
// 节点 = 笔记小节（node_key = 内容哈希）；边 = wikilink / 同标签 / embedding 相似 / 同文件 / 同目录。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { classifyNode, titleOf } from './classify.mjs'
import { computeAffect, computeSalience } from './salience.mjs'
import { clamp01, compact, nowIso, sha256 } from './util.mjs'
import { nodeKeyForContent, tx } from './db.mjs'

export const NOTE_ROOT_NAMES = ['personal', 'memory']
const MAX_FILE_BYTES = 512 * 1024
const MAX_CONTENT = 4000
const SKIP_DIRS = new Set(['.git', 'node_modules', '.obsidian', '.trash', '.DS_Store'])
const EDGE_SOURCES = ['semantic', 'cooccur']

/* ---------------- 扫描 ---------------- */

function listMarkdown(root, out, base) {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
    const abs = join(root, entry.name)
    if (entry.isDirectory()) listMarkdown(abs, out, base)
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      try {
        const st = statSync(abs)
        if (st.size > MAX_FILE_BYTES) continue
        out.push({ abs, rel: relative(base, abs).split('\\').join('/'), mtime: st.mtimeMs, size: st.size })
      } catch {
        /* 忽略读不到的文件 */
      }
    }
  }
  return out
}

/** 把一份笔记拆成小节：[{ heading, body }]。一级标题作为文件 title。 */
export function splitSections(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  let title = ''
  const sections = []
  let current = { heading: '', body: [] }
  for (const line of lines) {
    const h1 = /^#\s+(.+?)\s*$/.exec(line)
    if (h1 && !title && current.body.length === 0 && !current.heading) {
      title = h1[1].trim()
      continue
    }
    const hn = /^(#{2,4})\s+(.+?)\s*$/.exec(line)
    if (hn) {
      sections.push(current)
      current = { heading: hn[2].trim(), body: [] }
      continue
    }
    current.body.push(line)
  }
  sections.push(current)
  return { title, sections }
}

function dateFromPath(rel) {
  const m = /(\d{4})[-/](\d{2})[-/](\d{2})/.exec(rel)
  if (m) return `${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`
  return null
}

/** 收集工作区里所有笔记小节，产出候选节点。 */
export function collectNodes(workspace) {
  const files = []
  for (const name of NOTE_ROOT_NAMES) listMarkdown(join(workspace, name), files, workspace)
  const nodes = []
  const seen = new Set()
  for (const file of files) {
    let text = ''
    try {
      text = readFileSync(file.abs, 'utf8')
    } catch {
      continue
    }
    const { title, sections } = splitSections(text)
    const fallbackTitle = title || basename(file.abs, '.md')
    const validFrom = dateFromPath(file.rel) || new Date(file.mtime).toISOString()
    for (const section of sections) {
      const body = section.body.join('\n').trim()
      if (body.length < 24) continue
      const heading = section.heading.slice(0, 120)
      const content = compact(`《${fallbackTitle}》${heading ? ` ${heading}` : ''}\n${body}`, MAX_CONTENT)
      const key = nodeKeyForContent(content)
      if (seen.has(key)) continue
      seen.add(key)
      const ageDays = Math.max(0, (Date.now() - new Date(validFrom).getTime()) / 86400000)
      const salience = computeSalience({
        ageDays,
        recurrence: 1,
        critical: /必须|不要|绝不|禁止|规则|底线/.test(content),
        actionRelevant: /TODO|待办|下一步|计划/.test(content),
      })
      const affect = computeAffect(content)
      nodes.push({
        key,
        nodeKind: 'note',
        source: file.rel,
        heading,
        title: fallbackTitle,
        content,
        validFrom,
        salience: clamp01(salience),
        valence: affect.valence,
        arousal: affect.arousal,
        text: content,
      })
    }
  }
  return nodes
}

/* ---------------- 相似度 ---------------- */

const STOP_BIGRAMS = new Set(['的 ', '了 ', '是 ', '在 ', '和 ', '与 ', '我 ', '你 ', '他 ', '它 '])

function bigrams(text) {
  const clean = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*`|_\-\[\]()（）「」《》：:，,。.！!？?、；;"'“”‘’\s]/g, '')
  const set = new Set()
  for (let i = 0; i < clean.length - 1; i += 1) {
    const gram = clean.slice(i, i + 2)
    if (STOP_BIGRAMS.has(gram)) continue
    set.add(gram)
  }
  return set
}

function dice(a, b) {
  if (!a.size || !b.size) return 0
  let hit = 0
  for (const gram of a) if (b.has(gram)) hit += 1
  return (2 * hit) / (a.size + b.size)
}

function cosine(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (!na || !nb) return 0
  return dot / Math.sqrt(na * nb)
}

/** 从 ctx.db 读 embedding（读不到就返回 null，走 bigram 兜底）。 */
export function loadCtxEmbeddings(dbPath, workspace) {
  if (!dbPath) return null
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const rows = db.prepare('SELECT metadata, embedding, embedding_dim FROM memories WHERE embedding IS NOT NULL LIMIT 20000').all()
    if (!rows.length) return null
    const out = []
    for (const row of rows) {
      let meta = {}
      try {
        meta = JSON.parse(row.metadata || '{}')
      } catch {
        continue
      }
      let path = String(meta.path || '')
      if (!path) continue
      if (path.startsWith('/')) path = relative(workspace, path)
      const heading = String(meta.heading || '')
      const buf = row.embedding
      const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
      const dim = Number(row.embedding_dim) || Math.floor(bytes.length / 4)
      if (!dim || bytes.length < dim * 4) continue
      const vec = new Float32Array(dim)
      for (let i = 0; i < dim; i += 1) vec[i] = bytes.readFloatLE(i * 4)
      out.push({ path: path.split('\\').join('/'), heading, vec })
    }
    return out.length ? out : null
  } catch {
    return null
  } finally {
    try {
      db?.close()
    } catch {
      /* 忽略 */
    }
  }
}

/* ---------------- 边推导 ---------------- */

function addEdge(store, src, dst, kind, weight) {
  if (!src || !dst || src === dst) return
  const key = `${src}\u0000${dst}`
  const prev = store.get(key)
  const w = clamp01(weight)
  if (prev && prev.weight >= w) return
  store.set(key, { src, dst, kind, weight: w })
}

function normTitle(text) {
  return String(text ?? '')
    .replace(/\s+/g, '')
    .replace(/[《》「」()（）:：,，。.]/g, '')
    .toLowerCase()
}

function wikilinks(text) {
  const out = []
  const re = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g
  let m
  while ((m = re.exec(text))) {
    const target = (m[2] || m[1] || '').trim()
    if (target) out.push(target)
  }
  return out
}

function tagsOf(text) {
  const out = new Set()
  const re = /(^|[\s(（【>])#([\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9_\-]{1,19})/gu
  let m
  while ((m = re.exec(text))) out.add(m[2].toLowerCase())
  return out
}

export function deriveEdges(nodes, { embeddings = null, minSimilarity = 0.3, topK = 5 } = {}) {
  const store = new Map()
  const byKey = new Map(nodes.map((n) => [n.key, n]))

  // 1) 同文件相邻小节（结构骨架，保证每篇笔记内部连通）
  const bySource = new Map()
  for (const node of nodes) {
    if (!bySource.has(node.source)) bySource.set(node.source, [])
    bySource.get(node.source).push(node)
  }
  for (const group of bySource.values()) {
    for (let i = 1; i < group.length; i += 1) {
      addEdge(store, group[i - 1].key, group[i].key, 'cooccur', 0.4)
      addEdge(store, group[i].key, group[i - 1].key, 'cooccur', 0.4)
    }
  }

  // 2) wikilink：按标题 / 小节标题 / 文件名解析
  const byTitle = new Map()
  for (const node of nodes) {
    for (const alias of new Set([normTitle(node.title), normTitle(node.heading), normTitle(basename(node.source, '.md'))])) {
      if (!alias) continue
      if (!byTitle.has(alias)) byTitle.set(alias, [])
      byTitle.get(alias).push(node)
    }
  }
  for (const node of nodes) {
    for (const target of wikilinks(node.content)) {
      const hits = byTitle.get(normTitle(target)) || []
      for (const hit of hits.slice(0, 8)) {
        addEdge(store, node.key, hit.key, 'semantic', 0.8)
        addEdge(store, hit.key, node.key, 'semantic', 0.8)
      }
    }
  }

  // 3) 同标签
  const byTag = new Map()
  for (const node of nodes) {
    for (const tag of tagsOf(node.content)) {
      if (!byTag.has(tag)) byTag.set(tag, [])
      byTag.get(tag).push(node)
    }
  }
  for (const group of byTag.values()) {
    if (group.length < 2 || group.length > 40) continue
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        addEdge(store, group[i].key, group[j].key, 'cooccur', 0.45)
        addEdge(store, group[j].key, group[i].key, 'cooccur', 0.45)
      }
    }
  }

  // 4) embedding 相似度（ctx.db 可用时），否则 bigram 兜底
  const grams = new Map(nodes.map((n) => [n.key, bigrams(n.text)]))
  const vectorOf = new Map()
  let source = 'bigram'
  if (embeddings && embeddings.length) {
    // (path,heading) → 多个向量（同一小节被切块时取平均）
    const bucket = new Map()
    for (const item of embeddings) {
      const key = `${item.path}\u0000${item.heading}`
      if (!bucket.has(key)) bucket.set(key, [])
      bucket.get(key).push(item.vec)
    }
    for (const node of nodes) {
      const list = bucket.get(`${node.source}\u0000${node.heading}`) || bucket.get(`${node.source}\u0000`)
      if (!list || !list.length) continue
      const dim = list[0].length
      const avg = new Float32Array(dim)
      for (const vec of list) for (let i = 0; i < dim; i += 1) avg[i] += vec[i] / list.length
      vectorOf.set(node.key, avg)
    }
    if (!vectorOf.size) vectorOf.clear()
    else source = 'ctx-embedding'
  }

  const similar = (a, b) => {
    const va = vectorOf.get(a.key)
    const vb = vectorOf.get(b.key)
    if (va && vb) return cosine(va, vb)
    return dice(grams.get(a.key), grams.get(b.key))
  }

  // 候选裁剪：倒排索引，只比较共享 bigram 的小节
  const posting = new Map()
  nodes.forEach((node, index) => {
    for (const gram of grams.get(node.key) || []) {
      if (!posting.has(gram)) posting.set(gram, [])
      posting.get(gram).push(index)
    }
  })
  const cutoff = Math.max(24, Math.floor(nodes.length * 0.35))
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i]
    const votes = new Map()
    for (const gram of grams.get(node.key) || []) {
      const list = posting.get(gram) || []
      if (list.length > cutoff) continue
      for (const j of list) if (j !== i) votes.set(j, (votes.get(j) || 0) + 1)
    }
    const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)
    const scored = []
    for (const [j] of ranked) {
      const other = nodes[j]
      const sim = similar(node, other)
      if (sim >= minSimilarity) scored.push([other, sim])
    }
    scored.sort((a, b) => b[1] - a[1])
    for (const [other, sim] of scored.slice(0, topK)) {
      const weight = source === 'ctx-embedding' ? clamp01(sim * 0.85) : clamp01(sim * 1.1)
      addEdge(store, node.key, other.key, 'semantic', weight)
      addEdge(store, other.key, node.key, 'semantic', weight)
    }
  }

  if (!byKey.size) return { edges: [], source }
  return { edges: [...store.values()], source }
}

/* ---------------- 写入脑库 ---------------- */

const UPSERT_NODE = `
INSERT INTO nodes (node_key, node_kind, source, heading, title, content, node_type, salience, valence, arousal,
                   valid_from, created_at, updated_at, activation, access_count, pinned)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)
ON CONFLICT(node_key) DO UPDATE SET
  source = excluded.source,
  heading = excluded.heading,
  title = excluded.title,
  content = excluded.content,
  node_type = excluded.node_type,
  salience = excluded.salience,
  valence = excluded.valence,
  arousal = excluded.arousal,
  valid_from = excluded.valid_from,
  updated_at = excluded.updated_at
`

const UPSERT_EDGE = `
INSERT INTO synapses (src, dst, kind, weight, inhibition, hop_decay, co_count, created_at, updated_at)
VALUES (?, ?, ?, ?, 0, 0.9, 1, ?, ?)
ON CONFLICT(src, dst) DO UPDATE SET
  weight = MAX(synapses.weight, excluded.weight),
  kind = excluded.kind,
  updated_at = excluded.updated_at
`

const DELETE_EDGES = `DELETE FROM synapses WHERE kind IN (${EDGE_SOURCES.map(() => '?').join(',')})`

export function fingerprintOf(docs) {
  return sha256(docs.map((d) => `${d.rel}:${d.size}:${Math.round(d.mtime)}`).join('\n')).slice(0, 32)
}

/** 全量重建：节点 upsert + 过期节点删除 + 派生边重算。 */
export function rebuildFromNotes(brain, { workspace, embeddings = null, force = false } = {}) {
  const started = Date.now()
  const files = []
  for (const name of NOTE_ROOT_NAMES) listMarkdown(join(workspace, name), files, workspace)
  const fingerprint = fingerprintOf(files)
  if (!force && brain.meta('notes_fingerprint') === fingerprint) {
    return { skipped: true, fingerprint, nodes: 0, edges: 0, source: brain.meta('edge_source') || 'bigram' }
  }

  const nodes = collectNodes(workspace)
  if (!nodes.length) return { skipped: true, fingerprint, nodes: 0, edges: 0, source: 'none' }
  const { edges, source } = deriveEdges(nodes, { embeddings })
  const at = nowIso()
  const db = brain.db

  tx(db, () => {
    const upsert = db.prepare(UPSERT_NODE)
    const live = new Set()
    for (const node of nodes) {
      live.add(node.key)
      upsert.run(
        node.key,
        node.nodeKind,
        node.source,
        node.heading,
        node.title,
        node.content,
        classifyNode({ content: node.content, title: node.title, source: node.source, valence: node.valence, node_kind: node.nodeKind }),
        node.salience,
        node.valence,
        node.arousal,
        node.validFrom,
        at,
        at,
      )
    }
    // 只清理来自笔记的 note 节点：episode 与「巩固」节点不归这里管
    const stale = db.prepare("SELECT node_key, source FROM nodes WHERE node_kind = 'note' AND (source LIKE 'personal/%' OR source LIKE 'memory/%')").all()
    const del = db.prepare('DELETE FROM nodes WHERE node_key = ?')
    for (const row of stale) if (!live.has(row.node_key)) del.run(row.node_key)
    db.prepare(DELETE_EDGES).run(...EDGE_SOURCES)
    const insert = db.prepare(UPSERT_EDGE)
    for (const edge of edges) insert.run(edge.src, edge.dst, edge.kind, edge.weight, at, at)
  })

  brain.setMeta('notes_fingerprint', fingerprint)
  brain.setMeta('edge_source', source)
  brain.setMeta('last_index_at', at)
  brain.setMeta('brain_title', 'personal-memory')
  return { skipped: false, fingerprint, nodes: nodes.length, edges: edges.length, source, ms: Date.now() - started }
}

export { bigrams, dice, cosine }
