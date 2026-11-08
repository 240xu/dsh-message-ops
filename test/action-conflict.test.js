/**
 * 动作入口回归锁 —— 0.19.0 收敛，0.20.0 反转（编辑入口以**编辑框**形式回归）。
 *
 * 历史：
 *   0.19.0 审计发现 profile 已装 message-edit 插件，于是删掉了本插件自己的
 *          panel.edit / 行内铅笔 / 老 setDraft 路径（spec §9）。
 *   0.20.0 用户新指令：铅笔要回来，但**必须是独立编辑框 + 点「发送并回撤」才写**
 *          （spec §10，覆盖 §9 的删铅笔决定）。
 *
 * 因此本文件的锁从「本插件不再有编辑入口」翻转为：
 *   - 面板仍然**没有** panel.edit（§10.2：面板不恢复编辑）
 *   - 行内铅笔回归，但语义是打开编辑浮层，不是回填 composer
 *   - 老 `setDraft(pickedMsg.fullText)` 路径仍然不许回来（回填统一走 refillComposer）
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
    if (src[i] === '{') {
      depth++
      started = true
    } else if (src[i] === '}') {
      depth--
      if (started && depth === 0) return src.slice(at, i + 1)
    }
  }
  throw new Error(`块未闭合：${name}`)
}

// ── 0.20.0 · 编辑入口以「独立编辑框」形式回归（spec §10 覆盖 §9）────────────
test('0.20：行内铅笔回归 —— ensureEditBtn / runUserEdit 存在，且走编辑浮层', () => {
  for (const name of ['ensureEditBtn', 'runUserEdit']) {
    assert.ok(new RegExp('(function|var|const)\\s+' + name + '\\b').test(src), `缺 ${name}（0.20.0 已恢复铅笔入口）`)
  }
  assert.match(block('runUserEdit'), /EDIT_EVENT/, '铅笔必须派发 EDIT_EVENT 打开编辑浮层')
  assert.ok(/function EditResendOverlay/.test(src) || /const EditResendOverlay = \(/.test(src), '必须有独立的 EditResendOverlay 组件')
})

test('0.20：铅笔不等于「回填 composer」——runUserEdit 不许调 refillComposer', () => {
  // 0.18.0 那版铅笔只是 refillComposer 的别名（被判为与回滚重复而删除）。
  // 0.20.0 的契约是「打开编辑框，点发送那一刻才回撤」，所以绝不能退化成回填。
  assert.doesNotMatch(block('runUserEdit'), /refillComposer\(/, '铅笔退化成回填输入框 = 0.18 的旧 bug')
})

test('0.20：面板仍然没有 panel.edit（spec §10.2 只恢复行内铅笔）', () => {
  assert.doesNotMatch(src, /'panel\.edit'/, '面板编辑入口仍然删除（§10.2 第 3 条）')
  assert.doesNotMatch(src, /'panel\.editHint'/, 'panel.editHint 也已删')
})

test('0.20：用户消息动作行 = 回撤 → 编辑 → 分叉 三个按钮', () => {
  const fn = block('ensureUserActions')
  const revertAt = fn.indexOf('ensureBtn(')
  const editAt = fn.indexOf('ensureEditBtn(')
  const forkAt = fn.indexOf('ensureForkBtn(')
  assert.ok(revertAt >= 0, '缺回撤')
  assert.ok(editAt >= 0, '缺铅笔编辑')
  assert.ok(forkAt >= 0, '缺分叉')
  assert.ok(revertAt < editAt && editAt < forkAt, '顺序必须是 回撤 → 编辑 → 分叉')
})

test('老 setDraft 回填路径仍然不许回来（回填统一由 refillComposer 承担）', () => {
  assert.doesNotMatch(src, /__inputActions\.setDraft\(pickedMsg\.fullText\)/, '老路径已删，别在 0.20 复活')
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
