/**
 * 0.9.6 回归：重放 assistant 必须带 v4 必填字段 `data.stream`。
 *
 * 事故（专家组定位）：replayEventData 漏写 stream → 宿主投影层
 *   dsh-token-meter/lib/types/usage-projection.js:65 usageOf()
 *     → data.usage === undefined 回落到
 *   dsh-llm/lib/index.js:1412 lastAssistantStreamChunk(stream,'usage')
 *     → `stream.length` on undefined → TypeError
 * 抛出点无 try/catch，两个后果：
 *   - 历史加载失败 → 正文 0 行（dsh-session-query/lib/index.js:482）
 *   - 控制流基线失败 → 全站 `[session-controller] control stream failed`
 *       （dsh-api-session-controller/lib/index.js:1178，一个坏会话打死全站）
 *
 * 格式闸拦不住它：v3→v4 闸对 stream 只有 Array.isArray 守卫，缺失即跳过。
 * 所以必须在这里锁契约。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { replayEventData } from '../src/ops-core.js'

const TS = { turn: 4, step: 2 }
const ASSISTANT_ITEM = { type: 'assistant/message', text: '重放的助手回答' }

test('重放 assistant 必须带 stream，且是数组', () => {
  const data = replayEventData(ASSISTANT_ITEM, TS, 4)
  assert.ok('stream' in data, '缺 data.stream —— 宿主投影会在 stream.length 上抛 TypeError')
  assert.ok(Array.isArray(data.stream), 'stream 必须是 AssistantStreamRecord[]')
})

test('stream 只能是空数组：半填充流会触发宿主 deepStrictEqual 全量校验', () => {
  const data = replayEventData(ASSISTANT_ITEM, TS, 4)
  // 空数组 → expandAssistantStream([])→[] → assertCurrentAssistantStreams 直接 continue
  // 一旦有条目，宿主要求 blocks()/usage/replayState 与 message 全部深等，做不全=新的写坏
  assert.equal(data.stream.length, 0)
})

test('user 重放保持摊平契约，不带 stream（宿主只对 assistant 要求）', () => {
  const data = replayEventData({ type: 'user/message', text: '原文' }, TS, 4)
  assert.equal(data.role, 'user')
  assert.ok(Array.isArray(data.content), 'user 本体摊平在 data 顶层（v4 契约）')
  assert.ok(!('message' in data), 'user 不应包一层 message')
})

test('assistant 本体包一层 message（与 user 的摊平相反）', () => {
  const data = replayEventData(ASSISTANT_ITEM, TS, 4)
  assert.ok(data.message && typeof data.message === 'object')
  assert.equal(data.message.role, 'assistant')
  assert.equal(data.turn, 4)
  assert.equal(data.step, 2)
})

test('缺 turn/step 仍被拒绝（不能写出注定无法加载的事件）', () => {
  assert.throws(() => replayEventData(ASSISTANT_ITEM, null, 4), /turn\/step/)
  assert.throws(() => replayEventData(ASSISTANT_ITEM, { turn: 0, step: 1 }, 4), /turn\/step/)
})

test('回归：index.js 里不能出现 winR 笔误（live restore 会 ReferenceError）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  const winR = (src.match(/\bwinR\b/g) || []).length
  assert.equal(winR, 0, `存在 ${winR} 处 winR —— opsRestore 的 live 分支会抛 ReferenceError`)
})
