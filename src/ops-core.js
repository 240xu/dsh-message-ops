import { randomUUID } from "node:crypto";
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

import { readReplaceOp, messageText, computeShadowed } from "./session-file.js";

// messageText 的单点实现在 session-file.js（listMessages 同用）；此处转出保持
// 既有导入面兼容（ops-core 的 messageText 调用方不受影响）。
export { messageText };

/** 带语义状态码的操作错误（HTTP 直接映射，工具端转为失败文本）。 */
export class OpsError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** planRevert：回撤语义 = 遮蔽 targetSeq 及其之后全部可见节点（连续到末尾）。 */
export function planRevert(surface, targetSeq) {
  const nodes = surface && Array.isArray(surface.nodes) ? surface.nodes : [];
  const startIdx = nodes.indexOf(targetSeq);
  if (startIdx === -1) throw new OpsError(`surface replace: start seq ${targetSeq} not found in surface`, 409);
  const shadowedSeqs = nodes.slice(startIdx);
  if (shadowedSeqs.length === 0) throw new OpsError("nothing to revert", 409);
  return {
    startSeq: targetSeq,
    endSeq: shadowedSeqs[shadowedSeqs.length - 1],
    shadowedSeqs,
  };
}

/** planDelete：单条遮蔽，要求 seq 仍在当前 surface 上可见。 */
export function planDelete(surface, seq) {
  const nodes = surface && Array.isArray(surface.nodes) ? surface.nodes : [];
  if (!nodes.includes(seq)) throw new OpsError(`seq ${seq} not visible on current surface`, 409);
  return { startSeq: seq, endSeq: seq, shadowedSeqs: [seq] };
}

// 写端 replace 拼写（前向兼容雷，评审 P1）：当前运行时引擎
// （@deepseek-ai/dsh-session/lib/types/surface.js 的 isReplaceOp）要求
// {op:'replace', startSeq, endSeq} 且恰好 3 个键；dsh-src 较新副本已改名
// {op:'replace', start, end}（同样恰好 3 个键）。写端做一次运行时探测：
// 先按当前 cohort 的 startSeq/endSeq 形状写，若引擎报
// "invalid replace surfaceOp"（validateNext 在事件入 log 前抛出，失败不落
// 状态、无半写风险），降级用 {start,end} 重试一次并记住结果。读端
// （readReplaceOp/computeShadowed/planRestore）两种拼写始终兼容。
let replaceShape = null; // null=未探测 | "legacy"=startSeq/endSeq | "new"=start/end

function replaceOpFor(shape, startSeq, endSeq) {
  return shape === "new"
    ? { op: "replace", start: startSeq, end: endSeq }
    : { op: "replace", startSeq, endSeq };
}

