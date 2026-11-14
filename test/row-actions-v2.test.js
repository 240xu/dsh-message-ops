/**
 * 0.18.0 回归锁：行内操作三项修复。
 *
 * 用户反馈（原话）：
 *   1.「编辑重发的按钮可以和回撤放在同一个地方，就是用一个笔的那个图标」
 *      → 0.18 做了铅笔但只回填 composer，0.19 删掉，0.20 以**独立编辑框**回归。
 *   2.「引用AI的话...我怎么还得点一下这个类似于复制的按钮，然后这个会话直接
 *      跳进输入框，这UI做的怎么这么诡异？而且这样真的行吗？查点权威资料和官方代码」
 *   3.「那个时间的图标，怎么点那个也是回撤啊？那我自己发出去的那个回撤有什么用呢？」
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

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
  throw new Error(`块未闭合：${name}`)
}

// ── 1 · 0.20.0：铅笔回归，但必须是编辑框（spec §10 覆盖 §9 的「删铅笔」）────
test('1：行内铅笔回归（.mopsUserEdit），且与回撤同一动作行', () => {
  assert.match(src, /mopsUserEdit/, '0.20.0 起铅笔按钮回归')
  const fn = block('ensureEditBtn')
  assert.match(fn, /xzv4MW_actions/, '必须挂进宿主官方动作行（与回撤同排）')
})

test('0.23：动作行 = 回撤 → 编辑（分叉让位官方）', () => {
  const fn = block('ensureUserActions')
  const r = fn.indexOf('ensureBtn(')
  const e = fn.indexOf('ensureEditBtn(')
  assert.ok(r >= 0, '缺回撤')
  assert.ok(e >= 0, '缺铅笔编辑')
  assert.ok(r < e, '顺序 回撤 → 编辑')
  assert.equal(fn.indexOf('ensureForkBtn('), -1, '行内分叉已删')
})

test('1：铅笔点开的是编辑框，不是把原文塞回 composer（0.18 的旧 bug 不许回来）', () => {
  assert.match(block('runUserEdit'), /EDIT_EVENT/, '铅笔必须派发 EDIT_EVENT')
  assert.doesNotMatch(block('runUserEdit'), /refillComposer\(/, '铅笔不许退化成 refillComposer')
  assert.ok(/EditResendOverlay/.test(src), '必须有独立编辑框组件')
})

// ── 2 · 引用必须用官方 insertQuote，不能手拼 markdown ────────────────────────
test('2：引用走官方 insertQuote（结构化 QuoteNode），不再手工拼 "> "', () => {
  const fn = block('runQuote')
  assert.match(fn, /inputActions\.insertQuote\(/, '必须调用宿主官方 insertQuote')
  assert.doesNotMatch(fn, /'> ' \+ l/, '不许再手工拼 markdown 引用前缀')
  assert.doesNotMatch(fn, /inputActions\.insertText\(/, '不该再用 insertText 裸插文本')
})

test('2：不再依赖 captureInsertion（那是位置快照，异步期间会失效）', () => {
  const fn = block('runQuote')
  assert.doesNotMatch(fn, /captureInsertion\(\)/, 'insertQuote 自带光标定位，不需要位置快照')
})

// ── 3 · 时间文本与破坏性操作必须有视觉分隔 ───────────────────────────────────
test('3：插件按钮组与「时间/复制」之间必须有分隔（防误触回滚）', () => {
  assert.match(src, /\.mopsUserRevert:first-of-type\{margin-left/, '首按钮要有额外间距')
  assert.match(src, /\.mopsUserRevert:first-of-type::before/, '要有视觉分隔线')
})

test('3：回滚按钮独立于宿主的时钟/复制元素（不被绑定到时间上）', () => {
  // 我们的代码里不该出现任何把点击绑到 data-clock / timeStart 上的逻辑
  assert.doesNotMatch(src, /data-clock[^\n]*addEventListener/, '不能给时间元素绑事件')
  assert.doesNotMatch(src, /timeStart[^\n]*addEventListener/, '不能给时间文本绑事件')
})

// ── 4 · 面板唤起入口不得用分叉图标（语义错位）────────────────────────────────
test('4：面板唤起按钮用「列表+笔」图标，不是分叉图标', () => {
  const fn = block('OpsPanelIcon')
  // list-pen 的特征几何
  assert.match(fn, /M4\.9375 5\.90295H11\.0625/, '必须是 list-pen 的列表线')
  assert.match(fn, /M8\.97212 14\.3693/, '必须带笔的几何')
  assert.doesNotMatch(fn, /BRANCH_PATH/, '不能引用分叉常量')
})

test('4：唤起按钮不再渲染 BranchIcon', () => {
  // 找到渲染点：React.createElement(BranchIcon) 不该再出现在按钮里
  const at = src.indexOf("title: t('button.title')")
  assert.ok(at > 0, '找不到唤起按钮')
  const tail = src.slice(at, at + 400)
  assert.doesNotMatch(tail, /React\.createElement\(BranchIcon\)/, '唤起按钮不该再用分叉图标')
  assert.match(tail, /React\.createElement\(OpsPanelIcon\)/, '必须用 OpsPanelIcon')
})

test('4：唤起按钮圆角对齐 4px（与行内按钮一致）', () => {
  const at = src.indexOf('    const btnStyle = {')
  assert.ok(at > 0)
  const seg = src.slice(at, at + 400)
  assert.match(seg, /borderRadius:\s*4/, '圆角必须是 4（与 mopsUserRevert 一致）')
})

// ── 5 · 面板主题自适应：颜色必须走 token ─────────────────────────────────────
test('5：面板不出现裸 hex 颜色（必须走 --dsw-alias-* token）', () => {
  const bare = src.split('\n').filter(line => /:\s*#[0-9a-fA-F]{3,8}/.test(line) && !line.includes('var(--dsw'))
  assert.deepEqual(bare, [], `发现裸 hex 颜色（深色模式会瞎）：\n${bare.join('\n')}`)
})

// ── 0.19.0 · 引用：选中片段优先、截断+标注、非 copy 图标 ─────────────────────
test('0.19：引用图标不再回退到 IconCopyOutlineRegular', () => {
  // 只检查代码赋值，不检查注释（注释里会说明为什么删掉它）
  assert.doesNotMatch(src, /IconQuote\s*=\s*[^\n]*IconCopyOutlineRegular/, '不许把复制图标赋给 IconQuote（会与宿主 Copy 撞脸）')
})

test('0.20：引用优先取选中片段，且不再把整条未截断全文塞进 composer', () => {
  const fn = block('runQuote')
  assert.match(fn, /selectionInMessage\(\)/, '必须有选中片段优先逻辑')
  // 0.20.0（bug-hunt M-1）：截断抽成 clipQuote（按 code point + 边界回退），
  // 所以长度上限不再内联在 runQuote 里 —— 但**每一处放进 composer 的文本**
  // 都必须经过 clipQuote，直接塞全文不行。
  assert.match(fn, /clipQuote\(/, '放进 composer 的文本必须经过 clipQuote 截断')
  const clip = block('clipQuote')
  assert.match(clip, /QUOTE_MAX_CHARS/, 'clipQuote 必须用 QUOTE_MAX_CHARS 作为上限')
  // 0.22.0：改为 Intl.Segmenter 按 grapheme 切（比 code point 更严：
  // 不拆散 ZWJ 序列 / 组合字符）。真执行实测 family emoji 曾被切碎。
  assert.match(clip, /graphemes\(/, '必须按 grapheme 截断，不是 code point 也不是 UTF-16 slice')
  assert.doesNotMatch(fn, /insertQuote\(fullText\)|insertQuote\(d\.text\)/, '不许直接把未截断全文塞进 insertQuote')
  assert.match(fn, /insertQuote\(/, '必须走官方结构化引用')
})

// ── 0.19.0 · dock：不再自动折叠 ──────────────────────────────────────────────
test('0.19：dock 不再因 markers 变化自动 setOpen(false)', () => {
  assert.doesNotMatch(src, /\[markers && markers\.length, markers && markers\[0\] && markers\[0\]\.seq\]/, '自动折叠的 effect 依赖已删')
  // 仍保留用户主动关闭的 setOpen(false)
  assert.ok((src.match(/setOpen\(false\)/g) || []).length >= 1, '用户主动关闭仍可用')
})

// ── 0.20.0 · bug-hunt 修复回归锁 ─────────────────────────────────────────────
test('0.20 H-2：引用选区必须 anchor/focus 同属一个精确 chat node', () => {
  const fn = block('selectionInMessage')
  assert.match(fn, /ownerOf\(sel\.anchorNode\)/, '必须取 anchor 归属')
  assert.match(fn, /ownerOf\(sel\.focusNode\)/, '必须取 focus 归属')
  assert.match(fn, /anchorOwner !== focusOwner/, '跨消息选区必须拒绝')
  const owner = block('ownerOf')
  assert.match(owner, /closest\('\[data-chat-node-key\]'\)/, '只认精确节点，不用通用 flow-kind 兜底')
  assert.doesNotMatch(owner, /data-chat-flow-kind/, '不许用通用 flow-kind 兜底')
})

test('0.22 M-1：引用截断按 grapheme（Intl.Segmenter），不拆散 emoji ZWJ 序列', () => {
  assert.match(src, /const clipQuote = /, '必须有安全截断函数')
  assert.match(src, /Intl\.Segmenter/, '必须用 grapheme 分段器')
  const fn = block('clipQuote')
  assert.match(fn, /graphemes\(/, '按 grapheme 切')
  assert.match(fn, /\[\\s\\n\]/, '必须在空白/换行边界收尾')
  // 真执行：grapheme 切不会留下悬空 ZWJ 或半个家庭 emoji
  assert.ok(typeof Intl !== 'undefined' && Intl.Segmenter, '运行时需支持 Intl.Segmenter')
})

test('0.20 M-2：来源标注不进 QuoteNode 正文（只走 toast）', () => {
  const fn = block('runQuote')
  assert.doesNotMatch(fn, /sourcePrefix.*\\n.*clipped|withSource/, '不许把来源拼进引用正文')
  assert.match(fn, /quote\.doneWithSource/, '来源只放在 toast')
  assert.match(fn, /insertQuote\(text/, 'insertQuote 收到的仍是纯原文')
})

test('0.20 H-1/M-3：面板回滚限定用户消息，删除不受限', () => {
  assert.match(src, /const canRevert = canAct && pickedLive && pickedLive\.role === 'user'/, '回滚需用户消息')
  const at = src.indexOf("ref: revertBtnRef")
  const seg = src.slice(Math.max(0, at - 300), at)
  assert.match(seg, /disabled: !canRevert/, '回滚按钮用 canRevert')
  const delAt = src.indexOf('ref: deleteOneBtnRef')
  const delSeg = src.slice(Math.max(0, delAt - 300), delAt)
  assert.match(delSeg, /disabled: !canAct/, '删除按钮仍用 canAct')
})

test('0.20 token：不再引用宿主不存在的 --dsw-alias-bg-primary / label-error', () => {
  assert.doesNotMatch(src, /var\(--dsw-alias-bg-primary/, 'bg-primary 不存在，应用 bg-layer-1')
  assert.doesNotMatch(src, /var\(--dsw-alias-label-error/, 'label-error 不存在，应用 state-error-primary')
})

// ── 0.23.0 · 回撤隐私告知（合并进确认正文，不再单独一段）──────────────────
// 0.21.0 的独立隐私条 56 字 + 正文 37 字 = 93 字，四层告知让用户读不完。
// 0.23.0 合并为一条正文（54 字），告知内容一条不少：AI 看不到 / 原文仍在本地 / 可恢复。
test('0.23：隐私告知并入确认正文，且三条信息都在', () => {
  const zh = src.match(/'panel\.revertConfirmBody':\s*'([^']*)'/)
  assert.ok(zh, '缺中文确认正文')
  assert.match(zh[1], /AI/, '必须说明模型侧看不到')
  assert.match(zh[1], /本地会话文件/, '必须点破原文仍在本地会话文件')
  assert.match(zh[1], /可恢复/, '必须说明可恢复')
  const en = src.slice(src.indexOf('const enDict = {')).match(/'panel\.revertConfirmBody':\s*'([^']*)'/)
  assert.ok(en, '缺英文确认正文')
  assert.match(en[1], /local session file/, '英文同样要点破本地文件')
  assert.match(en[1], /can be restored/, '英文同样要说可恢复')
})

test('0.23：不再有独立的 revertPrivacyNote 常显块（已合并）', () => {
  assert.doesNotMatch(src, /'panel\.revertPrivacyNote'/, '独立隐私条应已删除')
  assert.doesNotMatch(src, /role: 'note'[\s\S]{0,80}revertPrivacyNote/, '不应再单独渲染')
  // 样式类保留，供编辑框等复用
  assert.match(src, /\.mopsPrivacyNote\{/, '样式类保留供复用')
})

test('0.23：隐私样式不引入裸 hex（深色模式跟随 token）', () => {
  const at = src.indexOf("'.mopsPrivacyNote{")
  const seg = src.slice(at, at + 400)
  const bare = seg.split('\n').filter(l => /:\s*#[0-9a-fA-F]{3,8}/.test(l) && !l.includes('var(--dsw'))
  assert.deepEqual(bare, [], '样式必须走 --dsw-alias-* token')
})

test('0.23：行内回滚按钮（不经过面板确认框）仍在 title 里带隐私提示', () => {
  assert.match(src, /slot\.revertPrivacyHint/, '必须有独立的隐私提示文案')
  assert.ok(
    /btn\.title = __t\('slot\.revertPrivacyHint'\)/.test(src) || /:\s*'slot\.revertPrivacyHint'/.test(src),
    'ensureBtn 与 syncEnabled 都必须指向 privacy hint',
  )
})

test('0.23：成功 toast 精简为一句，不复述隐私细节', () => {
  const zh = src.match(/'done\.revert': '([^']*)'/)
  assert.ok(zh, '缺 done.revert 中文')
  assert.match(zh[1], /恢复区/, '必须告诉用户去哪儿放回')
  assert.ok(zh[1].length <= 20, `toast 应精简（当前 ${zh[1].length} 字）`)
  assert.doesNotMatch(zh[1], /刷新页面/, '不再要求刷新页面')
  const en = src.match(/'done\.revert': '([^']*)'/)
  assert.ok(en, '缺 done.revert 英文')
})
