/**
 * 0.25.0 · 服务端 /text 绕路修复的**真执行**回归锁。
 *
 * 被修的问题（C 线工单第 1 条）：
 *   `GET /api/message-ops/text` 每条请求都 `readSessionFileAsync(logPath)` 全量重读
 *   整份日志（9.1MB 真实会话实测 550~1100ms/次），而面板每选一条消息就打一次。
 *   它绕过了 loadDerived 的 mtimeMs+size 缓存 —— 等于把 /messages 刚付过的
 *   解压 + JSON.parse 成本再付一遍。
 *
 * 本文件锁的是**行为**（不是源码形状）：
 *   1. 同一条 seq 连打两次 /text，全程只读一次盘（第一请求建缓存，第二请求纯命中）。
 *   2. 命中路径返回的文本与 messageTextFull 逐字一致（含多段 content 的拼接口径）。
 *   3. 缓存按 mtimeMs+size 失效：追加一帧后新 seq 必须能取到。
 *   4. 未缓存到的非消息 seq（tool/result）仍能拿到全文；不存在的 seq 仍是 404。
 *   5. 路由级真执行：经 host.register 拿到的 handler 跑一遍，走的也是同一条缓存
 *      （不是只测 opsText 这个内部函数，避免「路由里偷偷又全量重读」的假绿灯）。
 *   6. /search 与 /messages 共用同一层缓存：先 list 再 search 不得再读盘。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import url from 'node:url'
import { zstdCompressSync, constants } from 'node:zlib'

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
// 必须在 import src/index.js **之前**定好 DSH_HOME（sessionsRoot 每次调用现读 env，
// 但这里显式隔离，避免污染开发者本机 ~/.dsh）。
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-msgops-textcache-'))

const { encodeSessionFile, readSessionFileAsync, messageTextFull, listMessages } = await import('../src/session-file.js')
const { _internals, apply } = await import('../src/index.js')
const { opsText, opsList, opsSearch, derivedCache, derivedTexts } = _internals

const SID = 'session-00000000-aaaa-4bbb-8ccc-000000000001'
const PROJ = 'proj-textcache'

function header(id = SID) {
  return { type: 'session', version: 4, id, createdAt: 1, cwd: '/tmp/x' }
}
function msgEvent(type, seq, segs) {
  return {
    type,
    seq,
    time: 1000 + seq,
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: { role: type === 'user/message' ? 'user' : 'assistant', content: segs.map(text => ({ type: 'text', text })) },
    },
  }
}
function toolResultEvent(seq, text) {
  return {
    type: 'tool/result',
    seq,
    time: 1000 + seq,
    data: { turn: 1, step: 1, message: { role: 'tool', content: [{ type: 'text', text }] } },
  }
}

const EVENTS = [
  msgEvent('user/message', 0, ['第一段的用户问题']),
  // 0.22.0 的真实形态：宿主把长文本拆成多段 content（实测 321+7954+20 三段）。
  // /text 必须按 messageTextFull 的口径全部拼回，不能只给首段。
  msgEvent('assistant/message', 1, ['ANSWER-PART-1', 'ANSWER-PART-2-late', 'ANSWER-PART-3']),
  toolResultEvent(2, 'TOOL-RESULT-TEXT（非消息行：不在 listMessages 里，只能按需读盘取）'),
  msgEvent('user/message', 3, ['第二条用户消息']),
]
const LONG_SEQ = 1 // 多段拼接那条
const TOOL_SEQ = 2 // 非消息行

const LOG = path.join(process.env.DSH_HOME, 'sessions', PROJ, SID, 'session.v4.jsonl.zstd')
fs.mkdirSync(path.dirname(LOG), { recursive: true })
fs.writeFileSync(LOG, encodeSessionFile(header(), EVENTS))

/** 包 fs.promises.readFile 数读盘次数（readSessionFileAsync 正是走这条路）。 */
async function countingReads(fn) {
  const real = fs.promises.readFile
  let reads = 0
  fs.promises.readFile = async (...args) => {
    reads++
    return real(...args)
  }
  try {
    const result = await fn()
    return { result, reads }
  } finally {
    fs.promises.readFile = real
  }
}

const resetCaches = () => derivedCache.clear()
const ctxOf = () => ({ get: () => undefined })

