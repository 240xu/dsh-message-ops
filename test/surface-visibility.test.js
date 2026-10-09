/**
 * 0.9.1 transcript 可见性映射 —— 回归锁死。
 *
 * 背景：dsh 的 transcript **刻意不做 surface 折叠**（surface.d.ts:51-63
 * "replacement copies stay model-only"）。回滚要「看得见」只能在渲染层处理，
 * 而唯一可靠的行↔日志映射是 `data-chat-node-key` 里内嵌的官方 id。
 *
 * 本文件锁三件事：
 *  ① node-key 解析与查表（含 assistant-step 一 node 两行）
 *  ② **不能用 `visible` 当隐藏判据** —— tool/call 等非 surface 事件永远 visible=false，
 *     照抄会把所有工具调用行永久藏掉（实测 3/3 全被误藏）
 *  ③ 查不到时保持可见，绝不误藏
 */
import test from 'node:test'
import assert from 'node:assert/strict'

/** 与 client.js 的 parseNodeKey / buildIndex / seqOfNodeKey 同构 */
function parseNodeKey(k) {
  const m = /^(\d+):/.exec(k || '')
  if (!m) return null
  const digits = m[1].length
  const kindLen = Number(m[1])
  const start = digits + 1
  if (!Number.isSafeInteger(kindLen) || kindLen <= 0 || k.length < start + kindLen) return null
  return { kind: k.slice(start, start + kindLen), id: k.slice(start + kindLen) }
}

function buildIndex(list) {
  const dupByMessageId = new Map()
  const byMessageId = new Map(), byTurnStep = new Map(), byCallId = new Map(), byTurn = new Map()
  const visible = new Set(), reverted = new Set()
  let dupMessageId = 0
  for (const m of list || []) {
    if (!m || typeof m.seq !== 'number') continue
    if (m.id != null) {
      const k = String(m.id)
      if (byMessageId.has(k)) {
        dupMessageId++
        const arr = dupByMessageId.get(k) || [byMessageId.get(k)]
        arr.push(m.seq); dupByMessageId.set(k, arr); byMessageId.set(k, m.seq)
      } else { byMessageId.set(k, m.seq) }
    }
    if (m.type === 'assistant/message' && m.turn != null && m.step != null) byTurnStep.set(m.turn + ':' + m.step, m.seq)
    if (m.type === 'tool/call' && m.id != null) byCallId.set(String(m.id), m.seq)
    if (m.turn != null && !byTurn.has(String(m.turn))) byTurn.set(String(m.turn), m.seq)
    if (m.visible === true) visible.add(m.seq)
    if (m.reverted === true) reverted.add(m.seq)
  }
  return { byMessageId, dupByMessageId, byTurnStep, byCallId, byTurn, visible, reverted, dupMessageId, total: (list || []).length }
}

function seqOfNodeKey(key, idx) {
  const p = parseNodeKey(key)
  if (!p || !idx) return null
  switch (p.kind) {
    case 'input-message': case 'developer-message': case 'trajectory-note': {
      const h = idx.byMessageId.get(p.id)
      return h === undefined ? null : { seq: h, all: idx.dupByMessageId.get(p.id) || [h] }
    }
    case 'assistant-step': { const h = idx.byTurnStep.get(p.id); return h === undefined ? null : { seq: h, all: [h] } }
    case 'tool-call': { const h = idx.byCallId.get(p.id); return h === undefined ? null : { seq: h, all: [h] } }
    case 'turn-tail': case 'turn-process': case 'turn-error': case 'turn-max-tokens': case 'model-retry': {
      const h = idx.byTurn.get(p.id); return h === undefined ? null : { seq: h, all: [h] }
    }
    default: return null
  }
}

// ── 真实形状的语料（取自分支会话 session-0da37218）─────────────────────────
const K = {
  user:    (id) => `13:input-message${id}`,
  step:    (t, s) => `14:assistant-step${t}:${s}`,
  tool:    (id) => `9:tool-call${id}`,
  tail:    (t) => `9:turn-tail${t}`,
  process: (t) => `12:turn-process${t}`,
  dev:     (id) => `17:developer-message${id}`,
}
const CORPUS = [
  { seq: 8,  type: 'user/message', id: '8b5093a5-205e-4108-a886-00981bbd57da', visible: true,  reverted: false },
  { seq: 18, type: 'assistant/message', id: 'a1', turn: 1, step: 1, visible: true, reverted: false },
  { seq: 19, type: 'tool/call', id: 'call_2a9430d7030b4c04a75e7e87', turn: 1, step: 1, visible: false, reverted: false },
  { seq: 21, type: 'tool/call', id: 'call_2da69ea515e64d6181458e2f', turn: 1, step: 2, visible: false, reverted: false },
  { seq: 25, type: 'assistant/message', id: 'a2', turn: 1, step: 2, visible: true, reverted: false },
  { seq: 26, type: 'tool/call', id: 'call_c30c0f21878a43f0926c77a9', turn: 1, step: 2, visible: false, reverted: false },
  { seq: 54, type: 'user/message', id: '71921f48-3f8a-4f97-951f-122cfd64cb2e', visible: true,  reverted: true },
  { seq: 63, type: 'system/message', id: 'm1', visible: true, reverted: false, marker: true, range: { start: 54, end: 54 } },
]