/** 测试专用：重置写端拼写探测缓存。 */
export function _resetReplaceShape() { replaceShape = null; }

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
const PLUGIN_NAME = "@240xu/dsh-message-ops";
const PRODUCER_KIND = `plugin:${PLUGIN_NAME}`; // 迁移后的 v4 形态

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
  const r = role ?? "system";
  // ⚠️ role=system 只能写 "system-prompt"：Session 运行时层（dsh-session/lib/index.js:1206）
  // 对 `system/message` 要求 kind **严格等于** "system-prompt"，比 v4 格式闸更严，
  // 任何 producer-owned kind（含 plugin:<name>）都会被加载端拒���：
  //   `session event at seq N message must have system-prompt source`
  if (r === "system") return { kind: "system-prompt" };
  if (version === 4) return { kind: PRODUCER_KIND, role: r };
  return { kind: "plugin", plugin: PLUGIN_NAME, role: r };
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
  if (item.type === "user/message") {
    return {
      id: item.id ?? randomUUID(),
      role: "user",
      source: messageSource("user", version),
      content: [{ type: "text", text: item.text }],
    };
  }
  if (!ts || !Number.isSafeInteger(ts.turn) || ts.turn <= 0 || !Number.isSafeInteger(ts.step) || ts.step <= 0) {
    throw new OpsError("replayEventData: assistant/message 需要打开的 turn/step，拒绝写出注定无法加载的事件", 500);
  }
  return {
    turn: ts.turn,
    step: ts.step,
    message: {
      id: item.id ?? randomUUID(),
      role: "assistant",
      source: messageSource("assistant", version),
      content: [{ type: "text", text: item.text }],
    },
  };
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
      const d = events[i] && events[i].data;
      if (d && Number.isSafeInteger(d.turn) && d.turn > 0 && Number.isSafeInteger(d.step) && d.step > 0) {
        return { turn: d.turn, step: d.step };
      }
    }
  }
  return { turn: 1, step: 1 };
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
export function planNoticeWindow(events) {
  let turn = null, step = null, maxTurn = 0;
  for (const e of events ?? []) {
    const d = e?.data;
    if (Number.isSafeInteger(d?.turn) && d.turn > maxTurn) maxTurn = d.turn;
    switch (e?.type) {
      case "turn/start": turn = d?.turn ?? null; step = null; break;
      case "step/start": step = d?.step ?? null; break;
      case "step/end": step = null; break;
      case "turn/end": turn = null; step = null; break;
      default: break;
    }
  }
  // 会话正开着 turn+step（例如上一轮被中断）→ 直接用现成窗口，不造合成 turn
  if (turn !== null && step !== null) return { synthetic: false, turn, step };
  const nextTurn = maxTurn + 1;
  return { synthetic: true, turn: nextTurn, step: 1 };
}

/** 合成窗口的前缀事件（seq/time 由调用方分配）。 */
export function noticeWindowPreamble(win) {
  if (!win.synthetic) return [];
  return [
    { kind: "turn/start", data: { turn: win.turn, reason: "message-ops" } },
    { kind: "step/start", data: { turn: win.turn, step: win.step } },
  ];
}

/** 合成窗口的后缀事件。 */
export function noticeWindowPostamble(win) {
  if (!win.synthetic) return [];
  return [
    { kind: "step/end", data: { turn: win.turn, step: win.step } },
    // ⚠️ turn/end.data.reason 是**必填契约**（types.d.ts:271-276），引擎自己也这么写
    // （dsh-session/lib/index.js:783-786）。UI 的 trajectory 装配器无防护地读
    // `match.event.data.reason.kind`（dsh-client-ui-trajectory/lib/client.js:997-998）
    // → 缺字段会让整个会话页白屏（ConversationNodeAssembler.replayContext 抛 TypeError）。
    // kind 选 "interrupted"：语义上就是"非模型驱动的 turn"（引擎用它标记被打断的轮次）。
    { kind: "turn/end", data: { turn: win.turn, reason: { kind: "interrupted" } } },
  ];
}

