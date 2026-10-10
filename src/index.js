/**
 * dsh-message-ops 服务端：消息回滚 / 消息删除 / 消息分支 / 导出 / 回滚恢复
 * 的 HTTP 路由 + Agent 工具 message_ops。
 *
 * 五操作一条龙（同名插件，一个注入点）：
 *   POST /api/message-ops/revert   回滚：surface replace 遮蔽 targetSeq..末尾
 *   POST /api/message-ops/delete   删除：surface replace 遮蔽单条 seq
 *   GET  /api/message-ops/messages 消息列表（磁盘真相 + 可见性标注）
 *   POST /api/message-ops/restore  回滚恢复：重放被遮蔽的 user/assistant 消息
 *
 * 回滚/删除走 DSH 原生 surface replace（append-only，日志完整可恢复；
 * 约束由引擎 assertProvenance 校验，违规如实上报 409）。
 * 运行中的会话一律拒绝（409），由用户先停止再操作。
 *
 * Agent 工具：action revert/delete/list/restore 共用 HTTP 同一套
 *
 * 分支与导出不属本插件：dsh 官方已有 session/fork（任意 atSeq，且会补 fork closers）
 * 与 /api/session.export（ZIP 归档）。0.9.0 移除了本插件的磁盘分支与 Markdown 导出 ——
 * 前者语义有偏差（缺 isSeeded / inheritedEventCount / closers），后者零 UI 入口。
 * 核心逻辑（src/ops-core.js）。工具注册是容错的——ctx 里没有 tools 服务、
 * 或 @deepseek-ai/dsh-tools 包不可解析时，只跳过工具注册，不影响 HTTP。
 * @module dsh-message-ops
 */

import { zstdCompressSync } from "node:zlib";
import { open as openFile, truncate as truncateFile, stat as statFile } from "node:fs/promises";
import { isSessionId, sessionIdVariants, findSessionDirs, readSessionFile, readSessionFileAsync, listMessages, computeShadowed, messageText, turnBounds } from "./session-file.js";
import { restoreNoticeText, planRevertFromEvents, planDeleteFromEvents, nextSeqFrom, buildMarkerEvent, buildRestoreNoticeEvent, buildReplayEvent, planNoticeWindow, noticeWindowPreamble, noticeWindowPostamble,
  OpsError, planRevert, planDelete, planRestore, applyRestore, applySurfaceReplace,
  restoreProgress, pendingRestoreTurns,
  isTrustedApiRequest, isJsonContentType,
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

const MAX_BODY_BYTES = 1024 * 1024; // 评审 P2：无上限的 body 缓存可打爆进程

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > MAX_BODY_BYTES) throw new OpsError("request body too large", 413);
    chunks.push(c);
  }
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { return null; }
}

/** 统一入口围栏：全部 /api/message-ops/* 路由先过这一层。 */
function fence(req, res) {
  if (!isTrustedApiRequest(req)) {
    sendJson(res, 403, { ok: false, error: "untrusted request origin (loopback Host + same-origin only)" });
    return false;
  }
  return true;
}

/** 写操作围栏：入口信任 + Content-Type 必须 application/json（CSRF 纵深）。 */
function writeFence(req, res) {
  if (!fence(req, res)) return false;
  if (!isJsonContentType(req)) {
    sendJson(res, 415, { ok: false, error: "content-type must be application/json" });
    return false;
  }
  return true;
}

/** POST body 读取（信任围栏之后）：413/400 语义区分。 */
async function readFencedBody(req, res) {
  try { return await readJsonBody(req); }
  catch (err) {
    sendJson(res, err instanceof OpsError ? err.status : 400, { ok: false, error: String(err && err.message ? err.message : err) });
    return undefined;
  }
}

