// lib/brain/sessions.mjs —— 会话回合 → episode 节点（按 turn 幂等），默认开启。
// 只用 node:zlib 解 RFC8878 帧，避免依赖宿主实验性的 --experimental-zstd。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { DSH_HOME, compact, nowIso, sha256 } from './util.mjs'
import { computeAffect, computeSalience, isCritical } from './salience.mjs'
import { titleOf } from './classify.mjs'
import { tx } from './db.mjs'

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
export const EPISODE_HALF_LIFE_DAYS = 30

/** RFC8878 逐帧切分，返回 [start,end) 字节区间。 */
export function frameRanges(buf) {
  const ranges = []
  let pos = 0
  while (pos < buf.length) {
    if (buf[pos] !== MAGIC[0] || buf[pos + 1] !== MAGIC[1] || buf[pos + 2] !== MAGIC[2] || buf[pos + 3] !== MAGIC[3]) {
      throw new Error(`zstd: bad magic at ${pos}`)
    }
    const start = pos
    pos += 4
    const fhd = buf[pos]
    pos += 1
    const fcsFlag = fhd >> 6
    const singleSegment = (fhd >> 5) & 1
    const hasChecksum = (fhd >> 2) & 1
    const didFlag = fhd & 3
    if (!singleSegment) pos += 1
    pos += [0, 1, 2, 4][didFlag]
    pos += fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag]
    for (;;) {
      if (pos + 3 > buf.length) throw new Error('zstd: 截断的块头')
      const header = buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16)
      pos += 3
      const last = header & 1
      const type = (header >> 1) & 3
      const size = header >>> 3
      if (type === 3) throw new Error('zstd: 保留块类型')
      pos += type === 1 ? 1 : size
      if (last) break
    }
    if (hasChecksum) pos += 4
    ranges.push([start, pos])
  }
  return ranges
}

export function readSessionLog(file) {
  const buf = readFileSync(file)
  const ranges = frameRanges(buf)
  const parts = []
  for (const [start, end] of ranges) parts.push(zstdDecompressSync(buf.subarray(start, end)))
  const text = Buffer.concat(parts).toString('utf8')
  const records = []
  let bad = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      bad += 1
    }
  }
  return { records, bad, frames: ranges.length }
}

export function messageText(data) {
  const blocks = data?.content ?? data?.message?.content ?? []
  if (!Array.isArray(blocks)) return ''
  const texts = []
  for (const block of blocks) {
    if (!block || (block.type !== 'text' && block.type !== 'input_text')) continue
    if (typeof block.text === 'string' && block.text.trim()) texts.push(block.text)
  }
  return texts.join('\n')
}

const NOISE = /^<(system-reminder|available_skills|agent-experience|skill_resources)/
const NOISE_EXTRA = /^(<hindsight_knowledge|time sampled while preparing turn|background job |\[scheduled )/i
const INJECTED = new Set(['runtime-context', 'time-context', 'system', 'inbox', 'scheduled-context'])

export function isNoise(text, sourceKind) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return true
  if (NOISE.test(trimmed)) return true
  if (typeof sourceKind === 'string' && sourceKind && sourceKind !== 'user') return true
  const head = trimmed.slice(0, 40).toLowerCase()
  for (const name of INJECTED) if (head.includes(name)) return true
  return NOISE_EXTRA.test(trimmed)
}

/** 按 turn 分组；user/message 没有 data.turn，归属最近的 turn/start。 */
export function groupByTurn(records) {
  const turns = new Map()
  let current = 0
  for (const record of records) {
    const type = record?.type
    if (type === 'turn/start') {
      const turn = Number(record?.data?.turn)
      if (Number.isFinite(turn) && turn > 0) current = turn
      continue
    }
    if (type === 'turn/end') continue
    const explicit = Number(record?.data?.turn)
    const turn = Number.isFinite(explicit) && explicit > 0 ? explicit : current
    if (!turn) continue
    const bucket = turns.get(turn)
    if (bucket) bucket.push(record)
    else turns.set(turn, [record])
  }
  return turns
}

export function walkZstd(root) {
  const found = []
  const visit = (dir, depth) => {
    if (depth > 4) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) visit(full, depth + 1)
      else if (entry.isFile() && entry.name.endsWith('.jsonl.zstd')) found.push(full)
    }
  }
  visit(root, 0)
  return found
}

function recordTime(record, fallback) {
  const ts = record?.time ?? record?.timestamp ?? record?.data?.time
  if (ts == null) return fallback
  return typeof ts === 'number' ? nowIso(ts) : String(ts)
}

