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
  assert.equal(compact.messages[0].range, undefined, 'compact must not carry range')
  assert.equal(compact.messages[0].sourceKind, undefined, 'compact must not carry sourceKind')
  assert.equal(compact.messages[0].id, undefined, 'compact must not carry message ids')
  assert.equal(compact.messages[0].type, undefined, 'compact must not carry event type')
  assert.equal(compact.messages[0].marker, undefined, 'compact must not carry per-row marker flags')
  assert.equal(compact.messages[0].restoresSeq, undefined, 'compact must not carry per-row restore pointers')
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
