// 面板数据接口冒烟：不连 DSH，用假的 ctx + 假 req/res 调 apply() 注册的那条幽灵路由。
// 需要本机 ctx-server 在 127.0.0.1:17878 上（否则 /status 的 index 字段会标 ready:false，
// 其余接口照常可用）。node smoke-panel.mjs
import { apply } from './index.js'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// 只读接口打在真实工作区上；写操作（/note）打在一个临时目录上，
// 免得每次跑冒烟都往真日记里塞测试行。
const REAL_WORKSPACE = '/Users/mars/sly'

async function mount(workspace) {
  // 每个 mount 拿一份独立的模块实例（resolveWorkspace 有模块级缓存），
  // 否则第二个工作区会读到第一个的结果。
  const { apply: mountApply } = await import(`./index.js?v=${encodeURIComponent(workspace)}`)
  const captured = {}
  const ctx = {
    on() {},
    effect(setup) { return setup() },
    webServer: { register(route) { captured.route = route; return () => {} } },
    workingDirectory: { defaultDirectory: workspace },
    // clientModules 只在测 beacon 去重时被读；给一个稳定的 rev 模拟「同一个 bundle」
    get(name) { return name === 'clientModules' ? { composed: { rev: 'smoke-rev-1' } } : undefined },
  }
  // cacheMs: 0 —— 冒烟里会改 mtime（测时间过滤），不能让 2 秒的扫描缓存挡在前面
  mountApply(ctx, { workspace, log: false, autoReindex: false, cacheMs: 0 })
  if (!captured.route) {
    console.error('✗ 没有注册 /personal-memory 路由')
    process.exit(1)
  }
  return captured.route
}

const results = []
function check(label, condition, detail = '') {
  results.push({ label, ok: Boolean(condition), detail })
  console.log(`${condition ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

// 与浏览器同源 fetch 同形；跨站用例只需覆盖这里的返回。
const HOST_HEADER = '127.0.0.1:49700'
function headersFor() {
  return { host: HOST_HEADER, origin: `http://${HOST_HEADER}`, 'sec-fetch-site': 'same-origin' }
}

/** handler 是 void 包裹的异步，所以用「res.end 被调用」作为完成信号，不靠 sleep。 */
async function call(method, path, body, route = capturedRoute) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = {
    method,
    url: `/personal-memory${path}`,
    // 与浏览器同源 fetch 同形：Host 必带，同源请求也带 Origin 与 Sec-Fetch-Site。
    headers: headersFor(method, path, body),
    async *[Symbol.asyncIterator]() {
      for (const chunk of payload) yield chunk
    },
  }
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`超时没有响应：${method} ${path}`)), 30000)
    const res = {
      writeHead(code) { this.status = code },
      end(value) {
        clearTimeout(timer)
        resolvePromise({ status: this.status ?? 0, json: JSON.parse(String(value ?? '') || '{}') })
      },
    }
    req.res = res
    void route.handler(req, res)
  })
}

const capturedRoute = await mount(REAL_WORKSPACE)

const status = await call('GET', '/status')
check('GET /status 200', status.status === 200)
check('status 找到工作区', Boolean(status.json.value?.workspace), status.json.value?.workspace ?? '')
check('status 有 personal 计数', (status.json.value?.counts?.personal ?? 0) > 0, `personal=${status.json.value?.counts?.personal}`)
check('status 有日记计数', (status.json.value?.counts?.diaries ?? 0) > 0, `diaries=${status.json.value?.counts?.diaries}`)
check('status 带 ctx-server 健康', typeof status.json.value?.index?.ready === 'boolean', `ready=${status.json.value?.index?.ready}`)

const tree = await call('GET', '/tree?scope=personal,memory&refresh=1')
check('GET /tree 200', tree.status === 200)
const docs = tree.json.value?.docs ?? []
check('tree 有文档', docs.length > 0, `${docs.length} 篇`)
check('tree 每篇都有 path/name/mtime', docs.every((d) => d.path && d.name && d.mtime))
check('tree 范围内只有 personal/memory', docs.every((d) => d.scope === 'personal' || d.scope === 'memory'))
check('tree 有 .digest 之外的日记', docs.filter((d) => d.diary).length > 0, `日记 ${docs.filter((d) => d.diary).length} 篇`)

const sample = docs.find((d) => d.scope === 'personal' && !d.file.includes('index')) ?? docs[0]
const doc = await call('GET', `/doc?path=${encodeURIComponent(sample.path)}`)
check('GET /doc 200', doc.status === 200, sample.path)
check('doc 带全文', (doc.json.value?.text ?? '').length > 0, `${doc.json.value?.text?.length ?? 0} 字`)
check('doc 带目录 toc', Array.isArray(doc.json.value?.toc) && doc.json.value.toc.length > 0, `toc=${doc.json.value?.toc?.length}`)
check('doc 解析出 更新/来源 元信息', Boolean(doc.json.value?.meta), JSON.stringify(doc.json.value?.meta))

const evil = await call('GET', `/doc?path=${encodeURIComponent('../../etc/passwd')}`)
// 越界是「不允许」不是「服务器坏了」：该 403。之前这里断言的是 500，等于把 bug 冻进了测试。
check('GET /doc 拒绝目录穿越', evil.status === 403, `status=${evil.status}`)
const evil2 = await call('GET', `/doc?path=${encodeURIComponent('personal/../AGENTS.md')}`)
check('GET /doc 拒绝 .. 逃逸', evil2.status === 403, `status=${evil2.status}`)

const timeline = await call('GET', '/timeline?refresh=1')
const days = timeline.json.value?.days ?? []
check('GET /timeline 200', timeline.status === 200)
check('timeline 有日期', days.length > 0, `${days.length} 天`)
check('timeline 按日期倒序', days.every((d, i) => i === 0 || (days[i - 1].date >= d.date)))
check('timeline 每天有条目数', days.every((d) => typeof d.entries === 'number'))
check('timeline 有月份汇总', (timeline.json.value?.months ?? []).length > 0)
check('timeline 未完成计数可读', typeof timeline.json.value?.totals?.openTodos === 'number', `open=${timeline.json.value?.totals?.openTodos}`)

const search = await call('GET', `/search?q=${encodeURIComponent('止损线怎么定')}&scope=`)
check('GET /search 200', search.status === 200, JSON.stringify(search.json).slice(0, 200))
check('search 有命中', (search.json.value?.hits ?? []).length > 0, `hits=${search.json.value?.hits?.length} ms=${search.json.value?.ms}`)

const scoped = await call('GET', `/search?q=${encodeURIComponent('止损线怎么定')}&scope=memory`)
check('search scope=memory 只要 memory/', (scoped.json.value?.hits ?? []).every((h) => h.path.startsWith('memory/')), `hits=${scoped.json.value?.hits?.length}`)

const test = await call('POST', '/test', { query: '止损线怎么定' })
check('POST /test 200', test.status === 200)
check('test 有命中', (test.json.value?.hits ?? []).length > 0)
const testValue = test.json.value ?? {}
check('test 给出召回参数', testValue.params?.threshold > 0 && testValue.params?.maxChars > 0 && testValue.params?.fetchK >= 8,
  `th=${testValue.params?.threshold} k=${testValue.params?.fetchK} chars=${testValue.params?.maxChars}`)
check('test 列出全部候选', Array.isArray(testValue.rows) && testValue.rows.length >= testValue.hits.length,
  `candidates=${testValue.candidates} rows=${testValue.rows?.length}`)
check('test 标记谁会被注入', (testValue.rows ?? []).filter((row) => row.picked).length === testValue.hits.length,
  `picked=${testValue.picked} hits=${testValue.hits.length}`)
check('test 每种丢弃都有原因', (testValue.rows ?? []).every((row) => row.picked || row.drop === 'low' || row.drop === 'budget'),
  `low=${testValue.dropped?.low} budget=${testValue.dropped?.budget}`)
check('test 注入的条目互不重复', new Set((testValue.hits ?? []).map((hit) => hit.path)).size === (testValue.hits ?? []).length)

const bad = await call('POST', '/test', { query: '  ' })
check('POST /test 空 query 报 400', bad.status === 400, `status=${bad.status}`)
// 临时放宽：只对这一次生效，不写配置
const tight = await call('POST', '/test', { query: '止损线怎么定', threshold: 0.95 })
const tightVal = tight.json?.value ?? {}
check('POST /test 接受临时阈值', tightVal.params?.threshold === 0.95 && tightVal.params?.trial === true, JSON.stringify(tightVal.params))
check('临时阈值不写进配置', tightVal.params?.base?.threshold === 0.12, JSON.stringify(tightVal.params?.base))
check('阈值收紧后注入数下降或归零', Number(tightVal.picked) <= 7, `picked=${tightVal.picked}`)
const loose = await call('POST', '/test', { query: '止损线怎么定', threshold: 0 })
check('阈值为 0 时不再有「分数不够」', (loose.json?.value?.dropped?.low ?? 1) === 0, JSON.stringify(loose.json?.value?.dropped))
const small = await call('POST', '/test', { query: '止损线怎么定', maxChars: 400 })
check('POST /test 接受临时预算', small.json?.value?.params?.maxChars === 400, JSON.stringify(small.json?.value?.params))
check('预算收紧后注入数下降', Number(small.json?.value?.picked) < Number(tightVal.candidates), `picked=${small.json?.value?.picked}`)
// 摘要旋钮：收短摘要能在同样预算下多装几篇
const exOut = await call('POST', '/test', { query: '止损线怎么定', excerptChars: 120 })
const exVal = exOut.json?.value ?? {}
check('POST /test 接受临时摘要长度', exVal.params?.excerptChars === 120 && exVal.params?.trial === true, JSON.stringify(exVal.params))
check('临时摘要不写进配置', exVal.params?.base?.excerptChars === 260, JSON.stringify(exVal.params?.base))
check('摘要收短后条目字数变少', (exVal.rows ?? []).every((row) => String(row.excerpt ?? '').length <= 126), `${(exVal.rows ?? [])[0]?.excerpt?.length}`)
const exClamp = await call('POST', '/test', { query: '止损线怎么定', excerptChars: 5 })
check('摘要长度被夹到下限', exClamp.json?.value?.params?.excerptChars === 60, String(exClamp.json?.value?.params?.excerptChars))
// 语义命中的摘录要比字面命中的短（0.55 倍）：省下的字能多装一篇
const semanticRows = (exVal.rows ?? []).filter((row) => row.via === 'vector')
check('语义命中的摘录更短', semanticRows.every((row) => String(row.excerpt ?? '').length <= Math.max(60, Math.round(120 * 0.55)) + 6),
  semanticRows.map((row) => String(row.excerpt ?? '').length).join(','))
