/**
 * dsh-travel —— 旅行灵感面板(Web client 半)。
 *
 * 一个整页面板:按当季/四季看「该去哪、玩什么」。
 * 数据全部内置(不请求网络、不读磁盘),只依赖宿主的 react / slots / locale。
 *
 * 内容取舍:
 * - 每个目的地重点写「最好玩的事」——玩法(怎么玩、什么时候玩)、必吃、贴士,
 *   景点只是玩法的载体,不单独罗列"XX景区 AAAA"。
 * - 月份窗口是给「挑时间」用的:卡片在正当时的月份会置顶并打标。
 * - 收藏(想去)存 localStorage,丢了也只是少几颗星,不丢数据。
 */
window.__ModuleLoader__.load({
  id: 'dsh-travel',
  factory(require) {
    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback, useMemo, useRef } = React

    const NS = 'travel.panel'
    const PAGE_ID = 'travel'
    const inject = ['slots', 'locale']

    /* ------------------------------------------------------------------ *
     * 主题:只用宿主的 --dsw-alias-* token,深浅色自动跟随
     * ------------------------------------------------------------------ */
    const C = {
      bg: 'var(--dsw-alias-bg-base, #f6f7f9)',
      surface: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      surface2: 'var(--dsw-alias-bg-layer-2, #f1f2f5)',
      text: 'var(--dsw-alias-label-primary, #1f2329)',
      muted: 'color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 62%, transparent)',
      faint: 'color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 40%, transparent)',
      border: 'var(--dsw-alias-border-l2, #c7ccd4)',
      accent: 'var(--dsw-alias-brand-primary, #3b6ef6)',
      accentSoft: 'color-mix(in srgb, var(--dsw-alias-brand-primary, #3b6ef6) 12%, transparent)',
      warn: 'var(--dsw-alias-state-warn-primary, #f5a623)',
    }

    const CSS = `
.tvl-root *{box-sizing:border-box}
.tvl-root{height:100%;min-height:0;display:flex;flex-direction:column;background:${C.bg};color:${C.text};font-family:inherit;font-size:13px;padding-top:var(--dsh-frame-top-clearance,0px)}
.tvl-head{display:flex;align-items:center;gap:10px;padding:14px 20px 10px;flex:none;min-width:0;flex-wrap:wrap}
.tvl-brand{display:flex;align-items:center;gap:9px;min-width:0}
.tvl-brand>svg{color:${C.accent};flex:none}
.tvl-brand-txt{min-width:0}
.tvl-title{font-size:13.5px;font-weight:600;letter-spacing:.2px;line-height:1.25}
.tvl-sub{font-size:11px;color:${C.muted};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:44vw}
.tvl-spacer{flex:1;min-width:8px}
.tvl-search{position:relative;flex:none}
.tvl-search>svg{position:absolute;left:9px;top:50%;transform:translateY(-50%);color:${C.faint};pointer-events:none}
.tvl-input{width:250px;font:inherit;font-size:12.5px;padding:7px 10px 7px 30px;border-radius:9px;border:1px solid ${C.border};background:${C.surface};color:${C.text};outline:none;transition:border-color .12s ease,box-shadow .12s ease}
.tvl-input:focus{border-color:${C.accent};box-shadow:0 0 0 3px ${C.accentSoft}}
.tvl-input::placeholder{color:${C.faint}}
.tvl-btn{appearance:none;border:1px solid ${C.border};background:${C.surface};color:${C.text};font:inherit;font-size:12.5px;padding:6px 12px;border-radius:9px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;transition:background .12s ease,border-color .12s ease,transform .1s ease}
.tvl-btn:hover{background:${C.surface2}}
.tvl-btn:active{transform:scale(.97)}
.tvl-tabs{display:flex;gap:2px;background:${C.surface2};padding:3px;border-radius:10px;margin:0 20px;flex:none;width:fit-content}
.tvl-tab{appearance:none;border:0;background:transparent;color:${C.muted};font:inherit;font-size:12.5px;padding:6px 13px;border-radius:8px;cursor:pointer;white-space:nowrap;transition:background .12s ease,color .12s ease;display:inline-flex;align-items:center;gap:5px}
.tvl-tab:hover{color:${C.text}}
.tvl-tab.on{background:${C.surface};color:${C.text};box-shadow:0 1px 2px rgba(0,0,0,.07),0 0 0 1px ${C.border}}
.tvl-tab .tvl-ic{font-size:12px}
.tvl-tab.wish-on{color:var(--dsw-alias-state-warn-primary,#f5a623)}
.tvl-filters{display:flex;align-items:center;gap:14px;padding:10px 20px 2px;flex:none;min-height:30px;flex-wrap:wrap}
.tvl-chiprow{display:flex;gap:5px;align-items:center;flex-wrap:wrap}
.tvl-chip{appearance:none;border:1px solid ${C.border};background:transparent;color:${C.muted};font:inherit;font-size:11.5px;padding:3px 10px;border-radius:99px;cursor:pointer;transition:all .12s ease;white-space:nowrap}
.tvl-chip:hover{color:${C.text};background:${C.surface2}}
.tvl-chip.on{background:${C.text};border-color:transparent;color:${C.surface}}
.tvl-monthchip.on{background:${C.accent};color:#fff}
.tvl-count{margin-left:auto;font-size:11px;color:${C.faint};white-space:nowrap}
.tvl-body{flex:1;min-height:0;overflow:auto;padding:14px 20px 48px}
.tvl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(252px,1fr));gap:12px;max-width:1180px}
.tvl-card{position:relative;display:flex;flex-direction:column;gap:7px;text-align:left;border:1px solid ${C.border};background:${C.surface};border-radius:12px;padding:13px 14px 12px;cursor:pointer;font:inherit;color:${C.text};transition:transform .13s ease,box-shadow .13s ease,border-color .13s ease;overflow:hidden}
.tvl-card:hover{transform:translateY(-2px);box-shadow:0 6px 18px rgba(0,0,0,.09);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#3b6ef6) 40%,transparent)}
.tvl-card .tvl-seasline{position:absolute;left:0;top:0;bottom:0;width:3px;border-radius:0 2px 2px 0}
.tvl-card-top{display:flex;align-items:flex-start;gap:8px;padding-right:2px}
.tvl-card-name{font-size:14.5px;font-weight:600;line-height:1.3;flex:1;min-width:0}
.tvl-card-region{font-size:11px;color:${C.faint};white-space:nowrap;padding-top:2px}
.tvl-star{appearance:none;border:0;background:transparent;font:inherit;font-size:15px;line-height:1;cursor:pointer;padding:2px 3px;border-radius:6px;color:${C.faint};flex:none;transition:transform .12s ease,color .12s ease}
.tvl-star:hover{transform:scale(1.15);background:${C.surface2}}
.tvl-star.on{color:var(--dsw-alias-state-warn-primary,#f5a623)}
.tvl-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.tvl-window{font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:99px;white-space:nowrap}
.tvl-window.in{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#30a46c) 14%,transparent);color:var(--dsw-alias-state-success-primary,#1c8a57)}
.tvl-window.out{background:${C.surface2};color:${C.muted}}
.tvl-tagline{font-size:11.5px;color:${C.muted};line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.tvl-exps{display:flex;flex-wrap:wrap;gap:4px}
.tvl-expchip{font-size:10.5px;color:${C.muted};background:${C.surface2};padding:2.5px 8px;border-radius:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.tvl-expchip b{color:${C.text};font-weight:500}
.tvl-more{font-size:10.5px;color:${C.faint};padding:2.5px 2px;white-space:nowrap}
.tvl-kinds{display:flex;gap:4px;flex-wrap:wrap;margin-top:auto}
.tvl-kind{font-size:9.5px;color:${C.faint};border:1px solid ${C.border};padding:1px 6px;border-radius:99px}
.tvl-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:70px 20px;color:${C.muted}}
.tvl-empty .tvl-empty-ic{font-size:34px;opacity:.7}
.tvl-empty-t{font-size:13px;font-weight:600;color:${C.text}}
.tvl-empty-h{font-size:11.5px;color:${C.muted}}
.tvl-empty .tvl-btn{margin-top:10px}
.tvl-aiwrap{flex:1;min-height:0;overflow-y:auto;padding:4px 20px 24px}
.tvl-ai{max-width:1180px;margin:0 auto;border:1px solid ${C.border};border-radius:14px;background:${C.surface};padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.tvl-ai-head{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:600}
.tvl-ai-head .tvl-ai-sp{flex:1}
.tvl-ai-status{display:flex;align-items:center;gap:8px;color:${C.muted};font-size:12px}
.tvl-ai-dot{width:8px;height:8px;border-radius:50%;background:${C.accent};animation:tvl-pulse 1s ease-in-out infinite}
@keyframes tvl-pulse{0%,100%{opacity:.35}50%{opacity:1}}
.tvl-ai-intro{font-size:12.5px;line-height:1.55;color:${C.text}}
.tvl-ai-intro .tvl-ai-q{color:${C.accent};font-weight:600}
.tvl-ai-count{font-size:11.5px;color:${C.muted}}
.tvl-ai-note{font-size:10.5px;color:${C.faint}}
.tvl-ai .tvl-grid{grid-template-columns:repeat(auto-fill,minmax(240px,1fr))}
.tvl-ai .tvl-card{cursor:pointer}
.tvl-ai-err{font-size:12px;color:${C.warn};line-height:1.5}
.tvl-cursor{display:inline-block;width:7px;height:12px;background:${C.accent};vertical-align:-1px;margin-left:2px;animation:tvl-pulse .8s ease-in-out infinite}
.tvl-backdrop{position:fixed;inset:0;background:rgba(15,18,24,.42);z-index:40;animation:tvl-fade .14s ease}
@keyframes tvl-fade{from{opacity:0}to{opacity:1}}
.tvl-drawer{position:fixed;top:0;right:0;bottom:0;width:min(430px,94vw);background:${C.surface};z-index:41;display:flex;flex-direction:column;box-shadow:-12px 0 40px rgba(0,0,0,.2);animation:tvl-slide .18s ease}
@keyframes tvl-slide{from{transform:translateX(24px);opacity:0}to{transform:translateX(0);opacity:1}}
.tvl-dr-head{flex:none;padding:18px 20px 14px;border-bottom:1px solid ${C.border}}
.tvl-dr-close{position:absolute;top:10px;right:10px;appearance:none;border:0;background:transparent;color:${C.muted};font-size:16px;cursor:pointer;padding:6px 9px;border-radius:8px;line-height:1}
.tvl-dr-close:hover{background:${C.surface2};color:${C.text}}
.tvl-dr-season{font-size:10.5px;font-weight:600;letter-spacing:.4px;padding:2px 9px;border-radius:99px;color:#fff}
.tvl-dr-name{font-size:21px;font-weight:700;line-height:1.25;margin-top:9px;display:flex;align-items:baseline;gap:9px;flex-wrap:wrap}
.tvl-dr-name small{font-size:12px;font-weight:500;color:${C.muted}}
.tvl-dr-tagline{font-size:12px;color:${C.muted};margin-top:5px;line-height:1.55}
.tvl-dr-window{margin-top:10px;display:inline-flex}
.tvl-dr-body{flex:1;min-height:0;overflow:auto;padding:16px 20px 44px}
.tvl-sec{margin-bottom:20px}
.tvl-sec-h{font-size:11px;font-weight:700;letter-spacing:.5px;color:${C.faint};text-transform:uppercase;display:flex;align-items:center;gap:6px;margin-bottom:9px}
.tvl-sec-h .tvl-sec-n{color:${C.muted};font-weight:500;letter-spacing:0}
.tvl-exp{display:flex;gap:10px;padding:9px 10px;border:1px solid ${C.border};border-radius:10px;margin-bottom:7px;background:${C.bg}}
.tvl-exp-ic{flex:none;width:30px;height:30px;border-radius:8px;background:${C.surface};border:1px solid ${C.border};display:flex;align-items:center;justify-content:center;font-size:15px}
.tvl-exp-main{flex:1;min-width:0}
.tvl-exp-name{font-size:12.5px;font-weight:600;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.tvl-exp-when{font-size:10px;color:${C.faint};font-weight:500}
.tvl-exp-why{font-size:11.5px;color:${C.muted};line-height:1.55;margin-top:3px}
.tvl-foodrow{display:flex;flex-wrap:wrap;gap:6px}
.tvl-food{font-size:11px;padding:4px 11px;border-radius:99px;background:${C.surface2};color:${C.text};border:1px solid ${C.border}}
.tvl-foodgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(158px,1fr));gap:10px}
.tvl-foodcard{border:1px solid ${C.border};border-radius:10px;overflow:hidden;background:${C.surface2};display:flex;flex-direction:column}
.tvl-foodimg{width:100%;aspect-ratio:4/3;object-fit:cover;display:block;background:linear-gradient(135deg,${C.surface2},${C.border})}
.tvl-foodimg.ph{display:flex;align-items:center;justify-content:center;font-size:28px;background:linear-gradient(135deg,${C.surface2},${C.border})}
.tvl-foodcard-b{padding:8px 10px 10px;display:flex;flex-direction:column;gap:3px}
.tvl-foodcard-n{font-size:12.5px;font-weight:700;color:${C.text}}
.tvl-foodcard-d{font-size:11px;line-height:1.45;color:${C.muted}}
.tvl-foodcard-w{font-size:10.5px;color:${C.faint}}
.tvl-fcard .tvl-fc-img{width:100%;height:132px;object-fit:cover;display:block;border-radius:9px;margin-bottom:2px}
.tvl-fc-img.ph{display:flex;align-items:center;justify-content:center;font-size:34px;height:132px;background:linear-gradient(135deg,${C.surface2},${C.border})}
.tvl-fc-dishes{display:flex;flex-direction:column;gap:4px}
.tvl-fc-dish{font-size:11.5px;line-height:1.4;color:${C.muted}}
.tvl-fc-dish b{color:${C.text};font-weight:700}
.tvl-fc-more{font-size:10.5px;color:${C.faint}}
.tvl-tip{display:flex;gap:8px;font-size:11.5px;color:${C.muted};line-height:1.6;padding:5px 0}
.tvl-tip-ic{flex:none;color:${C.warn}}
.tvl-dr-wish{position:absolute;top:10px;right:44px;display:inline-flex}
.tvl-dr-wish .tvl-btn.sm{font-size:11px;padding:4px 10px;border-radius:8px}
.tvl-btn.sm.on{border-color:var(--dsw-alias-state-warn-primary,#f5a623);color:var(--dsw-alias-state-warn-primary,#f5a623);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f5a623) 9%,transparent)}
.tvl-nowline{padding:2px 20px 0;font-size:11px;color:${C.faint};flex:none}
.tvl-nowline b{color:${C.muted}}
@media (max-width:560px){.tvl-input{width:150px}.tvl-grid{grid-template-columns:1fr 1fr}}
@media (max-width:400px){.tvl-grid{grid-template-columns:1fr}}
`

    /* ------------------------------------------------------------------ *
     * 数据:四季目的地。字段:
     *   id      稳定 id(收藏用)
     *   name    目的地名   region 省/区域
     *   season  主季       months 最佳月份(1-12)
     *   tagline 一句话     kinds  玩法标签(筛选用)
     *   x[]     最好玩的事 {e emoji, n 名字, w 什么时候玩, d 为什么好玩/怎么玩}
     *   f[]     必吃       t[]    贴士/避坑
     * ------------------------------------------------------------------ */
    const SEASONS = [
      { id: 'spring', label: '春', icon: '🌷', months: [3, 4, 5] },
      { id: 'summer', label: '夏', icon: '🌊', months: [6, 7, 8] },
      { id: 'autumn', label: '秋', icon: '🍁', months: [9, 10, 11] },
      { id: 'winter', label: '冬', icon: '❄️', months: [12, 1, 2] },
    ]
    const SEASON_COLOR = { spring: '#e0728f', summer: '#2f9de4', autumn: '#dd8a2c', winter: '#57a0c4' }
    const ALL_KINDS = ['花', '海', '雪', '山', '草原', '古村', '人文', '美食', '摄影', '星空', '温泉', '徒步', '玩水', '骑行', '避暑', '反季', '户外', '森林']

    const DESTS = [
      /* ================= 春 ================= */
      {
        id: 'luoping', name: '罗平', region: '云南', season: 'spring', months: [2, 3, 4],
        tagline: '80 万亩油菜花在喀斯特峰林间铺到天边,金色是这里的底色。',
        kinds: ['花', '摄影', '户外'],
        x: [
          { e: '🌄', n: '金鸡峰丛看日出', w: '日出前后半小时', d: '登上观景台,晨雾从峰林间流过、花海在脚下铺开——这是「中国最美峰林花海」的标准镜头,拍出来就是明信片。' },
          { e: '🌀', n: '螺蛳田看梯田花圈', w: '白天', d: '一圈圈金色梯田绕着中间的孤峰,和婺源是完全不同的几何感,无人机/长焦都出片。' },
          { e: '💦', n: '九龙瀑布群', w: '雨后水量更好', d: '十级瀑布层层叠叠,坐缆车上去再沿栈道往下走,一路都是水声。' },
          { e: '🛶', n: '多依河竹筏漂流', w: '午后', d: '慢悠悠漂过布依族村寨和水车,顺手吃一顿花米饭,是花海之外的松弛感。' },
        ],
        f: ['五色花米饭', '菜籽油炸豌豆粉', '土蜂蜜'],
        t: ['2 月底–3 月初花最旺,3 月中旬开始凋谢,别踩空。', '阴雨天别放弃:云雾绕峰林的片子比晴天更绝。', '县城住宿便宜,建议住两晚,日出日落各拍一次。'],
      },
      {
        id: 'wuyuan', name: '婺源', region: '江西', season: 'spring', months: [3, 4],
        tagline: '白墙黛瓦插在金色花海里,徽州春天的模板。',
        kinds: ['花', '古村', '摄影'],
        x: [
          { e: '🌼', n: '江岭万亩梯田花海', w: '3 月中–4 月初', d: '层层梯田从山顶挂到谷底,站在栈道上往下看,云雾从花田里升起来。' },
          { e: '🚠', n: '篁岭索道 + 花溪水街', w: '全程', d: '坐索道悬在花田上空,再逛水街古巷,一个村子看两种春。' },
          { e: '🛶', n: '月亮湾竹筏', w: '清晨', d: '一小片沙洲弯成月牙,撑筏的二伯会把你划到最好拍的角度。' },
          { e: '🏮', n: '思溪延村古村慢逛', w: '午后', d: '比李坑清净得多的儒商古宅群,走累了在老宅天井里喝杯婺源绿茶。' },
          { e: '🌉', n: '彩虹桥', w: '顺路', d: '南宋廊桥,桥下溪水很浅,可以脱了鞋坐在桥墩上发呆。' },
        ],
        f: ['清明果(艾草粿)', '蒸汽糕', '荷包红鲤鱼', '糊豆腐'],
        t: ['周末人流爆炸,能请出工作日就来工作日。', '住一晚山里民宿:第二天 6 点的晨雾值回所有早起。', '理坑、察关人少景不输,包车师傅都知道。'],
      },
      {
        id: 'nyingchi', name: '林芝', region: '西藏', season: 'spring', months: [3, 4, 5],
        tagline: '雪山的脚下桃花开成河,春天西藏最温柔的打开方式。',
        kinds: ['花', '山', '摄影'],
        x: [
          { e: '🌸', n: '嘎拉桃花沟', w: '3 月底–4 月中', d: '上百年野桃树在缓坡上散开,花瓣落在青稞地里,粉的粉、绿的绿。' },
          { e: '🏔️', n: '索松村看南迦巴瓦', w: '清晨/日落', d: '村子的正对面就是「羞女峰」,春天云少,日出把雪山染成金红色的概率最高。' },
          { e: '🏞️', n: '雅鲁藏布大峡谷', w: '全程', d: '在峡谷观景台把"桃花+江水+雪山"收进一张照片,别处没有这种三合一。' },
          { e: '🚲', n: '尼洋河畔骑行', w: '午后', d: '沿河骑行道平缓,河水是那种不真实的蓝绿色,骑到哪都是画。' },
        ],
        f: ['石锅鸡', '酥油茶', '藏面'],
        t: ['海拔 3000+:头两天不洗澡、不喝酒、走路慢半拍。', '桃花节期间索松村住宿翻倍,提前 2–3 周订。', '3 月底桃花节开幕,但花期逐年浮动,出发前看当地花讯。'],
      },
      {
        id: 'yili-xinghua', name: '伊犁杏花沟', region: '新疆', season: 'spring', months: [4],
        tagline: '野杏花开满整面山坡,一年只开 7–10 天的限定款。',
        kinds: ['花', '摄影', '草原'],
        x: [
          { e: '🌅', n: '吐尔根日出斜光', w: '日出后 1 小时', d: '低角度光扫过山坡,明暗把野杏花衬出一层层的立体感——摄影师嘴里的「必去一次」就是它。' },
          { e: '🐑', n: '牧民转场', w: '4 月上旬', d: '运气好能撞上羊群从花海里穿过去,杏花沟最生动的一帧。' },
          { e: '🐎', n: '那拉提草原初春骑马', w: '午后', d: '雪线还没完全退,草原刚返青,骑马过河谷比夏天清爽。' },
          { e: '🎶', n: '伊宁六星街手风琴馆', w: '进城晚上', d: '百年手风琴收藏 + 现场拉一首,伊犁的俄式风情都在这条街上。' },
        ],
        f: ['烤包子', '手抓饭', '卡瓦斯(蜂蜜发酵饮)'],
        t: ['花期极短(约 4 月初 7–10 天),盯紧当地花讯再买票,但机票别等最后一天。', '山坡土路雨后泥泞,穿防滑鞋。', '附近大西沟福寿山可作备选,人少花也密。'],
      },
      {
        id: 'luoyang', name: '洛阳', region: '河南', season: 'spring', months: [4],
        tagline: '十三朝古都的春天:牡丹开城,满街汉服。',
        kinds: ['花', '人文', '美食'],
        x: [
          { e: '🌺', n: '赏牡丹', w: '4 月,早上', d: '王城公园、中国国花园挑一个就好,姚黄魏紫名品都在;牡丹只有约 3 周花期,过了就等明年。' },
          { e: '🪷', n: '龙门石窟夜景', w: '日落后的夜场', d: '灯光打在卢舍那大佛上的样子,比白天多一层"慈悲"——夜场票要单独买,值。' },
          { e: '👘', n: '洛邑古城穿汉服', w: '傍晚', d: '全城都是汉服店,妆造几十到几百任选,穿着汉服在古城夜景里走一圈,体验感拉满。' },
          { e: '✨', n: '应天门灯光秀', w: '晚上整点', d: '城楼立面变成巨幕,隋唐洛阳城的辉煌用灯光重演一遍。' },
        ],
        f: ['洛阳水席(牡丹燕菜)', '牛肉汤 + 饼丝', '浆面条'],
        t: ['牡丹文化节(4 月)酒店翻倍,提前订;看牡丹赶早,上午精神最好。', '汉服妆造店提前一天预约,现场等位要 1–2 小时。', '白马寺是第一座官办寺院,留半天,很静。'],
      },
      {
        id: 'wuhan', name: '武汉', region: '湖北', season: 'spring', months: [3],
        tagline: '樱花开满东湖,顺便把"过早"文化吃个遍。',
        kinds: ['花', '人文', '美食'],
        x: [
          { e: '🌙', n: '东湖樱园看夜樱', w: '3 月中下,晚上', d: '灯光下的樱花像粉色细雪,夜樱比白天美一个档次,还不用跟白天的人流挤。' },
          { e: '🚲', n: '东湖绿道骑行', w: '白天', d: '湖边骑行道穿过樱园、梅园和湿地,是国内城市里少有的大手笔绿道。' },
          { e: '⛴️', n: '长江轮渡过江', w: '日落前', d: '1.5 元的市民轮渡,十几分钟看两江四岸,比观光船便宜一百倍。' },
          { e: '🍜', n: '粮道街"过早"', w: '早上 7–9 点', d: '热干面、豆皮、糊汤粉、蛋酒……武汉人的早餐江湖,空着肚子去。' },
        ],
        f: ['热干面', '三鲜豆皮', '糊汤粉 + 油条', '蛋酒'],
        t: ['樱花季 3 月中下旬,武大樱园需要预约。', '"过早"不设座是常态,端着边走边吃才地道。', '轮渡选武昌中华路 ↔ 汉口武汉关这条线,风景最好。'],
      },
      {
        id: 'wuxi', name: '无锡', region: '江苏', season: 'spring', months: [3, 4],
        tagline: '鼋头渚樱花遇上太湖,号称"中华第一赏樱地"。',
        kinds: ['花', '摄影'],
        x: [
          { e: '🌸', n: '鼋头渚樱花谷', w: '3 月底前后 1 周', d: '三万株樱树沿太湖铺开,游船从花瓣雨里穿过去——比京都还夸张的樱花隧道。' },
          { e: '🌃', n: '夜樱灯光场', w: '盛花期晚上', d: '夜晚打灯的樱花是蓝紫色梦境,记得查"夜樱开放日"再订行程。' },
          { e: '⛩️', n: '拈花湾禅意小镇', w: '傍晚到夜里', d: '仿唐风小镇,晚上有亮灯和禅行演出,适合慢慢逛到打烊。' },
          { e: '🏯', n: '惠山古镇祠堂群', w: '雨天备用', d: '118 座祠堂排成一条街,雨天坐在老茶馆里听雨,另有一种江南。' },
        ],
        f: ['无锡小笼(甜口!)', '酱排骨', '太湖三白'],
        t: ['染井吉野盛放只有约一周(3 月底),行程要卡准。', '鼋头渚早上 7 点前进园,能拍无人空镜。', '太湖边风大,春天带件防风外套。'],
      },
      {
        id: 'hangzhou', name: '杭州', region: '浙江', season: 'spring', months: [3, 4, 5],
        tagline: '春有桃柳夹堤,还有一季一次的明前龙井。',
        kinds: ['花', '人文', '徒步'],
        x: [
          { e: '🌱', n: '龙井村喝明前茶', w: '3 月底–4 月', d: '赶在谷雨前,去茶农家里喝刚炒出来的明前龙井,顺手买二两,山下卖价的三分之一。' },
          { e: '🌸', n: '苏堤/白堤桃柳春晓', w: '清晨', d: '早上的西湖还没醒,桃红柳绿夹着水汽,是白居易诗里的那条堤。' },
          { e: '🌲', n: '九溪烟树徒步', w: '全程', d: '溪水、茶田、枫杨林,从龙井村一路走到钱塘江边,4 公里洗肺线。' },
          { e: '🛶', n: '西溪湿地摇橹船', w: '午后', d: '摇橹的船娘带你钻进芦苇迷宫,比西湖安静十倍。' },
        ],
        f: ['龙井虾仁', '片儿川', '定胜糕'],
        t: ['周末西湖景区限行,地铁 + 骑行最省心。', '买茶先喝再买,认住"明前"不是噱头,是日期。', '4 月中后进入雨季,带把伞,雨中西湖反而是水墨画。'],
      },
      {
        id: 'qiandongnan', name: '黔东南', region: '贵州', season: 'spring', months: [4, 5],
        tagline: '梯田灌水映天光,侗寨鼓楼里有人生第一场合唱。',
        kinds: ['人文', '古村', '摄影'],
        x: [
          { e: '🎤', n: '肇兴侗寨听侗族大歌', w: '晚上鼓楼', d: '没有指挥、没有伴奏的多声部合唱,从鼓楼里传出来的时候会起鸡皮疙瘩。' },
          { e: '🍻', n: '长桌宴 + 高山流水', w: '晚上', d: '几十米长桌摆满酸汤鱼,米酒顺着竹竿"高山流水"倒进嘴里,躲不掉也别躲。' },
          { e: '🥾', n: '堂安梯田徒步', w: '清晨', d: '从肇兴徒步上堂安(约 1.5h),4–5 月梯田灌水,像一层层镜子叠在山上。' },
          { e: '🖼️', n: '加榜梯田', w: '4–5 月', d: '路程远但值得:苗寨吊脚楼直接"挂"在梯田边上,日出时云海灌进田里。' },
          { e: '🖌️', n: '侗布蜡染体验', w: '雨天/午后', d: '亲手画一块蜡染带回家,比任何纪念品都有来处。' },
        ],
        f: ['酸汤鱼', '腌鱼', '糯米饭'],
        t: ['4–5 月灌水季是全年出片窗口。', '侗寨夜里比白天好看,住寨子里。', '苗银和水酒别在景区正价买,找当地人。'],
      },

      /* ================= 夏 ================= */
      {
        id: 'pingtan', name: '平潭', region: '福建', season: 'summer', months: [4, 5, 6, 7, 8],
        tagline: '追一场"蓝眼泪":海浪在夜里发出荧光蓝。',
        kinds: ['海', '星空', '摄影'],
        x: [
          { e: '✨', n: '夜里追蓝眼泪', w: '4–8 月,5–6 月高发', d: '发光浮游生物被浪打上岸,海水一拍就泛起荧光蓝——追泪要靠概率,连住两晚 + 盯当地"蓝眼泪预报"。' },
          { e: '🪨', n: '北港石头厝村落', w: '白天', d: '彩色石头房子面朝大海,《爸爸去哪儿》取景地,找家石头厝咖啡店坐一下午。' },
          { e: '🚲', n: '环岛路骑行风车田', w: '傍晚', d: '一边是海一边是白色风车,傍晚逆光骑过去,随手都是电影感。' },
          { e: '🎣', n: '夜钓鱿鱼', w: '夏夜', d: '跟渔民出海夜钓,鱿鱼上钩时会变色的体验,钓上来直接船上白灼。' },
        ],
        f: ['海蛎饼', '鱼丸', '时来运转(平潭特色小吃)'],
        t: ['蓝眼泪多在无月亮的夜晚 + 南风天,先查月相再定行程。', '岛上风极大,防晒和外套都要带。', '夜骑追泪结伴走,手电必备。'],
      },
      {
        id: 'qingdao', name: '青岛', region: '山东', season: 'summer', months: [6, 7, 8],
        tagline: '红瓦绿树、碧海蓝天,再加一袋用塑料袋装的散啤。',
        kinds: ['海', '美食', '人文'],
        x: [
          { e: '🏰', n: '八大关 + 海边木栈道', w: '上午', d: '万国建筑夹在梧桐树里,从花石楼沿着木栈道走到第二海水浴场,老青岛的精华全在这条线上。' },
          { e: '🍺', n: '啤酒博物馆喝原浆', w: '下午', d: '进厂线走到头有一杯刚灌的原浆和一包啤酒豆,比罐装好喝一个量级。' },
          { e: '⛰️', n: '崂山仰口线', w: '晴天', d: '索道上去,山海相连的那种蓝,是青岛独有的配色。' },
          { e: '🦐', n: '夜市散啤 + 烤海鲜', w: '晚上', d: '拎着塑料袋装的原浆散啤坐在马扎上,配烤生蚝——青岛夏夜的官方姿势。' },
        ],
        f: ['辣炒蛤蜊(gala)', '鲅鱼水饺', '海菜凉粉', '原浆啤酒'],
        t: ['7 月初比 8 月人少一半,8 月有国际啤酒节但房价起飞。', '下海选正规浴场,礁石区不熟别下去。', '崂山台风季会临时关闭,行程留弹性。'],
      },
      {
        id: 'dalian', name: '大连', region: '辽宁', season: 'summer', months: [6, 7, 8],
        tagline: '北方的海是凉的、清的,还能亲手挖一桶蚬子。',
        kinds: ['海', '户外', '美食'],
        x: [
          { e: '🦪', n: '赶海挖蚬子', w: '退潮前后 2 小时', d: '小付家庄、夏家河子退潮后滩涂全是蛤蜊,查好潮汐表,拎桶拿耙,晚上白灼就是战利品。' },
          { e: '🥾', n: '滨海路徒步', w: '清晨', d: '沿海木栈道从海之韵走到星海广场,一段一段走,累了坐观光巴士接力。' },
          { e: '⚓', n: '渔人码头', w: '日落前', d: '渔船桅杆 + 欧式码头,日落时分坐在堤坝上吃现开的海胆。' },
          { e: '🕊️', n: '星海广场喂海鸥', w: '全程', d: '火腿肠举高,海鸥会悬停在手上取食,孩子和大人都会尖叫。' },
        ],
        f: ['海胆', '焖子', '铁板鱿鱼', '海凉粉'],
        t: ['赶海先查"潮汐表"小程序,大风天滩涂关闭。', '夏天大连 25 度左右,晚上海边要外套。', '发现王国适合亲子,纯玩海的可跳过。'],
      },
      {
        id: 'hulunbuir', name: '呼伦贝尔', region: '内蒙古', season: 'summer', months: [6, 7, 8],
        tagline: '草原的尽头是云,越野车开进去,人就变成一个点。',
        kinds: ['草原', '户外', '摄影'],
        x: [
          { e: '🚙', n: '越野穿越莫日格勒河', w: '全天', d: '老舍写的"天下第一曲水",越野车翻过山丘,每一弯都像 Windows 壁纸成精。' },
          { e: '🐎', n: '骑马进草原腹地', w: '傍晚', d: '从马倌带路的小马场骑到河边,新人也能控住——比景区拍照式骑马有意思得多。' },
          { e: '🌌', n: '蒙古包看银河', w: '夜里', d: '草原没有一丝光污染,银河亮到不需要修图;篝火晚会就在包外。' },
          { e: '🍞', n: '恩和/室韦俄式村庄', w: '顺路', d: '木刻楞房子里住一晚,女主人的蓝莓酱列巴配奶茶,是草原最好的早餐。' },
        ],
        f: ['手把肉', '列巴', '蓝莓酱', '锅茶'],
        t: ['6 月中下旬草最绿、游客最少;7 月中以后人多。', '昼夜温差 15 度+,长袖外套必带。', '包车选本地司机,草原没信号,别跟低价团。'],
      },
      {
        id: 'qinghaihu', name: '青海湖', region: '青海', season: 'summer', months: [7, 8],
        tagline: '7 月的青海湖:一半是湖,一半是油菜花。',
        kinds: ['摄影', '户外', '星空'],
        x: [
          { e: '🚴', n: '环湖骑行', w: '7–8 月', d: '360 公里环湖公路,骑行 4 天全程或挑 2 天精华段,是中国最经典的骑行路线。' },
          { e: '🌻', n: '油菜花海 + 蓝湖同框', w: '7 月中–8 月初', d: '湖边全是金黄花田,牧民收 10–20 元让你进花田直通湖边,拍照无遮挡。' },
          { e: '🌅', n: '黑马河看日出', w: '日出', d: '太阳从湖面跳出来的瞬间,整个湖变成金红色,湖边的经幡一起飘。' },
          { e: '🪞', n: '茶卡盐湖"天空之镜"', w: '早上', d: '盐湖水面平得像镜子,越早人越少、倒影越完整,下午风大就花了。' },
          { e: '🌠', n: '高原银河', w: '夜里', d: '海拔 3200 的夜空通透,躺在湖边数卫星过境。' },
        ],
        f: ['老酸奶', '牦牛肉干', '羊肉尕面片'],
        t: ['海拔 3000+,第一天别跑跳,多喝水。', '盐湖要走浅水区穿鞋套,手机进水不保修。', '7 月中-8 月初花最好,8 月底花就谢了。'],
      },
      {
        id: 'yili', name: '伊犁', region: '新疆', season: 'summer', months: [6, 7, 8],
        tagline: '赛里木湖、那拉提、独库公路——夏天的新疆精华都在这条线上。',
        kinds: ['草原', '摄影', '户外'],
        x: [
          { e: '💧', n: '赛里木湖环湖', w: '上午顺光', d: '"大西洋最后一滴眼泪",湖水蓝得分层,环湖公路随时停车,别只呆在门口观景台。' },
          { e: '🏇', n: '那拉提空中草原骑马', w: '午后', d: '海拔两千的"空中草原",骑马上去看雪岭云杉和羊群,哈萨克牧民的马最稳。' },
          { e: '🛣️', n: '独库公路自驾', w: '6–9 月通车', d: '纵贯天山的公路,一天之内经历四季:雪山、峡谷、草原、河谷,每天限时段放行。' },
          { e: '💜', n: '霍城薰衣草田', w: '6 月中', d: '世界薰衣草三大产区之一,过了 6 月中就收割,时机比选园子重要。' },
          { e: '🧊', n: '伊宁手工冰淇淋', w: '全天', d: '喀赞其民俗区蓝色小巷里,5 块钱一份蛋奶香浓的手工冰淇淋。' },
        ],
        f: ['大盘鸡', '马肠子', '手工冰淇淋', '格瓦斯'],
        t: ['独库公路出发前查通车和放行时段公告。', '新疆时差 2 小时,日落 21 点,一天能玩很久。', '紫外线极强,防晒帽 + 冰袖别省。'],
      },
      {
        id: 'changbaishan', name: '长白山', region: '吉林', season: 'summer', months: [6, 7, 8],
        tagline: '山顶是 22 度的天池,山脚是 40 度的温泉蛋。',
        kinds: ['山', '避暑', '温泉'],
        x: [
          { e: '🌋', n: '天池', w: '上午(雾最少)', d: '中国最深的高山湖泊,晴天时湖水蓝得发黑——天池看运气,上午机会最大,先看天再选坡。' },
          { e: '♨️', n: '温泉煮蛋 + 泡汤', w: '下山后', d: '聚龙温泉群把鸡蛋煮出硫磺香,下山吃一枚,再泡个露天温泉,腿废了也值。' },
          { e: '🌼', n: '高山花园', w: '6 月底', d: '苔原带上野花一次性全开,像有人往山坡上倒了一桶颜料。' },
          { e: '💧', n: '长白瀑布 + 绿渊潭', w: '全程', d: '瀑布落下时水雾在阳光里架起彩虹,绿渊潭的水绿得不讲道理。' },
        ],
        f: ['温泉蛋', '朝鲜族冷面', '山野菜', '人参鸡汤'],
        t: ['北坡台阶多、西坡 1442 级台阶,膝盖不好选北坡。', '山顶风大,夏天也要带羽绒服(山顶可租)。', '天池 6 月中前可能还有冰,想看"全蓝"选 7–8 月。'],
      },
      {
        id: 'libo', name: '荔波', region: '贵州', season: 'summer', months: [6, 7, 8],
        tagline: '小七孔的水是"绿宝石色",夏天就该泡在水里。',
        kinds: ['玩水', '避暑', '徒步'],
        x: [
          { e: '💚', n: '小七孔一路玩水', w: '全程', d: '从 68 级跌水瀑布一路往上,浅滩可以踩水,走到卧龙潭看那种不真实的孔雀蓝。' },
          { e: '🛶', n: '鸳鸯湖划船', w: '午后', d: '两个湖被水迷宫连着,自己划船钻树洞,迷路也是乐趣。' },
          { e: '🌉', n: '大七孔天生桥', w: '顺路', d: '一座山自己"拱"成的桥,峡谷里走栈道,阴凉又震撼。' },
          { e: '🚣', n: '水春河漂流', w: '上午', d: '峡谷激流漂,落差不大但够湿身,夏天最解气的降温方式。' },
        ],
        f: ['杨梅汤', '烤鱼', '酸肉'],
        t: ['门票两天有效,慢慢玩不亏。', '7–8 月雨季,水大时部分路段戏水区关闭。', '带换洗衣物和防水袋,玩水项目从头湿到尾。'],
      },
      {
        id: 'daocheng', name: '稻城亚丁', region: '四川', season: 'summer', months: [6, 7, 8],
        tagline: '牛奶海和五色海——脚最疼的一天,眼睛最饱的一天。',
        kinds: ['徒步', '山', '摄影'],
        x: [
          { e: '🥾', n: '徒步牛奶海 + 五色海', w: '早上 7 点出发', d: '洛绒牛场骑马/徒步上山,海拔 4600 的两个海子,颜色像调色盘打翻——往返 7–8 小时,累但值得。' },
          { e: '🏔️', n: '洛绒牛场看夏诺多吉', w: '清晨', d: '雪山三怙主一字排开,清晨从牛场草甸看过去,金字塔状的雪峰贴在蓝天上。' },
          { e: '🌲', n: '冲古寺草坪 + 仙乃日', w: '第一天', d: '相对轻松的短线:栈道绕着仙乃日雪山下的圣湖珍珠海走一圈,练体力也适应海拔。' },
          { e: '🌌', n: '香格里拉镇星空', w: '夜里', d: '住宿海拔较低,睡前在停车场抬头,银河清晰得过分。' },
        ],
        f: ['牦牛肉汤锅', '酥油茶', '青稞饼'],
        t: ['高反因人而异,别剧烈运动,感到不适就下撤——山永远在。', '租马限量,旺季 6 点排队;徒步多带水和高糖零食。', '长线门票当日有效,安排两天:短线适应 + 长线登顶。'],
      },
      {
        id: 'weizhoudao', name: '涠洲岛', region: '广西', season: 'summer', months: [5, 6, 10],
        tagline: '中国最年轻的火山岛,骑着小电驴环岛看日落。',
        kinds: ['海', '骑行', '摄影'],
        x: [
          { e: '🌋', n: '鳄鱼山火山地质公园', w: '上午', d: '火山岩被海浪切出千层 cliffs,栈道贴着海走,黑色礁石配蓝海,很出片。' },
          { e: '🌇', n: '滴水丹屏看日落', w: '日落前 1 小时', d: '崖壁上的水珠在夕阳里像屏风,是岛上公认的日落机位王。' },
          { e: '🛵', n: '小电驴环岛', w: '全天', d: '租一辆小电驴,环岛路一侧是蕉林一侧是海,想去哪个湾就停在哪。' },
          { e: '🌊', n: '五彩滩日出赶海', w: '日出 + 退潮', d: '海蚀平台上退潮后留下一汪汪水洼,倒映朝霞,还能翻到小螃蟹。' },
          { e: '🤿', n: '石螺口浮潜', w: '午后', d: '珊瑚礁就在岸边,浮潜看小鱼,装备可以现场租。' },
        ],
        f: ['海鲜市场自选加工', '火山香蕉', '蕉叶糍'],
        t: ['台风前后船停航,返程船票提前买并盯通知。', '岛上住宿南湾最热闹,五彩滩附近适合看日出。', '防晒拉满:海面紫外线比城市狠得多。'],
      },

      /* ================= 秋 ================= */
      {
        id: 'kanas', name: '喀纳斯', region: '新疆', season: 'autumn', months: [9, 10],
        tagline: '金色的白桦林配湖水蓝,中国秋天的"天花板"之一。',
        kinds: ['摄影', '森林', '山'],
        x: [
          { e: '🌫️', n: '禾木村晨雾炊烟', w: '日出前后', d: '爬上观景台俯瞰:木屋的炊烟和晨雾混在一起,金色白桦林在后面接住第一缕光。' },
          { e: '🌊', n: '喀纳斯三湾', w: '清晨', d: '神仙湾的晨雾、月亮湾的 S 弯、卧龙湾的蓝——坐区间车一站站跳下来看。' },
          { e: '🔭', n: '观鱼台俯瞰湖', w: '上午', d: '1068 级台阶换一个上帝视角:整个喀纳斯湖像一条蓝龙盘在山谷里。' },
          { e: '🐎', n: '骑马进白桦林深处', w: '午后', d: '马道穿过金色林海,落叶踩上去沙沙响,是自驾给不了的体验。' },
        ],
        f: ['烤狗鱼(湖鱼)', '手抓肉', '奶疙瘩'],
        t: ['9 月中–10 月初金色最盛;10 月中后大雪,说封就封。', '住禾木村一晚才能看到晨雾,门票区间车分程买。', '早晚零下,羽绒服 + 手套别嫌夸张。'],
      },
      {
        id: 'ejina', name: '额济纳', region: '内蒙古', season: 'autumn', months: [10],
        tagline: '胡杨"一千年不死"的传说,一年只给你 20 天的金色。',
        kinds: ['摄影', '户外'],
        x: [
          { e: '🍂', n: '胡杨林四道桥",英雄林"', w: '10 月上旬', d: '《英雄》里张曼玉章子怡打斗的那片胡杨,树形最狂野,金色也最密。' },
          { e: '🌅', n: '怪树林日落剪影', w: '日落', d: '成片枯死的胡杨以狰狞姿态站在戈壁上,日落的剪影是"大漠孤烟"本漠。' },
          { e: '🛕', n: '黑水城遗址', w: '白天', d: '西夏古城废墟,配着黄沙和残塔,历史感扑面。' },
          { e: '🌾', n: '居延海日出', w: '日出', d: '戈壁里的一汪湖,芦苇荡里飞起成群水鸟,谁也想不到沙漠深处还有这景。' },
        ],
        f: ['烤全羊', '额济纳蜜瓜(甜到齁)', '奶茶'],
        t: ['金色窗口约 10 月 5–20 日,最旺在 10 月上旬。', '住宿提前 1 个月订,临河的"一道桥-八道桥"景区间有小车接驳。', '昼夜温差 20 度,早上 2 度中午 25 度是常态。'],
      },
      {
        id: 'huangling', name: '篁岭·晒秋', region: '江西', season: 'autumn', months: [9, 10, 11],
        tagline: '白墙黛瓦上晒满辣椒黄菊——"晒秋"二字的本尊。',
        kinds: ['摄影', '古村'],
        x: [
          { e: '🌶️', n: '晒秋人家', w: '全程,10 月最壮观', d: '家家户户把辣椒、菊花、玉米晒在晒台上,从天街往下看是挂在山崖上的调色盘。' },
          { e: '🚠', n: '索道俯瞰梯田稻浪', w: '上午', d: '上山索道正对梯田,9 月是金色稻浪,10 月收割后又是另一种肌理。' },
          { e: '🌫️', n: '石城红枫晨雾', w: '11 月中,6 点前', d: '摄影圈朝圣地:红枫 + 炊烟 + 晨雾,天亮前占好机位,太阳一出来全场快门声一片。' },
          { e: '🏘️', n: '晓起/江湾古村', w: '顺路', d: '千年古樟和徽派老宅,游客比春天少,逛起来从容。' },
        ],
        f: ['荷包红鲤鱼', '蒸汽糕', '菊花茶(自家晒的)'],
        t: ['石城晨雾要住在山里,5 点半摸黑上山。', '晒秋全程都有,但辣椒最红是 9–10 月。', '和春天的婺源是两副面孔,来两次都不亏。'],
      },
      {
        id: 'aershan', name: '阿尔山', region: '内蒙古', season: 'autumn', months: [9, 10],
        tagline: '火山、天池、金色林海——秋天的小兴安岭把颜色用到了极致。',
        kinds: ['森林', '摄影', '温泉'],
        x: [
          { e: '🌫️', n: '不冻河晨雾', w: '日出前后', d: '零度空气遇上海水一般恒温的河水,雾气贴着金色的河岸流,牛群从雾里走出来。' },
          { e: '🫐', n: '驼峰岭天池', w: '上午', d: '火山口湖像一颗蓝宝石嵌在金色林海中央,栈道绕一圈每个角度都好拍。' },
          { e: '🌋', n: '石塘林火山岩', w: '全程', d: '熔岩冷却后的"石海"上长出偃松和地衣,外星球地貌。' },
          { e: '🦌', n: '白狼镇鹿园', w: '午后', d: '梅花鹿从手里吃苔藓,金色松林当背景,顺手就能出"奈良感"照片。' },
        ],
        f: ['野生蘑菇宴', '冷水鱼', '柳蒿芽'],
        t: ['9 月底–10 月初秋色最旺,一过 10 月中就落雪。', '早晚已经零下,厚外套 + 帽子必带。', '阿尔山机场航班少且贵,飞乌兰浩特自驾 4 小时是常规替代。'],
      },
      {
        id: 'wulanbutong', name: '乌兰布统', region: '内蒙古', season: 'autumn', months: [9, 10],
        tagline: '白桦、骏马、起伏的草原——秋天摄影团的圣地。',
        kinds: ['摄影', '草原'],
        x: [
          { e: '🐎', n: '万马奔腾', w: '清晨,需约摄影团', d: '马倌策马赶群,百匹马从雾里冲过河滩,水花和晨光一起炸开——人为摆拍,但场面是真的震撼。' },
          { e: '🖼️', n: '蛤蟆坝晨雾', w: '日出', d: '坝上的"油画角":起伏丘陵 + 白桦 + 农舍,晨雾一漫就是粉彩画。' },
          { e: '🌊', n: '公主湖倒影', w: '无风上午', d: '湖面把金色白桦林完整倒过来,绕湖栈道半小时。' },
          { e: '🚙', n: '越野穿越五彩山', w: '午后', d: '越野车翻梁过河,每个山头一种颜色:金、橙、红、绿拼在一起。' },
        ],
        f: ['手把肉', '奶豆腐'],
        t: ['9 月中下旬最佳,坝上风大降温快。', '"万马奔腾"按场次收费,住景区里才有清晨。', '越野选正规车队,不进草原核心区压草场。'],
      },
      {
        id: 'hongcun', name: '宏村·塔川', region: '安徽', season: 'autumn', months: [10, 11],
        tagline: '塔川秋色是"中国三大秋色"之一,宏村是它的画框。',
        kinds: ['古村', '摄影'],
        x: [
          { e: '🍁', n: '塔川乌桕红叶', w: '11 月上中', d: '村口的乌桕树一层红一层黄,白墙黑瓦垫在底下,几张照片就能懂什么叫"塔川秋色"。' },
          { e: '🌉', n: '宏村南湖画桥晨光', w: '日出后 1 小时', d: '《卧虎藏龙》取景的画桥,晨光里倒影最完整,6 点前进村几乎无人。' },
          { e: '🏡', n: '月沼倒影', w: '全天', d: '牛形村落的"牛胃",水面把马头墙和灯笼一起倒过来,雨后更妙。' },
          { e: '🎋', n: '木坑竹海', w: '顺路', d: '《卧虎藏龙》竹林打斗地,竹海里爬到观景台,风一过全是涛声。' },
        ],
        f: ['臭鳜鱼', '毛豆腐', '腊八豆腐'],
        t: ['塔川红叶 11 月上中旬,11 月底基本落光。', '宏村住景区内,早晚各一次免排队。', '黄山汤口 1 小时车程,顺路看云海要碰运气。'],
      },
      {
        id: 'xinduqiao', name: '新都桥', region: '四川', season: 'autumn', months: [10, 11],
        tagline: '"摄影家的走廊":金杨树、藏寨和贡嘎雪山排成一条线。',
        kinds: ['摄影', '山', '人文'],
        x: [
          { e: '🍂', n: '十里杨树金廊', w: '10 月中–11 月初', d: '公路两边的青杨一夜变金,阳光斜过来时整条路都在发光。' },
          { e: '🏔️', n: '子梅垭口看贡嘎', w: '晴天日落', d: '近距离面对"蜀山之王",日照金山横着烧过整条山脊——10 月晴率全年最高。' },
          { e: '🏯', n: '丹巴甲居藏寨', w: '顺路 1 日', d: '百栋彩色藏寨沿着山坡撒在彩林里,被评为"中国最美乡村"。' },
          { e: '🛕', n: '塔公草原 + 木雅金塔', w: '上午', d: '雅拉雪山正对金塔和草原,转经的老人和玛尼墙都很入镜。' },
        ],
        f: ['牦牛肉汤', '酥油茶', '青稞酒'],
        t: ['海拔 3400,第一天别洗头少走路。', '折多山 10 月就可能下雪,自驾备防滑链。', '新都桥"光与影"靠斜射光,日出日落出门准没错。'],
      },
      {
        id: 'gubei', name: '北京·秋', region: '北京', season: 'autumn', months: [10, 11],
        tagline: '红叶、银杏、夜爬长城——北京把秋天过成了节日。',
        kinds: ['人文', '摄影'],
        x: [
          { e: '🏮', n: '司马台长城夜游', w: '周末夜场', d: '全国唯一可以夜爬的长城,灯笼从山脚一直点上去,长城像一条火龙趴在黑山上。' },
          { e: '🏘️', n: '古北水镇夜景', w: '傍晚', d: '北方"乌镇":水镇的灯、汤河的倒影,顺路泡山顶温泉。' },
          { e: '🍁', n: '坡峰岭红叶', w: '10 月下–11 月中', d: '比香山清净十倍的红叶山,黄栌从山脚烧到山顶。' },
          { e: '🍂', n: '故宫银杏 + 地坛大道', w: '11 月初', d: '故宫东华门里的银杏黄得和红墙一个色系,地坛银杏大道则铺满一地。' },
        ],
        f: ['烤鸭', '涮羊肉', '糖炒栗子'],
        t: ['香山红叶节周末人爆,选工作日或直接去坡峰岭。', '司马台夜长城需提前预约,山下古北水镇住宿最顺。', '11 月中后风大,早晚 5 度上下,保暖层带好。'],
      },
      {
        id: 'suzhou', name: '苏州', region: '江苏', season: 'autumn', months: [9, 10, 11],
        tagline: '桂花香里听评弹,秋风起时吃蟹——姑苏的秋天是甜的。',
        kinds: ['人文', '美食'],
        x: [
          { e: '🎻', n: '平江路听评弹', w: '晚上', d: '琵琶三弦一响,吴侬软语唱《声声慢》,茶位不贵,听的就是这个味。' },
          { e: '🍵', n: '艺圃喝茶', w: '午后', d: '小众园林之首,延光阁茶室贴着水面,一壶碧螺春配假山池沼,坐一下午。' },
          { e: '🍁', n: '天平山红枫', w: '11 月', d: '400 年古枫香层林尽染,是和塔川、香山并列的秋色名山。' },
          { e: '🦀', n: '阳澄湖大闸蟹', w: '10 月下–11 月', d: '秋风起蟹脚痒,去湖边蟹庄现捞现蒸,母蟹的黄这时候最满。' },
          { e: '🌼', n: '桂花季 citywalk', w: '9–10 月', d: '满城桂香,顺路来一碗桂花糖芋艿、酒酿圆子。' },
        ],
        f: ['大闸蟹', '响油鳝糊', '苏式汤面(焖肉浇头)', '桂花糖藕'],
        t: ['园林早上去,旅行团 9 点后进场。', '买蟹认准塘口直供,防"洗澡蟹"。', '评弹选琵琶语或伏羲会馆,提前订座。'],
      },
      {
        id: 'quanzhou', name: '泉州', region: '福建', season: 'autumn', months: [9, 10, 11],
        tagline: '半城烟火半城仙:簪花、南音、关帝庙的香火。',
        kinds: ['人文', '美食'],
        x: [
          { e: '💐', n: '蟳埔簪花围', w: '全程', d: '"头上花园":整头鲜花围成花环,男女都能戴,渔村老巷里怎么拍怎么好看。' },
          { e: '🗼', n: '开元寺东西塔', w: '上午', d: '南宋石塔八百年来扛过地震台风,塔下鸽子飞起来的瞬间记得按快门。' },
          { e: '🎭', n: '木偶戏 / 南音', w: '看当天排期', d: '提线木偶戏俗称"悬丝傀儡",全世界最古老的剧种之一,几十块门票穿越千年。' },
          { e: '🔥', n: '关帝庙求签', w: '全程', d: '泉州香火最旺的地方,摇签筒的声音混着香灰味,这就是"半城仙"。' },
          { e: '🏮', n: '西街骑楼夜游', w: '晚上', d: '钟楼、骑楼、小卷饼摊,从开元寺出来一路吃回去。' },
        ],
        f: ['面线糊', '姜母鸭', '土笋冻(敢试就赢)', '牛肉羹'],
        t: ['秋天不晒不台风,是泉州全年最舒服的窗口。', '簪花西街就能做,几十块含妆造。', '寺庙挨得很近,步行 + 小电驴就够。'],
      },
      {
        id: 'dunhuang', name: '敦煌', region: '甘肃', season: 'autumn', months: [9, 10],
        tagline: '壁画、沙山、星空——秋天是戈壁最温柔的两个月。',
        kinds: ['人文', '摄影', '星空'],
        x: [
          { e: '🖼️', n: '莫高窟 A 类票', w: '提前一个月抢票', d: '8 个窟 + 2 部数字电影,讲解员是研究所的,值回票价;B 类票是应急。' },
          { e: '🐪', n: '鸣沙山月牙泉骑骆驼', w: '日落前', d: '驼队摇进沙山,在沙脊上下看月牙泉变成一弯真实的月牙,日落时滑沙。' },
          { e: '🌌', n: '雅丹魔鬼城星空', w: '包车一日 + 夜', d: '大风蚀出的"舰队"立在黑戈壁上,夜里关灯抬头,银河横贯。' },
          { e: '🍢', n: '沙洲夜市', w: '晚上', d: '烤羊排、杏皮水、驴肉黄面一条街吃完,顺路买夜光杯。' },
        ],
        f: ['驴肉黄面', '杏皮水', '烤羊排'],
        t: ['A 类票提前 30 天在"莫高窟参观预约网"抢,旺季秒空。', '9–10 月早晚 8 度上下,戈壁风大。', '雅丹距市区 180km,拼车分摊,注意限速和加油。'],
      },
      {
        id: 'yangshuo', name: '阳朔', region: '广西', season: 'autumn', months: [9, 10, 11],
        tagline: '竹筏、攀岩、稻田骑行——山水在这里是"玩"的背景板。',
        kinds: ['玩水', '户外', '摄影'],
        x: [
          { e: '🛶', n: '遇龙河竹筏', w: '上午', d: '人工撑筏漂在稻田和峰林之间,水静得能听见竹篙点底,和漓江大船是两种体验。' },
          { e: '🚲', n: '十里画廊骑行', w: '午后', d: '小电驴或自行车穿过峰林和稻田,秋收季节满田金黄。' },
          { e: '🧗', n: '攀岩初体验', w: '任选', d: '阳朔是中国攀岩圣地,俱乐部有零基础体验线,在真实岩壁上爬一次。' },
          { e: '🌅', n: '相公山日出云海', w: '日出', d: '俯瞰漓江第一湾,秋天晨雾+云海概率高,摄影团的老根据地。' },
          { e: '🏞️', n: '兴坪古镇 20 元同款', w: '顺路', d: '人民币背面的取景地,古镇石板街顺带逛。' },
        ],
        f: ['啤酒鱼', '桂林米粉', '斑鱼火锅'],
        t: ['竹筏认准遇龙河,别坐漓江机动大船。', '攀岩体验提前一天约俱乐部。', '秋天水量适中天晴率高,是全年最佳窗口。'],
      },

      /* ================= 冬 ================= */
      {
        id: 'haerbin', name: '哈尔滨', region: '黑龙江', season: 'winter', months: [12, 1, 2],
        tagline: '零下二十度吃马迭尔,再走进一座 1:1 的冰城。',
        kinds: ['雪', '人文', '美食'],
        x: [
          { e: '🏰', n: '冰雪大世界', w: '12 月底–2 月,16 点后进', d: '几十米高的冰建筑全亮灯,像走进一座水晶城;下午进能同时看到白天和亮灯。' },
          { e: '🍦', n: '中央大街吃马迭尔', w: '全程', d: '零下 20 度站在百年老街啃冰棍,是哈尔滨的入乡随俗仪式。' },
          { e: '⛸️', n: '松花江冰上世界', w: '白天', d: '江面冻实后变成冰上乐园:冰爬犁、雪圈、抽冰嘎,大人小孩抢着玩。' },
          { e: '⛪', n: '圣索菲亚教堂雪景', w: '雪后傍晚', d: '拜占庭穹顶落满雪,喂鸽子,灯光亮起时最好拍。' },
          { e: '🧊', n: '红专街早市', w: '早上', d: '冻梨冻柿子摆在地上当砖头,买两个回屋缓一缓再吃,东北限定。' },
        ],
        f: ['马迭尔冰棍', '锅包肉', '东北铁锅炖', '红肠'],
        t: ['室内外温差 40 度,洋葱式穿衣 + 暖宝宝贴手机背面。', '冰雪大世界 16 点后进人少灯全亮。', '耳罩手套是刚需,相机电池备两块。'],
      },
      {
        id: 'xuexiang', name: '雪乡', region: '黑龙江', season: 'winter', months: [12, 1, 2],
        tagline: '雪压在木屋上像巨大的奶油面包——童话里都是骗人的,这里是真的。',
        kinds: ['雪', '摄影'],
        x: [
          { e: '🍄', n: '雪蘑菇屋', w: '全程', d: '积雪把每家木屋的屋檐压成蘑菇状,红灯笼一挂,就是明信片本片。' },
          { e: '🌄', n: '羊草山日出徒步', w: '凌晨出发', d: '雪地摩托送半程 + 徒步登顶,看雾凇和云海在脚下翻涌,下山滑雪圈更刺激。' },
          { e: '🔥', n: '夜里篝火 + 秧歌', w: '晚上', d: '村子广场上篝火晚会和东北大秧歌,游客和村民一起扭。' },
          { e: '🛏️', n: '东北火炕民宿', w: '全程', d: '炕烧得滚烫,躺下十分钟骨头缝都暖开,配冻梨最配。' },
        ],
        f: ['铁锅炖', '冻梨', '烧烤'],
        t: ['认准明码标价的正规民宿,提前电话确认房型价格。', '雪地徒步穿雪套,鞋底防滑。', '12 月底–1 月雪最厚最白;春节房价峰值。'],
      },
      {
        id: 'wusong', name: '吉林市·雾凇', region: '吉林', season: 'winter', months: [12, 1, 2],
        tagline: '松花江水汽一夜把树"冻"成银枝——看雾凇全靠早起和运气。',
        kinds: ['雪', '温泉', '摄影'],
        x: [
          { e: '❄️', n: '雾凇岛看树挂', w: '日出前后 6–8 点', d: '夜里的江雾在枝头凝成冰晶,太阳一出来整棵树银光乍裂——不是每次都有,连住两晚概率翻倍。' },
          { e: '♨️', n: '看完雾凇泡温泉', w: '上午', d: '从冰天雪地直接跳进露天温泉,头发结霜身上冒烟,反差感一绝。' },
          { e: '⛷️', n: '松花湖滑雪', w: '全天', d: '高铁直达的度假型雪场,雪质干爽,新手道和野雪区都有。' },
          { e: '🍲', n: '乌拉满族火锅', w: '晚上', d: '铜锅炭火白肉酸菜,是零下 25 度的最佳解法。' },
        ],
        f: ['乌拉满族火锅', '白肉血肠', '粘豆包'],
        t: ['雾凇看"水温和风力":前一晚江雾大,次日才有;提前看当地雾凇播报。', '岛上 5 点半摸黑等日出,头灯 + 手套必备。', '吉林市比哈尔滨人少,雾凇摄影的"内行"选择。'],
      },
      {
        id: 'sanya', name: '三亚', region: '海南', season: 'winter', months: [12, 1, 2],
        tagline: '全国穿羽绒服的时候,你在这浮潜——25 度的冬天。',
        kinds: ['海', '反季', '美食'],
        x: [
          { e: '🤿', n: '蜈支洲岛潜水', w: '上午', d: '冬季海水能见度更高,珊瑚堡礁和小丑鱼就在脚下,考个体验潜水证都没问题。' },
          { e: '🏄', n: '后海村学冲浪', w: '全程', d: '浪小而稳的新手天堂,教练满村都是,三节课后你就能站起来。' },
          { e: '🚂', n: '天涯镇小渔村', w: '午后', d: '蓝白色的小镇通向海边,游客比湾区少,适合发呆和拍照。' },
          { e: '🦀', n: '第一市场海鲜加工', w: '晚上', d: '市场买海鲜、找加工店代做,砍价 + 挑膏的乐趣一次集齐。' },
          { e: '🛍️', n: '免税城购物', w: '下雨备用', d: '离岛免税额度内扫货,把预算外的差价赚回来。' },
        ],
        f: ['清补凉', '椰子鸡', '和乐蟹', '抱罗粉'],
        t: ['春节房价翻三倍,避开或提前一个月订。', '沙滩拉客的"潜水一日游"别碰,认准正规潜店。', '冬天三亚也晒,防晒别因为是冬天就省。'],
      },
      {
        id: 'xishuangbanna', name: '西双版纳', region: '云南', season: 'winter', months: [12, 1, 2],
        tagline: '旱季版纳:28 度、雨林、夜市和天天都过的泼水节。',
        kinds: ['反季', '人文', '美食'],
        x: [
          { e: '🏮', n: '告庄星光夜市', w: '晚上', d: '大金塔下的东南亚风夜市,舂鸡脚、泡鲁达、水果船一路吃过去。' },
          { e: '🐘', n: '野象谷看亚洲象', w: '上午', d: '高架走廊下就是象群出没的河道,运气好能看到野象过河。' },
          { e: '💦', n: '傣族园泼水体验', w: '午后', d: '每天两场"天天泼水节",换上傣装被泼得透心凉也透心乐。' },
          { e: '🌿', n: '中科院植物园(含夜游)', w: '一整天', d: '亚洲最大热带植物园,白天看王莲夜游找萤火虫,夜游要单独约。' },
          { e: '🎭', n: '曼听公园篝火晚会 + 傣秀', w: '晚上', d: '放生灯、篝火、演出一条龙,旅行团和自由行都认的夜晚。' },
        ],
        f: ['香茅草烤鱼', '菠萝饭', '舂鸡脚', '泡鲁达'],
        t: ['12–2 月是旱季,不晒不雨最舒服;泼水节(4 月)是另一回事。', '植物园大,景区电瓶车值得买。', '夜市水果论公斤称,先看秤再买。'],
      },
      {
        id: 'mohe', name: '漠河', region: '黑龙江', season: 'winter', months: [12, 1],
        tagline: '去中国最北的村子"找北",顺便把开水泼成冰雾。',
        kinds: ['雪', '星空', '摄影'],
        x: [
          { e: '🧭', n: '北极村"找北"', w: '全程', d: '各种"最北":邮局寄一张盖着最北邮戳的明信片,给未来的自己。' },
          { e: '💦', n: '泼水成冰', w: '清晨,-30 度以下', d: '开水装进广口壶,逆光往空中一泼——"砰"地炸成冰雾,视频比照片震撼。' },
          { e: '🐴', n: '马拉爬犁穿白桦林', w: '午后', d: '爬犁铃铛在雪原上响,白桦林无限延伸,是东北版的雪国列车。' },
          { e: '🌌', n: '等一场星空/极光', w: '夜里', d: '极光概率低(看太阳活动),但-35 度的夜空能见度是城市里一辈子见不到的。' },
        ],
        f: ['铁锅炖江鱼', '蓝莓制品'],
        t: ['-30~-40 度:穿衣按"洋葱+宇航员",手机贴暖宝宝防关机。', '泼水成冰用 80 度以上热水,离脸远一点。', '两天一晚足够,交通以哈尔滨中转为主。'],
      },
      {
        id: 'kunming', name: '昆明', region: '云南', season: 'winter', months: [11, 12, 1, 2, 3],
        tagline: '红嘴鸥每年准时从西伯利亚飞来,比游客还守约。',
        kinds: ['反季', '摄影'],
        x: [
          { e: '🕊️', n: '翠湖/海埂喂红嘴鸥', w: '11 月–3 月', d: '上万只红嘴鸥悬停接食,买专用鸥粮,海埂大坝人少鸥多,翠湖更市中心。' },
          { e: '💐', n: '斗南花市论斤买花', w: '晚上去', d: '亚洲最大花市,玫瑰按斤称,10 块钱抱一大捆——晚上打包时段最便宜。' },
          { e: '☀️', n: '暖冬晒太阳', w: '全程', d: '20 度的冬天阳光,翠湖边找把椅子,喝茶晒太阳发呆就是正经项目。' },
          { e: '🍜', n: '圆西路小吃街', w: '傍晚', d: '学生街的豆花米线、烤饵块、炸洋芋,一条街吃完再换一条。' },
        ],
        f: ['过桥米线', '汽锅鸡', '玫瑰花饼', '豆花米线'],
        t: ['喂鸥用专用鸥粮,馒头面包鸥不吃。', '早晚温差大,中午短袖早晚羽绒是常态。', '花市晚上 8 点后是批发打包价。'],
      },
      {
        id: 'chengdu', name: '成都·西岭雪山', region: '四川', season: 'winter', months: [12, 1, 2],
        tagline: '上午在雪场摔跤,下午在茶馆掏耳朵——冬天的成都一秒切换。',
        kinds: ['雪', '美食', '人文'],
        x: [
          { e: '⛷️', n: '西岭雪山滑雪', w: '全天', d: '南方最近的像样雪场,初级道友好,坐索道去日月坪看"阴阳界"奇观。' },
          { e: '🐼', n: '熊猫基地蹲"吃播"', w: '早上 8 点开园', d: '直奔月亮产房,幼年熊猫打架滚地的画面值得早起;下午熊猫集体睡觉。' },
          { e: '🍵', n: '鹤鸣茶社掏耳朵', w: '午后', d: '竹椅盖碗茶 + 竹夹麻绳的采耳,酥麻到怀疑人生,人民公园人均 30 元全套体验。' },
          { e: '🎭', n: '川剧变脸', w: '晚上', d: '蜀风雅韵或锦江剧场,变脸喷火绝活近在眼前。' },
          { e: '🌃', n: '玉林路小酒馆', w: '深夜', d: '《成都》唱的那条街,从酒馆出来再吃一顿宵夜串串。' },
        ],
        f: ['火锅', '串串', '钟水饺', '蛋烘糕'],
        t: ['西岭滑雪周中去,周末索道排队 1 小时起。', '熊猫基地 8 点开园直奔产房,别恋战大门口。', '市区到西岭 2.5h,可高铁到邛崃转车。'],
      },
      {
        id: 'lasa', name: '拉萨', region: '西藏', season: 'winter', months: [12, 1, 2],
        tagline: '"冬游西藏":游客最少、阳光最硬、布宫还免票。',
        kinds: ['反季', '人文', '摄影'],
        x: [
          { e: '🏰', n: '冬游布达拉宫', w: '全程', d: '免票季(以当年公告为准)几乎不用排队,雪后的布宫在龙王潭里落一个完整倒影。' },
          { e: '☀️', n: '大昭寺晒太阳', w: '上午', d: '八廓街转经道墙根下,和藏民一起晒太阳,冬天拉萨的阳光是热的。' },
          { e: '🧊', n: '普莫雍错蓝冰', w: '1–2 月', d: '海拔 5000 的湖冻成整块蓝冰,裂纹和气泡像冻住的银河——冬季限定的顶级景观。' },
          { e: '🎉', n: '藏历新年体验', w: '2 月前后', d: '撞上藏历新年(公历 2 月居多)能看家家摆"切玛"、大昭寺的盛大朝佛。' },
        ],
        f: ['甜茶(甜茶馆一壶慢慢喝)', '藏面', '牦牛肉'],
        t: ['冬天白天阳光强不冷(15 度),早晚零下 10 度——分层穿衣。', '蓝冰要结到 1 月才够厚,2 月后化,行程卡准。', '冬季含氧量更低,第一天比夏天更要慢。'],
      },
    ]

    /* ------------------------------------------------------------------ *
     * 工具
     * ------------------------------------------------------------------ */
    const seasonById = Object.fromEntries(SEASONS.map((s) => [s.id, s]))
    const destById = Object.fromEntries(DESTS.map((d) => [d.id, d]))

    function currentMonth() {
      try {
        const m = new Date().getMonth() + 1
        return m >= 1 && m <= 12 ? m : 1
      } catch {
        return 1
      }
    }
    function seasonOf(month) {
      const s = SEASONS.find((s) => s.months.includes(month))
      return s ? s.id : 'spring'
    }
    function fmtMonths(months) {
      const parts = []
      let start = months[0]
      let prev = months[0]
      for (let i = 1; i <= months.length; i += 1) {
        const cur = months[i]
        if (cur === prev + 1) { prev = cur; continue }
        parts.push(start === prev ? `${start}月` : `${start}-${prev}月`)
        start = cur
        prev = cur
      }
      return parts.join('、')
    }
    function haystack(dest) {
      return [
        dest.name, dest.region, dest.tagline,
        ...dest.kinds, ...dest.f,
        ...dest.x.map((x) => `${x.n} ${x.d}`),
        ...(DISHES[dest.id] ?? []).flatMap((x) => [x.n, x.d, x.w]),
      ].join('\n').toLowerCase()
    }
    /* 招牌美食:每目的地 3-5 道 {n 菜名, d 为什么值得吃, w 去哪吃, img Commons 图}。
       来源:百度城市必吃榜/大众点评必吃榜/小红书高频榜单的人工筛选;图来自 Wikimedia Commons。 */
    const DISHES = {
      "luoping": [
        { n: "五色花米饭", d: "布依族五色糯米饭，枫叶、密蒙花等植物染色，现蒸竹香浓", w: "多依河布依族村寨农家", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/53/Five-colored_glutinous_rice_at_a_Guangxi-style_restaurant_in_Beijing_%2820250331105506%29.jpg/500px-Five-colored_glutinous_rice_at_a_Guangxi-style_restaurant_in_Beijing_%2820250331105506%29.jpg" },
        { n: "油煎蜂蛹", d: "春季蜂蛹最肥，炸到金黄酥脆爆浆，高蛋白下酒菜", w: "县城夜市、多依河农家菜馆", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/5a/Deep-fried_bee_pupae_and_grasshoppers.jpg/500px-Deep-fried_bee_pupae_and_grasshoppers.jpg" },
        { n: "竹筒饭", d: "糯米腊肉装鲜竹筒炭烤，剖开竹香扑鼻，趁热吃", w: "布依族村寨农家乐", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/c/ce/Glutinous_rice_in_bamboo_tubes.jpg/500px-Glutinous_rice_in_bamboo_tubes.jpg" },
      ],
      "wuyuan": [
        { n: "荷包红鲤鱼", d: "婺源特有红鲤清蒸，肉嫩刺少形似荷包，头道名菜", w: "县城老字号、李坑江湾农家", img: "" },
        { n: "糊豆腐", d: "豆腐羹滚烫一勺鲜，配肉茸香菇虾皮，徽席头道", w: "篁岭、思溪延村农家菜", img: "" },
        { n: "汽糕", d: "米浆垫箬叶铺笋丁香菇蒸成，切块趁热当早点", w: "婺源县城早餐摊、篁岭小吃街", img: "" },
        { n: "清明粿", d: "艾草汁和粿皮包笋丁腊肉，踏青季限定的咸香", w: "晓起、江湾街边粿摊", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/3/34/%E7%8C%AA%E6%B2%B9%E9%A6%85%E6%96%99%E5%85%B0%E6%BA%AA%E6%B8%85%E6%98%8E%E7%B2%BF.jpg/500px-%E7%8C%AA%E6%B2%B9%E9%A6%85%E6%96%99%E5%85%B0%E6%BA%AA%E6%B8%85%E6%98%8E%E7%B2%BF.jpg" },
      ],
      "nyingchi": [
        { n: "石锅鸡", d: "墨脱石锅炖土鸡手掌参，汤浓白带药香，鲁朗正宗", w: "鲁朗石锅鸡一条街", img: "" },
        { n: "藏香猪", d: "高原放养黑猪烤制，皮脆肉紧脂香，林芝必点硬菜", w: "鲁朗、八一镇藏餐馆", img: "" },
        { n: "松茸", d: "6-9月雨季鲜货，切片烤或石锅涮，菌香浓郁", w: "林芝菌市、石锅鸡店加菌", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c4/Fresh_matsutake.jpg/500px-Fresh_matsutake.jpg" },
        { n: "酥油茶", d: "咸口热茶配糌粑，看桃花前喝一碗暖身抗高反", w: "景区藏家茶馆", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/54/Tibetan_butter_tea.jpg/500px-Tibetan_butter_tea.jpg" },
      ],
      "yili-xinghua": [
        { n: "手抓肉", d: "带骨羊肉清炖撒皮牙子，蘸盐配原汤，牧区待客头道", w: "吐尔根沿途牧家乐、新源县城", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/b/b6/Shouzhuarou_at_Yangcun_Xiaoguan%2C_Urumqi_%2820230921133450%29.jpg/500px-Shouzhuarou_at_Yangcun_Xiaoguan%2C_Urumqi_%2820230921133450%29.jpg" },
        { n: "纳仁", d: "面片盖羊肉浇皮牙子热汤，哈萨克人家待客主食", w: "新源县城哈萨克风味馆", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/10/Naryn_noodles_at_Moon_G%C3%BClhan_Restaurant%2C_Beijing_%2820230322172203%29.jpg/500px-Naryn_noodles_at_Moon_G%C3%BClhan_Restaurant%2C_Beijing_%2820230322172203%29.jpg" },
        { n: "马肠子", d: "马肋灌肠慢熏，油润紧实烟熏香，切片下酒好", w: "那拉提镇、新源熏马肉铺", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/5b/%27Horse_meat_sausages%27_in_Chorsu_Bazaar.jpg/500px-%27Horse_meat_sausages%27_in_Chorsu_Bazaar.jpg" },
        { n: "奶疙瘩", d: "酸奶发酵晒干的酸香干粮，越嚼越香配奶茶", w: "沿途毡房、乡镇巴扎", img: "" },
      ],
      "luoyang": [
        { n: "牡丹燕菜", d: "水席头牌，萝卜丝细如燕窝，酸辣汤鲜，花期应景", w: "老城真不同、管记水席", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/3/3b/Mu_dan_yan_cai%28%E7%89%A1%E4%B8%B9%E7%87%95%E8%8F%9C%29.jpg/500px-Mu_dan_yan_cai%28%E7%89%A1%E4%B8%B9%E7%87%95%E8%8F%9C%29.jpg" },
        { n: "洛阳牛肉汤", d: "牛骨汤冲碗，咸甜两吃，清晨配饼丝，汤城早课", w: "启明东路马杰山牛肉汤", img: "" },
        { n: "浆面条", d: "绿豆浆发酵的酸香，加芹菜花生豆，开胃家常味", w: "老城十字街小馆", img: "" },
        { n: "不翻汤", d: "绿豆薄饼垫碗底，酸辣骨头汤泡饼，夜市暖胃", w: "老城十字街夜市汤摊", img: "" },
      ],
      "wuhan": [
        { n: "热干面", d: "碱水面裹浓芝麻酱，干香噎口才正宗，过早头牌", w: "粮道街老店、蔡林记", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/4/4f/%E7%83%AD%E5%B9%B2%E9%9D%A2.jpg/500px-%E7%83%AD%E5%B9%B2%E9%9D%A2.jpg" },
        { n: "三鲜豆皮", d: "糯米肉丁裹蛋皮煎到金黄，外脆里糯，老通城招牌", w: "老通城、户部巷摊", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/2/2d/Cailinji_doupi_cooked_on_a_pot.jpg/500px-Cailinji_doupi_cooked_on_a_pot.jpg" },
        { n: "面窝", d: "米浆炸圈边脆中软，带葱香窝心，过早绝配", w: "粮道街、户部巷油锅摊", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/2/28/Mianwo.JPG/500px-Mianwo.JPG" },
        { n: "糊汤粉", d: "鲫鱼熬到骨酥的稠糊汤，泡油条鲜辣暖胃", w: "田恒启、户部巷老摊", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/a0/%E7%94%B0%E6%81%92%E5%90%AF%E7%B3%8A%E6%B1%A4%E7%B2%89_20251009_172930.jpg/500px-%E7%94%B0%E6%81%92%E5%90%AF%E7%B3%8A%E6%B1%A4%E7%B2%89_20251009_172930.jpg" },
        { n: "排骨藕汤", d: "粉藕煨到起沙，汤色奶白，秋冬喝最熨帖", w: "蔡甸藕汤馆、家常菜馆", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/d/d3/Lotus_root-Hubei_style.jpg/500px-Lotus_root-Hubei_style.jpg" },
      ],
      "wuxi": [
        { n: "无锡小笼包", d: "皮薄卤多、甜咸口，趁热先开窗吸汤再入口，早茶头牌", w: "南禅寺老字号王兴记", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/d/dc/%E5%92%AC%E4%BA%86%E4%B8%80%E5%8F%A3%E7%9A%84%E6%97%A0%E9%94%A1%E5%B0%8F%E7%AC%BC%E5%8C%85.jpg/500px-%E5%92%AC%E4%BA%86%E4%B8%80%E5%8F%A3%E7%9A%84%E6%97%A0%E9%94%A1%E5%B0%8F%E7%AC%BC%E5%8C%85.jpg" },
        { n: "无锡酱排骨", d: "浓油赤酱甜出头咸收口，酥到脱骨，百年名菜也是伴手礼", w: "中山路三凤桥肉庄", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/6/64/Wuxi_spareribs_sauce.jpg/500px-Wuxi_spareribs_sauce.jpg" },
        { n: "银鱼炒蛋", d: "太湖银鱼无骨无刺，滑嫩带湖水鲜，湖鲜馆点单率最高的湖味", w: "太湖鼋头渚边湖鲜馆", img: "" },
        { n: "玉兰饼", d: "糯米粉裹鲜肉油炸，外壳脆内里糯，咬开爆汁的街头早点", w: "清名桥毛华玉兰饼老店", img: "" },
      ],
      "hangzhou": [
        { n: "西湖醋鱼", d: "现杀草鱼淋糖醋芡，火候不对易腥，认准湖边老字号现做", w: "孤山楼外楼/知味观", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/1b/West_Lake_Fish_in_Vinegar_Gravy.jpg/500px-West_Lake_Fish_in_Vinegar_Gravy.jpg" },
        { n: "东坡肉", d: "方块五花慢炖酥而不碎，肥而不腻入口即化，配米饭一绝", w: "楼外楼/知味观老店", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/4/4e/Dongpo_pork_%28a_Hangzhou_dish%29.jpg/500px-Dongpo_pork_%28a_Hangzhou_dish%29.jpg" },
        { n: "龙井虾仁", d: "明前龙井茶芽入馔，虾仁弹嫩裹茶香，清明前后最应景", w: "杨公堤味庄/知味观", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/8/8d/Longjing_prawns_in_Hangzhou_Restaurant_2015-07.JPG/500px-Longjing_prawns_in_Hangzhou_Restaurant_2015-07.JPG" },
        { n: "片儿川", d: "雪菜笋片肉丝浇头，汤头鲜掉眉毛，杭州人雷打不动的早面", w: "奎元馆/菊英面店", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/6/6e/%E7%89%87%E5%84%BF%E5%B7%9D_20260730.jpg/500px-%E7%89%87%E5%84%BF%E5%B7%9D_20260730.jpg" },
        { n: "葱包桧", d: "薄饼卷油条葱段铁板压烤，刷甜酱辣酱，现烤现吃的街头味", w: "河坊街小摊/鼓楼早市", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/d/d0/%E8%91%B1%E5%8C%85%E6%A1%A7.jpg/500px-%E8%91%B1%E5%8C%85%E6%A1%A7.jpg" },
      ],
      "qiandongnan": [
        { n: "凯里酸汤鱼", d: "红酸汤发酵酸辣开胃，蘸水加木姜子，鱼汤泡饭最销魂", w: "凯里市内酸汤鱼老店", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/4/4d/Food_%E9%85%B8%E6%B9%AF%E9%AD%9A%2C_%E9%A7%B1%E5%B8%AB%E7%88%B6%E9%86%AC%E5%91%B3%E5%B7%9D%E5%AE%A2%E8%8F%9C%2C_%E5%8F%B0%E5%8C%97_%2822438764872%29.jpg/500px-Food_%E9%85%B8%E6%B9%AF%E9%AD%9A%2C_%E9%A7%B1%E5%B8%AB%E7%88%B6%E9%86%AC%E5%91%B3%E5%B7%9D%E5%AE%A2%E8%8F%9C%2C_%E5%8F%B0%E5%8C%97_%2822438764872%29.jpg" },
        { n: "侗家腌鱼", d: "稻田鱼拌盐椒入桶发酵，酸香下饭，侗寨家宴和节庆硬菜", w: "从江/黎平侗寨农家乐", img: "" },
        { n: "从江香猪", d: "皮薄骨细肉香，白切或烤香猪蘸酸辣碟，本地才有真味", w: "从江县城香猪餐馆", img: "" },
        { n: "牛瘪火锅", d: "牛胃里草汁熬的百草汤，微苦回甘，敢尝鲜者的从江名物", w: "从江/榕江瘪派火锅店", img: "" },
      ],
      "pingtan": [
        { n: "时来运转", d: "薯粉皮包虾仁海蛎蒸制，皮糯馅鲜，平潭节庆必做的头号小吃", w: "潭城老街小吃店", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/4/44/%E6%97%B6%E6%9D%A5%E8%BF%90%E8%BD%AC.jpg/500px-%E6%97%B6%E6%9D%A5%E8%BF%90%E8%BD%AC.jpg" },
        { n: "海蛎饼", d: "米浆裹海蛎包菜油炸，外壳酥脆海味足，配锅边糊是标准早点", w: "平潭城关早点摊", img: "" },
        { n: "八珍炒糕", d: "薯粉糕和海鲜腊肉同炒，糯韧咸香，平潭宴席上的名点心", w: "潭城海鲜排档", img: "" },
        { n: "金鲟糯米饭", d: "红膏鲟铺糯米饭同蒸，蟹膏油脂渗进米粒，秋冬最肥美", w: "海鲜楼记得提前预订", img: "" },
      ],
      "qingdao": [
        { n: "辣炒蛤蜊", d: "红岛蛤蜊肉肥无沙，干辣椒爆炒，配散啤是夏夜大排档灵魂", w: "营口路啤酒屋/台东夜市", img: "" },
        { n: "鲅鱼水饺", d: "春鲅鱼剁馅包大个水饺，鲜嫩多汁，谷雨送鲅鱼季正当吃", w: "老城家常饺子馆", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/7/79/The_cooking_procedure_of_Scomberomorussinensis_dumplings_-_picture_2nd_%28Result%29.jpg/500px-The_cooking_procedure_of_Scomberomorussinensis_dumplings_-_picture_2nd_%28Result%29.jpg" },
        { n: "海菜凉粉", d: "石花菜熬冻切条，蒜泥香醋一拌，爽滑解腻的夏日海味", w: "劈柴院/啤酒屋凉粉", img: "" },
        { n: "海肠捞饭", d: "海肠段配韭菜打芡浇饭，脆嫩鲜甜，胶东风味的贵气代表作", w: "本地鲁菜老馆", img: "" },
      ],
      "dalian": [
        { n: "海鲜焖子", d: "地瓜粉凉粉块煎出焦壳，浇麻酱蒜汁虾油，街头现煎现吃", w: "青泥洼桥/天津街小吃摊", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/a1/Sanxian_Menzi_at_a_Restaurant_in_Dalian_20251122.jpg/500px-Sanxian_Menzi_at_a_Restaurant_in_Dalian_20251122.jpg" },
        { n: "咸鱼饼子", d: "咸鲅鱼配玉米饼子同食，咸鲜就粗粮，老渔村的经典搭配", w: "老虎滩渔村餐馆", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/53/Salted_fish_Dalian.JPG/500px-Salted_fish_Dalian.JPG" },
        { n: "海胆蒸蛋", d: "大连海胆春夏最肥，蛋羹嫩滑裹着胆黄鲜甜，一勺一个鲜", w: "长兴市场海胆现蒸小店", img: "" },
        { n: "铁板鱿鱼", d: "整只鱿鱼铁板压烤刷辣酱，脆嫩弹牙，夜市排队的人气小吃", w: "中原街/星海夜市摊", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/7/7b/20240503_Grilled_Squid_Restaurant_MeGusto_anagoria.jpg/500px-20240503_Grilled_Squid_Restaurant_MeGusto_anagoria.jpg" },
      ],
      "hulunbuir": [
        { n: "手把肉", d: "清水煮的羔羊肉，春天羊最肥时最好，蘸韭菜花直接上手撕", w: "海拉尔蒙餐馆、陈巴尔虎牧户", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/b/be/Beshbarmoq.jpg/500px-Beshbarmoq.jpg" },
        { n: "布里亚特包子", d: "布里亚特蒙古族羊肉洋葱馅包子，皮薄爆汁，早餐配奶茶最佳", w: "海拉尔老字号早点铺", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/0/03/Buuza_02.jpg/500px-Buuza_02.jpg" },
        { n: "蒙古锅茶", d: "咸奶茶煮炒米奶皮奶豆腐，冷天早上来一碗顶饱又暖身", w: "海拉尔蒙餐馆、牧户人家", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/9/9e/Hohhot.S%C3%BC%C3%BCtei_tsai_et_bonbons.jpg/500px-Hohhot.S%C3%BC%C3%BCtei_tsai_et_bonbons.jpg" },
        { n: "风干牛肉干", d: "草原风干的牛肉条越嚼越香，秋冬做、全年可当路上零食", w: "满洲里特产店、牧民作坊", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/1f/Beef-jerky.jpg/500px-Beef-jerky.jpg" },
      ],
      "qinghaihu": [
        { n: "手抓羊肉", d: "高原羊肉膻味轻，白煮蘸椒盐，环湖途中牧家乐吃最地道", w: "环湖牧家乐、共和县羊肉馆", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/e/ea/Shouzhua_Yangrou_at_Masongji_Restaurant%2C_Jiayuguan_%2820230919132517%29.jpg/500px-Shouzhua_Yangrou_at_Masongji_Restaurant%2C_Jiayuguan_%2820230919132517%29.jpg" },
        { n: "糌粑", d: "青稞炒面拌酥油茶捏着吃，高海拔抗寒顶饿的藏族主食", w: "刚察藏餐馆、牧民帐篷", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/18/Tsampa_cakes_at_Makye_Ame_Restaurant%2C_Xining_%2820230925145812%29.jpg/500px-Tsampa_cakes_at_Makye_Ame_Restaurant%2C_Xining_%2820230925145812%29.jpg" },
        { n: "羊肉面片", d: "手擀面片配羊肉汤，天冷一碗下肚从胃暖到脚", w: "环湖乡镇清真面馆", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/5a/%E6%A0%BC%E5%B0%94%E6%9C%A8_%E5%AD%94%E9%98%BF%E8%A8%87%E6%89%8B%E6%8A%93%E4%B9%8B%E7%BE%8A%E8%82%89%E9%9D%A2%E7%89%87.jpg/500px-%E6%A0%BC%E5%B0%94%E6%9C%A8_%E5%AD%94%E9%98%BF%E8%A8%87%E6%89%8B%E6%8A%93%E4%B9%8B%E7%BE%8A%E8%82%89%E9%9D%A2%E7%89%87.jpg" },
        { n: "老酸奶", d: "牧区土法发酵，凝固如嫩豆腐，撒白糖冰凉解腻", w: "青海湖边藏家酸奶摊", img: "" },
      ],
      "yili": [
        { n: "手抓饭", d: "羊油焖的黄萝卜抓饭油亮软糯，中午正餐吃最顶饱", w: "伊宁六星街维吾尔饭馆", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c3/%E7%BE%8A%E8%82%89%E6%8A%93%E9%A5%AD%E5%92%8C%E9%85%8D%E8%8F%9C.jpg/500px-%E7%BE%8A%E8%82%89%E6%8A%93%E9%A5%AD%E5%92%8C%E9%85%8D%E8%8F%9C.jpg" },
        { n: "烤包子", d: "馕坑烤的羊肉皮牙子馅薄皮包，出坑烫手趁热咬一嘴汁", w: "伊宁巴扎烤包子摊", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/55/Samsa_of_Khiva.jpg/500px-Samsa_of_Khiva.jpg" },
        { n: "熏马肠", d: "哈萨克冬宰熏的马肋肠，肥瘦相间越蒸越香，入冬才吃得着", w: "伊犁冬宰季熏肉店、牧民家", img: "" },
        { n: "卡瓦斯", d: "蜂蜜面包发酵的微甜气泡饮，夏天逛巴扎来一杯最解暑", w: "伊宁夜市大桶现打摊", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/8/8c/Kvass-ochakovskiy.jpg/500px-Kvass-ochakovskiy.jpg" },
      ],
      "changbaishan": [
        { n: "锅包肉", d: "东北糖醋炸肉片外壳咔哧响，二道白河镇上老馆子必点", w: "二道白河镇东北菜老馆", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/2/2c/%E6%B8%85%E7%9C%9F%E9%94%85%E5%8C%85%E8%82%89.jpg/500px-%E6%B8%85%E7%9C%9F%E9%94%85%E5%8C%85%E8%82%89.jpg" },
        { n: "延吉冷面", d: "朝鲜族冰镇牛肉汤冷面，夏天爬山后吃一碗透心凉", w: "二道白河朝鲜族饭店", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/b/bf/KOCIS_Mul-naengmyeon%2C_Chilled_Buckwheat_Noodle_Soup_%284594756202%29.jpg/500px-KOCIS_Mul-naengmyeon%2C_Chilled_Buckwheat_Noodle_Soup_%284594756202%29.jpg" },
        { n: "打糕", d: "木槌现打的糯米糕裹黄豆面，软糯弹牙，街边热乎现做", w: "二道白河早市现打摊", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/f/fd/Tteok.jpg/500px-Tteok.jpg" },
        { n: "铁锅炖", d: "大铁锅炖江鱼贴玉米饼子，雪季围着锅吃最有过冬气氛", w: "二道白河镇铁锅炖馆", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c3/Tieguodun_at_a_northeastern_restaurant_in_Hengdian%2C_Zhejiang_%2820250131182437%29.jpg/500px-Tieguodun_at_a_northeastern_restaurant_in_Hengdian%2C_Zhejiang_%2820250131182437%29.jpg" },
      ],
      "libo": [
        { n: "酸汤鱼", d: "毛辣果发酵的红酸汤煮河鱼，酸辣开胃，四季都值得吃", w: "荔波古镇酸汤鱼馆", img: "" },
        { n: "杨梅汤", d: "六月杨梅季用本地杨梅熬的酸甜汤，冰镇后消暑一绝", w: "荔波古镇夜市冷饮摊", img: "" },
        { n: "腌酸肉", d: "布依族坛子腌的酸肉酸香回甘，是本地人家待客下饭菜", w: "荔波本地菜馆、瑶山民家", img: "" },
        { n: "米豆腐", d: "米浆做的凉粉，浇糊辣椒折耳根汁，夏天走累来一碗", w: "樟江边小吃摊", img: "" },
      ],
      "daocheng": [
        { n: "酥油茶", d: "咸香酥油打茶配糌粑，高原早晚各一碗抗寒防高反", w: "稻城藏式茶馆", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/54/Tibetan_butter_tea.jpg/500px-Tibetan_butter_tea.jpg" },
        { n: "松茸", d: "七八月雨季稻城松茸上市，切片炖鸡或炭烤，鲜香无比", w: "稻城集市、县城藏餐馆", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c4/Fresh_matsutake.jpg/500px-Fresh_matsutake.jpg" },
        { n: "牦牛肉汤锅", d: "高原牦牛肉炖汤锅肉紧汤浓，爬山一天后吃最补力气", w: "稻城县城牦牛肉汤锅店", img: "" },
        { n: "藏式酸奶", d: "牦牛奶发酵的硬酸奶，撒白糖或蜂蜜，饭后一碗解腻", w: "亚丁村口酸奶小摊", img: "" },
      ],
      "weizhoudao": [
        { n: "白灼沙虫", d: "像小香肠的白灼沙虫脆嫩弹牙带海水味，涠洲赶海必点", w: "南湾街海鲜大排档", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/a9/Guangzhou-Beihai-shaochong-0459.jpg/500px-Guangzhou-Beihai-shaochong-0459.jpg" },
        { n: "椒盐濑尿虾", d: "秋季虾膏最肥，椒盐壳一剥就开，配啤酒夜宵首选", w: "南湾街夜市排档", img: "" },
        { n: "白切香蕉猪", d: "香蕉皮喂大的岛猪皮薄肉甜，白切蘸沙姜最原味", w: "南湾街餐馆", img: "" },
        { n: "海鲜粥", d: "沙虫虾蟹现捞现熬，米粒吸满海味，赶海归来一碗最落胃", w: "南湾街早餐摊", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/7/72/Cantonese_seafood_congee_at_home.jpg/500px-Cantonese_seafood_congee_at_home.jpg" },
      ],
      "kanas": [
        { n: "烤狗鱼", d: "额尔齐斯河冷水狗鱼炭烤，皮脆肉呈蒜瓣状，布尔津夜市招牌", w: "布尔津河堤夜市烤鱼摊", img: "" },
        { n: "包尔萨克", d: "哈萨克油炸面点外酥内软，蘸蜂蜜或泡咸奶茶都香", w: "牧民毡房或哈萨克餐馆", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c6/Kazakh_culture_Baursak.jpg/500px-Kazakh_culture_Baursak.jpg" },
        { n: "熏马肠", d: "马肋灌肠冬熏而成，油润咸香越嚼越浓，冬宰硬菜", w: "布尔津集市肉铺", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/3/3e/Horsemeat_platter.jpg/500px-Horsemeat_platter.jpg" },
        { n: "奶疙瘩", d: "酸奶发酵晾干的硬奶酪，酸香耐嚼，泡软在奶茶里更好吃", w: "喀纳斯村牧民家", img: "" },
      ],
      "ejina": [
        { n: "手把肉", d: "阿拉善羊清水煮只蘸盐韭花，鲜嫩无膻，秋膘最肥时吃", w: "达来呼布镇牧家乐", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/a0/Chanasan_makh.jpg/500px-Chanasan_makh.jpg" },
        { n: "阿拉善烤全羊", d: "整羊果木慢烤外皮酥红，牧区最高待客礼，四五人分食", w: "镇上蒙古包餐厅", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/5a/Roast_Whole_Lamb.jpg/500px-Roast_Whole_Lamb.jpg" },
        { n: "沙米凉粉", d: "沙蓬籽打成凉粉，滑韧爽口浇辣油醋汁，大漠消暑小吃", w: "达来呼布镇小吃摊", img: "" },
        { n: "额济纳蜜瓜", d: "9-10月沙地蜜瓜糖心爆汁，赏胡杨顺便抱一个路上吃", w: "胡杨林景区门口瓜摊", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/e/ed/Cucumis_melo_on_white_background.jpg/500px-Cucumis_melo_on_white_background.jpg" },
      ],
      "huangling": [
        { n: "清蒸荷包鲤", d: "婺源荷包红鲤肚圆如荷包，清蒸嫩滑刺软，徽宴头菜", w: "篁岭天街农家菜馆", img: "" },
        { n: "糊豆腐", d: "米粉浆糊化的豆腐羹，滑烫鲜香，婺源农家宴压轴", w: "篁岭农家菜馆", img: "" },
        { n: "婺源汽糕", d: "米浆发酵铺笋干香菇蒸成，松软咸香，趁热撕着吃", w: "江湾镇早餐摊", img: "" },
        { n: "江湾雪梨", d: "秋日成熟皮薄汁多，晒秋时节篁岭集市现摘现卖", w: "篁岭晒秋集市摊位", img: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ac/Pyrusnivalis.jpg/480px-Pyrusnivalis.jpg" },
      ],
      "aershan": [
        { n: "铁锅炖冷水鱼", d: "哈拉哈河冷水鱼肉紧无腥，炖汤奶白，秋冬围锅最暖", w: "阿尔山铁锅炖餐馆", img: "" },
        { n: "柳蒿芽", d: "初夏嫩芽清炒或做汤，微苦回甘，林区限定山野春味", w: "阿尔山家常菜馆", img: "" },
        { n: "山蘑炖笨鸡", d: "野生白蘑配散养笨鸡小火慢炖，汤浓菇香，进山回来吃正好", w: "阿尔山白狼镇农家院", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/5f/Chicken_Mushroom_Claypot.jpg/500px-Chicken_Mushroom_Claypot.jpg" },
        { n: "卜留克", d: "苤蓝腌的脆咸菜，酸爽解腻，配粥夹馒头都行还能带走", w: "阿尔山镇副食店", img: "" },
      ],
      "wulanbutong": [
        { n: "达里湖华子鱼", d: "达里湖雅罗鱼干炸香煎，酥骨焦香，冬捕现捞最肥美", w: "乌兰布统镇蒙餐馆", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/d/d5/Leuciscus_waleckii.jpg/500px-Leuciscus_waleckii.jpg" },
        { n: "烤羊腿", d: "草原羊炭烤外焦里嫩，现削现吃蘸椒盐，蒙古包里气氛拉满", w: "草原蒙古包度假村", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/a6/Roast_leg_of_lamb.jpg/500px-Roast_leg_of_lamb.jpg" },
        { n: "蒙古馅饼", d: "薄皮牛肉馅烙得流油，趁热咬一口爆汁，草原经典主食", w: "乌兰布统镇小吃馆", img: "" },
        { n: "锅茶", d: "咸奶茶现煮炒米奶皮牛肉干，清晨一碗暖身抗草原风", w: "牧区早点蒙古包", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/b/b7/Suutei_tsai.jpg/500px-Suutei_tsai.jpg" },
      ],
      "hongcun": [
        { n: "臭鳜鱼", d: "腌制发酵的鳜鱼似臭实鲜，蒜瓣肉配红烧汁，徽菜头牌必点", w: "黟县县城老菜馆、宏村周边土菜馆", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/0/0a/Fermented_mandarin_fish.jpg/500px-Fermented_mandarin_fish.jpg" },
        { n: "毛豆腐", d: "长白菌丝的豆腐油煎后蘸辣酱，外脆里糯，宏村街头现煎现吃", w: "宏村月沼边小吃摊现煎", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/d/df/%E6%96%B9%E9%91%AB%E7%8E%89%E6%AF%9B%E8%B1%86%E8%85%90.jpg/500px-%E6%96%B9%E9%91%AB%E7%8E%89%E6%AF%9B%E8%B1%86%E8%85%90.jpg" },
        { n: "腊八豆腐", d: "黟县人家腊八前后晒制的咸香豆腐干，耐嚼顶饱，冬季限定", w: "宏村景区徽菜馆、冬季农家", img: "" },
        { n: "黄山烧饼", d: "梅干菜猪肉馅炭火烤制，酥皮掉渣，逛老街时趁热买刚出炉的", w: "宏村老街梅干菜烧饼铺", img: "" },
      ],
      "xinduqiao": [
        { n: "牦牛肉汤锅", d: "高原牦牛肉炖锅，肉紧味浓汤滚烫，拍完贡嘎日落回来驱寒", w: "新都桥镇藏式餐馆、康定", img: "" },
        { n: "酥油茶", d: "咸香醇厚，配糌粑点心，清晨高原来一碗缓解高反", w: "新都桥藏家茶馆、牧民家", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/54/Tibetan_butter_tea.jpg/500px-Tibetan_butter_tea.jpg" },
        { n: "青稞饼", d: "青稞面烙烤微甜带嚼劲，赶路早餐配酥油茶最搭", w: "新都桥镇早餐藏餐馆", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/9/9c/%E9%9D%92%E7%A8%9E%E9%A5%BC.jpg/500px-%E9%9D%92%E7%A8%9E%E9%A5%BC.jpg" },
        { n: "藏式酸奶", d: "牦牛奶自然发酵，酸厚起沙，撒白糖或蜂蜜冰凉解腻", w: "新都桥镇藏式酸奶坊", img: "" },
      ],
      "gubei": [
        { n: "北京烤鸭", d: "果木挂炉烤出枣红油亮，片鸭卷饼蘸甜面酱，来京第一顿", w: "前门大街挂炉烤鸭老字号", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/d/d1/Peking_duck_by_Mr_Wabu_in_Beijing.jpg/500px-Peking_duck_by_Mr_Wabu_in_Beijing.jpg" },
        { n: "炸酱面", d: "手擀面拌小碗干炸酱和七八样菜码，胡同面馆一碗管饱", w: "方砖厂69号等胡同老面馆", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/9/9e/Noodles_with_diced_meat_soybean_paste_before_stirring_%2820210102181759%29.jpg/500px-Noodles_with_diced_meat_soybean_paste_before_stirring_%2820210102181759%29.jpg" },
        { n: "豆汁儿", d: "绿豆发酵酸香冲鼻，配焦圈咸菜丝，老北京早点试胆首选", w: "天坛附近老磁器口豆汁店", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/1d/Douzhir_at_Laociqikou_%2820200803141516%29.jpg/500px-Douzhir_at_Laociqikou_%2820200803141516%29.jpg" },
        { n: "卤煮火烧", d: "小肠肺头煮火烧，浓汤烂乎撒蒜汁，深夜胡同里趁热吃", w: "前门廊房二条卤煮老店", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/e/ef/Luzhu_Huoshao_%2820191024192103%29.jpg/500px-Luzhu_Huoshao_%2820191024192103%29.jpg" },
        { n: "炙子烤肉", d: "铁炙子果条烤牛羊肉，孜然香扑鼻夹芝麻烧饼，秋冬最应景", w: "什刹海烤肉季、烤肉宛", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/e/e1/Zhizi_Kaorou%2C_mutton_after_roasting_%2820220219182001%29.jpg/500px-Zhizi_Kaorou%2C_mutton_after_roasting_%2820220219182001%29.jpg" },
      ],
      "suzhou": [
        { n: "松鼠桂鱼", d: "桂鱼剞花刀炸酥浇糖醋汁上桌吱吱作响，苏帮宴席头道菜", w: "观前街松鹤楼、得月楼", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/e/e4/%E6%9D%BE%E9%BC%A0%E6%A1%82%E9%B1%BC.jpg/500px-%E6%9D%BE%E9%BC%A0%E6%A1%82%E9%B1%BC.jpg" },
        { n: "碧螺虾仁", d: "明前碧螺春茶汤入虾仁，清嫩带茶香，春季到苏州限定要吃", w: "十全街苏帮菜馆（春季）", img: "" },
        { n: "苏式汤面", d: "枫镇大肉面白汤鲜醇焖肉酥烂，老苏州赶清晨头汤面", w: "山塘街同得兴等老面馆", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/7/75/%E8%8B%8F%E5%BC%8F%E6%B1%A4%E9%9D%A2.JPG/500px-%E8%8B%8F%E5%BC%8F%E6%B1%A4%E9%9D%A2.JPG" },
        { n: "生煎", d: "皮薄底脆一咬爆汁，临顿路老店现做现卖，排队要趁早", w: "临顿路哑巴生煎老店", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/e/e6/Shengjian_mantou.jpg/500px-Shengjian_mantou.jpg" },
        { n: "桂花鸡头米", d: "秋季芡实糯弹清甜配糖桂花，平江路糖粥摊只有秋天吃得到", w: "平江路糖粥摊（秋季限定）", img: "" },
      ],
      "quanzhou": [
        { n: "面线糊", d: "细面线煮成糊加大肠醋肉卤料，泡油条吃，泉州人的一天从这开始", w: "西街水门国仔面线糊", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/2/29/M%C4%AB-su%C3%A0nn-k%C3%B4o_in_Quanzhou_%2820200929220207%29.jpg/500px-M%C4%AB-su%C3%A0nn-k%C3%B4o_in_Quanzhou_%2820200929220207%29.jpg" },
        { n: "土笋冻", d: "海滩星虫熬出的胶质冻，Q弹鲜甜蘸芥末酱油，夏天吃最爽", w: "西街、中山路土笋冻老铺", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/18/%E5%9C%9F%E7%AC%8B%E5%86%BB.jpg/500px-%E5%9C%9F%E7%AC%8B%E5%86%BB.jpg" },
        { n: "姜母鸭", d: "老姜麻油砂锅焖足两小时的鸭，香浓驱湿，秋冬来一锅正合适", w: "中山路斯丹姜母鸭", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/4/47/Quanzhou-style_Kiu%E2%81%BF-b%C3%B3-ah_%28Ginger_Duck%29_at_Yipin_Xiangqing_Restaurant%2C_Beijing_%2820240908174515%29.jpg/500px-Quanzhou-style_Kiu%E2%81%BF-b%C3%B3-ah_%28Ginger_Duck%29_at_Yipin_Xiangqing_Restaurant%2C_Beijing_%2820240908174515%29.jpg" },
        { n: "烧肉粽", d: "咸蛋黄三层肉香菇包进糯米，热吃蘸甜辣酱，下午顶饿点心", w: "西街侯阿婆肉粽", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/7/79/1980%E7%83%A7%E8%82%89%E7%B2%BD%E5%89%8D%E5%9F%94%E5%BA%97%E7%9A%84%E8%8F%9C%E5%93%81.jpg/500px-1980%E7%83%A7%E8%82%89%E7%B2%BD%E5%89%8D%E5%9F%94%E5%BA%97%E7%9A%84%E8%8F%9C%E5%93%81.jpg" },
        { n: "石花膏", d: "海石花草冻刨丝加蜜水四果，冰凉清甜，夏天逛街解暑标配", w: "天后路四果汤老店", img: "" },
      ],
      "dunhuang": [
        { n: "驴肉黄面", d: "手工拉面浇香菇驴肉臊子，肉香汤浓，敦煌夜宵第一招牌", w: "沙洲夜市顺张黄面馆", img: "" },
        { n: "胡羊焖饼", d: "羊肉炖宽面片吸饱汤汁，肉烂饼筋道，逛完鸣沙山来驱寒", w: "沙洲夜市焖饼老店", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/8/8e/Huyang_Menbing_at_Aftertaste_Studio%2C_Dunhuang_%2820230916205124%29.jpg/500px-Huyang_Menbing_at_Aftertaste_Studio%2C_Dunhuang_%2820230916205124%29.jpg" },
        { n: "杏皮水", d: "李广杏杏皮熬煮酸甜冰爽解腻，夜市烤肉摊边人手一杯", w: "沙洲夜市街头现熬摊", img: "" },
        { n: "敦煌酿皮", d: "厚酿皮拌麻酱辣子油泼蒜汁，筋道酸辣，当小吃也当正餐", w: "沙洲市场酿皮摊", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/9/9f/%E9%85%BF%E7%9A%AE%E5%84%BF_-_panoramio.jpg/500px-%E9%85%BF%E7%9A%AE%E5%84%BF_-_panoramio.jpg" },
      ],
      "yangshuo": [
        { n: "啤酒鱼", d: "漓江剑骨鱼配本地啤酒现焖，鱼鳞煎脆，鲜辣下饭", w: "西街一带啤酒鱼老字号", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/b/bc/Pijiu_Yu_%28Beer_fish%29_%28253141965%29.jpg/500px-Pijiu_Yu_%28Beer_fish%29_%28253141965%29.jpg" },
        { n: "桂林米粉", d: "卤水锅烧脆皮拌米粉，清晨本地人嗦粉那碗最正", w: "阳朔县前街一带米粉老店", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/4/49/Guilin_mifan.jpg/500px-Guilin_mifan.jpg" },
        { n: "田螺酿", d: "螺肉猪肉薄荷酿回壳，微辣，配漓江畔夜啤酒", w: "漓江边农家菜馆", img: "" },
        { n: "斑鱼火锅", d: "现杀斑鱼片涮汤脆弹，汤底鲜甜，饭后鱼粥收尾", w: "阳朔县城斑鱼庄火锅店", img: "" },
      ],
      "haerbin": [
        { n: "锅包肉", d: "现炸糖醋汁外酥里嫩，冷了就软，上桌趁热吃", w: "道外老字号东北菜馆", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/0/04/Guobaorou_at_Zhenbutong%2C_Changchun_%2820220826174428%29.jpg/500px-Guobaorou_at_Zhenbutong%2C_Changchun_%2820220826174428%29.jpg" },
        { n: "哈尔滨红肠", d: "果木熏香蒜味足，切片即食，伴手礼首选", w: "秋林·商委红肠门市部", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c9/China_Harbin_Hongchang_Sausages.jpg/500px-China_Harbin_Hongchang_Sausages.jpg" },
        { n: "马迭尔冰棍", d: "-30℃中央大街吃冰棍是名场面，奶浓不易化", w: "中央大街马迭尔冷饮厅", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/e/e6/%E9%A9%AC%E8%BF%AD%E5%B0%94%E5%86%B0%E6%A3%8D_20220610.jpg/500px-%E9%A9%AC%E8%BF%AD%E5%B0%94%E5%86%B0%E6%A3%8D_20220610.jpg" },
        { n: "铁锅炖", d: "铁锅炖江鱼排骨贴玉米饼，冬季围锅最暖", w: "道外铁锅炖老店", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c3/Tieguodun_at_a_northeastern_restaurant_in_Hengdian%2C_Zhejiang_%2820250131182437%29.jpg/500px-Tieguodun_at_a_northeastern_restaurant_in_Hengdian%2C_Zhejiang_%2820250131182437%29.jpg" },
      ],
      "xuexiang": [
        { n: "小鸡炖蘑菇", d: "榛蘑吸足鸡汤，火炕边就吃最应景，雪乡农家招牌", w: "雪乡农家火炕客栈", img: "" },
        { n: "杀猪菜", d: "酸菜白肉血肠一锅解腻开胃，进山暖身第一顿", w: "雪乡农家院大铁锅现炖", img: "" },
        { n: "冻梨", d: "冻透秋梨缓出冰壳，黑皮冰凉爆汁，饭后解腻", w: "雪乡农户摊现卖", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/8/8d/Rime_Island_Hantun_Village_16_Frozen_Pear_%28Dongli%29_and_persimmon.jpg/500px-Rime_Island_Hantun_Village_16_Frozen_Pear_%28Dongli%29_and_persimmon.jpg" },
      ],
      "wusong": [
        { n: "乌拉满族火锅", d: "铜锅白肉酸菜锅底，蘸料讲究，乌拉街正宗吃法", w: "乌拉街凤吉园等老火锅店", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/8/85/%E5%87%A4%E5%90%89%E5%9B%AD%E8%B4%BE%E5%AE%B6%E7%81%AB%E9%94%85.jpg/500px-%E5%87%A4%E5%90%89%E5%9B%AD%E8%B4%BE%E5%AE%B6%E7%81%AB%E9%94%85.jpg" },
        { n: "庆岭活鱼", d: "松花湖活鱼加把蒿炖，鱼肉嫩，夏秋避暑必吃", w: "庆岭活鱼一条街", img: "" },
        { n: "吉林煎粉", d: "土豆粉坨煎出焦壳拌麻酱蒜汁，吉林市独有小吃", w: "船营区老煎粉小吃店", img: "" },
        { n: "白肉血肠", d: "薄切五花白肉配酸菜血肠蘸蒜泥，满族年味菜", w: "乌拉街满族风味馆", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/9/92/Food_%E8%80%81%E8%88%85%E7%9A%84%E5%AE%B6%E9%84%89%E5%91%B3%2C_%E9%85%B8%E8%8F%9C%E7%99%BD%E8%82%89%E9%8D%8B%2C_%E8%80%81%E8%88%85%E9%85%B8%E8%8F%9C%E7%99%BD%E8%82%89%E9%8D%8B%2C_%E5%8F%B0%E5%8C%97_%2819450311409%29.jpg/500px-Food_%E8%80%81%E8%88%85%E7%9A%84%E5%AE%B6%E9%84%89%E5%91%B3%2C_%E9%85%B8%E8%8F%9C%E7%99%BD%E8%82%89%E9%8D%8B%2C_%E5%8F%B0%E5%8C%97_%2819450311409%29.jpg" },
      ],
      "sanya": [
        { n: "清补凉", d: "椰奶底十多款料冰爽，夜市消暑标配，晚上人多", w: "第一市场夜市清补凉摊", img: "" },
        { n: "椰子鸡", d: "三个椰子水煮文昌鸡清甜，配沙姜小青桔碟", w: "三亚湾大东海椰子鸡店", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/a5/Yeziji_Hainanese_coconut_chicken_soup.jpg/500px-Yeziji_Hainanese_coconut_chicken_soup.jpg" },
        { n: "港门粉", d: "本地人早餐，海鲜汤底粉滑，赶早去才吃得到", w: "解放路港门村老粉店", img: "" },
        { n: "和乐蟹", d: "蟹黄似咸蛋黄，清蒸原味，现挑现加工最鲜", w: "第一市场海鲜加工店", img: "" },
      ],
      "xishuangbanna": [
        { n: "香茅草烤鱼", d: "香茅罗非鱼炭烤，皮焦肉嫩带草香，夜市必点", w: "告庄西双景夜市傣味摊", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/0/09/DFC_4122_Grilled_whole_fish_skewered_and_served_on_a_banana_leaf_-_a_rustic_street-food_favorite.jpg/500px-DFC_4122_Grilled_whole_fish_skewered_and_served_on_a_banana_leaf_-_a_rustic_street-food_favorite.jpg" },
        { n: "菠萝饭", d: "紫米装回菠萝壳蒸，酸甜糯香，傣味餐桌颜值担当", w: "告庄傣味餐厅", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/58/%E8%8F%A0%E8%90%9D%E9%BB%91%E7%B3%AF%E7%B1%B3%E9%A5%AD_Sweet_Black_Glutinous_Rice_in_Pineapple_-_Tastes_of_Dai_stall%2C_Huguoqiaotou_Snack_Centre_%282501942686%29.jpg/500px-%E8%8F%A0%E8%90%9D%E9%BB%91%E7%B3%AF%E7%B1%B3%E9%A5%AD_Sweet_Black_Glutinous_Rice_in_Pineapple_-_Tastes_of_Dai_stall%2C_Huguoqiaotou_Snack_Centre_%282501942686%29.jpg" },
        { n: "傣味包烧", d: "芭蕉叶包肉菜炭烤，锁汁留香，配糯米饭更好", w: "景洪江边夜市傣味老店", img: "" },
        { n: "舂鸡脚", d: "木臼舂出的酸辣鸡脚，柠檬鱼露激香，啃到停不下", w: "告庄夜市傣味舂品摊", img: "" },
      ],
      "mohe": [
        { n: "锅包肉", d: "外酥里嫩酸甜爆汁，林区小馆锅气足，天冷来一盘最下饭", w: "漠河市区东北菜老馆", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/0/04/Guobaorou_at_Zhenbutong%2C_Changchun_%2820220826174428%29.jpg/500px-Guobaorou_at_Zhenbutong%2C_Changchun_%2820220826174428%29.jpg" },
        { n: "铁锅炖江鱼", d: "黑龙江冷水鱼铁锅慢炖，汤白鱼嫩，天冷围着铁锅吃最暖", w: "北极村江边鱼馆", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/6/6d/Tieguodun_at_a_northeastern_restaurant_in_Hengdian%2C_Zhejiang_%2820250131183653%29.jpg/500px-Tieguodun_at_a_northeastern_restaurant_in_Hengdian%2C_Zhejiang_%2820250131183653%29.jpg" },
        { n: "野生蓝莓", d: "大兴安岭八九月野生蓝莓当季，鲜果酸甜，还能买蓝莓果干", w: "北极村集市蓝莓摊", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/b/b9/Vaccinium_corymbosum_Beeren.jpg/500px-Vaccinium_corymbosum_Beeren.jpg" },
        { n: "俄式列巴", d: "俄式大列巴壳硬瓤松带麦香，切片抹蓝莓酱当早餐，边境风味", w: "北极村俄式面包房", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/12/Dalieba_bread_in_Dalian_%282018%29.jpg/500px-Dalieba_bread_in_Dalian_%282018%29.jpg" },
      ],
      "kunming": [
        { n: "过桥米线", d: "滚烫鸡汤现冲生片，汤鲜料足，到昆明第一顿必吃", w: "翠湖旁过桥米线老字号", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c6/%E4%BA%91%E5%8D%97%E8%BF%87%E6%A1%A5%E7%B1%B3%E7%BA%BF.jpg/500px-%E4%BA%91%E5%8D%97%E8%BF%87%E6%A1%A5%E7%B1%B3%E7%BA%BF.jpg" },
        { n: "汽锅鸡", d: "土陶汽锅蒸汽凝汤，鸡汤金黄原汁，秋冬滋补不上火", w: "福照楼等滇菜老字号", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/0/08/%E6%B1%BD%E9%94%85%E9%B8%A1_-_5059256289.jpg/500px-%E6%B1%BD%E9%94%85%E9%B8%A1_-_5059256289.jpg" },
        { n: "野生菌火锅", d: "六到九月雨季松茸牛肝菌下土鸡汤，鲜掉眉毛错过等一年", w: "关上野生菌一条街", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/5d/Mushroom_hot_pot_in_Yunnan.jpg/500px-Mushroom_hot_pot_in_Yunnan.jpg" },
        { n: "鲜花饼", d: "现烤玫瑰酥皮饼掉渣，花瓣馅带着露水气，伴手礼首选", w: "嘉华饼屋现烤门店", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/9/9e/%E5%A4%A7%E7%90%86%E5%8F%A4%E5%9F%8E%E7%8E%AB%E7%91%B0%E9%B2%9C%E8%8A%B1%E9%A5%BC.jpg/500px-%E5%A4%A7%E7%90%86%E5%8F%A4%E5%9F%8E%E7%8E%AB%E7%91%B0%E9%B2%9C%E8%8A%B1%E9%A5%BC.jpg" },
        { n: "小锅米线", d: "小铜锅单人现煮，鲜肉酸浆米线，昆明人早餐刚需", w: "篆新农贸市场米线摊", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/e/ea/%E6%98%86%E6%98%8E%E9%9D%92%E5%92%8C%E5%B0%8F%E9%94%85%E7%B1%B3%E7%BA%BF.jpg/500px-%E6%98%86%E6%98%8E%E9%9D%92%E5%92%8C%E5%B0%8F%E9%94%85%E7%B1%B3%E7%BA%BF.jpg" },
      ],
      "chengdu": [
        { n: "成都火锅", d: "牛油红汤麻辣厚重，毛肚鸭肠七上八下，解馋夜宵首选", w: "玉林路火锅老店", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/4/4e/Chengdu_Hot_Pot_Yuanyangguo_style_2019.jpg/500px-Chengdu_Hot_Pot_Yuanyangguo_style_2019.jpg" },
        { n: "串串香", d: "竹签串菜红汤里烫熟按签结账，人均低，市井烟火气足", w: "建设巷冷锅串串老店", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/4/4c/%E5%85%AD%E5%A9%86%E4%B8%B2%E4%B8%B2%E9%A6%99_-_panoramio.jpg/500px-%E5%85%AD%E5%A9%86%E4%B8%B2%E4%B8%B2%E9%A6%99_-_panoramio.jpg" },
        { n: "担担面", d: "一两碗红油麻酱脆臊，面条筋道，老成都午后打尖首选", w: "文殊院旁老面馆", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/9/95/%E6%8B%85%E6%8B%85%E9%9D%A2_Dandan_noodles.jpg/500px-%E6%8B%85%E6%8B%85%E9%9D%A2_Dandan_noodles.jpg" },
        { n: "钟水饺", d: "纯肉馅淋红油甜蒜汁，咸甜微辣皮薄馅嫩，百年名小吃", w: "提督街钟水饺老店", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c0/Chengdu_Zhong_Dumpling%28Zhong_Jiaozi%29.jpg/500px-Chengdu_Zhong_Dumpling%28Zhong_Jiaozi%29.jpg" },
        { n: "蛋烘糕", d: "小铜锅现烘松软蛋糕，夹果酱奶油肉松，成都街头记忆味", w: "建设巷蛋烘糕小摊", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/9/99/%E8%9B%8B%E7%83%98%E7%B3%95.jpg/500px-%E8%9B%8B%E7%83%98%E7%B3%95.jpg" },
      ],
      "lasa": [
        { n: "手撕牦牛肉", d: "高原牦牛肉紧实耐嚼，风干手撕越嚼越香，还能带回家", w: "八廓街藏餐吧", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/b/b7/Tibetan_yak_meat_dish.jpg/500px-Tibetan_yak_meat_dish.jpg" },
        { n: "藏面", d: "碱水面泡牦骨汤，一碗几口吃完，甜茶馆里配甜茶刚好", w: "光明港琼甜茶馆", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/7/7f/Thukpa%2C_Tibetan_noodle_in_Osaka%2C_Japan.jpg/500px-Thukpa%2C_Tibetan_noodle_in_Osaka%2C_Japan.jpg" },
        { n: "酥油茶", d: "咸香醇厚顶饿抗高反，清晨进甜茶馆先来一暖壶慢慢喝", w: "八廓街甜茶馆", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/54/Tibetan_butter_tea.jpg/500px-Tibetan_butter_tea.jpg" },
        { n: "糌粑", d: "青稞炒面拌酥油茶捏成团，带奶香和嚼劲，藏家主食本味", w: "八廓街藏餐馆", img: "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/aa/Tsampa.jpg/500px-Tsampa.jpg" },
        { n: "牦牛酸奶", d: "酸奶浓得能挂勺，酸得直眯眼，撒白糖压酸最地道", w: "布达拉宫旁酸奶坊", img: "" },
      ],

    }

    const HAY = new Map(DESTS.map((d) => [d.id, haystack(d)]))

    /** 收藏:localStorage 优先,失败退化为内存。 */
    function createWishStore() {
      const KEY = 'dsh-travel:wish'
      let mem = []
      let usable = true
      try {
        const raw = window.localStorage?.getItem(KEY)
        if (Array.isArray(JSON.parse(raw ?? '[]'))) mem = JSON.parse(raw ?? '[]')
      } catch {
        usable = false
      }
      const save = () => {
        if (!usable) return
        try { window.localStorage.setItem(KEY, JSON.stringify(mem)) } catch { usable = false }
      }
      return {
        list: () => mem,
        has: (id) => mem.includes(id),
        toggle(id) {
          mem = mem.includes(id) ? mem.filter((x) => x !== id) : [...mem, id]
          save()
          return mem
        },
      }
    }

    /** AI 结果缓存:同「季节|月份|关键词」直接回放,不重复烧 token。 */
    function createAiCache() {
      const KEY = 'dsh-travel:aicache'
      let mem = {}
      let usable = true
      try {
        const parsed = JSON.parse(window.localStorage?.getItem(KEY) ?? '{}')
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) mem = parsed
      } catch {
        usable = false
      }
      const save = () => {
        if (!usable) return
        try { window.localStorage.setItem(KEY, JSON.stringify(mem)) } catch { usable = false }
      }
      return {
        get: (key) => {
          const hit = mem[key]
          return hit && Array.isArray(hit.items) && hit.items.length > 0 ? hit : null
        },
        put(key, payload) {
          mem[key] = { ...payload, ts: Date.now() }
          const keys = Object.keys(mem)
          if (keys.length > 24) {
            keys.sort((a, b) => (mem[a].ts || 0) - (mem[b].ts || 0))
              .slice(0, keys.length - 24)
              .forEach((k) => { delete mem[k] })
          }
          save()
        },
      }
    }

    /** SSE 帧解析:POST /api/travel/ai,流式回调 onEvent(event, payload)。 */
    async function runAiRequest({ q, season, months, signal, onEvent }) {
      const res = await fetch('/api/travel/ai', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ q, season, months }),
        signal,
      })
      if (!res.ok) {
        let msg = `HTTP ${res.status}`
        try {
          const j = await res.json()
          if (j && j.error) msg = j.error
        } catch { /* keep status */ }
        throw new Error(msg)
      }
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          let ev = 'message'
          const datas = []
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) ev = line.slice(6).trim()
            else if (line.startsWith('data:')) datas.push(line.slice(5).trim())
          }
          if (datas.length === 0) continue
          let payload
          try { payload = JSON.parse(datas.join('\n')) } catch { continue }
          onEvent(ev, payload)
        }
      }
    }

    /* ------------------------------------------------------------------ *
     * 小组件
     * ------------------------------------------------------------------ */
    function BrandIcon({ size }) {
      const s = size ?? 26
      return h('svg', { viewBox: '0 0 64 64', width: s, height: s, 'aria-hidden': true },
        h('rect', { x: 2, y: 2, width: 60, height: 60, rx: 15, fill: 'url(#tvl-ic-bg)' }),
        h('defs', null,
          h('linearGradient', { id: 'tvl-ic-bg', x1: '0', y1: '0', x2: '1', y2: '1' },
            h('stop', { offset: '0', 'stop-color': '#2ea3a8' }),
            h('stop', { offset: '1', 'stop-color': '#176b9e' }))),
        h('circle', { cx: 32, cy: 32, r: 20, fill: 'none', stroke: '#fff', 'stroke-opacity': .92, 'stroke-width': 3.4 }),
        h('path', { d: 'M32 12.5 L36.6 27.4 L51.5 32 L36.6 36.6 L32 51.5 L27.4 36.6 L12.5 32 L27.4 27.4 Z', fill: '#fff', 'fill-opacity': .95 }),
        h('path', { d: 'M32 21.5 L34.9 29.1 L42.5 32 L34.9 34.9 L32 42.5 L29.1 34.9 L21.5 32 L29.1 29.1 Z', fill: '#f6a63c' }),
        h('circle', { cx: 32, cy: 32, r: 3.1, fill: '#e2574c' }))
    }

    function SearchIcon() {
      return h('svg', { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.4, 'stroke-linecap': 'round' },
        h('circle', { cx: 11, cy: 11, r: 7 }),
        h('path', { d: 'm20 20-3.8-3.8' }))
    }

    /** 目的地卡片。 */
    function DestCard({ dest, t, inMonth, wished, onStar, onOpen }) {
      const color = SEASON_COLOR[dest.season]
      const shown = dest.x.slice(0, 2)
      const more = dest.x.length - shown.length
      return h('button', {
        type: 'button', className: 'tvl-card',
        onClick: () => onOpen(dest),
        'aria-label': `${dest.name} · ${dest.region}`,
      },
        h('span', { className: 'tvl-seasline', style: { background: color } }),
        h('div', { className: 'tvl-card-top' },
          h('span', { className: 'tvl-card-name' }, dest.name),
          h('span', { className: 'tvl-card-region' }, dest.region),
          h('span', {
            className: `tvl-star${wished ? ' on' : ''}`,
            role: 'button', 'aria-pressed': wished, title: t(wished ? 'wish.remove' : 'wish.add'),
            onClick: (e) => { e.stopPropagation(); onStar(dest) },
          }, wished ? '★' : '☆')),
        h('div', { className: 'tvl-meta' },
          h('span', { className: `tvl-window${inMonth ? ' in' : ' out'}` }, inMonth ? `✓ ${t('badge.best')}` : fmtMonths(dest.months))),
        h('div', { className: 'tvl-tagline' }, dest.tagline),
        h('div', { className: 'tvl-exps' },
          shown.map((x, i) => h('span', { key: i, className: 'tvl-expchip' },
            `${x.e} `, h('b', null, x.n))),
          more > 0 ? h('span', { className: 'tvl-more' }, `+${more}`) : null),
        h('div', { className: 'tvl-kinds' },
          dest.kinds.slice(0, 3).map((k) => h('span', { key: k, className: 'tvl-kind' }, k))))
    }

    /** 美食页签卡片:封面图 + 招牌菜列表。 */
    function FoodCard({ dest, t, onOpen }) {
      const dishes = DISHES[dest.id] ?? []
      const cover = dishes.find((x) => x.img)
      const shown = dishes.slice(0, 3)
      const more = dishes.length - shown.length
      return h('button', {
        type: 'button', className: 'tvl-card tvl-fcard',
        onClick: () => onOpen(dest),
        'aria-label': `${dest.name} 的招牌美食`,
      },
        cover
          ? h('img', { className: 'tvl-fc-img', src: cover.img, alt: cover.n, loading: 'lazy' })
          : h('span', { className: 'tvl-fc-img ph' }, '🍜'),
        h('div', { className: 'tvl-card-top' },
          h('span', { className: 'tvl-card-name' }, dest.name),
          h('span', { className: 'tvl-card-region' }, dest.region)),
        h('div', { className: 'tvl-fc-dishes' },
          shown.map((x, i) => h('div', { key: i, className: 'tvl-fc-dish' }, h('b', null, x.n), ' ', x.d)),
          more > 0 ? h('span', { className: 'tvl-fc-more' }, `+${more} 道`) : null))
    }

    /** 玩法抽屉(详情)。 */
    function DetailDrawer({ dest, t, wished, onStar, onClose }) {
      const color = SEASON_COLOR[dest.season]
      const season = seasonById[dest.season]
      useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])
      return h(React.Fragment, null,
        h('div', { className: 'tvl-backdrop', onClick: onClose }),
        h('aside', { className: 'tvl-drawer', role: 'dialog', 'aria-modal': true, 'aria-label': dest.name },
          h('button', { type: 'button', className: 'tvl-dr-close', onClick: onClose, 'aria-label': 'close' }, '✕'),
          h('span', { className: 'tvl-dr-wish' },
            h('button', {
              type: 'button', className: `tvl-btn sm${wished ? ' on' : ''}`, onClick: () => onStar(dest),
            }, wished ? `★ ${t('wish.remove')}` : `☆ ${t('wish.add')}`)),
          h('div', { className: 'tvl-dr-head', style: { background: `linear-gradient(180deg, color-mix(in srgb, ${color} 12%, ${C.surface}), ${C.surface} 78%)` } },
            h('span', { className: 'tvl-dr-season', style: { background: color } }, `${season.icon} ${season.label}`),
            h('div', { className: 'tvl-dr-name' }, dest.name, h('small', null, dest.region)),
            h('div', { className: 'tvl-dr-tagline' }, dest.tagline),
            h('div', { className: 'tvl-dr-window' },
              h('span', { className: 'tvl-window in' }, `${t('months', { m: fmtMonths(dest.months) })} · ${dest.months.length} 个月最佳`))),
          h('div', { className: 'tvl-dr-body' },
            h('div', { className: 'tvl-sec' },
              h('div', { className: 'tvl-sec-h' }, '✨ ', t('drawer.exps'), h('span', { className: 'tvl-sec-n' }, `${dest.x.length}`)),
              dest.x.map((x, i) => h('div', { key: i, className: 'tvl-exp' },
                h('span', { className: 'tvl-exp-ic' }, x.e),
                h('div', { className: 'tvl-exp-main' },
                  h('div', { className: 'tvl-exp-name' }, x.n, h('span', { className: 'tvl-exp-when' }, x.w)),
                  h('div', { className: 'tvl-exp-why' }, x.d))))),
            h('div', { className: 'tvl-sec' },
              h('div', { className: 'tvl-sec-h' }, '🍜 ', t('drawer.food'),
                h('span', { className: 'tvl-sec-n' }, `${(DISHES[dest.id] ?? dest.f).length}`)),
              DISHES[dest.id]
                ? h('div', { className: 'tvl-foodgrid' },
                  DISHES[dest.id].map((x, i) => h('div', { key: i, className: 'tvl-foodcard' },
                    x.img
                      ? h('img', { className: 'tvl-foodimg', src: x.img, alt: x.n, loading: 'lazy' })
                      : h('span', { className: 'tvl-foodimg ph' }, '🍜'),
                    h('div', { className: 'tvl-foodcard-b' },
                      h('span', { className: 'tvl-foodcard-n' }, x.n),
                      h('span', { className: 'tvl-foodcard-d' }, x.d),
                      h('span', { className: 'tvl-foodcard-w' }, '📍 ', x.w)))))
                : h('div', { className: 'tvl-foodrow' }, dest.f.map((f) => h('span', { key: f, className: 'tvl-food' }, f)))),
            h('div', { className: 'tvl-sec' },
              h('div', { className: 'tvl-sec-h' }, '📌 ', t('drawer.tips')),
              dest.t.map((tip, i) => h('div', { key: i, className: 'tvl-tip' },
                h('span', { className: 'tvl-tip-ic' }, '●'),
                h('span', null, tip)))))))
    }

    /** AI 兜底结果面板:搜不到时展示默认模型流式生成的玩法。 */
    function AiPanel({ ai, t, month, nowMonth, wishedIds, onStar, onOpen, onRetry }) {
      const busy = ai.phase === 'loading' || ai.phase === 'stream'
      const live = ai.phase === 'stream' ? ai.intro.split('```')[0] : ''
      return h('div', { className: 'tvl-aiwrap' },
        h('div', { className: 'tvl-ai' },
          h('div', { className: 'tvl-ai-head' },
            h('span', null, '🤖'),
            busy
              ? h('span', { className: 'tvl-ai-status' },
                h('span', { className: 'tvl-ai-dot' }),
                t('ai.thinking', { q: ai.q }))
              : h('span', { className: 'tvl-ai-count' },
                ai.phase === 'error' ? t('ai.thinking', { q: ai.q }) : t('ai.count', { n: ai.items.length })),
            h('span', { className: 'tvl-ai-sp' }),
            ai.cached ? h('span', { className: 'tvl-ai-cached' }, t('ai.cached')) : null,
            ai.phase !== 'loading'
              ? h('button', { type: 'button', className: 'tvl-btn sm', onClick: onRetry }, '↻ ', t('ai.retry'))
              : null),
          ai.phase === 'error'
            ? h('div', { className: 'tvl-ai-err' }, t('ai.error', { m: ai.err || '?' }))
            : null,
          live
            ? h('p', { className: 'tvl-ai-intro' }, live, h('span', { className: 'tvl-cursor' }))
            : null,
          ai.phase === 'done' && ai.intro
            ? h('p', { className: 'tvl-ai-intro' }, ai.intro)
            : null,
          ai.phase === 'done'
            ? h('div', { className: 'tvl-grid' },
              ai.items.map((dest) => h(DestCard, {
                key: dest.id, dest, t,
                inMonth: dest.months.includes(month ?? nowMonth),
                wished: wishedIds.includes(dest.id), onStar, onOpen,
              })))
            : null,
          h('div', { className: 'tvl-ai-note' }, t('ai.note'))))
    }

    /* ------------------------------------------------------------------ *
     * 主面板
     * ------------------------------------------------------------------ */
    function App({ t }) {
      const now = useRef(currentMonth())
      const nowSeason = useRef(seasonOf(now.current))
      const wishStore = useRef(createWishStore())

      const [tab, setTab] = useState('now')
      const [month, setMonth] = useState(null)
      const [tags, setTags] = useState([])
      const [query, setQuery] = useState('')
      const [wish, setWish] = useState(wishStore.current.list())
      const [open, setOpen] = useState(null)
      const aiCache = useRef(createAiCache())
      const aiAbort = useRef(null)
      const [ai, setAi] = useState({ q: '', key: '', phase: 'idle', intro: '', items: [], err: null, cached: false })

      const effectiveSeason = tab === 'now' || tab === 'wish' || tab === 'food' ? nowSeason.current : tab
      const season = seasonById[effectiveSeason]
      const activeSeason = tab === 'now' || SEASONS.some((s) => s.id === tab)

      const toggleTag = useCallback((k) => {
        setTags((old) => (old.includes(k) ? old.filter((x) => x !== k) : [...old, k]))
      }, [])

      const switchTab = useCallback((next) => {
        setTab(next)
        if (next === 'now') setMonth(null)
        else if (SEASONS.some((s) => s.id === next)) {
          const s = seasonById[next]
          setMonth(s.months.includes(now.current) ? now.current : null)
        }
        if (next === 'wish' || next === 'food') setTags([])
      }, [])

      const list = useMemo(() => {
        const q = query.trim().toLowerCase()
        let rows
        if (tab === 'food') rows = DESTS.filter((d) => (DISHES[d.id] ?? []).length > 0)
        else if (tab === 'wish') rows = DESTS.filter((d) => wish.includes(d.id))
        else rows = DESTS.filter((d) => d.season === effectiveSeason)
        if (month && tab !== 'wish' && tab !== 'food') rows = rows.filter((d) => d.months.includes(month))
        if (tags.length > 0 && tab !== 'food') rows = rows.filter((d) => d.kinds.some((k) => tags.includes(k)))
        if (q) rows = rows.filter((d) => HAY.get(d.id).includes(q))
        const score = (d) => {
          let v = 0
          if (month && d.months.includes(month)) v += 100
          else if (d.months.includes(now.current)) v += 40
          if (tags.length > 0) v += d.kinds.filter((k) => tags.includes(k)).length * 10
          return v
        }
        return [...rows].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name, 'zh'))
      }, [tab, effectiveSeason, month, tags, query, wish])

      const wishCount = wish.length
      const kindsHere = useMemo(() => {
        const pool = tab === 'wish' ? DESTS.filter((d) => wish.includes(d.id)) : DESTS.filter((d) => d.season === effectiveSeason)
        const set = new Set(pool.flatMap((d) => d.kinds))
        return ALL_KINDS.filter((k) => set.has(k))
      }, [tab, effectiveSeason, wish])

      const roll = useCallback(() => {
        const pool = list.length > 0 ? list : (tab === 'wish' ? DESTS : DESTS)
        const pick = pool[Math.floor(Math.random() * pool.length)]
        if (!pick) return
        setOpen(pick)
      }, [list, tab])

      /* ------- AI 兜底搜索:静态列表搜不到时,让默认模型找当地玩法 ------- */
      const aiMonths = month ? [month] : season.months
      const aiQ = query.trim()

      const runAi = useCallback((q, force) => {
        if (aiAbort.current) { try { aiAbort.current.ctl.abort() } catch { /* gone */ } }
        const key = `${effectiveSeason}|${aiMonths.join(',')}|${q.toLowerCase()}`
        if (!force) {
          const hit = aiCache.current.get(key)
          if (hit) {
            setAi({ q, key, phase: 'done', intro: hit.intro, items: hit.items, err: null, cached: true })
            return
          }
        }
        const ctl = new AbortController()
        aiAbort.current = { ctl, q }
        setAi({ q, key, phase: 'loading', intro: '', items: [], err: null, cached: false })
        // 流必须收到终止帧（done/error）才算有结果。以前超时只 end() 不发帧，
        // 客户端停在 loading，而重试按钮自己也不渲染 —— 用户只能刷新页面。
        let sawTerminal = false
        runAiRequest({
          q, season: effectiveSeason, months: aiMonths, signal: ctl.signal,
          onEvent: (ev, p) => {
            if (ev === 'done' || ev === 'error') sawTerminal = true
            if (ev === 'delta') setAi((s) => (s.key === key ? { ...s, phase: 'stream', intro: (s.intro + (p.text || '')).slice(0, 500) } : s))
            else if (ev === 'done') {
              aiCache.current.put(key, { intro: p.intro, items: p.items })
              // 函数式 + key 守卫：旧请求的 done 不能覆盖新查询的状态。
              setAi((s) => (s.key === key ? { ...s, phase: 'done', intro: p.intro, items: p.items, err: null, cached: false } : s))
            } else if (ev === 'error') {
              setAi((s) => (s.key === key ? { ...s, phase: 'error', err: p.message } : s))
            }
          },
        }).then(() => {
          if (sawTerminal || ctl.signal.aborted) return
          // 兜底：流结束了却一个终止帧都没有（旧服务端的形态），也得让用户有出口。
          setAi((s) => (s.key === key && (s.phase === 'loading' || s.phase === 'stream')
            ? { ...s, phase: 'error', err: 'AI 没有给出结果（连接中断），请重试' } : s))
        }).catch((err) => {
          if (ctl.signal.aborted) return
          setAi((s) => (s.key === key ? { ...s, phase: 'error', err: String(err && err.message ? err.message : err) } : s))
        })
      }, [effectiveSeason, month])

      // 搜不到(≥2 字)时 700ms 防抖自动发起;换词/换筛选会打断旧请求
      useEffect(() => {
        if (tab === 'wish' || tab === 'food' || aiQ.length < 2 || list.length !== 0) return
        const timer = setTimeout(() => runAi(aiQ, false), 700)
        return () => {
          clearTimeout(timer)
          if (aiAbort.current && aiAbort.current.q !== aiQ) {
            try { aiAbort.current.ctl.abort() } catch { /* gone */ }
          }
        }
      }, [aiQ, list.length, tab, runAi])

      const onStar = useCallback((dest) => {
        setWish(wishStore.current.toggle(dest.id))
      }, [])

      const seasons = SEASONS
      const isWishTab = tab === 'wish'
      const isFoodTab = tab === 'food'

      return h('div', { className: 'tvl-root' },
        // 头部
        h('div', { className: 'tvl-head' },
          h('div', { className: 'tvl-brand' },
            h(BrandIcon, { size: 26 }),
            h('div', { className: 'tvl-brand-txt' },
              h('div', { className: 'tvl-title' }, t('nav')),
              h('div', { className: 'tvl-sub' }, t('brand.sub')))),
          h('div', { className: 'tvl-spacer' }),
          h('div', { className: 'tvl-search' },
            h(SearchIcon, null),
            h('input', {
              className: 'tvl-input', value: query,
              placeholder: t('search.ph'),
              onChange: (e) => setQuery(e.target.value),
              'aria-label': t('search.ph'),
            })),
          h('button', { type: 'button', className: 'tvl-btn', onClick: roll, title: t('random') }, '🎲 ', t('random'))),

        // 季节 tabs
        h('div', { className: 'tvl-tabs', role: 'tablist' },
          seasons.map((s) => h('button', {
            key: s.id,
            type: 'button',
            className: `tvl-tab${tab === s.id || (tab === 'now' && s.id === nowSeason.current) ? ' on' : ''}`,
            'aria-selected': tab === s.id,
            role: 'tab',
            onClick: () => switchTab(s.id),
          },
            h('span', { className: 'tvl-ic' }, s.icon), s.label)),
          h('button', {
            type: 'button',
            className: `tvl-tab${isFoodTab ? ' on' : ''}`,
            'aria-selected': isFoodTab,
            role: 'tab',
            onClick: () => switchTab('food'),
          },
            h('span', { className: 'tvl-ic' }, '🍜'), t('tab.food')),
          h('button', {
            type: 'button',
            className: `tvl-tab${isWishTab ? ' on wish-on' : ''}`,
            'aria-selected': isWishTab,
            role: 'tab',
            onClick: () => switchTab('wish'),
          },
            h('span', { className: 'tvl-ic' }, isWishTab ? '★' : '☆'), t('tab.wish', { n: wishCount }))),

        // 当季提示 + 月份
        activeSeason && h('div', { className: 'tvl-nowline' },
          tab === 'now'
            ? h('span', null, '📅 现在是 ', h('b', null, `${now.current} 月·${season.label}季`), ' ', h('span', { className: 'tvl-ic' }, season.icon))
            : null),

        // 月份 chips + 玩法标签 + 结果数
        h('div', { className: 'tvl-filters' },
          activeSeason && h('div', { className: 'tvl-chiprow' },
            h('button', {
              type: 'button', className: `tvl-chip${month === null ? ' on' : ''}`,
              onClick: () => setMonth(null),
            }, t('month.all')),
            season.months.map((m) => h('button', {
              key: m, type: 'button',
              className: `tvl-chip tvl-monthchip${month === m ? ' on' : ''}`,
              onClick: () => setMonth(month === m ? null : m),
            }, `${m}月`, m === now.current && season.months.includes(now.current) ? ' ·今' : null))),
          activeSeason && h('div', { className: 'tvl-chiprow' },
            kindsHere.map((k) => h('button', {
              key: k, type: 'button', 'aria-pressed': tags.includes(k),
              className: `tvl-chip${tags.includes(k) ? ' on' : ''}`,
              onClick: () => toggleTag(k),
            }, k))),
          h('span', { className: 'tvl-count' }, t('count', { n: list.length }), ' · ', isFoodTab ? t('food.hint') : t('sort.hint'))),

        // 卡片
        h('div', { className: 'tvl-body' },
          list.length === 0
            ? h(React.Fragment, null,
              h('div', { className: 'tvl-empty' },
                h('span', { className: 'tvl-empty-ic' }, isWishTab ? '⭐' : isFoodTab ? '🍜' : '🧭'),
                h('span', { className: 'tvl-empty-t' }, isWishTab ? t('wish.empty.title') : isFoodTab ? t('food.empty.title') : t('empty.title')),
                h('span', { className: 'tvl-empty-h' }, isWishTab ? t('wish.empty.hint') : isFoodTab ? t('food.empty.hint') : t('empty.hint'))),
              !isWishTab && !isFoodTab && aiQ.length >= 2 && ai.q === aiQ && ai.phase !== 'idle'
                ? h(AiPanel, {
                    ai, t, month, nowMonth: now.current,
                    wishedIds: wish, onStar, onOpen: setOpen,
                    onRetry: () => runAi(aiQ, true),
                  })
                : null)
            : h('div', { className: 'tvl-grid' },
              list.map((d) => isFoodTab
                ? h(FoodCard, { key: d.id, dest: d, t, onOpen: setOpen })
                : h(DestCard, {
                  key: d.id, dest: d, t,
                  inMonth: month ? d.months.includes(month) : d.months.includes(now.current),
                  wished: wish.includes(d.id),
                  onStar, onOpen: setOpen,
                })))),

        open ? h(DetailDrawer, {
          dest: open, t, wished: wish.includes(open.id),
          onStar, onClose: () => setOpen(null),
        }) : null)
    }

    /* ------------------------------------------------------------------ *
     * 文案
     * ------------------------------------------------------------------ */
    const zh = {
      nav: '旅行灵感',
      'brand.sub': '每个季节,该去哪、玩什么',
      'tab.wish': '想去 ({n})',
      'tab.food': '美食',
      'food.hint': '按菜名或地名搜',
      'food.empty.title': '没找到相关美食',
      'food.empty.hint': '试试菜名或地名,比如「烤鸭」「牛肉面」。',
      'search.ph': '搜地名、玩法、美食…',
      'month.all': '整季',
      count: '{n} 个目的地',
      'sort.hint': '正当时的排前',
      'badge.best': '正当时',
      'wish.add': '想去',
      'wish.remove': '已在想去',
      'wish.empty.title': '还没有想去的地方',
      'wish.empty.hint': '在卡片右上角点一颗星,这里就有了。',
      'drawer.exps': '最好玩的事',
      'drawer.food': '必吃',
      'drawer.tips': '出发前知道',
      random: '随机去哪',
      'empty.title': '没找到',
      'empty.hint': '换个关键词、月份或玩法标签试试。',
      'ai.thinking': 'AI 正在找「{q}」好玩的事…',
      'ai.count': 'AI 找到 {n} 个玩法',
      'ai.cached': '上次的结果',
      'ai.retry': '重新生成',
      'ai.note': 'AI 生成,仅供参考,出行前再核实。',
      'ai.error': 'AI 没帮上忙:{m}',
      months: '最佳:{m}',
    }
    const en = {
      nav: 'Travel',
      'brand.sub': 'Where to go this season, and what to do there',
      'tab.wish': 'Wishlist ({n})',
      'tab.food': 'Food',
      'food.hint': 'search by dish or place',
      'food.empty.title': 'No dishes found',
      'food.empty.hint': 'Try a dish or place name, e.g. "duck".',
      'search.ph': 'Search a place, an activity, a food…',
      'month.all': 'Whole season',
      count: '{n} destinations',
      'sort.hint': 'best-fit first',
      'badge.best': 'In season',
      'wish.add': 'Add to wishlist',
      'wish.remove': 'Remove from wishlist',
      'wish.empty.title': 'No wishlist yet',
      'wish.empty.hint': 'Tap the star on any destination card.',
      'drawer.exps': 'Things to do',
      'drawer.food': 'What to eat',
      'drawer.tips': 'Know before you go',
      random: 'Surprise me',
      'empty.title': 'Nothing matched',
      'empty.hint': 'Try another keyword, month or filter chip.',
      'ai.thinking': 'AI is looking for fun things to do in {q}…',
      'ai.count': 'AI found {n} ideas',
      'ai.cached': 'Saved from last time',
      'ai.retry': 'Regenerate',
      'ai.note': 'AI-generated, for reference only. Double-check before you go.',
      'ai.error': 'AI could not help: {m}',
      months: 'Best: {m}',
    }
    function tOf(dict, key, params) {
      let s = dict[key]
      if (typeof s !== 'string') s = en[key] ?? key
      if (params) {
        for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v))
      }
      return s
    }

    /* ------------------------------------------------------------------ *
     * apply
     * ------------------------------------------------------------------ */
    function apply(ctx) {
      const slots = ctx.get('slots')
      const locale = ctx.get('locale')
      if (!slots || !locale) return

      ctx.effect(() => locale.register(NS, { zh, en }), 'travel: dictionaries')

      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {}
        let el = document.getElementById('tvl-panel-styles')
        const mine = el === null
        if (mine) {
          el = document.createElement('style')
          el.id = 'tvl-panel-styles'
          el.textContent = CSS
          document.head.appendChild(el)
        }
        return () => {
          if (mine && el && el.parentNode) el.parentNode.removeChild(el)
        }
      }, 'travel: panel styles')

      // 侧栏入口
      slots.inject('sidebar.panellist', () => slots.register({
        name: 'sidebar.panellist',
        id: PAGE_ID,
        order: -2,
        label: () => tOf(zh, 'nav'),
        locale: NS,
      }, (props) => h(BrandIcon, { size: props?.size ?? 16 })))

      // 整页
      slots.inject('main', () => slots.register({
        name: 'main',
        key: PAGE_ID,
        locale: NS,
      }, (pageProps) => h(App, { ...pageProps, t: (key, params) => tOf(zh, key, params) })))
    }

    // __parts 给离线冒烟渲染用:不装插件也能把 App 真跑一遍
    return {
      inject,
      apply,
      __parts: {
        DISHES,
        SEASONS,
        SEASON_COLOR,
        DESTS,
        seasonOf,
        currentMonth,
        fmtMonths,
        App,
        BrandIcon,
        DetailDrawer,
        DestCard,
        tOf,
      },
    }
  },
})
