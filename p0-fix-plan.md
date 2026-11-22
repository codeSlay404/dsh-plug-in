# P0 修复方案 v2（2026-11-22，已过对抗式评审）

评审结论：v1 被 BLOCK，11 条阻断项已并入。本版为执行版本。
目标：关掉四个 P0 —— ①插件写路由无浏览器信任边界；②personal-memory 越界读写 + 并发丢写；③sector-board GET 可触发 ETL、paper/init 可清账户；④travel AI 流无终止语义导致永久转圈。
不做：重写 UI、改抓取逻辑、动 dsh-mars-quick-controls 与第三方插件；P1/P2 除"顺带"两条外不动。

**定位方式：本文行号只是当前快照，实现一律用函数名/唯一字符串 grep 定位**（第 2 步插入代码后行号全废）。

## 1. 方案 A：浏览器信任闸门 `guard.js`

依据：官方 `@deepseek-ai/dsh-client-connection/src/api-request-trust.ts`（`isTrustedApiRequest`）+ `dsh-host-webserver/README.md`（"No server-wide authentication or origin policy — route owners enforce their own request policy"）。不引入 token（官方也没有；token 要分发、client bundle 由 DSH serve，收益不如栅栏）。

三道栅栏，与官方同序：**Host**（防 DNS rebinding）→ **Sec-Fetch-Site**（cross-site 直接拒）→ **Origin**（有就必须与 Host 同 authority，`null` 拒）。

实现要点（评审 B9/建议 1、2 已并入）：
- 兼容两种入参：Node `req.headers`（普通对象，键已小写）与 Fetch `Headers`（`.get`）。取头部函数要同时支持，并对普通对象做大小写兜底。
- `isLoopback` 逐字抄 `loopback-hostname.ts`：`localhost`、`[::1]`/`::1`/`0:0:0:0:0:0:0:1`、`127.0.0.0/8` 用**分段整数比较**（不要 `Number(part)`，否则 `127.0.0.1.` 会通过）；剥 `%zone`；IPv6 比较前剥方括号。
- bind 地址同样剥方括号后再比（`ctx.webServer.host` 可能是 `'::1'`）。
- `0.0.0.0`/`::` 不作为可信目标（DSH `dsh-host-webserver/index.ts:363` 已拒绝 wildcard bind，服务起不来）。
- `trustedHosts` 走插件配置数组，默认 `[]`；比较用「同 authority（hostname+port）」，不字符串比对。
- 兜底：`ctx.webServer.host/protocol` 取不到时 `127.0.0.1` / `http:`。

挂载（全部在「读 body 之前」）：
| 插件 | 位置（函数/唯一串） | 入参形态 |
|---|---|---|
| personal-memory | `handler: (req, res) =>` 内 IIFE 第一行（`:2792`，覆盖全部 29 条路由） | IncomingMessage |
| sector-board | `postRoute` 的 `handler` 首行 + prefix `resource` 函数首行 | **Fetch Request** |
| superagent | `ctx.webServer.register` 的 `routes.map` 处统一包 `guardRoute(route.handler)` | IncomingMessage |
| travel | `handler: async (req, res) =>` 首行（`/api/travel/ai` 唯一路由） | IncomingMessage |

拒绝统一 403：PM `{ ok:false, error:{ code:'forbidden' } }`、superagent/sector-board `{ error:'forbidden' }`、travel `{ error:'forbidden' }`。

## 2. 方案 B：personal-memory 写安全

**B-1 事务锁（不是写函数锁）**。锁粒度必须是「一次 read→改→写」，否则并发 `/star` 各读旧 state、后写者覆盖，锁写在 `writePanelState` 上等于没锁；且 `markUsed` 内部调 `writePanelState`，两层同锁会自锁死。
- `withStateLock(workspace, fn)`：`Map` 尾部排队，`const next = (map.get(k) ?? Promise.resolve()).catch(() => {}).then(fn)`，`finally` 里 `if (map.get(k) === next) map.delete(k)`（不要 `tail.then(fn)`，前一个 reject 会连坐）。
- 包裹点（按函数名）：`markWait`、`recordMove`、`markUsed`、`appendQuery`、`toggleStar`、`setPanelUi`、`clearPanelState`、`stateClear`、`stateMigrate`、`resolved` 写入分支、`toggleTodo`（v1 漏了它，`:1602-1627`）。
- `readPanelState` / `writePanelState` **内部不取锁**。

