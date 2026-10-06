import test from "node:test";
import assert from "node:assert/strict";
import { planRestore, applyRestore, restoreProgress, pendingRestoreTurns } from "../src/ops-core.js";

// 构造：标记(20) 遮蔽 11..15；其中 11(user) 12(assistant) 13(user) 14(assistant) 15(tool)
function fixtures() {
  const events = [];
  const mk = (seq, type, text, extra) => Object.assign({
    seq, type, time: 1700000000000 + seq,
    data: { turn: 1, step: 1, message: { id: "m" + seq, role: type === "assistant/message" ? "assistant" : "user", source: { kind: "chat" }, content: [{ type: "text", text }] } },
    surfaceOp: "append",
  }, extra || {});
  events.push(mk(11, "user/message", "U1"));
  events.push(mk(12, "assistant/message", "A1"));
  events.push(mk(13, "user/message", "U2"));
  events.push(mk(14, "assistant/message", "A2"));
  events.push({ seq: 15, type: "tool/result", time: 1700000000015, data: { turn: 1, step: 1, message: { id: "m15", role: "tool", source: { kind: "tool" }, content: [{ type: "text", text: "T" }] } }, surfaceOp: "append" });
  events.push({
    seq: 20, type: "system/message", time: 1700000000020,
    data: { turn: 1, step: 1, message: { id: "mk20", role: "system", source: { kind: "system-prompt" }, content: [{ type: "text", text: "marker" }] } },
    surfaceOp: { op: "replace", startSeq: 11, endSeq: 15 },
    sourceEventSeqs: [11, 12, 13, 14, 15],
  });
  return events;
}

test("0.8.0 planRestore(upToSeq) 只重放到该 seq（按轮步进）", () => {
  const events = fixtures();
  const full = planRestore(events, 20);
  assert.deepEqual(full.replayable.map((i) => i.seq), [11, 12, 13, 14]);
  const step1 = planRestore(events, 20, 12); // 只到第一轮结束
  assert.deepEqual(step1.replayable.map((i) => i.seq), [11, 12], "upToSeq=12 → 只重放 11/12");
  assert.equal(step1.upToSeq, 12);
});

test("0.8.0 applyRestore 的 notice 带 restoredSourceSeqs", () => {
  const events = fixtures();
  const plan = planRestore(events, 20, 12);
  const appended = [];
  const fake = { append: (type, data) => { const e = { seq: 100 + appended.length, type, data }; appended.push(e); return e } };
  const r = applyRestore(fake, plan, {});
  assert.equal(r.restoredCount, 2);
  assert.equal(appended[0].type, "system/message");
  assert.equal(appended[0].data.restoresSeq, 20);
  assert.deepEqual(appended[0].data.restoredSourceSeqs, [11, 12]);
});

test("0.8.0 restoreProgress：部分恢复后仍未完成，pending 为剩余轮", () => {
  const events = fixtures();
  const before = restoreProgress(events, 20);
  assert.equal(before.complete, false, "无 notice → 未完成");
  assert.deepEqual(before.pendingSeqs, [11, 12, 13, 14]);

  // 加一条只恢复了 11/12 的 notice
  events.push({
    seq: 30, type: "system/message", time: 1700000000030,
    data: { turn: 1, step: 1, message: { id: "m30", role: "system", source: { kind: "system-prompt" }, content: [{ type: "text", text: "notice" }] }, restoresSeq: 20, restoredSourceSeqs: [11, 12] },
    surfaceOp: "append",
  });
  const mid = restoreProgress(events, 20);
  assert.equal(mid.complete, false, "部分恢复 → 仍活跃");
  assert.deepEqual(mid.restoredSeqs, [11, 12]);
  assert.deepEqual(mid.pendingSeqs, [13, 14]);
  const turns = pendingRestoreTurns(events, 20);
  assert.deepEqual(turns, [{ turnSeq: 13, seqs: [13, 14] }], "剩余一轮：U2 + A2");

  // 再补一条恢复 13/14
  events.push({
    seq: 31, type: "system/message", time: 1700000000031,
    data: { turn: 1, step: 1, message: { id: "m31", role: "system", source: { kind: "system-prompt" }, content: [{ type: "text", text: "notice" }] }, restoresSeq: 20, restoredSourceSeqs: [13, 14] },
    surfaceOp: "append",
  });
  const done = restoreProgress(events, 20);
  assert.equal(done.complete, true, "全部重放完 → 标记不再活跃");
  assert.deepEqual(pendingRestoreTurns(events, 20), []);
});

test("0.8.0 兼容旧通知（无 restoredSourceSeqs）→ 视为整段已恢复", () => {
  const events = fixtures();
  events.push({
    seq: 40, type: "system/message", time: 1700000000040,
    data: { turn: 1, step: 1, message: { id: "m40", role: "system", source: { kind: "system-prompt" }, content: [{ type: "text", text: "legacy notice" }] }, restoresSeq: 20 },
    surfaceOp: "append",
  });
  const p = restoreProgress(events, 20);
  assert.equal(p.legacy, true);
  assert.equal(p.complete, true, "旧通知 → 整段视为已恢复（向后兼容）");
});

test("0.8.0 B1：planRestore(excludeSeqs) 排除已重放，杜绝副本刷屏", () => {
  const events = fixtures();
  const p = planRestore(events, 20, 14, [11, 12]);
  assert.deepEqual(p.replayable.map((i) => i.seq), [13, 14], "已重放的 11/12 不再重放");
  const all = planRestore(events, 20, 23, [11, 12, 13, 14]);
  assert.deepEqual(all.replayable.map((i) => i.seq), [], "全部已重放 → 空计划（只补 notice）");
});
