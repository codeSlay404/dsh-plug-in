// 离线渲染脚手架：不装 React、不开浏览器，直接执行真实的 client.js。
//
// 为什么要有它：这台机器上 GUI（dsh web）需要 token，@electron 也没有开调试端口，
// 没法用浏览器自动化验收界面。所以用一套极简 hooks 运行时把组件树真的展开，
// 数据走真实的 host 路由（假 req/res），从而在命令行里验证：
//   · 组件渲染不抛异常；
//   · client 端的字段假设与 host 返回的 JSON 对得上；
//   · smoke-render.mjs 能断言结构，preview.mjs 能导出静态 HTML 再用 Chrome 截图看视觉。
//
// 用法：
//   import { boot } from './harness.mjs'
//   const { parts, hostCall, settle, expand, collect, styles, t } = await boot({ workspace })

import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 真实工作区：优先环境变量；没给就退回「插件目录往上两层」（本仓库就是工作区的 project/ 下），
// 这样 npm run check 不需要先 export 一个变量。
function guessRealWorkspace() {
  const fromEnv = process.env.DSH_MEMORY_WORKSPACE
  if (fromEnv) return fromEnv
  const parent = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  return existsSync(join(parent, 'personal')) && existsSync(join(parent, 'memory')) ? parent : undefined
}
const REAL_WORKSPACE = guessRealWorkspace()

import { apply } from './index.js'