export function digestTurn(input) {
  const { sessionId, turn } = input
  const title = String(input.title ?? '').trim()
  const cwd = String(input.cwd ?? '').trim()
  const lines = [`## ${title || sessionId}`, `- session:${sessionId} cwd:${cwd} turn:${turn}`]
  let msgCount = 0
  let first = null
  let last = null
  for (const record of input.records ?? []) {
    if (record?.type !== 'user/message' && record?.type !== 'assistant/message') continue
    const text = messageText(record.data)
    if (isNoise(text, record?.data?.source?.kind)) continue
    const role = record.type === 'user/message' ? '用户' : '助手'
    const at = recordTime(record, input.ended_at ?? nowIso())
    if (!first) first = at
    last = at
    lines.push(`- ${at} ${role}: ${compact(text, 400)}`)
    msgCount += 1
  }
  const text = lines.slice(0, 400).join('\n')
  const startedAt = input.started_at || first || nowIso()
  const endedAt = input.ended_at || last || startedAt
  return {
    id: `e:${sha256(`${sessionId}\u0000${turn}`).slice(0, 24)}`,
    sessionId,
    turn: Number(turn),
    contentKey: sha256(`${sessionId}\u0000${turn}\u0000${text}`),
    contentHash: sha256(text),
    text,
    startedAt,
    endedAt,
    msgCount,
  }
}

/** episode 的快衰减显著性：半衰期 30 天（note 是 90 天）。 */
export function episodeSalience({ ageDays = 0, recurrence = 1, critical = false }) {
  const decay = 0.5 ** (Math.max(0, ageDays) / EPISODE_HALF_LIFE_DAYS)
  const freq = Math.log1p(Math.max(0, recurrence)) / Math.log1p(50)
  const raw = decay * freq * (critical ? 32 : 1)
  return Math.min(1, Math.max(0, 1 - Math.exp(-raw)))
}

/** 入库一个回合；内容未变返回 0（幂等）。 */
export function ingestTurn(brain, input) {
  const digest = digestTurn(input)
  if (!digest.msgCount) return 0
  const db = brain.db
  const at = nowIso()
  const ageDays = Math.max(0, (Date.now() - Date.parse(digest.endedAt)) / 86400000)
  const affect = computeAffect(digest.text)
  const salience = episodeSalience({ ageDays, recurrence: digest.msgCount, critical: isCritical(digest.text) })
  const title = compact(String(input.title ?? '').trim() || titleOf(digest.text, digest.sessionId), 40)
  const source = `session/${digest.sessionId}`

  const cwd = String(input.cwd ?? '')
  return tx(db, () => {
    const prev = db.prepare('SELECT content_key FROM episodes WHERE id = ?').get(digest.id)
    if (prev && prev.content_key === digest.contentKey) return 0
    db.prepare(
      `INSERT INTO episodes (id, session_id, turn, content_key, content_hash, cwd, title, started_at, ended_at,
                             msg_count, ingested_at, salience, valence, arousal)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         content_key = excluded.content_key, content_hash = excluded.content_hash, title = excluded.title,
         started_at = excluded.started_at, ended_at = excluded.ended_at, msg_count = excluded.msg_count,
         ingested_at = excluded.ingested_at, salience = excluded.salience,
         valence = excluded.valence, arousal = excluded.arousal`,
    ).run(
      digest.id,
      digest.sessionId,
      digest.turn,
      digest.contentKey,
      digest.contentHash,
      cwd,
      title,
      digest.startedAt,
      digest.endedAt,
      digest.msgCount,
      at,
      salience,
      affect.valence,
      affect.arousal,
    )
    db.prepare(
      `INSERT INTO nodes (node_key, node_kind, source, heading, title, content, memory_type, node_type,
                          salience, valence, arousal, valid_from, created_at, updated_at)
       VALUES (?, 'episode', ?, ?, ?, ?, 'EPISODIC', 'event', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(node_key) DO UPDATE SET
         source = excluded.source, heading = excluded.heading, title = excluded.title,
         content = excluded.content, salience = excluded.salience, valence = excluded.valence,
         arousal = excluded.arousal, valid_from = excluded.valid_from, updated_at = excluded.updated_at`,
    ).run(
      digest.id,
      source,
      `turn ${digest.turn}`,
      title,
      digest.text,
      salience,
      affect.valence,
      affect.arousal,
      digest.startedAt,
      at,
      at,
    )

    // 情节 ↔ 笔记：正文里出现 note.source（精确路径）或 note.title（≥6 字）
    db.prepare(
      `INSERT INTO synapses (src, dst, kind, weight, hop_decay, created_at, updated_at)
       SELECT ?, node_key, 'temporal', 0.9, 0.8, ?, ? FROM nodes n
       WHERE n.merged_into IS NULL AND n.node_kind = 'note' AND length(n.source) > 2
         AND instr(?, n.source) > 0
       ON CONFLICT(src, dst) DO UPDATE SET weight = MAX(synapses.weight, excluded.weight), updated_at = excluded.updated_at`,
    ).run(digest.id, at, at, digest.text)
    db.prepare(
      `INSERT INTO synapses (src, dst, kind, weight, hop_decay, created_at, updated_at)
       SELECT node_key, ?, 'temporal', 0.75, 0.8, ?, ? FROM nodes n
       WHERE n.merged_into IS NULL AND n.node_kind = 'note' AND length(n.title) >= 4
         AND instr(?, n.title) > 0 LIMIT 20
       ON CONFLICT(src, dst) DO UPDATE SET weight = MAX(synapses.weight, excluded.weight), updated_at = excluded.updated_at`,
    ).run(digest.id, at, at, digest.text)
    return 1
  })
}

