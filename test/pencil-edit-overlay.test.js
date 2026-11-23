/**
 * 0.20.0 · 铅笔编辑框（用户消息动作行 → 独立编辑框 → 发送并回撤）
 *
 * 来源：docs/superpowers/specs/2026-11-06-message-actions-ux-design.md §10
 * （覆盖 §9 的「删铅笔」。用户新指令：铅笔点开必须是**编辑框**，不是回填输入框。）
 *
 * 本文件锁**契约**，不锁排版：
 *   - 结构锁用 `_source.js` 的 `flat` / `blockAt`（格式无关，prettier 重排不会崩）；
 *   - 能在 `__test` 面上拿到的，做**真执行**（照抄 fork-dom-behavior.test.js 的手法）；
 *     拿不到则跳过真执行，但第 4 节的结构锁仍然生效。
 *
 * 契约（与实现方 conflict-audit 对齐，2026-11-07）：
 *   按钮   ensureEditBtn / .mopsUserEdit / slot.edit / slot.editHint / 官方 edit-outline 几何
 *   顺序   ensureUserActions: ensureBtn → ensureEditBtn → ensureForkBtn
 *   组件   EditResendOverlay，OVERLAY_SLOT，id `message-ops-edit-resend`，order 102
 *   事件   EDIT_EVENT = 'dsh-message-ops:edit'，
 *          detail = { sessionId(裸), rawSessionId(带 session-), seq }
 *   全文   GET /api/message-ops/text?sessionId=&seq= ，只用 data.text（不许 snippet 顶替）
 *   发送   先 POST /revert → 成功才 writeSessionDraft → setDraft/persistDraft →
 *          emitChanged → openSessionById → trySubmitEdited；失败则留在编辑框
 *   取消   零 fetch、零写盘、零 openSession
 *   样式   .mopsEr* 前缀 / 全 var(--dsw-alias-*) / 圆角 var(--dsw-radius-*) / 无裸 hex
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { flat, blockAt } from './_source.js'

const src = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const f = flat(src)

/** 定位一个具名函数/箭头函数块；名字三种写法都认。 */
function fn(names) {
  const list = Array.isArray(names) ? names : [names]
  for (const name of list) {
    for (const needle of [`function ${name}`, `var ${name} =`, `const ${name} =`]) {
      const at = src.indexOf(needle)
      if (at === -1) continue
      const block = blockAt(src, needle)
      if (block) return block
    }
  }
  return null
}

function mustFn(names, label) {
  const block = fn(names)
  assert.ok(block, `找不到 ${label || [].concat(names).join(' / ')}`)
  return flat(block)
}

/** 从某段代码里按「块」找内层函数（用于取 catch / cancel 分支）。 */
function blockAfter(text, needle) {
  const at = text.indexOf(needle)
  if (at === -1) return null
  return blockAt(text, needle)
}

/**
 * 定位「发送并回撤」的**实现体**。
 *
 * 实现方可能把编排内联在 EditResendOverlay 里，也可能抽成独立的
 * `sendEditAndRevert(...)`（更利于真执行测试）。两种都接受：
 * 先按候选名找独立函数，再退回组件内的 send/submit 回调。
 */