/** 从 sessions 注册表解析（两种 id 拼写都试）。 */
let __resolveSource = null; // 诊断：最近一次 resolveSession 的失败原因
function resolveSession(ctx, sessionId) {
  // 宿主自己的取法是 `this.ctx.sessions.get(id)`（api-session-controller 同款）；
  // 实测 `ctx.get("sessions")` 在 inject 子 fiber 下解析到的注册表**查不到视图已
  // 加载的会话**（dock 已渲染但 get 双变体 miss —— agents.get 同 ctx 却命中），
  // 故属性优先、ctx.get 兜底，两处都试全变体。
  const candidates = [];
  try { if (ctx && ctx.sessions) candidates.push(["prop", ctx.sessions]); } catch { /* no proxy */ }
  try { const svc = ctx.get("sessions"); if (svc) candidates.push(["get", svc]); } catch { /* absent */ }
  if (candidates.length === 0) { __resolveSource = "no-sessions-service"; return undefined; }
  const variants = sessionIdVariants(sessionId);
  const tried = [];
  for (const [src, svc] of candidates) {
    if (typeof svc.get !== "function") { tried.push(src + ":no-get"); continue; }
    for (const variant of variants) {
      const s = svc.get(variant);
      if (s !== undefined) { __resolveSource = "hit via " + src + ".get " + String(variant).slice(0, 24); return s; }
    }
    // get 键错位兜底：list() 扫描（集群 face 的 list() 返回 live 实例数组，
    // 实测 get 双变体 miss 时 list 里可能有 —— 按 id/sessionId 匹配）
    if (typeof svc.list === "function") {
      try {
        const arr = svc.list();
        if (Array.isArray(arr)) {
          const hit = arr.find((x) => x && (variants.includes(x.id) || variants.includes(x.sessionId)));
          if (hit) { __resolveSource = "hit via " + src + ".list() n=" + arr.length; return hit; }
          tried.push(src + ":list-n=" + arr.length + " ids=" + arr.slice(0, 3).map((x) => String(x && (x.id || x.sessionId) || "?").slice(0, 18)).join("|"));
        } else {
          tried.push(src + ":list-" + typeof arr);
        }
      } catch (e) { tried.push(src + ":list-threw " + String(e && e.message).slice(0, 30)); }
      continue;
    }
    tried.push(src + ":miss");
  }
  __resolveSource = tried.join(",") + " tried=" + variants.length + " first=" + String(variants[0]).slice(0, 30);
  return undefined;
}

/** 是否有 live agent 正占用该会话。 */
/**
 * acquireSession：拿到 live SessionFace（带 .surface/.append）并在用完后释放。
 *
 * 0.5.6（实机第四层根因）：lazy-view 让会话**只在磁盘渲染、不进对象层**——
 * 视图开着（dock 已渲染）但 sessions.get(id) 双变体全 miss、list() 里只有别的
 * 会话 → 所有变更操作 404「not found in registry」。官方越界获取通道是
 * retain(target, {source}) → await ready → binding.session（ISessions 契约）；
 * 引用在 mutation 完成后 release（final reference 触发 teardown，须先 flush）。
 */
async function acquireSession(ctx, sessionId) {
  const direct = resolveSession(ctx, sessionId);
  if (direct !== undefined) return { session: direct, release() {} };
  const owners = [];
  // reflect 层：api-session-controller 把 ISessions（ClientSessions，带 retain）经
  // `rootCtx.reflect.provide("sessions", this)` 挂在根上；普通 ctx.get 取到的是
  // 近端同名对象层（get/list 有、retain 无）——必须走 reflect.get 才是契约面。
  try { if (ctx && ctx.reflect && typeof ctx.reflect.get === "function") owners.push(["reflect", ctx.reflect.get("sessions", false)]); } catch { /* not provided */ }
  try { if (ctx && ctx.sessions) owners.push(["prop", ctx.sessions]); } catch { /* getter threw */ }
  try { const svc = ctx.get("sessions"); if (svc) owners.push(["get", svc]); } catch { /* absent */ }
  const holders = owners.filter(([, o]) => o && typeof o.retain === "function");
  if (holders.length === 0) {
    const why = owners.length === 0
      ? "no-owner (prop-absent && get-absent)"
      : owners.map(([src, o]) => src + ":no-retain(" + (o == null ? "null" : typeof o) + ")").join(",");
    __resolveSource = (__resolveSource || "") + " | ISessions:" + why;
    return null;
  }
  const isess = holders[0][1];
  let ref = null;
  try {
    ref = isess.retain(sessionId, { source: "controllerOperation" });
    const binding = await ref.ready;
    const face = binding && binding.session;
    if (!face) { __resolveSource = "retain-ready-no-session-face"; try { ref.release(); } catch { /* */ } return null; }
    __resolveSource = "acquired via ISessions.retain";
    return { session: face, release: () => { try { ref.release(); } catch { /* already released */ } } };
  } catch (e) {
    __resolveSource = "retain-failed: " + String(e && e.message).slice(0, 80);
    if (ref) { try { ref.release(); } catch { /* */ } }
    return null;
  }
}

