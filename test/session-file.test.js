/**
 * dsh-message-ops — 零依赖测试（node --test）。
 * 覆盖：帧扫描/读写往返、消息列表、遮蔽推导、分支规划与落盘（临时目录）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-msgops-'))

const { scanZstdFrames, readSessionFile, encodeSessionFile, findSessionDirs, listMessages, computeShadowed } =
  await import('../src/session-file.js')
const { planBranch, applyBranch } = await import('../src/branch.js')

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

test('listMessages 提取 role/snippet 与 tool 摘要', () => {
  const events = [msg('user/message', 0, '  多  空格\n文本 '), msg('assistant/message', 1, '回复'), { type: 'tool/call', seq: 2, data: { name: 'bash' } }]
  const ms = listMessages(events)
  assert.equal(ms.length, 3)
  assert.equal(ms[0].role, 'user')
  assert.equal(ms[0].snippet, '多 空格 文本')
  assert.equal(ms[2].role, 'tool')
  assert.match(ms[2].snippet, /\[tool\] bash/)
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

test('planBranch 生成新 id + parentSession，事件截断正确', () => {
  const h = header('session-00000000-0000-0000-0000-000000000004')
  const events = [msg('user/message', 0, 'a'), msg('assistant/message', 1, 'b'), msg('user/message', 2, 'c')]
  const { header: nh, events: kept } = planBranch(h, events, 1)
  assert.notEqual(nh.id, h.id)
  assert.equal(nh.parentSession, h.id)
  assert.match(nh.id, /^session-[0-9a-f-]{36}$/)
  assert.equal(kept.length, 2)
  assert.throws(() => planBranch(h, events, -1))
})

test('applyBranch 落盘：新目录 + 新日志 + 原文件字节不变', () => {
  const id = 'session-00000000-0000-0000-0000-000000000005'
  const events = [msg('user/message', 0, 'a'), msg('assistant/message', 1, 'b'), msg('user/message', 2, 'c')]
  const origLog = writeLog(path.join(process.env.DSH_HOME, 'sessions', 'proj-b', id), header(id), events)
  const before = fs.readFileSync(origLog)
  const result = applyBranch(origLog, 1)
  assert.match(result.newId, /^session-[0-9a-f-]{36}$/)
  assert.ok(fs.existsSync(result.logPath))
  const { header: nh, events: kept } = readSessionFile(result.logPath)
  assert.equal(nh.parentSession, id)
  assert.equal(kept.length, 2)
  assert.deepEqual(fs.readFileSync(origLog), before)
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
