import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client.js'), 'utf8')
const start = src.indexOf('function OpsPanel')
const end = src.indexOf('// --- 头部按钮', start)
const panel = src.slice(start, end)

function has(text) {
  assert.ok(panel.includes(text), `OpsPanel 缺少：${text}`)
}

test('P0 focus：面板有初始焦点、焦点陷阱和背景 inert', () => {
  has("'aria-labelledby': 'mops-panel-title'")
  has("tabIndex: -1, ref: panelRef")
  has('focusablesIn(scope)')
  has("setAttribute('inert', '')")
  has('triggerRef.current')
  has('searchRef.current.focus()')
})

test('P0 listbox：虚拟列表有 roving 活动项和完整键盘导航', () => {
  has("'listbox'")
  has("'aria-activedescendant'")
  has("role: 'option'")
  has("'aria-setsize'")
  has('onKeyDown: handleListKeyDown')
  has("e.key === 'ArrowDown'")
  has("e.key === 'PageDown'")
  has("e.key === 'Home'")
})

test('P0 destructive：回滚和单条删除必须先进入确认态', () => {
  has("panel.revertConfirmBody")
  has("panel.deleteConfirmBody")
  has("onClick: () => setConfirmAction('revert')")
  has("onClick: () => setConfirmAction('delete')")
  has('runAction(confirmAction, true)')
  assert.ok(!panel.includes("onClick: () => runAction('revert')"))
  assert.ok(!panel.includes("onClick: () => runAction('delete')"))
})

test('P0 race：会话切换会使旧消息请求失效', () => {
  has('const requestId = ++loadSeqRef.current')
  has('if (requestId !== loadSeqRef.current) return')
  has('prev.sessionId === requestSid')
  has('loadSeqRef.current += 1')
})

test('P0 states：加载失败和回收站失败有独立错误与重试', () => {
  has("state === 'error'")
  has('loadError')
  has('panel.retry')
  has('trashError')
  has("trashState === 'error'")
})

test('P0 delete：整会话删除是可聚焦 alertdialog，错误在层内显示', () => {
  has("role: 'alertdialog'")
  has("'aria-labelledby': 'mops-delete-title'")
  has('deleteError')
  has('canConfirmDelete')
  has('disabled: !canConfirmDelete')
  has('closeConfirm')
})