let __runningSource = null; // 诊断：最近一次 isRunning 的判定来源
function isRunning(ctx, sessionId) {
  // 0.5.4（实机三层根因第 3 层的最终修）：与宿主**官方同源**——
  // dsh-api-session-controller/lib/index.js ApiSessionList.summaryFor():
  //   running: this.ctx.agents.get(session.id)?.status === "running"
  // 原实现把「agents 注册表有条目」直接当 running —— 会话仅在视图中打开
  // 就有条目 → 打开即 409 锁死所有变更操作。必须再比对 status。
  try {
    const candidates = [];
    try { if (ctx && ctx.agents) candidates.push(ctx.agents); } catch { /* no proxy */ }
    try { const svc = ctx.get("agents"); if (svc) candidates.push(svc); } catch { /* absent */ }
    if (candidates.length === 0) { __runningSource = "no-agents-service"; return false; }
    for (const svc of candidates) {
      if (typeof svc.get !== "function") continue;
      for (const variant of sessionIdVariants(sessionId)) {
        const agent = svc.get(variant);
        if (agent && agent.status === "running") {
          __runningSource = "agent-status-running";
          return true;
        }
        if (agent) __runningSource = "agent-status:" + String(agent.status);
      }
    }
    if (!__runningSource) __runningSource = "no-agent-entry";
    return false;
  } catch (e) {
    __runningSource = "threw:" + String(e && e.message).slice(0, 50);
    return false;
  }
}



/**
 * diskAppend：把新事件作为一个 zstd 帧追加到会话日志（等价持久层 appendLines：
 * encode → open('a') → write+sync，失败按持久层同款按 size 回滚）。
 * 仅用于 store-miss 的 lazy-view 会话——无并发生命周期游标可竞争。
 */
async function diskAppend(logPath, newEvents) {
  if (!Array.isArray(newEvents) || newEvents.length === 0) throw new OpsError("diskAppend: empty batch", 400);
  const jsonl = newEvents.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const frame = zstdCompressSync(Buffer.from(jsonl, "utf8"));
  const handle = await openFile(logPath, "a");
  let closed = false;
  const closeHandle = async () => { if (closed) return; closed = true; await handle.close(); };
  try {
    const { size: before } = await statFile(logPath);
    try {
      await handle.writeFile(frame);
      await handle.sync();
    } catch (error) {
      try {
        await closeHandle();
        await truncateFile(logPath, before);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `failed to roll back append to "${logPath}"`);
      }
      throw error;
    }
  } finally {
    await closeHandle();
  }
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

/** 多 project slug 命中同一 id 时的静默 dirs[0] 是隐患（评审 P2）：显式报歧义。 */
function pickSessionDir(sessionId) {
  const dirs = findSessionDirs(sessionId);
  if (dirs.length === 0) throw new OpsError("session log not found", 404);
  if (dirs.length > 1) throw new OpsError(`ambiguous session id: found in ${dirs.length} project slugs (${dirs.map((d) => d.dir).join(", ")})`, 409);
  return dirs[0];
}

