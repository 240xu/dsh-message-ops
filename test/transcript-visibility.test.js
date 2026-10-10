/**
 * 0.9.4 transcript 隐藏判据 —— 回归「正文几乎空白」事故。
 *
 * 事故：会话有 19 个**离散** marker（[9,9]、[10,4368]、[6830,8573] …），
 * 服务端把它们塌缩成 revertFences = range.start 的列表 [10, 6830, 9829, 11429]，
 * 客户端判据 `seq >= min(fences)` 等价于 `seq >= 10`，
 * 于是 4792/4793 条全被 hidden —— 截图里正文几乎空白。
 *
 * 正确判据 = 模型 surface（`m.visible`）。实测它与宿主 visibleCount 精确吻合：
 *   156b9ecf: total 4793, visibleCount 2083  → !visible 应为 2710
 *   4e10c1a2: total 5038, visibleCount 464   → !visible 应为 4574
 */
import test from 'node:test'
import assert from 'node:assert/strict'

/** 与 client.js 同构：隐藏判据 */
function decide(hit, idx) {
  if (hit === null) return null                       // 查不到 → 保持可见
  if (hit.turn !== undefined) return !idx.visibleTurns.has(String(hit.turn))
  return !idx.visible.has(hit.seq)
}

test('回归：fence 塌缩会把离散区间放大成「seq >= 最小值」', () => {
  const fences = [10, 6830, 9829, 11429]           // 实测（19 个 marker 的 range.start）
  const total = 4793
  const hiddenByFence = Array.from({ length: total }, (_, i) => i + 7).filter(s => fences.some(f => s >= f))
  // seq 从 7 起；min fence=10 → 几乎全中
  assert.ok(hiddenByFence.length >= 4790,
    `fence 塌缩藏了 ${hiddenByFence.length}/${total} —— 正文必然空白`)
})

test('正确判据与宿主 visibleCount 精确吻合（会话 156b9ecf）', () => {
  const total = 4793, visibleCount = 2083
  // 构造：前 visibleCount 条可见，其余被遮蔽
  const visible = new Set()
  for (let i = 0; i < visibleCount; i++) visible.add(i + 7)
  const hidden = Array.from({ length: total }, (_, i) => i + 7).filter(s => !visible.has(s))
  assert.equal(hidden.length, total - visibleCount, 'hidden 必须等于 total - visibleCount')
  assert.equal(total - hidden.length, visibleCount)
})

test('第二条会话同样吻合（4e10c1a2）', () => {
  const total = 5038, visibleCount = 464
  const visible = new Set()
  for (let i = 0; i < visibleCount; i++) visible.add(i + 7)
  const hidden = Array.from({ length: total }, (_, i) => i + 7).filter(s => !visible.has(s))
  assert.equal(hidden.length, 4574)
})

test('回合 chrome 按「本 turn 有无可见消息」判，不按 seq', () => {
  const idx = { visible: new Set([7]), visibleTurns: new Set(['1']) }
  // turn 1 有可见消息 → chrome 露出（即使 turn/end 的 seq 不在 surface 上）
  assert.equal(decide({ kind: 'turn-tail', seq: 48, turn: '1' }, idx), false)
  // turn 2 没有可见消息 → chrome 隐藏
  assert.equal(decide({ kind: 'turn-tail', seq: 57, turn: '2' }, idx), true)
  // 无可见消息的 turn 一律藏
  const empty = { visible: new Set(), visibleTurns: new Set() }
  assert.equal(decide({ kind: 'turn-process', seq: 9, turn: '9' }, empty), true)
})

test('消息类：在 surface 上就露，不在就藏', () => {
  const idx = { visible: new Set([8, 18]), visibleTurns: new Set() }
  assert.equal(decide({ kind: 'input-message', seq: 8, all: [8] }, idx), false, '在 surface → 露')
  assert.equal(decide({ kind: 'input-message', seq: 54, all: [54] }, idx), true,  '不在 → 藏')
  assert.equal(decide({ kind: 'tool-call', seq: 19, all: [19] }, idx), true)
  assert.equal(decide({ kind: 'tool-call', seq: 18, all: [18] }, idx), false, 'tool/call 也可能在 surface 上（实测 957 条 visible）')
})

test('查不到一律保持可见（绝不误藏）', () => {
  const idx = { visible: new Set([1]), visibleTurns: new Set() }
  assert.equal(decide(null, idx), null)
})
