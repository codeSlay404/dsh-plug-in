// lib/classify.mjs —— 节点七类映射与标题抽取（SPEC §1.5）。
import { compact } from './util.mjs'

export const NODE_TYPES = ['memory', 'concept', 'person', 'place', 'emotion', 'skill', 'event']
export const EDGE_KINDS = ['temporal', 'semantic', 'emotional', 'causal', 'cooccur']

export function classifyNode(row = {}) {
  if (row.node_kind === 'episode') return 'event'
  if (row.entity_type === 'PERSON') return 'person'
  if (row.entity_type === 'PLACE') return 'place'
  if (row.entity_type === 'SKILL') return 'skill'
  if (row.memory_type === 'EXPERIENTIAL') return 'memory'
  if (String(row.source ?? '').startsWith('memory/')) return 'memory'
  if (Math.abs(Number(row.valence ?? 0)) >= 0.35) return 'emotion'
  return 'concept'
}

const TITLE_RE = /《([^》\n]{1,60})》/

/** 标题优先取《…》，退回首个非空行（截 24 字）。 */
export function titleOf(content, fallback = '') {
  const text = String(content ?? '')
  const match = TITLE_RE.exec(text)
  if (match) return match[1].trim()
  const first = text.split('\n').map((line) => line.trim()).find(Boolean) ?? ''
  const cleaned = first.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '')
  return cleaned ? compact(cleaned, 24) : compact(fallback, 24)
}

/** 取 `## 标题` 或 `### 标题`（panel 的 heading 列）。 */
export function headingOf(content) {
  const match = /^#{2,4}\s+(.{1,80})$/m.exec(String(content ?? ''))
  return match ? match[1].trim() : ''
}

export function isEpisode(key) {
  return typeof key === 'string' && key.startsWith('e:')
}