async function opsList(targetCtx, sessionId) {
  if (!isSessionId(sessionId)) throw new OpsError("invalid sessionId", 400);
  const { logPath } = pickSessionDir(sessionId);
  // 大日志的逐帧解压走异步让出路径，避免阻塞 GUI 事件循环（评审 P1）。
  const { header, events } = await readSessionFileAsync(logPath);
  const messages = listMessages(events);
  const shadowed = computeShadowed(events);
  const live = resolveSession(targetCtx, sessionId);
  const visibleNodes = live && live.surface && Array.isArray(live.surface.nodes) ? new Set(live.surface.nodes) : null;
  let visibleCount = 0;
  for (const m of messages) {
    m.visible = visibleNodes ? visibleNodes.has(m.seq) : !shadowed.has(m.seq);
    if (m.visible) visibleCount++;
  }
  // 0.8.0 按轮步进：为每个回撤/删除标记附恢复进度与"待恢复轮"。
  // 一次建 seq→text 索引，避免每标记全量扫文本（性能评审点）。
  const seqText = new Map();
  for (const e of events) {
    if (!e || typeof e.seq !== "number") continue;
    if (e.type !== "user/message" && e.type !== "assistant/message") continue;
    const t = messageText(e);
    if (t && t.trim()) seqText.set(e.seq, t.trim().replace(/\s+/g, " ").slice(0, 80));
  }
  // 0.9.1：**reverted** = opencode 语义「回撤边界及其后」。
  //
  // ⚠️ 不能用 `visible` 当隐藏判据 —— `visible` 是「是否在模型 surface 上」，
  // 而 tool/call / turn/* / model/* **根本不是 surface 节点**（SURFACE_TYPES 只有
  // system|user|developer|assistant/message 与 tool/result），它们永远 visible=false。
  // 照抄会把**所有**工���调用行永久藏掉（实测 3/3 全被误藏）。
  //
  // 正确口径：每个活跃回撤标记的 range.start 之后的全部 seq 都算已回撤
  // —— 这正是 opencode 的 `messages.slice(0, boundaryIndex)`（边界自己也不显示）。
  for (const m of messages) {
    if (!m || m.marker !== true) continue;
    const prog = restoreProgress(events, m.seq);
    if (!prog) { m.restoreComplete = false; m.pendingTurns = []; continue; }
    m.restoreComplete = prog.complete;
    m.pendingTurns = pendingRestoreTurns(events, m.seq).map((t) => ({
      upTo: t.seqs[t.seqs.length - 1],
      count: t.seqs.length,
      preview: seqText.get(t.turnSeq) || ('#' + t.turnSeq),
    }));
  }

  // 0.9.4：原先这里发 `revertFences`（= 未恢复 marker 的 range.start 列表）和
  // 逐条 `m.reverted = seq >= 某个 fence`。**两样都已删除**，因为它们把 19 个
  // **离散** marker 区间塌缩成「seq >= 最小值」，在一个会话里导致
  // 4792/4793 条被判为已回滚 → 客户端全藏 → 正文几乎空白（截图复现）。
  // 正确判据是 `m.visible`（模型 surface），实测与下面的 visibleCount 精确吻合。
  // 0.9.1：回合页脚/过程条的 node-key id 就是 turn 号，而它们**不是消息**，
  // 无法用「首个带 turn 字段的消息」定位（该 turn 内可能一条消息都没有，
  // 实测 turn 2 就映射不到）。这里直接给 turn/start 的 seq 映射表。
  const bounds = turnBounds(events);
  // 用 **turn/end 的 seq** 而不是 turn/start：回撤边界常落在某个 turn **内部**
  // （实测边界 seq 54 在 turn 2 的 [51..62] 之间）。用起始 seq 会漏判该回合的页脚，
  // 用结束 seq 则「边界之前完全在前」的回合自然落选。
  const turnEndSeq = {};
  for (const [turn, seq] of bounds.ends) turnEndSeq[turn] = seq;
  for (const [turn, seq] of bounds.starts) if (!(turn in turnEndSeq)) turnEndSeq[turn] = seq;

  return {
    ok: true,
    session: { id: header.id, createdAt: header.createdAt, parentSession: header.parentSession ?? null },
    running: isRunning(targetCtx, sessionId),
    runningSource: __runningSource,
    total: messages.length,
    visibleCount,
    turnEndSeq,
    messages,
  };
}