**B-2 atomicWrite**：同目录 `.<name>.<pid>.<n>.tmp` → `writeFile` → `rename`，`finally` 里 `unlink(tmp).catch(()=>{})`。替换：`writePanelState`、`markWait`、`recordMove`、`appendQuickNote`、`deferTodo`、`appendDocLine`、`saveDoc`、`toggleTodo`、`appendExperiment`、LOG 写。

**B-3 realpath 越界校验，抽 `resolveWritePath(workspace, rel, { mustExist })`**：
- 缓存 `realWorkspace = realpathSync(workspace)`（按 workspace 做 key）。
- `realDir = realpathSync(dirname(abs))`，必须 `=== realWorkspace` 或以 `realWorkspace + sep` 开头。
- `mustExist` 时 `lstatSync(abs)` 若 `isSymbolicLink()` → 拒；再校验 `realpathSync(abs)` 落在 realWorkspace 内。
- **不要拿 `realpath(abs) !== abs` 判定**：macOS `/var`、`/tmp` 都是软链，测试沙箱在 `mkdtempSync(tmpdir())` 下，按 v1 写法全量 403、测试当场全红（评审 B2 实测）。
- 覆盖点：`safeDocPath`（读/存/挪待办/勾待办/增补，4 处写）、**`appendQuickNote`**（v1 误以为走 safeDocPath，实际 `join(workspace,'memory/...')` 直写）、**`createDoc`**（`stat` 跟随软链、`existsSync` 对悬空软链为假 → `flag:'wx'` 会在外部建文件）。`mustExist:false` 两处也要过 `resolveWritePath`。

## 3. 方案 C：sector-board

1. `refresh`：去掉 prefix 分支里的 `|| url.searchParams.get('run') === '1'`（GET 不再触发 4 分钟 ETL）。已核实 `REFRESH_URL`/`PAPER_INIT_URL`/`PAPER_DECIDE_URL` 都是 client 里的**死常量**，`scripts/`、`package.json`、`cordis.patch.yml`、`docs/PRD.md` 无 `?run=1` 依赖。
2. `paper/init`：**保留端点**（不删功能），要求 `POST` + `?confirm=1`，否则 400 `{ error:'need-confirm' }`；UI 无调用点（`PAPER_INIT_URL` 全文仅定义处），故只加确认、**不新增 UI 入口**，回归时明确记录「该端点目前只服务 CLI/手工调用」。调用必须 `PAPER_INIT_URL + '?confirm=1'`（一次性 POST fetch，不留 `EventSource` 式 GET）。
3. `paper.py`：`def init(force=False): if os.path.exists(ACC) and not force: return load()`；`main()` 的 `--init` 分支传 `force=args.force`，argparse 加 `--force`；**`decide()` 保持默认 `force=False`**（否则首跑自动建仓会坏）。已核实无其它 `--init` 调用点。
4. 顺带：`startRefresh` 补 `closeSync(fd)`；删掉 prefix resource 里重复的写分支（`announcements/refresh`、`paper/decide`、`robot/run`、`paper/init` 在 HTTP 下不可达，但留着等下次改 prefix 就成无 guard 写接口）。

## 4. 方案 D：travel 流终止语义

Host（`index.js`）：
- 缓存命中 → SSE：`writeHead(200, text/event-stream)` → `sseWrite('status')` → `sseWrite('done',{ok:true,cached:true,intro,items})` → `end()`。
- 超时：`let timedOut = false`，timer 回调里置真再 `abort()`；**主路径在 catch 里**（abort 后 `llm.stream` 抛 AbortError 走 catch，`:201` 的 `if (aborted) return` 很少命中）：catch 里若 `timedOut && !clientGone` → `sseWrite('error',{message:'模型响应超时，请重试'})`；`:201` 分支同样处理；`finally` 只 `end()`。
- `clientGone` 判定用 `res.writableEnded || !res.writable`（**不要用 `res.on('close')`**：正常 `end()` 后 Node 也发 close，会和超时帧互相踩）。

Client（`client.js`）：闭包里的 `phase` 是点击那刻的旧值（deps `[effectiveSeason, month]`），拿它兜底是死代码。改用：`runAiRequest` 内记 `sawDone`，循环结束 `if (!sawDone) throw new Error('流意外结束')`，交给现有 `.catch` 置 error。缓存命中的 `onEvent('done')` 顺手改函数式 + `s.key === key` 守卫（现在旧 done 会覆盖新查询状态）。**重试按钮条件不动**（`phase !== 'loading'`，评审建议 5：收紧会砍掉 done/stream 的重试入口）。

