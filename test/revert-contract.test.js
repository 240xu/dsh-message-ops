/**
 * 契约测试：revert / restore 写出的事件必须通过 **dsh 官方三层闸**。
 *
 * 三层缺一不可（每一层都真实咬过人）：
 *  1. 格式层  assertV4RowAdmission + restoreReleasedV4Artifact
 *  2. 运行时层 role 匹配 / source.kind 非空 / system/message 必须 system-prompt
 *  3. UI 层   turn/end.data.reason 必填（trajectory 装配器无防护读 reason.kind，
 *             缺字段 → TypeError → 整个会话页白屏）
 *
 * 只查第 1 层会得到「全绿但 UI 崩」的假象（0.8.x 实机踩过）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { zstdCompressSync, constants as zlibConstants } from 'node:zlib'
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'

// Optional local contract fixtures. CI does not ship sessionfix; these tests
// are skipped there rather than hard-failing on a machine-specific path.
const SEQ_IMPL = process.env.SESSIONFIX_SEQCORE ?? new URL('../../sessionfix/lib/seqcore.js', import.meta.url).href
const GATE_IMPL = process.env.SESSIONFIX_V4GATE ?? new URL('../../sessionfix/lib/v4gate.mjs', import.meta.url).href
let decodeFrames, parseRows, officialValidate
try {
  ({ decodeFrames, parseRows } = await import(SEQ_IMPL))
  ;({ officialValidate } = await import(GATE_IMPL))
} catch {
  decodeFrames = parseRows = officialValidate = undefined
}
const contractSkip = process.env.SESSIONFIX_CONTRACT !== '1'
  ? 'optional sessionfix contract tests; set SESSIONFIX_CONTRACT=1 to run'
  : (decodeFrames === undefined ? 'sessionfix contract fixtures not available' : false)
import {
  planNoticeWindow, noticeWindowPreamble, noticeWindowPostamble,
  buildMarkerEvent, buildRestoreNoticeEvent, buildReplayEvent, planRestore, restoreProgress,
} from '../src/ops-core.js'

const HEADER = { type: 'session', version: 4, id: 'contract-test', createdAt: 1, isSeeded: false, delegationDepth: 0 }

const compressFrame = (text) => zstdCompressSync(Buffer.from(text), {
  params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 },
})

/** 与宿主一致：header 单独一帧（帧 0 恰一行），事件后续帧承载。 */
const pack = (events) => Buffer.concat([
  compressFrame(JSON.stringify(HEADER) + '\n'),
  compressFrame(events.map((e) => JSON.stringify(e)).join('\n') + '\n'),
])

/** 空闲会话骨架：turn 1 已闭合，turn 2 是合成的 notice 窗口 */
function idleSessionBase() {
  return [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'system/message', data: { turn: 1, step: 1, message: { id: 'sys0', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'sys' }] } }, surfaceOp: 'append' },
    { type: 'user/message', data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '问题一' }] }, surfaceOp: 'append' },
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'contract-test', model: 'contract-test' }, content: [{ type: 'text', text: '答一' }] } }, surfaceOp: 'append' },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ].map((e, i) => ({ ...e, seq: i, time: 1000 + i }))
}

test('契约：合成窗口承载的 revert marker 通过官方三层闸', { skip: contractSkip }, () => {
  const base = idleSessionBase()
  const win = planNoticeWindow(base)
  assert.equal(win.synthetic, true, '空闲会话应规划合成窗口')
  assert.equal(win.turn, 2, '合成 turn 应为 maxTurn+1')

  let cursor = base.length, t = 5000
  const events = [...base]
  for (const pre of noticeWindowPreamble(win)) events.push({ type: pre.kind, seq: cursor++, time: t++, data: pre.data })
  events.push(buildMarkerEvent({
    seq: cursor++, time: t++, turnStep: { turn: win.turn, step: win.step },
    text: '[消息回滚] 测试', version: 4, startSeq: 3, endSeq: 4, shadowedSeqs: [3, 4],
  }))
  for (const post of noticeWindowPostamble(win)) events.push({ type: post.kind, seq: cursor++, time: t++, data: post.data })

  const v = officialValidate(pack(events))
  assert.ok(v.ok, `官方三层闸拒绝：${v.error}`)
  assert.equal(v.events, events.length)
})

test('契约：合成窗口以 completed 收尾，避免 UI 显示“已停止”', { skip: contractSkip }, () => {
  const win = { synthetic: true, turn: 9, step: 1 }
  const post = noticeWindowPostamble(win)
  const turnEnd = post.find((e) => e.kind === 'turn/end')
  assert.ok(turnEnd, '缺少 turn/end 后缀')
  assert.ok(turnEnd.data.reason, 'turn/end 缺 data.reason → UI 装配器崩')
  assert.equal(turnEnd.data.reason.kind, 'completed')
})