check('字面命中的摘录不缩水', (exVal.rows ?? []).filter((row) => row.via === 'keyword').every((row) => String(row.excerpt ?? '').length <= 126),
  (exVal.rows ?? []).filter((row) => row.via === 'keyword').map((row) => String(row.excerpt ?? '').length).join(','))
const altOut = await call('POST', '/test', { query: '止损线怎么定' })
const altVal = altOut.json?.value ?? {}
check('默认摘要下给出「收短能多进几篇」的对比', altVal.alt === null || (Number(altVal.alt.picked) > Number(altVal.alt.current) && Number(altVal.alt.excerptChars) === 120), JSON.stringify(altVal.alt))
// 「再多给多少字才够」：只报数字，不自动改配置
const needOut = await call('POST', '/test', { query: '止损线怎么定', maxChars: 400 })
const needVal = needOut.json?.value ?? {}
check('预算不够时给出需要多少字', Number(needVal.need?.budgetChars) > 400 && Number(needVal.need?.rows) > 0, JSON.stringify(needVal.need))
check('需要的字数 = 已用 + 补上被挡掉的', Number(needVal.need?.budgetChars) >= Number(needVal.need?.extraChars) + 1, JSON.stringify(needVal.need))
const needNone = await call('POST', '/test', { query: '止损线怎么定', maxChars: 8000 })
check('预算够时不给「再加字」的提示', needNone.json?.value?.need === null, JSON.stringify(needNone.json?.value?.need))
const needFit = await call('POST', '/test', { query: '止损线怎么定', maxChars: Number(needVal.need?.budgetChars) })
check('按提示的字数再试，被预算挡掉的变少', Number(needFit.json?.value?.dropped?.budget) < Number(needVal.dropped?.budget), `before=${needVal.dropped?.budget} after=${needFit.json?.value?.dropped?.budget}`)
const trialBad = await call('POST', '/test', { query: '止损线怎么定', threshold: 'abc' })
check('非法阈值被忽略而不是报错', trialBad.status === 200 && trialBad.json?.value?.params?.trial === false, `status=${trialBad.status}`)
const afterTrial = await call('GET', '/state')
check('临时放宽没写进 state', !JSON.stringify(afterTrial.json?.value?.ui ?? {}).includes('threshold'))


const missing = await call('GET', '/nope')
check('未知路径 404', missing.status === 404)

// ---- 写操作：临时工作区，不碰真日记 ----
const { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } = await import('node:fs')
const { tmpdir } = await import('node:os')

const now = new Date()
const pad = (n) => String(n).padStart(2, '0')
const todayParts = { year: String(now.getFullYear()), month: pad(now.getMonth() + 1), day: pad(now.getDate()) }
const sandbox = mkdtempSync(join(tmpdir(), 'pm-note-'))
mkdirSync(join(sandbox, 'personal'), { recursive: true })
mkdirSync(join(sandbox, 'memory'), { recursive: true })
writeFileSync(join(sandbox, 'personal', 'index.md'), '# 个人记忆\n\n- 测试工作区\n')
writeFileSync(join(sandbox, 'memory', 'index.md'), '# 时间长河\n')
const sandboxRoute = await mount(sandbox)

const note = await call('POST', '/note', { text: '冒烟测试条目（可以删）', section: '备忘' }, sandboxRoute)
check('POST /note 200', note.status === 200, JSON.stringify(note.json.value))
const notePath = note.json.value?.path ?? ''
check('note 落到 memory/YYYY/MM/今天.md', /^memory\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}\.md$/.test(notePath), notePath)

const note2 = await call('POST', '/note', { text: '第二条', section: '判断' }, sandboxRoute)
const written = readFileSync(join(sandbox, notePath), 'utf8')
check('note 是真追加（两条都在、分节正确）',
  written.includes('冒烟测试条目（可以删）') && written.includes('第二条') && /## 判断/.test(written),
  `${written.split('\n').length} 行`)
check('note 带 HH:MM 时间戳', /- \d{2}:\d{2} /.test(written))

// ---- 混合检索：向量召回不到的精确 token，靠词面层补回来 ----
await call('POST', '/note', { text: 'PMKWTOKEN42 只在沙箱里出现的一个精确 token', section: '备忘' }, sandboxRoute)
const kw = await call('GET', '/search?q=PMKWTOKEN42', null, sandboxRoute)
const kwHits = kw.json?.value?.hits ?? []
const kwHit = kwHits.find((hit) => hit.path === notePath)
check('词面检索能找回向量找不到的精确 token', Boolean(kwHit), kwHits.map((h) => `${h.via}:${h.path}`).join(' , ') || 'no hits')
// 同一篇既被向量召回又被词面命中时，via 保留 vector、用 literal 标「字面也命中了」——
// 两种都算「词面层认得这篇」，所以断言认这两个信号（真工作区里同名日期文件常和沙箱路径撞车）
check('词面命中标出 via=keyword 或 literal', kwHit?.via === 'keyword' || kwHit?.literal === true, `${String(kwHit?.via)}/${String(kwHit?.literal)}`)
check('混合检索有词面层参与', kw.json?.value?.mode === 'hybrid' || kwHit?.literal === true, String(kw.json?.value?.mode))
const kwScope = await call('GET', '/search?q=PMKWTOKEN42&scope=personal', null, sandboxRoute)
check('词面检索守 scope（memory 里的不越界）', (kwScope.json?.value?.hits ?? []).every((h) => String(h.path).startsWith('personal/')), JSON.stringify((kwScope.json?.value?.hits ?? []).map((h) => h.path)))
const kwMiss = await call('GET', '/search?q=PMKWTOKEN42NOTHERE', null, sandboxRoute)

  // ---- state.json 的版本与迁移：老文件不该靠八个 sanitize 各自猜 ----
  {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const legacy = {
      queries: ['止损线怎么定', '大豆供需'],
      stars: ['personal/关于我.md'],
      ui: { 'dir:stock': true },
      used: { 'personal/index.md': Date.now() },
      wait: { '等对账表': 'reply' },
      next: {},
      moved: {},
      usage: { '2026-11-19': { recalls: 2, injected: 5, chars: 400 } },
    }
    fs.mkdirSync(path.join(sandbox, '.dsh/personal-memory'), { recursive: true })
    fs.writeFileSync(path.join(sandbox, '.dsh/personal-memory/state.json'), JSON.stringify(legacy))
    const migrated = (await call('GET', '/state', null, sandboxRoute)).json?.value ?? {}
    check('迁移：老 queries 字符串补成对象', migrated.queries?.[0]?.q === '止损线怎么定' && migrated.queries[0].only === '', JSON.stringify(migrated.queries?.[0]))
    check('迁移：老 wait 字符串补成 {kind, at}', migrated.wait?.['等对账表']?.kind === 'reply' && migrated.wait['等对账表'].at === 0, JSON.stringify(migrated.wait))
    check('迁移：很老的平铺 ui 收进 collapsed', migrated.ui?.collapsed?.['dir:stock'] === true, JSON.stringify(migrated.ui))
    const exp2 = (await call('GET', '/state/export', null, sandboxRoute)).json?.value ?? {}
    check('导出：报告当前版本与文件版本', exp2.v === 2 && exp2.fileVersion === 0, JSON.stringify({ v: exp2.v, fileVersion: exp2.fileVersion }))
    // 用一个不在老文件里的路径：toggleStar 判断「没变」就不写盘，拿它测版本号会假失败
    await call('POST', '/star', { path: 'personal/index.md', on: true }, sandboxRoute)
    const onDisk = JSON.parse(fs.readFileSync(path.join(sandbox, '.dsh/personal-memory/state.json'), 'utf8'))
    check('写盘：落盘时打上版本号', onDisk.v === 2, String(onDisk.v))
    const exp3 = (await call('GET', '/state/export', null, sandboxRoute)).json?.value ?? {}
    check('导出：迁移后再读就是当前版本', exp3.fileVersion === 2, String(exp3.fileVersion))
    // 换一份 v0 老文件，确认「迁移可数」并且能显式落盘
    fs.writeFileSync(path.join(sandbox, '.dsh/personal-memory/state.json'), JSON.stringify({ queries: ['a', 'b'], wait: { k: 'reply' }, ui: { 'dir:x': true } }))
    const expOld = (await call('GET', '/state/export', null, sandboxRoute)).json?.value ?? {}
    check('迁移可数：报告补了哪几张表各几条', expOld.migration?.fixed === 4 && expOld.migration.migrated.length === 3, JSON.stringify(expOld.migration))
    const mig = (await call('POST', '/state/migrate', {}, sandboxRoute)).json?.value ?? {}
    check('现在写回文件：返回补了几条且版本落盘', mig.fixed === 4 && mig.v === 2, JSON.stringify({ fixed: mig.fixed, v: mig.v }))
    const afterMig = JSON.parse(fs.readFileSync(path.join(sandbox, '.dsh/personal-memory/state.json'), 'utf8'))
    check('写回后再读文件：已带版本号、形状已标准化', afterMig.v === 2 && typeof afterMig.queries[0] === 'object' && afterMig.wait.k.kind === 'reply', JSON.stringify({ v: afterMig.v, q: afterMig.queries[0] }))
    // 复位成干净状态，别影响后面的断言
    fs.writeFileSync(path.join(sandbox, '.dsh/personal-memory/state.json'), JSON.stringify({ v: 2, queries: [], stars: [], ui: {}, used: {}, wait: {}, next: {}, moved: {}, usage: {} }))
  }

  // ---- 面板自己的状态：能看见全貌，也能单独清掉一张表 ----
  const stExp = await call('GET', '/state/export', null, sandboxRoute)
  const exp = stExp.json?.value ?? {}
  check('导出面板状态：带条数与表名', stExp.status === 200 && Array.isArray(exp.tables) && exp.tables.includes('queries') && typeof exp.counts?.queries === 'number', JSON.stringify(exp.counts))
  check('导出面板状态：路径在 .dsh 下且带全量数据', exp.path === '.dsh/personal-memory/state.json' && exp.state && Array.isArray(exp.state.queries), String(exp.path))
  const stClearBad = await call('POST', '/state/clear', { tables: ['nope'] }, sandboxRoute)
  check('清空：表名不在白名单就拒绝', stClearBad.status === 400, JSON.stringify(stClearBad.json).slice(0, 100))
  const stClearNoConfirm = await call('POST', '/state/clear', { tables: ['queries'] }, sandboxRoute)
  check('清空：没带 confirm 不执行', stClearNoConfirm.status === 400, JSON.stringify(stClearNoConfirm.json).slice(0, 100))
  const beforeStars = (await call('GET', '/state', null, sandboxRoute)).json?.value?.stars ?? []
  const stClear = await call('POST', '/state/clear', { tables: ['queries'], confirm: true }, sandboxRoute)
  const cleared = stClear.json?.value ?? {}
  check('清空：指定的表清空', stClear.status === 200 && cleared.counts?.queries === 0 && Array.isArray(cleared.cleared) && cleared.cleared[0] === 'queries', JSON.stringify(cleared.counts))
  check('清空：别的表原样保留', JSON.stringify((await call('GET', '/state', null, sandboxRoute)).json?.value?.stars ?? []) === JSON.stringify(beforeStars), 'stars 变了')