## 5. 测试计划

**先补 harness，再挂 guard**（否则第 1 步之后现有用例全红，中间态不可验证）：
- `dsh-travel/host-smoke.mjs` 的 `fakeReq`、`dsh-personal-memory/smoke-panel.mjs` 的假 req：补 `headers: { host: '127.0.0.1:49700', origin: 'http://127.0.0.1:49700', 'sec-fetch-site': 'same-origin' }`。
- travel `TIMEOUT_MS` 做成可注入（`ctx.config.timeoutMs` 或导出常量），否则超时用例要等 90 秒。

新增（每条都要正反两面，评审 B9：只测"拒"会放过"全拒"的实现）：
- `personal-memory/smoke-guard.mjs`：① 跨站 Origin → 403；② 非 loopback Host → 403；③ `Sec-Fetch-Site: cross-site` → 403；④ **`Host+Origin+Sec-Fetch-Site: same-origin` → 200**；⑤ `Host: localhost` + `Origin: localhost` 同端口 → 200；⑥ 端口不一致 → 403（锁住"端口不同即不同源"）。
- `personal-memory/smoke-writepath.mjs`：① `/note` 目标文件是软链 → 403；② `create` 目录是软链 → 403；③ `create` 悬空软链 → 403；④ 同文件两行并发 `toggle` → 两条都落盘；⑤ 10 并发 `/append` → 10 行；⑥ realpath 型沙箱（tmpdir）下正常读写仍 200。
- `sector-board/smoke-guard.mjs`：① 跨站 Origin/`Sec-Fetch-Site` → 403；② `GET /refresh?run=1` 不再触发（status 保持 idle / 响应不含 started）；③ `POST /paper/init` 无 confirm → 400；④ `POST /paper/init?confirm=1` → 进 handler；⑤ 同源正常请求 200。
- `superagent/smoke-guard.mjs`：① 跨站 `POST /send` → 403；② 同源 `/send` 空文本 → 400（handler 可达）；③ 跨站 `/stream` → 403。**删掉「`/stream?session=other` → 403」**：当前代码无归属校验，DSH session 本身无归属概念，写这条要么永远红要么草率加 if；若要防同机进程另立 P1。
- `travel/smoke-stream.mjs`（假 llm）：① 首次 `text/event-stream`；② 第二次同参数仍 `text/event-stream` 且含 `event: done`；③ 超时路径出现 `event: error`（用注入的短超时）。

改现有断言：`host-smoke.mjs` 的「缓存命中返回 JSON」改成 SSE + done；`smoke-panel.mjs` 的 `deferTo` 改 `addDaysKey(localDateKey(), 1)`（**可读性改善，不是 P0**，不列验收条件）。

验收线：上面每条的**正反两面**全绿 + 现有绿用例不回归（travel smoke 71/71、host-smoke 19/19、PM smoke/check-props/smoke-live）+ 他测 agent 签「没发现阻断问题」。

## 6. 风险

| 风险 | 处理 |
|---|---|
| guard 误杀正常请求（Host 带端口/大小写/IPv6/尾点） | 用 URL 归一化 + 官方 loopback 逻辑；⑥⑦⑧ 用例锁行为 |
| 锁自锁死 / 泄漏 | 事务级锁 + `finally` 删 Map 项 + `.catch(()=>{})` 前缀 |
| realpath 判定误杀软链工作区 | 以 `realWorkspace` 为基准，不用 `realpath(abs)!==abs` |
| atomicWrite 跨设备 rename | tmp 与目标同目录 |
| 缓存命中改 SSE 让旧页面不适配 | 刷新即拿新 bundle；`done` 原是它处理的形状 |
| paper/init 成「有端点无入口」 | 明确记录只服务 CLI，不在 P0 加 UI |
| 改测试掩盖问题 | 只改数据形态不改断言语义；他测复跑 |
| 行号漂移 | 全文按函数名定位 |

## 7. 执行顺序

0. 补 harness 头（travel/PM）。→ 1. guard.js + 四处挂载 + 四条 guard 用例（含放行组）。→ 2. PM 事务锁/atomicWrite/resolveWritePath + writepath 用例。→ 3. sector-board 四条 + paper.py `--force` + 用例。→ 4. travel 流改造 + smoke-stream + 改 host-smoke 断言。→ 5. 全量 `node smoke*.mjs` 绿。→ 6. 交独立 agent 他测 → 修 → 交付。
