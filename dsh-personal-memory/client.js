/**
 * dsh-personal-memory —— Web 面板（client 半）。
 *
 * 一个整页面板，两个世界的窗口：
 *   personal/  个人记忆 —— 我懂过什么（认知、判断、方法）
 *   memory/    时间长河 —— 我经历过什么（日记，一天一格）
 * 外加「检索」和「召回」两页：前者手动翻库，后者看每轮自动召回的运行状况。
 *
 * 只依赖宿主内置的 react / slots / locale；数据全部来自 host 自注册的
 * HTTP 路由 /personal-memory/*。组件用 React.createElement 手写（这里没有 JSX）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-personal-memory',
  factory(require) {
    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback, useMemo, useRef, Fragment } = React

    const NS = 'personal-memory.panel'
    const PAGE_ID = 'personal-memory'
    const inject = ['slots', 'locale']

    /* ------------------------------------------------------------------ *
     * 探针：client 半每次加载都往 host 打一次点。
     * GUI 需要 token、拿不到页面控制台时，「这段代码到底跑了没有」只能靠它证明。
     * 失败无所谓（探针不能拖垮面板），永不 throw。
     * ------------------------------------------------------------------ */
    function beacon(stage) {
      try {
        const q = new URLSearchParams({ stage: String(stage).slice(0, 120) })
        if (typeof location !== 'undefined' && location.href) q.set('href', location.href.slice(0, 400))
        if (typeof navigator !== 'undefined' && navigator.userAgent) q.set('ua', navigator.userAgent.slice(0, 200))
        fetch('/personal-memory/beacon?' + q.toString(), { cache: 'no-store' }).catch(() => {})
      } catch {
        /* 探针永远不报错 */
      }
    }
    beacon('factory')
    try {
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('error', (event) => beacon('error: ' + String(event?.message ?? event?.error ?? 'unknown')))
      }
    } catch {
      /* 同上 */
    }

    /* ------------------------------------------------------------------ *
     * 主题：只用宿主的 --dsw-alias-* token，深浅色自动跟随
     * ------------------------------------------------------------------ */
    const C = {
      bg: 'var(--dsw-alias-bg-base, #f6f7f9)',
      surface: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      surface2: 'var(--dsw-alias-bg-layer-2, #f1f2f5)',
      overlay: 'var(--dsw-alias-bg-overlay, #ffffff)',
      text: 'var(--dsw-alias-label-primary, #1f2329)',
      muted: 'color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 64%, transparent)',
      border: 'var(--dsw-alias-border-l2, #c7ccd4)',
      borderStrong: 'var(--dsw-alias-border-l3, #9aa1ab)',
      accent: 'var(--dsw-alias-brand-primary, #3b6ef6)',
      accentSoft: 'color-mix(in srgb, var(--dsw-alias-brand-primary, #3b6ef6) 12%, transparent)',
      success: 'var(--dsw-alias-state-success-primary, #30a46c)',
      warn: 'var(--dsw-alias-state-warn-primary, #f5a623)',
      danger: 'var(--dsw-alias-state-error-primary, #e5484d)',
    }

    const CSS = `
.pmp-root *{box-sizing:border-box}
.pmp-root{height:100%;min-height:0;display:flex;flex-direction:column;background:${C.bg};color:${C.text};font-family:inherit;font-size:13px;padding-top:var(--dsh-frame-top-clearance,0px)}
.pmp-head{display:flex;align-items:center;gap:10px;padding:13px 18px 9px;flex:none;min-width:0}
.pmp-brand{display:flex;align-items:center;gap:9px;min-width:0}
.pmp-brand>svg{color:${C.accent};flex:none}
.pmp-brand-txt{min-width:0}
.pmp-title{font-size:13.5px;font-weight:600;letter-spacing:.2px;line-height:1.25}
.pmp-sub{font-size:11px;color:${C.muted};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:46vw}
.pmp-tabs{display:flex;gap:2px;background:${C.surface2};padding:3px;border-radius:9px;margin-left:4px;flex:none}
.pmp-tab{appearance:none;border:0;background:transparent;color:${C.muted};font:inherit;font-size:12.5px;padding:5px 11px;border-radius:7px;cursor:pointer;white-space:nowrap;transition:background .12s ease,color .12s ease}
.pmp-tab:hover{color:${C.text}}
.pmp-tab.on{background:${C.surface};color:${C.text};box-shadow:0 1px 2px rgba(0,0,0,.07),0 0 0 1px ${C.border}}
.pmp-spacer{flex:1;min-width:8px}
.pmp-btn{appearance:none;border:1px solid ${C.border};background:${C.surface};color:${C.text};font:inherit;font-size:12.5px;padding:6px 12px;border-radius:8px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;transition:background .12s ease,border-color .12s ease}
.pmp-btn:hover{background:${C.surface2}}
.pmp-btn:disabled{opacity:.5;cursor:default}
.pmp-btn.primary{background:${C.accent};border-color:transparent;color:#fff}
.pmp-btn.primary:hover{filter:brightness(1.06)}
.pmp-btn.ghost{background:transparent;border-color:transparent;color:${C.muted};padding:6px 8px}
.pmp-btn.ghost:hover{background:${C.surface2};color:${C.text}}
.pmp-btn.sm{font-size:11.5px;padding:4px 9px;border-radius:7px}
.pmp-strip{display:flex;align-items:center;gap:14px;padding:0 18px 9px;font-size:11px;color:${C.muted};flex:none;flex-wrap:wrap}
.pmp-strip b{font-weight:600;color:${C.text};font-variant-numeric:tabular-nums}
.pmp-dot{width:6px;height:6px;border-radius:50%;background:${C.borderStrong};display:inline-block;margin-right:5px;vertical-align:1px}
.pmp-dot.ok{background:${C.success}}
.pmp-dot.bad{background:${C.danger}}
.pmp-body{flex:1;min-height:0;display:flex;border-top:1px solid ${C.border}}
.pmp-master{width:338px;flex:none;border-right:1px solid ${C.border};overflow:auto;background:${C.surface};padding:0 0 28px;min-height:0}
.pmp-detail{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;background:${C.bg}}
.pmp-full{flex:1;min-height:0;overflow:auto;padding:16px 22px 40px}
.pmp-scroll{flex:1;min-height:0;overflow:auto}

/* 左侧列表 */
.pmp-audit{margin:8px 10px 0;padding:8px 10px;border-radius:8px;font-size:11.5px;line-height:1.5}
.pmp-audit-ok{display:flex;align-items:center;gap:6px;color:${C.muted};background:transparent;padding:2px 12px 0}
.pmp-audit-ok .pmp-audit-tick{color:${C.success}}
.pmp-audit-bad{border:1px solid ${C.warn};background:color-mix(in srgb,${C.warn} 8%,transparent);display:flex;flex-direction:column;gap:4px}
.pmp-audit-h{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.pmp-audit-bad .pmp-audit-t{font-weight:600;color:${C.warn}}
.pmp-audit-note{color:${C.muted};font-size:11px}
.pmp-audit-row{display:flex;align-items:baseline;gap:6px;width:100%;text-align:left;border:0;background:transparent;color:${C.text};font:inherit;padding:2px 0;cursor:pointer}
.pmp-audit-row:hover{text-decoration:underline}
.pmp-audit-lv{flex:none;font-size:10px;padding:0 4px;border-radius:4px;border:1px solid ${C.border}}
.pmp-audit-lv.p0{color:${C.danger};border-color:${C.danger}}
.pmp-audit-lv.p1{color:${C.muted}}
.pmp-audit-p{flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:44%}
.pmp-audit-i{flex:1 1 auto;color:${C.muted};overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pmp-audit-more{color:${C.muted};font-size:11px}
.pmp-searchbox{position:sticky;top:0;z-index:3;background:${C.surface};padding:9px 10px 9px;border-bottom:1px solid ${C.border}}
.pmp-input{width:100%;font:inherit;font-size:12.5px;padding:7px 10px;border-radius:8px;border:1px solid ${C.border};background:${C.bg};color:${C.text};outline:none;transition:border-color .12s ease,box-shadow .12s ease}
.pmp-input:focus{border-color:${C.accent};box-shadow:0 0 0 3px ${C.accentSoft}}
.pmp-input::placeholder{color:${C.muted}}
.pmp-group{margin-top:2px}
.pmp-group-h{display:flex;align-items:center;gap:6px;padding:7px 12px 5px;font-size:10.5px;font-weight:600;letter-spacing:.3px;color:${C.muted};cursor:pointer;user-select:none}
.pmp-group-h:hover{color:${C.text}}
.pmp-caret{display:inline-block;transition:transform .12s ease;font-size:8px;color:${C.muted};width:8px}
.pmp-caret.open{transform:rotate(90deg)}
.pmp-count{margin-left:auto;font-weight:400;font-size:10px;background:${C.surface2};color:${C.muted};padding:1px 6px;border-radius:99px;font-variant-numeric:tabular-nums}
.pmp-item{display:block;width:100%;text-align:left;border:0;border-left:2px solid transparent;background:transparent;font:inherit;color:${C.text};padding:7px 12px 7px 13px;cursor:pointer;transition:background .1s ease}
.pmp-item:hover{background:${C.surface2}}
.pmp-item.on{background:${C.accentSoft};border-left-color:${C.accent}}
.pmp-item-t{font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.35}
.pmp-item-m{font-size:10.5px;color:${C.muted};margin-top:2px;display:flex;gap:7px;overflow:hidden;white-space:nowrap}
.pmp-item-m .sep{opacity:.5}

/* 时间长河 */
.pmp-tl{padding:4px 8px 8px}
.pmp-tl-ms{margin-left:auto;font-weight:400;font-size:11px;color:${C.muted}}
.pmp-year{padding:8px 6px 6px;border-bottom:1px solid ${C.border};margin-bottom:2px}
.pmp-year-h{display:flex;align-items:center;gap:6px;font-size:10.5px;font-weight:600;color:${C.muted};margin-bottom:6px}
.pmp-year-t{font-variant-numeric:tabular-nums}
.pmp-year-g{display:grid;grid-template-columns:repeat(12,1fr);gap:3px}
.pmp-ym{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;height:34px;padding:0;border:1px solid ${C.border};border-radius:5px;background:transparent;color:${C.muted};font:inherit;font-size:9.5px;line-height:1;cursor:pointer}
.pmp-ym.on{color:${C.text};border-color:transparent}
.pmp-ym:hover{border-color:${C.borderStrong}}
.pmp-ym-m{font-weight:600}
.pmp-ym-n{font-size:8.5px;opacity:.75;font-variant-numeric:tabular-nums}
.pmp-tl-m{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:8px;padding:10px 6px 6px;font-size:10.5px;font-weight:600;color:${C.muted};background:${C.surface};font-variant-numeric:tabular-nums}
.pmp-tl-m:after{content:'';flex:1;height:1px;background:${C.border}}
.pmp-tl-m span{white-space:nowrap}
.pmp-gap{display:flex;align-items:center;gap:8px;padding:1px 0 3px 13px;font-size:10.5px;color:${C.muted}}
.pmp-gap-l{flex:0 0 auto;width:1px;height:12px;background:${C.borderStrong};opacity:.6}
.pmp-day{position:relative;display:block;width:100%;text-align:left;border:0;border-left:2px solid transparent;background:transparent;font:inherit;color:inherit;cursor:pointer;padding:7px 8px 7px 22px;border-radius:8px;transition:background .1s ease}
.pmp-day:hover{background:${C.surface2}}
.pmp-day.on{background:${C.accentSoft};border-left-color:${C.accent}}
.pmp-day:before{content:'';position:absolute;left:6px;top:14px;width:7px;height:7px;border-radius:50%;background:${C.borderStrong};box-shadow:0 0 0 3px ${C.surface}}
.pmp-day.on:before{background:${C.accent}}
.pmp-day-r{display:flex;align-items:baseline;gap:7px}
.pmp-day-d{font-size:12.5px;font-variant-numeric:tabular-nums;letter-spacing:.2px}
.pmp-day-w{font-size:10.5px;color:${C.muted}}
.pmp-day-n{margin-left:auto;font-size:10.5px;color:${C.muted};font-variant-numeric:tabular-nums}
.pmp-day-p{font-size:11px;color:${C.muted};margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pmp-badge{font-size:10px;padding:1px 6px;border-radius:99px;background:${C.accentSoft};color:${C.accent};white-space:nowrap;font-variant-numeric:tabular-nums}
.pmp-badge.warn{background:color-mix(in srgb,${C.warn} 16%,transparent);color:${C.warn}}
.pmp-badge.mute{background:${C.surface2};color:${C.muted}}

/* 未完成清单 */
.pmp-td-x{display:inline-block;width:12px;transition:transform .12s;color:${C.muted}}
.pmp-td-x.on{transform:rotate(90deg)}
.pmp-td-g{display:flex;align-items:center;gap:8px;padding:10px 12px 5px;font-size:10.5px;font-weight:600;letter-spacing:.3px;color:${C.muted};position:sticky;top:0;background:${C.surface};z-index:2;font-variant-numeric:tabular-nums}
.pmp-td{display:flex;gap:9px;align-items:flex-start;width:100%;text-align:left;border-left:2px solid transparent;background:transparent;color:${C.text};padding:7px 12px 7px 13px;transition:background .1s ease}
.pmp-td:hover{background:${C.surface2}}
.pmp-td.on{background:${C.accentSoft};border-left-color:${C.accent}}
.pmp-wr{border:1px solid color-mix(in srgb, ${C.warn} 34%, transparent);background:color-mix(in srgb, ${C.warn} 7%, transparent);border-radius:9px;padding:8px 10px;margin:0 0 10px}
.pmp-wr-h{font-size:11.5px;color:${C.muted};margin-bottom:6px}
.pmp-wr-row{display:flex;align-items:center;gap:8px;padding:3px 0}
.pmp-wr-t{flex:1 1 auto;min-width:0;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pmp-wr-input{flex:1 1 100%;margin-top:2px;font-size:12px;padding:4px 8px}
.pmp-td-next{display:block;font-size:11.5px;color:${C.accent};margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.pmp-td-nextw{color:${C.accent};margin-left:6px}
.pmp-wr-d{flex:none;font-size:11px;color:${C.muted}}
.pmp-td-wait{flex:none;align-self:center;border:1px dashed ${C.border};background:transparent;color:${C.muted};font-size:10.5px;padding:2px 6px;border-radius:6px;cursor:pointer;font-family:inherit;opacity:.6;white-space:nowrap}
.pmp-td:hover .pmp-td-wait{opacity:1}
.pmp-td-wait.on{opacity:1;border-style:solid;border-color:${C.borderStrong}}
.pmp-td-wait.on.wait-market{color:${C.warn};border-color:${C.warn};background:color-mix(in srgb, ${C.warn} 12%, transparent)}
.pmp-td-wait.on.wait-reply{color:${C.accent};border-color:${C.accent};background:${C.accentSoft}}
.pmp-td-wait.on.wait-decide{color:${C.text};border-color:${C.borderStrong};background:${C.surface2}}
.pmp-td-defer{flex:none;align-self:center;border:1px solid ${C.border};background:transparent;color:${C.muted};font-size:10.5px;padding:2px 6px;border-radius:6px;cursor:pointer;font-family:inherit;opacity:.75}
.pmp-td:hover .pmp-td-defer{opacity:1}
.pmp-td-defer-tom{margin-left:auto}
.pmp-td-defer-mon{opacity:.7}
.pmp-td-defer:hover{color:${C.accent};border-color:${C.accent};background:${C.accentSoft}}
.pmp-td-open{flex:1;min-width:0;display:flex;flex-direction:column;gap:0;border:0;background:transparent;padding:0;font:inherit;color:inherit;text-align:left;cursor:pointer}
.pmp-td-box{flex:none;width:13px;height:13px;margin-top:3px;padding:0;border:1px solid ${C.borderStrong};border-radius:3.5px;background:transparent;cursor:pointer;transition:background .12s ease,border-color .12s ease}
.pmp-td-box:hover{border-color:${C.accent};background:${C.accentSoft}}
.pmp-td-t{flex:1;min-width:0;font-size:12.5px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.pmp-td-m{font-size:10.5px;color:${C.muted};margin-top:3px;display:flex;gap:7px;align-items:center;flex-wrap:wrap}

/* 检索 */
.pmp-hit{display:block;width:100%;text-align:left;border:0;border-bottom:1px solid ${C.border};border-left:2px solid transparent;background:transparent;font:inherit;color:inherit;padding:10px 12px;cursor:pointer;transition:background .1s ease}
.pmp-hit:hover{background:${C.surface2}}
.pmp-hit.on{background:${C.accentSoft};border-left-color:${C.accent}}
.pmp-hit-t{display:flex;gap:8px;align-items:baseline}
.pmp-hit-title{font-size:12.5px;font-weight:500;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pmp-score{font-size:10.5px;color:${C.muted};font-variant-numeric:tabular-nums;flex:none}
.pmp-bar{height:2px;background:${C.border};border-radius:2px;margin-top:5px;overflow:hidden}
.pmp-bar>i{display:block;height:100%;background:${C.accent};border-radius:2px}
.pmp-hit-age.pmp-used{color:${C.accent};background:${C.accentSoft}}
.pmp-hit-age{flex:0 0 auto;font-size:10px;color:${C.muted};background:${C.surface2};padding:1px 5px;border-radius:5px}
.pmp-hit-h{font-size:10.5px;color:${C.accent};margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pmp-hit-e{font-size:11px;color:${C.muted};margin-top:3px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.5}
.pmp-chip-sep{flex:0 0 auto;width:1px;height:14px;background:${C.border};margin:0 2px}
.pmp-chips-row{display:flex;gap:5px;flex-wrap:wrap;margin-top:8px}
.pmp-prev{display:flex;flex-direction:column;gap:6px}
.pmp-prev-row{display:flex;flex-direction:column;gap:3px;text-align:left;padding:9px 11px;border:1px solid ${C.border};border-radius:9px;background:${C.surface};cursor:pointer;font:inherit;color:inherit}
.pmp-prev-row:hover{border-color:${C.borderStrong}}
.pmp-prev-d{display:flex;align-items:center;gap:7px;font-size:11.5px;color:${C.muted}}
.pmp-prev-dt{font-weight:600;color:${C.text}}
.pmp-prev-w{font-size:11px}
.pmp-prev-p{font-size:12px;line-height:1.55;color:${C.muted};display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.pmp-today-first{margin:12px 14px 0;padding:13px 14px;border:1px solid ${C.border};border-left:3px solid ${C.accent};border-radius:10px;background:${C.surface}}
.pmp-today-first-h{display:flex;align-items:center;gap:7px;font-size:13.5px;font-weight:600;color:${C.text}}
.pmp-today-first-p{margin-top:5px;font-size:11.5px;line-height:1.6;color:${C.muted}}
.pmp-today-first-a{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.pmp-td-wrap{flex-wrap:wrap}
.pmp-mv{font:inherit;cursor:pointer;border:0}
    .pmp-mv.on{background:${C.accentSoft};color:${C.accent}}
    .pmp-mv-b{flex-basis:100%;margin:6px 0 2px 24px;padding:6px 8px;border-left:2px solid ${C.border};font-size:11.5px;color:${C.muted};line-height:1.7}
    .pmp-mv-h{color:${C.text};margin-bottom:2px}
    .pmp-mv-i{display:flex;gap:8px}
    .pmp-mv-d{flex:none;font-variant-numeric:tabular-nums;color:${C.text}}
    .pmp-mv-n{color:${C.muted}}
    .pmp-mv-ask{flex-basis:100%;margin:8px 0 2px 24px;padding:8px;border:1px solid ${C.borderStrong};border-radius:8px;background:${C.surface2}}
    .pmp-mv-ask-h{font-size:12px;color:${C.text};margin-bottom:6px}
    .pmp-mv-ask-a{display:flex;gap:6px;margin-top:6px}
    .pmp-td-ctx{flex:none;width:18px;height:18px;border-radius:50%;border:1px solid ${C.border};background:transparent;color:${C.muted};font-size:10px;line-height:1;cursor:pointer;font-family:inherit;opacity:.6}
.pmp-td:hover .pmp-td-ctx,.pmp-td-ctx.on{opacity:1}
.pmp-td-ctx.on{color:${C.accent};border-color:${C.accent};background:${C.accentSoft}}
.pmp-td-ctxb{flex-basis:100%;margin:6px 0 2px 26px;padding:8px 10px;border-left:2px solid ${C.borderStrong};background:${C.surface2};border-radius:0 6px 6px 0}
.pmp-td-ctxb-h{font-size:11px;color:${C.muted};margin-bottom:3px}
.pmp-td-ctxb-p{font-size:12.5px;line-height:1.55;color:${C.text};white-space:pre-wrap;word-break:break-word}
.pmp-td-ctxb-open{margin-top:6px;border:0;background:transparent;color:${C.accent};font-size:11.5px;cursor:pointer;padding:0;font-family:inherit;text-decoration:underline}
.pmp-day-t{display:block;margin-top:4px;font-size:11px;color:${C.muted};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pmp-day-tk{color:${C.accent};margin-right:4px}
.pmp-subh{display:flex;align-items:center;gap:6px;margin:10px 2px 4px;font-size:11px;color:${C.muted}}
.pmp-today-add{display:flex;gap:6px;margin-top:10px}
.pmp-today-add .pmp-input{flex:1;min-width:0}
.pmp-recent{padding:10px 12px 2px;border-bottom:1px solid ${C.border}}
.pmp-recent-h{font-size:10.5px;color:${C.muted};margin-bottom:2px}
.pmp-trial{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:10px}
.pmp-trial-k{font-size:10.5px;color:${C.muted};margin-right:2px}
.pmp-trial-sep{width:1px;height:14px;background:${C.border};margin:0 4px}
.pmp-trial-hint{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px;font-size:10.5px;color:${C.muted}}
.pmp-state-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:8px;margin:6px 0 8px}
.pmp-state-c{border:1px solid ${C.border};border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:4px;align-items:flex-start}
.pmp-state-k{font-size:11px;color:${C.muted}}
.pmp-state-v{font-size:17px;font-weight:650;font-variant-numeric:tabular-nums}
.pmp-state-n{font-size:11.5px;color:${C.muted};line-height:1.6}
.pmp-state-mig{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11.5px;color:${C.warn};margin:2px 0 6px}
.pmp-exp{margin:10px 0 4px}
.pmp-exp-h{font-size:11px;color:${C.muted};margin-bottom:4px}
.pmp-vis-row{display:flex;align-items:center;gap:6px;width:100%;padding:2px 2px 2px 0;border:1px solid ${C.border};border-radius:9px;background:${C.surface}}
.pmp-vis-row:hover{border-color:${C.borderStrong};background:${C.surface2}}
/* 侧栏只有 338px：标题一行、时间一行，别把标题挤成「sto…」 */
.pmp-vis-main{display:flex;flex-direction:column;gap:2px;align-items:flex-start;flex:1;min-width:0;padding:5px 4px 5px 8px;border:0;background:transparent;text-align:left;cursor:pointer;font:inherit;color:inherit}
.pmp-vis-line{display:flex;align-items:center;gap:6px;min-width:0;max-width:100%}
.pmp-res-row{display:flex;align-items:baseline;gap:8px;padding:4px 2px;font-size:11.5px;color:${C.muted}}
.pmp-res-row + .pmp-res-row{border-top:1px dashed ${C.border}}
.pmp-res-t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${C.text}}
.pmp-res-d{flex:none;color:${C.muted}}
.pmp-vis-wrap{display:flex;flex-direction:column;gap:4px;border:1px solid ${C.border};border-radius:10px;background:${C.surface};padding:2px 2px 4px}
.pmp-vis-wrap .pmp-vis-row{border:0;background:transparent}
.pmp-vis-clue{align-self:flex-end;margin:0 8px 2px;padding:2px 8px;border:1px dashed ${C.border};border-radius:7px;background:transparent;color:${C.muted};font:inherit;font-size:10.5px;cursor:pointer}
.pmp-vis-clue:hover{color:${C.accent};border-color:${C.accent}}
.pmp-meta-k{color:inherit;font-weight:600}
.pmp-vis-go{flex:none;align-self:flex-start;margin-top:7px;border:1px solid ${C.accent};background:transparent;color:${C.accent};font-size:11px;line-height:1;padding:3px 7px;border-radius:7px;cursor:pointer;white-space:nowrap;opacity:.9}
.pmp-vis-go:hover{opacity:1;background:${C.accentSoft}}
.pmp-vis-edit{align-self:flex-start;margin-top:7px}

.pmp-clue-kind{display:flex;gap:6px;flex-wrap:wrap}

.pmp-dist{display:inline-flex;gap:6px;margin-left:10px;vertical-align:middle}
.pmp-dist-b{padding:1px 7px;font-size:11px;border:1px solid ${C.border};border-radius:6px;background:transparent;color:${C.muted};cursor:pointer}
.pmp-dist-b.on{color:${C.accent};border-color:${C.accent};background:${C.accentSoft}}
.pmp-none-clue{display:flex;flex-direction:column;gap:8px;align-items:flex-start;padding:2px 12px 14px}
.pmp-none-hint{font-size:11.5px;color:${C.muted};line-height:1.6}
.pmp-clue{margin:2px 8px 4px;padding:7px 8px;border:1px solid ${C.accent};border-radius:9px;background:${C.accentSoft};display:flex;flex-direction:column;gap:6px}
.pmp-clue-h{font-size:11px;color:${C.text}}
.pmp-clue-a{display:flex;gap:6px}
.pmp-vis-edit{flex:none;margin-right:6px;padding:3px 8px;border:1px solid ${C.border};border-radius:7px;background:${C.bg};color:${C.accent};font:inherit;font-size:11px;cursor:pointer;opacity:.8}
.pmp-vis-edit:hover{opacity:1;border-color:${C.accent}}
.pmp-vis-t{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.pmp-vis-n{font-size:11px;color:${C.muted};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;font-variant-numeric:tabular-nums}
.pmp-exp-list{display:flex;flex-direction:column;gap:4px}
.pmp-exp-row{display:grid;grid-template-columns:64px minmax(120px,1fr) 88px 92px;gap:8px;align-items:center;width:100%;padding:6px 10px;border:1px solid ${C.border};border-radius:9px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.pmp-exp-row:hover{background:${C.surface2}}
.pmp-exp-k{font-size:11px;color:${C.accent}}
.pmp-exp-q{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pmp-exp-n{font-size:11.5px;color:${C.muted};font-variant-numeric:tabular-nums}
.pmp-exp-t{font-size:11px;color:${C.muted};text-align:right;font-variant-numeric:tabular-nums}
.pmp-cmpbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 0 4px}
.pmp-cmpbar-h{font-size:11px;color:${C.muted}}
.pmp-cmp{border:1px solid ${C.border};border-radius:10px;overflow:hidden;margin:6px 0 10px}
.pmp-cmp-h{padding:6px 10px;font-size:11px;color:${C.muted};background:${C.surface2}}
.pmp-cmp-row{display:grid;grid-template-columns:72px minmax(120px,1.4fr) 56px 46px minmax(120px,1.6fr);gap:8px;align-items:center;width:100%;padding:7px 10px;border:0;border-top:1px solid ${C.border};background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.pmp-cmp-row:hover{background:${C.surface2}}
.pmp-cmp-row.on .pmp-cmp-n{color:${C.accent};font-weight:600}
.pmp-cmp-k{font-size:11px;color:${C.muted}}
.pmp-cmp-q{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pmp-cmp-n,.pmp-cmp-t{font-size:12px;font-variant-numeric:tabular-nums;color:${C.muted}}
.pmp-cmp-row.pmp-cmp-head{background:${C.surface2};cursor:default;border-top:1px solid ${C.border}}
.pmp-cmp-row.pmp-cmp-head:hover{background:${C.surface2}}
.pmp-cmp-row.pmp-cmp-head .pmp-cmp-t,.pmp-cmp-row.pmp-cmp-head .pmp-cmp-n{font-size:11px;color:${C.muted}}
.pmp-cmp-head{grid-template-columns:72px minmax(120px,1.4fr) 56px 46px 46px 46px}
.pmp-cmp-row{grid-template-columns:72px minmax(120px,1.4fr) 56px 46px 46px 46px}
.pmp-cmp-w{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:${C.muted}}
.pmp-state-vs{color:${C.accent}}
.pmp-state-f{font-size:11px;color:${C.muted};font-variant-numeric:tabular-nums;margin-bottom:6px}
.pmp-snippet{margin-top:8px;border:1px solid ${C.border};border-radius:10px;overflow:hidden}
.pmp-snippet-h{padding:6px 10px;background:${C.surface2};font-size:10.5px;color:${C.muted}}
.pmp-snippet-c{margin:0;padding:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.6;white-space:pre;overflow-x:auto;color:${C.text}}
.pmp-snippet-a{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border-top:1px solid ${C.border}}
.pmp-snippet-n{font-size:10.5px;color:${C.muted}}
.pmp-proc{margin-top:12px;border:1px solid ${C.border};border-radius:10px;overflow:hidden}
.pmp-proc-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;background:${C.surface2};font-size:11px;color:${C.muted}}
.pmp-proc-k{font-weight:600;color:${C.text}}
.pmp-proc-p,.pmp-proc-c{font-variant-numeric:tabular-nums}
.pmp-proc-row{display:flex;align-items:flex-start;gap:8px;width:100%;padding:8px 10px;border:0;border-top:1px solid ${C.border};background:transparent;text-align:left;cursor:pointer;font:inherit;color:inherit}
.pmp-proc-row:hover{background:${C.surface2}}
.pmp-proc-row.on{background:${C.accentSoft}}
.pmp-proc-m{width:14px;flex:none;font-size:12px;color:${C.muted}}
.pmp-proc-row.on .pmp-proc-m{color:${C.accent};font-weight:700}
.pmp-proc-b{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.pmp-proc-t{display:flex;align-items:center;gap:6px;min-width:0}
.pmp-proc-ti{font-size:12.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pmp-proc-path{font-size:10.5px;color:${C.muted};word-break:break-all}
.pmp-drop{border-top:1px solid ${C.border}}
.pmp-drop-need{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:10.5px;color:${C.muted}}
.pmp-drop-h{background:transparent}
.pmp-drop-i{opacity:.72}
.pmp-drop-i:hover{opacity:1}
.pmp-proc-e{font-size:11.5px;color:${C.muted};display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.pmp-log{border-bottom:1px solid ${C.border}}
.pmp-log-h{display:flex;align-items:baseline;gap:8px;width:100%;padding:7px 2px;border:0;background:transparent;color:${C.text};text-align:left;font-size:12px;cursor:pointer;border-radius:6px}
.pmp-log-h:hover:not(:disabled){background:${C.surface2}}
.pmp-log-h:disabled{cursor:default}
.pmp-log-h.on{background:${C.surface2}}
.pmp-log-t{flex:0 0 auto;font-size:10.5px;color:${C.muted};font-variant-numeric:tabular-nums}
.pmp-log-q{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pmp-log-n{flex:0 0 auto;font-size:10.5px;color:${C.muted}}
.pmp-log-x{flex:0 0 auto;font-size:10px;color:${C.muted}}
.pmp-log-i{padding:2px 0 8px 8px;display:flex;flex-direction:column;gap:2px}
.pmp-log-p{display:flex;align-items:baseline;gap:8px;padding:5px 8px;border:0;background:transparent;border-radius:6px;color:${C.text};text-align:left;font-size:12px;cursor:pointer}
.pmp-log-p:hover{background:${C.accentSoft}}
.pmp-log-pi{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pmp-log-pc{flex:0 0 auto;font-size:10px;color:${C.muted};font-variant-numeric:tabular-nums;display:inline-flex;align-items:center;gap:4px}
.pmp-log-b{font-size:10.5px;color:${C.muted};padding:3px 8px 6px;display:flex;align-items:center;gap:8px}
.pmp-log-bbar{flex:0 0 90px;height:3px;border-radius:2px;background:${C.surface2};overflow:hidden;display:inline-block}
.pmp-log-bbar i{display:block;height:100%;background:${C.accent}}
.pmp-log-ps{flex:0 0 auto;font-size:10px;color:${C.muted};font-variant-numeric:tabular-nums}
.pmp-chipb{appearance:none;font:inherit;font-size:11px;padding:3px 9px;border-radius:99px;border:1px solid ${C.border};background:${C.surface};color:${C.muted};cursor:pointer;transition:all .1s ease}
.pmp-chipb:hover{color:${C.text}}
.pmp-chipb.dim{opacity:.45;cursor:default}
.pmp-chipb.on{background:${C.accentSoft};border-color:${C.accent};color:${C.accent}}

/* 阅读器 */
.pmp-doc{padding:20px 30px 90px;max-width:840px}
.pmp-doc-h{display:flex;align-items:flex-start;gap:10px}
.pmp-doc-t{font-size:19px;font-weight:600;line-height:1.35;flex:1;min-width:0}
.pmp-doc-path{font-size:10.5px;color:${C.muted};word-break:break-all;margin-top:3px}
.pmp-chips{display:flex;flex-wrap:wrap;gap:6px;margin:11px 0 2px}
.pmp-chip{font-size:10.5px;color:${C.muted};background:${C.surface2};border:1px solid ${C.border};padding:2px 7px;border-radius:99px}
.pmp-toc{display:flex;flex-wrap:wrap;gap:3px;margin:12px 0 16px;padding-bottom:12px;border-bottom:1px solid ${C.border}}
.pmp-toc-b{appearance:none;border:0;background:transparent;font:inherit;font-size:11px;color:${C.muted};padding:2px 6px;border-radius:5px;cursor:pointer;text-align:left}
.pmp-toc-b:hover{background:${C.surface2};color:${C.accent}}
.pmp-mask{position:absolute;inset:0;background:color-mix(in srgb, #000 34%, transparent);display:flex;align-items:flex-start;justify-content:center;padding-top:12vh;z-index:40}
.pmp-qj{width:min(620px,92vw);background:${C.overlay};border:1px solid ${C.borderStrong};border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.32);display:flex;flex-direction:column;max-height:62vh;overflow:hidden}
.pmp-qj-in{display:flex;align-items:center;gap:9px;padding:12px 14px;border-bottom:1px solid ${C.border};color:${C.muted}}
.pmp-qj-input{border:0;background:transparent;outline:none;font:inherit;font-size:14px;color:${C.text};flex:1;padding:2px 0}
.pmp-qj-k{font-size:10px;border:1px solid ${C.borderStrong};border-radius:5px;padding:1px 5px;color:${C.muted};font-variant-numeric:tabular-nums}
.pmp-qj-list{overflow:auto;padding:6px;min-height:60px}
.pmp-qj-page .pmp-qj-t{color:${C.accent}}
.pmp-qj-search{margin-top:4px;border-top:1px dashed ${C.border}}
.pmp-qj-search .pmp-qj-t{color:${C.accent}}
.pmp-qj-recent .pmp-qj-t{color:${C.text}}
.pmp-qj-recent .pmp-qj-m{color:color-mix(in srgb, ${C.accent} 55%, ${C.muted})}
.pmp-qj-row{display:block;width:100%;text-align:left;border:0;background:transparent;color:${C.text};font:inherit;padding:7px 9px;border-radius:8px;cursor:pointer}
.pmp-qj-row.on{background:${C.accentSoft}}
.pmp-qj-t{font-size:12.5px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pmp-qj-m{font-size:10.5px;color:${C.muted};margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pmp-qj-f{padding:7px 14px;border-top:1px solid ${C.border};font-size:10.5px;color:${C.muted}}
.pmp-today{flex:1;min-height:0;overflow:auto;padding:16px 26px 40px;max-width:none}
.pmp-today-todos{display:flex;flex-direction:column;gap:2px}
.pmp-today-more{margin-top:8px}
.pmp-done{margin-top:12px;border-top:1px dashed ${C.border};padding-top:8px}
.pmp-done-h{display:inline-flex;align-items:center;gap:6px;border:0;background:transparent;color:${C.muted};font:inherit;font-size:11.5px;cursor:pointer;padding:2px 0}
.pmp-done-h:hover{color:${C.text}}
.pmp-done-k{color:${C.success};font-weight:700}
.pmp-done-c{text-decoration:underline dotted}
.pmp-done-x{font-size:10px;opacity:.7;transition:transform .12s ease}
.pmp-done-l{display:flex;flex-direction:column;gap:3px;margin:6px 0 2px 2px}
.pmp-done-i{display:flex;align-items:baseline;gap:6px;font-size:12px;color:${C.muted}}
.pmp-done-b{color:${C.success};flex:none}
.pmp-done-t{border:0;background:transparent;font:inherit;padding:0;text-align:left;cursor:pointer;color:inherit;text-decoration:line-through;text-decoration-color:color-mix(in srgb, ${C.muted} 60%, transparent);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pmp-link{appearance:none;border:0;background:transparent;font:inherit;font-size:11.5px;color:${C.accent};cursor:pointer;padding:2px 0}
.pmp-link:hover{text-decoration:underline}
.pmp-today-read{border:1px solid ${C.border};background:${C.surface};border-radius:10px;padding:12px 14px}
.pmp-today-meta{font-size:11px;color:${C.muted};margin-bottom:6px;font-variant-numeric:tabular-nums}
.pmp-today-p{font-size:12.5px;line-height:1.7;color:${C.text};opacity:.92}
.pmp-today-recent{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px}
.pmp-sec{margin-top:22px}
.pmp-sec-h{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;color:${C.muted};letter-spacing:.2px;margin-bottom:10px}
.pmp-sec-a{margin-left:auto;border:0;background:transparent;color:${C.accent};font:inherit;font-size:11.5px;cursor:pointer;padding:2px 4px;border-radius:5px}
.pmp-sec-a:hover{background:${C.accentSoft}}
.pmp-tl-x{display:flex;gap:6px;padding:10px 10px 0;flex-wrap:wrap}
.pmp-tl-xi{display:flex;align-items:center;gap:6px;border:1px solid ${C.border};background:${C.surface};color:${C.muted};font:inherit;font-size:11.5px;padding:4px 8px;border-radius:999px;cursor:pointer;max-width:100%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.pmp-tl-xi:hover{color:${C.accent};border-color:${C.accent}}
.pmp-tl-xi.on{color:${C.accent};border-color:${C.accent};background:${C.accentSoft}}
.pmp-related{margin-top:28px;padding-top:14px;border-top:1px solid ${C.border}}
.pmp-related-h{font-size:11px;font-weight:600;color:${C.muted};margin-bottom:8px;letter-spacing:.2px}
.pmp-rel{display:block;width:100%;text-align:left;border:1px solid ${C.border};background:${C.surface};border-radius:8px;padding:8px 10px;margin-bottom:6px;font:inherit;color:${C.text};cursor:pointer;font-size:12px;line-height:1.45;transition:border-color .12s ease,color .12s ease}
.pmp-rel:hover{border-color:${C.accent};color:${C.accent}}
.pmp-rel small{display:block;color:${C.muted};font-size:10.5px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* markdown */
.pmp-md{font-size:13px;line-height:1.74;color:${C.text}}
.pmp-md>*:first-child{margin-top:0}
.pmp-h{font-weight:600;line-height:1.42;scroll-margin-top:18px}
.pmp-h1{font-size:19px;margin:26px 0 10px}
.pmp-h2{font-size:15.5px;margin:24px 0 8px;padding-bottom:5px;border-bottom:1px solid ${C.border}}
.pmp-h3{font-size:13.5px;margin:18px 0 6px}
.pmp-h4,.pmp-h5,.pmp-h6{font-size:13px;margin:14px 0 4px;color:${C.muted}}
.pmp-p{margin:8px 0}
.pmp-list{margin:8px 0;padding-left:20px}
.pmp-li{margin:3px 0}
.pmp-task{list-style:none;margin-left:-17px;display:flex;gap:7px;align-items:flex-start}
.pmp-check{flex:none;width:14px;height:14px;margin-top:4px;padding:0;border:1px solid ${C.borderStrong};border-radius:3.5px;background:transparent;font-size:10px;line-height:11.5px;text-align:center;color:transparent}
button.pmp-check{cursor:pointer;transition:border-color .12s ease,background .12s ease}
button.pmp-check:hover{border-color:${C.accent};background:${C.accentSoft}}
.pmp-check.done{background:${C.success};border-color:${C.success};color:#fff}
.pmp-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;background:${C.surface2};border:1px solid ${C.border};padding:1px 4px;border-radius:4px}
.pmp-pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.6;background:${C.surface2};border:1px solid ${C.border};border-radius:8px;padding:10px 12px;overflow:auto;margin:10px 0}
.pmp-pre code{background:transparent;border:0;padding:0;font-size:11.5px}
.pmp-quote{margin:8px 0;padding:2px 0 2px 12px;border-left:2px solid ${C.borderStrong};color:${C.muted}}
.pmp-hr{border:0;height:1px;background:${C.border};margin:18px 0}
.pmp-a{color:${C.accent};text-decoration:none}
.pmp-a:hover{text-decoration:underline}
.pmp-table{border-collapse:collapse;margin:10px 0;font-size:12px}
.pmp-table th,.pmp-table td{border:1px solid ${C.border};padding:5px 9px;text-align:left;vertical-align:top}
.pmp-table th{background:${C.surface2};font-weight:600}

/* 召回页 */
.pmp-week{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:2px 2px 0;font-size:11px;color:${C.muted}}
.pmp-week-k{font-weight:600;color:${C.text}}
.pmp-week-i{padding:2px 7px;border:1px solid ${C.border};border-radius:999px;background:${C.surface}}
.pmp-week-i.warn{border-color:${C.warn};color:${C.warn}}
.pmp-week-n{margin-left:auto;font-size:10.5px;opacity:.8}
.pmp-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:10px;margin:14px 0 4px}
.pmp-card{background:${C.surface};border:1px solid ${C.border};border-radius:10px;padding:12px 14px}
.pmp-card-k{font-size:11px;color:${C.muted}}
.pmp-card-v{font-size:20px;font-weight:600;margin-top:4px;font-variant-numeric:tabular-nums;line-height:1.2}
.pmp-card-x{font-size:10.5px;color:${C.muted};margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pmp-sec{margin-top:24px}
.pmp-sec-h{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;margin-bottom:8px;flex-wrap:wrap}
.pmp-sec-h .pmp-spacer{flex:1}
.pmp-row{display:flex;gap:10px;padding:6px 10px;border-radius:7px;font-size:12px}
.pmp-row:nth-child(odd){background:${C.surface2}}
.pmp-row .k{width:148px;flex:none;color:${C.muted}}
.pmp-row .v{flex:1;min-width:0;word-break:break-all}
.pmp-empty{padding:30px 18px;text-align:center;color:${C.muted};font-size:12px;line-height:1.8}
.pmp-err{margin:10px 0;padding:10px 12px;border-radius:8px;background:color-mix(in srgb,${C.danger} 10%,transparent);color:${C.danger};font-size:12px;word-break:break-all;line-height:1.6}

/* 速记 / 提示 */
.pmp-mask{position:fixed;inset:0;background:rgba(12,15,20,.36);display:flex;align-items:flex-start;justify-content:center;padding-top:12vh;z-index:60}
.pmp-back{display:none}
.pmp-modal{width:min(560px,92vw);background:${C.overlay};border:1px solid ${C.border};border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.26);padding:18px 20px 16px}
.pmp-modal-h{font-size:14px;font-weight:600;margin-bottom:2px}
.pmp-modal-hint{font-size:11.5px;color:${C.muted};line-height:1.6;margin-bottom:10px}
.pmp-ta{width:100%;min-height:112px;resize:vertical;font:inherit;font-size:13px;line-height:1.62;padding:10px 12px;border-radius:9px;border:1px solid ${C.border};background:${C.bg};color:${C.text};outline:none;transition:border-color .12s ease,box-shadow .12s ease}
.pmp-ta:focus{border-color:${C.accent};box-shadow:0 0 0 3px ${C.accentSoft}}
.pmp-modal-f{display:flex;align-items:center;gap:8px;margin-top:12px}

.pmp-doc-actions{display:flex;gap:6px;flex:none;align-items:flex-start;padding-top:2px}
.pmp-star{appearance:none;width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;border:1px solid transparent;border-radius:7px;background:transparent;color:${C.muted};cursor:pointer;transition:all .12s ease}
.pmp-star:hover{color:${C.accent};background:${C.surface2}}
.pmp-star.on{color:${C.accent};background:${C.accentSoft};border-color:${C.accentSoft}}
.pmp-btn.warn{color:${C.danger};border-color:${C.danger}}
.pmp-edit{display:flex;flex-direction:column;flex:1;min-height:0;margin-top:10px}
.pmp-editor{width:100%;flex:1;min-height:min(56vh,520px);padding:14px 16px;border-radius:10px;border:1px solid ${C.border};background:${C.surface2};color:${C.text};outline:none;resize:vertical;tab-size:2;font:13px/1.75 ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace}
.pmp-editor:focus{border-color:${C.accent};box-shadow:0 0 0 3px ${C.accentSoft}}
.pmp-edit-hint{margin-top:8px;font-size:11px;color:${C.muted};min-height:15px}
.pmp-edit-hint b{color:${C.accent};font-weight:600}
.pmp-form{display:flex;flex-direction:column;gap:11px;margin-top:10px}
.pmp-field{display:flex;flex-direction:column;gap:5px}
.pmp-field label{font-size:11px;color:${C.muted};letter-spacing:.2px}
.pmp-field select.pmp-input{cursor:pointer}
/* 窄屏（手机 / 侧栏把中间区挤窄）：列表和阅读器不再并排，打开文档就整屏给正文 */
@media (max-width: 820px){
  /* 手机：先把纵向省出来，首屏要能看见「今天该做的」 */
  .pmp-head{padding:8px 10px 4px;gap:5px;align-items:center;flex-wrap:wrap}
  .pmp-brand{flex:1 1 auto;min-width:0}
  .pmp-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .pmp-act-t{display:none}
  .pmp-head > .pmp-btn{padding:6px 7px}
  .pmp-tabs{order:3;flex:0 0 100%;margin:2px 0 0;gap:2px;justify-content:space-between}
  .pmp-sub{display:none}
  .pmp-tabs{margin-left:0;max-width:100%;overflow-x:auto;scrollbar-width:none}
  .pmp-tabs::-webkit-scrollbar{display:none}
  .pmp-tab{padding:5px 6px;font-size:11.5px}
  .pmp-tabs{background:transparent;gap:1px}
  .pmp-strip{padding:0 12px 8px;gap:9px;flex-wrap:nowrap;overflow-x:auto;white-space:nowrap;scrollbar-width:none}
  .pmp-strip::-webkit-scrollbar{display:none}
  .pmp-body{flex-direction:column}
  .pmp-master{width:auto;flex:1;border-right:0}
  .pmp-detail{display:none}
  .pmp-root.pmp-doc-open .pmp-master{display:none}
  .pmp-root.pmp-doc-open .pmp-detail{display:flex;flex:1}
  .pmp-full{padding:12px 14px 32px}
  .pmp-doc-head{padding:10px 14px}
  .pmp-back{display:inline-flex}
  .pmp-hb-t{display:none}
  .pmp-btn.pmp-histback{border:1px solid ${C.border};padding:3px 8px}
.pmp-step{display:inline-flex;gap:2px;border:1px solid ${C.border};border-radius:7px;overflow:hidden}
.pmp-step-b{border:0!important;border-radius:0!important;padding:3px 8px!important;font-size:14px;line-height:1.1}
.pmp-step-b:disabled{opacity:.35;cursor:default}
  .pmp-doc-actions{gap:4px}
  .pmp-doc-t{overflow-wrap:anywhere}
  .pmp-modal{width:96vw;padding:16px 16px 14px}
  /* 往前两天：窄屏改成横滑卡片，一屏看得见一张半，右边那张露一角就是「还能滑」 */
  .pmp-prev{flex-direction:row;overflow-x:auto;gap:8px;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;padding-bottom:4px}
  .pmp-prev-row{flex:0 0 76%;scroll-snap-align:start}
}
.pmp-toast{position:fixed;left:50%;bottom:30px;transform:translateX(-50%);background:${C.text};color:${C.bg};padding:8px 16px;border-radius:99px;font-size:12px;z-index:80;box-shadow:0 8px 24px rgba(0,0,0,.24);max-width:78vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pmp-toast.bad{background:${C.danger};color:#fff}
.pmp-toast{display:inline-flex;align-items:center;gap:10px;white-space:normal}
.pmp-toast-t{min-width:0}
.pmp-toast-a{appearance:none;border:0;background:transparent;color:inherit;font:inherit;font-weight:600;text-decoration:underline;cursor:pointer;padding:0;flex:none}
.pmp-spin{display:inline-block;animation:pmp-spin .8s linear infinite}
@keyframes pmp-spin{to{transform:rotate(360deg)}}
.pmp-fade{animation:pmp-fade .14s ease-out}
@keyframes pmp-fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
`

    /* ------------------------------------------------------------------ *
     * 小工具
     * ------------------------------------------------------------------ */
    const num = (v) => Number(v) || 0
    const pad2 = (n) => String(n).padStart(2, '0')

    function fmtDate(iso) {
      if (!iso) return ''
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return ''
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    }

    function fmtClock(iso) {
      if (!iso) return '—'
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return '—'
      return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    }

    /** 毫秒时间戳 → 「今天 / 3 天前 / 2 个月前」，检索命中用；文案走 t()，面板要能切英文 */
    function agoMs(ms, t) {
      const at = Number(ms)
      if (!at) return ''
      const days = Math.floor((Date.now() - at) / 86400000)
      if (days <= 0) return t('ago.today')
      if (days === 1) return t('ago.yesterday')
      if (days < 30) return t('ago.days').replace('{n}', String(days))
      const months = Math.floor(days / 30)
      if (months < 12) return t('ago.months').replace('{n}', String(months))
      return t('ago.years').replace('{n}', String(Math.floor(months / 12)))
    }

    function fmtChars(n) {
      const v = num(n)
      return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : String(v)
    }

    function todayKey() {
      const d = new Date()
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    }

    /** 距离某个 YYYY-MM-DD 已经过去多少个自然日（今天=0，未来=负数取 0）。 */
    function daysSince(dateKey) {
      const parts = String(dateKey ?? '').split('-').map((v) => Number(v))
      if (parts.length !== 3 || !parts[0]) return 0
      const then = new Date(parts[0], parts[1] - 1, parts[2])
      const now = new Date()
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      const diff = Math.round((today.getTime() - then.getTime()) / 86400000)
      return diff > 0 ? diff : 0
    }

    /* ---------------- 行内标记：**粗** / `code` / [文字](链接) ---------------- */
    const INLINE_RE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g

    function inline(text, keyPrefix) {
      const out = []
      const source = String(text ?? '')
      let last = 0
      let match
      let n = 0
      INLINE_RE.lastIndex = 0
      while ((match = INLINE_RE.exec(source)) !== null) {
        if (match.index > last) out.push(source.slice(last, match.index))
        const token = match[0]
        if (token.startsWith('**')) {
          out.push(h('strong', { key: `${keyPrefix}b${n++}` }, token.slice(2, -2)))
        } else if (token.startsWith('`')) {
          out.push(h('code', { className: 'pmp-code', key: `${keyPrefix}c${n++}` }, token.slice(1, -1)))
        } else {
          const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
          out.push(h('a', {
            className: 'pmp-a',
            key: `${keyPrefix}a${n++}`,
            href: link[2],
            target: '_blank',
            rel: 'noreferrer noopener',
          }, link[1]))
        }
        last = match.index + token.length
      }
      if (last < source.length) out.push(source.slice(last))
      return out
    }

    /* ---------------- 极简 markdown 渲染（笔记里用到的子集） ---------------- */
    function renderMarkdown(text, options) {
      const onTask = typeof options?.onTask === 'function' ? options.onTask : null
      const lines = String(text ?? '').split('\n')
      const nodes = []
      const headings = []
      let i = 0
      let key = 0

      while (i < lines.length) {
        const line = lines[i]

        if (!line.trim()) { i += 1; continue }

        // 代码块
        if (/^\s*```/.test(line)) {
          const buf = []
          i += 1
          while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i += 1 }
          i += 1
          nodes.push(h('pre', { className: 'pmp-pre', key: `pre${key++}` }, h('code', null, buf.join('\n'))))
          continue
        }

        // 分隔线
        if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
          nodes.push(h('hr', { className: 'pmp-hr', key: `hr${key++}` }))
          i += 1
          continue
        }

        // 标题
        const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
        if (heading) {
          const level = heading[1].length
          const id = `mh${headings.length}`
          const text2 = heading[2].replace(/\s+#+\s*$/, '')
          headings.push({ level, text: text2, id })
          const tag = `h${Math.min(level, 6)}`
          nodes.push(h(tag, {
            key: `h${key++}`,
            className: `pmp-h pmp-h${level}`,
            'data-h': id,
          }, inline(text2, `${id}-`)))
          i += 1
          continue
        }

        // 表格
        if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
          const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
          const head = cells(line)
          i += 2
          const rows = []
          while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
            rows.push(cells(lines[i]))
            i += 1
          }
          const headRow = h('tr', null, head.map((cell, ci) =>
            h('th', { key: `th${ci}` }, inline(cell, `th${key}-${ci}-`))))
          const bodyRows = rows.map((row, ri) =>
            h('tr', { key: `tr${ri}` }, head.map((_, ci) =>
              h('td', { key: `td${ci}` }, inline(row[ci] ?? '', `td${key}-${ri}-${ci}-`)))))
          nodes.push(h('table', { className: 'pmp-table', key: `tb${key++}` },
            h('thead', null, headRow),
            h('tbody', null, bodyRows)))
          continue
        }

        // 引用
        if (/^>\s?/.test(line)) {
          const buf = []
          while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i += 1 }
          nodes.push(h('blockquote', { className: 'pmp-quote', key: `q${key++}` }, inline(buf.join(' '), `q${key}-`)))
          continue
        }

        // 列表（含 - [ ] 待办）
        if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
          const ordered = /^\s*\d+\./.test(line)
          const items = []
          while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
            const item = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(lines[i])
            const content = item ? item[2] : ''
            const task = /^\[([ xX])\]\s*(.*)$/.exec(content)
            if (task) {
              const done = Boolean(task[1].trim())
              const at = i + 1
              const box = h(onTask ? 'button' : 'span', {
                className: `pmp-check${done ? ' done' : ''}`,
                ...(onTask
                  ? {
                      type: 'button',
                      title: task[2],
                      'data-line': at,
                      onClick: () => onTask({ line: at, done, text: task[2] }),
                    }
                  : {}),
              }, done ? '✓' : '')
              items.push(h('li', { className: 'pmp-li pmp-task', key: `li${key++}`, 'data-line': at },
                box,
                h('span', null, inline(task[2], `tk${key}-`)),
              ))
            } else {
              items.push(h('li', { className: 'pmp-li', key: `li${key++}` }, inline(content, `li${key}-`)))
            }
            i += 1
          }
          nodes.push(h(ordered ? 'ol' : 'ul', { className: 'pmp-list', key: `l${key++}` }, items))
          continue
        }

        // 段落
        const buf = [line]
        i += 1
        while (
          i < lines.length &&
          lines[i].trim() &&
          !/^(#{1,6}\s|>\s?|\s*([-*+]|\d+\.)\s+|```|\|)/.test(lines[i]) &&
          !/^\s*(---|\*\*\*|___)\s*$/.test(lines[i])
        ) {
          buf.push(lines[i])
          i += 1
        }
        nodes.push(h('p', { className: 'pmp-p', key: `p${key++}` }, inline(buf.join(' '), `p${key}-`)))
      }

      return { nodes, headings }
    }

    /* ------------------------------------------------------------------ *
     * 数据接口
     * ------------------------------------------------------------------ */
    class Api {
      async call(method, path, body, timeoutMs) {
        const init = { method, signal: AbortSignal.timeout(timeoutMs ?? 20000) }
        if (body !== undefined) {
          init.headers = { 'content-type': 'application/json' }
          init.body = JSON.stringify(body)
        }
        const res = await fetch(`/personal-memory${path}`, init)
        let env = null
        try { env = await res.json() } catch { env = null }
        if (!res.ok || !env || env.ok !== true) {
          const message = env?.error?.message || `HTTP ${res.status}`
          throw new Error(message)
        }
        return env.value
      }

      status() { return this.call('GET', '/status', undefined, 15000) }
      tree(refresh) { return this.call('GET', `/tree?scope=personal,memory,project${refresh ? '&refresh=1' : ''}`, undefined, 30000) }
      doc(path) { return this.call('GET', `/doc?path=${encodeURIComponent(path)}`, undefined, 20000) }
      timeline(refresh) { return this.call('GET', `/timeline${refresh ? '?refresh=1' : ''}`, undefined, 30000) }
      search(q, scope, topK, opts) {
        const params = new URLSearchParams({ q, topK: String(topK || 12) })
        if (scope) params.set('scope', scope)
        if (opts?.days > 0) params.set('days', String(opts.days))
        // 相关笔记那种「拿整段正文当 query」的检索不该进「最近查过」
        if (opts?.record === false) params.set('record', '0')
        // 「只看待办」：待办状态不是笔记正文，混在一起要人自己扫
        if (opts?.only) params.set('only', String(opts.only))
        return this.call('GET', `/search?${params.toString()}`, undefined, 20000)
      }
      test(q, trial) {
        const body = { query: q }
        if (trial && Number.isFinite(Number(trial.threshold))) body.threshold = Number(trial.threshold)
        if (trial && Number.isFinite(Number(trial.maxChars))) body.maxChars = Number(trial.maxChars)
        if (trial && Number.isFinite(Number(trial.excerptChars))) body.excerptChars = Number(trial.excerptChars)
        return this.call('POST', '/test', body, 20000)
      }
      state() {
        return this.call('GET', '/state')
      }

      // 面板自己的状态（不是笔记）：导出全貌 / 按表清空
      stateExport() { return this.call('GET', '/state/export', null, 20000) }
      stateClear(tables) { return this.call('POST', '/state/clear', { tables, confirm: true }, 20000) }
      stateMigrate() { return this.call('POST', '/state/migrate', {}, 20000) }
      visited(limit = 20) { return this.call('GET', `/visited?limit=${limit}`, undefined, 20000) }
      /** 知识库体检：只读，默认只看 personal/。 */
      audit(scope = 'personal') { return this.call('GET', `/audit?scope=${encodeURIComponent(scope)}`, undefined, 30000) }
      experiment(payload) { return this.call('POST', '/experiment', payload, 15000) }
      experiments(limit = 12) { return this.call('GET', `/experiments?limit=${Number(limit) || 12}`, undefined, 15000) }

      ui(patch) { return this.call('POST', '/ui', patch, 15000) }
      star(path, on) {
        return this.call('POST', '/star', { path, on })
      }

      // 打开即打点：用来回答「那次召回后来被用上了吗」
      used(path, dwell) { return this.call('POST', '/used', { path, dwell }, 15000) }
      append(payload) { return this.call('POST', '/append', payload, 20000) }
      clues(limit) { return this.call('GET', `/clues?limit=${Number(limit) || 100}`, undefined, 20000) }
      resolveClue(text, resolved) { return this.call('POST', '/clue/resolve', { text, resolved }, 15000) }

      reindex() { return this.call('POST', '/reindex', {}, 180000) }
      note(payload) { return this.call('POST', '/note', payload, 60000) }
      todo(payload) { return this.call('POST', '/todo', payload, 20000) }
  deferTodo(payload) { return this.call('POST', '/todo/defer', payload, 20000) }
  wait(payload) { return this.call('POST', '/wait', payload, 15000) }
      save(payload) { return this.call('POST', '/save', payload, 60000) }
      create(payload) { return this.call('POST', '/create', payload, 30000) }
    }

    /* ------------------------------------------------------------------ *
     * 图标
     * ------------------------------------------------------------------ */
    function Glyph({ size = 16, children }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, children)
    }

    const IconMemory = (props) => h(Glyph, props,
      h('path', { d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H19v18H6.5A2.5 2.5 0 0 1 4 18.5z' }),
      h('path', { d: 'M8 3v18' }),
      h('path', { d: 'M12 8h4M12 12h4M12 16h3' }),
    )

    const IconNote = (props) => h(Glyph, props,
      h('path', { d: 'M12 20h9' }),
      h('path', { d: 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z' }),
    )

    const IconEdit = (props) => h(Glyph, props,
      h('path', { d: 'M12 20h9' }),
      h('path', { d: 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z' }),
    )

    const IconStar = ({ size = 14, filled = false } = {}) => h(Glyph, { size },
      h('path', {
        d: 'M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.2-4.1 5.8-.8z',
        fill: filled ? 'currentColor' : 'none',
      }),
    )

    const IconPlus = (props) => h(Glyph, props,
      h('path', { d: 'M12 5v14M5 12h14' }),
    )

    const IconDoc = (props) => h(Glyph, props,
      h('path', { d: 'M15 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z' }),
      h('path', { d: 'M15 3v4h4' }),
    )

    const IconToday = (props) => h(Glyph, props,
      h('rect', { x: '3', y: '5', width: '18', height: '16', rx: '2' }),
      h('path', { d: 'M8 3v4M16 3v4M3 11h18' }),
    )

    const IconSearch = (props) => h(Glyph, props,
      h('circle', { cx: '11', cy: '11', r: '7' }),
      h('path', { d: 'M20 20l-4.2-4.2' }),
    )

    const IconRefresh = (props) => h(Glyph, props,
      h('path', { d: 'M20 11a8 8 0 1 0-2.3 5.7' }),
      h('path', { d: 'M20 4v7h-7' }),
    )

    function Spinner() {
      return h('span', { className: 'pmp-spin' }, h(Glyph, { size: 13 }, h('path', { d: 'M21 12a9 9 0 1 1-6.2-8.6' })))
    }

    // 窄屏判断：手机 / 侧栏把中间区挤窄时，列表与阅读器不能并排（布局靠 CSS，行为靠这里）
    function useNarrow(query = '(max-width: 820px)') {
      const read = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia(query).matches
        : false)
      const [narrow, setNarrow] = useState(read)
      useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
        const mql = window.matchMedia(query)
        const onChange = () => setNarrow(mql.matches)
        onChange()
        if (typeof mql.addEventListener === 'function') {
          mql.addEventListener('change', onChange)
          return () => mql.removeEventListener('change', onChange)
        }
        if (typeof mql.addListener === 'function') {
          mql.addListener(onChange)
          return () => mql.removeListener(onChange)
        }
        return undefined
      }, [query])
      return narrow
    }

    /* ------------------------------------------------------------------ *
     * ⌘K：输入即跳，不经过左栏
     * ------------------------------------------------------------------ */
    // 「几天前看过」说成人话：0 天前、1 天前都不是人会说的
    function visitedLabel(t, days) {
      const n = Math.max(0, Math.floor(Number(days) || 0))
      if (n === 0) return t('qj.recentToday')
      if (n === 1) return t('qj.recentYesterday')
      return t('qj.recentMeta').replace('{d}', String(n))
    }

    /** 「看过 2 天前 · 改于 12 天前 · 读了 3 分钟」：前两个必给，停留时长没测到就不写 */
    function visitedMetaText(t, item) {
      const used = Number(item.daysSinceUsed) || 0
      const mtime = Number(item.mtimeMs) > 0 ? String(Math.max(0, Math.floor((Date.now() - Number(item.mtimeMs)) / 86400000))) : '—'
      const base = t('search.visitedMeta').replace('{u}', String(used)).replace('{m}', mtime)
      const dwell = Math.trunc(Number(item.dwell) || 0)
      return dwell > 0 ? `${base} · ${dwellLabel(t, dwell)}` : base
    }

    // 「停留了多久」：点开就走的不值得叫「停过」，所以 10 秒以下直说
    function dwellLabel(t, dwell) {
      const sec = Math.max(0, Math.round((Number(dwell) || 0) / 1000))
      if (sec < 10) return t('search.dwellBrief')
      if (sec < 60) return t('search.dwellSec').replace('{n}', String(sec))
      return t('search.dwellMin').replace('{n}', String(Math.round(sec / 60)))
    }

    function QuickJump(props) {
      const { t, docs = [], onPick, onClose, pages = [], onNavigate, recent = [], onSearch } = props
      const [query, setQuery] = useState(props.initialQuery ?? '')
      const [cursor, setCursor] = useState(0)
      const inputRef = useRef(null)

      useEffect(() => {
        if (inputRef.current && typeof inputRef.current.focus === 'function') inputRef.current.focus()
      }, [])

      // 页签也能跳：⌘K 里先给「今天 / 未完成 / 时间长河…」，再给笔记
      const entries = useMemo(() => {
        const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
        const pageRows = []
        for (const page of pages) {
          const hay = `${page.label} ${page.key}`.toLowerCase()
          if (!tokens.every((token) => hay.includes(token))) continue
          pageRows.push({ kind: 'page', page })
        }
        const rows = []
        for (const doc of docs) {
          const hay = `${doc.title} ${doc.path} ${doc.meta?.source ?? ''}`.toLowerCase()
          if (!tokens.every((token) => hay.includes(token))) continue
          rows.push(doc)
        }
        // 目录索引（index.md）通常不是你想跳的那一篇，权重放到后面
        const docRows = rows
          .sort((a, b) => {
            const ai = /^index/i.test(a.file) ? 1 : 0
            const bi = /^index/i.test(b.file) ? 1 : 0
            if (ai !== bi) return ai - bi
            return String(b.mtime ?? '').localeCompare(String(a.mtime ?? ''))
          })
          .slice(0, 40)
          .map((doc) => ({ kind: 'doc', doc }))
        // 空查询时先给「最近看过」：想跳回刚才看的东西，比按修改时间找更接近实际动作
        const recentRows = query.trim() === ''
          ? recent.slice(0, 5).map((item) => ({ kind: 'recent', item }))
          : []
        // 标题匹配不到时，还剩「正文里也许有」这条路：跳到检索页用同一句话搜内容
        const searchRow = query.trim() !== '' && typeof onSearch === 'function'
          ? [{ kind: 'search', text: query.trim() }]
          : []
        return [...pageRows, ...recentRows, ...docRows, ...searchRow]
      }, [docs, query, pages, recent, onSearch])

      const rows = entries

      useEffect(() => { setCursor(0) }, [query])

      const pick = (entry) => {
        if (!entry) return
        if (entry.kind === 'page') {
          if (typeof onNavigate === 'function') onNavigate(entry.page.key)
          onClose()
          return
        }
        if (entry.kind === 'recent') {
          onPick(entry.item.path)
          onClose()
          return
        }
        if (entry.kind === 'search') {
          onSearch(entry.text)
          onClose()
          return
        }
        onPick(entry.doc.path)
        onClose()
      }

      const onKeyDown = (event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setCursor((n) => Math.min(n + 1, Math.max(rows.length - 1, 0)))
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          setCursor((n) => Math.max(n - 1, 0))
        } else if (event.key === 'Enter') {
          event.preventDefault()
          pick(rows[cursor])
        } else if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
        }
      }

      return h('div', { className: 'pmp-mask', onClick: onClose },
        h('div', {
          className: 'pmp-qj',
          onClick: (event) => event.stopPropagation(),
        },
          h('div', { className: 'pmp-qj-in' },
            h(IconSearch, { size: 15 }),
            h('input', {
              ref: inputRef,
              className: 'pmp-input pmp-qj-input',
              placeholder: t('qj.placeholder'),
              value: query,
              autoFocus: true,
              onChange: (event) => setQuery(event.target.value),
              onKeyDown,
            }),
            h('span', { className: 'pmp-qj-k' }, '⌘K'),
          ),
          h('div', { className: 'pmp-qj-list' },
            rows.length === 0
              ? h('div', { className: 'pmp-empty', style: { padding: '14px 4px' } }, t('qj.empty'))
              : rows.map((entry, index) => entry.kind === 'page'
                ? h('button', {
                  type: 'button',
                  key: `page-${entry.page.key}`,
                  className: `pmp-qj-row pmp-qj-page${index === cursor ? ' on' : ''}`,
                  onClick: () => pick(entry),
                  onMouseEnter: () => setCursor(index),
                },
                  h('div', { className: 'pmp-qj-t' }, entry.page.label),
                  h('div', { className: 'pmp-qj-m' }, t('qj.page')),
                )
                : entry.kind === 'recent'
                  ? h('button', {
                    type: 'button',
                    key: `recent-${entry.item.path}`,
                    className: `pmp-qj-row pmp-qj-recent${index === cursor ? ' on' : ''}`,
                    onClick: () => pick(entry),
                    onMouseEnter: () => setCursor(index),
                  },
                    h('div', { className: 'pmp-qj-t' }, entry.item.title || entry.item.path),
                    h('div', { className: 'pmp-qj-m' }, `${visitedLabel(t, entry.item.daysSinceUsed)} · ${entry.item.path}`),
                  )
                  : entry.kind === 'search'
                    ? h('button', {
                      type: 'button',
                      key: 'search-row',
                      className: `pmp-qj-row pmp-qj-search${index === cursor ? ' on' : ''}`,
                      onClick: () => pick(entry),
                      onMouseEnter: () => setCursor(index),
                    },
                      h('div', { className: 'pmp-qj-t' }, t('qj.search').replace('{q}', entry.text)),
                      h('div', { className: 'pmp-qj-m' }, t('qj.searchHint')),
                    )
                    : h('button', {
                      type: 'button',
                      key: entry.doc.path,
                      className: `pmp-qj-row${index === cursor ? ' on' : ''}`,
                      onClick: () => pick(entry),
                      onMouseEnter: () => setCursor(index),
                    },
                      h('div', { className: 'pmp-qj-t' }, entry.doc.title),
                      h('div', { className: 'pmp-qj-m' }, `${entry.doc.path}${entry.doc.scope === 'memory' ? ' · memory' : ''}`),
                    )),
          ),
          h('div', { className: 'pmp-qj-f' }, t('qj.hint')),
        ),
      )
    }

    /* ------------------------------------------------------------------ *
     * 左侧：个人记忆（按目录分组）
     * ------------------------------------------------------------------ */
    function groupPersonal(docs, t) {
      const groups = new Map()
      for (const doc of docs) {
        // project/ 的笔记也在同一个检索索引里，能搜到就该能点到 —— 所以一并进这个树
        if (doc.scope !== 'personal' && doc.scope !== 'project') continue
        const dir = doc.dir || doc.scope
        if (!groups.has(dir)) groups.set(dir, [])
        groups.get(dir).push(doc)
      }
      const labelOf = (dir) => {
        if (dir === 'personal') return t('list.root')
        if (dir === 'project') return t('list.projectRoot')
        const rest = dir.split('/').slice(1).join(' / ')
        if (dir.startsWith('project/')) return `${t('list.project')} / ${rest || dir}`
        return rest || dir
      }
      const order = (dir) => (dir === 'personal' ? 0 : dir.startsWith('personal/') ? 1 : 2)
      return [...groups.entries()]
        .map(([dir, list]) => ({
          dir,
          label: labelOf(dir),
          docs: list.slice().sort((a, b) => {
            const ai = /^index/i.test(a.file) ? 0 : 1
            const bi = /^index/i.test(b.file) ? 0 : 1
            if (ai !== bi) return ai - bi
            return String(b.mtime ?? '').localeCompare(String(a.mtime ?? ''))
          }),
        }))
        .sort((a, b) => order(a.dir) - order(b.dir) || a.dir.localeCompare(b.dir))
    }

    /**
     * 知识库体检条。
     * 通过时不占地方（一行小字），坏了才列出来——体检的价值在「出事时能看见」，
     * 不在「每天提醒你很健康」。
     */
    function auditStrip(t, audit, onOpen) {
      if (!audit || !audit.counts) return null
      const counts = audit.counts
      const total = Number(counts.total) || 0
      if (total === 0) {
        return h('div', { className: 'pmp-audit pmp-audit-ok', title: t('audit.okHint') },
          h('span', { className: 'pmp-audit-tick' }, '✓'),
          h('span', { className: 'pmp-audit-t' }, t('audit.ok').replace('{n}', String(audit.notes ?? 0))),
        )
      }
      const rows = (audit.items ?? []).slice(0, 3)
      const rest = total - rows.length
      return h('div', { className: 'pmp-audit pmp-audit-bad' },
        h('div', { className: 'pmp-audit-h' },
          h('span', { className: 'pmp-audit-t' }, t('audit.title').replace('{n}', String(total))),
          h('span', { className: 'pmp-audit-note' }, t('audit.hint')),
        ),
        rows.map((item) => h('button', {
          key: `${item.path}:${item.issue}`,
          className: 'pmp-audit-row',
          title: `${item.path} — ${item.hint ?? ''}`,
          onClick: () => (typeof onOpen === 'function' ? onOpen(item.path) : null),
        },
          h('span', { className: `pmp-audit-lv ${item.level === 'P0' ? 'p0' : 'p1'}` }, item.level),
          h('span', { className: 'pmp-audit-p' }, String(item.path).replace(/^personal\//, '')),
          h('span', { className: 'pmp-audit-i' }, item.issue),
        )),
        rest > 0 ? h('div', { className: 'pmp-audit-more' }, t('audit.more').replace('{n}', String(rest))) : null,
      )
    }

    function MasterPersonal(props) {
      const { t, docs, selected, onOpen, collapsed = {}, onCollapse } = props
      const [filter, setFilter] = useState('')

      const groups = useMemo(() => {
        const all = groupPersonal(docs, t)
        const q = filter.trim().toLowerCase()
        const matched = q
          ? all
            .map((group) => ({
              ...group,
              docs: group.docs.filter((doc) =>
                `${doc.title} ${doc.file} ${doc.path}`.toLowerCase().includes(q)),
            }))
            .filter((group) => group.docs.length > 0)
          : all
        // 星标置顶：常用的那几篇不用每次翻目录
        const starred = docs.filter((doc) => doc.star === true)
        if (starred.length === 0) return matched
        return [{ dir: '__starred__', label: t('list.starred'), docs: starred }, ...matched]
      }, [docs, filter, t])

      return h('div', { className: 'pmp-master' },
        auditStrip(t, props.audit ?? null, onOpen),
        h('div', { className: 'pmp-searchbox' },
          h('input', {
            className: 'pmp-input',
            value: filter,
            placeholder: t('list.filter'),
            onChange: (e) => setFilter(e.target.value),
            spellCheck: false,
          }),
        ),
        groups.length === 0
          ? h('div', { className: 'pmp-empty' }, t('list.empty'))
          : groups.map((group) => {
            const open = collapsed[`dir:${group.dir}`] !== true
            return h('div', { className: 'pmp-group', key: group.dir },
              h('div', {
                className: 'pmp-group-h',
                onClick: () => (typeof onCollapse === 'function' ? onCollapse(`dir:${group.dir}`) : null),
              },
                h('span', { className: `pmp-caret${open ? ' open' : ''}` }, '▶'),
                h('span', null, group.label),
                h('span', { className: 'pmp-count' }, String(group.docs.length)),
              ),
              open && group.docs.map((doc) => h('button', {
                type: 'button',
                key: doc.path,
                className: `pmp-item${selected === doc.path ? ' on' : ''}`,
                onClick: () => onOpen(doc.path),
                title: doc.path,
              },
                h('div', { className: 'pmp-item-t' }, doc.title || doc.file),
                h('div', { className: 'pmp-item-m' },
                  doc.meta?.updated ? h('span', null, doc.meta.updated) : h('span', null, fmtDate(doc.mtime)),
                  h('span', { className: 'sep' }, '·'),
                  h('span', null, `${fmtChars(doc.chars)} ${t('meta.chars')}`),
                ),
              )),
            )
          }),
      )
    }

    /* ------------------------------------------------------------------ *
     * 左侧：时间长河（按月分组的日记时间轴）
     * ------------------------------------------------------------------ */
    function MasterTimeline(props) {
      const { t, timeline, selected, onOpen, docs = [], collapsed = {}, onCollapse, onPickMonth } = props
      const days = timeline?.days ?? []
      // memory/ 底下除了日记还有索引和模板，日记时间轴之外单独给一条入口
      const extras = docs.filter((doc) => doc.scope === 'memory' && !/^memory\/\d{4}\//.test(doc.path))

      // 那天除了写日记，还动过哪些笔记：日历和「工作痕迹」是两条不同的线索，并排才看得出一天的工作形状
      const touchedOf = useMemo(() => {
        const map = new Map()
        for (const doc of docs) {
          if (doc.scope === 'memory') continue
          const key = dayKeyOf(doc.mtime)
          if (!key) continue
          if (!map.has(key)) map.set(key, [])
          map.get(key).push(doc)
        }
        for (const list of map.values()) list.sort((a, b) => String(b.mtime ?? '').localeCompare(String(a.mtime ?? '')))
        return map
      }, [docs])

      // 每个月一条：记了几天、合计多少条、这个月有几天「本来就是空的」（未来日子不算）
      const months = useMemo(() => {
        const map = new Map()
        for (const day of days) {
          const key = String(day.date ?? '').slice(0, 7)
          if (!map.has(key)) map.set(key, [])
          map.get(key).push(day)
        }
        const todayKey = localDateKey()
        return [...map.entries()]
          .sort((a, b) => (a[0] < b[0] ? 1 : -1))
          .map(([month, list]) => {
            const [year, mon] = month.split('-').map(Number)
            const daysInMonth = new Date(year, mon, 0).getDate()
            const elapsed = month === todayKey.slice(0, 7)
              ? Number(todayKey.slice(8, 10))
              : (month > todayKey.slice(0, 7) ? 0 : daysInMonth)
            const entries = list.reduce((sum, day) => sum + (Number(day.entries) || 0), 0)
            return { month, list, recorded: list.length, entries, missed: Math.max(0, elapsed - list.length) }
          })
      }, [days])

      // 一年 12 格：回答「今年哪几个月我在认真过日子」。只看最新一篇所在的年份，不做跨年全景
      const yearGrid = useMemo(() => {
        const latest = [...days].map((day) => String(day.date ?? '')).sort().at(-1) ?? ''
        const year = latest.slice(0, 4) || String(new Date().getFullYear())
        const byMonth = new Map()
        for (const day of days) {
          const key = String(day.date ?? '')
          if (key.slice(0, 4) !== year) continue
          const mon = Number(key.slice(5, 7))
          byMonth.set(mon, (byMonth.get(mon) ?? 0) + 1)
        }
        const best = Math.max(1, ...[...byMonth.values()])
        return {
          year,
          cells: Array.from({ length: 12 }, (_, index2) => {
            const mon = index2 + 1
            const recorded = byMonth.get(mon) ?? 0
            return { month: `${year}-${pad2(mon)}`, mon, recorded, ratio: recorded / best }
          }),
          total: [...byMonth.values()].reduce((sum, v) => sum + v, 0),
        }
      }, [days])

      if (days.length === 0) return h('div', { className: 'pmp-master' }, h('div', { className: 'pmp-empty' }, t('tl.empty')))

      return h('div', { className: 'pmp-master' },
        h('div', { className: 'pmp-year' },
          h('div', { className: 'pmp-year-h' },
            h('span', null, `${yearGrid.year} · ${t('tl.year')}`),
            h('span', { className: 'pmp-spacer' }),
            h('span', { className: 'pmp-year-t' }, `${yearGrid.total} ${t('meta.days')}`)),
          h('div', { className: 'pmp-year-g' }, yearGrid.cells.map((cell) => {
            const style = cell.recorded > 0
              ? { background: `color-mix(in srgb, ${C.accent} ${Math.round(18 + cell.ratio * 62)}%, transparent)` }
              : undefined
            return h('button', {
              type: 'button',
              key: cell.month,
              className: `pmp-ym${cell.recorded > 0 ? ' on' : ''}`,
              // 强度用 accent 的透明度表达：记满的月份最深，空格子只有描边
              style,
              title: `${cell.month} · ${t('tl.yearCell').replace('{n}', String(cell.recorded))}`,
              onClick: () => (typeof onPickMonth === 'function' ? onPickMonth(`month:${cell.month}`) : null),
            },
              h('span', { className: 'pmp-ym-m' }, String(cell.mon)),
              h('span', { className: 'pmp-ym-n' }, cell.recorded > 0 ? String(cell.recorded) : ''))
          }))),
        extras.length > 0
          ? h('div', { className: 'pmp-tl-x' }, extras.map((doc) => h('button', {
            type: 'button',
            key: doc.path,
            className: `pmp-tl-xi${selected === doc.path ? ' on' : ''}`,
            onClick: () => onOpen(doc.path),
            title: doc.path,
          }, h(IconDoc, { size: 13 }), h('span', null, doc.dir === 'memory' ? doc.file : `${doc.dir.slice(7)} / ${doc.file}`))))
          : null,
        h('div', { className: 'pmp-tl' },
          months.map((bucket) => {
            const isClosed = collapsed[`month:${bucket.month}`] === true
            return h('div', { key: bucket.month },
              h('button', {
                type: 'button',
                id: `pm-month:${bucket.month}`,
                className: 'pmp-tl-m',
                style: { border: 0, width: '100%', textAlign: 'left', cursor: 'pointer', font: 'inherit', background: 'transparent' },
                onClick: () => (typeof onCollapse === 'function' ? onCollapse(`month:${bucket.month}`) : null),
                title: bucket.month,
              },
                h('span', { className: `pmp-td-x${isClosed ? '' : ' on'}` }, '\u25b8'),
                h('span', null, bucket.month),
                h('span', { className: 'pmp-tl-ms' },
                  `${bucket.recorded} ${t('meta.days')}`,
                  bucket.entries > 0 ? ` · ${bucket.entries} ${t('meta.entries')}` : '',
                  bucket.missed > 0 ? ` · ${t('tl.missed').replace('{n}', String(bucket.missed))}` : '',
                ),
              ),
              isClosed
                ? null
                : bucket.list.map((day, index2) => {
                  const prev = index2 > 0 ? bucket.list[index2 - 1] : null
                  // 断档要说出来：时间轴上「没写的日子」也是信息，别让两天挨在一起像连着
                  // 日记按时间倒序排，差值要取绝对值
                  const gaps = prev ? Math.abs(dayDiff(prev.date, day.date)) : 0
                  return h(Fragment, { key: day.path },
                    gaps > 1
                      ? h('div', { className: 'pmp-gap', title: `${prev.date} → ${day.date}` },
                        h('span', { className: 'pmp-gap-l' }),
                        h('span', null, t('tl.gap').replace('{n}', String(gaps - 1))))
                      : null,
                    h('button', {
                      type: 'button',
                      className: `pmp-day${selected === day.path ? ' on' : ''}`,
                      onClick: () => onOpen(day.path),
                      title: day.title,
                    },
                      h('div', { className: 'pmp-day-r' },
                        h('span', { className: 'pmp-day-d' }, String(day.date ?? '').slice(5)),
                        h('span', { className: 'pmp-day-w' }, day.weekday ?? ''),
                        day.openTodos > 0
                          ? h('span', { className: 'pmp-badge warn' }, `${day.openTodos} ${t('meta.todos')}`)
                          : null,
                        h('span', { className: 'pmp-day-n' }, `${day.entries} ${t('meta.entries')}`),
                      ),
                      day.preview ? h('div', { className: 'pmp-day-p' }, day.preview) : null,
                      (() => {
                        const touched = touchedOf.get(day.date) ?? []
                        if (touched.length === 0) return null
                        const names = touched.slice(0, 3).map((doc) => doc.title || doc.file)
                        const more = touched.length - names.length
                        return h('div', { className: 'pmp-day-t', title: touched.map((doc) => doc.path).join('\n') },
                          h('span', { className: 'pmp-day-tk' }, t('tl.touched')),
                          names.join(' · '),
                          more > 0 ? ` +${more}` : '',
                        )
                      })(),
                    ),
                  )
                }),
            )
          }),
        ),
      )
    }

    /* ------------------------------------------------------------------ *
     * 今天：打开面板第一眼该看到的东西
     * ------------------------------------------------------------------ */
    const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

    /** 两个 YYYY-MM-DD 相差几天（只用于时间轴断档，跨月也算得对） */
    function dayDiff(from, to) {
      const a = String(from ?? '').split('-').map(Number)
      const b = String(to ?? '').split('-').map(Number)
      if (a.length !== 3 || b.length !== 3 || a.some((n) => !Number.isFinite(n)) || b.some((n) => !Number.isFinite(n))) return 0
      const one = new Date(a[0], a[1] - 1, a[2]).getTime()
      const two = new Date(b[0], b[1] - 1, b[2]).getTime()
      return Math.round((two - one) / 86400000)
    }
    function weekdayName(dateKey) {
      const parts = String(dateKey).split('-').map(Number)
      if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return ''
      return WEEKDAYS[new Date(parts[0], parts[1] - 1, parts[2]).getDay()] ?? ''
    }

    // tree 的 mtime 是 UTC ISO，直接切前 10 位会错一天（本地 02:45 = UTC 前一天 18:45）
    function dayKeyOf(value) {
      if (value === undefined || value === null || value === '') return ''
      const date = value instanceof Date ? value : new Date(value)
      if (Number.isNaN(date.getTime())) return ''
      return localDateKey(date)
    }

    function localDateKey(now) {
      const date = now ?? new Date()
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    }

    // 和宿主 waitKeyOf 保持同一套规则：改期挪到别的一天后，行号变了、这条标记还在
    function waitKeyOf(text) {
      return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
    }

    const WAIT_CYCLE = [null, 'market', 'reply', 'decide']

    // state.json 里新格式是 { kind, at }（老格式是纯字符串），两边都要能读
    function waitKind(raw, fallback) {
      const value = typeof raw === 'string' ? raw : raw?.kind
      return value || fallback || null
    }

    // 「下一步」显示在待办正文下面一行：看得见才知道动手时从哪开始。
    // 可点：打开那篇笔记并直接进编辑态、把光标落在这一句所在的位置。
    function nextLine(t, item, nexts, onEditNext) {
      const text = nexts[waitKeyOf(item.text)] ?? item.next ?? null
      if (!text) return null
      const body = `${t('todo.nextPrefix')}${text}`
      if (typeof onEditNext !== 'function') {
        return h('span', { className: 'pmp-td-next', title: text }, body)
      }
      return h('button', {
        type: 'button',
        className: 'pmp-td-next pmp-td-next-go',
        title: t('todo.nextOpen'),
        // 光标落在待办那句本身（它一定在正文里），不是落在 state 里那句提示上
        onClick: () => onEditNext({ path: item.path, text: item.text }),
      }, body)
    }

    function waitChip(t, item, waits, onWait) {
      const kind = waitKind(waits[waitKeyOf(item.text)], item.wait)
      const label = kind ? t(`wait.${kind}`) : t('wait.add')
      return h('button', {
        type: 'button',
        className: `pmp-td-wait${kind ? ` on wait-${kind}` : ''}`,
        title: t('wait.hint'),
        onClick: () => {
          if (typeof onWait !== 'function') return
          const index = WAIT_CYCLE.indexOf(kind)
          onWait({ text: item.text, kind: WAIT_CYCLE[(index + 1) % WAIT_CYCLE.length] })
        },
      }, kind ? `\u23f3 ${label}` : label)
    }

    // 「这条挪了 3 次、从 11-04 起」：一直往后推的事，值得被看见而不是被继续推。
    // 只在挪过 2 次以上时出现；一次临时改期不算问题，标出来反而变成噪音。
    function movedBadge(t, item, opts) {
      const count = Number(item.movedCount) || 0
      if (count < 2) return null
      const from = typeof item.movedFrom === 'string' && item.movedFrom.length >= 10 ? item.movedFrom.slice(5) : ''
      const steps = Array.isArray(item.movedSteps) ? item.movedSteps : []
      const withNote = steps.filter((step) => step && step.note)
      const text = t('todo.moved').replace('{n}', String(count))
      // 顺手写下的理由优先当 tooltip：比「挪了几次」更能解释为什么
      const title = withNote.length > 0
        ? withNote.map((step) => `${String(step.from ?? '').slice(5)}→${String(step.to ?? '').slice(5)} ${step.note}`).join('\n')
        : from ? t('todo.movedHint').replace('{d}', from) : text
      const open = opts?.open === true
      if (typeof opts?.onToggle !== 'function') return h('span', { className: 'pmp-badge warn', title }, text)
      return h('button', {
        type: 'button',
        className: `pmp-badge warn pmp-mv${open ? ' on' : ''}`,
        title: t('todo.movedOpen').replace('{t}', title),
        onClick: (event) => {
          event?.stopPropagation?.()
          opts.onToggle()
        },
      }, text)
    }

    // 点开「挪过 N 次」看到的：每一步从哪天挪到哪天、当时为什么挪（没写就留白，不编）
    function movedBlock(t, item) {
      const steps = Array.isArray(item.movedSteps) ? item.movedSteps : []
      if (steps.length === 0) return null
      return h('div', { className: 'pmp-mv-b' },
        h('div', { className: 'pmp-mv-h' }, t('todo.movedWhy')),
        ...steps.map((step, index) => h('div', { key: `mv${index}`, className: 'pmp-mv-i' },
          h('span', { className: 'pmp-mv-d' }, `${String(step.from ?? '').slice(5)} → ${String(step.to ?? '').slice(5)}`),
          h('span', { className: 'pmp-mv-n' }, step.note || t('todo.movedNoNote')),
        )),
      )
    }

    // 「今天不做」不是「做完了」。但「挪明天」只对了一半——多数事其实是本周某个工作日要做，
    // 所以给两档：明天 / 下周一（已经在周一就顺延到下周一，避免原地不动）。
    function deferButtons(t, item, onDeferTodo, onAsk) {
      if (typeof onDeferTodo !== 'function' || !String(item.path ?? '').startsWith('memory/')) return []
      // 第一次改期不问（正常调度）；第二次起先问一句「为什么往后挪」，一句话就够
      const ask = typeof onAsk === 'function' && (Number(item.movedCount) || 0) >= 1
      const fire = (to) => (ask ? onAsk(to) : onDeferTodo({ path: item.path, line: item.line, expect: item.text, to }))
      return [
        h('button', {
          type: 'button',
          key: 'defer-tomorrow',
          className: 'pmp-td-defer pmp-td-defer-tom',
          title: t('todo.defer'),
          onClick: () => fire('tomorrow'),
        }, t('todo.deferShort')),
        h('button', {
          type: 'button',
          key: 'defer-monday',
          className: 'pmp-td-defer pmp-td-defer-mon',
          title: t('todo.deferMonday'),
          onClick: () => fire('monday'),
        }, t('todo.deferMondayShort')),
      ]
    }

    function MasterToday(props) {
      const { t, timeline, docs = [], status, selected, onOpen, onToggleTodo, onDeferTodo, onNote, onQuickTodo, waits = {}, nexts = {}, onWait, onEditNext, onOpenDone } = props
      const days = timeline?.days ?? []
      const todayKey = localDateKey()
      const today = days.find((day) => day.date === todayKey) ?? null
      const totals = timeline?.totals ?? {}
      const openTotal = Number(totals.openTodos) || 0
      // 今天勾掉的：只显示欠的，人会以为今天什么都没干
      const doneItems = today?.doneItems ?? []
      const doneCount = Number(today?.doneTodos) || 0
      const [doneOpen, setDoneOpen] = useState(props.initialDoneOpen === true)

      // 今天该做的：分两拨看。今天新加的是「我刚想起来的事」，更早的是「一直欠着的事」——
      // 混在一起按日期排，今天刚写的会沉到最后，等于首屏看不见今天新增。
      const { fresh, carried } = useMemo(() => {
        const freshRows = []
        const carriedRows = []
        for (const day of days) {
          for (const item of day.todos ?? []) {
            const row = { ...item, path: day.path, date: day.date, weekday: day.weekday }
            if (day.date === todayKey) freshRows.push(row)
            else carriedRows.push(row)
          }
        }
        return { fresh: freshRows, carried: carriedRows }
      }, [days, todayKey])
      const OWED_LIMIT = 8
      // 首屏只铺 8 条（4 条今天的 + 补满），剩下的就地展开——跳页会丢掉「我现在在哪」的上下文
      const [owedExpanded, setOwedExpanded] = useState(false)
      // 排序由上层记住（写进 state.json）：默认「今天新加的在前」，也可以「最久没动的在前」。
      // 后者会把今天刚想起来的事排到最后——两种都合理，取决于此刻是在推进还是清账。
      const sortMode = (props.todoSort ?? props.initialTodoSort) === 'oldest' ? 'oldest' : 'fresh'
      const ordered = sortMode === 'oldest'
        ? [...fresh, ...carried].sort((a, b) => String(a.date).localeCompare(String(b.date)))
        : [...fresh, ...carried].sort((a, b) => (a.date === todayKey ? -1 : 0) - (b.date === todayKey ? -1 : 0))
      const shown = owedExpanded ? ordered : ordered.slice(0, OWED_LIMIT)
      const shownFresh = shown.filter((item) => item.date === todayKey)
      const shownCarried = shown.filter((item) => item.date !== todayKey)
      const owed = shown
      const owedLeft = ordered.length - shown.length

      const recent = useMemo(() => {
        return docs
          .filter((doc) => doc.scope === 'personal')
          .slice()
          .sort((a, b) => String(b.mtime ?? '').localeCompare(String(a.mtime ?? '')))
          .slice(0, 3)
      }, [docs])

      const previewOf = useMemo(() => new Map((timeline?.days ?? []).map((day) => [day.path, day.preview ?? ''])), [timeline])
      const [ctxOpen, setCtxOpen] = useState({})
      const toggleCtx = (key) => setCtxOpen((prev) => ({ ...prev, [key]: prev[key] !== true }))

      const [addDraft, setAddDraft] = useState('')
      const [busyAdd, setBusyAdd] = useState(false)
      const submitAdd = async () => {
        const text = addDraft.trim()
        if (!text || busyAdd) return
        if (typeof onQuickTodo !== 'function') return
        setBusyAdd(true)
        try {
          const ok = await onQuickTodo(text)
          if (ok !== false) setAddDraft('')
        } finally {
          setBusyAdd(false)
        }
      }

      const addRef = useRef(null)
      // 往前看两天：今天页只有「今天」的话，就没有时间纵深
      const prevDays = (timeline?.days ?? [])
        .filter((day) => day.date !== localDateKey())
        .slice(0, 2)

      // 今天写了没有：不是「有没有这个文件」，是「有没有内容」
      const wroteToday = Boolean(today) && (Number(today.entries) || 0) > 0

      const card = (label, value, note) => h('div', { className: 'pmp-card' },
        h('div', { className: 'pmp-card-k' }, label),
        h('div', { className: 'pmp-card-v' }, String(value)),
        note ? h('div', { className: 'pmp-card-x', title: String(note) }, String(note)) : null,
      )

      // 本周（周一起算）：日记里只有「那天写了什么」，看不出「这一周怎么样」
      const week = useMemo(() => {
        const now = new Date()
        const sinceMonday = (now.getDay() + 6) % 7
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - sinceMonday)
        const startKey = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`
        const days2 = days.filter((day) => String(day.date) >= startKey)
        let entries = 0
        let done = 0
        let owed = 0
        for (const day of days2) {
          entries += Number(day.entries) || 0
          done += Array.isArray(day.doneItems) ? day.doneItems.length : 0
          owed += Number(day.openTodos) || 0
        }
        return { start: startKey, entries, done, owed, days: days2.length }
      }, [days])

      const ago = (dateKey) => {
        const diff = daysSince(dateKey)
        if (diff === 0) return t('today.today')
        return `${diff} ${t('todo.days')}`
      }

      const todoRow = (item) => h('div', {
        className: 'pmp-td pmp-td-wrap',
        key: `${item.path}:${item.line}`,
      },
        h('button', {
          type: 'button',
          className: 'pmp-td-box',
          title: t('todo.done'),
          onClick: () => onToggleTodo({ path: item.path, line: item.line, done: true, expect: item.text }),
        }),
        h('button', {
          type: 'button',
          className: 'pmp-td-open',
          onClick: () => onOpen(item.path),
          title: item.path,
        },
          h('div', { className: 'pmp-td-t' }, item.text || t('todo.unnamed')),
          h('div', { className: 'pmp-td-m' },
            h('span', null, ago(item.date)),
            nextLine(t, item, nexts, onEditNext) ? h('span', { className: 'pmp-td-nextw' }, nextLine(t, item, nexts, onEditNext)) : null,
            item.section && item.section !== '未完成'
              ? h('span', { className: 'pmp-badge mute' }, item.section)
              : null,
            daysSince(item.date) >= 7 ? h('span', { className: 'pmp-badge warn' }, t('todo.stale')) : null,
            movedBadge(t, item),
          ),
        ),
        h('button', {
          type: 'button',
          className: `pmp-td-ctx${ctxOpen[`${item.path}:${item.line}`] ? ' on' : ''}`,
          title: t('todo.ctx'),
          onClick: () => toggleCtx(`${item.path}:${item.line}`),
        }, '?'),
        waitChip(t, item, waits, onWait),
        deferButtons(t, item, onDeferTodo),
        ctxOpen[`${item.path}:${item.line}`]
          ? h('div', { className: 'pmp-td-ctxb' },
            h('div', { className: 'pmp-td-ctxb-h' }, `${t('todo.ctxDay')} · ${item.date}${item.weekday ? ` ${item.weekday}` : ''}`),
            h('div', { className: 'pmp-td-ctxb-p' }, previewOf.get(item.path) || t('todo.ctxEmpty')),
            h('button', {
              type: 'button',
              className: 'pmp-td-ctxb-open',
              onClick: () => onOpen(item.path),
            }, t('todo.ctxOpen')),
          )
          : null,
      )

      return h('div', { className: 'pmp-today' },
        h('div', { className: 'pmp-cards' },
          card(t('today.card.date'), todayKey.slice(5), `${todayKey.slice(0, 4)} · ${today?.weekday ?? weekdayName(todayKey)}`),
          card(t('today.card.entries'), today?.entries ?? 0, today ? today.title : t('today.notWritten')),
          card(t('today.card.todos'), today?.openTodos ?? 0, `${t('today.total')} ${openTotal}`),
          card(t('today.card.days'), Number(totals.days) || 0, totals.latest ? `${t('recall.latest')} ${String(totals.latest).slice(5)}` : ''),
        ),

        h('div', { className: 'pmp-week' },
          h('span', { className: 'pmp-week-k' }, t('today.week')),
          h('span', { className: 'pmp-week-i' }, `${week.entries} ${t('today.weekEntries')}`),
          h('span', { className: 'pmp-week-i' }, `${week.done} ${t('today.weekDone')}`),
          h('span', { className: `pmp-week-i${week.owed > 0 ? ' warn' : ''}` }, `${week.owed} ${t('today.weekOwed')}`),
          h('span', { className: 'pmp-week-n' }, t('today.weekSince').replace('{d}', week.start.slice(5))),
        ),

        wroteToday
          ? null
          : h('div', { className: 'pmp-today-first' },
            h('div', { className: 'pmp-today-first-h' },
              h(IconToday, { size: 15 }),
              h('span', null, t('today.first.title')),
            ),
            h('div', { className: 'pmp-today-first-p' }, t('today.first.hint')),
            h('div', { className: 'pmp-today-first-a' },
              h('button', { type: 'button', className: 'pmp-btn primary sm', onClick: onNote }, t('today.first.write')),
              h('button', {
                type: 'button',
                className: 'pmp-btn sm',
                onClick: () => {
                  const node = addRef.current
                  if (node && typeof node.focus === 'function') node.focus()
                },
              }, t('today.first.todo')),
            ),
          ),

        h('div', { className: 'pmp-sec' },
          h('div', { className: 'pmp-sec-h' },
            h('span', null, t('today.owed')),
            h('span', { className: 'pmp-sort' },
              h('button', {
                type: 'button',
                className: `pmp-chipb${sortMode === 'fresh' ? ' on' : ''}`,
                onClick: () => (typeof props.onTodoSort === 'function' ? props.onTodoSort('fresh') : null),
              }, t('today.sort.fresh')),
              h('button', {
                type: 'button',
                className: `pmp-chipb${sortMode === 'oldest' ? ' on' : ''}`,
                onClick: () => (typeof props.onTodoSort === 'function' ? props.onTodoSort('oldest') : null),
              }, t('today.sort.oldest')),
            ),
            owed.length > 0
              ? h('span', { className: 'pmp-badge warn' }, openTotal > owed.length ? `${owed.length} / ${openTotal}` : `${owed.length}`)
              : null,
          ),
          owed.length === 0
            ? h('div', { className: 'pmp-empty', style: { padding: '10px 2px' } }, t('today.owedEmpty'))
            : h('div', null,
              sortMode === 'fresh' && shownFresh.length > 0
                ? h('div', null,
                  h('div', { className: 'pmp-subh' }, t('today.fresh'), h('span', { className: 'pmp-badge' }, String(fresh.length))),
                  h('div', { className: 'pmp-today-todos' }, shownFresh.map(todoRow)),
                )
                : null,
              sortMode === 'fresh' && shownCarried.length > 0
                ? h('div', null,
                  h('div', { className: 'pmp-subh' }, t('today.carried'), h('span', { className: 'pmp-badge warn' }, String(carried.length))),
                  h('div', { className: 'pmp-today-todos' }, shownCarried.map(todoRow)),
                )
                : null,
              sortMode === 'oldest'
                ? h('div', { className: 'pmp-today-todos' }, shown.map(todoRow))
                : null,
            ),
          h('div', { className: 'pmp-today-add' },
            h('input', {
              className: 'pmp-input',
              ref: addRef,
              value: addDraft,
              placeholder: t('today.addHint'),
              onChange: (e) => setAddDraft(e.target.value),
              onKeyDown: (e) => {
                if (e.key !== 'Enter') return
                e.preventDefault()
                void submitAdd()
              },
              spellCheck: false,
            }),
            h('button', {
              type: 'button',
              className: 'pmp-btn sm',
              disabled: busyAdd || !addDraft.trim(),
              onClick: () => void submitAdd(),
            }, busyAdd ? '…' : t('today.addBtn')),
          ),
          owedLeft > 0 || owedExpanded
            ? h('div', { className: 'pmp-today-more' },
              h('button', {
                type: 'button',
                className: 'pmp-link',
                onClick: () => setOwedExpanded((open) => !open),
              }, owedExpanded
                ? t('today.collapseOwed')
                : t('today.expandOwed').replace('{n}', String(owedLeft))),
              typeof props.onTodos === 'function'
                ? h('button', {
                  type: 'button',
                  className: 'pmp-link',
                  style: { marginLeft: '14px' },
                  onClick: () => props.onTodos(),
                }, t('today.toTodos'))
                : null)
            : null,
          doneCount > 0
            ? h('div', { className: 'pmp-done' },
              h('button', {
                type: 'button',
                className: 'pmp-done-h',
                title: t('today.doneHint'),
                onClick: () => setDoneOpen((open) => !open),
              },
                h('span', { className: 'pmp-done-k' }, '✓'),
                h('span', { className: 'pmp-done-c' }, t('today.doneCount').replace('{n}', String(doneCount))),
                h('span', { className: 'pmp-done-x', style: { transform: doneOpen ? 'rotate(90deg)' : 'none' } }, '▸')),
              doneOpen && doneItems.length > 0
                ? h('div', { className: 'pmp-done-l' }, doneItems.map((item, index) => h('div', { key: `done-${index}`, className: 'pmp-done-i' },
                  h('span', { className: 'pmp-done-b' }, '✓'),
                  // 做完的事也要能回到现场：点一下打开那天的日记，落在它所在的小节
                  h('button', {
                    type: 'button',
                    className: 'pmp-done-t',
                    title: t('today.doneOpen'),
                    onClick: () => {
                      if (typeof onOpenDone !== 'function' || !today) return
                      onOpenDone({ path: today.path, section: item.section })
                    },
                  }, item.text))))
                : null)
            : null,
        ),

        h('div', { className: 'pmp-sec' },
          h('div', { className: 'pmp-sec-h' },
            h('span', null, t('today.wrote')),
            today
              ? h('button', { type: 'button', className: 'pmp-sec-a', onClick: () => onOpen(today.path) }, t('today.open'))
              : h('button', { type: 'button', className: 'pmp-sec-a', onClick: onNote }, t('today.write')),
          ),
          today
            ? h('div', { className: 'pmp-today-read' },
              h('div', { className: 'pmp-today-meta' }, `${today.title} · ${today.entries} ${t('meta.entries')} · ${num(today.chars)} ${t('meta.chars')}`),
              h('div', { className: 'pmp-today-p' }, today.preview || ''),
            )
            : h('div', { className: 'pmp-empty', style: { padding: '10px 2px' } }, t('today.empty')),
        ),

        prevDays.length > 0
          ? h('div', { className: 'pmp-sec' },
            h('div', { className: 'pmp-sec-h' }, h('span', null, t('today.prev'))),
            h('div', { className: 'pmp-prev' }, prevDays.map((day) => h('button', {
              type: 'button',
              key: day.path,
              className: 'pmp-prev-row',
              onClick: () => onOpen(day.path),
              title: day.path,
            },
              h('div', { className: 'pmp-prev-d' },
                h('span', { className: 'pmp-prev-dt' }, String(day.date).slice(5)),
                h('span', { className: 'pmp-prev-w' }, day.weekday ?? ''),
                h('span', { className: 'pmp-badge mute' }, `${Number(day.entries) || 0} ${t('meta.entries')}`),
                Number(day.openTodos) > 0
                  ? h('span', { className: 'pmp-badge warn' }, t('today.card.owed').replace('{n}', String(Number(day.openTodos))))
                  : null,
              ),
              h('div', { className: 'pmp-prev-p' }, day.preview || t('today.emptyDay')),
            ))),
          )
          : null,

        recent.length > 0
          ? h('div', { className: 'pmp-sec' },
            h('div', { className: 'pmp-sec-h' }, h('span', null, t('today.recent'))),
            h('div', { className: 'pmp-today-recent' }, recent.map((doc) => h('button', {
              type: 'button',
              key: doc.path,
              className: `pmp-rel${selected === doc.path ? ' on' : ''}`,
              onClick: () => onOpen(doc.path),
            },
              doc.title,
              h('small', null, `${doc.path} · ${num(doc.chars)} ${t('meta.chars')}`),
            ))),
          )
          : null,
      )
    }

    /* ------------------------------------------------------------------ *
     * 左侧：未完成清单（跨天）
     * ------------------------------------------------------------------ */
    function MasterTodos(props) {
      const { t, timeline, selected, onOpen, onToggleTodo, onDeferTodo, waits = {}, nexts = {}, onWait, onEditNext, onPlanNext, collapsed = {}, onCollapse } = props
      const [filter, setFilter] = useState('')
      const [ageMin, setAgeMin] = useState(0)
      // 「我只能等」和「我能推进」是两种状态，混在一起会让人反复翻同一批条目
      const [waitOnly, setWaitOnly] = useState(props.initialWaitOnly === true)
      // 一直往后推的事和「本周才冒出来的事」不是一回事：挪过 2 次以上的单独能筛
      const [movedOnly, setMovedOnly] = useState(props.initialMovedOnly === true)
      // 「这条是哪天为什么加的」——勾之前人常想看一眼出处，跳页太重
      const [ctxOpen, setCtxOpen] = useState({})
      const toggleCtx = (key) => setCtxOpen((prev) => ({ ...prev, [key]: prev[key] !== true }))

      // 36 条待办平铺就是一堵墙。先按「欠了多久」分三档：今天 / 这一周 / 更早。
      const items = useMemo(() => {
        const q = filter.trim().toLowerCase()
        const out = []
        for (const day of timeline?.days ?? []) {
          const todos = Array.isArray(day.todos) ? day.todos : []
          if (todos.length === 0) continue
          const age = daysSince(day.date)
          if (ageMin > 0 && age < ageMin) continue
          for (const item of todos) {
            if (q && !String(item.text ?? '').toLowerCase().includes(q)) continue
            const raw = waits[waitKeyOf(item.text)]
            const kind = waitKind(raw, item.wait)
            if (waitOnly && !kind) continue
            if (movedOnly && (Number(item.movedCount) || 0) < 2) continue
            out.push({ path: day.path, date: day.date, weekday: day.weekday ?? '', line: item.line, text: item.text, section: item.section, age, preview: day.preview ?? '', kind, waitDays: Number(item.waitDays) || 0, next: item.next ?? null, movedCount: Number(item.movedCount) || 0, movedFrom: item.movedFrom ?? null, movedSteps: Array.isArray(item.movedSteps) ? item.movedSteps : [] })
          }
        }
        return out
      }, [timeline, filter, ageMin, waitOnly, movedOnly, waits])

      // 预览/深链接用：直接展开第一条的「那天写了什么」（宿主不传）
      const firstKey = items.length > 0 ? `${items[0].path}:${items[0].line}` : null
      useEffect(() => {
        if (props.initialCtx === true && firstKey && ctxOpen[firstKey] !== true) setCtxOpen({ [firstKey]: true })
      }, [firstKey, props.initialCtx])

      const buckets = useMemo(() => {
        const defs = [
          { key: 'today', label: t('todo.bucket.today'), test: (age) => age <= 0 },
          { key: 'week', label: t('todo.bucket.week'), test: (age) => age > 0 && age < 7 },
          { key: 'old', label: t('todo.bucket.old'), test: (age) => age >= 7 },
        ]
        const list = defs
          .map((def) => {
            const rows = items.filter((item) => def.test(item.age))
            // 档头除了件数，再给「最久的那条欠了几天」——36 条里哪些是真旧账，一件件点看不清
            return { ...def, rows, oldest: rows.reduce((max, item) => Math.max(max, Number(item.age) || 0), 0) }
          })
          .filter((bucket) => bucket.rows.length > 0)
        // 只在「全部」时分组；选了具体天数就是在找一个窗口，不用再分三层
        return ageMin === 0 ? list : list.map((bucket, index) => ({ ...bucket, flat: true, key: `${bucket.key}-${index}` }))
      }, [items, ageMin, t])

      // 「变成行动」不是终点：先问一句下一步是什么，回车才真的落地
      const [actingKey, setActingKey] = useState(props.initialActing ?? null)
      const [actingDraft, setActingDraft] = useState(props.initialActingDraft ?? '')

      // 标了「在等」但等了 3 天以上的：不是催，是提醒「这个判断还成立吗」。
      // 只在没做别的筛选时出现，避免和「只看在等的」叠成一屏噪音。
      const staleWaits = useMemo(() => {
        if (filter.trim() || ageMin > 0 || waitOnly) return []
        return items.filter((item) => item.kind && item.waitDays >= 3).slice(0, 3)
      }, [items, filter, ageMin, waitOnly])

      // 预览/深链接用：直接展开第一条「等太久」的下一步输入框
      const firstStaleKey = staleWaits.length > 0 ? `${staleWaits[0].path}:${staleWaits[0].line}` : null
      useEffect(() => {
        if (props.initialActing === true && firstStaleKey && actingKey !== firstStaleKey) {
          setActingKey(firstStaleKey)
          setActingDraft(String(props.initialActingText ?? ''))
        }
      }, [firstStaleKey, props.initialActing])

      // 已经在往后挪的那条（预览/深链接要能直接展开看理由，不用先点一下）
      const firstMovedKey = (() => {
        const hit = items.find((row) => (Number(row.movedCount) || 0) >= 2)
        return hit ? `${hit.path}#${hit.line}` : null
      })()
      // 点开「挪过 N 次」看每一步的理由；再点收起
      const [mvOpen, setMvOpen] = useState(props.initialMvOpen === true && firstMovedKey ? { [firstMovedKey]: true } : {})
      const toggleMv = (key) => setMvOpen((prev) => ({ ...prev, [key]: prev[key] !== true }))
      // 第二次以后的改期先问一句「为什么往后挪」，回车才真挪
      const [askKey, setAskKey] = useState(props.initialAskForRepeat === true ? firstMovedKey : null)
      const [askTo, setAskTo] = useState('tomorrow')
      const [askDraft, setAskDraft] = useState('')
      const submitAsk = (note) => {
        if (!askKey) return
        const [path, lineText] = askKey.split('#')
        const item = items.find((row) => `${row.path}#${row.line}` === askKey)
        setAskKey(null)
        setAskDraft('')
        if (!item) return
        onDeferTodo({ path, line: Number(lineText), expect: item.text, to: askTo, note })
      }

      // 「挪过 2 次以上」有几条：有才显示筛选 chip（偶尔挪一次不算问题）
      const movedCountTotal = items.filter((item) => item.movedCount >= 2).length
      const total = items.length

      return h('div', { className: 'pmp-master' },
        h('div', { className: 'pmp-searchbox' },
          h('input', {
            className: 'pmp-input',
            placeholder: t('todo.filter'),
            value: filter,
            onChange: (event) => setFilter(event.target.value),
          }),
          h('div', { className: 'pmp-chips-row' },
            h('span', { className: 'pmp-badge mute', style: { marginRight: 'auto', alignSelf: 'center' } },
              `${total} ${t('meta.todos')}`),
            h('button', {
              type: 'button',
              className: `pmp-chipb${waitOnly ? ' on' : ''}`,
              title: t('todo.waitOnlyHint'),
              onClick: () => setWaitOnly((open) => !open),
            }, t('todo.waitOnly')),
            movedCountTotal >= 2
              ? h('button', {
                type: 'button',
                className: `pmp-chipb${movedOnly ? ' on' : ''}`,
                title: t('todo.movedOnlyHint'),
                onClick: () => setMovedOnly((open) => !open),
              }, t('todo.movedOnly'))
              : null,
            [[0, t('todo.allAge')], [1, t('todo.today')], [3, t('todo.age3')], [7, t('todo.age7')]].map(([value, label]) => h('button', {
              type: 'button',
              key: String(value),
              className: `pmp-chipb${ageMin === value ? ' on' : ''}`,
              onClick: () => setAgeMin(value),
            }, label))),
        ),
        staleWaits.length > 0 && typeof onWait === 'function'
          ? h('div', { className: 'pmp-wr' },
            h('div', { className: 'pmp-wr-h' }, t('wait.review')),
            staleWaits.map((item) => h('div', { key: `${item.path}:${item.line}`, className: 'pmp-wr-row' },
              h('span', { className: 'pmp-wr-t', title: item.text }, item.text),
              h('span', { className: 'pmp-wr-d' }, t('wait.days').replace('{n}', String(item.waitDays))),
              h('button', {
                type: 'button',
                className: 'pmp-chipb',
                title: t('wait.keepHint'),
                onClick: () => onWait({ text: item.text, kind: item.kind }),
              }, t('wait.keep')),
              h('button', {
                type: 'button',
                className: 'pmp-chipb on',
                title: t('wait.actHint'),
                onClick: () => {
                  const key = `${item.path}:${item.line}`
                  if (actingKey === key && actingDraft.trim()) {
                    onWait({ text: item.text, kind: null, next: actingDraft })
                    setActingKey(null)
                    setActingDraft('')
                    return
                  }
                  setActingKey(key)
                  setActingDraft('')
                },
              }, actingKey === `${item.path}:${item.line}` && actingDraft.trim() ? t('wait.actSave') : t('wait.act')),
              actingKey === `${item.path}:${item.line}` && typeof onPlanNext === 'function'
                ? ['tomorrow', 'monday'].map((to) => h('button', {
                  key: to,
                  type: 'button',
                  className: 'pmp-chipb',
                  title: t(to === 'monday' ? 'wait.planMonHint' : 'wait.planTomHint'),
                  onClick: () => {
                    onPlanNext({ path: item.path, line: item.line, text: item.text, to, next: actingDraft })
                    setActingKey(null)
                    setActingDraft('')
                  },
                }, t(to === 'monday' ? 'wait.planMon' : 'wait.planTom')))
                : null,
              actingKey === `${item.path}:${item.line}`
                ? h('input', {
                  className: 'pmp-input pmp-wr-input',
                  placeholder: t('wait.nextPlaceholder'),
                  value: actingDraft,
                  autoFocus: true,
                  onChange: (event) => setActingDraft(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Escape') { setActingKey(null); setActingDraft('') }
                    if (event.key !== 'Enter') return
                    onWait({ text: item.text, kind: null, next: actingDraft })
                    setActingKey(null)
                    setActingDraft('')
                  },
                })
                : null)))
          : null,
        total === 0
          ? h('div', { className: 'pmp-empty' }, t('todo.empty'))
          : buckets.map((bucket) => {
            const isClosed = collapsed[`bucket:${bucket.key}`] === true
            return h('div', { key: bucket.key, className: 'pmp-group' },
              bucket.flat
                ? null
                : h('button', {
                  type: 'button',
                  className: 'pmp-td-g',
                  style: { border: 0, width: '100%', textAlign: 'left', cursor: 'pointer', font: 'inherit' },
                  onClick: () => (typeof onCollapse === 'function' ? onCollapse(`bucket:${bucket.key}`) : null),
                },
                  h('span', { className: `pmp-td-x${isClosed ? '' : ' on'}` }, '\u25b8'),
                  h('span', null, bucket.label),
                  bucket.oldest > 0
                    ? h('span', { className: 'pmp-badge mute' }, t('todo.bucketOldest').replace('{n}', String(bucket.oldest)))
                    : null,
                  h('span', { className: 'pmp-count', style: { marginLeft: 'auto' } }, String(bucket.rows.length)),
                ),
              isClosed ? null : bucket.rows.map((item, index) => h('div', {
                key: `${item.path}#${item.line ?? index}`,
                className: `pmp-td pmp-td-wrap${selected === item.path ? ' on' : ''}`,
              },
                h('button', {
                  type: 'button',
                  className: 'pmp-td-box',
                  title: t('todo.done'),
                  onClick: () => onToggleTodo?.({ path: item.path, line: item.line, done: true, expect: item.text }),
                }),
                h('button', {
                  type: 'button',
                  className: 'pmp-td-open',
                  onClick: () => onOpen(item.path),
                },
                  h('span', { className: 'pmp-td-t' }, item.text || t('todo.unnamed')),
                  nextLine(t, item, nexts, onEditNext) ? h('span', { className: 'pmp-td-nextw' }, nextLine(t, item, nexts, onEditNext)) : null,
                  h('span', { className: 'pmp-td-m' },
                    // 「未完成」是这一页的默认归属，每条都挂一遍就是噪声；只标意外的来源
                    item.section && item.section !== '未完成' ? h('span', { className: 'pmp-badge mute' }, item.section) : null,
                    h('span', null, item.date),
                    item.age >= 7 ? h('span', { className: 'pmp-badge warn' }, `${item.age} ${t('todo.days')}`) : null,
                    movedBadge(t, item, { open: mvOpen[`${item.path}#${item.line}`] === true, onToggle: () => toggleMv(`${item.path}#${item.line}`) }),
                  ),
                ),
                h('button', {
                  type: 'button',
                  className: `pmp-td-ctx${ctxOpen[`${item.path}:${item.line}`] ? ' on' : ''}`,
                  title: t('todo.ctx'),
                  onClick: () => toggleCtx(`${item.path}:${item.line}`),
                }, '?'),
                // 「今天不做」不是「做完了」：给一条改期的路，别逼人用勾掉来清屏
                waitChip(t, item, waits, onWait),
                deferButtons(t, item, onDeferTodo, (to) => {
                  setAskKey(`${item.path}#${item.line}`)
                  setAskTo(to)
                  setAskDraft('')
                }),
                ctxOpen[`${item.path}:${item.line}`]
                  ? h('div', { className: 'pmp-td-ctxb' },
                    h('div', { className: 'pmp-td-ctxb-h' }, `${t('todo.ctxDay')} · ${item.date}${item.weekday ? ` ${item.weekday}` : ''}`),
                    h('div', { className: 'pmp-td-ctxb-p' }, item.preview || t('todo.ctxEmpty')),
                    h('button', {
                      type: 'button',
                      className: 'pmp-td-ctxb-open',
                      onClick: () => onOpen(item.path),
                    }, t('todo.ctxOpen')),
                  )
                  : null,
                mvOpen[`${item.path}#${item.line}`] === true ? movedBlock(t, item) : null,
                askKey === `${item.path}#${item.line}`
                  ? h('div', { className: 'pmp-mv-ask' },
                    h('div', { className: 'pmp-mv-ask-h' }, t('todo.whyAsk')),
                    h('input', {
                      className: 'pmp-input',
                      placeholder: t('todo.whyHint'),
                      value: askDraft,
                      autoFocus: true,
                      onChange: (event) => setAskDraft(event.target.value),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter') submitAsk(askDraft.trim())
                        if (event.key === 'Escape') setAskKey(null)
                      },
                    }),
                    h('div', { className: 'pmp-mv-ask-a' },
                      h('button', { type: 'button', className: 'pmp-btn sm primary', onClick: () => submitAsk(askDraft.trim()) }, t('todo.whyGo')),
                      h('button', { type: 'button', className: 'pmp-btn sm ghost', onClick: () => submitAsk('') }, t('todo.whySkip')),
                    ),
                  )
                  : null,
              )),
            )
          }),
      )
    }

    function MasterSearch(props) {
      const { t, selected, onOpen, onOpenIn, recent = [], sort = 'score', onSort, onEditAtEnd, onNewNoteFrom, onSearchFor } = props
      const [query, setQuery] = useState(props.initialQuery ?? '')
      const [scopes, setScopes] = useState({ personal: true, memory: true, project: false })
      const [days, setDays] = useState(0)
      // 待办状态不是笔记正文：想「我还在等什么」时，混在笔记命中里得自己扫
      // 「只看某一类」：'' 全都要 / 'state' 只看待办 / 'clue' 只看线索。
      // 同时只看两类跟都不看差别不大，所以做成单选
      const [onlyKind, setOnlyKind] = useState(props.initialOnlyKind ?? (props.initialStateOnly === true ? 'state' : ''))
      const onlyKindRef = useRef(onlyKind)
      useEffect(() => { onlyKindRef.current = onlyKind }, [onlyKind])
      const stateOnly = onlyKind === 'state'
      const clueOnly = onlyKind === 'clue'
      const anyOnly = onlyKind !== ''
      const [hits, setHits] = useState(props.initialHits ?? null)
      // 「翻过但没动」：打开过、之后没再改的笔记——当时觉得有用，后来忘了
      const [visited, setVisited] = useState(props.initialVisited ?? null)
      const [visitedBusy, setVisitedBusy] = useState(false)
      // 「看一眼就走」的目录页：就地补一条线索（写进那页末尾），把路过变成改进
      const [clueFor, setClueFor] = useState('')
      const [clueDraft, setClueDraft] = useState('')
      const [clueBusy, setClueBusy] = useState(false)
      const [clueDone, setClueDone] = useState('')
      // 「这页的线索」：把所有 - 想找：… 收在一处，看哪些还悬着
      const [clueRows, setClueRows] = useState(props.initialClueRows ?? null)
      // 最近解决的留一周：解决完就消失，就看不出「我最近在补哪些缺口」
      const [clueRecent, setClueRecent] = useState(Array.isArray(props.initialClueRecent) ? props.initialClueRecent : null)
      const [cluePages, setCluePages] = useState(Array.isArray(props.initialCluePages) ? props.initialCluePages : null)
      // 「+ 记一条」：想到什么就直接记，不必先路过某一页
      const [newClueOpen, setNewClueOpen] = useState(false)
      const [newClueText, setNewClueText] = useState('')
      const [newCluePath, setNewCluePath] = useState('')
      const [newClueBusy, setNewClueBusy] = useState(false)
      // 「这条线索想要什么」：想知道答案 / 想确认已有结论 / 想找回原话出处——动作不同，先分开
      const [newClueKind, setNewClueKind] = useState(props.initialNewClueKind ?? 'find')
      // 从别处（线索行）带着一句话进检索页：seed.at 变一次就跑一次
      const seedSeen = useRef(0)
      useEffect(() => {
        const seed = props.seed
        if (!seed || !seed.q || seedSeen.current === seed.at) return
        seedSeen.current = seed.at
        setQuery(seed.q)
        void run(seed.q, scopeParam())
      })

      const submitNewClue = async () => {
        const text = String(newClueText ?? '').replace(/\s+/g, ' ').trim()
        const path = String(newCluePath || (cluePages ?? []).find((page) => page.scope === 'personal')?.path || (cluePages ?? [])[0]?.path || '')
        if (!text || !path || newClueBusy) return
        setNewClueBusy(true)
        try {
          await api.append({ path, line: `- 想找：${text}`, clueKind: newClueKind })
          setNewClueText('')
          setNewClueOpen(false)
          setClueDone(text)
          const value = await api.clues(100)
          setClueRows(Array.isArray(value?.items) ? value.items : [])
          setClueRecent(Array.isArray(value?.recent) ? value.recent : [])
        } catch (err) { setClueDone(String(err?.message ?? err)) } finally { setNewClueBusy(false) }
      }

      // 表单抽出来：线索页的「+ 记一条」和「什么都没搜到时」用的是同一个东西
      const clueForm = () => h('div', { className: 'pmp-clue' },
        h('div', { className: 'pmp-clue-h' }, t('search.clueNewAsk')),
        h('div', { className: 'pmp-clue-kind' }, ['find', 'check', 'cite'].map((kind) => h('button', {
          key: `kind-${kind}`,
          type: 'button',
          className: `pmp-chipb${newClueKind === kind ? ' on' : ''}`,
          title: t(`search.clueKindHint.${kind}`),
          onClick: () => setNewClueKind(kind),
        }, t(`search.clueKind.${kind}`)))),
        h('input', {
          className: 'pmp-input',
          placeholder: t('search.cluePlaceholder'),
          value: newClueText,
          autoFocus: true,
          onInput: (event) => setNewClueText(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') { event.preventDefault(); void submitNewClue() }
            else if (event.key === 'Escape') { event.preventDefault(); setNewClueOpen(false) }
          },
        }),
        h('div', { className: 'pmp-clue-a' },
          (cluePages ?? []).length > 0
            ? h('select', {
              className: 'pmp-input',
              style: { flex: 1 },
              value: newCluePath || (cluePages ?? [])[0]?.path || '',
              onChange: (event) => setNewCluePath(event.target.value),
            }, (cluePages ?? []).map((page) => h('option', { key: page.path, value: page.path }, `${page.title} · ${page.path}`)))
            : null,
          h('button', { type: 'button', className: 'pmp-btn primary sm', disabled: newClueBusy, onClick: () => void submitNewClue() }, newClueBusy ? '…' : t('search.clueSave')),
          h('button', { type: 'button', className: 'pmp-btn ghost sm', onClick: () => setNewClueOpen(false) }, t('search.clueCancel')),
        ))

      const toggleResolved = async (row) => {
        const on = !(Number(row.resolvedAt) > 0)
        try {
          await api.resolveClue(row.text, on)
          setClueRows((prev) => (prev ?? []).map((item) => (item.text === row.text
            ? { ...item, resolvedAt: on ? Date.now() : 0, open: on ? false : !item.touchedAfter }
            : item)))
        } catch (err) { setClueDone(String(err?.message ?? err)) }
      }

      const loadClues = async () => {
        if (clueRows !== null) { setClueRows(null); return }
        try {
          const value = await api.clues(100)
          setClueRows(Array.isArray(value?.items) ? value.items : [])
          setClueRecent(Array.isArray(value?.recent) ? value.recent : [])
          setCluePages(Array.isArray(value?.indexPages) ? value.indexPages : [])
        } catch (err) { setClueRows([]); setClueDone(String(err?.message ?? err)) }
      }

      const submitClue = async (path) => {
        const text = String(clueDraft ?? '').replace(/\s+/g, ' ').trim()
        if (!text || clueBusy) return
        setClueBusy(true)
        try {
          await api.append({ path, line: `- 想找：${text}` })
          setClueFor('')
          setClueDraft('')
          setClueDone(text)
          // 补完这条就不是「纯路过」了，刷新列表让这行的时间线跟着动
          setVisitedBusy(true)
          try {
            const value = await api.visited(20)
            setVisited(Array.isArray(value?.items) ? value.items : [])
          } finally { setVisitedBusy(false) }
        } catch (err) {
          setClueDone(String(err?.message ?? err))
        } finally {
          setClueBusy(false)
        }
      }
      const [ms, setMs] = useState(0)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const api = useRef(props.api ?? new Api()).current
      const runId = useRef(0)

      // 只看待办时范围无意义：待办只活在 memory/ 里，如实按 memory 查，别让 scope chip 说谎
      const scopeParam = () => (stateOnly ? 'memory' : Object.keys(scopes).filter((k) => scopes[k]).join(','))
      // 结果的类型分布：搜一次出来二十条，人并不想自己数「里面有几条不是我写的」
      const distribution = useMemo(() => {
        const rows = hits ?? []
        let note = 0
        let state = 0
        let clue = 0
        for (const hit of rows) {
          if (hit.via === 'state') state += 1
          else if (hit.via === 'clue') clue += 1
          else note += 1
        }
        return { note, state, clue }
      }, [hits])

      const onlyParam = () => (onlyKindRef.current || '')
      // 单选：点已亮的那个 = 取消筛选
      const setOnly = (kind) => {
        const next = onlyKindRef.current === kind ? '' : kind
        setOnlyKind(next)
        onlyKindRef.current = next
        if (query.trim()) void run(query, next === 'state' ? 'memory' : Object.keys(scopes).filter((key) => scopes[key]).join(','))
      }
      // 排序只动展示顺序，不动召回集合：换成分数/时间，同一批命中换个看法
      const shown = useMemo(() => {
        const list = Array.isArray(hits) ? hits.slice() : []
        if (sort === 'recent') {
          return list.sort((a, b) => (Number(b.mtimeMs) || 0) - (Number(a.mtimeMs) || 0))
        }
        return list.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
      }, [hits, sort])

      const run = useCallback(async (q, scope, within) => {
        const text = String(q ?? '').trim()
        if (!text) { setHits(null); setError(''); return }
        const id = ++runId.current
        setBusy(true)
        setError('')
        try {
          const value = await api.search(text, scope, 12, { days: within ?? days, only: onlyKindRef.current || '' })
          if (id !== runId.current) return
          setHits(value.hits ?? [])
          setMs(num(value.ms))
        } catch (err) {
          if (id !== runId.current) return
          setHits([])
          setError(String(err?.message ?? err))
        } finally {
          if (id === runId.current) setBusy(false)
        }
      }, [api, days])

      // 「打开过但一直没动」这件事，只有打点才知道：查一次列表，不参与召回
      const loadVisited = useCallback(async () => {
        setVisitedBusy(true)
        try {
          const value = await api.visited(20)
          setVisited(Array.isArray(value?.items) ? value.items : [])
        } catch (err) {
          setVisited([])
          setError(err?.message ?? String(err))
        } finally {
          setVisitedBusy(false)
        }
      }, [api])

      const seeded = useRef(false)
      useEffect(() => {
        const seed = String(props.initialQuery ?? '').trim()
        if (seeded.current || !seed) return
        seeded.current = true
        void run(seed, Object.keys(scopes).filter((k) => scopes[k]).join(','))
      }, [])

      const toggleScope = (key) => {
        const next = { ...scopes, [key]: !scopes[key] }
        if (!next.personal && !next.memory && !next.project) return
        setScopes(next)
        if (query.trim()) void run(query, Object.keys(next).filter((k) => next[k]).join(','))
      }

      return h('div', { className: 'pmp-master' },
        h('div', { className: 'pmp-searchbox' },
          h('input', {
            className: 'pmp-input',
            value: query,
            placeholder: t('search.placeholder'),
            autoFocus: true,
            spellCheck: false,
            onChange: (e) => setQuery(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') void run(query, scopeParam()) },
          }),
          h('div', { className: 'pmp-chips-row' },
            ['personal', 'memory', 'project'].map((key) => h('button', {
              type: 'button',
              key,
              // 只看待办时范围无意义（待办只活在 memory/ 里）：禁用 + 变淡，别让 chip 说谎
              className: `pmp-chipb${stateOnly ? ' dim' : scopes[key] ? ' on' : ''}`,
              disabled: stateOnly,
              title: stateOnly ? t('search.scopeOffHint') : '',
              onClick: () => toggleScope(key),
            }, t(`search.scope.${key}`))),
            h('span', { className: 'pmp-chip-sep' }),
            [[0, t('search.anyTime')], [7, t('search.days7')], [30, t('search.days30')]].map(([value, label]) => h('button', {
              type: 'button',
              key: String(value),
              className: `pmp-chipb${days === value ? ' on' : ''}`,
              onClick: () => {
                setDays(value)
                if (query.trim()) void run(query, scopeParam(), value)
              },
            }, label)),
            h('span', { className: 'pmp-chip-sep' }),
            h('button', {
              type: 'button',
              className: `pmp-chipb${stateOnly ? ' on' : ''}`,
              title: t('search.onlyStateHint'),
              onClick: () => setOnly('state'),
            }, t('search.onlyState')),
            h('button', {
              type: 'button',
              className: `pmp-chipb${clueOnly ? ' on' : ''}`,
              title: t('search.onlyClueHint'),
              onClick: () => setOnly('clue'),
            }, t('search.onlyClue')),
            h('button', {
              type: 'button',
              className: `pmp-chipb${visited ? ' on' : ''}`,
              title: t('search.visitedHint'),
              onClick: () => {
                if (visited) { setVisited(null); return }
                void loadVisited()
              },
            }, visitedBusy ? '…' : t('search.visited')),
            h('button', {
              type: 'button',
              className: `pmp-chipb${clueRows !== null ? ' on' : ''}`,
              title: t('search.clueSheetHint'),
              onClick: () => void loadClues(),
            }, t('search.clueSheet')),
            h('button', {
              type: 'button',
              className: 'pmp-btn sm',
              style: { marginLeft: 'auto' },
              disabled: busy || !query.trim(),
              onClick: () => void run(query, scopeParam()),
            }, busy ? h(Spinner) : t('search.btn')),
          ),
        ),
        error ? h('div', { className: 'pmp-err', style: { margin: '10px' } }, error) : null,
        !query.trim() && recent.length > 0
          ? h('div', { className: 'pmp-recent' },
            h('div', { className: 'pmp-recent-h' }, t('search.recent')),
            h('div', { className: 'pmp-chips-row' }, recent.slice(0, 6).map((raw, index2) => {
              // 老状态里是裸字符串，新的是 {q, scope, days}：两种都要能点
              const item = typeof raw === 'string' ? { q: raw, scope: '', days: 0 } : (raw ?? {})
              const shownScope = String(item.scope ?? '')
              const extra = [
                shownScope && shownScope.split(',').filter(Boolean).length < 3
                  ? shownScope.split(',').filter(Boolean).map((key) => t(`search.short.${key}`)).join('/')
                  : '',
                Number(item.days) > 0 ? t('search.recentDays').replace('{n}', String(Number(item.days))) : '',
                item.only === 'state' ? t('search.onlyState') : '',
              ].filter(Boolean).join(' · ')
              return h('button', {
                type: 'button',
                key: `${item.q}-${index2}`,
                className: 'pmp-chipb',
                title: extra ? `${item.q} · ${extra}` : item.q,
                onClick: () => {
                  // 恢复的不只是那句话，还有当时的范围和筛选条件
                  setQuery(item.q)
                  const keys = String(item.scope ?? '').split(',').filter(Boolean)
                  const nextScope = {}
                  for (const key of ['personal', 'memory', 'project']) nextScope[key] = keys.length === 0 ? true : keys.includes(key)
                  setScopes(nextScope)
                  const nextDays = Number(item.days) > 0 ? Number(item.days) : 0
                  setDays(nextDays)
                  // 恢复的是「同一屏」：当时开了「只看待办」，就要连带把开关打开
                  const nextOnly = item.only === 'state' || item.only === 'clue' ? item.only : ''
                  setOnlyKind(nextOnly)
                  onlyKindRef.current = nextOnly
                  void run(item.q, nextOnly === 'state' ? 'memory' : Object.keys(nextScope).filter((key) => nextScope[key]).join(','), nextDays)
                },
              }, extra ? `${item.q} · ${extra}` : item.q)
            })),
          )
          : null,
        visited
          ? h('div', { className: 'pmp-exp' },
            h('div', { className: 'pmp-exp-h' }, t('search.visitedH').replace('{n}', String(visited.length))),
            visited.length === 0
              ? h('div', { className: 'pmp-empty' }, t('search.visitedEmpty'))
              : h('div', { className: 'pmp-exp-list' }, visited.map((item) => h('div', { key: item.path, className: 'pmp-vis-wrap' },
                h('div', { className: 'pmp-vis-row' },
                h('button', {
                  type: 'button',
                  className: 'pmp-vis-main',
                  title: item.path,
                  onClick: () => onOpen(item.path),
                },
                h('span', { className: 'pmp-vis-line' },
                  h('span', { className: 'pmp-badge mute' }, t('search.visitedTag')),
                  item.kind === 'index' ? h('span', { className: 'pmp-badge mute', title: t('search.visitedIndexHint') }, t('search.visitedIndex')) : null,
                  h('span', { className: 'pmp-vis-t', title: item.title }, item.title),
                ),
                h('span', { className: 'pmp-vis-n' }, visitedMetaText(t, item)),
                ),
                // 列表只说明「我看过没动」，要动还得有一步：直接进编辑态，光标落在文末
                typeof onEditAtEnd === 'function'
                  ? h('button', {
                    type: 'button',
                    className: 'pmp-vis-edit',
                    title: t('search.visitedEditHint'),
                    onClick: () => onEditAtEnd(item.path),
                  }, item.kind === 'index' ? t('search.visitedAddHere') : t('search.visitedEdit'))
                  : null,
                ),
                // 目录页「看一眼就走」通常意味着「我想找的东西没在索引里写清楚」：给一条把路过变成改进的路
                item.kind === 'index' && Number(item.dwell) > 0 && Number(item.dwell) < 10000 && typeof api?.append === 'function'
                  ? (clueFor === item.path
                    ? h('div', { className: 'pmp-clue' },
                      h('div', { className: 'pmp-clue-h' }, t('search.clueAsk')),
                      h('input', {
                        className: 'pmp-input',
                        placeholder: t('search.cluePlaceholder'),
                        value: clueDraft,
                        autoFocus: true,
                        onInput: (event) => setClueDraft(event.target.value),
                        onKeyDown: (event) => {
                          if (event.key === 'Enter') { event.preventDefault(); void submitClue(item.path) }
                          else if (event.key === 'Escape') { event.preventDefault(); setClueFor('') }
                        },
                      }),
                      h('div', { className: 'pmp-clue-a' },
                        h('button', { type: 'button', className: 'pmp-btn primary sm', disabled: clueBusy, onClick: () => void submitClue(item.path) }, clueBusy ? '…' : t('search.clueSave')),
                        h('button', { type: 'button', className: 'pmp-btn ghost sm', onClick: () => setClueFor('') }, t('search.clueCancel')),
                      ))
                    : h('button', { type: 'button', className: 'pmp-vis-clue', title: t('search.clueHint'), onClick: () => { setClueFor(item.path); setClueDraft('') } }, t('search.clue')))
                  : null,
              ))),
          )
          : null,
        clueRows !== null
          ? h('div', { className: 'pmp-exp' },
            h('div', { className: 'pmp-exp-h' },
              h('span', null, t('search.clueSheetH').replace('{n}', String(clueRows.filter((row) => row.open).length))),
              // 想到什么就直接记，不必先路过某一页——少一步摩擦，多一条记录
              h('button', {
                type: 'button',
                className: 'pmp-vis-clue',
                style: { alignSelf: 'auto', margin: '0 0 0 auto' },
                title: t('search.clueNewHint'),
                onClick: () => { setNewClueOpen(!newClueOpen); setNewClueText('') },
              }, t('search.clueNew')),
            ),
            newClueOpen ? clueForm() : null,
            clueRows.length === 0
              ? h('div', { className: 'pmp-empty' }, t('search.clueSheetEmpty'))
              : h('div', { className: 'pmp-exp-list' }, clueRows.map((row, index) => h('div', { key: `${row.path}-${index}`, className: 'pmp-vis-wrap' },
                h('div', { className: 'pmp-vis-row' },
                  h('button', { type: 'button', className: 'pmp-vis-main', title: `${row.path} 第 ${row.line} 行`, onClick: () => onOpen(row.path) },
                    h('span', { className: 'pmp-vis-line' },
                      row.open ? h('span', { className: 'pmp-badge warn' }, t('search.clueOpen')) : h('span', { className: 'pmp-badge mute' }, t('search.clueDone')),
                      // 悬着的线索要有时长：挂了两周的，比刚记的十条更值得看
                      row.open && Number(row.ageDays) >= 3
                        ? h('span', { className: 'pmp-badge mute', title: t('search.clueAgeHint') }, t('search.clueAge').replace('{n}', String(row.ageDays)))
                        : null,
                      h('span', { className: 'pmp-vis-t', title: row.text }, row.text),
                    ),
                    h('span', { className: 'pmp-vis-n' },
                      h('span', {
                        className: 'pmp-meta-k',
                        title: t(`search.clueKindHint.${row.clueKind ?? 'find'}`),
                      }, t(`search.clueKind.${row.clueKind ?? 'find'}`)),
                      ` · ${row.path} · ${t('search.clueLine').replace('{n}', String(row.line))}`),
                  ),
                  // 「该去哪补」：还没人写过 → 直接开新建并预填该页目录；想确认/想找回原话 → 带着那句话去检索
                  row.kind === 'index' && typeof onNewNoteFrom === 'function' && typeof onSearchFor === 'function'
                    ? h('button', {
                      type: 'button',
                      className: 'pmp-vis-go',
                      title: t(`search.clueGoHint.${row.clueKind ?? 'find'}`),
                      onClick: () => {
                        const dir = String(row.path).includes('/') ? String(row.path).slice(0, String(row.path).lastIndexOf('/')) : 'personal'
                        if ((row.clueKind ?? 'find') === 'find') onNewNoteFrom(dir)
                        else onSearchFor(row.text)
                      },
                    }, t(`search.clueGo.${row.clueKind ?? 'find'}`))
                    : null,
                  // 「这页没改」和「我已经知道了」是两件事：解决要能单独标，也要能撤
                  h('button', {
                    type: 'button',
                    className: 'pmp-vis-edit',
                    title: t('search.clueResolveHint'),
                    onClick: () => void toggleResolved(row),
                  }, row.resolvedAt > 0 ? t('search.clueReopen') : t('search.clueResolve')),
                ),
              ))),
            (clueRecent ?? []).length > 0
              ? h('div', { className: 'pmp-done' },
                h('div', { className: 'pmp-done-h' }, t('search.clueRecent').replace('{n}', String((clueRecent ?? []).length))),
                (clueRecent ?? []).map((row) => h('div', { className: 'pmp-res-row', key: String(row.text) },
                  h('span', { className: 'pmp-res-t', title: row.text }, row.text),
                  h('span', { className: 'pmp-res-d' }, row.days === 0 ? t('search.clueRecentToday') : t('search.clueRecentDays').replace('{n}', String(row.days))),
                )),
              )
              : null,
          )
          : null,
        hits === null
          ? (visited ? null : clueRows !== null ? null : recent.length > 0 ? null : h('div', { className: 'pmp-empty' }, t('search.idle')))
          : hits.length === 0
            ? h('div', { className: 'pmp-exp' },
              h('div', { className: 'pmp-empty' }, busy ? t('search.busy') : (stateOnly ? t('search.noneState') : clueOnly ? t('search.noneClue') : t('search.none'))),
              // 搜不到正是该记一笔的时刻：下次搜同一句时，这条线索自己会浮出来
              !busy && query.trim() && !stateOnly
                ? (newClueOpen
                  ? clueForm()
                  : h('div', { className: 'pmp-none-clue' },
                    h('span', { className: 'pmp-none-hint' }, t('search.noneClueHint')),
                    h('button', {
                      type: 'button',
                      className: 'pmp-btn ghost sm pmp-none-save',
                      style: { color: C.accent, borderColor: C.accent },
                      title: t('search.clueNewHint'),
                      onClick: () => {
                        setNewClueText(query.trim())
                        setNewClueOpen(true)
                        if (cluePages === null) void loadClues()
                      },
                    }, t('search.noneClueSave'))))
                : null)
            : h('div', null,
              h('div', { className: 'pmp-tl-m', style: { position: 'static', padding: '8px 12px 4px', background: 'transparent' } },
                h('span', null, t('search.stat').replace('{n}', String(hits.length)).replace('{ms}', String(ms))),
                // 类型分布：点一下只看那一类（笔记 = 关掉另外两路）
                h('span', { className: 'pmp-dist' }, [
                  ['note', t('search.distNote'), distribution.note],
                  ['state', t('search.distState'), distribution.state],
                  ['clue', t('search.distClue'), distribution.clue],
                ].filter(([, , count]) => count > 0).map(([kind, label, count]) => h('button', {
                  key: `dist-${kind}`,
                  type: 'button',
                  className: `pmp-btn ghost sm pmp-dist-b${onlyKind === kind ? ' on' : ''}`,
                  title: t(`search.distHint.${kind}`),
                  onClick: () => setOnly(kind),
                }, `${label} ${count}`))),
              ),
              typeof onSort === 'function'
                ? h('div', { style: { display: 'flex', gap: 6, padding: '0 12px 6px' } },
                  [['score', t('search.sortScore')], ['recent', t('search.sortRecent')]].map(([key, label]) =>
                    h('button', {
                      type: 'button',
                      key,
                      className: `pmp-chipb${sort === key ? ' on' : ''}`,
                      onClick: () => onSort(key),
                    }, label)))
                : null,
              shown.map((hit, index) => h('button', {
                type: 'button',
                key: `${hit.docId ?? index}-${index}`,
                className: `pmp-hit${selected === hit.path ? ' on' : ''}`,
                onClick: () => (typeof onOpenIn === 'function' ? onOpenIn(hit.path, hit.heading ?? '') : onOpen(hit.path)),
                title: hit.path,
              },
                h('div', { className: 'pmp-hit-t' },
                  h('span', { className: 'pmp-hit-title' }, hit.title || hit.path),
                  hit.via === 'state'
                    ? h('span', { className: 'pmp-badge mute', title: t('search.viaStateHint') }, t('search.viaState'))
                    : null,
                  // 线索命中：它不是「有这篇」，而是「这个缺口还开着」
                  hit.via === 'clue'
                    ? h('span', { className: 'pmp-badge warn', title: t('search.viaClueHint') }, t('search.viaClue'))
                    : null,
                  hit.mtimeMs
                    ? h('span', { className: 'pmp-hit-age', title: `${t('search.changed')} ${fmtDate(new Date(hit.mtimeMs))}` }, agoMs(hit.mtimeMs, t))
                    : null,
                  hit.usedAt
                    ? h('span', { className: 'pmp-hit-age pmp-used', title: `${t('search.usedHint')} ${fmtDate(new Date(hit.usedAt))}` }, t('search.usedAt').replace('{d}', agoMs(hit.usedAt, t)))
                    : null,
                  h('span', { className: 'pmp-score' }, Number(hit.score ?? 0).toFixed(3)),
                ),
                hit.heading ? h('div', { className: 'pmp-hit-h' }, `› ${hit.heading}`) : null,
                h('div', { className: 'pmp-bar' },
                  h('i', { style: { width: `${Math.max(3, Math.min(100, num(hit.score) * 100))}%` } }),
                ),
                h('div', { className: 'pmp-hit-e' }, hit.via === 'state'
                  ? `${t('search.stateTodo')} ${hit.stateText ?? ''}${hit.excerpt ? ` — ${hit.excerpt}` : ''}`
                  : hit.via === 'clue'
                    ? `${t('search.clueExcerpt')}${hit.excerpt ?? ''}`
                    : (hit.excerpt ?? '')),
              )),
            ),
      )
    }

    /* ------------------------------------------------------------------ *
     * 右侧：阅读器
     * ------------------------------------------------------------------ */
    // 「补一句」的哨兵值：editAt 平时是「光标要落到哪一句」，这里表示「落到文末」
    const EDIT_AT_END = '\u0000end'

    function DocReader(props) {
      // 相邻笔记：按当前列表顺序（左栏树 / 时间线日期）走，读一串笔记时手不用回左栏
      const { canPrev = false, canNext = false, onPrev, onNext } = props
      const { t, docPath, doc, loading, error, onRetry, api, onOpen, onToggleTodo, onBack, onSave, editSignal, starred, onStar, anchor , canHistoryBack, onHistoryBack, editAt } = props
      const scrollRef = useRef(null)
      const [related, setRelated] = useState([])
      const [relatedBusy, setRelatedBusy] = useState(false)

      // 编辑态：草稿放本地，保存成功才退出。换一篇就复位，草稿绝不带到下一篇。
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState('')
      const [saving, setSaving] = useState(false)
      const [discardArmed, setDiscardArmed] = useState(false)
      const editSignalSeen = useRef(0)
      const editorRef = useRef(null)
      const editAtSeen = useRef('')
      const body = useMemo(() => {
        if (!doc?.text) return { nodes: [], headings: [] }
        // 去掉首个 H1 时保留换行，行号才和磁盘上的文件对得上（勾待办要用行号）
        const text = String(doc.text).replace(/^\s*#\s+[^\n]*\n?/, (matched) => '\n'.repeat(Math.max(0, matched.split('\n').length - 1)))
        const onTask = typeof onToggleTodo === 'function'
          ? ({ line, done, text: label }) => onToggleTodo({ path: doc.path, line, done: !done, expect: label })
          : null
        return renderMarkdown(text, { onTask })
      }, [doc?.text, doc?.path, onToggleTodo])

      useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = 0 }, [docPath])

      // 读完一篇，顺手把「相关的其它笔记」捞回来：personal 与 memory 互相指认。
      useEffect(() => {
        if (!api || !doc?.path) { setRelated([]); return undefined }
        const query = String(
          doc.scope === 'memory'
            ? (doc.diary?.preview || doc.title || '')
            : `${doc.title ?? ''} ${String(doc.excerpt ?? '').slice(0, 80)}`,
        ).trim()
        if (query.length < 4) { setRelated([]); return undefined }
        let alive = true
        setRelatedBusy(true)
        api.search(query, 'personal,memory', 8, { record: false })
          .then((value) => {
            if (!alive) return
            setRelated((value.hits ?? []).filter((hit) => hit.path !== doc.path).slice(0, 5))
          })
          .catch(() => { if (alive) setRelated([]) })
          .finally(() => { if (alive) setRelatedBusy(false) })
        return () => { alive = false }
      }, [api, doc?.path, doc?.scope, doc?.title, doc?.excerpt, doc?.diary?.preview])

      useEffect(() => {
        setEditing(false)
        setSaving(false)
        setDiscardArmed(false)
        setDraft('')
      }, [docPath])

      // 「新建」之后直接进编辑：只在信号变化时触发一次，不跟用户的手动退出打架。
      useEffect(() => {
        if (!editSignal || editSignal === editSignalSeen.current) return
        if (!doc?.text) return
        editSignalSeen.current = editSignal
        setDraft(String(doc.text))
        setEditing(true)
      }, [editSignal, doc?.text])

      const clean = doc?.text ?? ''
      const dirty = editing && draft !== clean

      // 进编辑态之后，如果这次进来是「点下一步」触发的，把光标落到那句话上，
      // 顺便把编辑框滚到它附近——不然人还是要在几千字里自己找。
      useEffect(() => {
        if (!editing || !editAt || !editorRef.current) return
        const key = `${doc?.path ?? ''}|${editAt}`
        if (editAtSeen.current === key) return
        // 「补一句」：不打哪一句，就是落到文末——补记本来就该接在最后
        if (editAt === EDIT_AT_END) {
          editAtSeen.current = key
          const area = editorRef.current
          if (typeof area.focus === 'function') area.focus()
          const end = clean.length
          if (typeof area.setSelectionRange === 'function') area.setSelectionRange(end, end)
          area.scrollTop = area.scrollHeight ?? 0
          return
        }
        const at = clean.indexOf(String(editAt))
        if (at < 0) return
        editAtSeen.current = key
        const area = editorRef.current
        if (typeof area.focus === 'function') area.focus()
        if (typeof area.setSelectionRange === 'function') area.setSelectionRange(at, at + String(editAt).length)
        const line = clean.slice(0, at).split('\n').length
        area.scrollTop = Math.max(0, (line - 3) * 20)
      }, [editing, editAt, doc?.path, clean])

      const beginEdit = () => {
        setDraft(clean)
        setEditing(true)
        setDiscardArmed(false)
      }

      // 有未保存的改动时，第一次点「取消」只警告，再点一次才真丢。
      const cancelEdit = () => {
        if (dirty && !discardArmed) {
          setDiscardArmed(true)
          return
        }
        setEditing(false)
        setDiscardArmed(false)
        setDraft('')
      }

      const commitEdit = async () => {
        if (!editing || saving) return
        if (typeof onSave !== 'function') return
        setSaving(true)
        try {
          const kept = await onSave({ path: docPath, text: draft, hash: doc?.hash })
          if (kept !== false) {
            setEditing(false)
            setDiscardArmed(false)
            setDraft('')
          }
        } finally {
          setSaving(false)
        }
      }

      // 从检索页点进来：滚到命中那一节。标题比对要宽松（`《标题》`、空白、大小写都不该拦住）
      const sawAnchor = useRef(0)
      const normHeading = (value) => String(value ?? '').replace(/[《》\s]/g, '').toLowerCase()
      useEffect(() => {
        if (!anchor || !doc || anchor.path !== docPath) return
        if (sawAnchor.current === anchor.at) return
        const wanted = normHeading(anchor.heading)
        if (!wanted) { sawAnchor.current = anchor.at; return }
        const hit = body.headings.find((item) => {
          const text = normHeading(item.text)
          return text && (text === wanted || text.includes(wanted) || wanted.includes(text))
        })
        sawAnchor.current = anchor.at
        if (hit) jump(hit.id)
      }, [anchor?.at, doc?.path, body.headings.length])

      const jump = (id) => {
        const root = scrollRef.current
        if (!root) return
        const el = root.querySelector(`[data-h="${id}"]`)
        if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start', behavior: 'smooth' })
      }

      if (loading) {
        return h('div', { className: 'pmp-scroll' },
          h('div', { className: 'pmp-empty' }, h(Spinner), ' ', t('detail.loading')),
        )
      }

      if (error) {
        return h('div', { className: 'pmp-scroll' },
          h('div', { className: 'pmp-doc' },
            h('div', { className: 'pmp-err' }, error),
            h('button', { type: 'button', className: 'pmp-btn sm', onClick: onRetry }, t('act.retry')),
          ),
        )
      }

      if (!doc) {
        return h('div', { className: 'pmp-scroll' },
          h('div', { className: 'pmp-empty' },
            h('div', { style: { marginBottom: '10px', opacity: 0.6 } }, h(IconMemory, { size: 30 })),
            h('div', null, t('detail.empty')),
            h('div', { style: { marginTop: '4px', fontSize: '11.5px' } }, t('detail.emptyHint')),
          ),
        )
      }

      const chips = []
      if (doc.meta?.updated) chips.push(`${t('detail.updated')} ${doc.meta.updated}`)
      if (doc.meta?.source) chips.push(`${t('detail.source')} ${doc.meta.source}`)
      if (doc.diary) {
        chips.push(`${doc.diary.entries} ${t('meta.entries')}`)
        if (doc.diary.openTodos > 0) chips.push(`${doc.diary.openTodos} ${t('meta.todos')}`)
      }
      chips.push(`${fmtChars(doc.chars)} ${t('meta.chars')}`)
      chips.push(`${doc.lines} ${t('detail.lines')}`)

      return h('div', { className: 'pmp-scroll', ref: scrollRef },
        h('div', { className: 'pmp-doc pmp-fade' },
          typeof onBack === 'function'
            ? h('button', { type: 'button', className: 'pmp-btn ghost pmp-back', onClick: onBack }, `‹ ${t('act.back')}`)
            : null,
          h('div', { className: 'pmp-doc-h' },
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('div', { className: 'pmp-doc-t' }, doc.title || doc.file || docPath),
              h('div', { className: 'pmp-doc-path' }, docPath),
            ),
            h('div', { className: 'pmp-doc-actions' },
              typeof canHistoryBack === 'boolean' && canHistoryBack && typeof onHistoryBack === 'function'
                ? h('button', {
                  type: 'button',
                  className: 'pmp-btn ghost pmp-histback',
                  onClick: onHistoryBack,
                  title: t('act.histBack'),
                }, `↩ `, h('span', { className: 'pmp-hb-t' }, t('act.histBackShort')))
                : null,
              !editing && (typeof onPrev === 'function' || typeof onNext === 'function')
                ? h('span', { className: 'pmp-step' },
                  h('button', {
                    type: 'button',
                    className: 'pmp-btn ghost pmp-step-b',
                    disabled: !canPrev,
                    onClick: () => { if (canPrev && typeof onPrev === 'function') onPrev() },
                    title: t('act.prev'),
                  }, '‹'),
                  h('button', {
                    type: 'button',
                    className: 'pmp-btn ghost pmp-step-b',
                    disabled: !canNext,
                    onClick: () => { if (canNext && typeof onNext === 'function') onNext() },
                    title: t('act.next'),
                  }, '›'))
                : null,
              !editing && typeof onStar === 'function'
                ? h('button', {
                  type: 'button',
                  className: `pmp-star${starred ? ' on' : ''}`,
                  onClick: () => onStar(doc.path, !starred),
                  title: starred ? t('star.remove') : t('star.add'),
                  'aria-pressed': starred ? 'true' : 'false',
                }, h(IconStar, { size: 14, filled: starred === true }))
                : null,
              editing
                ? h('button', {
                  type: 'button',
                  className: 'pmp-btn primary sm',
                  disabled: saving,
                  onClick: () => void commitEdit(),
                  title: t('edit.hintKey'),
                }, saving ? h(Spinner) : t('act.save'))
                : h('button', {
                  type: 'button',
                  className: 'pmp-btn ghost sm',
                  onClick: beginEdit,
                  title: t('edit.hint'),
                }, h(IconEdit, { size: 13 }), t('act.edit')),
              editing
                ? h('button', {
                  type: 'button',
                  className: `pmp-btn ghost sm${discardArmed ? ' warn' : ''}`,
                  onClick: cancelEdit,
                }, discardArmed ? t('edit.discardArmed') : t('act.cancel'))
                : null,
            ),
          ),
          h('div', { className: 'pmp-chips' }, chips.map((label, index) => h('span', { className: 'pmp-chip', key: index }, label))),
          body.headings.length > 1 && !editing
            ? h('div', { className: 'pmp-toc' }, body.headings.map((item, index) => h('button', {
              type: 'button',
              key: index,
              className: 'pmp-toc-b',
              style: { paddingLeft: `${(item.level - 1) * 8 + 6}px` },
              onClick: () => jump(item.id),
            }, item.text)))
            : null,
          editing
            ? h('div', { className: 'pmp-edit' },
              h('textarea', {
                className: 'pmp-editor',
                ref: editorRef,
                value: draft,
                spellCheck: false,
                onChange: (e) => { setDraft(e.target.value); setDiscardArmed(false) },
                onKeyDown: (e) => {
                  if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 's') {
                    e.preventDefault()
                    void commitEdit()
                    return
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    cancelEdit()
                  }
                },
              }),
              h('div', { className: 'pmp-edit-hint' },
                dirty ? h('b', null, `${t('edit.dirty')} · ${t('edit.hintKey')}`) : h('span', null, t('edit.hintKey')),
              ),
            )
            : h('div', { className: 'pmp-md' }, body.nodes),
          editing
            ? null
            : relatedBusy
            ? h('div', { className: 'pmp-related' }, h('div', { className: 'pmp-related-h' }, t('related.title')), h('div', { className: 'pmp-empty', style: { padding: '10px 0' } }, h(Spinner)))
            : related.length > 0
              ? h('div', { className: 'pmp-related' },
                h('div', { className: 'pmp-related-h' }, `${t('related.title')} · ${related.length}`),
                related.map((hit) => h('button', {
                  type: 'button',
                  key: hit.path,
                  className: 'pmp-rel',
                  onClick: () => onOpen?.(hit.path),
                },
                  h('span', null, hit.title || hit.path),
                  h('small', null, `${hit.path}${hit.heading ? ` · ${hit.heading}` : ''}`),
                )),
              )
              : null,
        ),
      )
    }

    /* ------------------------------------------------------------------ *
     * 召回页
     * ------------------------------------------------------------------ */
    /**
     * 同一个意图的几种说法：措辞决定召回，所以要在同一屏里比。
     * 只做「几乎不改变意思」的机械变换，不猜同义词——猜错了比不猜更误导。
     */
    /**
     * 「四个旋钮一起看」：一次把阈值/预算/摘要的几档并排跑出来。
     * 单旋钮逐个试的问题是「改了这个，另一个的影响看不见」——
     * 但也不能全组合（8 档 × 4 档 × 3 档 = 96 次请求），只取「默认 + 每档单独动 + 全开」。
     */
    const SWEEP_COMBOS = [
      { key: 'base', trial: {}, label: '默认' },
      { key: 'th', trial: { threshold: 0.05 }, label: '阈值降到 0.05' },
      { key: 'bud', trial: { maxChars: 2400 }, label: '预算加到 2400' },
      { key: 'snip', trial: { excerptChars: 120 }, label: '摘要收到 120' },
      { key: 'all', trial: { threshold: 0.05, maxChars: 2400, excerptChars: 120 }, label: '三样一起放开' },
    ]

    function phraseVariants(q) {
      const text = String(q ?? '').trim()
      if (!text) return []
      const out = [{ key: 'orig', text }]
      const stripped = text
        .replace(/[？?！!。，,、；;：:]+$/g, '')
        .replace(/(怎么|如何|应该|是否|为什么|什么|哪些|一下|到底|究竟)/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (stripped && stripped !== text) out.push({ key: 'strip', text: stripped })
      // 「只留实词」：中文没有空格，只能按「疑问词 + 虚词」逐片段剜掉再压缩空白
      const focus = text
        .replace(/[^\p{Script=Han}A-Za-z0-9]+/gu, ' ')
        .replace(/(怎么|如何|是否|为什么|什么|哪些|一下|到底|究竟|的|了|呢|吧|吗|啊|呀|的话)/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (focus && focus.length >= 2) out.push({ key: 'focus', text: focus })
      // 「补上下文」：给语义检索一句「这是笔记里写过的东西」，措辞变了但意图没变
      const ctx = `我在笔记里写过：${text.replace(/[？?！!。]+$/g, '')}`
      out.push({ key: 'ctx', text: ctx })
      return out.filter((item, index) => out.findIndex((other) => other.text === item.text) === index).slice(0, 3)
    }

    function RecallTab(props) {
      const { t, status, api, onToast, onReload, onOpen, initialLogOpen, initialTest } = props
      const [query, setQuery] = useState('')
      // initialLogOpen 只给截图/深链接用：宿主不传就是全部收起
      const [openLog, setOpenLog] = useState(typeof initialLogOpen === 'number' ? initialLogOpen : -1)
      // initialTestMeta 只给冒烟/截图用：直接把一次召回的结果塞进来，省掉一次网络
      const seedMeta = props.initialTestMeta && Array.isArray(props.initialTestMeta.rows) ? props.initialTestMeta : null
      const [testHits, setTestHits] = useState(seedMeta ? (seedMeta.hits ?? seedMeta.rows.filter((row) => row.picked)) : null)
      const [testMeta, setTestMeta] = useState(seedMeta)
      const [showDropped, setShowDropped] = useState(props.initialShowDropped === true)
      const [testMs, setTestMs] = useState(Number(seedMeta?.ms) || 0)
      // 临时放宽：只对「这一次试一下」生效，不写配置。null = 用宿主默认
      const [trialThreshold, setTrialThreshold] = useState(null)
      const [trialBudget, setTrialBudget] = useState(null)
      const [trialExcerpt, setTrialExcerpt] = useState(null)
      const [snippetOpen, setSnippetOpen] = useState(props.initialSnippetOpen === true)
      // 「换个说法再试」：同一个意图的几种措辞并排比，看措辞怎么改变召回
      const [compare, setCompare] = useState(Array.isArray(props.initialCompare) ? props.initialCompare : null)
      const [sweep, setSweep] = useState(Array.isArray(props.initialSweep) ? props.initialSweep : null)
      const [history, setHistory] = useState(Array.isArray(props.initialExperiments) ? props.initialExperiments : null)
      const loadExperiments = async () => {
        if (!api) return
        try {
          const value = await api.experiments(12)
          setHistory(Array.isArray(value?.items) ? value.items : [])
        } catch { /* 实验记录是附属物，坏了不挡主流程 */ }
      }
      useEffect(() => {
        // 预览/深链接塞了初始值就别再拉一次（真拉回来会把合成的历史覆盖成空）
        if (Array.isArray(props.initialExperiments)) return
        if (api) void loadExperiments()
      }, [api])
      const [sweeping, setSweeping] = useState(false)
      const runSweep = async (base) => {
        const source = String(base ?? query ?? '').trim()
        if (!source || !api) return
        setSweeping(true)
        try {
          const rows = []
          for (const combo of SWEEP_COMBOS) {
            try {
              const value = await api.test(source, combo.trial)
              const picked = Array.isArray(value?.picked) ? value.picked : (value?.hits ?? [])
              const dropped = value?.dropped ?? {}
              rows.push({
                key: combo.key,
                trial: combo.trial,
                injected: picked.length,
                candidates: (value?.rows ?? []).length,
                low: Number(dropped.low) || 0,
                budget: Number(dropped.budget) || 0,
                top: Number(picked[0]?.score ?? 0),
                ms: Number(value?.ms) || 0,
              })
            } catch (err) {
              rows.push({ key: combo.key, trial: combo.trial, injected: 0, candidates: 0, low: 0, budget: 0, top: 0, ms: 0, error: String(err?.message ?? err) })
            }
          }
          setSweep(rows)
          void api.experiment({ kind: 'sweep', query: source, rows }).then(() => { void loadExperiments() }).catch(() => {})
        } finally {
          setSweeping(false)
        }
      }
      const [comparing, setComparing] = useState(false)
      const runCompare = async (base) => {
        const source = String(base ?? query ?? '').trim()
        const variants = phraseVariants(source)
        if (variants.length === 0 || !api) return
        setComparing(true)
        try {
          const rows = []
          for (const item of variants) {
            try {
              const value = await api.test(item.text, { threshold: trialThreshold, maxChars: trialBudget, excerptChars: trialExcerpt })
              // 返回体里 picked 是「注入了几篇」的计数，命中数组叫 hits（第一版把两者当同一个 → 注入数恒为 undefined）
              const picked = Array.isArray(value?.picked) ? value.picked : (value?.hits ?? [])
              rows.push({
                key: item.key,
                text: item.text,
                injected: picked.length,
                candidates: (value?.rows ?? []).length,
                top: Number(picked[0]?.score ?? 0),
                title: picked[0]?.title ?? '',
                path: picked[0]?.path ?? '',
              })
            } catch (err) {
              rows.push({ key: item.key, text: item.text, injected: 0, candidates: 0, top: 0, title: String(err?.message ?? err), path: '' })
            }
          }
          setCompare(rows)
          void api.experiment({ kind: 'compare', query: source, rows }).then(() => { void loadExperiments() }).catch(() => {})
        } finally {
          setComparing(false)
        }
      }
      // 面板自己的状态：能看见「我攒了什么」，也能单独清掉某一张表
      const [stateInfo, setStateInfo] = useState(props.initialStateInfo ?? null)
      const [stateOpen, setStateOpen] = useState(props.initialStateOpen === true)
      const [clearArmed, setClearArmed] = useState(null)
      const [busyClear, setBusyClear] = useState(false)
      const tableLabel = (name) => t(`recall.tbl.${name}`)
      const loadState = async () => {
        try {
          setStateInfo(await api.stateExport())
          setStateOpen(true)
        } catch (err) {
          onToast?.(String(err?.message ?? err), true)
        }
      }
      // 迁移是「读的时候就地做」的：只有下次写状态才会落盘，所以要给一个显式的「现在就写回去」
      const migrate = async () => {
        try {
          const value = await api.stateMigrate()
          setStateInfo((prev) => ({ ...(prev ?? {}), v: value.v, fileVersion: value.v, migration: { from: value.from, migrated: [], fixed: 0 }, counts: value.counts, state: value.state }))
          onToast?.(t('recall.stateMigrated').replace('{n}', String(value.fixed)))
          onReload?.()
        } catch (err) {
          onToast?.(String(err?.message ?? err), true)
        }
      }
      const migrationHint = (info) => {
        const fixed = Number(info?.migration?.fixed) || 0
        if (fixed <= 0) return null
        const parts = (info.migration.migrated ?? []).map((item) => `${tableLabel(item.table)} ${item.fixed}`).join(' · ')
        return h('div', { className: 'pmp-state-mig' },
          h('span', null, t('recall.stateMig').replace('{n}', String(fixed)).replace('{from}', `v${Number(info.migration.from) || 0}`) + (parts ? `（${parts}）` : '')),
          h('button', { type: 'button', className: 'pmp-chipb', onClick: () => { void migrate() } }, t('recall.stateMigNow')))
      }
      // 第一次点只是「举起手」，第二次才真的删——删除不该靠来不及看清的 toast 兜
      const clearTable = async (name) => {
        if (clearArmed !== name) { setClearArmed(name); return }
        setBusyClear(true)
        try {
          const value = await api.stateClear([name])
          setStateInfo((prev) => ({ ...(prev ?? {}), counts: value.counts, state: value.state }))
          setClearArmed(null)
          onToast?.(t('recall.stateCleared').replace('{k}', tableLabel(name)))
          onReload?.()
        } catch (err) {
          onToast?.(String(err?.message ?? err), true)
        } finally {
          setBusyClear(false)
        }
      }
      const [copied, setCopied] = useState(false)
      // chip 高亮要跟着「这次实际用的值」，否则截图/回看时看不出刚才放宽成什么了
      const shownThreshold = testMeta?.params?.trial ? testMeta.params.threshold : trialThreshold
      const shownBudget = testMeta?.params?.trial ? testMeta.params.maxChars : trialBudget
      const shownExcerpt = testMeta?.params?.trial ? testMeta.params.excerptChars : trialExcerpt
      const trialSnippet = (() => {
        const conf = status?.config ?? {}
        const lines = []
        // 只写和当前配置不同的项：全写会把默认值固化成显式配置，默认变了就不跟随了
        if (shownThreshold !== null && Number(shownThreshold) !== Number(conf.threshold)) lines.push(`threshold: ${Number(shownThreshold)}`)
        if (shownBudget !== null && Number(shownBudget) !== Number(conf.maxChars)) lines.push(`maxChars: ${Number(shownBudget)}`)
        if (shownExcerpt !== null && Number(shownExcerpt) !== Number(conf.excerptChars)) lines.push(`excerptChars: ${Number(shownExcerpt)}`)
        const file = status?.profileFile || '~/.dsh/profiles/<name>/cordis.patch.yml'
        if (lines.length === 0) return `# ${file}\n# 现在这组参数和配置一样，不用改`
        // 跟 profile 里现有写法保持一致：平铺列表追加一条
        return [`# ${file}（追加到列表末尾）`, '- id: personal-memory', '  name: dsh-personal-memory', '  config:', ...lines.map((line) => `    ${line}`)].join('\n')
      })()
      // 被挡掉的清单：手写 h() 嵌套太深容易错，拆成变量构造
      const dropBlock = (() => {
        if (!testMeta) return null
        const droppedRows = testMeta.rows.filter((row) => !row.picked)
        if (droppedRows.length === 0) return null
        const title = h('span', { className: 'pmp-proc-t' },
          h('span', { className: 'pmp-proc-ti' }, t('recall.dropTitle').replace('{n}', String(droppedRows.length))))
        const why = h('span', { className: 'pmp-proc-e' },
          t('recall.dropWhy')
            .replace('{low}', String(num(testMeta.dropped?.low)))
            .replace('{budget}', String(num(testMeta.dropped?.budget))))
        // 「再多给多少字才够」：给一个目标值，而不是让用户猜
        const need = testMeta.need && num(testMeta.need.rows) > 0 ? testMeta.need : null
        // 摘要旋钮的对比：收短比加预算更省，而且多进来的那几篇往往更有用
        const alt = testMeta.alt && num(testMeta.alt.picked) > num(testMeta.alt.current) ? testMeta.alt : null
        const altLine = alt
          ? h('span', { className: 'pmp-drop-need' },
            t('recall.altExcerpt')
              .replace('{chars}', String(num(alt.excerptChars)))
              .replace('{more}', String(num(alt.picked) - num(alt.current))),
            h('button', {
              type: 'button',
              className: 'pmp-chipb',
              onClick: () => {
                setTrialExcerpt(num(alt.excerptChars))
                void runTest(undefined, { threshold: trialThreshold, maxChars: trialBudget, excerptChars: num(alt.excerptChars) })
              },
            }, t('recall.needTry')))
          : null
        const needLine = need
          ? h('span', { className: 'pmp-drop-need' },
            t('recall.needBudget')
              .replace('{n}', String(num(need.rows)))
              .replace('{chars}', String(num(need.budgetChars))),
            h('button', {
              type: 'button',
              className: 'pmp-chipb',
              onClick: () => {
                setTrialBudget(num(need.budgetChars))
                void runTest(undefined, { threshold: trialThreshold, maxChars: num(need.budgetChars) })
              },
            }, t('recall.needTry')))
          : null
        const head = h('button', {
          type: 'button',
          className: `pmp-proc-row pmp-drop-h${showDropped ? ' on' : ''}`,
          onClick: () => setShowDropped((open) => !open),
        },
          h('span', { className: 'pmp-proc-m' }, showDropped ? '▾' : '▸'),
          h('span', { className: 'pmp-proc-b' }, title, why, needLine, altLine))
        if (!showDropped) return h('div', { className: 'pmp-drop' }, head)
        const rows = droppedRows.slice(0, 24).map((row, index2) => h('button', {
          key: `drop-${row.docId ?? index2}-${index2}`,
          type: 'button',
          className: 'pmp-proc-row pmp-drop-i',
          title: row.path || row.title,
          onClick: () => { if (row.path) onOpen(row.path) },
        },
          h('span', { className: 'pmp-proc-m' }, '·'),
          h('span', { className: 'pmp-proc-b' },
            h('span', { className: 'pmp-proc-t' },
              h('span', { className: 'pmp-proc-ti' }, row.title),
              row.drop === 'low' ? h('span', { className: 'pmp-badge mute' }, t('recall.dropLow')) : null,
              row.drop === 'budget' ? h('span', { className: 'pmp-badge mute' }, t('recall.dropBudget')) : null),
            h('span', { className: 'pmp-proc-path' }, row.path || '')),
          h('span', { className: 'pmp-score' }, Number(row.score ?? 0).toFixed(3))))
        return h('div', { className: 'pmp-drop' }, head, rows)
      })()
      const [testing, setTesting] = useState(false)
      const [testError, setTestError] = useState('')
      const [reindexing, setReindexing] = useState(false)

      const runTest = async (override, trialOverride) => {
        const text = (typeof override === 'string' ? override : query).trim()
        if (!text || testing) return
        setTesting(true)
        setTestError('')
        const trial = trialOverride ?? { threshold: trialThreshold, maxChars: trialBudget, excerptChars: trialExcerpt }
        try {
          const value = await api.test(text, trial)
          setTestHits(value.hits ?? [])
          setTestMeta(value)
          setTestMs(num(value.ms))
        } catch (err) {
          setTestHits([])
          setTestMeta(null)
          setTestError(String(err?.message ?? err))
        } finally {
          setTesting(false)
        }
      }

      // 预览/深链接用：进页面就按给定 query 试一次（真实宿主不传）
      const autoTested = useRef(false)
      useEffect(() => {
        if (autoTested.current) return
        if (typeof initialTest !== 'string' || initialTest.trim() === '') return
        autoTested.current = true
        setQuery(initialTest)
        void runTest(initialTest)
      }, [initialTest])

      const runReindex = async () => {
        if (reindexing) return
        setReindexing(true)
        try {
          await api.reindex()
          onToast(t('recall.reindexed'))
          await onReload(true)
        } catch (err) {
          onToast(String(err?.message ?? err), true)
        } finally {
          setReindexing(false)
        }
      }

      const cfg = status?.config ?? {}
      const counts = status?.counts ?? {}
      const index = status?.index ?? {}
      const stats = status?.stats ?? {}
      const recent = status?.recent ?? []
      // 命中率：近 7 天注入的每一篇里有多少后来被打开过。没有样本时 rate 是 null，不要显示 0%
      const usage = status?.usage ?? null

      const card = (label, value, note) => h('div', { className: 'pmp-card' },
        h('div', { className: 'pmp-card-k' }, label),
        h('div', { className: 'pmp-card-v' }, String(value)),
        note ? h('div', { className: 'pmp-card-x', title: String(note) }, String(note)) : null,
      )

      return h('div', { className: 'pmp-full' },
        h('div', { className: 'pmp-cards' },
          // 数字来自日汇总时标一下：日志被清过、明细看不到了，但累计还在
          card(t('recall.recalls'), num(stats.recalls), `${stats.lastAt ? fmtDate(stats.lastAt) : t('recall.none')}${stats.source === 'rollup' ? ` · ${t('recall.fromRollup')}` : ''}`),
          card(t('recall.hits'), num(stats.hits), `${t('meta.docs')} ${num(counts.personal) + num(counts.diaries)}`),
          // 有明细才算得出命中率；没有明细就只报次数，别用「—」把「召回过 20 次」也藏起来
          usage && usage.rate !== null
            ? card(t('recall.usage'), `${num(usage.used)} / ${num(usage.injected)}`,
              t('recall.usageNote').replace('{d}', String(usage.days)).replace('{p}', String(usage.rate)))
            : card(t('recall.usage'), '—',
              num(usage?.recalls) > 0
                ? t('recall.usageBlind').replace('{d}', String(usage?.days ?? 7)).replace('{n}', String(num(usage?.recalls)))
                : t('recall.usageEmpty').replace('{d}', String(usage?.days ?? 7))),
          card(t('recall.diaries'), num(counts.diaries), `${num(counts.memoryEntries)} ${t('meta.entries')}`),
          card(t('recall.todos'), num(counts.openTodos), t('recall.todosNote')),
          card(t('recall.index'), index.ready ? t('recall.ready') : t('recall.down'),
            index.bytes ? `${(num(index.bytes) / 1048576).toFixed(1)} MB` : (index.error || '—')),
        ),

        status?.workspace
          ? null
          : h('div', { className: 'pmp-err' }, t('recall.nows')),

        h('div', { className: 'pmp-sec' },
          h('div', { className: 'pmp-sec-h' },
            h('span', null, t('recall.try')),
            h('span', { className: 'pmp-spacer' }),
            h('button', {
              type: 'button',
              className: 'pmp-btn sm',
              disabled: reindexing,
              onClick: () => void runReindex(),
            }, reindexing ? h('span', null, h(Spinner), ' ', t('recall.reindexing')) : t('recall.reindex')),
          ),
          h('div', { style: { fontSize: '11.5px', color: C.muted, marginBottom: '8px' } }, t('recall.tryHint')),
          h('div', { style: { display: 'flex', gap: '8px' } },
            h('input', {
              className: 'pmp-input',
              value: query,
              placeholder: t('search.placeholder'),
              spellCheck: false,
              onChange: (e) => setQuery(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') void runTest() },
            }),
            h('button', {
              type: 'button',
              className: 'pmp-btn primary',
              disabled: testing || !query.trim(),
              onClick: () => void runTest(),
            }, testing ? h(Spinner) : t('recall.run')),
          ),
          // 阈值/预算放宽：判断「该不该调配置」要先看得见「放宽后会多进来哪几篇」
          h('div', { className: 'pmp-trial' },
            h('span', { className: 'pmp-trial-k' }, t('recall.trial')),
            h('span', { className: 'pmp-trial-k' }, t('recall.trialThreshold')),
            [[null, t('recall.trialBase')], [0.08, '0.08'], [0.05, '0.05'], [0, t('recall.trialAll')]].map(([value, label]) => h('button', {
              key: `th-${String(value)}`,
              type: 'button',
              className: `pmp-chipb${(shownThreshold ?? null) === value ? ' on' : ''}`,
              onClick: () => setTrialThreshold(value),
            }, label)),
            h('span', { className: 'pmp-trial-sep' }),
            h('span', { className: 'pmp-trial-k' }, t('recall.trialBudget')),
            [[null, t('recall.trialBase')], [2400, '2400'], [3200, '3200']].map(([value, label]) => h('button', {
              key: `bg-${String(value)}`,
              type: 'button',
              className: `pmp-chipb${(shownBudget ?? null) === value ? ' on' : ''}`,
              onClick: () => setTrialBudget(value),
            }, label)),
            h('span', { className: 'pmp-trial-sep' }),
            h('span', { className: 'pmp-trial-k' }, t('recall.trialExcerpt')),
            [[null, t('recall.trialBase')], [180, '180'], [120, '120']].map(([value, label]) => h('button', {
              key: `ex-${String(value)}`,
              type: 'button',
              className: `pmp-chipb${(shownExcerpt ?? null) === value ? ' on' : ''}`,
              onClick: () => setTrialExcerpt(value),
            }, label)),
          ),
          api
            ? h('div', { className: 'pmp-cmpbar' },
              h('button', {
                type: 'button',
                className: 'pmp-chipb',
                disabled: comparing || !String(query ?? '').trim(),
                onClick: () => { void runCompare() },
              }, comparing ? t('recall.cmpBusy') : t('recall.cmp')),
              h('span', { className: 'pmp-cmpbar-h' }, t('recall.cmpHint')))
            : null,
          api
            ? h('div', { className: 'pmp-cmpbar' },
              h('button', {
                type: 'button',
                className: 'pmp-chipb',
                disabled: sweeping || !String(query ?? '').trim(),
                onClick: () => { void runSweep() },
              }, sweeping ? t('recall.sweepBusy') : t('recall.sweep')),
              h('span', { className: 'pmp-cmpbar-h' }, t('recall.sweepHint')))
            : null,
          sweep && sweep.length > 0
            ? h('div', { className: 'pmp-cmp' },
              h('div', { className: 'pmp-cmp-h' }, t('recall.sweepTitle')),
              h('div', { className: 'pmp-cmp-row pmp-cmp-head' },
                h('span', { className: 'pmp-cmp-k' }, t('recall.sweepKnob')),
                h('span', { className: 'pmp-cmp-q' }, t('recall.sweepThrow')),
                h('span', { className: 'pmp-cmp-n' }, t('recall.sweepInjected')),
                h('span', { className: 'pmp-cmp-t' }, t('recall.sweepLow')),
                h('span', { className: 'pmp-cmp-t' }, t('recall.sweepBudget')),
                h('span', { className: 'pmp-cmp-t' }, t('recall.sweepTop'))),
              sweep.map((row) => h('button', {
                key: row.key,
                type: 'button',
                className: `pmp-cmp-row${row.injected > 0 ? ' on' : ''}`,
                title: t('recall.sweepApply'),
                onClick: () => {
                  setTrialThreshold(row.trial?.threshold ?? null)
                  setTrialBudget(row.trial?.maxChars ?? null)
                  setTrialExcerpt(row.trial?.excerptChars ?? null)
                  void runTest(undefined, row.trial ?? {})
                },
              },
              h('span', { className: 'pmp-cmp-k' }, t(`recall.sweep.${row.key}`)),
              h('span', { className: 'pmp-cmp-q' }, SWEEP_COMBOS.find((c) => c.key === row.key)?.label ?? ''),
              h('span', { className: 'pmp-cmp-n' }, `${row.injected} / ${row.candidates}`),
              h('span', { className: 'pmp-cmp-t' }, String(row.low)),
              h('span', { className: 'pmp-cmp-t' }, String(row.budget)),
              h('span', { className: 'pmp-cmp-t' }, row.top > 0 ? row.top.toFixed(2) : '—'))))
            : null,
          history && history.length > 0
            ? h('div', { className: 'pmp-exp' },
              h('div', { className: 'pmp-exp-h' }, t('recall.expTitle')),
              h('div', { className: 'pmp-exp-list' },
                history.slice(0, 6).map((item) => {
                  const best = (item.rows ?? []).reduce((max, row) => Math.max(max, Number(row.injected) || 0), 0)
                  return h('button', {
                    key: `${item.at}:${item.kind}`,
                    type: 'button',
                    className: 'pmp-exp-row',
                    title: t('recall.expReplay'),
                    onClick: () => {
                      setQuery(item.query)
                      if (item.kind === 'sweep') setSweep(item.rows)
                      else setCompare(item.rows)
                    },
                  },
                  h('span', { className: 'pmp-exp-k' }, item.kind === 'sweep' ? t('recall.expSweep') : t('recall.expCompare')),
                  h('span', { className: 'pmp-exp-q' }, item.query),
                  h('span', { className: 'pmp-exp-n' }, t('recall.expBest').replace('{n}', String(best))),
                  h('span', { className: 'pmp-exp-t' }, String(item.at ?? '').slice(5, 16).replace('T', ' ')))
                })))
            : null,
          compare && compare.length > 0
            ? h('div', { className: 'pmp-cmp' },
              h('div', { className: 'pmp-cmp-h' }, t('recall.cmpTitle')),
              compare.map((row) => h('button', {
                key: row.key,
                type: 'button',
                className: `pmp-cmp-row${row.injected > 0 ? ' on' : ''}`,
                title: t('recall.cmpOpen'),
                onClick: () => { setQuery(row.text); void runTest(row.text) },
              },
              h('span', { className: 'pmp-cmp-k' }, t(`recall.cmp.${row.key}`)),
              h('span', { className: 'pmp-cmp-q' }, row.text),
              h('span', { className: 'pmp-cmp-n' }, `${row.injected} / ${row.candidates}`),
              h('span', { className: 'pmp-cmp-t' }, row.top > 0 ? row.top.toFixed(2) : '—'),
              h('span', { className: 'pmp-cmp-w' }, row.title || t('recall.cmpNone')))))
            : null,
          trialThreshold !== null || trialBudget !== null || trialExcerpt !== null || props.initialTrialHint === true
            ? h('div', { className: 'pmp-trial-hint' },
              h('span', null, t('recall.trialHint')),
              h('button', {
                type: 'button',
                className: 'pmp-chipb',
                onClick: () => setSnippetOpen((open) => !open),
              }, snippetOpen ? t('recall.snippetHide') : t('recall.snippet')))
            : null,
          // 试出来的参数要能带走：直接改 profile 配置有风险（App 正在跑、可能静默失效），
          // 所以给一段可直接粘贴的 YAML + 目标文件路径，人自己决定什么时候落。
          snippetOpen
            ? h('div', { className: 'pmp-snippet' },
              h('div', { className: 'pmp-snippet-h' }, t('recall.snippetWhere')),
              h('pre', { className: 'pmp-snippet-c' }, trialSnippet),
              h('div', { className: 'pmp-snippet-a' },
                h('button', {
                  type: 'button',
                  className: 'pmp-btn sm',
                  onClick: () => {
                    const text = trialSnippet
                    const clip = typeof navigator !== 'undefined' ? navigator?.clipboard : null
                    if (clip && typeof clip.writeText === 'function') {
                      void clip.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) }).catch(() => {})
                    }
                  },
                }, copied ? t('recall.snippetCopied') : t('recall.snippetCopy')),
                h('span', { className: 'pmp-snippet-n' }, t('recall.snippetNote'))))
            : null,
          testError ? h('div', { className: 'pmp-err' }, testError) : null,
          testHits === null
            ? null
            : testMeta === null
              ? null
              : h('div', { className: 'pmp-proc' },
                h('div', { className: 'pmp-proc-h' },
                  h('span', { className: 'pmp-proc-k' }, t('recall.proc')),
                  h('span', { className: 'pmp-proc-p' },
                    t('recall.params')
                      .replace('{mode}', String(testMeta.mode ?? 'vector'))
                      .replace('{k}', String(num(testMeta.params?.fetchK)))
                      .replace('{th}', String(num(testMeta.params?.threshold)))
                      .replace('{chars}', String(num(testMeta.params?.maxChars)))),
                  h('span', { className: 'pmp-spacer' }),
                  h('span', { className: 'pmp-proc-c' },
                    t('recall.candLine')
                      .replace('{n}', String(num(testMeta.candidates)))
                      .replace('{p}', String(num(testMeta.picked)))
                      .replace('{low}', String(num(testMeta.dropped?.low)))
                      .replace('{budget}', String(num(testMeta.dropped?.budget)))
                      .replace('{ms}', String(testMs))),
                ),
                testMeta.rows.length === 0
                  ? h('div', { className: 'pmp-empty' }, t('search.none'))
                  : testMeta.rows.filter((row) => row.picked).slice(0, 24).map((row, index2) => h('button', {
                    key: `${row.docId ?? index2}-${index2}`,
                    type: 'button',
                    className: `pmp-proc-row${row.picked ? ' on' : ''}`,
                    title: row.path || row.title,
                    onClick: () => { if (row.path) onOpen(row.path) },
                  },
                    h('span', { className: 'pmp-proc-m' }, row.picked ? '✓' : '·'),
                    h('span', { className: 'pmp-proc-b' },
                      h('span', { className: 'pmp-proc-t' },
                        h('span', { className: 'pmp-proc-ti' }, row.title),
                        row.via === 'keyword' || row.literal
                          ? h('span', { className: 'pmp-badge mute' }, t('search.viaKeyword'))
                          : null,
                        row.drop === 'low' ? h('span', { className: 'pmp-badge mute' }, t('recall.dropLow')) : null,
                        row.drop === 'budget' ? h('span', { className: 'pmp-badge mute' }, t('recall.dropBudget')) : null,
                        row.picked ? h('span', { className: 'pmp-badge' }, t('recall.picked')) : null,
                      ),
                      h('span', { className: 'pmp-proc-path' }, row.path || ''),
                      h('span', { className: 'pmp-proc-e' }, row.excerpt ?? ''),
                    ),
                    h('span', { className: 'pmp-score' }, Number(row.score ?? 0).toFixed(3)),
                  )),
              ),
          // 被挡掉的也要看得见：只显示注入了什么，人会以为「没召回」=「没有」。
          // 而且「记忆偏保守」这件事必须能量出来——阈值挡掉几篇、预算挡掉几篇。
          dropBlock,
        ),

        h('div', { className: 'pmp-sec' },
          h('div', { className: 'pmp-sec-h' }, h('span', null, t('recall.recent'))),
          recent.length === 0
            ? h('div', { className: 'pmp-empty' },
              t('recall.none'),
              // 面板说「还没有记录」容易被读成「记忆没工作过」，把日志的实际情况写出来
              status?.logLines
                ? h('div', { className: 'pmp-snippet-n', style: { marginTop: '6px' } },
                  t('recall.noneWhy')
                    .replace('{n}', String(num(status.logLines)))
                    .replace('{since}', String(status.logSince ?? '—').slice(0, 16).replace('T', ' ')))
                : null)
            : h('div', null, recent.slice(0, 20).map((row, index2) => {
              const items = Array.isArray(row.items) ? row.items.filter((item) => item && item.path) : []
              const open = openLog === index2
              const head = h('button', {
                type: 'button',
                className: `pmp-log-h${open ? ' on' : ''}`,
                disabled: items.length === 0,
                onClick: () => setOpenLog(open ? -1 : index2),
              },
                h('span', { className: 'pmp-log-t' }, row.at ? `${fmtDate(row.at)} ${fmtClock(row.at)}` : '—'),
                h('span', { className: 'pmp-log-q' }, row.error ? `⚠ ${row.error}` : (row.query ?? '')),
                h('span', { className: 'pmp-log-n' }, `${row.hits ?? 0} ${t('recall.hitUnit')}`),
                Number(row.usedCount) > 0
                  ? h('span', { className: 'pmp-badge', title: t('recall.usedHint') }, `${t('recall.used')} ${row.usedCount}`)
                  : null,
                items.length > 0 ? h('span', { className: 'pmp-log-x' }, open ? '▾' : '▸') : null,
              )
              return h('div', { className: 'pmp-log', key: index2 },
                head,
                open && items.length > 0
                  ? h('div', { className: 'pmp-log-i' },
                  // 这一轮实际注入了多少字、有没有把某篇截掉：密度才是「记忆有没有挤占上下文」的答案
                  Number.isFinite(Number(row.budget)) && Number(row.budget) > 0
                    ? h('div', { className: 'pmp-log-b' },
                      `${t('recall.logBudget')} ${Number(row.used) || 0} / ${Number(row.budget)} ${t('recall.logChars')}`,
                      h('span', { className: 'pmp-log-bbar' },
                        h('i', { style: { width: `${Math.max(2, Math.min(100, ((Number(row.used) || 0) / Number(row.budget)) * 100))}%` } })),
                    )
                    : null,
                  items.map((item, index3) => h('button', {
                    type: 'button',
                    key: `${item.path}-${index3}`,
                    className: 'pmp-log-p',
                    onClick: () => onOpen(item.path),
                    title: item.path,
                  },
                    h('span', { className: 'pmp-log-pi' }, item.used === true ? `\u2713 ${item.title || item.path}` : (item.title || item.path)),
                    // 来源：这篇是被语义撞上的，还是我真的写过这几个字（老日志没有 via，就不显示）
                    item.via === 'keyword' || item.via === 'both'
                      ? h('span', { className: `pmp-badge${item.via === 'both' ? '' : ' mute'}`, title: t('recall.viaHint') },
                        t(item.via === 'both' ? 'recall.viaBoth' : 'recall.viaKeyword'))
                      : null,
                    Number(item.chars) > 0
                      ? h('span', { className: 'pmp-log-pc' },
                        `${item.chars} ${t('recall.logChars')}`,
                        item.truncated === true ? h('span', { className: 'pmp-badge mute' }, t('recall.truncated')) : null)
                      : null,
                    h('span', { className: 'pmp-log-ps' }, Number(item.score ?? 0).toFixed(3)),
                  )))
                  : null,
              )
            })),
        ),

        h('div', { className: 'pmp-sec' },
          h('div', { className: 'pmp-sec-h' },
            h('span', null, t('recall.stateTitle')),
            h('button', {
              type: 'button',
              className: 'pmp-chipb',
              onClick: () => { void loadState() },
            }, stateOpen ? t('recall.stateReload') : t('recall.stateOpen'))),
          h('div', { className: 'pmp-state' },
            h('div', { className: 'pmp-state-n' }, t('recall.stateHint')),
            stateInfo ? migrationHint(stateInfo) : null,
            stateInfo
              ? [
                h('div', { className: 'pmp-state-grid' }, stateInfo.tables.map((name) => h('div', { className: 'pmp-state-c', key: name },
                  h('div', { className: 'pmp-state-k' }, tableLabel(name)),
                  h('div', { className: 'pmp-state-v' }, String(Number(stateInfo.counts?.[name]) || 0)),
                  h('button', {
                    type: 'button',
                    className: `pmp-chipb${clearArmed === name ? ' on' : ''}`,
                    disabled: busyClear || Number(stateInfo.counts?.[name]) === 0,
                    title: clearArmed === name ? t('recall.stateClearNow') : t('recall.stateClearHint'),
                    onClick: () => { void clearTable(name) },
                  }, clearArmed === name ? t('recall.stateClearNow') : t('recall.stateClear'))))),
                h('div', { className: 'pmp-state-f' },
                  h('span', null, `${stateInfo.path} · ${stateInfo.bytes} B${stateInfo.modified ? ` · ${stateInfo.modified.slice(0, 19).replace('T', ' ')}` : ''}`),
                  Number.isFinite(Number(stateInfo.v))
                    ? h('span', { className: 'pmp-state-vs' }, ` · v${stateInfo.v}${Number(stateInfo.fileVersion) === Number(stateInfo.v) ? '' : `（文件里是 v${Number(stateInfo.fileVersion) || 0}，读的时候已就地迁移）`}`)
                    : null),
                stateOpen
                  ? h('pre', { className: 'pmp-snippet-c' }, JSON.stringify(stateInfo.state, null, 2))
                  : null,
              ]
              : h('div', { className: 'pmp-state-n' }, t('recall.stateEmpty'))),
        ),

        h('div', { className: 'pmp-sec' },
          h('div', { className: 'pmp-sec-h' }, h('span', null, t('recall.config'))),
          h('div', null,
            [
              [t('recall.ws'), status?.workspace || t('recall.nows')],
              ['enabled', String(cfg.enabled)],
              ['topK', String(cfg.topK)],
              ['threshold', String(cfg.threshold)],
              ['maxChars', String(cfg.maxChars)],
              ['minQueryChars', String(cfg.minQueryChars)],
              ['timeoutMs', `${cfg.timeoutMs} ms`],
              ['quickNote', String(cfg.quickNote)],
              ['ctx-server', status?.ctxServer || 'http://127.0.0.1:17878'],
              [t('recall.log'), status?.logPath || '—'],
            ].map(([k, v]) => h('div', { className: 'pmp-row', key: k },
              h('span', { className: 'k' }, k),
              h('span', { className: 'v' }, String(v)),
            )),
          ),
        ),
      )
    }

    /* ------------------------------------------------------------------ *
     * 速记弹窗：只追加到当天日记
     * ------------------------------------------------------------------ */
    function NoteModal(props) {
      const { t, api, onClose, onDone, toast } = props
      const [text, setText] = useState('')
      const [section, setSection] = useState('产出')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const areaRef = useRef(null)

      useEffect(() => {
        if (areaRef.current && typeof areaRef.current.focus === 'function') areaRef.current.focus()
        const onKey = (event) => { if (event.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])

      const submit = async () => {
        const body = text.trim()
        if (!body || busy) return
        setBusy(true)
        setError('')
        try {
          const value = await api.note({ text: body, section })
          onDone(value)
        } catch (err) {
          setError(String(err?.message ?? err))
          toast(String(err?.message ?? err), true)
        } finally {
          setBusy(false)
        }
      }

      return h('div', { className: 'pmp-mask', onMouseDown: (e) => { if (e.target === e.currentTarget) onClose() } },
        h('div', { className: 'pmp-modal pmp-fade' },
          h('div', { className: 'pmp-modal-h' }, t('note.title')),
          h('div', { className: 'pmp-modal-hint' }, t('note.hint')),
          h('textarea', {
            ref: areaRef,
            className: 'pmp-ta',
            value: text,
            placeholder: t('note.placeholder'),
            onChange: (e) => setText(e.target.value),
            onKeyDown: (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit() },
          }),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '10px', flexWrap: 'wrap' } },
            h('span', { style: { fontSize: '11.5px', color: C.muted } }, t('note.section')),
            SECTIONS.map((name) => h('button', {
              type: 'button',
              key: name,
              className: `pmp-chipb${section === name ? ' on' : ''}`,
              onClick: () => setSection(name),
            }, t(`note.sec.${name.toLowerCase()}`))),
          ),
          error ? h('div', { className: 'pmp-err' }, error) : null,
          h('div', { className: 'pmp-modal-f' },
            h('span', { style: { fontSize: '11px', color: C.muted } }, t('note.hintKey')),
            h('span', { className: 'pmp-spacer' }),
            h('button', { type: 'button', className: 'pmp-btn ghost', onClick: onClose }, t('act.cancel')),
            h('button', {
              type: 'button',
              className: 'pmp-btn primary',
              disabled: busy || !text.trim(),
              onClick: () => void submit(),
            }, busy ? h(Spinner) : t('note.submit')),
          ),
        ),
      )
    }

    const SECTIONS = ['产出', '判断', '未完成', '备忘']

    /* ------------------------------------------------------------------ *
     * 新建笔记：标题 + 目录（只建 personal/，日记走速记）
     * ------------------------------------------------------------------ */
    function NewNoteModal(props) {
      const { t, api, dirs, onClose, onDone, toast } = props
      const [title, setTitle] = useState('')
      const [dir, setDir] = useState(props.defaultDir ?? 'personal')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const inputRef = useRef(null)

      useEffect(() => {
        if (inputRef.current && typeof inputRef.current.focus === 'function') inputRef.current.focus()
        const onKey = (event) => { if (event.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])

      const submit = async () => {
        const name = title.trim()
        if (!name || busy) return
        setBusy(true)
        setError('')
        try {
          const value = await api.create({ scope: 'personal', dir, title: name })
          onDone(value)
        } catch (err) {
          setError(String(err?.message ?? err))
          toast(String(err?.message ?? err), true)
        } finally {
          setBusy(false)
        }
      }

      const options = dirs && dirs.length > 0 ? dirs : ['personal']

      return h('div', { className: 'pmp-mask', onMouseDown: (e) => { if (e.target === e.currentTarget) onClose() } },
        h('div', { className: 'pmp-modal pmp-fade' },
          h('div', { className: 'pmp-modal-h' }, t('new.title')),
          h('div', { className: 'pmp-modal-hint' }, t('new.hint')),
          h('div', { className: 'pmp-form' },
            h('div', { className: 'pmp-field' },
              h('label', null, t('new.name')),
              h('input', {
                ref: inputRef,
                className: 'pmp-input',
                value: title,
                placeholder: t('new.placeholder'),
                spellCheck: false,
                onChange: (e) => setTitle(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') void submit() },
              }),
            ),
            h('div', { className: 'pmp-field' },
              h('label', null, t('new.dir')),
              h('select', {
                className: 'pmp-input',
                value: dir,
                onChange: (e) => setDir(e.target.value),
              }, options.map((name) => h('option', { key: name, value: name }, name))),
            ),
            h('div', { className: 'pmp-modal-hint' }, t('new.pathHint').replace('{dir}', dir)),
          ),
          error ? h('div', { className: 'pmp-err' }, error) : null,
          h('div', { className: 'pmp-modal-f' },
            h('span', { className: 'pmp-spacer' }),
            h('button', { type: 'button', className: 'pmp-btn ghost', onClick: onClose }, t('act.cancel')),
            h('button', {
              type: 'button',
              className: 'pmp-btn primary',
              disabled: busy || !title.trim(),
              onClick: () => void submit(),
            }, busy ? h(Spinner) : t('new.submit')),
          ),
        ),
      )
    }

    /* ------------------------------------------------------------------ *
     * 设置页分区（只读概览）
     * ------------------------------------------------------------------ */
    function SettingsSection(props) {
      const { api, t } = props
      const [status, setStatus] = useState(null)
      const [error, setError] = useState('')

      useEffect(() => {
        let alive = true
        api.status().then((value) => { if (alive) setStatus(value) }).catch((err) => { if (alive) setError(String(err?.message ?? err)) })
        return () => { alive = false }
      }, [api])

      const counts = status?.counts ?? {}
      const index = status?.index ?? {}
      return h('div', { style: { padding: '4px 0' } },
        h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, t('settings.title')),
        h('p', { style: { fontSize: '11.5px', color: C.muted, lineHeight: 1.6, margin: '0 0 10px' } }, t('settings.hint')),
        error ? h('div', { className: 'pmp-err' }, error) : null,
        h('div', null,
          [
            [t('recall.ws'), status?.workspace || '—'],
            [t('meta.docs'), `${num(counts.personal)} personal / ${num(counts.diaries)} memory`],
            [t('meta.entries'), `${num(counts.memoryEntries)} ${t('meta.entries')} · ${num(counts.openTodos)} ${t('meta.todos')}`],
            [t('recall.index'), index.ready ? t('recall.ready') : t('recall.down')],
          ].map(([k, v]) => h('div', { className: 'pmp-row', key: k },
            h('span', { className: 'k' }, k),
            h('span', { className: 'v' }, String(v)),
          )),
        ),
      )
    }

    /* ------------------------------------------------------------------ *
     * 整页面板
     * ------------------------------------------------------------------ */
    function App(props) {
      const { t } = props
      // props.api 只给离线预览/测试注入用；真实宿主不传，就是真路由
      const api = useRef(props.api ?? new Api()).current
      const narrow = useNarrow()

      // initialTab / initialPath 只给离线预览与将来的深链接用；宿主不传就是默认「个人记忆」
      const [tab, setTab] = useState(props.initialTab ?? 'today')
      const [status, setStatus] = useState(null)
      const [docs, setDocs] = useState([])
      const [treeWarning, setTreeWarning] = useState('')
      const [timeline, setTimeline] = useState(null)
      const [booting, setBooting] = useState(true)
      const [refreshing, setRefreshing] = useState(false)
      const [loadError, setLoadError] = useState('')

      const [selected, setSelected] = useState(props.initialPath ?? null)
      // 从检索结果跳进来时，要落在命中的那一节，而不是文首
      const [anchor, setAnchor] = useState(null)
      const [doc, setDoc] = useState(null)
      const [docLoading, setDocLoading] = useState(false)
      const [docError, setDocError] = useState('')

      const [stars, setStars] = useState([])
      const [recentQueries, setRecentQueries] = useState([])
      // 折叠偏好跟工作区走（.dsh/personal-memory/state.json），刷新页面不会又全展开
      const [collapsed, setCollapsed] = useState({})
      // 预览/深链接可以指定初始排序；真实宿主不传，就走 state.json 里记住的那个
      const [todoSort, setTodoSortState] = useState(props.initialTodoSort === 'oldest' ? 'oldest' : 'fresh')
      const [noteOpen, setNoteOpen] = useState(false)
      const [quickOpen, setQuickOpen] = useState(props.initialQuickQuery ? true : false)
      // 「最近看过」：⌘K 里排在页签之后、全部笔记之前
      const [recentVisited, setRecentVisited] = useState(props.initialRecent ?? null)
      // 体检结果：笔记库有没有烂掉（缺 更新/来源、孤儿、死链）。
      // 平时它该只是「通过」三个字；坏了才值得占位置。
      const [audit, setAudit] = useState(props.initialAudit ?? null)
      // 检索排序：偏好跟工作区走（state.ui.searchSort），刷新后仍是上次那种看法
      const [searchSort, setSearchSortState] = useState(props.initialSearchSort === 'recent' ? 'recent' : 'score')
      const setSearchSort = useCallback((next) => {
        const value = next === 'recent' ? 'recent' : 'score'
        setSearchSortState(value)
        void api.ui({ searchSort: value }).catch(() => {})
      }, [api])
      const [newOpen, setNewOpen] = useState(false)
      // 「该去哪补」要能一键开始：线索说「还没人写过」就直接开新建并预填目录；
      // 说「想确认/想找回原话」就带着那句话去检索页。少一次手抄，就多一次真的去补。
      const [newNoteDir, setNewNoteDir] = useState('')
      const [seedQuery, setSeedQuery] = useState(null)
      const [editSignal, setEditSignal] = useState(0)
      // 点「下一步」时要把光标落在那句话上：先记句子，再进编辑态
      const [editAt, setEditAt] = useState('')
      // 阅读路径栈：从左栏一路点进去，Alt+← 能一路退回来。只记路径，不记滚动位置
      // 预览/深链接可以把「已经读过哪几篇」直接塞进来，真实宿主不传
      const backStack = useRef(Array.isArray(props.initialHistory) ? [...props.initialHistory].slice(-20) : [])
      const [backDepth, setBackDepth] = useState(backStack.current.length)
      // openDoc 里要读到「当前是哪一篇」，但 useCallback 的依赖不能塞 selected（会每次重建），所以用 ref
      const selectedRef = useRef(props.initialPath ?? null)
      // 键位监听要早于 goBack 定义（effect 在上面），所以走 ref 间接调用
      const goBackRef = useRef(null)
      useEffect(() => { selectedRef.current = selected }, [selected])
      const [toast, setToast] = useState(null)
      const toastTimer = useRef(null)

      // 「在等什么」：等外部的事和能推进的事混在一张表里，人会一直翻同一批条目
      const [waits, setWaits] = useState({})
      // 「变成行动」时写下的下一步：跟着正文摘要走，和 ⌛ 同一把钥匙
      const [nexts, setNexts] = useState({})

      const showToast = useCallback((text, bad, action) => {
        setToast({ text, bad: bad === true, action: action ?? null })
        if (toastTimer.current) clearTimeout(toastTimer.current)
        // 带动作的提示多留一会儿：勾错了要来得及点撤销
        toastTimer.current = setTimeout(() => setToast(null), action ? 6000 : 3200)
      }, [])
      useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current) }, [])

      // 键盘 [ / ] 走相邻笔记：effect 在 stepDoc 之前，直接引用依赖会 TDZ，所以走 ref
      const stepRef = useRef(null)

      // ⌘K / Ctrl+K：面板里任何地方都能唤出跳转
      useEffect(() => {
        if (typeof window.addEventListener !== 'function') return undefined
        const onKeyDown = (event) => {
          // Alt+←：退回上一处阅读位置（浏览器里 Alt+← 是后退，面板里借同一个手势）
          if (event.altKey && (event.key === 'ArrowLeft' || event.key === '←')) {
            if (backStack.current.length === 0) return
            event.preventDefault()
            if (goBackRef.current) goBackRef.current()
            return
          }
          // [ / ]：在当前列表里往前走/往后走（在输入框里打字时不劫持）
          if (!event.metaKey && !event.ctrlKey && !event.altKey && (event.key === '[' || event.key === ']')) {
            const tag = String(event.target?.tagName ?? '').toUpperCase()
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
            if (stepRef.current) stepRef.current(event.key === ']' ? 1 : -1)
            return
          }
          if (!(event.metaKey || event.ctrlKey)) return
          if (String(event.key).toLowerCase() !== 'k') return
          event.preventDefault()
          setQuickOpen((open) => !open)
        }
        window.addEventListener('keydown', onKeyDown)
        return () => { if (typeof window.removeEventListener === 'function') window.removeEventListener('keydown', onKeyDown) }
      }, [])

      const reload = useCallback(async (refresh) => {
        if (refresh) setRefreshing(true)
        try {
          const [nextStatus, nextTree, nextTimeline, nextState, nextAudit] = await Promise.all([
            api.status().catch(() => null),
            api.tree(refresh !== false).catch((err) => ({ docs: [], warning: String(err?.message ?? err) })),
            api.timeline(refresh !== false).catch(() => null),
            api.state().catch(() => null),
            typeof api.audit === 'function' ? api.audit('personal').catch(() => null) : Promise.resolve(null),
          ])
          if (nextStatus) setStatus(nextStatus)
          // 预览/深链接给了体检结果就别被 reload 的实测结果覆盖（否则截图永远是「通过」）
          if (nextAudit && !props.initialAudit) setAudit(nextAudit)
          if (nextState) {
            setStars(Array.isArray(nextState.stars) ? nextState.stars : [])
            setRecentQueries(Array.isArray(nextState.queries) ? nextState.queries : [])
            setWaits(nextState.wait && typeof nextState.wait === 'object' ? nextState.wait : {})
            setNexts(nextState.next && typeof nextState.next === 'object' ? nextState.next : {})
            setCollapsed(nextState.ui?.collapsed && typeof nextState.ui.collapsed === 'object' ? nextState.ui.collapsed : {})
            if (nextState.ui?.searchSort === 'recent' || nextState.ui?.searchSort === 'score') setSearchSortState(nextState.ui.searchSort)
            // 预览/深链接显式指定过排序时，别让 state.json 把它盖掉
            if (props.initialTodoSort !== 'oldest' && props.initialTodoSort !== 'fresh') {
              setTodoSortState(nextState.ui?.todoSort === 'oldest' ? 'oldest' : 'fresh')
            }
          }
          setDocs(nextTree?.docs ?? [])
          if (!Array.isArray(props.initialRecent) && typeof api.visited === 'function') {
            api.visited(6).then((value) => setRecentVisited(Array.isArray(value?.items) ? value.items : [])).catch(() => {})
          }
          setTreeWarning(nextTree?.warning ?? '')
          // timelineOverride 只给离线预览用：真实宿主不传，就是磁盘上的时间线
          setTimeline(props.timelineOverride ?? nextTimeline)
          setLoadError(nextTree?.warning && (nextTree?.docs ?? []).length === 0 ? nextTree.warning : '')
        } finally {
          setBooting(false)
          setRefreshing(false)
        }
      }, [api])

      useEffect(() => { void reload(false) }, [reload])

      const openDoc = useCallback(async (path, opts) => {
        if (!path) return
        // 换文档才记一步；同一篇重复打开不算新的一步
        if (opts?.push !== false && path !== selectedRef.current) {
          const prev = selectedRef.current
          if (prev) {
            backStack.current = [...backStack.current, prev].slice(-20)
            setBackDepth(backStack.current.length)
          }
        }
        // 停留时长：切换文档时把上一篇的「停了多久」补报一次——点一下就走的和看了两分钟的，不该一样
        const prevPath = readingRef.current.path
        if (prevPath && prevPath !== path) {
          const dwell = Date.now() - readingRef.current.at
          if (dwell >= 1500) void api.used(prevPath, dwell).catch(() => {})
        }
        readingRef.current = { path, at: Date.now() }
        setSelected(path)
        setDoc(null)
        setDocError('')
        setDocLoading(true)
        try {
          const value = await api.doc(path)
          setDoc(value)
          // 打点：这篇被打开了。失败不影响阅读，也不提示用户
          if (!usedSeen.current.has(path)) {
            usedSeen.current.add(path)
            void api.used(path).catch(() => {})
          }
        } catch (err) {
          setDocError(String(err?.message ?? err))
        } finally {
          setDocLoading(false)
        }
      }, [api])

      const onNoted = useCallback(async (value) => {
        setNoteOpen(false)
        showToast(t('note.ok').replace('{path}', value?.path ?? ''))
        await reload(true)
        if (value?.path) void openDoc(value.path)
      }, [openDoc, reload, showToast, t])

      // 新建完直接进编辑：刚生成的骨架只有标题和两行元信息，正是要往下写的时候。
      const onCreated = useCallback(async (value) => {
        setNewOpen(false)
        showToast(t('new.created'))
        await reload(true)
        if (value?.path) {
          void openDoc(value.path)
          setEditSignal((n) => n + 1)
        }
      }, [openDoc, reload, showToast, t])

      // 保存：成功就刷新索引缓存；hash 对不上说明磁盘被别处改过，重读这篇再让用户决定。
      // 星标：只是「常用的几篇」，不改笔记内容，落在工作区 .dsh 里
      /** 折叠/展开一个分组：本地立刻生效，落盘失败也不回滚（这是偏好，不是数据） */
      // 排序偏好跟工作区走：换成「最久没动的在前」之后，刷新页面还是这个顺序
      const setTodoSort = useCallback((next) => {
        const value = next === 'oldest' ? 'oldest' : 'fresh'
        setTodoSortState(value)
        void api.ui({ todoSort: value }).catch(() => {})
      }, [api])

      const toggleCollapse = useCallback((key) => {
        setCollapsed((prev) => {
          const next = { ...prev, [key]: prev[key] !== true }
          void api.ui({ collapsed: { [key]: next[key] } }).catch(() => {})
          return next
        })
      }, [api])

      // 「在等什么」循环：没标 → 等行情 → 等人回 → 等自己决定 → 清除
      const setWait = useCallback(async ({ text, kind, next }) => {
        const key = waitKeyOf(text)
        if (!key) return
        setWaits((prev) => {
          const nextWaits = { ...prev }
          if (kind) nextWaits[key] = kind
          else delete nextWaits[key]
          return nextWaits
        })
        if (typeof next === 'string') {
          const clean = next.replace(/\s+/g, ' ').trim()
          setNexts((prev) => {
            const nextMap = { ...prev }
            if (clean) nextMap[key] = clean
            else delete nextMap[key]
            return nextMap
          })
        }
        try {
          await api.wait({ text: key, kind: kind ?? null, ...(typeof next === 'string' ? { next } : {}) })
        } catch (err) {
          showToast(String(err?.message ?? err), true)
        }
      }, [api, showToast])

      const toggleStar = useCallback(async (path, on) => {
        if (!path) return
        try {
          const value = await api.star(path, on)
          setStars(Array.isArray(value?.stars) ? value.stars : [])
          setDocs((rows) => rows.map((row) => (row.path === path ? { ...row, star: value?.starred === true } : row)))
          showToast(value?.starred ? t('star.added') : t('star.removed'))
        } catch (err) {
          showToast(String(err?.message ?? err), true)
        }
      }, [api, showToast, t])

      const saveDoc = useCallback(async ({ path, text, hash }) => {
        try {
          const value = await api.save({ path, text, hash })
          await reload(true)
          if (selected === path) void openDoc(path)
          showToast(t('edit.saved'))
          return value
        } catch (err) {
          showToast(String(err?.message ?? err), true)
          if (selected === path) void openDoc(path)
          return false
        }
      }, [api, openDoc, reload, selected, showToast, t])

      // 打开面板就落在一篇「最该看」的笔记上，而不是空白的阅读区：
      // initialPath → personal/关于我.md → personal/index.md → 最近改过的一篇。
      const autoOpened = useRef(false)
      useEffect(() => {
        if (booting || autoOpened.current) return
        autoOpened.current = true
        if (selected) { void openDoc(selected); return }
        // 窄屏（手机）上「一进来就整屏一篇正文」等于把列表藏起来 —— 只保留显式深链接。
        if (narrow && !props.initialPath) return
        const latestDay = timeline?.days?.[0]?.path ?? null
        const pick = props.initialPath
          ?? (tab === 'today'
            ? null
            : tab === 'timeline' || tab === 'todos'
            ? latestDay
            : tab === 'search' || tab === 'recall'
              ? null
              : docs.find((item) => item.path === 'personal/关于我.md')?.path
                ?? docs.find((item) => item.path === 'personal/index.md')?.path
                ?? [...docs].sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))[0]?.path)
        if (pick) {
          void openDoc(pick)
          // 离线预览/深链接用：打开后直接进编辑态
          if (props.initialEdit) setEditSignal((n) => n + 1)
        }
      }, [booting, docs, timeline, tab, openDoc, props.initialPath, props.initialEdit, selected, narrow])

      // 切到「时间长河」时顺手打开最近一天，视线不用在空面板上找入口。
      const openTab = useCallback((key) => {
        setTab(key)
        // 窄屏切页签先回到列表：手机上每次切换都整屏进正文会让人找不到北
        if (narrow) setSelected(null)
        // 「今天」是自成一屏的：不挂阅读器，切过去就清掉选中
        if (key === 'today') { setSelected(null); return }
        if (key !== 'timeline') return
        if (selected && String(selected).startsWith('memory/')) return
        const latest = timeline?.days?.[0]?.path
        if (latest) void openDoc(latest)
      }, [timeline, selected, openDoc, narrow])

      // 从「今天」里点一篇：按 scope 跳到对应的页签，再打开
      const usedSeen = useRef(new Set())
      // 当前正在读的是哪篇、从什么时候开始读（用来算停留时长）
      const readingRef = useRef({ path: '', at: 0 })
      const goBack = useCallback(() => {
        const prev = backStack.current.pop()
        setBackDepth(backStack.current.length)
        if (!prev) return
        void openDoc(prev, { push: false })
      }, [openDoc])
      goBackRef.current = goBack

      // 上一篇/下一篇：按当前这一页看到的那份顺序走（左栏树的顺序 / 时间线的日期顺序）
      const navPaths = useMemo(() => {
        if (tab === 'timeline' || tab === 'todos') return (timeline?.days ?? []).map((day) => day.path)
        return groupPersonal(docs, t).flatMap((group) => group.docs.map((doc) => doc.path))
      }, [tab, timeline, docs, t])
      const navAt = selected ? navPaths.indexOf(selected) : -1
      const stepDoc = useCallback((delta) => {
        if (navAt < 0) return
        const next = navPaths[navAt + delta]
        if (!next) return
        void openDoc(next)
      }, [navAt, navPaths, openDoc])
      stepRef.current = stepDoc

      const openFrom = useCallback((path, heading) => {
        if (!path) return
        setAnchor(heading ? { path, heading: String(heading), at: Date.now() } : null)
        setTab(String(path).startsWith('memory/') ? 'timeline' : 'personal')
        void openDoc(path)
      }, [openDoc])

      const counts = status?.counts ?? {}
      const indexReady = Boolean(status?.index?.ready)

      // 勾掉一条待办：写回磁盘上的 `- [x]`，成功后把时间线和当前文档一起刷新。
      const toggleTodo = useCallback(async ({ path, line, done, expect }) => {
        if (!path || !Number.isInteger(line)) return
        try {
          await api.todo({ path, line, done, expect })
          setTimeline((prev) => {
            if (!prev?.days) return prev
            const days = prev.days.map((day) => {
              if (day.path !== path) return day
              const todos = (day.todos ?? []).filter((item) => item.line !== line)
                .map((item) => item)
              const openTodos = Math.max(0, (day.openTodos ?? todos.length + 1) - 1)
              return { ...day, todos, openTodos }
            })
            const openTodos = days.reduce((sum, day) => sum + (Number(day.openTodos) || 0), 0)
            return { ...prev, days, totals: { ...(prev.totals ?? {}), openTodos } }
          })
          if (selected === path) void openDoc(path)
          // 勾错了总要能退回来：提示上直接挂一个撤销，不用回未完成页翻
          showToast(done ? t('todo.cleared') : t('todo.reopened'), false, {
            label: t('act.undo'),
            run: () => { void toggleTodo({ path, line, done: !done, expect }) },
          })
        } catch (err) {
          showToast(String(err?.message ?? err), true)
          void openDoc(path)
        }
      }, [api, openDoc, selected, showToast, t])

      // 点「补一句」：打开那篇、进编辑态、光标落文末——补记是接着写的，不是改中间
      const editAtEnd = useCallback((path) => {
        if (!path) return
        setEditAt(EDIT_AT_END)
        void openDoc(path)
        setEditSignal((n) => n + 1)
      }, [openDoc])

      // 点「下一步 · …」：打开那篇笔记，直接进编辑态，光标落在这一步上
      const editAtNext = useCallback(({ path, text }) => {
        if (!path) return
        setEditAt(String(text ?? ''))
        void openDoc(path)
        setEditSignal((n) => n + 1)
      }, [openDoc])

      // 改期：今天不做 ≠ 做完了。挪到明天，欠的债跟着人走
      const deferTodo = useCallback(async ({ path, line, expect, to, note }) => {
        if (!path || !Number.isInteger(line)) return
        try {
          const value = await api.deferTodo({ path, line, expect, to, note })
          const day = String(value?.to?.date ?? '')
          showToast(t('todo.deferred').replace('{d}', day.length > 5 ? day.slice(5) : day))
          setTimeline((prev) => {
            if (!prev?.days) return prev
            const days = prev.days.map((d) => (d.path === path
              ? { ...d, todos: (d.todos ?? []).filter((item) => item.line !== line), openTodos: Math.max(0, (d.openTodos ?? 1) - 1) }
              : d))
            const openTodos = days.reduce((sum, d) => sum + (Number(d.openTodos) || 0), 0)
            return { ...prev, totals: { ...(prev.totals ?? {}), openTodos } }
          })
          if (selected === path) void openDoc(path)
          const fresh = await api.timeline(true)
          if (fresh?.days) setTimeline(fresh)
        } catch (err) {
          showToast(String(err?.message ?? err), true)
          void openDoc(path)
        }
      }, [api, openDoc, selected, showToast, t])

      // 「变成行动」不只问下一步，还能直接排进某一天：先记下这一步，再把它挪过去
      const planNext = useCallback(async ({ path, line, text, to, next }) => {
        if (!path || !Number.isInteger(line)) return
        const clean = String(next ?? '').replace(/\s+/g, ' ').trim()
        await setWait({ text, kind: null, next: clean })
        await deferTodo({ path, line, expect: text, to, note: clean })
      }, [setWait, deferTodo])

      // 今天页直接往「未完成」里加一条：散步回来想起的事，不该先开弹窗
      const quickTodo = useCallback(async (text) => {
        const body = String(text ?? '').trim()
        if (!body) return false
        try {
          const value = await api.note({ text: body, todo: true })
          showToast(t('today.added'))
          const fresh = await api.timeline(true)
          setTimeline(fresh)
          if (selected && value?.path === selected) void openDoc(selected)
          return true
        } catch (err) {
          showToast(String(err?.message ?? err), true)
          return false
        }
      }, [api, openDoc, selected, showToast, t])

      // 新建时的目录候选：只列 personal/ 下已经存在的目录，避免手打路径
      const personalDirs = useMemo(() => {
        const set = new Set(['personal'])
        for (const item of docs) {
          if (item.scope !== 'personal') continue
          const dir = item.dir || 'personal'
          set.add(dir)
        }
        return [...set].sort((a, b) => (a === 'personal' ? -1 : b === 'personal' ? 1 : a.localeCompare(b)))
      }, [docs])

      const subtitle = status?.workspace
        ? `${status.workspace} · ${num(counts.personal)} ${t('meta.docs')} · ${num(counts.diaries)} ${t('meta.days')}`
        : t('recall.nows')

      const tabs = [
        ['today', t('tab.today')],
        ['personal', t('tab.personal')],
        ['timeline', t('tab.timeline')],
        ['todos', t('tab.todos')],
        ['search', t('tab.search')],
        ['recall', t('tab.recall')],
      ]

      const detail = h('div', { className: 'pmp-detail' },
        h(DocReader, {
          t,
          canHistoryBack: backDepth > 0,
          onHistoryBack: goBack,
          canPrev: navAt > 0,
          canNext: navAt >= 0 && navAt < navPaths.length - 1,
          onPrev: () => stepDoc(-1),
          onNext: () => stepDoc(1),
          api,
          docPath: selected,
          doc,
          loading: docLoading,
          error: docError,
          onRetry: () => { if (selected) void openDoc(selected) },
          onOpen: (path) => void openDoc(path),
          onToggleTodo: toggleTodo,
          onSave: saveDoc,
          editAt,
          editSignal,
          starred: stars.includes(selected ?? ''),
          onStar: toggleStar,
          // 窄屏上正文是整屏的，得有一条路回到列表
          onBack: () => setSelected(null),
          anchor,
        }),
      )

      return h('div', { className: `pmp-root${selected ? ' pmp-doc-open' : ''}` },
        h('div', { className: 'pmp-head' },
          h('div', { className: 'pmp-brand' },
            h(IconMemory, { size: 17 }),
            h('div', { className: 'pmp-brand-txt' },
              h('div', { className: 'pmp-title' }, t('nav')),
              h('div', { className: 'pmp-sub', title: subtitle }, subtitle),
            ),
          ),
          h('div', { className: 'pmp-tabs' }, tabs.map(([key, label]) => h('button', {
            type: 'button',
            key,
            className: `pmp-tab${tab === key ? ' on' : ''}`,
            onClick: () => openTab(key),
          }, label))),
          h('span', { className: 'pmp-spacer' }),
          h('button', {
            type: 'button',
            className: 'pmp-btn ghost',
            onClick: () => setQuickOpen(true),
            title: t('qj.hintKey'),
          }, h(IconSearch, { size: 14 }), h('span', { className: 'pmp-act-t' }, t('act.jump'))),
          h('button', {
            type: 'button',
            className: 'pmp-btn ghost',
            onClick: () => setNewOpen(true),
            title: t('new.hintKey'),
          }, h(IconPlus, { size: 14 }), h('span', { className: 'pmp-act-t' }, t('act.newNote'))),
          h('button', {
            type: 'button',
            className: 'pmp-btn primary',
            onClick: () => setNoteOpen(true),
            title: t('note.hintKey'),
          }, h(IconNote, { size: 14 }), h('span', { className: 'pmp-act-t' }, t('act.note'))),
          h('button', {
            type: 'button',
            className: 'pmp-btn ghost',
            disabled: refreshing || booting,
            onClick: () => void reload(true),
            title: t('act.refresh'),
          }, refreshing ? h(Spinner) : h(IconRefresh, { size: 15 })),
        ),

        h('div', { className: 'pmp-strip' },
          h('span', null, h('span', { className: `pmp-dot${indexReady ? ' ok' : ' bad'}` }), `${t('recall.index')} ${indexReady ? t('recall.ready') : t('recall.down')}`),
          h('span', null, `${t('meta.docs')} `, h('b', null, String(num(counts.personal) + num(counts.diaries)))),
          h('span', null, `${t('meta.entries')} `, h('b', null, String(num(counts.memoryEntries)))),
          h('span', null, `${t('meta.todos')} `, h('b', null, String(num(counts.openTodos)))),
          counts.lastDiary ? h('span', null, `${t('recall.latest')} `, h('b', null, String(counts.lastDiary).slice(-13, -3))) : null,
        ),

        loadError && tab !== 'recall' ? h('div', { className: 'pmp-err', style: { margin: '0 18px 8px' } }, loadError) : null,
        treeWarning && tab === 'personal' && docs.length === 0 ? h('div', { className: 'pmp-err', style: { margin: '0 18px 8px' } }, treeWarning) : null,

        tab === 'today'
          ? h('div', { className: 'pmp-body' },
            booting
              ? h('div', { className: 'pmp-empty', style: { flex: 1 } }, h(Spinner))
              : h(MasterToday, {
                t,
                timeline,
                onTodos: () => openTab('todos'),
                docs,
                status,
                selected,
                onOpen: openFrom,
                onToggleTodo: toggleTodo,
                onDeferTodo: deferTodo,
                onQuickTodo: quickTodo,
                onNote: () => setNoteOpen(true),
                onOpenDone: ({ path, section }) => openFrom(path, section),
                initialDoneOpen: props.initialDoneOpen === true,
                initialTodoSort: props.initialTodoSort,
                todoSort,
                onTodoSort: setTodoSort,
                waits,
                nexts,
                onWait: setWait,
                onEditNext: editAtNext,
                nexts,
              }),
          )
          : tab === 'recall'
          ? h('div', { className: 'pmp-body' },
            h(RecallTab, {
              t,
              status,
              api,
              onToast: showToast,
              onReload: reload,
              onOpen: (path) => void openFrom(path),
              initialLogOpen: props.initialLogOpen,
              initialTest: props.initialTest,
              initialStateInfo: props.initialStateInfo,
              initialStateOpen: props.initialStateOpen,
              initialTestMeta: props.initialTestMeta,
              initialShowDropped: props.initialShowDropped,
              initialSnippetOpen: props.initialSnippetOpen,
              initialTrialHint: props.initialTrialHint,
              initialCompare: props.initialCompare,
              initialSweep: props.initialSweep,
              initialExperiments: props.initialExperiments,
            }),
          )
          : h('div', { className: 'pmp-body' },
            booting
              ? h('div', { className: 'pmp-master' }, h('div', { className: 'pmp-empty' }, h(Spinner)))
              : tab === 'personal'
                ? h(MasterPersonal, { t, docs, selected, collapsed, onCollapse: toggleCollapse, audit, onOpen: (path) => void openDoc(path) })
                : tab === 'timeline'
                  ? h(MasterTimeline, {
                    t, timeline, docs, selected, collapsed,
                    onCollapse: toggleCollapse,
                    onOpen: (path) => void openDoc(path),
                    // 点年份格子：既展开那个月，也把它滚到视野里（没有 DOM 的环境直接跳过）
                    onPickMonth: (key) => {
                      if (collapsed[key] === true) toggleCollapse(key)
                      if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
                        const node = document.getElementById(`pm-${key}`) ?? document.getElementById(key)
                        if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'start', behavior: 'smooth' })
                      }
                    },
                  })
                  : tab === 'todos'
                    ? h(MasterTodos, {
              initialCtx: props.initialCtx, initialMvOpen: props.initialMvOpen, initialAskForRepeat: props.initialAskForRepeat, t, timeline, selected, onOpen: (path) => void openDoc(path), onToggleTodo: toggleTodo, onDeferTodo: deferTodo, waits, nexts, onWait: setWait, onEditNext: editAtNext, onPlanNext: planNext, initialActing: props.initialActing, initialActingText: props.initialActingText, initialActingDraft: props.initialActingDraft, initialWaitOnly: props.initialWaitOnly, initialMovedOnly: props.initialMovedOnly, collapsed, onCollapse: toggleCollapse })
                    : h(MasterSearch, { t, selected, initialQuery: props.initialQuery ?? null, recent: recentQueries, onOpen: (path) => void openDoc(path), onOpenIn: (path, heading) => openFrom(path, heading), sort: searchSort, onSort: setSearchSort, initialStateOnly: props.initialStateOnly, initialOnlyKind: props.initialOnlyKind, initialHits: props.initialHits, initialVisited: props.initialVisited ?? null, initialClueRows: props.initialClueRows, initialClueRecent: props.initialClueRecent, initialCluePages: props.initialCluePages, initialNewClueKind: props.initialNewClueKind, seed: seedQuery, onEditAtEnd: editAtEnd,
                      onNewNoteFrom: (dir) => { setNewNoteDir(dir || 'personal'); setNewOpen(true) },
                      onSearchFor: (text) => { setTab('search'); setSeedQuery({ q: text, at: Date.now() }) } }),
            detail,
          ),

        quickOpen ? h(QuickJump, {
          t,
          docs,
          initialQuery: props.initialQuickQuery ?? null,
          // 页签也能跳：手机上没有 ⌘K，这个面板就是唯一的「去哪」
          pages: [
            { key: 'today', label: t('tab.today') },
            { key: 'personal', label: t('tab.personal') },
            { key: 'timeline', label: t('tab.timeline') },
            { key: 'todos', label: t('tab.todos') },
            { key: 'search', label: t('tab.search') },
            { key: 'recall', label: t('tab.recall') },
          ],
          onNavigate: (key) => {
            setQuickOpen(false)
            openTab(key)
          },
          onPick: (path) => {
            setQuickOpen(false)
            setTab(String(path).startsWith('memory/') ? 'timeline' : 'personal')
            void openDoc(path)
          },
          recent: Array.isArray(recentVisited) ? recentVisited : [],
          // 标题里没有，不等于正文里没有：⌘K 里再给一条「去搜内容」
          onSearch: (text) => {
            setQuickOpen(false)
            setTab('search')
            setSeedQuery({ q: text, at: Date.now() })
          },
          onClose: () => setQuickOpen(false),
        }) : null,
        noteOpen ? h(NoteModal, { t, api, onClose: () => setNoteOpen(false), onDone: onNoted, toast: showToast }) : null,
        newOpen ? h(NewNoteModal, {
          t,
          api,
          dirs: personalDirs,
          defaultDir: newNoteDir || (selected && String(selected).startsWith('personal/') ? String(selected).slice(0, String(selected).lastIndexOf('/')) : 'personal'),
          onClose: () => { setNewOpen(false); setNewNoteDir('') },
          onDone: onCreated,
          toast: showToast,
        }) : null,
        toast
          ? h('div', { className: `pmp-toast${toast.bad ? ' bad' : ''}` },
            h('span', { className: 'pmp-toast-t' }, toast.text),
            toast.action
              ? h('button', {
                type: 'button',
                className: 'pmp-toast-a',
                onClick: () => { setToast(null); toast.action.run() },
              }, toast.action.label)
              : null)
          : null,
      )
    }

    function PanelIcon(props) {
      return props?.size ? h(IconMemory, { size: props.size }) : h(IconMemory, { size: 16 })
    }

    /* ------------------------------------------------------------------ *
     * 文案
     * ------------------------------------------------------------------ */
    const zh = {
      nav: '个人记忆',
      'tab.today': '今天',
      'today.card.date': '今天',
      'today.card.entries': '今天写了',
      'today.card.todos': '今天未完成',
      'today.card.owed': '欠 {n} 件',
      'today.card.days': '日记天数',
      'today.notWritten': '还没写',
      'today.total': '全书共',
      'today.owed': '今天该做的',
      'today.sort.fresh': '今天新加的在前',
      'today.sort.oldest': '最久没动的在前',
      'todo.ctx': '那天写了什么',
      'todo.ctxDay': '那天写了',
      'todo.ctxEmpty': '那天没写正文。',
      'todo.ctxOpen': '打开那天 →',
      'recall.used': '用上',
      'recall.usedHint': '召回之后这篇被打开过',
      'recall.logBudget': '本轮注入',
      'recall.logChars': '字',
      'recall.truncated': '截断',
      'tl.touched': '改过',
      'tl.year': '今年',
      'tl.yearCell': '{n} 天',
      'today.fresh': '今天新加的',
      'today.carried': '挂着没做的',
      'today.owedEmpty': '没有晾着的待办。',
      'today.wrote': '今天这篇',
      'today.open': '打开今天',
      'today.write': '写一条',
      'today.first.title': '今天还没写',
      'today.first.hint': '现在写一条，比事后回忆便宜得多 —— 写完这一天的格子就填上了。',
      'today.first.write': '写今天的第一条',
      'today.first.todo': '记一件要做的事',
      'today.empty': '今天还没写。点「写一条」记一句，明天它就在时间长河里。',
      'today.week': '本周',
      'today.weekEntries': '条',
      'today.weekDone': '勾掉',
      'today.weekOwed': '新欠',
      'today.weekSince': '从周一起算（{d}）',
      'today.prev': '往前两天',
      'today.emptyDay': '那天没写',
      'today.recent': '最近改过',
      'today.today': '今天',
      'today.added': '已加进今天的未完成',
      'today.addHint': '加一条要做的事，回车写进当天日记',
      'today.addBtn': '加上',
      'today.moreOwed': '还有 {n} 条在未完成页 →',
      'today.expandOwed': '就地展开剩下的 {n} 条',
      'today.collapseOwed': '收起，只看最要紧的 8 条',
      'today.toTodos': '去未完成页 →',
      'today.doneCount': '今天勾掉 {n} 条',
      'today.doneHint': '点开看看今天做完了什么',
      'today.doneOpen': '打开当天日记，落在它所在的小节',
      'recall.needBudget': '再多给 {chars} 字，这 {n} 篇都能进来',
      'recall.altExcerpt': '摘到 {chars} 字的话，能多进 {more} 篇',
      'recall.trialExcerpt': '摘要',
      'recall.needTry': '按这个数字再试',
      'recall.snippet': '变成配置',
      'recall.snippetHide': '收起配置',
      'recall.snippetWhere': '粘到这里（改完禁用/启用插件一次即生效）',
      'recall.snippetCopy': '复制',
      'recall.snippetCopied': '已复制',
      'recall.snippetNote': '不自动改你的配置：App 正在跑，改错会静默失效',
      'recall.trial': '临时放宽',
      'recall.trialBase': '默认',
      'recall.trialThreshold': '阈值',
      'recall.trialBudget': '预算',
      'recall.trialAll': '全都要',
      'recall.cmp': '换个说法再试',
      'recall.cmpBusy': '在比…',
      'recall.cmpHint': '措辞会改变召回：同一个问题换三种说法，看分别挑中什么',
      'recall.cmpTitle': '几种说法的对比（注入数 / 候选数 · 首位分 · 首位标题）',
      'recall.cmpOpen': '点一行：换成这个说法再跑一次，看完整过程',
      'recall.cmpNone': '一篇都没进来',
      'recall.cmp.orig': '原话',
      'recall.cmp.strip': '去掉疑问词',
      'recall.cmp.focus': '只留实词',
      'recall.cmp.ctx': '补上下文',
      'recall.sweep': '四个旋钮一起看',
      'recall.sweepBusy': '在扫…',
      'recall.sweepHint': '阈值 / 预算 / 摘要各动一档，一次看清楚该动哪个',
      'recall.sweepTitle': '同一句话，换不同配置（注入数 / 候选数 · 分数不够 · 超预算 · 首位分）',
      'recall.sweepKnob': '配置',
      'recall.sweepThrow': '改了什么',
      'recall.sweepInjected': '注入',
      'recall.sweepLow': '低分',
      'recall.sweepBudget': '超算',
      'recall.sweepTop': '首位',
      'recall.sweepApply': '点一行：按这套参数重跑一次「试一下」',
      'recall.sweep.base': '默认',
      'recall.expTitle': '实验记录（每跑一次留一行，点一行回到那次的结果）',
      'recall.expReplay': '点一行：把这次的查询和结果重新铺到上面',
      'recall.expSweep': '旋钮',
      'recall.expCompare': '说法',
      'recall.expBest': '最多 {n} 篇',

      'recall.sweep.th': '阈值 0.05',
      'recall.sweep.bud': '预算 2400',
      'recall.sweep.snip': '摘要 120',
      'recall.sweep.all': '三样一起',

      'recall.trialHint': '只对这一下生效，不写进配置；看完再决定要不要改 config',
      'recall.dropTitle': '被挡掉的 {n} 篇',
      'recall.dropWhy': '分数不够 {low} · 超预算 {budget} —— 不是没有，是没进来',
      'search.sortScore': '按相关度',
      'search.sortRecent': '按最近改过',
      'act.prev': '上一篇（[）',
      'act.next': '下一篇（]）',
      'todo.allAge': '全部',
      'todo.today': '今天的',
      'todo.age3': '3 天以上',
      'todo.age7': '一周以上',
      'todo.stale': '晾了一周',
      'list.project': '项目',
      'list.projectRoot': '项目 / 根目录',
      'act.jump': '跳转',
      'act.undo': '撤销',
      'act.histBack': '退回上一处（Alt+←）',
      'act.histBackShort': '上一处',
      'star.add': '星标（置顶在左栏）',
      'star.remove': '取消星标',
      'star.added': '已星标，左栏置顶',
      'star.removed': '已取消星标',
      'list.starred': '星标',
      'search.recent': '最近查过',
      'search.recentDays': '{n} 天内',
      'search.short.personal': '个人',
      'search.short.memory': '长河',
      'search.short.project': '项目',
      'qj.page': '页签',
      'qj.search': '用「{q}」搜内容',
      'qj.searchHint': '标题里没有，正文里也许有',
      'qj.recentMeta': '{d} 天前看过',
      'qj.recentToday': '今天看过',
      'qj.recentYesterday': '昨天看过',
      'qj.placeholder': '跳到哪里？输入标题或路径片段',
      'qj.empty': '没有匹配的笔记。',
      'qj.hint': '↑↓ 选择 · Enter 打开 · Esc 关闭',
      'qj.hintKey': '⌘K 快速跳转',
      'search.viaKeyword': '词面',
      'search.changed': '改于',
      'search.usedAt': '看过 · {d}',
      'search.usedHint': '你上次为它停下来是',

      'search.viaClue': '线索',
      'search.viaClueHint': '这是你记下的「想找但没找到」：缺口本身也进检索，省得下次再找一遍',
      'search.clueExcerpt': '想找：',
      'search.viaState': '待办',
      'search.visited': '翻过没动',
      'search.visitedEdit': '补一句',
      'search.visitedEditHint': '直接进编辑态，光标落在文末——看完就动手，比看完就算了强',
      'search.dwellBrief': '看一眼就走',
      'search.dwellSec': '停了 {n} 秒',
      'search.dwellMin': '读了 {n} 分钟',
      'search.clueSheet': '线索',
      'search.clueSheetH': '想找的东西（还悬着 {n} 条）',
      'search.clueSheetEmpty': '还没有「想找：」记录。目录页点开几秒就走时，可以在那一行「记一条线索」。',
      'search.clueSheetHint': '把所有「- 想找：…」收在一处：反复找同一个东西，说明索引缺了一块',
      'search.clueNew': '+ 记一条',
      'search.clueNewHint': '不用先打开某一页：想到「我在找什么」就直接记，落到你选的目录页末尾',
      'search.clueNewAsk': '我在找什么？（会以「- 想找：…」补到所选目录页末尾）',
      'search.clueGo.find': '写一篇',
      'search.clueGo.check': '去核对',
      'search.clueGo.cite': '找回原话',
      'search.clueGoHint.find': '直接开一篇新建笔记，目录就落在这页所在的目录',
      'search.clueGoHint.check': '带着这句话去检索，翻出当时的结论',
      'search.clueGoHint.cite': '带着这句话去检索，找回那句原话',
      'search.clueKind.find': '想知道答案',
      'search.clueKind.check': '想确认结论',
      'search.clueKind.cite': '想找回原话',
      'search.clueKindHint.find': '缺的是「还没人写过」：该去补索引或补一篇',
      'search.clueKindHint.check': '缺的是「当时写了什么、对不对」：该去翻旧结论核对',
      'search.clueKindHint.cite': '缺的是「原话在哪一句」：该去翻日记找出处',
      'search.clueAge': '已悬 {n} 天',
      'search.clueAgeHint': '这条线索记下之后一直没被处理：反复想找又一直没补，通常是索引缺的那块真的重要',
      'search.clueRecent': '最近解决的（{n}）',
      'search.clueRecentToday': '今天',
      'search.clueRecentDays': '{n} 天前',
      'search.clueResolve': '解决了',
      'search.clueReopen': '重新打开',
      'search.clueResolveHint': '标记「这条我找到了」（写在别处也算）——跟「这页被改过」分开记',
      'search.clueOpen': '还悬着',
      'search.clueDone': '已补进正文',
      'search.clueLine': '第 {n} 行',
      'search.clue': '记一条线索',
      'search.clueHint': '打开这页几秒就走，多半是「想找的东西没写在索引里」——写下你要找什么，直接补到这页末尾',
      'search.clueAsk': '你想在这页找到什么？（会以「- 想找：…」补到这页末尾）',
      'search.cluePlaceholder': '比如：各板块的止损线怎么定',
      'search.clueSave': '补到末尾',
      'audit.ok': '体检通过 · {n} 篇笔记都带着更新/来源，也都在索引里',
      'audit.okHint': '缺 更新/来源、没被索引引用、索引里的死链，都在这里查；发现问题才会显示',
      'audit.title': '体检发现 {n} 条',
      'audit.hint': '点一条打开那篇',
      'audit.more': '还有 {n} 条（完整清单跑 kb-audit skill）',
      'search.clueCancel': '算了',
      'search.visitedIndex': '目录',
      'search.visitedIndexHint': '这是个目录页（index/README）：打开它通常只是进去找东西，不是「看了没动」',
      'search.visitedAddHere': '加一条',
      'search.visitedHint': '打开过、之后一直没再改的笔记：当时觉得有用，后来忘了',
      'search.visitedH': '翻过但没动（{n} 篇）',
      'search.visitedEmpty': '没有这种笔记——看过的都动过手，或者还没看过什么',
      'search.visitedTag': '看过没动',
      'search.visitedMeta': '看过 {u} 天前 · 改于 {m} 天前',
      'search.onlyClue': '只看线索',
      'search.onlyClueHint': '只留「想找但没找到」的记录，不混正文命中',
      'search.noneClue': '没有匹配的线索。换一句话，或者取消「只看线索」。',
      'search.noneClueSave': '记一条线索',
      'search.noneClueHint': '搜不到，说明这里缺一块。记下来，下次搜同一句它会自己出现。',
      'search.distNote': '笔记',
      'search.distState': '待办',
      'search.distClue': '线索',
      'search.distHint.note': '只看笔记正文里的命中（把待办与线索收起来）',
      'search.distHint.state': '只看待办状态里的命中',
      'search.distHint.clue': '只看「想找但没找到」的记录',
      'search.onlyState': '只看待办',
      'search.scopeOffHint': '只看待办时范围固定为时间长河（待办只写在那里）',
      'search.onlyStateHint': '只在待办状态里找：下一步写了什么、在等什么、为什么一直往后挪',
      'search.noneState': '没有匹配的待办。换一句话，或者取消「只看待办」。',
      'search.viaStateHint': '这条命中来自你的待办状态（下一步 / 在等什么 / 为什么挪），不是笔记正文',
      'search.stateTodo': '待办：',
      'ago.today': '今天',
      'ago.yesterday': '昨天',
      'ago.days': '{n} 天前',
      'ago.months': '{n} 个月前',
      'ago.years': '{n} 年前',
      'search.anyTime': '不限时间',
      'search.days7': '7 天内',
      'search.days30': '30 天内',
      'tab.personal': '个人记忆',
      'tab.timeline': '时间长河',
      'tab.todos': '未完成',
      'todo.filter': '筛选未完成…',
      'act.back': '返回列表',
      'act.edit': '编辑',
      'act.save': '保存',
      'act.cancel': '取消',
      'act.newNote': '新建笔记',
      'edit.hint': '在这里改正文，改完保存',
      'edit.hintKey': '⌘S 保存 · Esc 取消',
      'edit.dirty': '有未保存的改动',
      'edit.discardArmed': '再点一次丢弃',
      'edit.saved': '已保存',
      'new.title': '新建一篇笔记',
      'new.hint': '建在 personal/ 里，建完直接进编辑；日记请用「速记」',
      'new.name': '标题',
      'new.placeholder': '比如：怎么判断一只股票贵不贵',
      'new.dir': '放在哪个目录',
      'new.pathHint': '会建成 {dir}/标题.md，带 更新:/来源: 两行',
      'new.submit': '建好并开始写',
      'new.created': '建好了，开始写吧',
      'new.hintKey': '新建一篇 personal 笔记',
      'todo.staleOnly': '只看晾了 7 天以上',
      'todo.done': '勾掉（写回当天日记）',
      'todo.defer': '挪到明天（写进明天日记的「未完成」）',
      'todo.deferShort': '明天',
      'todo.deferMondayShort': '周一',
      'todo.deferMonday': '挪到下周一（周五起就算下周）',
      'todo.waitOnly': '只看在等的',
      'todo.waitOnlyHint': '只显示标了「在等什么」的条目——这些推进不了，看一眼就能放下',
      'todo.moved': '挪过 {n} 次',
      'todo.movedHint': '从 {d} 起一直在往后挪——不是没时间，是这件事本身还没定下来',
      'todo.movedOnly': '老是往后挪的',
      'todo.movedOnlyHint': '只看挪过 2 次以上的：反复改期的，通常不是排期问题',
      'todo.movedOpen': '点开看每一步为什么挪（{t}）',
      'todo.movedWhy': '这条一直在往后挪',
      'todo.movedNoNote': '（当时没写为什么）',
      'todo.whyAsk': '再挪一次，顺手记一句为什么——攒几次就能看出是等外部条件，还是自己没想清',
      'todo.whyHint': '一句话就够，比如「等三季报」「还没想清要不要做」',
      'todo.whyGo': '记下并挪过去',
      'todo.whySkip': '不写了，直接挪',
      'wait.add': '\u231b',
      'wait.hint': '点一下标记「这条在等什么」，再点循环（等行情 → 等人回 → 等自己决定 → 清除）',
      'wait.market': '等行情',
      'wait.reply': '等人回',
      'wait.decide': '等决定',
      'wait.review': '这几条已经等了一阵，还在等吗？',
      'wait.days': '等了 {n} 天',
      'wait.keep': '继续等',
      'wait.keepHint': '还在等：把计时重新开始',
      'wait.act': '变成行动',
      'wait.actHint': '不再等了：清掉标记，回到「我能推进」的那张表里',
      'wait.planTom': '排到明天',
      'wait.planMon': '排到周一',
      'wait.planTomHint': '记下这一步，然后把这条挪到明天',
      'wait.planMonHint': '记下这一步，然后把这条挪到下周一',
      'wait.actSave': '存下下一步',
      'wait.nextPlaceholder': '下一步是什么？（回车存下）',
      'todo.nextPrefix': '下一步 · ',
          'todo.nextOpen': '打开这篇、直接改到这一步',
      'todo.deferred': '挪到 {d} 了',
      'todo.cleared': '勾掉了，写进当天的日记',
      'todo.reopened': '已取消勾选',
      'todo.empty': '没有未完成的条目，收得挺干净。',
      'todo.bucket.today': '今天还没做',
      'todo.bucket.week': '这一周欠的',
      'todo.bucket.old': '更早（一周以上）',
      'todo.bucketOldest': '最久 {n} 天',
      'todo.days': '天前',
      'todo.unnamed': '（只写了复选，没写内容）',
      'related.title': '相关笔记',
      'tab.search': '检索',
      'tab.recall': '召回',
      'act.note': '速记',
      'act.refresh': '刷新',
      'act.retry': '重试',
      'act.cancel': '取消',
      'meta.chars': '字',
      'meta.entries': '条',
      'meta.days': '天',
      'meta.docs': '篇笔记',
      'meta.todos': '未完成',
      'list.filter': '筛选标题…',
      'list.root': 'personal / 根目录',
      'list.empty': '这里还没有笔记。',
      'detail.empty': '左边挑一篇，读它。',
      'detail.emptyHint': 'personal 是懂过的东西，memory 是走过的日子。',
      'detail.loading': '读取中…',
      'detail.lines': '行',
      'detail.updated': '更新',
      'detail.source': '来源',
      'tl.missed': '空 {n} 天',
      'tl.gap': '{n} 天没记',
      'tl.empty': '还没有日记。去写第一天的。',
      'search.placeholder': '比如：钧达的止损线怎么定？',
      'search.btn': '检索',
      'search.idle': '输入一句话，在 personal / memory / project 里找回当时的想法。',
      'search.busy': '检索中…',
      'search.none': '没有命中。换个说法试试。',
      'search.stat': '{n} 篇命中 · {ms} ms',
      'search.scope.personal': '个人记忆',
      'search.scope.memory': '时间长河',
      'search.scope.project': '项目',
      'recall.recalls': '累计召回',
      'recall.hits': '命中笔记',
      'recall.diaries': '日记天数',
      'recall.todos': '未完成',
      'recall.todosNote': '跨天累计',
      'recall.index': '索引',
      'recall.ready': '就绪',
      'recall.down': '未就绪',
      'recall.try': '试一下召回',
      'recall.proc': '这次召回的过程',
      'recall.params': '{mode} · 阈值 {th} · 取前 {k} 篇 · 预算 {chars} 字',
      'recall.candLine': '候选 {n} · 注入 {p} · 分数不够 {low} · 超预算 {budget} · {ms} ms',
      'recall.picked': '会注入',
      'recall.dropLow': '分数不够',
      'recall.dropBudget': '超预算',
      'recall.tryHint': '输入一句话，看每轮自动召回实际会挑哪几篇笔记（不会写进会话）。',
      'recall.run': '试一下',
      'recall.reindex': '重建索引',
      'recall.reindexing': '重建中…',
      'recall.reindexed': '索引已重建',
      'recall.recent': '最近召回',
      'recall.none': '还没有记录',
      'recall.noneWhy': '日志里已有 {n} 条记录（最早 {since}），但召回记录被清空过，所以上面几张卡是 0',
      'recall.mounted': '插件已挂载',
      'recall.hitUnit': '篇',
      'recall.fromRollup': '含历史汇总',
      'recall.usage': '召回命中率',
      'recall.usageNote': '近 {d} 天 · 后来被打开 {p}%',
      'recall.usageEmpty': '近 {d} 天还没有召回记录',
      'recall.usageBlind': '近 {d} 天召回 {n} 次，但旧日志没记明细，算不出命中率',
      'recall.viaKeyword': '词面',
      'recall.viaBoth': '都中',
      'recall.viaHint': '词面 = 正文里真的出现过这几个字；都中 = 语义和字面都命中',
      'recall.stateTitle': '面板自己的状态',
      'recall.stateOpen': '看它攒了什么',
      'recall.stateReload': '刷新',
      'recall.stateHint': '这些是面板自己记的东西（不是笔记）：检索历史、星标、等待、下一步、改期链、用量、折叠偏好。存在工作区的 .dsh/personal-memory/state.json，删了只是丢这些便利，笔记一条不动。',
      'recall.stateEmpty': '还没读过。点右上「看它攒了什么」。',
      'recall.stateMig': '这次读进来把 {n} 条 {from} 的旧格式补成了新形状',
      'recall.stateMigNow': '现在写回文件',
      'recall.stateMigrated': '版本已写回文件（补了 {n} 条旧格式）',
      'recall.stateClear': '清空',
      'recall.stateClearHint': '只清这张表，点一次先确认',
      'recall.stateClearNow': '真的清掉？',
      'recall.stateCleared': '已清空「{k}」',
      'recall.tbl.queries': '检索历史',
      'recall.tbl.stars': '星标',
      'recall.tbl.ui': '折叠偏好',
      'recall.tbl.used': '用过的笔记',
      'recall.tbl.wait': '在等什么',
      'recall.tbl.next': '下一步',
      'recall.tbl.moved': '改期链',
      'recall.tbl.usage': '日用量',
      'recall.config': '当前配置',
      'recall.ws': '工作区',
      'recall.log': '日志',
      'recall.nows': '没有找到工作区（需要 personal/ 与 memory/ 目录）',
      'recall.latest': '最近日记',
      'note.title': '快速记一条',
      'note.hint': '只往当天日记里追加一行，不改已有内容。',
      'note.placeholder': '现在发生了什么、想清楚了什么…',
      'note.submit': '记下来',
      'note.section': '写到',
      'note.hintKey': '⌘ + Enter 提交',
      'note.ok': '已记到 {path}',
      'note.sec.产出': '产出',
      'note.sec.判断': '判断',
      'note.sec.未完成': '未完成',
      'note.sec.备忘': '备忘',
      'settings.title': '个人记忆',
      'settings.hint': 'personal 是认知，memory 是时间。面板只读文件，速记只追加。要改参数，编辑 ~/.dsh/profiles/desktop/cordis.patch.yml 里 personal-memory 的 config，然后重载插件。',
    }

    const en = {
      nav: 'Personal Memory',
      'tab.today': 'Today',
      'today.card.date': 'Today',
      'today.card.entries': 'Written today',
      'today.card.todos': 'Open today',
      'today.card.owed': 'owed {n}',
      'today.card.days': 'Diary days',
      'today.notWritten': 'not written yet',
      'today.total': 'in total',
      'today.owed': 'What is owed',
      'today.sort.fresh': 'Added today first',
      'today.sort.oldest': 'Oldest first',
      'todo.ctx': 'What that day said',
      'todo.ctxDay': 'That day',
      'todo.ctxEmpty': 'Nothing written that day.',
      'todo.ctxOpen': 'Open that day →',
      'recall.used': 'used',
      'recall.usedHint': 'Opened after that recall',
      'recall.logBudget': 'Injected',
      'recall.logChars': 'chars',
      'recall.truncated': 'cut',
      'tl.touched': 'Edited',
      'tl.year': 'this year',
      'tl.yearCell': '{n} d',
      'today.fresh': 'Added today',
      'today.carried': 'Still owed',
      'today.owedEmpty': 'Nothing left hanging.',
      'today.wrote': 'Today',
      'today.open': 'Open today',
      'today.write': 'Write one',
      'today.first.title': 'Nothing written today',
      'today.first.hint': 'One line now costs less than remembering later — and the day gets filled in.',
      'today.first.write': 'Write the first line',
      'today.first.todo': 'Note something to do',
      'today.empty': 'Nothing written today yet. Hit “Write one” — tomorrow it will be part of the timeline.',
      'today.week': 'This week',
      'today.weekEntries': 'entries',
      'today.weekDone': 'ticked',
      'today.weekOwed': 'newly owed',
      'today.weekSince': 'since Monday ({d})',
      'today.prev': 'Two days back',
      'today.emptyDay': 'nothing written',
      'today.recent': 'Recently edited',
      'today.today': 'today',
      'today.moreOwed': '{n} more on the To do page →',
      'today.expandOwed': 'Show the other {n} here',
      'today.collapseOwed': 'Collapse to the top 8',
      'today.toTodos': 'To do page →',
      'today.doneCount': '{n} ticked today',
      'today.doneHint': 'See what you finished today',
      'today.doneOpen': 'Open that day and jump to its section',
      'recall.needBudget': '{n} more would fit with {chars} chars',
      'recall.altExcerpt': 'Shorter excerpts ({chars} chars) would fit {more} more',
      'recall.trialExcerpt': 'excerpt',
      'recall.needTry': 'Retry with that',
      'recall.snippet': 'As config',
      'recall.snippetHide': 'Hide config',
      'recall.snippetWhere': 'Paste into that file, then disable/enable the plugin',
      'recall.snippetCopy': 'Copy',
      'recall.snippetCopied': 'Copied',
      'recall.snippetNote': 'Never edits your profile for you — a bad write fails silently while the app runs',
      'recall.trial': 'Loosen',
      'recall.trialBase': 'default',
      'recall.trialThreshold': 'threshold',
      'recall.trialBudget': 'budget',
      'recall.trialAll': 'all',
      'recall.cmp': 'Try other phrasings',
      'recall.cmpBusy': 'Comparing…',
      'recall.cmpHint': 'Wording changes what comes back: same question, three phrasings',
      'recall.cmpTitle': 'Side by side (injected / candidates · top score · top title)',
      'recall.cmpOpen': 'Click a row to re-run with that phrasing and see the full process',
      'recall.cmpNone': 'Nothing came in',
      'recall.cmp.orig': 'Original',
      'recall.cmp.strip': 'No question words',
      'recall.cmp.focus': 'Content words',
      'recall.cmp.ctx': 'With context',
      'recall.sweep': 'Sweep all knobs',
      'recall.sweepBusy': 'Sweeping…',
      'recall.sweepHint': 'Move threshold / budget / snippet one at a time, see which one matters',
      'recall.sweepTitle': 'Same sentence, different settings (injected / candidates · below threshold · over budget · top score)',
      'recall.sweepKnob': 'Setting',
      'recall.sweepThrow': 'Changed',
      'recall.sweepInjected': 'In',
      'recall.sweepLow': 'Low',
      'recall.sweepBudget': 'Over',
      'recall.sweepTop': 'Top',
      'recall.sweepApply': 'Click a row to re-run with that setting',
      'recall.sweep.base': 'Default',
      'recall.expTitle': 'Experiment log (one line per run — click to bring it back)',
      'recall.expReplay': 'Click a row to reload that query and its results',
      'recall.expSweep': 'Sweep',
      'recall.expCompare': 'Phrasing',
      'recall.expBest': 'up to {n}',

      'recall.sweep.th': 'threshold 0.05',
      'recall.sweep.bud': 'budget 2400',
      'recall.sweep.snip': 'snippet 120',
      'recall.sweep.all': 'All three',

      'recall.trialHint': 'Applies to this run only — nothing written to config',
      'recall.dropTitle': '{n} left out',
      'recall.dropWhy': '{low} below threshold · {budget} over budget — not absent, just left out',
      'search.sortScore': 'By relevance',
      'search.sortRecent': 'By recency',
      'act.prev': 'Previous ([)',
      'act.next': 'Next (])',
      'today.added': 'Added to today’s to-dos',
      'today.addHint': 'Add something to do — Enter writes it into today’s diary',
      'today.addBtn': 'Add',
      'todo.allAge': 'All',
      'todo.today': 'Today',
      'todo.age3': '3d+',
      'todo.age7': '7d+',
      'todo.stale': 'stale 7d+',
      'list.project': 'project',
      'list.projectRoot': 'project / root',
      'act.jump': 'Jump',
      'act.undo': 'Undo',
      'act.histBack': 'Back to the previous note (Alt+←)',
      'act.histBackShort': 'Back',
      'star.add': 'Star (pinned on the left)',
      'star.remove': 'Unstar',
      'star.added': 'Starred — pinned on the left',
      'star.removed': 'Unstarred',
      'list.starred': 'Starred',
      'search.recent': 'Recent searches',
      'search.recentDays': 'last {n}d',
      'search.short.personal': 'personal',
      'search.short.memory': 'timeline',
      'search.short.project': 'project',
      'qj.page': 'page',
      'qj.search': 'Search content for “{q}”',
      'qj.searchHint': 'Not in titles — maybe in the text',
      'qj.recentMeta': 'opened {d}d ago',
      'qj.recentToday': 'opened today',
      'qj.recentYesterday': 'opened yesterday',
      'qj.placeholder': 'Jump to… title or path fragment',
      'qj.empty': 'No matching notes.',
      'qj.hint': '↑↓ move · Enter open · Esc close',
      'qj.hintKey': '⌘K quick jump',
      'search.viaKeyword': 'literal',
      'search.changed': 'Edited',
      'search.usedAt': 'Opened · {d}',
      'search.usedHint': 'You last opened it',

      'search.viaClue': 'Clue',
      'search.viaClueHint': 'A gap you recorded — it shows up so you stop searching for it twice',
      'search.clueExcerpt': 'Wanted: ',
      'search.viaState': 'todo',
      'search.visited': 'Read, untouched',
      'search.visitedEdit': 'Add a line',
      'search.visitedEditHint': 'Jump into the editor with the caret at the end',
      'search.dwellBrief': 'skipped by',
      'search.dwellSec': 'stayed {n}s',
      'search.dwellMin': 'read {n}m',
      'search.clueSheet': 'Clues',
      'search.clueSheetH': 'Things I was looking for ({n} open)',
      'search.clueSheetEmpty': 'No “- 想找：” lines yet. When an index page is left in seconds, tag it with a clue.',
      'search.clueSheetHint': 'All “- 想找：” lines in one place: hunting the same thing twice means the index is missing a piece',
      'search.clueNew': '+ Add',
      'search.clueNewHint': 'No need to open a page first — record what you were looking for, appended to the chosen index',
      'search.clueNewAsk': 'What were you looking for? (appended as “- 想找：…”)',
      'search.clueGo.find': 'Write one',
      'search.clueGo.check': 'Go check',
      'search.clueGo.cite': 'Find quote',
      'search.clueGoHint.find': 'Open a new note in the same folder as this index',
      'search.clueGoHint.check': 'Search with this phrase to dig out the old call',
      'search.clueGoHint.cite': 'Search with this phrase to find the exact sentence',
      'search.clueKind.find': 'Need an answer',
      'search.clueKind.check': 'Confirm a call',
      'search.clueKind.cite': 'Find the quote',
      'search.clueKindHint.find': 'Nobody wrote it yet — add to an index or write a note',
      'search.clueKindHint.check': 'You wrote it before — go back and check',
      'search.clueKindHint.cite': 'You need the exact sentence — dig through the diary',
      'search.clueAge': 'open {n}d',
      'search.clueAgeHint': 'Recorded a while ago and never handled — if you keep looking for it, the index really is missing something',
      'search.clueRecent': 'Resolved recently ({n})',
      'search.clueRecentToday': 'today',
      'search.clueRecentDays': '{n}d ago',
      'search.clueResolve': 'Resolve',
      'search.clueReopen': 'Reopen',
      'search.clueResolveHint': 'Mark “found it elsewhere” — kept separate from “this page changed”',
      'search.clueOpen': 'open',
      'search.clueDone': 'landed',
      'search.clueLine': 'line {n}',
      'search.clue': 'Add a clue',
      'search.clueHint': 'Opened and left in seconds — probably what you wanted was not in this index',
      'search.clueAsk': 'What were you looking for here? (appended as “- 想找：…” )',
      'search.cluePlaceholder': 'e.g. how stop-loss is set per sector',
      'search.clueSave': 'Append',
      'audit.ok': 'Healthy · {n} notes all carry updated/source and are indexed',
      'audit.okHint': 'Checks missing 更新/来源, notes no index points at, and dead links. Shown only when something breaks',
      'audit.title': 'Audit found {n}',
      'audit.hint': 'Click one to open it',
      'audit.more': '{n} more (run the kb-audit skill for the full list)',
      'search.clueCancel': 'Never mind',
      'search.visitedIndex': 'index',
      'search.visitedIndexHint': 'An index/README page: opening it usually means you went in to find something',
      'search.visitedAddHere': 'append',
      'search.visitedHint': 'Notes you opened but never edited since: seemed useful then, forgotten now',
      'search.visitedH': 'Read but untouched ({n})',
      'search.visitedEmpty': 'None — everything you opened, you also edited. Or you have not opened much yet.',
      'search.visitedTag': 'read only',
      'search.visitedMeta': 'read {u}d ago · edited {m}d ago',
      'search.onlyClue': 'Clues only',
      'search.onlyClueHint': 'Keep only the gaps you recorded, drop note hits',
      'search.noneClue': 'No matching clue. Try another phrase, or turn off “Clues only”.',
      'search.noneClueSave': 'Record this gap',
      'search.noneClueHint': 'Nothing matched — that means a gap. Write it down; next search will surface it.',
      'search.distNote': 'notes',
      'search.distState': 'todos',
      'search.distClue': 'clues',
      'search.distHint.note': 'Only hits inside note text (drop todos and clues)',
      'search.distHint.state': 'Only hits from your todo state',
      'search.distHint.clue': 'Only the gaps you recorded',
      'search.onlyState': 'Todos only',
      'search.scopeOffHint': 'Scope is fixed to memory while “Todos only” is on (that is where todos live)',
      'search.onlyStateHint': 'Search only your todo state: next step, what you are waiting for, why it keeps slipping',
      'search.noneState': 'No matching todos. Rephrase, or turn off “Todos only”.',
      'search.viaStateHint': 'This hit comes from your todo state (next step / waiting / why deferred), not from note text',
      'search.stateTodo': 'Todo:',
      'ago.today': 'today',
      'ago.yesterday': 'yesterday',
      'ago.days': '{n}d ago',
      'ago.months': '{n}mo ago',
      'ago.years': '{n}y ago',
      'search.anyTime': 'Any time',
      'search.days7': 'Last 7d',
      'search.days30': 'Last 30d',
      'tab.personal': 'Personal',
      'tab.timeline': 'Timeline',
      'tab.todos': 'To do',
      'todo.filter': 'Filter open items…',
      'act.back': 'Back to list',
      'act.edit': 'Edit',
      'act.save': 'Save',
      'act.cancel': 'Cancel',
      'act.newNote': 'New note',
      'edit.hint': 'Edit the body, then save',
      'edit.hintKey': '⌘S to save · Esc to cancel',
      'edit.dirty': 'Unsaved changes',
      'edit.discardArmed': 'Click again to discard',
      'edit.saved': 'Saved',
      'new.title': 'New note',
      'new.hint': 'Created under personal/ and opened for editing; use Quick note for the journal',
      'new.name': 'Title',
      'new.placeholder': 'e.g. How to tell if a stock is expensive',
      'new.dir': 'Folder',
      'new.pathHint': 'Creates {dir}/<title>.md with Updated/Source lines',
      'new.submit': 'Create & write',
      'new.created': 'Created — start writing',
      'new.hintKey': 'Create a personal note',
      'todo.staleOnly': 'Aging 7d+',
      'todo.done': 'Tick it (writes back to that day)',
      'todo.defer': 'Move to tomorrow (lands in tomorrow\'s 「未完成」)',
      'todo.deferShort': 'Tmrw',
      'todo.deferMondayShort': 'Mon',
      'todo.deferMonday': 'Move to next Monday',
      'todo.waitOnly': 'Waiting only',
      'todo.waitOnlyHint': 'Only items tagged as waiting on something external',
      'todo.moved': 'Moved {n}x',
      'todo.movedHint': 'Pushed forward since {d} — not a scheduling problem, the thing itself is undecided',
      'todo.movedOnly': 'Repeatedly moved',
      'todo.movedOnlyHint': 'Only items moved 2+ times: rescheduling again and again is usually not about time',
      'todo.movedOpen': 'See why each time ({t})',
      'todo.movedWhy': 'Pushed back over and over',
      'todo.movedNoNote': '(no reason written then)',
      'todo.whyAsk': 'One more move — jot down why. After a few, you can tell whether you are waiting on the world or on yourself',
      'todo.whyHint': 'One line is enough: "waiting for Q3 report", "still not sure it is worth doing"',
      'todo.whyGo': 'Save and move',
      'todo.whySkip': 'Move without a reason',
      'wait.add': '\u231b',
      'wait.hint': 'Tap to tag what this item is waiting for (market / reply / your own decision)',
      'wait.market': 'market',
      'wait.reply': 'reply',
      'wait.decide': 'decide',
      'wait.review': 'These have been waiting a while — still waiting?',
      'wait.days': 'waiting {n}d',
      'wait.keep': 'Still waiting',
      'wait.keepHint': 'Still waiting: restart the clock',
      'wait.act': 'Make it an action',
      'wait.actHint': 'No longer waiting: clear the mark and put it back on the actionable list',
      'wait.planTom': 'Plan tomorrow',
      'wait.planMon': 'Plan Monday',
      'wait.planTomHint': 'Save the next step, then move this to tomorrow',
      'wait.planMonHint': 'Save the next step, then move this to next Monday',
      'wait.actSave': 'Save next step',
      'wait.nextPlaceholder': 'What is the next step? (Enter to save)',
      'todo.nextPrefix': 'Next · ',
          'todo.nextOpen': 'Open the note and start editing here',
      'todo.deferred': 'Moved to {d}',
      'todo.cleared': 'Ticked — written back to that day',
      'todo.reopened': 'Un-ticked',
      'todo.empty': 'Nothing left open. Clean.',
      'todo.bucket.today': 'Due today',
      'todo.bucket.week': 'Owed this week',
      'todo.bucket.old': 'Older than a week',
      'todo.bucketOldest': 'oldest {n} d',
      'todo.days': 'd ago',
      'todo.unnamed': '(empty item)',
      'related.title': 'Related notes',
      'tab.search': 'Search',
      'tab.recall': 'Recall',
      'act.note': 'Note',
      'act.refresh': 'Refresh',
      'act.retry': 'Retry',
      'act.cancel': 'Cancel',
      'meta.chars': 'chars',
      'meta.entries': 'items',
      'meta.days': 'days',
      'meta.docs': 'notes',
      'meta.todos': 'open',
      'list.filter': 'Filter titles…',
      'list.root': 'personal / root',
      'list.empty': 'No notes here yet.',
      'detail.empty': 'Pick a note on the left.',
      'detail.emptyHint': 'personal is what you have learned; memory is the days you have lived.',
      'detail.loading': 'Loading…',
      'detail.lines': 'lines',
      'detail.updated': 'updated',
      'detail.source': 'source',
      'tl.missed': '{n} blank',
      'tl.gap': '{n}d skipped',
      'tl.empty': 'No diary yet. Write the first day.',
      'search.placeholder': 'e.g. how was the stop-loss set?',
      'search.btn': 'Search',
      'search.idle': 'Type a question and find what you thought back then.',
      'search.busy': 'Searching…',
      'search.none': 'No hits. Try different words.',
      'search.stat': '{n} hits · {ms} ms',
      'search.scope.personal': 'Personal',
      'search.scope.memory': 'Timeline',
      'search.scope.project': 'Projects',
      'recall.recalls': 'Recalls',
      'recall.hits': 'Hit notes',
      'recall.diaries': 'Diary days',
      'recall.todos': 'Open todos',
      'recall.todosNote': 'all days',
      'recall.index': 'Index',
      'recall.ready': 'ready',
      'recall.down': 'down',
      'recall.try': 'Try a recall',
      'recall.proc': 'How this recall was assembled',
      'recall.params': '{mode} · threshold {th} · top {k} fetched · budget {chars} chars',
      'recall.candLine': '{n} candidates · {p} injected · {low} below threshold · {budget} over budget · {ms} ms',
      'recall.picked': 'injected',
      'recall.dropLow': 'below threshold',
      'recall.dropBudget': 'over budget',
      'recall.tryHint': 'Type a sentence and see which notes the automatic recall would pick (not written to the session).',
      'recall.run': 'Try',
      'recall.reindex': 'Reindex',
      'recall.reindexing': 'Reindexing…',
      'recall.reindexed': 'Index rebuilt',
      'recall.recent': 'Recent recalls',
      'recall.none': 'Nothing yet',
      'recall.noneWhy': 'The log holds {n} entries (oldest {since}), but recall rows were cleared — that is why the cards read 0',
      'recall.mounted': 'plugin mounted',
      'recall.hitUnit': 'hits',
      'recall.fromRollup': 'incl. history',
      'recall.usage': 'Recall hit rate',
      'recall.usageNote': 'last {d}d · {p}% opened later',
      'recall.usageEmpty': 'no recalls in the last {d}d',
      'recall.usageBlind': '{n} recalls in {d}d, but old log rows carry no detail — no hit rate',
      'recall.viaKeyword': 'literal',
      'recall.viaBoth': 'both',
      'recall.viaHint': 'literal = those words really appear in the text; both = semantic and literal',
      'recall.stateTitle': 'Panel state',
      'recall.stateOpen': 'See what it kept',
      'recall.stateReload': 'Refresh',
      'recall.stateHint': 'Things the panel keeps for itself (not notes): search history, stars, waits, next steps, defer chains, usage, collapse prefs. Stored in .dsh/personal-memory/state.json — deleting them only loses the conveniences, never a note.',
      'recall.stateEmpty': 'Not loaded yet. Click “See what it kept”.',
      'recall.stateMig': '{n} entries from {from} were reshaped on this read',
      'recall.stateMigNow': 'Write it back now',
      'recall.stateMigrated': 'Version written back ({n} entries reshaped)',
      'recall.stateClear': 'Clear',
      'recall.stateClearHint': 'Clears just this table; click once to arm',
      'recall.stateClearNow': 'Really clear?',
      'recall.stateCleared': 'Cleared “{k}”',
      'recall.tbl.queries': 'Search history',
      'recall.tbl.stars': 'Stars',
      'recall.tbl.ui': 'Collapse prefs',
      'recall.tbl.used': 'Notes opened',
      'recall.tbl.wait': 'Waiting on',
      'recall.tbl.next': 'Next steps',
      'recall.tbl.moved': 'Defer chains',
      'recall.tbl.usage': 'Daily usage',
      'recall.config': 'Current config',
      'recall.ws': 'Workspace',
      'recall.log': 'Log',
      'recall.nows': 'Workspace not found (needs personal/ and memory/)',
      'recall.latest': 'Latest diary',
      'note.title': 'Quick note',
      'note.hint': 'Appends one line to today\u2019s diary. Nothing else is touched.',
      'note.placeholder': 'What happened, what became clear…',
      'note.submit': 'Save',
      'note.section': 'Into',
      'note.hintKey': '\u2318 + Enter to save',
      'note.ok': 'Saved to {path}',
      'note.sec.产出': 'Output',
      'note.sec.判断': 'Judgement',
      'note.sec.未完成': 'Todo',
      'note.sec.备忘': 'Memo',
      'settings.title': 'Personal Memory',
      'settings.hint': 'personal is cognition, memory is time. The panel only reads files; quick note only appends. To change settings edit the personal-memory config in ~/.dsh/profiles/desktop/cordis.patch.yml and reload.',
    }

    /* ------------------------------------------------------------------ *
     * apply
     * ------------------------------------------------------------------ */
    function apply(ctx) {
      beacon('apply')
      try {
        applyInner(ctx)
        beacon('registered')
      } catch (error) {
        beacon('apply-error: ' + String(error?.message ?? error))
        throw error
      }
    }

    function applyInner(ctx) {
      const slots = ctx.get('slots')
      const locale = ctx.get('locale')
      if (!slots || !locale) {
        beacon('apply-missing-services: slots=' + !!slots + ' locale=' + !!locale)
        return
      }

      ctx.effect(() => locale.register(NS, { zh, en }), 'personal-memory: dictionaries')
      const t = locale.bind(NS)

      // 样式：注入一次，卸下时清掉自己注入的那份
      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {}
        let el = document.getElementById('pm-panel-styles')
        const mine = el === null
        if (mine) {
          el = document.createElement('style')
          el.id = 'pm-panel-styles'
          el.textContent = CSS
          document.head.appendChild(el)
        }
        return () => {
          if (mine && el && el.parentNode) el.parentNode.removeChild(el)
        }
      }, 'personal-memory: panel styles')

      // 侧栏入口 + 整页
      slots.inject('sidebar.panellist', () => slots.register({
        name: 'sidebar.panellist',
        id: PAGE_ID,
        order: -2,
        label: () => t('nav'),
        locale: NS,
      }, PanelIcon))

      slots.inject('main', () => slots.register({
        name: 'main',
        key: PAGE_ID,
        locale: NS,
      }, (pageProps) => h(App, { ...pageProps, t })))

      // 设置页里的只读概览
      slots.inject('settings.section', () => slots.register({
        name: 'settings.section',
        id: 'personal-memory',
        order: 55,
        label: () => t('nav'),
        locale: NS,
        inject: () => ({ api: new Api(), t }),
      }, SettingsSection))
    }

    // __parts 只给 smoke-render.mjs / preview.mjs 用：离线把每个视图都真的渲染一遍
    return {
      inject,
      apply,
      __parts: {
        locales: { zh, en },
        App,
        PanelIcon,
        MasterPersonal,
        MasterTimeline,
        MasterTodos,
        MasterSearch,
        DocReader,
        RecallTab,
        NoteModal,
        NewNoteModal,
        SettingsSection,
        renderMarkdown,
        groupPersonal,
        MasterToday,
        QuickJump,
        weekdayName,
        localDateKey,
        Api,
        phraseVariants,
      },
    }
  },
})
