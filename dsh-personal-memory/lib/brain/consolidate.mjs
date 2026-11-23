// lib/brain/consolidate.mjs —— 巩固：把「被召回或与笔记相连」的 episode 聚类，
// 每条聚成一条 note 型节点（不写回笔记文件），原 episode 保留但降权。
import { compact, nowIso, sha256 } from './util.mjs'
import { tx } from './db.mjs'

const CANDIDATE_SQL = `
SELECT DISTINCT n.node_key, n.title, n.content, n.salience, n.activation, n.access_count, n.source
FROM nodes n
WHERE n.merged_into IS NULL AND n.node_kind = 'episode'
  AND (n.activation > 0 OR n.access_count > 0 OR EXISTS (
        SELECT 1 FROM synapses s JOIN nodes t ON t.node_key = s.dst
        WHERE s.src = n.node_key AND t.node_kind = 'note'))
ORDER BY n.salience DESC, n.access_count DESC
LIMIT ?
`

const NOTE_NEIGHBORS_SQL = `
SELECT DISTINCT t.node_key, t.title, t.source
FROM synapses s JOIN nodes t ON t.node_key = s.dst
WHERE s.src = ? AND t.merged_into IS NULL AND t.node_kind = 'note'
UNION
SELECT DISTINCT t.node_key, t.title, t.source
FROM synapses s JOIN nodes t ON t.node_key = s.src
WHERE s.dst = ? AND t.merged_into IS NULL AND t.node_kind = 'note'
`

/**
 * @returns {{clusters:number, episodes:number, created:number, skipped:number, ms:number}}
 */
export function consolidate(brain, options = {}) {
  const started = Date.now()
  const db = brain.db
  const limit = Math.max(1, Number(options.limit ?? 400))
  const minEpisodes = Math.max(2, Number(options.minEpisodes ?? 3))
  const candidates = db.prepare(CANDIDATE_SQL).all(limit)
  if (!candidates.length) {
    brain.setMeta('last_consolidate_at', nowIso())
    return { clusters: 0, episodes: 0, created: 0, skipped: 0, ms: Date.now() - started }
  }

  const neighborStmt = db.prepare(NOTE_NEIGHBORS_SQL)
  const notes = new Map()
  for (const episode of candidates) {
    let rows = []
    try {
      rows = neighborStmt.all(episode.node_key, episode.node_key)
    } catch {
      rows = []
    }
    for (const note of rows) {
      if (!notes.has(note.node_key)) notes.set(note.node_key, { note, episodes: [] })
      notes.get(note.node_key).episodes.push(episode)
    }
  }

  const at = nowIso()
  let created = 0
  let skipped = 0
  let episodesTouched = 0
  for (const { note, episodes } of notes.values()) {
    if (episodes.length < minEpisodes) {
      skipped += 1
      continue
    }
    const key = `c:${sha256(note.node_key).slice(0, 24)}`
    const list = episodes.slice(0, 12)
    const title = compact(`巩固：${note.title || note.source}`, 40)
    const content = [
      `《${title}》 巩固`,
      `- 来源笔记：${note.source}`,
      ...list.map((episode) => `- ${compact(episode.title || episode.content, 90)}`),
    ].join('\n')
    const salience = Math.max(0.4, ...list.map((episode) => Number(episode.salience) || 0.4))
    tx(db, () => {
      db.prepare(
        `INSERT INTO nodes (node_key, node_kind, source, heading, title, content, memory_type, node_type,
                            salience, valence, arousal, valid_from, created_at, updated_at)
         VALUES (?, 'note', 'brain/consolidated', '巩固', ?, ?, 'SEMANTIC', 'concept', ?, 0, 0.1, ?, ?, ?)
         ON CONFLICT(node_key) DO UPDATE SET
           title = excluded.title, content = excluded.content, salience = excluded.salience,
           updated_at = excluded.updated_at`,
      ).run(key, title, content, salience, at, at, at)
      db.prepare('DELETE FROM synapses WHERE src = ? OR dst = ?').run(key, key)
      const edge = db.prepare(
        `INSERT INTO synapses (src, dst, kind, weight, hop_decay, created_at, updated_at)
         VALUES (?, ?, 'consolidated', ?, 0.85, ?, ?)
         ON CONFLICT(src, dst) DO UPDATE SET weight = MAX(synapses.weight, excluded.weight), updated_at = excluded.updated_at`,
      )
      edge.run(key, note.node_key, 0.75, at, at)
      edge.run(note.node_key, key, 0.75, at, at)
      for (const episode of list) {
        edge.run(key, episode.node_key, 0.5, at, at)
        edge.run(episode.node_key, key, 0.5, at, at)
        db.prepare('UPDATE nodes SET salience = MAX(0, salience * 0.9), activation = activation * 0.7, updated_at = ? WHERE node_key = ?').run(at, episode.node_key)
      }
      db.prepare('INSERT INTO consolidation_log (at, op, detail, nodes) VALUES (?, ?, ?, ?)').run(
        at,
        'cluster-to-note',
        JSON.stringify({ note: note.node_key, episodes: list.length }),
        JSON.stringify([key, ...list.map((episode) => episode.node_key)]),
      )
    })
    created += 1
    episodesTouched += list.length
  }
  brain.setMeta('last_consolidate_at', at)
  return { clusters: notes.size, episodes: episodesTouched, created, skipped, ms: Date.now() - started }
}
