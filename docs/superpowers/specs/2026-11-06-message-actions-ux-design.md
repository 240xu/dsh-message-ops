# 消息动作区与编辑 UX 收敛设计

日期：2026-11-06
状态：待用户审阅
仓库：`@240xu/dsh-message-ops`（当前 0.18.0）

## 0. 背景与目标

用户连续多轮反馈同一类问题：消息动作区的 UI/UX 是一轮轮补丁堆出来的，
互相重叠、语义混乱。本设计把动作区、编辑、引用、恢复区收敛成一套连贯的交互。

明确目标（用户原话归纳）：

1. AI 消息下方那个「时钟」按钮删掉——它其实就是回撤，而回撤是用户消息那边的用途。
2. 引用按钮不能和宿主自带的 Copy 撞脸；引用不能把整条消息塞进输入框；
   引用要让 AI 知道这是引用，UI 要打磨。
3. 铅笔点了不能只是把消息回填输入框，要「编辑并重发的那样一个框」。
4. 时序：点「发送」那一刻才回撤（发送之前零副作用）。
5. 「编辑并重发」为什么还存在——要理清楚，收敛为唯一入口。
6. 回撤后折叠的「恢复」区逻辑不要乱；只修自动折叠的烦人行为。
7. 别把 UX 做乱。

## 1. 现状（代码证据，均为当前 HEAD）

| 项 | 位置 | 现实 |
|---|---|---|
| AI 消息时钟按钮 = 回撤 | `src/client.js:2997` | `act(React.createElement(IconClock,...), t('slot.revert'), 'revert', runRevert, running)` |
| 引用图标撞脸 Copy | `src/client.js:2748` | `IconQuote = P2.IconChatOutlineRegular \|\| P2.IconCopyOutlineRegular`，回退用复制图标 |
| 引用塞整条全文 | `src/client.js:2954-2960` | `runQuote` 把 `fullText` 或 `/text` 接口返回的**整条**传给 `inputActions.insertQuote` |
| 宿主引用本就结构化 | `dsh-client-ui-conversation:13837` | `QuoteNode.getTextContent()` → `formatQuoteText`，注释「exact model-visible Markdown blockquote」；渲染 `QuotePreview`（带删除按钮） |
| 面板仍有编辑入口 | `src/client.js:217-222, 351-354` | `panel.edit` 等文案仍在 |
| 面板老回填路径 | `src/client.js:784-793` | `mode==='revert'` 时直接 `__inputActions.setDraft(pickedMsg.fullText)` + `persistDraft` |
| 行内铅笔只回填 | `src/client.js` `runUserEdit` | → `refillComposer` → 写 `dsh.conversation.<sid>` 草稿键，无编辑框 |
| dock 自动折叠 | `src/client.js` `useEffect` | `markers` 长度或首 seq 变化就 `setOpen(false)` |
| 恢复 = 重放 | `src/client.js:165` | 文案「恢复为重放：消息将出现在会话末尾，不会回到原位」；引擎无解除遮蔽原语 |

## 2. 已确认的决策

| 编号 | 决策 | 用户选择 |
|---|---|---|
| D1 | 编辑语义 | 独立编辑框 + 自动回撤重发（方案 A） |
| D1' | 时序 | **点「发送」那一刻才回撤**，之前零副作用（用户补充） |
| D1'' | 实现方式 | **方案甲**：编辑浮层自带「发送并回撤」按钮，不劫持宿主提交流程 |
| D2 | 引用 | 保留、换图标、改成引用选中片段/结构化、打磨 UI，让 AI 可识别 |
| D3 | AI 动作区 | 删时钟，只留引用一个按钮 |
| D4 | 恢复区 | 逻辑不动（恢复=重放、不回原位），只去掉自动折叠 |

## 3. 设计

### 3.1 动作区收敛（最终形态）

- **用户消息动作行**（宿主 `.xzv4MW_actions` 内）：
  `时间文本 → 宿主 Copy → ｜ 回撤 → 铅笔编辑 → 分叉`
  回滚前的竖线分隔保留（防误触，0.18.0 已加）。
- **AI 消息动作行**（插件 assistant-actions 槽）：
  **只渲染一个「引用」按钮**。`runRevert` 那条 `act(...)` 删除。
  宿主自带的 Copy 保持不动。
- **面板（OpsPanel）**：删除 `panel.edit` 那一组按钮与其 `startEdit` 回调；
  删除 `src/client.js:784-793` 的 `setDraft` 老路径。
  面板只保留：列表浏览 + 搜索 + 回滚/删除/分叉/恢复。
- 面板中「回滚用户消息后回填原文」的能力由 `refillComposer` 保留（这是回滚语义的一部分，
  不是编辑功能），但不再作为独立编辑入口暴露。

