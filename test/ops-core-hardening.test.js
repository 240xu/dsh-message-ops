/**
 * 0.26.0 · ops-core 语义边界硬化（**全部真执行**，无源码形状断言）。
 *
 * 针对「规划层说可以、宿主说不行」这一类**假可见/假可恢复**缺陷：规划产物一旦
 * 写进 append-only 日志，宿主 foldSurface 会拒绝整份会话
 * （`start seq … not found in surface` / `node 0 holds the system prompt …` /
 * `sourceEventSeqs must include every shadowed surface node`），日志就打不开了。
 *
 * 全部 fixture 的 seq 编号、事件类型、data 形状、surfaceOp 三元组与文案都取自
 * 真实日志（会话 id 写在每段注释里），只把不相关的长文本截短、把无关事件略去；
 * 保留的每一条都是真实事件的**拓扑等价缩影**（节点序与真实日志逐位一致）。
 *
 * 真执行口径：每个断言都真的调用 `src/ops-core.js` 的导出函数，并把返回值/抛错
 * 与手工推导的宿主语义对比。禁止「源码里出现了某个字符串」式断言。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const {
  OpsError,
  planRevert,
  planDelete,
  planRevertFromEvents,
  planDeleteFromEvents,
  planRestore,
  restoreProgress,
  pendingRestoreTurns,
  buildRestoreIndex,
  restoreProgressFromIndex,
  pendingRestoreTurnsFromIndex,
  diskSurfaceNodes,
  diskVisibleNodes,
  isMarkerEvent,
  restoreNoticeText,
  buildMarkerEvent,
} = await import('../src/ops-core.js')
const { computeShadowed } = await import('../src/session-file.js')

// ── fixture 构造器：字段逐项镜像真实日志 ─────────────────────────────────────
/** 真实 user/message 形状（`data.content` 摊平 + `source.kind`）。 */
const userMsg = (seq, text, kind = 'user') => ({
  type: 'user/message',
  seq,
  time: 1790000000000 + seq,
  data: { content: [{ type: 'text', text }], source: { kind }, role: 'user', id: 'u' + seq },
  surfaceOp: 'append',
})

/** 真实 assistant/message 形状（`data.message.content` 包裹 + model source）。 */
const asstMsg = (seq, text) => ({
  type: 'assistant/message',
  seq,
  time: 1790000000000 + seq,
  data: {
    turn: 1,
    step: 1,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'test', model: 'test' },
      id: 'a' + seq,
    },
  },
  surfaceOp: 'append',
})

/** 真实 tool/result 形状（surface 节点但不可重放 —— provenance 必须覆盖它）。 */
const toolResult = (seq, text) => ({
  type: 'tool/result',
  seq,
  time: 1790000000000 + seq,
  data: {
    turn: 1,
    step: 1,
    message: {
      role: 'tool',
      source: { kind: 'tool', callId: 'c' + seq },
      toolCallId: 'c' + seq,
      content: [{ type: 'text', text }],
      id: 't' + seq,
    },
  },
  sourceEventSeqs: [seq - 1],
  surfaceOp: 'append',
})

/** surface 头节点：system prompt（真实语料 240/240 份的头节点都是它）。 */
const systemPrompt = (seq, text = 'You are an AI agent powered by DeepSeek Harness.') => ({
  type: 'system/message',
  seq,
  time: 1790000000000 + seq,
  data: {
    turn: 1,
    step: 1,
    message: { id: 'sys' + seq, role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text }] },
  },
  surfaceOp: 'append',
})

/** 真实 revert/delete marker 形状（`[消息回滚]`/`[消息删除]` 文案 + 三元组 surfaceOp）。 */
const marker = (seq, startSeq, endSeq, shadowedSeqs, text) => ({
  type: 'system/message',
  seq,
  time: 1790000000000 + seq,
  data: {
    turn: 2,
    step: 1,
    message: {
      id: 'mk' + seq,
      role: 'system',
      source: { kind: 'system-prompt' },
      content: [
        {
          type: 'text',
          text: text === undefined ? '[消息回滚] 已回滚到 seq ' + startSeq + '（含）之后的 ' + shadowedSeqs.length + ' 个节点' : text,
        },
      ],
    },
  },
  sourceEventSeqs: shadowedSeqs,
  surfaceOp: { op: 'replace', startSeq, endSeq },
})

