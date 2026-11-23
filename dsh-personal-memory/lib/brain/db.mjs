// lib/brain/db.mjs —— brain.db 生命周期（只依赖本地笔记，不再挂 ctx.db）。
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DSH_HOME, nowIso, sha256 } from './util.mjs'
import { ensureSchema, getMeta, setMeta } from './schema.mjs'

/** 脑库默认落在 ~/.dsh/personal-memory/brain.db（与 personal-memory 同家）。 */
export function defaultBrainPath() {
  return join(DSH_HOME, 'personal-memory', 'brain.db')
}

export function nodeKeyForContent(content) {
  return `m:${sha256(content).slice(0, 32)}`
}

/** BEGIN IMMEDIATE 事务；失败 ROLLBACK 后抛出。 */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const value = fn()
    db.exec('COMMIT')
    return value
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* 已回滚 */
    }
    throw error
  }
}

export function openBrain(options = {}) {
  const path = options.path || process.env.PM_BRAIN_DB || defaultBrainPath()
  mkdirSync(dirname(path), { recursive: true })
  const conn = new DatabaseSync(path)
  conn.exec('PRAGMA journal_mode = WAL;')
  conn.exec('PRAGMA synchronous = NORMAL;')
  conn.exec('PRAGMA busy_timeout = 3000;')
  conn.exec('PRAGMA foreign_keys = ON;')
  ensureSchema(conn)

  const brain = {
    path,
    get db() {
      return conn
    },
    meta(key) {
      return getMeta(conn, key)
    },
    setMeta(key, value) {
      return setMeta(conn, key, value)
    },
    close() {
      try {
        conn.close()
      } catch {
        /* 忽略 */
      }
    },
  }
  return brain
}

export function brainStats(brain) {
  const db = brain.db
  const count = (sql) => Number(db.prepare(sql).get()?.n ?? 0)
  return {
    nodes: count('SELECT COUNT(*) AS n FROM nodes WHERE merged_into IS NULL'),
    archived: count('SELECT COUNT(*) AS n FROM nodes WHERE merged_into IS NOT NULL'),
    synapses: count('SELECT COUNT(*) AS n FROM synapses'),
    episodes: count('SELECT COUNT(*) AS n FROM episodes'),
    dbPath: brain.path,
    schema: getMeta(db, 'schema_version'),
    lastIndexAt: brain.meta('last_index_at'),
    lastIndexSource: brain.meta('edge_source'),
  }
}

export { nowIso }