### 3.2 编辑并重发（唯一实现）

新增 `EditResendOverlay`（走 `shell.overlay` 槽）：

- 触发：用户消息动作行的铅笔按钮。
- 内容：多行 `textarea`，预填该条消息**完整原文**（走 `/api/message-ops/text` 取全文，
  不用 160 字 snippet）；显示来源提示（这条消息属于哪一轮、seq）。
- 按钮：`取消` / `发送并回撤`。
- **时序（关键）**：
  1. 打开浮层、改文本：不调用任何写接口，不改草稿、不遮蔽。
  2. 点「取消」或关闭：零副作用。
  3. 点「发送并回撤」：
     a. 先 `POST /api/message-ops/revert { sessionId, seq }` 遮蔽该条及其之后全部消息；
        失败则报错并**保持在编辑框**，不发送。
     b. 成功后把改后文本 `writeSessionDraft` 落盘，再 `openSession` 重建视图。
     c. 尝试 `inputActions.submit()` 触发一次提交；若宿主不可用则退回「文本已放入
        输入框，由你按回车发送」并明确提示（不静默）。
- **风险与取舍**：宿主 `InputActions.submit()` 硬编码为 `"queue"`（排队而非立即发送），
  且插件无法可靠地"在宿主发送那一刻"挂钩。因此本设计把「发送」定义为
  **编辑浮层里的「发送并回撤」按钮**：点它 = 回撤 + 把改后文本放进 composer + 触发一次提交。
  这与用户「点发送之后再把前面的内容回撤」的意图一致（发送动作发生时回撤），
  但不劫持宿主 composer 的提交管线。

### 3.3 引用

- 图标：换成官方非 copy 的引用图标（优先 `quote` 类；确认 primitives 暴露名后再定，
  不复用 `IconCopyOutlineRegular`）。
- 文本来源：
  1. 优先取用户在 AI 消息里的**选中文字**（`window.getSelection()`，限定在该消息节点内）。
  2. 无选中 → 取整条但**截断到合理长度**并在引用块里标注来源（消息 seq / 角色）。
- 一律走 `inputActions.insertQuote(text)`：宿主生成结构化 `QuoteNode`
  （模型可见 markdown blockquote + `QuotePreview` 可视化 + 删除按钮），
  不再手工拼 `> `、不再 `captureInsertion`。
- 不再把整条未截断全文直接塞进 composer。

### 3.4 恢复区（dock）

- 删除 `useEffect` 中「markers 变化 → setOpen(false)」的自动折叠。
- 折叠状态只由用户点击 header / chevron 改变。
- 恢复语义（重放、新 seq、不回原位）与 `dock.restoreHint` 文案**不变**。
- 顺手对齐圆角（`--dsw-radius-*`）与主题 token，不改布局结构。

### 3.5 统一约束

- 所有颜色走 `var(--dsw-alias-*, fallback)`，禁止裸 hex。
- 圆角统一走宿主 `--dsw-radius-*`。
- 新增/改动均配回归测试；现有 309 测试必须全绿；`prettier --check` 通过。
- 每个改动是独立提交，便于逐项验证。

## 4. 数据流（编辑并重发）

```
[用户消息 铅笔]
   → ensureEditBtn / runUserEdit（改为 openEditOverlay）
   → GET /api/message-ops/text?seq=N        （取全文）
   → EditResendOverlay（textarea 预填）
        ├─ 取消 → 关闭，零副作用
        └─ 发送并回撤
             ├─ POST /api/message-ops/revert { seq:N }
             │     └─ 失败 → 报错，留在编辑框
             ├─ writeSessionDraft(sid, 改后文本)（合并写入，保住 view 偏好）
             ├─ openSession(sid) 重建视图
             └─ 触发提交（composer）
```

## 5. 错误与边界

- 会话运行中：回撤接口会 409；编辑框应显示明确错误并保留内容，不丢失用户已改的文本。
- 全文接口失败：编辑框禁用发送，提示重试（不拿 160 字 snippet 冒充原文）。
- 引用时无选中且全文过长：截断 + 标注，不静默塞全文。
- `writeSessionDraft` 必须合并写入（0.14.0 已修），避免覆盖 `view` 偏好。
- 编辑框关闭不落盘、不回撤；重复打开不影响会话。

## 6. 测试计划

- 结构锁：AI 动作槽不再渲染时钟/回撤；面板不再有 `panel.edit` 入口；
  老 `setDraft` 路径已删。
- 行为锁：编辑浮层「取消」零副作用；「发送并回撤」先 revert 再写草稿；
  revert 失败不发送、不清空编辑内容。
