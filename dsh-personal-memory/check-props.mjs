// 预览专用 props 的直通自检：
// 症状是「截图里那块是空的」，但代码本身没错——错在 App 那层没把 props 转发下去。
// 这个脚本静态比对：子组件读了哪些 initialXxx，App 渲染它时有没有真的传下去。
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('./client.js', import.meta.url), 'utf8')

/** 取 `function Name(props) {` 起的一整段（按花括号配平） */
function blockOf(name) {
  const start = src.indexOf(`function ${name}(props) {`)
  if (start < 0) return null
  let depth = 0
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  return null
}

/** 组件里读到的预览 props */
function previewPropsRead(block) {
  const names = new Set()
  for (const m of block.matchAll(/\bprops\.(initial[A-Za-z0-9]+)\b/g)) names.add(m[1])
  for (const m of block.matchAll(/\b(?:const|let)\s*\{([^}]*)\}\s*=\s*props\b/g)) {
    for (const part of m[1].split(',')) {
      const key = part.split(':')[0].trim()
      if (/^initial[A-Z]/.test(key)) names.add(key)
    }
  }
  return [...names]
}

/** App 里 `h(Component, { … })` 传给它的键（按花括号配平取第一个参数对象） */
function propsPassedTo(component) {
  const keys = new Set()
  let from = 0
  for (;;) {
    const at = src.indexOf(`h(${component}, {`, from)
    if (at < 0) break
    let depth = 0
    let end = at
    for (let i = src.indexOf('{', at); i < src.length; i += 1) {
      if (src[i] === '{') depth += 1
      else if (src[i] === '}') {
        depth -= 1
        if (depth === 0) { end = i; break }
      }
    }
    const body = src.slice(src.indexOf('{', at), end + 1)
    for (const m of body.matchAll(/(?:^|[{,\s])([A-Za-z_$][\w$]*)\s*:/g)) keys.add(m[1])
    // 展开写法 {...props} 视为全量透传
    if (/\{\s*\.\.\.props\b/.test(body)) keys.add('*')
    from = end
  }
  return keys
}

const components = [...src.matchAll(/function ([A-Z][\w$]*)\(props\) \{/g)].map((m) => m[1])
const problems = []
for (const name of components) {
  if (name === 'App') continue
  const block = blockOf(name)
  if (!block) continue
  const wanted = previewPropsRead(block)
  if (wanted.length === 0) continue
  const passed = propsPassedTo(name)
  const missing = passed.has('*') ? [] : wanted.filter((key) => !passed.has(key))
  if (missing.length > 0) problems.push({ component: name, missing, passed: [...passed] })
}

if (problems.length === 0) {
  console.log(`props 直通自检：${components.length - 1} 个组件全部通过 ✓`)
} else {
  for (const item of problems) {
    console.log(`✗ ${item.component} 读了 ${item.missing.join(', ')}，但 App 渲染它时没传`)
  }
  console.log(`\nprops 直通自检：${problems.length} 个组件漏传 ✗`)
  process.exitCode = 1
}
