# @240xu/dsh-message-ops

DSH web 插件：**消息回滚 + 删除 + 恢复**。只补 dsh 官方**没有**的能力。

> **0.9.0 是破坏性变更**：移除了本插件的**分支**与 **Markdown 导出**。
> 两者 dsh 官方都已有（`session/fork` 与 `/api/session.export`），详见下方「为什么不重复造轮子」。

## 官方没有、本插件提供的

| 能力 | 官方 dsh 0.2.0-rc.2 | 本插件 |
|---|---|---|
| **消息回滚**（遮蔽该条及其后全部内容） | ❌ 没有。`SurfaceOp` 只有 `append\|replace`，**没有解除遮蔽的操作**；`undo` 仅指草稿编辑器的 Ctrl+Z | ✅ |
| **单条删除** | ❌ 没有。官方 README 明文 *"sessions can be archived but never deleted"* | ✅ |
| **恢复**（撤销一次回滚/删除） | ❌ 没有 | ✅ |

## 为什么不重复造轮子（0.9.0 的取舍）

- **分支** → 官方有完整实现：RPC `session/fork`（`atSeq` 任意）+ `SessionStore.fork()`
  + UI 消息级按钮 + 官方埋点就叫 `branch_session_click`。
  本插件原先还有一个磁盘实现（`applyBranch`）作为「官方失败时的回落」，但它语义是错的：
  删掉了 `isSeeded`（官方 fork 设 `true`）、不写 `inheritedEventCount`、
  也不补 fork closers → 产出的子会话边界可能悬空。**已删除**，失败时直接提示停止运行中的会话。
- **Markdown 导出** → 官方 `/api/session.export` 提供 ZIP 归档（原始 JSONL + 附件，面向迁移/复现）。
  格式确实不重叠，但本插件的导出**零 UI 入口**（实测路由可用但前端从不调用），等于死代码。**已删除**。

## 用法

- **会话头部**的 `Message ops (revert / delete / branch)` 按钮 → 统一对话框
- **助手消息** hover 行的 `Revert to here` / `Quote to composer`
- **用户消息** hover 行的 `Revert to here`
- **输入框上方的回撤贴条**：展开后可逐条 `Restore`（这是恢复的唯一入口）
- **侧栏会话行**的 `...` 菜单

对话框流程：**先在列表里选一条消息 → 上方出现三个操作 → 破坏性操作需勾选确认**。

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

## 0.5.2 · Bug 猎场第一轮修复（P0×1 + P1×3 + P2×6）

- **[P0] activeMarkers 被 0.5.0 误删**（与 INPUT_DOCK 同一 commit，0.5.1 只找回常量）：
  dock 100% 静默失效（ReferenceError 被 .catch 吞掉）。已恢复函数 + vm 冒烟守卫。
- **[P1] 工具层未 await async ops**（0.2.1 改 async 后漏同步化）：list/restore 必抛
  TypeError、export 渲出空 text。switch 全部 await + 回归测试（异步桩）。
- **[P1] 引用空块**：assistant 消息 fullText 恒 null，回退 `''` 通过 null 检查 →
  插入空 `> ` 块并报成功。改为按 seq 走新端点 `GET /text` 取单条全文，空串按不可用处理。
- **[P1] 侧栏菜单卡死**：dispatch 缺 sessionId → 对话框永久「正在读取…」。
  从 data-row-key 提取 sessionId 一并派发。
- **[P2] seq 索引缓存投毒**：失败必须 `delete`，否则该会话按钮/dock 到刷新前全失效。
- **[P2] 索引口径**：同 id 取最早 seq（对齐服务端 buildSeqIndex，不再内联取最大）。
- **[P2] branch 工具渲染**：读 keptEvents/parentSession（原读不存在的 kept/parentId）。
- **[P2] dock 标题口径**：改报标记 range 内被遮蔽消息数（原报标记数，严重低报）。
- **[P2] busy 卡死**：runRevert/restoreRow/对话框 run 全部 `Promise.resolve()` 包裹——
  同步抛出也落进 finally；restoreRow 补 finally 双保险。
