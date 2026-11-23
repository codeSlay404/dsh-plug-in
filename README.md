# DSH 插件集合 · DeepSeek Harness plugins

[DeepSeek Harness](https://github.com/deepseek-ai)（DSH）的自研插件 monorepo。四个插件都声明了 `dsh.bundle` patch，装进 profile 即可在 Web 界面里看到对应入口；每个插件目录有自己的 README。

| 目录 | npm 包名 | 是什么 |
|---|---|---|
| [`dsh-personal-memory/`](dsh-personal-memory/) | `dsh-personal-memory` | 个人记忆：把 `personal/`（长期认知）与 `memory/`（日记时间长河）做成整页面板，支持浏览、检索、速记、勾待办、编辑新建、星标与「最近查过」；每轮对话前按工作区自动召回相关条目注入上下文 |
| [`dsh-travel/`](dsh-travel/) | `dsh-travel` | 旅行灵感：按季节/月份推荐目的地，支持标签筛选、收藏与「AI 帮找」（走当前会话模型，SSE 流式） |
| [`dsh-superagent/`](dsh-superagent/) | `dsh-superagent` | 小组长：标题栏常驻一个 lead agent，把需求拆成任务派给 worker，面板里看回合、工具与 worker 会话 |
| [`sector-board/`](sector-board/) | `dsh-sector-board` | A 股板块看板：八分区（今日/板块/模拟盘/更多）、全 A 股 ETL、实时报价、龙虎榜/游资/周期/红利、agent 模拟盘 |

## 安装

DSH 自带插件管理：

```bash
# 从 npm（发版后可用）
dsh plugin add dsh-travel
dsh plugin add dsh-personal-memory

# 本地开发：直接 link 本目录
dsh plugin add link:/path/to/this/repo/dsh-travel
```

装完重启 DSH 生效；client 半改动在页面刷新后生效（跑着 `pnpm run dev:web` 时会走 HMR）。

## 安全说明（请先读）

这些插件的 Web 路由都注册在 DSH 的本地 Web 服务上，并自带一层请求来源栅栏：**Host 必须是本机回环地址（或插件配置里的 `trustedHosts`）、`Sec-Fetch-Site` 不能是 `cross-site`、带 `Origin` 时必须与 Host 同源**。语义对齐 DSH 官方 `dsh-client-connection` 的 `isTrustedApiRequest`，目的是挡住恶意网页用 `<img>`/`fetch` 打本机接口（含 DNS rebinding）。

几点必须知道的：

- **`dsh-superagent` 会在本机起 agent 跑命令**（默认 `danger-full-access`、审批 `never`），只适合在你自己信任的机器上用。
- **`sector-board` 会起 Python 子进程**（`etl.py`/`paper.py`/`robot.py`）抓公开行情数据、写 `~/.dsh/sector-board/`，并把看板数据以 JSON 暴露给同源页面。
- **`dsh-personal-memory` 会读写你的工作区文件**（`personal/`、`memory/`、`.dsh/personal-memory/`），写路径做了 realpath 越界校验与事务锁，但它仍然有你的笔记读取权限。
- 没有服务级鉴权：插件栅栏只按 Host/Origin 判定，**局域网内其它机器**要访问，需要把 LAN Host 显式加进 `trustedHosts`。

## 开发

```bash
cd dsh-personal-memory
node smoke.mjs            # 召回冒烟
node smoke-client.mjs     # client 渲染冒烟
node smoke-guard.mjs      # 来源栅栏
node smoke-writepath.mjs  # 写路径安全 / 并发
node smoke-panel.mjs      # HTTP 路由（需 DSH_MEMORY_WORKSPACE 指向测试工作区）
node smoke-render.mjs     # 整棵面板树渲染（同上）
```

各插件的测试矩阵、路由清单、配置项都写在各自的 `README.md` 里。

## License

[MIT](LICENSE) © 2026 codeSlay404
