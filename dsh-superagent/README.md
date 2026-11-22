# dsh-superagent

左上角的「小组长」：在 DeepSeek Harness 网页里点一下标题栏左侧的 **Superagent**，就能跟一个常驻的 lead agent 对话。它把需求拆成任务，派给 worker，再把结果收回来。

这是 v1：界面简单、能马上用，方便边用边改。

## 用起来

1. 打开任意会话，标题栏左侧会出现 **Superagent** 按钮；点开面板。
2. 直接说需求，例如「看看这个工作区是干什么的，5 行以内」。
3. 面板里看到它的回复、每一步用过的工具、当前任务条和它派出的 worker；点 worker 直接跳到那个子会话。
4. 它停下来问你时，面板顶部会出现「它在等你回答」；点「在完整会话里打开」直接跳过去回答。
5. `↗` 打开这个 lead agent 的完整会话；`新对话` 断开当前 lead，下一条消息会自动在**你当前的工作目录**里新建一个。
6. 面板底部的模型按钮可以换模型：只影响这个 lead 会话，以及之后新派出的 worker（worker 继承 lead 的 provider / model / 推理强度）。同一个会话里也可以只切换「推理强度」。

## 它怎么工作

- Host 端（`index.js`）只维护 **一个** orchestrator 会话，session id 存在 `~/.dsh/superagent/state.json`。
- 新会话的第一条消息是一段隐藏的「引导」，规定它是团队负责人：先判断要不要动手、用 `todo_write` 列计划、再派活、只在卡住时用正文提问、回复控制在几行。
- 面板按「回合」聚合消息：一整个回合只占一条气泡，工具调用显示成小 chip 并标注「N 步」，不会再被几十条空行刷屏。
- 任务条来自最近的 `todo/write`（上一轮已全部完成、且不属于当前回合的计划会自动隐藏；没有 todo 时退回 `agentTeam` 团队任务）。
- worker 列表来自 `subagentCatalog` 投影，状态由每个子会话的 `sessionController.state` 得出（每 4 秒最多查一次）。
- 等待状态来自 `pendingInput` / `userQuestions` 投影；如果 lead 用 `ask_user_question` 提问，会把问题原文显示在横幅里。
- 正在生成的字走 SSE：面板打开时连一条 `sessionController.follow`（`assistantStream: true`），逐段显示 assistant 文本，收到结束帧后由一次状态刷新换成正式的回合气泡。
- Web 面板（`client.js`）只调用本 bundle 自己的同源接口，不直接碰 Session：
  - `GET /api/superagent/state`：会话状态、聚合后的消息、任务条、worker 列表、等待状态
  - `GET /api/superagent/stream?session=<id>`：SSE，推送 `snapshot` / `delta` / `event` / `turn`
  - `POST /api/superagent/send`：`{ text }`
  - `POST /api/superagent/cancel`：停掉当前回合以及仍在运行的 worker
  - `POST /api/superagent/reset`：断开当前 lead（旧会话留在历史里）
  - `GET /api/superagent/models`：分组模型目录（缓存 60s）
  - `POST /api/superagent/model`：`{ provider, model, reasoningEffort? }`，切换当前 lead 的模型并记住它
- worker 的调度完全复用 DSH 自带的 `subagent` / `team_task_*` 工具，没有另造一套队列。
- 模型选择走 `sessionController.selectModel`：和主界面的模型选择器是同一个入口，选中后也会成为该 profile 的默认模型。
- 工作目录：新建 lead 时如果没设置过，会挑「最近使用、且不是 Superagent 自己的」那个会话的 cwd 并记住；可在 `~/.dsh/superagent/state.json` 里改 `cwd`。

## 文件

- `index.js`：Host 插件，注册路由、驱动 orchestrator 会话、聚合状态
- `client.js`：Web 插件，顶部按钮 + 浮层面板
- `cordis.patch.yml`：profile 里的挂载点
- `locale/{zh,en}.json`：插件列表里的标题与描述

## 可调项（环境变量）

- `DSH_SUPERAGENT_HOME`：状态目录，默认 `~/.dsh/superagent`
- `DSH_SUPERAGENT_CWD`：固定 lead 会话的工作目录（不再自动探测）

改完 `index.js` 或 `client.js` 后，重新加载插件即可生效；替换已安装的包需要重启 Harness。

## 已知边界（v1）

- 流式只覆盖 assistant 的正文片段；结构（任务条、worker 状态、等待横幅）仍然靠 1.3s 轮询更新。
- worker 的工具输出不在面板里流式显示，点进 worker 会话才看得到。
- 已经跑起来的 worker 不会因为换模型而改用新模型；只有之后新派出的 worker 继承。
- 面板不能给单个 worker 指定不同的模型（DSH 的 subagent 工具没有暴露 per-call 模型参数）。
- worker 列表最多显示最近 6 个，状态每 4 秒刷新一次；「停止」会尽量一起停掉仍在跑的 worker。
- 引导只在新建 lead 会话时注入一次；已有会话里的旧提示词不会自动更新。
- 不处理图片/文件附件，只收文本。
