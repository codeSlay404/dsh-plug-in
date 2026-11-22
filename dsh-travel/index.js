/**
 * Host half of dsh-travel.
 *
 * One-shot "AI 帮找" search: when the static 40-destination list has nothing
 * for a query, the Client POSTs {q, season, months} here and we run a single
 * streaming model call with the user's default model, parsing the reply into
 * dest-shaped cards (same shape as client.js DESTS). SSE so the intro text
 * types out live in the panel.
 *
 *   POST /api/travel/ai  { q, season, months }  ->  SSE
 *     event: status {q}
 *     event: delta  {text}          (raw model text, client shows intro live)
 *     event: done   {intro, items}  (items already sanitized to DEST shape)
 *     event: error  {message}
 */

import { guardOptions, isTrustedRequest } from './guard.js'
export const name = 'dsh-travel'
export const inject = ['webServer', 'llm', 'agentDefaultModel']

const ROUTE = '/api/travel/ai'
const MAX_Q = 40
const TIMEOUT_MS = 90_000
const CACHE_MAX = 60

/** In-memory answer cache: `${season}|${months}|${q}` -> payload. */
const cache = new Map()

const KIND_WORDS = ['花', '海', '雪', '山', '草原', '古村', '人文', '美食', '摄影', '星空', '温泉', '徒步', '玩水', '骑行', '避暑', '反季', '户外', '森林']

const SEASON_ZH = { spring: '春季', summer: '夏季', autumn: '秋季', winter: '冬季' }

function systemPrompt(season, months) {
  const szh = SEASON_ZH[season] ?? '四季'
  const mz = months.length > 0 ? months.map((m) => `${m}月`).join('、') : '整个季节'
  return [
    '你是一位懂行的国内旅行向导。用户会给你一个地点(可能是小城市、区县,甚至搜索引擎上资料很少的地方)。',
    '请回答:在这个时间(当前季节/月份),这里有什么真正好玩的事 —— 不只是景点,更要给"怎么玩":吃喝、市集、夜生活、室内备选、亲子、小众路线都算。',
    '要求:',
    `1. 先写 1-2 句导语:这时候(${szh},约 ${mz})去这里值不值、主打玩什么。诚实:如果确实不是最佳季节,直说,并给出该季节下的替代玩法。`,
    '2. 导语之后,输出一个 ```json 代码块,内容是一个 JSON 数组,3 到 5 个对象。每个对象字段:',
    '   name: 地点主体名(如 "廊坊·御龙河公园",老城/区县可写子地点);',
    '   region: 省/市,如 "河北廊坊";',
    '   tagline: 一句话说明为什么去、什么感觉;',
    `   kinds: 从这个词表里选 2-3 个:${KIND_WORDS.join(',')};`,
    '   x: 3-4 个"最好玩的事"数组,每项 {e: 一个emoji, n: 事情名, w: 建议时长(如"2小时"、"半天"), d: 一句话怎么玩};',
    '   f: 2-4 个必吃/必带,字符串数组;',
    '   t: 1-3 条贴士(交通、时段、避坑),字符串数组。',
    '3. 导语和代码块之外,不要输出任何其他内容。不要输出表格。JSON 必须合法,不要注释、不要尾逗号。',
  ].join('\n')
}

/* ---------------- HTTP helpers ---------------- */

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

function sseWrite(res, event, payload) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
    return true
  } catch {
    return false
  }
}

/* ---------------- reply parsing ---------------- */

/** Pull the fenced (or bare) JSON array out of the model text; return [intro, items] or null. */
export function splitReply(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = fence ? fence[1] : null
  const source = raw ?? text
  const start = source.indexOf('[')
  const end = source.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) return null
  const body = source.slice(start, end + 1)
  for (const candidate of [body, body.replace(/,\s*([}\]])/g, '$1')]) {
    try {
      const parsed = JSON.parse(candidate)
      if (Array.isArray(parsed)) {
        const intro = (raw ? text.slice(0, text.indexOf('```')) : text.slice(0, start)).trim()
        return [intro, parsed]
      }
    } catch { /* try next */ }
  }
  return null
}