/** 真实恢复 notice 形状（`restoresSeq` + `restoredSourceSeqs`）。 */
const notice = (seq, restoreSeq, restoredSourceSeqs) => ({
  type: 'system/message',
  seq,
  time: 1790000000000 + seq,
  data: {
    turn: 3,
    step: 1,
    message: {
      id: 'nt' + seq,
      role: 'system',
      source: { kind: 'system-prompt' },
      content: [{ type: 'text', text: '[消息恢复] 重放' }],
    },
    restoresSeq: restoreSeq,
    ...(restoredSourceSeqs ? { restoredSourceSeqs } : {}),
  },
  surfaceOp: 'append',
})

/**
 * 真实 compaction checkpoint 形状：**`user/message` 携带 replace surfaceOp**
 * （不是 system/message marker！）。语料实测：session-afcc0453 的 530/718、
 * session-008f3759 的 6338/12416 全是 `user/message` + `source.kind: compact-checkpoint`。
 * 曾经把它误建成 system/message，会让 `planRestore` 走「marker」分支的语义判断出错。
 */
const checkpoint = (seq, startSeq, endSeq, shadowedSeqs) => ({
  type: 'user/message',
  seq,
  time: 1790000000000 + seq,
  data: {
    content: [{ type: 'text', text: 'This is an automatically generated checkpoint condensing an earlier span of the conversation' }],
    source: { kind: 'compact-checkpoint', compactionId: 'c' + seq },
    role: 'user',
    id: 'cp' + seq,
  },
  sourceEventSeqs: shadowedSeqs,
  surfaceOp: { op: 'replace', startSeq, endSeq },
})

/** 宿主节点序折叠的手工复算（与宿主 `nodes.indexOf`+`splice` 同语义）。 */
function refold(events) {
  const isSurface = t =>
    t === 'user/message' || t === 'assistant/message' || t === 'system/message' || t === 'developer/message' || t === 'tool/result'
  const nodes = []
  for (const e of events) {
    if (!e || !Number.isSafeInteger(e.seq) || !isSurface(e.type)) continue
    const op = e.surfaceOp
    if (!op || typeof op !== 'object' || op.op !== 'replace') {
      nodes.push(e.seq)
      continue
    }
    const startIdx = nodes.indexOf(op.startSeq)
    const endIdx = nodes.indexOf(op.endSeq)
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
      nodes.push(e.seq)
      continue
    }
    nodes.splice(startIdx, endIdx - startIdx + 1, e.seq)
  }
  return nodes
}

// ── ① 节点序折叠 = 宿主语义（session-ab6f / ab6feff2-…）──────────────────────
/**
 * 真实拓扑（取自该会话 seq 89..1205）：
 *   89 user(继续) · 90 user(system-reminder 注入) · 114 user(继续) · 115 assistant
 *   · 1185 assistant · 1191 marker replace(114..1185) · 1197 marker replace(89..1191)
 *   · 1205 marker replace(1197..1197)
 * 宿主折叠：[89,90,114,115,1185] →(1191 挖 114..1185)→ [89,90,1191]
 *          →(1197 挖 89..1191)→ [1197] →(1205)→ [1205]
 */
function ab6fFixture() {
  return [
    userMsg(89, '继续'),
    userMsg(90, '<system-reminder>\nUpdated instructions from: ~/.dsh/AGENTS.md', 'agent-instructions'),
    userMsg(114, '继续'),
    asstMsg(115, '继续。先找回 newapi 管理端登录方式——查项目记忆里的凭据记录。'),
    asstMsg(1185, 'Let me search memory for the admin credentials of newapi.sepic.space.'),
    marker(1191, 114, 1185, [114, 115, 1185]),
    marker(1197, 89, 1191, [89, 90, 1191]),
    marker(1205, 1197, 1197, [1197], '[消息回滚] 已回滚到 seq 1197（含）之后的 1 个节点'),
  ]
}