test('契约：缺 reason 的 turn/end 会被官方闸拦下（回归证明这条规则有效）', { skip: contractSkip }, () => {
  const base = idleSessionBase()
  const bad = [...base, { type: 'turn/start', seq: base.length, time: 6000, data: { turn: 2 } },
    { type: 'step/start', seq: base.length + 1, time: 6001, data: { turn: 2, step: 1 } },
    { type: 'system/message', seq: base.length + 2, time: 6002, data: { turn: 2, step: 1, message: { id: 'n', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'x' }] } }, surfaceOp: 'append' },
    { type: 'step/end', seq: base.length + 3, time: 6003, data: { turn: 2, step: 1 } },
    { type: 'turn/end', seq: base.length + 4, time: 6004, data: { turn: 2 } }] // ← 缺 reason
  const v = officialValidate(pack(bad))
  assert.equal(v.ok, false, '缺 reason 竟然通过了 —— UI 层规则失效')
  assert.match(v.error, /reason/, `错误信息应指向 reason，实际：${v.error}`)
})

test('契约：完整 restore 链路（notice + 重放）通过官方三层闸', { skip: contractSkip }, () => {
  const base = idleSessionBase()
  let cursor = base.length, t = 5000
  const win = planNoticeWindow(base)
  const afterRevert = [...base]
  for (const pre of noticeWindowPreamble(win)) afterRevert.push({ type: pre.kind, seq: cursor++, time: t++, data: pre.data })
  const marker = buildMarkerEvent({ seq: cursor++, time: t++, turnStep: { turn: win.turn, step: win.step }, text: '[消息回滚]', version: 4, startSeq: 3, endSeq: 4, shadowedSeqs: [3, 4] })
  afterRevert.push(marker)
  for (const post of noticeWindowPostamble(win)) afterRevert.push({ type: post.kind, seq: cursor++, time: t++, data: post.data })
  assert.ok(officialValidate(pack(afterRevert)).ok, 'revert 产物不合法')

  // restore：重新规划窗口（上一个已被占用）
  const win2 = planNoticeWindow(afterRevert)
  const plan = planRestore(afterRevert, marker.seq, undefined, restoreProgress(afterRevert, marker.seq)?.restoredSeqs ?? null)
  plan.turnStep = { turn: win2.turn, step: win2.step }
  const afterRestore = [...afterRevert]
  for (const pre of noticeWindowPreamble(win2)) afterRestore.push({ type: pre.kind, seq: cursor++, time: t++, data: pre.data })
  afterRestore.push(buildRestoreNoticeEvent({ seq: cursor++, time: t++, turnStep: plan.turnStep, version: 4, text: '[消息恢复]', restoreSeq: plan.restoreSeq }))
  let off = 0
  for (const item of plan.replayable) afterRestore.push(buildReplayEvent({ seq: cursor++, time: t + (++off), item, turnStep: plan.turnStep, version: 4 }))
  for (const post of noticeWindowPostamble(win2)) afterRestore.push({ type: post.kind, seq: cursor++, time: t + off + (off++), data: post.data })

  const v = officialValidate(pack(afterRestore))
  assert.ok(v.ok, `restore 产物被官方闸拒绝：${v.error}`)
})

test('契约：buildReplayEvent 缺 turnStep 必须抛错（绝不静默落 1/1）', () => {
  assert.throws(
    () => buildReplayEvent({ seq: 1, time: 1, item: { type: 'assistant/message', role: 'assistant', text: 'z' } }),
    (e) => e.status === 500,
  )
  assert.throws(
    () => buildReplayEvent({ seq: 1, time: 1, turnStep: { turn: 0, step: 1 }, item: { type: 'assistant/message', role: 'assistant', text: 'z' } }),
    (e) => e.status === 500,
  )
})

test('planNoticeWindow：turn 已开但 step 未开时拒绝合成（防重号/防非法嵌套）', () => {
  assert.throws(
    () => planNoticeWindow([{ type: 'turn/start', seq: 0, data: { turn: 7 } }]),
    (e) => e.status === 409 && /between steps/.test(e.message),
  )
  const closed = [{ type: 'turn/start', seq: 0, data: { turn: 7 } }, { type: 'turn/end', seq: 1, data: { turn: 7, reason: { kind: 'completed' } } }]
  assert.equal(planNoticeWindow(closed).turn, 8)
})

test('buildMarkerEvent：嵌套/重复 sourceEventSeqs 必须摊平去重', () => {
  const ev = buildMarkerEvent({
    seq: 20, time: 1, turnStep: { turn: 2, step: 1 }, text: 'x',
    startSeq: 3, endSeq: 9, shadowedSeqs: [[3, 6], 6, 7, [9]],
  })
  assert.deepEqual(ev.sourceEventSeqs, [3, 6, 7, 9])
})
