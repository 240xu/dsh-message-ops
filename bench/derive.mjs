#!/usr/bin/env node
/**
 * bench/derive.mjs — 只读离线基准：复现 GET /api/message-ops/messages 的
 * 服务端成本拆解（读文件 → 扫帧 → 解压+解析 → 派生 → 序列化）。
 *
 * 用法：
 *   node bench/derive.mjs            # 跑「最大会话」+「中位会话」各一次
 *   node bench/derive.mjs <path...>  # 显式指定日志文件
 *
 * 纯只读：不写任何文件、不调任何 HTTP、不改缓存状态。
 * 每个会话输出一行 JSON：
 *   fileMB / frames / events / messages / markers
 *   readFileSyncMs / scanFramesMs / decompressParseMs / deriveMs / stringifyMs
 *   totalMs / payloadKB / stallsOver2ms / maxStallMs / p95StallMs / heapUsedMB
 *   opsListColdMs / opsListWarmMs / warmStallsOver2ms / warmMaxStallMs /
 *   cacheMatchesCold   ← 真实 src/index.js opsList 的缓存 miss/hit 对照
 * 事件循环卡顿用 setInterval(…,1) 采样相邻 tick 间隔统计。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { zstdDecompressSync } from "node:zlib";

import { scanZstdFrames, listMessages, computeShadowed, turnBounds, messageText } from "../src/session-file.js";
import { restoreProgress, pendingRestoreTurns } from "../src/ops-core.js";
import { _internals } from "../src/index.js";

const { opsList } = _internals;

// ---------------------------------------------------------------------------
// 事件循环卡顿采样
// ---------------------------------------------------------------------------
class StallSampler {
  constructor() {
    this.samples = [];
    this.last = 0;
    this.timer = null;
  }
  start() {
    this.samples = [];
    this.last = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now();
      this.samples.push(now - this.last);
      this.last = now;
    }, 1);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const s = this.samples.slice().sort((a, b) => a - b);
    const over2 = s.filter((x) => x > 2);
    const p95 = s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * 0.95) - 1))] : 0;
    return {
      stallsOver2ms: over2.length,
      maxStallMs: s.length ? Math.round(s[s.length - 1] * 10) / 10 : 0,
      p95StallMs: Math.round(p95 * 10) / 10,
    };
  }
}

const heapMB = () => Math.round((process.memoryUsage().heapUsed / 1048576) * 10) / 10;

// ---------------------------------------------------------------------------
// 管线（与 src/index.js opsList 的文件派生部分逐段对应）
// ---------------------------------------------------------------------------
/** 与 readSessionFileAsync 同构：每 framesPerYield 帧向事件循环让出一次。 */
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

async function decompressParse(buf, frames, { framesPerYield = 8 } = {}) {
  const events = [];
  let header = null;
  let since = 0;
  for (const f of frames) {
    const text = zstdDecompressSync(buf.subarray(f.start, f.end)).toString("utf8");
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let json;
      try { json = JSON.parse(t); } catch { continue; }
      if (!header && json && typeof json === "object" && json.type === "session") { header = json; continue; }
      events.push(json);
    }
    if (++since >= framesPerYield) { since = 0; await yieldToLoop(); }
  }
  return { header, events };
}

function derive(header, events) {
  const messages = listMessages(events);
  const shadowed = computeShadowed(events);
  const markers = messages.filter((m) => m.marker === true);
  // seqText 惰性：无 marker 不建（与 src/index.js opsList 同口径）
  let seqText = null;
  if (markers.length > 0) {
    seqText = new Map();
    for (const e of events) {
      if (!e || typeof e.seq !== "number") continue;
      if (e.type !== "user/message" && e.type !== "assistant/message") continue;
      const t = messageText(e);
      if (t && t.trim()) seqText.set(e.seq, t.trim().replace(/\s+/g, " ").slice(0, 80));
    }
    for (const m of markers) {
      const prog = restoreProgress(events, m.seq);
      if (!prog) { m.restoreComplete = false; m.pendingTurns = []; continue; }
      m.restoreComplete = prog.complete;
      m.pendingTurns = pendingRestoreTurns(events, m.seq, prog).map((t) => ({
        upTo: t.seqs[t.seqs.length - 1],
        count: t.seqs.length,
        preview: seqText.get(t.turnSeq) || ("#" + t.turnSeq),
      }));
    }
  }
  for (const m of messages) m.shadowed = shadowed.has(m.seq);
  const bounds = turnBounds(events);
  const turnEndSeq = {};
  for (const [turn, seq] of bounds.ends) turnEndSeq[turn] = seq;
  for (const [turn, seq] of bounds.starts) if (!(turn in turnEndSeq)) turnEndSeq[turn] = seq;
  return { messages, shadowed, turnEndSeq, markerCount: markers.length };
}

function buildPayload(header, derived) {
  const visibleNodes = null; // 离线：无 live surface → 走 !shadowed 兜底（与 opsList 相同分支）
  let visibleCount = 0;
  const messages = derived.messages.map((base) => {
    const visible = visibleNodes ? visibleNodes.has(base.seq) : !derived.shadowed.has(base.seq);
    if (visible) visibleCount++;
    return { ...base, visible };
  });
  return {
    ok: true,
    session: { id: header.id, createdAt: header.createdAt, parentSession: header.parentSession ?? null },
    running: false,
    runningSource: "bench",
    total: messages.length,
    visibleCount,
    turnEndSeq: derived.turnEndSeq,
    messages,
  };
}

