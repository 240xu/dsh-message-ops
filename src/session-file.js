/**
 * dsh-message-ops — 会话文件机制（纯 Node，零 npm 依赖）。
 *
 * DSH 的 JSONL 持久化格式：一份会话日志 = 多个独立 zstd 帧的串联，
 *   帧 0 = 恰好一行 session header JSON（以 \n 结尾，帧带 checksum）
 *   之后每帧 = 一批以 \n 分隔的事件行（NDJSON）
 * 回写 = 重排帧：header 帧 + 事件帧。node:zlib 自 Node 23.5 起暴露
 * zstdCompressSync / zstdDecompressSync，零依赖即可压缩/解压，
 * Windows / Termux / Linux 行为一致。旧格式 session.jsonl.zstd（单帧
 * 整文件）读取走同一帧扫描路径，单帧等效于解压整份。
 * @module dsh-message-ops/session-file
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

const ZSTD_MAGIC = 0xfd2fb528;

/** 从 message 事件提取首个非空 text 块（listMessages / ops-core 共用单点）。 */
export function messageText(e) {
  const msg = e && e.data && e.data.message;
  const content = msg && Array.isArray(msg.content) ? msg.content : (e && e.data && e.data.content);
  if (!Array.isArray(content)) return "";
  for (const c of content) {
    if (c && c.type === "text" && typeof c.text === "string" && c.text.trim()) return c.text;
  }
  return "";
}

/** 与 DSH 宿主一致：帧带 checksum（ZSTD_c_checksumFlag=1）。 */
function compressFrame(input) {
  return zstdCompressSync(Buffer.from(input, "utf8"), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  });
}

/**
 * 扫描串联 zstd 流的完整帧边界（不解压块）。
 * @returns {{frames: {start:number,end:number}[], tornStart?: number}}
 */
