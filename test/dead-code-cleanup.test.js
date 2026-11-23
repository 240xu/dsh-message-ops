/**
 * 0.25.0 死代码清理的「不得复活」锁。
 *
 * 背景：本插件 0.23.0 起 AI 消息动作槽（`conversation.chat.assistant-actions`）
 * 已 `return null`（引用让位宿主 dsh-message-quotes，D-4；行内 fork 让位官方，
 * D-5），但支撑那套 UI 的机械一直留在源码里：自绘引用链路、两套 messageId→seq
 * 索引、无消费方的全局兜底变量、React 版分叉图标组件，以及只剩字典定义的死 key。
 * 0.25.0 把它们全部删除（详见 docs/DECISIONS.md 与工单 A）。
 *
 * 这个文件锁的是**删除本身**：将来谁想重新加回来，必须先在 DECISIONS 里过一遍
 * 产品决策（尤其 D-1 铅笔 / D-2 面板 / D-4 引用 / D-5 分叉），不能「顺手修复」。
 *
 * 断言口径：只看**代码形态**，容忍注释 —— 源码注释里会解释这些符号为什么删，
 * 那是文档，不是复活。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readSource, flat, blockAt } from './_source.js'

const src = readSource()

/** 去掉注释行与空行后的纯代码（注释里提到「已删」「D-4」等不算复活）。 */
function codeOnly(text) {
  return String(text || '')
    .split('\n')
    .filter(line => {
      const t = line.trim()
      return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t === '')
    })
    .join('\n')
}

const code = codeOnly(src)