- 引用锁：走 `insertQuote`、不拼 `> `、不 `captureInsertion`、图标不是 copy。
- dock 锁：不再有 markers 变化触发的 `setOpen(false)`。
- 全量 `npm test` 全绿 + `prettier --check`。

## 7. 实施顺序（4 个独立提交）

1. 删 AI 时钟 + 收敛面板重复编辑入口与老 `setDraft` 路径。
2. 引用重做（图标 + 选中片段 + 官方结构化引用）。
3. 编辑浮层（发送并回撤，方案甲）。
4. dock 自动折叠 + 视觉收尾。

## 8. 不做的事（YAGNI）

- 不劫持宿主 composer 的提交管线。
- 不实现「真正的一键撤销回撤」（append-only 日志做不到，也不安全）。
- 不引入第二套设计 token。
- 不把面板改造成独立编辑器（面板定位仍是浏览 + 上下文）。

---

## 9. 审计后修订（2026-11-06 晚，Lead 决断，覆盖 §3.2）

### 9.1 决定性发现

profile 里**已安装并实际加载** `@linxin666/dsh-client-ui-message-edit@0.4.14`
（3080 与 3098 的 bundle graph 均命中）。它注入 `conversation.chat.turnTail` 槽，
提供的正是用户要的「编辑并重发」：

- 回合末尾一个文字按钮「编辑并重发」/ "Edit and resend"（`lib/client.js:196,208`）
- 点开是**原地 textarea**（`.gbJVYa_editor`，radius 12px，全 `--dsw-alias-*` token）
- 提交走 `sessions.fork({atSeq: seq-1})` → `sessions.using(childId)` →
  `reference.binding.session.prompt([{type:"text",text:editedText}], "queue")`
  （`lib/client.js:234-245`）—— 这是**官方认可的编辑并重发路径**
- 源会话不变；Esc 取消、Ctrl/Cmd+Enter 重发、运行中/无 fork 权限禁用
- README 明确「不会改写原日志、不会回滚后续副作用」

也就是说：**「编辑并重发」不该由本插件实现，它早已由专门插件提供。**
本插件在 0.12.0/0.17.0/0.18.0 里做的 `panel.edit`、行内铅笔 `mopsUserEdit`、
`client.js:784` 的老 `setDraft` 路径，全都是与它重复的劣质轮子，且互相矛盾
（用户看到「编辑并重发为什么还存在」就是这么来的）。

### 9.2 修订后的决断（覆盖 §3.2 与 §3.1）

**删除，不再自己造编辑框。**

1. 删除行内铅笔按钮 `ensureEditBtn` / `runUserEdit` / `.mopsUserEdit` 样式 /
   `slot.edit*` 文案。用户消息动作行收敛为：`时间 → 宿主Copy → ｜ 回撤 → 分叉`。
2. 删除面板 `panel.edit` 一组按钮与 `startEdit` 回调、相关文案与状态
   （`detailFull` / `editTextReady` / `panel.edit*`）。
3. 删除 `client.js:784-793` 的 `mode==='revert'` 老 `setDraft` 路径。
   「回滚用户消息后回填原文」仍由 `refillComposer` 承担（属回滚语义，不是编辑入口）。
4. 编辑并重发交由已装的 `@linxin666/dsh-client-ui-message-edit` 在 **turn-tail** 提供。
   本插件不再重复暴露入口，也不与之争抢同一动作行。
5. §3.2 的 `EditResendOverlay` / `shell.overlay` / 「发送并回撤」方案**整个废弃**。
   用户「点发送才回撤」的时序诉求，由官方插件的 fork 语义天然满足：
   点保存那一刻才 `fork` + `prompt`，此前源会话零副作用。

### 9.3 对 §3.2 风险的结论

审计确认 `prompt(..., "queue")` 中的 `"queue"` 是官方插件自己在用的提交模式
（`lib/client.js:243`），不是缺陷。本插件无需触碰 composer 提交管线 —— 这进一步
印证「不劫持宿主」是正确的，也彻底消除了 §3.2 里那个 submit 歧义。

### 9.4 修订后的实施顺序（4 个独立提交）

1. **收敛编辑入口**：删铅笔 / 面板 edit / 老 setDraft 路径；动作行只剩 回撤 + 分叉。
   配回归测试证明「本插件不再提供编辑入口」，并说明由 message-edit 插件承担。
2. **删 AI 时钟**：assistant-actions 槽只渲染引用一个按钮。
3. **引用重做**：换非 copy 图标、选中片段优先、截断+标注、走官方 insertQuote。
4. **dock**：去掉 markers 变化触发的自动折叠；恢复=重放语义与文案不变。

§3.3（引用）、§3.4（dock）、§3.5（统一约束）、§5（错误边界）、§6（测试）、
§8（YAGNI）继续有效，仅 §3.1/§3.2 被本节覆盖。
