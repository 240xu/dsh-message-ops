/**
 * 0.14.0 回归锁：用户实机报的三个 bug。
 *
 * 用户原话：「我回撤的是新消息，这下面也没有任何 AI 消息，为什么我恢复它会
 * 给我什么回滚后的节点呢？……而且为什么我回撤的消息没有重新填入到消息框呢？」
 *
 * 三个独立缺陷：
 *   A. 回填写进编辑器又被 openSession 重建冲掉 → 原文没进输入框
 *   B. dock 用 marker **自己**的 seq/文案当「将恢复到这条」→ 用户看到的是回滚通知本身
 *   C. marker 可被当成回滚目标 → 产生「遮蔽另一条 marker」的自噬空记录
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { planRevertFromEvents, isMarkerEvent } from '../src/ops-core.js'

const client = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const server = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
const flat = s => s.replace(/\s+/g, ' ')

function block(src, name) {
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

// ── A · 回填必须落盘到宿主草稿键 ─────────────────────────────────────────────
test('A：refillComposer 必须写宿主草稿存储键，不能只依赖 persistDraft', () => {
  const fn = block(client, 'refillComposer')
  assert.match(fn, /writeSessionDraft\(/, '必须直接写 dsh.conversation.<sid>（openSession 之后读到的权威值）')
  assert.match(fn, /return persisted \|\| editorSet/, '必须诚实返回成败，不能恒 true')
})

test('A：回填后仍要尽力更新活着的编辑器（视图不重建的路径）', () => {
  const fn = block(client, 'refillComposer')
  assert.match(fn, /__inputActions\.setDraft\(/, '活编辑器也要设，否则 dock 内联恢复看不到')
})

// ── B · dock 文案必须描述「被遮蔽的那段」，不是 marker 自己 ──────────────────
test('B：dock 行预览不许直接用 marker 自己的 snippet（那是通知文案）', () => {
  const at = client.indexOf('const dockRows = []')
  assert.ok(at > 0, '找不到 dockRows 构造')
  const tail = client.slice(at, at + 2000)
  assert.doesNotMatch(tail, /snippet: mk\.snippet\b/, 'mk.snippet 是 marker 自己的 notice 文本，不能当预览')
  assert.match(tail, /mk\.range/, '必须用 marker 的 replace 区间描述「遮蔽了哪段」')
})

test('B：compact 投影必须带 marker 与 range（否则客户端不可能区分）', () => {
  const at = server.indexOf('const visibleMessages = compact')
  assert.ok(at > 0)
  const proj = server.slice(at, at + 1600)
  assert.match(proj, /marker: m\.marker === true/, 'compact 必须带 marker 标志')
  assert.match(proj, /range: m\.range \?\? null/, 'compact 必须带 replace 区间')
})

// ── C · marker 不能被当成回滚目标 ────────────────────────────────────────────
test('C：服务端拒绝把 marker 当回滚目标（防止自噬空 replace）', () => {
  const events = [
    { seq: 5, type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }, surfaceOp: 'append' },
    { seq: 6, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'yo' }] } }, surfaceOp: 'append' },
    {
      seq: 7,
      type: 'system/message',
      data: { turn: 2, step: 1, message: { role: 'system', content: [{ type: 'text', text: '[消息回滚] …' }] } },
      surfaceOp: { op: 'replace', startSeq: 5, endSeq: 5 },
      sourceEventSeqs: [5],
    },
  ]
  assert.equal(isMarkerEvent(events[2]), true, 'seq 7 是 marker')
  assert.equal(isMarkerEvent(events[0]), false, '用户消息不是 marker')
  assert.throws(
    () => planRevertFromEvents(events, 7),
    /marker/i,
    '把 marker 当回滚目标必须 409，否则会遮蔽 marker 自己产生空记录',
  )
})

test('C：dock 过滤掉「遮蔽目标是另一条 marker」的自噬记录', () => {
  const at = client.indexOf('function activeMarkers')
  assert.ok(at > 0, '找不到 activeMarkers')
  const fn = block(client, 'activeMarkers')
  assert.match(fn, /target\.marker === true/, '必须识别「遮蔽目标本身是 marker」并排除')
})

test('C：自噬 marker 的判据是「区间退化为单点且目标也是 marker」', () => {
  const fn = block(client, 'activeMarkers')
  assert.match(fn, /rng\.startSeq !== rng\.endSeq\) return true/, '先放行正常区间')
  assert.match(fn, /m\.range/, '必须依赖 marker 的 range')
})

// ── D · 草稿写入必须合并，不能清掉宿主的 view 偏好 ────────────────────────────
test('D：writeSessionDraft 必须合并已有 JSON（保住 view/viewRequest）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  const fn = block(src, 'writeSessionDraft')
  assert.match(fn, /\.\.\.base/, '必须展开旧对象再覆盖 draft')
  assert.match(fn, /localStorage\.getItem\(key\)/, '必须先读旧值')
  assert.doesNotMatch(
    fn,
    /localStorage\.setItem\([^)]*JSON\.stringify\(\{\s*draft:/,
    '不许整体覆盖成 {draft} —— 会丢 view 偏好',
  )
})

// ── E · dock 生命周期字段必须投影到 compact ───────────────────────────────────
test('E：compact 必须投影 restoreComplete / committed，否则 dock 无法过滤已恢复 marker', () => {
  const at = server.indexOf('const visibleMessages = compact')
  const proj = server.slice(at, at + 2000)
  assert.match(proj, /restoreComplete: m\.restoreComplete === true/, 'dock 判据依赖它')
  assert.match(proj, /committed: m\.committed === true/, 'dock 判据依赖它')
})

test('E：activeMarkers 的两个判据与投影字段同名', () => {
  const fn = block(client, 'activeMarkers')
  assert.match(fn, /m\.restoreComplete !== true/, 'dock 判据')
  assert.match(fn, /m\.committed !== true/, 'dock 判据')
})
