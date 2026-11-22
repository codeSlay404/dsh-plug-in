// 离线渲染脚手架(仿 dsh-personal-memory/harness.mjs 的思路,但 travel 没有网络请求,
// 所以极简很多):不开浏览器、不装依赖,直接执行真实的 client.js,把组件树真的展开。
//
// 用法:
//   import { boot, walk, collect } from './harness.mjs'
import { apply } from './index.js'

/* ---------------- 极简 hooks 运行时 ----------------
 * state 按组件实例分桶(全局游标会让后渲染的组件读到前一个组件的 state);
 * children 同时放进 props(React 真实语义);Fragment 用同款 symbol。
 */
const stateStore = new Map()
let compStack = [{ id: 'root', cursor: 0 }]
let occurrences = new Map()
let effects = []
let cleanups = []
let dirty = false

const top = () => compStack[compStack.length - 1]
function slot() {
  const frame = top()
  const key = `${frame.id}:${frame.cursor}`
  frame.cursor += 1
  return key
}

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

const Fragment = Symbol.for('react.fragment')

const React = {
  createElement,
  Fragment,
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
  useEffect(fn) { effects.push(fn); return undefined },
  useRef(initial) {
    const key = slot()
    if (!stateStore.has(key)) stateStore.set(key, { current: initial })
    return stateStore.get(key)
  },
}

/* ---------------- 假浏览器环境 ---------------- */
const styleNodes = []
const localStorageData = new Map()

export async function boot() {
  let moduleApi = null
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    localStorage: {
      getItem: (k) => localStorageData.get(k) ?? null,
      setItem: (k, v) => localStorageData.set(k, v),
      removeItem: (k) => localStorageData.delete(k),
    },
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
  globalThis.document = {
    createElement() { return { id: '', textContent: '', remove() {} } },
    head: { appendChild(node) { styleNodes.push(node) }, removeChild() {} },
    getElementById(id) { return styleNodes.find((n) => n.id === id) ?? null },
    addEventListener() {},
    removeEventListener() {},
  }

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
  }
  const ctxEffects = []
  const clientCtx = {
    get(key) {
      if (key === 'slots') return slots
      if (key === 'locale') return locale
      return undefined
    },
    effect(setup, _name) {
      const cleanup = setup()
      if (typeof cleanup === 'function') ctxEffects.push(cleanup)
      return cleanup
    },
  }

  void apply(null) // host 半 apply() 是空函数,跑一下不抛错即可
  await import('./client.js')
  if (!moduleApi) throw new Error('client.js 没有调用 window.__ModuleLoader__.load')
  moduleApi.apply(clientCtx)
  if (styleNodes.length === 0) throw new Error('client.js 没有注入样式')
  const page = slots.captured.find((c) => c.entry.name === 'main')
  if (!page) throw new Error('client.js 没有注册 main 页面插槽')

  return {
    parts: moduleApi.__parts,
    slots,
    styleNodes,
    localStorageData,
    ctxEffects,
    page,
  }
}

export function renderOnce(renderFn, props) {
  // React 语义:上一轮 effect 的 cleanup 在本轮 effect 之前执行
  for (const cleanup of cleanups) {
    try { cleanup() } catch { /* ignore */ }
  }
  cleanups = []
  compStack = [{ id: 'root', cursor: 0 }]
  occurrences = new Map()
  effects = []
  dirty = false
  const tree = expand(createElement(renderFn, { ...props }))
  const pending = []
  for (const effect of effects) {
    const result = effect()
    if (result && typeof result.then === 'function') pending.push(result)
    else if (typeof result === 'function') cleanups.push(result)
  }
  return { tree, pending }
}

/** 反复渲染直到 state 稳定;期间触发的 setState 会标 dirty。 */
export async function settle(renderFn, props = {}, passes = 12) {
  let tree = null
  let stable = 0
  for (let i = 0; i < passes; i += 1) {
    const out = renderOnce(renderFn, props)
    tree = out.tree
    await Promise.all(out.pending)
    if (!dirty) stable += 1
    if (stable >= 2 && i >= 2) break
  }
  return tree
}

export function expand(node) {
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
  walk(node, (el) => {
    if (typeof el === 'string' || typeof el === 'number') { text.push(String(el)); return }
    if (typeof el !== 'object') return
    const cls = el.props?.className
    if (typeof cls === 'string') classes.push(...cls.split(/\s+/).filter(Boolean))
    if (el.props?.placeholder) text.push(el.props.placeholder)
  })
  return { text: text.join(' | '), classes: classes.join(' | ') }
}

/** 找 className 整词匹配 + 文本匹配的节点(labelFn 可对收集到的文本做自定义断言)。 */
export function findButtons(tree, { cls, text, labelFn }) {
  const hits = []
  walk(tree, (el) => {
    if (typeof el !== 'object' || el === null) return
    const c = String(el.props?.className ?? '')
    if (cls && !c.split(/\s+/).includes(cls)) return
    const label = collect({ children: el.children ?? [] }).text
    if (text && !label.includes(text)) return
    if (labelFn && !labelFn(label)) return
    hits.push(el)
  })
  return hits
}