- **[P2] dock 陈旧**：新增 `dsh-message-ops:changed` 广播，回滚/恢复成功后 dock 自动重拉。
- **[P3] 删 en 独有死键 dock.shadowedN；GET 端点补 405 方法校验。**

### 0.5.3 · 「打开即 Running」误报修复（实机 P0 级）

- isRunning 原查 agents 注册表——会话**在视图中打开**即有条目 → 打开即报
  running → 回撤/删除/分支全部 409 锁死（「按钮没有用」的又一层根因，Playwright
  闭环 e2e 实机抓到：curl 未打开时 false、UI 打开后恒 true）。
- 改读 `sessions.list.getSnapshot().byId[].running`（host-asserted，与官方侧栏
  spinner、官方分支按钮 disabled 同源）；老宿主回退 agents 注册表。

### 0.5.4 · 「点回撤打死整个 dsh」P0 修复（包装实测 exit=1 定位）

- **根因**：dsh 0.2.0 收紧 v4 行准入（`assertV4SystemMessageFields`）——每个
  `system/message` 的 `data` 必须带**正整数 `turn`/`step`**。回滚/删除/恢复的通知
  事件没带 → 持久层 `encodeEventBatch` 抛出的 SessionFormatError **没有任何层捕获
  → 整个 dsh 进程退出**（浏览器端表现为「Failed to fetch」，一切 revert 都静默失败；
  此前多次「实例无故死亡」全部是它）。
- **修复**：新增 `deriveTurnStep(events)`（尾部回溯最近正坐标，兜底 1/1）；
  revert/delete 通知与 restore 通知全部附带坐标；`opsCommit` 改 async 读日志派生，
  HTTP/tool 调用点已 await。回归测试断言三处 append 的 data.turn/step 均为正整数。
- 教训：宿主持久层对未知字段的编码失败会杀进程（记录于 hub——上游应给
  encodeEventBatch 加错误边界），插件侧必须严格遵守 v4 行结构。

### 0.5.5 · v4 准入第 3 关：`message.id` 非空字符串

- 0.5.4 补 turn/step 后实机复测仍崩：`assertV4SystemMessageFields` 继续要求
  `message.id` 为非空 string（`string(x, name, nonempty=true)`）。两处 notice
  append 的 message.id 现用 `randomUUID()`；回归测试断言三段（turn/step/id）。
- 行准入全貌（本轮实测三连击）：① `data.turn/step` 正整数 → ② `message.id`
  非空字符串 → ③ role=system + content 数组 + block 文本串。

### 0.5.6 · dock 死按钮修复：空可重放区间改优雅停用

- 实机闭环：dock 上标记若遮蔽区间只含 tool/system 事件（或遮蔽了另一个标记），
  恢复请求恒 409「no replayable user/assistant messages」——按钮永久死、dock
  计数永远清不掉（Playwright 8 连 409 复现）。
- 改为：planRestore 对空可重放返回空计划；applyRestore 追加**停用 notice**
  （含 restoresSeq → dock 移除该行）+ 如实文案「区间无可重放内容」。
  非标记/越界/非法 seq 仍按原语义 404/409/400。

### 0.5.7 · 第四层根因：store-miss 会话的磁盘追加路径

- **实机链**：lazy-view 让会话只在磁盘渲染、不进对象层（视图开着 dock 已渲染，
  但 `sessions.get(id)` 双变体 miss、`list()` 里只有别的会话）→ 变更操作 404。
  官方服务端**没有** retain/using 面（那是浏览器侧 ClientSessions 的）。
- **修复**：store-miss 时改为**直接向日志追加 zstd 帧**（等价持久层
  `appendLines`：encode → open('a') → write+sync+按 size 回滚），事件字段逐项
  镜像引擎金标准（根键序 `type/seq/time/data/sourceEventSeqs/surfaceOp`；
  restore notice `restoresSeq` + `surfaceOp:"append"`；重放无 id）。
  磁盘会话的视图/搜索/dock 全部按帧重读 → 追加即可见；成功后客户端
  openSession 强制重建视图（磁盘追加无 live 投影事件）。