async function opsCommit(targetCtx, mode, sessionId, seq) {
  if (!isSessionId(sessionId)) throw new OpsError("invalid sessionId", 400);
  if (!Number.isSafeInteger(seq) || seq < 0) throw new OpsError("invalid seq", 400);
  if (isRunning(targetCtx, sessionId)) throw new OpsError("session is running; stop it first", 409);
  const { logPath } = pickSessionDir(sessionId);
  const { header, events } = await readSessionFileAsync(logPath);
  // 0.8.2：空闲会话（实测 340/364）没有打开的 turn/step → 用自足的**合成 turn**
  // 承载 notice，而不是拒绝。引擎 append-only 插不进已有 step，但合成一整个 turn 合法
  //��已对官方校验闸实测：append 型 / 单节点 replace / 多节点 replace 全 PASS，遮蔽受保护头正确拒绝）。
  // 带 reason:"message-ops"，UI 与审计可识别，不与真实模型轮次混淆。
  const win = planNoticeWindow(events);
  const turnStep = { turn: win.turn, step: win.step };
  const notice = mode === "delete"
    ? `[消息删除] 已遮蔽 seq ${seq}`
    : null; // revert 文案含 shadowed 数量，规划后拼
  const acq = await acquireSession(targetCtx, sessionId);
  if (acq !== null && acq.session !== undefined) {
    try {
      const session = acq.session;
      // 0.5.4（P0）：v4 准入要求 system/message 带正 turn/step——缺字段时持久层
      // encodeEventBatch 的 SessionFormatError 未捕获会**打死整个 dsh 进程**。
      const plan = mode === "delete" ? planDelete(session.surface, seq) : planRevert(session.surface, seq);
      const text = mode === "delete" ? notice
        : `[消息回滚] 已回滚到 seq ${seq}（含）之后的 ${plan.shadowedSeqs.length} 个节点`;
      // 0.8.2：会话 store 命中时走引擎路径 —— 同样要先开合成 turn 窗口，
      // 否则 notice 落在已关闭的 turn/step 里，加载端拒绝整份历史。
      for (const pre of noticeWindowPreamble(win)) session.append(pre.kind, pre.data);
      const event = applySurfaceReplace(session, plan.startSeq, plan.endSeq, plan.shadowedSeqs, text, turnStep);
      // 必须闭合：否则引擎内存里 turn 16 永远开着 → isRunning 恒真 → 后续操作全被 409
      for (const post of noticeWindowPostamble(win)) session.append(post.kind, post.data);
      flushSessions(targetCtx, session);
      return {
        ok: true, mode, seq,
        syntheticTurn: win.synthetic === true,
        shadowedCount: plan.shadowedSeqs.length,
        eventSeq: event && event.seq != null ? event.seq : null,
      };
    } finally {
      acq.release();
    }
  }
  // store-miss（lazy-view 只读盘会话）→ 磁盘路径：镜像引擎字段直接追加 zstd 帧
  const plan = mode === "delete" ? planDeleteFromEvents(events, seq) : planRevertFromEvents(events, seq);
  const text = mode === "delete" ? notice
    : `[消息回滚] 已回滚到 seq ${seq}（含）之后的 ${plan.shadowedSeqs.length} 个节点`;
  // 0.8.2：磁盘路径同样把 marker 包进合成 turn（裸 zstd 写、零校验，写错就是整份日志报废）
  const baseTime = Date.now();
  let cursor = nextSeqFrom(events);
  const batch = noticeWindowPreamble(win).map((e, i) => ({
    type: e.kind, seq: cursor++, time: baseTime + i, data: e.data,
  }));
  const marker = buildMarkerEvent({
    seq: cursor++, time: baseTime + batch.length, turnStep, text, version: header?.version ?? 4,
    startSeq: plan.startSeq, endSeq: plan.endSeq, shadowedSeqs: plan.shadowedSeqs,
  });
  batch.push(marker);
  let tail = marker.time + 1;
  for (const e of noticeWindowPostamble(win)) batch.push({ type: e.kind, seq: cursor++, time: tail++, data: e.data });
  await diskAppend(logPath, batch);
  return {
    ok: true, mode, seq, disk: true, syntheticTurn: win.synthetic === true,
    shadowedCount: plan.shadowedSeqs.length,
    eventSeq: marker.seq,
  };
}