export async function boot(options = {}) {
  // 默认值必须是「报错」而不是真实工作区：忘了传 workspace 的测试脚本一旦写盘，
  // 就会写进某个真实工作区（2026-11-22 的 smoke 事故就是这么来的）。
  if (!options.workspace && options.realWorkspace !== true) {
    throw new Error('boot() 必须显式传 workspace（临时目录）；确实要读真实工作区请传 realWorkspace: true')
  }
  if (options.realWorkspace === true && !options.workspace && !REAL_WORKSPACE) {
    throw new Error('读取真实工作区要显式指定：boot({ realWorkspace: true, workspace }) 或设置环境变量 DSH_MEMORY_WORKSPACE')
  }
  const workspace = resolve(options.workspace ?? REAL_WORKSPACE ?? process.cwd())

  /* ---------------- 1. 宿主半：注册 /personal-memory 路由 ---------------- */
  const captured = {}
  const ctx = {
    on() {},
    effect(setup) { return setup() },
    webServer: { register(route) { captured.route = route; return () => {} } },
    workingDirectory: { defaultDirectory: workspace },
    workspaceRegistry: { list() { return [{ path: workspace }] } },
  }
  // resolveWorkspace() 的 seed 会「向上找同时有 personal/ 和 memory/ 的目录」。
  // 临时工作区里这两个目录如果还不存在，它会一路往上找到某个上级真实工作区 ——
  // 于是所有写操作都落到那里（2026-11-22 就这么覆盖过一次真实 personal 文件）。
  // 所以：先把三个标准目录建好，让 seed 第一跳就命中临时目录。
  for (const dir of ['personal', 'memory', 'project']) mkdirSync(join(workspace, dir), { recursive: true })

  apply(ctx, { workspace, log: false, autoReindex: false })
  if (!captured.route) throw new Error('host 半没有注册 /personal-memory 路由')

  const DEFAULT_HEADERS = { host: '127.0.0.1:49700', origin: 'http://127.0.0.1:49700', 'sec-fetch-site': 'same-origin' }

  function hostCall(method, path, body, headers) {
    const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = {
      method,
      url: `/personal-memory${path}`,
      headers: headers === undefined ? { ...DEFAULT_HEADERS } : headers,
      async *[Symbol.asyncIterator]() {
        for (const chunk of payload) yield chunk
      },
    }
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error(`host 路由超时：${method} ${path}`)), 30000)
      const res = {
        writeHead(code) { this.status = code },
        end(value) {
          clearTimeout(timer)
          const json = JSON.parse(String(value ?? '') || '{}')
          if (json.ok === false) {
            const error = new Error(json.error?.message ?? 'host error')
            error.status = this.status
            error.code = json.error?.code
            reject(error)
          } else resolvePromise(json.value)
        },
      }
      void captured.route.handler(req, res)
    })
  }

  // 二道保险：真跑起来之后再问一次宿主用的是哪个工作区，对不上就直接炸，
  // 绝不允许「测试脚本静默写真实工作区」这种情况再发生。
  const resolved = await hostCall('GET', '/status')
  if (resolve(resolved?.workspace ?? '/nonexistent') !== resolve(workspace)) {
    throw new Error(
      `harness 工作区解析偏离：期望 ${resolve(workspace)}，宿主持有 ${resolved?.workspace ?? '(空)'}；已中止，避免写坏真实工作区`,
    )
  }

  /* ---------------- 2. 极简 hooks 运行时 ---------------- */
  // state 必须按「组件实例」分桶：用一个全局游标会让后渲染的组件读到前一个组件的 state。
  const stateStore = new Map()
  let compStack = [{ id: 'root', cursor: 0 }]
  let occurrences = new Map()
  let effects = []
  let dirty = false

  const top = () => compStack[compStack.length - 1]
  function slot() {
    const frame = top()
    const key = `${frame.id}:${frame.cursor}`
    frame.cursor += 1
    return key
  }

  // React 的真实语义是「children 也是 props.children」—— 图标组件（Glyph）正是靠它拿子节点，
  // 所以这里必须把 children 同时放进 props，否则渲染出来的 svg 是空的。
  function createElement(type, props, ...children) {
    const flat = []
    const push = (node) => {
      if (Array.isArray(node)) node.forEach(push)
      else if (node !== null && node !== undefined && node !== false) flat.push(node)
    }
    push(children)
    const merged = { ...(props ?? {}) }
    let source = flat
    if (source.length === 0 && merged.children !== undefined) source = [merged.children].flat(Infinity)
    if (source.length > 0) merged.children = source.length === 1 ? source[0] : source
    return { type, props: merged, children: source }
  }

  // React 的 Fragment 是个 symbol：这里给它同款，expand 时当透明盒子展开
  const Fragment = Symbol.for('react.fragment')

  const React = {
    createElement,
    Fragment,
    createRef: () => ({ current: null }),
    useState(initial) {
      const key = slot()
      if (!stateStore.has(key)) stateStore.set(key, typeof initial === 'function' ? initial() : initial)
      const setState = (next) => {
        const value = typeof next === 'function' ? next(stateStore.get(key)) : next
        if (value !== stateStore.get(key)) {
          stateStore.set(key, value)
          dirty = true
        }
      }
      return [stateStore.get(key), setState]
    },
    useMemo(fn) { slot(); return fn() },
    useCallback(fn) { slot(); return fn },
    // 真实的 useEffect 只在依赖变化时跑；不认依赖的话「换文档才重置草稿」这类
    // 带 [] 的副作用会在每一轮 pass 里反复执行，把编辑态又按回关闭。
    useEffect(fn, deps) {
      const key = slot()
      if (deps === undefined) { effects.push(fn); return undefined }
      const prev = stateStore.get(key)
      const changed = !prev || deps.length !== prev.deps.length || deps.some((dep, i) => !Object.is(dep, prev.deps[i]))
      if (!changed) return undefined
      stateStore.set(key, { deps: deps.slice() })
      effects.push(fn)
      return undefined
    },
    // 真实的 useRef 在重渲之间是同一个对象（写进去的值要留着），
    // 所以这里把 ref 也存进 stateStore，而不是每次返回 { current: initial }。
    useRef(initial) {
      const key = slot()
      if (!stateStore.has(key)) stateStore.set(key, { current: initial })
      return stateStore.get(key)
    },
    useSyncExternalStore() { slot(); return undefined },
  }

  const realFetch = globalThis.fetch
  const fetchLog = []
  // 让 settle() 知道「还有请求在飞」：异步拉数据触发的 setState 不能被当成「渲染已稳定」
  const inflight = new Set()
  async function fakeFetch(url, init) {
    const target = String(url)
    if (!target.startsWith('/personal-memory')) {
      // host 半自己会去连 127.0.0.1:17878（contextdb），放行给真 fetch
      fetchLog.push(`(passthrough) ${init?.method ?? 'GET'} ${target}`)
      return realFetch(url, init)
    }
    fetchLog.push(`${init?.method ?? 'GET'} ${target}`)
    const path = target.replace(/^\/personal-memory/, '')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body) : undefined
    const ticket = {}
    inflight.add(ticket)
    try {
      const value = await hostCall(method, path, body)
      return {
        ok: true,
        status: 200,
        async json() { return { ok: true, value } },
      }
    } finally {
      inflight.delete(ticket)
    }
  }

  /* ---------------- 3. 假的浏览器环境 ---------------- */
  const styleNodes = []
  const doc = {
    createElement() { return { id: '', textContent: '', setAttribute() {}, remove() {} } },
    head: { appendChild(node) { styleNodes.push(node) }, removeChild() {} },
    body: { appendChild() {} },
    querySelector() { return null },
    getElementById(id) { return styleNodes.find((n) => n.id === id) ?? null },
    addEventListener() {},
    removeEventListener() {},
  }

  // 文案直接用 client.js 里的真字典，别另写一份 —— 否则预览/冒烟里会出现没翻译的裸 key。
  // client.js 要等下面 import 之后才有 locales，所以这里只能惰性取。
  const dictOf = () => moduleApi?.__parts?.locales?.zh ?? {}

  const slots = {
    captured: [],
    register(entry, renderer) {
      slots.captured.push({ entry, renderer })
      return () => {}
    },
    inject(_key, callback) { return callback() },
  }
  const locale = {
    register() { return () => {} },
    bind() { return (key) => dictOf()[key] ?? key },
    getLocale() { return { id: 'zh' } },
    subscribe() { return () => {} },
  }

  // 假 matchMedia：让 CSS 媒体查询与 JS 里的 useNarrow() 用同一个宽度判断，
  // 这样「手机宽度」的预览才能真的走到窄屏分支。
  const viewportWidth = () => Number(globalThis.__pmViewportWidth) || Number(options.width) || 1440
  const matchesQuery = (query) => {
    const max = /\(\s*max-width:\s*(\d+)px\s*\)/.exec(String(query))
    const min = /\(\s*min-width:\s*(\d+)px\s*\)/.exec(String(query))
    let ok = true
    if (max) ok = ok && viewportWidth() <= Number(max[1])
    if (min) ok = ok && viewportWidth() >= Number(min[1])
    return ok
  }
  const makeMql = (query) => ({
    media: String(query),
    get matches() { return matchesQuery(query) },
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  })

  let moduleApi = null
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    matchMedia: makeMql,
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (...args) => clearTimeout(...args),
    __ModuleLoader__: {
      load({ id, factory }) {
        moduleApi = factory((name) => {
          if (name === 'react') return React
          throw new Error(`unexpected require: ${name}`)
        })
        moduleApi.__id = id
      },
    },
  }
  globalThis.document = doc
  globalThis.fetch = fakeFetch
  globalThis.AbortSignal = globalThis.AbortSignal ?? class {}
  if (!('timeout' in globalThis.AbortSignal)) globalThis.AbortSignal.timeout = () => undefined

  const clientCtx = {
    get(key) {
      if (key === 'slots') return slots
      if (key === 'locale') return locale
      if (key === 'layout') return { selectPanel() {}, toggleSidebar() {} }
      return undefined
    },
    effect(setup) { return setup() },
    on() {},
  }

  await import('./client.js')
  if (!moduleApi) throw new Error('client.js 没有调用 window.__ModuleLoader__.load')
  moduleApi.apply(clientCtx)
  if (styleNodes.length === 0) throw new Error('client.js 没有注入样式')

  /* ---------------- 4. 把函数组件真的展开 ---------------- */
  function expand(node) {
    if (node === null || node === undefined || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map(expand)
    const el = node
    if (el.type === Fragment) {
      const kids = []
      for (const child of el.children ?? []) kids.push(expand(child))
      return kids
    }
    if (typeof el.type === 'function') {
      const name = el.type.name || 'anon'
      const index = occurrences.get(name) ?? 0
      occurrences.set(name, index + 1)
      compStack.push({ id: `${name}#${index}`, cursor: 0 })
      let out
      try {
        out = el.type(el.props)
      } finally {
        compStack.pop()
      }
      return expand(out)
    }
    const children = []
    for (const child of el.children ?? []) children.push(expand(child))
    return { type: el.type, props: el.props ?? {}, children }
  }

  function renderOnce(renderFn, props) {
    compStack = [{ id: 'root', cursor: 0 }]
    occurrences = new Map()
    effects = []
    dirty = false
    const tree = expand(createElement(renderFn, { ...props, t }))
    const pending = []
    for (const effect of effects) {
      const result = effect()
      if (result && typeof result.then === 'function') pending.push(result)
    }
    return { tree, pending }
  }

  async function settle(renderFn, props, passes = 40) {
    let tree = null
    let stable = 0
    for (let i = 0; i < passes; i += 1) {
      const out = renderOnce(renderFn, props)
      tree = out.tree
      await Promise.all(out.pending)
      await new Promise((resolve) => setTimeout(resolve, 30))
      // 还在等宿主回话就不算稳定：数据到手后还会有一次 re-render
      const busy = inflight.size > 0
      if (!dirty && !busy) stable += 1
      else stable = 0
      if (stable >= 2 && i >= 2) break
    }
    return tree
  }

  const parts = moduleApi.__parts
  const t = locale.bind('personal-memory.panel')

  return {
    workspace,
    parts,
    t,
    hostCall,
    settle,
    expand,
    createElement,
    styles: styleNodes.map((node) => String(node.textContent ?? '')),
    styleNodes,
    slots,
    locale,
    get dict() { return dictOf() },
    fetchLog,
    realFetch,
    reset() { stateStore.clear(); compStack = [{ id: 'root', cursor: 0 }]; occurrences = new Map(); effects = []; dirty = false },
  }
}

export function walk(node, visit) {
  if (node === null || node === undefined) return
  if (typeof node !== 'object') { visit(node); return }
  if (Array.isArray(node)) { node.forEach((child) => walk(child, visit)); return }
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

export function collect(node) {
  const text = []
  const classes = []
  const tags = []
  walk(node, (el) => {
    if (typeof el === 'string' || typeof el === 'number') { text.push(String(el)); return }
    if (typeof el !== 'object') return
    if (el.type) tags.push(String(el.type))
    const cls = el.props?.className
    if (typeof cls === 'string') classes.push(...cls.split(/\s+/).filter(Boolean))
    if (el.props?.placeholder) text.push(el.props.placeholder)
  })
  return { text, classes, tags, all: [...text, ...classes.map((c) => `cls:${c}`)].join(' | ') }
}
