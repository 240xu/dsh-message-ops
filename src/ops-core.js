import { randomUUID, createHash, createHmac, timingSafeEqual } from 'node:crypto'

/** OpsError 单点在 session-file.js（computeShadowed 护栏也在那里抛它）；此处转出保持既有导入面。 */
export { OpsError } from './session-file.js'
import { OpsError } from './session-file.js'
/**
 * dsh-message-ops — 可复用操作核心（纯逻辑，无 HTTP、无 dsh-tools 依赖）。
 *
 * HTTP 路由（src/index.js）与 Agent 工具 message_ops 共用这里的函数，
 * 保证两条入口的行为（规划 / 校验 / 错误语义）完全一致。
 *
 * 引擎能力查证（来自安装的运行时 @deepseek-ai/dsh-session/lib/types/surface.js）：
 *   - SurfaceOp 只有 'append' 与 'replace' 两个变体，不存在「解除遮蔽」
 *     操作；surface replace 是 append-only 的永久遮蔽。
 *   - 运行时引擎的 replace 形状是 { op:'replace', startSeq, endSeq }
 *     （dsh-src 仓库较新副本已改名为 start/end；本插件面向安装的运行时，
 *     写入用 startSeq/endSeq，读取端两种拼写都兼容以便前向迁移）。
 *   - 因此「回滚恢复」只能实现为「重放」（replay）：把被遮蔽区间的
 *     user/assistant 消息文本重新 append 为新事件（0.6.0：干净文本无前缀，对齐 opencode），
 *     而不是取消遮蔽。语义差异见 README。
 * @module dsh-message-ops/ops-core
 */

import { readReplaceOp, messageText, messageTextFull, computeShadowed } from './session-file.js'

// messageText 的单点实现在 session-file.js（listMessages 同用）；此处转出保持
// 既有导入面兼容（ops-core 的 messageText 调用方不受影响）。
export { messageText }

/** 带语义状态码的操作错误（单点已迁至 session-file.js，此处仅转出）。 */

/** planRevert：回撤语义 = 遮蔽 targetSeq 及其之后全部可见节点（连续到末尾）。 */
/**
 * 该 seq 是否是一条**回撤/删除 marker**（surfaceOp=replace 的 system/message）？
 *
 * 0.14.0 护栏：marker 是账本，不是对话。允许拿 marker 当回滚目标会产生一种
 * 自噬记录 —— 新 marker 遮蔽旧 marker，`content` 为空、`startSeq===endSeq`，
 * 界面上表现为「恢复之后又多出一条『回滚后的节点』」。实测语料里已经出现过
 * 5 次（seq 3424/3658/3689/3721/3746），全部由 dock 用 `mk.seq` 当目标造成。
 */
export function isMarkerEvent(e) {
  return !!e && e.type === 'system/message' && readReplaceOp(e) !== null
}

export function planRevert(surface, targetSeq) {
  const nodes = surface && Array.isArray(surface.nodes) ? surface.nodes : []
  const startIdx = nodes.indexOf(targetSeq)
  if (startIdx === -1) throw new OpsError(`surface replace: start seq ${targetSeq} not found in surface`, 409)
  const shadowedSeqs = nodes.slice(startIdx)
  if (shadowedSeqs.length === 0) throw new OpsError('nothing to revert', 409)
  // 0.26.0：节点 0 保护面（宿主 assertSystemHeadRewrite，见 systemHeadRejection 的
  // 长注释）。live 路径拿到的是宿主**真实** surface，头节点即 system prompt，
  // 多节点回滚它会被宿主拒绝整份日志 —— 规划层必须同判（磁盘路径已同判）。
  const head = nodes[0]
  const headEvent = head === targetSeq ? surfaceHeadEventOf(surface) : null
  if (startIdx === 0 && headEvent && headEvent.type === 'system/message' && shadowedSeqs.length !== 1) {
    throw new OpsError(
      'surface replace: node 0 holds the system prompt and may be rewritten only by a system/message over exactly that node' +
        `（目标 seq ${targetSeq} 是 surface 头节点，回滚它会把系统提示连同后面 ${shadowedSeqs.length - 1} 个节点一起遮蔽 —— 宿主会整份拒绝该日志）`,
      409,
    )
  }
  return {
    startSeq: targetSeq,
    endSeq: shadowedSeqs[shadowedSeqs.length - 1],
    shadowedSeqs,
  }
}

/**
 * live surface 对象的头事件（宿主 `SurfaceManager` 只暴露 `nodes`，不带事件本体）。
 *
 * 无事件可查时按**保守**口径处理：live surface 的节点 0 在真实会话里恒为
 * system prompt（语料 240/240 份如此），故把「头节点 + 多节点遮蔽」一律拒绝，
 * 而不是放行后让宿主把整份日志拒掉（后者用户无法自救）。
 */
function surfaceHeadEventOf(surface) {
  const events = surface && Array.isArray(surface.events) ? surface.events : null
  if (events) {
    const seq = surface.nodes[0]
    return events.find(e => e && e.seq === seq) || { type: 'system/message' }
  }
  return { type: 'system/message', assumed: true }
}

/** planDelete：单条遮蔽，要求 seq 仍在当前 surface 上可见。 */
export function planDelete(surface, seq) {
  const nodes = surface && Array.isArray(surface.nodes) ? surface.nodes : []
  if (!nodes.includes(seq)) throw new OpsError(`seq ${seq} not visible on current surface`, 409)
  // 单节点遮蔽恒满足宿主的 node-0 豁免（system/message over exactly that node），
  // 故 delete 不额外拒绝；但 marker 仍不得当目标（与磁盘路径同判，planDeleteFromEvents
  // 侧有事件本体可判，这条在 live 路径由调用方给事件，见 opsCommit 的 isMarkerEvent 闸）。
  return { startSeq: seq, endSeq: seq, shadowedSeqs: [seq] }
}

// 写端 replace 拼写（前向兼容雷，评审 P1）：当前运行时引擎
// （@deepseek-ai/dsh-session/lib/types/surface.js 的 isReplaceOp）要求
// {op:'replace', startSeq, endSeq} 且恰好 3 个键；dsh-src 较新副本已改名
// {op:'replace', start, end}（同样恰好 3 个键）。写端做一次运行时探测：
// 先按当前 cohort 的 startSeq/endSeq 形状写，若引擎报
// "invalid replace surfaceOp"（validateNext 在事件入 log 前抛出，失败不落
// 状态、无半写风险），降级用 {start,end} 重试一次并记住结果。读端
// （readReplaceOp/computeShadowed/planRestore）两种拼写始终兼容。
let replaceShape = null // null=未探测 | "legacy"=startSeq/endSeq | "new"=start/end

function replaceOpFor(shape, startSeq, endSeq) {
  return shape === 'new' ? { op: 'replace', start: startSeq, end: endSeq } : { op: 'replace', startSeq, endSeq }
}

/** 测试专用：重置写端拼写探测缓存。 */
export function _resetReplaceShape() {
  replaceShape = null
}

/**
 * v4 消息归属（producer-owned source）构造。
 *
 * 0.8.1 P0 实机事故：dsh 0.2.0 收紧 v4 准入后，本插件写的每条消息都缺
 * `message.source` → `format v4 message requires a producer-owned source kind`
 * → **整份日志被拒绝，20 个会话在 UI 打不开**（v4 要求 kind 非空且非
 * "plugin"；v3 反过来要求 system/message 的 kind==="plugin"，两边都不
 * 接受缺失）。
 *
 * 形状必须**同时满足 v3 与迁移后的 v4**（实测踩出来的）：
 *  - v3（v2-to-v3 `assertV3RowAdmission`）要求 `system/message` 的
 *    `message.source.kind === "plugin"`，否则报 `system message requires
 *    plugin source`。而插件的 `findSessionDirs` 会 v4 → v3 → 旧单帧逐级回退，
 *    24 个 v3 日志是活靶子。
 *  - v4 的 `source()` 只拒绝**字面量** `"plugin"`（v3-to-v4:126），而
 *    `producerKind()` 对未知插件返回 `plugin:<name>` —— 该值 v4 接受。
 *  → `{kind:"plugin", plugin:"<name>"}` 是唯一两边都合法的形状：迁移时
 *    `rewritePluginSource` → `producerKind` → `plugin:@240xu/dsh-message-ops`。
 *
 * ⚠️ 不要改成 `{kind:"message-ops"}`：它在 v3 直接非法（实测 FAIL）。
 */
const PLUGIN_NAME = '@240xu/dsh-message-ops'
const PRODUCER_KIND = `plugin:${PLUGIN_NAME}` // 迁移后的 v4 形态