async function benchFile(file) {
  const sampler = new StallSampler();
  const t0 = performance.now();
  let heapPeak = heapMB();
  sampler.start();

  const buf = fs.readFileSync(file);
  const tRead = performance.now();

  const { frames } = scanZstdFrames(buf);
  const tScan = performance.now();

  const { header, events } = await decompressParse(buf, frames);
  const tParse = performance.now();
  heapPeak = Math.max(heapPeak, heapMB());

  const derived = derive(header, events);
  const tDerive = performance.now();
  heapPeak = Math.max(heapPeak, heapMB());

  const payload = buildPayload(header, derived);
  const json = JSON.stringify(payload);
  const tStringify = performance.now();

  const stalls = sampler.stop();
  const total = performance.now() - t0;

  // —— 对齐 HTTP 路径：真实 opsList 的缓存 miss / hit 各一次（只读）——
  const sid = path.basename(path.dirname(file));
  const ctx = {
    sessions: { get: () => undefined, list: () => [] },
    agents: { get: () => undefined },
    get(n) { return n === "sessions" ? this.sessions : n === "agents" ? this.agents : undefined },
  };
  const tCold0 = performance.now();
  const cold = await opsList(ctx, sid);
  const tCold1 = performance.now();
  // 采样只包住 hit 那一次：miss 的读+解压+派生是另一回事（= totalMs 的成本）
  const s2 = new StallSampler();
  s2.start();
  const warm = await opsList(ctx, sid);
  // 采样窗一直包到响应序列化 —— 这才是 warm HTTP 请求里最长的同步块
  const warmJson = JSON.stringify(warm);
  const tWarm1 = performance.now();
  // 必须先让出事件循环：被 stringify 压住的那次 interval 回调是**排队**的，
  // 直接 clearInterval 会把它一起取消 → stall 被静默吞掉（实测 19ms 的
  // stringify 块曾被记成 2.3ms）。让出一拍后再收采样。
  await new Promise((r) => setTimeout(r, 8));
  const warmStalls = s2.stop();
  if (warmJson.length !== json.length) { /* 与离线路径同长，仅键序可能不同 */ }

  return {
    file: path.basename(path.dirname(file)),
    fileMB: Math.round((buf.length / 1048576) * 100) / 100,
    frames: frames.length,
    events: events.length,
    messages: derived.messages.length,
    markers: derived.markerCount,
    readFileSyncMs: Math.round((tRead - t0) * 10) / 10,
    scanFramesMs: Math.round((tScan - tRead) * 10) / 10,
    decompressParseMs: Math.round((tParse - tScan) * 10) / 10,
    deriveMs: Math.round((tDerive - tParse) * 10) / 10,
    stringifyMs: Math.round((tStringify - tDerive) * 10) / 10,
    totalMs: Math.round(total * 10) / 10,
    payloadKB: Math.round(Buffer.byteLength(json, "utf8") / 102.4) / 10,
    ...stalls,
    heapUsedMB: heapPeak,
    // 缓存路径（真实 src/index.js opsList）：miss = 首次算，hit = 之后每次
    opsListColdMs: Math.round((tCold1 - tCold0) * 10) / 10,
    opsListWarmMs: Math.round((tWarm1 - tCold1) * 10) / 10,
    warmStallsOver2ms: warmStalls.stallsOver2ms,
    warmMaxStallMs: warmStalls.maxStallMs,
    cacheMatchesCold: warmJson === JSON.stringify(cold) && cold.total === derived.messages.length,
    heapAfterCacheMB: null, // 主循环里在离线管线出作用域后回填
    _heapBeforeMB: null,
  };
}

function sessionsRoot() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, "sessions");
}

function listLogs() {
  const root = sessionsRoot();
  const out = [];
  let slugs = [];
  try { slugs = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const s of slugs) {
    if (!s.isDirectory()) continue;
    let ids = [];
    try { ids = fs.readdirSync(path.join(root, s.name), { withFileTypes: true }); } catch { continue; }
    for (const d of ids) {
      if (!d.isDirectory()) continue;
      const dir = path.join(root, s.name, d.name);
      for (const name of ["session.v4.jsonl.zstd", "session.v3.jsonl.zstd", "session.jsonl.zstd"]) {
        const p = path.join(dir, name);
        try { if (fs.statSync(p).isFile()) { out.push(p); break; } } catch { /* next */ }
      }
    }
  }
  return out;
}

const args = process.argv.slice(2);
let targets = args;
if (targets.length === 0) {
  const all = listLogs().map((p) => ({ p, size: fs.statSync(p).size })).sort((a, b) => a.size - b.size);
  if (all.length === 0) {
    console.error("no session logs found under " + sessionsRoot());
    process.exit(1);
  }
  targets = [all[all.length - 1].p, all[Math.floor(all.length / 2)].p];
}

const heapBefore = heapMB();
const rows = [];
for (const t of targets) {
  const row = await benchFile(t);
  row._heapBeforeMB = heapBefore;
  // 离线管线的 buf(11MB)/events(114MB)/payload 已出作用域 —— gc 之后剩下的
  // 常驻堆才等于「基线 + 派生缓存」（raw events 不在其中）。
  if (global.gc) global.gc();
  row.heapAfterCacheMB = global.gc ? heapMB() : null;
  rows.push(row);
  console.log(JSON.stringify(row));
}
