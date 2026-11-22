// 写路径与并发冒烟：工作区边界（软链穿出）与「两个请求同时改一个文件」。
//
// 这一组用例复现的是审计里真实打穿过的东西：
//   · personal/link.md 软链到工作区外，GET /doc 读到外面文件、POST /save 把外面文件改掉；
//   · 10 条并发 POST /append 全部回 200，磁盘上只落 1 行（读改写丢更新）。
// 反例和放行都要测：只测「拒」的话，一个「全拒」的实现也能全绿。
//
// 用法：node smoke-writepath.mjs

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot } from './harness.mjs'

const workspace = mkdtempSync(join(tmpdir(), 'pm-write-'))
const outside = mkdtempSync(join(tmpdir(), 'pm-outside-'))

const results = []
function check(label, ok, detail = '') {
  results.push({ label, ok: Boolean(ok) })
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

async function expectStatus(label, status, run) {
  try {
    const value = await run()
    check(label, false, `没有报错（${JSON.stringify(value).slice(0, 60)}），期望 ${status}`)
    return null
  } catch (error) {
    check(label, error.status === status, `实际 ${error.status ?? '无状态'}：${error.message}`)
    return error
  }
}

const todayKey = new Date().toLocaleDateString('sv-SE')

// --- 布景：正常文件、软链到外面的文件、软链到外面的目录、悬空软链 ---
mkdirSync(join(workspace, 'personal'), { recursive: true })
mkdirSync(join(workspace, 'project'), { recursive: true })
mkdirSync(join(outside, 'vault'), { recursive: true })
writeFileSync(join(workspace, 'personal', '关于我.md'), '# 关于我\n\n更新:2026-11-22\n来源:smoke\n\n正常内容\n')
writeFileSync(join(workspace, 'project', '并发.md'), '# 并发\n\n更新:2026-11-22\n来源:smoke\n\n')
writeFileSync(join(outside, 'secret.md'), 'SECRET-42\n')
writeFileSync(join(outside, 'vault', 'inner.md'), 'INNER\n')
symlinkSync(join(outside, 'secret.md'), join(workspace, 'personal', 'link.md'))
symlinkSync(join(outside, 'vault'), join(workspace, 'personal', 'linkdir'))
symlinkSync(join(outside, 'not-yet.md'), join(workspace, 'personal', 'dangling.md'))

const { hostCall } = await boot({ workspace })

// --- 放行：工作区在 /var/folders 软链下（realpath 与字面路径不同）也要能正常写 ---
{
  const doc = await hostCall('GET', '/doc?path=' + encodeURIComponent('personal/关于我.md'))
  check('工作区在软链路径下时，正常读仍放行', String(doc?.text ?? '').includes('正常内容'), '')

  const saved = await hostCall('POST', '/save', { path: 'personal/关于我.md', text: '# 关于我\n\n更新:2026-11-22\n来源:smoke\n\n改过的内容\n' })
  check('正常保存可用', saved?.changed === true, `bytes=${saved?.bytes}`)

  const created = await hostCall('POST', '/create', { title: '新笔记', dir: 'personal' })
  check('正常新建可用', created?.created === true, created?.path ?? '')
}

// --- 拒绝：文件是软链，指向工作区外 ---
{
  await expectStatus('软链文件：GET /doc 拒绝', 403, () => hostCall('GET', '/doc?path=' + encodeURIComponent('personal/link.md')))
  await expectStatus('软链文件：POST /save 拒绝', 403, () => hostCall('POST', '/save', { path: 'personal/link.md', text: 'PWNED\n' }))
  await expectStatus('软链文件：POST /append 拒绝', 403, () => hostCall('POST', '/append', { path: 'personal/link.md', line: '- PWNED' }))
  await expectStatus('软链文件：POST /todo 拒绝', 403, () => hostCall('POST', '/todo', { path: 'personal/link.md', line: 1, done: true }))
  check('工作区外的文件没被改写', readFileSync(join(outside, 'secret.md'), 'utf8') === 'SECRET-42\n', '')
}

// --- 拒绝：目录是软链，指向工作区外 ---
{
  await expectStatus('软链目录：POST /create 拒绝', 403, () => hostCall('POST', '/create', { title: '越界', dir: 'personal/linkdir' }))
  check('工作区外的目录里没多出文件', readdirSync(join(outside, 'vault')).join(',') === 'inner.md', readdirSync(join(outside, 'vault')).join(','))
}

// --- 悬空软链：existsSync 是 false，不能被当「空位」写出去 ---
{
  const created = await hostCall('POST', '/create', { title: 'dangling', dir: 'personal' })
  check('悬空软链不跟写：新建落到别处', created?.path !== 'personal/dangling.md', created?.path ?? '')
  check('悬空软链的目标没有被创建', !existsSync(join(outside, 'not-yet.md')), existsSync(join(outside, 'not-yet.md')) ? '外面出现了文件' : '')
}

// --- 速记：memory/YYYY 目录被换成软链时要拒 ---
{
  rmSync(join(workspace, 'memory'), { recursive: true, force: true })
  symlinkSync(join(outside, 'vault'), join(workspace, 'memory'))
  await expectStatus('速记目录软链：POST /note 拒绝', 403, () => hostCall('POST', '/note', { text: '越界速记' }))
  check('外面目录里没多出日记', readdirSync(join(outside, 'vault')).join(',') === 'inner.md', readdirSync(join(outside, 'vault')).join(','))
  rmSync(join(workspace, 'memory'))
  const noted = await hostCall('POST', '/note', { text: '正常速记' })
  check('去掉软链之后速记可用', noted?.created === true, noted?.path ?? '')
  const dayFile = join(workspace, 'memory', todayKey.slice(0, 4), todayKey.slice(5, 7), `${todayKey}.md`)
  check('速记落在工作区里', existsSync(dayFile) && readFileSync(dayFile, 'utf8').includes('正常速记'), dayFile)
}

// --- 并发：10 条同时补到同一篇，一行都不能丢 ---
{
  const path = 'project/并发.md'
  const lines = Array.from({ length: 10 }, (_, i) => `- 并发第 ${i + 1} 行`)
  const resultsRaw = await Promise.all(lines.map((line) => hostCall('POST', '/append', { path, line })))
  const okCount = resultsRaw.filter((row) => row?.appended === true).length
  const text = readFileSync(join(workspace, path), 'utf8')
  const landed = lines.filter((line) => text.includes(line)).length
  check('10 条并发追加全部落盘', okCount === 10 && landed === 10, `返回 ${okCount} / 落盘 ${landed}`)
}

// --- 并发：星标（状态文件读改写）不能丢 ---
{
  const targets = ['personal/关于我.md', 'project/并发.md']
  const extra = []
  for (let i = 0; i < 6; i += 1) {
    const rel = `project/星标-${i}.md`
    writeFileSync(join(workspace, rel), `# 星标 ${i}\n\n更新:2026-11-22\n来源:smoke\n\n`)
    extra.push(rel)
  }
  const all = [...targets, ...extra]
  await Promise.all(all.map((path) => hostCall('POST', '/star', { path, on: true })))
  const state = await hostCall('GET', '/state?tables=stars')
  const stars = state?.stars ?? state?.state?.stars ?? []
  check('8 条并发星标全部记下', all.every((path) => stars.includes(path)), `记录 ${stars.length} 条`)
}

// --- 并发：星标与「线索」抢同一份状态文件（2026-11-22 他测复现过的丢更新） ---
{
  const starTargets = ['personal/关于我.md', 'project/并发.md']
  const extra = []
  for (let i = 0; i < 6; i += 1) {
    const rel = `personal/混写-${i}.md`
    writeFileSync(join(workspace, rel), `# 混写 ${i}\n\n更新:2026-11-22\n来源:smoke\n\n`)
    extra.push(rel)
  }
  const clueLines = Array.from({ length: 6 }, (_, i) => `- 想找：混写线索 ${i}`)
  const starPaths = [...starTargets, ...extra]
  await Promise.all([
    ...starPaths.map((path) => hostCall('POST', '/star', { path, on: true })),
    ...clueLines.map((line) => hostCall('POST', '/append', { path: 'personal/混写-0.md', line })),
  ])
  const state = await hostCall('GET', '/state')
  const stars = state?.stars ?? state?.state?.stars ?? []
  const clues = state?.clues ?? state?.state?.clues ?? {}
  const clueTexts = Object.values(clues).map((row) => String(row?.text ?? ''))
  const starOk = starPaths.every((path) => stars.includes(path))
  const clueOk = clueLines.every((line) => clueTexts.some((text) => line.includes(text)))
  check('星标与线索并发写互不覆盖', starOk && clueOk, `星标 ${stars.length}/${starPaths.length}，线索 ${clueTexts.length}/${clueLines.length}`)
}

// --- 状态目录本身被换成软链：不能把 state.json 写到工作区外 ---
{
  const outside = mkdtempSync(join(tmpdir(), 'pm-outstate-'))
  rmSync(join(workspace, '.dsh'), { recursive: true, force: true })
  symlinkSync(outside, join(workspace, '.dsh'))
  let status = 0
  try {
    await hostCall('POST', '/star', { path: 'project/并发.md', on: true })
    status = 200
  } catch (err) {
    status = err.status ?? -1
  }
  const leaked = existsSync(join(outside, 'personal-memory', 'state.json'))
  check('状态目录软链穿出时拒绝写', status === 403 && !leaked, `status ${status} leaked ${leaked}`)
  rmSync(join(workspace, '.dsh'), { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
}

const failed = results.filter((row) => !row.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  console.log(`失败：${failed.map((row) => row.label).join('、')}`)
  process.exit(1)
}
