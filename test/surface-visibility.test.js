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
 *
 * ⚠️ 0.26.0（审计 §4.1）修正了一个**假绿灯**：本文件原先的 parseNodeKey /
 * buildIndex / seqOfNodeKey 是**手抄的「同构副本」**（注释自己写着「与 client.js
 * 同构」），根本不读 `src/client.js` —— 于是生产里 `hit.all` / `dupByMessageId`
 * 明明 0 个读取方，这里却用副本维护着它们、还断言它们「正确」，测试全绿。
 * 现在改成**从生产源码抽出真实实现**（`blockAt` + `new Function`，与
 * client-perf-locks 抽 applySurfaceVisibility 同款手法）真执行：
 *   · 生产改了索引形状 → 这里立刻红（而不是继续测副本）；
 *   · `all` / `dupByMessageId` 已删 → 对应两条回归锁换成「不得复活」的正向断言。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readSource, blockAt } from './_source.js'

/**
 * 从 `src/client.js` 抽出 `parseNodeKey` / `buildIndex` / `seqOfNodeKey` 三个
 * **生产实现**并组合成可调用三元组。抽不到就硬失败（绝不允许退回「测副本」）。
 */
function loadProductionIndex() {
  const src = readSource()
  const pn = blockAt(src, 'var parseNodeKey = ')
  assert.ok(pn, '源码里抠不出 parseNodeKey —— 必须硬失败，不许退回手抄副本')
  const bi = blockAt(src, 'var buildIndex = ')
  assert.ok(bi, '源码里抠不出 buildIndex')
  const sk = blockAt(src, 'var seqOfNodeKey = ')
  assert.ok(sk, '源码里抠不出 seqOfNodeKey')
  // eslint-disable-next-line no-new-func
  const parseNodeKey = new Function(pn + '; return parseNodeKey')()
  // eslint-disable-next-line no-new-func
  const buildIndexPayload = new Function(bi + '; return buildIndex')()
  // eslint-disable-next-line no-new-func
  const seqFn = new Function('parseNodeKey', sk + '; return seqOfNodeKey')(parseNodeKey)
  /** 生产 `buildIndex` 吃的是 **payload 对象**（`{ messages, turnEndSeq }`），
   *  而本文件的语料是「消息数组」—— 这里做一次薄适配（不是副本：索引逻辑仍走生产）。 */
  const buildIndex = payload => buildIndexPayload(Array.isArray(payload) ? { messages: payload } : payload || {})
  return { parseNodeKey, buildIndex, seqOfNodeKey: seqFn, rawBuildIndex: buildIndexPayload }
}

const PROD = loadProductionIndex()
const { parseNodeKey, buildIndex, seqOfNodeKey } = PROD

