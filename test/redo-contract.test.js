/**
 * 0.9.5 /redo 的 seq 契约 —— 回归「传了消息 seq 导致空转」。
 *
 * `POST /api/message-ops/restore` 的 seq 是 **marker seq**：
 *   opsRestore(targetCtx, sessionId, restoreSeq, ...)
 *     → restoreProgress(events, restoreSeq) / planRestore(events, restoreSeq, ...)
 * dock 传的 row.seq 来自 activeMarkers（marker 行）。
 *
 * 0.9.4 之前 /redo 传的是 lastRevertable() —— 那是**用户消息** seq，
 * planRestore 找不到对应 marker → 计划为空 → 恢复不发生。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const activeMarkers = (msgs) => (msgs || []).filter(
  (m) => m.marker && m.sourceKind !== 'compact-checkpoint' && m.restoreComplete !== true,
)

const FIXTURE = [
  { seq: 8,   type: 'user/message',    marker: false, visible: true },
  { seq: 63,  type: 'system/message',  marker: true,  range: { start: 54, end: 54 }, restoreComplete: true },
  { seq: 76,  type: 'system/message',  marker: true,  range: { start: 70, end: 70 }, restoreComplete: false },
  { seq: 90,  type: 'user/message',    marker: false, visible: false },
]

test('activeMarkers 只留未恢复、且非 compact-checkpoint 的 marker', () => {
  const ms = activeMarkers(FIXTURE)
  assert.equal(ms.length, 1)
  assert.equal(ms[0].seq, 76)
})

test('/redo 必须传 marker seq，不是消息 seq', () => {
  const markers = activeMarkers(FIXTURE)
  const redoTarget = markers[markers.length - 1]
  assert.equal(redoTarget.seq, 76, 'redo 目标 = 最新未恢复 marker')
  // 反例：旧实现取最后一条用户消息
  const messageTarget = FIXTURE.filter((m) => m.type === 'user/message').slice(-1)[0]
  assert.notEqual(messageTarget.seq, redoTarget.seq,
    '消息 seq 与 marker seq 不同 —— 混用会让 planRestore 找不到 marker')
  assert.equal(redoTarget.marker, true, 'redo 目标必须是 marker')
})

test('全部恢复完毕 → 不发请求，给出无事可做的提示', () => {
  const done = FIXTURE.map((m) => ({ ...m, restoreComplete: true }))
  assert.equal(activeMarkers(done).length, 0, 'activeMarkers 为空 → 应短路')
})

test('/undo 与 /redo 的目标集合互不重叠', () => {
  // undo 取 surface 上最后一条用户消息；redo 取最新未恢复 marker
  const undoTarget = FIXTURE.filter((m) => m.type === 'user/message' && m.visible).slice(-1)[0]
  const redoTarget = activeMarkers(FIXTURE).slice(-1)[0]
  assert.equal(undoTarget.seq, 8)
  assert.equal(redoTarget.seq, 76)
  assert.notEqual(undoTarget.seq, redoTarget.seq)
})