/**
 * 按**目标代**构造消息 source —— v3 与 v4 的合法形状互斥（实测）：
 *
 *   source                                  v3 日志      v4 日志
 *   {kind:"plugin", plugin:<name>}          PASS ✅      FAIL ✗（拒字面量 "plugin"）
 *   {kind:"plugin:<name>"}（producerKind）  FAIL ✗      PASS ✅
 *   {kind:"message-ops"}                    FAIL ✗      PASS ✅
 *
 * 根因：v3 的 `assertV3RowAdmission` 要求 system 类消息 `source.kind==="plugin"`；
 * v4 的 `source()` 只拒绝**字面量** "plugin"，而 `producerKind()` 对未知插件产出
 * `plugin:<name>`，该值 v4 接���。
 * 插件的 `findSessionDirs` 会 v4 → v3 → 旧单帧逐级回退（语料里 24 个 v3 日志），
 * 所以**必须按写到哪里决定形状**，不能一刀切。
 *
 * @param {number|undefined} version 目标日志的 header.version（4 = v4；其余按 v3 形状）
 */
function messageSource(role, version) {
  const r = role ?? 'system'
  // ⚠️ role=system 只能写 "system-prompt"：Session 运行时层（dsh-session/lib/index.js:1206）
  // 对 `system/message` 要求 kind **严格等于** "system-prompt"，比 v4 格式闸更严，
  // 任何 producer-owned kind（含 plugin:<name>）都会被加载端拒���：
  //   `session event at seq N message must have system-prompt source`
  if (r === 'system') return { kind: 'system-prompt' }
  if (version === 4) return { kind: PRODUCER_KIND, role: r }
  return { kind: 'plugin', plugin: PLUGIN_NAME, role: r }
}

function assistantReplaySource(item, version) {
  const source = item && item.source
  if (version === 4) {
    if (
      !source ||
      source.kind !== 'model' ||
      typeof source.provider !== 'string' ||
      !source.provider ||
      typeof source.model !== 'string' ||
      !source.model
    ) {
      throw new OpsError('assistant replay requires the original model source', 500)
    }
    return { ...source }
  }
  if (source && typeof source === 'object' && typeof source.kind === 'string' && source.kind) {
    return { ...source }
  }
  return messageSource('assistant', version)
}

/**
 * 重放事件的 data 形状 —— **按事件类型分派**。
 *
 * 0.8.1 P0 实机事故（第二处）：`user/message` 的 v4 契约里**消息本体字段
 * 直接摊在 data 上**（`data.id` / `data.role` / `data.source` /
 * `data.content`），而 `assistant/message` 才包一层 `data.message`
 * （并带 turn/step）。旧代码对两者一律写 `{ message: {...} }` →
 * user/message 被双重包裹成 `data.message.role`，且丢 id、丢 source。
 * 正确形状见 `dsh-session-format-v2-to-v3/lib/index.js:264-271`。
 */
export function replayEventData(item, ts, version = 4) {
  if (item.type === 'user/message') {
    return {
      id: item.id ?? randomUUID(),
      role: 'user',
      source: messageSource('user', version),
      content: [{ type: 'text', text: item.text }],
    }
  }
  if (!ts || !Number.isSafeInteger(ts.turn) || ts.turn <= 0 || !Number.isSafeInteger(ts.step) || ts.step <= 0) {
    throw new OpsError('replayEventData: assistant/message 需要打开的 turn/step，拒绝写出注定无法加载的事件', 500)
  }
  return {
    turn: ts.turn,
    step: ts.step,
    message: {
      id: item.id ?? randomUUID(),
      role: 'assistant',
      source: assistantReplaySource(item, version),
      content: [{ type: 'text', text: item.text }],
    },
    // ⚠️ v4 契约 `stream: AssistantStreamRecord[]` **非可选**
    // （SessionEventMap，见 dsh-agent-preset-registry/lib/typert.host.js:647）。
    //
    // 缺它的后果不是「格式闸拒绝」——格式闸对 stream 只有 Array.isArray 守卫，
    // 会放行——而是**运行期炸在投影层**：
    //   dsh-token-meter/lib/types/usage-projection.js:65  usageOf()
    //     → data.usage === undefined 时回落到
    //   dsh-llm/lib/index.js:1412  lastAssistantStreamChunk(stream, 'usage')
    //     → `for (index = stream.length - 1; ...)` ← stream 是 undefined
    //     → TypeError: Cannot read properties of undefined (reading 'length')
    // 抛出点没有 try/catch：
    //   - 历史加载  → dsh-session-query/lib/index.js:482 → UI「Failed to load history」→ **正文 0 行**
    //   - 控制流基线 → dsh-api-session-controller/lib/index.js:1178 → 逸出 async* →
    //     `[session-controller] control stream failed`（一个坏会话打死全站控制流）
    //
    // `stream: []` 是**已实测安全**的取值：
    //   expandAssistantStream([]) → [] → assertCurrentAssistantStreams 里 timed.length===0 直接 continue，
    //   跳过 content/usage/replayState 的 deepStrictEqual 校验；UI 走 message.content 渲染，不依赖 stream。
    // ⚠️ 反面教材：不要写「半填充流」（如只放 message-end/usage chunk）——
    //   一旦 timed.length !== 0，宿主要求 blocks()/usage/replayState 与 message 全部深等，做不全就是新的写坏。
    stream: [],
  }
}

/**
 * surface replace 落定：append 一条承载 replace 的 system/message。
 * sourceEventSeqs 必须覆盖被遮蔽的全部 surface 节点（引擎
 * assertProvenance 强校验，缺失即抛错）。
 */
/**
 * deriveTurnStep：从事件流尾部回溯最近的正整数 turn/step 坐标。
 *
 * 0.5.4（实机 P0）：dsh 0.2.0 收紧 v4 准入（assertV4SystemMessageFields）——
 * 每个 system/message 的 data 必须带正整数 turn/step。缺失时持久层
 * encodeEventBatch 抛出的 SessionFormatError **未被任何层捕获 → 打死整个 dsh
 * 进程**（包装实测 exit=1，栈：assertV4SystemMessageFields ← encodeEventBatch
 * ← cordis apply）。通知事件复用最近一次活动的坐标（row-admission 只做
 * positive 校验，无状态机匹配要求）；空/旧日志兜底 1/1。
 */
export function deriveTurnStep(events) {
  if (Array.isArray(events)) {
    for (let i = events.length - 1; i >= 0; i--) {
      const d = events[i] && events[i].data
      if (d && Number.isSafeInteger(d.turn) && d.turn > 0 && Number.isSafeInteger(d.step) && d.step > 0) {
        return { turn: d.turn, step: d.step }
      }
    }
  }
  return { turn: 1, step: 1 }
}

/**
 * 规划承载 notice 的 turn/step 窗口。
 *
 * v4 关系状态机要求 `system/message` 的 `data.turn/step` 匹配**当前打开**的
 * turn+step（`assertReleasedV4Relationships` → `requireStep`）。但用户恰恰在会话
 * **空闲**时想回滚消息，而正常会话都以 `turn/end` 收尾 —— 实测 364 个日志里
 * **340 个（93%）空闲时 turn+step 是关闭的**。若此时拒绝，功能等于不存在。
 *
 * 出路：引擎 append-only（Session 公开方法里确无 insert/splice），所以把 notice
 * 包进一个**自足的合成 turn**：turn/start → step/start → notice → step/end → turn/end。
 * 这正是 dsh 自己的崩溃恢复（`openTurnClosers`���用同一手法合��闭合事件。
 * 已对官方校验闸实测四种情形全部通过：append 型 / 单节点 replace / 多节点 replace /
 * 遮蔽受保护头（正确拒绝）。
 *
 * 合成 turn 带 `reason:"message-ops"`，UI 与审计可据此识别，不与真实模型轮次混淆。
 *
 * @returns {{synthetic: boolean, turn: number, step: number,
 *            preamble?: Array, postamble?: Array}}
 */
/** 合成 turn 落盘后，把宿主 idle agent 的 turn 游标对齐到该 turn（否则下一条真实消息会重号）。 */
export function alignLiveTurnCursor(ctx, session, turn) {
  if (!Number.isSafeInteger(turn) || turn < 1 || !session || typeof session.id !== 'string') return false
  // 0.11.4：插件 `inject` 故意留空（tools 是可选增强），因此 `ctx.agents`
  // **属性访问恒为 undefined** —— 旧实现只写 `ctx.agents`，这条对齐从来没执行过。
  // 实测 `ctx.get("agents")` 在 HTTP 请求期可解析（同 resolveSession 的取法），
  // 故属性优先、ctx.get 兜底。
  let agents = null
  try {
    if (ctx && ctx.agents) agents = ctx.agents
  } catch {
    /* getter threw */
  }
  if (!agents) {
    try {
      agents = ctx && typeof ctx.get === 'function' ? ctx.get('agents') : null
    } catch {
      /* absent */
    }
  }
  let agent = null
  try {
    agent = agents && typeof agents.get === 'function' ? agents.get(session.id) : null
  } catch {
    /* registry miss */
  }
  if (!agent || agent.phase?.kind !== 'idle' || typeof agent.setPhase !== 'function') return false
  const lastTurn = Number.isSafeInteger(agent.phase.lastTurn) ? agent.phase.lastTurn : 0
  if (lastTurn >= turn) return false
  agent.setPhase({ kind: 'idle', lastTurn: turn })
  return true
}

