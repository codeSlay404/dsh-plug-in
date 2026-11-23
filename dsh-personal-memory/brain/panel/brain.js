/* ============================================================================
 * 人脑式记忆图 · 3D 可视化原型
 * ----------------------------------------------------------------------------
 * 渲染：WebGL2/WebGL1 实例化（节点 = instanced quads，边 = gl.LINES 一次绘制，
 *       高权边额外一批 instanced quads 做粗细）；无 WebGL 时退化 Canvas2D 批量绘制。
 * 调度：按需出帧 —— 没有漂移 / 脉冲 / 交互 / 高亮过渡时，rAF 完全停下（HUD 显示 REST）。
 * 数据：优先 window.BRAIN_DATA（宿主注入），否则 fetch('./demo.json')，
 *       两者都失败时用内置合成数据兜底（file:// 直接打开也能看）。
 * ==========================================================================*/
(function () {
  'use strict';

  // ------------------------------------------------------------------ utils
  const params = new URLSearchParams(location.search);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const TAU = Math.PI * 2;

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function gauss(rnd) {
    const u = Math.max(rnd(), 1e-9);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * rnd());
  }
  function percentile(arr, p) {
    if (!arr.length) return 0;
    const a = arr.slice().sort((x, y) => x - y);
    const i = clamp(Math.round((p / 100) * (a.length - 1)), 0, a.length - 1);
    return a[i];
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  function fmtTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    if (isNaN(+d)) return '—';
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // ---------------------------------------------------------------- 类型 / 配色
  // center 为脑内坐标（x 前后：+前 -后；y 上下：+上；z 左右，符号代表半球）
  const TYPES = [
    { key: 'memory',  label: '记忆', hex: '#6ea8fe', rgb: [0.43, 0.66, 0.99], center: [-0.28, -0.33, 0.20], spread: 0.30 },
    { key: 'concept', label: '概念', hex: '#b4a0ff', rgb: [0.71, 0.63, 1.00], center: [0.12, 0.42, 0.30], spread: 0.42 },
    { key: 'person',  label: '人物', hex: '#6fe0c0', rgb: [0.44, 0.88, 0.75], center: [0.06, -0.30, 0.46], spread: 0.30 },
    { key: 'place',   label: '地点', hex: '#ffd37a', rgb: [1.00, 0.83, 0.48], center: [-0.63, 0.18, 0.30], spread: 0.30 },
    { key: 'emotion', label: '情绪', hex: '#ff8fa3', rgb: [1.00, 0.56, 0.64], center: [-0.12, -0.47, 0.16], spread: 0.24 },
    { key: 'skill',   label: '技能', hex: '#9ee493', rgb: [0.62, 0.89, 0.58], center: [0.06, 0.70, 0.18], spread: 0.30 },
    { key: 'event',   label: '事件', hex: '#ffb37a', rgb: [1.00, 0.70, 0.48], center: [0.71, 0.22, 0.12], spread: 0.30 }
  ];
  const TYPE_INDEX = {};
  TYPES.forEach((t, i) => { TYPE_INDEX[t.key] = i; });
  const TYPE_COUNT = TYPES.length;

  const EDGE_KINDS = [
    { key: 'temporal', label: '时序' },
    { key: 'semantic', label: '语义' },
    { key: 'emotional', label: '情绪' },
    { key: 'causal', label: '因果' },
    { key: 'cooccur', label: '共现' }
  ];
  const KIND_INDEX = {};
  EDGE_KINDS.forEach((k, i) => { KIND_INDEX[k.key] = i; });

  // ---------------------------------------------------------------- 大脑几何
  // 侧视剪影：x 前(+)/后(-)，y 上(+)/下(-)；含小脑与脑干，闭合平滑后作为轮廓。
  const BRAIN_X = 1.15;
  const PROFILE_RAW = [
    [0.00, 1.00], [0.38, 0.96], [0.70, 0.82], [0.92, 0.58], [1.04, 0.26],
    [1.02, -0.08], [0.90, -0.38], [0.68, -0.56], [0.42, -0.60], [0.22, -0.52],
    [0.04, -0.58], [-0.06, -0.72], [-0.02, -0.86], [-0.14, -0.98], [-0.28, -0.92],
    [-0.30, -0.74], [-0.46, -0.68], [-0.62, -0.82], [-0.80, -0.86], [-0.94, -0.74],
    [-0.90, -0.58], [-1.02, -0.30], [-1.06, 0.02], [-0.98, 0.36], [-0.82, 0.66],
    [-0.58, 0.88], [-0.30, 1.00]
  ].map((p) => [p[0] * BRAIN_X, p[1]]);

  function smoothClosed(pts, perSeg) {
    const out = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
      for (let j = 0; j < perSeg; j++) {
        const t = j / perSeg, t2 = t * t, t3 = t2 * t;
        out.push([
          0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
          0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)
        ]);
      }
    }
    return out;
  }
  const CONTOUR_SRC = smoothClosed(PROFILE_RAW, 10);

  function insideProfile(x, y) {
    let inside = false;
    for (let i = 0, j = PROFILE_RAW.length - 1; i < PROFILE_RAW.length; j = i++) {
      const xi = PROFILE_RAW[i][0], yi = PROFILE_RAW[i][1];
      const xj = PROFILE_RAW[j][0], yj = PROFILE_RAW[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  // 沿左右方向的最大厚度：中间厚、边缘薄
  function zMax(x, y) {
    const r2 = (x / 1.24) * (x / 1.24) + ((y - 0.02) / 1.05) * ((y - 0.02) / 1.05);
    return 0.60 * Math.sqrt(Math.max(0, 1 - r2));
  }

  // 三个轮廓环（z = -0.32 / 0 / +0.32），旋转时一起转，形成隐约的脑壳
  const RINGS = [
    { z: 0.46, s: 0.74, a: 0.10 },
    { z: 0.27, s: 0.95, a: 0.16 },
    { z: 0, s: 1.045, a: 0.30 },
    { z: -0.27, s: 0.95, a: 0.16 },
    { z: -0.46, s: 0.74, a: 0.10 }
  ].map((r) => ({
    z: r.z,
    a: r.a,
    pts: CONTOUR_SRC.map((p) => [p[0] * r.s, (p[1] + 0.02) * r.s - 0.02])
  }));
  // z=0 处的半透明剪影环带（内外两圈之间的 TRIANGLE_STRIP），让脑形在没有任何节点时也能被认出来
  const FILL_ALPHA = 0.05;

  // ---------------------------------------------------------------- 状态容器
  const state = {
    data: null, source: 'demo.json',
    N: 0, NE: 0,
    nodes: [], edges: [],
    nBase: null, nType: null, nStrength: null, nValence: null, nRgb: null, nSeed: null,
    eA: null, eB: null, eW: null, eKind: null,
    adjStart: null, adjEdges: null,
    thick: null, thickW: null,
    nSX: null, nSY: null, nR: null, nA: null, nGlow: null, nZ: null,
    dpr: Math.min(window.devicePixelRatio || 1, 2),
    densityScale: 1
  };

  const camera = { yaw: 0.26, pitch: 0.10, zoom: 0.9, panX: 0, panY: 0 };
  const CAM_DIST = 3.5;
  const START_YAW = 0.26, START_PITCH = 0.10, START_ZOOM = 0.9;

  const LAYERS = { fill: true, edges: true, thick: true, contours: true, nodes: true, pulses: true };

  const scene = {
    w: 0, h: 0, dpr: 1,
    nodeCount: 0, nodes: null,
    edgeCount: 0, edges: null, eBucket: null,
    thickCount: 0, thick: null,
    pulseCount: 0, pulses: null,
    contours: []
  };

  let renderer = null;
  let canvas, ctx2d;
  let animOn = true;
  let pulseOn = true;
  let resting = false;
  let rafId = 0;
  let lastNow = 0;
  let lastInput = 0;
  let framesRendered = 0;
  let benchRunning = false;
  let hoverNode = -1;
  let selectedNode = -1;
  let hlNode = -1;
  let hlMix = 0;
  let hlTarget = 0;
  let dragging = false;
  let dragButton = 0;
  let dragMoved = 0;
  let downX = 0, downY = 0, downT = 0, lastPX = 0, lastPY = 0;
  const pulses = [];
  const MAX_PULSES = 260;
  let activeUntil = null;
  let mark = null;
  let panelEl = null;
  let panelShift = 0;
  let panelTarget = 0;
  let markGen = 0;
  const clusterDrift = new Float32Array(TYPE_COUNT * 3);
  let lastAmbient = 0;
  let frameTimes = [];
  let cpuTimes = [];
  let fps = 0;
  let hudTimer = 0;

  // ---------------------------------------------------------------- 数据规范化
  function normalize(raw) {
    if (!raw || !Array.isArray(raw.nodes) || !raw.nodes.length) throw new Error('数据缺少 nodes');
    const used = new Set();
    const nodes = [];
    const idMap = new Map();
    raw.nodes.forEach((n, i) => {
      if (!n) return;
      const id = String(n.id != null ? n.id : 'n' + i);
      if (used.has(id)) return;
      used.add(id);
      const type = TYPE_INDEX[n.type] != null ? n.type : 'concept';
      let strength = Number(n.strength);
      if (!isFinite(strength)) strength = 0.45;
      strength = clamp(strength, 0, 1);
      let valence = Number(n.valence);
      if (!isFinite(valence)) valence = 0;
      valence = clamp(valence, -1, 1);
      const ts = Number(n.ts) || 0;
      const label = String(n.label || n.title || n.content || id).slice(0, 24);
      const content = String(n.content || n.text || label);
      // 两类节点视觉分开：会话片段（episode）压暗压小，笔记保持亮；
      // 同一张图里「这里是我写过的」和「这里是聊过的」一眼能认出来。
      const nodeKind = n.nodeKind === 'episode' || String(id).startsWith('e:') ? 'episode' : 'note';
      if (nodeKind === 'episode') strength = clamp(strength * 0.45, 0, 1);
      idMap.set(id, nodes.length);
      nodes.push({
        id, type, strength, valence, ts, label, content, degree: 0, nodeKind,
        fixedX: isFinite(n.x) ? Number(n.x) : null,
        fixedY: isFinite(n.y) ? Number(n.y) : null,
        fixedZ: isFinite(n.z) ? Number(n.z) : null
      });
    });

    const edges = [];
    const seen = new Set();
    (raw.edges || []).forEach((e) => {
      if (!e) return;
      const a = idMap.get(String(e.source)), b = idMap.get(String(e.target));
      if (a == null || b == null || a === b) return;
      const key = a < b ? a + ':' + b : b + ':' + a;
      if (seen.has(key)) return;
      seen.add(key);
      let w = Number(e.weight);
      if (!isFinite(w)) w = 0.4;
      w = clamp(w, 0.02, 1);
      const kind = KIND_INDEX[e.kind] != null ? EDGE_KINDS[KIND_INDEX[e.kind]].key : 'temporal';
      edges.push({ a, b, w, kind });
      nodes[a].degree++;
      nodes[b].degree++;
    });
    if (!edges.length) throw new Error('数据缺少有效 edges');
    return { nodes, edges, meta: raw.meta || {} };
  }

  function buildGraph(data) {
    const { nodes, edges } = data;
    const N = nodes.length, NE = edges.length;
    state.data = data;
    state.nodes = nodes;
    state.edges = edges;
    state.N = N;
    state.NE = NE;

    state.nBase = new Float32Array(N * 3);
    state.nType = new Uint8Array(N);
    state.nStrength = new Float32Array(N);
    state.nValence = new Float32Array(N);
    state.nRgb = new Float32Array(N * 3);
    state.nSeed = new Float32Array(N);
    state.nSX = new Float32Array(N);
    state.nSY = new Float32Array(N);
    state.nR = new Float32Array(N);
    state.nA = new Float32Array(N);
    state.nGlow = new Float32Array(N);
    state.nZ = new Float32Array(N);
    state.activeUntil = new Float32Array(N);

    // ---- 布局：按类型分簇，落在脑剪影体积内（同 id 一定同位置，可复现）
    for (let i = 0; i < N; i++) {
      const n = nodes[i];
      const ti = TYPE_INDEX[n.type];
      const spec = TYPES[ti];
      const rnd = mulberry32(hashStr(n.id));
      state.nType[i] = ti;
      state.nStrength[i] = n.strength;
      state.nValence[i] = n.valence;
      state.nSeed[i] = rnd();
      let x, y, z;
      if (n.fixedX != null && n.fixedY != null) {
        x = n.fixedX; y = n.fixedY; z = n.fixedZ != null ? n.fixedZ : (rnd() * 2 - 1) * 0.3;
      } else {
        const side = rnd() < 0.5 ? -1 : 1;
        let placed = false;
        for (let k = 0; k < 72; k++) {
          x = spec.center[0] + gauss(rnd) * spec.spread;
          y = spec.center[1] + gauss(rnd) * spec.spread * 0.84;
          z = spec.center[2] * side + gauss(rnd) * spec.spread * 0.78;
          if (!insideProfile(x, y)) continue;
          const zm = zMax(x, y);
          if (Math.abs(z) > zm * 0.96) {
            z = z * 0.55;
            if (Math.abs(z) > zm * 0.96) continue;
          }
          placed = true;
          break;
        }
        if (!placed) {
          // 兜底：脑内均匀采样
          for (let k = 0; k < 160; k++) {
            x = (rnd() * 2 - 1) * 1.18;
            y = (rnd() * 2 - 1) * 1.0;
            if (insideProfile(x, y)) break;
          }
          z = (rnd() * 2 - 1) * zMax(x, y) * 0.7;
        }
        x *= 0.985; y *= 0.985;
      }
      state.nBase[i * 3] = x;
      state.nBase[i * 3 + 1] = y;
      state.nBase[i * 3 + 2] = z;

      // 效价轻微染色：正向偏暖，负向偏冷
      const c = spec.rgb;
      const warm = n.valence >= 0;
      const k = Math.abs(n.valence) * 0.16;
      state.nRgb[i * 3] = clamp(c[0] + (warm ? 0.10 : -0.04) * k * 6, 0, 1);
      state.nRgb[i * 3 + 1] = clamp(c[1] + (warm ? 0.02 : 0.03) * k * 6, 0, 1);
      state.nRgb[i * 3 + 2] = clamp(c[2] + (warm ? -0.06 : 0.06) * k * 6, 0, 1);
    }

    // ---- 边
    state.eA = new Int32Array(NE);
    state.eB = new Int32Array(NE);
    state.eW = new Float32Array(NE);
    state.eKind = new Uint8Array(NE);
    const thickArr = [];
    for (let e = 0; e < NE; e++) {
      const ed = edges[e];
      state.eA[e] = ed.a; state.eB[e] = ed.b; state.eW[e] = ed.w;
      state.eKind[e] = KIND_INDEX[ed.kind] || 0;
      if (ed.w >= 0.6) thickArr.push(e);
    }
    state.thick = Int32Array.from(thickArr);

    // ---- 邻接（CSR）
    const deg = new Int32Array(N + 1);
    for (let e = 0; e < NE; e++) { deg[state.eA[e]]++; deg[state.eB[e]]++; }
    const start = new Int32Array(N + 1);
    for (let i = 0; i < N; i++) start[i + 1] = start[i] + deg[i];
    const fill = start.slice(0, N);
    const adj = new Int32Array(NE * 2);
    for (let e = 0; e < NE; e++) {
      const a = state.eA[e], b = state.eB[e];
      adj[fill[a]++] = e;
      adj[fill[b]++] = e;
    }
    state.adjStart = start;
    state.adjEdges = adj;

    mark = state.mark = new Uint32Array(N);
    markGen = state.markGen = 1;
    state.activeUntil = new Float32Array(N);

    // ---- 场景缓冲（按最大规模一次性分配）
    scene.nodes = new Float32Array(N * 8);
    scene.edges = new Float32Array(NE * 2 * 3);
    scene.eBucket = new Uint8Array(NE);
    scene.thick = new Float32Array(Math.max(1, state.thick.length) * 7);
    scene.pulses = new Float32Array(MAX_PULSES * 4 * 8);
    scene.contours = RINGS.map((r) => new Float32Array(r.pts.length * 3));
    scene.fill = new Float32Array((CONTOUR_SRC.length * 2 + 2) * 3);
    scene.dpr = state.dpr;
    state.densityScale = clamp(Math.sqrt(900 / Math.max(1, NE)), 0.34, 1);
    state.nodeScale = clamp(Math.pow(600 / Math.max(1, N), 0.34), 0.5, 1.25);

    camera.yaw = START_YAW; camera.pitch = START_PITCH; camera.zoom = START_ZOOM;
    camera.panX = 0; camera.panY = 0;
    pulses.length = 0;
    hoverNode = -1; selectedNode = -1; hlNode = -1; hlMix = 0; hlTarget = 0;
  }

  // ---------------------------------------------------------------- 合成数据
  const SYN_LABELS = {
    memory: ['便利店关东煮', '海边日出', '雨夜末班车', '外婆的灶台', '第一次潜水', '屋顶的晚风', '凌晨的面馆', '旧书摊的味道'],
    concept: ['注意力残留', '复利效应', '心流状态', '损失厌恶', '间隔重复', '沉没成本', '第一性原理', '熵与秩序'],
    person: ['沈阿姨', '室友阿哲', '导师老周', '咖啡店老板', '楼下保安', '搭档小林', '组件里的大刘', '表妹果果'],
    place: ['京都鸭川', '公司三楼茶水间', '鼓浪屿小巷', '图书馆四楼', '青岛的海堤', '西湖断桥', '城西旧厂房', '南站候车厅'],
    emotion: ['被理解的松弛', '没来由的烦躁', '松了口气', '轻微的愧疚', '安静的满足', '临考前的紧'],
    skill: ['盲打', '煎溏心蛋', '看懂卷积', '骑摩托车', '讲清楚一件事', '用 vim 改名', '手冲咖啡'],
    event: ['2024 第一次述职', '搬家那天', '通宵修 bug', '生日聚餐', '第一次见客户', '台风停工', '马拉松完赛']
  };
  function syntheticData(n, m) {
    n = clamp(n | 0, 10, 20000);
    m = clamp(m | 0, 10, 40000);
    const rnd = mulberry32(20261122);
    const types = TYPES.map((t) => t.key);
    const nodes = [];
    for (let i = 0; i < n; i++) {
      const t = types[Math.floor(rnd() * types.length)];
      const pool = SYN_LABELS[t] || SYN_LABELS.concept;
      const label = pool[Math.floor(rnd() * pool.length)] + (rnd() < 0.4 ? ' ' + (i + 1) : '');
      nodes.push({
        id: 'n' + i,
        type: t,
        strength: Math.pow(rnd(), 1.4),
        valence: Math.round((rnd() * 2 - 1) * 100) / 100,
        ts: Date.UTC(2023, 0, 1) + Math.floor(rnd() * 1000) * 86400000,
        label: label.slice(0, 24),
        content: label + '——' + (SYN_LABELS.concept[Math.floor(rnd() * 8)] || '') + '，与「' + (SYN_LABELS.memory[Math.floor(rnd() * 8)] || '') + '」有关。'
      });
    }
    const edges = [];
    const seen = new Set();
    let guard = 0;
    while (edges.length < m && guard++ < m * 30) {
      let a, b;
      if (rnd() < 0.55) {
        a = Math.floor(rnd() * n);
        b = clamp(a + Math.floor((rnd() - 0.5) * 40), 0, n - 1);
      } else {
        a = Math.floor(rnd() * n);
        b = Math.floor(rnd() * n);
      }
      if (a === b) continue;
      const key = a < b ? a + ':' + b : b + ':' + a;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: 'n' + a, target: 'n' + b,
        weight: 0.08 + Math.pow(rnd(), 1.7) * 0.9,
        kind: EDGE_KINDS[Math.floor(rnd() * EDGE_KINDS.length)].key
      });
    }
    return { meta: { title: '合成数据', synthetic: true, nodes: n, edges: edges.length }, nodes, edges };
  }

  // ---------------------------------------------------------------- 场景构建
  function buildScene(now) {
    const W = canvas.width, H = canvas.height, dpr = state.dpr;
    const N = state.N, NE = state.NE;
    scene.w = W; scene.h = H; scene.dpr = dpr;
    scene.nodeCount = N;
    scene.edgeCount = NE;

    const cyw = Math.cos(camera.yaw), syw = Math.sin(camera.yaw);
    const cpi = Math.cos(camera.pitch), spi = Math.sin(camera.pitch);
    const focal = H * 1.34 * camera.zoom;
    panelTarget = (panelEl && panelEl.classList.contains('is-open')) ? -W * 0.075 : 0;
    panelShift += (panelTarget - panelShift) * 0.16;
    if (Math.abs(panelTarget - panelShift) < 0.4) panelShift = panelTarget;
    const ox = W * 0.5 + camera.panX * dpr + panelShift;
    const oy = H * 0.5 + camera.panY * dpr;
    const t = now * 0.001;

    for (let c = 0; c < TYPE_COUNT; c++) {
      const ph = c * 1.71;
      clusterDrift[c * 3] = Math.sin(t * 0.31 + ph) * 0.031;
      clusterDrift[c * 3 + 1] = Math.cos(t * 0.24 + ph * 1.31) * 0.026;
      clusterDrift[c * 3 + 2] = Math.sin(t * 0.19 + ph * 0.7) * 0.034;
    }

    // ---- 高亮目标：优先 hover，其次选中
    const focus = hoverNode >= 0 ? hoverNode : selectedNode;
    hlTarget = focus >= 0 ? 1 : 0;
    hlMix += (hlTarget - hlMix) * 0.22;
    if (Math.abs(hlTarget - hlMix) < 0.004) hlMix = hlTarget;
    hlNode = focus;
    const hl = hlMix > 0.01 ? hlNode : -1;

    // 标记一跳邻域
    if (hl >= 0) {
      markGen++;
      mark[hl] = markGen;
      const s = state.adjStart, a = state.adjEdges;
      for (let k = s[hl]; k < s[hl + 1]; k++) {
        const e = a[k];
        mark[state.eA[e] === hl ? state.eB[e] : state.eA[e]] = markGen;
      }
    }

    // ---- 节点
    const base = state.nBase, seed = state.nSeed, ntype = state.nType;
    const nSX = state.nSX, nSY = state.nSY, nR = state.nR, nA = state.nA, nGlow = state.nGlow, nZ = state.nZ;
    const nStr = state.nStrength;
    const out = scene.nodes;
    const nodeScale = state.nodeScale;
    const active = state.activeUntil;

    for (let i = 0; i < N; i++) {
      const ti = ntype[i];
      const bi = i * 3;
      const w = 0.72 + seed[i] * 0.6;
      const x = base[bi] + clusterDrift[ti * 3] * w;
      const y = base[bi + 1] + clusterDrift[ti * 3 + 1] * w;
      const z = base[bi + 2] + clusterDrift[ti * 3 + 2] * w;

      const x1 = x * cyw + z * syw;
      const z1 = -x * syw + z * cyw;
      const y2 = y * cpi - z1 * spi;
      const z2 = y * spi + z1 * cpi + CAM_DIST;

      const zi = i * 8;
      if (z2 < 0.35) { nR[i] = 0; nA[i] = 0; out[zi + 2] = 0; out[zi + 6] = 0; continue; }

      const s = focal / z2;
      const sx = ox + x1 * s;
      const sy = oy - y2 * s;
      const rad = (1.75 + nStr[i] * 3.0) * dpr * (CAM_DIST / z2) * nodeScale;
      nSX[i] = sx; nSY[i] = sy; nR[i] = rad; nZ[i] = z2;

      let alpha = (0.68 + nStr[i] * 0.32) * (0.62 + nodeScale * 0.38);
      let glow = 0.20 + nStr[i] * 0.26;
      if (now < active[i]) { glow = 1; alpha = 1; }
      if (hl >= 0) {
        const h = hlMix;
        if (i === hl) { alpha = Math.min(1, alpha + 0.5 * h); glow = Math.max(glow, h); }
        else if (mark[i] === markGen) { alpha = Math.min(1, alpha * (1 + 0.55 * h)); glow = Math.max(glow, 0.45 * h); }
        else { alpha = alpha * (1 - 0.82 * h); glow *= 1 - h; }
      }
      nA[i] = alpha;
      nGlow[i] = glow;

      out[zi] = sx; out[zi + 1] = sy; out[zi + 2] = rad;
      const ci = i * 3;
      out[zi + 3] = state.nRgb[ci];
      out[zi + 4] = state.nRgb[ci + 1];
      out[zi + 5] = state.nRgb[ci + 2];
      out[zi + 6] = alpha;
      out[zi + 7] = glow;
    }

    // ---- 边
    const eout = scene.edges;
    const dens = state.densityScale;
    let ei = 0;
    for (let e = 0; e < NE; e++) {
      const a = state.eA[e], b = state.eB[e];
      const ra = nR[a], rb = nR[b];
      const wa = state.eW[e];
      scene.eBucket[e] = Math.min(4, (wa * 5) | 0);
      if (ra <= 0 || rb <= 0) {
        eout[ei++] = 0; eout[ei++] = 0; eout[ei++] = 0;
        eout[ei++] = 0; eout[ei++] = 0; eout[ei++] = 0;
        continue;
      }
      let alpha = (0.022 + wa * 0.11) * dens;
      const depth = (CAM_DIST * 2) / (nZ[a] + nZ[b]);
      alpha *= clamp(depth, 0.55, 1.15);
      if (hl >= 0) {
        const incident = a === hl || b === hl;
        const between = mark[a] === markGen && mark[b] === markGen;
        if (incident) alpha = Math.min(0.9, alpha * 2.6 + 0.18 * hlMix);
        else if (between) alpha = Math.min(0.6, alpha * 1.6);
        else alpha *= 1 - 0.72 * hlMix;
      }
      if (now < active[a] || now < active[b]) alpha = Math.min(0.95, alpha * 1.7);
      eout[ei++] = nSX[a]; eout[ei++] = nSY[a]; eout[ei++] = alpha;
      eout[ei++] = nSX[b]; eout[ei++] = nSY[b]; eout[ei++] = alpha;
    }

    // ---- 重边（weight >= 0.6）：拉成短四边形，让粗的神经丝真的更粗
    const tout = scene.thick;
    const thick = state.thick;
    let ti2 = 0;
    for (let k = 0; k < thick.length; k++) {
      const e = thick[k];
      const a = state.eA[e], b = state.eB[e];
      if (nR[a] <= 0 || nR[b] <= 0) continue;
      const dx = nSX[b] - nSX[a], dy = nSY[b] - nSY[a];
      const len = Math.hypot(dx, dy);
      if (len < 0.5) continue;
      let alpha = (0.028 + state.eW[e] * 0.17) * dens * 1.15;
      if (hl >= 0) {
        const incident = a === hl || b === hl;
        alpha = incident ? Math.min(0.9, alpha * 2.4 + 0.16 * hlMix) : alpha * (1 - 0.72 * hlMix);
      }
      if (now < active[a] || now < active[b]) alpha = Math.min(0.95, alpha * 1.6);
      tout[ti2++] = nSX[a];
      tout[ti2++] = nSY[a];
      tout[ti2++] = dx / len;
      tout[ti2++] = dy / len;
      tout[ti2++] = len;
      tout[ti2++] = (0.55 + state.eW[e] * 1.5) * dpr;
      tout[ti2++] = alpha;
    }
    scene.thickCount = ti2 / 7;

    // ---- 轮廓环
    for (let r = 0; r < RINGS.length; r++) {
      const ring = RINGS[r];
      const arr = scene.contours[r];
      for (let i = 0; i < ring.pts.length; i++) {
        const px = ring.pts[i][0], py = ring.pts[i][1], pz = ring.z;
        const x1 = px * cyw + pz * syw;
        const z1 = -px * syw + pz * cyw;
        const y2 = py * cpi - z1 * spi;
        const z2 = py * spi + z1 * cpi + CAM_DIST;
        const s = focal / z2;
        arr[i * 3] = ox + x1 * s;
        arr[i * 3 + 1] = oy - y2 * s;
        arr[i * 3 + 2] = ring.a * clamp(focal / (z2 * 260), 0.65, 1.25);
      }
    }

    // ---- 剪影环带（同一套投影，z = 0）：内圈 alpha 0 → 外圈 FILL_ALPHA，边缘柔化
    {
      const f = scene.fill;
      const pts = CONTOUR_SRC;
      const SK = 0.855;
      const OUT = 1.045;
      const n = pts.length;
      for (let i = 0; i <= n; i++) {
        const p = pts[i % n];
        const px = p[0], py = p[1];
        const x1 = px * cyw, z1 = -px * syw;
        const y2 = py * cpi - z1 * spi;
        const z2 = py * spi + z1 * cpi + CAM_DIST;
        const s = focal / z2;
        const inner = i * 2 * 3, outer = inner + 3;
        f[inner] = ox + x1 * SK * s;
        f[inner + 1] = oy - y2 * SK * s;
        f[inner + 2] = 0;
        f[outer] = ox + x1 * OUT * s;
        f[outer + 1] = oy - y2 * OUT * s;
        f[outer + 2] = FILL_ALPHA;
      }
      scene.fillCount = (n + 1) * 2;
    }

    // ---- 脉冲
    const pout = scene.pulses;
    let pi = 0;
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i];
      const prog = (now - p.t0) / p.dur;
      if (prog < 0) continue;
      if (prog >= 1) { pulses.splice(i, 1); continue; }
      const a = p.a, b = p.b;
      if (nR[a] <= 0 || nR[b] <= 0) continue;
      const ease = Math.sin(Math.PI * prog);
      for (let k = 0; k < 4; k++) {
        const tt = prog - k * 0.05;
        if (tt < 0) break;
        const x = lerp(nSX[a], nSX[b], tt);
        const y = lerp(nSY[a], nSY[b], tt);
        const alpha = ease * Math.pow(0.42, k) * 0.95;
        const size = (2.25 - k * 0.4) * dpr;
        pout[pi++] = x; pout[pi++] = y; pout[pi++] = size;
        pout[pi++] = 0.83; pout[pi++] = 0.93; pout[pi++] = 1.0;
        pout[pi++] = alpha; pout[pi++] = 1;
      }
    }
    scene.pulseCount = pi / 8;
  }

  // ---------------------------------------------------------------- WebGL 渲染器
  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('shader: ' + gl.getShaderInfoLog(sh));
    }
    return sh;
  }
  function makeProgram(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('link: ' + gl.getProgramInfoLog(p));
    }
    return p;
  }

  const NODE_VS = `
    precision mediump float;
    attribute vec2 a_corner;
    attribute vec2 a_center;
    attribute float a_radius;
    attribute vec3 a_color;
    attribute float a_alpha;
    attribute float a_glow;
    uniform vec2 u_res;
    varying vec2 v_uv;
    varying vec3 v_col;
    varying float v_a;
    varying float v_glow;
    void main() {
      v_uv = a_corner;
      v_col = a_color;
      v_a = a_alpha;
      v_glow = a_glow;
      float r = a_radius * (1.0 + a_glow * 0.9);
      vec2 p = a_center + a_corner * r;
      vec2 clip = vec2(p.x / u_res.x * 2.0 - 1.0, 1.0 - p.y / u_res.y * 2.0);
      gl_Position = vec4(clip, 0.0, 1.0);
    }`;
  const NODE_FS = `
    precision mediump float;
    varying vec2 v_uv;
    varying vec3 v_col;
    varying float v_a;
    varying float v_glow;
    void main() {
      float d = length(v_uv);
      if (d > 1.0) discard;
      float core = smoothstep(1.0, 0.2, d);
      core *= core;
      float halo = v_glow * smoothstep(1.0, 0.34, d) * (1.0 - smoothstep(0.3, 0.02, d));
      float a = v_a * clamp(core + halo * 0.62, 0.0, 1.0);
      if (a < 0.004) discard;
      vec3 col = mix(v_col, v_col * 0.55 + vec3(0.45), v_glow * 0.42 * (1.0 - d));
      gl_FragColor = vec4(col, a);
    }`;
  const EDGE_VS = `
    precision mediump float;
    attribute vec2 a_pos;
    attribute float a_alpha;
    uniform vec2 u_res;
    varying float v_a;
    void main() {
      v_a = a_alpha;
      gl_Position = vec4(a_pos.x / u_res.x * 2.0 - 1.0, 1.0 - a_pos.y / u_res.y * 2.0, 0.0, 1.0);
    }`;
  const EDGE_FS = `
    precision mediump float;
    uniform vec3 u_color;
    varying float v_a;
    void main() {
      if (v_a < 0.002) discard;
      gl_FragColor = vec4(u_color, v_a);
    }`;
  const THICK_VS = `
    precision mediump float;
    attribute vec2 a_corner;
    attribute vec2 a_center;
    attribute vec2 a_dir;
    attribute float a_len;
    attribute float a_width;
    attribute float a_alpha;
    uniform vec2 u_res;
    varying float v_side;
    varying float v_a;
    void main() {
      vec2 p = a_center + a_dir * (a_corner.x * a_len * 0.5) + vec2(-a_dir.y, a_dir.x) * (a_corner.y * a_width * 0.5);
      v_side = a_corner.y;
      v_a = a_alpha;
      gl_Position = vec4(p.x / u_res.x * 2.0 - 1.0, 1.0 - p.y / u_res.y * 2.0, 0.0, 1.0);
    }`;
  const THICK_FS = `
    precision mediump float;
    uniform vec3 u_color;
    varying float v_side;
    varying float v_a;
    void main() {
      float f = 1.0 - abs(v_side);
      float a = v_a * smoothstep(0.0, 0.75, f);
      if (a < 0.002) discard;
      gl_FragColor = vec4(u_color, a);
    }`;

  function createGLRenderer(cv, N, NE, T, MAXP) {
    const opts = { alpha: false, antialias: true, depth: false, stencil: false, powerPreference: 'high-performance' };
    let gl = cv.getContext('webgl2', opts);
    let gl2 = !!gl;
    if (!gl) gl = cv.getContext('webgl', opts) || cv.getContext('experimental-webgl', opts);
    if (!gl) return null;
    gl.__gl2 = gl2;
    const inst = gl2 ? null : gl.getExtension('ANGLE_instanced_arrays');
    if (!gl2 && !inst) return null;

    const nodeProg = makeProgram(gl, NODE_VS, NODE_FS);
    const edgeProg = makeProgram(gl, EDGE_VS, EDGE_FS);
    const thickProg = makeProgram(gl, THICK_VS, THICK_FS);

    function loc(p, name) { return gl.getAttribLocation(p, name); }
    const nl = {
      corner: loc(nodeProg, 'a_corner'), center: loc(nodeProg, 'a_center'),
      radius: loc(nodeProg, 'a_radius'), color: loc(nodeProg, 'a_color'),
      alpha: loc(nodeProg, 'a_alpha'), glow: loc(nodeProg, 'a_glow'),
      res: gl.getUniformLocation(nodeProg, 'u_res')
    };
    const el = {
      pos: loc(edgeProg, 'a_pos'), alpha: loc(edgeProg, 'a_alpha'),
      res: gl.getUniformLocation(edgeProg, 'u_res'),
      color: gl.getUniformLocation(edgeProg, 'u_color')
    };
    const tl = {
      corner: loc(thickProg, 'a_corner'), center: loc(thickProg, 'a_center'),
      dir: loc(thickProg, 'a_dir'), len: loc(thickProg, 'a_len'),
      width: loc(thickProg, 'a_width'), alpha: loc(thickProg, 'a_alpha'),
      res: gl.getUniformLocation(thickProg, 'u_res'),
      color: gl.getUniformLocation(thickProg, 'u_color')
    };

    function buf(dataOrSize, dynamic) {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, dataOrSize, dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
      return b;
    }
    const quadBuf = buf(new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]));
    const nodeBuf = buf(N * 8 * 4, true);
    const edgeBuf = buf(Math.max(6, NE * 2 * 3) * 4, true);
    const thickBuf = buf(Math.max(7, T * 7) * 4, true);
    const pulseBuf = buf(MAXP * 8 * 4, true);
    const contourBufs = RINGS.map((r) => buf(r.pts.length * 3 * 4, true));
    const fillBuf = buf((CONTOUR_SRC.length * 2 + 2) * 3 * 4, true);

    function divisor(l, d) {
      if (gl2) gl.vertexAttribDivisor(l, d);
      else inst.vertexAttribDivisorANGLE(l, d);
    }
    function drawInst(mode, first, verts, count) {
      if (gl2) gl.drawArraysInstanced(mode, first, verts, count);
      else inst.drawArraysInstancedANGLE(mode, first, verts, count);
    }
    function attrib(l, size, stride, offset) {
      if (l < 0) return;
      gl.enableVertexAttribArray(l);
      gl.vertexAttribPointer(l, size, gl.FLOAT, false, stride, offset);
    }
    function off() {
      [nl.corner, nl.center, nl.radius, nl.color, nl.alpha, nl.glow,
        el.pos, el.alpha, tl.corner, tl.center, tl.dir, tl.len, tl.width].forEach((l) => {
        if (l >= 0) gl.disableVertexAttribArray(l);
      });
    }

    gl.clearColor(0.024, 0.031, 0.047, 1);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);

    const api = {
      kind: gl2 ? 'webgl2' : 'webgl1',
      gl,
      draw: function (sc) {
        const W = sc.w, H = sc.h, dpr = sc.dpr;
        gl.viewport(0, 0, W, H);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        off();

        // 0. 脑壳剪影填充：一次 TRIANGLE_FAN，最底层
        if (sc.fillCount && LAYERS.fill) {
          gl.useProgram(edgeProg);
          gl.uniform2f(el.res, W, H);
          gl.uniform3f(el.color, 0.30, 0.44, 0.78);
          gl.bindBuffer(gl.ARRAY_BUFFER, fillBuf);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, sc.fill.subarray(0, sc.fillCount * 3));
          attrib(el.pos, 2, 12, 0);
          attrib(el.alpha, 1, 12, 8);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, sc.fillCount);
          off();
        }

        // 1. 所有边：一次 gl.LINES
        if (LAYERS.edges) {
        gl.useProgram(edgeProg);
        gl.uniform2f(el.res, W, H);
        gl.uniform3f(el.color, 0.52, 0.66, 0.95);
        gl.bindBuffer(gl.ARRAY_BUFFER, edgeBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, sc.edges.subarray(0, sc.edgeCount * 6));
        attrib(el.pos, 2, 12, 0);
        attrib(el.alpha, 1, 12, 8);
        gl.drawArrays(gl.LINES, 0, sc.edgeCount * 2);
        off();
        }

        // 2. 重边：instanced quads，宽度随 weight
        if (sc.thickCount > 0 && LAYERS.thick) {
          gl.useProgram(thickProg);
          gl.uniform2f(tl.res, W, H);
          gl.uniform3f(tl.color, 0.55, 0.70, 0.98);
          gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
          attrib(tl.corner, 2, 8, 0);
          divisor(tl.corner, 0);
          gl.bindBuffer(gl.ARRAY_BUFFER, thickBuf);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, sc.thick.subarray(0, sc.thickCount * 7));
          const s = 28;
          attrib(tl.center, 2, s, 0); divisor(tl.center, 1);
          attrib(tl.dir, 2, s, 8); divisor(tl.dir, 1);
          attrib(tl.len, 1, s, 16); divisor(tl.len, 1);
          attrib(tl.width, 1, s, 20); divisor(tl.width, 1);
          attrib(tl.alpha, 1, s, 24); divisor(tl.alpha, 1);
          drawInst(gl.TRIANGLES, 0, 6, sc.thickCount);
          [tl.center, tl.dir, tl.len, tl.width, tl.alpha].forEach((l) => divisor(l, 0));
          off();
        }

        // 3. 脑壳轮廓环（先清掉上一段用过的实例属性，避免 a_alpha 指向边的缓冲）
        off();
        if (LAYERS.contours) {
        gl.useProgram(edgeProg);
        gl.uniform2f(el.res, W, H);
        gl.uniform3f(el.color, 0.38, 0.52, 0.78);
        for (let r = 0; r < sc.contours.length; r++) {
          const arr = sc.contours[r];
          gl.bindBuffer(gl.ARRAY_BUFFER, contourBufs[r]);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, arr);
          attrib(el.pos, 2, 12, 0);
          attrib(el.alpha, 1, 12, 8);
          gl.lineWidth(1);
          gl.drawArrays(gl.LINE_STRIP, 0, arr.length / 3);
        }
        off();
        }

        // 4. 节点：instanced quads，一次 draw call
        if (LAYERS.nodes) {
        gl.useProgram(nodeProg);
        gl.uniform2f(nl.res, W, H);
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
        attrib(nl.corner, 2, 8, 0);
        divisor(nl.corner, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, nodeBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, sc.nodes.subarray(0, sc.nodeCount * 8));
        const ns = 32;
        attrib(nl.center, 2, ns, 0); divisor(nl.center, 1);
        attrib(nl.radius, 1, ns, 8); divisor(nl.radius, 1);
        attrib(nl.color, 3, ns, 12); divisor(nl.color, 1);
        attrib(nl.alpha, 1, ns, 24); divisor(nl.alpha, 1);
        attrib(nl.glow, 1, ns, 28); divisor(nl.glow, 1);
        drawInst(gl.TRIANGLES, 0, 6, sc.nodeCount);
        [nl.center, nl.radius, nl.color, nl.alpha, nl.glow].forEach((l) => divisor(l, 0));
        off();
        }

        // 5. 脉冲：加法混合的光点
        if (sc.pulseCount > 0 && LAYERS.pulses) {
          gl.useProgram(nodeProg);
          gl.uniform2f(nl.res, W, H);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
          gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
          attrib(nl.corner, 2, 8, 0);
          divisor(nl.corner, 0);
          gl.bindBuffer(gl.ARRAY_BUFFER, pulseBuf);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, sc.pulses.subarray(0, sc.pulseCount * 8));
          attrib(nl.center, 2, 32, 0); divisor(nl.center, 1);
          attrib(nl.radius, 1, 32, 8); divisor(nl.radius, 1);
          attrib(nl.color, 3, 32, 12); divisor(nl.color, 1);
          attrib(nl.alpha, 1, 32, 24); divisor(nl.alpha, 1);
          attrib(nl.glow, 1, 32, 28); divisor(nl.glow, 1);
          drawInst(gl.TRIANGLES, 0, 6, sc.pulseCount);
          [nl.center, nl.radius, nl.color, nl.alpha, nl.glow].forEach((l) => divisor(l, 0));
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          off();
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
      }
    };
    return api;
  }

  // ---------------------------------------------------------------- Canvas2D 回落
  function create2DRenderer(cv, N, NE) {
    const c = cv.getContext('2d', { alpha: false, desynchronized: true });
    if (!c) return null;
    const buckets = [];
    for (let i = 0; i < 5; i++) buckets.push({ data: new Float32Array(Math.max(4, NE * 4)), n: 0 });
    const groups = [];
    for (let i = 0; i < TYPE_COUNT * 3; i++) groups.push({ idx: new Int32Array(N), n: 0 });

    return {
      kind: 'canvas2d',
      gl: null,
      draw: function (sc) {
        const W = sc.w, H = sc.h, dpr = sc.dpr;
        const ctx = c;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = '#06080d';
        ctx.fillRect(0, 0, W, H);

        // 轮廓
        ctx.strokeStyle = 'rgba(110,140,200,0.14)';
        ctx.lineWidth = Math.max(1, dpr * 0.8);
        for (let r = 0; r < sc.contours.length; r++) {
          const arr = sc.contours[r];
          ctx.beginPath();
          ctx.moveTo(arr[0], arr[1]);
          for (let i = 2; i < arr.length; i += 2) ctx.lineTo(arr[i], arr[i + 1]);
          ctx.closePath();
          ctx.stroke();
        }

        // 边：按 权重档 × 透明度档 归并成 20 条路径
        for (let i = 0; i < buckets.length; i++) buckets[i].n = 0;
        const eout = sc.edges;
        for (let e = 0; e < sc.edgeCount; e++) {
          const o = e * 6;
          const a = eout[o + 2];
          if (a < 0.004) continue;
          const wb = sc.eBucket[e];
          const ab = Math.min(3, (a * 7) | 0);
          const b = buckets[wb * 4 + ab];
          const n = b.n;
          if (n + 4 <= b.data.length) {
            b.data[n] = eout[o]; b.data[n + 1] = eout[o + 1];
            b.data[n + 2] = eout[o + 3]; b.data[n + 3] = eout[o + 4];
            b.n = n + 4;
          }
        }
        const widths = [0.55, 0.8, 1.05, 1.35, 1.8];
        for (let i = 0; i < buckets.length; i++) {
          const b = buckets[i];
          if (!b.n) continue;
          const wb = (i / 4) | 0, ab = i % 4;
          ctx.strokeStyle = 'rgba(130,165,240,' + (0.05 + ab * 0.075).toFixed(3) + ')';
          ctx.lineWidth = Math.max(0.5, widths[wb] * dpr);
          ctx.beginPath();
          for (let k = 0; k < b.n; k += 4) {
            ctx.moveTo(b.data[k], b.data[k + 1]);
            ctx.lineTo(b.data[k + 2], b.data[k + 3]);
          }
          ctx.stroke();
        }

        // 节点：类型 × 亮度档
        for (let i = 0; i < groups.length; i++) groups[i].n = 0;
        const nout = sc.nodes;
        const glowIdx = [];
        for (let i = 0; i < sc.nodeCount; i++) {
          const o = i * 8;
          const a = nout[o + 6];
          if (a <= 0.004 || nout[o + 2] <= 0) continue;
          if (nout[o + 7] > 0.5) { glowIdx.push(i); continue; }
          const lvl = a < 0.24 ? 0 : a < 0.55 ? 1 : 2;
          const g = groups[state.nType[i] * 3 + lvl];
          if (g.n < g.idx.length) g.idx[g.n++] = i;
        }
        for (let t = 0; t < TYPE_COUNT; t++) {
          const rgb = TYPES[t].rgb;
          for (let lvl = 0; lvl < 3; lvl++) {
            const g = groups[t * 3 + lvl];
            if (!g.n) continue;
            const a = lvl === 0 ? 0.16 : lvl === 1 ? 0.42 : 0.82;
            ctx.fillStyle = 'rgba(' + ((rgb[0] * 255) | 0) + ',' + ((rgb[1] * 255) | 0) + ',' + ((rgb[2] * 255) | 0) + ',' + a + ')';
            ctx.beginPath();
            for (let k = 0; k < g.n; k++) {
              const i = g.idx[k], o = i * 8;
              const r = nout[o + 2];
              ctx.moveTo(nout[o] + r, nout[o + 1]);
              ctx.arc(nout[o], nout[o + 1], r, 0, TAU);
            }
            ctx.fill();
          }
        }
        // 高亮 / 激活节点：柔光
        for (let k = 0; k < glowIdx.length; k++) {
          const i = glowIdx[k], o = i * 8;
          const x = nout[o], y = nout[o + 1], r = Math.max(2 * dpr, nout[o + 2]);
          const g = nout[o + 7];
          const grd = ctx.createRadialGradient(x, y, 0, x, y, r * 3.2);
          grd.addColorStop(0, 'rgba(235,245,255,' + (0.85 * g).toFixed(3) + ')');
          grd.addColorStop(0.35, 'rgba(190,220,255,' + (0.35 * g).toFixed(3) + ')');
          grd.addColorStop(1, 'rgba(150,190,255,0)');
          ctx.fillStyle = grd;
          ctx.beginPath();
          ctx.arc(x, y, r * 3.2, 0, TAU);
          ctx.fill();
          ctx.fillStyle = 'rgba(240,248,255,' + (0.9 * g).toFixed(3) + ')';
          ctx.beginPath();
          ctx.arc(x, y, r, 0, TAU);
          ctx.fill();
        }

        // 脉冲
        if (sc.pulseCount) {
          ctx.globalCompositeOperation = 'lighter';
          for (let p = 0; p < sc.pulseCount; p++) {
            const o = p * 8;
            const x = sc.pulses[o], y = sc.pulses[o + 1];
            const a = sc.pulses[o + 6];
            if (a < 0.01) continue;
            const r = sc.pulses[o + 2] * 1.5;
            const grd = ctx.createRadialGradient(x, y, 0, x, y, r * 2);
            grd.addColorStop(0, 'rgba(230,245,255,' + (a * 0.9).toFixed(3) + ')');
            grd.addColorStop(1, 'rgba(160,210,255,0)');
            ctx.fillStyle = grd;
            ctx.beginPath();
            ctx.arc(x, y, r * 2, 0, TAU);
            ctx.fill();
          }
          ctx.globalCompositeOperation = 'source-over';
        }
      }
    };
  }

  // ---------------------------------------------------------------- 相机 / 交互
  function resize() {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = state.dpr;
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    if (renderer && renderer.gl) renderer.gl.viewport(0, 0, w, h);
  }

  window.addEventListener('resize', () => { resize(); schedule(); });
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => { resize(); schedule(); });
    ro.observe(document.getElementById('app') || document.body);
  }

  function projectPick(px, py) {
    const dpr = state.dpr;
    let best = -1, bestScore = Infinity;
    for (let i = 0; i < state.N; i++) {
      if (state.nR[i] <= 0) continue;
      const dx = state.nSX[i] - px, dy = state.nSY[i] - py;
      const rr = Math.max(state.nR[i] * 2.2, 6.5 * dpr);
      const d2 = dx * dx + dy * dy;
      if (d2 > rr * rr) continue;
      const score = d2 / (rr * rr) + (state.nZ[i] - CAM_DIST) * 0.12;
      if (score < bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  function activate(idx, count) {
    if (idx < 0 || idx >= state.N) return;
    const now = performance.now();
    state.activeUntil[idx] = now + 1500;
    const s = state.adjStart[idx], a = state.adjEdges;
    const maxEdges = Math.min(count || 9, 14);
    let made = 0;
    for (let k = s; k < state.adjStart[idx + 1] && made < maxEdges; k++) {
      const e = a[k];
      const other = state.eA[e] === idx ? state.eB[e] : state.eA[e];
      pulses.push({ a: idx, b: other, t0: now + made * 32, dur: 520 + state.eW[e] * 460 });
      made++;
    }
    while (pulses.length > MAX_PULSES) pulses.shift();
    wake();
  }

  function wake() {
    resting = false;
    lastInput = performance.now();
    schedule();
  }

  function resetCamera() {
    camera.yaw = START_YAW; camera.pitch = START_PITCH; camera.zoom = START_ZOOM;
    camera.panX = 0; camera.panY = 0;
    wake(); schedule();
  }

  function selectNode(idx) {
    selectedNode = idx;
    hoverNode = -1;
    renderPanel();
    if (idx >= 0) activate(idx, 10);
    wake();
  }

  function onPointerDown(e) {
    canvas.setPointerCapture(e.pointerId);
    dragging = true;
    dragButton = e.button;
    dragMoved = 0;
    downX = lastPX = e.clientX;
    downY = lastPY = e.clientY;
    downT = performance.now();
    canvas.classList.add('is-dragging');
    wake();
  }
  function onPointerMove(e) {
    const px = e.clientX, py = e.clientY;
    const rect = canvas.getBoundingClientRect();
    if (dragging) {
      const dx = px - lastPX, dy = py - lastPY;
      dragMoved += Math.abs(dx) + Math.abs(dy);
      if (dragButton === 2) {
        camera.panX = clamp(camera.panX + dx, -rect.width * 0.75, rect.width * 0.75);
        camera.panY = clamp(camera.panY + dy, -rect.height * 0.75, rect.height * 0.75);
      } else {
        camera.yaw += dx * 0.0062;
        camera.pitch = clamp(camera.pitch - dy * 0.0055, -1.15, 1.15);
      }
      lastPX = px; lastPY = py;
      wake();
      return;
    }
    const idx = projectPick((px - rect.left) * state.dpr, (py - rect.top) * state.dpr);
    if (idx !== hoverNode) {
      hoverNode = idx;
      setTip(idx, px, py, rect);
      wake();
    } else if (idx >= 0) {
      setTip(idx, px, py, rect);
    }
    if (idx >= 0) lastInput = performance.now();
  }
  function onPointerUp(e) {
    if (!dragging) return;
    dragging = false;
    canvas.classList.remove('is-dragging');
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    const dt = performance.now() - downT;
    if (dragMoved < 6 && dt < 500) {
      const rect = canvas.getBoundingClientRect();
      const idx = projectPick((e.clientX - rect.left) * state.dpr, (e.clientY - rect.top) * state.dpr);
      if (idx >= 0) selectNode(idx);
      else if (selectedNode >= 0) { selectedNode = -1; renderPanel(); }
    }
    wake();
  }
  function onWheel(e) {
    e.preventDefault();
    const k = Math.exp(-e.deltaY * 0.0015);
    camera.zoom = clamp(camera.zoom * k, 0.5, 3.6);
    wake();
  }

  // 右键：只屏蔽系统菜单，平移走 pointerdown/move（button === 2）
  function onContextMenu(e) {
    e.preventDefault();
  }

  // ---------------------------------------------------------------- HUD / 面板
  const el = {};
  function $(id) { return document.getElementById(id); }

  let tipEl;
  function setTip(idx, px, py, rect) {
    if (!tipEl) return;
    if (idx < 0) { tipEl.hidden = true; return; }
    const n = state.nodes[idx];
    const t = TYPES[state.nType[idx]];
    tipEl.hidden = false;
    tipEl.innerHTML = '<span class="dot" style="background:' + t.hex + '"></span>' +
      esc(n.label) + '<em>' + t.label + ' · 强度 ' + n.strength.toFixed(2) + '</em>';
    const x = clamp(px - rect.left + 14, 6, rect.width - 190);
    const y = clamp(py - rect.top + 16, 6, rect.height - 60);
    tipEl.style.transform = 'translate(' + x + 'px,' + y + 'px)';
  }

  function renderPanel() {
    const panel = $('panel');
    const body = $('panelBody');
    if (!panel || !body) return;
    if (selectedNode < 0) { panel.classList.remove('is-open'); return; }
    const n = state.nodes[selectedNode];
    const t = TYPES[state.nType[selectedNode]];
    const kindName = (k) => EDGE_KINDS[KIND_INDEX[k] || 0].label;

    // 邻接 top
    const s = state.adjStart[selectedNode], e2 = state.adjStart[selectedNode + 1];
    const list = [];
    for (let k = s; k < e2; k++) {
      const ei = state.adjEdges[k];
      const other = state.eA[ei] === selectedNode ? state.eB[ei] : state.eA[ei];
      list.push({ idx: other, w: state.eW[ei], kind: state.edges[ei].kind });
    }
    list.sort((a, b) => b.w - a.w);
    const top = list.slice(0, 6);
    const valencePct = (n.valence + 1) * 50;

    body.innerHTML =
      '<div class="p-head"><span class="p-dot" style="background:' + t.hex + '"></span>' +
      '<span class="p-type">' + t.label + '</span><span class="p-id">#' + esc(n.id) + '</span></div>' +
      '<h2 class="p-title">' + esc(n.label) + '</h2>' +
      '<p class="p-content">' + esc(n.content) + '</p>' +
      '<div class="p-metric"><div class="p-mlabel"><span>强度</span><b>' + n.strength.toFixed(2) + '</b></div>' +
      '<div class="p-bar"><i style="width:' + (n.strength * 100).toFixed(1) + '%;background:' + t.hex + '"></i></div></div>' +
      '<div class="p-metric"><div class="p-mlabel"><span>效价</span><b>' + (n.valence > 0 ? '+' : '') + n.valence.toFixed(2) + '</b></div>' +
      '<div class="p-bar p-valence"><i style="left:' + Math.min(50, valencePct).toFixed(1) + '%;width:' +
      Math.abs(valencePct - 50).toFixed(1) + '%;background:' + (n.valence >= 0 ? '#ffcfa0' : '#8fb8ff') + '"></i></div></div>' +
      '<div class="p-row"><span>时间</span><b>' + fmtTime(n.ts) + '</b></div>' +
      '<div class="p-row"><span>连接</span><b>' + n.degree + ' 条</b></div>' +
      '<div class="p-sub">关联</div><div class="p-links">' +
      top.map((x) => '<button class="p-link" data-i="' + x.idx + '"><span class="dot" style="background:' +
        TYPES[state.nType[x.idx]].hex + '"></span><span class="lbl">' + esc(state.nodes[x.idx].label) +
        '</span><span class="w">' + kindName(x.kind) + ' ' + x.w.toFixed(2) + '</span></button>').join('') +
      '</div>' +
      '<div class="p-actions"><button id="pFocus" class="pill">激活脉冲</button><button id="pFocus2" class="pill">重置视角</button></div>';
    body.querySelectorAll('.p-link').forEach((btn) => {
      btn.addEventListener('click', () => selectNode(Number(btn.dataset.i)));
    });
    const f1 = $('pFocus'), f2 = $('pFocus2');
    if (f1) f1.addEventListener('click', () => activate(selectedNode, 12));
    if (f2) f2.addEventListener('click', resetCamera);
    panel.classList.add('is-open');
  }

  function updateHud(nowMs) {
    if (!el.fps) return;
    const s = stats();
    el.fps.textContent = s.fps > 0 ? s.fps.toFixed(0) : '—';
    el.ms.textContent = s.avgCpu > 0 ? s.avgCpu.toFixed(2) + 'ms' : '—';
    el.p95.textContent = s.p95 > 0 ? s.p95.toFixed(2) + 'ms' : '—';
    el.count.textContent = state.N + ' 点 / ' + state.NE + ' 边';
    el.gl.textContent = renderer ? renderer.kind : '—';
    const loop = resting ? 'REST' : (animOn ? 'LIVE' : 'IDLE');
    el.loop.textContent = loop;
    el.loop.className = 'hud-chip ' + (loop === 'LIVE' ? 'is-live' : 'is-rest');
  }

  function stats() {
    return {
      fps,
      avgCpu: cpuTimes.length ? cpuTimes.reduce((a, b) => a + b, 0) / cpuTimes.length : 0,
      p95: percentile(cpuTimes, 95),
      p50: percentile(cpuTimes, 50),
      frames: framesRendered,
      nodes: state.N,
      edges: state.NE,
      renderer: renderer ? renderer.kind : 'none',
      loop: resting ? 'rest' : 'live'
    };
  }

  // ---------------------------------------------------------------- 主循环
  function frame(now) {
    const t0 = performance.now();
    buildScene(now);
    renderer.draw(scene);
    const cpu = performance.now() - t0;
    framesRendered++;
    cpuTimes.push(cpu);
    if (cpuTimes.length > 120) cpuTimes.shift();

    if (lastNow) {
      const dt = now - lastNow;
      if (dt > 0) {
        fps = 1000 / dt;
        frameTimes.push(dt);
        if (frameTimes.length > 60) frameTimes.shift();
      }
    }
    lastNow = now;
    if (now - hudTimer > 260) { hudTimer = now; updateHud(now); }
  }

  function needMore(now) {
    if (benchRunning) return false;
    if (pulses.length) return true;
    if (Math.abs(hlTarget - hlMix) > 0.01) return true;
    if (Math.abs(panelTarget - panelShift) > 0.4) return true;
    if (dragging) return true;
    if (animOn && !resting) {
      if (now - lastInput < 8000) return true;
      resting = true;
      return true; // 再画一帧，然后停
    }
    return false;
  }

  function tick(ts) {
    rafId = 0;
    const now = typeof ts === 'number' ? ts : performance.now();
    if (!renderer) return;
    if (animOn && !resting && pulseOn && now - lastInput < 8000 && now - lastAmbient > 2400 && pulses.length < 60) {
      lastAmbient = now;
      activate((Math.random() * state.N) | 0, 6);
    }
    frame(now);
    if (needMore(now)) schedule();
  }

  function schedule() {
    if (benchRunning) return;
    if (!rafId) rafId = requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------- 启动
  function banner(msg) {
    const b = $('banner');
    if (!b) return;
    b.hidden = false;
    b.textContent = msg;
    clearTimeout(b._t);
    b._t = setTimeout(() => { b.hidden = true; }, 9000);
  }

  // 宿主实时图优先：/api/superbrain/graph 返回 {ok,value:{nodes,edges,meta}}，
  // 也兼容裸 {nodes,edges}。只有拿到「有节点且有边」的图才算实时，
  // 否则退回 demo.json，并让 HUD 的「数据」行标出「实时 / 演示」。
  const LIVE_GRAPH_URL = '/personal-memory/brain/graph';

  function graphPayload(body) {
    const raw = body && body.ok === true && body.value ? body.value : body;
    if (!raw || !Array.isArray(raw.nodes) || !raw.nodes.length) throw new Error('空图（0 节点）');
    if (!Array.isArray(raw.edges) || !raw.edges.length) throw new Error('图里还没有连线');
    return raw;
  }

  async function loadLive() {
    const limit = parseInt(params.get('limit'), 10);
    const kind = String(params.get('kind') || '').trim();
    const qs = [];
    if (limit > 0) qs.push('limit=' + limit);
    if (kind && kind !== 'all') qs.push('kind=' + encodeURIComponent(kind));
    const query = qs.length ? '?' + qs.join('&') : '';
    const res = await fetch(LIVE_GRAPH_URL + query, {
      cache: 'no-store',
      headers: { accept: 'application/json' }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const raw = graphPayload(await res.json());
    return { raw, source: 'live', meta: raw.meta || {} };
  }

  async function loadData() {
    const injected = window.BRAIN_DATA;
    if (injected) {
      const raw = typeof injected === 'string' ? JSON.parse(injected) : injected;
      return { raw, source: 'window.BRAIN_DATA', meta: raw.meta || {} };
    }
    const nq = parseInt(params.get('nodes'), 10);
    if (nq > 0) {
      const eq = parseInt(params.get('edges'), 10);
      return { raw: syntheticData(nq, eq > 0 ? eq : nq * 2), source: 'synthetic(?nodes=)', meta: {} };
    }
    const failures = [];
    const overHttp = location.protocol === 'http:' || location.protocol === 'https:';
    if (overHttp) {
      try {
        return await loadLive();
      } catch (err) {
        failures.push('实时图 ' + err.message);
      }
    }
    try {
      const res = await fetch('./demo.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const raw = graphPayload(await res.json());
      if (failures.length) banner(failures.join('；') + '：已退回 demo.json 演示数据。');
      return { raw, source: 'demo', meta: raw.meta || {} };
    } catch (err) {
      failures.push('demo.json ' + err.message);
      banner(failures.join('；') + '：已用内置合成数据预览。请用 http 打开，或注入 window.BRAIN_DATA。');
      return { raw: syntheticData(500, 900), source: 'synthetic', meta: {} };
    }
  }

  function mountRenderer() {
    scene.w = canvas.width; scene.h = canvas.height;
    renderer = createGLRenderer(canvas, state.N, state.NE, state.thick.length, MAX_PULSES);
    if (!renderer) {
      renderer = create2DRenderer(canvas, state.N, state.NE);
      banner('未获得 WebGL 上下文，已切换到 Canvas2D 批量绘制。');
    }
    if (!renderer) throw new Error('无法创建任何渲染上下文');
    if (!renderer.gl) return;
  }

  function bench(framesCount) {
    const count = Math.max(10, framesCount | 0 || 120);
    benchRunning = true;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    resting = false; lastInput = performance.now();
    const cpu = [], total = [], build = [], draw = [];
    for (let i = 0; i < count; i++) {
      const t0 = performance.now();
      buildScene(performance.now() + i * 16.7);
      const t1 = performance.now();
      renderer.draw(scene);
      const t2 = performance.now();
      if (renderer.gl) renderer.gl.finish();
      const t3 = performance.now();
      build.push(t1 - t0);
      draw.push(t2 - t1);
      cpu.push(t2 - t0);
      total.push(t3 - t0);
    }
    const avgOf = (a) => +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2);
    const result = {
      renderer: renderer.kind,
      nodes: state.N,
      edges: state.NE,
      frames: count,
      size: canvas.width + 'x' + canvas.height,
      dpr: state.dpr,
      cpuavg: +(cpu.reduce((a, b) => a + b, 0) / count).toFixed(2),
      cpup50: +percentile(cpu, 50).toFixed(2),
      cpup95: +percentile(cpu, 95).toFixed(2),
      cpuMax: +Math.max.apply(null, cpu).toFixed(2),
      buildAvg: avgOf(build),
      buildP95: +percentile(build, 95).toFixed(2),
      drawAvg: avgOf(draw),
      drawP95: +percentile(draw, 95).toFixed(2),
      fillBound: avgOf(draw) > avgOf(build) * 3,
      avg: +(total.reduce((a, b) => a + b, 0) / count).toFixed(2),
      p50: +percentile(total, 50).toFixed(2),
      p95: +percentile(total, 95).toFixed(2),
      p99: +percentile(total, 99).toFixed(2),
      max: +Math.max.apply(null, total).toFixed(2),
      fps: +(1000 / (total.reduce((a, b) => a + b, 0) / count)).toFixed(1),
      gpuFinish: !!renderer.gl,
      at: new Date().toISOString()
    };
    window.__BRAIN_BENCH__ = result;
    benchRunning = false;
    console.info('[brain-bench] ' + JSON.stringify(result));
    wake();
    return result;
  }

  // HUD「数据」行的来源标识：实时 = 宿主 brain.db，演示 = demo.json / 合成数据。
  function paintSource(source, meta) {
    const chip = $('hudSource');
    if (!chip) return;
    const m = meta || {};
    const live = source === 'live';
    const injected = source === 'window.BRAIN_DATA';
    chip.textContent = live ? '实时' : injected ? '注入' : '演示';
    chip.className = 'hud-chip ' + (live || injected ? 'is-live' : 'is-rest');
    const bits = [];
    if (m.nodes) bits.push(m.nodes + ' 节点');
    if (m.edges) bits.push(m.edges + ' 边');
    if (m.truncated && m.total) bits.push('库内共 ' + m.total + ' 节点（已截断）');
    if (m.generatedAt) bits.push(String(m.generatedAt).replace('T', ' ').slice(0, 19));
    chip.title = live
      ? '实时：宿主 /api/superbrain/graph' + (bits.length ? ' · ' + bits.join(' · ') : '')
      : injected
        ? '数据由 window.BRAIN_DATA 注入'
        : '宿主实时图不可用，当前展示 ' + source + ' 演示数据';
  }

  async function boot() {
    canvas = $('stage');
    tipEl = $('tip');
    panelEl = $('panel');
    el.fps = $('hudFps'); el.ms = $('hudMs'); el.p95 = $('hudP95');
    el.count = $('hudCount'); el.gl = $('hudGL'); el.loop = $('hudLoop');
    if (!canvas) return;

    const dprQ = parseFloat(params.get('dpr'));
    if (dprQ > 0) state.dpr = clamp(dprQ, 0.5, 3);
    resize();

    let data;
    try {
      const loaded = await loadData();
      data = normalize(loaded.raw);
      state.source = loaded.source;
      paintSource(loaded.source, loaded.meta || data.meta);
    } catch (err) {
      banner('数据不可用：' + err.message);
      return;
    }
    buildGraph(data);
    mountRenderer();
    resize();

    // 交互
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', onContextMenu);
    canvas.addEventListener('pointerleave', () => {
      if (hoverNode >= 0 && !dragging) { hoverNode = -1; if (tipEl) tipEl.hidden = true; wake(); }
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { selectedNode = -1; renderPanel(); hoverNode = -1; wake(); }
      else if (e.key === 'r' || e.key === 'R') resetCamera();
      else if (e.key === ' ') { e.preventDefault(); toggleAnim(); }
    });

    $('panelClose').addEventListener('click', () => { selectedNode = -1; renderPanel(); wake(); });
    const bAnim = $('btnAnim'), bPulse = $('btnPulse'), bReset = $('btnReset');
    bAnim.addEventListener('click', toggleAnim);
    bPulse.addEventListener('click', () => { pulseOn = !pulseOn; bPulse.classList.toggle('is-on', pulseOn); wake(); });
    bReset.addEventListener('click', resetCamera);
    function toggleAnim() {
      animOn = !animOn;
      if (animOn) resting = false;
      bAnim.classList.toggle('is-on', animOn);
      wake();
    }

    lastInput = performance.now();
    lastAmbient = performance.now();
    renderPanel();
    frame(performance.now());
    updateHud(performance.now());
    window.__BRAIN_READY__ = true;

    const bf = parseInt(params.get('bench'), 10);
    if (bf > 0 || params.has('bench')) {
      setTimeout(() => bench(bf > 0 ? bf : 120), 60);
    } else {
      schedule();
    }

    window.__BRAIN_DEBUG__ = {
      stats,
      bench,
      select: (id) => {
        const i = state.nodes.findIndex((n) => n.id === String(id));
        if (i >= 0) selectNode(i);
        return i >= 0;
      },
      activate: (i) => activate(i, 10),
      hover: (i) => { hoverNode = i | 0; wake(); },
      setAnim: (v) => { animOn = !!v; if (animOn) resting = false; wake(); },
      frames: () => framesRendered,
      rafActive: () => !!rafId,
      scene,
      state,
      camera
    };
    window.__BRAIN_APP__ = { buildScene, renderer, camera, state, layers: LAYERS, scene };

    if (params.has('shot')) {
      // 便于截图/自检：稳定摇到 3/4 视角
      camera.yaw = 0.42; camera.pitch = 0.18;
      wake();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