- live 会话（对象层在册）仍走引擎路径；两条路径共用 turn/step/id 派生与
  空区间停用语义。新回归测试断言可见节点/计划语义/字段镜像（44/44）。

## 0.6.0 · opencode 对齐：回滚长在「我的消息」上 + 贴条化恢复 UI

用户定调「回滚信息怎么可能回滚的是 AI 的信息」——此前唯一一键入口挂在官方
`conversation.chat.assistant-actions` 槽（只渲染在助手消息上），方向整个反了。
Playwright 实测 opencode web（127.0.0.1:4096）后四项改造：

1. **用户消息 hover 注入「回滚」按钮**（核心）：官方无用户消息动作槽 →
   受控 DOM 注入，靶点用官方 `[data-chat-flow-kind="user"]` 属性。点击即回滚
   「这条及其之后」（范围语义与 opencode 实测一致，未动）。**防错锁**：DOM 块 ↔
   API 可见 user 行按序配对 + 文本归一化前缀互验，点击时复验一次，对不上拒绝
   执行（宁可不回滚，不回滚错消息）。
2. **恢复条贴合输入框**（opencode 实测规格：条→输入框 1px、同宽同列、折叠 42px）：
   `.mopsRd` 锁 `max-width:var(--dsh-composer-card-max-width)`（与 `uV2eYG_card`
   同源变量）+ `margin-inline:auto` + `margin-bottom:-5px` 把宿主 composerStack 的
   6px gap 压成 **1px**；实测 bar rect [468,751,776,42]、card top 794/前轮 772 →
   **gap=1、dx=-1、dw=2**；展开时列表向上涨（底边钉住，1px 不丢）。删 18px
   spacer hack。EN 文案改 `{n} rolled back messages`（opencode 语序）。
3. **对话框删「恢复」模式**：恢复唯一入口 = 贴条逐行按钮；对话框只留
   回滚/删除/分支（实测 modeCount=3、无恢复项）。顺手防呆：pick 列表排除
   `role=system`（引擎 node0 守卫本就 500 拒绝——不该给用户一个必然失败的选项）。
4. **恢复去 `[恢复]` 前缀**：重放干净文本（opencode 实测恢复无任何标记）；
   机制说明保留在 system notice。引擎 append-only 无法真正反遮蔽，重放语义不变。
- 附带修复：注入器成功/失败回调误用组件级 `t()`（模块作用域未定义 → ReferenceError
  吃掉刷新链：回滚 200 而贴条不出现）→ 改模块级 `__t`。
- 验证：单测 44/44；Playwright 全环（发消息 → hover 回滚 200 → 贴条 gap=1 →
  展开 → 恢复 → 条清空 + 消息回 + 无前缀）两条路径（注入器 / 对话框）各一遍。
- 已知观察：宿主 `dsh-client-ui-open-in-app` 的 event feed 订阅在**无 id 重放事件**
  （引擎原生 compaction 重放同形）上抛 `operation.kind` 读取错误——客户端已捕获、
  功能无损，属宿主脆读，不在本插件范围。

## 0.7.0 · 用户消息回滚按钮回归「官方动作行」（修布局乱/点不了）

用户实测反馈（0.6.0 的三处真问题，全部根因修复，非症状掩盖）：

1. **按钮压在消息文字上** → 0.6.0 用 `position:absolute; top/right` 覆盖气泡。
   官方用户消息的动作行是 `.xzv4MW_actions`（height28、消息下方 16px、
   `hWmORq_actions{margin-top:16px;margin-left:-6px}`，内含 Copy 按钮）。
   0.7.0 把按钮 **append 进该行**，与 Copy 同级同层（实测 `parentCls=xzv4MW_actions`、
   与 Copy 中心 y 差 ≤6px、与气泡矩形不相交）。
2. **触屏点不了** → 0.6.0 用 `opacity:0 + :hover` 显形。改由宿主动作行自身
   `[data-actions-reveal]` 统一控制（按钮作为其子元素天然继承），并加
   `@media (hover:none)` 兜底常显。
