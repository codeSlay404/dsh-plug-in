/**
 * Host half of the Superagent bundle.
 *
 * Owns exactly one persistent "orchestrator" Session and exposes it to the Web
 * panel as same-origin JSON. The Client half (client.js) only renders and polls.
 *
 * Routes:
 *   GET  /api/superagent/state   -> { sessionId, running, messages, tasks, workers, waiting, ... }
 *   POST /api/superagent/send    -> { text } -> { ok, sessionId }
 *   POST /api/superagent/cancel  -> stop the running turn (and its workers)
 *   POST /api/superagent/reset   -> detach from the current session (the old one stays in history)
 *   GET  /api/superagent/models  -> grouped model catalog
 *   POST /api/superagent/model   -> { provider, model, reasoningEffort? }
 */
import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { guardOptions, isTrustedRequest } from './guard.js'

export const name = 'dsh-superagent'
export const inject = ['webServer', 'sessionController']

/** The first user message of a fresh orchestrator session carries this marker, and is hidden in the panel. */
const BOOT_PREFIX = 'SUPERAGENT // 引导'

const BOOT_TEXT = `${BOOT_PREFIX}

你是用户的「Superagent」，运行在 DeepSeek Harness 网页左上角的小面板里，是这个用户身边的小团队负责人。
你不是一个人在干活：你负责理解和拆解，把具体执行派给 worker 会话。

工作方式：
1. 先判断要不要动手。简单问题直接回答，不必强行派活。
2. 需要做事的，先用 todo_write 写一份 2~5 步的计划（面板上会显示成任务条，做完一步就更新一次）。
3. 有两件以上互相独立的工作时，用 subagent 并行派多个 worker；只有一件事就直接 subagent。派活时把背景、目标、验收标准写进 subagent 的 prompt —— worker 看不到你这里的对话。
4. 需要跟进时用 send_message / wait_agent，不要反复轮询。
5. 不要用 ask_user_question：面板里那个问题只显示成一个工具名，用户很可能看不到。需要用户拍板时，直接在回复正文里问，等用户下一条消息。

回复风格：
- 用用户的语言，3~6 行，先给结论，再给「已派出 / 进行中 / 完成」的状态。
- 纯文本，不要用 Markdown：面板不渲染加粗、代码块和表格，星号、反引号、竖线会原样显示。列表用「·」或短横线，不要用表格。
- 面板空间小，不要贴大段代码、长日志或长篇解释；细节留在 worker 会话里，用户点 ↗ 可以看你的完整会话。
- 不要向用户重复解释你这套工作方式。`

const MAX_SEEN_MESSAGES = 120
const VISIBLE_MESSAGES = 60
const MAX_TEXT = 8000
const MAX_WORKERS = 6