export function scanZstdFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset < buf.length) {
    const start = offset;
    if (buf.length - offset < 4) return { frames, tornStart: start };
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt zstd session log: invalid frame magic at byte ${offset}`);
    }
    let end = buf.length;
    for (let p = offset + 4; p <= buf.length - 4; p++) {
      if (buf.readUInt32LE(p) === ZSTD_MAGIC) { end = p; break; }
    }
    frames.push({ start, end });
    offset = end;
  }
  return { frames };
}

/**
 * 逐行解帧：首个 type:"session" 行作 header，其余行作事件。
 * 一条路径同时覆盖两种持久化格式（compat-audit P0）：
 *   - v3 多帧：帧 0 = 恰一行 header，其后每帧一批事件行；
 *   - 旧单帧 session.jsonl.zstd：整个文件一帧，解压出多行 NDJSON，
 *     首行 header、其余事件——旧实现把帧 0 整段 JSON.parse 会直接崩。
 * 撕裂行（JSON.parse 失败）按宿主「完整前缀」语义跳过。
 */
function collectHeaderAndEvents(text, events) {
  let header = null;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let json;
    try { json = JSON.parse(t); } catch { continue; /* torn record: skip */ }
    if (!header && json && typeof json === "object" && json.type === "session") { header = json; continue; }
    events.push(json);
  }
  return header;
}

/**
 * 读取会话日志 → { header, events }。两种格式（v3 多帧 / 旧单帧）同一条
 * 逐行扫描路径，见 collectHeaderAndEvents。
 */
export function readSessionFile(file) {
  const buf = fs.readFileSync(file);
  const { frames } = scanZstdFrames(buf);
  if (frames.length === 0) throw new Error("empty or header-less session log");
  const events = [];
  let header = null;
  for (const f of frames) {
    const text = zstdDecompressSync(buf.subarray(f.start, f.end)).toString("utf8");
    const found = collectHeaderAndEvents(text, events);
    if (!header) header = found;
  }
  if (!header) throw new Error(`session log ${file}: no {type:"session"} header line in any frame`);
  return { header, events };
}

/** 物化整份日志：header 帧（恰一行）+ 单一事件帧（全部事件行）。 */
export function encodeSessionFile(header, events) {
  const headerText = JSON.stringify(header) + "\n";
  const bodyText = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  return Buffer.concat([compressFrame(headerText), compressFrame(bodyText)]);
}

/** 会话根目录（尊重 DSH_HOME；Windows/Termux 通吃）。 */
export function sessionsRoot() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, "sessions");
}

const SESSION_ID_RE = /^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionId(v) {
  return typeof v === "string" && SESSION_ID_RE.test(v);
}

/** 会话 id 的两种拼写（带/不带 session- 前缀）。 */
export function sessionIdVariants(sessionId) {
  const variants = new Set([sessionId]);
  if (sessionId.startsWith("session-")) variants.add(sessionId.slice("session-".length));
  else variants.add(`session-${sessionId}`);
  return [...variants];
}

/**
 * 在 sessions 根下定位会话目录：扫每个 project-slug 目录找 <slug>/<id>/，
 * 避免在插件里重推 workspace 路径编码。
 * @returns {{dir: string, logPath: string}[]}
 */
export function findSessionDirs(sessionId) {
  const root = sessionsRoot();
  let slugs = [];
  try { slugs = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const variants = sessionIdVariants(sessionId);
  const found = [];
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    for (const variant of variants) {
      const dir = path.join(root, slug.name, variant);
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
      } catch { continue; }
      // 探测序列（用户实测 DSH 已升级 v4 格式）：v4 → v3 → 旧单帧，
      // 高版本优先；文件名与 header.version 对应，读取逻辑三格式同构。
      let logPath = null;
      for (const name of ["session.v4.jsonl.zstd", "session.v3.jsonl.zstd", "session.jsonl.zstd"]) {
        const candidate = path.join(dir, name);
        try { fs.statSync(candidate); logPath = candidate; break; } catch { /* probe next */ }
      }
      if (!logPath) continue;
      if (!found.some((f) => f.dir === dir)) found.push({ dir, logPath });
    }
  }
  return found;
}

/** 新建会话 id（与宿主同款 session-<uuid> 拼写）。 */
export function newSessionId() {
  return `session-${crypto.randomUUID()}`;
}

/** 从事件流提取消息级列表（user/assistant/system message + tool/call 摘要）。 */
export function listMessages(events) {
  const messages = [];
  for (const e of events) {
    if (!e || typeof e.seq !== "number") continue;
    if (e.type === "user/message" || e.type === "assistant/message" || e.type === "system/message") {
      const text = messageText(e);
      const msg = e.data && e.data.message;
      // id：宿主持久化的消息身份（user 在 data.id、assistant 在 data.message.id），
      // 供 0.2.0 assistant-actions 槽（ownerProps={messageId}）反查 seq。
      // marker：本事件是 revert/delete 落定的 replace 标记 → 对话框据此提供「恢复」模式。
      const isReplaceMarker = !!(e.surfaceOp && typeof e.surfaceOp === "object" && e.surfaceOp.op === "replace");
      messages.push({
        seq: e.seq,
        type: e.type,
        role: (msg && msg.role) || (e.type === "user/message" ? "user" : e.type === "assistant/message" ? "assistant" : "system"),
        id: (msg && msg.id) || e.data.id || null,
        marker: isReplaceMarker,
        snippet: text.replace(/\s+/g, " ").trim().slice(0, 160),
        // 0.4.0 composer 回填：user 消息携带全文（revert 后 setDraft 原文）
        fullText: e.type === "user/message" ? text : null,
        time: e.time ?? null,
        turn: (e.data && e.data.turn) ?? null,
      });
    } else if (e.type === "tool/call") {
      const d = e.data || {};
      const name = d.name || (d.call && d.call.name) || "tool";
      messages.push({
        seq: e.seq, type: "tool/call", role: "tool", snippet: `[tool] ${name}`,
        time: e.time ?? null, turn: d.turn ?? null,
      });
    }
  }
  return messages;
}

/**
 * 读取一条 replace surfaceOp 的区间（共用单点，读写端拼写必须一致）。
 * 兼容两种拼写：当前运行时 {op:'replace', startSeq, endSeq} 与
 * dsh-src 较新副本的 {op:'replace', start, end}；其余视为非法返回 null。
 */
export function readReplaceOp(e) {
  const op = e && e.surfaceOp;
  if (!op || typeof op !== "object" || op.op !== "replace") return null;
  const startSeq = Number.isSafeInteger(op.startSeq) ? op.startSeq : op.start;
  const endSeq = Number.isSafeInteger(op.endSeq) ? op.endSeq : op.end;
  if (!Number.isSafeInteger(startSeq) || !Number.isSafeInteger(endSeq)) return null;
  return { startSeq, endSeq };
}

/**
 * 从磁盘事件流推导「被遮蔽」seq 集合：后来发生的 surface replace 事件
 * 遮蔽 [startSeq..endSeq]（append-only：遮蔽仍在日志但不再可见）。
 */
export function computeShadowed(events) {
  const shadowed = new Set();
  for (const e of events) {
    const range = readReplaceOp(e);
    if (!range) continue;
    for (let s = range.startSeq; s <= range.endSeq; s++) shadowed.add(s);
  }
  return shadowed;
}

const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

/**
 * readSessionFile 的异步变体：逐帧解压循环每 framesPerYield 帧向事件循环
 * 让出一次（setImmediate），避免大日志把 GUI 的 tick 卡死数秒。
 * 文件读取与帧边界扫描仍是同步单次系统调用/字节扫描（成本低）；真正昂贵
 * 的 zstdDecompressSync + JSON.parse 在让出点之间执行。
 * @returns {{header, events, frameCount, partial}}
 *   partial：帧数超过 frameBudget（默认 500）时为 true，调用方应向
 *   用户提示「仅完整读取，无截断，但本次请求耗时可能较长」。
 */
export async function readSessionFileAsync(file, { framesPerYield = 8, frameBudget = 500 } = {}) {
  const buf = fs.readFileSync(file);
  const { frames } = scanZstdFrames(buf);
  if (frames.length === 0) throw new Error("empty or header-less session log");
  const events = [];
  let header = null;
  let framesSinceYield = 0;
  for (const f of frames) {
    const text = zstdDecompressSync(buf.subarray(f.start, f.end)).toString("utf8");
    const found = collectHeaderAndEvents(text, events);
    if (!header) header = found;
    if (++framesSinceYield >= framesPerYield) {
      framesSinceYield = 0;
      await yieldToLoop();
    }
  }
  if (!header) throw new Error(`session log ${file}: no {type:"session"} header line in any frame`);
  const bodyFrames = frames.length - 1;
  return { header, events, frameCount: bodyFrames, partial: bodyFrames > frameBudget };
}
