// lib/schema.mjs —— brain.db 的全部 DDL（SPEC §1.2），幂等。
import { getMeta, setMeta } from './meta.mjs'

export const SCHEMA_VERSION = '1'

export const PRAGMAS = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 3000;
PRAGMA foreign_keys = ON;
`

export const DDL = `
-- 节点：内容寻址，跨 reindex 稳定
CREATE TABLE IF NOT EXISTS nodes (
  node_key       TEXT PRIMARY KEY,
  node_kind      TEXT NOT NULL DEFAULT 'memory',
  memory_id      TEXT,
  memory_id_prev TEXT,
  source         TEXT NOT NULL DEFAULT '',
  heading        TEXT NOT NULL DEFAULT '',
  title          TEXT NOT NULL DEFAULT '',
  content        TEXT NOT NULL DEFAULT '',
  memory_type    TEXT NOT NULL DEFAULT 'FACTUAL',
  node_type      TEXT NOT NULL DEFAULT 'concept',
  salience       REAL NOT NULL DEFAULT 0.5 CHECK (salience BETWEEN 0 AND 1),
  valence        REAL NOT NULL DEFAULT 0.0 CHECK (valence BETWEEN -1 AND 1),
  arousal        REAL NOT NULL DEFAULT 0.0 CHECK (arousal BETWEEN 0 AND 1),
  activation     REAL NOT NULL DEFAULT 0.0,
  access_count   INTEGER NOT NULL DEFAULT 0,
  last_activated TEXT,
  last_bound_rev TEXT,
  valid_from     TEXT,
  valid_to       TEXT,
  merged_into    TEXT,
  merged_at      TEXT,
  pinned         INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_memory     ON nodes(memory_id);
CREATE INDEX IF NOT EXISTS idx_nodes_kind       ON nodes(node_kind, node_type);
CREATE INDEX IF NOT EXISTS idx_nodes_activation ON nodes(activation DESC);
CREATE INDEX IF NOT EXISTS idx_nodes_unmerged   ON nodes(merged_into) WHERE merged_into IS NULL;

-- 突触：有向（语义边双向各插一条），权重可学习
CREATE TABLE IF NOT EXISTS synapses (
  src         TEXT NOT NULL REFERENCES nodes(node_key) ON DELETE CASCADE,
  dst         TEXT NOT NULL REFERENCES nodes(node_key) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'semantic',
  weight      REAL NOT NULL DEFAULT 0.5 CHECK (weight BETWEEN 0 AND 1),
  inhibition  REAL NOT NULL DEFAULT 0.0 CHECK (inhibition BETWEEN 0 AND 1),
  hop_decay   REAL NOT NULL DEFAULT 0.8 CHECK (hop_decay BETWEEN 0.1 AND 1),
  co_count    INTEGER NOT NULL DEFAULT 0,
  last_used   TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (src, dst)
);
CREATE INDEX IF NOT EXISTS idx_synapses_dst ON synapses(dst);

-- 激活流水：可回放
CREATE TABLE IF NOT EXISTS activation_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  node_key   TEXT NOT NULL,
  at         TEXT NOT NULL,
  amount     REAL NOT NULL,
  source     TEXT NOT NULL,
  hop        INTEGER NOT NULL DEFAULT 0,
  query_hash TEXT,
  session_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_actlog_node ON activation_log(node_key, at DESC);
CREATE INDEX IF NOT EXISTS idx_actlog_at   ON activation_log(at);

-- 情节（回合级）
CREATE TABLE IF NOT EXISTS episodes (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  turn         INTEGER NOT NULL,
  content_key  TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  cwd          TEXT NOT NULL DEFAULT '',
  title        TEXT NOT NULL DEFAULT '',
  started_at   TEXT NOT NULL,
  ended_at     TEXT NOT NULL,
  msg_count    INTEGER NOT NULL DEFAULT 0,
  digest_path  TEXT NOT NULL DEFAULT '',
  summary      TEXT NOT NULL DEFAULT '',
  salience     REAL NOT NULL DEFAULT 0.5,
  valence      REAL NOT NULL DEFAULT 0.0,
  arousal      REAL NOT NULL DEFAULT 0.0,
  ingested_at  TEXT NOT NULL,
  UNIQUE (session_id, turn)
);
CREATE INDEX IF NOT EXISTS idx_episodes_time ON episodes(ended_at DESC);

CREATE TABLE IF NOT EXISTS episode_links (
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  node_key   TEXT NOT NULL,
  relation   TEXT NOT NULL DEFAULT 'MENTIONS',
  weight     REAL NOT NULL DEFAULT 0.6,
  created_at TEXT NOT NULL,
  PRIMARY KEY (episode_id, node_key)
);
CREATE INDEX IF NOT EXISTS idx_eplinks_node ON episode_links(node_key);

CREATE TABLE IF NOT EXISTS consolidation_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL,
  op     TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  nodes  TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS ingest_cursor (
  session_file TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  size         INTEGER NOT NULL DEFAULT 0,
  mtime_ms     INTEGER NOT NULL DEFAULT 0,
  last_turn    INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS brain_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`

/** 建表 + 记录 schema_version；可重复调用。 */
export function ensureSchema(db) {
  db.exec(DDL)
  if (getMeta(db, 'schema_version') !== SCHEMA_VERSION) {
    setMeta(db, 'schema_version', SCHEMA_VERSION)
  }
}

export { getMeta, setMeta }
