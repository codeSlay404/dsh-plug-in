// 离线冒烟：模拟 window.__ModuleLoader__ + React + ctx，验证 client.js
// 加载不抛错、返回 inject/apply、apply 注册侧栏入口 + 整页 + 设置分区。node smoke-client.mjs
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('./client.js', import.meta.url), 'utf8')

// 极简 React mock：只需要加载期被引用的顶层 API（组件函数体不在加载期执行）
const React = {
  createElement: (...args) => ({ __el: args }),
  useState: () => [null, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: () => ({ current: null }),
}

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(mod) {
      if (mod.id !== 'dsh-personal-memory') throw new Error('id 不对: ' + mod.id)
      captured = mod
    },
  },
  addEventListener() {},
  removeEventListener() {},
}
globalThis.document = {
  getElementById: () => ({}), // 已有样式节点 → 跳过插入
  createElement: () => ({}),
  head: { appendChild() {} },
}
globalThis.fetch = async () => { throw new Error('不应在加载期 fetch') }
globalThis.AbortSignal = globalThis.AbortSignal ?? { timeout: () => ({}) }
if (!globalThis.AbortSignal.timeout) globalThis.AbortSignal.timeout = () => ({})

// 执行 client.js（CommonJS 风格的 factory(require)）
const require = (name) => {
  if (name === 'react') return React
  throw new Error('意外的 require: ' + name)
}
new Function('window', 'document', 'fetch', 'require', 'AbortSignal', src)(
  globalThis.window, globalThis.document, globalThis.fetch, require, globalThis.AbortSignal,
)

if (!captured || typeof captured.factory !== 'function') throw new Error('client 没有 register module')
const mod = captured.factory(require)
if (!Array.isArray(mod.inject) || typeof mod.apply !== 'function') throw new Error('client 未导出 inject/apply')
console.log('client inject:', mod.inject.join(', '))

// 假 slots / locale / ctx，验证 apply 注册三个 slot
const registered = []
const effects = []
const slots = {
  register: (def) => { registered.push(def); return () => {} },
  inject: (key, cb) => { const eff = cb(); effects.push(key); return () => {} },
}
const ctx = {
  get: (name) => (name === 'slots' ? slots : name === 'locale' ? {
    register: () => () => {},
    bind: () => (k) => k,
  } : undefined),
  effect: (fn) => { fn(); return () => {} },
}
mod.apply(ctx)
console.log('slots injected:', effects.join(', '))
if (!effects.includes('sidebar.panellist')) throw new Error('缺 sidebar.panellist')
if (!effects.includes('main')) throw new Error('缺 main')
if (!effects.includes('settings.section')) throw new Error('缺 settings.section')
const main = registered.find((def) => def.name === 'main')
if (!main || main.key !== 'personal-memory') throw new Error('main 的 key 必须等于侧栏 id')
const entry = registered.find((def) => def.name === 'sidebar.panellist')
if (!entry || entry.id !== 'personal-memory') throw new Error('sidebar.panellist 的 id 不对')
console.log('client smoke: 全部通过 ✓')