3. **点了没反应 / 有时没按钮** → 两个根因：
   - 锚点不稳：改为从 `.xzv4MW_actions` 反查最近消息容器（回退
     `[data-chat-flow-kind="user"]`），并用 MutationObserver + 滚动扫描覆盖
     虚拟列表动态追加（DOM 里没渲染的块本就无从注入）。
   - **宿主把 `<system-reminder>` / runtime context 也记为 role=user**，
     按序配对被这些"假用户消息"带偏（配对错位 / seq 打不上）。已过滤。
   - 打标是异步的：点击时先 `await` 完成配对再执行（早先点在未打标按钮上静默失败）。
- 沿用并保持：防错锁（文本互验、对不上拒绝执行）、范围语义（含目标到末尾）、
  贴条 gap=1、恢复干净无前缀、运行中 409 守卫（实测点运行中的会话返回
  409 "session is running; stop it first"，符合设计）。
- 验证：单测 44/44；Playwright 失败用例先红后绿（`inOfficialRow && sameRowAsCopy
  && !overlapsBubble` 全真 + `POST /revert 200` + 贴条出现）；对话框路径全环
  （回滚→贴条→展开→恢复→条清空+无前缀）复跑通过。

## 0.8.0 · 按轮步进恢复（对齐 opencode 展开行语义）

opencode 实测：展开行 = 每条被遮蔽消息一行，点行**只恢复该消息及其同轮回复**，
后续保持遮蔽。0.8.0 把"按标记整段恢复"升级为"按轮步进"：

- **服务端**：
  - `planRestore(events, seq, upToSeq?, excludeSeqs?)`：`upToSeq` 截断重放区间；
    `excludeSeqs` 排除已重放源 seq（**B1 修复**：此前每轮从区间头重放 →
    消息副本成倍刷屏，实测 seq8 被重放 5 次）。
  - 恢复 notice 新增 `restoredSourceSeqs`（本次重放的源 seq 列表）——
    引擎准入**不拒绝** data 未知字段（研究册 01 §8），且实测磁盘原样持久化。
  - `restoreProgress()`：标记的恢复进度（restored/pending/complete/legacy）；
    `pendingRestoreTurns()`：未重放轮切分（一个 user 及其后继 assistant 为一轮）。
  - `GET /messages` 为每个标记附 `restoreComplete` + `pendingTurns`
    （含 preview，一次建 seq→text 索引，避免每标记全量扫）。
  - `POST /restore` 接受可选 `upToSeq`（live 与磁盘两路径一致）。
- **客户端**：
  - 贴条行 = 待恢复轮（`#markerSeq · 首条预览 (+N)`），点击只回该轮；
  - 标记活跃判定收敛到服务端权威 `restoreComplete`（删除客户端 restoresSeq
    集合旧判——按轮下部分恢复的标记也带 restoresSeq，旧逻辑会误杀，
    实测：第一轮恢复后整条消失）；
  - 全部轮恢复完 → 标记不活跃 → 贴条消失；兼容旧 notice（视为整段已恢复）。
- **验证**：单测 **49/49**（新增 5 条：upToSeq 截断 / notice 字段 / 进度推进 /
  旧通知兼容 / B1 排除）；Playwright `v080.cjs` 全环 **GREEN**：
  5 行=5 轮 → 点第一行（S1 副本=1、余 4 轮、贴条保持）→ 逐轮清空 →
  `markerActive=false`、无前缀、贴条消失；0.7.0 布局用例复跑 GREEN；
  对话框路径复跑通过（恢复亦按轮）。

## 0.8.1 · discard 停用面 + 用户会话实查结论

- 新增 `POST /restore {discard:true}`：不重放内容、仅停用标记（notice 带
  `discarded:true`，进度判定视为完成）。适用场景：清掉"没有可重放内容/不希望
  重放"的惰性标记。
- 用户主会话（4e10c1a2）实查：8 个测试标记在 0.8.0 语义下全部 complete=True
  （区间无可重放消息内容——链式遮蔽的是其他标记），贴条不再显示，**无需丢弃**；
  hidden≈2710 的大头是 compact-checkpoint（引擎自身历史压缩设计），非测试污染
  （修正 0.8.0 时代"2709 条测试污染"的误判）。清理前已备份日志
  （~/.dsh/backups/session-4e10c1a2.*.zstd.bak，9.2MB）。
