/**
 * 0.9.3 /undo 的纯逻辑回归。
 *
 * /undo 走官方斜杠管线 `ctx.inputTriggers.registerSource`，注册路径踩过四个坑，
 * 全部锁在这里（宿主侧的契约坑无法用单测覆盖，故此文件锁「我方判定」那一半）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const bare = (id) => String(id || '').replace(/^session-/, '')
const pickLastVisible = (rows) => {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i] && rows[i].seq != null && rows[i].visible) return rows[i]
  return null
}
const shouldHide = (cands, fences, reverted) =>
  fences.length ? cands.some((q) => fences.some((f) => q >= f)) : cands.some((q) => reverted.has(q))

test('sessionId 归一化：DOM dataset 带 session- 前缀', () => {
  assert.equal(bare('session-0da37218-2672-48b7-adaa-7735af4adee2'), '0da37218-2672-48b7-adaa-7735af4adee2')
  assert.equal(bare('0da37218-2672'), '0da37218-2672')
  assert.equal(bare(null), '')
})

test('回归：__currentSessionId 带前缀会让 API 请求静默失败', () => {
  // 送 "session-<uuid>" 给 /api/message-ops/revert 会落不到会话目录
  assert.notEqual(bare('session-x'), 'session-x')
})

test('lastRevertable 必须挑 surface 上的那条', () => {
  const rows = [
    { seq: 8, visible: true },
    { seq: 54, visible: true },
    { seq: 70, visible: false },   // restore 重放副本：不在模型 surface 上
  ]
  // 无脑取最后一条 → 70 → 服务端报 "start seq 70 not found in surface"（实测���
  assert.equal(rows[rows.length - 1].seq, 70)
  // 正确：取最后一条 visible
  assert.equal(pickLastVisible(rows).seq, 54)
})

test('没有 surface 上的用户消息 → 返回 null，不发请求', () => {
  assert.equal(pickLastVisible([{ seq: 8, visible: false }]), null)
  assert.equal(pickLastVisible([]), null)
})

test('fence 判定：边界及其后都藏', () => {
  assert.equal(shouldHide([8], [8], new Set()), true)
  assert.equal(shouldHide([7], [8], new Set()), false)
  assert.equal(shouldHide([70], [70, 8], new Set()), true, '多个 fence 取并集')
  assert.equal(shouldHide([54], [70, 8], new Set()), true)
  assert.equal(shouldHide([7], [70, 8], new Set()), false)
})

test('fence 为空时退回 reverted 集合', () => {
  assert.equal(shouldHide([54], [], new Set([54, 63])), true)
  assert.equal(shouldHide([8], [], new Set([54, 63])), false)
})

test('空 fences + 空 reverted → 全部可见', () => {
  assert.equal(shouldHide([1, 2, 3], [], new Set()), false)
})