export function sessionLogOf(session) {
  if (!session) return null
  if (Array.isArray(session.log)) return session.log
  if (Array.isArray(session.events)) return session.events
  if (typeof session.events === 'function') {
    try {
      const log = session.events()
      return Array.isArray(log) ? log : null
    } catch {
      return null
    }
  }
  return null
}

export function planNoticeWindow(events) {
  let turn = null,
    step = null,
    maxTurn = 0
  for (const e of events ?? []) {
    const d = e?.data
    if (Number.isSafeInteger(d?.turn) && d.turn > maxTurn) maxTurn = d.turn
    switch (e?.type) {
      case 'turn/start':
        turn = d?.turn ?? null
        step = null
        break
      case 'step/start':
        step = d?.step ?? null
        break
      case 'step/end':
        step = null
        break
      case 'turn/end':
        turn = null
        step = null
        break
      default:
        break
    }
  }
  // 会话正开着 turn+step（例如上一轮被中断）→ 直接用现成窗口，不造合成 turn
  if (turn !== null && step !== null) return { synthetic: false, turn, step }
  if (turn !== null) throw new OpsError('session is between steps; retry after the current turn settles', 409)
  const nextTurn = maxTurn + 1
  return { synthetic: true, turn: nextTurn, step: 1 }
}

/** 合成窗口的前缀事件（seq/time 由调用方分配）。 */
export function noticeWindowPreamble(win) {
  if (!win.synthetic) return []
  return [
    { kind: 'turn/start', data: { turn: win.turn, reason: 'message-ops' } },
    { kind: 'step/start', data: { turn: win.turn, step: win.step } },
  ]
}

/** 合成窗口的后缀事件。 */
export function noticeWindowPostamble(win) {
  if (!win.synthetic) return []
  return [
    { kind: 'step/end', data: { turn: win.turn, step: win.step } },
    // ⚠️ turn/end.data.reason 是**必填契约**（types.d.ts:271-276），引擎自己也这么写
    // （dsh-session/lib/index.js:783-786）。UI 的 trajectory 装配器无防护地读
    // `match.event.data.reason.kind`（dsh-client-ui-trajectory/lib/client.js:997-998）
    // → 缺字段会让整个会话页白屏（ConversationNodeAssembler.replayContext 抛 TypeError）。
    // 用 "completed"：这是成功的记账 turn；用 "interrupted" 会被聊天 UI 渲染成“已停止”。
    { kind: 'turn/end', data: { turn: win.turn, reason: { kind: 'completed' } } },
  ]
}

/**
 * 展开 `sourceEventSeqs` 的存储形态为宿主内存态整数序列。
 *
 * ⚠️ 宿主把**连续 ≥3 个** seq 无损压缩成 `[start, end]` 闭区间对
 * （dsh-session/lib/index.js `encodeSeqRanges`，读盘 `decodeSeqRanges` 再展开）。
 * 因此 `[[780, 782]]` 表示 **780、781、782 三个**节点，不是「两个端点」。
 * 早期版本用 `flat(Infinity)` 处理 —— 会把 `[3, 6]` 变成 `3, 6`，
 * 丢掉区间内的 4、5，写出的 marker 被引擎判 `sourceEventSeqs must include
 * every shadowed surface node; missing 4, 5` 而 500/409。
 *
 * @param {unknown} value 存储形态（整数与/或 `[start, end]` 闭区间）
 * @returns {number[]} 去重后保持首次出现顺序的整数序列
 */
export function expandSourceSeqs(value) {
  const out = []
  const seen = new Set()
  const push = seq => {
    if (!Number.isSafeInteger(seq)) throw new OpsError('surface replace sources must be integer seqs', 500)
    if (seen.has(seq)) return
    seen.add(seq)
    out.push(seq)
  }
  for (const entry of Array.isArray(value) ? value : []) {
    if (Array.isArray(entry)) {
      if (entry.length !== 2) throw new OpsError('surface replace source ranges must be [start, end] pairs', 500)
      const [start, end] = entry
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) {
        throw new OpsError('surface replace source ranges require integer start <= end', 500)
      }
      for (let seq = start; seq <= end; seq += 1) push(seq)
    } else {
      push(entry)
    }
  }
  return out
}

export function applySurfaceReplace(session, startSeq, endSeq, sourceEventSeqs, noticeText, turnStep) {
  const ts = turnStep && Number.isSafeInteger(turnStep.turn) && turnStep.turn > 0 ? turnStep : { turn: 1, step: 1 }
  const sources = expandSourceSeqs(sourceEventSeqs)
  const data = {
    turn: ts.turn,
    step: ts.step,
    message: { id: randomUUID(), role: 'system', source: messageSource('system', 4), content: [{ type: 'text', text: noticeText }] },
  }
  if (replaceShape) {
    return session.append('system/message', data, { surfaceOp: replaceOpFor(replaceShape, startSeq, endSeq), sourceEventSeqs: sources })
  }
  try {
    const event = session.append('system/message', data, { surfaceOp: replaceOpFor('legacy', startSeq, endSeq), sourceEventSeqs: sources })
    replaceShape = 'legacy'
    return event
  } catch (err) {
    if (!/invalid replace surfaceOp/.test(String(err && err.message))) throw err
    const event = session.append('system/message', data, { surfaceOp: replaceOpFor('new', startSeq, endSeq), sourceEventSeqs: sources })
    replaceShape = 'new'
    return event
  }
}

/**
 * planRestore：从磁盘事件流规划「回滚恢复」。
 *
 * @param {Array} events 磁盘全量事件（readSessionFile 的返回）
 * @param {number} restoreSeq 一次 revert/delete 落定的 system/message 事件的
 *   seq（其 surfaceOp 为 replace、sourceEventSeqs 记录了被遮蔽节点）
 */