- 单测 50/50（+1 discard 语义）。

---

## 0.9.0 变更清单

### 移除（与官方重复或无入口）
- `src/branch.js` 整个删除；`/api/message-ops/branch` 路由、tool 的 `branch` 动作、
  客户端的磁盘回落（`diskBranch`）与 `fork.disk` 文案全部移除。**分支现在只走官方 `sessions.fork()`**，
  失败时提示「官方分支不可用，通常是会话正在运行」。
- `/api/message-ops/export` 路由、`exportMarkdown()`、tool 的 `export` 动作移除。
  **导出一律用官方 `/api/session.export`**（ZIP 归档）。
- 死代码清理：`IconTrash`/`TrashFallback`（零渲染点）、对话框内永不可达的 restore 分支、
  4 组 restore locale 文案（dock 用自己的 `dock.*` 键）。

### 修复（均为浏览器实测发现，静态审查无法发现）
1. **用户消息回滚按钮恒定失效**。四个 bug 叠在一起：
   - `userAnchors()` 匹配 CSS-module 生成的前缀 `Sixlwa_*`，而 dsh 0.2.0-rc.2 的哈希已变为
     `EvIC1a_*` → 锚点集为空；
   - 过滤了 `m.visible !== false`，但宿主聊天视图**不施加**遮蔽模型、照常渲染被回滚的消息
     → 配对候选与 DOM 块零交集；
   - `injected()` 的 `current\s+runtime\s+context` 跑在 `norm()`（`replace(/\s+/g,'')`，删掉**全部**空白）
     之后的串上 → 永远匹配不上，伪 user 行漏进配对；
   - 按钮可用性在 fetch 回调里做事后全局扫描，与 DOM 注入/重排竞态
     → 块已打上 seq 而按钮仍禁用。
   现在实测 `data-mops-seq=["8","54"]`、按钮可用；配不上的块会被**禁用并说明原因**，
   而不是留一个点了才报错的装饰按钮。
2. **对话区硬编码 `_flowItem` 会误收官方 `turn-tail`**（官方 branch 按钮所在行）→ 收紧为
   `data-chat-flow-kind="user"` + `_userRow|_userStack|_bubble`。
3. `defineTool` 注册失败原先 `catch(() => {})` 静默吞掉，无法诊断 → 改为 `console.warn`。

### 契约测试
新增 `test/revert-contract.test.js`：把 **dsh 官方三层闸**接进测试 ——
① 格式层 `assertV4RowAdmission` + `restoreReleasedV4Artifact`、
② 运行时层（role 匹配 / `source.kind` 非空 / `system/message` 必须 `system-prompt`）、
③ **UI 装配层**（`turn/end.data.reason` 必填）。
只��第 ① 层会得到「全绿但 UI 崩」的假象（0.8.x 实机踩过：`dsh-client-ui-trajectory`
的装配器无防护读 `reason.kind`，缺字段直接白屏）。

## 事件形状的三条硬规则（写错就是整份日志报废）

1. **`system/message` 的 `source.kind` 必须严格是 `"system-prompt"`** ——
   Session 运行时层（`dsh-session/lib/index.js:1206`）比格式闸更严。
2. **`turn/end.data.reason` 必填**（`types.d.ts:271-276`）——UI 装配器直接读 `reason.kind`。
3. **空闲会话要写 notice，必须自带一个合成 turn**（`turn/start`+`step/start`+notice+`step/end`+`turn/end`，
   带 `reason:{kind:"interrupted"}`）——v4 要求 `system/message` 匹配**打开的** turn/step，
   而正常会话都以 `turn/end` 收尾（实测 340/364 空闲时是关闭的）。引擎 append-only 插不进已有 step，
   但合成一整个 turn 合法。dsh 自己的崩溃恢复（`openTurnClosers`）用同一手法。

`surfaceOp: replace` 的 notice **不会**渲染成对话行（`dsh-client-ui-chat/lib/client.js:9370`
只渲染 `surfaceOp==="append"`），这是设计如此 —— 回撤提示由输入框上方的贴条负责。