export function applySurfaceReplace(session, startSeq, endSeq, sourceEventSeqs, noticeText, turnStep) {
  const ts = turnStep && Number.isSafeInteger(turnStep.turn) && turnStep.turn > 0
    ? turnStep : { turn: 1, step: 1 };
  const data = { turn: ts.turn, step: ts.step, message: { id: randomUUID(), role: "system", source: messageSource("system", 4), content: [{ type: "text", text: noticeText }] } };
  if (replaceShape) {
    return session.append("system/message", data, { surfaceOp: replaceOpFor(replaceShape, startSeq, endSeq), sourceEventSeqs });
  }
  try {
    const event = session.append("system/message", data, { surfaceOp: replaceOpFor("legacy", startSeq, endSeq), sourceEventSeqs });
    replaceShape = "legacy";
    return event;
  } catch (err) {
    if (!/invalid replace surfaceOp/.test(String(err && err.message))) throw err;
    const event = session.append("system/message", data, { surfaceOp: replaceOpFor("new", startSeq, endSeq), sourceEventSeqs });
    replaceShape = "new";
    return event;
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
  if (!Array.isArray(events)) throw new OpsError("restore: events must be an array", 500);
  if (!Number.isSafeInteger(restoreSeq) || restoreSeq < 0) throw new OpsError("invalid seq", 400);
  const ev = events.find((e) => e && e.seq === restoreSeq);
  if (!ev) throw new OpsError(`restore: event seq ${restoreSeq} not found in log`, 404);
  // 读取端拼写统一走 session-file 的 readReplaceOp（双拼写兼容的单点）。
  const range = readReplaceOp(ev);
  if (!range) {
    throw new OpsError(`restore: seq ${restoreSeq} is not a revert/delete marker event (no well-formed replace surfaceOp)`, 409);
  }
  const { startSeq, endSeq } = range;
  // 0.8.0 按轮步进：upToSeq 给定则只重放到该 seq（含），后续仍保持遮蔽；
  // excludeSeqs = 已重放过（先前轮次 notice 的 restoredSourceSeqs 并集），
  // **必须排除，否则每轮都从区间头重放 → 消息副本刷屏**（0.8.0 实测 B1）。
  const cap = Number.isSafeInteger(upToSeq) ? Math.min(upToSeq, endSeq) : endSeq;
  const excluded = Array.isArray(excludeSeqs) ? new Set(excludeSeqs.filter((q) => Number.isSafeInteger(q))) : null;
  const replayable = [];
  let skipped = 0;
  for (const e of events) {
    if (!e || typeof e.seq !== "number" || e.seq < startSeq || e.seq > cap) continue;
    if (e.type === "user/message" || e.type === "assistant/message") {
      if (excluded && excluded.has(e.seq)) continue;
      const text = messageText(e);
      if (!text.trim()) { skipped++; continue; }
      replayable.push({
        seq: e.seq,
        type: e.type,
        role: e.type === "user/message" ? "user" : "assistant",
        text,
      });
    } else {
      skipped++; // tool/call 等不可安全重放的事件：跳过并在结果里计数
    }
  }
  // 0.5.6：区间无可重放消息（如只遮蔽了 tool/system 事件）不再 409 ——
  // dock 会为这类标记常驻显示恢复按钮，409 死按钮 = 永远清不掉（实测 8 连 409）。
  // 改为返回空计划：applyRestore 仍追加说明 notice（含 restoresSeq）→ 标记停用、
  // dock 计数递减；语义如实：0 条重放 + 文案说明区间无 user/assistant 内容。
  return { restoreSeq, startSeq, endSeq, upToSeq: Number.isSafeInteger(upToSeq) ? cap : endSeq, replayable, skipped };
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
    : `[消息恢复] 重放 seq ${plan.startSeq}..${(plan.upToSeq != null ? plan.upToSeq : plan.endSeq)} 的 ${plan.replayable.length} 条消息` +
      (plan.upToSeq != null && plan.upToSeq < plan.endSeq ? `（按轮步进：seq ${plan.upToSeq + 1}..${plan.endSeq} 仍遮蔽）` : "") +
      (plan.skipped > 0 ? `（另有 ${plan.skipped} 条不可重放事件已跳过）` : "") +
      `；原区间仍处于遮蔽状态，恢复为重放而非解除遮蔽`;
}

export function applyRestore(session, plan, { flush } = {}) {
  const eventSeqs = [];
  const notice = plan.discard
    ? `[消息操作] 回撤标记 seq ${plan.restoreSeq} 已停用（丢弃）：区间内容保持遮蔽、未重放；日志原文仍在，可搜索`
    : restoreNoticeText(plan);
  // 0.4.2：notice 事件携带 restoresSeq —— dock 据此把被恢复的标记从「活跃回撤」
  // 中移除（对齐 opencode clear 语义：恢复后不再显示为待恢复项）。
  const ts = plan.turnStep && Number.isSafeInteger(plan.turnStep.turn) && plan.turnStep.turn > 0
    ? plan.turnStep : { turn: 1, step: 1 };
  const noticeEvent = session.append(
    "system/message",
    { turn: ts.turn, step: ts.step, message: { id: randomUUID(), role: "system", source: messageSource("system", 4), content: [{ type: "text", text: notice }] }, restoresSeq: plan.restoreSeq, restoredSourceSeqs: plan.discard ? [] : plan.replayable.map((i) => i.seq), ...(plan.discard ? { discarded: true } : {}) },
    { surfaceOp: "append" },
  );
  if (noticeEvent && noticeEvent.seq != null) eventSeqs.push(noticeEvent.seq);
  for (const item of plan.discard ? [] : plan.replayable) {
    const event = session.append(
      item.type,
      replayEventData(item, ts),
      { surfaceOp: "append" },
    );
    if (event && event.seq != null) eventSeqs.push(event.seq);
  }
  if (flush) {
    try { flush(); } catch { /* flush 失败不回滚已接受的事件 */ }
  }
  return { restoredCount: plan.discard ? 0 : plan.replayable.length, skipped: plan.skipped, eventSeqs };
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
export function restoreProgress(events, markerSeq) {
  const list = Array.isArray(events) ? events : [];
  const marker = list.find((e) => e && e.seq === markerSeq);
  if (!marker) return null;
  const range = readReplaceOp(marker);
  if (!range) return null;
  const { startSeq, endSeq } = range;
  // 该区间内可重放的消息型事件
  const candidates = [];
  for (const e of list) {
    if (!e || typeof e.seq !== "number" || e.seq < startSeq || e.seq > endSeq) continue;
    if (e.type !== "user/message" && e.type !== "assistant/message") continue;
    if (!(messageText(e) || "").trim()) continue;
    candidates.push(e.seq);
  }
  // 收集针对该标记的所有恢复 notice
  const notices = list.filter((e) => e && e.data && e.data.restoresSeq === markerSeq);
  const restored = new Set();
  let legacy = false;
  let discarded = false;
  for (const n of notices) {
    // 0.8.1：显式丢弃（不重放内容、仅停用标记）也算完成——
    // 用户场景"我都没回滚过，清掉测试遗留条"，2709 条重放是另一种污染。
    if (n.data.discarded === true) { discarded = true; continue; }
    const seqs = n.data && Array.isArray(n.data.restoredSourceSeqs) ? n.data.restoredSourceSeqs : null;
    if (!seqs) { legacy = true; continue; }
    for (const q of seqs) if (Number.isSafeInteger(q)) restored.add(q);
  }
  const pending = candidates.filter((q) => !restored.has(q));
  return {
    startSeq,
    endSeq,
    restoredSeqs: Array.from(restored).sort((a, b) => a - b),
    pendingSeqs: pending,
    complete: legacy || discarded ? true : pending.length === 0,
    legacy,
    discarded,
  };
}

/**
 * 0.8.0：贴条按行展示用 —— 列出该标记仍未重放的「轮」（一个 user 消息及其后
 * 到下一个 user 之前的 assistant 回复算一轮，对齐 opencode 按轮步进恢复）。
 *
 * @returns {Array<{ turnSeq:number, seqs:number[] }>} 按 seq 升序
 */
export function pendingRestoreTurns(events, markerSeq) {
  const prog = restoreProgress(events, markerSeq);
  if (!prog || prog.pendingSeqs.length === 0) return [];
  const list = Array.isArray(events) ? events : [];
  const bySeq = new Map();
  for (const e of list) if (e && typeof e.seq === "number") bySeq.set(e.seq, e);
  const turns = [];
  let current = null;
  for (const q of prog.pendingSeqs) {
    const e = bySeq.get(q);
    if (!e) continue;
    if (e.type === "user/message") { current = { turnSeq: q, seqs: [q] }; turns.push(current) }
    else if (current) current.seqs.push(q);
    else turns.push({ turnSeq: q, seqs: [q] }); // 孤立 assistant（无前导 user）
  }
  return turns;
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
  const value = headers && headers[name];
  return typeof value === "string" ? value : undefined;
}

function parseAuthority(authority) {
  try { return new URL(`http://${authority}`); } catch { return undefined; }
}

function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** 与 slv-check 同款的信任判定（回环 Host + 非 cross-site + Origin 同源）。 */
export function isTrustedApiRequest(req) {
  const host = headerOf(req && req.headers, "host");
  if (host === undefined) return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === undefined) return false;
  if (!isLoopbackHostname(hostUrl.hostname)) return false;
  if (headerOf(req.headers, "sec-fetch-site") === "cross-site") return false;
  const origin = headerOf(req.headers, "origin");
  if (origin === undefined) return true;
  try { return new URL(origin).host === hostUrl.host; } catch { return false; }
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
  const ct = headerOf(req && req.headers, "content-type") || "";
  return ct.split(";")[0].trim().toLowerCase() === "application/json";
}

// ---------------------------------------------------------------------------
// 0.3.0 用户 UI 回撤体系：分支双路径 feature-detect（纯函数，client 与测试共用）
// ---------------------------------------------------------------------------

/**
 * 分支双路径判定：0.2.0+ 的官方 sessions.fork({sessionId, atSeq})（原生 fork、
 * 子会话进宿主列表）优先；0.1.x / fork 缺席 / 调用失败回退本插件磁盘
 * applyBranch（写盘后需刷新列表才可见）。
 * @param {object=} svc ctx.get('sessions') 服务（0.1.x/0.2.0 形状均可）
 * @returns {{kind:'official', fork:(opts:object)=>Promise<string>} | {kind:'disk'}}
 */
export function pickForkPath(svc) {
  if (svc && typeof svc.fork === "function") {
    return { kind: "official", fork: (opts) => svc.fork(opts) };
  }
  return { kind: "disk" };
}

/**
 * messageId → seq 索引（0.2.0 assistant-actions 槽 ownerProps 只给 messageId；
 * seq 由 messages 列表反查）。同 id 多条取最小 seq（重试链取最早可见节点）。
 * @param {Array<{seq:number, id?:string|null}>} messages listMessages 输出
 * @returns {Map<string, number>}
 */
export function buildSeqIndex(messages) {
  const map = new Map();
  for (const m of messages || []) {
    if (!m || typeof m.seq !== "number" || !m.id) continue;
    const prev = map.get(m.id);
    if (prev === undefined || m.seq < prev) map.set(m.id, m.seq);
  }
  return map;
}

// ---------------------------------------------------------------------------
// 0.5.7 · 磁盘路径（lazy-view 会话不进对象层时的回退）
// ---------------------------------------------------------------------------
// 实机第四层根因：视图打开 ≠ 对象层有会话（lazy-view 只读盘渲染）。官方服务端
// 没有 retain/using 面，故 store-miss 时改为**直接向日志追加 zstd 帧**——与
// 持久层 JsonlSessionPersistence.appendLines 等价（encode → open('a') →
// write+sync+失败回滚），事件字段逐项镜像引擎写出的金标准（见 README0.5.7）。
// 磁盘会话的视图本来就按帧重读，追加即可见；live 会话仍走引擎路径。

/** 事件类型是否为 surface 节点（message 类；step/end、turn/end 等结构性事件不是）。 */
export function isSurfaceMessageType(type) {
  return type === "user/message" || type === "assistant/message"
    || type === "system/message" || type === "developer/message";
}

/** 磁盘可见节点：按事件流推导的 message 类 seq（剔除既有遮蔽）。 */
/**
 * 当前 surface 上的**全部**节点（v4 的 5 种 surface 类型），已剔除被遮蔽的。
 *
 * ⚠️ 与 `diskVisibleNodes` 的区别是关键的（0.8.2 实机事故）：
 * `diskVisibleNodes` 只收 4 种**消息**类型（UI 列表用），而 v4 的 surface 还包含
 * `tool/result`。surface replace 的 `sourceEventSeqs` 必须覆盖**被遮蔽的每一个
 * surface 节点**（`foldSurface`：`if (removed.some(s => !sources.includes(s))) throw
 * "replacement sourceEventSeqs omit a shadowed surface node"`）—— 用消息集合当溯源
 * 会漏掉区间内的 tool/result，**整份日志被加载端拒绝**。这正是历史上 14 个打不开的
 * 会话的真正成因（不是区间压缩编码问题）。
 */
export function diskSurfaceNodes(events) {
  const shadowed = computeShadowed(events);
  const nodes = [];
  for (const e of events) {
    if (!e || !Number.isSafeInteger(e.seq)) continue;
    if (shadowed.has(e.seq)) continue;
    if (isSurfaceType(e.type)) nodes.push(e.seq);
  }
  return nodes;
}

function isSurfaceType(type) {
  return isSurfaceMessageType(type) || type === "tool/result";
}

export function diskVisibleNodes(events) {
  return diskSurfaceNodes(events).filter((seq) => {
    const e = events.find((x) => x && x.seq === seq);
    return e && isSurfaceMessageType(e.type);
  });
}

/** 磁盘版 planRevert：target 必须可见，遮蔽 target 之后（含）全部可见节点。 */
export function planRevertFromEvents(events, targetSeq) {
  // 目标用「消息」集合（回滚对象是消息），溯源用「全部 surface」集合（0.8.2 修正）
  const nodes = diskVisibleNodes(events);
  const startIdx = nodes.indexOf(targetSeq);
  if (startIdx === -1) throw new OpsError(`surface replace: start seq ${targetSeq} not found in surface`, 409);
  const surface = diskSurfaceNodes(events);
  const shadowedSeqs = surface.slice(surface.indexOf(targetSeq));
  if (shadowedSeqs.length === 0) throw new OpsError("nothing to revert", 409);
  return { startSeq: targetSeq, endSeq: shadowedSeqs[shadowedSeqs.length - 1], shadowedSeqs };
}

/** 磁盘版 planDelete：单条可见遮蔽。 */
export function planDeleteFromEvents(events, seq) {
  const surface = diskSurfaceNodes(events);
  if (!diskVisibleNodes(events).includes(seq) || !surface.includes(seq)) {
    throw new OpsError(`seq ${seq} not visible on current surface`, 409);
  }
  // 单节点遮蔽：溯源就是它自己（0.8.2：也走完整 surface 判定，避免非 surface 节点）
  return { startSeq: seq, endSeq: seq, shadowedSeqs: [seq] };
}

/** 下一个可用 seq（全量事件 max+1；结构性事件也占 seq）。 */
export function nextSeqFrom(events) {
  let max = -1;
  for (const e of events) if (e && Number.isSafeInteger(e.seq) && e.seq > max) max = e.seq;
  return max + 1;
}

/** 磁盘回撤/删除标记事件（字段镜像引擎金标准：type/seq/time/data/sourceEventSeqs/surfaceOp）。 */
export function buildMarkerEvent({ seq, time, turnStep, text, startSeq, endSeq, shadowedSeqs, version = 4 }) {
  return {
    type: "system/message",
    seq,
    time,
    data: {
      turn: turnStep.turn,
      step: turnStep.step,
      message: { id: randomUUID(), role: "system", source: messageSource("system", version), content: [{ type: "text", text }] },
    },
    sourceEventSeqs: [...shadowedSeqs],
    surfaceOp: { op: "replace", startSeq, endSeq },
  };
}

/** 磁盘恢复说明事件（restoresSeq → dock 移除该行；surfaceOp 恒 "append"）。 */
export function buildRestoreNoticeEvent({ seq, time, turnStep, text, restoreSeq, discard, version = 4 }) {
  return {
    type: "system/message",
    seq,
    time,
    data: {
      turn: turnStep.turn,
      step: turnStep.step,
      message: { id: randomUUID(), role: "system", source: messageSource("system", version), content: [{ type: "text", text }] },
      restoresSeq: restoreSeq,
      ...(discard ? { discarded: true } : {}),
    },
    surfaceOp: "append",
  };
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
  const ts = turnStep && Number.isSafeInteger(turnStep.turn) && turnStep.turn > 0
    && Number.isSafeInteger(turnStep.step) && turnStep.step > 0
    ? turnStep
    : (() => { throw new OpsError("buildReplayEvent: 缺少合法的打开 turn/step，拒绝写出注定无法加载的事件", 500); })();
  return {
    type: item.type,
    seq,
    time,
    data: replayEventData(item, ts, version),
    surfaceOp: "append",
  };
}