export function planRestore(events, restoreSeq, upToSeq, excludeSeqs) {
  if (!Array.isArray(events)) throw new OpsError('restore: events must be an array', 500)
  if (!Number.isSafeInteger(restoreSeq) || restoreSeq < 0) throw new OpsError('invalid seq', 400)
  const ev = events.find(e => e && e.seq === restoreSeq)
  if (!ev) throw new OpsError(`restore: event seq ${restoreSeq} not found in log`, 404)
  // 读取端拼写统一走 session-file 的 readReplaceOp（双拼写兼容的单点）。
  const range = readReplaceOp(ev)
  if (!range) {
    throw new OpsError(`restore: seq ${restoreSeq} is not a revert/delete marker event (no well-formed replace surfaceOp)`, 409)
  }
  const { startSeq, endSeq } = range
  // 0.8.0 按轮步进：upToSeq 给定则只重放到该 seq（含），后续仍保持遮蔽；
  // excludeSeqs = 已重放过（先前轮次 notice 的 restoredSourceSeqs 并集），
  // **必须排除，否则每轮都从区间头重放 → 消息副本刷屏**（0.8.0 实测 B1）。
  //
  // 0.26.0（根因修正）：候选集必须是**该 marker 真正遮蔽的节点**，不是数值区间。
  // 宿主 foldSurface 用节点索引 splice，数值区间会**连带把早先 marker 已遮蔽的
  // 节点算进来** → 重放用户根本没回滚过的消息。实测 session-ab6f marker 1197：
  // 区间 89..1191 里数值候选 151 条，宿主遮蔽集只有 `[89, 90, 1191]` —— 旧实现会把
  // 149 条早已被遮蔽的历史消息当作"恢复对象"重放出去（复原的是别人回滚掉的内容）。
  const shadowed = markerShadowedSeqs(events, ev)
  // 数值区间仅用于「无法判定遮蔽集」的历史/损坏 marker（markerShadowedSeqs 返回 null）。
  // 反向区间（start > end）在数值口径下**没有语义**（宿主是节点索引区间）——
  // 猜 min..max 会重放用户根本没回滚过的消息，故此时一律不出候选（与
  // `computeShadowed` 对无凭据反向 marker 的历史约定一致：视为未遮蔽任何东西）。
  const numericOnly = shadowed == null && startSeq <= endSeq
  const numericCap = Number.isSafeInteger(upToSeq) ? Math.min(upToSeq, Math.max(startSeq, endSeq)) : Math.max(startSeq, endSeq)
  const fallbackSpan = numericOnly ? { lo: Math.min(startSeq, endSeq), hi: numericCap } : null
  // shadowed == null 且反向区间 → 空集（不猜）。numericOnly 时此集不参与判定。
  const shadowedSet = shadowed == null ? new Set() : new Set(shadowed.filter(q => Number.isSafeInteger(q)))
  const stepCap = Number.isSafeInteger(upToSeq) ? upToSeq : null
  const excluded = Array.isArray(excludeSeqs) ? new Set(excludeSeqs.filter(q => Number.isSafeInteger(q))) : null
  const replayable = []
  let skipped = 0
  for (const e of events) {
    if (!e || typeof e.seq !== 'number') continue
    if (numericOnly) {
      if (e.seq < fallbackSpan.lo || e.seq > fallbackSpan.hi) continue
    } else {
      if (!shadowedSet.has(e.seq)) continue
      // 按轮步进：落在 upToSeq 之后的候选仍保持遮蔽（不计 skipped，它们不是"跳过"）
      if (stepCap !== null && e.seq > stepCap) continue
    }
    if (e.type === 'user/message' || e.type === 'assistant/message') {
      if (excluded && excluded.has(e.seq)) continue
      // 0.23.0（深挖 S-1）：重放必须取**全段**。宿主把长文本拆成多个 content
      // 段（compaction checkpoint 实测 321+7954+20 三段），旧实现用 messageText
      // 只取首段 → 恢复副本永久丢掉后半段。实测 898 条多段消息受影响、
      // 累计丢 175 万字符，其中 133 条是真人输入。
      const text = messageTextFull(e)
      if (!text.trim()) {
        skipped++
        continue
      }
      replayable.push({
        seq: e.seq,
        type: e.type,
        role: e.type === 'user/message' ? 'user' : 'assistant',
        text,
        source: e.type === 'assistant/message' && e.data && e.data.message ? e.data.message.source : undefined,
      })
    } else {
      skipped++ // tool/call 等不可安全重放的事件：跳过并在结果里计数
    }
  }
  // 0.5.6：区间无可重放消息（如只遮蔽了 tool/system 事件）不再 409 ——
  // dock 会为这类标记常驻显示恢复按钮，409 死按钮 = 永远清不掉（实测 8 连 409）。
  // 改为返回空计划：applyRestore 仍追加说明 notice（含 restoresSeq）→ 标记停用、
  // dock 计数递减；语义如实：0 条重放 + 文案说明区间无 user/assistant 内容。
  const top = Math.max(startSeq, endSeq)
  const effectiveUpTo = stepCap === null ? top : Math.min(stepCap, top)
  return { restoreSeq, startSeq, endSeq, upToSeq: effectiveUpTo, replayable, skipped }
}

/**
 * applyRestore：把 planRestore 的重放计划落定到 live session。
 * 引擎不支持取消遮蔽（SurfaceOp 无该变体），故实现为重放：
 * 0.6.0：每条消息以原类型 append、**干净文本（无前缀，对齐 opencode 干净恢复）**；先 append 一条 system 说明。
 */
/** 恢复说明文案（live append 与磁盘路径共用；空可重放 = 停用语义）。 */
export function restoreNoticeText(plan) {
  return plan.replayable.length === 0
    ? `[消息恢复] seq ${plan.startSeq}..${plan.endSeq} 区间无可重放的 user/assistant 消息（` +
        `内容为 tool/system 事件或空文本）——该回撤标记就此停用，区间保持遮蔽`
    : `[消息恢复] 重放 seq ${plan.startSeq}..${plan.upToSeq != null ? plan.upToSeq : plan.endSeq} 的 ${plan.replayable.length} 条消息` +
        (plan.upToSeq != null && plan.upToSeq < plan.endSeq ? `（按轮步进：seq ${plan.upToSeq + 1}..${plan.endSeq} 仍遮蔽）` : '') +
        (plan.skipped > 0 ? `（另有 ${plan.skipped} 条不可重放事件已跳过）` : '') +
        `；原区间仍处于遮蔽状态，恢复为重放而非解除遮蔽`
}

export function applyRestore(session, plan, { flush } = {}) {
  const eventSeqs = []
  const notice = plan.discard
    ? `[消息操作] 回撤标记 seq ${plan.restoreSeq} 已停用（丢弃）：区间内容保持遮蔽、未重放；日志原文仍在，可搜索`
    : restoreNoticeText(plan)
  // 0.4.2：notice 事件携带 restoresSeq —— dock 据此把被恢复的标记从「活跃回撤」
  // 中移除（对齐 opencode clear 语义：恢复后不再显示为待恢复项）。
  const ts = plan.turnStep && Number.isSafeInteger(plan.turnStep.turn) && plan.turnStep.turn > 0 ? plan.turnStep : { turn: 1, step: 1 }
  const noticeEvent = session.append(
    'system/message',
    {
      turn: ts.turn,
      step: ts.step,
      message: { id: randomUUID(), role: 'system', source: messageSource('system', 4), content: [{ type: 'text', text: notice }] },
      restoresSeq: plan.restoreSeq,
      restoredSourceSeqs: plan.discard ? [] : plan.replayable.map(i => i.seq),
      ...(plan.discard ? { discarded: true } : {}),
    },
    { surfaceOp: 'append' },
  )
  if (noticeEvent && noticeEvent.seq != null) eventSeqs.push(noticeEvent.seq)
  for (const item of plan.discard ? [] : plan.replayable) {
    const event = session.append(item.type, replayEventData(item, ts), { surfaceOp: 'append' })
    if (event && event.seq != null) eventSeqs.push(event.seq)
  }
  if (flush) {
    try {
      flush()
    } catch {
      /* flush 失败不回滚已接受的事件 */
    }
  }
  return { restoredCount: plan.discard ? 0 : plan.replayable.length, skipped: plan.skipped, eventSeqs }
}

/**
 * 0.8.0：计算一次 revert/delete 标记的「恢复进度」。
 *
 * @param {Array} events 全量事件（含标记与其后的恢复 notice）
 * @param {number} markerSeq 标记事件 seq
 * @returns {{ startSeq:number, endSeq:number, restoredSeqs:number[], pendingSeqs:number[], complete:boolean, legacy:boolean }}
 *   - restoredSeqs：已被重放过的源 seq（来自各 notice 的 restoredSourceSeqs）
 *   - pendingSeqs：仍未重放的、可重放的源 seq（贴条按行展示用）
 *   - complete：是否已全部恢复（标记不再活跃）
 *   - legacy：旧通知（无 restoredSourceSeqs 字段）→ 视为整段已恢复
 */
/**
 * 「该 marker 的可重放候选集」单点口径（restoreProgress 直算版与索引版共用）。
 *
 * 0.26.0：候选取**宿主遮蔽集**（`markerShadowedSeqs`），不再取数值区间。
 * 与 `planRestore` 的候选集同源，二者因此不会再出现「进度说还有 151 条待恢复、
 * 实际只能恢复 2 条」的分裂。空文本消息仍然不算候选（重放不出内容）。
 *
 * 兜底：抹蔽集无法判定（历史损坏 marker）时退回数值区间，与旧行为一致。
 *
 * @param {Array} events 全量事件
 * @param {object} marker 标记事件
 * @param {{startSeq:number,endSeq:number}} range marker 的 replace 区间
 * @returns {number[]} 候选 seq（升序）
 */
function restoreCandidates(events, marker, range, fold = null) {
  const shadowed = markerShadowedSeqs(events, marker, fold)
  const candidates = []
  if (shadowed) {
    const set = new Set(shadowed.filter(q => Number.isSafeInteger(q)))
    for (const e of events) {
      if (!e || typeof e.seq !== 'number' || !set.has(e.seq)) continue
      if (e.type !== 'user/message' && e.type !== 'assistant/message') continue
      if (!messageTextFull(e).trim()) continue
      candidates.push(e.seq)
    }
    // 升序：宿主遮蔽集按**节点序**（compaction checkpoint 的反向区间会得到非升序
    // 数组），而贴条按行展示与 step 步进都假定升序（旧实现天然升序）。
    return candidates.sort((a, b) => a - b)
  }
  const lo = Math.min(range.startSeq, range.endSeq)
  const hi = Math.max(range.startSeq, range.endSeq)
  // 反向区间（start > end）且遮蔽集无法判定（无凭据、折叠也定位不到端点）→
  // 与 `computeShadowed` 的历史约定一致：**视为未遮蔽任何东西**，不拿 min..max
  // 去猜。数值区间对反向 marker 没有语义（宿主是节点索引区间），瞎猜会重放
  // 用户根本没回滚过的消息。
  if (range.startSeq > range.endSeq) return []
  for (const e of events) {
    if (!e || typeof e.seq !== 'number' || e.seq < lo || e.seq > hi) continue
    if (e.type !== 'user/message' && e.type !== 'assistant/message') continue
    if (!messageTextFull(e).trim()) continue
    candidates.push(e.seq)
  }
  return candidates
}

