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
 *     user/assistant 消息文本重新 append 为新事件（文本加 [恢复] 前缀），
 *     而不是取消遮蔽。语义差异见 README。
 * @module dsh-message-ops/ops-core
 */

/** 带语义状态码的操作错误（HTTP 直接映射，工具端转为失败文本）。 */
export class OpsError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** 从 message 事件提取首个非空 text 块（与 listMessages 同一规则）。 */
export function messageText(e) {
  const msg = e && e.data && e.data.message;
  const content = msg && Array.isArray(msg.content) ? msg.content : (e && e.data && e.data.content);
  if (!Array.isArray(content)) return "";
  for (const c of content) {
    if (c && c.type === "text" && typeof c.text === "string" && c.text.trim()) return c.text;
  }
  return "";
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

/**
 * surface replace 落定：append 一条承载 replace 的 system/message。
 * sourceEventSeqs 必须覆盖被遮蔽的全部 surface 节点（引擎
 * assertProvenance 强校验，缺失即抛错）。
 */
export function applySurfaceReplace(session, startSeq, endSeq, sourceEventSeqs, noticeText) {
  return session.append(
    "system/message",
    { message: { role: "system", content: [{ type: "text", text: noticeText }] } },
    { surfaceOp: { op: "replace", startSeq, endSeq }, sourceEventSeqs },
  );
}

/**
 * planRestore：从磁盘事件流规划「回滚恢复」。
 *
 * @param {Array} events 磁盘全量事件（readSessionFile 的返回）
 * @param {number} restoreSeq 一次 revert/delete 落定的 system/message 事件的
 *   seq（其 surfaceOp 为 replace、sourceEventSeqs 记录了被遮蔽节点）
 */
export function planRestore(events, restoreSeq) {
  if (!Array.isArray(events)) throw new OpsError("restore: events must be an array", 500);
  if (!Number.isSafeInteger(restoreSeq) || restoreSeq < 0) throw new OpsError("invalid seq", 400);
  const ev = events.find((e) => e && e.seq === restoreSeq);
  if (!ev) throw new OpsError(`restore: event seq ${restoreSeq} not found in log`, 404);
  const op = ev.surfaceOp;
  if (!op || typeof op !== "object" || op.op !== "replace") {
    throw new OpsError(`restore: seq ${restoreSeq} is not a revert/delete marker event (no replace surfaceOp)`, 409);
  }
  // 读取端兼容两种拼写：运行时 startSeq/endSeq（当前）与 start/end（dsh-src 较新副本）。
  const startSeq = Number.isSafeInteger(op.startSeq) ? op.startSeq : op.start;
  const endSeq = Number.isSafeInteger(op.endSeq) ? op.endSeq : op.end;
  if (!Number.isSafeInteger(startSeq) || !Number.isSafeInteger(endSeq)) {
    throw new OpsError(`restore: seq ${restoreSeq} carries a malformed replace surfaceOp`, 409);
  }
  const replayable = [];
  let skipped = 0;
  for (const e of events) {
    if (!e || typeof e.seq !== "number" || e.seq < startSeq || e.seq > endSeq) continue;
    if (e.type === "user/message" || e.type === "assistant/message") {
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
  if (replayable.length === 0) {
    throw new OpsError(`restore: no replayable user/assistant messages in shadowed range ${startSeq}..${endSeq}`, 409);
  }
  return { restoreSeq, startSeq, endSeq, replayable, skipped };
}

/**
 * applyRestore：把 planRestore 的重放计划落定到 live session。
 * 引擎不支持取消遮蔽（SurfaceOp 无该变体），故实现为重放：
 * 每条消息以原类型 append、文本加 [恢复] 前缀；先 append 一条 system 说明。
 */
export function applyRestore(session, plan, { flush } = {}) {
  const eventSeqs = [];
  const notice = `[消息恢复] 重放 seq ${plan.startSeq}..${plan.endSeq} 的 ${plan.replayable.length} 条消息` +
    (plan.skipped > 0 ? `（另有 ${plan.skipped} 条不可重放事件已跳过）` : "") +
    `；原区间仍处于遮蔽状态，恢复为重放而非解除遮蔽`;
  const noticeEvent = session.append(
    "system/message",
    { message: { role: "system", content: [{ type: "text", text: notice }] } },
    { surfaceOp: "append" },
  );
  if (noticeEvent && noticeEvent.seq != null) eventSeqs.push(noticeEvent.seq);
  for (const item of plan.replayable) {
    const event = session.append(
      item.type,
      { message: { role: item.role, content: [{ type: "text", text: `[恢复] ${item.text}` }] } },
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
