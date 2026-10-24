/**
 * dsh-message-ops — 零依赖测试（node --test）。
 * 覆盖：帧扫描/读写往返、消息列表、遮蔽推导、分支规划与落盘（临时目录）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-msgops-'))

const { scanZstdFrames, readSessionFile, readSessionHeader, encodeSessionFile, findSessionDirs, listMessages, computeShadowed } =
  await import('../src/session-file.js')

const MAGIC = 0xfd2fb528

function header(id) {
  return { type: 'session', version: 3, id, createdAt: Date.now(), cwd: '/tmp/x', delegationDepth: 0 }
}
function msg(type, seq, text) {
  return { type, seq, time: Date.now(), surfaceOp: 'append', data: { turn: 1, step: 1, message: { role: type === 'user/message' ? 'user' : 'assistant', content: [{ type: 'text', text }] } } }
}

function writeLog(dir, header, events) {
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, 'session.v3.jsonl.zstd')
  fs.writeFileSync(p, encodeSessionFile(header, events))
  return p
}

test('zstd 帧扫描定位每个魔数边界', () => {
  const a = encodeSessionFile(header('session-00000000-0000-0000-0000-000000000001'), [msg('user/message', 0, 'hi')])
  const b = encodeSessionFile(header('session-00000000-0000-0000-0000-000000000002'), [msg('user/message', 0, 'yo')])
  const buf = Buffer.concat([a, b])
  const { frames } = scanZstdFrames(buf)
  assert.equal(frames.length, 4) // 2 files × (header frame + event frame)
  for (const f of frames) assert.equal(buf.readUInt32LE(f.start), MAGIC)
})

test('zstd 帧扫描不把压缩载荷内的魔数当成新帧', () => {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const payload = Buffer.alloc(2000, 0x41)
  magic.copy(payload, 10)
  const frame = zstdCompressSync(payload)
  const inside = frame.indexOf(magic, 4)
  assert.ok(inside > 0, 'fixture must contain magic bytes inside the compressed frame')

  const { frames } = scanZstdFrames(frame)
  assert.equal(frames.length, 1)
  assert.equal(frames[0].start, 0)
  assert.equal(frames[0].end, frame.length)
})

test('读写往返：header 与事件完整恢复', () => {
  const events = [
    msg('user/message', 0, '你好'),
    msg('assistant/message', 1, '你好！有什么可以帮你？'),
    { type: 'tool/call', seq: 2, data: { name: 'bash' } },
  ]
  const p = writeLog(path.join(process.env.DSH_HOME, 'sessions', 'proj-a', 'session-00000000-0000-0000-0000-000000000003'), header('session-00000000-0000-0000-0000-000000000003'), events)
  const { header: h, events: evs } = readSessionFile(p)
  assert.equal(h.type, 'session')
  assert.equal(evs.length, 3)
  assert.equal(evs[0].data.message.content[0].text, '你好')
})

test('readSessionHeader only needs the first frame (corrupt body must not block title)', () => {
  const id = 'session-00000000-0000-0000-0000-000000000009'
  const p = writeLog(path.join(process.env.DSH_HOME, 'sessions', 'proj-h', id), header(id), [msg('user/message', 0, 'hi')])
  const buf = fs.readFileSync(p)
  const { frames } = scanZstdFrames(buf)
  const broken = Buffer.from(buf)
  broken[frames[1].start + 10] ^= 0xff
  fs.writeFileSync(p, broken)
  assert.throws(() => readSessionFile(p))
  assert.equal(readSessionHeader(p).id, id)
})

test('listMessages 提取 role/snippet 与 tool 摘要', () => {
  const events = [msg('user/message', 0, '  多  空格\n文本 '), msg('assistant/message', 1, '回复'), { type: 'tool/call', seq: 2, data: { name: 'bash' } }]
  const ms = listMessages(events)
  assert.equal(ms.length, 3)
  assert.equal(ms[0].role, 'user')
  assert.equal(ms[0].snippet, '多 空格 文本')
  assert.equal(ms[2].role, 'tool')
  assert.match(ms[2].snippet, /\[tool\] bash/)
})

test('listMessages 标记 message-ops 合成 turn', () => {
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 2, reason: 'message-ops' } },
    { type: 'system/message', seq: 1, surfaceOp: 'append', data: { turn: 2, step: 1, message: { role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: '[消息回滚] x' }] } } },
    { type: 'turn/end', seq: 2, data: { turn: 2, reason: { kind: 'completed' } } },
    msg('user/message', 3, 'real'),
  ]
  const ms = listMessages(events)
  assert.equal(ms.find((m) => m.seq === 1).syntheticTurn, true)
  assert.equal(ms.find((m) => m.seq === 3).syntheticTurn, undefined)
})

test('computeShadowed 识别 surface replace 遮蔽区间', () => {
  const events = [
    msg('user/message', 0, 'a'),
    msg('assistant/message', 1, 'b'),
    msg('user/message', 2, 'c'),
    { type: 'system/message', seq: 3, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 }, data: { message: { role: 'system', content: [{ type: 'text', text: '[回滚]' }] } } },
  ]
  const shadowed = computeShadowed(events)
  assert.ok(shadowed.has(1) && shadowed.has(2))
  assert.ok(!shadowed.has(0))
})



test('findSessionDirs 两种 id 拼写均可定位', () => {
  const uuid = '11111111-2222-3333-4444-555555555555'
  writeLog(path.join(process.env.DSH_HOME, 'sessions', 'proj-c', `session-${uuid}`), header(`session-${uuid}`), [msg('user/message', 0, 'x')])
  const byFull = findSessionDirs(`session-${uuid}`)
  const byBare = findSessionDirs(uuid)
  assert.equal(byFull.length, 1)
  assert.equal(byBare.length, 1)
  assert.equal(byFull[0].dir, byBare[0].dir)
})