function str(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

/** Force an arbitrary parsed object into the dest shape the client renders. */
export function toDest(raw, i, season, months) {
  if (!raw || typeof raw !== 'object') return null
  const name = str(raw.name, 40)
  if (!name) return null
  const kinds = (Array.isArray(raw.kinds) ? raw.kinds : [])
    .map((k) => str(k, 6)).filter((k) => KIND_WORDS.includes(k)).slice(0, 3)
  const x = (Array.isArray(raw.x) ? raw.x : [])
    .map((e) => ({
      e: str(e && e.e, 4) || '🎯',
      n: str(e && e.n, 30),
      w: str(e && e.w, 12) || '半天',
      d: str(e && e.d, 90),
    }))
    .filter((e) => e.n)
    .slice(0, 4)
  const f = (Array.isArray(raw.f) ? raw.f : []).map((v) => str(v, 20)).filter(Boolean).slice(0, 4)
  const t = (Array.isArray(raw.t) ? raw.t : []).map((v) => str(v, 80)).filter(Boolean).slice(0, 3)
  if (x.length === 0) return null
  return {
    id: `ai-${season}-${i}-${name.replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 24)}`,
    name, region: str(raw.region, 20) || 'AI 推荐',
    season, months: [...months],
    tagline: str(raw.tagline, 80) || '来自 AI 的推荐',
    kinds: kinds.length > 0 ? kinds : ['人文'],
    x, f, t,
  }
}

/* ---------------- apply ---------------- */

export function apply(ctx) {
  if (!ctx) return // 离线冒烟只 import 纯函数
  const llm = ctx.llm
  const adm = ctx.agentDefaultModel
  const guardOpts = guardOptions(ctx)
  // 超时可注入：线上默认 90s，冒烟用 ctx.config.timeoutMs / TRAVEL_TIMEOUT_MS 缩短。
  const timeoutMs = Number(ctx?.config?.timeoutMs) > 0
    ? Number(ctx.config.timeoutMs)
    : Number(process.env.TRAVEL_TIMEOUT_MS) > 0 ? Number(process.env.TRAVEL_TIMEOUT_MS) : TIMEOUT_MS

  ctx.effect(() => {
    const disposer = ctx.webServer.register({
      kind: 'exact',
      path: ROUTE,
      handler: async (req, res) => {
        // 浏览器信任闸门（同官方 api-request-trust）：跨站页面 / DNS rebinding 进不来。
        if (!isTrustedRequest(req, guardOpts)) return json(res, 403, { error: 'forbidden' })
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        const body = await readJson(req)
        const q = typeof body.q === 'string' ? body.q.trim().slice(0, MAX_Q) : ''
        const season = SEASON_ZH[body.season] ? body.season : 'spring'
        const months = Array.isArray(body.months)
          ? body.months.filter((m) => Number.isInteger(m) && m >= 1 && m <= 12).slice(0, 6)
          : []
        if (!q) return json(res, 400, { error: 'empty q' })

        const key = `${season}|${months.join(',')}|${q.toLowerCase()}`
        const hit = cache.get(key)
        if (hit) {
          // 同一个 (q, season, months) 再问一次时，以前回 JSON —— 而客户端只解析 SSE，
          // 于是切 tab 回来 / 点重新生成都会永久转圈。现在与流式成功同形，客户端零特判。
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            'connection': 'keep-alive',
          })
          sseWrite(res, 'status', { q })
          sseWrite(res, 'done', { ...hit, cached: true })
          try { res.end() } catch { /* already gone */ }
          return
        }

        let selection
        try {
          selection = adm.currentSelection()
        } catch (err) {
          return json(res, 500, { error: `默认模型不可用:${err && err.message ? err.message : err}` })
        }
        if (!selection || !selection.provider || !selection.model) {
          return json(res, 500, { error: '默认模型不可用:未配置模型' })
        }

        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          'connection': 'keep-alive',
        })
        sseWrite(res, 'status', { q })

        const abort = new AbortController()
        // 客户端走了（写完了也算）就别再发帧；res.on('close') 在正常 end() 后也会触发，
        // 不能拿它当「用户断开」，否则超时帧会和正常结束互相踩。
        const clientGone = () => res.writableEnded === true || res.writable === false
        let timedOut = false
        res.on('close', () => {
          if (timedOut || res.writableEnded) return
          try { abort.abort() } catch { /* gone */ }
        })
        const timer = setTimeout(() => {
          timedOut = true
          try { abort.abort() } catch { /* gone */ }
        }, timeoutMs)
        const timeoutMessage = `模型 ${Math.round(timeoutMs / 1000)} 秒没有响应，请重试`

        try {
          let text = ''
          let finish = null
          const options = {
            ...selection,
            system: systemPrompt(season, months),
            messages: [{ role: 'user', content: [{ type: 'text', text: `地点:${q}` }] }],
            temperature: 0.8,
            maxTokens: 2400,
            signal: abort.signal,
          }
          for await (const chunk of llm.stream(options)) {
            if (abort.signal.aborted) break
            if (chunk.type === 'text-delta') {
              text += chunk.text
              sseWrite(res, 'delta', { text: chunk.text })
            } else if (chunk.type === 'finish') {
              finish = chunk.reason
            }
          }

          if (abort.signal.aborted) {
            // 走到这里说明流是「正常 break」的；客户端已走就静默，超时就给终止帧。
            if (timedOut && !clientGone()) sseWrite(res, 'error', { message: timeoutMessage })
            return
          }
          const kind = finish && finish.kind
          if (kind === 'error' || kind === 'aborted') {
            const msg = (finish.failure && finish.failure.message) || '模型调用失败'
            sseWrite(res, 'error', { message: String(msg).slice(0, 200) })
            return
          }
          const split = splitReply(text)
          if (!split) {
            sseWrite(res, 'error', { message: 'AI 没有给出可用的推荐,换个说法再试试。' })
            return
          }
          const [intro, raws] = split
          const items = raws.map((r, i) => toDest(r, i, season, months)).filter(Boolean).slice(0, 5)
          if (items.length === 0) {
            sseWrite(res, 'error', { message: 'AI 给的推荐格式不对,换个说法再试试。' })
            return
          }
          const payload = { ok: true, intro: intro.slice(0, 200), items }
          cache.set(key, payload)
          if (cache.size > CACHE_MAX) {
            const first = cache.keys().next().value
            cache.delete(first)
          }
          sseWrite(res, 'done', payload)
        } catch (err) {
          if (abort.signal.aborted) {
            // abort 之后 llm.stream 多半是抛 AbortError 走到这里，这才是超时的主路径。
            if (timedOut && !clientGone()) sseWrite(res, 'error', { message: timeoutMessage })
          } else {
            sseWrite(res, 'error', { message: String(err && err.message ? err.message : err).slice(0, 200) })
          }
        } finally {
          clearTimeout(timer)
          try { res.end() } catch { /* already gone */ }
        }
      },
    })
    return () => {
      try {
        if (typeof disposer === 'function') disposer()
        else if (disposer && typeof disposer.dispose === 'function') disposer.dispose()
      } catch { /* best effort */ }
      cache.clear()
    }
  }, 'travel: ai search route')
}