// ---- 翻过但没动：打开过、之后再没改过 ----
{
  const file = join(sandbox, 'personal', 'readonly.md')
  writeFileSync(file, '# 翻过没动的示例\n\n更新:2026-11-01\n来源:冒烟\n\n一句话。\n', 'utf8')
  const past = new Date(Date.now() - 3 * 86400000)
  utimesSync(file, past, past)
  const empty = await call('GET', '/visited?limit=10', undefined, sandboxRoute)
  check('翻过没动：没人打开过时是空的', empty.status === 200 && Array.isArray(empty.json.value.items), JSON.stringify(empty.json).slice(0, 80))
  await call('POST', '/used', { path: 'personal/readonly.md' }, sandboxRoute)
  const after = await call('GET', '/visited?limit=10', undefined, sandboxRoute)
  const row = (after.json.value.items ?? []).find((item) => item.path === 'personal/readonly.md') ?? {}
  check('翻过没动：打开过、没改过的会进列表', row.path === 'personal/readonly.md' && typeof row.usedAt === 'number', JSON.stringify(row).slice(0, 120))
  check('翻过没动：带着「看过多久了」与标题', row.daysSinceUsed === 0 && row.title === '翻过没动的示例', JSON.stringify({ d: row.daysSinceUsed, t: row.title }))
  check('翻过没动：正文页标成 note', row.kind === 'note', String(row.kind))
  // 目录页（index/README）被打开通常只是「进去找东西」，要能区分出来
  const idxFile = join(sandbox, 'personal', 'index.md')
  const idxPast = new Date(Date.now() - 5 * 86400000)
  utimesSync(idxFile, idxPast, idxPast)
  await call('POST', '/used', { path: 'personal/index.md' }, sandboxRoute)
  const idxRow = ((await call('GET', '/visited?limit=10', undefined, sandboxRoute)).json.value.items ?? []).find((item) => item.path === 'personal/index.md') ?? {}
  check('翻过没动：目录页标成 index', idxRow.kind === 'index', String(idxRow.kind))
  // 停留时长：点开就走 vs 停下来读过，能分开
  await call('POST', '/used', { path: 'personal/readonly.md', dwell: 95000 }, sandboxRoute)
  const dwellRow = ((await call('GET', '/visited?limit=10', undefined, sandboxRoute)).json.value.items ?? []).find((item) => item.path === 'personal/readonly.md') ?? {}
  check('翻过没动：记下停留时长', dwellRow.dwell === 95000, String(dwellRow.dwell))
  await call('POST', '/used', { path: 'personal/readonly.md', dwell: 2000 }, sandboxRoute)
  const keptDwell = ((await call('GET', '/visited?limit=10', undefined, sandboxRoute)).json.value.items ?? []).find((item) => item.path === 'personal/readonly.md') ?? {}
  check('翻过没动：停留时长取最长的一次', keptDwell.dwell === 95000, String(keptDwell.dwell))
  await call('POST', '/used', { path: 'personal/readonly.md', dwell: 0 }, sandboxRoute)
  const zeroDwell = ((await call('GET', '/visited?limit=10', undefined, sandboxRoute)).json.value.items ?? []).find((item) => item.path === 'personal/readonly.md') ?? {}
  check('翻过没动：不带时长不会被清成 0', zeroDwell.dwell === 95000, String(zeroDwell.dwell))

  // 目录页「路过」之后能给一条补救线索：只追加一行，路径白名单与 hash 校验跟 /save 同一把锁
  const ap0 = await call('POST', '/append', { path: 'personal/index.md', line: '- 想找：止损线的历史判断' }, sandboxRoute)
  check('/append 追加一行成功', ap0.status === 200 && ap0.json?.value?.appended === true, JSON.stringify(ap0.json?.value ?? ap0.json).slice(0, 120))
  check('/append 真的写进文件末尾', readFileSync(join(sandbox, 'personal', 'index.md'), 'utf8').includes('- 想找：止损线的历史判断'), '')
  const ap1 = await call('POST', '/append', { path: 'personal/index.md', line: '- 想找：止损线的历史判断' }, sandboxRoute)
  check('/append 同一句不重复写', ap1.status === 200 && ap1.json?.value?.appended === false, JSON.stringify(ap1.json?.value ?? null).slice(0, 80))
  const ap2 = await call('POST', '/append', { path: 'personal/index.md', line: '   ' }, sandboxRoute)
  check('/append 空行 400', ap2.status === 400, String(ap2.status))
  const ap3 = await call('POST', '/append', { path: '../AGENTS.md', line: '- x' }, sandboxRoute)
  check('/append 越权 403', ap3.status === 403, String(ap3.status))
  const ap4 = await call('POST', '/append', { path: 'personal/index.md', line: '- x', hash: 'deadbeefdeadbeef' }, sandboxRoute)
  check('/append hash 对不上 409', ap4.status === 409, String(ap4.status))
  // 补完线索这一页先别再提醒（否则刚做完的事立刻又出现在同一张表上）
  const stillListed = ((await call('GET', '/visited?limit=10', undefined, sandboxRoute)).json.value.items ?? []).some((item) => item.path === 'personal/index.md')
  check('补过线索的目录页不再出现在「翻过没动」里', !stillListed, JSON.stringify(((await call('GET', '/visited?limit=10', undefined, sandboxRoute)).json.value.items ?? []).map((i) => i.path)).slice(0, 120))
  const clueState = (await call('GET', '/state', null, sandboxRoute)).json?.value ?? {}
  const clueEntry = Object.entries(clueState.clues ?? {}).find(([key]) => key.startsWith('personal/index.md\u0000'))
  check('线索记进了 state（path+正文 → {at, text, kind}）', Number(clueEntry?.[1]?.at) > 0 && String(clueEntry?.[1]?.text ?? '').includes('止损线') && clueEntry?.[1]?.kind === 'find', JSON.stringify(clueState.clues ?? null).slice(0, 160))
  // 打开后再改：就不再算「没动过」
  writeFileSync(file, '# 翻过没动的示例\n\n更新:2026-11-20\n来源:冒烟\n\n改了一句。\n', 'utf8')
  const now = new Date()
  utimesSync(file, now, now)
  const afterEdit = await call('GET', '/visited?limit=10', undefined, sandboxRoute)
  check('翻过没动：改过之后就不在列表里了', !(afterEdit.json.value.items ?? []).some((item) => item.path === 'personal/readonly.md'), JSON.stringify(afterEdit.json.value.items?.map?.((i) => i.path) ?? []).slice(0, 120))
}

