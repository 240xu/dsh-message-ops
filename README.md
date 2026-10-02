# @240xu/dsh-message-ops

DSH web 插件：**消息回滚 + 消息删除 + 消息分支** 三合一。在会话头部添加分支图标按钮，
侧栏会话行 "..." 菜单注入「消息操作」项，打开统一操作对话框：

- **回滚（Revert）**：遮蔽所选消息及其后的全部可见内容（DSH 原生 surface replace 语义）。
  日志 append-only，原事件完整保留，语境可通过重新发送恢复。
- **删除（Delete）**：仅遮蔽所选的那一条消息，其余内容不变（同样是 surface replace）。
- **分支（Branch）**：把所选消息（含）之前的全部事件复制为一个**新会话**，
  新会话 header 携带 `parentSession=<原会话 id>`，原会话一个字节都不动 —— 唯一的非破坏操作。

## 安装

零 npm 依赖（只用 `node:fs` / `node:zlib` / `node:path` / `node:url`；zstd 压缩走
Node 内建 `zlib.zstdCompressSync`，需 **Node ≥ 23.5**，Termux 与 Windows 通用）。

```sh
# Termux / Linux
dsh plugin --profile web add @240xu/dsh-message-ops

# Windows
dsh plugin --profile web add @240xu/dsh-message-ops
# 或本地目录：
dsh plugin --profile web add file:C:/path/to/dsh-message-ops
```

重启 DSH web 实例后生效。

## 安全设计

- 回滚/删除不重写日志：通过一条承载 `surfaceOp: replace` 的 system 事件实现，
  约束由 DSH 引擎 `assertProvenance` 校验，违规如实上报（HTTP 409）。
- 回滚/删除前必须勾选风险确认；运行中的会话一律拒绝（提示先停止）。
- 分支先写临时文件再原子 rename，半写日志不会被会话扫描读到。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET  | `/api/message-ops/messages?sessionId=<id>` | 消息级列表（磁盘真相 + 可见性标注 + running 状态） |
| POST | `/api/message-ops/revert`  | `{sessionId, seq}` 回滚到该条（含） |
| POST | `/api/message-ops/delete`  | `{sessionId, seq}` 仅遮蔽该条 |
| POST | `/api/message-ops/branch`  | `{sessionId, upToSeq}` 分支新会话，返回 `{newId, dir, keptEvents}` |
| GET  | `/api/message-ops/export?sessionId=<id>&seq=<可选>` | 导出 Markdown（seq ≤ 上界，缺省全部），附件下载 |
| POST | `/api/message-ops/restore` | `{sessionId, seq}` 回滚恢复：seq 为某次 revert/delete 标记事件的 seq |

## 0.2.4 UI GAP（ux-scout dsh-ui-spec G-M1）

- **S6 违规修复**：回滚/删除成功后不再 900ms 裸 `location.reload()`——改为
  devkit 标准 toast（`window.__dshDevkit.toast` 探测，无 devkit 时降级为对话框
  内完成文案）+ done 态新增「刷新页面」按钮由用户手动刷新；与 branch 路径
  （refreshList 不刷新页面）行为拉齐。

## 0.2.3 格式兼容（compat-audit + 用户实测紧急修复）

- **P0 旧单帧 `session.jsonl.zstd` 读取必崩**：`readSessionFile` 旧实现把帧 0
  整段 `JSON.parse`——旧单帧格式整个文件是一帧、解压出多行 NDJSON，直接抛异常，
  与「旧格式兼容」声明矛盾。现改为**逐行扫描统一路径**：全部帧解压后按行扫描，
  首个 `type:"session"` 行作 header、其余行作事件，v3 多帧 / v4 多帧 / 旧单帧
  三种格式一条代码路径（撕裂行仍按完整前缀语义跳过）。
- **P0 v4 会话格式（用户实测 3080 服务暴露）**：DSH 已升级 v4 持久化
  （`session.v4.jsonl.zstd`，结构同 v3，仅文件名与 `version` 数字不同）。
  `findSessionDirs` 探测序列改为 **v4 → v3 → 旧单帧**（此前只找 v3，最新会话
  全部 "session log not found"）；`readSessionFile` 不做 version 硬校验；
  `applyBranch` 分支写回沿用读到的原格式版本（`session.v<version>.jsonl.zstd`），
  不再写死 v3。
