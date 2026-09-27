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
 * 读取会话日志 → { header, events }。撕裂的最终帧按宿主同款
 * 「完整前缀」语义忽略（完整帧全部恢复）。
 */
export function readSessionFile(file) {
  const buf = fs.readFileSync(file);
  const { frames } = scanZstdFrames(buf);
  if (frames.length === 0) throw new Error("empty or header-less session log");
  const headerText = zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end)).toString("utf8");
  const header = JSON.parse(headerText.trim());
  if (header.type !== "session") throw new Error("first frame is not a session header");
  const events = [];
  for (const f of frames.slice(1)) {
    const text = zstdDecompressSync(buf.subarray(f.start, f.end)).toString("utf8");
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try { events.push(JSON.parse(t)); } catch { /* torn record: skip */ }
    }
  }
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
      const logPath = path.join(dir, "session.v3.jsonl.zstd");
      try { fs.statSync(logPath); } catch { continue; }
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
      const msg = e.data && e.data.message;
      const content = msg && Array.isArray(msg.content) ? msg.content : (e.data && e.data.content);
      let text = "";
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c && c.type === "text" && typeof c.text === "string" && c.text.trim()) {
            text = c.text; break;
          }
        }
      }
      messages.push({
        seq: e.seq,
        type: e.type,
        role: (msg && msg.role) || (e.type === "user/message" ? "user" : e.type === "assistant/message" ? "assistant" : "system"),
        snippet: text.replace(/\s+/g, " ").trim().slice(0, 160),
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
  const headerText = zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end)).toString("utf8");
  const header = JSON.parse(headerText.trim());
  if (header.type !== "session") throw new Error("first frame is not a session header");
  const events = [];
  const bodyFrames = frames.slice(1);
  let framesSinceYield = 0;
  for (const f of bodyFrames) {
    const text = zstdDecompressSync(buf.subarray(f.start, f.end)).toString("utf8");
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try { events.push(JSON.parse(t)); } catch { /* torn record: skip */ }
    }
    if (++framesSinceYield >= framesPerYield) {
      framesSinceYield = 0;
      await yieldToLoop();
    }
  }
  return { header, events, frameCount: bodyFrames.length, partial: bodyFrames.length > frameBudget };
}
