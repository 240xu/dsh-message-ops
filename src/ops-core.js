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
// 既有导入面兼容（ops-core 的 messageText/exportMarkdown 调用方不受影响）。
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

export function applySurfaceReplace(session, startSeq, endSeq, sourceEventSeqs, noticeText, turnStep) {
  const ts = turnStep && Number.isSafeInteger(turnStep.turn) && turnStep.turn > 0
    ? turnStep : { turn: 1, step: 1 };
  const data = { turn: ts.turn, step: ts.step, message: { id: randomUUID(), role: "system", content: [{ type: "text", text: noticeText }] } };
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
  return { restoreSeq, startSeq, endSeq, upToSeq: Number.isSafeInteger(upToSeq) ? cap : endSeq, replayable, skipped, turnStep: deriveTurnStep(events) };
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
  const notice = restoreNoticeText(plan);
  // 0.4.2：notice 事件携带 restoresSeq —— dock 据此把被恢复的标记从「活跃回撤」
  // 中移除（对齐 opencode clear 语义：恢复后不再显示为待恢复项）。
  const ts = plan.turnStep && Number.isSafeInteger(plan.turnStep.turn) && plan.turnStep.turn > 0
    ? plan.turnStep : { turn: 1, step: 1 };
  const noticeEvent = session.append(
    "system/message",
    { turn: ts.turn, step: ts.step, message: { id: randomUUID(), role: "system", content: [{ type: "text", text: notice }] }, restoresSeq: plan.restoreSeq, restoredSourceSeqs: plan.replayable.map((i) => i.seq) },
    { surfaceOp: "append" },
  );
  if (noticeEvent && noticeEvent.seq != null) eventSeqs.push(noticeEvent.seq);
  for (const item of plan.replayable) {
    const event = session.append(
      item.type,
      { message: { role: item.role, content: [{ type: "text", text: item.text }] } },
      { surfaceOp: "append" },
    );
    if (event && event.seq != null) eventSeqs.push(event.seq);
  }
  if (flush) {
    try { flush(); } catch { /* flush 失败不回滚已接受的事件 */ }
  }
  return { restoredCount: plan.replayable.length, skipped: plan.skipped, eventSeqs };
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
  for (const n of notices) {
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
    complete: legacy ? true : pending.length === 0,
    legacy,
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

/**
 * exportMarkdown：把到 upToSeq（含）为止的事件流渲染为 Markdown。
 * user/assistant/system 消息按角色小节展开，工具调用折叠为单行引用。
 * @param {object} header 会话 header（readSessionFile）
 * @param {Array} events 全量事件
 * @param {number=} upToSeq 可选上界（含）；缺省导出全部
 */
export function exportMarkdown(header, events, upToSeq) {
  if (upToSeq !== undefined && (!Number.isSafeInteger(upToSeq) || upToSeq < 0)) {
    throw new OpsError("invalid seq", 400);
  }
  const sessionId = header && header.id ? header.id : "unknown";
  const scoped = upToSeq === undefined ? events : events.filter((e) => e && typeof e.seq === "number" && e.seq <= upToSeq);
  const lines = [];
  lines.push(`# DSH 会话导出：${sessionId}`);
  lines.push("");
  lines.push(`- 会话 id：${sessionId}`);
  if (header && header.parentSession) lines.push(`- 来源分支：${header.parentSession}`);
  lines.push(`- 导出范围：${upToSeq === undefined ? "全部" : `seq ≤ ${upToSeq}`}`);
  lines.push(`- 生成时间：${new Date().toISOString()}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  for (const e of scoped) {
    if (!e || typeof e.seq !== "number") continue;
    if (e.type === "user/message" || e.type === "assistant/message" || e.type === "system/message") {
      const role = (e.data && e.data.message && e.data.message.role) ||
        (e.type === "user/message" ? "user" : e.type === "assistant/message" ? "assistant" : "system");
      const text = messageText(e);
      lines.push(`## [seq ${e.seq}] ${role}`);
      lines.push("");
      lines.push(text || "（无文本内容）");
      lines.push("");
    } else if (e.type === "tool/call") {
      const d = e.data || {};
      const name = d.name || (d.call && d.call.name) || "tool";
      const argsHint = d.call && d.call.arguments !== undefined
        ? JSON.stringify(d.call.arguments).slice(0, 80)
        : "";
      lines.push(`> [seq ${e.seq}] 🔧 工具调用：${name}${argsHint ? ` — ${argsHint}` : ""}`);
      lines.push("");
    }
  }
  return lines.join("\n");
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
export function diskVisibleNodes(events) {
  const shadowed = computeShadowed(events);
  const nodes = [];
  for (const e of events) {
    if (!e || !Number.isSafeInteger(e.seq)) continue;
    if (shadowed.has(e.seq)) continue;
    if (isSurfaceMessageType(e.type)) nodes.push(e.seq);
  }
  return nodes;
}

/** 磁盘版 planRevert：target 必须可见，遮蔽 target 之后（含）全部可见节点。 */
export function planRevertFromEvents(events, targetSeq) {
  const nodes = diskVisibleNodes(events);
  const startIdx = nodes.indexOf(targetSeq);
  if (startIdx === -1) throw new OpsError(`surface replace: start seq ${targetSeq} not found in surface`, 409);
  const shadowedSeqs = nodes.slice(startIdx);
  if (shadowedSeqs.length === 0) throw new OpsError("nothing to revert", 409);
  return { startSeq: targetSeq, endSeq: shadowedSeqs[shadowedSeqs.length - 1], shadowedSeqs };
}

/** 磁盘版 planDelete：单条可见遮蔽。 */
export function planDeleteFromEvents(events, seq) {
  if (!diskVisibleNodes(events).includes(seq)) {
    throw new OpsError(`seq ${seq} not visible on current surface`, 409);
  }
  return { startSeq: seq, endSeq: seq, shadowedSeqs: [seq] };
}

/** 下一个可用 seq（全量事件 max+1；结构性事件也占 seq）。 */
export function nextSeqFrom(events) {
  let max = -1;
  for (const e of events) if (e && Number.isSafeInteger(e.seq) && e.seq > max) max = e.seq;
  return max + 1;
}

/** 磁盘回撤/删除标记事件（字段镜像引擎金标准：type/seq/time/data/sourceEventSeqs/surfaceOp）。 */
export function buildMarkerEvent({ seq, time, turnStep, text, startSeq, endSeq, shadowedSeqs }) {
  return {
    type: "system/message",
    seq,
    time,
    data: {
      turn: turnStep.turn,
      step: turnStep.step,
      message: { id: randomUUID(), role: "system", content: [{ type: "text", text }] },
    },
    sourceEventSeqs: [...shadowedSeqs],
    surfaceOp: { op: "replace", startSeq, endSeq },
  };
}

/** 磁盘恢复说明事件（restoresSeq → dock 移除该行；surfaceOp 恒 "append"）。 */
export function buildRestoreNoticeEvent({ seq, time, turnStep, text, restoreSeq }) {
  return {
    type: "system/message",
    seq,
    time,
    data: {
      turn: turnStep.turn,
      step: turnStep.step,
      message: { id: randomUUID(), role: "system", content: [{ type: "text", text }] },
      restoresSeq: restoreSeq,
    },
    surfaceOp: "append",
  };
}

/** 磁盘重放事件（镜像引擎：无 id、干净文本无前缀（0.6.0 对齐 opencode）、surfaceOp "append"）。 */
export function buildReplayEvent({ seq, time, item }) {
  return {
    type: item.type,
    seq,
    time,
    data: { message: { role: item.role, content: [{ type: "text", text: item.text }] } },
    surfaceOp: "append",
  };
}
