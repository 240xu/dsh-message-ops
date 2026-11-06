/**
 * 0.17.0 回归锁：动作入口的「同语义多实现」冲突。
 *
 * 用户原话：「那个编辑并重发是你的吗？你看看有多少是功能冲突的」
 *
 * 三个已确认并修复的冲突：
 *   C1 · 回填（把原文放回 composer）有两条实现，可靠性不同
 *   R2 · 「编辑并重发」文案暗示修改原消息，实际是新增一条
 *   C2 · 回滚成功后的防 409 护栏只有 /undo 有，按钮路径漏了
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

// ── C1 · 回填必须只有一条实现路径 ─────────────────────────────────────────────
test('C1：startEdit 与 refillComposer 用同一条落盘路径（writeSessionDraft）', () => {
  const edit = block('startEdit')
  const refill = block('refillComposer')
  assert.match(edit, /writeSessionDraft\(/, 'startEdit 必须直接写宿主草稿键')
  assert.match(refill, /writeSessionDraft\(/, 'refillComposer 必须同源')
  assert.doesNotMatch(edit, /persistDraft\(\)/, 'startEdit 不该再依赖 persistDraft（视图未挂载时空转）')
})

test('C1：startEdit 不再因编辑器未挂载而直接失败', () => {
  const edit = block('startEdit')
  // 旧实现在 !__inputActions 时就 setError 返回；新实现只把它当"尽力而为"
  assert.doesNotMatch(
    edit,
    /if \(!__inputActions \|\| typeof __inputActions\.setDraft !== 'function'\) \{\s*setError/,
    '编辑器未挂载不等于回填失败 —— 落盘成功了就该成功',
  )
})

// ── R2 · 文案不得暗示「修改原消息」────────────────────────────────────────────
test('R2：编辑入口文案必须是「复制」语义，不能暗示修改原消息', () => {
  const zh = src.match(/'panel\.edit': '([^']*)'/)
  assert.ok(zh, '缺 panel.edit 中文文案')
  assert.doesNotMatch(zh[1], /编辑|修改/, '行为是复制，不该叫"编辑"')
  assert.match(zh[1], /复制|拷贝/, '应明确是复制到输入框')

  const hint = src.match(/'panel\.editHint': '([^']*)'/)
  assert.ok(hint, '缺 panel.editHint')
  assert.match(hint[1], /不会修改原消息|新增一条/, '提示必须说明发出后是新增，不修改原消息')
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