- **dedup**：`listMessages` 内联文本提取收敛到 `session-file.messageText`
  单点（ops-core 转出保持导入面兼容），消除双实现漂移面。
- 回归：40 项测试全绿，含旧单帧/ v4 fixture 往返、listMessages、
  findSessionDirs 三格式发现与 v4 分支写回；真实 v4 会话日志已实测通过。

## 0.2.2 前端收尾（评审 M1/M2）

- **M2 观察范围收窄**：侧栏行菜单注入的 `MutationObserver` 仍观察
  `document.body`（菜单由宿主 React 动态渲染，安装期无稳定锚点），但回调改为
  精确过滤——只有新增节点本身是（或包含）`[role=menu]` 时才调度探测；聊天流
  渲染、流式 chunk 等海量 mutation 零探测成本；同帧多次命中合并为一次探测。
- **M1 分批渲染**：消息列表先渲 50 条，顶部「显示更多（剩余 N 条）」按钮每次
  渐进展开 50 条（上限仍为最近 200 条），避免 200 行单选列表一次性进 DOM；
  打开新会话时分页重置。

## 0.2.1 评审修复（架构评审 arch-review）

- **P0 信任围栏**：全部 6 条 `/api/message-ops/*` 路由接入三层信任判定
  （回环 Host 挡 DNS rebinding + `sec-fetch-site: cross-site` 拒绝 + Origin
  同源校验），非回环/跨站请求一律 403。写操作（revert/delete/branch/restore）
  另要求 `Content-Type: application/json`（text/plain 绕预检的洞 → 415）。
  **为何不引入一次性 CSRF token**：浏览器对所有 POST（含 text/plain）都附带
  Origin 头，Origin 同源校验已覆盖跨站 POST；自定义头天然触发预检、与 Origin
  校验等价——token 只增加握手复杂度而不增加安全性，围栏已足够（论证见
  `src/ops-core.js` 的 `isJsonContentType` 注释）。
- **P1 写端 replace 拼写前向兼容**：`applySurfaceReplace` 写入时先按当前
  运行时 `{startSeq,endSeq}` 形状写；若引擎报 `invalid replace surfaceOp`
  （validateNext 在事件入 log 前抛出，无半写风险）自动降级 `{start,end}`
  重试并记住拼写。当前与未来 dsh cohort 都不炸；读端双拼写兼容已统一收敛到
  `session-file.readReplaceOp` 单点（computeShadowed / planRestore 共用）。
- **P1 大日志让出**：新增 `readSessionFileAsync`，逐帧解压每 8 帧
  `setImmediate` 让出事件循环；messages/export/restore 路由改走该路径。
  帧数超过 500 阈值的 export 在 Markdown 末尾追加耗时提示（partial 语义，
  内容完整无截断）。
- **P2**：`readJsonBody` 加 1MB 上限（超限 413）；`findSessionDirs` 多
  project slug 命中同一 id 时显式报 409 歧义而非静默取第一个；branch 产物
  不进会话注册表——需刷新会话列表后才可见（此为宿主扫描行为，见 branch 命令
  返回后请刷新列表）。

## 0.2.0 新增

### Agent 工具 `message_ops`

模型侧可直接调用五操作：`action: list | revert | delete | branch | restore | export`，参数
`sessionId`（必填）、`seq`、`upToSeq`。工具与 HTTP 路由共用同一套核心逻辑
（`src/ops-core.js`），行为与错误语义完全一致；失败以文本形式返回，不中断回合。

工具注册是**容错**的：本插件 `inject` 保持为空（tools 是可选增强而非硬依赖，
cordis 的 inject 是硬依赖声明，缺服务会让整个插件永不加载）。apply 时探测
`ctx.get('tools')`，有则注册；没有则通过 `ctx.inject(['tools'], …)` 等它出现；
`@deepseek-ai/dsh-tools` 包不可解析时静默跳过工具，HTTP 面完全不受影响。
因此 `@deepseek-ai/dsh-tools` 以 peerDependencies 形式声明（`^0.1.0-rc.6`）。

### 导出 Markdown

`GET /api/message-ops/export?sessionId=<id>&seq=<可选上界（含）>`，`Content-Disposition`
附件下载。user/assistant/system 消息按角色小节展开（`## [seq N] role`），工具调用折叠为
单行引用（含 80 字符参数摘要）；带 `parentSession` 的分支会话在头部标注来源。

