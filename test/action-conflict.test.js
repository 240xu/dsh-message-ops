/**
 * 0.19.0 回归锁：动作入口收敛。
 *
 * 审计发现 profile 已装并加载 @linxin666/dsh-client-ui-message-edit@0.4.14
 * （turnTail 槽，提供真正的「编辑并重发」：fork 到 seq-1 + prompt）。
 * 本插件在 0.12/0.17/0.18 造的 panel.edit / 行内铅笔 / 老 setDraft 全是
 * 与之重复的劣质轮子，已全部删除。见 spec §9。
 *
 * 保留的锁：C2（防 409 护栏两条回滚路径共用）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

function block(name) {
  let at = src.indexOf('function ' + name)
  if (at === -1) at = src.indexOf('var ' + name + ' =')
  if (at === -1) at = src.indexOf('const ' + name + ' =')
  assert.notEqual(at, -1, `找不到 ${name}`)
  let depth = 0
  let started = false
  for (let i = at; i < src.length; i++) {
    if (src[i] === '{') { depth++; started = true }
    else if (src[i] === '}') {
      depth--
      if (started && depth === 0) return src.slice(at, i + 1)
    }
  }
  throw new Error(`块未闭合：${name}`)
}

// ── 0.19.0 · 本插件不再提供任何「编辑」入口 ─────────────────────────────────
test('0.19：本插件不再有 startEdit / ensureEditBtn / runUserEdit', () => {
  for (const name of ['startEdit', 'ensureEditBtn', 'runUserEdit']) {
    assert.ok(!new RegExp('(function|var|const)\\s+' + name + '\\b').test(src), `残留 ${name}`)
  }
})

test('0.19：不再有 panel.edit / slot.edit 文案（编辑交给已装插件）', () => {
  assert.doesNotMatch(src, /'panel\.edit'/, 'panel.edit 系列已删')
  assert.doesNotMatch(src, /'slot\.edit'/, 'slot.edit 系列已删')
})

test('0.19：用户消息动作行只剩 回撤 + 分叉 两个按钮', () => {
  const fn = block('ensureUserActions')
  assert.match(fn, /ensureBtn\(/, '保留回撤')
  assert.match(fn, /ensureForkBtn\(/, '保留分叉')
  assert.doesNotMatch(fn, /ensureEditBtn/, '不再有铅笔编辑按钮')
})

test('0.19：老 setDraft 回填路径已删（回填统一由 refillComposer 承担）', () => {
  assert.doesNotMatch(src, /__inputActions\.setDraft\(pickedMsg\.fullText\)/, '老路径已删')
})

// ── C2 · 防 409 护栏必须两条回滚路径共用 ──────────────────────────────────────
test('C2：markRowsShadowedFrom 是共享函数（不是某条路径私有）', () => {
  assert.match(src, /var markRowsShadowedFrom = /, '护栏必须是具名共享函数')
  const fn = block('markRowsShadowedFrom')
  assert.match(fn, /shadowed = true/, '必须把 >= 边界的行标成已遮蔽')
  assert.match(fn, /cache\.at = 0/, '必须让缓存失效以触发重算')
})

test('C2：两条回滚路径都调用同一护栏', () => {
  const btn = block('runUserRevert')
  const undo = block('runUndo')
  assert.match(btn, /markRowsShadowedFrom\(/, '按钮路径必须调用护栏（原先漏了 → 重复点击 409）')
  assert.match(undo, /markRowsShadowedFrom\(/, '/undo 路径必须调用同一个护栏')
})

test('C2：护栏必须在 refill 之前调用（否则回填后又立刻重算会闪）', () => {
  const btn = block('runUserRevert')
  const guardAt = btn.indexOf('markRowsShadowedFrom(')
  const refillAt = btn.indexOf('refillComposer(')
  assert.ok(guardAt >= 0 && refillAt > guardAt, '先标遮蔽，再回填')
})

// ── 0.19.0 · AI 消息动作区只留引用（时钟回撤已删）────────────────────────────
test('0.19：AI 动作槽不再渲染时钟/回撤按钮', () => {
  assert.doesNotMatch(src, /IconClock/, 'IconClock 已删')
  assert.doesNotMatch(src, /,\s*'revert',\s*runRevert\b/, 'revert 动作不再出现在 AI 槽')
  assert.doesNotMatch(src, /const runRevert = \(/, 'runRevert 已删')
})

test('0.19：AI 动作槽只渲染一个引用按钮', () => {
  assert.match(src, /return act\(React\.createElement\(IconQuote,/, '只 return 一个 act(引用)')
})
