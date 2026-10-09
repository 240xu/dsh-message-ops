/**
 * dsh-message-ops — compat-audit P0 回归测试：旧单帧 session.jsonl.zstd
 * 必须与 v3 多帧走同一读取路径（帧 0 是整段 NDJSON，不是单行 header）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { constants, zstdCompressSync } from 'node:zlib'

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-msgops-legacy-'))

const { readSessionFile, readSessionFileAsync, encodeSessionFile, findSessionDirs, listMessages } =
  await import('../src/session-file.js')

const HEADER = { type: 'session', version: 3, id: 'session-22222222-2222-2222-2222-222222222222', createdAt: 1, cwd: '/tmp/x' }
const EVENTS = [
  { type: 'user/message', seq: 0, surfaceOp: 'append', data: { message: { role: 'user', content: [{ type: 'text', text: '旧格式第一问' }] } } },
  { type: 'assistant/message', seq: 1, surfaceOp: 'append', data: { message: { role: 'assistant', content: [{ type: 'text', text: '旧格式回复' }] } } },
]

/** 旧单帧：整个文件 = 单个 zstd 帧，解压出 header 行 + 事件行 NDJSON。 */
function writeLegacySingleFrame(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const ndjson = JSON.stringify(HEADER) + '\n' + EVENTS.map((e) => JSON.stringify(e)).join('\n') + '\n'
  const frame = zstdCompressSync(Buffer.from(ndjson, 'utf8'), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
  const logPath = path.join(dir, 'session.jsonl.zstd')
  fs.writeFileSync(logPath, frame)
  return logPath
}

test('readSessionFile：旧单帧格式往返（header + 事件完整恢复）', () => {
  const p = writeLegacySingleFrame(path.join(process.env.DSH_HOME, 'sessions', 'legacy-a', HEADER.id))
  const { header, events } = readSessionFile(p)
  assert.equal(header.type, 'session')
  assert.equal(header.id, HEADER.id)
  assert.equal(events.length, 2)
  assert.equal(events[0].data.message.content[0].text, '旧格式第一问')
})

test('readSessionFileAsync：旧单帧同样走逐行扫描路径', async () => {
  const p = writeLegacySingleFrame(path.join(process.env.DSH_HOME, 'sessions', 'legacy-b', HEADER.id))
  const { header, events, frameCount } = await readSessionFileAsync(p)
  assert.equal(header.id, HEADER.id)
  assert.equal(events.length, 2)
  assert.equal(frameCount, 0) // 单帧格式：除承载 header+事件的帧外无其余帧
})

test('listMessages：旧单帧日志可提取消息（含 tool 摘要）', () => {
  const dir = path.join(process.env.DSH_HOME, 'sessions', 'legacy-c', HEADER.id)
  fs.mkdirSync(dir, { recursive: true })
  const ndjson = JSON.stringify(HEADER) + '\n'
    + JSON.stringify(EVENTS[0]) + '\n'
    + JSON.stringify({ type: 'tool/call', seq: 1, data: { name: 'bash' } }) + '\n'
    + JSON.stringify(EVENTS[1]) + '\n'
  fs.writeFileSync(path.join(dir, 'session.jsonl.zstd'),
    zstdCompressSync(Buffer.from(ndjson, 'utf8'), { params: { [constants.ZSTD_c_checksumFlag]: 1 } }))
  const { header, events } = readSessionFile(path.join(dir, 'session.jsonl.zstd'))
  assert.equal(header.id, HEADER.id)
  const ms = listMessages(events)
  assert.equal(ms.length, 3)
  assert.equal(ms[0].snippet, '旧格式第一问')
  assert.match(ms[1].snippet, /\[tool\] bash/)
})

test('findSessionDirs：旧文件名 session.jsonl.zstd 可发现（v3 缺席时）', () => {
  const uniq = 'session-44444444-4444-4444-4444-444444444444'
  writeLegacySingleFrame(path.join(process.env.DSH_HOME, 'sessions', 'legacy-d', uniq))
  const dirs = findSessionDirs(uniq)
  assert.equal(dirs.length, 1)
  assert.match(dirs[0].logPath, /session\.jsonl\.zstd$/)
})

test('v3 多帧回归：新格式不受统一路径影响', () => {
  const id = 'session-33333333-3333-3333-3333-333333333333'
  const dir = path.join(process.env.DSH_HOME, 'sessions', 'v3-a', id)
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, 'session.v3.jsonl.zstd')
  fs.writeFileSync(p, encodeSessionFile({ ...HEADER, id }, [{ type: 'user/message', seq: 0, surfaceOp: 'append', data: { message: { role: 'user', content: [{ type: 'text', text: '多帧' }] } } }]))
  const { header, events } = readSessionFile(p)
  assert.equal(header.id, id)
  assert.equal(events.length, 1)
  // 同目录同时存在 v3 与旧格式时 v3 优先
  fs.writeFileSync(path.join(dir, 'session.jsonl.zstd'),
    zstdCompressSync(Buffer.from(JSON.stringify(HEADER) + '\n', 'utf8'), { params: { [constants.ZSTD_c_checksumFlag]: 1 } }))
  const dirs = findSessionDirs(id)
  assert.equal(dirs.length, 1)
  assert.match(dirs[0].logPath, /session\.v3\.jsonl\.zstd$/)
})

// --- v4 会话格式（用户实测 DSH 已升级；结构同 v3，仅文件名与 version 数字不同） ---

const V4_HEADER = { type: 'session', version: 4, id: 'session-55555555-5555-5555-5555-555555555555', createdAt: 2, cwd: '/tmp/x' }

test('readSessionFile：v4 多帧格式往返（version 不硬校验）', () => {
  const dir = path.join(process.env.DSH_HOME, 'sessions', 'v4-a', V4_HEADER.id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), encodeSessionFile(V4_HEADER, [
    { type: 'user/message', seq: 0, surfaceOp: 'append', data: { message: { role: 'user', content: [{ type: 'text', text: 'v4 会话第一问' }] } } },
    { type: 'assistant/message', seq: 1, surfaceOp: 'append', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'v4 回复' }] } } },
  ]))
  const { header, events } = readSessionFile(path.join(dir, 'session.v4.jsonl.zstd'))
  assert.equal(header.version, 4)
  assert.equal(events.length, 2)
})

test('readSessionFileAsync：v4 同样可读', async () => {
  const p = path.join(process.env.DSH_HOME, 'sessions', 'v4-a', V4_HEADER.id, 'session.v4.jsonl.zstd')
  const { header, events } = await readSessionFileAsync(p)
  assert.equal(header.version, 4)
  assert.equal(events.length, 2)
})

test('findSessionDirs：v4 文件名优先发现；同目录 v4 压过 v3/legacy', () => {
  const dirs = findSessionDirs(V4_HEADER.id)
  assert.equal(dirs.length, 1)
  assert.match(dirs[0].logPath, /session\.v4\.jsonl\.zstd$/)
})