export function apply(ctx) {
  const ctl = ctx.sessionController
  const root = process.env.DSH_SUPERAGENT_HOME || join(homedir(), '.dsh', 'superagent')
  const fallbackWorkspace = join(root, 'workspace')
  const stateFile = join(root, 'state.json')

  /**
   * @type {{
   *   sessionId: string | null,
   *   booted: boolean,
   *   cwd: string | null,
   *   model: { provider: string, model: string, reasoningEffort?: string } | null,
   * }}
   */
  const record = { sessionId: null, booted: false, cwd: null, model: null }
  let loaded = null
  let creating = null
  let saving = Promise.resolve()
  /** Model catalog is a provider round-trip; keep the panel snappy across openings. */
  let catalogCache = { at: 0, value: null }
  /** Worker statuses come from one sessionController.state call per worker; poll slower than the panel. */
  let workerCache = { at: 0, sig: '', value: [] }

  /* ---------------- persistence ---------------- */

  function load() {
    loaded ??= (async () => {
      try {
        const parsed = JSON.parse(await readFile(stateFile, 'utf8'))
        if (parsed && typeof parsed.sessionId === 'string' && parsed.sessionId) record.sessionId = parsed.sessionId
        if (parsed && parsed.booted === true) record.booted = true
        if (parsed && typeof parsed.cwd === 'string' && parsed.cwd) record.cwd = parsed.cwd
        const model = parsed && parsed.model
        if (model && typeof model.provider === 'string' && typeof model.model === 'string') {
          record.model = {
            provider: model.provider,
            model: model.model,
            ...(typeof model.reasoningEffort === 'string' ? { reasoningEffort: model.reasoningEffort } : {}),
          }
        }
      } catch {
        /* first run */
      }
    })()
    return loaded
  }

  function save() {
    const snapshot = JSON.stringify(
      { sessionId: record.sessionId, booted: record.booted, cwd: record.cwd, model: record.model },
      null,
      2,
    )
    saving = saving
      .then(async () => {
        await mkdir(root, { recursive: true })
        await writeFile(stateFile, snapshot, 'utf8')
      })
      .catch(() => {})
    return saving
  }

  /* ---------------- workspace ---------------- */

  function usableDir(path) {
    if (typeof path !== 'string' || !path) return false
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  }

  /**
   * Where a fresh orchestrator Session (and therefore its workers) should run.
   *
   * The panel has no session binding, so "the user's current workspace" is
   * approximated by the most recently used session that is not one of ours.
   * Resolved once and remembered, so a later `新对话` keeps the same place.
   */
  async function resolveCwd(signal) {
    if (record.cwd) return record.cwd
    const fromEnv = process.env.DSH_SUPERAGENT_CWD
    if (fromEnv) {
      record.cwd = fromEnv
      await save()
      return fromEnv
    }
    try {
      const page = await ctl.list({}, signal)
      const items = (page && Array.isArray(page.items) && page.items) || []
      const candidate = items
        .filter((item) => item && typeof item.cwd === 'string' && item.cwd && !item.cwd.startsWith(root))
        .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
        .find((item) => usableDir(item.cwd))
      if (candidate) {
        record.cwd = candidate.cwd
        await save()
        return candidate.cwd
      }
    } catch {
      /* fall through to the dedicated directory */
    }
    return fallbackWorkspace
  }

  /* ---------------- session ---------------- */

  async function ensureSession(signal) {
    await load()
    if (record.sessionId) {
      try {
        await ctl.state({ sessionId: record.sessionId }, signal)
        return record.sessionId
      } catch {
        // Stale id (profile reset, deleted session): fall through and create a new one.
        record.sessionId = null
        record.booted = false
      }
    }
    if (creating === null) {
      creating = (async () => {
        const cwd = await resolveCwd(signal)
        await mkdir(cwd, { recursive: true })
        const created = await ctl.create({ cwd })
        record.sessionId = created.sessionId
        record.booted = false
        if (record.model) {
          // A saved route may have disappeared (key removed, provider offline); the
          // panel still works on the deployment default when that happens.
          try {
            await ctl.selectModel({ sessionId: created.sessionId, ...record.model })
          } catch {
            /* keep the deployment default */
          }
        }
        await save()
        return created.sessionId
      })().finally(() => {
        creating = null
      })
    }
    return creating
  }

  /** Read the provider-grouped model catalog, memoized for a minute. */
  async function getCatalog() {
    if (catalogCache.value && Date.now() - catalogCache.at < 60_000) return catalogCache.value
    const catalog = await ctl.modelCatalog()
    catalogCache = { at: Date.now(), value: catalog }
    return catalog
  }

  /** Select a Session-local model and remember it for the next Session this panel creates. */
  async function selectModel(request) {
    const provider = typeof request.provider === 'string' ? request.provider : ''
    const model = typeof request.model === 'string' ? request.model : ''
    if (!provider || !model) throw new Error('provider and model are required')
    const reasoningEffort = typeof request.reasoningEffort === 'string' && request.reasoningEffort ? request.reasoningEffort : undefined
    const sessionId = await ensureSession(new AbortController().signal)
    const value = await ctl.selectModel({
      sessionId,
      provider,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    })
    record.model = { ...value.selected }
    await save()
    return { sessionId, selected: value.selected }
  }

  async function send(text) {
    const signal = new AbortController().signal
    const sessionId = await ensureSession(signal)
    const first = !record.booted
    const body = first ? `${BOOT_TEXT}\n\n---\n\n用户任务：\n${text}` : text
    await ctl.prompt(
      {
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: body }],
      },
      signal,
    )
    if (first) {
      record.booted = true
      await save()
    }
    return sessionId
  }

  /* ---------------- transcript ---------------- */

  function textOf(blocks) {
    if (!Array.isArray(blocks)) return ''
    return blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim()
  }

  function toolsOf(blocks) {
    if (!Array.isArray(blocks)) return []
    const names = []
    for (const b of blocks) {
      if (b && b.type === 'tool-call' && typeof b.name === 'string' && names.indexOf(b.name) === -1) names.push(b.name)
    }
    return names
  }

  /**
   * One row per turn instead of one row per step: a single `assistant/message`
   * event is emitted for every model call, so a long task would otherwise fill
   * the panel with dozens of rows that only carry a tool name.
   */
  function collectMessages(records) {
    const out = []
    const seen = new Set()
    for (const entry of records || []) {
      const ev = entry && entry.type === 'event' ? entry.event : null
      if (!ev || typeof ev.type !== 'string') continue
      if (ev.type === 'user/message') {
        const data = ev.data
        if (!data) continue
        // Only real user input. DSH and plugins also inject runtime context, skill
        // catalogs, recall notes and time snapshots as `user/message` events; their
        // `source.kind` is the injector, so anything but 'user' is chrome, not chat.
        if (data.source && typeof data.source.kind === 'string' && data.source.kind !== 'user') continue
        const key = typeof data.id === 'string' ? `u:${data.id}` : `u:${ev.seq}`
        if (seen.has(key)) continue
        seen.add(key)
        const text = textOf(data.content)
        if (!text || text.startsWith(BOOT_PREFIX)) continue
        out.push({ id: key, role: 'user', text, tools: [], steps: 0, turn: null, time: ev.time || 0 })
      } else if (ev.type === 'assistant/message') {
        const data = ev.data
        const message = data && data.message
        if (!message) continue
        const key = typeof message.id === 'string' ? `a:${message.id}` : `a:${ev.seq}`
        if (seen.has(key)) continue
        seen.add(key)
        const text = textOf(message.content)
        const tools = toolsOf(message.content)
        const turn = typeof data.turn === 'number' ? data.turn : null
        const prev = out[out.length - 1]
        if (prev && prev.role === 'assistant' && turn !== null && prev.turn === turn) {
          prev.steps += 1
          if (text) prev.text = prev.text ? `${prev.text}\n\n${text}` : text
          for (const name of tools) if (prev.tools.indexOf(name) === -1) prev.tools.push(name)
          prev.time = ev.time || prev.time
          continue
        }
        if (!text && tools.length === 0) continue
        out.push({ id: key, role: 'assistant', text, tools, steps: 1, turn, time: ev.time || 0 })
      }
    }
    return out.slice(-VISIBLE_MESSAGES).map((message) => ({ ...message, tools: message.tools.slice(0, 8) }))
  }

  function collectTodos(records) {
    let latest = null
    let at = 0
    for (const entry of records || []) {
      const ev = entry && entry.type === 'event' ? entry.event : null
      if (ev && ev.type === 'todo/write' && ev.data && Array.isArray(ev.data.todos)) {
        latest = ev.data.todos
        at = Number(ev.time) || 0
      }
    }
    if (!latest) return { todos: [], at: 0 }
    return {
      at,
      todos: latest
        .filter((todo) => todo && typeof todo.content === 'string' && todo.content)
        .slice(0, 12)
        .map((todo, index) => ({
          id: `todo-${index}`,
          subject: String(todo.content).slice(0, 120),
          status: todo.status === 'in_progress' || todo.status === 'completed' ? todo.status : 'pending',
          source: 'todo',
        })),
    }
  }

  function collectTeamTasks(projection) {
    const values = projection && projection.values
    const team = values && values.agentTeam
    if (!team || !Array.isArray(team.tasks)) return []
    return team.tasks
      .filter((t) => t && t.status !== 'deleted')
      .slice(0, 12)
      .map((t) => ({
        id: String(t.id || ''),
        subject: String(t.subject || '').slice(0, 120),
        status: String(t.status || 'pending'),
        source: 'team',
      }))
  }

  /**
   * Workers come from the `subagentCatalog` projection; their live state needs
   * one sessionController.state call each, so results are cached for a few
   * seconds and only the newest few are tracked.
   */
  async function readWorkers(values, signal) {
    const catalog = values && Array.isArray(values.subagentCatalog) ? values.subagentCatalog : []
    if (catalog.length === 0) return []
    const picked = catalog.slice(-MAX_WORKERS).reverse()
    const sig = picked.map((child) => `${child.id}:${child.createdAt || 0}`).join(',')
    const now = Date.now()
    if (sig === workerCache.sig && now - workerCache.at < 4000) return workerCache.value

    const workers = await Promise.all(
      picked.map(async (child) => {
        const worker = {
          id: String(child.id || ''),
          label: String(child.label || child.name || '').slice(0, 80),
          mode: String(child.mode || ''),
          createdAt: Number(child.createdAt) || 0,
          status: 'unknown',
        }
        try {
          const state = await ctl.state({ sessionId: worker.id }, signal)
          worker.status = state && state.running ? 'running' : state && state.active ? 'idle' : 'ended'
        } catch {
          worker.status = 'ended'
        }
        return worker
      }),
    )
    const ordered = workers.sort((a, b) => {
      const rank = (w) => (w.status === 'running' ? 0 : w.status === 'idle' ? 1 : 2)
      return rank(a) - rank(b) || b.createdAt - a.createdAt
    })
    workerCache = { at: now, sig, value: ordered }
    return ordered
  }

  function activeQuestions(values) {
    const q = values && values.userQuestions
    const active = q && Array.isArray(q.active) ? q.active : []
    return active
      .map((item) => {
        const first = item && Array.isArray(item.questions) ? item.questions[0] : null
        return first && typeof first.question === 'string' ? first.question : ''
      })
      .filter(Boolean)
      .slice(0, 2)
  }

  /** The question text of the newest ask_user_question call, for the waiting banner. */
  function pendingQuestionText(records) {
    for (let index = (records || []).length - 1; index >= 0; index -= 1) {
      const entry = records[index]
      const ev = entry && entry.type === 'event' ? entry.event : null
      if (!ev || ev.type !== 'tool/call') continue
      const data = ev.data
      if (!data || data.name !== 'ask_user_question') continue
      try {
        const args = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments
        const first = args && Array.isArray(args.questions) ? args.questions[0] : null
        return first && typeof first.question === 'string' ? first.question : ''
      } catch {
        return ''
      }
    }
    return ''
  }

  async function readState() {
    await load()
    const signal = new AbortController().signal
    const cwd = await resolveCwd(signal).catch(() => record.cwd || fallbackWorkspace)
    const base = {
      sessionId: record.sessionId,
      running: false,
      active: false,
      waiting: false,
      questions: [],
      booted: record.booted,
      model: record.model,
      messages: [],
      tasks: [],
      workers: [],
      cwd,
    }
    if (!record.sessionId) return base

    let state
    try {
      state = await ctl.state({ sessionId: record.sessionId }, signal)
    } catch {
      record.sessionId = null
      record.booted = false
      await save()
      return base
    }

    const sessionId = record.sessionId
    const [page, projection] = await Promise.all([
      ctl
        .events({ address: { kind: 'session', sessionId }, maxMessages: MAX_SEEN_MESSAGES }, signal)
        .catch(() => null),
      ctl.projections({ sessionId }, signal).catch(() => null),
    ])

    const records = (page && page.records) || []
    const values = (projection && projection.values) || null
    const questions = activeQuestions(values)
    const pending = state && Array.isArray(state.pendingInput) ? state.pendingInput : []
    const waiting = questions.length > 0 || pending.length > 0
    if (waiting && questions.length === 0) {
      const text = pendingQuestionText(records)
      if (text) questions.push(text)
    }

    const messages = collectMessages(records)
    const lastUser = messages.reduce((at, message) => (message.role === 'user' ? Math.max(at, message.time) : at), 0)
    const todoState = collectTodos(records)
    // A finished plan from the previous request should not look like the current
    // plan: keep it only while something is in progress, or when it belongs to
    // this turn.
    const keepTodos =
      todoState.todos.length > 0 && (todoState.at >= lastUser || todoState.todos.some((t) => t.status === 'in_progress'))

    return {
      sessionId,
      running: Boolean(state && state.running),
      active: Boolean(state && state.active),
      queue: state && Array.isArray(state.queue) ? state.queue.length : 0,
      pendingInput: pending,
      waiting,
      questions,
      booted: record.booted,
      model: record.model,
      messages,
      tasks: keepTodos ? todoState.todos : collectTeamTasks(projection),
      workers: await readWorkers(values, signal).catch(() => []),
      cwd,
    }
  }

  /* ---------------- HTTP ---------------- */

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

  /** Stop the lead turn and any worker that is still running, so "停止" means stopped. */
  async function stopEverything() {
    if (!record.sessionId) return
    const signal = new AbortController().signal
    try {
      const state = await ctl.state({ sessionId: record.sessionId }, signal)
      if (state && state.running) await ctl.cancel({ sessionId: record.sessionId })
    } catch {
      /* already gone */
    }
    const projection = await ctl.projections({ sessionId: record.sessionId }, signal).catch(() => null)
    const catalog = projection && projection.values && projection.values.subagentCatalog
    if (!Array.isArray(catalog)) return
    await Promise.all(
      catalog.slice(-MAX_WORKERS).map(async (child) => {
        if (!child || !child.id) return
        try {
          const state = await ctl.state({ sessionId: child.id }, signal)
          if (state && state.running) await ctl.cancel({ sessionId: child.id })
        } catch {
          /* best effort */
        }
      }),
    )
    workerCache = { at: 0, sig: '', value: [] }
  }

  /* ---------------- live stream ---------------- */

  /** Durable session events worth waking the panel for; payloads stay on the state route. */
  const STREAM_EVENTS = new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result', 'turn/start', 'turn/end'])
  const openStreams = new Set()

  function sseWrite(res, event, payload) {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
      return true
    } catch {
      return false
    }
  }

  /**
   * Follow the lead session and push assistant text deltas over SSE.
   * The client keeps a slow state poll for structure and this stream for typing.
   */
  async function streamSession(req, res, sessionId) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write('retry: 2000\n\n')

    const controller = new AbortController()
    openStreams.add(controller)
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      openStreams.delete(controller)
      controller.abort()
      try {
        res.end()
      } catch {
        /* already gone */
      }
    }
    req.on('close', close)
    req.on('error', close)
    const heartbeat = setInterval(() => {
      if (closed) return
      try {
        res.write(': ping\n\n')
      } catch {
        close()
      }
    }, 15000)
    heartbeat.unref?.()

    try {
      const frames = ctl.follow(
        { address: { kind: 'session', sessionId }, assistantStream: true, maxMessages: 40 },
        controller.signal,
      )
      for await (const frame of frames) {
        if (closed) break
        if (frame.type === 'snapshot') {
          sseWrite(res, 'snapshot', { cursor: frame.cursor })
          continue
        }
        if (frame.type === 'assistant-stream') {
          const inner = frame.frame
          if (inner && inner.type === 'chunk' && inner.chunk && inner.chunk.type === 'text-delta') {
            const text = inner.chunk.text
            if (typeof text === 'string' && text) sseWrite(res, 'delta', { text })
          } else if (inner && inner.type === 'end') {
            sseWrite(res, 'turn', { done: true })
          }
          continue
        }
        if (frame.type === 'event') {
          const event = frame.event
          if (!event || !STREAM_EVENTS.has(event.type)) continue
          sseWrite(res, 'event', { type: event.type, seq: event.seq, time: event.time })
        }
      }
    } catch (err) {
      if (!closed) sseWrite(res, 'error', { message: String((err && err.message) || err).slice(0, 300) })
    } finally {
      clearInterval(heartbeat)
      close()
    }
  }

  const routes = [
    {
      path: '/api/superagent/stream',
      handler: async (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        const url = new URL(req.url || '/', 'http://localhost')
        const sessionId = url.searchParams.get('session') || record.sessionId
        if (!sessionId) return json(res, 400, { error: 'no session yet' })
        try {
          await streamSession(req, res, sessionId)
        } catch (err) {
          if (!res.headersSent) json(res, 500, { error: String((err && err.message) || err) })
        }
      },
    },
    {
      path: '/api/superagent/state',
      handler: async (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        try {
          return json(res, 200, await readState())
        } catch (err) {
          return json(res, 500, { error: String((err && err.message) || err) })
        }
      },
    },
    {
      path: '/api/superagent/send',
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        const body = await readJson(req)
        const text = typeof body.text === 'string' ? body.text.trim().slice(0, MAX_TEXT) : ''
        if (!text) return json(res, 400, { error: 'empty text' })
        try {
          const sessionId = await send(text)
          return json(res, 200, { ok: true, sessionId })
        } catch (err) {
          return json(res, 500, { error: String((err && err.message) || err) })
        }
      },
    },
    {
      path: '/api/superagent/cancel',
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        try {
          await stopEverything()
          return json(res, 200, { ok: true })
        } catch (err) {
          return json(res, 500, { error: String((err && err.message) || err) })
        }
      },
    },
    {
      path: '/api/superagent/models',
      handler: async (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        try {
          const catalog = await getCatalog()
          return json(res, 200, { current: record.model, default: catalog.default, groups: catalog.groups, failures: catalog.failures })
        } catch (err) {
          return json(res, 500, { error: String((err && err.message) || err) })
        }
      },
    },
    {
      path: '/api/superagent/model',
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        const body = await readJson(req)
        try {
          const result = await selectModel(body)
          return json(res, 200, { ok: true, ...result })
        } catch (err) {
          return json(res, 400, { error: String((err && err.message) || err) })
        }
      },
    },
    {
      path: '/api/superagent/reset',
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        try {
          await stopEverything().catch(() => {})
          record.sessionId = null
          record.booted = false
          await save()
          return json(res, 200, { ok: true })
        } catch (err) {
          return json(res, 500, { error: String((err && err.message) || err) })
        }
      },
    },
  ]

  ctx.effect(() => {
    // 浏览器信任闸门（同官方 api-request-trust）：7 条路由一律先过闸门，
    // /stream 与 /send 尤其重要——它们能驱动 lead 跑任意命令。
    const guardOpts = guardOptions(ctx)
    const guarded = (handler) => (req, res) => {
      if (!isTrustedRequest(req, guardOpts)) return json(res, 403, { error: 'forbidden' })
      return handler(req, res)
    }
    const disposers = routes.map((route) =>
      ctx.webServer.register({ kind: 'exact', path: route.path, handler: guarded(route.handler) }),
    )
    return () => {
      for (const controller of openStreams) {
        try {
          controller.abort()
        } catch {
          /* best effort */
        }
      }
      openStreams.clear()
      for (const disposer of disposers) {
        try {
          if (typeof disposer === 'function') disposer()
          else if (disposer && typeof disposer.dispose === 'function') disposer.dispose()
          else if (disposer && typeof disposer === 'object' && typeof disposer[Symbol.dispose] === 'function') disposer[Symbol.dispose]()
        } catch {
          /* best effort */
        }
      }
    }
  }, 'superagent: web routes')
}