// ── 真实形状的语料（取自分支会话 session-0da37218）─────────────────────────
const K = {
  user: id => `13:input-message${id}`,
  step: (t, s) => `14:assistant-step${t}:${s}`,
  tool: id => `9:tool-call${id}`,
  tail: t => `9:turn-tail${t}`,
  process: t => `12:turn-process${t}`,
  dev: id => `17:developer-message${id}`,
}
const CORPUS = [
  { seq: 8, type: 'user/message', id: '8b5093a5-205e-4108-a886-00981bbd57da', visible: true, reverted: false },
  { seq: 18, type: 'assistant/message', id: 'a1', turn: 1, step: 1, visible: true, reverted: false },
  { seq: 19, type: 'tool/call', id: 'call_2a9430d7030b4c04a75e7e87', turn: 1, step: 1, visible: false, reverted: false },
  { seq: 21, type: 'tool/call', id: 'call_2da69ea515e64d6181458e2f', turn: 1, step: 2, visible: false, reverted: false },
  { seq: 25, type: 'assistant/message', id: 'a2', turn: 1, step: 2, visible: true, reverted: false },
  { seq: 26, type: 'tool/call', id: 'call_c30c0f21878a43f0926c77a9', turn: 1, step: 2, visible: false, reverted: false },
  { seq: 54, type: 'user/message', id: '71921f48-3f8a-4f97-951f-122cfd64cb2e', visible: true, reverted: true },
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
  // ⚠️ SV-M3 变异实测：turn-chrome 分支**丢 `turn` 字段**时上面的断言全绿 ——
  // 因为真执行它的调用方（applySurfaceVisibility）判据是 `hit.turn !== undefined`，
  // 丢了 turn 就会把「回合 chrome」误当普通消息处理（用它的 seq 去查 shadowed 集合）。
  // 这不只是形状问题：turn-tail 行将被按错误判据藏/露。必须显式锁住。
  for (const key of [K.tail(1), K.process(1), K.tail(3)]) {
    const hit = seqOfNodeKey(key, idx)
    if (hit) assert.equal(typeof hit.turn, 'string', key + ' 必须带 turn（chrome 判据靠 hit.turn !== undefined，丢了会误判藏露）')
  }
  // 反向对照：消息类节点的返回**不该**带 turn（否则会被误当 chrome）
  assert.equal(seqOfNodeKey(K.user('8b5093a5-205e-4108-a886-00981bbd57da'), idx)?.turn, undefined, '消息类不得带 turn')
  assert.equal(seqOfNodeKey(K.tool('call_2a9430d7030b4c04a75e7e87'), idx)?.turn, undefined, '工具类不得带 turn')
})

test('回归：生产索引**不建** visible / reverted 集合（藏行只认 shadowed）', () => {
  // 0.9.6 血案：tool/call 在 live 路径下恒 visible=false，拿 `visible` 当藏行判据
  // 会把整页工具行全藏（实测 157 行藏 152 行）。生产因此**连集合都不建**
  // （client.js buildIndex 里那句“故这里连集合都不建”）。这里锁的是**形状**：
  const idx = buildIndex(CORPUS)
  assert.equal('visible' in idx, false, '索引不得再维护 visible 集合（唯一会误藏用户内容的判据）')
  assert.equal('reverted' in idx, false, '索引不得再维护 reverted（0.9.4 已换成 shadowed 区间口径）')
  assert.ok(idx.shadowed instanceof Set, '藏行判据必须是 shadowed（replace 区间）')
  // 语义对照：三个 tool-call 若按 visible 判会被全部误藏 —— 这就是不许用它的原因
  const toolSeqs = ['call_2a9430d7030b4c04a75e7e87', 'call_2da69ea515e64d6181458e2f', 'call_c30c0f21878a43f0926c77a9'].map(
    id => seqOfNodeKey(K.tool(id), idx)?.seq,
  )
  assert.deepEqual(toolSeqs, [19, 21, 26], '三个 tool-call 仍要被索引到（只是不许拿 visible 判藏）')
  const wronglyHidden = CORPUS.filter(m => toolSeqs.includes(m.seq) && m.visible !== true)
  assert.equal(wronglyHidden.length, 3, '语料里三个 tool-call 都是 visible=false —— 用 visible 判就会 3/3 全藏')
  // 正确的 shadowed 判据：语料里没有任何 tool-call 落在 replace 区间内 → 一个都不藏
  assert.equal(toolSeqs.filter(q => idx.shadowed.has(q)).length, 0, '按 shadowed 判，工具行一个都不该藏')
})

