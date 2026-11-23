/**
 * 0.26.0 · live 路径 marker 闸的**真执行**锁（对应 core-d 审计的「最后一个自噬入口」）。
 *
 * 背景：磁盘路径的 `planDeleteFromEvents/planRevertFromEvents` 早已拒 marker 当目标，
 * 但 live 路径只拿得到 `session.surface.nodes`（一串 seq，没有事件本体）→ 判不出目标
 * 是不是 marker → 把 marker 自己当删除目标会写出一条 content 为空的 replace
 * （语料实测 40 条空 content 的 system/message replace：3424/3658/3689/3721/3746/
 * 7252/7524/7525/7526/8954…）。0.26.0 在 `opsCommit` live 路径补了一道闸。
 *
 * 本文件**不用桩替换内部函数**：`src/index.js` 的 `_internals` 已导出 `opsCommit`
 * （原有 list/search/text），直接按真实签名调用；伪造的只是 ctx 上那几个服务
 * （sessions/agents 注册表），它们的真实契约能从 `resolveSession` / `isRunning` /
 * `acquireSession` 的实现里逐条读出来：
 *   - `resolveSession` 先试 `ctx.sessions.get(id)`（属性优先），命中即用，不需要 retain；
 *   - `isRunning` 读 `ctx.agents.get(id).status`，`'idle'` → 不锁；
 *   - `acquireSession` 在 resolveSession 命中时直接返回 `{ session, release(){} }`，
 *     不会走 ISessions.retain（那道是 store-miss 的兜底，见源码 204-267 行）；
 *   - `sessionLogOf(session)` 取 `session.log`（宿主 Session 的真实字段，
 *     dsh-session/lib/index.js:516 `this.log`）；
 *   - `planNoticeWindow(liveEvents)` 需要一份 turn/step 已闭合的事件流（否则会
 *     409 "session is between steps"）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ⚠️ 必须在 import src/index.js **之前**设 DSH_HOME：findSessionDirs/sessionsRoot
// 按它定位日志（本文件在 node --test 下独占一个子进程，不会污染其它测试）。
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-msgops-marker-guard-'))

const { encodeSessionFile } = await import('../src/session-file.js')
const { _internals } = await import('../src/index.js')
const { OpsError } = await import('../src/ops-core.js')

const opsCommit = _internals.opsCommit
const SID = 'session-99999999-8888-7777-6666-555555555555'

/** 真实 v4 形状的事件流：turn1 闭合 → 合成窗口承载 marker(seq9) → turn3 有新消息。 */
function fixtureEvents() {
  const ev = (seq, type, data, extra) => ({ type, seq, time: 1790000000000 + seq, data, ...(extra || {}) })
  const prompt = {
    turn: 1,
    step: 1,
    message: { id: 'sys', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'sys prompt' }] },
  }
  const userMsg = (seq, text) =>
    ev(
      seq,
      'user/message',
      { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user', id: 'u' + seq },
      { surfaceOp: 'append' },
    )
  const asstMsg = (seq, text) =>
    ev(
      seq,
      'assistant/message',
      {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text }],
          source: { kind: 'model', provider: 't', model: 't' },
          id: 'a' + seq,
        },
      },
      { surfaceOp: 'append' },
    )
  return [
    ev(0, 'turn/start', { turn: 1, reason: { kind: 'user' } }),
    ev(1, 'step/start', { turn: 1, step: 1 }),
    ev(2, 'system/message', prompt, { surfaceOp: 'append' }),
    userMsg(3, '第一问'),
    asstMsg(4, '第一答'),
    ev(5, 'step/end', { turn: 1, step: 1 }),
    ev(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    // marker 由合成窗口承载（真实落盘形态）
    ev(7, 'turn/start', { turn: 2, reason: 'message-ops' }),
    ev(8, 'step/start', { turn: 2, step: 1 }),
    ev(
      9,
      'system/message',
      {
        turn: 2,
        step: 1,
        message: {
          id: 'mk',
          role: 'system',
          source: { kind: 'system-prompt' },
          content: [{ type: 'text', text: '[消息回滚] 已回滚到 seq 3（含）之后的 2 个节点' }],
        },
      },
      { sourceEventSeqs: [3, 4], surfaceOp: { op: 'replace', startSeq: 3, endSeq: 4 } },
    ),
    ev(10, 'step/end', { turn: 2, step: 1 }),
    ev(11, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
    ev(12, 'turn/start', { turn: 3, reason: { kind: 'user' } }),
    ev(13, 'step/start', { turn: 3, step: 1 }),
    userMsg(14, '第二问'),
    asstMsg(15, '第二答'),
    ev(16, 'step/end', { turn: 3, step: 1 }),
    ev(17, 'turn/end', { turn: 3, reason: { kind: 'completed' } }),
  ]
}

/** 真实日志落盘（findSessionDirs 会扫 $DSH_HOME/sessions/<slug>/<id>/）。 */
function writeSessionLog(events) {
  const header = { type: 'session', version: 3, id: SID, createdAt: 1, cwd: '/tmp/marker-guard', delegationDepth: 0 }
  const logPath = path.join(process.env.DSH_HOME, 'sessions', 'proj-marker', SID, 'session.v3.jsonl.zstd')
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  fs.writeFileSync(logPath, encodeSessionFile(header, events))
  return logPath
}

/**
 * 伪造 ctx：只提供 opsCommit 真正会碰的三个服务面（全部按实现逐条确认过）。
 * @param {{log?: Array, nodes?: number[], appendSpy?: Array}} opts
 */
function ctxFor({ log, nodes, appendSpy } = {}) {
  let cursor = 100
  const session = {
    id: SID,
    surface: { nodes },
    log,
    append(type, data) {
      const event = { type, seq: cursor++, data }
      if (appendSpy) appendSpy.push(event)
      if (Array.isArray(this.log)) this.log.push(event)
      return { seq: event.seq }
    },
  }
  const sessions = { get: id => (id === SID ? session : undefined), list: () => [session] }
  const agents = { get: id => (id === SID ? { status: 'idle' } : undefined) }
  const ctx = { sessions, agents, get: n => (n === 'sessions' ? sessions : n === 'agents' ? agents : undefined) }
  return { ctx, session }
}

/** 一个「live 里存在、但磁盘里没有」的 marker：证明闸读的是 liveEvents，不是磁盘。 */
const MARKER_SEQ_LIVE_ONLY = 9

writeSessionLog(fixtureEvents())

// ── ① 负向：delete/revert 打到 marker → 409，且**一个事件都没写出去** ──────────
test('① live 路径 delete marker 自身 → 409，且 append 零调用（不写自噬 marker）', async () => {
  const events = fixtureEvents()
  const appended = []
  // surface.nodes 与真实折叠一致：[system prompt 2, marker 9, user 14, assistant 15]
  const { ctx } = ctxFor({ log: events, nodes: [2, MARKER_SEQ_LIVE_ONLY, 14, 15], appendSpy: appended })
  await assert.rejects(
    () => opsCommit(ctx, 'delete', SID, MARKER_SEQ_LIVE_ONLY),
    err => {
      assert.ok(err instanceof OpsError, '必须是 OpsError（路由层靠 status 映射 HTTP）')
      assert.equal(err.status, 409, '必须 409')
      assert.match(err.message, /marker/i, '错误信息要指出「这是 marker」，否则用户不知道为什么会失败')
      return true
    },
  )
  assert.deepEqual(appended, [], '闸必须在任何 append 之前拦住 —— 否则已经写出半条自噬记录')
})

test('① live 路径 revert marker 自身 → 409（两个 mode 同判）', async () => {
  const events = fixtureEvents()
  const appended = []
  const { ctx } = ctxFor({ log: events, nodes: [2, MARKER_SEQ_LIVE_ONLY, 14, 15], appendSpy: appended })
  await assert.rejects(
    () => opsCommit(ctx, 'revert', SID, MARKER_SEQ_LIVE_ONLY),
    err => err instanceof OpsError && err.status === 409 && /marker/i.test(err.message),
  )
  assert.deepEqual(appended, [])
})

// ── ② 正向对照：闸是「针对 marker」，不是一刀切拒绝 live 路径 ────────────────
test('② live 路径 delete 普通消息 → 成功（证明闸只咬 marker，不误伤）', async () => {
  const events = fixtureEvents()
  const appended = []
  const { ctx } = ctxFor({ log: events, nodes: [2, MARKER_SEQ_LIVE_ONLY, 14, 15], appendSpy: appended })
  const out = await opsCommit(ctx, 'delete', SID, 14)
  assert.equal(out.ok, true)
  assert.equal(out.mode, 'delete')
  assert.equal(out.seq, 14)
  assert.equal(out.shadowedCount, 1, '单节点遮蔽')
  assert.ok(appended.length > 0, '真的写出了 replace 事件（不是走了旁路）')
  const replaceEvent = appended.find(e => e.data && e.data.message)
  assert.ok(replaceEvent, '应有一条 system/message 说明')
  assert.equal(replaceEvent.type, 'system/message', 'replace 事件的类型必须是 system/message（宿主 v4 准入）')
  assert.deepEqual(replaceEvent.data.message.content[0].text, '[消息删除] 已遮蔽 seq 14', '说明文案必须如实指向被遮蔽的那一条')
})

test('② live 路径 revert 普通消息 → 成功（且未触 marker 闸）', async () => {
  const events = fixtureEvents()
  const appended = []
  const { ctx } = ctxFor({ log: events, nodes: [2, MARKER_SEQ_LIVE_ONLY, 14, 15], appendSpy: appended })
  const out = await opsCommit(ctx, 'revert', SID, 14)
  assert.equal(out.ok, true)
  assert.equal(out.mode, 'revert')
  assert.ok(out.shadowedCount >= 1)
})

// ── ③ 闸读的是 liveEvents：磁盘里没有这条 marker 也必须拦 ────────────────────
test('③ marker 只在 live 内存日志里（磁盘是旧快照）→ 仍 409', async () => {
  const diskEvents = fixtureEvents().filter(e => e.seq <= 6) // 磁盘只到 turn1 闭合
  const liveEvents = fixtureEvents()
  const liveMarker = liveEvents.find(e => e.seq === MARKER_SEQ_LIVE_ONLY)
  assert.ok(liveMarker && liveMarker.surfaceOp && liveMarker.surfaceOp.op === 'replace', 'live 里确实是 marker')
  assert.equal(
    diskEvents.some(e => e.seq === MARKER_SEQ_LIVE_ONLY),
    false,
    '磁盘旧快照里没有它',
  )
  const appended = []
  const { ctx } = ctxFor({ log: liveEvents, nodes: [2, MARKER_SEQ_LIVE_ONLY, 14, 15], appendSpy: appended })
  await assert.rejects(
    () => opsCommit(ctx, 'delete', SID, MARKER_SEQ_LIVE_ONLY),
    err => err instanceof OpsError && err.status === 409 && /marker/i.test(err.message),
    '闸必须读 liveEvents —— 读磁盘会漏（宿主内存日志比落盘批窗新 200ms）',
  )
  assert.deepEqual(appended, [])
})

// ── ④ 磁盘路径（store-miss / 无 sessions 服务）同样拦 marker ─────────────────
test('④ store-miss（acquireSession 返回 null）→ 磁盘路径 planDeleteFromEvents 也 409', async () => {
  // 不给 sessions/agents → resolveSession undefined → acquireSession null → 磁盘路径
  const ctx = { get: () => undefined }
  await assert.rejects(
    () => opsCommit(ctx, 'delete', SID, MARKER_SEQ_LIVE_ONLY),
    err => err instanceof OpsError && err.status === 409 && /marker/i.test(err.message),
  )
})

// ── ⑤ 前置条件自证：这套 ctx 确实走到了 **live** 分支，而不是悄悄退回磁盘 ────
test('⑤ live 分支真的命中（正向对照产物里带着磁盘路径不会有的 turnAligned 字段）', async () => {
  const events = fixtureEvents()
  const appended = []
  const { ctx } = ctxFor({ log: events, nodes: [2, MARKER_SEQ_LIVE_ONLY, 14, 15], appendSpy: appended })
  const out = await opsCommit(ctx, 'delete', SID, 14)
  assert.equal('disk' in out, false, 'live 路径的返回对象没有 disk:true（磁盘路径才有）')
  assert.equal('turnAligned' in out, true, 'live 路径独有字段 —— 证明真的走了 session.surface/append 分支')
})