test('① 折叠：diskSurfaceNodes 与宿主节点序 splice 逐位一致（ab6f 真实拓扑）', () => {
  const events = ab6fFixture()
  assert.deepEqual(diskSurfaceNodes(events), [1205], '宿主折叠后只剩 marker 1205')
  assert.deepEqual(diskSurfaceNodes(events), refold(events), '与手工复算的宿主语义必须逐位一致')

  // 缺陷成因对照：旧「数值区间」语义（computeShadowed）是另一套判据。
  const numericShadowed = computeShadowed(events)
  assert.equal(numericShadowed.has(114), true, '数值语义把 114 算作已遮蔽（本例两端同判）')
  assert.equal(diskVisibleNodes(events).includes(114), false, '节点序语义同样不可见（两面同判）')
})

test('① 恢复候选 = marker 真正遮蔽的节点，不是数值区间（ab6f marker 1197）', () => {
  const events = ab6fFixture()
  const plan = planRestore(events, 1197)
  assert.deepEqual(
    plan.replayable.map(i => i.seq),
    [89, 90],
    '只应重放 1197 真正遮蔽的两条 user 消息；数值区间会把 114/115/1185 一起重放',
  )
  const numericCandidates = events
    .filter(e => (e.type === 'user/message' || e.type === 'assistant/message') && e.seq >= 89 && e.seq <= 1191)
    .map(e => e.seq)
  assert.deepEqual(numericCandidates, [89, 90, 114, 115, 1185], '数值区间候选确实是 5 条（对照基线）')
  assert.ok(!plan.replayable.some(i => [114, 115, 1185].includes(i.seq)), '被更早 marker 遮蔽过的消息不得被重放')
  assert.equal(plan.upToSeq, 1191, '未指定 upToSeq 时按区域上界（max(start,end)）')
})

test('① 恢复进度与恢复计划同源：pendingSeqs 与 planRestore 候选集一致', () => {
  const events = ab6fFixture()
  const prog = restoreProgress(events, 1197)
  assert.deepEqual(prog.pendingSeqs, [89, 90], '进度条不得显示上百条待恢复（真实日志里就是 2 条）')
  assert.equal(prog.complete, false)
  assert.deepEqual(prog.restoredSeqs, [])

  events.push(notice(1210, 1197, [89, 90]))
  const after = restoreProgress(events, 1197)
  assert.equal(after.complete, true, '全部候选已重放 → 标记不再活跃')
  assert.deepEqual(after.pendingSeqs, [])
})

test('① 索引版与直算版在真实拓扑上完全等价（含 pendingRestoreTurns）', () => {
  const events = ab6fFixture()
  events.push(notice(1210, 1197, [89]))
  const index = buildRestoreIndex(events)
  for (const markerSeq of [1191, 1197, 1205, 1210]) {
    assert.deepEqual(restoreProgress(events, markerSeq), restoreProgressFromIndex(index, markerSeq), 'seq ' + markerSeq)
    assert.deepEqual(
      pendingRestoreTurns(events, markerSeq),
      pendingRestoreTurnsFromIndex(index, markerSeq, restoreProgress(events, markerSeq)),
      'turn seq ' + markerSeq,
    )
  }
  assert.deepEqual(restoreProgress(events, 1197).pendingSeqs, [90], '只重放了 89 → 还剩注入行 90')
  assert.deepEqual(pendingRestoreTurns(events, 1197), [{ turnSeq: 90, seqs: [90] }])
})

// ── ② 反向区间（startSeq > endSeq）是合法的节点序区间 ─────────────────────
/**
 * session-afcc0453 有 9 条这样的 compact-checkpoint：
 *   718 `replace(530, 465)` —— 数值上 start > end，节点序上 530 在 465 之前
 *   （530 是 `replace(8,199)` 的落点，故排在 202 之前）。宿主 shadowedN=96、
 *   首三个正是 `[530, 202, 204]`。
 */
