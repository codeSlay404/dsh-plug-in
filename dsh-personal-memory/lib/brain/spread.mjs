// lib/spread.mjs —— 激活扩散（SPEC §5.3）；确定性、有界、可解释。
import { clamp01 } from './util.mjs'

const EDGE_SQL = `SELECT dst, weight, inhibition, hop_decay FROM synapses
  WHERE src = ? AND weight >= ? ORDER BY weight DESC LIMIT ?`

export class MaxHeap {
  constructor() {
    this.items = []
  }

  get size() {
    return this.items.length
  }

  push(item) {
    const items = this.items
    items.push(item)
    let index = items.length - 1
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (items[parent].act >= items[index].act) break
      ;[items[parent], items[index]] = [items[index], items[parent]]
      index = parent
    }
  }

  pop() {
    const items = this.items
    if (!items.length) return undefined
    const top = items[0]
    const last = items.pop()
    if (items.length && last) {
      items[0] = last
      let index = 0
      for (;;) {
        const left = index * 2 + 1
        const right = left + 1
        let best = index
        if (left < items.length && items[left].act > items[best].act) best = left
        if (right < items.length && items[right].act > items[best].act) best = right
        if (best === index) break
        ;[items[best], items[index]] = [items[index], items[best]]
        index = best
      }
    }
    return top
  }
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Array<{key:string,activation:number}>|Map<string,number>} seeds
 * @returns {{act:Map<string,number>, parent:Map<string,string|null>, hop:Map<string,number>, traversed:Set<string>}}
 */
export function spreadActivation(db, seeds, options = {}) {
  const hops = Math.max(1, Number(options.hops ?? 3))
  const decay = Math.max(0, Number(options.decay ?? 0.65))
  const minWeight = clamp01(options.minWeight ?? 0.15)
  const minActivation = Math.max(0, Number(options.minActivation ?? 0.02))
  const maxNodes = Math.max(1, Number(options.maxNodes ?? 256))
  const fanout = Math.max(1, Number(options.fanout ?? 32))
  const inhibitionScale = Math.max(0, Number(options.inhibitionScale ?? 1))
  const hopDecayFallback = clamp01(options.hopDecayFallback ?? 0.8)

  const salienceStmt = db.prepare('SELECT salience FROM nodes WHERE node_key = ?')
  const salienceCache = new Map()
  const salienceOf = (key) => {
    if (salienceCache.has(key)) return salienceCache.get(key)
    let value = 0.5
    try {
      const row = salienceStmt.get(key)
      if (row && Number.isFinite(Number(row.salience))) value = clamp01(row.salience)
    } catch {
      /* 缺节点按默认 */
    }
    salienceCache.set(key, value)
    return value
  }

  const act = new Map()
  const parent = new Map()
  const hop = new Map()
  const traversed = new Set()
  const queue = new MaxHeap()

  const entries = seeds instanceof Map ? [...seeds.entries()] : (seeds ?? []).map((seed) => [seed.key, seed.activation])
  for (const [key, value] of entries) {
    if (!key) continue
    const activation = Number(value)
    if (!Number.isFinite(activation) || activation <= 0) continue
    const previous = act.get(key) ?? 0
    if (activation <= previous + 1e-9) continue
    act.set(key, activation)
    parent.set(key, null)
    hop.set(key, 0)
    queue.push({ key, act: activation, hop: 0 })
  }

  const edgeStmt = db.prepare(EDGE_SQL)
  while (queue.size && act.size <= maxNodes) {
    const current = queue.pop()
    if (!current) break
    if (current.act + 1e-9 < (act.get(current.key) ?? 0)) continue
    if (current.hop >= hops) continue
    let edges
    try {
      edges = edgeStmt.all(current.key, minWeight, fanout)
    } catch {
      continue
    }
    for (const edge of edges) {
      const dst = edge.dst
      if (!dst) continue
      traversed.add(`${current.key}>${dst}`)
      const through =
        current.act *
        clamp01(edge.weight) *
        clamp01(edge.hop_decay ?? hopDecayFallback) *
        Math.max(0, 1 - inhibitionScale * clamp01(edge.inhibition)) *
        decay
      const candidate = through * (0.5 + 0.5 * salienceOf(dst))
      if (candidate < minActivation) continue
      if (candidate <= (act.get(dst) ?? 0) + 1e-9) continue
      act.set(dst, candidate)
      parent.set(dst, current.key)
      hop.set(dst, current.hop + 1)
      queue.push({ key: dst, act: candidate, hop: current.hop + 1 })
    }
  }

  return { act, parent, hop, traversed }
}