test('1 · 同一条 seq 连打两次 /text 只读一次日志（第二次纯命中）', async () => {
  resetCaches()
  const { result, reads } = await countingReads(async () => {
    const a = await opsText(SID, LONG_SEQ)
    const b = await opsText(SID, LONG_SEQ)
    return { a, b }
  })
  assert.equal(reads, 1, `两次 /text 应只读 1 次盘（旧实现 2 次），实际 ${reads} 次`)
  assert.equal(result.a, result.b, '两次返回的全文必须一致')
  const expect = messageTextFull(EVENTS.find(e => e.seq === LONG_SEQ))
  assert.equal(result.b, expect, '命中路径必须与 messageTextFull 逐字一致')
  assert.match(result.b, /ANSWER-PART-1\n\nANSWER-PART-2-late\n\nANSWER-PART-3/, '多段 content 必须全量拼接（只给首段 = 拦腰截断）')
})

test('2 · 命中缓存后隔多次请求仍不再读盘（缓存不是一次性的）', async () => {
  resetCaches()
  const first = await opsText(SID, LONG_SEQ)
  const { result, reads } = await countingReads(async () => {
    const out = []
    for (let i = 0; i < 5; i++) out.push(await opsText(SID, LONG_SEQ))
    return out
  })
  assert.equal(reads, 0, `后续 5 次 /text 一次盘都不该读，实际 ${reads} 次`)
  for (const text of result) assert.equal(text, first)
})

test('3 · 缓存按 mtimeMs+size 失效：追加一帧后新 seq 立刻可取', async () => {
  resetCaches()
  await opsText(SID, LONG_SEQ)
  const entryBefore = derivedCache.get(LOG)
  assert.ok(entryBefore, '首次 /text 后应有缓存条目')

  const extra = msgEvent('user/message', 4, ['追加进来的一条'])
  const frame = zstdCompressSync(Buffer.from(JSON.stringify(extra) + '\n', 'utf8'), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  })
  const sizeBefore = fs.statSync(LOG).size
  fs.appendFileSync(LOG, frame)
  assert.ok(fs.statSync(LOG).size > sizeBefore, '追加后文件 size 必变')

  assert.equal(await opsText(SID, 4), '追加进来的一条', '新增的 seq 必须能取到（读前 stat 失效 + 重算）')
  const entryAfter = derivedCache.get(LOG)
  const st = fs.statSync(LOG)
  assert.equal(entryAfter.size, st.size, '缓存条目必须换成新 size')
  assert.equal(entryAfter.mtimeMs, st.mtimeMs)
})

test('4 · 未进索引的非消息 seq 仍能取全文；不存在的 seq 仍然 404', async () => {
  resetCaches()
  await opsList(ctxOf(), SID) // 先建一次缓存（tool/result 不在 listMessages 里 → 不在命中索引上）
  const toolText = await opsText(SID, TOOL_SEQ)
  assert.match(toolText, /TOOL-RESULT-TEXT/, '非消息行必须按需现读取得全文，不能变成 404')
  assert.equal(toolText, messageTextFull(EVENTS.find(e => e.seq === TOOL_SEQ)))
  await assert.rejects(
    () => opsText(SID, 999),
    err => err.status === 404,
    '不存在的 seq 必须 404',
  )
})

test('5 · 参数校验：seq 0 / 非法 sessionId / 非法 seq 的错误语义不变', async () => {
  await assert.rejects(
    () => opsText(SID, 0),
    err => err.status === 404,
    'seq 0 不是可引用消息（保持 404）',
  )
  await assert.rejects(
    () => opsText('not-a-session', 1),
    err => err.status === 400,
  )
  await assert.rejects(
    () => opsText(SID, -1),
    err => err.status === 400,
  )
  await assert.rejects(
    () => opsText(SID, 1.5),
    err => err.status === 400,
  )
})

// ── 路由级真执行：走 host.register 拿到的 handler，而不是只测内部函数 ────────
function makeRoutes() {
  const routes = new Map()
  const ctx = {
    get(k) {
      return k === 'webServer' ? { register: r => routes.set(r.path, r.handler) } : undefined
    },
    inject() {},
    effect(fn) {
      return fn()
    },
  }
  apply(ctx)
  return routes
}
const mockReq = requestUrl => ({ method: 'GET', url: requestUrl, headers: { host: '127.0.0.1:3080' } })
function mockRes() {
  const out = { status: null, body: '' }
  out.writeHead = status => {
    out.status = status
  }
  out.end = b => {
    out.body = b == null ? '' : String(b)
  }
  return out
}