function afccFixture() {
  // ⚠️ 顺序必须是**日志顺序（seq 升序）**：readSessionFile 返回的就是升序，
  // planRestore 按数组顺序扫描。节点序 [530,202,204,465] 来自 530 落到了
  // 8..199 的节点位置上（堆叠在 202 之前），而不是数组顺序。
  return [
    userMsg(8, '用户第一条', 'user'),
    toolResult(199, 'sanity: gateway:80 → GW80_OPEN'),
    asstMsg(202, 'Interesting: 18902 belongs to mihomo pid 945 = /opt/reg-proxy'),
    toolResult(204, '=== via 18902 (reg-proxy): intern-ai ===\n000 0.908908s'),
    toolResult(465, '=== sanity: /dev/tcp to gateway:80 ===\nGW80_OPEN'),
    checkpoint(530, 8, 199, [8, 199]),
    // 真实日志里 718 也是 user/message + replace(530,465)（反向区间）
    checkpoint(718, 530, 465, [530, 202, 204, 465]),
  ]
}

test('② 反向区间按节点序遮蔽（afcc marker 718 replace(530,465)）', () => {
  const events = afccFixture()
  assert.deepEqual(diskSurfaceNodes(events), [718], '718 遮蔽了 [530,202,204,465]')
  assert.deepEqual(diskSurfaceNodes(events), refold(events))

  const plan = planRestore(events, 718)
  // 节点序遮蔽集 = [530, 202, 204, 465]（530 是 8..199 的落点，故排在 202 之前），
  // 其中 204/465 是 tool/result（不可重放 → skipped），530/202 是可重放消息。
  assert.deepEqual(
    plan.replayable.map(i => i.seq),
    [202, 530],
    '两条 message 型节点按 seq 升序重放',
  )
  assert.equal(plan.skipped, 2, '遮蔽集里的 2 条 tool/result 计入 skipped')

  const numericRange = events.filter(e => (e.type === 'user/message' || e.type === 'assistant/message') && e.seq >= 465 && e.seq <= 465)
  assert.equal(numericRange.length, 0, '数值区间里确实没有任何消息（旧口径 →「区间无可重放」的假停用）')
})

test('② 反向区间的候选必须升序（贴条逐行展示与按轮步进都假定升序）', () => {
  const events = afccFixture()
  const prog = restoreProgress(events, 718)
  assert.deepEqual(prog.pendingSeqs, [202, 530], '节点序遮蔽集里 530 在前，候选必须按 seq 升序')
  assert.deepEqual(pendingRestoreTurns(events, 718), [
    { turnSeq: 202, seqs: [202] },
    { turnSeq: 530, seqs: [530] },
  ])
})

test('② 候选顺序稳定升序（事件数组乱序也要归一化）', () => {
  // 生产路径 readSessionFile 返回 seq 升序，但 `planRestore` 的公开签名接受
  // 任意事件数组（历史上所有 fixture 都是手造数组），列表类输出的顺序不能依赖
  // 「调用方恰好给了升序」—— dav 贴条逐行展示 / step 步进都按 seq 单调递增假设。
  const shuffled = afccFixture()
  // 打乱顺序（保持同一份事件，只改数组顺序）
  const perm = [4, 0, 5, 1, 6, 2, 3].map(i => shuffled[i])
  const prog = restoreProgress(perm, 718)
  assert.deepEqual(prog.pendingSeqs, [202, 530], '乱序输入下的候选必须仍按 seq 升序')
})

// ── ③ 节点 0 保护（system prompt）────────────────────────────────────────────
function headFixture() {
  return [systemPrompt(0), userMsg(8, '第一问'), asstMsg(9, '第一答'), userMsg(10, '第二问')]
}

