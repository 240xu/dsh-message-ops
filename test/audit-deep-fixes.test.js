/**
 * 0.22.0 深挖修复的真执行回归锁。
 *
 * 来源：智能体团队审计（多数成员中途失败，但留下 .audit-tmp/cq.mjs /
 * emoji.mjs 两个真执行脚本与三条半截结论）。Lead 逐条复核后落地：
 *   1. clipQuote 按 code point 切会拆散 grapheme cluster（家庭 emoji 被切碎）
 *   2. listMessages 的 fullText 用 messageText（首段），与 /text 的
 *      messageTextFull 口径分裂，长消息回填丢后半段
 *   3. EditResendOverlay 的 edit.replaceHint 缺隐私告知（编辑框也会 /revert）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { listMessages, messageText, messageTextFull } from '../src/session-file.js'

const src = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

// ── 1 · 0.25.0：clipQuote 已随引用机械删除（真执行锁 → 防复活锁）─────────────
// 0.22.0 这条锁保护「按 grapheme 切、不拆散家庭 emoji」。0.23.0 起 AI 动作槽
// return null，0.25.0 把整条引用链路（clipQuote / graphemes / QUOTE_MAX_CHARS）删除 ——
// 截断现在完全是宿主划词引用的事。真执行没有对象了，改成结构断言防复活。
test('1 · 0.25.0：clipQuote 已删除，不得复活（引用让位宿主 D-4）', () => {
  assert.doesNotMatch(src, /const clipQuote = /, 'clipQuote 必须已删')
  assert.doesNotMatch(src, /const graphemes = raw =>/, 'graphemes 必须已删')
  assert.doesNotMatch(src, /QUOTE_MAX_CHARS/, '引用长度上限常量必须已删')
  assert.doesNotMatch(src, /new Intl\.Segmenter\(/, '引用用分段器必须已删')
})

// ── 2 · fullText 与 /text 同口径（真执行）────────────────────────────────────
test('2 · listMessages 的 fullText 用全段，不是首段', () => {
  const e = {
    seq: 5,
    type: 'user/message',
    surfaceOp: 'append',
    data: { id: 'u1', content: [
      { type: 'text', text: '第一段' },
      { type: 'text', text: '第二段' },
    ] },
  }
  assert.equal(messageText(e), '第一段', 'messageText 确实只取首段')
  assert.equal(messageTextFull(e), '第一段\n\n第二段', 'messageTextFull 取全段')
  const row = listMessages([e]).find(m => m.seq === 5)
  assert.ok(row, 'listMessages 应产出该行')
  assert.equal(row.fullText, '第一段\n\n第二段', 'fullText 必须是全段（0.22.0 修）')
  assert.equal(row.snippet, '第一段', 'snippet 仍是首段摘要（短），不受影响')
})

// ── 3 · 编辑框隐私告知覆盖 ───────────────────────────────────────────────────
test('3 · edit.replaceHint 点破「不是删除 / 原文仍在文件」', () => {
  const zh = src.match(/'edit\.replaceHint':\s*'([^']*)'/)
  const en = src.slice(src.indexOf('const enDict = {')).match(/'edit\.replaceHint':\s*\n?\s*'([^']*)'/)
  assert.ok(zh, '缺中文 edit.replaceHint')
  assert.match(zh[1], /不是删除/, '编辑框也要点破')
  assert.match(zh[1], /会话文件|本地/, '必须说清原文仍在本地文件')
  assert.ok(en, '缺英文 edit.replaceHint')
  assert.match(en[1], /not deletion/, '英文同样点破')
})