---

## 0.9.1 / 0.9.2 · 回滚「真的生效了」

### 问题：回滚对用户是无效的（0.9.0 及以前）

浏览器实测发现：点回滚后 **dock 计数变了，但消息在界面上���行没变**。

根因（源码 + 实测双重证实）：**dsh 刻意把「模型可见」和「人类 transcript」分成两套**。
`surface.d.ts:51-63` 明写：

> *Append-origin events are that transcript's durable source material; **replacement copies stay model-only**.*

即 `surfaceOp: {op:'replace'}` 只折叠**模型 surface**（实测 393→13 节点，模型侧确实生效），
但前端 transcript **不施加遮蔽**，被遮蔽消息照常渲染且完全可见 —— 连我们的 replace
marker 自身都不渲染（`systemMessageDefinition.buildViewNode` 对 `surfaceOp !== 'append'`
直接 `return null`，`dsh-client-ui-chat/lib/client.js:9370`）。

所以之前那句「回滚已完成」是**误判**：只验了日志写入与 dock 计数，没验用户眼���。

### 解法：渲染层按 node-key 精确映射

每一行渲染节点带 `data-chat-node-key`，形态 `<len>:<kind><id>`，而 `<id>` 就是日志事件的字段：

| 行 kind | `<id>` | 查表 |
|---|---|---|
| `user` / `steering` | messageId | `byMessageId` |
| `assistant-step` | `<turn>:<step>` | `byTurnStep` |
| `tool-call` | callId | `byCallId` |
| `turn-tail` / `turn-process` / `turn-error` | turn 号 | `byTurn` ← **turn/end 的 seq** |
| `developer-message` | messageId | `byMessageId` |

配合服务端的 `revertFences` / `turnEndSeq`，客户端做**精确查表 + fence 比较**，
命中则 `row.setAttribute('hidden', 'until-found')`。

`hidden="until-found"` 与宿主 `useSearchableHidden` 同款：Ctrl+F 仍能搜到，
且宿主的分页锚点选择器 `[data-chat-paging-anchor]:not(:empty):not([hidden])`
会自动跳过，滚动恢复不受影响。

### 三个踩过的坑（都有回归测试锁住）

1. **不能用 `visible` 当隐藏判据**。`visible` 是「是否在模型 surface 上」，而
   `tool/call` / `turn/*` / `model/*` **根本不是 surface 节点**，它们永远 `visible=false`
   —— 照抄会把**所有**工具调用行永久藏掉（实测 3/3 全被误藏）。
   正确口径是 `reverted`（= opencode 的「边界及其后」：`messages.slice(0, boundaryIndex)`）。
2. **回合页脚不是消息**，锚到 `turn/end` 的 seq，永远不在 `reverted` 集合里，
   所以判据必须**直接对 fence 数组比较**。
   且要用 `turn/end` 而非 `turn/start` —— 回撤边界常落在某个 turn **内部**。
3. **旧的 40 字符前缀包含匹配**实测 4 条错 2 条（「继续」命中「继续，…」），
   已整体删除，改为 node-key 查表。

### 实测结果

```
回滚后： hidden 5（user + turn-process×2 + turn-tail×2）
        被回滚消息 disappears from DOM ✅
        该轮之后的助手回答也消失 ✅
        更早的消息完好 ✅
恢复后： hidden 0，dock 消失，消息全部回来 ✅
查表命中率： unresolved 0 / mismatch 0 / hiddenButNotReverted 0 ✅
```

### 已知限制

- **restore 是「重放」语义**（dsh 无 unshadow 原语，见 README 上文的机制说明），
  所以「恢复后再回滚」的复合场景下，重放副本的行可能不被识别为 user 行。
- `restore` 后界面需要触发刷新才更新（已接 `__refreshSurface` 钩子 + MutationObserver，
  但极少数情况下仍需重载页面）。

---

## 0.9.3 · `/undo` —— 复刻 opencode 的招牌交互

「我说的那句话不对」→ 打 `/undo` → 消息从 transcript 消失 + **原文回填输入框**。