test('③ 回滚头节点（会顺带遮蔽多个节点）必须 409，不是放行', () => {
  const events = headFixture()
  assert.equal(diskSurfaceNodes(events)[0], 0, '头节点是 system prompt')
  assert.throws(
    () => planRevertFromEvents(events, 0),
    e => e instanceof OpsError && e.status === 409 && /node 0 holds the system prompt/i.test(e.message),
    '宿主会拒绝这种 marker，规划层必须先拦住',
  )
  // 宿主判据的手工复算：startIdx === 0 且头事件是 system/message 且遮蔽数 > 1 → 拒绝
  const hostRejects = diskSurfaceNodes(events).indexOf(0) === 0 && events[0].type === 'system/message' && [0, 8, 9, 10].length !== 1
  assert.equal(hostRejects, true, '宿主判据：startIdx 0 + 多节点 → 拒绝')
})

test('③ 回滚非头消息照常放行（护栏只咬节点 0）', () => {
  const events = headFixture()
  const plan = planRevertFromEvents(events, 8)
  assert.deepEqual(plan.shadowedSeqs, [8, 9, 10], '8 是索引 1，不在保护区')
  assert.equal(plan.startSeq, 8)
  assert.equal(plan.endSeq, 10)
})

test('③ 删除单个头节点合法：规划产物的形状恰好满足宿主豁免', () => {
  const events = headFixture()
  const plan = planDeleteFromEvents(events, 0)
  assert.deepEqual(plan.shadowedSeqs, [0], '单节点遮蔽')
  const built = buildMarkerEvent({
    seq: 11,
    time: 1,
    turnStep: { turn: 2, step: 1 },
    text: '[消息删除] 已遮蔽 seq 0',
    startSeq: plan.startSeq,
    endSeq: plan.endSeq,
    shadowedSeqs: plan.shadowedSeqs,
  })
  assert.equal(built.type, 'system/message', '豁免条件一：替换事件本身是 system/message')
  assert.deepEqual(built.surfaceOp, { op: 'replace', startSeq: 0, endSeq: 0 })
  assert.deepEqual(built.sourceEventSeqs, [0], '豁免条件二：只遮蔽那一个节点')
  const bad = buildMarkerEvent({
    seq: 12,
    time: 1,
    turnStep: { turn: 2, step: 1 },
    text: 'x',
    startSeq: 0,
    endSeq: 10,
    shadowedSeqs: [0, 8, 9, 10],
  })
  assert.notEqual(bad.sourceEventSeqs.length, 1, '多节点 → 不满足「exactly that node」，这才是 409 的理由')
})

// ── ④ marker 不能当删除目标（自噬空 marker 的成因）──────────────────────────
/**
 * session-645bd930 实测：marker seq 21 `revert` → 409 DENY、`delete` → **ALLOW**。
 * 语料里 51 条 content 为空的系统 marker（3424/3658/3689/3721/3746/7252/7524…）
 * 全是「拿 marker 当目标」的自噬产物。
 */
function s645bFixture() {
  return [
    userMsg(8, '第一条用户消息'),
    userMsg(9, '<system-reminder> 注入行', 'agent-instructions'),
    userMsg(10, '第二条用户消息'),
    asstMsg(15, '第一条回答'),
    { type: 'turn/start', seq: 19, time: 1790000000019, data: { turn: 2, reason: 'message-ops' } },
    { type: 'step/start', seq: 20, time: 1790000000020, data: { turn: 2, step: 1 } },
    marker(21, 8, 15, [8, 9, 10, 15]),
    { type: 'step/end', seq: 22, time: 1790000000022, data: { turn: 2, step: 1 } },
  ]
}

test('④ 删除 marker 自身必须 409（旧实现 delete 侧放行 → 自噬空记录）', () => {
  const events = s645bFixture()
  assert.equal(isMarkerEvent(events.find(e => e.seq === 21)), true)
  assert.throws(
    () => planDeleteFromEvents(events, 21),
    e => e instanceof OpsError && e.status === 409 && /marker/i.test(e.message),
    'delete 侧必须与 revert 侧同判',
  )
  assert.throws(
    () => planRevertFromEvents(events, 21),
    e => e.status === 409 && /marker/i.test(e.message),
    'revert 侧既有护栏不回归',
  )
  const selfEaten = marker(3424, 3417, 3417, [3417], '')
  selfEaten.data.message.content = []
  assert.equal(isMarkerEvent(selfEaten), true, '空 content 也仍是 marker（判据是 surfaceOp，不是文本）')
})

