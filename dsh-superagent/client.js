/**
 * Client half of the Superagent bundle.
 *
 * A button in `conversation.header.leading` (top-left) toggles a floating card
 * in `shell.overlay`. The card only talks to the Host routes of this same
 * bundle (/api/superagent/*) — it never drives Sessions directly.
 */
window.__ModuleLoader__.load({
  id: 'dsh-superagent',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'superagent.panel'
    const STYLE_ID = 'sa-panel-styles'

    /* ---------------- shared open state ---------------- */

    const store = { open: false, listeners: new Set() }
    function setOpen(next) {
      if (store.open === next) return
      store.open = next
      for (const listener of store.listeners) listener()
    }
    function useOpen() {
      const [, force] = React.useState(0)
      React.useEffect(() => {
        const listener = () => force((n) => n + 1)
        store.listeners.add(listener)
        return () => store.listeners.delete(listener)
      }, [])
      return store.open
    }

    /* ---------------- small helpers ---------------- */

    async function api(path, init) {
      const response = await fetch(path, {
        cache: 'no-store',
        ...init,
        headers: { 'content-type': 'application/json', ...(init && init.headers) },
      })
      let body = null
      try {
        body = await response.json()
      } catch {
        /* non-JSON */
      }
      if (!response.ok) throw new Error((body && body.error) || `HTTP ${response.status}`)
      return body
    }

    /** Minimal inline markdown: **bold** and `code`, everything else literal. */
    function renderRich(text) {
      const parts = []
      const pattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g
      let last = 0
      let match
      let index = 0
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > last) parts.push(text.slice(last, match.index))
        const token = match[0]
        if (token.startsWith('**')) parts.push(h('strong', { key: `b${index++}` }, token.slice(2, -2)))
        else parts.push(h('code', { key: `c${index++}`, className: 'sa-code' }, token.slice(1, -1)))
        last = match.index + token.length
      }
      if (last < text.length) parts.push(text.slice(last))
      return parts
    }

    const TOOL_LABELS = {
      subagent: '派活',
      team_task_create: '建任务',
      team_task_update: '更新任务',
      team_task_list: '看任务',
      send_message: '跟进',
      wait_agent: '等待',
    }

    function ToolGlyph() {
      return h(
        'svg',
        { width: 11, height: 11, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M9.6 2.2a3.2 3.2 0 0 0-3.9 4.1L2.4 9.6a1.6 1.6 0 1 0 2.3 2.3l3.3-3.3a3.2 3.2 0 0 0 4.1-3.9l-1.9 1.9-2.4-.5-.5-2.4 2.3-1.5Z',
          fill: 'currentColor',
        }),
      )
    }

    function SparkIcon({ size }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M12 3.2 13.7 9 19.5 10.7 13.7 12.4 12 18.2 10.3 12.4 4.5 10.7 10.3 9 12 3.2Z',
          fill: 'currentColor',
        }),
        h('path', { d: 'M18.6 3.4 19.2 5.2 21 5.8 19.2 6.4 18.6 8.2 18 6.4 16.2 5.8 18 5.2 18.6 3.4Z', fill: 'currentColor', opacity: 0.75 }),
      )
    }

    /* ---------------- top-left trigger ---------------- */

    function Trigger(props) {
      const { t } = props
      const open = useOpen()
      return h(
        'button',
        {
          type: 'button',
          className: 'sa-trigger',
          'data-open': open ? 'true' : 'false',
          title: t('navTitle'),
          onClick: () => setOpen(!store.open),
        },
        h(SparkIcon, { size: 14 }),
        h('span', null, t('nav')),
      )
    }

    /* ---------------- panel ---------------- */

    function Panel(props) {
      const { t, uiWorkspace } = props
      const open = useOpen()
      const [data, setData] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [draft, setDraft] = React.useState('')
      const [confirmReset, setConfirmReset] = React.useState(false)
      const [models, setModels] = React.useState(null)
      const [menuOpen, setMenuOpen] = React.useState(false)
      const [modelBusy, setModelBusy] = React.useState(false)
      const [live, setLive] = React.useState(null)
      const bodyRef = React.useRef(null)
      const inputRef = React.useRef(null)
      const resetTimer = React.useRef(null)
      const liveAt = React.useRef(0)
      const refreshTimer = React.useRef(null)
      const streamRef = React.useRef(null)

      React.useEffect(() => {
        if (!open) return undefined
        let live = true
        let timer = null
        const tick = async () => {
          try {
            const next = await api('/api/superagent/state')
            if (live) {
              setData(next)
              setError('')
            }
          } catch (err) {
            if (live) setError(String((err && err.message) || err))
          } finally {
            if (live) timer = setTimeout(tick, 1300)
          }
        }
        tick()
        return () => {
          live = false
          if (timer) clearTimeout(timer)
        }
      }, [open])

      React.useEffect(() => {
        if (open && inputRef.current) inputRef.current.focus()
      }, [open])

      const messages = (data && data.messages) || []
      const messageCount = messages.length
      const liveLength = live && live.text ? live.text.length : 0
      React.useEffect(() => {
        const node = bodyRef.current
        if (node) node.scrollTop = node.scrollHeight
      }, [messageCount, liveLength, open])

      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          if (menuOpen) setMenuOpen(false)
          else setOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open, menuOpen])

      // Model catalog is only needed while the panel is open; one read per opening.
      React.useEffect(() => {
        if (!open) return undefined
        let live = true
        api('/api/superagent/models')
          .then((catalog) => {
            if (live) setModels(catalog)
          })
          .catch(() => {
            /* the model menu shows its own empty state */
          })
        return () => {
          live = false
        }
      }, [open])

      React.useEffect(() => {
        if (!menuOpen) return undefined
        const onDown = (event) => {
          const target = event.target
          if (target && typeof target.closest === 'function' && target.closest('.sa-menu, .sa-modelbtn')) return
          setMenuOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }, [menuOpen])

      const refresh = React.useCallback(async () => {
        try {
          const next = await api('/api/superagent/state')
          setData(next)
          /* The durable row replaces the live bubble as soon as it lands. */
          if (liveAt.current && (next.messages || []).some((m) => m.role === 'assistant' && m.time >= liveAt.current - 2000)) {
            liveAt.current = 0
            setLive(null)
          }
        } catch (err) {
          setError(String((err && err.message) || err))
        }
      }, [])

      const scheduleRefresh = React.useCallback(() => {
        if (refreshTimer.current) return
        refreshTimer.current = setTimeout(() => {
          refreshTimer.current = null
          refresh()
        }, 350)
      }, [refresh])

      /* Live typing: one SSE connection while the panel is open with a session. */
      React.useEffect(() => {
        if (!open) return undefined
        const sessionId = data && data.sessionId
        if (!sessionId) return undefined
        let source = null
        try {
          source = new EventSource(`/api/superagent/stream?session=${encodeURIComponent(sessionId)}`)
        } catch {
          return undefined
        }
        streamRef.current = source
        const onDelta = (event) => {
          let payload = null
          try {
            payload = JSON.parse(event.data)
          } catch {
            return
          }
          const text = payload && typeof payload.text === 'string' ? payload.text : ''
          if (!text) return
          liveAt.current = Date.now()
          setLive((prev) => ({ text: (prev ? prev.text : '') + text }))
        }
        const onEvent = (event) => {
          let payload = null
          try {
            payload = JSON.parse(event.data)
          } catch {
            return
          }
          if (!payload) return
          if (payload.type === 'turn/end' || payload.type === 'assistant/message' || payload.type === 'user/message') {
            scheduleRefresh()
          }
        }
        const onTurn = () => scheduleRefresh()
        source.addEventListener('delta', onDelta)
        source.addEventListener('event', onEvent)
        source.addEventListener('turn', onTurn)
        return () => {
          if (streamRef.current === source) streamRef.current = null
          try {
            source.close()
          } catch {
            /* already closed */
          }
        }
      }, [open, data && data.sessionId, scheduleRefresh])

      const submit = React.useCallback(async () => {
        const text = draft.trim()
        if (!text || busy) return
        setBusy(true)
        setError('')
        setDraft('')
        liveAt.current = 0
        setLive(null)
        try {
          await api('/api/superagent/send', { method: 'POST', body: JSON.stringify({ text }) })
          await refresh()
        } catch (err) {
          setError(String((err && err.message) || err))
          setDraft(text)
        } finally {
          setBusy(false)
          if (inputRef.current) inputRef.current.focus()
        }
      }, [draft, busy, refresh])

      const stop = React.useCallback(async () => {
        try {
          await api('/api/superagent/cancel', { method: 'POST' })
          liveAt.current = 0
          setLive(null)
          await refresh()
        } catch (err) {
          setError(String((err && err.message) || err))
        }
      }, [refresh])

      const reset = React.useCallback(async () => {
        if (!confirmReset) {
          setConfirmReset(true)
          if (resetTimer.current) clearTimeout(resetTimer.current)
          resetTimer.current = setTimeout(() => setConfirmReset(false), 2600)
          return
        }
        if (resetTimer.current) clearTimeout(resetTimer.current)
        setConfirmReset(false)
        try {
          await api('/api/superagent/reset', { method: 'POST' })
          liveAt.current = 0
          setLive(null)
          await refresh()
        } catch (err) {
          setError(String((err && err.message) || err))
        }
      }, [confirmReset, refresh])

      const openFull = React.useCallback(() => {
        if (!data || !data.sessionId) return
        try {
          if (uiWorkspace && typeof uiWorkspace.openSession === 'function') uiWorkspace.openSession(data.sessionId)
        } catch {
          /* navigation is best effort */
        }
      }, [data, uiWorkspace])

      const openWorker = React.useCallback(
        (sessionId) => {
          if (!sessionId) return
          try {
            if (uiWorkspace && typeof uiWorkspace.openSession === 'function') uiWorkspace.openSession(sessionId)
          } catch {
            /* navigation is best effort */
          }
        },
        [uiWorkspace],
      )

      const chooseModel = React.useCallback(
        async (provider, model, reasoningEffort) => {
          setModelBusy(true)
          setError('')
          try {
            const result = await api('/api/superagent/model', {
              method: 'POST',
              body: JSON.stringify({ provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }),
            })
            setData((prev) => (prev ? { ...prev, model: result.selected } : prev))
            setMenuOpen(false)
            await refresh()
          } catch (err) {
            setError(String((err && err.message) || err))
          } finally {
            setModelBusy(false)
          }
        },
        [refresh],
      )

      const currentModel = (data && data.model) || null
      const groups = (models && models.groups) || []
      const defaultSelection = models && models.default
      const shownModel = currentModel || defaultSelection || null
      const modelName = (selection) => {
        if (!selection) return t('modelDefault')
        for (const group of groups) {
          const found = group.models.find((entry) => entry.id === selection.model)
          if (found) return found.name
        }
        return selection.model
      }

      if (!open) return null

      const running = Boolean(data && data.running)
      const waiting = Boolean(data && data.waiting)
      const questions = (data && data.questions) || []
      const tasks = (data && data.tasks) || []
      const workers = (data && data.workers) || []
      const hasSession = Boolean(data && data.sessionId)

      return h(
        'section',
        { className: 'sa-panel', role: 'dialog', 'aria-label': t('title') },
        h(
          'header',
          { className: 'sa-head' },
          h('span', { className: 'sa-mark' }, h(SparkIcon, { size: 15 })),
          h(
            'div',
            { className: 'sa-headtext' },
            h('div', { className: 'title' }, t('title')),
            h(
              'div',
              { className: 'status' },
              h('span', { className: 'sa-dot', 'data-running': waiting ? 'wait' : running ? 'true' : 'false' }),
              waiting ? t('waitShort') : running ? t('running') : t('idle'),
            ),
          ),
          h('span', { className: 'sa-space' }),
          running ? h('button', { type: 'button', className: 'sa-iconbtn', onClick: stop, title: t('stop') }, t('stop')) : null,
          h('button', { type: 'button', className: 'sa-iconbtn', onClick: reset, title: t('reset') }, confirmReset ? t('resetConfirm') : t('reset')),
          h('button', { type: 'button', className: 'sa-iconbtn', onClick: openFull, disabled: !hasSession, title: t('openFull') }, '↗'),
          h('button', { type: 'button', className: 'sa-iconbtn', onClick: () => setOpen(false), title: t('close') }, '✕'),
        ),
        waiting
          ? h(
              'div',
              { className: 'sa-wait' },
              h('span', { className: 'sa-waitdot' }),
              h(
                'div',
                { className: 'sa-waittext' },
                h('div', { className: 'sa-waittitle' }, t('waiting')),
                questions.length > 0 ? h('div', { className: 'sa-waitq' }, questions[0]) : null,
              ),
              h('button', { type: 'button', className: 'sa-waitbtn', onClick: openFull }, t('openFull')),
            )
          : null,
        workers.length > 0
          ? h(
              'div',
              { className: 'sa-workers' },
              h('span', { className: 'sa-wlabel' }, t('workers')),
              workers.map((worker) =>
                h(
                  'button',
                  {
                    key: worker.id,
                    type: 'button',
                    className: 'sa-worker',
                    'data-status': worker.status,
                    title: `${worker.label || worker.id} · ${worker.status === 'running' ? t('wRunning') : worker.status === 'idle' ? t('wIdle') : t('wEnded')}`,
                    onClick: () => openWorker(worker.id),
                  },
                  h('span', { className: 'dot' }),
                  worker.label || worker.id.slice(0, 8),
                ),
              ),
            )
          : null,
        tasks.length > 0
          ? h(
              'div',
              { className: 'sa-tasks' },
              tasks.map((task) =>
                h(
                  'span',
                  { key: task.id, className: 'sa-task', 'data-status': task.status, title: task.subject },
                  h('span', { className: 'dot' }),
                  task.status === 'completed' ? '✓ ' : '',
                  task.subject,
                ),
              ),
            )
          : null,
        h(
          'div',
          { className: 'sa-body', ref: bodyRef },
          messages.length === 0 && !running
            ? h(
                'div',
                { className: 'sa-empty' },
                h('span', { className: 'sa-mark big' }, h(SparkIcon, { size: 22 })),
                h('h4', null, t('emptyTitle')),
                h('p', null, t('emptyHint')),
                [t('ex1'), t('ex2'), t('ex3')].map((example, index) =>
                  h(
                    'button',
                    {
                      key: index,
                      type: 'button',
                      className: 'sa-ex',
                      onClick: () => {
                        setDraft(example)
                        if (inputRef.current) inputRef.current.focus()
                      },
                    },
                    example,
                  ),
                ),
              )
            : null,
          messages.map((message) =>
            h(
              'div',
              { key: message.id, className: `sa-msg ${message.role === 'user' ? 'user' : 'assistant'}` },
              message.role === 'assistant' && message.tools && message.tools.length > 0
                ? h(
                    'div',
                    { className: 'sa-tools' },
                    message.steps > 1 ? h('span', { className: 'sa-steps' }, t('steps').replace('{n}', String(message.steps))) : null,
                    message.tools.map((name) =>
                      h('span', { key: name, className: 'sa-tool' }, h(ToolGlyph, null), TOOL_LABELS[name] || name),
                    ),
                  )
                : null,
              message.text ? h('div', { className: 'sa-bubble' }, renderRich(message.text)) : null,
            ),
          ),
          live && live.text
            ? h(
                'div',
                { className: 'sa-msg assistant sa-live' },
                h('div', { className: 'sa-bubble' }, renderRich(live.text), h('span', { className: 'sa-caret' })),
              )
            : null,
          running && !waiting && !(live && live.text)
            ? h('div', { className: 'sa-thinking' },
                h('span', { className: 'sa-dot', 'data-running': 'true' }),
                t('thinking'))
            : null,
        ),
        error ? h('div', { className: 'sa-err' }, `${t('errPrefix')}${error}`) : null,
        h(
          'div',
          { className: 'sa-composer' },
          h('textarea', {
            ref: inputRef,
            className: 'sa-input',
            rows: 2,
            value: draft,
            placeholder: t('placeholder'),
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                submit()
              }
            },
          }),
          h(
            'button',
            { type: 'button', className: 'sa-send', disabled: !draft.trim() || busy, onClick: submit, title: t('send') },
            h(
              'svg',
              { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
              h('path', { d: 'M8 12.5V4M8 4 4 8M8 4l4 4', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }),
            ),
          ),
        ),
        h(
          'div',
          { className: 'sa-foot' },
          h(
            'button',
            {
              type: 'button',
              className: 'sa-modelbtn',
              'data-open': menuOpen ? 'true' : 'false',
              title: t('modelTitle'),
              onClick: () => setMenuOpen((value) => !value),
            },
            h('span', { className: 'sa-modeldot' }),
            h('span', { className: 'sa-modelname' }, modelName(shownModel)),
            shownModel && shownModel.reasoningEffort
              ? h('span', { className: 'sa-effort' }, shownModel.reasoningEffort)
              : null,
            h('span', { className: 'sa-caret' }, '▾'),
          ),
          h('span', { className: 'sa-hint' }, t('hint')),
        ),
        menuOpen
          ? h(
              'div',
              { className: 'sa-menu', role: 'menu' },
              models === null
                ? h('div', { className: 'sa-menu-empty' }, t('modelLoading'))
                : groups.length === 0
                  ? h('div', { className: 'sa-menu-empty' }, t('modelEmpty'))
                  : groups.map((group) =>
                      h(
                        'div',
                        { key: group.id, className: 'sa-group' },
                        h('div', { className: 'sa-groupname' }, group.name),
                        group.models.map((model) => {
                          const selected = shownModel && shownModel.provider === group.id && shownModel.model === model.id
                          const efforts = (model.reasoning && model.reasoning.efforts) || []
                          const isDefault =
                            defaultSelection && defaultSelection.provider === group.id && defaultSelection.model === model.id
                          return h(
                            'div',
                            { key: model.id, className: 'sa-modelrow', 'data-selected': selected ? 'true' : 'false' },
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'sa-modelpick',
                                disabled: modelBusy,
                                onClick: () => chooseModel(group.id, model.id, model.reasoning && model.reasoning.defaultEffort),
                              },
                              h('span', { className: 'sa-check' }, selected ? '✓' : ''),
                              h('span', { className: 'sa-mname' }, model.name),
                              isDefault ? h('span', { className: 'sa-badge' }, t('modelDefaultBadge')) : null,
                            ),
                            model.description ? h('div', { className: 'sa-mdesc' }, model.description) : null,
                            efforts.length > 0
                              ? h(
                                  'div',
                                  { className: 'sa-efforts' },
                                  efforts.map((effort) =>
                                    h(
                                      'button',
                                      {
                                        key: effort.id,
                                        type: 'button',
                                        className: 'sa-effortbtn',
                                        title: effort.description || '',
                                        disabled: modelBusy,
                                        'data-selected':
                                          selected && shownModel.reasoningEffort === effort.id ? 'true' : 'false',
                                        onClick: () => chooseModel(group.id, model.id, effort.id),
                                      },
                                      effort.name,
                                    ),
                                  ),
                                )
                              : null,
                          )
                        }),
                      ),
                    ),
              models && models.failures && models.failures.length > 0
                ? h('div', { className: 'sa-menu-note' }, `${t('modelFailures')}${models.failures.map((failure) => failure.name).join('、')}`)
                : null,
            )
          : null,
      )
    }

    /* ---------------- styles ---------------- */

    const CSS = `
/* The panel owns one opaque surface. Only tokens the running theme publishes are
   used (Theme.listTokens); every var() carries an explicit fallback so a renamed
   token degrades the look instead of turning the panel transparent. */
.sa-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px 0 8px;
  margin-right: 4px;
  border: 1px solid var(--dsw-alias-border-l2, #d7dbe2);
  border-radius: 9px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #6b7280);
  font: inherit;
  font-size: 12.5px;
  line-height: 1;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
  white-space: nowrap;
}
.sa-trigger:hover {
  background: color-mix(in srgb, var(--dsw-alias-label-primary, #1b1f27) 7%, transparent);
  color: var(--dsw-alias-label-primary, #1b1f27);
}
.sa-trigger[data-open="true"] {
  border-color: var(--dsw-alias-brand-primary, #3b6ef6);
  color: var(--dsw-alias-label-primary, #1b1f27);
}
.sa-trigger svg { color: var(--dsw-alias-brand-primary, #3b6ef6); }

.sa-panel {
  --sa-bg: var(--dsw-alias-bg-overlay, #ffffff);
  --sa-surface: var(--dsw-alias-bg-layer-2, #f2f4f8);
  --sa-base: var(--dsw-alias-bg-base, #ffffff);
  --sa-text: var(--dsw-alias-label-primary, #1b1f27);
  --sa-muted: var(--dsw-alias-label-secondary, #6b7280);
  --sa-border: var(--dsw-alias-border-l2, #d7dbe2);
  --sa-border-soft: var(--dsw-alias-border-l1, #e6e9ef);
  --sa-brand: var(--dsw-alias-brand-primary, #3b6ef6);
  --sa-hover: color-mix(in srgb, var(--sa-text) 7%, transparent);
  --sa-faint: color-mix(in srgb, var(--sa-text) 5%, transparent);

  position: fixed;
  left: 12px;
  top: 60px;
  z-index: 30;
  width: min(400px, calc(100vw - 24px));
  max-height: min(74vh, 660px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--sa-border);
  border-radius: 16px;
  /* bg-base is opaque in every theme; the overlay tint is painted on top of it so
     a translucent overlay token can never make the panel see-through. */
  background-color: var(--sa-base);
  background-image: linear-gradient(var(--sa-bg), var(--sa-bg));
  background-clip: padding-box;
  color: var(--sa-text);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.22), 0 2px 8px rgba(0, 0, 0, 0.12);
  font-family: inherit;
  animation: sa-in 140ms ease-out;
}
@keyframes sa-in {
  from { opacity: 0; transform: translateY(-4px) scale(0.99); }
  to { opacity: 1; transform: none; }
}

.sa-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 8px 8px 12px;
}
.sa-mark {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  flex: none;
  border-radius: 8px;
  background: var(--sa-brand);
  color: #fff;
}
.sa-mark.big { width: 36px; height: 36px; border-radius: 11px; margin: 0 auto; }
.sa-headtext { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.sa-headtext .title { font-size: 12.5px; font-weight: 600; letter-spacing: 0.2px; }
.sa-headtext .status {
  display: flex; align-items: center; gap: 4px;
  font-size: 10.5px; color: var(--sa-muted);
}
.sa-space { flex: 1 1 auto; }
.sa-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--dsw-alias-state-idle-primary, #9aa1ab);
  flex: none;
}
.sa-dot[data-running="true"] {
  background: var(--sa-brand);
  animation: sa-pulse 1.2s ease-in-out infinite;
}
.sa-dot[data-running="wait"] { background: var(--dsw-alias-state-warn-primary, #f5a623); }
@keyframes sa-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

.sa-iconbtn {
  height: 24px;
  min-width: 24px;
  padding: 0 6px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--sa-muted);
  font: inherit;
  font-size: 11.5px;
  line-height: 1;
  cursor: pointer;
}
.sa-iconbtn:hover { background: var(--sa-hover); color: var(--sa-text); }
.sa-iconbtn:disabled { opacity: 0.35; cursor: default; background: transparent; }

.sa-wait {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 10px 8px;
  padding: 7px 8px 7px 10px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f5a623) 45%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f5a623) 12%, transparent);
}
.sa-waitdot {
  width: 7px; height: 7px; flex: none;
  border-radius: 50%;
  background: var(--dsw-alias-state-warn-primary, #f5a623);
  animation: sa-pulse 1.2s ease-in-out infinite;
}
.sa-waittext { flex: 1 1 auto; min-width: 0; }
.sa-waittitle { font-size: 11.5px; font-weight: 600; color: var(--sa-text); }
.sa-waitq {
  margin-top: 1px;
  color: var(--sa-muted);
  font-size: 10.5px;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.sa-waitbtn {
  flex: none;
  padding: 3px 8px;
  border: 1px solid var(--sa-border);
  border-radius: 7px;
  background: var(--sa-base);
  color: var(--sa-text);
  font: inherit;
  font-size: 10.5px;
  cursor: pointer;
}
.sa-waitbtn:hover { background: var(--sa-hover); }

.sa-workers {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow-x: auto;
  padding: 0 12px 7px;
  scrollbar-width: thin;
}
.sa-wlabel {
  flex: none;
  color: var(--sa-muted);
  font-size: 10px;
  letter-spacing: 0.3px;
}
.sa-worker {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 180px;
  padding: 1px 7px;
  border: 1px solid var(--sa-border-soft);
  border-radius: 999px;
  background: transparent;
  color: var(--sa-text);
  font: inherit;
  font-size: 10.5px;
  line-height: 1.6;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}
.sa-worker:hover { background: var(--sa-hover); border-color: var(--sa-border); }
.sa-worker .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary, #9aa1ab); flex: none; }
.sa-worker[data-status="running"] .dot { background: var(--sa-brand); animation: sa-pulse 1.2s ease-in-out infinite; }
.sa-worker[data-status="running"] { border-color: color-mix(in srgb, var(--sa-brand) 40%, transparent); }
.sa-worker[data-status="ended"] { color: var(--sa-muted); opacity: 0.7; }

.sa-tasks {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding: 0 12px 8px;
  scrollbar-width: thin;
}
.sa-task {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 210px;
  padding: 2px 8px;
  border: 1px solid var(--sa-border-soft);
  border-radius: 999px;
  background: var(--sa-faint);
  color: var(--sa-muted);
  font-size: 10.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sa-task .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--dsw-alias-state-warn-primary, #f5a623); flex: none; }
.sa-task[data-status="in_progress"] .dot { background: var(--sa-brand); }
.sa-task[data-status="completed"] .dot { background: var(--dsw-alias-state-success-primary, #30a46c); }
.sa-task[data-status="completed"] { color: var(--sa-muted); opacity: 0.8; }

.sa-body {
  flex: 1 1 auto;
  min-height: 120px;
  max-height: 46vh;
  overflow-y: auto;
  padding: 2px 12px 4px;
  scrollbar-width: thin;
}
.sa-msg { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
.sa-msg.user { align-items: flex-end; }
.sa-msg.assistant { align-items: flex-start; }
.sa-bubble {
  max-width: 88%;
  padding: 7px 10px;
  border-radius: 12px;
  font-size: 12.8px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}
.sa-msg.user .sa-bubble {
  background: var(--sa-brand);
  color: #fff;
  border-bottom-right-radius: 4px;
}
.sa-msg.assistant .sa-bubble {
  background: var(--sa-surface);
  color: var(--sa-text);
  border-bottom-left-radius: 4px;
}
.sa-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.92em;
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--sa-faint);
  border: 1px solid var(--sa-border-soft);
}
.sa-msg.user .sa-code { background: rgba(255, 255, 255, 0.18); border-color: rgba(255, 255, 255, 0.28); }
.sa-live .sa-bubble { opacity: 0.96; }
.sa-caret {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 2px;
  vertical-align: -2px;
  background: var(--sa-brand);
  animation: sa-blink 0.9s step-end infinite;
}
@keyframes sa-blink { 50% { opacity: 0; } }
.sa-tools { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.sa-steps { color: var(--sa-muted); font-size: 10px; margin-right: 1px; }
.sa-tool {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  border: 1px solid var(--sa-border-soft);
  border-radius: 999px;
  color: var(--sa-muted);
  background: var(--sa-faint);
  font-size: 10px;
  line-height: 1.5;
}
.sa-thinking {
  display: flex; align-items: center; gap: 6px;
  padding: 2px 2px 10px;
  color: var(--sa-muted);
  font-size: 11.5px;
}

.sa-empty { padding: 12px 4px 8px; text-align: center; }
.sa-empty h4 { margin: 9px 0 4px; font-size: 13px; font-weight: 600; }
.sa-empty p {
  margin: 0 0 12px;
  color: var(--sa-muted);
  font-size: 11.5px;
  line-height: 1.55;
}
.sa-ex {
  display: block;
  width: 100%;
  margin: 0 0 6px;
  padding: 7px 9px;
  border: 1px solid var(--sa-border-soft);
  border-radius: 9px;
  background: var(--sa-faint);
  color: var(--sa-text);
  font: inherit;
  font-size: 11.5px;
  line-height: 1.45;
  text-align: left;
  cursor: pointer;
}
.sa-ex:hover { border-color: var(--sa-border); background: var(--sa-hover); }

.sa-err {
  margin: 0 12px 8px;
  color: var(--dsw-alias-state-error-primary, #e5484d);
  font-size: 11.5px;
  line-height: 1.4;
}

.sa-composer {
  display: flex;
  gap: 8px;
  align-items: flex-end;
  padding: 8px 12px 6px;
  border-top: 1px solid var(--sa-border-soft);
}
.sa-input {
  flex: 1 1 auto;
  min-height: 46px;
  max-height: 104px;
  padding: 7px 9px;
  border: 1px solid var(--sa-border);
  border-radius: 10px;
  background: var(--sa-base);
  color: var(--sa-text);
  font: inherit;
  font-size: 12.8px;
  line-height: 1.5;
  resize: none;
  outline: none;
}
.sa-input::placeholder { color: var(--sa-muted); opacity: 0.75; }
.sa-input:focus { border-color: var(--sa-brand); }
.sa-send {
  width: 30px;
  height: 30px;
  flex: none;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 10px;
  background: var(--sa-brand);
  color: #fff;
  cursor: pointer;
  margin-bottom: 1px;
}
.sa-send:disabled { opacity: 0.4; cursor: default; }
.sa-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 12px 9px;
  color: var(--sa-muted);
  font-size: 10.5px;
}
.sa-hint { color: var(--sa-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sa-modelbtn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 62%;
  padding: 3px 8px;
  border: 1px solid var(--sa-border-soft);
  border-radius: 999px;
  background: var(--sa-faint);
  color: var(--sa-text);
  font: inherit;
  font-size: 10.5px;
  line-height: 1.3;
  cursor: pointer;
}
.sa-modelbtn:hover { border-color: var(--sa-border); background: var(--sa-hover); }
.sa-modelbtn[data-open="true"] { border-color: var(--sa-brand); }
.sa-modeldot {
  width: 5px; height: 5px; flex: none;
  border-radius: 50%;
  background: var(--sa-brand);
}
.sa-modelname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sa-effort {
  padding: 0 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--sa-brand) 14%, transparent);
  color: var(--sa-brand);
  font-size: 9.5px;
}
.sa-caret { color: var(--sa-muted); font-size: 9px; }

.sa-menu {
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: 44px;
  z-index: 5;
  max-height: 300px;
  overflow-y: auto;
  padding: 6px;
  border: 1px solid var(--sa-border);
  border-radius: 12px;
  background-color: var(--sa-base);
  background-image: linear-gradient(var(--sa-bg), var(--sa-bg));
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.24);
  scrollbar-width: thin;
}
.sa-group + .sa-group { margin-top: 6px; border-top: 1px solid var(--sa-border-soft); padding-top: 6px; }
.sa-groupname { padding: 4px 7px 3px; color: var(--sa-muted); font-size: 10px; letter-spacing: 0.3px; }
.sa-modelrow { padding: 1px 0 4px; }
.sa-modelpick {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 7px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--sa-text);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.sa-modelpick:hover { background: var(--sa-hover); }
.sa-modelrow[data-selected="true"] .sa-modelpick { background: var(--sa-faint); font-weight: 600; }
.sa-check { width: 12px; flex: none; color: var(--sa-brand); font-size: 10px; }
.sa-mname { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sa-badge {
  padding: 0 5px;
  border: 1px solid var(--sa-border-soft);
  border-radius: 999px;
  color: var(--sa-muted);
  font-size: 9px;
  font-weight: 400;
}
.sa-mdesc { padding: 0 7px 2px 25px; color: var(--sa-muted); font-size: 10px; line-height: 1.4; }
.sa-efforts { display: flex; flex-wrap: wrap; gap: 4px; padding: 2px 7px 4px 25px; }
.sa-effortbtn {
  padding: 1px 7px;
  border: 1px solid var(--sa-border-soft);
  border-radius: 999px;
  background: transparent;
  color: var(--sa-muted);
  font: inherit;
  font-size: 9.5px;
  cursor: pointer;
}
.sa-effortbtn:hover { color: var(--sa-text); border-color: var(--sa-border); }
.sa-effortbtn[data-selected="true"] {
  border-color: var(--sa-brand);
  color: var(--sa-brand);
  background: color-mix(in srgb, var(--sa-brand) 10%, transparent);
}
.sa-menu-empty { padding: 12px 8px; color: var(--sa-muted); font-size: 11px; text-align: center; }
.sa-menu-note { padding: 6px 8px 2px; color: var(--dsw-alias-state-warn-primary, #b7791f); font-size: 10px; line-height: 1.4; }
`

    /* ---------------- dictionaries ---------------- */

    const zh = {
      nav: 'Superagent',
      navTitle: '打开 Superagent 面板',
      title: 'Superagent',
      running: '干活中',
      idle: '待命',
      stop: '停止',
      reset: '新对话',
      resetConfirm: '确认清空？',
      openFull: '在完整会话里打开',
      close: '收起',
      modelTitle: '切换模型；只影响这个面板的会话和它派出的 worker',
      modelDefault: '默认模型',
      modelDefaultBadge: '默认',
      modelLoading: '正在读取模型…',
      modelEmpty: '没有可用的模型',
      modelFailures: '部分提供方不可用：',
      emptyTitle: '把一个需求丢给我',
      emptyHint: '我会拆成任务、派给 worker，再把结果收回来。',
      ex1: '看看这个工作区，用 5 行告诉我它是干什么的',
      ex2: '派个 worker 调研一下我们的构建脚本，再汇报',
      ex3: '并行做三件小事：列目录、找 TODO、总结 README',
      placeholder: '把需求丢给 Superagent…',
      send: '发送',
      thinking: '正在干活…',
      steps: '{n} 步',
      waiting: '它在等你回答',
      waitShort: '等你回答',
      workers: 'WORKERS',
      wRunning: '干活中',
      wIdle: '待命',
      wEnded: '已结束',
      errPrefix: '出错了：',
      hint: 'Enter 发送 · Shift+Enter 换行',
      workspace: '独立工作目录',
    }

    const en = {
      nav: 'Superagent',
      navTitle: 'Open the Superagent panel',
      title: 'Superagent',
      running: 'Working',
      idle: 'Standing by',
      stop: 'Stop',
      reset: 'New chat',
      resetConfirm: 'Clear chat?',
      openFull: 'Open the full session',
      close: 'Collapse',
      modelTitle: "Switch model (affects this panel's session and the workers it spawns)",
      modelDefault: 'Default model',
      modelDefaultBadge: 'Default',
      modelLoading: 'Loading models…',
      modelEmpty: 'No models available',
      modelFailures: 'Unavailable providers: ',
      emptyTitle: 'Hand me a request',
      emptyHint: 'I split it into tasks, route them to workers, and bring the results back.',
      ex1: 'Look at this workspace and tell me in 5 lines what it does',
      ex2: 'Send a worker to review our build scripts, then report back',
      ex3: 'Run three small jobs in parallel: list dirs, find TODOs, summarize the README',
      placeholder: 'Give the Superagent a task…',
      send: 'Send',
      thinking: 'Working…',
      steps: '{n} steps',
      waiting: 'It is waiting for your answer',
      waitShort: 'Needs you',
      workers: 'WORKERS',
      wRunning: 'Working',
      wIdle: 'Standing by',
      wEnded: 'Finished',
      errPrefix: 'Error: ',
      hint: 'Enter to send · Shift+Enter for a new line',
      workspace: 'Own workspace',
    }

    /* ---------------- apply ---------------- */

    function apply(ctx) {
      const slots = ctx.get('slots')
      const locale = ctx.get('locale')
      if (!slots || !locale) return
      const uiWorkspace = ctx.get('uiWorkspace')

      ctx.effect(() => locale.register(NS, { zh, en }), 'superagent: dictionaries')
      const t = locale.bind(NS)

      // First visit: open the panel once so it is discovered without hunting for the pill.
      try {
        if (window.localStorage.getItem('dsh-superagent.seen') !== '1') {
          window.localStorage.setItem('dsh-superagent.seen', '1')
          setOpen(true)
        }
      } catch {
        /* storage unavailable */
      }

      if (typeof document !== 'undefined' && document.getElementById(STYLE_ID) === null) {
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = CSS
        document.head.appendChild(style)
      }

      slots.inject('conversation.header.leading', () =>
        slots.register(
          {
            name: 'conversation.header.leading',
            id: 'superagent',
            order: 5,
            inject: () => ({ t }),
          },
          Trigger,
        ),
      )

      slots.inject('shell.overlay', () =>
        slots.register(
          {
            name: 'shell.overlay',
            id: 'superagent',
            order: 20,
            inject: () => ({ t, uiWorkspace }),
          },
          Panel,
        ),
      )
    }

    return { inject: ['slots', 'locale', 'uiWorkspace'], apply }
  },
})
