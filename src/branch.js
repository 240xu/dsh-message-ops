/**
 * dsh-message-ops — 消息分支（fork）：把会话从某条消息处派生为新会话。
 *
 * 磁盘级、零破坏：读原日志 → 过滤 seq<=upToSeq 的事件 → 以新 session id
 * 写入同 project 目录下的新会话目录。原会话日志一个字节都不动。
 * 新 header 携带 parentSession=<原 id>，保留 cwd / agentPreset / version，
 * 便于溯源与 UI 关联展示。分支是本插件唯一的非破坏操作，无需风险确认。
 * @module dsh-message-ops/branch
 */

import fs from "node:fs";
import path from "node:path";
import { readSessionFile, encodeSessionFile, newSessionId } from "./session-file.js";

/**
 * 纯函数：从 {header, events} 规划分支产物（不碰磁盘，便于测试）。
 * @param {{id:string, version?:number, cwd?:string, agentPreset?:string, delegationDepth?:number}} header
 * @param {object[]} events 全部事件（含 seq）
 * @param {number} upToSeq 保留到哪条（含）
 * @returns {{header: object, events: object[]}} 新会话的 header 与事件
 */
export function planBranch(header, events, upToSeq) {
  if (!header || header.type !== "session") throw new Error("invalid session header");
  if (!Number.isSafeInteger(upToSeq) || upToSeq < 0) throw new Error("invalid upToSeq");
  const kept = events.filter((e) => e && typeof e.seq === "number" && e.seq <= upToSeq);
  if (kept.length === 0) throw new Error("no events at or before upToSeq");
  const newHeader = {
    ...header,
    id: newSessionId(),
    createdAt: Date.now(),
    parentSession: header.id,
  };
  delete newHeader.isSeeded;
  return { header: newHeader, events: kept };
}

/**
 * 落盘：在同 project 目录下创建 <newId>/session.v3.jsonl.zstd。
 * @returns {{newId: string, dir: string, logPath: string, keptEvents: number}}
 */
export function applyBranch(logPath, upToSeq) {
  const { header, events } = readSessionFile(logPath);
  const { header: newHeader, events: kept } = planBranch(header, events, upToSeq);
  const dir = path.dirname(path.resolve(logPath));
  const newDir = path.join(path.dirname(dir), newHeader.id);
  fs.mkdirSync(newDir, { recursive: true });
  const newLogPath = path.join(newDir, "session.v3.jsonl.zstd");
  const buf = encodeSessionFile(newHeader, kept);
  // 原子写：先写临时名再 rename，避免半写日志被会话扫描读到。
  const tmpPath = newLogPath + ".tmp-messageops";
  fs.writeFileSync(tmpPath, buf);
  fs.renameSync(tmpPath, newLogPath);
  return { newId: newHeader.id, dir: newDir, logPath: newLogPath, keptEvents: kept.length };
}
