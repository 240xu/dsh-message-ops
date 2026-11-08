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

test('用户消息动作行同时注入回滚与分叉（回滚在前）', () => {
  const body = block('ensureUserActions')
  const revertAt = body.indexOf('ensureBtn(')
  const forkAt = body.indexOf('ensureForkBtn(')
  assert.notEqual(revertAt, -1, '缺回滚按钮注入')
  assert.notEqual(forkAt, -1, '缺分叉按钮注入')
  assert.ok(revertAt < forkAt, '回滚是破坏性更高的动作，必须排在分叉之前')
})

test('分叉按钮挂进官方动作行（.xzv4MW_actions），不是自造悬浮层', () => {
  const body = block('ensureForkBtn')
  assert.match(body, /xzv4MW_actions/, '必须复用宿主动作行，可见性才跟着宿主 hover 走')
  assert.match(body, /mopsUserFork/, '按钮类名必须可被样式与测试识别')
})

test('分叉图标复用官方 IconBranchOutline16 路径，且显式声明填充', () => {
  const body = block('ensureForkBtn')
  assert.match(body, /M13\.0762 1\.37207/, '图标路径必须取官方 IconBranchOutline16（不自己画）')
  assert.match(body, /fill="currentColor"/, '官方图标是填充几何，必须 currentColor')
  assert.doesNotMatch(body, /stroke="currentColor"/, '填充几何不能同时描边（会变粗）')
  // 我们注入的是**内联 path**（自己画的 button），与宿主 sprite 形态无关；
  // 但识别宿主按钮时必须认 sprite —— 见 fork-dom-behavior.test.js。
})

test('块内按钮统一同步（三个按钮缺一不可）', () => {
  assert.match(src, /var syncBlockButtons = \(?block\)? =>/, '必须存在块级同步函数')
  const body = block('syncBlockButtons')
  // 0.20.0：铅笔以编辑框形式回归，同步范围必须回到三个（回滚/编辑/分叉）。
  // 漏掉任何一个 → 该按钮永远 disabled（0.18.0 的「分叉留在禁用态」同型 bug）。
  for (const cls of ['mopsUserRevert', 'mopsUserEdit', 'mopsUserFork']) {
    assert.match(body, new RegExp(cls), `同步范围缺 ${cls}`)
  }
  const assignBody = src.slice(src.indexOf('var assignSeqs'), src.indexOf('var assignSig'))
  assert.doesNotMatch(assignBody, /syncEnabled\(b, b\.querySelector/, 'assignSeqs 里不能再只同步单个按钮（会把分叉按钮留在禁用态）')
})

test('官方 AI 消息的 branch 按钮被隐藏（按图标路径识别，不靠 aria-label）', () => {
  const scanBody = block('suppressHostBranch')
  assert.match(scanBody, /\[data-turn-tail\] button/, '作用域必须限定在 assistant turn-tail 内')
  assert.match(scanBody, /isHostBranchButton\(btn\)/, '判定必须来自单一纯函数')
  const pure = block('isHostBranchButton')
  assert.match(pure, /HOST_BRANCH_ICON_ID/, '主判据必须是 sprite 的 data-icon id（0.2.2-alpha.2 无 <path>）')
  assert.match(pure, /HOST_BRANCH_D_PREFIX/, '同时保留旧宿主的内联 path 回退')
  assert.doesNotMatch(pure, /aria-label/, 'aria-label 有 8 种语言，不能作为识别依据')
  assert.match(pure, /HOST_BRANCH_CLASS/, '必须排除自己注入的分叉按钮（它复用同一图标）')
})

test('scan 每轮都会重新隐藏官方 branch（视图重建后仍生效）', () => {
  const body = block('scan')
  assert.match(body, /suppressHostBranch\(\)/, 'scan 必须调用抑制函数，否则 openSession 重挂后按钮回来')
})

test('面板不再有编辑入口（编辑走行内铅笔 + 编辑框）', () => {
  assert.doesNotMatch(src, /startEdit\b/, 'startEdit 已删')
  assert.doesNotMatch(src, /panel\.edit/, 'panel.edit 文案已删')
  // 面板仍保留用户消息判定（分叉需要）
  assert.ok(src.includes("pickedIsUser = !!pickedLive && pickedLive.role === 'user'"), '面板必须有用户消息判定')
  // 编辑入口改为行内铅笔（DOM 注入），且它打开的是编辑浮层
  assert.match(src, /mopsUserEdit/, '行内铅笔必须存在（0.20.0）')
  assert.match(src, /EDIT_EVENT/, '铅笔必须派发编辑浮层事件')
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