### 回滚恢复（restore，重放语义）

`POST /api/message-ops/restore` 传 `{sessionId, seq}`，seq 指向一次 revert/delete 落定的
标记事件（`surfaceOp: replace`、携带 `sourceEventSeqs`）。

**引擎能力查证结论**（见 `src/ops-core.js` 头部注释）：安装的运行时
`@deepseek-ai/dsh-session` 的 SurfaceOp 只有 `append` 与 `replace` 两个变体，
**不存在「解除遮蔽」操作**——surface replace 是 append-only 的永久遮蔽。因此恢复实现为
**重放（replay）而非解除遮蔽**：把被遮蔽区间的 user/assistant 消息文本重新 append 为新
事件，文本加 `[恢复]` 前缀，并先 append 一条 system 说明；tool/call 等不可安全重放的事件
跳过并在结果中计数。原遮蔽区间保持不可见（磁盘日志原样保留）。

**语义差异须知**：恢复出来的消息 seq 是新的、时间戳是新的、措辞带 `[恢复]` 标记，且不是
「回到当时」——后续上下文（中间隔着的其他对话）不会被抹掉。若想「干净地回到某点」，
请用 branch 从该 seq 分叉。

**兼容性备注**：运行时引擎当前 replace 形状为 `{op:'replace', startSeq, endSeq}`；
dsh-src 仓库较新副本已改名为 `start`/`end`。本插件写入用 `startSeq/endSeq`（对齐安装的
运行时），restore 读取端两种拼写都兼容，前向迁移无需改动。

### 开发

```sh
npm test            # 20 个零依赖测试（node --test，Node 26 起目录参数已弃用，改用 glob）
node --check src/*.js
```

格式兼容性已对真实会话日志验证（多帧 v3 格式；旧单帧 `session.jsonl.zstd` 读取走同一帧扫描路径）。

## License

MIT

## 0.3.0 · 用户 UI 回撤体系（官方槽集成）

针对 dsh 0.2.0-rc.2 的用户级操作面（agent 工具保留，但 UI 为主推入口）：

- **每条 AI 消息旁的原生回撤按钮**：注入官方 `conversation.chat.assistant-actions`
  槽（0.2.0 正式扩展点，条目收持久化 messageId）——「回滚到此 / 删除此条 /
  从此分支」直接出现在消息操作行，与官方点赞/点踩并列；0.1.x 无此槽自动 no-op。
  messageId→seq 反查经 `/api/message-ops/messages`（每会话索引缓存）。
- **分支双路径**：0.2.0+ 优先官方 `sessions.fork({sessionId, atSeq, increaseTitle})`
  （子会话自动进宿主列表，成功后可一键 `uiWorkspace.openSession` 打开）；
  官方 fork 失败或 0.1.x 回退磁盘级 applyBranch（原路径保留）。
- **恢复（restore）补完**：选中 revert/delete 落定的 replace 标记行时，对话框
  提供「恢复」操作（重放语义：新 seq + `[恢复]` 前缀，不可重放事件计数跳过），
  确认弹窗内联语义说明（评审缺口销账）。
- 官方已有但易混淆的：0.2.0 原生分支按钮（仅限已完成轮次最后一条消息）与
  本插件的「任意位置分支/回滚」互补不冲突。

### 0.3.1 · 槽按钮重构（opencode 式一键 + 去重）

- **一键立即执行**：回滚/删除点击即生效（无对话框），devkit toast 反馈；宿主
  0.2.0 chat store 原生响应 surface replace——遮蔽即时呈现，无需刷新页面。
- **与官方去重**：槽内移除分支按钮——官方 0.2.0 已在消息操作行自带分支
  （限已完成轮次最后一条）；任意位置分支保留在对话框（官方没有的能力）。
- **原生观感**：按钮改用官方 primitives 图标（IconClockOutline/IconTrashOutline，
  require 失败回退内联 SVG）；S3 命中区 ≥44px；S11 双提交防护（busy 互斥）。

### 0.3.2 · 图标规范化

