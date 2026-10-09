/**
 * 用户消息回滚按钮的 DOM 配对（0.9.0 修复）。
 *
 * 实机 bug：4 个 `.mopsUserRevert` 按钮全部 `data-mops-seq === null`，点击必报
 * `revert target verification failed` —— **任何发生过回滚的会话，这个按钮都是装饰品**。
 *
 * 根因：宿主聊天视图**不施加**本插件的遮蔽模型，照常渲染 seq 114 之后的全部消息；
 * 而 `fetchRows` 在 client.js:968 硬过滤 `m.visible !== false`，配对候选只剩
 * 可见的 [8,9,54]，而 DOM 块对应的是被遮蔽的 seq 897/1074 → 零交集 → hit 恒 -1。
 *
 * 修法：配对行**必须覆盖宿主实际渲染的全部 user 行（含遮蔽态）**。
 * 注意：对话框的可选目标列表（client.js:436）仍应过滤 visible —— 那是「可回滚目标」
 * 语义，与 DOM 配对是两回事，不要一起改。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const norm = (x) => String(x || '').replace(/\s+/g, '')
const injectedFixed = (raw) =>
  /^<system-reminder|current\s+runtime\s+context|^<system-Reminder/i.test(String(raw || ''))

/** client.js:965-972 的行构造（修复版：不过滤 visible，且保留 raw） */
export function buildPairRows(messages) {
  return (messages || [])
    .filter((m) => m && m.role === 'user')
    .map((m) => ({ seq: m.seq, sn: norm(m.snippet), raw: String(m.snippet ?? '') }))
    .filter((r) => r.sn && !injectedFixed(r.raw))
}

/** client.js:1000-1012 的按序配对（纯函数化，便于测试） */
export function assignSeqs(rows, blocks) {
  const assigned = []
  let ri = 0
  for (const headText of blocks) {
    const head = norm(headText.slice(0, 240))
    let hit = -1
    for (let j = ri; j < rows.length; j++) {
      const a = (rows[j].sn || '').slice(0, 40)
      const b = (head || '').slice(0, 40)
      if (a && b && (head.includes(a) || rows[j].sn.includes(b))) { hit = j; break }
    }
    assigned.push(hit >= 0 ? rows[hit].seq : null)
    if (hit >= 0) ri = hit + 1
  }
  return assigned
}

// 实机语料：393 条消息中，宿主渲染的 user 块对应的是**被遮蔽**的那批
const MESSAGES = [
  { seq: 8, role: 'user', visible: true, snippet: '分配几个子代理把模型广场的模型价格什么的做好' },
  { seq: 9, role: 'user', visible: true, snippet: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' },
  { seq: 10, role: 'user', visible: true, snippet: '<system-reminder> A skill is a reusable set of task-specific instructions.' },
  { seq: 54, role: 'user', visible: true, snippet: '基础价格按官方api价格来，缓存命中价格加上。' },
  { seq: 897, role: 'user', visible: false, snippet: '继续，你把mimo的搞好' },
  { seq: 1074, role: 'user', visible: false, snippet: '你自己看看playright去调用一下' },
]
// 宿主 DOM 实际渲染的 user 块（前 4 条可见的 + 被遮蔽后��主照常渲染的）
const DOM_BLOCKS = [
  '分配几个子代理把模型广场的模型价格什么的做好，渠道应该写好了吧',
  '基础价格按官方api价格来，缓存命中价格加上。',
  '继续，你把mimo的搞好',
  '你自己看看playright去调用一下',
]

test('buildPairRows 不过滤 visible（遮蔽消息必须进入配对候选）', () => {
  const rows = buildPairRows(MESSAGES)
  assert.deepEqual(rows.map((r) => r.seq), [8, 54, 897, 1074],
    '伪 user 行(seq9/10)被滤掉，遮蔽行(897/1074)必须保留')
})

test('回归：旧的 visible 过滤会让遮蔽行消失（这正是原 bug）', () => {
  const buggy = MESSAGES
    .filter((m) => m && m.role === 'user' && m.visible !== false)
    .map((m) => ({ seq: m.seq, sn: norm(m.snippet) }))
  assert.deepEqual(buggy.map((r) => r.seq), [8, 9, 10, 54])
  assert.deepEqual(assignSeqs(buggy, DOM_BLOCKS), [8, 54, null, null],
    '旧逻辑：两个被遮蔽块拿不到 seq → 点击必失败')
})

test('修复后：原本配不上的遮蔽块现在能配到 seq（核心回归）', () => {
  const assigned = assignSeqs(buildPairRows(MESSAGES), DOM_BLOCKS)
  assert.deepEqual(assigned, [8, 54, 897, 1074])
  assert.ok(assigned.every((s) => s !== null), '存在配对失败的块 → 按钮是装饰品')
})

test('已知局限：DOM 文本与日志摘要不一致时配不上（走兜底而非报错）', () => {
  // 实机观测：宿主渲染 `playwright`，日志 snippet 是 `playright`（模型自己写的）。
  // 配对是前 40 字的子串包含，措辞漂移就会失配 —— 这是已知局限，
  // 0.9.0 的处理是「配不上就 disabled + title 提示」，而不是点了弹错。
  const assigned = assignSeqs(buildPairRows(MESSAGES), ['你自己看看playwright去调用一下'])
  assert.deepEqual(assigned, [null])
})

test('纯 user ��息（未发生回滚的会话）行为不变', () => {
  const msgs = MESSAGES.filter((m) => m.visible !== false)
  const blocks = ['分配几个子代理把模型广场的模型价格什么的做好，渠道应该写好了吧', '基础价格按官方api价格来，缓存命中价格加上。']
  assert.deepEqual(assignSeqs(buildPairRows(msgs), blocks), [8, 54])
})

test('配对失败的块返回 null（调用方据此 disabled + title 提示，而不是点了报错）', () => {
  const assigned = assignSeqs(buildPairRows(MESSAGES), ['一个不存在的消息'])
  assert.deepEqual(assigned, [null])
})