function sendLogic() {
  for (const needle of ['function sendEditAndRevert', 'var sendEditAndRevert =', 'const sendEditAndRevert =']) {
    const b = blockAfter(src, needle)
    if (b && b.includes('/api/message-ops/revert')) return b
  }
  const overlay = fn(['EditResendOverlay'])
  if (overlay) {
    for (const needle of ['const send', 'const submit', 'sendAndRevert', 'const sendAndRevert']) {
      const b = blockAfter(overlay, needle)
      if (b) return b
    }
    // 兜底：整段组件里含 revert 的那块（组件只有一个发送动作）
    if (overlay.includes('/api/message-ops/revert')) return overlay
  }
  return null
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 · 铅笔按钮：存在 / 图标是铅笔 / 与回撤同一动作行
// ═══════════════════════════════════════════════════════════════════════════
test('1.1 ensureEditBtn 存在，注入 .mopsUserEdit，并挂进官方动作行（.xzv4MW_actions）', () => {
  const body = mustFn('ensureEditBtn')
  assert.match(body, /mopsUserEdit/, '按钮类名必须是 .mopsUserEdit（样式与测试都靠它识别）')
  // 0.26.0：宿主 hash 抽成 HOST_CLS 单点常量。断言改为「消费常量」而非字面量
  // （否则抽常量后本行仍绿 —— 常量定义行还在文件里，锁强度会退化成「定义存在」）。
  assert.match(body, /HOST_CLS\.actions|ensureActionsHost\(/, '必须复用宿主官方动作行（经 HOST_CLS 单点），可见性才能跟随 hover 显隐')
  assert.match(body, /slot\.edit/, 'title / aria-label 用 slot.edit')
})

test('1.2 铅笔图标是官方 edit-outline 几何，不是复制/时钟/分叉', () => {
  const body = mustFn('ensureEditBtn')
  assert.match(body, /M11\.9 1\.4/, '图标必须是官方 edit-outline 的 path 前缀（铅笔）')
  assert.doesNotMatch(body, /M13\.0762 1\.37207/, '不能复用分叉图标（BranchIcon 几何）')
  assert.doesNotMatch(body, /IconCopyOutlineRegular/, '不能是复制图标')
  assert.doesNotMatch(body, /M2\.5 8a5\.5 5\.5 0 1 0 1\.6-3\.9/, '不能是时钟/回撤图标')
})

test('0.23 动作行顺序：回撤 → 编辑（分叉让位官方）', () => {
  const body = mustFn('ensureUserActions')
  const revertAt = body.indexOf('ensureBtn(')
  const editAt = body.indexOf('ensureEditBtn(')
  assert.notEqual(revertAt, -1, '缺回撤按钮')
  assert.notEqual(editAt, -1, '缺铅笔编辑按钮')
  assert.equal(body.indexOf('ensureForkBtn('), -1, '行内分叉已删（让位官方）')
  assert.ok(revertAt < editAt, '回撤必须在编辑之前（破坏性从左到右递减）')
})

test('0.23 块级同步覆盖两个按钮；syncEnabled 对铅笔用 slot.editHint', () => {
  const sync = mustFn('syncBlockButtons')
  assert.match(sync, /mopsUserRevert/, '同步范围缺 mopsUserRevert')
  assert.match(sync, /mopsUserEdit/, '同步范围缺 mopsUserEdit（否则编辑按钮永远禁用）')
  assert.doesNotMatch(sync, /mopsUserFork/, '行内分叉已删，不再参与同步')

  const enabled = mustFn('syncEnabled')
  assert.match(enabled, /mopsUserEdit/, 'syncEnabled 必须能区分铅笔按钮')
  assert.match(enabled, /slot\.editHint/, '铅笔的 hint 是 slot.editHint（不能都写 revert）')
})

test('1.5 点击铅笔走 runUserEdit，而不是直接把原文回填进 composer', () => {
  const body = mustFn('ensureEditBtn')
  assert.match(body, /runUserEdit\(/, '点击必须进编辑链路')
  const runner = mustFn('runUserEdit')
  assert.match(runner, /EDIT_EVENT/, '应通过 EDIT_EVENT 让编辑框打开（组件与按钮解耦）')
  assert.doesNotMatch(runner, /refillComposer\(/, '铅笔不得退化成「回填输入框」（那是 0.18 的旧行为）')
})

// ═══════════════════════════════════════════════════════════════════════════
// 2 · 编辑框是独立组件（不是写草稿键的伪编辑）
// ═══════════════════════════════════════════════════════════════════════════
test('2.1 EditResendOverlay 是独立组件，且不复用 refillComposer', () => {
  const body = mustFn(['EditResendOverlay'], 'EditResendOverlay 组件')
  assert.match(body, /textarea/i, '编辑框必须有可多行编辑的 textarea')
  assert.doesNotMatch(body, /refillComposer\(/, '编辑框不是回填：不许调 refillComposer')
})

test('2.2 编辑框注册在 shell.overlay，id / order 固定', () => {
  assert.match(f, /EDIT_ID = 'message-ops-edit-resend'/, '缺编辑框的槽注册 id 常量')
  assert.match(f, /EDIT_EVENT = 'dsh-message-ops:edit'/, '缺编辑框的事件名常量')

  const apply = mustFn('apply')
  assert.match(apply, /OVERLAY_SLOT/, '编辑框必须挂 shell.overlay')
  assert.match(apply, /EDIT_ID/, 'overlay 注册必须用 EDIT_ID')
  assert.match(apply, /order: 102/, 'order 必须是 102（与面板 101 错开）')
  assert.match(apply, /EditResendOverlay/, 'overlay 注册的组件必须是 EditResendOverlay')
})

test('2.3 铅笔派发的事件 detail 三个字段齐全（裸 sid / 原始 sid / seq）', () => {
  const runner = mustFn('runUserEdit')
  for (const field of ['sessionId', 'rawSessionId', 'seq']) {
    assert.match(runner, new RegExp(field), `EDIT_EVENT detail 缺 ${field}`)
  }
  // detail.sessionId 必须是**裸 uuid**（HTTP 用），因此派发点要经过 bareSessionId 归一；
  // rawSessionId 保留宿主原始写法（openSession / 草稿键用）。
  assert.match(runner, /bareSessionId\(/, 'detail.sessionId 必须归一成裸 uuid（API 只要裸 uuid）')
  assert.match(runner, /rawSessionId:\s*sid/, 'rawSessionId 必须保留宿主原始 id')
})

test('2.3b sendEditAndRevert 自己兜底补 session- 前缀（rawSessionId 缺省时）', () => {
  const send = mustFn('sendEditAndRevert')
  assert.match(
    send,
    /'session-'\s*\+\s*sessionId|`session-\$\{sessionId\}`|"session-"\s*\+\s*sessionId/,
    '缺前缀时必须自行补 session-（openSession 只认带前缀）',
  )
})

// ═══════════════════════════════════════════════════════════════════════════
// 3 · 「取消」零副作用
// ═══════════════════════════════════════════════════════════════════════════
test('3.1 取消分支只有本地状态重置：无 fetch / 无写盘 / 无 openSession', () => {
  const overlay = mustFn(['EditResendOverlay'])
  const cancel =
    blockAfter(overlay, 'const cancel') || blockAfter(overlay, 'cancel = useCallback') || blockAfter(overlay, 'function cancel')
  assert.ok(cancel, '找不到取消回调（契约名 cancel）')
  const c = flat(cancel)
  // 0.26.0：状态重置抽成 resetState（cancel 只调它 + in-flight 护栏）。
  // 判据必须跟着走：既认「cancel 直接重置」也认「cancel 委托 resetState」。
  const reset = blockAfter(overlay, 'const resetState =') || ''
  const stateCode = c + '\n' + flat(reset)
  assert.match(c, /resetState\(\)/, 'cancel 必须委托唯一的 resetState（避免两处状态重置漂移）')
  assert.doesNotMatch(stateCode, /fetch\(/, '取消不得发任何请求')
  assert.doesNotMatch(stateCode, /writeSessionDraft\(/, '取消不得写草稿键（零副作用）')
  assert.doesNotMatch(stateCode, /localStorage/, '取消不得碰 localStorage')
  assert.doesNotMatch(stateCode, /openSessionById\(|openSession\(/, '取消不得重建会话视图')
  assert.doesNotMatch(stateCode, /prompt\(/, '取消不得发送（取消是纯读的结束）')
  assert.match(stateCode, /setTarget\(\s*null\s*\)|setOpen\(\s*false\s*\)|setVisible\(\s*false\s*\)/, '取消至少要真的关闭界面')
})

test('3.2 发送中禁用取消与输入，避免半写状态', () => {
  const overlay = mustFn(['EditResendOverlay'])
  // 实现用 `saving` 作为 in-flight 状态（与面板的 `busy` 同义）。两者都认。
  assert.match(overlay, /\b(saving|busy)\b/, '编辑框必须有 in-flight 状态（saving / busy）')
  assert.match(overlay, /disabled:\s*(saving|busy|!canSubmit)/, 'in-flight 时按钮必须 disabled')
  const cancel = blockAfter(overlay, 'const cancel')
  assert.ok(cancel, '找不到 cancel 回调')
  assert.match(flat(cancel), /if\s*\(\s*(saving|busy)\s*\)\s*return/, 'cancel 在 in-flight 时必须直接返回（不许中途取消）')
  assert.match(overlay, /readOnly:\s*(saving|busy)/, 'in-flight 时 textarea 必须只读（避免改到半写的文本）')
})

// ═══════════════════════════════════════════════════════════════════════════
// 4 · 「发送并回撤」顺序与失败语义
// ═══════════════════════════════════════════════════════════════════════════
test('4.1 先 POST /revert，成功之后才写草稿（顺序不可颠倒）', () => {
  const send = sendLogic()
  assert.ok(send, '找不到「发送并回撤」的实现体（EditResendOverlay.send / sendEditAndRevert）')
  const s = flat(send)
  const revertAt = s.indexOf('/api/message-ops/revert')
  // 写入用注入别名（doWrite / writeSessionDraft），两种写法都认
  const writeAt = [s.indexOf('doWrite('), s.indexOf('writeSessionDraft(')].filter(i => i !== -1).sort((a, b) => a - b)[0]
  assert.notEqual(revertAt, -1, '发送必须先调 /api/message-ops/revert')
  assert.ok(writeAt != null && writeAt !== -1, '发送成功后必须落盘草稿（doWrite / writeSessionDraft）')
  assert.ok(revertAt < writeAt, '顺序错了：必须 revert 成功后再写草稿（点发送才回撤）')
  assert.match(s, /writeSessionDraft/, '默认写入实现必须是 writeSessionDraft（同 fork/回填机制）')
})

test('4.2 revert 失败：编排层在任何副作用之前早退', () => {
  const send = flat(sendLogic() || '')
  assert.ok(send, '找不到「发送并回撤」的实现体')
  // 失败判据那一行（`!res.ok || !data.ok` / `stage: 'revert'` 的早退）
  const failAt = send.search(/data\.ok\s*!==\s*true|!data\s*\|\|\s*data\.ok|stage:\s*'revert'/)
  assert.ok(failAt >= 0, '缺 revert 失败的判定与早退')
  for (const token of [
    'markRowsShadowedFrom(',
    'markShadowed(',
    'doWrite(',
    'doSetDraft(',
    'doPersistDraft(',
    'doEmitChanged(',
    'doOpenSession(',
    'doSubmit(',
  ]) {
    const at = send.indexOf(token)
    if (at === -1) continue
    assert.ok(at > failAt, `${token} 出现在失败早退之前 —— revert 失败时不得有后续副作用`)
  }
})

test('4.2b 组件层：revert 失败不清空 textarea、不关闭、显示 edit.failed', () => {
  const raw = fn(['EditResendOverlay'])
  assert.ok(raw, '找不到 EditResendOverlay')
  const at = raw.indexOf('if (!result.ok)')
  assert.ok(at >= 0, '组件必须显式处理 sendEditAndRevert 的失败返回')
  // 精确切出 `if (!result.ok) { … }` 分支（按大括号配平），避免把后面的成功分支
  // 的 cancel() 误算进来。
  const branch = flat(blockAt(raw.slice(at), 'if (!result.ok)') || '')
  assert.ok(branch, '失败分支未闭合')
  assert.match(branch, /edit\.failed/, '失败文案必须是 edit.failed（含原因）')
  assert.match(branch, /setError\(/, '必须把错误显示出来')
  assert.match(branch, /return/, '失败分支必须早退（不得继续走成功路径）')
  assert.doesNotMatch(branch, /cancel\(\)/, 'revert 失败不得关闭编辑框')
  assert.doesNotMatch(branch, /setTarget\(\s*null\s*\)/, 'revert 失败不得清空 target')
  assert.doesNotMatch(branch, /setDraft\(\s*''\s*\)/, 'revert 失败不得清空用户已改的文本')
})

test('4.3 成功后依次：标遮蔽 → emitChanged → openSession → 官方 prompt（且不再写草稿）', () => {
  const send = sendLogic()
  assert.ok(send, '找不到「撤销并发送」的实现体')
  const s = flat(send || '')
  // 0.26.0 契约：官方 prompt 是唯一发送面，所以成功路径只该有这四个阶段。
  // 「写草稿 / setDraft / persistDraft / inputActions.submit」全部退场 ——
  // 它们会让改后的文本残留在 composer 里（用户明确反对「UI 上再复现一遍」）。
  const stages = [
    ['markRowsShadowedFrom(', 'markShadowed('],
    ['doEmitChanged(', 'emitChanged('],
    ['doOpenSession(', 'openSessionById('],
    ['doPrompt(', 'promptEditedText('],
  ]
  let last = -1
  for (const names of stages) {
    const hits = names.map(n => s.lastIndexOf(n)).filter(i => i !== -1)
    assert.ok(hits.length > 0, `成功后必须调用 ${names.join(' 或 ')}`)
    const at = Math.max(...hits)
    assert.ok(at > last, `${names[0]} 顺序不对（必须在前一阶段之后）`)
    last = at
  }
  // 负向锁：新路径**不得**再写草稿 / 驱动 composer（那是被删掉的旧编排）
  assert.doesNotMatch(s, /doSetDraft\(|doPersistDraft\(/, '成功路径不得再同步 composer 草稿（新契约走官方 prompt）')
})

test('4.4 官方 prompt 被拒必须显式报错（不许静默、不许谎报回撤失败）', () => {
  const overlay = mustFn(['EditResendOverlay'])
  // 成功反馈
  assert.match(overlay, /edit\.doneSubmitted/, '发送成功要有 edit.doneSubmitted 反馈')
  // 发送被拒的专门文案：回撤**已经成功**，不能再报 edit.failed（那会告诉用户回撤失败）
  assert.match(overlay, /edit\.sendFailed/, 'prompt 被拒要有独立文案（不能与回撤失败混用）')
  const raw = fn(['EditResendOverlay'])
  assert.match(flat(raw), /stage === 'send'/, "必须按 stage === 'send' 分流：回撤成功但发送被拒")
  // 重试语义：同一 seq 再回撤必然 409，所以发送被拒后只能「重新发送」
  assert.ok(overlay.includes('reverted: sendOnly'), '重试必须以 reverted 跳过回撤（否则必然 409）')
  assert.match(overlay, /edit\.resend/, '重试按钮文案是 edit.resend')

  // 编排层：官方发送面（不是 inputActions.submit 轮询）
  const send = mustFn('sendEditAndRevert')
  assert.match(send, /deps\.prompt|promptEditedText/, '编排层必须走官方 prompt 通道')
  assert.doesNotMatch(send, /submitEditedText|trySubmitEdited|ia\.submit\(/, '不得残留 inputActions.submit 轮询')
})

// ═══════════════════════════════════════════════════════════════════════════
// 5 · 全文来源：/api/message-ops/text，不拿 160 字 snippet 冒充
// ═══════════════════════════════════════════════════════════════════════════
test('5.1 预填文本来自 /text 全文接口', () => {
  const overlay = mustFn(['EditResendOverlay'])
  assert.match(flat(overlay), /\/api\/message-ops\/text\?/, '必须走 /text 取全文')
})

test('5.2 只有 ok===true 且 text 是字符串才算 ready；失败禁用发送并可重试', () => {
  const overlay = mustFn(['EditResendOverlay'])
  const o = flat(overlay)
  assert.match(o, /data\.ok|ok === true|ok !== true/, '必须校验 ok 字段')
  assert.match(o, /typeof [\w.]*text\s*!==?\s*'string'/, '必须校验 text 是字符串（空串/undefined 不算）')
  assert.match(o, /edit\.loadFail/, '取全文失败要有 edit.loadFail')
  assert.match(o, /edit\.retry/, '取全文失败要有 edit.retry（可重试）')
  assert.match(o, /disabled/, '全文未就绪时发送按钮必须 disabled')
})

test('5.3 不许把 snippet 当原文预填', () => {
  const overlay = mustFn(['EditResendOverlay'])
  assert.doesNotMatch(flat(overlay), /\.snippet/, '编辑框不许读 snippet（列表只带 160 字摘要）')
})

// ═══════════════════════════════════════════════════════════════════════════
// 6 · 样式：.mopsEr 前缀 / token / 圆角 / 无裸 hex
// ═══════════════════════════════════════════════════════════════════════════
// 注意：只认 .mopsEr 后面跟「大写字母或非字母」的类名，避免误吃既有的
// `.mopsErrorState`（面板错误态）—— 那是 0.19 就存在的类，不属于编辑框。
const MOPS_ER = /\.mopsEr(?![a-z])/
const mopsErLines = () => src.split('\n').filter(line => MOPS_ER.test(line))

test('6.1 编辑框样式用 .mopsEr 前缀，且七个契约类名都在', () => {
  const overlay = mustFn(['EditResendOverlay'])
  assert.match(flat(overlay), /mopsEr/, '编辑框样式必须用 .mopsEr 前缀（契约）')
  for (const name of ['mopsErScrim', 'mopsErPanel', 'mopsErText', 'mopsErActions', 'mopsErPrimary', 'mopsErGhost', 'mopsErError']) {
    assert.ok(f.includes(name), `缺样式类 ${name}`)
  }
})

test('6.2 样式全走 --dsw-alias-* / --dsw-radius-*，无裸 hex', () => {
  const lines = mopsErLines()
  assert.ok(lines.length > 0, '找不到任何 mopsEr 样式行')
  const joined = lines.join('\n')
  assert.match(joined, /--dsw-radius-/, '圆角必须走宿主 --dsw-radius-* token')
  assert.match(joined, /--dsw-alias-/, '颜色必须走宿主 --dsw-alias-* token')
  // 只允许 `var(--dsw-…, #hex)` 这种**带 token 的 fallback**；裸 hex 一律不许。
  const bare = lines.filter(line => /#[0-9a-fA-F]{3,8}/.test(line) && !line.includes('var(--dsw'))
  assert.deepEqual(bare, [], 'mopsEr 样式里出现裸 hex（深色模式会瞎）：\n' + bare.join('\n'))
})

// ═══════════════════════════════════════════════════════════════════════════
// 7 · i18n：新增 key 两侧齐全、顺序一致、语言正确
// ═══════════════════════════════════════════════════════════════════════════
const EDIT_KEYS = [
  'slot.edit',
  'slot.editHint',
  'slot.editNoText',
  'slot.editUnmatched',
  'edit.title',
  'edit.subtitle',
  'edit.loading',
  'edit.loadFail',
  'edit.retry',
  'edit.placeholder',
  'edit.cancel',
  'edit.send',
  'edit.sending',
  'edit.resend',
  'edit.sendFailed',
  'edit.empty',
  'edit.failed',
  'edit.doneSubmitted',
  'edit.manual',
  'edit.running',
  'edit.replaceHint',
]

function grabDict(name) {
  const at = src.indexOf(`const ${name} = {`)
  assert.notEqual(at, -1, `找不到 ${name}`)
  const block = blockAt(src, `const ${name} = {`)
  const out = {}
  for (const m of block.matchAll(/'([a-zA-Z][\w.]*)':\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g)) {
    out[m[1]] = m[2] ?? m[3]
  }
  return out
}

function dictKeyOrder(name) {
  const block = blockAt(src, `const ${name} = {`)
  return [...block.matchAll(/'([a-zA-Z][\w.]*)':/g)].map(m => m[1])
}

test('7.1 20 个新增 key 在 zh / en 两侧都存在', () => {
  const zh = grabDict('zhDict')
  const en = grabDict('enDict')
  const missingZh = EDIT_KEYS.filter(k => !(k in zh))
  const missingEn = EDIT_KEYS.filter(k => !(k in en))
  assert.deepEqual(missingZh, [], `zhDict 缺：${missingZh.join(', ')}`)
  assert.deepEqual(missingEn, [], `enDict 缺：${missingEn.join(', ')}`)
})

test('7.2 zh 是中文、en 不是中文；占位符集合一致', () => {
  const zh = grabDict('zhDict')
  const en = grabDict('enDict')
  const cjk = /[\u3400-\u9fff]/
  const names = s => (String(s).match(/\{[a-zA-Z]+\}/g) || []).sort()
  for (const k of EDIT_KEYS) {
    assert.ok(cjk.test(zh[k]), `zhDict['${k}'] 不是中文：${zh[k]}`)
    assert.ok(!cjk.test(en[k]), `enDict['${k}'] 混进中文：${en[k]}`)
    assert.deepEqual(names(zh[k]), names(en[k]), `占位符集合不一致：${k}`)
  }
})

test('7.3 zh / en key 序列一致，且编辑 key 成块紧接 slot.forkUnavailable', () => {
  const zhKeys = dictKeyOrder('zhDict')
  const enKeys = dictKeyOrder('enDict')
  assert.deepEqual(zhKeys, enKeys, 'zh / en key 序列必须完全一致（含顺序）')
  // 0.26.0：块序按实现里的实际序列锁（新增 edit.resend / edit.sendFailed 之后）。
  // 不再手抄一份「应该是什么」的常量 —— 直接从 EDIT_KEYS 推：它已经按实现顺序列好，
  // 只需断言它整体紧接 slot.forkUnavailable 之后、且顺序逐项相等。
  for (const keys of [zhKeys, enKeys]) {
    const anchor = keys.indexOf('slot.forkUnavailable')
    assert.notEqual(anchor, -1, '缺 slot.forkUnavailable 锚点')
    assert.deepEqual(
      keys.slice(anchor + 1, anchor + 1 + EDIT_KEYS.length),
      EDIT_KEYS,
      '编辑 key 必须紧接 slot.forkUnavailable 之后成块插入且顺序不变',
    )
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// 8 · 真执行：直接跑编排函数（若实现方导出 __test.sendEditAndRevert）
// ═══════════════════════════════════════════════════════════════════════════

/** 极小 DOM + 最小宿主桩，只为让插件工厂跑完并交出 __test。 */
class El {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase()
    this.children = []
    this.attributes = {}
    this.style = {}
    this.classList = {
      _s: new Set(),
      add(c) {
        this._s.add(c)
      },
      contains(c) {
        return this._s.has(c)
      },
      get value() {
        return [...this._s].join(' ')
      },
    }
    this._listeners = {}
    this.parentElement = null
    this.className = ''
    this.disabled = false
  }
  appendChild(c) {
    c.parentElement = this
    this.children.push(c)
    return c
  }
  setAttribute(k, v) {
    this.attributes[k] = String(v)
  }
  getAttribute(k) {
    return k in this.attributes ? this.attributes[k] : null
  }
  hasAttribute(k) {
    return k in this.attributes
  }
  removeAttribute(k) {
    delete this.attributes[k]
  }
  addEventListener(t, fn) {
    ;(this._listeners[t] ||= []).push(fn)
  }
  matches() {
    return false
  }
  querySelectorAll(sel) {
    const out = []
    const match = c => {
      if (sel === 'svg path') return c.tagName === 'PATH'
      if (sel === 'svg') return c.tagName === 'SVG'
      if (sel === 'use') return c.tagName === 'USE'
      return false
    }
    const walk = n => {
      for (const c of n.children) {
        if (match(c)) out.push(c)
        walk(c)
      }
    }
    walk(this)
    return out
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null
  }
  closest() {
    return null
  }
}

function withDom(run) {
  const body = new El('body')
  const g = {
    window: {
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {},
      __MOPS_DEBUG: false,
      __ModuleLoader__: null,
    },
    document: {
      body,
      head: new El('head'),
      documentElement: { clientWidth: 1200 },
      activeElement: null,
      getElementById: () => null,
      createElement: t => new El(t),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    localStorage: {
      _m: new Map(),
      getItem(k) {
        return this._m.has(k) ? this._m.get(k) : null
      },
      setItem(k, v) {
        this._m.set(k, String(v))
      },
      removeItem(k) {
        this._m.delete(k)
      },
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    CustomEvent: class {
      constructor(t, o) {
        this.type = t
        this.detail = o?.detail
      }
    },
  }
  const saved = {}
  for (const k of Object.keys(g)) {
    saved[k] = globalThis[k]
    globalThis[k] = g[k]
  }
  try {
    return run(g)
  } finally {
    for (const k of Object.keys(g)) {
      if (saved[k] === undefined) delete globalThis[k]
      else globalThis[k] = saved[k]
    }
  }
}

/** 加载插件取出 __test 面（每个用例独立加载，避免共享模块状态）。 */
function loadPlugin(g) {
  let api = null
  g.window.__ModuleLoader__ = {
    load({ factory }) {
      api = factory(id => {
        if (id === 'react') {
          return {
            useState: v => [typeof v === 'function' ? v() : v, () => {}],
            useEffect() {},
            useRef: v => ({ current: v }),
            useCallback: fn => fn,
            createElement: () => null,
            Fragment: {},
          }
        }
        return {}
      })
    },
  }
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'localStorage', 'fetch', 'MutationObserver', 'ResizeObserver', 'CustomEvent', src)(
    g.window,
    g.document,
    g.localStorage,
    g.fetch,
    g.MutationObserver,
    g.ResizeObserver,
    g.CustomEvent,
  )
  assert.ok(api, '插件工厂未执行（window.__ModuleLoader__.load 未被调用）')
  return api
}

/**
 * 构造实现接受的 deps（键名与 `sendEditAndRevert` 里 `deps.*` 的读取一一对应：
 * fetch / markRowsShadowedFrom / emitChanged / openSessionById / **prompt**
 * （老宿主降级路径还会读 writeSessionDraft / readSessionDraft）。
 *
 * ⚠️ 用错键名会静默落回真实实现（例如 prompt 落到 promptEditedText 后因为没有
 * sessions 服务而走降级分支），结果是「看起来成功但其实没发送」——
 * 所以这里集中一处构造，别在用例里手写。
 */
function makeDeps(calls, opts) {
  const o = opts || {}
  return {
    fetch: async url => {
      calls.push(['fetch', String(url)])
      return o.revertOk === false
        ? { ok: false, status: 409, json: async () => ({ ok: false, error: 'session is running' }) }
        : { ok: true, status: 200, json: async () => ({ ok: true }) }
    },
    writeSessionDraft: (id, t) => {
      calls.push(['writeSessionDraft', id, t])
      return true
    },
    readSessionDraft: () => null,
    markRowsShadowedFrom: () => calls.push(['markRowsShadowedFrom']),
    setDraft: () => calls.push(['setDraft']),
    persistDraft: () => calls.push(['persistDraft']),
    emitChanged: () => calls.push(['emitChanged']),
    openSessionById: () => calls.push(['openSessionById']),
    // 0.26.0（官方发送面）：prompt(text, mode) 是唯一提交通道。
    // 记录**全部实参**，测试据此断言 mode === 'queue' 与发送文本。
    prompt: (t, mode) => {
      calls.push(['prompt', t, mode])
      return Promise.resolve(o.promptResult || { ok: true, accepted: true })
    },
  }
}

test('8.1 真执行：revert 失败时零写盘（若 __test.sendEditAndRevert 存在）', () => {
  return withDom(g => {
    const { __test } = loadPlugin(g)
    const fnSend = __test && __test.sendEditAndRevert
    assert.equal(typeof fnSend, 'function', '__test.sendEditAndRevert 必须导出（否则真执行静默蒸发）')
    const calls = []
    const deps = makeDeps(calls, { revertOk: false })
    return Promise.resolve(fnSend({ sessionId: 'uuid', rawSessionId: 'session-uuid', seq: 12, text: '改后文本', deps })).then(out => {
      assert.equal(out && out.ok, false, 'revert 失败必须返回 ok:false')
      assert.equal(out.stage, 'revert', '失败阶段必须是 revert')
      const after = calls.map(c => c[0]).filter(n => n !== 'fetch')
      assert.deepEqual(after, [], 'revert 失败时不得有任何后续副作用（写盘/重建/提交）')
    })
  })
})

test('8.2 真执行：revert 成功时顺序为 revert → 标遮蔽 → emitChanged → openSession → 官方 prompt', () => {
  return withDom(g => {
    const { __test } = loadPlugin(g)
    const fnSend = __test && __test.sendEditAndRevert
    assert.equal(typeof fnSend, 'function', '__test.sendEditAndRevert 必须导出（否则真执行静默蒸发）')
    const calls = []
    const deps = makeDeps(calls, { revertOk: true })
    return Promise.resolve(fnSend({ sessionId: 'uuid', rawSessionId: 'session-uuid', seq: 12, text: '改后文本', deps })).then(out => {
      assert.equal(out && out.ok, true, 'revert 成功应返回 ok:true')
      assert.equal(out.stage, 'done', '成功阶段必须是 done')
      assert.equal(out.submitted, true, '官方 prompt 被接受时 submitted 必须是 true')
      assert.equal(out.mode, 'official', '成功路径必须是官方发送面（不是降级草稿）')
      const names = calls.map(c => c[0])
      const at = n => names.indexOf(n)
      assert.equal(names[0], 'fetch', '第一个副作用必须是 POST /revert')
      assert.match(calls[0][1], /\/api\/message-ops\/revert/, '第一个请求必须是 /revert')
      assert.ok(at('markRowsShadowedFrom') > 0, '成功后必须标遮蔽（防 409 护栏）')
      assert.ok(at('emitChanged') > at('markRowsShadowedFrom'), 'emitChanged 在标遮蔽之后')
      assert.ok(at('openSessionById') > at('emitChanged'), 'openSession 在 emitChanged 之后')
      assert.ok(at('prompt') > at('openSessionById'), '官方 prompt 必须在视图重建之后（否则遮蔽还没落地）')
      // 负向锁：旧编排的两个阶段不得出现（写草稿会让文本残留 composer）
      assert.equal(at('writeSessionDraft'), -1, '官方 prompt 路径**不得**再写草稿（会残留重复文本）')
      assert.equal(at('setDraft'), -1, '官方 prompt 路径不得再驱动 composer 的 setDraft')
      // prompt 必须是 queue 模式且只带一个 text part
      const prompt = calls.find(c => c[0] === 'prompt')
      assert.equal(prompt[2], 'queue', "prompt 必须用 'queue' 模式（追加一轮，不打断）")
      assert.equal(prompt[1], '改后文本', 'prompt 发送的必须是用户改后的文本')
      return null
    })
  })
})

test('9.1 真执行：revert 失败时官方 prompt 零调用（零副作用）', () => {
  return withDom(g => {
    const { __test } = loadPlugin(g)
    assert.equal(typeof __test.sendEditAndRevert, 'function', '编排层必须导出（否则真执行静默蒸发）')
    const calls = []
    const deps = makeDeps(calls, { revertOk: false })
    return Promise.resolve(
      __test.sendEditAndRevert({ sessionId: 'uuid', rawSessionId: 'session-uuid', seq: 12, text: '改后文本', deps }),
    ).then(out => {
      assert.equal(out.ok, false, 'revert 失败必须返回 ok:false')
      assert.equal(out.stage, 'revert', '失败阶段必须是 revert')
      assert.equal(calls.filter(c => c[0] === 'prompt').length, 0, 'revert 失败时绝不许发送（会发出与回撤无关的消息）')
      assert.deepEqual(
        calls.map(c => c[0]).filter(n => n !== 'fetch'),
        [],
        'revert 失败时不得有任何后续副作用',
      )
    })
  })
})

test('9.2 真执行：prompt 抛错 → 返回 stage send / ok:false，不吞异常', () => {
  return withDom(g => {
    const { __test } = loadPlugin(g)
    const calls = []
    const deps = makeDeps(calls, { revertOk: true })
    deps.prompt = () => {
      calls.push(['prompt'])
      throw new Error('prompt boom')
    }
    return Promise.resolve(
      __test.sendEditAndRevert({ sessionId: 'uuid', rawSessionId: 'session-uuid', seq: 12, text: '改后文本', deps }),
    ).then(out => {
      // 回撤已经成功 → 不能报「回撤失败」，否则用户会被误导去重试回撤（必然 409）
      assert.equal(out.ok, false, 'prompt 抛错必须返回 ok:false')
      assert.equal(out.stage, 'send', "回撤成功后的发送失败必须单列 stage:'send'")
      assert.equal(out.submitted, false, '不许把失败谎报成已提交')
      assert.match(String(out.reason), /prompt boom/, '必须把原始错误带出来（不吞）')
      assert.equal(calls.filter(c => c[0] === 'prompt').length, 1, 'prompt 只尝试一次，不做隐藏重试')
    })
  })
})

test('9.3 真执行：官方发送面缺席 → 唯一降级（写草稿 + 回读），只有一个 manual 分支', () => {
  return withDom(g => {
    const { __test } = loadPlugin(g)
    const calls = []
    const deps = makeDeps(calls, { revertOk: true })
    // 模拟老宿主：sessions 服务缺席
    deps.prompt = () => Promise.resolve({ ok: false, unavailable: true, reason: 'sessions service unavailable' })
    // 回读返回写入的值 → persisted 必须为 true
    deps.readSessionDraft = () => '改后文本'
    return Promise.resolve(
      __test.sendEditAndRevert({ sessionId: 'uuid', rawSessionId: 'session-uuid', seq: 12, text: '改后文本', deps }),
    ).then(out => {
      assert.equal(out.ok, true, '降级路径写盘成功仍算 ok（不能让用户以为整个操作失败）')
      assert.equal(out.submitted, false, '降级路径没有真的发送，submitted 必须是 false')
      assert.equal(out.mode, 'manual', '降级路径必须显式标记 mode=manual')
      assert.equal(out.manual, true, '降级路径必须带 manual 标记供组件选文案')
      assert.equal(out.persisted, true, '回读一致时 persisted 必须为 true')
      const names = calls.map(c => c[0])
      assert.equal(names.filter(n => n === 'writeSessionDraft').length, 1, '降级只写一次草稿（不复制第二套 composer）')
      assert.equal(names.filter(n => n === 'setDraft').length, 0, '降级也不许驱动 composer 的活编辑器')
    })
  })
})

test('9.4 真执行：降级路径写盘后回读到不一致 → persisted=false（如实报失败）', () => {
  return withDom(g => {
    const { __test } = loadPlugin(g)
    const deps = makeDeps([], { revertOk: true })
    deps.prompt = () => Promise.resolve({ ok: false, unavailable: true, reason: 'no sessions' })
    deps.readSessionDraft = () => '别的内容'
    return Promise.resolve(
      __test.sendEditAndRevert({ sessionId: 'uuid', rawSessionId: 'session-uuid', seq: 12, text: '改后文本', deps }),
    ).then(out => {
      assert.equal(out.mode, 'manual')
      assert.equal(out.persisted, false, '回读不一致必须如实报 persisted=false（不许假装成功）')
    })
  })
})

test('8.3 真执行：reverted=true 时跳过回撤与视图重建，只发一次官方 prompt（重新发送）', () => {
  return withDom(g => {
    const { __test } = loadPlugin(g)
    const calls = []
    const deps = makeDeps(calls, { revertOk: true })
    return Promise.resolve(
      __test.sendEditAndRevert({
        sessionId: 'uuid',
        rawSessionId: 'session-uuid',
        seq: 12,
        text: '改后文本',
        deps,
        reverted: true,
      }),
    ).then(out => {
      assert.equal(out.ok, true, '重新发送必须成功')
      assert.equal(out.stage, 'done')
      assert.equal(calls.filter(c => c[0] === 'fetch').length, 0, '同一 seq 再回撤必然 409，重新发送不得再 POST /revert')
      assert.equal(calls.filter(c => c[0] === 'openSessionById').length, 0, '重新发送不需要再重建视图')
      assert.equal(calls.filter(c => c[0] === 'prompt').length, 1, '重新发送只发一次 prompt')
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 10 · 0.24.0 P4：InputActions 必须按会话隔离（跨会话污染防护）
// ═══════════════════════════════════════════════════════════════════════════
test('10.1 结构：__inputActions 不再是唯一权威，按会话 Map 才是', () => {
  assert.match(src, /var __inputActionsBySession = new Map\(\)/, '必须有按会话的 Map')
  assert.match(src, /function inputActionsFor\(/, '必须有按会话读取的访问器')
  assert.match(src, /function rememberInputActions\(/, '必须有按会话登记')
  assert.match(src, /function forgetInputActions\(/, '必须有按会话卸载清理')
})

test('10.2 真执行：两个会话各自登记，互不覆盖（旧实现会串到最后一个）', () => {
  return withDom(g => {
    const { __test } = loadPlugin(g)
    const mkIA = name => {
      const calls = []
      return {
        name,
        calls,
        setDraft: v => calls.push([name, 'setDraft', v]),
        persistDraft: () => calls.push([name, 'persist']),
        submit: () => calls.push([name, 'submit']),
      }
    }
    const iaA = mkIA('A')
    const iaB = mkIA('B')

    __test.rememberInputActions('session-aaa', iaA)
    __test.rememberInputActions('session-bbb', iaB)

    // 核心断言：后登记的 B 不得顶掉 A
    assert.equal(__test.inputActionsFor('session-aaa'), iaA, 'A 会话必须仍取到自己的 InputActions')
    assert.equal(__test.inputActionsFor('session-bbb'), iaB, 'B 会话取到自己的')

    // 归一：带前缀与裸 uuid 视为同一会话
    assert.equal(__test.inputActionsFor('aaa'), iaA, '裸 uuid 必须命中带前缀登记的同一会话')
    assert.equal(__test.inputActionsFor('session-bbb'), __test.inputActionsFor('bbb'), '两种拼写必须等价')

    // 未知会话必须返回 null（明确失败路径，不许退到「最后一次已知」）
    assert.equal(__test.inputActionsFor('session-unknown'), null, '未知会话必须返回 null，不得回退到别的会话')
    assert.equal(__test.inputActionsFor(''), null, '空 sessionId 必须返回 null')
  })
})

test('10.3 真执行：卸载只删自己的，且不误删同会话的新实例', () => {
  return withDom(g => {
    const { __test } = loadPlugin(g)
    const mkIA = name => ({ name, setDraft() {}, persistDraft() {} })
    const oldA = mkIA('oldA')
    const newA = mkIA('newA')
    const iaB = mkIA('B')

    __test.rememberInputActions('session-aaa', oldA)
    __test.rememberInputActions('session-bbb', iaB)
    // 同会话重挂：新实例顶替旧实例
    __test.rememberInputActions('session-aaa', newA)
    assert.equal(__test.inputActionsFor('session-aaa'), newA, '重挂后应取新实例')

    // 旧实例的卸载回调晚到 —— 不得把新实例删掉
    __test.forgetInputActions('session-aaa', oldA)
    assert.equal(__test.inputActionsFor('session-aaa'), newA, '旧实例的迟到卸载不得删掉新实例')

    // 真正卸载
    __test.forgetInputActions('session-aaa', newA)
    assert.equal(__test.inputActionsFor('session-aaa'), null, '卸载后应取不到')
    assert.equal(__test.inputActionsFor('session-bbb'), iaB, 'B 会话不受 A 卸载影响')
  })
})

test('10.4 真执行：refill 路径取不到本会话 InputActions 时，绝不用别的会话的编辑器', () => {
  return withDom(g => {
    const { __test } = loadPlugin(g)
    const calls = []
    const iaOther = { setDraft: v => calls.push(['other', v]), persistDraft: () => calls.push(['other-persist']) }
    // 只有「别的会话」登记过
    __test.rememberInputActions('session-other', iaOther)

    assert.equal(__test.inputActionsFor('session-mine'), null, '本会话未登记时必须为 null')
    // 直接断言访问器不返回别人的对象
    assert.notEqual(__test.inputActionsFor('session-mine'), iaOther, '绝不能返回别的会话的 InputActions')
    assert.deepEqual(calls, [], '未发生任何跨会话写入')
  })
})
