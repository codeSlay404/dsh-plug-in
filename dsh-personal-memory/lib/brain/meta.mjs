// lib/meta.mjs —— brain_meta 的读写（schema.mjs 与 db.mjs 共用，避免循环依赖）。
export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM brain_meta WHERE key = ?').get(key)
  return row?.value ?? null
}

export function setMeta(db, key, value) {
  db.prepare(
    `INSERT INTO brain_meta (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(key, value == null ? null : String(value))
}