test('parseNodeKey：解析 <len>:<kind><id>', () => {
  assert.deepEqual(parseNodeKey(K.user('abc')), { kind: 'input-message', id: 'abc' })
  assert.deepEqual(parseNodeKey(K.step(1, 2)), { kind: 'assistant-step', id: '1:2' })
  assert.deepEqual(parseNodeKey(K.tail(3)), { kind: 'turn-tail', id: '3' })
  assert.equal(parseNodeKey(''), null)
  assert.equal(parseNodeKey('garbage'), null)
  assert.equal(parseNodeKey('99:tool-call'), null, '声明长度超出字符串 → null')
})

test('查表：六种行全部命中真实 seq', () => {
  const idx = buildIndex(CORPUS)
  assert.equal(seqOfNodeKey(K.user('8b5093a5-205e-4108-a886-00981bbd57da'), idx)?.seq, 8)
  assert.equal(seqOfNodeKey(K.step(1, 1), idx)?.seq, 18)
  assert.equal(seqOfNodeKey(K.tool('call_2a9430d7030b4c04a75e7e87'), idx)?.seq, 19)
  assert.equal(seqOfNodeKey(K.tail(1), idx)?.seq, 18, 'turn 号映射到该 turn 首个带 turn 字段的消息 seq（回合页脚不是消息，用锚点近似）')
  assert.equal(seqOfNodeKey(K.dev('nope'), idx), null, '未知 id → null')
})

test('回归：用 visible 当隐藏判据会误藏全部工具调用行', () => {
  const idx = buildIndex(CORPUS)
  const wronglyHidden = ['call_2a9430d7030b4c04a75e7e87', 'call_2da69ea515e64d6181458e2f', 'call_c30c0f21878a43f0926c77a9']
    .filter((id) => !idx.visible.has(seqOfNodeKey(K.tool(id), idx)?.seq))
  assert.equal(wronglyHidden.length, 3, '三个 tool-call 都 visible=false —— 这就是为什么不能用 visible')
  // 用 reverted 则一个都不该被误藏
  const withReverted = wronglyHidden.filter((id) => idx.reverted.has(seqOfNodeKey(K.tool(id), idx)?.seq))
  assert.equal(withReverted.length, 0)
})

test('reverted 口径：只藏边界及其后', () => {
  const idx = buildIndex(CORPUS)
  assert.equal(idx.reverted.has(54), true, '边界消息自己也要藏（opencode slice(0, boundaryIndex)）')
  assert.equal(idx.reverted.has(26), false, '边界之前的不藏')
  assert.equal(idx.reverted.has(8), false)
})

test('查不到时返回 null → 调用方保持可见（绝不误藏）', () => {
  const idx = buildIndex(CORPUS)
  assert.equal(seqOfNodeKey(K.user('00000000-0000-0000-0000-000000000000'), idx), null)
  assert.equal(seqOfNodeKey(K.step(9, 9), idx), null)
  assert.equal(seqOfNodeKey(K.tail(9), idx), null)
})

test('compaction / command 等不参与映射（它们不是回撤对象）', () => {
  const idx = buildIndex(CORPUS)
  assert.equal(seqOfNodeKey('9:compactionxx', idx), null)
  assert.equal(seqOfNodeKey('7:commandyy', idx), null)
})

test('重复 messageId（restore 重放）保留全部 seq，指向最新', () => {
  const idx = buildIndex([
    { seq: 5, type: 'user/message', id: 'dup', visible: true },
    { seq: 99, type: 'user/message', id: 'dup', visible: true },   // 重放副本
  ])
  assert.equal(idx.byMessageId.get('dup'), 99, '指向最新（当前 surface 上的那条）')
  assert.deepEqual(idx.dupByMessageId.get('dup'), [5, 99])
  assert.equal(idx.dupMessageId, 1)
})

test('回归：恢复后再回滚，副本必须被藏（用最早 seq 判会漏）', () => {
  // fence=70；原件 seq=54、restore 副本 seq=70
  const idx = buildIndex([
    { seq: 54, type: 'user/message', id: 'x', visible: true },
    { seq: 70, type: 'user/message', id: 'x', visible: true },
  ])
  idx.fences = [70]
  const hit = seqOfNodeKey(K.user('x'), idx)
  const cands = hit.all
  const hiddenByEarliestOnly = idx.fences.some((f) => cands[0] >= f)      // 54 >= 70 → false
  const hiddenByAny = idx.fences.some((f) => cands.some((q) => q >= f))     // 70 >= 70 → true
  assert.equal(hiddenByEarliestOnly, false, '只用最早 seq 会漏藏')
  assert.equal(hiddenByAny, true, '任一 seq 越过 fence 就要藏')
})

test('空/畸形 payload 不抛异常', () => {
  const idx = buildIndex(undefined)
  assert.equal(idx.total, 0)
  assert.equal(seqOfNodeKey(K.user('x'), idx), null)
})