// 0.8.0：upToSeq 可选 —— 给定则按轮步进恢复（只重放到该 seq，后续仍遮蔽）。
// 0.8.1：opts.discard —— 不重放内容，仅停用标记（清贴条）。
async function opsRestore(targetCtx, sessionId, restoreSeq, upToSeq, discard) {
  if (!isSessionId(sessionId)) throw new OpsError("invalid sessionId", 400);
  if (!Number.isSafeInteger(restoreSeq) || restoreSeq < 0) throw new OpsError("invalid seq", 400);
  if (upToSeq !== undefined && (!Number.isSafeInteger(upToSeq) || upToSeq < 0)) throw new OpsError("invalid upToSeq", 400);
  if (isRunning(targetCtx, sessionId)) throw new OpsError("session is running; stop it first", 409);
  const { logPath } = pickSessionDir(sessionId);
  const { events } = await readSessionFileAsync(logPath);
  // 0.8.0（B1 修复）：步进恢复必须排除先前轮次已重放的源 seq，
  // 否则每轮从区间头重放 → 消息副本成倍出现。
  // 0.8.2：空闲会话（实测 340/364）没有打开的 turn/step → 用自足的**合成 turn**
  // 承载 notice，而不是拒绝。引擎 append-only 插不进已有 step，但合成一整个 turn 合法
  //��已对官方校验闸实测：append 型 / 单节点 replace / 多节点 replace 全 PASS，遮蔽受保护头正确拒绝）。
  // 带 reason:"message-ops"，UI 与审计可识别，不与真实模型轮次混淆。
  const win = planNoticeWindow(events);
  const progress = restoreProgress(events, restoreSeq);
  const plan = planRestore(events, restoreSeq, upToSeq, progress ? progress.restoredSeqs : null);
  plan.turnStep = { turn: win.turn, step: win.step };
  plan.window = win;
  if (discard) plan.discard = true;
  if (plan.replayable.length === 0 && progress && !progress.complete && progress.pendingSeqs.length > 0) {
    // 请求的 upTo 之前已全部重放过 → 只补一条进度 notice（不重复重放）
    plan.upToSeq = upToSeq != null ? Math.min(upToSeq, plan.endSeq) : plan.endSeq;
  }
  const acq = await acquireSession(targetCtx, sessionId);
  if (acq !== null && acq.session !== undefined) {
    try {
      for (const pre of noticeWindowPreamble(win)) acq.session.append(pre.kind, pre.data);
      const result = applyRestore(acq.session, plan, {
        flush: () => { flushSessions(targetCtx, acq.session); },
      });
      for (const post of noticeWindowPostamble(winR)) acq.session.append(post.kind, post.data);
      return { ok: true, ...result, discarded: plan.discard === true, upToSeq: plan.upToSeq, restoredSourceSeqs: plan.replayable.map((i) => i.seq), range: { startSeq: plan.startSeq, endSeq: plan.endSeq } };
    } finally {
      acq.release();
    }
  }
  // store-miss → 磁盘路径：说明事件 + 重放事件批量追加（一个帧）
  let cursor = nextSeqFrom(events);
  const baseTime = Date.now();
  const version = (await readSessionFileAsync(logPath)).header?.version ?? 4;
  const batch = noticeWindowPreamble(win).map((e, i) => ({
    type: e.kind, seq: cursor++, time: baseTime + i, data: e.data,
  }));
  const noticeBase = baseTime + batch.length;
  batch.push(buildRestoreNoticeEvent({
    seq: cursor++, time: noticeBase, turnStep: plan.turnStep, version,
    text: plan.discard
      ? `[消息操作] 回撤标记 seq ${plan.restoreSeq} 已停用（丢弃）：区间内容保持遮蔽、未重放；日志原文仍在，可搜索`
      : restoreNoticeText(plan),
    restoreSeq: plan.restoreSeq,
    discard: plan.discard === true,
  }));
  let offset = 0;
  for (const item of plan.discard ? [] : plan.replayable) {
    batch.push(buildReplayEvent({ seq: cursor++, time: noticeBase + (++offset), item, turnStep: plan.turnStep, version }));
  }
  let tail = noticeBase + offset + 1;
  for (const e of noticeWindowPostamble(win)) batch.push({ type: e.kind, seq: cursor++, time: tail++, data: e.data });
  await diskAppend(logPath, batch);
  return {
    ok: true, disk: true, syntheticTurn: win.synthetic === true,
    restoredCount: plan.replayable.length,
    upToSeq: plan.upToSeq,
    restoredSourceSeqs: plan.replayable.map((i) => i.seq),
    skipped: plan.skipped,
    eventSeqs: batch.map((e) => e.seq),
    range: { startSeq: plan.startSeq, endSeq: plan.endSeq },
  };
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
      "Manage DSH conversation messages: list messages with visibility, revert to a seq (surface replace shadows the tail), delete a single message, restore (replay) messages shadowed by a previous revert. These are the message-level operations dsh does NOT provide natively (use the built-in session/fork for branching and /export for archives). Sessions must not be running for mutating actions.",
    parameters: {
      action: {
        type: "string",
        required: true,
        enum: ["list", "revert", "delete", "restore"],
        description: "Which operation to perform.",
      },
      sessionId: {
        type: "string",
        required: true,
        description: "Target session id (uuid or session-<uuid> form).",
      },
      seq: {
        type: "integer",
        description: "revert/delete: the target seq. restore: the seq of the revert/delete marker event. Ignored by list.",
      },
      upToSeq: {
        type: "integer",
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
        // 0.5.2（P1）：ops 自 0.2.1 起为 async——不 await 会把 Promise 直接送进 renderResult，
        // list/restore 必抛 TypeError（测试桩曾是同步的故漏检）。
        switch (action) {
          case "list": result = await ops.list(ctx, sessionId); break;
          case "revert": result = await ops.revert(ctx, sessionId, args.seq); break;
          case "delete": result = await ops.delete(ctx, sessionId, args.seq); break;
          case "restore": result = await ops.restore(ctx, sessionId, args.seq); break;
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
        `session ${r.session.id}`,
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
    case "restore":
      return `restore ok: replayed ${r.restoredCount} message(s) from range ${r.range.startSeq}..${r.range.endSeq} (${r.skipped} skipped); appended event seqs ${r.eventSeqs.join(", ")}`;
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
          restore: (c, id, seq, upToSeq) => opsRestore(c, id, seq, upToSeq),
        };
        tools.register(createMessageOpsTool({ defineTool, ops, ctx: targetCtx }));
      })
      // 0.9.0：不再静默吞错。原先 catch(() => {}) 让「工具注册成功与否」完全无从诊断
      // （实测日志里 defineTool / ERR_MODULE_NOT_FOUND 零命中）。
      .catch((e) => {
        console.warn('[message-ops] defineTool 注册失败，工具不可用（其余功能不受影响）:', e && (e.code || e.message) ? (e.code || e.message) : e)
      });
    return true;
  }
  if (tryRegister(ctx)) return;
  ctx.inject(["tools"], (sub) => { tryRegister(sub); });
}