test('6 · 路由级：两次 /text 请求只读一次日志，且响应体是全文 JSON', async () => {
  resetCaches()
  const handler = makeRoutes().get('/api/message-ops/text')
  assert.equal(typeof handler, 'function', '必须注册 /api/message-ops/text 路由')

  const { result, reads } = await countingReads(async () => {
    const out = []
    for (let i = 0; i < 2; i++) {
      const res = mockRes()
      await handler(mockReq('/api/message-ops/text?sessionId=' + SID + '&seq=' + LONG_SEQ), res)
      out.push({ status: res.status, json: JSON.parse(res.body) })
    }
    return out
  })
  assert.equal(reads, 1, `路由级两次请求应只读 1 次盘，实际 ${reads} 次`)
  for (const r of result) {
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, true)
    assert.equal(r.json.seq, LONG_SEQ)
    assert.equal(r.json.text, messageTextFull(EVENTS.find(e => e.seq === LONG_SEQ)), '路由必须返回全文（不是 snippet）')
  }
  // 路由级 404 语义（seq 0）不能因为绕路修复而漂移
  const res404 = mockRes()
  await handler(mockReq('/api/message-ops/text?sessionId=' + SID + '&seq=0'), res404)
  assert.equal(res404.status, 404)
  assert.equal(JSON.parse(res404.body).ok, false)
})

test('7 · /search 与 /messages 共用同一层缓存：先 list 再 search 不得再读盘', async () => {
  resetCaches()
  const ctx = ctxOf()
  await opsList(ctx, SID, { compact: true }) // 建缓存
  const { result, reads } = await countingReads(async () => {
    const first = await opsSearch(ctx, SID, 'ANSWER-PART-2-late')
    const second = await opsSearch(ctx, SID, 'ANSWER-PART-2-late')
    return [first, second]
  })
  assert.equal(reads, 0, `/search 在 /messages 之后必须 0 读盘（旧实现两套缓存 → 再读 1 次），实际 ${reads} 次`)
  assert.equal(result[0].total, 1, '全文搜索必须命中多段内容的第二段（160 字 snippet 之外）')
  assert.equal(result[0].results[0].seq, LONG_SEQ)
  assert.deepEqual(result[0], result[1], '同一查询两次结果必须相同')
})

test('8 · /search 与 /messages 的缓存条目是同一份（不是两张表）', async () => {
  resetCaches()
  const ctx = ctxOf()
  await opsList(ctx, SID, { compact: true })
  const sizeAfterList = derivedCache.size
  await opsSearch(ctx, SID, '用户')
  assert.equal(derivedCache.size, sizeAfterList, '/search 不得再建第二条缓存条目')
  assert.equal(_internals.searchCache, undefined, 'searchCache 必须已删除（两层缓存合并成一层）')
})

test('9 · 文本索引挂在 derived 上，但 derived 的对外形状不变', async () => {
  derivedCache.clear()
  const derived = await _internals.loadDerived(LOG)
  assert.deepEqual(
    Object.keys(derived).sort(),
    ['header', 'messages', 'shadowed', 'turnEndSeq'],
    'derived 的键集合是既有契约：全文索引不得泄进去（否则响应体跟着膨胀）',
  )
  const texts = derivedTexts.get(derived)
  assert.ok(texts instanceof Map, '全文索引应挂在 WeakMap 上，与 derived 同生共死')
  // 索引大小 = 当前日志 listMessages 的行数（tool/result 这类非消息行不入索引）。
  // 注意读当前文件而不是常量 EVENTS：测试 3 已向日志追加过 seq 4。
  const current = await readSessionFileAsync(LOG)
  assert.equal(texts.size, listMessages(current.events).length)
  assert.equal(texts.get(LONG_SEQ), messageTextFull(current.events.find(e => e.seq === LONG_SEQ)))
})

test('10 · 缓存被清空后 /text 仍正确（冷分支不依赖残存状态）', async () => {
  derivedCache.clear()
  const text = await opsText(SID, LONG_SEQ)
  assert.equal(text, messageTextFull(EVENTS.find(e => e.seq === LONG_SEQ)))
  assert.equal(derivedCache.size, 1, '冷请求应重新建条目')
  const snapshot = await readSessionFileAsync(LOG)
  assert.deepEqual(Object.keys(snapshot).sort(), ['events', 'frameCount', 'header', 'partial'])
})
