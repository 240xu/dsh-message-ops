/**
 * dsh-message-ops 服务端：消息回滚 / 消息删除 / 消息分支 / 导出 / 回滚恢复
 * 的 HTTP 路由 + Agent 工具 message_ops。
 *
 * 五操作一条龙（同名插件，一个注入点）：
 *   POST /api/message-ops/revert   回滚：surface replace 遮蔽 targetSeq..末尾
 *   POST /api/message-ops/delete   删除：surface replace 遮蔽单条 seq
 *   POST /api/message-ops/branch   分支：磁盘级 fork（新会话，parentSession 关联）
 *   GET  /api/message-ops/messages 消息列表（磁盘真相 + 可见性标注）
 *   GET  /api/message-ops/export   导出 Markdown（seq 可选上界，附件下载）
 *   POST /api/message-ops/restore  回滚恢复：重放被遮蔽的 user/assistant 消息
 *
 * 回滚/删除走 DSH 原生 surface replace（append-only，日志完整可恢复；
 * 约束由引擎 assertProvenance 校验，违规如实上报 409）。
 * 运行中的会话一律拒绝（409），由用户先停止再操作。
 *
 * Agent 工具：action revert/delete/branch/list/restore 共用 HTTP 同一套
 * 核心逻辑（src/ops-core.js）。工具注册是容错的——ctx 里没有 tools 服务、
 * 或 @deepseek-ai/dsh-tools 包不可解析时，只跳过工具注册，不影响 HTTP。
 * @module dsh-message-ops
 */

import { isSessionId, sessionIdVariants, findSessionDirs, readSessionFile, listMessages, computeShadowed } from "./session-file.js";
import { applyBranch } from "./branch.js";
import {
  OpsError, planRevert, planDelete, planRestore, applyRestore, applySurfaceReplace, exportMarkdown,
} from "./ops-core.js";

export const name = "dsh-message-ops";
// 保持 inject 为空：tools 是可选增强而非硬依赖（cordis 的 inject 是
// 硬依赖声明，缺服务会让整个插件 apply 永远不执行）。工具注册在
// apply 内部容错探测，见 registerToolTolerantly。
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

