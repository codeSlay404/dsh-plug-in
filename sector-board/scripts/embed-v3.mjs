#!/usr/bin/env node
/**
 * Rebuild the inline v3 preview embedded in client.js.
 *
 * The panel has to work without a Host restart, so the preview is shipped as
 * one self-contained HTML document in client.js. Keep this script in sync with
 * docs/ui-v3.html + docs/assets/ui-v3.{css,js}. The embedded page contains no
 * demo data; it reads the Host API at runtime.
 *
 * Run: node scripts/embed-v3.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'

const ROOT = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8')

function buildHtml() {
  const css = read('docs/assets/ui-v3.css')
  const js = read('docs/assets/ui-v3.js')
  const universe = read('docs/assets/universe-data.js')
  let html = read('docs/ui-v3.html')

  // Function replacements are required: a string replacement treats `$$` as
  // an escaped `$`, which would silently corrupt the embedded JavaScript.
  html = html.replace('<link rel="stylesheet" href="assets/ui-v3.css">', () => `<style>\n${css}\n</style>`)
  html = html.replace('<script src="assets/universe-data.js"></script>', () => `<script>\n${universe}\n</script>`)
  html = html.replace('<script src="assets/ui-v3.js"></script>', () => `<script>\n${js}\n</script>`)
  return html.replace('页面为静态原型', '页面为嵌入预览')
}

const html = buildHtml()
const b64 = Buffer.from(html, 'utf8').toString('base64')
const clientPath = new URL('client.js', ROOT)
let client = readFileSync(clientPath, 'utf8')
if (!client.includes("const V3_PREVIEW_B64 = '")) throw new Error('client.js: V3_PREVIEW_B64 not found')
client = client.replace(/const V3_PREVIEW_B64 = '[^']*'/, () => `const V3_PREVIEW_B64 = '${b64}'`)
writeFileSync(clientPath, client)
console.log(`embedded ${html.length} chars (${b64.length} base64) -> client.js ${client.length} chars`)
