# 宿主能力需求：per-seq payload 重写 + 会话日志 reload

日期：2026-11-10
状态：待提交给 DSH 宿主维护者
提出方：`@240xu/dsh-message-ops`（消息级回滚插件）
优先级建议：中（隐私预期正确性，非崩溃级）

---

## 0. 一句话诉求

请宿主提供**两个能力**，让「回撤（revert）」能像 opencode 的 commit 那样，
在**用户继续对话时**把被回撤消息的原文从会话文件里真正抹掉，而不是只做遮蔽：

1. **per-seq payload 重写**：改写指定 seq 事件的 `data` 内容，但**不删行、不重排 seq、不改事件类型**。
2. **会话日志 reload 入口**：让已打开的会话在持锁状态下重新读盘并重建内存 surface。

没有这两个能力，插件层无论如何都做不到「翻会话文件拿不到原文」。

---

## 1. 背景：用户的诉求与实测落差

用户原话：

> 「回撤的话 AI 还看得到吗？如果直接翻这个会话文件的话，能不能拿得到这个回撤的数据？
> 我希望的回撤是彻底删除，但是由于需要恢复的原因至少在后续几次当中将几次之前的删除」

专项核查（`design-demos/revert-data-semantics.md`，276 行）结论：

| 问题 | 实测答案 |
|---|---|
| 回撤后 AI 还看得到吗？ | **看不到**。宿主 `deriveMessages()`（`dsh-session/lib/index.js:1681-1696`）只遍历 `surface.nodes`；`dsh-agent-loop/lib/index.js:1017` 注明「从 admitted surface 派生请求」 |
| 翻会话文件拿得到吗？ | **拿得到，完整原文**。实测 `session-62374e92…/session.v4.jsonl.zstd`：9018 事件、42 个 replace marker、2135 个被遮蔽 seq，其中 **161 条消息原文逐字可读** |
| 当前「回撤」是什么 | append 一条 `surfaceOp: {op:'replace', startSeq, endSeq}` 的 marker，把区间标成遮蔽。**事件本身和原文原封不动留在 zstd 日志里** |

也就是说：现在的回撤是「拿黑笔划掉但纸还在」，用户以为是「把纸撕了」。
这构成**隐私预期落差**，比功能缺失更该优先处理。

---

## 2. 为什么插件层做不到（已排除的路径）

### 2.1 物理删行 —— 会 corrupt 整份会话

宿主 `surface.js:425-426` 强制 seq 连续：
```js
if (event.seq !== expectedSeq)
    throw new Error(`session event seq ${event.seq} is not contiguous; expected ${expectedSeq}`);
```

**破坏性试验（一次性，throwaway，未碰真实会话）**：
取一个短会话（24 事件），删掉中间 seq 8–11 四行、保留其余事件原 seq 不变，
用宿主 `foldSurface` 重放：

```
session.v4.jsonl.zstd  ✓ foldSurface OK, nodes=2
redacted2.zstd         ✓ foldSurface OK, nodes=2   ← 脱敏重写（见 2.3）
deleted.zstd           ✗ CORRUPT: session event seq 12 is not contiguous; expected 8
```

删中间行必崩。这正是历史上「step/end does not match an open turn」同类强配对校验。

### 2.2 照抄 opencode 的 `DELETE WHERE seq >= boundary` —— 几何对不上

opencode 用可变 SQLite，`projector.ts:1142-1148`：
```sql
DELETE FROM SessionMessageTable WHERE session_id=? AND seq >= boundary.seq
```
这是**尾部删除**，前提是「用户刚回撤、还没继续对话，边界之后就是要删的尾部」。

**但 DSH 的回撤不是尾部语义**。实测真实会话 49 个 replace marker：

```
总事件 9939 | 最大 seq 9938 | replace marker 49
尾部型 marker: 0 | 中间型 marker: 49
（例：marker#469 range=[9..9]，距末尾 9929 个事件）
```

用户回滚到历史中段后，又继续了几千个事件。被遮蔽的内容**早就不在尾部**，
`fs.truncate(path, offset)`（宿主 `dsh-session-persistence-jsonl/lib/index.js:3353` 的 `repair`，
只用于修复撕裂尾部）救不了。

### 2.3 插件自己重写整份日志 —— 磁盘层可行，但运行时不可行

**试验 1（脱敏重写，通过宿主校验）**：
用 `encodeSessionFile(header, events)` 把 seq 8–11 的 `content` 改成 `[redacted]`，
保持事件数 / seq / 类型不变，重新压帧：

```
✓ 回读成功, events: 24
✓ computeShadowed: 4（遮蔽关系不变）
✓ foldSurface OK, nodes=2（宿主校验通过）
  seq=8 content=[{"type":"text","text":"[redacted]"}]
```

证明「**纸还在，字被涂改液盖掉**」在**冷数据层**技术可行，且不破坏 seq 连续性。
宿主 `surface.js:230-258` 的 `assertSourceEventReferences` 只校验 `sourceEventSeqs`
引用合法性，除 `tool/result` 与 node 0 system prompt 外不要求 replace 事件内容与原事件一致，
这是脱敏能成立的原因。