走**官方斜杠管线**（`ctx.inputTriggers.registerSource`），不自己劫持键盘，
所以菜单分组、搜索、Enter 裁决、composer 状态机全由宿主负责。

```js
ctx.inject(['inputTriggers'], (sub) => {
  doRegisterUndoSlash(ctx, sub.inputTriggers || sub)   // ⚠️ 见下方坑 2
})
```

### 注册路径踩过的四个坑

1. **`candidates` 必须返回 Promise**。宿主在 `InputTriggerController.fetchCandidates`
   里直接 `source.candidates(...).then(...)`，同步返回数���会抛
   `source.candidates(...).then is not a function`，**整个菜单静默失效**。
2. **cordis `inject` 回调收到的是「注入命名空间」，服务在其同名字段下**
   （与本文件 `sub.uiWorkspace || sub` 同模式）。把 `sub` 直接当服务用会抛
   `cannot get property "registerSource" without inject`。
3. **`rowsCache` 是注入器闭包私有的**（`installUserRevertInjector()` 内）。
   `/undo` 的 `onPick` 在模块级作用域，直接引用会 ReferenceError，
   表现为「点菜单毫无反应」。需要 `__peekRowsCache()` 出口。
4. **`__currentSessionId` 来自 DOM dataset，可能带 `session-` 前缀**，
   而 API 只要裸 uuid → 请求静默失败。

### 目标必须挑 surface 上的那条

`restore` 是「重放」语义 → 原件被遮蔽、副本带**新 seq** 落在日志尾部。
无脑取最后一条会挑到副本，而副本不在模型 surface 上，服务端以
`surface replace: start seq N not found in surface` 拒绝（实测）。
回滚的前提就是「目标在 surface 上」，所以先筛 `visible`。

### 实测

```
composer 输入 /und → 官方菜单出现「回滚上一条消息 undo 移除最后一条用户消息，原文回填输入框」
点击 → 目标 = seq 8（surface 上的那条，不是重放副本）
      → 转��成功，dock 计数 13
      → 原文「分配几个子代理把模型广场的模型价格什么的做好…」回填进 composer ✅
      → transcript：24 行中 22 行 hidden，被回滚消息从正文消失 ✅
```

---

## 0.9.4 · 修「正文几乎空白」

### 症状

用户截图里 133 轮的会话正文几乎全空，只露出零星几个「工具已更新」标记。

### 根因

19 个 marker 是**离散区间**（`[9,9]`、`[10,4368]`、`[6830,8573]` …），
服务端把它们塌缩成 `revertFences = range.start 列表 = [10, 6830, 9829, 11429]`，
客户端判据 `seq >= fence`（任一命中）等价于 **`seq >= min(fences)` = `seq >= 10`**。

于是 **4792/4793 条被判为已回滚** → 全部 hidden → 正文空白。

### 量化验证（两条真实会话）

| 判据 | 隐藏数 | 与宿主 `visibleCount` 吻合？ |
|---|---|---|
| `seq >= min(fence)`（事故判据）| 4792 / 4793 | ✗ 只剩 1 条可见 |
| 未恢复 marker 区间并集 | 2707 | 部分吻合 |
| **`!visible`（模型 surface）** | **2710 / 4574** | ✓ **2083 / 464，精确吻合** |

顺带纠正一处旧断言：`tool/call` **并非**永远不在 surface 上
—— 实测 957 条 `tool/call` 是 visible 的，`visible` 对它同样有意义。

### 修复

- **消息类行**：`hide = !visible.has(seq)`（直接问模型 surface）
- **回合 chrome**（`turn-tail` / `turn-process` / `turn-error` / `model-retry`）：
  `hide = !visibleTurns.has(turn)` —— 该 turn 还有可见消息就露出，
  因为 `turn/end` 本身多半不在 surface 上
- 删除 `revertFences` / `m.reverted` 两个**编码了错误判据**的字段（已无消费者）

### 实测

```
修复前：  正文几乎空白（截图）
修复后：  113 行 → 可见 67 / 隐藏 46，可见字符 36,851
```