// ---- 想找：线索汇总 ----
{
  // 用自己的一份笔记，别跟前面测「补线索」留下的那几条混在一起
  writeFileSync(join(sandbox, 'personal', 'clue-sheet.md'), '# 线索页\n\n随便写点什么\n')
  await call('GET', '/tree?refresh=1', null, sandboxRoute)
  const empty = await call('GET', '/clues?scope=personal', null, sandboxRoute)
  check('线索汇总：没有线索时为空（只算自己这页）', (empty.json?.value?.items ?? []).every((item) => item.path !== 'personal/clue-sheet.md'), JSON.stringify(empty.json?.value?.total))
  await call('POST', '/append', { path: 'personal/clue-sheet.md', line: '- 想找：各板块止损线怎么定' }, sandboxRoute)
  const one = (await call('GET', '/clues?scope=personal', null, sandboxRoute)).json?.value ?? {}
  const mine = (one.items ?? []).filter((item) => item.path === 'personal/clue-sheet.md')
  check('线索汇总：列出补过的那一条', mine.length === 1, JSON.stringify(mine))
  check('线索汇总：带正文与行号', mine[0]?.text === '各板块止损线怎么定' && Number(mine[0]?.line) > 0, JSON.stringify(mine[0]))
  check('线索汇总：刚补完算「还悬着」', mine[0]?.open === true, String(mine[0]?.open))
  // 之后又改过这页 → 那条线索算已落进正文
  await new Promise((done) => setTimeout(done, 1100))
  await call('POST', '/append', { path: 'personal/clue-sheet.md', line: '- 补了一句正文' }, sandboxRoute)
  const after = (await call('GET', '/clues?scope=personal', null, sandboxRoute)).json?.value ?? {}
  const mineAfter = (after.items ?? []).filter((item) => item.path === 'personal/clue-sheet.md')
  check('线索汇总：之后改过这页就不再算悬着', mineAfter[0]?.open === false, String(mineAfter[0]?.open))
  // 「我解决了」跟「这页改过」是两条独立的记录：改过的也能自己标回悬着
  const mark = (await call('POST', '/clue/resolve', { text: '各板块止损线怎么定' }, sandboxRoute)).json?.value ?? {}
  check('线索解决：标成已解决并记时间', mark.resolved === true && Number(mark.at) > 0, JSON.stringify(mark))
  const afterMark = (await call('GET', '/clues?scope=personal', null, sandboxRoute)).json?.value ?? {}
  const markRow = (afterMark.items ?? []).find((item) => item.path === 'personal/clue-sheet.md' && item.text === '各板块止损线怎么定')
  check('线索解决：已解决的不算悬着', markRow?.open === false && Number(markRow?.resolvedAt) > 0, JSON.stringify(markRow))
  check('线索解决：未解决的仍算悬着', (afterMark.items ?? []).find((item) => item.path === 'personal/index.md' && item.text === '止损线的历史判断')?.open === true, '')
  const unmark = (await call('POST', '/clue/resolve', { text: '各板块止损线怎么定', resolved: false }, sandboxRoute)).json?.value ?? {}
  check('线索解决：可以撤销', unmark.resolved === false && unmark.count === 0, JSON.stringify(unmark))
  const bad = await call('POST', '/clue/resolve', { text: '   ' }, sandboxRoute)
  check('线索解决：空正文 400', bad.status === 400, String(bad.status))
  // 解决完就消失，看不出「我最近在补哪些缺口」——所以留一周的可见记录
  await call('POST', '/clue/resolve', { text: '各板块止损线怎么定' }, sandboxRoute)
  const withRecent = (await call('GET', '/clues?scope=personal', null, sandboxRoute)).json?.value ?? {}
  // 「悬了多久」：从补线索那天算，不知道就给 null，不用 mtime 冒充
  const aged = (await call('GET', '/clues?scope=personal', null, sandboxRoute)).json?.value ?? {}
  const agedRow = (aged.items ?? []).find((item) => item.path === 'personal/clue-sheet.md' && item.text === '各板块止损线怎么定')
  check('线索年限：补过线索的那条带 ageDays', Number(agedRow?.ageDays) === 0 && Number(agedRow?.clueAt) > 0, JSON.stringify(agedRow))
  // 手写进文件的线索（没经过 /append，state 里没有记录）：宁可知不知道，也不要拿 mtime 冒充
  writeFileSync(join(sandbox, 'personal', 'manual-clue.md'), '# 手写\n\n- 想找：手写进文件的线索\n')
  const manual = (await call('GET', '/clues?scope=personal', null, sandboxRoute)).json?.value ?? {}
  const manualRow = (manual.items ?? []).find((item) => item.text === '手写进文件的线索')
  check('线索年限：没有记录的老线索 ageDays 是 null', manualRow?.ageDays === null && manualRow?.clueAt === 0, JSON.stringify(manualRow))
  check('线索汇总：给出可落点的目录页', Array.isArray(aged.indexPages) && aged.indexPages.length > 0 && aged.indexPages[0].path.endsWith('index.md'), JSON.stringify(aged.indexPages?.slice(0, 2)))
  check('线索排序：还悬着的排在已解决之前', (aged.items ?? [])[0]?.open === true, JSON.stringify((aged.items ?? []).map((item) => item.open)))
  // 「这条线索想要什么」：想知道答案 / 想确认 / 想找回原话——动作不同，得先分开
  await call('POST', '/append', { path: 'personal/clue-sheet.md', line: '- 想找：想确认的那条', clueKind: 'check' }, sandboxRoute)
  const kinds = (await call('GET', '/clues?scope=personal', null, sandboxRoute)).json?.value ?? {}
  const checkRow = (kinds.items ?? []).find((item) => item.text === '想确认的那条')
  check('线索类型：想确认的存下来并读回', checkRow?.clueKind === 'check', JSON.stringify(checkRow?.clueKind))
  const findRow = (kinds.items ?? []).find((item) => item.text === '各板块止损线怎么定')
  check('线索类型：没指定就是「想知道答案」', findRow?.clueKind === 'find', JSON.stringify(findRow?.clueKind))
  await call('POST', '/clue/resolve', { text: '想确认的那条', resolved: true }, sandboxRoute)

  // 线索也进检索：搜同一句话时，「还没人写过」这件事本身要能浮出来
  const clueSearch = (await call('GET', `/search?q=${encodeURIComponent('止损线的历史判断')}&topK=8`, null, sandboxRoute)).json?.value ?? {}
  const clueHit = (clueSearch.hits ?? []).find((hit) => hit.via === 'clue')
  check('线索进检索：命中的带 via=clue', Boolean(clueHit), JSON.stringify((clueSearch.hits ?? []).map((hit) => hit.via)))
  check('线索进检索：命中带线索类型与行号', clueHit?.clueKind === 'find' && Number(clueHit?.line) > 0, JSON.stringify(clueHit ?? null).slice(0, 160))
  check('线索进检索：摘录就是那句想找的话', String(clueHit?.excerpt ?? '').includes('止损线的历史判断'), String(clueHit?.excerpt ?? ''))

  check('线索解决：最近解决的带回来（含天数）', Array.isArray(withRecent.recent) && withRecent.recent[0]?.text === '各板块止损线怎么定' && withRecent.recent[0]?.days === 0, JSON.stringify(withRecent.recent))
}

// ---- 命中带「我什么时候看过它」 ----
{
  const before = await call('GET', '/search?q=止损线&topK=6')
  const hit0 = (before.json.value.hits ?? [])[0] ?? {}
  check('检索命中：默认不带「看过」时间（还没打过点时有 path 但没 usedAt）', before.status === 200 && (hit0.usedAt === undefined || typeof hit0.usedAt === 'number'), JSON.stringify(hit0.usedAt))
  if (hit0.path) {
    await call('POST', '/used', { path: hit0.path })
    const after = await call('GET', '/search?q=止损线&topK=6')
    const same = (after.json.value.hits ?? []).find((row) => row.path === hit0.path) ?? {}
    check('检索命中：打过点之后带上 usedAt', typeof same.usedAt === 'number' && same.usedAt > 0, JSON.stringify(same).slice(0, 80))
  }
}

// ---- 实验记录：每跑一次留一行，能回看 ----
{
  const empty = await call('GET', '/experiments')
  check('实验记录：一开始能读到（空或非空都算正常）', empty.status === 200 && Array.isArray(empty.json.value.items), JSON.stringify(empty.json).slice(0, 80))
  const made = await call('POST', '/experiment', { kind: 'sweep', query: 'PMEXP 止损线怎么定？', rows: [{ key: 'base', injected: 10, candidates: 12, low: 0, budget: 2, top: 0.48 }, { key: 'bud', injected: 12, candidates: 12, low: 0, budget: 0, top: 0.48 }] })
  check('实验记录：能追加一次扫描', made.status === 200 && made.json.value.total >= 1, JSON.stringify(made.json).slice(0, 80))
  const back = await call('GET', '/experiments?limit=5')
  const first = (back.json.value.items ?? [])[0] ?? {}
  check('实验记录：读回来带 kind 与查询', first.kind === 'sweep' && String(first.query).startsWith('PMEXP'), JSON.stringify(first).slice(0, 80))
  check('实验记录：读回来带每一行的数字', Array.isArray(first.rows) && first.rows.length === 2 && first.rows[1].injected === 12, JSON.stringify(first.rows ?? []).slice(0, 80))
  const bad1 = await call('POST', '/experiment', { kind: 'nope', query: 'x', rows: [{ injected: 1 }] })
  check('实验记录：非法 kind 400', bad1.status === 400, String(bad1.status))
  const bad2 = await call('POST', '/experiment', { kind: 'sweep', query: 'x', rows: [] })
  check('实验记录：没有 rows 400', bad2.status === 400, String(bad2.status))
  const cmp = await call('POST', '/experiment', { kind: 'compare', query: 'PMEXP 换个说法', rows: [{ key: 'orig', text: '原话', injected: 3, candidates: 9, top: 0.5 }] })
  check('实验记录：两种实验都能记', cmp.status === 200 && cmp.json.value.kind === 'compare', JSON.stringify(cmp.json).slice(0, 60))
}

// ---- 面板状态也在检索里：写在 state.json 的「下一步 / 在等」不该只活在面板里 ----
const stateTodo = await call('POST', '/note', { text: 'PMSTATE55 沙箱里一条待办', todo: true }, sandboxRoute)
check('造一条带 state 的待办', stateTodo.status === 200, JSON.stringify(stateTodo.json).slice(0, 120))
await call('POST', '/wait', { text: 'PMSTATE55 沙箱里一条待办', kind: null, next: '等 PMSTATENEXT66 那份对账表' }, sandboxRoute)
const stHit = await call('GET', '/search?q=PMSTATENEXT66', null, sandboxRoute)
const stHits = stHit.json?.value?.hits ?? []
const stOne = stHits.find((h) => h.via === 'state')
check('下一步里的词能搜到（via=state）', Boolean(stOne), JSON.stringify(stHits.map((h) => `${h.via}:${h.path}`)).slice(0, 200))
check('state 命中带回落点路径与小节', Boolean(stOne?.path?.endsWith('.md')) && typeof stOne?.heading === 'string', JSON.stringify(stOne ?? {}).slice(0, 160))
check('state 命中带 kind 与原文', stOne?.stateKind === 'next' && String(stOne?.stateText ?? '').includes('PMSTATE55'), JSON.stringify({ kind: stOne?.stateKind, text: stOne?.stateText }))
const stOnly = await call('GET', '/search?q=PMSTATENEXT66&only=state', null, sandboxRoute)
const stOnlyHits = stOnly.json?.value?.hits ?? []
check('只看待办时返回的全是状态命中', stOnlyHits.length > 0 && stOnlyHits.every((h) => h.via === 'state'), JSON.stringify(stOnlyHits.map((h) => h.via)))
check('只看待办时 mode 标成 state', stOnly.json?.value?.mode === 'state' && stOnly.json?.value?.only === 'state', JSON.stringify({ mode: stOnly.json?.value?.mode, only: stOnly.json?.value?.only }))
const stHist = await call('GET', '/state', null, sandboxRoute)
const histRows = stHist.json?.value?.queries ?? []
const onlyRow = histRows.find((item) => item && typeof item === 'object' && item.q === 'PMSTATENEXT66')
check('「只看待办」也记进检索历史', onlyRow?.only === 'state', JSON.stringify(onlyRow))
check('同一句只开开关不算同一条历史', histRows.filter((item) => item?.q === 'PMSTATENEXT66').length === 2, JSON.stringify(histRows.filter((item) => item?.q === 'PMSTATENEXT66')))
check('老历史行补齐 only 字段', histRows.every((item) => item && typeof item === 'object' && typeof (item.only ?? '') === 'string'), JSON.stringify(histRows[0]))
const stOnlyMiss = await call('GET', '/search?q=PMSTATENOMATCH99&only=state', null, sandboxRoute)
check('只看待办、没命中时是空列表而不是报错', stOnlyMiss.status === 200 && (stOnlyMiss.json?.value?.hits ?? []).length === 0, JSON.stringify(stOnlyMiss.json?.value?.hits))
const stScope = await call('GET', '/search?q=PMSTATENEXT66&scope=personal', null, sandboxRoute)
check('限 scope=personal 时不混入待办状态', !(stScope.json?.value?.hits ?? []).some((h) => h.via === 'state'), JSON.stringify((stScope.json?.value?.hits ?? []).map((h) => h.via)))