test('shadowed 口径：只藏 replace 区间内的 seq（不是 visible=false）', () => {
  const idx = buildIndex([
    { seq: 8, type: 'user/message', id: 'a', shadowed: false, turn: 1 },
    { seq: 54, type: 'user/message', id: 'b', shadowed: true, turn: 1 },
    { seq: 26, type: 'tool/call', id: 'c', shadowed: false, turn: 1, visible: false },
  ])
  assert.equal(idx.shadowed.has(54), true, '落在 replace 区间内的必须被藏')
  assert.equal(idx.shadowed.has(26), false, '工具调用行只是 visible=false，绝不是“被回滚”，不许藏')
  assert.equal(idx.shadowed.has(8), false)
  // visibleTurns = 含至少一条未遮蔽消息的 turn（回合 chrome 的判据）
  assert.equal(idx.visibleTurns.has('1'), true, 'turn 1 里有未被遮蔽的消息 → chrome 露出')
  assert.equal(
    buildIndex([{ seq: 60, type: 'user/message', id: 'z', shadowed: true, turn: 2 }]).visibleTurns.has('2'),
    false,
    '整轮都被遮蔽 → chrome 藏',
  )
})

test('重复 messageId：生产只留最新一个 seq（不再维护 dup 全集）', () => {
  // 0.9.1 曾维护 `dupByMessageId`（同 id 全部 seq）+ `hit.all`，供已在 0.9.6
  // 换成 shadowed 判据的旧 fence 逻辑使用 → 0.26.0 删（审计 §4.1）。
  // 仍然成立的事实：restore 是「重放」语义，同 id 可能原件与副本并存，
  // 查表必须指向**最新**（当前 surface 上那条），否则“恢复后再回滚”会拿旧 seq。
  const idx = buildIndex([
    { seq: 5, type: 'user/message', id: 'dup', shadowed: false },
    { seq: 99, type: 'user/message', id: 'dup', shadowed: false }, // 重放副本
  ])
  assert.equal(idx.byMessageId.get('dup'), 99, '必须指向最新（当前 surface 上的那条），不是最早')
  assert.deepEqual(
    Object.keys(idx),
    ['byMessageId', 'byTurnStep', 'byCallId', 'byTurn', 'shadowed', 'visibleTurns', 'total'],
    '索引只许有被消费的字段（多一个 = 多一份没人读的状态）',
  )
  // 已删字段不得复活（真正的正向断言，不再测手抄副本）
  assert.equal('dupByMessageId' in idx, false, 'dupByMessageId 生产 0 读者，已删不许复活')
  assert.equal('dupMessageId' in idx, false, 'dup 计数同样没有消费者')
  assert.equal(seqOfNodeKey(K.user('dup'), idx).all, undefined, 'seqOfNodeKey 不得再返回 all（隐藏判据已换成 shadowed）')
})

test('回归：恢复后再回滚 —— 副本 seq 越过 replace 区间时，必须按最新 seq 判藏', () => {
  // 旧机制（fences + hit.all 逐 seq 比对）已随 dupByMessageId 删除；
  // 现在判据是 shadowed 区间 + byMessageId 指向最新。等价场景：
  //   原件 seq=54（未遮蔽）、restore 副本 seq=70（落在 replace 区间内）
  // 若查表返回**最早**的 54，就会得出“未遮蔽”→ 漏藏（这正是 0.9.1 那条事故）。
  const idx = buildIndex([
    { seq: 54, type: 'user/message', id: 'x', shadowed: false },
    { seq: 70, type: 'user/message', id: 'x', shadowed: true },
  ])
  const hit = seqOfNodeKey(K.user('x'), idx)
  assert.equal(hit.seq, 70, '查表必须指向副本（最新），否则“恢复后再回滚”会拿原件 seq')
  assert.equal(idx.shadowed.has(hit.seq), true, '副本落在 replace 区间内 → 该藏')
  assert.equal(idx.shadowed.has(54), false, '原件本身不在区间内（判据不靠它）')
  assert.equal(hit.all, undefined, 'hit.all 已删：判据不再需要“全部 seq”，只认最新 + 区间集合')
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

test('空/畸形 payload 不抛异常', () => {
  const idx = buildIndex(undefined)
  assert.equal(idx.total, 0)
  assert.equal(seqOfNodeKey(K.user('x'), idx), null)
})
