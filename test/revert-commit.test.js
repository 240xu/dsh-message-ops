/**
 * 0.10.1 revert 的 commit 生命周期（对齐 opencode）。
 *
 * 用户反馈：「我把消息改完发出去了，恢复弹窗仍然存在，我不知道它让我恢复到哪去」。
 *
 * opencode 源码（anomalyco/opencode @ dev）核对结论：
 *   core/src/session/session.ts:165
 *     // Commit a staged revert only after preparation succeeds, before admitting new work.
 *     if (session.revert) yield* SessionRevert.commit(bus, session)
 *   → 用户发出下一条消息时**自动 commit**
 *   core/src/session/projector.ts:759 → `DELETE WHERE seq >= boundary.seq` + `revert: null`
 *   app/.../use-session-commands.tsx:287
 *     disabled: !actions.session.data.revertMessageID()
 *   → opencode **没有常驻弹窗**，只有会灰掉的 undo/redo 命令；状态清零 = affordance 消失
 *
 * 我们是 append-only 日志，marker 不会真消失 → 由 markCommitted 自算。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { markCommitted } from '../src/session-file.js'

const marker = (seq, extra = {}) => ({ seq, type: 'system/message', marker: true, ...extra })
const realUser = (seq) => ({ seq, type: 'user/message', sourceKind: 'user' })
const kinded = (seq, sourceKind) => ({ seq, type: 'user/message', sourceKind })

test('未发新消息 → marker 未提交（dock 应该显示）', () => {
  const msgs = [realUser(8), marker(63)]
  markCommitted(msgs)
  assert.equal(msgs[1].committed, false)
})

test('发出下一条真实消息 → marker 已提交（dock 应消失）', () => {
  const msgs = [realUser(8), marker(63), realUser(70)]
  markCommitted(msgs)
  assert.equal(msgs[1].committed, true, '这是用户反馈的核心场景')
})

test('注入行不算提交（否则 background job 落地就会让弹窗自己消失）', () => {
  const injectedKinds = ['tool-jobs', 'agent-instructions', 'runtime-context',
    'skill-catalog', 'subagent-settled', 'model-selection', 'team-message',
    'goal', 'agent-message', 'compact-checkpoint', 'user-approval']
  for (const k of injectedKinds) {
    const msgs = [realUser(8), marker(63), kinded(70, k)]
    markCommitted(msgs)
    assert.equal(msgs[1].committed, false, `${k} 不应触发提交`)
  }
})

test('restore 重放副本不算提交（否则恢复一次弹窗就没了）', () => {
  const msgs = [realUser(8), marker(63), kinded(70, 'plugin:@240xu/dsh-message-ops')]
  markCommitted(msgs)
  assert.equal(msgs[1].committed, false)
})

test('边界之前的真实消息不影响判定', () => {
  const msgs = [realUser(8), realUser(30), marker(63)]
  markCommitted(msgs)
  assert.equal(msgs[2].committed, false, '边界之前的真实消息不该提交它')
})

test('多个 marker 各自独立判定', () => {
  const msgs = [realUser(8), marker(63), realUser(70), marker(80)]
  markCommitted(msgs)
  assert.equal(msgs[1].committed, true, '63 之后有真实消息 → 已提交')
  assert.equal(msgs[3].committed, false, '80 之后没有 → 仍可恢复')
})

test('非 marker 行不被打上 committed（避免污染普通消息）', () => {
  const msgs = [realUser(8), marker(63), realUser(70)]
  markCommitted(msgs)
  assert.ok(!('committed' in msgs[0]))
  assert.ok(!('committed' in msgs[2]))
})

test('activeMarkers 过滤条件（与 client.js 同构）', () => {
  const active = (msgs) => (msgs || []).filter((m) =>
    m.marker && m.sourceKind !== 'compact-checkpoint'
    && m.restoreComplete !== true && m.committed !== true)
  const msgs = [
    { seq: 63, marker: true, committed: false, restoreComplete: false },   // 活跃
    { seq: 70, marker: true, committed: true,  restoreComplete: false },   // 已提交 → 排除
    { seq: 80, marker: true, committed: false, restoreComplete: true },    // 已恢复 → 排除
    { seq: 90, marker: true, sourceKind: 'compact-checkpoint', committed: false, restoreComplete: false },
  ]
  const out = active(msgs)
  assert.equal(out.length, 1)
  assert.equal(out[0].seq, 63)
})

test('源码锁：activeMarkers 必须排 committed', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client.js'), 'utf8')
  const m = src.match(/function activeMarkers[\s\S]{0,2000}?\n {4}\}/)
  assert.ok(m, '找不到 activeMarkers')
  assert.ok(/committed !== true/.test(m[0]), 'activeMarkers 未排除已提交的 marker —— 弹窗会常驻（用户报告的 bug）')
})