test('④ 删除已被遮蔽的消息必须 409（宿主会报 start seq not found in surface）', () => {
  const events = s645bFixture()
  assert.equal(diskSurfaceNodes(events).includes(8), false, '8..15 已被 marker 21 遮蔽')
  assert.throws(
    () => planDeleteFromEvents(events, 8),
    e => e.status === 409 && /not visible/i.test(e.message),
  )
  assert.throws(
    () => planRevertFromEvents(events, 8),
    e => e.status === 409,
  )
})

// ── ⑤ 数值可见 ≠ 宿主可见（session-008f3759 的 343 个假可见节点）─────────────
/**
 * 真实成因：marker 12416 `replace(6338, 10003)`。节点序上 6338 在索引 1、10003 在
 * 索引 3，中间的 4445 在**数值上小于 6338**（4445 < 6338），所以「数值区间」判据
 * 认为它从来没被遮蔽 → 旧 `diskVisibleNodes` 把它当可见 → 删除/回滚它会产出
 * `surface replace: start seq 4445 not found in surface`
 * （实测该会话 1017 个"可见"节点里 343 个不在宿主 surface 上，首批 4445/4447/4453…）。
 */
function s008fFixture() {
  // 日志顺序（seq 升序）：4445 < 6338，但 6338 的 replace 覆盖 9..4441 之后，
  // 节点序变成 [6338, 4445, ..., 10003] —— 4445 因此**排到** 6338 之后，被 12416 一网打尽。
  return [
    userMsg(9, '会话首条用户消息'),
    toolResult(4441, 'ls ~/.dsh/sessions'),
    userMsg(4445, '把 proxy 换到 18902 试试', 'team-message'),
    checkpoint(6338, 9, 4441, [9, 4441]),
    userMsg(10003, '压缩后的新用户消息', 'subagent-settled'),
    checkpoint(12416, 6338, 10003, [6338, 4445, 10003]),
  ]
}

test('⑤ 节点序折叠把「数值上靠前」的节点也算作被遮蔽（008f 4445 的真实形态）', () => {
  const events = s008fFixture()
  const surface = diskSurfaceNodes(events)
  assert.deepEqual(surface, [12416], '6338 在索引 1、10003 在索引 3 → 中间的 4445 一并被遮蔽')
  assert.deepEqual(surface, refold(events))

  const numeric = computeShadowed(events)
  assert.equal(numeric.has(4445), false, '数值判据认为 4445 未被遮蔽（缺陷成因）')
  assert.equal(surface.includes(4445), false, '节点序判据认为它已被遮蔽（宿主的真实判定）')

  assert.throws(
    () => planDeleteFromEvents(events, 4445),
    e => e.status === 409 && /not visible/i.test(e.message),
    '否则整份日志被宿主拒绝',
  )
  assert.throws(
    () => planRevertFromEvents(events, 4445),
    e => e.status === 409,
  )
})

// ── ⑥ 按轮步进（upToSeq）语义在节点序候选下保持不变 ─────────────────────────
test('⑥ upToSeq 只重放到该 seq，后续候选仍保持遮蔽且不计 skipped', () => {
  const events = ab6fFixture()
  const full = planRestore(events, 1197)
  const step1 = planRestore(events, 1197, 89)
  assert.deepEqual(
    full.replayable.map(i => i.seq),
    [89, 90],
  )
  assert.deepEqual(
    step1.replayable.map(i => i.seq),
    [89],
    'upToSeq=89 → 只重放 89',
  )
  assert.equal(step1.upToSeq, 89)
  assert.equal(step1.skipped, 0, '被 upToSeq 挡住的候选是"仍遮蔽"，不是"跳过"')
  const step2 = planRestore(events, 1197, 1200, [89])
  assert.deepEqual(
    step2.replayable.map(i => i.seq),
    [90],
    'excludeSeqs=已重放的 89 → 只补 90',
  )
})

