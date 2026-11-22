// 把美食调研 JSON(/tmp/food-research.json)合并进 client.js 的 DISHES。
//   node tools/merge-food.mjs [json路径]
// 校验:40 目的地全覆盖、每地 3-5 道、字段长度、img 仅 upload.wikimedia.org、跨城菜名去重。
import { readFileSync, writeFileSync } from 'node:fs'
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const jsonPath = process.argv[2] ?? '/tmp/food-research.json'
const { dests } = JSON.parse(readFileSync(jsonPath, 'utf8'))

const destIds = [...src.matchAll(/^\s+id: '([^']+)', name: '([^']+)',/gm)]
  .filter((m) => !m[1].includes('-xinghua') || true)
  .map((m) => ({ id: m[1], name: m[2] }))
const idByName = new Map(destIds.map((d) => [d.name.replace(/·.*$/, ''), d.id]))
// 「北京·秋」这类 name 取 · 前的部分做菜谱地名匹配兜底
const ids = new Set(destIds.map((d) => d.id))

const problems = []
const seenNames = new Map() // 菜名 -> id
const byId = new Map()
for (const dest of dests) {
  if (!ids.has(dest.id)) { problems.push(`未知目的地 id: ${dest.id}`); continue }
  if (byId.has(dest.id)) { problems.push(`重复目的地: ${dest.id}`); continue }
  const dishes = []
  for (const x of dest.dishes ?? []) {
    const n = String(x.n ?? '').trim()
    const d = String(x.d ?? '').trim()
    const w = String(x.w ?? '').trim()
    let img = String(x.img ?? '').trim()
    if (!n || !d || !w) { problems.push(`${dest.id} 字段缺失: ${JSON.stringify(x)}`); continue }
    if (n.length > 10 || d.length > 42 || w.length > 26) problems.push(`${dest.id} 字段超长: ${n}`)
    seenNames.set(n, dest.id) // 只记全局菜名;跨城重复(锅包肉/酥油茶等)是真实在地饮食,保留
    if (img && !/^(https:\/\/)(upload|thumb)\.wikimedia\.org\//.test(img)) { problems.push(`${dest.id}/${n} 非法图 URL,丢弃`); img = '' }
    // 非 /thumb/ 全尺寸图归一化为 480px 缩略,省流量
    if (img && img.includes('upload.wikimedia.org/wikipedia/commons/') && !img.includes('/thumb/')) {
      const m = img.match(/\/wikipedia\/commons\/([0-9a-f])\/([0-9a-f]{2})\/(.+\.(?:jpe?g|png|JPE?G|PNG))$/)
      if (m) img = `https://upload.wikimedia.org/wikipedia/commons/thumb/${m[1]}/${m[2]}/${m[3]}/480px-${m[3]}`
    }
    dishes.push({ n, d, w, img })
  }
  if (dishes.length < 3) problems.push(`${dest.id} 只有 ${dishes.length} 道菜(需≥3)`)
  byId.set(dest.id, dishes.slice(0, 5))
}

const missing = [...ids].filter((id) => !byId.has(id))
if (missing.length) problems.push(`缺目的地: ${missing.join(',')}`)
if (problems.length) {
  console.log('=== 校验问题 ===')
  for (const p of problems) console.log('- ' + p)
}
const covered = [...ids].filter((id) => (byId.get(id)?.length ?? 0) >= 3).length
console.log(`覆盖 ${covered}/${ids.size} 个目的地,共 ${[...byId.values()].flat().length} 道菜`)

// 写回:替换 DISHES 占位块
const start = src.indexOf('const DISHES = {')
if (start < 0) throw new Error('找不到 DISHES 占位')
const endMarker = '\n    }'
const end = src.indexOf(endMarker, start)
if (end < 0) throw new Error('找不到 DISHES 结束')
let body = ''
for (const [id, dishes] of byId) {
  if (!dishes?.length) continue
  body += `      ${JSON.stringify(id)}: [\n`
  for (const x of dishes) {
    body += `        { n: ${JSON.stringify(x.n)}, d: ${JSON.stringify(x.d)}, w: ${JSON.stringify(x.w)}, img: ${JSON.stringify(x.img)} },\n`
  }
  body += `      ],\n`
}
const out = src.slice(0, start) + 'const DISHES = {\n' + body + src.slice(end)
writeFileSync(new URL('../client.js', import.meta.url), out)
console.log('已写入 client.js DISHES(共 ' + [...byId.values()].filter((a) => a?.length).length + ' 地)')
