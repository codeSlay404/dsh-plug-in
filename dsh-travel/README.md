# dsh-travel 旅行灵感

每个季节该去哪、玩什么的 DSH 插件。不是景点大全——每个目的地给的是**当地最好玩的事**(喂红嘴鸥、蹲一场日出云海、赶一场泼水节),配上必吃和出发前该知道的事。

## 功能

- **四季 × 40 个目的地**:春夏秋冬各 9~12 个,覆盖山海湖漠城。
- **当季优先**:打开默认落在当前季节,当月正当时的目的地排最前并打"正当时"徽章。
- **按月份筛**:只想 1 月出行?点月份 chip,只看那个月还值得去的地方。
- **按玩法筛**:18 个玩法标签(看雪/吃/海/摄影/人文/温泉/星空/徒步…),组合筛选。
- **搜索**:地名、玩法、美食都能搜。
- **AI 帮找**:静态列表搜不到时(≥2 字),自动调用默认模型找当地的"最好玩的事"——流式打字、结果渲染成同款卡片,同一次查询有缓存(Host 内存 + Client localStorage,重进不重烧 token);失败有友好报错和"重新生成"。Host 半注册同源路由 `POST /api/travel/ai`(SSE),llm 服务由 DSH 提供。
- **详情抽屉**:点卡片看"最好玩的事"(带时段)、必吃清单、出发前贴士。
- **想去收藏**:卡片右上角星标收藏,存 localStorage,侧栏"想去 (n)"一键查看。
- **随机去哪**:选择困难时掷骰子,随机开一张详情。
- **中英双语**:界面文案跟 Client locale 走(zh/en)。

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半:注册 `POST /api/travel/ai` 路由(SSE),调默认模型生成玩法卡并清洗成 DEST 形状;导出 `splitReply`/`toDest` 供测试 |
| `client.js` | Web 面板:数据 + UI + slots 注册(同时导出 `__parts` 供离线冒烟) |
| `cordis.patch.yml` | 声明 client 侧 patch |
| `locale/zh.json` `locale/en.json` | 展示元数据(插件行标题/描述) |
| `icon.svg` | 插件图标 |
| `docs/DETAIL.md` `docs/DETAIL.zh.md` `docs/preview.svg` | 插件详情页单图 |
| `harness.mjs` `smoke.mjs` `preview.mjs` | 开发工具:离线 hooks 运行时、客户端冒烟(70 断言)与截图预览 |
| `host-smoke.mjs` | Host 路由离线桩测试(19 断言,假 req/res + 假 llm.stream) |

## 开发自检

```bash
node --check client.js && node --check index.js   # 语法
node smoke.mjs                                    # 客户端离线冒烟,应 83/83
node host-smoke.mjs                               # Host 路由桩测试,应 19/19
node preview.mjs                                  # 生成 /tmp/travel-preview/*.png 截图（需要 Chrome）
```

