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

// ── 1 · clipQuote 真执行：抽出函数体跑 grapheme 边界用例 ──────────────────────
function loadClipQuote() {
  const at = src.indexOf('const clipQuote = ')
  assert.ok(at > 0, '找不到 clipQuote')
  // 连同前置的 graphemes / quoteSegmenter 一起抽
  const start = src.indexOf('let quoteSegmenter = null', Math.max(0, at - 800))
  let depth = 0
  let started = false
  let end = at
  for (let i = at; i < src.length; i++) {
    if (src[i] === '{') { depth++; started = true }
    else if (src[i] === '}') { depth--; if (started && depth === 0) { end = i + 1; break } }
  }
  const body = src.slice(start >= 0 && start < at ? start : at, end)
  return new Function('QUOTE_MAX_CHARS', body.replace('const clipQuote = ', 'return ') + '\nreturn clipQuote')(600)
}

test('1 · clipQuote 不拆散 grapheme cluster（真执行）', () => {
  const clip = loadClipQuote()
  const family = '👨‍👩‍👧‍👦' // 7 code points, 1 grapheme
  const out = clip('a'.repeat(599) + family)
  assert.ok(out.includes(family), '家庭 emoji 必须完整保留，不能被切成 👨‍…')
  assert.ok(!/👨‍…$/.test(out), '不许留下悬空 ZWJ')
  assert.ok(out.endsWith(family) || out.endsWith('…'), '尾部要么完整 grapheme 要么省略号')
})

test('1 · clipQuote 超长纯文本仍按上限截断（真执行）', () => {
  const clip = loadClipQuote()
  assert.equal(clip('a'.repeat(600)).length, 600, '恰好 600 不加省略号')
  const long = clip('a'.repeat(700))
  assert.ok(long.length <= 601, '超长必须截断')
  assert.ok(long.endsWith('…'), '截断要带省略号')
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
