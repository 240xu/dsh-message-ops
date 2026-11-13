/**
 * 0.12.0 结构性契约：消息动作收敛到用户消息，AI 消息只剩回撤/引用。
 *
 * 产品决定（用户指令 + opencode 对齐）：
 *  1. 分叉只属于**用户消息**，按钮与回撤按钮**同一动作行**（opencode 把
 *     Revert/Copy/Fork 放在同一行）。
 *  2. 官方 assistant turn-tail 的 branch 按钮要隐藏 —— 官方没有开关，
 *     只能在渲染层按图标路径识别后隐藏。
 *  3. 编辑并重发：0.20.0 起由**行内铅笔 + 独立编辑框**提供（spec §10）；
 *     面板里不再有编辑入口（§10.2 第 3 条）。
 *  4. fork 的边界是 **before** 语义（不含该条用户消息），原文进子会话草稿。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

/** 取出某个函数/箭头函数的源码块（`function NAME` 与 `var NAME = (...)` 两种写法都认）。 */
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
  throw new Error(`function ${name} 块未闭合`)
}

test('fork 边界按轮切（turnStartSeq - 1），无 turn 信息才退回 seq - 1', () => {
  const body = block('forkBoundaryBefore')
  assert.match(body, /turnStartSeq - 1/, '有 turn 信息时必须按轮切 —— 真人输入前一个事件恒是同 turn 的 system/message')
  assert.match(body, /seq - 1/, '保留无 turn 信息时的保守回退')
  assert.match(body, /\? seq - 1 : -1/, '不可分叉要用 -1 哨兵值表达，不能静默返回 0')
})

test('forkFromUserMessage 走官方 fork，并写子会话草稿', () => {
  const body = block('forkFromUserMessage')
  assert.match(body, /pickForkPath\(__sessionsSvc\)/, '必须走官方 sessions.fork（不写磁盘分支）')
  assert.match(body, /forkBoundaryBefore\(seq, turnStartSeq\)/, '边界必须来自单一实现（并带上 turnStartSeq，否则切在 turn 内部）')
  assert.match(body, /writeSessionDraft\(childId, text\)/, '原文必须落进新会话草稿，否则「放回输入框」不成立')
})

test('会话草稿写入点与宿主读取点同键同形', () => {
  // 宿主：const CONVERSATION_STORE_KEY = "dsh.conversation";
  //       localStorage.getItem(`${CONVERSATION_STORE_KEY}.${sessionId}`)
  //       parseStoredDraft 接受 { draft: '<text>' } 的字符串形态
  assert.match(src, /FORK_SESSION_STORAGE_PREFIX = 'dsh\.conversation\.'/, 'localStorage 键前缀必须与宿主一致')
  const body = block('writeSessionDraft')
  // 0.14.0：改成**合并**写入 `{ ...base, draft }`，不再是裸 `{ draft }`。
  // 原因：同一个键里宿主还存 view / viewRequest（会话视图偏好）；回填现在作用在
  // 正在使用的会话上，整体覆盖会静默清掉用户的视图选择。
  // 宿主 parseStoredDraft 只要求 `draft` 字段存在且是字符串 —— 合并形态满足。
  assert.match(body, /draft:\s*String\(text \|\| ''\)/, '必须写入 draft 字符串字段，否则宿主 parseStoredDraft 读不出来')
  assert.match(body, /\.\.\.base/, '必须在旧对象上合并，保住 view 等字段')
})

test('0.23：行内分叉按钮已删，官方 branch 按钮不再被抑制', () => {
  // dsh 官方在 AI 回合尾部已有 sessions.fork（TurnTailNodeView / MessageIconActions）。
  // 0.12 起我们把它藏掉又自己造行内 fork，是重复造轮子，现已纠正。
  assert.doesNotMatch(src, /ensureForkBtn/, '行内 fork 注入已删')
  assert.doesNotMatch(src, /mopsUserFork/, '行内 fork 按钮已删')
  assert.doesNotMatch(src, /suppressHostBranch/, '不再抑制官方按钮')
  assert.doesNotMatch(src, /data-mops-host-branch/, '不再打隐藏标记')
})

test('面板分叉不再使用「含该条」的旧边界（atSeq: picked.seq）', () => {
  assert.doesNotMatch(
    src,
    /fork\(\{ sessionId: target\.sessionId, atSeq: picked\.seq/,
    '面板分叉撞到了旧的「含该条」边界 —— 必须走 forkFromUserMessage',
  )
  assert.match(src, /forkFromUserMessage\(actionSid, picked\.seq/, '面板分叉必须复用同一个 before 语义实现')
})

test('分叉文案说明「原文已回到输入框」而不是复制到该条为止', () => {
  assert.match(src, /'panel\.branchHint': '[^']*放回新会话输入框'/, '中文 hint 必须写清 before 语义')
  assert.match(src, /'slot\.forkHint': '[^']*放回新会话输入框'/, '按钮 tooltip 必须写清 before 语义')
})
