/**
 * 0.23.0 深挖修复的真执行回归锁。
 * 来源：design-demos/audit-data-stupidity.md（S-1/S-2）、audit-ux-copy.md、
 *       audit-quote-redesign.md（引用让位宿主）、audit-ux-ia.md（编辑框告知）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { planRestore } from '../src/ops-core.js'

const src = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const core = readFileSync(new URL('../src/ops-core.js', import.meta.url), 'utf8')

// ── S-1 · restore 重放必须取全段（真执行）────────────────────────────────────
test('S-1：planRestore 对多段消息产出完整全文，不是首段', () => {
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'step/start', data: { turn: 1, step: 1 } },
    {
      seq: 2,
      type: 'user/message',
      surfaceOp: 'append',
      data: {
        id: 'u1',
        source: { kind: 'user' },
        content: [
          { type: 'text', text: 'FIRST PART' },
          { type: 'text', text: 'SECOND PART' },
        ],
      },
    },
    {
      seq: 3,
      type: 'system/message',
      surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 },
      sourceEventSeqs: [2],
      data: { turn: 2, step: 1, message: { role: 'system', content: [{ type: 'text', text: '[marker]' }] } },
    },
  ]
  const plan = planRestore(events, 3)
  const hit = plan.replayable.find(r => r.seq === 2)
  assert.ok(hit, '应重放 seq 2')
  assert.match(hit.text, /FIRST PART/, '首段在')
  assert.match(hit.text, /SECOND PART/, '第二段也必须在（旧实现只取首段 → 永久丢失）')
})

test('S-1：ops-core 不再从 messageText 取重放正文', () => {
  assert.match(core, /messageTextFull/, '必须 import 并改用全段')
  // planRestore 体内不得再用 messageText(e) 作为 text 来源
  const at = core.indexOf('export function planRestore')
  const body = core.slice(at, at + 1800)
  assert.doesNotMatch(body, /const text = messageText\(e\)/, '重放正文不能是首段')
})

// ── S-2 · dock 遮蔽计数兼容 range 两种形状 ──────────────────────────────────
test('S-2：dock 计数读 startSeq/endSeq（服务端真实形状），并兼容 start/end', () => {
  const at = src.indexOf('const seen = new Set()')
  const seg = src.slice(at, at + 900)
  assert.match(seg, /rng\.startSeq/, '必须读 startSeq（服务端 buildDerived 覆盖后的形状）')
  assert.match(seg, /rng\.endSeq/, '必须读 endSeq')
  assert.match(seg, /rng\.start\b/, '兼容旧 {start,end}')
})

// ── 引用让位宿主 ────────────────────────────────────────────────────────────
test('0.23：AI 动作槽不再渲染引用按钮，但仍捕获 inputActions', () => {
  assert.doesNotMatch(src, /return act\(React\.createElement\(IconQuote,/, '引用按钮已删')
  // 0.24.0 P4：捕获改为按会话登记（__inputActionsBySession），不再是裸赋值。
  assert.match(src, /rememberInputActions\(sessionId, inputActions\)/, '捕获仍在（按会话）')
})

// ── 文案：删除/回撤不再自我打脸 ─────────────────────────────────────────────
// 0.24.0：op.delete / op.revertDesc 只被 OpsDialog 的死 radio 使用，
// 已随该函数一起删除。原锁「文案不许说删除」保护的是死代码里的活 bug，
// 现在改成锁「这些 key 不存在」，并保留对**活文案**的同类检查。
test('0.24：op.* 文案已随 OpsDialog 删除', () => {
  for (const k of ['op.delete', 'op.revertDesc', 'op.revert', 'op.deleteDesc', 'op.branch', 'op.branchDesc']) {
    assert.doesNotMatch(src, new RegExp(`'${k.replace(/\./g, '\\.')}':`), `${k} 应随 OpsDialog 删除`)
  }
})

test('0.24：活着的删除/回撤文案仍不许自我打脸', () => {
  // 面板里真正的删除按钮文案
  const del = src.match(/'panel\.delete': '([^']*)'/)
  assert.ok(del, '缺 panel.delete')
  assert.match(del[1], /遮蔽|删除/, 'panel.delete 必须有明确语义')
  // 回撤确认文案不许出现 append-only 这种外行词
  const note = src.match(/'panel\.revertConfirmBody':\s*\n?\s*'([^']*)'/)
  assert.ok(note, '缺 panel.revertConfirmBody')
  assert.doesNotMatch(note[1], /append-only/, '外行看不懂的技术词')
})

// ── 0.23 · i18n 值语义锁（变异测试：改 en 值成反义仍全绿）────────────────────
test('0.23：破坏性动作的 en 文案不得出现 Delete / Cancel 这类反义', () => {
  const enStart = src.indexOf('const enDict = {')
  const enBlock = src.slice(enStart, src.indexOf('\n    }', enStart))
  // 0.24.0：confirm.revert 已随 OpsDialog 删除，换成面板的活 key
  const bad = [
    ["'panel.revert'", /Delete everything|Cancel/i],
    ["'dock.restore'", /^'Delete'/i],
    ["'edit.send'", /^'Cancel'/i],
  ]
  for (const [key, re] of bad) {
    const m = enBlock.match(new RegExp(key + ":\\s*\\n?\\s*'([^']*)'"))
    assert.ok(m, `缺 ${key}`)
    assert.doesNotMatch(m[1], re, `${key} 的英文值不能是反义（变异测试实证盲区）`)
  }
})

test('0.23：__test 不导出已删除的 branch 抑制符号', () => {
  assert.doesNotMatch(src, /isHostBranchButton,/, '__test 导出面已清理')
  assert.doesNotMatch(src, /HOST_BRANCH_ICON_ID,/, '常量导出已删')
})
