/**
 * dsh-message-ops 服务端：消息回滚 / 消息删除 / 消息分支 的 HTTP 路由。
 *
 * 三操作一条龙（同名插件，一个注入点）：
 *   POST /api/message-ops/revert   回滚：surface replace 遮蔽 targetSeq..末尾
 *   POST /api/message-ops/delete   删除：surface replace 遮蔽单条 seq
 *   POST /api/message-ops/branch   分支：磁盘级 fork（新会话，parentSession 关联）
 *   GET  /api/message-ops/messages 消息列表（磁盘真相 + 可见性标注）
 *
 * 回滚/删除走 DSH 原生 surface replace（append-only，日志完整可恢复；
 * 约束由引擎 assertProvenance 校验，违规如实上报 409）。
 * 运行中的会话一律拒绝（409），由用户先停止再操作。
 * @module dsh-message-ops
 */

import { isSessionId, sessionIdVariants, findSessionDirs, readSessionFile, listMessages, computeShadowed } from "./session-file.js";
import { applyBranch } from "./branch.js";

export const name = "dsh-message-ops";
export const inject = [];

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { return null; }
}

/** 从 sessions 注册表解析（两种 id 拼写都试）。 */
function resolveSession(ctx, sessionId) {
  const sessions = ctx.get("sessions");
  if (!sessions || typeof sessions.get !== "function") return undefined;
  for (const variant of sessionIdVariants(sessionId)) {
    const s = sessions.get(variant);
    if (s !== undefined) return s;
  }
  return undefined;
}

/** 是否有 live agent 正占用该会话。 */
function isRunning(ctx, sessionId) {
  const agents = ctx.get("agents");
  if (!agents || typeof agents.get !== "function") return false;
  try {
    for (const variant of sessionIdVariants(sessionId)) {
      if (agents.get(variant)) return true;
    }
  } catch { /* registry absent: treat as idle */ }
  return false;
}

/** planRevert：回撤语义 = 遮蔽 targetSeq 及其之后全部可见节点（连续到末尾）。 */
function planRevert(surface, targetSeq) {
  const nodes = surface && Array.isArray(surface.nodes) ? surface.nodes : [];
  const startIdx = nodes.indexOf(targetSeq);
  if (startIdx === -1) throw new Error(`surface replace: start seq ${targetSeq} not found in surface`);
  const shadowedSeqs = nodes.slice(startIdx);
  if (shadowedSeqs.length === 0) throw new Error("nothing to revert");
  return {
    startSeq: targetSeq,
    endSeq: shadowedSeqs[shadowedSeqs.length - 1],
    shadowedSeqs,
  };
}

/** surface replace 落定：append 一条承载 replace 的 system/message。 */
function applySurfaceReplace(session, startSeq, endSeq, sourceEventSeqs, noticeText) {
  return session.append(
    "system/message",
    { message: { role: "system", content: [{ type: "text", text: noticeText }] } },
    { surfaceOp: { op: "replace", startSeq, endSeq }, sourceEventSeqs },
  );
}

