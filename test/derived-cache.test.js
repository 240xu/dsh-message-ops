/**
 * 0.9.7 · 文件派生缓存（P0-1）的行为契约。
 *
 * 锁四件事：
 *  1. **visible 绝不进缓存** —— 它依赖 live.surface.nodes；陈旧的 visible 会让
 *     /undo 的 lastRevertable() 挑到不在 surface 上的 seq（服务端 409 / 回填错目标）。
 *     这是 0.9.6 修复的红线，本文件用「同文件两次 list、中间换 surface」直接钉死。
 *  2. running / runningSource 不进缓存（agents 注册表随时变）。
 *  3. 缓存条目**不含 raw events**（114MB/次的短命堆分配），只含派生结果；
 *     且缓存对象不被每请求字段改写（每次返回的是新拷贝）。
 *  4. 在途去重：3 个并发 list 只读 1 次盘；mtime+size 变化（追加一帧）必须失效。
 *
 * 藏行判据仍是 shadowed（不是 visible）——见 surface-visibility / transcript
 * 那两组测试；这里额外断言 shadowed 在缓存前后逐位一致。
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import url from "node:url"
import { zstdCompressSync, constants } from "node:zlib"

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..")
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-msgops-cache-"))

const { encodeSessionFile, listMessages } = await import("../src/session-file.js")
const { _internals } = await import("../src/index.js")
const { opsList, loadDerived, derivedCache } = _internals

const SID = "session-00000000-4444-5555-6666-777777777777"
const BARE = SID.slice("session-".length)

function header() {
  return { type: "session", version: 3, id: SID, createdAt: 1, cwd: "/tmp/x", delegationDepth: 0 }
}
function msg(type, seq, text) {
  return {
    type, seq, time: 1000 + seq, surfaceOp: "append",
    data: { turn: 1, step: 1, message: { role: type === "user/message" ? "user" : "assistant", content: [{ type: "text", text }] } },
  }
}
const EVENTS = [
  msg("user/message", 0, "问题一"),
  msg("assistant/message", 1, "回答一"),
  msg("user/message", 2, "问题二"),
  msg("assistant/message", 3, "回答二"),
  {
    type: "system/message", seq: 4, time: 1100,
    surfaceOp: { op: "replace", startSeq: 1, endSeq: 2 },
    sourceEventSeqs: [1, 2],
    data: { turn: 1, step: 1, message: { role: "system", content: [{ type: "text", text: "[消息回滚] 到 seq 1" }] } },
  },
  msg("user/message", 5, "问题三"),
  msg("assistant/message", 6, "回答三"),
]

const logPath = path.join(process.env.DSH_HOME, "sessions", "proj-cache", SID, "session.v3.jsonl.zstd")
fs.mkdirSync(path.dirname(logPath), { recursive: true })
fs.writeFileSync(logPath, encodeSessionFile(header(), EVENTS))

/** 测试用 ctx：sessions/agents 两个注册表都可换，模拟 live surface / 运行状态变化。 */
function ctxFor({ nodes = null, status = "idle" } = {}) {
  const session = nodes === null ? undefined : { id: SID, surface: { nodes } }
  const agent = { status }
  const sessions = { get: () => session, list: () => (session ? [session] : []) }
  const agents = { get: () => agent }
  return {
    sessions, agents,
    get(name) { return name === "sessions" ? sessions : name === "agents" ? agents : undefined },
  }
}
const visibleMap = (r) => r.messages.filter((m) => m.visible).map((m) => m.seq)

test("缓存命中后 visible 仍随 live surface 重算（0.9.6 红线）", async () => {
  // 第一次：会话不在对象层 → 走 !shadowed 兜底
  const r1 = await opsList(ctxFor({ nodes: null }), SID)
  assert.equal(r1.ok, true)
  assert.deepEqual(visibleMap(r1), [0, 3, 4, 5, 6], "兜底判据 = !shadowed（seq 1,2 被 replace 遮蔽；marker seq 4 自己可见）")
  assert.equal(r1.visibleCount, 5)

  // 第二次：live surface 只挂 0 与 1 —— 文件没变，纯缓存命中
  const r2 = await opsList(ctxFor({ nodes: [0, 1] }), SID)
  assert.deepEqual(visibleMap(r2), [0, 1], "缓存命中也必须用新 surface，绝不能回放上一次的 visible")
  assert.equal(r2.visibleCount, 2)

  // 第三次：再换一个 surface
  const r3 = await opsList(ctxFor({ nodes: [5] }), SID)
  assert.deepEqual(visibleMap(r3), [5])
  assert.equal(r3.visibleCount, 1)

  // 三次返回的 messages 必须是**不同对象**（缓存对象不被改写）
  assert.notStrictEqual(r1.messages, r2.messages)
  assert.notStrictEqual(r1.messages[0], r2.messages[0])
  // 但文件派生字段逐位一致
  assert.deepEqual(r1.messages.map((m) => [m.seq, m.snippet, m.shadowed]), r3.messages.map((m) => [m.seq, m.snippet, m.shadowed]))
})