/** 断言 zh / en 两侧都没有这个 i18n key（单侧残留会被 P0-4 的序列锁抓到）。 */
function assertKeyGone(key, why) {
  const re = new RegExp(`'${key.replace(/\./g, '\\.')}':`)
  assert.doesNotMatch(code, re, `i18n key '${key}' 不得复活：${why}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 · 自建引用机械（0.23.0 起不可达；引用让位宿主 dsh-message-quotes，D-4）
// ═══════════════════════════════════════════════════════════════════════════
test('1 · 引用机械全部删除：IconQuote / clipQuote / runQuote / selectionInMessage / ownerOf', () => {
  assert.doesNotMatch(code, /var IconQuote\s*=\s*null/, 'IconQuote 初始化块已删（0.25.0）')
  assert.doesNotMatch(code, /function QuoteFallback\(/, '引号 fallback 组件已删')
  assert.doesNotMatch(code, /const QUOTE_MAX_CHARS\s*=\s*\d/, '引用长度上限常量已删')
  assert.doesNotMatch(code, /let quoteSegmenter\s*=\s*null/, 'Intl.Segmenter 缓存已删')
  assert.doesNotMatch(code, /const graphemes\s*=\s*raw\s*=>/, 'grapheme 切分已删')
  assert.doesNotMatch(code, /const clipQuote\s*=\s*raw\s*=>/, '安全截断已删')
  assert.doesNotMatch(code, /const ownerOf\s*=\s*node\s*=>/, '选区归属判定已删')
  assert.doesNotMatch(code, /const selectionInMessage\s*=\s*/, '选区判定已删')
  assert.doesNotMatch(code, /const runQuote\s*=\s*/, '引用动作已删')
  assert.doesNotMatch(code, /function runQuote\(/, '引用动作已删')
  assert.doesNotMatch(code, /inputActions\s*\.\s*insertQuote\s*\(/, 'insertQuote 归宿主 text-interaction 槽')
})

test('1 · 引用配套的 fullText 拉取链路删除（唯一消费者已消失）', () => {
  assert.doesNotMatch(code, /const \[fullText,\s*setFullText\]/, 'MsgSlotActions 的 fullText state 已删')
  // 注意：行缓存里的 `fullText:` 字段仍是活的（refillComposer 依赖），不能被误删
  assert.match(code, /fullText:\s*m\.fullText\s*\?\?\s*null/, 'rowsCache 仍必须带出 fullText（回填依赖）')
})

test('1 · MsgSlotActions 必须只剩「捕获 inputActions + return null」', () => {
  const body = blockAt(src, 'function MsgSlotActions(props)')
  assert.ok(body, 'MsgSlotActions 必须仍存在（删了会让编辑框/面板/回填静默失效）')
  const flatBody = flat(body)
  assert.match(flatBody, /rememberInputActions\(sessionId, inputActions\)/, '捕获 inputActions 的 effect 必须保留')
  assert.match(flatBody, /forgetInputActions\(sessionId, inputActions\)/, '卸载清理也必须保留')
  assert.match(flatBody, /return null/, '该槽不渲染任何按钮')
  // 不得重新长出按钮工厂 / 忙碌态
  assert.doesNotMatch(flatBody, /const act = \(icon, label/, 'act 工厂已删（0 处调用）')
  assert.doesNotMatch(flatBody, /const \[busy, setBusy\]/, 'busy state 已删（0 处调用）')
  assert.doesNotMatch(flatBody, /const revealSession = \(\) =>/, 'revealSession 已删（0 处调用）')
})

test('1 · 5 个引用 i18n key 在 zh / en 两侧都已删除', () => {
  for (const k of ['slot.quote', 'quote.done', 'quote.unavailable', 'quote.sourcePrefix', 'quote.doneWithSource']) {
    assertKeyGone(k, '引用按钮已随 D-4 删除，这些 key 只剩字典定义')
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// 2 · __seqIndexCache / __fullTextCache 双索引（0.25.0 收敛到 rowsCache）
// ═══════════════════════════════════════════════════════════════════════════
test('2 · messageId→seq 双索引不得复活（唯一来源必须是 rowsCache）', () => {
  assert.doesNotMatch(code, /var __seqIndexCache\s*=\s*new Map\(\)/, 'messageId→seq 缓存已删')
  assert.doesNotMatch(code, /var __fullTextCache\s*=\s*new Map\(\)/, 'messageId→全文 缓存已删')
  assert.doesNotMatch(code, /__seqIndexCache\./, '索引读写已删')
  assert.doesNotMatch(code, /__fullTextCache\./, '全文缓存读写已删')
  assert.doesNotMatch(code, /const SEQ_INDEX_EVENT\s*=/, '双索引失效广播常量已删')
  assert.doesNotMatch(code, /dispatchEvent\(new CustomEvent\(SEQ_INDEX_EVENT\)\)/, '广播已删')
  assert.doesNotMatch(code, /var syncSeqIndex\s*=\s*\(/, 'dataSig 驱动的索引重建已删')
  assert.doesNotMatch(code, /syncSeqIndex\(/, '重建函数的调用点已删')
  // 单一来源仍必须是注入器的行缓存
  assert.match(code, /var rowsCache = \{ sid: null, rows: null, at: 0, running: false \}/, 'rowsCache 必须是唯一行缓存')
})

test('2 · 槽位不再订阅索引失效事件（订阅方已删）', () => {
  assert.doesNotMatch(code, /addEventListener\(SEQ_INDEX_EVENT/, '已无订阅方')
  assert.doesNotMatch(code, /const \[idxRev, setIdxRev\]/, 'idxRev 失效代号 state 已删')
})

// ═══════════════════════════════════════════════════════════════════════════
// 3 · __inputActions 全局兜底（0.24.0 起按会话 Map 才是权威）
// ═══════════════════════════════════════════════════════════════════════════
test('3 · 裸 __inputActions 兜底变量已删，只允许按会话 Map', () => {
  assert.doesNotMatch(code, /var __inputActions\s*=\s*null/, '全局兜底变量已删（0 个读取方）')
  assert.doesNotMatch(code, /__inputActions\s*=\s*inputActions/, '兜底赋值已删')
  // 反向：权威访问面必须还在，且必须是按会话的
  assert.match(code, /var __inputActionsBySession = new Map\(\)/, '按会话 Map 必须存在')
  assert.match(code, /function inputActionsFor\(sessionId\)/, '按会话读取器必须存在')
  assert.match(code, /function sessionKeyOf\(sessionId\)/, '会话键归一必须存在')
})

test('3 · 回填路径仍按会话取 InputActions（不得回退到「最后一次已知」）', () => {
  const fn = blockAt(src, 'var refillComposer =')
  assert.ok(fn, 'refillComposer 必须存在')
  assert.match(flat(fn), /inputActionsFor\(rawSid\)/, '必须按会话取，取不到就走明确失败路径')
  // 注释里会解释旧实现（`__inputActions.setDraft` 那段历史），只看代码形态：
  assert.doesNotMatch(codeOnly(fn), /__inputActions\b(?!BySession)/, '不许再读全局兜底（注释里提到旧实现是文档，不算复活）')
})

// ═══════════════════════════════════════════════════════════════════════════
// 4 · BranchIcon React 组件（0 处渲染，分叉几何只留 branchIconMarkup）
// ═══════════════════════════════════════════════════════════════════════════
test('4 · React 版 BranchIcon 组件已删，branchIconMarkup 是唯一入口', () => {
  assert.doesNotMatch(code, /function BranchIcon\(/, 'BranchIcon 组件已删（0 处渲染）')
  assert.doesNotMatch(code, /createElement\(BranchIcon\)/, '不得再渲染该组件')
  // 唯一入口与其常量必须保留
  assert.match(code, /const BRANCH_PATH\s*=\s*'M5 2\.5/, 'BRANCH_PATH 必须保留（唯一几何来源）')
  assert.match(code, /const BRANCH_STROKE = 1\.4/, 'BRANCH_STROKE 必须保留')
  assert.match(code, /function branchIconMarkup\(size\)/, 'markup 工厂必须保留（侧栏菜单在用）')
  assert.match(code, /item\.innerHTML = branchIconMarkup\(16\)/, '侧栏菜单项仍必须用该工厂')
})

// ═══════════════════════════════════════════════════════════════════════════
// 5 · 行内分叉遗留 key（D-5 已删行内 fork；slot.forkUnavailable 必须保留）
// ═══════════════════════════════════════════════════════════════════════════
test('5 · 六组行内分叉 key 在 zh / en 两侧都已删除', () => {
  for (const k of ['slot.fork', 'slot.forkHint', 'slot.forkDone', 'fork.official', 'fork.unavailable', 'toast.openNew']) {
    assertKeyGone(k, '行内 fork 已删（D-5），这些 key 只剩字典定义')
  }
})

test('5 · slot.forkUnavailable 必须保留（面板 branch 仍走它）', () => {
  const zh = src.match(/'slot\.forkUnavailable':\s*'([^']*)'/)
  assert.ok(zh, "zh 侧 'slot.forkUnavailable' 必须保留")
  const en = src.match(/'slot\.forkUnavailable':\s*'([^']*)'/)
  assert.ok(en, "en 侧 'slot.forkUnavailable' 必须保留")
  assert.match(flat(blockAt(src, 'async function forkFromUserMessage')), /slot\.forkUnavailable/, 'forkFromUserMessage 仍必须用它报错')
})

// ═══════════════════════════════════════════════════════════════════════════
// 6 · 其它 0 消费方的死 key
// ═══════════════════════════════════════════════════════════════════════════
test('6 · done.delete / action.reload / dock.shadowedN / edit.done 已删除', () => {
  for (const k of ['done.delete', 'action.reload', 'dock.shadowedN', 'edit.done']) {
    assertKeyGone(k, '0 处消费（仅 zh+en 字典定义本身）')
  }
  // 近邻的活 key 必须还在（防止「删多了」）
  for (const k of ['done.revert', 'done.revertNoRefill', 'dock.title', 'edit.doneSubmitted']) {
    assert.match(src, new RegExp(`'${k.replace(/\./g, '\\.')}':`), `活 key '${k}' 不能误删`)
  }
})

test('6 · i18n 两侧 key 序列仍完全一致（删 key 必须 zh/en 同删）', () => {
  const zhAt = src.indexOf('const zhDict = {')
  const enAt = src.indexOf('const enDict = {')
  assert.ok(zhAt >= 0 && enAt >= 0, '两本字典必须存在')
  const grab = at => [...blockAt(src, src.slice(at, at + 16)).matchAll(/'([a-zA-Z][\w.]*)':/g)].map(m => m[1])
  const zh = grab(zhAt)
  const en = grab(enAt)
  assert.ok(zh.length > 100, `zhDict key 数量异常（${zh.length}）`)
  assert.deepEqual(zh, en, 'zh / en key 序列必须逐项相同（含顺序）')
})