export function restoreProgress(events, markerSeq) {
  const list = Array.isArray(events) ? events : []
  const marker = list.find(e => e && e.seq === markerSeq)
  if (!marker) return null
  const range = readReplaceOp(marker)
  if (!range) return null
  const { startSeq, endSeq } = range
  const candidates = restoreCandidates(list, marker, range)
  const notices = list.filter(e => e && e.data && e.data.restoresSeq === markerSeq)
  const restored = new Set()
  let legacy = false
  let discarded = false
  for (const n of notices) {
    // 0.8.1：显式丢弃（不重放内容、仅停用标记）也算完成——
    // 用户场景"我都没回滚过，清掉测试遗留条"，2709 条重放是另一种污染。
    if (n.data.discarded === true) {
      discarded = true
      continue
    }
    const seqs = n.data && Array.isArray(n.data.restoredSourceSeqs) ? n.data.restoredSourceSeqs : null
    if (!seqs) {
      legacy = true
      continue
    }
    for (const q of seqs) if (Number.isSafeInteger(q)) restored.add(q)
  }
  const pending = candidates.filter(q => !restored.has(q))
  return {
    startSeq,
    endSeq,
    restoredSeqs: Array.from(restored).sort((a, b) => a - b),
    pendingSeqs: pending,
    complete: legacy || discarded ? true : pending.length === 0,
    legacy,
    discarded,
  }
}

/**
 * 恢复进度索引（`buildDerived` 每份日志建一次）。
 *
 * 0.26.0 新增 `candidateTexts`：索引版候选集必须与直算版**同源同判据**
 * （遮蔽集 + `messageTextFull` 非空）。旧实现建索引时用 `messageText`（首段）
 * 判非空、按数值区间选候选 —— 与 `planRestore` 三处口径分裂，实测 457 条
 * 前向 marker 里 17 条候选集与宿主真值不符（16 条 compact-checkpoint、
 * 1 条 system-prompt）。现在把「节点序遮蔽集」一并缓存进索引：`buildDerived`
 * 每份日志只折叠一次 surface，标记越多越省。
 */
export function buildRestoreIndex(events) {
  const bySeq = new Map()
  const noticesByMarker = new Map()
  const candidates = []
  const textBySeq = new Map()
  for (const e of events) {
    if (!e || typeof e.seq !== 'number') continue
    bySeq.set(e.seq, e)
    if (e.type === 'user/message' || e.type === 'assistant/message') {
      // 0.26.0：判据与 planRestore 对齐 —— 首段为空但后段有内容的也算候选
      // （实测 0 条「首段空而全文非空」，但口径必须一处，否则未来必分裂）。
      if (messageTextFull(e).trim()) {
        candidates.push(e.seq)
        textBySeq.set(e.seq, messageTextFull(e))
      }
    }
    const markerSeq = e.data && e.data.restoresSeq
    if (Number.isSafeInteger(markerSeq)) {
      const list = noticesByMarker.get(markerSeq)
      if (list) list.push(e)
      else noticesByMarker.set(markerSeq, [e])
    }
  }
  const fold = foldSurfaceNodes(events)
  return { bySeq, noticesByMarker, candidates, textBySeq, fold }
}

export function restoreProgressFromIndex(index, markerSeq) {
  const marker = index.bySeq.get(markerSeq)
  if (!marker) return null
  const range = readReplaceOp(marker)
  if (!range) return null
  const { startSeq, endSeq } = range
  // 0.26.0：候选集走与 restoreProgress 完全相同的单点口径（遮蔽集，非数值区间）。
  const shadowed = markerShadowedSeqs([], marker, index.fold)
  const candidates = []
  if (shadowed) {
    const set = new Set(shadowed.filter(q => Number.isSafeInteger(q)))
    for (const q of index.candidates) if (set.has(q)) candidates.push(q)
  } else {
    const lo = Math.min(startSeq, endSeq)
    const hi = Math.max(startSeq, endSeq)
    for (const q of index.candidates) if (q >= lo && q <= hi) candidates.push(q)
  }
  const notices = index.noticesByMarker.get(markerSeq) || []
  const restored = new Set()
  let legacy = false
  let discarded = false
  for (const n of notices) {
    if (n.data.discarded === true) {
      discarded = true
      continue
    }
    const seqs = n.data && Array.isArray(n.data.restoredSourceSeqs) ? n.data.restoredSourceSeqs : null
    if (!seqs) {
      legacy = true
      continue
    }
    for (const q of seqs) if (Number.isSafeInteger(q)) restored.add(q)
  }
  const pending = candidates.filter(q => !restored.has(q))
  return {
    startSeq,
    endSeq,
    restoredSeqs: Array.from(restored).sort((a, b) => a - b),
    pendingSeqs: pending,
    complete: legacy || discarded ? true : pending.length === 0,
    legacy,
    discarded,
  }
}

export function pendingRestoreTurnsFromIndex(index, markerSeq, progress) {
  if (!progress || progress.pendingSeqs.length === 0) return []
  const turns = []
  let current = null
  for (const q of progress.pendingSeqs) {
    const e = index.bySeq.get(q)
    if (!e) continue
    if (e.type === 'user/message') {
      current = { turnSeq: q, seqs: [q] }
      turns.push(current)
    } else if (current) current.seqs.push(q)
    else turns.push({ turnSeq: q, seqs: [q] })
  }
  return turns
}

/**
 * 0.8.0：贴条按行展示用 —— 列出该标记仍未重放的「轮」（一个 user 消息及其后
 * 到下一个 user 之前的 assistant 回复算一轮，对齐 opencode 按轮步进恢复）。
 *
 * @param {Array} events 全量事件
 * @param {number} markerSeq 标记事件 seq
 * @param {{pendingSeqs:number[]}=} progress **可选**：调用方已经算好的
 *   restoreProgress(events, markerSeq) 结果。原先这里内部再调一次
 *   restoreProgress —— 对同一 marker 是 O(events) 的纯重复扫描（每次都要
 *   全量遍历 + messageText 提取），而 opsList 对每个 marker 都要先算一遍
 *   progress 再问「待恢复轮」，等于每标记白扫两遍。传入已算好的 prog 即可
 *   省掉；不传则维持原行为（内部自算），既有调用方/测试不受影响。
 * @returns {Array<{ turnSeq:number, seqs:number[] }>} 按 seq 升序
 */
export function pendingRestoreTurns(events, markerSeq, progress = null) {
  const prog = progress || restoreProgress(events, markerSeq)
  if (!prog || prog.pendingSeqs.length === 0) return []
  const list = Array.isArray(events) ? events : []
  const bySeq = new Map()
  for (const e of list) if (e && typeof e.seq === 'number') bySeq.set(e.seq, e)
  const turns = []
  let current = null
  for (const q of prog.pendingSeqs) {
    const e = bySeq.get(q)
    if (!e) continue
    if (e.type === 'user/message') {
      current = { turnSeq: q, seqs: [q] }
      turns.push(current)
    } else if (current) current.seqs.push(q)
    else turns.push({ turnSeq: q, seqs: [q] }) // 孤立 assistant（无前导 user）
  }
  return turns
}

// ---------------------------------------------------------------------------
// HTTP 信任围栏（评审 P0）：插件经 webServer.register 挂载的路由不经过宿主
// connection RPC 面的 isTrustedApiRequest 围栏（dsh-src
// packages/client/connection/src/api-request-trust.ts），必须自建。三层：
//   1. Host 必须是回环地址 → 挡 DNS rebinding（伪造 Host 的攻击页直接 403）；
//   2. sec-fetch-site: cross-site 拒绝 → 挡跨站浏览器请求；
//   3. Origin 存在时必须与 Host 同源 → 挡其余跨站 POST/GET。
// 非浏览器客户端（curl / Agent 工具 / 宿主自身）不带 sec-fetch-site 与
// Origin，且 Host 均为回环 → 天然放行，无需 token。
// ---------------------------------------------------------------------------

function headerOf(headers, name) {
  const value = headers && headers[name]
  return typeof value === 'string' ? value : undefined
}

function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

