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
