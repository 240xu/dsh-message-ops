/**
 * Compact payload + per-session search contract (TDD).
 *
 * The panel must not download fullText for every row (190 KB for 543 rows),
 * but search must still match text beyond the 160-char list snippet.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { _internals } from '../src/index.js'
import { encodeSessionFile } from '../src/session-file.js'

const SID = 'session-33333333-3333-4333-8333-333333333333'

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mops-search-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const dir = path.join(home, 'sessions', '--tmp-project--', SID)
  fs.mkdirSync(dir, { recursive: true })
  const header = { type: 'session', id: SID, version: 4, createdAt: 1790000000000 }
  const events = [
    {
      type: 'user/message', seq: 1, time: 1,
      data: { id: 'u1', source: { kind: 'user' }, message: { role: 'user', content: [{ type: 'text', text: 'hello world' }] } },
    },
    {
      type: 'assistant/message', seq: 2, time: 2,
      data: { id: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'A'.repeat(300) }, { type: 'text', text: 'needle-inside the long answer' }] } },
    },
    { type: 'tool/call', seq: 3, time: 3, data: { name: 'web_search', callId: 'c1' } },
    {
      type: 'system/message', seq: 4, time: 4,
      surfaceOp: { op: 'replace', startSeq: 2, endSeq: 3 },
      data: { id: 'm1', message: { role: 'system', content: [] } },
    },
  ]
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), encodeSessionFile(header, events))

  t.after(() => {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    fs.rmSync(home, { recursive: true, force: true })
  })
  return { ctx: { get: () => undefined } }
}

test('compact view drops heavy fields but keeps visibility state and counts', async (t) => {
  const { ctx } = setup(t)
  const full = await _internals.opsList(ctx, SID)
  const compact = await _internals.opsList(ctx, SID, { compact: true })

  assert.equal(full.ok, true)
  assert.equal(compact.ok, true)
  assert.equal(compact.messages.length, 4)
  assert.equal(typeof full.messages[0].fullText, 'string')
  assert.equal(compact.messages[0].fullText, undefined, 'compact must not carry fullText')
  assert.equal(compact.messages[0].turn, undefined, 'compact must not carry turn')
  assert.equal(compact.messages[0].step, undefined, 'compact must not carry step')
  // 0.14.0：range / marker 从「重字段」改为**必需字段** —— dock 靠它们区分
  // 「这行是 marker」并显示它遮蔽的区间。不带的话客户端只能拿 marker 自己的
  // seq 当恢复目标，产生自噬记录（实测 5 条）。它们是小对象/布尔，不属重字段。
  assert.ok('range' in compact.messages[0], 'compact must carry range for marker rows (dock target fix)')
  assert.ok('marker' in compact.messages[0], 'compact must carry the marker flag (dock filtering)')
  assert.equal(compact.messages[0].sourceKind, undefined, 'compact must not carry sourceKind')
  assert.equal(compact.messages[0].id, undefined, 'compact must not carry message ids')
  assert.equal(compact.messages[0].type, undefined, 'compact must not carry event type')
  assert.equal(compact.messages[0].marker, false, '非 marker 行必须是显式 false（不是 undefined）')
  assert.equal(compact.messages[0].restoresSeq, undefined, 'compact must not carry per-row restore pointers')
  // 0.12.0：分叉边界要按轮切，所以 compact 必须带 turnStartSeq 字段。
  // 该 fixture 没有 turn/start 事件 → 值必须是显式 null（不是 undefined），
  // 让客户端能区分「没有这个字段」与「这条消息不在任何 turn 里」。
  assert.ok('turnStartSeq' in compact.messages[0], 'compact 必须带 turnStartSeq，否则客户端只能退回 seq-1')
  assert.equal(compact.messages[0].turnStartSeq, null, '无 turn 结构时必须是 null，不能是 undefined')
  assert.equal(compact.messages[1].shadowed, true)
  assert.equal(compact.messages[2].shadowed, true)
  assert.equal(compact.shadowedCount, 2)
  assert.equal(compact.markerCount, 1)
  assert.equal(compact.visibleCount, 2)
  assert.equal(compact.session.confirmTitle, SID, 'untitled sessions confirm by session id')
})

test('search matches full text beyond the 160-char snippet', async (t) => {
  const { ctx } = setup(t)
  const result = await _internals.opsSearch(ctx, SID, 'needle-inside')
  assert.equal(result.ok, true)
  assert.equal(result.total, 1)
  assert.equal(result.results[0].seq, 2)
  assert.equal(result.results[0].role, 'assistant')
  assert.equal(result.results[0].shadowed, true)
  assert.ok(result.results[0].snippet.includes('needle-inside'))
  assert.ok(result.results[0].snippet.length <= 160)
})

test('search supports role filtering and limit metadata', async (t) => {
  const { ctx } = setup(t)
  const assistant = await _internals.opsSearch(ctx, SID, 'needle', { role: 'assistant' })
  const user = await _internals.opsSearch(ctx, SID, 'needle', { role: 'user' })
  assert.equal(assistant.total, 1)
  assert.equal(user.total, 0)
  const limited = await _internals.opsSearch(ctx, SID, 'A', { limit: 1 })
  assert.equal(limited.results.length, 1)
  assert.equal(limited.truncated, true)
})

test('search rejects empty and overlong queries', async (t) => {
  const { ctx } = setup(t)
  await assert.rejects(() => _internals.opsSearch(ctx, SID, '  '), (e) => e.status === 400)
  await assert.rejects(() => _internals.opsSearch(ctx, SID, 'x'.repeat(501)), (e) => e.status === 400)
})

test('compact 的 turnStartSeq 精确指向该消息所在 turn 的 turn/start', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mops-turn-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    fs.rmSync(home, { recursive: true, force: true })
  })
  const dir = path.join(home, 'sessions', '--tmp-project--', SID)
  fs.mkdirSync(dir, { recursive: true })
  const header = { type: 'session', id: SID, version: 4, createdAt: 1790000000000 }
  // 真实形状：turn/start → agent/inbox/spliced → step/start → system/message → user/message
  const events = [
    { type: 'turn/start', seq: 4, time: 4, data: { turn: 1 } },
    { type: 'agent/inbox/spliced', seq: 5, time: 5, data: {} },
    { type: 'step/start', seq: 6, time: 6, data: { turn: 1, step: 1 } },
    { type: 'system/message', seq: 7, time: 7, data: { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: 'sys' }] } } },
    { type: 'user/message', seq: 8, time: 8, data: { id: 'u1', turn: 1, source: { kind: 'user' }, message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } } },
    { type: 'turn/end', seq: 9, time: 9, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', seq: 10, time: 10, data: { turn: 2 } },
    { type: 'step/start', seq: 11, time: 11, data: { turn: 2, step: 1 } },
    { type: 'user/message', seq: 12, time: 12, data: { id: 'u2', turn: 2, source: { kind: 'user' }, message: { role: 'user', content: [{ type: 'text', text: 'again' }] } } },
  ]
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), encodeSessionFile(header, events))
  const ctx = { get: () => undefined }
  const compact = await _internals.opsList(ctx, SID, { compact: true })
  const u1 = compact.messages.find((m) => m.seq === 8)
  const u2 = compact.messages.find((m) => m.seq === 12)
  assert.equal(u1.turnStartSeq, 4, 'turn 1 的消息必须指向 seq 4 的 turn/start')
  assert.equal(u2.turnStartSeq, 10, 'turn 2 的消息必须指向 seq 10 的 turn/start')
  // 边界 = turnStartSeq - 1 → 切在上一轮 turn/end（seq 9），不是 turn 内部
  assert.equal(u2.turnStartSeq - 1, 9, '按轮切：turn 2 的分叉边界应落在 turn 1 的 turn/end')
})