function flushSessions(ctx, session) {
  const sessions = ctx.get("sessions");
  if (sessions && typeof sessions.flush === "function") {
    try { return sessions.flush(session); } catch { /* flush 失败不回滚已接受的事件 */ }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 核心操作：HTTP 与 message_ops 工具共用（返回普通对象，失败抛 OpsError）
// ---------------------------------------------------------------------------

function opsList(targetCtx, sessionId) {
  if (!isSessionId(sessionId)) throw new OpsError("invalid sessionId", 400);
  const dirs = findSessionDirs(sessionId);
  if (dirs.length === 0) throw new OpsError("session log not found", 404);
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
  return {
    ok: true,
    session: { id: header.id, createdAt: header.createdAt, parentSession: header.parentSession ?? null },
    running: isRunning(targetCtx, sessionId),
    total: messages.length,
    visibleCount,
    messages,
  };
}

function opsCommit(targetCtx, mode, sessionId, seq) {
  if (!isSessionId(sessionId)) throw new OpsError("invalid sessionId", 400);
  if (!Number.isSafeInteger(seq) || seq < 0) throw new OpsError("invalid seq", 400);
  if (isRunning(targetCtx, sessionId)) throw new OpsError("session is running; stop it first", 409);
  const session = resolveSession(targetCtx, sessionId);
  if (session === undefined) throw new OpsError("session not found in registry (is it loaded?)", 404);
  const plan = mode === "delete" ? planDelete(session.surface, seq) : planRevert(session.surface, seq);
  const notice = mode === "delete"
    ? `[消息删除] 已遮蔽 seq ${seq}`
    : `[消息回滚] 已回滚到 seq ${seq}（含）之后的 ${plan.shadowedSeqs.length} 个节点`;
  const event = applySurfaceReplace(session, plan.startSeq, plan.endSeq, plan.shadowedSeqs, notice);
  flushSessions(targetCtx, session);
  return {
    ok: true, mode, seq,
    shadowedCount: plan.shadowedSeqs.length,
    eventSeq: event && event.seq != null ? event.seq : null,
  };
}

function opsBranch(targetCtx, sessionId, upToSeq) {
  if (!isSessionId(sessionId)) throw new OpsError("invalid sessionId", 400);
  if (!Number.isSafeInteger(upToSeq) || upToSeq < 0) throw new OpsError("invalid upToSeq", 400);
  if (isRunning(targetCtx, sessionId)) {
    throw new OpsError("session is running; stop it first (the log may be mid-append)", 409);
  }
  const dirs = findSessionDirs(sessionId);
  if (dirs.length === 0) throw new OpsError("session log not found", 404);
  return { ok: true, ...applyBranch(dirs[0].logPath, upToSeq) };
}

function opsRestore(targetCtx, sessionId, restoreSeq) {
  if (!isSessionId(sessionId)) throw new OpsError("invalid sessionId", 400);
  if (!Number.isSafeInteger(restoreSeq) || restoreSeq < 0) throw new OpsError("invalid seq", 400);
  if (isRunning(targetCtx, sessionId)) throw new OpsError("session is running; stop it first", 409);
  const session = resolveSession(targetCtx, sessionId);
  if (session === undefined) throw new OpsError("session not found in registry (is it loaded?)", 404);
  const dirs = findSessionDirs(sessionId);
  if (dirs.length === 0) throw new OpsError("session log not found", 404);
  const { events } = readSessionFile(dirs[0].logPath);
  const plan = planRestore(events, restoreSeq);
  const result = applyRestore(session, plan, {
    flush: () => { flushSessions(targetCtx, session); },
  });
  return { ok: true, ...result, range: { startSeq: plan.startSeq, endSeq: plan.endSeq } };
}

function opsExport(targetCtx, sessionId, seq) {
  if (!isSessionId(sessionId)) throw new OpsError("invalid sessionId", 400);
  if (seq !== undefined && (!Number.isSafeInteger(seq) || seq < 0)) throw new OpsError("invalid seq", 400);
  const dirs = findSessionDirs(sessionId);
  if (dirs.length === 0) throw new OpsError("session log not found", 404);
  const { header, events } = readSessionFile(dirs[0].logPath);
  return { header, markdown: exportMarkdown(header, events, seq), upToSeq: seq };
}

// ---------------------------------------------------------------------------
// Agent 工具 message_ops（容错注册）
// ---------------------------------------------------------------------------

/**
 * 构造 message_ops 工具定义。defineTool 由调用方注入（@deepseek-ai/dsh-tools），
 * 这里保持零静态依赖、可在测试里用桩验证。ops 为核心操作表，签名：
 * (targetCtx, sessionId[, seq]) → 结果对象，失败抛 OpsError。
 */
export function createMessageOpsTool({ defineTool, ops, ctx }) {
  return defineTool({
    name: "message_ops",
    description:
      "Manage DSH conversation messages: list messages with visibility, revert to a seq (surface replace shadows the tail), delete a single message, fork a branch from any seq, restore (replay) messages shadowed by a previous revert, or export the conversation as Markdown. Sessions must not be running for mutating actions.",
    parameters: {
      action: {
        type: "string",
        required: true,
        enum: ["list", "revert", "delete", "branch", "restore", "export"],
        description: "Which operation to perform.",
      },
      sessionId: {
        type: "string",
        required: true,
        description: "Target session id (uuid or session-<uuid> form).",
      },
      seq: {
        type: "integer",
        description: "revert/delete: the target seq. restore: the seq of the revert/delete marker event. export: optional upper bound (inclusive). Ignored by list/branch.",
      },
      upToSeq: {
        type: "integer",
        description: "branch: fork keeps events up to this seq (inclusive).",
      },
    },
    output: {
      schema: { type: "string" },
      render(_args, value) { return [{ type: "text", text: value }]; },
    },
    async execute(args) {
      const action = args.action;
      const sessionId = String(args.sessionId || "").trim();
      try {
        let result;
        switch (action) {
          case "list": result = ops.list(ctx, sessionId); break;
          case "revert": result = ops.revert(ctx, sessionId, args.seq); break;
          case "delete": result = ops.delete(ctx, sessionId, args.seq); break;
          case "branch": result = ops.branch(ctx, sessionId, args.upToSeq); break;
          case "restore": result = ops.restore(ctx, sessionId, args.seq); break;
          case "export": result = ops.export(ctx, sessionId, args.seq); break;
          default: throw new OpsError(`unknown action: ${action}`, 400);
        }
        return renderResult(action, result);
      } catch (e) {
        return `${action} failed: ${e && e.message ? e.message : e}`;
      }
    },
  });
}

/** 工具结果 → 模型可读的多行文本。 */
function renderResult(action, r) {
  switch (action) {
    case "list": {
      const lines = [
        `session ${r.session.id}${r.session.parentSession ? ` (branch of ${r.session.parentSession})` : ""}`,
        `running: ${r.running}; total: ${r.total}; visible: ${r.visibleCount}`,
      ];
      for (const m of r.messages) {
        lines.push(`seq ${m.seq} [${m.visible ? "visible" : "shadowed"}] ${m.role}: ${m.snippet}`);
      }
      return lines.join("\n");
    }
    case "revert":
    case "delete":
      return `${r.mode} ok: shadowed ${r.shadowedCount} node(s) from seq ${r.seq}; marker event seq ${r.eventSeq}`;
    case "branch":
      return `branch ok: new session ${r.newId} (parent ${r.parentId ?? "n/a"}), kept ${r.kept ?? "?"} event(s)`;
    case "restore":
      return `restore ok: replayed ${r.restoredCount} message(s) from range ${r.range.startSeq}..${r.range.endSeq} (${r.skipped} skipped); appended event seqs ${r.eventSeqs.join(", ")}`;
    case "export":
      return r.markdown;
    default:
      return JSON.stringify(r);
  }
}

/**
 * 容错工具注册：ctx 已带 tools 服务就直接注册；没有就等它出现
 * （ctx.inject 子 fiber，永不 fatal）；dsh-tools 包解析失败也只跳过。
 */
function registerToolTolerantly(ctx) {
  function tryRegister(targetCtx) {
    const tools = targetCtx.get("tools");
    if (!tools || typeof tools.register !== "function") return false;
    // 动态 import：包缺失时只跳过工具，不拖垮插件的 HTTP 面。
    import("@deepseek-ai/dsh-tools")
      .then(({ defineTool }) => {
        const ops = {
          list: (c, id) => opsList(c, id),
          revert: (c, id, seq) => opsCommit(c, "revert", id, seq),
          delete: (c, id, seq) => opsCommit(c, "delete", id, seq),
          branch: (c, id, upToSeq) => opsBranch(c, id, upToSeq),
          restore: (c, id, seq) => opsRestore(c, id, seq),
          export: (c, id, seq) => opsExport(c, id, seq),
        };
        tools.register(createMessageOpsTool({ defineTool, ops, ctx: targetCtx }));
      })
      .catch(() => { /* dsh-tools 不可解析：跳过工具注册，不影响其余功能 */ });
    return true;
  }
  if (tryRegister(ctx)) return;
  ctx.inject(["tools"], (sub) => { tryRegister(sub); });
}

// ---------------------------------------------------------------------------
// 插件入口：HTTP 路由 + 容错工具注册
// ---------------------------------------------------------------------------

export function apply(ctx) {
  function registerHttp(host, targetCtx) {
    // --- GET /api/message-ops/messages：消息列表（只读） ---------------------
    targetCtx.effect(() => host.register({
      kind: "exact",
      path: "/api/message-ops/messages",
      handler: async (req, res) => {
        try {
          const url = new URL(req.url, "http://localhost");
          return sendJson(res, 200, opsList(targetCtx, url.searchParams.get("sessionId") || ""));
        } catch (err) {
          return sendJson(res, err instanceof OpsError ? err.status : 500, { ok: false, error: String(err && err.message ? err.message : err) });
        }
      },
    }), "dsh-message-ops: messages route");

    // --- POST revert / delete：live-session surface replace ------------------
    const commitHandler = (mode) => async (req, res) => {
      if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method not allowed" });
      const body = await readJsonBody(req);
      if (!body) return sendJson(res, 400, { ok: false, error: "invalid json" });
      try {
        return sendJson(res, 200, opsCommit(targetCtx, mode, body.sessionId, body.seq));
      } catch (err) {
        return sendJson(res, err instanceof OpsError ? err.status : 500, { ok: false, error: String(err && err.message ? err.message : err) });
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
        try {
          return sendJson(res, 200, opsBranch(targetCtx, body.sessionId, body.upToSeq));
        } catch (err) {
          return sendJson(res, err instanceof OpsError ? err.status : 500, { ok: false, error: String(err && err.message ? err.message : err) });
        }
      },
    }), "dsh-message-ops: branch route");

    // --- POST restore：回滚恢复（重放语义，见 ops-core.js 注释） --------------
    targetCtx.effect(() => host.register({
      kind: "exact",
      path: "/api/message-ops/restore",
      handler: async (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method not allowed" });
        const body = await readJsonBody(req);
        if (!body) return sendJson(res, 400, { ok: false, error: "invalid json" });
        try {
          return sendJson(res, 200, opsRestore(targetCtx, body.sessionId, body.seq));
        } catch (err) {
          return sendJson(res, err instanceof OpsError ? err.status : 500, { ok: false, error: String(err && err.message ? err.message : err) });
        }
      },
    }), "dsh-message-ops: restore route");

    // --- GET export：Markdown 附件下载 ----------------------------------------
    targetCtx.effect(() => host.register({
      kind: "exact",
      path: "/api/message-ops/export",
      handler: async (req, res) => {
        try {
          const url = new URL(req.url, "http://localhost");
          const sessionId = url.searchParams.get("sessionId") || "";
          const rawSeq = url.searchParams.get("seq");
          const seq = rawSeq === null || rawSeq === "" ? undefined : Number(rawSeq);
          const { header, markdown, upToSeq } = opsExport(targetCtx, sessionId, seq);
          const suffix = upToSeq === undefined ? "full" : `seq-${upToSeq}`;
          res.writeHead(200, {
            "content-type": "text/markdown; charset=utf-8",
            "content-disposition": `attachment; filename="${header.id}-${suffix}.md"`,
          });
          res.end(markdown);
        } catch (err) {
          return sendJson(res, err instanceof OpsError ? err.status : 500, { ok: false, error: String(err && err.message ? err.message : err) });
        }
      },
    }), "dsh-message-ops: export route");
  }

  const ws = ctx.get("webServer");
  if (ws !== undefined) registerHttp(ws, ctx);
  else ctx.inject(["webServer"], (sub) => registerHttp(sub.webServer, sub));

  registerToolTolerantly(ctx);
}

export default { name, inject, apply };