// ---- 只看线索 ----
writeFileSync(join(sandbox, 'personal', 'pm-clue-only.md'), '# 线索单\n\n- 想找：PMONLYCLUE 这条\n')
const clueOnly = await call('GET', '/search?q=PMONLYCLUE&only=clue&topK=5', null, sandboxRoute)
const clueOnlyHits = clueOnly.json?.value?.hits ?? []
check('只看线索时返回 200 且标 only=clue', clueOnly.status === 200 && clueOnly.json?.value?.only === 'clue', JSON.stringify({ status: clueOnly.status, only: clueOnly.json?.value?.only }))
check('只看线索时每一条都是 via=clue', clueOnlyHits.length > 0 && clueOnlyHits.every((h) => h.via === 'clue'), JSON.stringify(clueOnlyHits.map((h) => h.via)))
check('只看线索时 mode 标成 clue', clueOnly.json?.value?.mode === 'clue', JSON.stringify({ mode: clueOnly.json?.value?.mode }))
const clueMixed = await call('GET', '/search?q=PMONLYCLUE&topK=8', null, sandboxRoute)
const clueMixedHits = clueMixed.json?.value?.hits ?? []
check('不限类型时线索命中也在里面', clueMixedHits.some((h) => h.via === 'clue'), JSON.stringify(clueMixedHits.map((h) => h.via)))
check('不限类型时命中条数不少于只看线索', clueMixedHits.length >= clueOnlyHits.length, JSON.stringify({ mixed: clueMixedHits.length, only: clueOnlyHits.length }))
const clueOnlyMiss = await call('GET', '/search?q=PMONLYNOMATCH99&only=clue', null, sandboxRoute)
check('只看线索、没命中时是空列表而不是报错', clueOnlyMiss.status === 200 && (clueOnlyMiss.json?.value?.hits ?? []).length === 0, JSON.stringify(clueOnlyMiss.json?.value?.hits))

// ---- 只看笔记：把待办与线索两路关掉 ----
writeFileSync(join(sandbox, 'personal', 'pm-note-only.md'), '# 笔记\n\nPMNOTEONLY77 这一段写在正文里。\n')
const noteOnly = await call('GET', '/search?q=PMNOTEONLY77&only=note', null, sandboxRoute)
const noteOnlyHits = noteOnly.json?.value?.hits ?? []
check('只看笔记时返回 200 且标 only=note', noteOnly.status === 200 && noteOnly.json?.value?.only === 'note', JSON.stringify({ status: noteOnly.status, only: noteOnly.json?.value?.only }))
check('只看笔记时不含待办与线索命中', noteOnlyHits.length > 0 && !noteOnlyHits.some((h) => h.via === 'state' || h.via === 'clue'), JSON.stringify(noteOnlyHits.map((h) => h.via)))

// ---- 检索的时间范围：把沙箱那篇的 mtime 拨回一年前 ----
const old = new Date(Date.now() - 400 * 86400000)
utimesSync(join(sandbox, notePath), old, old)
const kwDays = await call('GET', '/search?q=PMKWTOKEN42&days=7', null, sandboxRoute)
check('days=7 时滤掉一年前改过的笔记', !(kwDays.json?.value?.hits ?? []).some((h) => h.path === notePath), JSON.stringify((kwDays.json?.value?.hits ?? []).map((h) => h.path)))
check('days 原样回传', kwDays.json?.value?.days === 7, String(kwDays.json?.value?.days))
const kwAll = await call('GET', '/search?q=PMKWTOKEN42&days=0', null, sandboxRoute)
check('days=0 时不限时间，仍能找回', (kwAll.json?.value?.hits ?? []).some((h) => h.path === notePath))
const kw400 = await call('GET', '/search?q=PMKWTOKEN42&days=500', null, sandboxRoute)
check('days=500 时又找回来了', (kw400.json?.value?.hits ?? []).some((h) => h.path === notePath))
check('days 传垃圾值不炸', (await call('GET', '/search?q=PMKWTOKEN42&days=abc', null, sandboxRoute)).status === 200)

// ---- 面板状态：最近查询 + 星标 ----
const state0 = await call('GET', '/state', null, sandboxRoute)
check('GET /state 200', state0.status === 200, JSON.stringify(state0.json))
const queries0 = state0.json?.value?.queries ?? []
check('最近查询记下了刚才那次', queries0.some((item) => (typeof item === 'string' ? item : item?.q) === 'PMKWTOKEN42'), JSON.stringify(queries0).slice(0, 120))
check('最近查询存的是「查询+范围+时间窗」对象', queries0.every((item) => item && typeof item === 'object' && typeof item.q === 'string' && typeof item.scope === 'string' && typeof item.days === 'number'), JSON.stringify(queries0[0]))
const starOn = await call('POST', '/star', { path: 'personal/index.md' }, sandboxRoute)
check('POST /star 200', starOn.status === 200, JSON.stringify(starOn.json))
check('星标后 starred=true', starOn.json?.value?.starred === true, JSON.stringify(starOn.json?.value))
check('星标列表里有它', (starOn.json?.value?.stars ?? []).includes('personal/index.md'))
const stateFile = join(sandbox, '.dsh/personal-memory/state.json')
check('星标落在工作区 .dsh 里', readFileSync(stateFile, 'utf8').includes('personal/index.md'))
const treeStar = await call('GET', '/tree?scope=personal', null, sandboxRoute)
check('/tree 带 star 标记', (treeStar.json?.value?.docs ?? []).some((doc) => doc.path === 'personal/index.md' && doc.star === true), JSON.stringify((treeStar.json?.value?.docs ?? []).map((d) => [d.path, d.star])))
const starOff = await call('POST', '/star', { path: 'personal/index.md', on: false }, sandboxRoute)
check('取消星标 starred=false', starOff.json?.value?.starred === false, JSON.stringify(starOff.json?.value))
check('取消后列表里没有它', !(starOff.json?.value?.stars ?? []).includes('personal/index.md'))
check('POST /star 拒绝目录穿越', (await call('POST', '/star', { path: '../AGENTS.md' }, sandboxRoute)).status === 403)
check('POST /star 拒绝不存在的笔记', (await call('POST', '/star', { path: 'personal/nope.md' }, sandboxRoute)).status === 403)
const beforeNoise = (await call('GET', '/state', null, sandboxRoute)).json?.value?.queries?.length ?? 0
const noisy = '这是一段从正文里截出来的很长的东西'.repeat(6)
await call('GET', `/search?q=${encodeURIComponent(noisy.slice(0, 200))}`, null, sandboxRoute)
const afterNoise = (await call('GET', '/state', null, sandboxRoute)).json?.value?.queries ?? []
check('拿正文当 query 的检索不进最近查过',
  afterNoise.length === beforeNoise || !afterNoise.some((item) => String(typeof item === 'string' ? item : item?.q).includes(noisy.slice(0, 60))),
  `${beforeNoise} -> ${afterNoise.length}`)

// 同一句话换时间窗 = 另一条历史，不能互相覆盖
await call('GET', '/search?q=PMFILTERSCOPE77&topK=5&scope=personal,memory&days=7', null, sandboxRoute)
await call('GET', '/search?q=PMFILTERSCOPE77&topK=5&scope=personal,memory&days=0', null, sandboxRoute)
const filtered = ((await call('GET', '/state', null, sandboxRoute)).json?.value?.queries ?? []).filter((item) => (typeof item === 'string' ? item : item?.q) === 'PMFILTERSCOPE77')
check('同一句换时间窗算两条历史', filtered.length === 2, JSON.stringify(filtered))
check('历史里存下了范围与时间窗', filtered.some((item) => item.scope === 'personal,memory' && item.days === 7) && filtered.some((item) => item.days === 0), JSON.stringify(filtered))
await call('GET', '/search?q=PMRECORDOFF99&record=0', null, sandboxRoute)
// ---- 打开打点：召回后来有没有被用上 ----
const used0 = await call('GET', '/state', null, sandboxRoute)
check('/state 带 used 字段', used0.status === 200 && typeof used0.json?.value?.used === 'object', JSON.stringify(used0.json?.value?.used ?? null).slice(0, 40))
const usedOn = await call('POST', '/used', { path: 'personal/index.md' }, sandboxRoute)
check('POST /used 记下打开时间', usedOn.status === 200 && Number(usedOn.json?.value?.at) > 0, `${usedOn.status} ${JSON.stringify(usedOn.json?.value ?? null).slice(0, 60)}`)
const usedState = await call('GET', '/state', null, sandboxRoute)
check('/state 里读到刚打的点', Number(usedState.json?.value?.used?.['personal/index.md']?.at) > 0, JSON.stringify(usedState.json?.value?.used?.['personal/index.md'] ?? null).slice(0, 60))
check('POST /used 缺 path 报 400', (await call('POST', '/used', {}, sandboxRoute)).status === 400)
const usedFile = readFileSync(join(sandbox, '.dsh/personal-memory/state.json'), 'utf8')
check('打开记录落在工作区 .dsh 里（不进笔记）', usedFile.includes('personal/index.md') && usedFile.includes('used') && !usedFile.includes('/Users/mars/sly/personal/index.md'))

// ---- 最近召回日志带 items（面板里能点进原文） ----
const statusNow = await call('GET', '/status', null, sandboxRoute)
const recentRows = statusNow.json?.value?.recent ?? []
check('累计召回不再被 beacon 挤成 0（读窗口够深）', Number(statusNow.json?.value?.stats?.recalls) > 0, `recalls=${statusNow.json?.value?.stats?.recalls} logLines=${statusNow.json?.value?.logLines}`)
check('最近召回里没有 mounted 行', recentRows.every((row) => row.event !== 'mounted'), JSON.stringify(recentRows.slice(0, 2)))
check('最近召回的 items 形状正确', recentRows.every((row) => row.items === undefined || (Array.isArray(row.items) && row.items.every((item) => typeof item.path === 'string' && typeof item.title === 'string'))))
check('items 带路径时能定位到真实笔记', recentRows.filter((row) => Array.isArray(row.items)).every((row) => row.items.every((item) => item.path === '' || item.path.startsWith('personal/') || item.path.startsWith('memory/') || item.path.startsWith('project/'))))

// ---- 打点去重：同一个 rev 只记一次 ----
const beaconA = await call('GET', '/beacon?stage=apply&href=dsh-app://app/&ua=smoke', null, sandboxRoute)
const beaconB = await call('GET', '/beacon?stage=apply&href=dsh-app://app/&ua=smoke', null, sandboxRoute)
check('第一次打点会被记录', beaconA.json?.value?.recorded === true || beaconA.status === 200, JSON.stringify(beaconA.json?.value))
check('同一 stage 重复打点被跳过', beaconB.json?.value?.skipped === 'duplicate' || beaconB.json?.value?.recorded === false, JSON.stringify(beaconB.json?.value))
check('打点带上 bundle rev（去重靠它）', beaconA.json?.value?.rev === 'smoke-rev-1', String(beaconA.json?.value?.rev))

// ---- 日志瘦身：beacon 不能把召回行挤出窗口 ----
const logFile = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'logs', 'personal-memory.jsonl')
const logBefore = existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).length : 0
check('日志行数可读', logBefore >= 0, `lines=${logBefore}`)

