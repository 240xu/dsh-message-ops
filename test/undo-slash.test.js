/**
 * 0.9.3 /undo 的纯逻辑回归。
 *
 * /undo 走官方斜杠管线 `ctx.inputTriggers.registerSource`，注册路径踩过四个坑，
 * 全部锁在这里（宿主侧的契约坑无法用单测覆盖，故此文件锁「我方判定」那一半）。
 *
 * 🔴🔴 文件里的 helper 分两类，**不许与其它测试的 helper 合并去重** 🔴🔴
 *
 *  1. `shouldHide(cands, fences, reverted)` —— **0.9.4 历史判据（已废弃）** 的
 *     独立副本。client.js 0.9.6 起藏行判据已是 `idx.shadowed`（replace 区间），
 *     `fences` / `reverted` 两套都不再存在。本 helper 全绿只因测的是自己的副本；
 *     它与 `test/transcript-visibility.test.js` 的 `decide()` 属同一批历史样本。
 *     ⛔ 合并 = 把过期契约焊死成现行契约。
 *  2. `pickLastVisible(rows)` —— **仍与现行实现同源**：对齐 client.js 的
 *     `lastRevertable`（「可回滚目标」必须挑模型 surface 上的那一条，至今用
 *     `visible`）。那是另一套语义，与藏行判据无关，不要混淆。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const bare = (id) => String(id || '').replace(/^session-/, '')
const pickLastVisible = (rows) => {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i] && rows[i].seq != null && rows[i].visible) return rows[i]
  return null
}
/** [0.9.4 判据（已废弃）] 历史副本 —— 现行判据是 client.js 的 idx.shadowed。 */
const shouldHide = (cands, fences, reverted) =>
  fences.length ? cands.some((q) => fences.some((f) => q >= f)) : cands.some((q) => reverted.has(q))

test('sessionId 归一化：DOM dataset 带 session- 前缀', () => {
  assert.equal(bare('session-0da37218-2672-48b7-adaa-7735af4adee2'), '0da37218-2672-48b7-adaa-7735af4adee2')
  assert.equal(bare('0da37218-2672'), '0da37218-2672')
  assert.equal(bare(null), '')
})

test('回归：__currentSessionId 带前缀会让 API 请求静默失败', () => {
  // 送 "session-<uuid>" 给 /api/message-ops/revert 会落不到会话目录
  assert.notEqual(bare('session-x'), 'session-x')
})

test('lastRevertable 必须挑 surface 上的那条', () => {
  // [现行同源] 对齐 client.js 的 lastRevertable（visible = 模型 surface，仍在用）
  const rows = [
    { seq: 8, visible: true },
    { seq: 54, visible: true },
    { seq: 70, visible: false },   // restore 重放副本：不在模型 surface 上
  ]
  // 无脑取最后一条 → 70 → 服务端报 "start seq 70 not found in surface"（实测���
  assert.equal(rows[rows.length - 1].seq, 70)
  // 正确：取最后一条 visible
  assert.equal(pickLastVisible(rows).seq, 54)
})

test('没有 surface 上的用户消息 → 返回 null，不发请求', () => {
  assert.equal(pickLastVisible([{ seq: 8, visible: false }]), null)
  assert.equal(pickLastVisible([]), null)
})

test('fence 判定：边界及其后都藏', () => {
  // [0.9.4 判据（已废弃）] fences 只存在于历史实现，client.js 已不发 revertFences。
  assert.equal(shouldHide([8], [8], new Set()), true)
  assert.equal(shouldHide([7], [8], new Set()), false)
  assert.equal(shouldHide([70], [70, 8], new Set()), true, '多个 fence 取并集')
  assert.equal(shouldHide([54], [70, 8], new Set()), true)
  assert.equal(shouldHide([7], [70, 8], new Set()), false)
})

test('fence 为空时退回 reverted 集合', () => {
  // [0.9.4 判据（已废弃）] reverted 集合已被 0.9.6 的 shadowed 取代。
  assert.equal(shouldHide([54], [], new Set([54, 63])), true)
  assert.equal(shouldHide([8], [], new Set([54, 63])), false)
})

test('空 fences + 空 reverted → 全部可见', () => {
  // [0.9.4 判据（已废弃）]
  assert.equal(shouldHide([1, 2, 3], [], new Set()), false)
})

// ── 对照：现行实现（0.9.6+）用的是 shadowed，不是上面那些历史副本 ────────────
test('[当前判据对照] client.js 藏行判据 = idx.shadowed，本文件 shouldHide 只是历史样本', () => {
  const src = fs.readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  assert.ok(/shouldHide = idx\.shadowed\.has\(hit\.seq\)/.test(src),
    '消息/工具类判据必须是 idx.shadowed（0.9.6）')
  assert.ok(!/\bfences\b/.test(src.match(/var applySurfaceVisibility = [\s\S]*?\n {6}\};/)?.[0] ?? ''),
    'applySurfaceVisibility 内不得出现 fences（0.9.4 判据已废弃）')
  assert.ok(/r\.seq != null && r\.visible/.test(src),
    'lastRevertable 仍须用 visible 挑「可回滚目标」（与藏行判据是两套语义）')
})
