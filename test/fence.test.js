/**
 * dsh-message-ops — 评审修复测试（node --test）。
 * 覆盖：HTTP 信任围栏（P0）、写操作 Content-Type/413、写端 replace 拼写
 * 运行时探测（P1 前向雷）、异步逐帧读取与 partial 语义（P1）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-msgops-fence-'))

const { isTrustedApiRequest, isJsonContentType, applySurfaceReplace, _resetReplaceShape, OpsError } =
  await import('../src/ops-core.js')
const { encodeSessionFile, readSessionFileAsync, computeShadowed } = await import('../src/session-file.js')
const { apply } = await import('../src/index.js')

// --- 围栏纯函数 ----------------------------------------------------------------

function req(headers) { return { headers } }

test('isTrustedApiRequest：回环 Host 放行（localhost / 127.x / ::1）', () => {
  assert.equal(isTrustedApiRequest(req({ host: 'localhost:3080' })), true)
  assert.equal(isTrustedApiRequest(req({ host: '127.0.0.1:3080' })), true)
  assert.equal(isTrustedApiRequest(req({ host: '127.7.7.7' })), true)
  assert.equal(isTrustedApiRequest(req({ host: "[::1]:3080" })), true)
})

test('isTrustedApiRequest：非回环 Host / 缺 Host 拒绝（DNS rebinding）', () => {
  assert.equal(isTrustedApiRequest(req({ host: 'evil.com:3080' })), false)
  // 2130706433 是十进制 IPv4，WHATWG URL 会规范化为 127.0.0.1 → 本就是回环，放行
  assert.equal(isTrustedApiRequest(req({ host: '2130706433' })), true)
  assert.equal(isTrustedApiRequest(req({})), false)
  assert.equal(isTrustedApiRequest(req({ host: '127.0.0.999' })), false)
  assert.equal(isTrustedApiRequest(req({ host: 'foo.127.0.0.1' })), false)
})

test('isTrustedApiRequest：sec-fetch-site cross-site / Origin 不同源拒绝；同源放行', () => {
  const h = { host: '127.0.0.1:3080' }
  assert.equal(isTrustedApiRequest(req({ ...h, 'sec-fetch-site': 'cross-site' })), false)
  assert.equal(isTrustedApiRequest(req({ ...h, origin: 'http://evil.com' })), false)
  assert.equal(isTrustedApiRequest(req({ ...h, origin: 'http://127.0.0.1:3080' })), true)
  assert.equal(isTrustedApiRequest(req({ ...h, 'sec-fetch-site': 'same-origin' })), true)
  assert.equal(isTrustedApiRequest(req({ ...h, origin: 'not a url' })), false)
})

test('isJsonContentType：application/json（含 charset 后缀）通过，其余拒绝', () => {
  assert.equal(isJsonContentType(req({ 'content-type': 'application/json' })), true)
  assert.equal(isJsonContentType(req({ 'content-type': 'application/json; charset=utf-8' })), true)
  assert.equal(isJsonContentType(req({ 'content-type': 'text/plain' })), false)
  assert.equal(isJsonContentType(req({})), false)
})

// --- 路由级围栏（mock req/res 直接驱动注册的 handler） --------------------------

function makeCtx() {
  const routes = new Map()
  const ctx = {
    get(k) { return k === 'webServer' ? { register: (r) => routes.set(r.path, r.handler) } : undefined },
    inject() {},
    effect(fn) { return fn() },
  }
  apply(ctx)
  return routes
}

function mockReq({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  return {
    method, url, headers,
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c },
  }
}

function mockRes() {
  const out = { status: null, headers: null, body: '' }
  out.writeHead = (status, headers) => { out.status = status; out.headers = headers || {} }
  out.end = (b) => { out.body = b == null ? '' : String(b) }
  return out
}

test('路由级：非回环 Host → 403；cross-site POST → 403（先于业务校验）', async () => {
  const routes = makeCtx()
  const res1 = mockRes()
  await routes.get('/api/message-ops/messages')(mockReq({ url: '/api/message-ops/messages?sessionId=x', headers: { host: 'evil.com' } }), res1)
  assert.equal(res1.status, 403)
  const res2 = mockRes()
  await routes.get('/api/message-ops/revert')(mockReq({
    method: 'POST', url: '/api/message-ops/revert', headers: { host: '127.0.0.1', 'sec-fetch-site': 'cross-site', origin: 'http://evil.com' },
  }), res2)
  assert.equal(res2.status, 403)
})

test('路由级：写操作 text/plain 绕预检 → 415；超大 body → 413', async () => {
  const routes = makeCtx()
  const res1 = mockRes()
  await routes.get('/api/message-ops/revert')(mockReq({
    method: 'POST', url: '/api/message-ops/revert',
    headers: { host: '127.0.0.1', 'content-type': 'text/plain' }, body: '{"sessionId":"x","seq":1}',
  }), res1)
  assert.equal(res1.status, 415)

  const big = Buffer.alloc(1024 * 1024 + 1, 0x61).toString()
  const res2 = mockRes()
  await routes.get('/api/message-ops/revert')(mockReq({
    method: 'POST', url: '/api/message-ops/revert',
    headers: { host: '127.0.0.1', 'content-type': 'application/json' }, body: big,
  }), res2)
  assert.equal(res2.status, 413)
})


// --- 写端 replace 拼写运行时探测（P1 前向雷） -----------------------------------

function probingSession(failLegacy) {
  const appends = []
  return {
    appends,
    append(type, data, opts) {
      appends.push(opts)
      const op = opts && opts.surfaceOp
      if (failLegacy && op && typeof op === 'object' && op.op === 'replace' && 'startSeq' in op) {
        throw new Error('session event "system/message" carries an invalid replace surfaceOp')
      }
      return { seq: appends.length - 1, type, data, opts }
    },
  }
}

test('applySurfaceReplace：新引擎（拒 startSeq）自动降级 {start,end} 并记住拼写', () => {
  _resetReplaceShape()
  const session = probingSession(true)
  const ev = applySurfaceReplace(session, 3, 4, [3, 4], 'notice')
  assert.equal(ev.seq, 1)
  // appends[0] 是被引擎拒绝的 legacy 尝试，appends[1] 是降级重试
  assert.deepEqual(session.appends[0].surfaceOp, { op: 'replace', startSeq: 3, endSeq: 4 })
  assert.deepEqual(ev.opts.surfaceOp, { op: 'replace', start: 3, end: 4 })
  // 第二次直接用新拼写，不再探测
  const ev2 = applySurfaceReplace(session, 5, 6, [5, 6], 'n2')
  assert.deepEqual(ev2.opts.surfaceOp, { op: 'replace', start: 5, end: 6 })
})

test('applySurfaceReplace：当前引擎（收 startSeq）保持原拼写；无关错误原样抛出', () => {
  _resetReplaceShape()
  const session = probingSession(false)
  applySurfaceReplace(session, 1, 2, [1, 2], 'n')
  assert.deepEqual(session.appends[0].surfaceOp, { op: 'replace', startSeq: 1, endSeq: 2 })
  _resetReplaceShape()
  const boom = { append() { throw new Error('disk on fire') } }
  assert.throws(() => applySurfaceReplace(boom, 1, 1, [1], 'n'), /disk on fire/)
})

// --- 异步逐帧读取 + partial 语义 + 双拼写 computeShadowed -----------------------

test('readSessionFileAsync：事件完整恢复，返回 frameCount；超 frameBudget 置 partial', async () => {
  const id = 'session-aaaa0000-0000-0000-0000-00000000f001'
  const dir = path.join(process.env.DSH_HOME, 'sessions', 'proj-async', id)
  fs.mkdirSync(dir, { recursive: true })
  const events = [{ type: 'user/message', seq: 0, surfaceOp: 'append', data: { message: { role: 'user', content: [{ type: 'text', text: '异步读取' }] } } }]
  const file = path.join(dir, 'session.v3.jsonl.zstd')
  fs.writeFileSync(file, encodeSessionFile({ type: 'session', version: 3, id, createdAt: 1 }, events))

  const r1 = await readSessionFileAsync(file)
  assert.equal(r1.partial, false)
  assert.equal(r1.frameCount, 1)
  assert.equal(r1.events[0].data.message.content[0].text, '异步读取')
  // encodeSessionFile 产生 header 帧 + 1 个事件帧；用最小 frameBudget 触发 partial
  const r2 = await readSessionFileAsync(file, { frameBudget: 0 })
  assert.equal(r2.partial, true)
})

test('computeShadowed：双拼写（startSeq/endSeq 与 start/end）都能推导遮蔽', () => {
  const shadowed = computeShadowed([
    { seq: 0, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 } },
    { seq: 2, surfaceOp: { op: 'replace', start: 2, end: 3 } },
    { seq: 4, surfaceOp: { op: 'replace', startSeq: 4, start: 4 } }, // 半残：非法忽略
  ])
  assert.ok([0, 1, 2, 3].every((s) => shadowed.has(s)))
  assert.ok(!shadowed.has(4))
})