- 槽按钮去掉文字 emoji——0.2.0+ 直接用官方 primitives 图标（与原生操作行 1:1 同款）；
  回退路径的 SVG 也改为官方 IconClockOutline/IconTrashOutline 的精确 path 数据
  （1px stroke，与 Regular 变体一致），不再手绘。
- 字典文案去 emoji（label 仅用于 tooltip/aria，不参与渲染）。

### 0.4.0 · opencode 式回撤深化（composer 回填 + 回撤 dock）

- **Composer 回填**：回滚**用户消息**后，原文经官方 `InputActions.setDraft`
  自动回填输入框——「编辑重发」零按钮（opencode 招牌交互）。
- **结构化回撤 dock**：注入官方 `conversation.input.dock` 槽（composer 卡片上方
  全宽条目）——「已回撤 N 条（可恢复）」折叠面板，展开列出每个回撤/删除标记，
  逐条「恢复」（restoring 中间态禁用，S11）；无标记时 dock 不渲染。
- 数据链：messages 端点为 user 消息新增 `fullText` 字段（回填原文）。
- 0.1.x 宿主两个槽均不存在，inject 自动 no-op。

### 0.4.1 · dock 修复：统计口径 + 原生观感

- **统计修复**：旧版把历史累积的被遮蔽消息全算进「已回撤 N 条」（多次恢复重放后
  虚高到数百）。现在 dock 只列**手工回撤/删除标记**（排除 compaction checkpoint），
  每条标记显示其 range 内**当前不可见**的消息数；头部为标记计数。
- **原生观感**：样式改为官方 GoalDock/TodoDock 同款——36px 高毛玻璃条
  （`--dsw-specific-menu` + `--dsw-elevation-panel` + `--dsw-radius-md`）、
  composer 卡片对齐宽度（`--dsh-composer-dock-inset` 系列）、13px/500 label、
  28px 圆形切换钮——与目标/计划 dock 视觉完全一致。

### 0.4.2 · dock 像素级对齐 opencode + 回撤生命周期修正

- **回撤生命周期**（对齐 opencode clear 语义）：restore 的 notice 事件现携带
  `restoresSeq` 引用被恢复的标记——dock 只显示**活跃**标记，已恢复项自动消失
  （此前恢复过的标记永远挂在列表里，计数随之虚高）。
- **像素级对齐 opencode SessionRevertDock**（读其 dev 分支源码逐项落地）：
  42px 头部（reset 图标 + 13px/500 label + 折叠时第一条预览文本 + 180° 旋转
  chevron）、rounded-xl + 0.5px 边框 + bg-layer-01 容器、24px 行高 + neutral
  小按钮（非文字链）、items 变化自动折叠、Enter/Space 键盘切换、18px
  sacrificial 空间。

### 0.4.3 · dock 崩溃修复（Hooks 规则违规）

- 0.4.1 的自动折叠 useEffect 位于「无标记早退」之后——标记从 0 变非 0 时多出
  第 4 个 hook，React 抛出 hooks 顺序错误并卸载整个槽（dock 永远不可见，
  Playwright 抓到 React #310）。已把该 effect 移到早退之前（无条件 hook）。

## 0.5.0 · 「按钮没有用」根因修复 + 消息引用

- **根因**：宿主 live 投影只处理 compaction 类 surface replace——插件标记落盘后
  打开的会话视图不会收起，所以回撤/删除按钮点了「没反应」（0.3.x 引入的回归）。
- **修复**：回撤成功后经官方 `uiWorkspace.openSession(sessionId)` 重建会话视图，
  遮蔽立即呈现（无需刷新页面）；dock 的恢复同样触发视图重建。
- **消息引用（新）**：AI 消息操作行新增「引用到输入框」——经官方
  `InputActions.captureInsertion + insertText` 把消息全文以 markdown 引用块
  （`> ` 前缀）插入输入框，零 DOM hack。
- 槽按钮收敛为两个：**⏱ 回撤到此** 与 **❝ 引用**；删除/分支保留在对话框
  （官方分支按钮已覆盖最后一条消息场景）。

### 0.5.1 · 修复 0.5.0 客户端激活失败

- 0.4.2 的 dock 重写误删了 `INPUT_DOCK_SLOT/ID` 常量声明——apply() 引用未定义
  标识符导致**整个客户端激活失败**（页面横幅 Failed to load plugins）。
  已恢复常量；新增 vm 冒烟自测路径（见 .e2e/）。