**但插件做这件事有两个致命问题**：
1. **没有 reload 入口**：全库 grep 无 `reload` / `reopen` / `invalidateLog` / `loadFromDisk`。
   会话一旦打开，内存 log 是权威；插件改了磁盘，运行中的会话不会感知。
2. **写锁**：`persistBatch`（`persistence-jsonl:2929`）走 `acquireWriteLease` 串行化，
   插件直接改文件有并发 / 崩溃恢复风险。

所以**必须由宿主在持锁状态下做，并让内存 surface 同步重建**。

---

## 3. 建议的接口（供宿主设计参考，非强制）

### 3.1 per-seq payload 重写

```
redactEvents(sessionId, entries: Array<{ seq: number, data: EventData }>, options?)
```
约束：
- 只改 `data`，**不改** `seq` / `type` / `time` / `surfaceOp` / `sourceEventSeqs`
- 不允许删除或插入行（保持 `foldSurface` 的 seq 连续性）
- 必须走现有 `acquireWriteLease`，与 append 串行
- 返回新的 `contentGeneration`（让 `deriveMessages` 缓存失效）
- 建议限制：只允许把 `message.content` 里的 `text` 块替换为脱敏串，
  不允许改结构（避免绕过 `assertDeveloperHeader` 等校验）

### 3.2 reload / 提交时机

建议由宿主在**已有的 commit 时机**自动触发脱敏，而不是暴露裸 reload：

| 触发点（对标 opencode `session.ts:173 / :264 / :352`） | DSH 对应 hook |
|---|---|
| 用户发下一条消息 | `session.prompt` 准入前 |
| compact | `compaction/*` 流程 |
| 显式提交 | 插件调用 `commitRevert(sessionId, markerSeq)` |

语义：
```
stage（回撤）        → 只 append marker，可恢复（现状，保持不变）
用户继续对话 / commit → 宿主对该 marker 的 [startSeq..endSeq] 内所有
                        消息事件执行 per-seq 脱敏，然后清掉「可恢复」窗口
```
即：**可恢复窗口 = stage 到 commit 之间**；commit 后翻文件也拿不到原文。
这正好对上用户「至少在后续几次当中能恢复、之后彻底删掉」的诉求。

### 3.3 与我们插件的分工

- 插件：负责 UI（回撤入口、确认框、恢复区）、决定何时 stage / 何时请求 commit
- 宿主：负责持锁重写 + 内存 surface 重建 + 保证 `foldSurface` 通过
- 插件**不**自己改会话文件

---

## 4. 已先行落地的缓解（0.21.0，纯插件）

在宿主能力到位之前，我们先止住**隐私预期落差**：

1. 回撤确认框常显告知条：`panel.revertPrivacyNote`
   ——「这不是删除。AI 将看不到这些消息，但原文仍完整保留在本地会话文件中，可被恢复；
   直接翻看会话文件仍能读到。」
2. 行内回滚按钮 title：`slot.revertPrivacyHint`（`syncEnabled` 统一，避免被覆盖）
3. 回滚成功 toast：`done.revert` 补「原文仍保留在本地会话文件，可被恢复」

真实 Chromium 验证（3099 预览实例）：
```
行内按钮 title = "Revert to here (not deletion: hidden from the AI, but the original text stays in the local session file)"
面板确认框 .mopsPrivacyNote = "Note: this is not deletion. ... reading the session file directly still reveals it."
```

---

## 5. 验收标准（宿主改动完成后）

1. 回撤一条消息 → stage 期间可从恢复区还原（现有能力不退化）
2. 用户继续发一条消息（或显式 commit）→ 被回撤消息的原文**在 `session.v4.jsonl.zstd` 里不可读**
   （用 `readSessionFileAsync` 逐帧读，断言 `content` 不含原文）
3. `foldSurface` 对改写后的日志仍通过（无 `seq not contiguous`）
4. 会话可正常继续对话、compact、fork
5. 深色模式 / 现有测试不受影响

---

## 6. 证据索引

| 结论 | 来源 |
|---|---|
| 模型只读 surface.nodes | `dsh-session/lib/index.js:1681-1696`；`dsh-agent-loop/lib/index.js:1017` |
| append-only，唯一写入口 append | `dsh-session/lib/index.js:1524` |
| seq 连续性校验 | `dsh-session/lib/types/surface.js:425-426` |
| replace 不校验新事件内容 | `dsh-session/lib/types/surface.js:230-258` |
| truncate 只用于撕裂尾部修复 | `dsh-session-persistence-jsonl/lib/index.js:2954-2958, 3353-3360` |
| 无 reload / reopen 入口 | 全库 grep 无命中 |
| 脱敏重写试验 / 删行 corrupt 试验 | `design-demos/revert-data-semantics.md` §1 + 本次 Spike 一次性脚本 |
| 49 个 marker 全是中间型 | 本次 Spike 实测输出 |
| opencode 两段式与 DELETE | `design-demos/revert-data-semantics.md` §2.4；`projector.ts:1142-1148` |

---

## 7. 不做的事（YAGNI）

- 不要求宿主支持删中间行（会 corrupt，且 DSH 回撤本就不是尾部语义）
- 不要求重写整份日志（只需 per-seq 改 data）
- 不要求插件获得 bypass 写锁的能力