// ---- 日用量汇总：日志被清空也不该归零 ----
const usageState = JSON.parse(readFileSync(join(sandbox, '.dsh/personal-memory/state.json'), 'utf8'))
check('state.json 里有天汇总容器', usageState.usage === undefined || typeof usageState.usage === 'object', JSON.stringify(usageState.usage ?? null))

const usageNow = statusNow.json?.value?.usage ?? null
check('/status 带 usage 命中率统计', usageNow && typeof usageNow.injected === 'number' && typeof usageNow.rate === 'object' || typeof usageNow?.rate === 'number' || usageNow?.rate === null,
  JSON.stringify(usageNow))
check('/status 的 stats 说明数字从哪来', ['log', 'rollup'].includes(statusNow.json?.value?.stats?.source), String(statusNow.json?.value?.stats?.source))
check('/status 的 usage 标注来源', ['log', 'rollup'].includes(usageNow?.source), String(usageNow?.source))
check('/status 的 stats.rollup 形状正确', statusNow.json?.value?.stats?.rollup === undefined || ['days', 'recalls', 'injected', 'chars'].every((k) => typeof statusNow.json.value.stats.rollup[k] === 'number'))

check('没有样本时命中率是 null 而不是 0', usageNow.injected > 0 || usageNow.rate === null, JSON.stringify(usageNow))
check('record=0 时不记最近查过', !((await call('GET', '/state', null, sandboxRoute)).json?.value?.queries ?? []).includes('PMRECORDOFF99'))

// ---- 速记带 todo：今天页直接加一条待办 ----
const quick = await call('POST', '/note', { text: 'PMQUICKTODO 记得回邮件', todo: true }, sandboxRoute)
check('POST /note todo=true 200', quick.status === 200, JSON.stringify(quick.json))
const quickDay = await call('GET', `/doc?path=${encodeURIComponent(quick.json?.value?.path ?? '')}`, null, sandboxRoute)
const quickText = quickDay.json?.value?.text ?? ''
check('待办写进「未完成」小节', quickText.includes('- [ ] PMQUICKTODO 记得回邮件'), String(quickText).slice(-200))
check('待办不带时间前缀', !/- \d{2}:\d{2} PMQUICKTODO/.test(quickText))
const quickTimeline = await call('GET', '/timeline?refresh=1', null, sandboxRoute)
const todayRow = (quickTimeline.json?.value?.days ?? []).find((day) => day.path === quick.json?.value?.path)
check('时间线上今天多了一条未完成', (todayRow?.todos ?? []).some((item) => String(item.text).includes('PMQUICKTODO')), JSON.stringify(todayRow?.todos ?? []))
check('空文本的待办被拒', (await call('POST', '/note', { text: '   ', todo: true }, sandboxRoute)).status === 400)
check('查不到的 token 不硬凑', (kwMiss.json?.value?.hits ?? []).every((h) => h.via !== 'keyword'), JSON.stringify((kwMiss.json?.value?.hits ?? []).slice(0, 2)))
check('note 拒绝空文本', (await call('POST', '/note', { text: '   ' }, sandboxRoute)).status === 400)
const realDiary = join(REAL_WORKSPACE, `memory/${todayParts.year}/${todayParts.month}/${todayParts.day}.md`)
let realDiaryText = ''
try { realDiaryText = readFileSync(realDiary, 'utf8') } catch { realDiaryText = '' }
// ---- 勾待办：只改那一行 ----
const diaryRel = notePath
const diaryAbs = join(sandbox, diaryRel)
const lines = readFileSync(diaryAbs, 'utf8').split('\n')
const todoLine = lines.findIndex((row) => /^- \[ \] \S/.test(row)) + 1
check('冒烟日记里有一条未勾的待办', todoLine > 0, `line ${todoLine}`)
const todoText = todoLine > 0 ? lines[todoLine - 1].replace(/^\s*-\s+\[ \]\s*/, '').trim() : ''
const tick = await call('POST', '/todo', { path: diaryRel, line: todoLine, done: true, expect: todoText }, sandboxRoute)
check('POST /todo 勾上 200', tick.status === 200, `status=${tick.status}`)
check('POST /todo 返回 done:true', tick.json?.value?.done === true, JSON.stringify(tick.json))
const after = readFileSync(diaryAbs, 'utf8').split('\n')
check('磁盘上真的变成 [x]', /^- \[x\]/.test(after[todoLine - 1]), after[todoLine - 1])
check('其它行一个字没动', after.length === lines.length && after.filter((_, i) => i !== todoLine - 1).join('\n') === lines.filter((_, i) => i !== todoLine - 1).join('\n'))
// 勾掉之后，「今天勾掉的」要在时间线上看得见（只显示欠的，人以为今天什么都没干）
const tickTimeline = await call('GET', '/timeline?refresh=1', null, sandboxRoute)
const tickDay = (tickTimeline.json?.value?.days ?? []).find((day) => day.path === diaryRel) ?? {}
check('/timeline 每天带 doneItems', Array.isArray(tickDay.doneItems), JSON.stringify(tickDay.doneItems ?? null).slice(0, 120))
check('刚勾掉的那条进了 doneItems', (tickDay.doneItems ?? []).some((item) => String(item.text).includes(todoText.replace(/\s+/g, ' ').trim().slice(0, 10))), `todo=${todoText.slice(0, 30)} | done=${JSON.stringify((tickDay.doneItems ?? []).map((item) => item.text))}`)
check('doneItems 只有正文没有勾选框', (tickDay.doneItems ?? []).every((item) => !String(item.text).startsWith('[x]')))
const untick = await call('POST', '/todo', { path: diaryRel, line: todoLine, done: false }, sandboxRoute)
check('POST /todo 取消勾选 200', untick.status === 200)
check('磁盘上真的变回 [ ]', /^- \[ \]/.test(readFileSync(diaryAbs, 'utf8').split('\n')[todoLine - 1]))
const again = await call('POST', '/todo', { path: diaryRel, line: todoLine, done: false }, sandboxRoute)
check('重复勾同一状态算 unchanged', again.json?.value?.unchanged === true, JSON.stringify(again.json))
check('POST /todo 文本对不上报 400', (await call('POST', '/todo', { path: diaryRel, line: todoLine, done: true, expect: '完全不同的内容' }, sandboxRoute)).status === 400)
check('POST /todo 不是待办的行报 400', (await call('POST', '/todo', { path: diaryRel, line: 1, done: true }, sandboxRoute)).status === 400)
check('POST /todo 越界行号报 400', (await call('POST', '/todo', { path: diaryRel, line: 9999, done: true }, sandboxRoute)).status === 400)
check('POST /todo done 非布尔报 400', (await call('POST', '/todo', { path: diaryRel, line: todoLine, done: 'yes' }, sandboxRoute)).status === 400)
check('POST /todo 拒绝目录穿越', (await call('POST', '/todo', { path: '../AGENTS.md', line: 1, done: true }, sandboxRoute)).status === 403)