test('⑥ 空可重放区间仍是「停用」而非 409（0.5.6 语义不回退）', () => {
  const events = [
    userMsg(3410, '嗯，你分配智能体'),
    userMsg(3411, '<time-context> snapshot', 'time-context'),
    marker(3417, 3410, 3411, [3410, 3411]),
    marker(3424, 3417, 3417, [3417], ''),
  ]
  events[3].data.message.content = []
  const plan = planRestore(events, 3424)
  assert.equal(plan.replayable.length, 0, '自噬空 marker 遮蔽的是 marker 自己 → 无可重放')
  assert.match(restoreNoticeText(plan), /无可重放/, '产物必须是停用文案（dock 才清得掉这一行）')
  assert.equal(restoreProgress(events, 3424).complete, true, '0 候选 → 已完成（不留活跃条）')
})

// ── ⑦ 历史/损坏 marker 的数值兜底仍能打开日志（不得 throw）─────────────────────
test('⑦ 端点不在节点表上的历史 marker：折叠不 throw，候选退回数值区间', () => {
  const events = [systemPrompt(0), userMsg(500, '历史消息 A'), asstMsg(501, '历史回答 A'), marker(1001, 999, 1000, [999, 1000])]
  const surface = diskSurfaceNodes(events)
  assert.ok(surface.includes(1001), '无法定位时必须把 marker 自身收进节点表，绝不能 throw')
  const plan = planRestore(events, 1001)
  assert.equal(plan.replayable.length, 0, '数值区间 [999..1000] 里没有事件')
  assert.equal(plan.startSeq, 999)
})

test('⑦ 反向区间且无 provenance：无法等价推导 → 不误重放、不 throw', () => {
  const events = [
    userMsg(8, 'A'),
    asstMsg(9, 'B'),
    {
      type: 'system/message',
      seq: 20,
      time: 1,
      data: {
        turn: 2,
        step: 1,
        message: { id: 'x', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'm' }] },
      },
      surfaceOp: { op: 'replace', startSeq: 9, endSeq: 8 },
    },
  ]
  const plan = planRestore(events, 20)
  assert.equal(plan.startSeq, 9)
  assert.equal(plan.endSeq, 8, '区间原样保留（不擅自翻转）')
  assert.equal(plan.replayable.length, 0, '无凭据的反向区间无法等价推导 → 不重放任何东西')
})

// ── ⑧ 巨量 provenance 不是候选集（真实 1191 的 373 条凭据）────────────────────
test('⑧ marker 凭据是遮蔽集超集时，候选仍只取真实遮蔽集', () => {
  const events = ab6fFixture()
  const m = events.find(e => e.seq === 1191)
  m.sourceEventSeqs = [114, 115, 1185, 1190, 1189, 1188]
  const plan = planRestore(events, 1191)
  // 节点序遮蔽集 = [114, 115, 1185]（1185 是真实 assistant/message，是 endSeq 节点）。
  assert.deepEqual(
    plan.replayable.map(i => i.seq),
    [114, 115, 1185],
    '取节点序遮蔽集，不是凭据全集',
  )
  assert.ok(!plan.replayable.some(i => [1190, 1189, 1188].includes(i.seq)), '凭据里多出来的 3 条结构性 seq 不得被当作消息重放')
  assert.deepEqual(restoreProgress(events, 1191).pendingSeqs, [114, 115, 1185])
})

// ── ⑨ planDelete / planRevert（live 对象层路径）与磁盘路径同判 ────────────────
test('⑨ live surface 对象层：节点序 + 同样的头节点护栏', () => {
  const events = headFixture()
  const surface = { nodes: diskSurfaceNodes(events) }
  const plan = planRevert(surface, 8)
  assert.deepEqual(plan.shadowedSeqs, [8, 9, 10], 'live 路径同语义')
  assert.throws(
    () => planRevert(surface, 0),
    e => e.status === 409 && /node 0 holds the system prompt/i.test(e.message),
  )
  assert.deepEqual(planDelete(surface, 0).shadowedSeqs, [0], '单节点头改写合法')
  assert.throws(
    () => planDelete(surface, 99),
    e => e.status === 409,
  )
})