test("藏行判据是 shadowed 且跨请求稳定（0.9.6）", async () => {
  const a = await opsList(ctxFor({ nodes: [1, 2] }), SID) // 即使 surface 上有 1,2
  const b = await opsList(ctxFor({ nodes: [1, 2] }), SID)
  for (const r of [a, b]) {
    assert.equal(r.messages.find((m) => m.seq === 1).shadowed, true)
    assert.equal(r.messages.find((m) => m.seq === 2).shadowed, true)
    assert.equal(r.messages.find((m) => m.seq === 0).shadowed, false)
    // shadowed 恒由 computeShadowed 得出，与 visible 是否为 true 无关
    assert.equal(r.messages.find((m) => m.seq === 1).visible, true)
  }
  assert.deepEqual(a.messages.map((m) => m.shadowed), b.messages.map((m) => m.shadowed))
})

test("running / runningSource 每请求重算，不进缓存", async () => {
  const idle = await opsList(ctxFor({ status: "idle" }), SID)
  assert.equal(idle.running, false)
  const run = await opsList(ctxFor({ status: "running" }), SID)
  assert.equal(run.running, true)
  assert.equal(run.runningSource, "agent-status-running")
  assert.equal((await opsList(ctxFor({ status: "idle" }), SID)).running, false)
})

test("缓存条目不含 raw events，且 LRU 上限 16", async () => {
  derivedCache.clear()
  await opsList(ctxFor(), SID)
  assert.equal(derivedCache.size, 1)
  const entry = derivedCache.get(logPath)
  assert.ok(entry, "应按 logPath 建条目")
  assert.deepEqual(Object.keys(entry).sort(), ["mtimeMs", "promise", "size"])
  const derived = await entry.promise
  assert.ok(!("events" in derived), "derived 不得持有 raw events（114MB/次）")
  assert.deepEqual(Object.keys(derived).sort(), ["header", "messages", "shadowed", "turnEndSeq"])
  assert.equal(derived.messages.length, listMessages(EVENTS).length)

  // 再灌 20 个真实会话日志 → 上限必须是 16，且最早插入的被淘汰
  const extra = [];
  for (let i = 0; i < 20; i++) {
    const id = `session-00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const dir = path.join(process.env.DSH_HOME, "sessions", "proj-lru", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "session.v3.jsonl.zstd"), encodeSessionFile({ ...header(), id }, [msg("user/message", 0, "x" + i)]));
    extra.push(path.join(dir, "session.v3.jsonl.zstd"));
  }
  for (const p of extra) await loadDerived(p);
  assert.equal(derivedCache.size, 16, `LRU 未生效：size=${derivedCache.size}`)
  assert.equal(derivedCache.has(logPath), false, "最早插入的条目应被淘汰")
})

test("在途去重：3 个并发 list 只读 1 次盘", async () => {
  derivedCache.clear()
  const realReadFile = fs.promises.readFile
  let reads = 0
  fs.promises.readFile = async (...args) => { reads++; return realReadFile(...args) }
  try {
    const [a, b, c] = await Promise.all([opsList(ctxFor(), SID), opsList(ctxFor(), SID), opsList(ctxFor(), SID)])
    assert.equal(reads, 1, `并发应共享一次读取，实际 ${reads} 次`)
    assert.equal(a.total, b.total)
    assert.deepEqual(visibleMap(a), visibleMap(c))
  } finally {
    fs.promises.readFile = realReadFile
  }
  assert.equal(derivedCache.size, 1)
  // 串行再问一次：仍是缓存命中（不再读盘）
  const before = fs.promises.readFile
  let reads2 = 0
  fs.promises.readFile = async (...args) => { reads2++; return before(...args) }
  try { await opsList(ctxFor(), SID) } finally { fs.promises.readFile = before }
  assert.equal(reads2, 0, "命中不应再读盘")
})

test("mtime+size 失效：追加一帧后立即看到新事件", async () => {
  derivedCache.clear()
  const first = await opsList(ctxFor(), SID)
  assert.equal(first.total, EVENTS.length)

  // append-only 追加一个 user 消息帧（裸 zstd，与 diskAppend 同构）
  const extra = msg("user/message", 7, "问题四")
  const frame = zstdCompressSync(Buffer.from(JSON.stringify(extra) + "\n", "utf8"), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  })
  const stBefore = fs.statSync(logPath)
  fs.appendFileSync(logPath, frame)
  // 保证 mtime/size 至少有一个变化（size 必变）
  assert.ok(fs.statSync(logPath).size > stBefore.size)

  const second = await opsList(ctxFor(), SID)
  assert.equal(second.total, EVENTS.length + 1, "读前 stat 必须让追加生效")
  assert.equal(second.messages.at(-1).snippet, "问题四")

  // 同步 loadDerived 也走重算路径
  const st = fs.statSync(logPath)
  const entry = derivedCache.get(logPath)
  assert.equal(entry.size, st.size)
  assert.equal(entry.mtimeMs, st.mtimeMs)
})

test("findSessionDirs 两种 id 拼写都能命中缓存（key 是 logPath 不是 sessionId）", async () => {
  derivedCache.clear()
  const byFull = await opsList(ctxFor(), SID)
  const byBare = await opsList(ctxFor(), BARE)
  assert.equal(byFull.session.id, SID)
  assert.equal(byBare.session.id, SID)
  assert.equal(derivedCache.size, 1, "同一文件的两种 id 拼写必须命中同一条缓存")
})