export function apply(ctx) {
  function registerHttp(host, targetCtx) {
    // --- GET /api/message-ops/messages：消息列表（只读） ---------------------
    targetCtx.effect(() => host.register({
      kind: "exact",
      path: "/api/message-ops/messages",
      handler: async (req, res) => {
        const url = new URL(req.url, "http://localhost");
        const sessionId = url.searchParams.get("sessionId") || "";
        if (!isSessionId(sessionId)) return sendJson(res, 400, { ok: false, error: "invalid sessionId" });
        const dirs = findSessionDirs(sessionId);
        if (dirs.length === 0) return sendJson(res, 404, { ok: false, error: "session log not found" });
        try {
          const { header, events } = readSessionFile(dirs[0].logPath);
          const messages = listMessages(events);
          const shadowed = computeShadowed(events);
          const live = resolveSession(targetCtx, sessionId);
          const visibleNodes = live && live.surface && Array.isArray(live.surface.nodes) ? new Set(live.surface.nodes) : null;
          let visibleCount = 0;
          for (const m of messages) {
            m.visible = visibleNodes ? visibleNodes.has(m.seq) : !shadowed.has(m.seq);
            if (m.visible) visibleCount++;
          }
          return sendJson(res, 200, {
            ok: true,
            session: { id: header.id, createdAt: header.createdAt, parentSession: header.parentSession ?? null },
            running: isRunning(targetCtx, sessionId),
            total: messages.length,
            visibleCount,
            messages,
          });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
        }
      },
    }), "dsh-message-ops: messages route");

    // --- POST revert / delete：live-session surface replace ------------------
    const commitHandler = (mode) => async (req, res) => {
      if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method not allowed" });
      const body = await readJsonBody(req);
      if (!body) return sendJson(res, 400, { ok: false, error: "invalid json" });
      const { sessionId, seq } = body;
      if (!isSessionId(sessionId)) return sendJson(res, 400, { ok: false, error: "invalid sessionId" });
      if (!Number.isSafeInteger(seq) || seq < 0) return sendJson(res, 400, { ok: false, error: "invalid seq" });
      if (isRunning(targetCtx, sessionId)) {
        return sendJson(res, 409, { ok: false, error: "session is running; stop it first" });
      }
      const session = resolveSession(targetCtx, sessionId);
      if (session === undefined) return sendJson(res, 404, { ok: false, error: "session not found in registry (is it loaded?)" });
      try {
        let plan;
        if (mode === "delete") {
          const nodes = session.surface && Array.isArray(session.surface.nodes) ? session.surface.nodes : [];
          if (!nodes.includes(seq)) throw new Error(`seq ${seq} not visible on current surface`);
          plan = { startSeq: seq, endSeq: seq, shadowedSeqs: [seq] };
        } else {
          plan = planRevert(session.surface, seq);
        }
        const notice = mode === "delete"
          ? `[消息删除] 已遮蔽 seq ${seq}`
          : `[消息回滚] 已回滚到 seq ${seq}（含）之后的 ${plan.shadowedSeqs.length} 个节点`;
        const event = applySurfaceReplace(session, plan.startSeq, plan.endSeq, plan.sourceEventSeqs, notice);
        const sessions = targetCtx.get("sessions");
        if (sessions && typeof sessions.flush === "function") {
          try { await sessions.flush(session); } catch { /* flush 失败不回滚已接受的事件 */ }
        }
        return sendJson(res, 200, {
          ok: true, mode, seq,
          shadowedCount: plan.shadowedSeqs.length,
          eventSeq: event && event.seq != null ? event.seq : null,
        });
      } catch (err) {
        return sendJson(res, 409, { ok: false, error: String(err && err.message ? err.message : err) });
      }
    };

    targetCtx.effect(() => host.register({
      kind: "exact", path: "/api/message-ops/revert", handler: commitHandler("revert"),
    }), "dsh-message-ops: revert route");

    targetCtx.effect(() => host.register({
      kind: "exact", path: "/api/message-ops/delete", handler: commitHandler("delete"),
    }), "dsh-message-ops: delete route");

    // --- POST branch：磁盘级 fork（唯一非破坏操作） ---------------------------
    targetCtx.effect(() => host.register({
      kind: "exact",
      path: "/api/message-ops/branch",
      handler: async (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method not allowed" });
        const body = await readJsonBody(req);
        if (!body) return sendJson(res, 400, { ok: false, error: "invalid json" });
        const { sessionId, upToSeq } = body;
        if (!isSessionId(sessionId)) return sendJson(res, 400, { ok: false, error: "invalid sessionId" });
        if (!Number.isSafeInteger(upToSeq) || upToSeq < 0) return sendJson(res, 400, { ok: false, error: "invalid upToSeq" });
        if (isRunning(targetCtx, sessionId)) {
          return sendJson(res, 409, { ok: false, error: "session is running; stop it first (the log may be mid-append)" });
        }
        const dirs = findSessionDirs(sessionId);
        if (dirs.length === 0) return sendJson(res, 404, { ok: false, error: "session log not found" });
        try {
          const result = applyBranch(dirs[0].logPath, upToSeq);
          return sendJson(res, 200, { ok: true, ...result });
        } catch (err) {
          return sendJson(res, 409, { ok: false, error: String(err && err.message ? err.message : err) });
        }
      },
    }), "dsh-message-ops: branch route");
  }

  const ws = ctx.get("webServer");
  if (ws !== undefined) registerHttp(ws, ctx);
  else ctx.inject(["webServer"], (sub) => registerHttp(sub.webServer, sub));
}

export default { name, inject, apply };