// ---------------------------------------------------------------------------
// 插件入口：HTTP 路由 + 容错工具注册
// ---------------------------------------------------------------------------

export function apply(ctx) {
  // 诊断（0.5.4 调试）：会话状态服务解析情况
  try {
    const names = ["sessions", "agents", "sessionController", "sessionList", "session-manager"];
    const parts = names.map((n) => { const v = ctx.get(n); return n + "=" + (v == null ? String(v) : typeof v); });
    const ses = ctx.get("sessions");
    const hasList = ses && ses.list != null;
    const hasSnap = hasList && typeof ses.list.getSnapshot === "function";
    console.log("[message-ops] session services: " + parts.join(" ") + " | sessions.list=" + hasList + " getSnapshot=" + hasSnap + (ses ? " keys=" + Object.keys(ses).slice(0, 12).join("|") : ""));
  } catch (e) { console.log("[message-ops] probe failed: " + e); }
  function registerHttp(host, targetCtx) {
    // --- GET /api/message-ops/messages：消息列表（只读） ---------------------
    targetCtx.effect(() => host.register({
      kind: "exact",
      path: "/api/message-ops/messages",
      handler: async (req, res) => {
        if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "method not allowed" });
        if (!fence(req, res)) return;
        try {
          const url = new URL(req.url, "http://localhost");
          return sendJson(res, 200, await opsList(targetCtx, url.searchParams.get("sessionId") || ""));
        } catch (err) {
          return sendJson(res, err instanceof OpsError ? err.status : 500, { ok: false, error: String(err && err.message ? err.message : err) });
        }
      },
    }), "dsh-message-ops: messages route");

    // --- GET /api/message-ops/text：单条消息全文（0.5.2 引用按钮按需取） ----------
    // assistant 消息的 fullText 不在 messages 列表里（载荷控制），quote 点击时单取。
    targetCtx.effect(() => host.register({
      kind: "exact",
      path: "/api/message-ops/text",
      handler: async (req, res) => {
        if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "method not allowed" });
        if (!fence(req, res)) return;
        try {
          const url = new URL(req.url, "http://localhost");
          const sessionId = url.searchParams.get("sessionId") || "";
          const seq = Number.parseInt(url.searchParams.get("seq") || "", 10);
          if (!isSessionId(sessionId)) throw new OpsError("invalid sessionId", 400);
          if (!Number.isSafeInteger(seq) || seq < 0) throw new OpsError("invalid seq", 400);
          const { logPath } = pickSessionDir(sessionId);
          const { events } = await readSessionFileAsync(logPath);
          const ev = events.find((e) => e && e.seq === seq);
          if (!ev) throw new OpsError("seq not found", 404);
          return sendJson(res, 200, { ok: true, seq, text: messageText(ev) });
        } catch (err) {
          return sendJson(res, err instanceof OpsError ? err.status : 500, { ok: false, error: String(err && err.message ? err.message : err) });
        }
      },
    }), "dsh-message-ops: text route");

    // --- POST revert / delete：live-session surface replace ------------------
    const commitHandler = (mode) => async (req, res) => {
      if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method not allowed" });
      if (!writeFence(req, res)) return;
      const body = await readFencedBody(req, res);
      if (body === undefined) return;
      if (!body || typeof body !== "object") return sendJson(res, 400, { ok: false, error: "invalid json" });
      try {
        return sendJson(res, 200, await opsCommit(targetCtx, mode, body.sessionId, body.seq));
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


    // --- POST restore：回滚恢复（重放语义，见 ops-core.js 注释） --------------
    targetCtx.effect(() => host.register({
      kind: "exact",
      path: "/api/message-ops/restore",
      handler: async (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method not allowed" });
        if (!writeFence(req, res)) return;
        const body = await readFencedBody(req, res);
        if (body === undefined) return;
        if (!body || typeof body !== "object") return sendJson(res, 400, { ok: false, error: "invalid json" });
        try {
          // 0.8.0：body.upToSeq 存在 → 按轮步进恢复（只到该 seq）
          return sendJson(res, 200, await opsRestore(targetCtx, body.sessionId, body.seq, body.upToSeq != null ? Number(body.upToSeq) : undefined, body.discard === true));
        } catch (err) {
          return sendJson(res, err instanceof OpsError ? err.status : 500, { ok: false, error: String(err && err.message ? err.message : err) });
        }
      },
    }), "dsh-message-ops: restore route");

  }

  const ws = ctx.get("webServer");
  if (ws !== undefined) registerHttp(ws, ctx);
  else ctx.inject(["webServer"], (sub) => registerHttp(sub.webServer, sub));

  registerToolTolerantly(ctx);
}

export default { name, inject, apply };