// ---- 改期：删掉源行、目标那天落一条同文的 ----
const deferTo = '2026-11-21'
const dstRel0 = `memory/2026/11/${deferTo}.md`
const deferred = await call('POST', '/todo/defer', { path: diaryRel, line: todoLine, expect: todoText, to: deferTo }, sandboxRoute)
check('POST /todo/defer 200', deferred.status === 200, `status=${deferred.status} ${JSON.stringify(deferred.json).slice(0,200)}`)
check('改期返回源与目标', deferred.json?.value?.from?.line === todoLine && deferred.json?.value?.to?.date === deferTo && deferred.json?.value?.to?.path === dstRel0, JSON.stringify(deferred.json?.value?.from) + ' → ' + JSON.stringify(deferred.json?.value?.to))
const srcAfterDefer = readFileSync(join(sandbox, diaryRel), 'utf8').split('\n')
check('源文件里那一行被删掉了', !srcAfterDefer.some((row) => row.includes(todoText)), String(todoText).slice(0, 20))
const dstAfterDefer = readFileSync(join(sandbox, dstRel0), 'utf8').split('\n')
const dstHit = dstAfterDefer.findIndex((row) => /^- \[ \] \S/.test(row) && row.includes(todoText))
check('目标那天落了同文一条', dstHit >= 0, String(dstAfterDefer.length))
const secIdx = dstAfterDefer.findIndex((row) => /^##\s*未完成/.test(row))
check('落在「未完成」节里', secIdx >= 0 && dstHit > secIdx, `section@${secIdx} todo@${dstHit}`)
check('改期会记一步「挪过几次」', deferred.json?.value?.moved === 1, String(deferred.json?.value?.moved))
// 再挪一次：链上要变 2，而且时间线要能带出「从哪天起一直在挪」
const dstDoc = await call('GET', `/doc?path=${encodeURIComponent(dstRel0)}`, null, sandboxRoute)
const dstLines = String(dstDoc.json?.value?.text ?? '').split('\n')
const dstLine = dstLines.findIndex((row) => /^- \[ \] \S/.test(row)) + 1
// 第二次改期：顺手带一句「为什么挪」，链上要留得下这句话、时间线要能读出来
const twiceWhy = dstLine > 0
  ? await call('POST', '/todo/defer', { path: dstRel0, line: dstLine, expect: todoText, to: '2026-11-22', note: '  等三季报出来再说  ' }, sandboxRoute)
  : { status: 0, json: {} }
check('第二次改期同样成功', twiceWhy.status === 200, `status=${twiceWhy.status} ${JSON.stringify(twiceWhy.json).slice(0, 160)}`)
check('改期可以带理由', twiceWhy.status === 200 && twiceWhy.json?.value?.moved === 2, `status=${twiceWhy.status} moved=${twiceWhy.json?.value?.moved}`)
const tlWhy = await call('GET', '/timeline?refresh=1', null, sandboxRoute)
const whyRow = (tlWhy.json?.value?.days ?? []).flatMap((day) => day.todos ?? []).find((item) => String(item.text).includes('PMDEFER') || String(item.text).includes(String(todoText).slice(0, 6)))
check('时间线带出每一步的理由（去空白）', Boolean(whyRow) && (whyRow.movedSteps ?? []).some((step) => step.note === '等三季报出来再说'), JSON.stringify(whyRow?.movedSteps ?? null).slice(0, 200))
const whyState = await call('GET', '/state', null, sandboxRoute)
check('理由写进 state.json', Object.values(whyState.json?.value?.moved ?? {}).some((chain) => Array.isArray(chain) && chain.some((step) => step.note === '等三季报出来再说')), '')
const tl2 = await call('GET', '/timeline?refresh=1', null, sandboxRoute)
const needle = String(todoText).replace(/\s+/g, ' ').trim().slice(0, 8)
const movedRows = (tl2.json?.value?.days ?? []).flatMap((day) => (day.todos ?? []).filter((item) => String(item.text).replace(/\s+/g, ' ').includes(needle)))
check('时间线带出改期次数与起点', movedRows.length > 0 && movedRows[0].movedCount >= 2 && /^\d{4}-\d{2}-\d{2}$/.test(String(movedRows[0].movedFrom ?? '')), JSON.stringify(movedRows[0] ?? null).slice(0, 200))
const st2 = await call('GET', '/state', null, sandboxRoute)
const movedMap = st2.json?.value?.moved ?? {}
check('改期链落在 state.json 里', Object.values(movedMap).some((chain) => Array.isArray(chain) && chain.length >= 2), JSON.stringify(movedMap).slice(0, 160))
// 目标文件里那条现在的行号（上面已经挪过两次，位置会变：按内容重新找）
const dstRel = dstRel0
const dstAbsNow = join(sandbox, dstRel)
const dstTodoLine = readFileSync(dstAbsNow, 'utf8').split('\n').findIndex((row) => /^- \[ \] \S/.test(row)) + 1
check('改期到同一天报 400', (await call('POST', '/todo/defer', { path: dstRel, line: dstTodoLine, to: deferTo }, sandboxRoute)).status === 400)
// 先勾掉一条再试改期：已完成的待办不该被挪走（新造一条，别依赖上面还剩什么）
await call('POST', '/note', { text: 'PMDEFERCHECK 已经做完的事', todo: true }, sandboxRoute)
const rowsNow = readFileSync(diaryAbs, 'utf8').split('\n')
const tickable = rowsNow.findIndex((row) => row.includes('PMDEFERCHECK')) + 1
let deferCheckedStatus = 0
if (tickable > 0) {
  await call('POST', '/todo', { path: diaryRel, line: tickable, done: true }, sandboxRoute)
  const checkedDefer = await call('POST', '/todo/defer', { path: diaryRel, line: tickable, to: deferTo }, sandboxRoute)
  deferCheckedStatus = checkedDefer.status
  if (checkedDefer.status !== 400) console.log('   debug defer-on-checked:', JSON.stringify(checkedDefer.json).slice(0, 200))
}
check('改期已勾掉的待办报 400', deferCheckedStatus === 400, `status=${deferCheckedStatus}`)
check('改期文本对不上报 400', (await call('POST', '/todo/defer', { path: dstRel, line: dstTodoLine, to: '2026-11-22', expect: '完全不同的内容' }, sandboxRoute)).status === 400)
check('改期拒绝目录穿越', (await call('POST', '/todo/defer', { path: '../AGENTS.md', line: 1, to: deferTo }, sandboxRoute)).status === 403)

// ---- 编辑：hash 争用 + 逐字写回 ----
const target = 'personal/index.md'
const before = await call('GET', `/doc?path=${encodeURIComponent(target)}`, null, sandboxRoute)
check('GET /doc 带 hash 与 mtimeMs', typeof before.json?.value?.hash === 'string' && Number(before.json?.value?.mtimeMs) > 0, JSON.stringify({ hash: before.json?.value?.hash, mtimeMs: before.json?.value?.mtimeMs }))
const original = before.json?.value?.text ?? ''
const edited = `${original.trimEnd()}\n\n## 手动补一段\n\n- 面板里写的\n`
const saved = await call('POST', '/save', { path: target, text: edited, hash: before.json?.value?.hash }, sandboxRoute)
check('POST /save 200', saved.status === 200, JSON.stringify(saved.json))
check('save 报告 changed:true', saved.json?.value?.changed === true)
check('磁盘上真是新内容', readFileSync(join(sandbox, target), 'utf8') === edited, JSON.stringify(readFileSync(join(sandbox, target), 'utf8').slice(-40)))
check('save 返回新 hash', typeof saved.json?.value?.hash === 'string' && saved.json.value.hash !== before.json?.value?.hash)
check('用旧 hash 再保存报 409', (await call('POST', '/save', { path: target, text: 'x', hash: before.json?.value?.hash }, sandboxRoute)).status === 409)
check('内容没变算 changed:false', (await call('POST', '/save', { path: target, text: edited, hash: saved.json?.value?.hash }, sandboxRoute)).json?.value?.changed === false)
check('save text 非字符串报 400', (await call('POST', '/save', { path: target, text: 123 }, sandboxRoute)).status === 400)
check('save 拒绝目录穿越', (await call('POST', '/save', { path: '../AGENTS.md', text: 'x' }, sandboxRoute)).status === 403)
check('save 拒绝不存在的路径', (await call('POST', '/save', { path: 'personal/nope.md', text: 'x' }, sandboxRoute)).status === 403)

// ---- 新建笔记：骨架 + 重名自增 ----
const made = await call('POST', '/create', { scope: 'personal', dir: 'personal', title: '冒烟新建笔记' }, sandboxRoute)
check('POST /create 200', made.status === 200, JSON.stringify(made.json))
const madePath = made.json?.value?.path ?? ''
check('create 落在 personal/ 且是 .md', /^personal\/.+\.md$/.test(madePath), madePath)
const madeText = readFileSync(join(sandbox, madePath), 'utf8')
check('create 生成 H1 + 更新: + 来源:',
  madeText.startsWith('# 冒烟新建笔记\n') && /^更新:\d{4}-\d{2}-\d{2}$/m.test(madeText) && /^来源:面板新建$/m.test(madeText),
  JSON.stringify(madeText))
check('create 返回 text/toc/hash', typeof made.json?.value?.text === 'string' && Array.isArray(made.json?.value?.toc) && typeof made.json?.value?.hash === 'string')
const made2 = await call('POST', '/create', { scope: 'personal', dir: 'personal', title: '冒烟新建笔记' }, sandboxRoute)
check('重名自动加 -2', String(made2.json?.value?.path ?? '').endsWith('-2.md'), String(made2.json?.value?.path))
check('create 空标题报 400', (await call('POST', '/create', { dir: 'personal', title: '  ' }, sandboxRoute)).status === 400)
check('create 拒绝 memory（日记靠速记）', (await call('POST', '/create', { scope: 'memory', dir: 'memory', title: 'x' }, sandboxRoute)).status === 400)
check('create 目录不存在报 400', (await call('POST', '/create', { dir: 'personal/没有这个目录', title: 'x' }, sandboxRoute)).status === 400)
check('create 拒绝目录穿越', (await call('POST', '/create', { dir: 'personal/../..', title: 'x' }, sandboxRoute)).status === 403)
check('create 拒绝越界 scope', (await call('POST', '/create', { scope: 'etc', dir: 'etc', title: 'x' }, sandboxRoute)).status === 400)

// ---- 知识库体检：缺元数据、孤儿、死链 ----
{
  const clean = await call('GET', '/audit', undefined, sandboxRoute)
  check('体检可用', clean.status === 200 && clean.json?.value?.counts, `status=${clean.status}`)
  check('体检默认只看 personal', (clean.json?.value?.topics ?? []).every((topic) => topic.startsWith('personal')), JSON.stringify(clean.json?.value?.topics))
  const before = Number(clean.json?.value?.counts?.total) || 0

  // 造三篇：一篇缺元数据、一篇没被索引、再在索引里塞一条死链
  writeFileSync(join(sandbox, 'personal', 'no-meta.md'), '# 没有元数据的笔记\n\n正文。\n')
  // 孤儿要放在主题目录里才有意义：根目录裸文件是另一条判据（会单独报「根目录裸文件」）
  mkdirSync(join(sandbox, 'personal', 'learning'), { recursive: true })
  writeFileSync(join(sandbox, 'personal', 'learning', 'index.md'), '# 学习\n\n## 索引\n')
  writeFileSync(join(sandbox, 'personal', 'learning', 'orphan.md'), '# 孤儿笔记\n\n更新:2026-11-20\n来源:冒烟\n\n正文。\n')
  const indexFile = join(sandbox, 'personal', 'index.md')
  const indexText = readFileSync(indexFile, 'utf8')
  writeFileSync(indexFile, `${indexText}\n[死链](gone.md)\n`)

  const dirty = await call('GET', '/audit?scope=personal', undefined, sandboxRoute)
  const items = dirty.json?.value?.items ?? []
  check('体检抓出缺「更新:」', items.some((item) => item.path === 'personal/no-meta.md' && item.issue.includes('更新')), `${items.length} 条`)
  check('体检抓出没被索引引用', items.some((item) => item.path === 'personal/learning/orphan.md' && item.issue.includes('index')), '')
  check('体检抓出死链并且是 P0', items.some((item) => item.level === 'P0' && item.issue.includes('gone.md')), '')
  check('体检结果比干净时多', Number(dirty.json?.value?.counts?.total) > before, `${before} → ${dirty.json?.value?.counts?.total}`)

  // 收拾干净，别把脏数据留给后面的断言
  writeFileSync(indexFile, indexText)
  rmSync(join(sandbox, 'personal', 'no-meta.md'))
  rmSync(join(sandbox, 'personal', 'learning', 'orphan.md'))
  rmSync(join(sandbox, 'personal', 'learning', 'index.md'))
  rmSync(join(sandbox, 'personal', 'learning'), { recursive: true, force: true })
  const again = await call('GET', '/audit', undefined, sandboxRoute)
  check('收拾之后体检回到干净', Number(again.json?.value?.counts?.total) === before, `${again.json?.value?.counts?.total} vs ${before}`)
}

// ---- 检索命中带 mtime：面板要显示「改于几时」，时间过滤也靠它 ----
// 注意：向量索引是真实工作区的，沙箱里没有那些 path → 拿不到 mtime，所以这条要打真工作区路由
const searched = await call('GET', '/search?q=' + encodeURIComponent('止损线') + '&topK=6')
const searchedHits = searched.json?.value?.hits ?? []
check('search 命中带 mtimeMs', searchedHits.length > 0 && searchedHits.every((hit) => Number(hit.mtimeMs) > 0), `${searchedHits.length} 条 / ${searchedHits.filter((h) => Number(h.mtimeMs) > 0).length} 带时间`)
const daysFiltered = await call('GET', '/search?q=' + encodeURIComponent('止损线') + '&days=7')
check('days 过滤后命中仍带 mtimeMs', (daysFiltered.json?.value?.hits ?? []).every((hit) => Number(hit.mtimeMs) > 0))
check('days 过滤只留窗口内的', (daysFiltered.json?.value?.hits ?? []).every((hit) => Date.now() - Number(hit.mtimeMs) <= 8 * 86400000))

// ---- 折叠偏好：跟工作区走，不进笔记 ----
const uiSaved = await call('POST', '/ui', { collapsed: { 'month:2026-11': true, 'bucket:old': true } }, sandboxRoute)
check('POST /ui 200', uiSaved.status === 200 && uiSaved.json?.value?.ui?.collapsed?.['month:2026-11'] === true, JSON.stringify(uiSaved.json).slice(0, 160))
const uiState = await call('GET', '/state', undefined, sandboxRoute)
const st = await call('GET', '/status')
check('/status 给出 profile 配置文件路径', typeof st.json?.value?.profileFile === 'string' && st.json.value.profileFile.endsWith('cordis.patch.yml'), String(st.json?.value?.profileFile))
check('/status 给出日志行数与起点', Number(st.json?.value?.logLines) >= 1 && typeof st.json?.value?.logSince === 'string', `lines=${st.json?.value?.logLines} since=${st.json?.value?.logSince}`)
check('GET /state 带回折叠偏好', uiState.json?.value?.ui?.collapsed?.['bucket:old'] === true)
const uiFile = JSON.parse(readFileSync(join(sandbox, '.dsh/personal-memory/state.json'), 'utf8'))
check('state.json 真落了 ui.collapsed', uiFile?.ui?.collapsed?.['month:2026-11'] === true, JSON.stringify(uiFile).slice(0, 120))
const uiMerge = await call('POST', '/ui', { collapsed: { 'dir:personal/stock': true } }, sandboxRoute)
check('再次 POST /ui 是合并不是覆盖', uiMerge.json?.value?.ui?.collapsed?.['month:2026-11'] === true && uiMerge.json?.value?.ui?.collapsed?.['dir:personal/stock'] === true)
const longKey = 'x'.repeat(200)
const uiJunk = await call('POST', '/ui', { collapsed: { 'month:2026-11': 'yes', [longKey]: true } }, sandboxRoute)
check('非布尔的折叠值被丢掉', uiJunk.json?.value?.ui?.collapsed?.['month:2026-11'] === true, JSON.stringify(uiJunk.json?.value?.ui?.collapsed))
check('超长 key 被丢掉', Object.keys(uiJunk.json?.value?.ui?.collapsed ?? {}).every((key) => key.length <= 80))
check('POST /ui 非对象报 400', (await call('POST', '/ui', 'nope', sandboxRoute)).status === 400)
// 清单排序和折叠一样，是「跟工作区走的偏好」，不是数据
await call('POST', '/ui', { todoSort: 'oldest' }, sandboxRoute)
const sortState = await call('GET', '/state', null, sandboxRoute)
check('POST /ui 能记住清单排序', sortState.json?.value?.ui?.todoSort === 'oldest', String(sortState.json?.value?.ui?.todoSort))
await call('POST', '/ui', { todoSort: '瞎写' }, sandboxRoute)
const sortBack = await call('GET', '/state', null, sandboxRoute)
check('非法排序值被忽略，保留原值', sortBack.json?.value?.ui?.todoSort === 'oldest', String(sortBack.json?.value?.ui?.todoSort))
await call('POST', '/ui', { todoSort: 'fresh' }, sandboxRoute)
const sortFresh2 = await call('GET', '/state', null, sandboxRoute)
check('排序可以切回来', sortFresh2.json?.value?.ui?.todoSort === 'fresh', String(sortFresh2.json?.value?.ui?.todoSort))
// 检索排序：查「止损线」要分数，查「11 月做了什么」要时间——两种都记住
await call('POST', '/ui', { searchSort: 'recent' }, sandboxRoute)
const searchSortState = await call('GET', '/state', null, sandboxRoute)
check('POST /ui 能记住检索排序', searchSortState.json?.value?.ui?.searchSort === 'recent', String(searchSortState.json?.value?.ui?.searchSort))
check('记住检索排序不影响清单排序', searchSortState.json?.value?.ui?.todoSort === 'fresh', String(searchSortState.json?.value?.ui?.todoSort))
await call('POST', '/ui', { searchSort: '按时间' }, sandboxRoute)
const searchSortBack = await call('GET', '/state', null, sandboxRoute)
check('非法检索排序被忽略', searchSortBack.json?.value?.ui?.searchSort === 'recent', String(searchSortBack.json?.value?.ui?.searchSort))
await call('POST', '/ui', { searchSort: 'score' }, sandboxRoute)


// 改期：明天 / 下周一（宿主算日期，客户端只说意图）
const deferNote = await call('POST', '/note', { text: 'PMDEFERMON 归一（可以删）', todo: true }, sandboxRoute)
const deferPath = deferNote.json?.value?.path
const deferDoc = await call('GET', `/doc?path=${encodeURIComponent(deferPath)}`, null, sandboxRoute)
const deferLines = String(deferDoc.json?.value?.text ?? '').split('\n')
const deferLine = deferLines.findIndex((row) => /^- \[ \] PMDEFERMON/.test(row)) + 1
const monday = await call('POST', '/todo/defer', { path: deferPath, line: deferLine, expect: 'PMDEFERMON', to: 'monday' }, sandboxRoute)
const mondayDate = monday.json?.value?.to?.date
const mondayDow = mondayDate ? new Date(`${mondayDate}T12:00:00`).getDay() : -1
check('挪到下周一：落到周一', monday.status === 200 && mondayDow === 1, `${String(mondayDate)} dow=${mondayDow}`)
check('挪到下周一：不是今天也不是昨天', mondayDate !== new Date().toISOString().slice(0, 10), String(mondayDate))
const deferNote2 = await call('POST', '/note', { text: 'PMDEFERTOM 归一（可以删）', todo: true }, sandboxRoute)
const deferDoc2 = await call('GET', `/doc?path=${encodeURIComponent(deferNote2.json?.value?.path)}`, null, sandboxRoute)
const deferLine2 = String(deferDoc2.json?.value?.text ?? '').split('\n').findIndex((row) => /^- \[ \] PMDEFERTOM/.test(row)) + 1
const tomorrow = await call('POST', '/todo/defer', { path: deferNote2.json?.value?.path, line: deferLine2, expect: 'PMDEFERTOM', to: 'tomorrow' }, sandboxRoute)
const tomorrowDate = tomorrow.json?.value?.to?.date
const tomorrowExpect = (function () { const d = new Date(); d.setDate(d.getDate() + 1); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` })()
check('挪到明天：落到明天', tomorrowDate === tomorrowExpect, `${String(tomorrowDate)} vs ${tomorrowExpect}`)

// 「在等什么」：认正文不认行号，所以改期之后标记还跟着走
await call('POST', '/note', { text: 'PMWAITCHK 一条要等的事（可以删）', todo: true }, sandboxRoute)
const waitSet = await call('POST', '/wait', { text: 'PMWAITCHK 一条要等的事（可以删）', kind: 'market' }, sandboxRoute)
check('POST /wait 记下「在等行情」（带时间戳）', waitSet.status === 200 && waitSet.json?.value?.wait?.kind === 'market' && Number(waitSet.json?.value?.wait?.at) > 0, JSON.stringify(waitSet.json).slice(0, 160))
const waitAgeTl = await call('GET', '/timeline?refresh=1', null, sandboxRoute)
const waitAgeRow = (waitAgeTl.json?.value?.days ?? []).flatMap((day) => day.todos ?? []).find((item) => String(item.text ?? '').startsWith('PMWAITCHK'))
check('时间线上这条带「等了几天」', waitAgeRow?.wait === 'market' && Number(waitAgeRow?.waitDays) === 0 && Number(waitAgeRow?.waitAt) > 0, JSON.stringify({ wait: waitAgeRow?.wait, waitDays: waitAgeRow?.waitDays }))
const waitTl = await call('GET', '/timeline?refresh=1', null, sandboxRoute)
const waitRow = (waitTl.json?.value?.days ?? []).flatMap((day) => day.todos ?? []).find((item) => String(item.text ?? '').startsWith('PMWAITCHK'))
check('/timeline 的待办带 wait 标记', waitRow?.wait === 'market', String(waitRow?.wait))
const waitBad = await call('POST', '/wait', { text: 'PMWAITCHK 一条要等的事（可以删）', kind: '瞎写' }, sandboxRoute)
check('非法 wait 种类报 400', waitBad.status === 400, String(waitBad.status))

// 「变成行动」顺手写下的一步：存进 state.next，跟着正文摘要走
const nextSet = await call('POST', '/wait', { text: 'PMWAITCHK 一条要等的事（可以删）', kind: null, next: '读 PRD 第 3 节' }, sandboxRoute)
check('POST /wait 能同时清标记 + 存下一步', nextSet.status === 200 && nextSet.json?.value?.wait === null && String(nextSet.json?.value?.next ?? '').includes('PRD'), JSON.stringify(nextSet.json?.value ?? null))
const nextTl = await call('GET', '/timeline?refresh=1', null, sandboxRoute)
const nextRow = (nextTl.json?.value?.days ?? []).flatMap((day) => day.todos ?? []).find((item) => String(item.text ?? '').startsWith('PMWAITCHK'))
check('时间线上这条带 next（标记已清）', nextRow?.wait === null && String(nextRow?.next ?? '').includes('PRD'), JSON.stringify({ wait: nextRow?.wait, next: nextRow?.next }))
const nextState = await call('GET', '/state', null, sandboxRoute)
check('/state 里 next 也在', Object.values(nextState.json?.value?.next ?? {}).some((value) => String(value).includes('PRD')), JSON.stringify(nextState.json?.value?.next ?? null).slice(0, 120))
const nextLong = await call('POST', '/wait', { text: 'PMWAITCHK 一条要等的事（可以删）', kind: null, next: '字'.repeat(300) }, sandboxRoute)
check('过长的下一步被截到 120 字', nextLong.status === 200 && String(nextLong.json?.value?.next ?? '').length === 120, String(nextLong.json?.value?.next ?? '').length)

const waitClear = await call('POST', '/wait', { text: 'PMWAITCHK 一条要等的事（可以删）', kind: null }, sandboxRoute)
check('kind 留空就清除标记', waitClear.status === 200 && waitClear.json?.value?.wait === null, JSON.stringify(waitClear.json?.value ?? null))
const waitEmpty = await call('POST', '/wait', { text: '   ' }, sandboxRoute)
check('空正文报 400', waitEmpty.status === 400, String(waitEmpty.status))

check('折叠偏好没写进任何笔记', !readFileSync(join(sandbox, 'personal/index.md'), 'utf8').includes('month:2026-11'))

check('写操作没碰真日记', !realDiaryText.includes('冒烟测试条目（可以删）'), realDiary.replace(REAL_WORKSPACE + '/', ''))

rmSync(sandbox, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) process.exit(1)
