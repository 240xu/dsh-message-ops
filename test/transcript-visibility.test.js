/**
 * 0.9.4 transcript 隐藏判据 —— 回归「正文几乎空白」事故。
 *
 * 🔴🔴 本文件是「历史判据的回归样本」，**不是**当前实现的规格 🔴🔴
 *
 * 文件里的 `decide()` / `visible` 集合 / `fences` 全是 **0.9.4 时代的判据副本**，
 * 与 `src/client.js` 当前（0.9.6+）的 `shadowed` 判据**不同源**：
 *   - 当前真判据：`shouldHide = idx.shadowed.has(hit.seq)`（replace 区间）+ 回合 chrome
 *     的 `!idx.visibleTurns.has(turn)`；权威锁在 `test/client-perf-locks.test.js`。
 *   - 本文件保留的是「当年为什么会出事、当年怎么算的」的原始样本，全绿只因测的是自己的副本。
 * ⛔ **禁止**把这里的 helper 与其它测试的 helper 合并去重 —— 合并等于把 0.9.4 的
 *    过期契约焊死成「现行契约」。`test/undo-slash.test.js` 的
 *    `shouldHide(cands, fences, reverted)` 与本文件属同一批，同样不许合并。
 *    （唯一仍与现行实现同源的是 `pickLastVisible`：它对齐 client.js 的
 *     `lastRevertable`「可回滚目标」语义，那一套至今仍用 `visible`。）
 *
 * 事故：会话有 19 个**离散** marker（[9,9]、[10,4368]、[6830,8573] …），
 * 服务端把它们塌缩成 revertFences = range.start 的列表 [10, 6830, 9829, 11429]，
 * 客户端判据 `seq >= min(fences)` 等价于 `seq >= 10`，
 * 于是 4792/4793 条全被 hidden —— 截图里正文几乎空白。
 *
 * 当时（0.9.4）认为的正确判据 = 模型 surface（`m.visible`）。实测它与宿主
 * visibleCount 精确吻合：
 *   156b9ecf: total 4793, visibleCount 2083  → !visible 应为 2710
 *   4e10c1a2: total 5038, visibleCount 464   → !visible 应为 4574
 * ⚠️ 0.9.6 又把它换成了 `shadowed`（live 路径下 tool/call 恒 visible=false，
 *    拿 visible 当判据会整页误藏工具行）—— 见文件末尾的「当前判据对照」测试。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

/** 0.9.4 判据（已废弃）的历史副本 —— 与 client.js 当前 shadowed 判据不同源，禁止合并。 */
function decide(hit, idx) {
  if (hit === null) return null                       // 查不到 → 保持可见
  if (hit.turn !== undefined) return !idx.visibleTurns.has(String(hit.turn))
  return !idx.visible.has(hit.seq)
}

test('回归：fence 塌缩会把离散区间放大成「seq >= 最小值」', () => {
  // [0.9.4 判据（已废弃）] fences 只存在于历史实现，client.js 早已不发 revertFences。
  const fences = [10, 6830, 9829, 11429]           // 实测（19 个 marker 的 range.start）
  const total = 4793
  const hiddenByFence = Array.from({ length: total }, (_, i) => i + 7).filter(s => fences.some(f => s >= f))
  // seq 从 7 起；min fence=10 → 几乎全中
  assert.ok(hiddenByFence.length >= 4790,
    `fence 塌缩藏了 ${hiddenByFence.length}/${total} —— 正文必然空白`)
})

test('正确判据与宿主 visibleCount 精确吻合（会话 156b9ecf）', () => {
  // [0.9.4 判据（已废弃）] 当时的「正确判据」= m.visible；0.9.6 起真判据是 shadowed。
  const total = 4793, visibleCount = 2083
  // 构造：前 visibleCount 条可见，其余被遮蔽
  const visible = new Set()
  for (let i = 0; i < visibleCount; i++) visible.add(i + 7)
  const hidden = Array.from({ length: total }, (_, i) => i + 7).filter(s => !visible.has(s))
  assert.equal(hidden.length, total - visibleCount, 'hidden 必须等于 total - visibleCount')
  assert.equal(total - hidden.length, visibleCount)
})

test('第二条会话同样吻合（4e10c1a2）', () => {
  // [0.9.4 判据（已废弃）] 同上：visible 口径的量化样本。
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
  // [0.9.4 判据（已废弃）] 消息类分支用的 idx.visible 已被 0.9.6 的 shadowed 取代；
  // 回合 chrome 分支（visibleTurns）仍与现行实现同源。
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

// ── 对照：现行实现（0.9.6+）用的是 shadowed，不是本文件上面那些副本 ──────────
// 上面所有断言都是历史判据的回归样本；这一条负责把「真判据在 client.js 哪里」钉死，
// 免得后人误以为本文件的 decide() 就是现行规格。
test('[当前判据对照] client.js 藏行判据 = idx.shadowed，不是本文件的 visible/fences 副本', () => {
  const src = fs.readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  assert.ok(/shouldHide = idx\.shadowed\.has\(hit\.seq\)/.test(src),
    '消息/工具类判据必须是 idx.shadowed（0.9.6）')
  assert.ok(/shouldHide = !idx\.visibleTurns\.has\(String\(hit\.turn\)\)/.test(src),
    '回合 chrome 判据必须是 idx.visibleTurns')
  assert.ok(!/idx\.visible\.has\(/.test(src),
    'client.js 不得回退到 idx.visible 判据（live 路径下 tool/call 恒 false → 整页误藏）')
  // revertFences 允许出现在**注释**里（指向 README「历史事故记录」#4 的演进史指针），
  // 但任何**代码行**出现 = 塌缩判据复活 —— 所以先剥掉整行注释再查。
  const codeOnly = src.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n')
  assert.ok(!/\brevertFences\b/.test(codeOnly), 'client.js 代码不得复活 revertFences 塌缩判据（注释指针除外）')
})
