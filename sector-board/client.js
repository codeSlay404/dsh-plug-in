/**
 * Client half of the A-share sector board bundle.
 *
 * Registers a global panel: an icon in the sidebar's panellist and a keyed
 * `main` page under the same id, so the sidebar entry opens the board.
 * Data comes from the Host route `/api/sector-board/*` (same origin).
 *
 * v1.1: five sections — 总览 / 龙虎榜 / 游资 / 板块周期 / 红利.
 */
try {
window.__ModuleLoader__.load({
  id: 'dsh-sector-board',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const PANEL_ID = 'sector-board'
    const NS = 'sectorBoard'
    const DATA_URL = '/api/sector-board/dashboard.json'
    const STATUS_URL = '/api/sector-board/status.json'
    const REFRESH_URL = '/api/sector-board/refresh'
    const HOT_URL = '/api/sector-board/hot.json'

    const SIGNALS = [
      { key: 'golden_above', label: '水上金叉', color: '#e8b339', desc: 'MACD 金叉，且 DIF、DEA 都在零轴上方' },
      { key: 'golden_below', label: '水下金叉', color: '#5aa0e6', desc: 'MACD 金叉，且 DIF、DEA 都在零轴下方' },
      { key: 'surge', label: '近期大涨', color: 'var(--dsw-alias-state-error-primary)', desc: '近 5 日涨幅 ≥ +10%' },
      { key: 'plunge', label: '近期大跌', color: 'var(--dsw-alias-state-success-primary)', desc: '近 5 日涨幅 ≤ -10%' },
      { key: 'plunge_flat', label: '大跌后横盘', color: '#a78bfa', desc: '20 日跌幅 ≤ -12%，近 5 日振幅 ≤ 6% 且涨跌幅 ≤ 3%' },
      { key: 'cycle_low', label: '周期底部', color: '#38bdf8', desc: '收盘价处于近 250 日分位 ≤ 10%' },
      { key: 'cycle_high', label: '周期高点', color: '#fb923c', desc: '收盘价处于近 250 日分位 ≥ 90%' },
    ]
    const SIGNAL_BY_KEY = Object.fromEntries(SIGNALS.map((s) => [s.key, s]))

    const TABS = [
      { id: 'decide', label: 'navDecide' },
      { id: 'live', label: 'navLive' },
      { id: 'overview', label: 'navOverview' },
      { id: 'info', label: 'navInfo' },
      { id: 'themes', label: 'navThemes' },
      { id: 'hot', label: 'navHot' },
      { id: 'dividend', label: 'navDividend' },
      { id: 'global', label: 'navGlobal' },
      { id: 'paper', label: 'navRobot' },
    ]

    const UP = 'var(--dsw-alias-state-error-primary)'
    const DOWN = 'var(--dsw-alias-state-success-primary)'
    const STAGE_TONE = {
      底部: '#38bdf8', 顶部: '#fb923c', 上行: UP, 下行: DOWN,
      震荡: 'var(--dsw-alias-label-secondary)', '—': 'var(--dsw-alias-label-secondary)',
    }

    const dispName = (n) => (!n || n === '-' || n === '未分类') ? '未分类' : n
    const fmtPct = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%`)
    const fmtRatio = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)
    const fmtNum = (v, d = 1) => (v == null ? '—' : Number(v).toFixed(d))
    const fmtMoney = (v) => {
      if (v == null) return '—'
      const a = Math.abs(v)
      if (a >= 1e8) return `${(v / 1e8).toFixed(2)}亿`
      if (a >= 1e4) return `${(v / 1e4).toFixed(0)}万`
      return Number(v).toFixed(0)
    }
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
    const tone = (v) => (v == null || v === 0 ? 'var(--dsw-alias-label-secondary)' : v > 0 ? UP : DOWN)

    function todayCN() {
      const now = new Date(Date.now() + 8 * 3600 * 1000)
      return now.toISOString().slice(0, 10)
    }
    function cnHour() {
      return (new Date().getUTCHours() + 8) % 24
    }

    const styles = {
      page: {
        height: '100%', overflow: 'auto', boxSizing: 'border-box',
        paddingTop: 'calc(var(--dsh-frame-top-clearance, 24px) + 8px)',
        paddingRight: 28, paddingBottom: 40, paddingLeft: 28,
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
      },
      head: { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 12 },
      title: { fontSize: 20, fontWeight: 650, letterSpacing: 0.2, margin: 0, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      sub: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginTop: 6, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' },
      badge: { fontSize: 11, padding: '2px 8px', borderRadius: 999, border: '1px solid var(--dsw-alias-border-l1)', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap', fontWeight: 500 },
      btn: { fontSize: 12, padding: '6px 12px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' },
      nav: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12, borderBottom: '1px solid var(--dsw-alias-border-l1)', paddingBottom: 10 },
      navBtn: { fontSize: 13, padding: '6px 14px', borderRadius: 8, border: '1px solid transparent', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer' },
      navActive: { color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)', borderColor: 'var(--dsw-alias-border-l1)', fontWeight: 600 },
      strip: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(104px, 1fr))', gap: 8, marginBottom: 12 },
      stat: { background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, padding: '8px 10px' },
      statLabel: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
      statValue: { fontSize: 18, fontWeight: 640, marginTop: 2, fontVariantNumeric: 'tabular-nums' },
      toolbar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 },
      input: { flex: '1 1 200px', maxWidth: 320, fontSize: 13, padding: '7px 10px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', outline: 'none' },
      select: { fontSize: 12, padding: '7px 8px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)' },
      pill: { fontSize: 12, padding: '4px 9px', borderRadius: 999, border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(226px, 1fr))', gap: 10, alignContent: 'start' },
      card: { textAlign: 'left', cursor: 'pointer', borderRadius: 12, padding: '11px 12px', background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', transition: 'border-color .12s ease, background .12s ease', color: 'inherit', font: 'inherit' },
      cardSel: { borderColor: 'var(--dsw-alias-brand-primary)', background: 'var(--dsw-alias-bg-layer-2)' },
      cardTop: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
      cardName: { fontSize: 14, fontWeight: 620 },
      cardCount: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
      bar: { display: 'flex', height: 4, borderRadius: 2, overflow: 'hidden', margin: '9px 0 8px', background: 'var(--dsw-alias-bg-layer-2)' },
      chips: { display: 'flex', flexWrap: 'wrap', gap: 4 },
      chip: { fontSize: 10, padding: '1px 6px', borderRadius: 999, background: 'var(--dsw-alias-bg-layer-2)', display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--dsw-alias-label-secondary)' },
      dot: { width: 6, height: 6, borderRadius: 3, display: 'inline-block' },
      detail: { flex: '1 1 340px', minWidth: 320, maxWidth: 460, background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 12, padding: 14, position: 'sticky', top: 8 },
      tabs: { display: 'flex', flexWrap: 'wrap', gap: 5, margin: '10px 0' },
      liveBar: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '10px 14px', borderRadius: 10, background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', marginBottom: 8 },
      liveHint: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginBottom: 10 },
      evItem: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2)', fontSize: 11.5 },
      evTag: { fontSize: 10.5, padding: '1px 7px', borderRadius: 999, border: '1px solid', whiteSpace: 'nowrap' },
      table: { display: 'flex', flexDirection: 'column', gap: 1, maxHeight: 430, overflow: 'auto' },
      tr: { display: 'grid', gridTemplateColumns: '58px 1fr 62px 52px 52px 56px', gap: 6, fontSize: 11.5, padding: '4px 2px', alignItems: 'center', borderBottom: '1px solid var(--dsw-alias-border-l1)', fontVariantNumeric: 'tabular-nums' },
      th: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)' },
      empty: { padding: '48px 0', textAlign: 'center', color: 'var(--dsw-alias-label-secondary)', fontSize: 13 },
      foot: { marginTop: 18, fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.7 },
      errorBox: { padding: 12, borderRadius: 10, border: '1px solid var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, marginBottom: 12, whiteSpace: 'pre-wrap' },
      // ---- v1.1 ----
      hint: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', margin: '2px 0 8px', lineHeight: 1.6 },
      tableBox: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, overflow: 'auto', background: 'var(--dsw-alias-bg-layer-1)' },
      rowHead: { display: 'grid', gap: 8, padding: '6px 10px', fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-layer-2)', alignItems: 'center' },
      row: { display: 'grid', gap: 8, padding: '6px 10px', fontSize: 11.5, borderTop: '1px solid var(--dsw-alias-border-l1)', alignItems: 'center', fontVariantNumeric: 'tabular-nums', cursor: 'pointer' },
      rowStatic: { cursor: 'default' },
      right: { textAlign: 'right' },
      mono: { fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-label-secondary)' },
      seats: { padding: '8px 12px 10px 24px', background: 'var(--dsw-alias-bg-layer-2)', fontSize: 11, borderTop: '1px dashed var(--dsw-alias-border-l1)' },
      seatRow: { display: 'grid', gridTemplateColumns: '1fr 86px 86px 86px', gap: 8, padding: '3px 0', alignItems: 'center' },
      stage: { fontSize: 10, padding: '1px 7px', borderRadius: 999, border: '1px solid currentColor', whiteSpace: 'nowrap', display: 'inline-block' },
      kpi: { display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11, padding: '2px 0', color: 'var(--dsw-alias-label-secondary)' },
      kpiVal: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
      twoCol: { display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' },
      colFlex: { flex: '1 1 420px', minWidth: 320 },
      sectionTitle: { fontSize: 13, fontWeight: 620, margin: '10px 0 6px' },
      // ---- v1.2 ----
      seg: { display: 'inline-flex', padding: 2, borderRadius: 9, background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)' },
      segBtn: { fontSize: 12, padding: '4px 10px', borderRadius: 7, border: 0, background: 'transparent', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer' },
      segActive: { background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', fontWeight: 600, boxShadow: '0 1px 2px rgba(0,0,0,.08)' },
      searchBox: { position: 'relative', flex: '0 1 330px', minWidth: 200 },
      dropdown: { position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 40, background: 'var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1))', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,.18)', overflow: 'hidden' },
      dropItem: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 10px', background: 'transparent', border: 0, borderBottom: '1px solid var(--dsw-alias-border-l1)', color: 'inherit', font: 'inherit', fontSize: 12, cursor: 'pointer', textAlign: 'left' },
      drawer: { position: 'fixed', right: 16, top: 'calc(var(--dsh-frame-top-clearance, 40px) + 12px)', width: 330, maxHeight: '72vh', overflow: 'auto', zIndex: 30, background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, padding: 14, boxShadow: '0 14px 40px rgba(0,0,0,.22)' },
      decision: { border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', borderRadius: 10, padding: '8px 10px' },
      // ---- v2 overview ----
      idxBar: { display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 2, marginBottom: 12 },
      idxChip: { display: 'flex', alignItems: 'baseline', gap: 7, whiteSpace: 'nowrap', padding: '6px 10px', borderRadius: 9, background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)' },
      idxName: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
      idxPx: { fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
      idxPct: { fontSize: 11, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
      breadth: { display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap', padding: '13px 16px', borderRadius: 12, background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', marginBottom: 12 },
      breadthNums: { display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 210 },
      big: { fontSize: 27, fontWeight: 700, fontVariantNumeric: 'tabular-nums', lineHeight: 1 },
      bLabel: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
      bBar: { flex: '1 1 280px', minWidth: 180, height: 10, borderRadius: 5, overflow: 'hidden', display: 'flex', background: 'var(--dsw-alias-bg-layer-2)' },
      bMeta: { display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
      heatWrap: { position: 'relative', width: '100%', aspectRatio: '2 / 1', minHeight: 380, maxHeight: '62vh', borderRadius: 12, overflow: 'hidden', border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)' },
      heatTile: { position: 'absolute', boxSizing: 'border-box', border: '1px solid var(--dsw-alias-bg-base)', borderRadius: 3, padding: '5px 7px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', overflow: 'hidden', cursor: 'pointer', textShadow: '0 1px 2px rgba(0,0,0,.32)' },
      heatName: { fontWeight: 650, lineHeight: 1.15, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' },
      heatPct: { fontWeight: 700, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 },
      heatMeta: { fontSize: 10, opacity: 0.88, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
    }

    function PanelIcon({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('rect', { x: 1.5, y: 8, width: 3, height: 6.5, rx: 1, fill: 'currentColor', opacity: 0.55 }),
        h('rect', { x: 6.5, y: 4.5, width: 3, height: 10, rx: 1, fill: 'currentColor' }),
        h('rect', { x: 11.5, y: 1.5, width: 3, height: 13, rx: 1, fill: 'currentColor', opacity: 0.8 }))
    }

    function Stat({ label, value, color }) {
      return h('div', { style: styles.stat },
        h('div', { style: styles.statLabel }, label),
        h('div', { style: { ...styles.statValue, color: color || 'var(--dsw-alias-label-primary)' } }, value))
    }

    function SignalPill({ sig, count, active, onClick, compact }) {
      return h('button', {
        type: 'button',
        onClick: onClick || undefined,
        style: {
          ...styles.pill,
          ...(active ? { borderColor: sig.color, color: sig.color, background: 'color-mix(in srgb, ' + sig.color + ' 12%, transparent)' } : null),
          ...(onClick ? null : { cursor: 'default' }),
          padding: compact ? '2px 7px' : '4px 9px',
        },
        title: sig.desc,
      },
        h('span', { style: { ...styles.dot, background: sig.color } }),
        sig.label,
        count != null ? h('span', { style: { fontWeight: 600, color: active ? sig.color : 'var(--dsw-alias-label-primary)' } }, count > 999 ? '999+' : count) : null)
    }

    function SectorCard({ sector, selected, filter, onSelect }) {
      const total = Math.max(1, sector.up + sector.down + sector.flat)
      const shown = SIGNALS.filter((s) => (sector.signals[s.key] || 0) > 0)
      return h('button', {
        type: 'button',
        onClick: () => onSelect(sector.name),
        style: { ...styles.card, ...(selected ? styles.cardSel : null) },
      },
        h('div', { style: styles.cardTop },
          h('span', { style: styles.cardName }, dispName(sector.name)),
          h('span', { style: styles.cardCount }, sector.count, ' 只')),
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 4 } },
          h('span', { style: { fontSize: 15, fontWeight: 640, color: tone(sector.avg_pct) } }, fmtPct(sector.avg_pct)),
          h('span', { style: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)' } },
            '涨 ', sector.up, ' / 跌 ', sector.down,
            sector.limit_up ? ' · 涨停 ' + sector.limit_up : '',
            sector.limit_down ? ' · 跌停 ' + sector.limit_down : '')),
        h('div', { style: styles.bar },
          h('span', { style: { width: (sector.up / total) * 100 + '%', background: UP, opacity: 0.85 } }),
          h('span', { style: { width: (sector.flat / total) * 100 + '%', background: 'var(--dsw-alias-label-secondary)', opacity: 0.35 } }),
          h('span', { style: { width: (sector.down / total) * 100 + '%', background: DOWN, opacity: 0.85 } })),
        h('div', { style: styles.chips },
          shown.length === 0
            ? h('span', { style: { ...styles.chip, color: 'var(--dsw-alias-label-secondary)' } }, '无信号')
            : shown.slice(0, 4).map((s) => h('span', {
                key: s.key,
                style: {
                  ...styles.chip,
                  ...(filter === s.key ? { color: s.color, outline: '1px solid ' + s.color } : null),
                },
                title: s.desc,
              },
                h('span', { style: { ...styles.dot, background: s.color } }),
                s.label, ' ', sector.signals[s.key])),
          shown.length > 4 ? h('span', { style: styles.chip }, '+', shown.length - 4) : null))
    }

    function TechChips({ r, t, compact }) {
      if (!r) return null
      const items = []
      if (r.ma_state) items.push({ k: 'ma', txt: r.ma_state, color: r.ma_state === '多头' ? UP : r.ma_state === '空头' ? DOWN : 'var(--dsw-alias-label-secondary)' })
      if (r.macd_zone) items.push({ k: 'macd', txt: r.macd_zone, color: r.macd_zone === '水上' ? UP : r.macd_zone === '水下' ? DOWN : 'var(--dsw-alias-label-secondary)' })
      if (r.rsi14 != null && (!compact || r.rsi14 >= 70 || r.rsi14 <= 30)) items.push({ k: 'rsi', txt: 'RSI ' + fmtNum(r.rsi14, 0), color: r.rsi14 >= 70 ? UP : r.rsi14 <= 30 ? DOWN : 'var(--dsw-alias-label-secondary)' })
      if (!items.length) return null
      return h('span', { style: { display: 'inline-flex', gap: 3, flexWrap: 'wrap' } },
        items.map((x) => h('span', {
          key: x.k,
          title: t('techHint'),
          style: { fontSize: 9.5, lineHeight: '15px', padding: '0 4px', borderRadius: 4,
                   border: '1px solid ' + x.color, color: x.color, whiteSpace: 'nowrap' },
        }, x.txt)))
    }

    const STOCK_COLS = '46px 1fr 48px 38px 38px 78px'

    function StockTable({ rows, t }) {
      if (!rows || rows.length === 0) return h('div', { style: { ...styles.empty, padding: '26px 0' } }, t('noSignal'))
      return h('div', null,
        h('div', { style: { ...styles.tr, gridTemplateColumns: STOCK_COLS, borderBottom: 'none', color: 'var(--dsw-alias-label-secondary)' } },
          h('span', null, '代码'), h('span', null, '名称'), h('span', { style: { textAlign: 'right' } }, '今日'),
          h('span', { style: { textAlign: 'right' } }, '5日'),
          h('span', { style: { textAlign: 'right' } }, '年位置'), h('span', { style: { textAlign: 'right' } }, t('techCol'))),
        h('div', { style: styles.table },
          rows.map((r) => h('div', { key: r.code, style: { ...styles.tr, gridTemplateColumns: STOCK_COLS } },
            h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, r.code),
            h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: r.name }, r.name),
            h('span', { style: { textAlign: 'right', color: tone(r.pct), fontWeight: 600 } }, fmtPct(r.pct)),
            h('span', { style: { textAlign: 'right', color: tone(r.pct5) } }, fmtRatio(r.pct5)),
            h('span', { style: { textAlign: 'right', color: 'var(--dsw-alias-label-secondary)' } }, fmtRatio(r.pos250)),
            h('span', { style: { textAlign: 'right' } }, h(TechChips, { r, t, compact: true }))))))
    }

    function Detail({ sector, filter, onClose, t }) {
      const first = filter && (sector.signals[filter] || 0) > 0 ? filter : null
      const defaultTab = first || (SIGNALS.find((s) => (sector.signals[s.key] || 0) > 0) || SIGNALS[0]).key
      const [tab, setTab] = useState(defaultTab)
      useEffect(() => { setTab(defaultTab) }, [sector.name, defaultTab])
      const sig = SIGNAL_BY_KEY[tab]
      const rows = sector.lists[tab] || []
      const statLine = [
        ['平均', fmtPct(sector.avg_pct)],
        ['上涨', sector.up],
        ['下跌', sector.down],
        ['平盘', sector.flat],
        ['涨停', sector.limit_up],
        ['跌停', sector.limit_down],
      ]
      return h('aside', { style: styles.detail },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
          h('div', null,
            h('div', { style: { fontSize: 16, fontWeight: 650 } }, dispName(sector.name)),
            h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginTop: 2 } }, sector.count, ' 只股票')),
          h('button', { type: 'button', onClick: onClose, style: { ...styles.btn, padding: '3px 9px' }, title: t('close') }, '×')),
        h('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap', margin: '10px 0 2px' } },
          statLine.map(([k, v]) => h('span', { key: k, style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
            k, ' ', h('b', { style: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600 } }, v)))),
        h('div', { style: styles.tabs },
          SIGNALS.map((s) => {
            const n = sector.signals[s.key] || 0
            return h('button', {
              key: s.key,
              type: 'button',
              onClick: () => setTab(s.key),
              style: {
                ...styles.pill,
                fontSize: 11,
                opacity: n === 0 ? 0.5 : 1,
                ...(tab === s.key ? { borderColor: s.color, color: s.color, background: 'color-mix(in srgb, ' + s.color + ' 12%, transparent)' } : null),
              },
            }, s.label, ' ', n)
          })),
        h('div', { style: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)', marginBottom: 6 } }, sig.desc),
        h(StockTable, { rows, t }))
    }

    // ---- v2 overview helpers -------------------------------------------

    const INDEX_CODES = ['sh000001', 'sz399001', 'sz399006', 'sh000688', 'sh000300', 'hkHSI', 'hkHSTECH']

    function IndexStrip({ t }) {
      const [rows, setRows] = useState([])
      useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const res = await fetch('/api/sector-board/quotes.json?codes=' + INDEX_CODES.join(','), { cache: 'no-store' })
            const body = await res.json()
            if (alive && Array.isArray(body.rows)) {
              setRows(body.rows.filter((r) => r && r.price != null && r.pct != null))
            }
          } catch { /* quotes are best-effort */ }
        }
        load()
        const id = setInterval(load, 10000)
        return () => { alive = false; clearInterval(id) }
      }, [])
      if (!rows.length) return null
      return h('div', { style: styles.idxBar },
        rows.map((r) => h('div', { key: r.code, style: styles.idxChip },
          h('span', { style: styles.idxName }, r.name || r.code),
          h('span', { style: styles.idxPx }, Number(r.price).toFixed(r.price > 1000 ? 0 : 2)),
          h('span', { style: { ...styles.idxPct, color: tone(r.pct) } }, fmtPct(r.pct)))))
    }

    function heatTone(pct) {
      const v = clamp(Math.abs(pct == null ? 0 : pct) / 4.5, 0, 1)
      if (pct > 0.05 || pct < -0.05) {
        const a = 0.22 + v * 0.66
        const bg = pct > 0 ? `rgba(206, 54, 54, ${a})` : `rgba(22, 138, 86, ${a})`
        return a >= 0.5
          ? { background: bg, color: '#fff', textShadow: '0 1px 2px rgba(0,0,0,.35)' }
          : { background: bg, color: 'var(--dsw-alias-label-primary)', textShadow: 'none' }
      }
      return { background: 'rgba(138, 138, 138, 0.16)', color: 'var(--dsw-alias-label-primary)', textShadow: 'none' }
    }

    function rowRatio(areas, side) {
      const sum = areas.reduce((a, b) => a + b, 0)
      const max = Math.max(...areas)
      const min = Math.min(...areas)
      if (!sum || !min) return Infinity
      return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min))
    }

    function squarify(items, W, H) {
      const nodes = items.map((it) => ({ it, area: Math.max(1, it.value) }))
      const total = nodes.reduce((a, n) => a + n.area, 0)
      const scale = (W * H) / total
      nodes.forEach((n) => { n.area *= scale })
      const out = []
      let x = 0, y = 0, w = W, h = H, idx = 0
      while (idx < nodes.length && w > 0.5 && h > 0.5) {
        const side = Math.min(w, h)
        const row = [nodes[idx]]
        let next = idx + 1
        while (next < nodes.length) {
          const candidate = row.concat(nodes[next])
          if (rowRatio(candidate.map((n) => n.area), side) <= rowRatio(row.map((n) => n.area), side)) {
            row.push(nodes[next])
            next += 1
          } else break
        }
        const rowArea = row.reduce((a, n) => a + n.area, 0)
        if (w >= h) {
          const colW = rowArea / h
          let yy = y
          for (const n of row) {
            const tileH = n.area / colW
            out.push({ ...n.it, x, y: yy, w: colW, h: tileH })
            yy += tileH
          }
          x += colW
          w -= colW
        } else {
          const rowH = rowArea / w
          let xx = x
          for (const n of row) {
            const tileW = n.area / rowH
            out.push({ ...n.it, x: xx, y, w: tileW, h: rowH })
            xx += tileW
          }
          y += rowH
          h -= rowH
        }
        idx = next
      }
      return out
    }

    function BoardHeatmap({ rows, selected, filter, onSelect }) {
      const W = 1000, H = 500
      const tiles = useMemo(() => {
        const items = rows.map((s) => ({ segment: s, value: Math.max(2, s.count) })).sort((a, b) => b.value - a.value)
        return squarify(items, W, H).map((t) => ({ ...t, segment: t.segment }))
      }, [rows])

      return h('div', { style: styles.heatWrap },
        tiles.map((t) => {
          const s = t.segment
          const area = t.w * t.h
          const px = (v) => `${(v / W) * 100}%`
          const py = (v) => `${(v / H) * 100}%`
          const nameSize = clamp(Math.sqrt(area) / 5.2, 9, 17)
          const pctSize = clamp(Math.sqrt(area) / 4.4, 9, 19)
          const isSel = selected === s.name
          return h('div', {
            key: s.name,
            style: {
              ...styles.heatTile,
              left: px(t.x), top: py(t.y), width: px(t.w), height: py(t.h),
              ...heatTone(s.avg_pct),
              ...(isSel ? { outline: '2px solid var(--dsw-alias-brand-primary)', outlineOffset: -2, zIndex: 2 } : null),
            },
            onClick: () => onSelect(s.name),
            title: `${s.name} · ${s.count} 只 · 平均 ${fmtPct(s.avg_pct)} · 涨 ${s.up} / 跌 ${s.down}`,
          },
            area > 900 ? h('div', { style: { ...styles.heatName, fontSize: nameSize } }, dispName(s.name)) : null,
            area > 1800 ? h('div', { style: { ...styles.heatPct, fontSize: pctSize } }, fmtPct(s.avg_pct)) : null,
            area > 5200 ? h('div', { style: styles.heatMeta },
              s.count, '只 · 涨', s.up, ' 跌', s.down,
              filter && s.signals[filter] ? ` · ${SIGNAL_BY_KEY[filter].label} ${s.signals[filter]}` : '') : null)
        }))
    }


    function OverviewView({ data, t, jump }) {
      const [selected, setSelected] = useState(null)
      const [filter, setFilter] = useState(null)
      const [query, setQuery] = useState('')
      const [sort, setSort] = useState('count')
      const [mode, setMode] = useState('industry')
      const [view, setView] = useState('heat')

      const bd = data.boards || {}
      const MODES = [
        { id: 'industry', label: t('viewIndustry'), rows: data.sectors },
        { id: 'concept', label: t('viewConcept'), rows: bd.concept || [] },
      ].filter((x) => x.id === 'industry' || x.rows.length > 0)
      const active = MODES.find((x) => x.id === mode) || MODES[0]

      useEffect(() => {
        if (!jump) return
        setMode(jump.mode)
        setSelected(jump.name)
        setFilter(null)
        setQuery('')
      }, [jump && jump.n])

      const sectors = useMemo(() => {
        const q = query.trim().toLowerCase()
        let rows = active.rows.filter((s) => s.count > 0)
        if (q) rows = rows.filter((s) => s.name.toLowerCase().includes(q))
        if (filter) rows = rows.filter((s) => (s.signals[filter] || 0) > 0)
        const sigTotal = (s) => SIGNALS.reduce((a, x) => a + (s.signals[x.key] || 0), 0)
        const cmp = {
          count: (a, b) => b.count - a.count,
          pct: (a, b) => (b.avg_pct == null ? -999 : b.avg_pct) - (a.avg_pct == null ? -999 : a.avg_pct),
          signal: (a, b) => sigTotal(b) - sigTotal(a),
          name: (a, b) => a.name.localeCompare(b.name, 'zh'),
        }[sort]
        return [...rows].sort(cmp)
      }, [active, query, filter, sort])

      const selectedSector = selected && active.rows.find((s) => s.name === selected) || null
      const m = data.market || {}
      const totalSignals = SIGNALS.reduce((a, s) => a + (data.signals[s.key] || 0), 0)
      const breadthTotal = Math.max(1, (m.up || 0) + (m.flat || 0) + (m.down || 0))

      return h('div', null,
        h(IndexStrip, { t }),
        h('div', { style: styles.breadth },
          h('div', { style: styles.breadthNums },
            h('span', { style: { ...styles.big, color: UP } }, m.up == null ? '—' : m.up),
            h('span', { style: styles.bLabel }, t('marketUp')),
            h('span', { style: { ...styles.big, color: DOWN, marginLeft: 10 } }, m.down == null ? '—' : m.down),
            h('span', { style: styles.bLabel }, t('marketDown'))),
          h('div', { style: styles.bBar },
            h('span', { style: { width: ((m.up || 0) / breadthTotal) * 100 + '%', background: UP, opacity: 0.9 } }),
            h('span', { style: { width: ((m.flat || 0) / breadthTotal) * 100 + '%', background: 'var(--dsw-alias-label-secondary)', opacity: 0.3 } }),
            h('span', { style: { width: ((m.down || 0) / breadthTotal) * 100 + '%', background: DOWN, opacity: 0.9 } })),
          h('div', { style: styles.bMeta },
            h('span', null, t('limitUp'), ' ', h('b', { style: { color: UP } }, m.limit_up == null ? '—' : m.limit_up)),
            h('span', null, t('limitDown'), ' ', h('b', { style: { color: DOWN } }, m.limit_down == null ? '—' : m.limit_down)),
            h('span', null, t('median'), ' ', h('b', { style: { color: tone(m.median_pct) } }, m.median_pct == null ? '—' : fmtPct(m.median_pct))),
            h('span', null, t('avg'), ' ', h('b', { style: { color: tone(m.avg_pct) } }, m.avg_pct == null ? '—' : fmtPct(m.avg_pct))),
            h('span', null, t('signalTotal'), ' ', h('b', null, totalSignals)),
            h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, t('techBull'), ' ',
              h('b', { style: { color: UP } }, (m.tech && m.tech.ma_bull) == null ? '—' : m.tech.ma_bull),
              ' / ', t('techBear'), ' ',
              h('b', { style: { color: DOWN } }, (m.tech && m.tech.ma_bear) == null ? '—' : m.tech.ma_bear),
              ' · ', t('techAbove'), ' ',
              h('b', null, (m.tech && m.tech.macd_above) == null ? '—' : m.tech.macd_above),
              ' · RSI≥70 ', h('b', { style: { color: UP } }, (m.tech && m.tech.rsi_over) == null ? '—' : m.tech.rsi_over)))),
        h('div', { style: styles.toolbar },
          MODES.length > 1 ? h('div', { style: styles.seg },
            MODES.map((x) => h('button', {
              key: x.id, type: 'button',
              style: { ...styles.segBtn, ...(mode === x.id ? styles.segActive : null) },
              onClick: () => { setMode(x.id); setSelected(null) },
            }, x.label, ' ', h('b', null, x.rows.filter((s) => s.count > 0).length)))) : null,
          h('div', { style: styles.seg },
            h('button', { type: 'button', style: { ...styles.segBtn, ...(view === 'heat' ? styles.segActive : null) }, onClick: () => setView('heat') }, t('heatmap')),
            h('button', { type: 'button', style: { ...styles.segBtn, ...(view === 'cards' ? styles.segActive : null) }, onClick: () => setView('cards') }, t('cards'))),
          h('span', { style: { flex: 1 } }),
          h('input', {
            style: styles.input,
            placeholder: t('search'),
            value: query,
            onChange: (e) => setQuery(e.target.value),
          }),
          view === 'cards' ? h('select', { style: styles.select, value: sort, onChange: (e) => setSort(e.target.value) },
            h('option', { value: 'count' }, t('sortCount')),
            h('option', { value: 'pct' }, t('sortPct')),
            h('option', { value: 'signal' }, t('sortSignal')),
            h('option', { value: 'name' }, t('sortName'))) : null),
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 } },
          h('button', {
            type: 'button',
            style: { ...styles.pill, ...(filter === null ? { borderColor: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-brand-primary)' } : null) },
            onClick: () => setFilter(null),
          }, t('all'), ' ', h('b', null, active.rows.filter((s) => s.count > 0).length)),
          SIGNALS.map((s) => h(SignalPill, {
            key: s.key, sig: s, count: data.signals[s.key] || 0,
            active: filter === s.key,
            onClick: () => setFilter(filter === s.key ? null : s.key),
          }))),
        h('div', { style: { display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' } },
          h('div', { style: { flex: '3 1 640px', minWidth: 300 } },
            sectors.length === 0
              ? h('div', { style: styles.empty }, t('noMatch'))
              : view === 'heat'
                ? h(BoardHeatmap, { rows: sectors, selected, filter, onSelect: setSelected })
                : h('div', { style: styles.grid },
                    sectors.map((s) => h(SectorCard, {
                      key: s.name, sector: s, selected: selected === s.name, filter, onSelect: setSelected,
                    })))),
          selectedSector
            ? h(Detail, { sector: selectedSector, filter, onClose: () => setSelected(null), t })
            : null),
        h('div', { style: { ...styles.foot, marginTop: 10 } }, t('overviewHint'), ` ${t('signalTotal')} ${totalSignals}.`))
    }


    // ---------------- 热点（讨论热度 + 龙虎榜 + 游资） ----------------

    function HotView({ data, t, onTech }) {
      const [sub, setSub] = useState('heat')
      const [hot, setHot] = useState(null)
      const [err, setErr] = useState('')
      useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const res = await fetch(HOT_URL, { cache: 'no-store' })
            const body = await res.json()
            if (alive) { setHot(body); setErr('') }
          } catch (e) {
            if (alive) setErr(String((e && e.message) || e))
          }
        }
        load()
        const id = setInterval(load, 120000)
        return () => { alive = false; clearInterval(id) }
      }, [])
      const rows = (hot && hot.rows) || []
      const subs = [
        { id: 'heat', label: t('hotSubHeat'), n: rows.length },
        { id: 'lhb', label: t('hotSubLhb'), n: (data.lhb && data.lhb.count) || 0 },
        { id: 'youzi', label: t('hotSubYouzi'), n: ((data.youzi && data.youzi.stocks) || []).length },
      ]
      const cols = '30px 1.35fr 58px 56px 78px 118px'
      return h('div', null,
        h('div', { style: styles.hint }, t('hotHint')),
        h('div', { style: { ...styles.seg, marginBottom: 10 } },
          subs.map((x) => h('button', {
            key: x.id, type: 'button',
            style: { ...styles.segBtn, ...(sub === x.id ? styles.segActive : null) },
            onClick: () => setSub(x.id),
          }, x.label, ' ', h('b', null, x.n)))),
        sub === 'heat' ? h('div', null,
          err ? h('div', { style: styles.errorBox }, err) : null,
          !hot && !err ? h('div', { style: styles.empty }, t('loading')) : null,
          rows.length ? h('div', { style: styles.tableBox },
            h('div', { style: { ...styles.rowHead, gridTemplateColumns: cols } },
              h('span', null, '#'), h('span', null, t('colName')), h('span', { style: styles.right }, t('colPct')),
              h('span', { style: styles.right }, t('hotHeat')), h('span', null, t('hotPopularity')),
              h('span', { style: styles.right }, t('techCol'))),
            rows.slice(0, 60).map((r) => h('div', {
              key: r.code,
              style: { ...styles.row, gridTemplateColumns: cols, cursor: 'pointer' },
              onClick: () => onTech({ code: r.code, name: r.name, type: 'stock', industry: (r.concepts || []).join(' ') }),
            },
              h('span', { style: { color: r.rank <= 3 ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)', fontWeight: 650 } }, r.rank),
              h('span', { style: { minWidth: 0 } },
                h('div', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5, fontWeight: 600 } }, r.name || r.code),
                h('div', { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  r.code, r.industry ? ' · ' + r.industry : '', (r.concepts && r.concepts.length ? ' · ' + r.concepts.join('/') : ''))),
              h('span', { style: { ...styles.right, color: tone(r.pct), fontWeight: 600 } }, fmtPct(r.pct)),
              h('span', { style: styles.right }, r.heat == null ? '—' : (r.heat >= 10000 ? (r.heat / 10000).toFixed(1) + '万' : fmtNum(r.heat, 0))),
              h('span', { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, r.popularity || '—'),
              h('span', { style: { textAlign: 'right' } }, h(TechChips, { r, t }))))) : null,
          h('div', { style: { ...styles.hint, marginTop: 8 } }, t('hotNote')))
        : sub === 'lhb' ? h(LhbView, { data, t }) : h(YouziView, { data, t }))
    }

    // ---------------- 龙虎榜 ----------------
    const LHB_COLS = '64px 1.3fr 62px 62px 92px 92px 66px'

    function lhbSeatPanel(r, t) {
      const rows = (r.seats || []).map((s, i) => h('div', { key: i, style: styles.seatRow },
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: s.name },
          s.name, s.inst ? h('span', { style: { ...styles.chip, marginLeft: 6 } }, t('lhbInst')) : null),
        h('span', { style: styles.right }, fmtMoney(s.buy)),
        h('span', { style: styles.right }, fmtMoney(s.sell)),
        h('span', { style: { ...styles.right, color: tone(s.net) } }, fmtMoney(s.net))))
      return h('div', { style: styles.seats },
        r.reason ? h('div', { style: { marginBottom: 6, color: 'var(--dsw-alias-label-secondary)' } },
          t('lhbReason'), '：', r.reason) : null,
        h('div', { style: { ...styles.seatRow, color: 'var(--dsw-alias-label-secondary)' } },
          h('span', null, t('lhbDept')),
          h('span', { style: styles.right }, t('lhbBuy')),
          h('span', { style: styles.right }, t('lhbSell')),
          h('span', { style: styles.right }, t('lhbNet'))),
        rows)
    }

    function LhbView({ data, t }) {
      const lhb = data.lhb || { rows: [] }
      const [sortKey, setSortKey] = useState('net')
      const [expanded, setExpanded] = useState(null)
      const rows = useMemo(() => {
        const arr = [...(lhb.rows || [])]
        const cmp = {
          net: (a, b) => (b.net || 0) - (a.net || 0),
          pct: (a, b) => (b.pct || 0) - (a.pct || 0),
          ratio: (a, b) => (b.net_ratio || 0) - (a.net_ratio || 0),
          amount: (a, b) => (b.amount || 0) - (a.amount || 0),
        }[sortKey]
        return arr.sort(cmp)
      }, [lhb, sortKey])

      const head = h('div', { style: { ...styles.rowHead, gridTemplateColumns: LHB_COLS } },
        h('span', null, '代码'), h('span', null, '名称'),
        h('span', { style: styles.right }, t('lhbPct')),
        h('span', { style: styles.right }, t('lhbTurn')),
        h('span', { style: styles.right }, t('lhbNet')),
        h('span', { style: styles.right }, t('lhbAmount')),
        h('span', { style: styles.right }, t('lhbSeat')))

      const body = rows.length === 0
        ? h('div', { style: styles.empty }, t('lhbEmpty'))
        : h('div', { style: styles.tableBox },
            head,
            rows.map((r) => h('div', { key: r.code },
              h('div', {
                style: { ...styles.row, gridTemplateColumns: LHB_COLS, background: expanded === r.code ? 'var(--dsw-alias-bg-layer-2)' : 'transparent' },
                onClick: () => setExpanded(expanded === r.code ? null : r.code),
                title: r.reason || '',
              },
                h('span', { style: styles.mono }, r.code),
                h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: r.name + (r.reason ? ' — ' + r.reason : '') }, r.name),
                h('span', { style: { ...styles.right, color: tone(r.pct), fontWeight: 600 } }, fmtPct(r.pct)),
                h('span', { style: styles.right }, fmtNum(r.turnover, 2)),
                h('span', { style: { ...styles.right, color: tone(r.net), fontWeight: 600 } }, fmtMoney(r.net)),
                h('span', { style: styles.right }, fmtMoney(r.amount)),
                h('span', { style: styles.right }, (r.seats || []).length)),
              expanded === r.code ? lhbSeatPanel(r, t) : null)))

      return h('div', null,
        h('div', { style: styles.strip },
          h(Stat, { label: t('lhbCount'), value: lhb.count || 0 }),
          h(Stat, { label: t('lhbNetSum'), value: fmtMoney(lhb.net_sum), color: tone(lhb.net_sum) }),
          h(Stat, { label: t('lhbBuySum'), value: fmtMoney(lhb.buy_sum) }),
          h(Stat, { label: t('lhbDate'), value: lhb.date || '—' })),
        h('div', { style: styles.hint }, t('lhbHint')),
        h('div', { style: styles.toolbar },
          h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, t('sortBy')),
          h('select', { style: styles.select, value: sortKey, onChange: (e) => setSortKey(e.target.value) },
            h('option', { value: 'net' }, t('lhbNet')),
            h('option', { value: 'pct' }, t('lhbPct')),
            h('option', { value: 'ratio' }, t('lhbRatio')),
            h('option', { value: 'amount' }, t('lhbAmount')))),
        body)
    }

    // ---------------- 游资 ----------------
    const YZ_COLS = '64px 1.2fr 60px 92px 64px 54px'
    const ACT_COLS = '1fr 92px 92px 52px'

    function YouziView({ data, t }) {
      const yz = data.youzi || { stocks: [], seats: [] }
      const [sortKey, setSortKey] = useState('net')
      const stocks = useMemo(() => {
        const arr = [...(yz.stocks || [])]
        const cmp = {
          net: (a, b) => (b.net || 0) - (a.net || 0),
          pct: (a, b) => (b.pct || 0) - (a.pct || 0),
          ratio: (a, b) => (b.net_ratio || 0) - (a.net_ratio || 0),
        }[sortKey]
        return arr.sort(cmp)
      }, [yz, sortKey])

      return h('div', null,
        h('div', { style: styles.strip },
          h(Stat, { label: t('youziCount'), value: yz.count || 0 }),
          h(Stat, { label: t('youziNetSum'), value: fmtMoney((yz.stocks || []).reduce((a, x) => a + (x.net || 0), 0)), color: UP }),
          h(Stat, { label: t('youziSeatCount'), value: (yz.seats || []).length })),
        h('div', { style: styles.hint }, t('youziHint')),
        h('div', { style: styles.twoCol },
          h('div', { style: styles.colFlex },
            h('div', { style: styles.sectionTitle }, t('youziStocks')),
            h('div', { style: styles.toolbar },
              h('select', { style: styles.select, value: sortKey, onChange: (e) => setSortKey(e.target.value) },
                h('option', { value: 'net' }, t('youziNet')),
                h('option', { value: 'pct' }, t('youziPct')),
                h('option', { value: 'ratio' }, t('youziRatio')))),
            stocks.length === 0
              ? h('div', { style: { ...styles.empty, padding: '26px 0' } }, t('youziEmpty'))
              : h('div', { style: styles.tableBox },
                  h('div', { style: { ...styles.rowHead, gridTemplateColumns: YZ_COLS } },
                    h('span', null, '代码'), h('span', null, '名称'),
                    h('span', { style: styles.right }, t('youziPct')),
                    h('span', { style: styles.right }, t('youziNet')),
                    h('span', { style: styles.right }, t('youziRatio')),
                    h('span', { style: styles.right }, t('youziSeats'))),
                  stocks.map((r) => h('div', { key: r.code, style: { ...styles.row, ...styles.rowStatic, gridTemplateColumns: YZ_COLS }, title: r.reason || '' },
                    h('span', { style: styles.mono }, r.code),
                    h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, r.name),
                    h('span', { style: { ...styles.right, color: tone(r.pct), fontWeight: 600 } }, fmtPct(r.pct)),
                    h('span', { style: { ...styles.right, color: UP, fontWeight: 600 } }, fmtMoney(r.net)),
                    h('span', { style: styles.right }, r.net_ratio == null ? '—' : fmtPct(r.net_ratio)),
                    h('span', { style: styles.right }, r.seat_count))))),
          h('div', { style: styles.colFlex },
            h('div', { style: styles.sectionTitle }, t('youziActive')),
            h('div', { style: styles.tableBox },
              h('div', { style: { ...styles.rowHead, gridTemplateColumns: ACT_COLS } },
                h('span', null, t('youziDept')),
                h('span', { style: styles.right }, t('youziBuy')),
                h('span', { style: styles.right }, t('youziNet')),
                h('span', { style: styles.right }, t('youziStocks'))),
              (yz.seats || []).map((s, i) => h('div', { key: i, style: { ...styles.row, ...styles.rowStatic, gridTemplateColumns: ACT_COLS }, title: (s.codes || []).join(' ') },
                h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, s.name),
                h('span', { style: styles.right }, fmtMoney(s.buy)),
                h('span', { style: { ...styles.right, color: tone(s.net) } }, fmtMoney(s.net)),
                h('span', { style: styles.right }, s.stocks)))))))
    }

    // ---------------- 板块周期 ----------------
    function StageBadge({ stage }) {
      const c = STAGE_TONE[stage] || 'var(--dsw-alias-label-secondary)'
      return h('span', { style: { ...styles.stage, color: c } }, stage || '—')
    }

    function CycleCard({ sec, selected, onSelect, t }) {
      return h('button', {
        type: 'button',
        onClick: () => onSelect(sec.name),
        style: { ...styles.card, ...(selected ? styles.cardSel : null) },
      },
        h('div', { style: styles.cardTop },
          h('span', { style: styles.cardName }, sec.name),
          h(StageBadge, { stage: sec.stage })),
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 6 } },
          h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, sec.character, ' · ', sec.count, ' 只'),
          h('span', { style: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)' } }, t('cycleX'), ' ', fmtRatio(sec.pe_pct_x))),
        h('div', { style: styles.kpi }, h('span', null, t('cyclePe')), h('span', { style: styles.kpiVal }, fmtNum(sec.pe_median))),
        h('div', { style: styles.kpi }, h('span', null, t('cyclePb')), h('span', { style: styles.kpiVal }, fmtNum(sec.pb_median, 2))),
        h('div', { style: styles.kpi }, h('span', null, t('cycleSmall')), h('span', { style: styles.kpiVal }, fmtRatio(sec.pos250_med))),
        h('div', { style: styles.kpi }, h('span', null, t('cycleBig')), h('span', { style: styles.kpiVal }, fmtRatio(sec.pos1250_med))),
        h('div', { style: styles.kpi }, h('span', null, t('cycleVol')), h('span', { style: styles.kpiVal }, fmtRatio(sec.vol_median))))
    }

    const CY_COLS = '64px 1.2fr 60px 52px 60px 62px 62px 54px 52px'

    function CycleView({ data, t }) {
      const cyc = data.cycle || { sectors: [] }
      const sectors = cyc.sectors || []
      const [selected, setSelected] = useState(null)
      const [sortKey, setSortKey] = useState('pe')
      const active = selected && sectors.find((s) => s.name === selected) || sectors[0] || null
      const stocks = useMemo(() => {
        if (!active) return []
        const arr = [...(active.stocks || [])]
        const cmp = {
          pe: (a, b) => (a.pe_pct_in == null ? 2 : a.pe_pct_in) - (b.pe_pct_in == null ? 2 : b.pe_pct_in),
          small: (a, b) => (a.pos250 == null ? 2 : a.pos250) - (b.pos250 == null ? 2 : b.pos250),
          big: (a, b) => (a.pos1250 == null ? 2 : a.pos1250) - (b.pos1250 == null ? 2 : b.pos1250),
          pct5: (a, b) => (b.pct5 == null ? -9 : b.pct5) - (a.pct5 == null ? -9 : a.pct5),
        }[sortKey]
        return arr.sort(cmp)
      }, [active, sortKey])

      return h('div', null,
        h('div', { style: styles.hint }, t('cycleHint'), ' ', t('cycleRules'), '：', cyc.rules || ''),
        sectors.length === 0
          ? h('div', { style: styles.empty }, t('cycleEmpty'))
          : h('div', { style: styles.grid },
              sectors.map((s) => h(CycleCard, { key: s.name, sec: s, selected: active && active.name === s.name, onSelect: setSelected, t }))),
        active
          ? h('div', null,
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, margin: '16px 0 8px', flexWrap: 'wrap' } },
                h('div', { style: styles.sectionTitle, margin: 0 }, active.name, ' · ', t('cycleStocks')),
                h(StageBadge, { stage: active.stage }),
                h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, active.desc || ''),
                h('span', { style: { flex: 1 } }),
                h('select', { style: styles.select, value: sortKey, onChange: (e) => setSortKey(e.target.value) },
                  h('option', { value: 'pe' }, t('cyclePePct')),
                  h('option', { value: 'small' }, t('cycleSmall')),
                  h('option', { value: 'big' }, t('cycleBig')),
                  h('option', { value: 'pct5' }, t('cyclePct5')))),
              h('div', { style: styles.tableBox },
                h('div', { style: { ...styles.rowHead, gridTemplateColumns: CY_COLS } },
                  h('span', null, '代码'), h('span', null, '名称'),
                  h('span', { style: styles.right }, 'PE'), h('span', { style: styles.right }, 'PB'),
                  h('span', { style: styles.right }, t('cyclePePct')),
                  h('span', { style: styles.right }, t('cycleSmall')),
                  h('span', { style: styles.right }, t('cycleBig')),
                  h('span', { style: styles.right }, t('cycleStage')),
                  h('span', { style: styles.right }, '5日')),
                stocks.map((r) => h('div', { key: r.code, style: { ...styles.row, ...styles.rowStatic, gridTemplateColumns: CY_COLS } },
                  h('span', { style: styles.mono }, r.code),
                  h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, r.name),
                  h('span', { style: styles.right }, fmtNum(r.pe)),
                  h('span', { style: styles.right }, fmtNum(r.pb, 2)),
                  h('span', { style: styles.right }, fmtRatio(r.pe_pct_in)),
                  h('span', { style: styles.right }, fmtRatio(r.pos250)),
                  h('span', { style: styles.right }, fmtRatio(r.pos1250)),
                  h('span', { style: styles.right }, h(StageBadge, { stage: r.stage })),
                  h('span', { style: { ...styles.right, color: tone(r.pct5) } }, fmtRatio(r.pct5))))))
          : null)
    }

    // ---------------- 红利 ----------------
    const DIV_COLS = '64px 1.2fr 1fr 62px 56px 56px 62px 52px'

    function DividendView({ data, t }) {
      const div = data.dividend || { rows: [] }
      const [sortKey, setSortKey] = useState('yield')
      const rows = useMemo(() => {
        const arr = [...(div.rows || [])]
        const cmp = {
          yield: (a, b) => (b.yield || 0) - (a.yield || 0),
          pe: (a, b) => (a.pe == null ? 9e9 : a.pe) - (b.pe == null ? 9e9 : b.pe),
          pos: (a, b) => (a.pos250 == null ? 2 : a.pos250) - (b.pos250 == null ? 2 : b.pos250),
          pct5: (a, b) => (b.pct5 == null ? -9 : b.pct5) - (a.pct5 == null ? -9 : a.pct5),
        }[sortKey]
        return arr.sort(cmp)
      }, [div, sortKey])

      return h('div', null,
        h('div', { style: styles.strip },
          h(Stat, { label: t('divCount'), value: div.count || 0 }),
          h(Stat, { label: t('divMedianYield'), value: fmtRatio(div.median_yield), color: UP }),
          h(Stat, { label: t('divMedianPe'), value: fmtNum(div.median_pe) }),
          h(Stat, { label: t('divMedianPb'), value: fmtNum(div.median_pb, 2) }),
          h(Stat, { label: t('marketUp'), value: div.up == null ? '—' : div.up, color: UP }),
          h(Stat, { label: t('marketDown'), value: div.down == null ? '—' : div.down, color: DOWN })),
        h('div', { style: styles.hint }, t('divHint')),
        h('div', { style: styles.toolbar },
          h('select', { style: styles.select, value: sortKey, onChange: (e) => setSortKey(e.target.value) },
            h('option', { value: 'yield' }, t('divYield')),
            h('option', { value: 'pe' }, 'PE'),
            h('option', { value: 'pos' }, t('divPos')),
            h('option', { value: 'pct5' }, t('cyclePct5')))),
        rows.length === 0
          ? h('div', { style: styles.empty }, t('divEmpty'))
          : h('div', { style: styles.tableBox },
              h('div', { style: { ...styles.rowHead, gridTemplateColumns: DIV_COLS } },
                h('span', null, '代码'), h('span', null, '名称'), h('span', null, t('divIndustry')),
                h('span', { style: styles.right }, t('divYield')),
                h('span', { style: styles.right }, 'PE'), h('span', { style: styles.right }, 'PB'),
                h('span', { style: styles.right }, t('divPos')),
                h('span', { style: styles.right }, t('divTimes'))),
              rows.map((r) => h('div', { key: r.code, style: { ...styles.row, ...styles.rowStatic, gridTemplateColumns: DIV_COLS } },
                h('span', { style: styles.mono }, r.code),
                h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  r.name, r.cyclic ? h('span', { style: { ...styles.chip, marginLeft: 6 } }, t('divCyclic')) : null),
                h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-secondary)' } }, r.industry),
                h('span', { style: { ...styles.right, color: UP, fontWeight: 650 } }, fmtRatio(r.yield)),
                h('span', { style: styles.right }, fmtNum(r.pe)),
                h('span', { style: styles.right }, fmtNum(r.pb, 2)),
                h('span', { style: styles.right }, fmtRatio(r.pos250)),
                h('span', { style: styles.right }, r.times)))))
    }

    const ETF_URL = '/api/sector-board/etf.json'
    const GLOBAL_URL = '/api/sector-board/global.json'
    const SEARCH_URL = '/api/sector-board/search'
    const QUOTES_URL = '/api/sector-board/quotes.json'
    const PAPER_URL = '/api/sector-board/paper.json'
    const PAPER_DECIDE_URL = '/api/sector-board/paper/decide'
    const ROBOT_URL = '/api/sector-board/robot/run'
    const PAPER_INIT_URL = '/api/sector-board/paper/init'
    const EVENTS_URL = '/api/sector-board/events.json'
    const STOCK_URL = '/api/sector-board/stock.json'

    async function fetchJson(url, opts) {
      const res = await fetch(url, { cache: 'no-store', ...(opts || {}) })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      return body
    }

    function useQuoteMap(codes) {
      const [map, setMap] = useState({})
      const key = codes.join(',')
      useEffect(() => {
        if (!key) return undefined
        let alive = true
        const tick = async () => {
          try {
            const b = await fetchJson(`${QUOTES_URL}?codes=${encodeURIComponent(key)}`)
            if (!alive) return
            const m = {}
            for (const q of b.rows || []) if (q.price != null) m[q.code] = q
            setMap(m)
          } catch { /* keep last */ }
        }
        tick()
        const id = setInterval(tick, 10000)
        return () => { alive = false; clearInterval(id) }
      }, [key])
      return map
    }

    function SearchBox({ t, onPick }) {
      const [q, setQ] = useState('')
      const [rows, setRows] = useState([])
      const [open, setOpen] = useState(false)
      useEffect(() => {
        const query = q.trim()
        if (!query) { setRows([]); return undefined }
        let alive = true
        const id = setTimeout(async () => {
          try {
            const b = await fetchJson(`${SEARCH_URL}?q=${encodeURIComponent(query)}`)
            if (!alive) return
            setRows(b.rows || [])
            setOpen(true)
          } catch { /* ignore */ }
        }, 160)
        return () => { alive = false; clearTimeout(id) }
      }, [q])
      const pick = (r) => { onPick(r); setQ(''); setRows([]); setOpen(false) }
      return h('div', { style: styles.searchBox },
        h('input', {
          style: styles.input, placeholder: t('searchStock'), value: q,
          onChange: (e) => setQ(e.target.value),
          onFocus: () => { if (rows.length) setOpen(true) },
          onBlur: () => setTimeout(() => setOpen(false), 180),
        }),
        open && rows.length ? h('div', { style: styles.dropdown },
          rows.map((r) => h('button', {
            key: `${r.type}-${r.code}`, type: 'button', style: styles.dropItem,
            onMouseDown: (e) => { e.preventDefault(); pick(r) },
          },
            h('span', { style: { fontWeight: 600, whiteSpace: 'nowrap' } }, r.name),
            h('span', { style: { ...styles.mono, fontSize: 11 } }, r.code),
            h('span', { style: styles.badge },
              r.type === 'board' ? `${t('boardTag')} · ${r.industry}` : r.type === 'etf' ? t('etfTag') : r.type === 'global' ? r.group : (r.industry || t('stockTag')))))) : null)
    }

    function DetailDrawer({ pick, t, onTech, onClose }) {
      const [q, setQ] = useState(null)
      const [err, setErr] = useState('')
      useEffect(() => {
        let alive = true
        setQ(null)
        setErr('')
        fetchJson(`${QUOTES_URL}?codes=${encodeURIComponent(pick.code)}`)
          .then((b) => { if (alive) setQ((b.rows || [])[0] || null) })
          .catch((e) => { if (alive) setErr(String(e.message || e)) })
        return () => { alive = false }
      }, [pick])
      const up = q && q.pct != null && q.pct > 0
      const sub = [pick.code, pick.industry, pick.group, pick.cat].filter(Boolean).join(' · ')
      const canTech = pick.type !== 'board' && /^(sh|sz|bj)?\d{6}$/i.test(String(pick.code || ''))
      return h('div', { style: styles.drawer },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' } },
          h('div', null,
            h('div', { style: { fontSize: 16, fontWeight: 650 } }, pick.name),
            h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginTop: 3 } }, sub)),
          h('div', { style: { display: 'flex', gap: 6 } },
            onTech && canTech ? h('button', { type: 'button', style: styles.btn, onClick: () => onTech(pick) }, t('techBtn')) : null,
            h('button', { type: 'button', style: styles.btn, onClick: onClose }, t('close')))),
        err ? h('div', { style: { ...styles.errorBox, marginTop: 10 } }, err) : null,
        !q && !err ? h('div', { style: styles.empty }, t('loading')) : null,
        q && q.price == null ? h('div', { style: styles.empty }, t('noQuote')) : null,
        q && q.price != null ? h('div', { style: { marginTop: 12 } },
          h('div', { style: { fontSize: 30, fontWeight: 700, color: up ? UP : q.pct < 0 ? DOWN : 'inherit' } }, fmtNum(q.price, 3)),
          h('div', { style: { fontSize: 14, marginTop: 2, color: up ? UP : q.pct < 0 ? DOWN : 'inherit' } }, `${fmtNum(q.chg, 3)}  ${fmtPct(q.pct)}`),
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 14, fontSize: 12 } },
            [['prev', t('prevClose')], ['open', t('open')], ['high', t('high')], ['low', t('low')]].map(([k, label]) =>
              h('div', { key: k, style: styles.kpi }, h('span', null, label), h('span', { style: styles.kpiVal }, fmtNum(q[k], 3)))),
            h('div', { style: styles.kpi }, h('span', null, t('quoteTime')), h('span', { style: styles.kpiVal }, q.time || '—')),
            h('div', { style: styles.kpi }, h('span', null, t('quoteSource')), h('span', { style: styles.kpiVal }, q.source || '—')))) : null)
    }

    function EtfView({ t, onOpen }) {
      const [doc, setDoc] = useState(null)
      const [err, setErr] = useState('')
      const [cat, setCat] = useState('')
      const [q, setQ] = useState('')
      const [sort, setSort] = useState('amount')
      useEffect(() => {
        let alive = true
        fetchJson(ETF_URL).then((b) => { if (alive) setDoc(b) }).catch((e) => { if (alive) setErr(String(e.message || e)) })
        return () => { alive = false }
      }, [])
      const rows = useMemo(() => {
        if (!doc) return []
        const kw = q.trim()
        const list = (doc.rows || []).filter((r) => (!cat || r.cat === cat) && (!kw || r.name.includes(kw) || r.code.includes(kw)))
        const sorter = sort === 'pct5' ? (a, b) => (b.pct5 ?? -9) - (a.pct5 ?? -9)
          : sort === 'pct20' ? (a, b) => (b.pct20 ?? -9) - (a.pct20 ?? -9)
            : sort === 'pos' ? (a, b) => (a.pos250 ?? 9) - (b.pos250 ?? 9)
              : (a, b) => (b.amount ?? 0) - (a.amount ?? 0)
        return [...list].sort(sorter)
      }, [doc, cat, q, sort])
      const codes = useMemo(() => rows.slice(0, 140).map((r) => r.symbol), [rows])
      const quotes = useQuoteMap(codes)
      if (err) return h('div', { style: styles.errorBox }, err)
      if (!doc) return h('div', { style: styles.empty }, t('loading'))
      const cats = doc.categories || []
      return h('div', null,
        h('div', { style: styles.toolbar },
          h('button', { type: 'button', style: { ...styles.pill, ...(cat === '' ? styles.navActive : null) }, onClick: () => setCat('') },
            t('allCat'), h('span', { style: styles.mono }, doc.total)),
          cats.map((c) => h('button', {
            key: c.name, type: 'button',
            style: { ...styles.pill, ...(cat === c.name ? styles.navActive : null) },
            onClick: () => setCat(c.name === cat ? '' : c.name),
          }, c.name, h('span', { style: styles.mono }, c.count)))),
        h('div', { style: styles.toolbar },
          h('input', {
            style: styles.input, placeholder: t('searchEtf'), value: q,
            onChange: (e) => setQ(e.target.value),
          }),
          h('select', { style: styles.select, value: sort, onChange: (e) => setSort(e.target.value) },
            h('option', { value: 'amount' }, t('sortAmount')),
            h('option', { value: 'pct5' }, t('sort5')),
            h('option', { value: 'pct20' }, t('sort20')),
            h('option', { value: 'pos' }, t('sortPos'))),
          h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, t('etfLive'))),
        !rows.length ? h('div', { style: styles.empty }, t('noMatch')) : null,
        rows.length ? h('div', { style: styles.tableBox },
          h('div', { style: { ...styles.rowHead, gridTemplateColumns: '1.6fr 64px 56px 68px 64px 60px 60px 58px 76px' } },
            h('span', null, t('colName')), h('span', null, t('colCode')), h('span', null, t('colCat')),
            h('span', { style: styles.right }, t('colPrice')), h('span', { style: styles.right }, t('colPct')),
            h('span', { style: styles.right }, t('col5')), h('span', { style: styles.right }, t('col20')),
            h('span', { style: styles.right }, t('colPos')), h('span', { style: styles.right }, t('colAmount'))),
          rows.map((r) => {
            const qq = quotes[r.symbol]
            const price = qq ? qq.price : r.price
            const pct = qq ? qq.pct : r.pct
            return h('div', {
              key: r.code, style: { ...styles.row, gridTemplateColumns: '1.6fr 64px 56px 68px 64px 60px 60px 58px 76px' },
              onClick: () => onOpen({ code: r.symbol, name: r.name, cat: r.cat, type: 'etf' }),
            },
              h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, r.name),
              h('span', { style: styles.mono }, r.code),
              h('span', { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)' } }, r.cat),
              h('span', { style: styles.right }, fmtNum(price, 3)),
              h('span', { style: { ...styles.right, color: tone(pct) } }, fmtPct(pct)),
              h('span', { style: { ...styles.right, color: tone(r.pct5) } }, fmtPct(r.pct5 == null ? null : r.pct5 * 100)),
              h('span', { style: { ...styles.right, color: tone(r.pct20) } }, fmtPct(r.pct20 == null ? null : r.pct20 * 100)),
              h('span', { style: styles.right }, fmtRatio(r.pos250)),
              h('span', { style: styles.right }, fmtMoney(r.amount)))
          })) : null,
        h('div', { style: styles.hint }, doc.as_of ? `${t('etfAsOf')} ${doc.as_of} · ${t('etfHint')}` : t('etfHint')))
    }

    function GlobalView({ t, onOpen }) {
      const [doc, setDoc] = useState(null)
      const [err, setErr] = useState('')
      useEffect(() => {
        let alive = true
        const tick = () => fetchJson(GLOBAL_URL)
          .then((b) => { if (alive) setDoc(b) })
          .catch((e) => { if (alive) setErr(String(e.message || e)) })
        tick()
        const id = setInterval(tick, 10000)
        return () => { alive = false; clearInterval(id) }
      }, [])
      if (err) return h('div', { style: styles.errorBox }, err)
      if (!doc) return h('div', { style: styles.empty }, t('loading'))
      const groups = {}
      for (const it of doc.items || []) (groups[it.group] = groups[it.group] || []).push(it)
      return h('div', null,
        h('div', { style: styles.hint }, t('globalHint')),
        ['A股指数', '港股指数', '美股指数', '日股', '韩股', '欧股', '美股', '港股', '商品', '外汇'].map((g) =>
          groups[g] ? h('div', { key: g, style: { marginBottom: 12 } },
            h('div', { style: styles.sectionTitle }, g),
            h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))', gap: 8 } },
              groups[g].map((it) => h('button', {
                key: it.code, type: 'button', style: styles.card,
                onClick: () => onOpen({ code: it.code, name: it.name, group: it.group, type: 'global' }),
              },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 6, alignItems: 'baseline' } },
                  h('span', { style: { fontSize: 12.5, fontWeight: 600 } }, it.name),
                  h('span', { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)' } }, it.group)),
                h('div', { style: { fontSize: 18, fontWeight: 650, marginTop: 4, color: it.pct == null ? 'inherit' : tone(it.pct) } }, fmtNum(it.price, it.price != null && it.price > 1000 ? 2 : 3)),
                h('div', { style: { fontSize: 11.5, color: tone(it.pct), marginTop: 1 } }, `${fmtPct(it.pct)}`))))) : null),
        h('div', { style: styles.hint }, t('globalNote')))
    }

    function PaperView({ t }) {
      const [doc, setDoc] = useState(null)
      const [err, setErr] = useState('')
      const [busy, setBusy] = useState(false)
      const load = useCallback(async () => {
        try {
          setDoc(await fetchJson(PAPER_URL))
        } catch (e) { setErr(String(e.message || e)) }
      }, [])
      useEffect(() => {
        load()
        const id = setInterval(load, 10000)
        return () => clearInterval(id)
      }, [load])
      const run = useCallback(async (url) => {
        setBusy(true)
        setErr('')
        try {
          const b = await fetchJson(url, { method: 'POST' })
          if (!b.ok) setErr(b.error || t('error'))
          else if (b.account) setDoc(b.account)
          setTimeout(() => { load(); setBusy(false) }, 3500)
        } catch (e) { setErr(String(e.message || e)); setBusy(false) }
      }, [t])
      if (err) return h('div', { style: styles.errorBox }, err)
      if (!doc) return h('div', { style: styles.empty }, t('loading'))
      const up = (doc.pnl_pct || 0) >= 0
      const head = h('div', { style: styles.toolbar },
        h('button', {
          type: 'button', style: { ...styles.btn, opacity: busy ? 0.6 : 1 }, disabled: busy,
          onClick: () => run(ROBOT_URL),
        }, busy ? t('running') : t('robotRun')),
        h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, t('paperAuto')),
        h('span', { style: { flex: 1 } }),
        doc.updated_at ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, `${t('updated')} ${String(doc.updated_at).slice(0, 16).replace('T', ' ')}`) : null)
      if (!doc.exists) {
        return h('div', null, head, h('div', { style: styles.empty }, t('paperEmpty')))
      }
      const kpis = [
        [t('paperNav'), fmtNum(doc.nav, 2), null],
        [t('paperPnl'), fmtPct(doc.pnl_pct), up ? UP : DOWN],
        [t('paperCash'), fmtNum(doc.cash, 2), null],
        [t('paperMv'), fmtNum(doc.mv, 2), null],
      ]
      return h('div', null,
        head,
        h('div', { style: styles.strip }, kpis.map(([label, value, color]) =>
          h('div', { key: label, style: styles.stat },
            h('div', { style: styles.statLabel }, label),
            h('div', { style: { ...styles.statValue, color: color || 'inherit' } }, value)))),
        (() => {
          const rb = doc.robot || {}
          const last = (doc.decisions || [])[0]
          const orders = (last && last.orders) || []
          const executed = (last && last.executed) || []
          const rejected = (last && last.rejected) || []
          const watch = (last && last.watch) || []
          return h('div', { style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, padding: '10px 12px', background: 'var(--dsw-alias-bg-layer-1)', margin: '10px 0' } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
              h('span', { style: { fontSize: 13, fontWeight: 600 } }, t('robotTitle')),
              h('span', { style: { ...styles.badge, background: (rb.mode || '').startsWith('opencode') ? UP : 'var(--dsw-alias-border-l1)' } }, rb.mode || 'rules'),
              rb.model ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, rb.model) : null,
              h('span', { style: { flex: 1 } }),
              h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
                `${t('robotNext')} ${rb.next_run || '-'}`)),
            h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginTop: 6 } },
              `${t('robotLast')} ${rb.last_run ? String(rb.last_run).slice(0, 16).replace('T', ' ') : '-'}${rb.note ? ' · ' + rb.note : ''}`),
            last ? h('div', { style: { fontSize: 12, marginTop: 8, lineHeight: 1.7 } },
              h('span', { style: styles.badge }, last.date), ' ', last.summary,
              executed.length ? h('div', { style: { marginTop: 4 } }, executed.map((x, i) => h('div', { key: i },
                '· ', x.side === 'buy' ? t('buy') : t('sell'), ' ', x.name, ' ', x.qty, ' @', x.price,
                h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, ' — ', x.reason || ''))))
                : h('div', { style: { marginTop: 4, color: 'var(--dsw-alias-label-secondary)' } }, t('robotNoAction')),
              rejected.length ? h('div', { style: { marginTop: 4, color: 'var(--dsw-alias-label-secondary)' } },
                t('robotRejected'), '：', rejected.map((x) => `${x.code} ${x.why}`).join('；')) : null,
              watch.length ? h('div', { style: { marginTop: 4 } }, t('robotWatch'), '：', watch.map((c) => h('span', { key: c, style: { ...styles.badge, marginRight: 4 } }, c))) : null) : null)
        })(),
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
          h('div', { style: styles.sectionTitle }, t('paperEquity')),
          h('span', { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)' } }, doc.equity.length ? doc.equity[0].date + ' → ' + doc.equity[doc.equity.length - 1].date : '')),
        doc.equity.length > 1 ? h('div', { style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, padding: 8, background: 'var(--dsw-alias-bg-layer-1)' } }, h(EquityCurve, { points: doc.equity })) : null,
        h('div', { style: styles.hint }, t('paperRobot')),
        h('div', { style: styles.hint }, t('paperHint')),
        h('div', { style: styles.sectionTitle }, `${t('paperPositions')} · ${doc.positions.length}`),
        doc.positions.length ? h('div', { style: styles.tableBox },
          h('div', { style: { ...styles.rowHead, gridTemplateColumns: '1.5fr 70px 60px 64px 64px 60px 76px 80px' } },
            h('span', null, t('colName')), h('span', { style: styles.right }, t('colQty')),
            h('span', { style: styles.right }, t('colCost')), h('span', { style: styles.right }, t('colPrice')),
            h('span', { style: styles.right }, t('colPct')), h('span', { style: styles.right }, t('colMv')),
            h('span', { style: styles.right }, t('colPnl')), h('span', { style: styles.right }, t('colPnlPct'))),
          doc.positions.map((p) => h('div', {
            key: p.code, style: { ...styles.row, gridTemplateColumns: '1.5fr 70px 60px 64px 64px 60px 76px 80px' },
          },
            h('span', null, p.name, h('span', { style: { ...styles.mono, fontSize: 10, marginLeft: 6 } }, p.code)),
            h('span', { style: styles.right }, p.qty),
            h('span', { style: styles.right }, fmtNum(p.cost, 3)),
            h('span', { style: styles.right }, fmtNum(p.price, 3)),
            h('span', { style: { ...styles.right, color: tone(p.pct) } }, fmtPct(p.pct)),
            h('span', { style: styles.right }, fmtNum(p.mv, 2)),
            h('span', { style: { ...styles.right, color: tone(p.pnl) } }, fmtNum(p.pnl, 2)),
            h('span', { style: { ...styles.right, color: tone(p.pnl) } }, fmtPct(p.pnl_pct))))) : h('div', { style: styles.empty }, t('paperNoPos')),
        h('div', { style: styles.sectionTitle }, t('paperDecisions')),
        !doc.decisions.length ? h('div', { style: styles.empty }, t('paperNoDecisions')) :
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            doc.decisions.map((d, i) => h('details', { key: `${d.at}-${i}`, style: styles.decision },
              h('summary', { style: { cursor: 'pointer', fontSize: 12 } },
                h('span', { style: styles.badge }, d.date),
                h('span', { style: { marginLeft: 8, color: d.action === 'trade' ? UP : 'var(--dsw-alias-label-secondary)' } }, d.action === 'trade' ? t('actionTrade') : t('actionHold')),
                h('span', { style: { marginLeft: 8, color: 'var(--dsw-alias-label-secondary)' } }, d.summary)),
              h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginTop: 6, lineHeight: 1.7 } },
                (d.detail || []).map((x, j) => h('div', { key: j }, '· ', x)),
                (d.mode ? h('div', { key: 'mode' }, '· ', `mode=${d.mode}${d.model ? ' · ' + d.model : ''}${d.note ? ' · ' + d.note : ''}`) : null),
                (d.executed || []).map((x, j) => h('div', { key: 'x' + j }, '· ', `${x.side === 'buy' ? '买入' : '卖出'} ${x.name} ${x.qty} @${x.price} — ${x.reason || ''}`)),
                (d.rejected || []).map((x, j) => h('div', { key: 'r' + j, style: { color: 'var(--dsw-alias-label-secondary)' } }, '· 拒绝 ', x.code, '：', x.why)),
                h('div', { style: { marginTop: 4 } }, `NAV ${fmtNum(d.nav, 2)} · ${t('paperCash')} ${fmtNum(d.cash, 2)}`))))),
        doc.trades.length ? h('div', null,
          h('div', { style: styles.sectionTitle }, t('paperTrades')),
          h('div', { style: styles.tableBox },
            h('div', { style: { ...styles.rowHead, gridTemplateColumns: '64px 52px 1.4fr 70px 72px 80px' } },
              h('span', null, t('colDate')), h('span', null, t('colSide')), h('span', null, t('colName')),
              h('span', { style: styles.right }, t('colQty')), h('span', { style: styles.right }, t('colPrice')),
              h('span', { style: styles.right }, t('colAmount'))),
            doc.trades.map((x, i) => h('div', {
              key: i, style: { ...styles.row, gridTemplateColumns: '64px 52px 1.4fr 70px 72px 80px' },
            },
              h('span', { style: styles.mono }, x.date),
              h('span', { style: { color: x.side === 'buy' ? UP : DOWN } }, x.side === 'buy' ? t('buy') : t('sell')),
              h('span', null, x.name), h('span', { style: styles.right }, x.qty),
              h('span', { style: styles.right }, fmtNum(x.price, 3)),
              h('span', { style: styles.right }, fmtNum(x.amount, 2)))))) : null)
    }

    /* ---------------- v1.5：主题周期 / 信息日历 / 技术分析 ---------------- */

    function KlineChart({ doc }) {
      const [hover, setHover] = useState(null)
      const bars = (doc && doc.bars) || []
      if (bars.length < 5) return null
      const n = bars.length
      const ma = doc.ma || {}
      const boll = doc.boll || {}
      const macd = doc.macd || {}
      const volma5 = doc.volma5 || []
      const W = 860, padL = 6, padR = 56, top = 8
      const priceH = 300, volH = 54, macdH = 64, gap = 8
      const priceTop = top
      const volTop = priceTop + priceH + gap
      const macdTop = volTop + volH + gap
      const H = macdTop + macdH + 18
      const iw = W - padL - padR
      const x = (i) => padL + (i / Math.max(1, n - 1)) * iw
      const vals = []
      bars.forEach((b) => { vals.push(b.l, b.h) })
      ;['ma5', 'ma10', 'ma20', 'ma60'].forEach((k) => (ma[k] || []).forEach((v) => { if (v != null) vals.push(v) }))
      ;['up', 'low'].forEach((k) => (boll[k] || []).forEach((v) => { if (v != null) vals.push(v) }))
      const max = Math.max(...vals), min = Math.min(...vals)
      const span = max - min || 1
      const y = (v) => priceTop + ((max - v) / span) * priceH
      const bw = Math.max(1, (iw / n) * 0.6)
      const nodes = []
      ;[0, 0.25, 0.5, 0.75, 1].forEach((f) => {
        const v = max - f * span
        nodes.push(h('line', { key: 'g' + f, x1: padL, x2: W - padR, y1: y(v), y2: y(v), stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 0.6, strokeDasharray: '3 3' }))
        nodes.push(h('text', { key: 'gt' + f, x: W - padR + 4, y: y(v) + 3, fontSize: 9.5, fill: 'var(--dsw-alias-label-secondary)' }, v.toFixed(2)))
      })
      // BOLL 带
      ;[['up', 'up', 'rgba(148,163,184,.55)'], ['low', 'low', 'rgba(148,163,184,.55)']].forEach(([k, key, col]) => {
        let d = ''
        ;(boll[k] || []).forEach((v, i) => { if (v == null) return; d += (d ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1) })
        if (d) nodes.push(h('path', { key: 'bo' + key, d, fill: 'none', stroke: col, strokeWidth: 0.9, strokeDasharray: '4 3' }))
      })
      bars.forEach((b, i) => {
        const up = b.c >= b.o
        const col = up ? UP : DOWN
        const yO = y(b.o), yC = y(b.c)
        nodes.push(h('line', { key: 'w' + i, x1: x(i), x2: x(i), y1: y(b.h), y2: y(b.l), stroke: col, strokeWidth: 1 }))
        nodes.push(h('rect', { key: 'b' + i, x: x(i) - bw / 2, y: Math.min(yO, yC), width: bw, height: Math.max(1, Math.abs(yO - yC)), fill: col }))
      })
      ;[['ma5', '#f59e0b'], ['ma10', '#38bdf8'], ['ma20', '#a78bfa'], ['ma60', '#94a3b8']].forEach(([k, col]) => {
        let d = ''
        ;(ma[k] || []).forEach((v, i) => { if (v == null) return; d += (d ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1) })
        if (d) nodes.push(h('path', { key: k, d, fill: 'none', stroke: col, strokeWidth: 1.2, opacity: 0.95 }))
      })
      // 最新价线
      const last = bars[n - 1]
      nodes.push(h('line', { key: 'lastp', x1: padL, x2: W - padR, y1: y(last.c), y2: y(last.c), stroke: tone(last.c - last.o), strokeWidth: 0.7, strokeDasharray: '2 4', opacity: 0.8 }))
      // 成交量
      const vmax = Math.max(1, ...bars.map((b) => b.v))
      bars.forEach((b, i) => {
        const hh = Math.max(1, (b.v / vmax) * (volH - 2))
        nodes.push(h('rect', { key: 'v' + i, x: x(i) - bw / 2, y: volTop + volH - hh, width: bw, height: hh, fill: b.c >= b.o ? UP : DOWN, opacity: 0.5 }))
      })
      let vd = ''
      ;volma5.forEach((v, i) => { if (v == null) return; vd += (vd ? 'L' : 'M') + x(i).toFixed(1) + ' ' + (volTop + volH - (v / vmax) * (volH - 2)).toFixed(1) })
      if (vd) nodes.push(h('path', { key: 'vma', d: vd, fill: 'none', stroke: '#fbbf24', strokeWidth: 0.9, opacity: 0.85 }))
      nodes.push(h('text', { key: 'vl', x: padL, y: volTop - 3, fontSize: 9.5, fill: 'var(--dsw-alias-label-secondary)' }, '成交量 · 黄线 VMA5'))
      // MACD
      const mvals = []
      ;['dif', 'dea', 'hist'].forEach((k) => (macd[k] || []).forEach((v) => { if (v != null) mvals.push(Math.abs(v)) }))
      const mmax = Math.max(0.0001, ...mvals)
      const yM = (v) => macdTop + macdH / 2 - (v / mmax) * (macdH / 2 - 2)
      nodes.push(h('line', { key: 'm0', x1: padL, x2: W - padR, y1: yM(0), y2: yM(0), stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 0.6 }))
      ;(macd.hist || []).forEach((v, i) => {
        if (v == null) return
        const y0 = yM(0), y1 = yM(v)
        nodes.push(h('rect', { key: 'mh' + i, x: x(i) - bw / 2, y: Math.min(y0, y1), width: bw, height: Math.max(0.8, Math.abs(y0 - y1)), fill: v >= 0 ? UP : DOWN, opacity: 0.45 }))
      })
      ;[['dif', '#f59e0b'], ['dea', '#38bdf8']].forEach(([k, col]) => {
        let d = ''
        ;(macd[k] || []).forEach((v, i) => { if (v == null) return; d += (d ? 'L' : 'M') + x(i).toFixed(1) + ' ' + yM(v).toFixed(1) })
        if (d) nodes.push(h('path', { key: k, d, fill: 'none', stroke: col, strokeWidth: 1.1 }))
      })
      nodes.push(h('text', { key: 'ml', x: padL, y: macdTop - 3, fontSize: 9.5, fill: 'var(--dsw-alias-label-secondary)' }, 'MACD(12,26,9) · 红柱为多'))
      // 日期刻度
      const picks = [0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((3 * n) / 4), n - 1]
      picks.forEach((i, k) => nodes.push(h('text', { key: 'd' + k, x: x(i), y: H - 4, fontSize: 9, textAnchor: 'middle', fill: 'var(--dsw-alias-label-secondary)' }, String(bars[i].d).slice(2))))
      // 悬停
      if (hover != null && hover.idx >= 0 && hover.idx < n) {
        const i = hover.idx
        const hx = x(i)
        nodes.push(h('line', { key: 'cx', x1: hx, x2: hx, y1: priceTop, y2: macdTop + macdH, stroke: 'var(--dsw-alias-label-secondary)', strokeWidth: 0.6, strokeDasharray: '3 3' }))
        nodes.push(h('circle', { key: 'cc', cx: hx, cy: y(bars[i].c), r: 2.4, fill: tone(bars[i].c - bars[i].o) }))
      }
      const onMove = (e) => {
        const rect = e.currentTarget.getBoundingClientRect()
        const px = ((e.clientX - rect.left) / rect.width) * W
        const idx = Math.max(0, Math.min(n - 1, Math.round(((px - padL) / iw) * (n - 1))))
        setHover({ idx, left: e.clientX - rect.left, top: e.clientY - rect.top })
      }
      const hv = hover != null && hover.idx >= 0 && hover.idx < n ? bars[hover.idx] : null
      return h('div', { style: { position: 'relative' }, onMouseMove: onMove, onMouseLeave: () => setHover(null) },
        h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 10, color: 'var(--dsw-alias-label-secondary)', marginBottom: 2 } },
          h('span', { style: { color: '#f59e0b' } }, 'MA5'), h('span', { style: { color: '#38bdf8' } }, 'MA10'),
          h('span', { style: { color: '#a78bfa' } }, 'MA20'), h('span', { style: { color: '#94a3b8' } }, 'MA60'),
          h('span', null, '虚线 = 布林上下轨(20,2)')),
        h('svg', { viewBox: '0 0 ' + W + ' ' + H, style: { width: '100%', height: 'auto', display: 'block' } }, nodes),
        hv ? h('div', {
          style: {
            position: 'absolute', left: Math.min(hover.left + 12, 560), top: Math.max(0, hover.top - 10),
            background: 'var(--dsw-alias-bg-overlay)', border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: 8, padding: '7px 9px', fontSize: 10.5, lineHeight: 1.6, pointerEvents: 'none',
            color: 'var(--dsw-alias-label-primary)', boxShadow: '0 6px 18px rgba(0,0,0,.25)', zIndex: 2, minWidth: 132,
          },
        },
          h('div', { style: { fontWeight: 600 } }, hv.d),
          h('div', null, '开 ', fmtNum(hv.o, 2), '  高 ', fmtNum(hv.h, 2)),
          h('div', null, '低 ', fmtNum(hv.l, 2), '  收 ', fmtNum(hv.c, 2)),
          h('div', { style: { color: tone(hv.c - hv.o) } }, '涨跌 ', fmtPct(((hv.c / hv.o) - 1) * 100)),
          h('div', null, '量 ', fmtMoney(hv.v))) : null)
    }


    function MinuteChart({ doc }) {
      const pts = (doc && doc.points) || []
      if (pts.length < 2) return null
      const prev = doc.prev_close || pts[0].p
      const n = pts.length
      const W = 860, padL = 6, padR = 58, top = 8
      const priceH = 300, volH = 54, gap = 10
      const volTop = top + priceH + gap
      const H = volTop + volH + 20
      const iw = W - padL - padR
      const x = (i) => padL + (i / Math.max(1, n - 1)) * iw
      const vals = pts.map((p) => p.p)
      if (prev) vals.push(prev)
      const max = Math.max(...vals), min = Math.min(...vals)
      const pad = (max - min) * 0.05 || 0.01
      const hi = max + pad, lo = min - pad
      const y = (v) => top + ((hi - v) / (hi - lo)) * priceH
      const lastP = pts[n - 1].p
      const col = lastP >= prev ? UP : DOWN
      const nodes = []
      ;[0, 0.25, 0.5, 0.75, 1].forEach((f) => {
        const v = hi - f * (hi - lo)
        nodes.push(h('line', { key: 'g' + f, x1: padL, x2: W - padR, y1: y(v), y2: y(v), stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 0.6, strokeDasharray: '3 3' }))
        nodes.push(h('text', { key: 'gt' + f, x: W - padR + 4, y: y(v) + 3, fontSize: 9.5, fill: 'var(--dsw-alias-label-secondary)' }, v.toFixed(2)))
      })
      // 昨收基准
      nodes.push(h('line', { key: 'prev', x1: padL, x2: W - padR, y1: y(prev), y2: y(prev), stroke: 'var(--dsw-alias-label-secondary)', strokeWidth: 0.7, strokeDasharray: '4 4', opacity: 0.8 }))
      nodes.push(h('text', { key: 'prevt', x: padL + 2, y: y(prev) - 3, fontSize: 9, fill: 'var(--dsw-alias-label-secondary)' }, '昨收 ' + fmtNum(prev, 2)))
      // 价格面积 + 线
      let dArea = '', dLine = '', dAvg = ''
      pts.forEach((p, i) => {
        dLine += (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.p).toFixed(1)
        if (p.avg != null) dAvg += (dAvg ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.avg).toFixed(1)
      })
      dArea = dLine + 'L' + x(n - 1).toFixed(1) + ' ' + (top + priceH) + 'L' + x(0).toFixed(1) + ' ' + (top + priceH) + 'Z'
      nodes.push(h('path', { key: 'area', d: dArea, fill: col, opacity: 0.09 }))
      nodes.push(h('path', { key: 'line', d: dLine, fill: 'none', stroke: col, strokeWidth: 1.5 }))
      if (dAvg) nodes.push(h('path', { key: 'avg', d: dAvg, fill: 'none', stroke: '#f59e0b', strokeWidth: 1 }))
      // 成交量
      const vmax = Math.max(1, ...pts.map((p) => p.v || 0))
      const bw = Math.max(1, (iw / n) * 0.7)
      pts.forEach((p, i) => {
        const hh = Math.max(0.5, ((p.v || 0) / vmax) * (volH - 2))
        const up = p.p >= prev
        nodes.push(h('rect', { key: 'v' + i, x: x(i) - bw / 2, y: volTop + volH - hh, width: bw, height: hh, fill: up ? UP : DOWN, opacity: 0.45 }))
      })
      nodes.push(h('text', { key: 'vl', x: padL, y: volTop - 3, fontSize: 9.5, fill: 'var(--dsw-alias-label-secondary)' }, '分时成交量'))
      // 时间刻度
      const want = ['0930', '1030', '1130', '1400', '1500']
      want.forEach((tt, k) => {
        let idx = pts.findIndex((p) => p.t >= tt)
        if (idx < 0) idx = k === want.length - 1 ? n - 1 : Math.round((k / (want.length - 1)) * (n - 1))
        nodes.push(h('text', { key: 'x' + k, x: Math.min(x(idx), W - padR), y: H - 4, fontSize: 9, textAnchor: 'middle', fill: 'var(--dsw-alias-label-secondary)' }, tt.slice(0, 2) + ':' + tt.slice(2)))
      })
      // 最新点
      nodes.push(h('circle', { key: 'last', cx: x(n - 1), cy: y(lastP), r: 2.6, fill: col }))
      return h('div', null,
        h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 10, color: 'var(--dsw-alias-label-secondary)', marginBottom: 2 } },
          h('span', { style: { color: col } }, '价格'), h('span', { style: { color: '#f59e0b' } }, '均价'), h('span', null, '虚线 = 昨收')),
        h('svg', { viewBox: '0 0 ' + W + ' ' + H, style: { width: '100%', height: 'auto', display: 'block' } }, nodes))
    }

    function TechDrawer({ pick, t, onClose }) {
      const [period, setPeriod] = useState('day')
      const [doc, setDoc] = useState(null)
      const [err, setErr] = useState('')
      useEffect(() => {
        let alive = true
        setDoc(null)
        setErr('')
        fetchJson(STOCK_URL + '?code=' + encodeURIComponent(pick.code) + '&period=' + period)
          .then((b) => { if (!alive) return; if (b.error) setErr(b.error); else setDoc(b) })
          .catch((e) => { if (alive) setErr(String(e.message || e)) })
        return () => { alive = false }
      }, [pick.code, period])
      const q = (doc && doc.quote) || {}
      const bars = (doc && doc.bars) || []
      const last = bars.length ? bars[bars.length - 1] : null
      const sm = (doc && doc.summary) || {}
      const lv = sm.last || {}
      const levels = sm.levels || {}
      const kdj = doc && doc.kdj ? { k: doc.kdj.k[doc.kdj.k.length - 1], d: doc.kdj.d[doc.kdj.d.length - 1], j: doc.kdj.j[doc.kdj.j.length - 1] } : {}
      const r6 = doc && doc.rsiAll && doc.rsiAll.r6 && doc.rsiAll.r6.length ? doc.rsiAll.r6[doc.rsiAll.r6.length - 1] : null
      const toneScore = sm.score == null ? 'var(--dsw-alias-label-secondary)' : sm.score >= 75 ? UP : sm.score >= 60 ? '#f59e0b' : sm.score >= 45 ? 'var(--dsw-alias-label-secondary)' : DOWN
      const cell = (label, value, color) => h('div', { style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, padding: '7px 9px', background: 'var(--dsw-alias-bg-layer-1)' } },
        h('div', { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)' } }, label),
        h('div', { style: { fontSize: 13, fontWeight: 600, color: color || 'inherit', marginTop: 2 } }, value))
      return h('div', { style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 60, display: 'flex', justifyContent: 'flex-end' }, onClick: onClose },
        h('div', {
          style: { width: 'min(980px, 97vw)', height: '100%', overflow: 'auto', background: 'var(--dsw-alias-bg-base)', borderLeft: '1px solid var(--dsw-alias-border-l2)', padding: 16 },
          onClick: (e) => e.stopPropagation(),
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' } },
            h('div', { style: { fontSize: 17, fontWeight: 650 } }, pick.name || pick.code,
              h('span', { style: { ...styles.mono, fontSize: 11, marginLeft: 6, color: 'var(--dsw-alias-label-secondary)' } }, pick.code)),
            h('span', { style: { flex: 1 } }),
            h('button', { type: 'button', style: styles.btn, onClick: onClose }, t('close'))),
          err ? h('div', { style: styles.errorBox }, err) : null,
          !doc && !err ? h('div', { style: styles.empty }, t('loading')) : null,
          doc ? h('div', null,
            h('div', { style: { display: 'flex', gap: 14, alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 6 } },
              h('span', { style: { fontSize: 28, fontWeight: 700 } }, q.price != null ? fmtNum(q.price, 3) : (last ? fmtNum(last.c, 2) : '—')),
              h('span', { style: { fontSize: 15, fontWeight: 600, color: tone(q.pct) } }, q.pct != null ? fmtPct(q.pct) : ''),
              last ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, last.d) : (doc.date ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, String(doc.date)) : null),
              q.time ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, t('quoteTime') + ' ' + q.time) : null,
              q.time ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, t('quoteTime') + ' ' + q.time) : null,
              h('span', { style: { flex: 1 } }),
              sm.score != null ? h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 6 } },
                h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, t('techScore')),
                h('span', { style: { fontSize: 24, fontWeight: 700, color: toneScore } }, sm.score),
                h('span', { style: { fontSize: 12, fontWeight: 600, color: toneScore } }, sm.label || '')) : null),
            h('div', { style: { display: 'flex', gap: 6, margin: '4px 0 8px' } },
              [['min', 'techMinute'], ['day', 'techDaily'], ['week', 'techWeekly'], ['month', 'techMonthly']].map(([k, lab]) => h('button', {
                key: k, type: 'button',
                style: { ...styles.pill, ...(period === k ? { borderColor: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-brand-primary)' } : null) },
                onClick: () => setPeriod(k),
              }, t(lab)))),
            (sm.signals || []).length ? h('div', { style: { display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 8 } },
              sm.signals.map((sg) => h('span', { key: sg, style: styles.chip }, sg))) : null,
            period === 'min' ? h('div', null,
              h('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11.5, margin: '2px 0 8px', color: 'var(--dsw-alias-label-secondary)' } },
                [['开盘', doc.open], ['最高', doc.high], ['最低', doc.low], ['均价', doc.last && doc.last.avg], ['成交额', q.amount]].map(([lab, val]) => (
                  h('span', { key: lab },
                    h('span', { style: { opacity: 0.75 } }, lab + ' '),
                    h('span', { style: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600 } }, lab === '成交额' ? fmtMoney((val || 0) * 1e4) : fmtNum(val, 2)))
                ))),
              h(MinuteChart, { doc })
            ) : h(KlineChart, { doc }),
            period === 'min' ? null : h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))', gap: 6, marginTop: 10 } },
              cell('MA5 距离', lv.ma5 && last ? fmtPct((last.c / lv.ma5 - 1) * 100) : '—', lv.ma5 && last ? tone(last.c - lv.ma5) : null),
              cell('MA10 距离', lv.ma10 && last ? fmtPct((last.c / lv.ma10 - 1) * 100) : '—', lv.ma10 && last ? tone(last.c - lv.ma10) : null),
              cell('MA20 距离', lv.ma20 && last ? fmtPct((last.c / lv.ma20 - 1) * 100) : '—', lv.ma20 && last ? tone(last.c - lv.ma20) : null),
              cell('MA60 距离', lv.ma60 && last ? fmtPct((last.c / lv.ma60 - 1) * 100) : '—', lv.ma60 && last ? tone(last.c - lv.ma60) : null),
              cell('RSI6 / RSI14', fmtNum(r6, 0) + ' / ' + fmtNum(lv.rsi, 1)),
              cell('KDJ', kdj.k == null ? '—' : `${fmtNum(kdj.k, 0)} / ${fmtNum(kdj.d, 0)} / ${fmtNum(kdj.j, 0)}`),
              cell('布林上/中/下', [lv.bollUp, lv.bollMid, lv.bollLow].map((v) => v == null ? '—' : fmtNum(v, 2)).join(' / ')),
              cell('ATR14', lv.atr == null ? '—' : `${fmtNum(lv.atr, 2)}（${last ? ((lv.atr / last.c) * 100).toFixed(1) : '—'}%）`),
              cell('1 年位置', sm.pos == null ? '—' : fmtRatio(sm.pos)),
              cell('20 日高/低', `${fmtNum(levels.h20, 2)} / ${fmtNum(levels.l20, 2)}`),
              cell('60 日高/低', `${fmtNum(levels.h60, 2)} / ${fmtNum(levels.l60, 2)}`),
              cell('120 日高/低', `${fmtNum(levels.h120, 2)} / ${fmtNum(levels.l120, 2)}`)),
            period === 'min' ? null : h('div', { style: { marginTop: 10, padding: '10px 12px', borderRadius: 10, background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)' } },
              h('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 4 } }, t('techNotes')),
              (sm.notes || []).map((x, i) => h('div', { key: i, style: { fontSize: 11.5, lineHeight: 1.75, color: 'var(--dsw-alias-label-secondary)' } }, `· ${x}`))),
            period === 'min' ? h('div', { style: { ...styles.hint, marginTop: 8 } }, '分时数据来自腾讯，约 3–15 秒延迟；不显示指标，指标看日/周/月线。') : h('div', { style: { ...styles.hint, marginTop: 8 } }, t('techHint'))) : null))
    }

    function themeComment(tm) {
      if (!tm) return ''
      if (tm.kind === 'index') return tm.desc || ''
      const small = tm.pos250_med, big = tm.pos1250_med
      const parts = []
      parts.push(tm.name + '当前' + (tm.stage || '—') + '：小周期 ' + (small == null ? '—' : fmtRatio(small)) + '，大周期 ' + (big == null ? '—' : fmtRatio(big)) + '。')
      const sg = tm.stage
      if (sg === '底部') parts.push('位置在 1 年与 5 年区间的下沿，赔率更好，但需要催化（政策、价格拐点或放量）；没有催化时容易在底部反复磨。')
      else if (sg === '顶部') parts.push('大小周期都在高位，趋势仍可能延续，但性价比下降；追高要设好止损，关注量能是否背离。')
      else if (sg === '上行') parts.push('大周期不高、小周期已经抬升，属于修复初期；如果行业基本面（价格/订单/政策）同步改善，持续性会更好。')
      else if (sg === '下行') parts.push('大周期仍高、小周期已经走弱，属于高位回落；反弹先当修复，不要急着判断反转。')
      else parts.push('大小周期位置错位，方向不明；更适合等区间突破或回踩确认，而不是提前押注。')
      if (tm.character === '强周期') parts.push('这是强周期行业，核心变量是产品价格与产能周期，股价通常领先基本面 1–2 个季度。')
      else if (tm.character === '成长周期') parts.push('这是成长周期，估值弹性大，要看订单/渗透率能否兑现，回撤也会更剧烈。')
      else if (tm.character === '弱周期') parts.push('这是弱周期，波动相对小，更多受需求与政策脉冲影响。')
      parts.push('中位 PE ' + (tm.pe_median == null ? '—' : fmtNum(tm.pe_median, 1)) + '（主题间横分位 ' + (tm.pe_pct_x == null ? '—' : fmtRatio(tm.pe_pct_x)) + '），PB ' + (tm.pb_median == null ? '—' : fmtNum(tm.pb_median, 2)) + '。')
      return parts.join('')
    }

    function ThemeModal({ theme, t, onClose, onStock }) {
      const [q, setQ] = useState('')
      const rows = useMemo(() => {
        const all = (theme.stocks || [])
        const s = q.trim().toLowerCase()
        if (!s) return all
        return all.filter((r) => String(r.name || '').toLowerCase().includes(s) || String(r.code || '').includes(s))
      }, [theme, q])
      const posBar = (v) => h('span', { style: { display: 'inline-block', width: 60, height: 4, borderRadius: 2, background: 'var(--dsw-alias-border-l1)', position: 'relative', verticalAlign: 'middle' } },
        h('span', { style: { position: 'absolute', left: 0, top: 0, bottom: 0, width: Math.round((v || 0) * 100) + '%', borderRadius: 2, background: 'var(--dsw-alias-brand-primary)' } }))
      return h('div', { style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 55, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }, onClick: onClose },
        h('div', { style: { width: 'min(1000px, 96vw)', maxHeight: '88vh', overflow: 'auto', background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 14, padding: 18, boxShadow: '0 20px 50px rgba(0,0,0,.3)' }, onClick: (e) => e.stopPropagation() },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
            h('div', { style: { fontSize: 20, fontWeight: 700 } }, theme.name),
            h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, theme.group + ' · ' + (theme.character || '')),
            h('span', { style: { fontSize: 11, fontWeight: 600, color: STAGE_TONE[theme.stage] || 'var(--dsw-alias-label-secondary)' } }, theme.stage || '—'),
            h('span', { style: { flex: 1 } }),
            h('button', { type: 'button', style: styles.btn, onClick: onClose }, t('close'))),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8, margin: '12px 0' } },
            [[t('themeSmall'), theme.pos250_med == null ? '—' : fmtRatio(theme.pos250_med), theme.pos250_med],
             [t('themeBig'), theme.pos1250_med == null ? '—' : fmtRatio(theme.pos1250_med), theme.pos1250_med],
             [t('themePe'), theme.pe_median == null ? '—' : fmtNum(theme.pe_median, 1), null],
             [t('themePb'), theme.pb_median == null ? '—' : fmtNum(theme.pb_median, 2), null],
             [t('themeCount'), theme.count + ' ' + t('total'), null],
             [t('cyclePct5'), theme.pct5_med == null ? '—' : fmtPct(theme.pct5_med), null]].map(([label, value, bar]) =>
              h('div', { key: label, style: { background: 'var(--dsw-alias-bg-layer-1)', borderRadius: 10, padding: '8px 10px' } },
                h('div', { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)' } }, label),
                h('div', { style: { fontSize: 15, fontWeight: 650, marginTop: 2 } }, value),
                bar != null ? posBar(bar) : null))),
          h('div', { style: { fontSize: 12, lineHeight: 1.8, color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)', borderRadius: 10, padding: '10px 12px' } }, themeComment(theme)),
          theme.kind === 'index' ? h('div', { style: { ...styles.hint, marginTop: 8 } },
            t('themeProxy'), ' ',
            h('button', { type: 'button', style: { ...styles.btn, padding: '2px 8px' }, onClick: () => onStock({ code: 'sh513130', name: '恒生科技ETF' }) }, '513130 技术分析')) : null,
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', margin: '14px 0 8px' } },
            h('div', { style: styles.sectionTitle }, t('themeStocks') + ' · ' + rows.length),
            h('span', { style: { flex: 1 } }),
            h('input', {
              value: q, placeholder: t('themeSearch'), onChange: (e) => setQ(e.target.value),
              style: { ...styles.input, width: 200 },
            })),
          rows.length ? h('div', { style: styles.tableBox },
            h('div', { style: { ...styles.rowHead, gridTemplateColumns: '1.4fr 58px 54px 54px 50px 70px 70px 50px 100px' } },
              h('span', null, t('colName')), h('span', null, t('colCode')),
              h('span', { style: styles.right }, t('colPrice')), h('span', { style: styles.right }, t('colPct')),
              h('span', { style: styles.right }, t('cyclePct5')), h('span', { style: styles.right }, t('themeSmall')),
              h('span', { style: styles.right }, t('themeBig')), h('span', { style: styles.right }, t('cycleStage')),
              h('span', { style: styles.right }, t('techCol'))),
            rows.slice(0, 120).map((r) => h('div', {
              key: r.code,
              style: { ...styles.row, gridTemplateColumns: '1.4fr 58px 54px 54px 50px 70px 70px 50px 100px', cursor: 'pointer' },
              onClick: () => onStock(r),
            },
              h('span', null, r.name),
              h('span', { style: styles.mono }, r.code),
              h('span', { style: styles.right }, r.price == null ? '—' : fmtNum(r.price, 2)),
              h('span', { style: { ...styles.right, color: tone(r.pct) } }, fmtPct(r.pct)),
              h('span', { style: { ...styles.right, color: tone(r.pct5) } }, fmtPct(r.pct5)),
              h('span', { style: styles.right }, r.pos250 == null ? '—' : fmtRatio(r.pos250)),
              h('span', { style: styles.right }, r.pos1250 == null ? '—' : fmtRatio(r.pos1250)),
              h('span', { style: { ...styles.right, color: STAGE_TONE[r.stage] || 'var(--dsw-alias-label-secondary)' } }, r.stage || '—'),
              h('span', { style: { textAlign: 'right' } }, h(TechChips, { r, t }))))) : h('div', { style: styles.empty }, t('themeNoStocks')),
          h('div', { style: { ...styles.hint, marginTop: 8 } }, t('themeHint'))))
    }

    function ThemeCard({ tm, onOpen }) {
      const up = (tm.avg_pct || 0) >= 0
      const rows = [['小', tm.pos250_med], ['大', tm.pos1250_med]]
      const bar = (v) => h('div', { style: { height: 3, borderRadius: 2, background: 'var(--dsw-alias-border-l1)', marginTop: 2 } },
        h('div', { style: { height: '100%', width: Math.round((v || 0) * 100) + '%', borderRadius: 2, background: 'var(--dsw-alias-brand-primary)' } }))
      return h('button', {
        type: 'button',
        onClick: () => onOpen(tm),
        style: {
          textAlign: 'left', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 12, padding: '10px 12px',
          background: 'var(--dsw-alias-bg-layer-1)', cursor: 'pointer', color: 'inherit', display: 'flex', flexDirection: 'column', gap: 4,
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          h('span', { style: { fontSize: 13, fontWeight: 650 } }, tm.name),
          h('span', { style: { flex: 1 } }),
          h('span', { style: { fontSize: 10, fontWeight: 600, color: STAGE_TONE[tm.stage] || 'var(--dsw-alias-label-secondary)' } }, tm.stage || '—')),
        h('div', { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)' } },
          (tm.character || '') + (tm.kind === 'index' ? ' · 港指代理' : ' · ' + tm.count + ' 只')),
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 2 } },
          h('span', { style: { fontSize: 18, fontWeight: 700, color: up ? UP : DOWN } },
            tm.avg_pct == null ? (tm.kind === 'index' ? '看指数' : '—') : fmtPct(tm.avg_pct)),
          h('span', { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)' } }, tm.count ? tm.up + '↑ ' + tm.down + '↓' : '')),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 4 } },
          rows.map((r) => h('div', { key: r[0] },
            h('div', { style: { fontSize: 9, color: 'var(--dsw-alias-label-secondary)' } }, r[0], '周期 ', r[1] == null ? '—' : fmtRatio(r[1])),
            bar(r[1])))))
    }

    function ThemesView({ data, t }) {
      const [open, setOpen] = useState(null)
      const [tech, setTech] = useState(null)
      const themes = (data && data.themes) || []
      const groups = (data && data.theme_groups) || []
      if (!themes.length) return h('div', { style: styles.empty }, t('themeNoStocks'))
      return h('div', null,
        h('div', { style: styles.hint }, t('themesHint')),
        groups.map((g) => {
          const list = themes.filter((x) => x.group === g)
          if (!list.length) return null
          return h('div', { key: g, style: { marginTop: 12 } },
            h('div', { style: { ...styles.sectionTitle, marginBottom: 6 } }, g),
            h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 8 } },
              list.map((tm) => h(ThemeCard, { key: tm.name, tm, onOpen: setOpen }))))
        }),
        open ? h(ThemeModal, { theme: open, t, onClose: () => setOpen(null), onStock: (r) => setTech(r) }) : null,
        tech ? h(TechDrawer, { pick: tech, t, onClose: () => setTech(null) }) : null)
    }

    function EventCard({ ev, t }) {
      const cells = [
        [t('eventPre'), ev.stats.pre1], [t('eventDay'), ev.stats.day],
        [t('eventNext'), ev.stats.next1], [t('eventNext5'), ev.stats.next5],
      ]
      return h('div', { style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 12, background: 'var(--dsw-alias-bg-layer-1)', padding: 12 } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
          h('div', { style: { fontSize: 13, fontWeight: 650 } }, ev.title),
          ev.estimate ? h('span', { style: { ...styles.badge, fontSize: 9 } }, t('eventEstimate')) : null,
          h('span', { style: { flex: 1 } }),
          h('span', { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)' } }, t('eventSample') + ' ' + (ev.stats.day.n || 0))),
        ev.upcoming && ev.upcoming.length ? h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 } },
          ev.upcoming.map((d) => h('span', { key: d, style: { ...styles.badge, fontSize: 10, color: 'var(--dsw-alias-brand-primary)' } }, d))) : null,
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 6, marginTop: 8 } },
          cells.map(([label, st]) => h('div', { key: label, style: { background: 'var(--dsw-alias-bg-base)', borderRadius: 8, padding: '6px 8px' } },
            h('div', { style: { fontSize: 9, color: 'var(--dsw-alias-label-secondary)' } }, label),
            h('div', { style: { fontSize: 11, fontWeight: 600, marginTop: 2 } },
              st.n ? (t('eventWin') + ' ' + st.win + '%') : '—',
              st.n ? h('span', { style: { fontSize: 10, fontWeight: 500, color: tone(st.avg), marginLeft: 4 } }, fmtPct(st.avg)) : null)))))
    }

    function InfoView({ t }) {
      const [doc, setDoc] = useState(null)
      const [err, setErr] = useState('')
      useEffect(() => {
        let alive = true
        fetchJson(EVENTS_URL)
          .then((b) => { if (alive) setDoc(b) })
          .catch((e) => { if (alive) setErr(String(e.message || e)) })
        return () => { alive = false }
      }, [])
      if (err) return h('div', { style: styles.errorBox }, err)
      if (!doc) return h('div', { style: styles.empty }, t('loading'))
      return h('div', null,
        h('div', { style: styles.hint }, t('infoHint')),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 } },
          (doc.events || []).map((ev) => h(EventCard, { key: ev.kind, ev, t }))),
        h('div', { style: { ...styles.hint, marginTop: 10, opacity: 0.9 } }, doc.note))
    }

    function EquityCurve({ points }) {
      const pts = (points || []).filter((p) => p && Number.isFinite(p.equity != null ? p.equity : p.nav))
      if (pts.length < 2) return null
      const W = 760, H = 140, pad = 8
      const navs = pts.map((p) => (p.equity != null ? p.equity : p.nav))
      const min = Math.min(...navs), max = Math.max(...navs)
      const span = max - min || 1
      const x = (i) => pad + (i / (pts.length - 1)) * (W - pad * 2)
      const y = (v) => pad + (1 - (v - min) / span) * (H - pad * 2)
      let d = ''
      pts.forEach((p, i) => { d += (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.equity != null ? p.equity : p.nav).toFixed(1) })
      return h('svg', { viewBox: '0 0 ' + W + ' ' + H, style: { width: '100%', height: 'auto', display: 'block' } },
        h('path', { d, fill: 'none', stroke: 'var(--dsw-alias-brand-primary)', strokeWidth: 1.6 }),
        h('text', { x: pad, y: pad + 10, fontSize: 10, fill: 'var(--dsw-alias-label-secondary)' }, 'NAV ' + fmtNum(min, 0) + ' – ' + fmtNum(max, 0)))
    }

    function Foot({ t, totalSignals }) {
      return h('div', { style: styles.foot },
        h('div', null, t('foot'), totalSignals != null ? ` ${t('signalTotal')} ${totalSignals}.` : ''),
        h('div', { style: { marginTop: 4, opacity: 0.8 } }, t('footSource')))
    }


    function DecisionView({ data, t, onTech }) {
      const d = (data && data.decision) || {}
      const s = d.sentiment || {}
      const leaders = d.leaders || []
      const risks = d.risks || []
      const top = leaders.slice(0, 3)
      const score = s.score == null ? 50 : s.score
      const tone = score < 20 ? '#38bdf8' : score < 40 ? '#93c5fd' : score < 60 ? 'var(--dsw-alias-label-secondary)' : score < 80 ? '#fb923c' : '#f87171'
      const cardStyle = { marginBottom: 10, padding: '12px 14px', borderRadius: 10, background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)' }
      const row = (k, v) => h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12, padding: '3px 0' } },
        h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, k), h('span', null, v))
      return h('div', null,
        h('div', { style: { ...cardStyle, background: 'var(--dsw-alias-bg-layer-2)' } },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
            h('div', { style: { fontSize: 13, fontWeight: 600 } }, t('decideTitle')),
            h('div', { style: { fontSize: 26, fontWeight: 700, color: tone } }, `${score}`),
            h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, `/ 100 · ${s.label || ''}`),
            h('div', { style: { fontSize: 12, color: tone, marginLeft: 'auto' } }, s.advice || '')),
          h('div', { style: { height: 6, borderRadius: 999, background: 'var(--dsw-alias-bg-base)', margin: '8px 0', overflow: 'hidden' } },
            h('div', { style: { width: `${Math.max(0, Math.min(100, score))}%`, height: '100%', background: tone } })),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
            h('span', null, `${t('marketUp')} ${s.parts ? s.parts.up : '—'}`),
            h('span', null, `${t('marketDown')} ${s.parts ? s.parts.down : '—'}`),
            h('span', null, `${t('limitUp')} ${s.parts ? s.parts.limit_up : '—'}`),
            h('span', null, `${t('limitDown')} ${s.parts ? s.parts.limit_down : '—'}`),
            h('span', null, `${t('median')} ${fmtPct(s.median_pct)}`),
            h('span', null, `${t('decideBreadth')} ${fmtRatio(s.breadth)}`))),

        h('div', { style: { ...cardStyle } },
          h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, t('decideConcl')),
          top.length === 0
            ? h('div', { style: styles.hint }, t('decideNoCandidate'))
            : top.map((x) => h('div', { key: x.code, style: { padding: '10px 0', borderTop: '1px solid var(--dsw-alias-border-l1)' } },
                h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
                  h('div', { style: { fontSize: 13, fontWeight: 600 } }, x.name || x.code),
                  h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, `${x.code} · ${x.industry || ''}`),
                  h('div', { style: { ...styles.chip, marginLeft: 'auto' } }, `${t('decideScore')} ${x.score}`)),
                h('div', { style: { fontSize: 11.5, lineHeight: 1.75, marginTop: 4 } },
                  (x.evidence || []).map((e, i) => h('div', { key: i }, `· ${e}`))),
                h('div', { style: { fontSize: 11.5, marginTop: 4 } }, h('b', null, `${t('decideTrigger')}：`), x.trigger || ''),
                h('div', { style: { fontSize: 11.5, marginTop: 2, color: 'var(--dsw-alias-label-secondary)' } },
                  h('b', null, `${t('decideInvalid')}：`), x.invalid || ''),
                h('button', { type: 'button', style: { ...styles.btn, marginTop: 6, fontSize: 11 }, onClick: () => onTech({ code: x.code, name: x.name }) }, t('techBtn'))))),

        h('div', { style: { ...cardStyle } },
          h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, t('decideRisk')),
          risks.length === 0
            ? h('div', { style: styles.hint }, t('decideNoRisk'))
            : risks.slice(0, 3).map((x) => h('div', { key: x.code, style: { display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 11.5, padding: '5px 0', borderTop: '1px solid var(--dsw-alias-border-l1)' } },
                h('b', null, x.name || x.code),
                h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, x.industry || ''),
                h('span', null, `${t('decidePos')} ${fmtRatio(x.pos250)}`),
                h('span', null, `RSI ${fmtNum(x.rsi14, 1)}`),
                h('span', { style: { color: 'var(--dsw-alias-state-warn-primary)' } }, x.reason || '')))),

        h('div', { style: { ...cardStyle } },
          h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, `${t('decideCandidates')} (${leaders.length})`),
          h('div', { style: styles.table },
            h('div', { style: { display: 'grid', gridTemplateColumns: '1.2fr 52px 46px 46px 46px', gap: 8, padding: '2px 4px' } },
              h('div', { style: styles.th }, t('name')), h('div', { style: styles.th }, t('decidePos')),
              h('div', { style: styles.th }, 'RSI'), h('div', { style: styles.th }, t('decide5d')), h('div', { style: styles.th }, t('decideVol'))),
            leaders.map((x) => h('button', {
              key: x.code, type: 'button',
              style: { display: 'grid', gridTemplateColumns: '1.2fr 52px 46px 46px 46px', gap: 8, padding: '5px 4px', background: 'transparent', border: 0, borderTop: '1px solid var(--dsw-alias-border-l1)', color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer' },
              onClick: () => onTech({ code: x.code, name: x.name }),
            },
              h('div', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, x.name || x.code),
              h('div', null, fmtRatio(x.pos250)),
              h('div', null, fmtNum(x.rsi14, 0)),
              h('div', null, fmtPct(x.pct5)),
              h('div', null, fmtNum(x.vol_ratio, 2))))),

        h('div', { style: styles.hint }, t('decideHint'))))
    }

    /* ------------------------------------------------------- 盘中异动 */
    const LIVE_URL = '/api/sector-board/live.json'
    const LIVE_POLL = 15000
    const LIVE_COLS = '52px 1fr 56px 56px 50px 44px 62px 46px 64px'

    function tradingNow() {
      const d = new Date(Date.now() + 8 * 3600 * 1000)
      const day = d.getUTCDay()
      if (day === 0 || day === 6) return false
      const m = d.getUTCHours() * 100 + d.getUTCMinutes()
      return (m >= 915 && m <= 1135) || (m >= 1255 && m <= 1505)
    }

    const hmss = (ts) => new Date(new Date(ts).getTime() + 8 * 3600 * 1000).toISOString().slice(11, 19)

    const EV_TONE = {
      limit_down_open: 'var(--dsw-alias-state-success-primary)',
      limit_up_break: 'var(--dsw-alias-state-warn-primary)',
      surge: 'var(--dsw-alias-state-error-primary)',
      plunge: 'var(--dsw-alias-state-success-primary)',
    }

    function LiveView({ data, t }) {
      const [state, setState] = useState({ rows: [], events: [], updated_at: null, count: 0 })
      const [err, setErr] = useState('')
      const [sort, setSort] = useState('pct')
      const alive = useRef(true)

      const codes = useMemo(() => {
        const list = []
        const seen = new Set()
        const push = (c) => {
          if (c && /^\d{6}$/.test(c) && !seen.has(c)) { seen.add(c); list.push(c) }
        }
        for (const th of (data?.themes || [])) for (const s of (th.stocks || []).slice(0, 40)) push(s.code)
        for (const r of (data?.decision?.leaders || [])) push(r.code)
        for (const r of (data?.decision?.risks || [])) push(r.code)
        return list.slice(0, 500)
      }, [data])

      const load = useCallback(async () => {
        if (!codes.length) return
        try {
          const res = await fetch(LIVE_URL + '?codes=' + codes.join(','), { cache: 'no-store' })
          const body = await res.json().catch(() => ({}))
          if (!alive.current) return
          if (!res.ok) { setErr(body.error || res.status); return }
          setErr('')
          setState(body)
        } catch (e) { if (alive.current) setErr(String((e && e.message) || e)) }
      }, [codes])

      useEffect(() => {
        alive.current = true
        if (!codes.length) return () => { alive.current = false }
        load()
        const id = setInterval(() => { if (tradingNow()) load() }, LIVE_POLL)
        return () => { alive.current = false; clearInterval(id) }
      }, [load, codes.length])

      const rows = useMemo(() => {
        const score = (r) => sort === 'speed' ? (r.speed ?? -9)
          : sort === 'vol' ? (r.vol_ratio ?? 0)
          : sort === 'amount' ? (r.amount ?? 0)
          : (r.pct ?? -99)
        return (state.rows || []).filter((r) => r && r.price).sort((a, b) => score(b) - score(a)).slice(0, 200)
      }, [state.rows, sort])

      return h('div', null,
        h('div', { style: styles.liveBar },
          h('span', { style: { ...styles.dot, background: tradingNow() ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)' } }),
          h('span', { style: { fontSize: 13, fontWeight: 600 } }, tradingNow() ? t('liveTrading') : t('liveClosed')),
          h('span', { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' } },
            t('liveMonitor'), ' ', state.count || codes.length, ' 只'),
          h('span', { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' } },
            t('updated'), ' ', state.updated_at ? hmss(state.updated_at) : '—'),
          h('span', { style: { flex: 1 } }),
          ['pct', 'speed', 'vol', 'amount'].map((k) => h('button', {
            key: k, type: 'button',
            style: { ...styles.pill, fontSize: 11, ...(sort === k ? { borderColor: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-brand-primary)' } : null) },
            onClick: () => setSort(k),
          }, t(k === 'pct' ? 'liveSortPct' : k === 'speed' ? 'liveSortSpeed' : k === 'vol' ? 'liveSortVol' : 'liveSortAmount'))),
          h('button', { type: 'button', style: { ...styles.btn, padding: '4px 10px' }, onClick: load }, t('refresh'))),
        err ? h('div', { style: { fontSize: 11.5, color: 'var(--dsw-alias-state-error-primary)', marginBottom: 8 } }, err) : null,
        h('div', { style: styles.liveHint }, t('liveHint')),
        h('div', { style: { display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' } },
          h('div', { style: { flex: '1 1 620px', minWidth: 340 } },
            h('div', { style: { ...styles.tr, gridTemplateColumns: LIVE_COLS, borderBottom: 'none', color: 'var(--dsw-alias-label-secondary)' } },
              h('span', null, '代码'), h('span', null, '名称'),
              h('span', { style: { textAlign: 'right' } }, '现价'),
              h('span', { style: { textAlign: 'right' } }, '涨跌'),
              h('span', { style: { textAlign: 'right' } }, t('liveSpeed')),
              h('span', { style: { textAlign: 'right' } }, t('liveVol')),
              h('span', { style: { textAlign: 'right' } }, t('liveAmount')),
              h('span', { style: { textAlign: 'right' } }, t('liveTurnover')),
              h('span', { style: { textAlign: 'right' } }, t('liveState'))),
            h('div', { style: { ...styles.table, maxHeight: 560 } },
              rows.map((r) => {
                const chip = r.limit_up && r.price >= r.limit_up * 0.999 ? '涨停'
                  : r.limit_down && r.price <= r.limit_down * 1.001 ? '跌停' : '—'
                const chipTone = chip === '涨停' ? UP : chip === '跌停' ? DOWN : 'var(--dsw-alias-label-secondary)'
                return h('div', { key: r.code, style: { ...styles.tr, gridTemplateColumns: LIVE_COLS } },
                  h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, r.code),
                  h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: r.name }, r.name),
                  h('span', { style: { textAlign: 'right' } }, fmtNum(r.price, 2)),
                  h('span', { style: { textAlign: 'right', color: tone(r.pct), fontWeight: 600 } }, fmtPct(r.pct)),
                  h('span', { style: { textAlign: 'right', color: tone(r.speed) } }, r.speed == null ? '—' : fmtPct(r.speed)),
                  h('span', { style: { textAlign: 'right', color: 'var(--dsw-alias-label-secondary)' } }, fmtNum(r.vol_ratio, 2)),
                  h('span', { style: { textAlign: 'right', color: 'var(--dsw-alias-label-secondary)' } }, r.amount == null ? '—' : fmtMoney(r.amount * 1e4)),
                  h('span', { style: { textAlign: 'right', color: 'var(--dsw-alias-label-secondary)' } }, r.turnover == null ? '—' : r.turnover.toFixed(1) + '%'),
                  h('span', { style: { textAlign: 'right', color: chipTone, fontWeight: 600 } }, chip))
              }),
              rows.length === 0 ? h('div', { style: { ...styles.empty, padding: '30px 0' } }, t('liveNoEvents')) : null)),
          h('aside', { style: { ...styles.detail, position: 'static', maxWidth: 380, flex: '0 1 340px' } },
            h('div', { style: { fontSize: 13, fontWeight: 650, marginBottom: 8 } }, t('liveEvents'), ' ', state.events?.length || 0),
            (state.events || []).length === 0
              ? h('div', { style: { ...styles.empty, padding: '20px 0', fontSize: 12 } }, t('liveNoEvents'))
              : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 540, overflow: 'auto' } },
                  (state.events || []).map((e, i) => h('div', { key: e.code + e.type + e.at + i, style: styles.evItem },
                    h('span', { style: { ...styles.evTag, color: EV_TONE[e.type] || 'var(--dsw-alias-label-secondary)', borderColor: EV_TONE[e.type] || 'var(--dsw-alias-border-l1)' } },
                      t(e.type === 'limit_down_open' ? 'liveLimitDownOpen' : e.type === 'limit_up_break' ? 'liveLimitUpBreak' : e.type === 'surge' ? 'liveSurge' : 'livePlunge')),
                    h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                      e.name, ' ', h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 10.5 } }, e.code)),
                    h('span', { style: { color: tone(e.pct), fontSize: 11, fontVariantNumeric: 'tabular-nums' } }, fmtPct(e.pct)),
                    h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 10.5, fontVariantNumeric: 'tabular-nums' } }, hmss(e.at))))))
        ))
    }

    function BoardPage({ t }) {
      return h('div', {
        style: {
          height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column',
          paddingTop: 'var(--dsh-frame-top-clearance, 0px)',
          background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
        },
      },
        h('iframe', {
          src: '/api/sector-board/v3/ui-v3.html?v=3.13.2',
          title: '股票分析',
          style: { display: 'block', flex: 1, minHeight: 0, width: '100%', border: 0, background: 'var(--dsw-alias-bg-base)' },
        }))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.locale.register(NS, {
          zh: {
            panel: '股票分析', title: '股票分析', refresh: '更新数据', refreshing: '更新中…',
            search: '搜索板块…', all: '全部板块', total: '只', sectors: '个板块',
            loading: '正在加载看板…', nodata: '还没有看板数据',
            nodataHint: '首次运行要抓取全 A 股约 5600 只股票的日线，约 4–6 分钟。点「更新数据」开始，期间可以关掉这个页面。',
            progress: '正在抓取数据', error: '加载失败', updated: '数据生成于', source: '新浪清单 + 东财估值/龙虎榜 + 雪球/新浪/腾讯日线',
            marketUp: '上涨', marketDown: '下跌', limitUp: '涨停', limitDown: '跌停',
            median: '中位涨幅', avg: '平均涨幅',
            sortCount: '按股票数', sortPct: '按平均涨幅', sortSignal: '按信号数', sortName: '按名称',
            noSignal: '该板块今天没有命中这个信号。', noMatch: '没有匹配的板块。', close: '关闭',
            signalTotal: '当前全市场信号合计',
            overviewHint: '点击板块卡片查看成分股；信号口径：MACD(12,26,9) 今日金叉；近 5 日涨幅 ≥ +10% 为近期大涨、≤ -10% 为近期大跌；近 20 日跌幅 ≤ -12%、近 5 日振幅 ≤ 6% 且涨跌幅 ≤ 3% 为「大跌后横盘」；收盘价在近 250 日分位 ≤ 10% 为周期底部、≥ 90% 为周期高点。',
            foot: '仅作盘面观察，不构成投资建议。',
            footSource: '数据源：新浪股票清单与日线、东方财富行业分类/估值/龙虎榜/分红、雪球前复权日线。',
            navDecide: '决策', navLive: '盘中', navOverview: '总览',
            liveTrading: '交易中', liveClosed: '非交易时段（显示最近快照）', liveMonitor: '监控',
            liveEvents: '异动', liveNoEvents: '暂无', liveSpeed: '涨速', liveVol: '量比',
            liveAmount: '成交额', liveTurnover: '换手', liveState: '状态',
            liveSortPct: '涨跌幅', liveSortSpeed: '涨速', liveSortVol: '量比', liveSortAmount: '成交额',
            liveLimitDownOpen: '跌停撬板', liveLimitUpBreak: '涨停打开', liveSurge: '急拉', livePlunge: '急跌',
            liveHint: '每 15 秒轮询主题成分与候选池；仅展示，不推送告警。涨速为相邻两次快照的变化。',
            decideTitle: '今日结论', decideConcl: '今日结论与触发条件', decideRisk: '高位风险',
            decideCandidates: '底部反转候选（龙头）', decideScore: '强度', decideBreadth: '涨跌家数比',
            decidePos: '年位置', decide5d: '5日', decideVol: '量比',
            decideTrigger: '触发', decideInvalid: '失效',
            decideNoCandidate: '今天没有同时满足「位置低 + 反转确认」的龙头股。空仓等待也是决策。',
            decideNoRisk: '今天没有触发高位风险条件的龙头股。',
            decideHint: '候选规则：行业内市值前 40% 且 ≥ 50 亿；1 年价格分位 ≤ 40%；收盘站上 MA20、MA20 斜率转正、量比 ≥ 1.1、MACD 不在水下或当日金叉。分数只用于排序，不是胜率。以上为盘面推演，不构成投资建议。', navLhb: '龙虎榜', navYouzi: '游资', navCycle: '板块周期', navDividend: '红利',
            lhbCount: '上榜股票', lhbNetSum: '龙虎榜净买', lhbBuySum: '龙虎榜买入', lhbDate: '交易日',
            lhbHint: '当日登上龙虎榜的全部股票，按净买入排序；点任意一行展开买卖席位。',
            lhbPct: '涨跌幅', lhbTurn: '换手', lhbNet: '净买入', lhbAmount: '成交额', lhbRatio: '净买占比',
            lhbSeat: '席位', lhbReason: '上榜原因', lhbEmpty: '当日没有龙虎榜数据（非交易日或接口未更新）。',
            lhbDept: '营业部 / 席位', lhbBuy: '买入', lhbSell: '卖出', lhbInst: '机构',
            sortBy: '排序',
            youziCount: '游资净买个股', youziNetSum: '游资净买合计', youziSeatCount: '活跃营业部',
            youziHint: '只统计龙虎榜中非「机构专用」席位的买卖，净买入为正的股票。',
            youziStocks: '游资净买个股', youziActive: '活跃营业部（买入额前 20）',
            youziPct: '涨跌幅', youziNet: '游资净买', youziRatio: '占成交', youziSeats: '席位',
            youziDept: '营业部', youziBuy: '买入额', youziStocksCol: '股票数',
            youziEmpty: '今天没有游资净买入的股票。',
            cycleTitle: '板块周期', cycleHint: '申万一级周期行业；大周期=近 5 年价格分位，小周期=近 1 年价格分位。',
            cyclePe: 'PE中位', cyclePb: 'PB中位', cycleSmall: '小周期', cycleBig: '大周期',
            cycleStage: '阶段', cycleVol: '年化波动', cycleX: '估值横分位', cycleStocks: '成分股',
            cyclePePct: '行业内估值分位', cyclePct5: '近5日', cycleEmpty: '周期行业暂无数据。',
            cycleRules: '规则',
            divTitle: '红利板块', divHint: '近 12 个月股息率 ≥ 3%、非 ST、总市值 ≥ 50 亿，按股息率降序，最多 120 只。',
            divCount: '红利样本', divMedianYield: '中位股息率', divMedianPe: '中位 PE', divMedianPb: '中位 PB',
            divYield: '股息率', divPos: '年位置', divTimes: '分红次数', divIndustry: '行业',
            divEmpty: '暂无满足条件的红利股。', divCyclic: '周期',
            navEtf: 'ETF', navGlobal: '全球', navPaper: '模拟盘', navInfo: '信息', navThemes: '周期', navRobot: '机器人',
            navHot: '热点',
            hotHint: '讨论热度来自同花顺人气榜（每小时更新），并给前 30 只标注均线/MACD/RSI；龙虎榜看资金上榜，游资看剔除机构后的净买。',
            hotSubHeat: '讨论热度', hotSubLhb: '龙虎榜', hotSubYouzi: '游资',
            hotHeat: '热度', hotPopularity: '榜单标签',
            hotNote: '热度只代表讨论量，不等于看多；点任意一行看技术分析。数据源：同花顺人气榜（主）、东财股吧人气（备）。',
            techCol: '技术', techBull: '均线多头', techBear: '均线空头', techAbove: 'MACD水上', techBtn: '技术分析',
            techMinute: '分时', techDaily: '日线', techWeekly: '周线', techMonthly: '月线', techScore: '技术状态',
            techNotes: '技术解读', techSignals: '信号',
            infoHint: '把会议与交割日当成日历看：先看未来 3 次节点，再看历史上同一天上涨的频率。历史频率只解释波动来源，不能直接当预测。',
            eventPre: '前 1 日', eventDay: '当日', eventNext: '后 1 日', eventNext5: '后 5 日',
            eventWin: '胜率', eventSample: '样本', eventEstimate: '惯例估计',
            themesHint: '把相似的周期放在一组：科技（AI 资本开支/库存）、消费（猪价/内容）、新能源（产能/价格）、地产链、资源（金属价格）。点卡片看周期位置、成分股与个股技术分析。',
            themeSmall: '小周期', themeBig: '大周期', themePe: 'PE 中位', themePb: 'PB 中位', themeCount: '成分',
            themeStocks: '成分股', themeSearch: '在主题内搜索股票…', themeNoStocks: '主题暂无数据。',
            themeProxy: '恒生科技没有 A 股成分，用恒生科技 ETF 513130 的日线代理走势。',
            themeHint: '小周期=近 1 年价格分位，大周期=近 5 年价格分位；点任意股票看蜡烛图、均线与 MACD。',
            techHint: '蜡烛图 + MA5/10/20/60 + 成交量 + MACD；只做技术面描述，不构成买卖建议。',
            paperEquity: '净值曲线',
            paperRobot: '机器人模拟盘：从决策页的底部反转龙头候选里自动选股，当前为规则模式；接入 opencode 后由模型给买卖理由。',
            robotTitle: '机器人交易员', robotRun: '运行机器人', robotNext: '下次自动运行',
            robotLast: '上次运行', robotNoAction: '本轮无成交', robotRejected: '被拒订单', robotWatch: '观察',
            searchStock: '搜索股票 / ETF / 板块 / 全球标的…', searchEtf: '搜索 ETF…',
            boardTag: '板块', viewIndustry: '申万行业', viewConcept: '概念板块', viewSub: '行业细分', heatmap: '热力图', cards: '卡片',
            etfTag: 'ETF', stockTag: '股票',
            prevClose: '昨收', open: '开盘', high: '最高', low: '最低', quoteTime: '时间', quoteSource: '来源',
            noQuote: '暂时没有报价。',
            allCat: '全部', sortAmount: '按成交额', sort5: '按 5 日', sort20: '按 20 日', sortPos: '按年位置（低→高）',
            etfLive: '现价每 10 秒刷新', colName: '名称', colCode: '代码', colCat: '分类', colPrice: '现价', colPct: '涨跌幅',
            col5: '5日', col20: '20日', colPos: '年位置', colAmount: '成交额', etfAsOf: '日线截至', colQty: '数量', colCost: '成本',
            colMv: '市值', colPnl: '浮盈亏', colPnlPct: '盈亏比', colDate: '日期', colSide: '方向', buy: '买', sell: '卖',
            etfHint: 'ETF 日线指标来自 ETL，现价与涨跌幅每 10 秒刷新；点击任意一行看详情。',
            globalHint: '外股、指数、商品与外汇实时报价（交易时段内每 10 秒刷新）。',
            globalNote: '日/韩/德/英用美国上市的国家 ETF 或 ADR 代理；A股、港股、美股指数为交易所指数。',
            paperEmpty: '还没有模拟盘账户。点「创建账户」用 10 万初始资金开始，策略是 ETF 趋势轮动。',
            paperAuto: '每 10 秒刷新净值；决策在收盘后用日线跑。',
            paperNav: '总资产', paperPnl: '累计收益', paperCash: '现金', paperMv: '持仓市值',
            paperHint: '约束：最多 3 只、单只 ≤34%、A 股/ETF 100 股取整、双边费率 0.05% 与滑点 0.05%；浮亏 -8% 强制卖出；工作日 14:50 自动运行。',
            paperPositions: '当前持仓', paperNoPos: '空仓。',
            paperDecisions: '决策记录', paperNoDecisions: '还没有决策记录。',
            paperTrades: '成交记录', actionTrade: '交易', actionHold: '持有',
            runDecide: '跑一次决策', initAccount: '创建账户', running: '运行中…',
          },
          en: {
            panel: 'Stock Analysis', title: 'Stock Analysis', refresh: 'Refresh', refreshing: 'Refreshing…',
            search: 'Search sectors…', all: 'All sectors', total: 'stocks', sectors: 'sectors',
            loading: 'Loading…', nodata: 'No board data yet',
            nodataHint: 'The first run fetches daily bars for ~5,600 A-share stocks (4–6 minutes). Click Refresh; you can leave this page.',
            progress: 'Fetching data', error: 'Failed', updated: 'Generated', source: 'Sina list + EastMoney valuation/LHB + Sina/Xueqiu/Tencent bars',
            marketUp: 'Advancing', marketDown: 'Declining', limitUp: 'Limit up', limitDown: 'Limit down',
            median: 'Median', avg: 'Average',
            sortCount: 'By stock count', sortPct: 'By avg change', sortSignal: 'By signal count', sortName: 'By name',
            noSignal: 'No stock in this sector hits this signal today.', noMatch: 'No matching sectors.', close: 'Close',
            signalTotal: 'Signals across the market:',
            overviewHint: 'Click a sector card for constituents. Signals: MACD(12,26,9) golden cross today; 5-day change ≥ +10% surge, ≤ -10% plunge; 20-day ≤ -12% with 5-day amplitude ≤ 6% and |5-day| ≤ 3% is post-plunge flat; 250-day percentile ≤ 10% cycle low, ≥ 90% cycle high.',
            foot: 'For market observation only; not investment advice.',
            footSource: 'Sources: Sina quotes, EastMoney industries/valuation/LHB/dividends, Xueqiu adjusted bars.',
            navDecide: 'Decision', navLive: 'Live', navOverview: 'Overview',
            liveTrading: 'Market open', liveClosed: 'Market closed (last snapshot)', liveMonitor: 'Watching',
            liveEvents: 'Moves', liveNoEvents: 'None', liveSpeed: 'Speed', liveVol: 'Vol ratio',
            liveAmount: 'Turnover', liveTurnover: 'Turn', liveState: 'State',
            liveSortPct: 'Change', liveSortSpeed: 'Speed', liveSortVol: 'Vol', liveSortAmount: 'Turnover',
            liveLimitDownOpen: 'Limit-down lifted', liveLimitUpBreak: 'Limit-up broken', liveSurge: 'Surge', livePlunge: 'Drop',
            liveHint: 'Polls theme members and candidates every 15s; display only, no alerts. Speed is change between snapshots.',
            decideTitle: 'Today', decideConcl: 'Conclusions & triggers', decideRisk: 'High-level risks',
            decideCandidates: 'Reversal candidates (leaders)', decideScore: 'Strength', decideBreadth: 'Up/down',
            decidePos: 'Pos', decide5d: '5d', decideVol: 'Vol',
            decideTrigger: 'Trigger', decideInvalid: 'Invalidation',
            decideNoCandidate: 'No leader meets both cheap position and reversal confirmation today. Waiting is a decision.',
            decideNoRisk: 'No leader flagged as high-level risk today.',
            decideHint: 'Rules: top 40% mcap in industry and >= 5B CNY; 1y price percentile <= 40%; close above MA20, MA20 slope turning up, volume >= 1.1x, MACD not deep below or golden cross today. Score ranks only, not win rate. Not investment advice.', navLhb: 'Dragon-Tiger', navYouzi: 'Hot Money', navCycle: 'Cycles', navDividend: 'Dividend',
            lhbCount: 'Listed stocks', lhbNetSum: 'Net buy', lhbBuySum: 'Total buy', lhbDate: 'Trade date',
            lhbHint: 'All stocks on the daily Dragon-Tiger list, sorted by net buy; click a row for seats.',
            lhbPct: 'Change', lhbTurn: 'Turnover', lhbNet: 'Net buy', lhbAmount: 'Amount', lhbRatio: 'Net ratio',
            lhbSeat: 'Seats', lhbReason: 'Reason', lhbEmpty: 'No Dragon-Tiger data for this day.',
            lhbDept: 'Seat', lhbBuy: 'Buy', lhbSell: 'Sell', lhbInst: 'Inst',
            sortBy: 'Sort',
            youziCount: 'Stocks', youziNetSum: 'Total net', youziSeatCount: 'Active seats',
            youziHint: 'Only non-institutional seats from the Dragon-Tiger list; net buy > 0.',
            youziStocks: 'Hot-money net buys', youziActive: 'Active seats (top 20 by buy)',
            youziPct: 'Change', youziNet: 'Net buy', youziRatio: 'Of amount', youziSeats: 'Seats',
            youziDept: 'Seat', youziBuy: 'Buy', youziStocksCol: 'Stocks',
            youziEmpty: 'No hot-money net buys today.',
            cycleTitle: 'Sector cycles', cycleHint: 'SW level-1 cyclical sectors; big cycle = 5y price percentile, small = 1y.',
            cyclePe: 'Median PE', cyclePb: 'Median PB', cycleSmall: '1y pos', cycleBig: '5y pos',
            cycleStage: 'Stage', cycleVol: 'Ann. vol', cycleX: 'Valuation rank', cycleStocks: 'Constituents',
            cyclePePct: 'PE rank in sector', cyclePct5: '5-day', cycleEmpty: 'No cyclical data.',
            cycleRules: 'Rules',
            divTitle: 'Dividend', divHint: 'Trailing 12m yield ≥ 3%, non-ST, market cap ≥ CNY 5bn; top 120 by yield.',
            divCount: 'Samples', divMedianYield: 'Median yield', divMedianPe: 'Median PE', divMedianPb: 'Median PB',
            divYield: 'Yield', divPos: '1y pos', divTimes: 'Payments', divIndustry: 'Industry',
            divEmpty: 'No dividend stocks match.', divCyclic: 'Cyclical',
            navEtf: 'ETF', navGlobal: 'Global', navPaper: 'Paper', navInfo: 'Calendar', navThemes: 'Cycles', navRobot: 'Robot',
            navHot: 'Buzz',
            hotHint: 'Buzz ranking comes from the 10jqka popularity list (hourly), with MA/MACD/RSI tags for the top 30; Dragon-Tiger shows exchange flows, Hot Money strips institutional seats.',
            hotSubHeat: 'Buzz', hotSubLhb: 'Dragon-Tiger', hotSubYouzi: 'Hot money',
            hotHeat: 'Buzz', hotPopularity: 'Tag',
            hotNote: 'Buzz measures discussion volume, not bullishness. Click any row for technicals. Sources: 10jqka popularity (primary), EastMoney Guba (fallback).',
            techCol: 'Tech', techBull: 'MA bull', techBear: 'MA bear', techAbove: 'MACD above', techBtn: 'Technicals',
            techMinute: 'Intraday', techDaily: 'Daily', techWeekly: 'Weekly', techMonthly: 'Monthly', techScore: 'Tech state',
            techNotes: 'Read', techSignals: 'Signals',
            infoHint: 'Treat meetings and delivery days as a calendar: check the next three dates, then how often the index rose on the same kind of date. Base rates explain what moves the tape, not a forecast.',
            eventPre: 'T-1', eventDay: 'Event day', eventNext: 'T+1', eventNext5: 'T+5',
            eventWin: 'Win rate', eventSample: 'n', eventEstimate: 'estimated',
            themesHint: 'Similar cycles sit together: tech (AI capex/inventory), consumer (hogs/content), new energy (capacity/prices), property chain, resources (metal prices). Click a card for cycle position, constituents and per-stock technicals.',
            themeSmall: 'Short cycle', themeBig: 'Long cycle', themePe: 'Median PE', themePb: 'Median PB', themeCount: 'Names',
            themeStocks: 'Constituents', themeSearch: 'Search within theme…', themeNoStocks: 'No theme data yet.',
            themeProxy: 'Hang Seng Tech has no A-share constituents; the daily bars of ETF 513130 are used as a proxy.',
            themeHint: 'Short cycle = 1-year price percentile; long cycle = 5-year price percentile. Click a stock for candles, MAs and MACD.',
            techHint: 'Candles + MA5/10/20/60 + volume + MACD. Technical description only, not investment advice.',
            paperEquity: 'Equity curve',
            paperRobot: 'Robot paper account: picks bottom-reversal leaders automatically; rules mode until opencode is connected for trade reasons.',
            robotTitle: 'Robot trader', robotRun: 'Run robot', robotNext: 'Next auto run',
            robotLast: 'Last run', robotNoAction: 'No fills this run', robotRejected: 'Rejected', robotWatch: 'Watch',
            searchStock: 'Search stocks / ETFs / sectors / global…', searchEtf: 'Search ETFs…',
            boardTag: 'Sector', viewIndustry: 'Industries', viewConcept: 'Concepts', viewSub: 'Sub-industries', heatmap: 'Heatmap', cards: 'Cards',
            etfTag: 'ETF', stockTag: 'Stock',
            prevClose: 'Prev close', open: 'Open', high: 'High', low: 'Low', quoteTime: 'Time', quoteSource: 'Source',
            noQuote: 'No quote right now.',
            allCat: 'All', sortAmount: 'By amount', sort5: 'By 5-day', sort20: 'By 20-day', sortPos: 'By 1y pos (low→high)',
            etfLive: 'Price refreshes every 10s', colName: 'Name', colCode: 'Code', colCat: 'Cat', colPrice: 'Price', colPct: 'Change',
            col5: '5d', col20: '20d', colPos: '1y pos', colAmount: 'Amount', etfAsOf: 'Bars as of', colQty: 'Qty', colCost: 'Cost',
            colMv: 'MV', colPnl: 'P&L', colPnlPct: 'P&L %', colDate: 'Date', colSide: 'Side', buy: 'Buy', sell: 'Sell',
            etfHint: 'ETF daily metrics come from ETL; price and change refresh every 10s. Click a row for details.',
            globalHint: 'Realtime quotes for global indices, stocks, commodities and FX (every 10s during sessions).',
            globalNote: 'Japan/Korea/Germany/UK use US-listed country ETFs or ADRs as proxies; A/HK/US indices are exchange indices.',
            paperEmpty: 'No paper account yet. Create one with CNY 100,000 to start the ETF trend-rotation strategy.',
            paperAuto: 'NAV refreshes every 10s; decisions run after close on daily bars.',
            paperNav: 'Net value', paperPnl: 'Total P&L', paperCash: 'Cash', paperMv: 'Position value',
            paperHint: 'Constraints: max 3 positions, ≤34% each, 100-share lots, 0.05% fee + 0.05% slippage, -8% hard stop; auto-runs weekdays 14:50.',
            paperPositions: 'Positions', paperNoPos: 'No positions.',
            paperDecisions: 'Decision log', paperNoDecisions: 'No decisions yet.',
            paperTrades: 'Trades', actionTrade: 'Trade', actionHold: 'Hold',
            runDecide: 'Run a decision', initAccount: 'Create account', running: 'Running…',
          },
        })
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: -1,
          label: () => t('panel'), locale: NS,
        }, PanelIcon))
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: PANEL_ID, locale: NS,
        }, (props) => h(BoardPage, { ...props, t })))
      },
    }
  },
})
} catch (err) {
  console.error('[sector-board] client module registration failed', err)
}