/** 与 slv-check 同款的信任判定（回环 Host + 非 cross-site + Origin 同源）。 */
export function isTrustedApiRequest(req) {
  const host = headerOf(req && req.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (headerOf(req.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = headerOf(req.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * 写操作 CSRF 防护：Content-Type 必须 application/json（允许 ;charset=… 后缀）。
 * 为何不需要一次性 token：浏览器对**所有** POST（含 text/plain 绕预检的
 * 那条路）都会附带 Origin 头，第 3 层 Origin 同源校验已覆盖跨站 POST；
 * Content-Type 约束是纵深防御（阻止非 JSON 客户端误写），而自定义头
 * （如 X-Requested-With）天然触发 CORS 预检，与 Origin 校验等价，故
 * 引入 token 只增加握手复杂度而不增加安全性——围栏已足够（论证记录于此）。
 */
export function isJsonContentType(req) {
  const ct = headerOf(req && req.headers, 'content-type') || ''
  return ct.split(';')[0].trim().toLowerCase() === 'application/json'
}

// ---------------------------------------------------------------------------
// 0.10.8 · web 前端鉴权对齐（GET 也要过宿主的浏览器认证门）
// ---------------------------------------------------------------------------
// 宿主侧实况（全局 dsh 0.2.0-rc.2 的 dsh-client-connection/lib/index.js）：
//   admit(request)（:742-749）对每一条 /api 前缀请求（含 GET）都要求
//   browserAuth 认证——根 token 只在 authorizeIndex 换 cookie：GET /<token>
//   → 铸 HttpOnly+SameSite=Strict 的签名 cookie（名 = dsh-auth-<b64url(
//   sha256(authority))>，载荷 v{1|2}.<b64url(json)>.<b64url(hmac-sha256)>
//   secret 32 字节，存 credentials 记录 client-connection/browser-session）
//   → 重定向 ./；此后每条 /api 都凭 cookie 过 admit，无 cookie → 401。
//   前端取数是同源 fetch（默认凭证）——cookie 自动随行，**全程没有
//   Authorization 头，也没有 ?token= 打到 /api**。
// 插件路由此前只跑 isTrustedApiRequest（该围栏自述 "is not an auth layer"），
// 同机无凭证进程 GET 即可整卷消息/全文（宿主同条件 401——审计缺口）。
// 对齐修法（选型理由见报告）：前端本来就带 cookie → 围栏里**校验同款
// cookie**；secret 经 credentials 服务的合法读法取（no-op modifyRecord，
// 勿写勿落盘）。无 credentials 服务 = 老宿主 → 保留旧围栏；有服务但记录
// 缺失/格式升级 → **fail-closed** 并告警，避免永久 allow-all。
// 非浏览器 GET（curl 等）从 200 变 401 = 与宿主对齐的有意行为变化。

const AUTH_RECORD_KEY = 'client-connection/browser-session'
const AUTH_COOKIE_PREFIX = 'dsh-auth-'
const AUTH_STORED_SECRET_VERSION = 1
const AUTH_SECRET_BYTES = 32

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u

function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function decodeBase64Url(value) {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) return undefined
  const padding = '='.repeat((4 - (value.length % 4)) % 4)
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
  return encodeBase64Url(decoded) === value ? decoded : undefined
}

/** 宿主 requestAudience 的口径：HTTP 用 url.host；TLS 用 url.origin。插件
 * 读不到监听面协议，两种拼写都试（名字与载荷 authority 用**同一个**拼写
 * 配对校验，跨拼写伪造照样被拒）。 */
function cookieAuthorityCandidates(hostHeader) {
  try {
    const url = new URL(`http://${hostHeader}`)
    return [url.host, `https://${url.host}`]
  } catch {
    return []
  }
}

/** 宿主 cookieValue：按分号切段取**第一个**同名区的值（无解码语义）。 */
function cookieValue(rawCookie, name) {
  if (typeof rawCookie !== 'string') return undefined
  for (const segment of rawCookie.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1 || segment.slice(0, at).trim() !== name) continue
    return segment.slice(at + 1).trim()
  }
  return undefined
}

/** 宿主 decodeCookie 的镜像：三段结构 + HMAC + 载荷形状（v1 浏览器 peer / v2 带操作者 id）。 */
function decodeBrowserAuthCookie(value, secret) {
  const parts = value.split('.')
  const [version, body, encodedSignature] = parts
  if (parts.length !== 3 || (version !== 'v1' && version !== 'v2') || body === undefined || encodedSignature === undefined) return undefined
  const actualSignature = decodeBase64Url(encodedSignature)
  if (actualSignature === undefined) return undefined
  const expectedSignature = createHmac('sha256', secret).update(body).digest()
  if (actualSignature.length !== expectedSignature.length || !timingSafeEqual(actualSignature, expectedSignature)) return undefined
  const bodyBytes = decodeBase64Url(body)
  if (bodyBytes === undefined) return undefined
  let decoded
  try {
    decoded = JSON.parse(bodyBytes.toString('utf8'))
  } catch {
    return undefined
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return undefined
  if (decoded.version !== 1 && decoded.version !== 2) return undefined
  if (version !== `v${decoded.version}`) return undefined
  if (typeof decoded.authority !== 'string' || decoded.authority === '') return undefined
  if (typeof decoded.issuedAt !== 'number' || !Number.isSafeInteger(decoded.issuedAt)) return undefined
  if (typeof decoded.expiresAt !== 'number' || !Number.isSafeInteger(decoded.expiresAt)) return undefined
  const payload = { version: decoded.version, authority: decoded.authority, issuedAt: decoded.issuedAt, expiresAt: decoded.expiresAt }
  if (decoded.version === 1) return payload
  if (typeof decoded.id !== 'string' || decoded.id.length === 0) return undefined
  return { ...payload, id: decoded.id }
}

/**
 * 校验请求是否携带**有效**的宿主浏览器认证 cookie。
 * @returns 载荷（通过）或 undefined（未认证）。返回值只当布尔用。
 */
export function browserAuthPayload(req, secret) {
  if (secret == null) return undefined
  const host = headerOf(req && req.headers, 'host')
  if (host === undefined) return undefined
  const rawCookie = headerOf(req.headers, 'cookie')
  if (rawCookie === undefined) return undefined
  const now = Date.now()
  for (const authority of cookieAuthorityCandidates(host)) {
    const value = cookieValue(rawCookie, AUTH_COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest()))
    if (value === undefined) continue
    const payload = decodeBrowserAuthCookie(value, secret)
    // payload.authority 与产生名字的同一个拼写配对（宿主同样的绑定语义）。
    if (payload === undefined || payload.authority !== authority) continue
    // 宿主 authenticate(:555 附近) 的时效三条；expiresAt-issuedAt 的 maxAge
    // 窗口不复制（host 可配 cookieMaxAgeDays，插件复制会误杀合法长龄 cookie）。
    if (payload.issuedAt > now || payload.expiresAt <= now || payload.expiresAt <= payload.issuedAt) continue
    return payload
  }
  return undefined
}

/**
 * 经 credentials 服务读宿主 BrowserAuth 签名 secret。**唯一读法**：
 * no-op modifyRecord（mutate 返回 undefined = 记录未动、返回 current），
 * 不落盘不经 argv。宿主无该成分 / 记录缺失 / 格式或长度不符 → null。
 * 调用方据此决定老宿主降级还是 fail-closed（有 credentials 服务即后者）。
 * @param {object|undefined} credentials ctx.get("credentials")
 * @returns {Promise<Buffer|null>}
 */
export async function loadBrowserAuthSecret(credentials) {
  if (!credentials || typeof credentials.modifyRecord !== 'function') return null
  let record
  try {
    record = await credentials.modifyRecord(AUTH_RECORD_KEY, async () => undefined)
  } catch {
    return null
  }
  if (record === undefined || record === null || typeof record !== 'object' || record.kind !== 'grant') return null
  const payload = record.payload
  if (!payload || typeof payload !== 'object' || payload.version !== AUTH_STORED_SECRET_VERSION) return null
  if (typeof payload.secret !== 'string') return null
  const secret = decodeBase64Url(payload.secret)
  if (!secret || secret.length !== AUTH_SECRET_BYTES) return null
  return secret
}

// 进程级 memo：secret 一次命中就终身持有（宿主 create 只在缺失时铸新记录，
// 正常进程内不会换代）；探测失败 10s 内不重试，401 风暴不会打爆 credential 锁。
const WEB_AUTH_RETRY_MS = 10_000
let __webAuthSecret = null
let __webAuthProbeAt = 0
let __webAuthProbe = null
let __webAuthWarned = false

/** 测试钩子：直接注入/清除 secret，绕开 credentials 服务。 */
export function _setWebAuthSecret(secret) {
  __webAuthSecret = secret
}
export function _resetWebAuth() {
  __webAuthSecret = null
  __webAuthProbeAt = 0
  __webAuthProbe = null
  __webAuthWarned = false
}

/**
 * 围栏的鉴权半段：取活跃 secret（含单飞探测与 10s 失败 memo）。
 * secret 存在但请求未携有效 cookie → false（路由层回 401）；
 * 无 credentials 服务（老宿主）→ true = 旧围栏；有服务但记录不可读 → false（fail-closed）。
 * @param {object|undefined} ctx 插件 ctx（get("credentials")）
 * @param {object} req http 请求
 */
export async function webAuthGate(ctx, req) {
  if (__webAuthSecret !== null) {
    return browserAuthPayload(req, __webAuthSecret) !== undefined
  }

  let credentials = null
  try {
    credentials = ctx && typeof ctx.get === 'function' ? ctx.get('credentials') : null
  } catch {
    /* legacy ctx */
  }
  if (!credentials || typeof credentials.modifyRecord !== 'function') return true

  const now = Date.now()
  if (__webAuthProbe === null && now - __webAuthProbeAt >= WEB_AUTH_RETRY_MS) {
    __webAuthProbeAt = now
    __webAuthProbe = loadBrowserAuthSecret(credentials)
      .then(secret => {
        __webAuthSecret = secret
        if (secret === null && !__webAuthWarned) {
          __webAuthWarned = true
          console.warn(
            '[message-ops] BrowserAuth cookie 鉴权已启用但 `client-connection/browser-session` 记录不可读' +
              '——GET 鉴权 fail-closed；请检查该记录是否存在',
          )
        }
        return secret
      })
      .finally(() => {
        __webAuthProbe = null
      })
  }

  if (__webAuthProbe === null) return false
  const secret = await __webAuthProbe
  return secret !== null && browserAuthPayload(req, secret) !== undefined
}

// ---------------------------------------------------------------------------
// 0.5.7 · 磁盘路径（lazy-view 会话不进对象层时的回退）
// ---------------------------------------------------------------------------
// store-miss 时**直接向日志追加 zstd 帧**（字段逐项镜像引擎金标准），磁盘会话的
// 视图按帧重读、追加即可见；live 会话仍走引擎路径。复盘见 README「0.5.7」。

/** 事件类型是否为 surface 节点（message 类；step/end、turn/end 等结构性事件不是）。 */
export function isSurfaceMessageType(type) {
  return type === 'user/message' || type === 'assistant/message' || type === 'system/message' || type === 'developer/message'
}

/** 磁盘可见节点：按事件流推导的 message 类 seq（剔除既有遮蔽）。 */
/**
 * 当前 surface 上的**全部**节点（v4 的 5 种 surface 类型），已剔除被遮蔽的。
 *
 * ⚠️ 与 `diskVisibleNodes` 的区别是关键的（0.8.2 实机事故）：
 * `diskVisibleNodes` 只收 4 种**消息**类型（UI 列表用），而 v4 的 surface 还包含
 * `tool/result`。surface replace 的 `sourceEventSeqs` 必须覆盖**被遮蔽的每一个
 * surface 节点**（`foldSurface`：`sourceEventSeqs must include every shadowed
 * surface node`）—— 用消息集合当溯源会漏掉区间内的 tool/result，**整份日志被
 * 加载端拒绝**。这正是历史上 14 个打不开的会话的真正成因（不是区间压缩编码问题）。
 *
 * ── 0.26.0 根因修正 ────────────────────────────────────────────────────────
 * 旧实现用 `computeShadowed` 的**数值区间**语义（`startSeq..endSeq` 里所有 seq
 * 都算被遮蔽），宿主用的是**节点索引**语义（`nodes.indexOf(startSeq)` /
 * `nodes.indexOf(endSeq)` 定位后 `splice`）。两者在「区间内还有别人先遮蔽掉的
 * 节点」时**不等价**：数值语义会连带把早先标记已遮蔽的节点重复算进去，节点序
 * 语义只消费当时仍在表上的节点。
 *
 * 实测（263 份可折叠语料，与安装的 `foldSurface` 逐份对拍）：
 *   - 节点数组与本实现一致：**新 263/263、旧 216/263**（旧实现 47 份分歧）；
 *   - replace 的 `shadowedSeqs`：本实现 263/263 完全一致（0 分歧）；
 *   - 用宿主闸复验回滚目标（每份日志全部可见节点）：**旧实现 13787 个目标里
 *     2495 个被宿主拒绝（18.1%：`start seq not found in surface` 2285、
 *     `node 0 holds the system prompt` 195、`sourceEventSeqs missing shadowed`
 *     15）；新实现 11323 个目标 0 拒绝**。
 *
 * 反向区间（`startSeq > endSeq`，语料 afcc0453 共 9 条 compact-checkpoint）在
 * 宿主是**合法的节点序区间**（索引 start < 索引 end）；节点序实现天然支持，
 * 数值实现只能退回「凭据」近似。故本实现统一走节点序，端点解析不了时才回落
 * 到旧数值口径（损坏/伪造日志不因此炸掉整份读取）。
 *
 * @param {Array} events 全量事件
 * @returns {{ nodes:number[], shadowedByMarker:Map<number,number[]>, bySeq:Map<number,object>, fallbacks:number }}
 */
function foldSurfaceNodes(events) {
  const nodes = []
  const shadowedByMarker = new Map()
  const bySeq = new Map()
  let fallbacks = 0
  const list = Array.isArray(events) ? events : []
  for (const e of list) if (e && Number.isSafeInteger(e.seq)) bySeq.set(e.seq, e)
  for (const e of list) {
    if (!e || !Number.isSafeInteger(e.seq)) continue
    if (!isSurfaceType(e.type)) continue
    const range = readReplaceOp(e)
    if (!range) {
      nodes.push(e.seq)
      continue
    }
    const startIdx = nodes.indexOf(range.startSeq)
    const endIdx = nodes.indexOf(range.endSeq)
    if (startIdx !== -1 && endIdx !== -1 && startIdx <= endIdx) {
      const shadowed = nodes.slice(startIdx, endIdx + 1)
      shadowedByMarker.set(e.seq, shadowed)
      nodes.splice(startIdx, endIdx - startIdx + 1, e.seq)
      continue
    }
    // 端点不在当前节点表上（历史损坏/伪造 marker）：退回旧数值口径，绝不 throw —
    // 读取路径必须能打开日志，规划路径由下面的显式校验（409）负责拒绝。
    fallbacks += 1
    let kept
    if (range.startSeq <= range.endSeq) {
      kept = nodes.filter(q => q < range.startSeq || q > range.endSeq)
    } else {
      const src = Array.isArray(e.sourceEventSeqs) ? e.sourceEventSeqs : []
      const removed = new Set(src.filter(q => Number.isSafeInteger(q)))
      kept = nodes.filter(q => !removed.has(q))
    }
    kept.push(e.seq)
    nodes.length = 0
    nodes.push(...kept)
  }
  return { nodes, shadowedByMarker, bySeq, fallbacks }
}

/**
 * 某个 marker「真正遮蔽了哪些 surface 节点」。
 *
 * 优先级：宿主节点序折叠结果 → `sourceEventSeqs` 凭据 → 旧数值区间。
 * 实测 485 条 replace 中 452 条凭据与宿主遮蔽集**完全相等**、33 条为超集
 * （多为同一 turn 内顺带列出的结构性 seq），**0 条缺失** —— 所以凭据是可靠的
 * 次优来源；数值区间是最后兜底（历史 marker 无凭据时）。
 *
 * @returns {number[]|null} null = 完全无法判定（无区间也无凭据）
 */
function markerShadowedSeqs(events, marker, fold = null) {
  if (!marker) return null
  const state = fold || foldSurfaceNodes(events)
  const known = state.shadowedByMarker.get(marker.seq)
  if (known) return known
  const src = Array.isArray(marker.sourceEventSeqs) ? expandSourceSeqs(marker.sourceEventSeqs) : null
  if (src && src.length > 0) return src.filter(q => q < marker.seq)
  const range = readReplaceOp(marker)
  if (!range || range.startSeq > range.endSeq) return null
  const out = []
  for (let q = range.startSeq; q <= range.endSeq; q += 1) out.push(q)
  return out
}

export function diskSurfaceNodes(events) {
  return foldSurfaceNodes(events).nodes
}

function isSurfaceType(type) {
  return isSurfaceMessageType(type) || type === 'tool/result'
}

export function diskVisibleNodes(events) {
  const state = foldSurfaceNodes(events)
  return state.nodes.filter(seq => {
    const e = state.bySeq.get(seq)
    return e && isSurfaceMessageType(e.type)
  })
}

/**
 * 宿主保护面：surface 节点 0 承载 system prompt。
 *
 * `surface.js` `assertSystemHeadRewrite`（安装版 0.2.0-rc.2，385-394 行）：
 * 当 `startIdx === 0` 且该节点是 `system/message` 时，replace **必须**本身是
 * `system/message` 且只遮蔽那一个节点，否则整份日志被加载端拒绝：
 *   `surface replace: node 0 holds the system prompt and may be rewritten only
 *    by a system/message over exactly that node`
 *
 * 实测：243 份无 compaction 日志里 27 个「可见的头节点」回滚目标，旧规划器
 * **全部放行**（把头节点之后全部遮蔽 = 多节点），宿主**全部拒绝**；在 6112 个
 * 目标上以宿主闸复验，「节点序 + 本护栏」的判定与宿主 0 分歧。
 *
 * @param {Array} surfaceNodes 节点序 surface（已剔除遮蔽）
 * @param {number} startIdx 目标在节点表上的索引
 * @param {number} shadowedCount 本次将遮蔽的节点数
 * @returns {string|null} 拒绝理由；null = 通过
 */
function systemHeadRejection(events, surfaceNodes, startIdx, shadowedCount) {
  if (startIdx !== 0) return null
  const headSeq = surfaceNodes[0]
  const head = (events ?? []).find(e => e && e.seq === headSeq)
  if (!head || head.type !== 'system/message') return null
  if (shadowedCount === 1) return null
  return (
    `surface replace: node 0 holds the system prompt and may be rewritten only by a system/message over exactly that node` +
    `（目标 seq ${headSeq} 是 surface 头节点，回滚它会把系统提示连同后面 ${shadowedCount - 1} 个节点一起遮蔽 —— 宿主会整份拒绝该日志）`
  )
}

/** 磁盘版 planRevert：target 必须可见，遮蔽 target 之后（含）全部可见节点。 */
export function planRevertFromEvents(events, targetSeq) {
  // 0.14.0 护栏：marker 不是对话，不能被回滚（否则产生自噬的空 replace 记录）。
  const targetEvent = (events ?? []).find(e => e && e.seq === targetSeq)
  if (isMarkerEvent(targetEvent)) {
    throw new OpsError(`seq ${targetSeq} is a revert/delete marker, not a message — restore it instead of reverting it`, 409)
  }
  // 一次折叠同时产出「全部 surface 节点」与「message 节点」（旧实现折叠两遍，
  // 大日志上 planRevertFromEvents 实测 141.4 ms，其中一半是白重算）。
  const state = foldSurfaceNodes(events)
  const nodes = state.nodes.filter(seq => {
    const e = state.bySeq.get(seq)
    return e && isSurfaceMessageType(e.type)
  })
  const startIdx = nodes.indexOf(targetSeq)
  if (startIdx === -1) throw new OpsError(`surface replace: start seq ${targetSeq} not found in surface`, 409)
  // 目标用「消息」集合（回滚对象是消息），溯源用「全部 surface」集合（0.8.2 修正）
  const surfaceIdx = state.nodes.indexOf(targetSeq)
  if (surfaceIdx === -1) throw new OpsError(`surface replace: start seq ${targetSeq} not found in surface`, 409)
  const shadowedSeqs = state.nodes.slice(surfaceIdx)
  if (shadowedSeqs.length === 0) throw new OpsError('nothing to revert', 409)
  const headReject = systemHeadRejection(events, state.nodes, surfaceIdx, shadowedSeqs.length)
  if (headReject) throw new OpsError(headReject, 409)
  return { startSeq: targetSeq, endSeq: shadowedSeqs[shadowedSeqs.length - 1], shadowedSeqs }
}

/**
 * 磁盘版 planDelete：单条可见遮蔽。
 *
 * 0.26.0 补齐两道旧实现缺失的护栏（与 `planRevertFromEvents` 对齐）：
 *   1. **marker 不能当删除目标** —— 旧实现只在 revert 侧拦，delete 侧放行；
 *      实测 session-645bd9 的 marker seq 21：`revert` → 409 DENY，`delete`
 *      → **ALLOW**，落定即「遮蔽 marker 自己」的自噬空记录（语料 3424/3658/
 *      3689/3721/3746/7252/7524/7525/7526/8954… 共 51 条空 content marker 就是这么来的）。
 *   2. **节点 0 保护** —— delete 虽是单节点，但若目标就是头节点且头节点是
 *      `system/message`，宿主要求 replace 事件本身必须是 `system/message`
 *      （delete 写的就是 system/message，故单节点头删除**合法**）；这里仍显式
 *      校验以免未来改成别的写法时静默失效。
 */
export function planDeleteFromEvents(events, seq) {
  const targetEvent = (events ?? []).find(e => e && e.seq === seq)
  if (isMarkerEvent(targetEvent)) {
    throw new OpsError(`seq ${seq} is a revert/delete marker, not a message — restore it instead of deleting it`, 409)
  }
  const state = foldSurfaceNodes(events)
  const visible = state.nodes.filter(q => {
    const e = state.bySeq.get(q)
    return e && isSurfaceMessageType(e.type)
  })
  if (!visible.includes(seq) || !state.nodes.includes(seq)) {
    throw new OpsError(`seq ${seq} not visible on current surface`, 409)
  }
  // 单节点遮蔽：溯源就是它自己（0.8.2：也走完整 surface 判定，避免非 surface 节点）
  return { startSeq: seq, endSeq: seq, shadowedSeqs: [seq] }
}

/** 下一个可用 seq（全量事件 max+1；结构性事件也占 seq）。 */
export function nextSeqFrom(events) {
  let max = -1
  for (const e of events) if (e && Number.isSafeInteger(e.seq) && e.seq > max) max = e.seq
  return max + 1
}

/** 磁盘回撤/删除标记事件（字段镜像引擎金标准：type/seq/time/data/sourceEventSeqs/surfaceOp）。 */
export function buildMarkerEvent({ seq, time, turnStep, text, startSeq, endSeq, shadowedSeqs, version = 4 }) {
  const sources = expandSourceSeqs(shadowedSeqs)
  return {
    type: 'system/message',
    seq,
    time,
    data: {
      turn: turnStep.turn,
      step: turnStep.step,
      message: { id: randomUUID(), role: 'system', source: messageSource('system', version), content: [{ type: 'text', text }] },
    },
    sourceEventSeqs: sources,
    surfaceOp: { op: 'replace', startSeq, endSeq },
  }
}

/**
 * 磁盘恢复说明事件（restoresSeq → dock 移除该行；surfaceOp 恒 "append"）。
 *
 * 0.11.4：必须写入 `restoredSourceSeqs`。`restoreProgress` 靠它累计「已重放哪些
 * 源 seq」来算 pending/complete；旧实现只写 `restoresSeq`，于是每次恢复都被判
 * `legacy`（`complete:true` 但 `restoredSeqs` 恒空）→ 进度不可见，且下一轮
 * `excludeSeqs` 为空 → 同一区间被**反复重放**（实测 008f3759 两轮各 209 条）。
 */
export function buildRestoreNoticeEvent({ seq, time, turnStep, text, restoreSeq, discard, restoredSourceSeqs, version = 4 }) {
  const restored = Array.isArray(restoredSourceSeqs) ? [...new Set(restoredSourceSeqs.filter(q => Number.isSafeInteger(q)))] : []
  return {
    type: 'system/message',
    seq,
    time,
    data: {
      turn: turnStep.turn,
      step: turnStep.step,
      message: { id: randomUUID(), role: 'system', source: messageSource('system', version), content: [{ type: 'text', text }] },
      restoresSeq: restoreSeq,
      ...(restored.length > 0 ? { restoredSourceSeqs: restored } : {}),
      ...(discard ? { discarded: true } : {}),
    },
    surfaceOp: 'append',
  }
}

/**
 * 磁盘重放事件（镜像引擎：干净文本无前缀（0.6.0 对齐 opencode）、surfaceOp "append"）。
 *
 * turnStep 由调用方传**打开的** turn/step（index.js 的 `plan.turnStep`，由
 * `requireOpenTurnStep` 校验）。曾经硬编码 {turn:1,step:1} —— 那是同一类事故的
 * "修了一半"版本：notice 用了正确坐标、replay 仍写死 1/1，一旦会话当前打开的
 * turn ≠ 1，`assertReleasedV4Relationships` 报
 * `assistant/message does not match an open turn and step` → **整份日志被拒**，
 * 而 `diskAppend` 是裸 zstd 写、零校验，拦不住。
 */
export function buildReplayEvent({ seq, time, item, turnStep, version = 4 }) {
  const ts =
    turnStep && Number.isSafeInteger(turnStep.turn) && turnStep.turn > 0 && Number.isSafeInteger(turnStep.step) && turnStep.step > 0
      ? turnStep
      : (() => {
          throw new OpsError('buildReplayEvent: 缺少合法的打开 turn/step，拒绝写出注定无法加载的事件', 500)
        })()
  return {
    type: item.type,
    seq,
    time,
    data: replayEventData(item, ts, version),
    surfaceOp: 'append',
  }
}
