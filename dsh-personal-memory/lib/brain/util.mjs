// lib/brain/util.mjs —— 脑图层的零依赖工具。日志并入 personal-memory.jsonl。
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
export const PM_LOG = join(DSH_HOME, 'logs', 'personal-memory.jsonl')

export function sha256(text) {
  return createHash('sha256').update(String(text ?? '')).digest('hex')
}

export function nowIso(ts) {
  const date = ts == null ? new Date() : ts instanceof Date ? ts : new Date(ts)
  return date.toISOString()
}

export function clamp(value, lo, hi) {
  const n = Number(value)
  if (!Number.isFinite(n)) return lo
  return Math.min(hi, Math.max(lo, n))
}

export function clamp01(value) {
  return clamp(value, 0, 1)
}

export function compact(text, limit = 240) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= limit) return flat
  return `${flat.slice(0, Math.max(0, limit - 1))}…`
}

export function safeJson(text, fallback = null) {
  if (typeof text !== 'string' || !text) return fallback
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true })
  return path
}

/** 往 personal-memory 的 JSONL 日志里追加一行；写不了不影响主流程。 */
export function brainLog(cfg, entry) {
  if (cfg && cfg.log === false) return
  try {
    ensureDir(dirname(PM_LOG))
    appendFileSync(PM_LOG, `${JSON.stringify({ at: nowIso(), ...entry })}\n`, 'utf8')
  } catch {
    /* 忽略 */
  }
}
