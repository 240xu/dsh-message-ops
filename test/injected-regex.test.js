/**
 * injected() 正则回归（0.9.0 修复）。
 *
 * 实机 bug：client.js 的 `norm()` 是 `replace(/\s+/g,'')` —— 删掉**全部**空白，
 * 而 `injected()` 里的 `current\s+runtime\s+context` 跑在 norm 之后的字符串上，
 * `\s+` 永远匹配不上 → 「Current runtime context…」伪 user 行漏进 DOM 配对，
 * 导致按序配对错位（实测 [8,9,54]，应为 [8,54]）。
 *
 * 修法：injected() 必须对**未去空白的原始 snippet** 判定。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

// 与 client.js:957 保持一致的归一化
const norm = (x) => String(x || '').replace(/\s+/g, '')

/** 修复后的判定：吃 raw（原始 snippet），不依赖 norm */
export function injectedFixed(raw) {
  return /^<system-reminder|current\s+runtime\s+context|^<system-Reminder/i.test(String(raw || ''))
}

/** 修复前的判定（回归对照：对 norm 后的串跑） */
function injectedBuggy(normalised) {
  return /^<system-reminder|current\s+runtime\s+context|^<system-Reminder/i.test(String(normalised || ''))
}

test('injectedFixed：Current runtime context（大小写混合+空格）被识别', () => {
  assert.equal(injectedFixed('Current runtime context. This snapshot supersedes earlier'), true)
  assert.equal(injectedFixed('current runtime context'), true)
  assert.equal(injectedFixed('Current  runtime   context'), true)
})

test('回归证明：对 norm 后的串判定必然失败（这正是原 bug）', () => {
  const raw = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'
  assert.equal(injectedBuggy(norm(raw)), false, 'norm 删掉空白后 \\s+ 永不匹配')
  assert.equal(injectedFixed(raw), true)
})

test('injectedFixed：<system-reminder> 前缀仍被识别', () => {
  assert.equal(injectedFixed('<system-reminder> A skill is a reusable set of instructions.'), true)
  assert.equal(injectedFixed('<system-Reminder> The following workspace instructions'), true)
})

test('injectedFixed：真实用户消息不被误判', () => {
  assert.equal(injectedFixed('继续，你把 mimo 的搞好'), false)
  assert.equal(injectedFixed('基础价格按官方 api 价格来，缓存命中价格加上。'), false)
  assert.equal(injectedFixed(''), false)
  assert.equal(injectedFixed(null), false)
})

test('fetchRows 行构造：保留 raw 供 injected 判定', () => {
  // 模拟 client.js:969 的 map：既要 norm 后的 sn（配对用），也要 raw（判定用）
  const msgs = [
    { seq: 8, role: 'user', snippet: '分配几个子代理把模型广场的模型价格' },
    { seq: 9, role: 'user', snippet: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' },
    { seq: 10, role: 'user', snippet: '<system-reminder> A skill is a reusable set of task-specific instructions.' },
    { seq: 54, role: 'user', snippet: '基础价格按官方api价格来，缓存命中价格加上。' },
  ]
  const rows = msgs.map((m) => ({ seq: m.seq, sn: norm(m.snippet), raw: String(m.snippet ?? '') }))
    .filter((r) => r.sn && !injectedFixed(r.raw))
  assert.deepEqual(rows.map((r) => r.seq), [8, 54], '伪 user 行必须被滤掉')
})
