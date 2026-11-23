// lib/salience.mjs —— 显著性 / 情绪价（SPEC §1.4），确定性、零依赖、无 LLM。
import { clamp, clamp01 } from './util.mjs'

export const HALF_LIFE_DAYS = 90
export const ACTION_BOOST = 4.0
export const CRITICAL_BOOST = 32.0

/** 0..1，压平后供面板渐变着色。 */
export function computeSalience({ ageDays = 0, recurrence = 1, critical = false, actionRelevant = false, pinned = false } = {}) {
  const decay = 0.5 ** (Math.max(0, ageDays) / HALF_LIFE_DAYS)
  const freq = Math.log1p(Math.max(0, recurrence)) / Math.log1p(50)
  let boost = 1
  if (actionRelevant) boost *= ACTION_BOOST
  if (critical) boost *= CRITICAL_BOOST
  if (pinned) boost *= 2
  const raw = decay * freq * boost
  return clamp01(1 - Math.exp(-raw))
}

const POSITIVE = [
  '喜欢', '爱', '开心', '满足', '感谢', '成就', '顺利', '惊喜', '安心', '期待', '骄傲', '释然',
  '不错', '很好', '太好了', '漂亮', '成功', '搞定', '通过', '舒服', '温暖', '靠谱', '值得', '幸福',
]
const NEGATIVE = [
  '讨厌', '焦虑', '难过', '生气', '后悔', '愧疚', '疲惫', '恐惧', '失望', '委屈', '压力', '烦',
  '崩溃', '痛苦', '失败', '错误', '生气', '担心', '害怕', '沮丧', '孤独', '内耗', '烦人', '糟',
]
const HIGH_AROUSAL = ['！', '!', '急', '马上', '立刻', '崩', '炸', 'deadline', '截止', '熬夜', '吵', '赶紧', '催']
const LOW_AROUSAL = ['慢慢', '平静', '安静', '随便', '还行', '淡淡的', '无所谓', '躺平']

export const CRITICAL_WORDS = [
  '过敏', '密码', '密钥', '身份证', '银行', 'ICU', '手术', '合同', '截止', '别忘', '千万不要', '密码',
  'api key', 'apikey', 'token', '私钥', '社保', '急诊', '遗嘱',
]

function occurrences(text, words) {
  const haystack = String(text ?? '').toLowerCase()
  let count = 0
  for (const word of words) {
    if (!word) continue
    let index = haystack.indexOf(word.toLowerCase())
    while (index !== -1) {
      count += 1
      index = haystack.indexOf(word.toLowerCase(), index + word.length)
    }
  }
  return count
}

export function isCritical(text) {
  return occurrences(text, CRITICAL_WORDS) > 0
}

/** {valence:-1..1, arousal:0..1} */
export function computeAffect(text) {
  const pos = occurrences(text, POSITIVE)
  const neg = occurrences(text, NEGATIVE)
  const high = occurrences(text, HIGH_AROUSAL)
  const low = occurrences(text, LOW_AROUSAL)
  const valence = clamp((pos - neg) / Math.max(1, pos + neg), -1, 1)
  const arousal = clamp01((high - low) / 4 + 0.15 * Math.abs(valence))
  return { valence: Number(valence.toFixed(4)), arousal: Number(arousal.toFixed(4)) }
}

/** 节点入库时的默认显著性：按创建时间衰减、频次取 corroboration。 */
export function salienceOfNode(row = {}, now = Date.now()) {
  const base = row.valid_from || row.created_at
  const created = Date.parse(base ?? '')
  const ageDays = Number.isFinite(created) ? Math.max(0, (now - created) / 86_400_000) : 0
  const recurrence = Number(row.corroboration_count ?? 0) + Number(row.access_count ?? 0) || 1
  return Number(
    computeSalience({
      ageDays,
      recurrence,
      critical: isCritical(row.content),
      actionRelevant: Boolean(row.action_relevant),
      pinned: Boolean(row.pinned),
    }).toFixed(4),
  )
}
