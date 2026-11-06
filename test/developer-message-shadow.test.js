/**
 * 0.15.0 回归锁：回滚后「工具清单变更」那行必须一起消失。
 *
 * 用户原话：「我说的撤回，只是不显示我重新发起的请求，就像干净请求」——
 * 他要的是**界面上看起来像干净请求**。而工具增删提示回滚后仍然显示。
 *
 * 根因链（全部在宿主实际下发的代码里取证）：
 *   1. `developerMessageDefinition.match` 只看 `event.type === 'developer/message'`，
 *      **没有** `isAppendSurfaceEvent` 这道闸（user/message 有）。
 *   2. `isVisibleChatNode` 对含 tool-addition/tool-removal 的 context 节点
 *      **强制可见**。
 *   → surface replace 遮蔽了事件（模型上下文干净），但 UI 照样渲染。
 *
 * 插件侧唯一的抓手是渲染层遮蔽同步（按 data-chat-node-key 查表藏行），
 * 前提是这些事件先进入我们的消息列表并带上 id。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { listMessages, computeShadowed } from '../src/session-file.js'

const fileSrc = readFileSync(new URL('../src/session-file.js', import.meta.url), 'utf8')
const serverSrc = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')

test('listMessages 必须收录 developer/message（否则遮蔽状态传不到客户端）', () => {
  assert.match(fileSrc, /e\.type === 'developer\/message'/, 'listMessages 的类型白名单必须含 developer/message')
})

test('tool-addition / tool-removal 必须产出可读文本（否则 snippet 为空会被丢弃）', () => {
  const src = fileSrc
  assert.match(src, /c\.type === 'tool-addition'/, '必须把 tool-addition 渲染成 +name')
  assert.match(src, /c\.type === 'tool-removal'/, '必须把 tool-removal 渲染成 -name')
})

test('真执行：developer/message 进列表、带 id、遮蔽状态正确', () => {
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'step/start', data: { turn: 1, step: 1 } },
    { seq: 2, type: 'user/message', data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }, surfaceOp: 'append' },
    {
      seq: 3,
      type: 'developer/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'dev-1',
          role: 'developer',
          source: { kind: 'tool-registry' },
          content: [{ type: 'tool-addition', toolName: 'sidebar_open' }],
        },
      },
      surfaceOp: 'append',
    },
    // 回滚到 seq 2（含）→ 遮蔽 2..3
    {
      seq: 4,
      type: 'system/message',
      data: { turn: 2, step: 1, message: { role: 'system', content: [{ type: 'text', text: '[消息回滚]' }] } },
      surfaceOp: { op: 'replace', startSeq: 2, endSeq: 3 },
      sourceEventSeqs: [2, 3],
    },
  ]
  const rows = listMessages(events)
  const dev = rows.find((r) => r.seq === 3)
  assert.ok(dev, 'developer/message 必须出现在 listMessages 里')
  assert.equal(dev.id, 'dev-1', '必须带 message.id —— 客户端拼 node-key 反查 seq 的唯一锚点')
  assert.equal(dev.role, 'developer', 'role 必须是 developer，不能退化成 system')
  assert.match(dev.snippet, /sidebar_open/, 'snippet 必须可读（否则空串会被索引丢弃）')

  const shadowed = computeShadowed(events)
  assert.equal(shadowed.has(3), true, '落在 replace 区间内的 developer/message 必须被遮蔽')
})

test('compact 投影必须带 id，否则 node-key 反查断链', () => {
  const at = serverSrc.indexOf('const visibleMessages = compact')
  assert.ok(at > 0)
  const proj = serverSrc.slice(at, at + 2400)
  assert.match(proj, /id: m\.id \?\? null/, 'compact 必须投影 id')
})

test('seqOfNodeKey 必须认 developer-message 这种 kind', () => {
  const clientSrc = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  const at = clientSrc.indexOf('var seqOfNodeKey =')
  assert.ok(at > 0, '找不到 seqOfNodeKey')
  const seg = clientSrc.slice(at, at + 900)
  assert.match(seg, /developer-message/, '必须支持 developer-message 的 key 反查')
})

test('node-key 格式：<kindLen>:<kind><id>（17:developer-message<uuid>）', () => {
  const kind = 'developer-message'
  const id = '2a306c76-632d-4d13-b154-97337914c4b1'
  const key = `${kind.length}:${kind}${id}`
  assert.equal(key, '17:developer-message2a306c76-632d-4d13-b154-97337914c4b1')
  // 与 client.js 的 parseNodeKey 同构
  const m = /^(\d+):/.exec(key)
  const digits = m[1].length
  const kindLen = Number(m[1])
  assert.equal(key.slice(digits + 1, digits + 1 + kindLen), kind)
  assert.equal(key.slice(digits + 1 + kindLen), id)
})