export function getCursor(brain, sessionFile) {
  return brain.db.prepare('SELECT * FROM ingest_cursor WHERE session_file = ?').get(sessionFile) ?? null
}

export function putCursor(brain, sessionFile, row) {
  brain.db
    .prepare(
      `INSERT INTO ingest_cursor (session_file, session_id, size, mtime_ms, last_turn, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_file) DO UPDATE SET
         session_id = excluded.session_id, size = excluded.size, mtime_ms = excluded.mtime_ms,
         last_turn = MAX(ingest_cursor.last_turn, excluded.last_turn), updated_at = excluded.updated_at`,
    )
    .run(sessionFile, row.session_id, row.size, row.mtime_ms, row.last_turn ?? 0, nowIso())
}

/** 同一会话内相邻 turn 连线：episode-episode 时序边，保证会话片段自己成串。 */
function linkSessionTurns(brain, nodeIds) {
  if (nodeIds.length < 2) return
  const at = nowIso()
  const stmt = brain.db.prepare(
    `INSERT INTO synapses (src, dst, kind, weight, hop_decay, created_at, updated_at)
     VALUES (?, ?, 'temporal', 0.7, 0.85, ?, ?)
     ON CONFLICT(src, dst) DO UPDATE SET weight = MAX(synapses.weight, excluded.weight), updated_at = excluded.updated_at`,
  )
  for (let i = 1; i < nodeIds.length; i += 1) {
    try {
      stmt.run(nodeIds[i - 1], nodeIds[i], at, at)
      stmt.run(nodeIds[i], nodeIds[i - 1], at, at)
    } catch {
      /* 忽略 */
    }
  }
}

/** 入库单个会话文件。 */
export function ingestFromFile(brain, file, options = {}) {
  const started = Date.now()
  const parsed = readSessionLog(file)
  const records = parsed.records
  const head = records.find((record) => record?.type === 'session')
  const sessionId = options.sessionId ?? head?.data?.id ?? head?.id ?? basename(dirname(file)).replace(/^session-/, '')
  let title = ''
  for (const record of records) {
    if (record?.type === 'session/title' && record?.data?.title) title = String(record.data.title)
  }
  const cwd = head?.data?.cwd ?? head?.cwd ?? ''
  const turns = groupByTurn(records)
  const ids = []
  let episodes = 0
  for (const [turn, turnRecords] of turns.entries()) {
    const input = { sessionId, turn, records: turnRecords, title, cwd }
    episodes += ingestTurn(brain, input)
    ids.push(digestTurn(input).id)
  }
  linkSessionTurns(brain, ids)
  const stat = statSync(file)
  let lastTurn = 0
  for (const turn of turns.keys()) if (turn > lastTurn) lastTurn = turn
  putCursor(brain, file, { session_id: sessionId, size: stat.size, mtime_ms: Math.floor(stat.mtimeMs), last_turn: lastTurn })
  return { sessionId, title, turns: turns.size, episodes, records: records.length, frames: parsed.frames, bad: parsed.bad, ms: Date.now() - started }
}

/** 批量扫描会话目录；未变化的文件按 (size, mtime_ms) 跳过。 */
export function scanSessions(brain, options = {}) {
  const started = Date.now()
  const roots = options.roots ?? [options.root || join(DSH_HOME, 'sessions')]
  const force = Boolean(options.force)
  const maxFiles = Math.max(1, Number(options.maxFiles ?? 400))
  let scanned = 0
  let skipped = 0
  let files = 0
  let episodes = 0
  for (const root of roots) {
    if (!root || !existsSync(root)) continue
    for (const file of walkZstd(root)) {
      files += 1
      if (scanned >= maxFiles) break
      let stats
      try {
        stats = statSync(file)
      } catch {
        continue
      }
      const cursor = getCursor(brain, file)
      if (!force && cursor && cursor.size === stats.size && cursor.mtime_ms === Math.floor(stats.mtimeMs)) {
        skipped += 1
        continue
      }
      try {
        const result = ingestFromFile(brain, file)
        episodes += result.episodes
        scanned += 1
      } catch {
        skipped += 1
      }
    }
  }
  brain.setMeta('last_session_ingest_at', nowIso())
  const nodes = Number(brain.db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE node_kind = 'episode'").get()?.n ?? 0)
  return { scanned, skipped, files, episodes, nodes, ms: Date.now() - started }
}
