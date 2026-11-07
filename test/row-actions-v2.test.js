/**
 * 0.18.0 回归锁：行内操作三项修复。
 *
 * 用户反馈（原话）：
 *   1.「编辑重发的按钮可以和回撤放在同一个地方，就是用一个笔的那个图标」
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
    if (src[i] === '{') { depth++; started = true }
    else if (src[i] === '}') {
      depth--
      if (started && depth === 0) return src.slice(at, i + 1)
    }
  }
  throw new Error(`块未闭合：${name}`)
}

// ── 1 · 0.19.0：行内编辑按钮已移除（编辑交给已装插件）────────────────────
test('1：本插件不再注入行内编辑按钮（mopsUserEdit）', () => {
  assert.doesNotMatch(src, /mopsUserEdit/, '0.19.0 起不再有铅笔按钮')
  assert.doesNotMatch(src, /ensureEditBtn/, 'ensureEditBtn 已删')
  assert.doesNotMatch(src, /runUserEdit/, 'runUserEdit 已删')
})

test('1：动作行只剩 回撤 + 分叉（顺序不变）', () => {
  const fn = block('ensureUserActions')
  assert.match(fn, /ensureBtn\(/, '保留回撤')
  assert.match(fn, /ensureForkBtn\(/, '保留分叉')
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
  assert.doesNotMatch(
    src,
    /IconQuote\s*=\s*[^\n]*IconCopyOutlineRegular/,
    '不许把复制图标赋给 IconQuote（会与宿主 Copy 撞脸）',
  )
})

test('0.19：引用优先取选中片段，且不再把整条未截断全文塞进 composer', () => {
  const fn = block('runQuote')
  assert.match(fn, /selectionInMessage\(\)/, '必须有选中片段优先逻辑')
  assert.match(fn, /QUOTE_MAX_CHARS/, '必须有长度上限')
  assert.match(fn, /quote\.sourcePrefix/, '无选中时必须标注来源（走 i18n）')
  assert.match(fn, /insertQuote\(/, '必须走官方结构化引用')
})

// ── 0.19.0 · dock：不再自动折叠 ──────────────────────────────────────────────
test('0.19：dock 不再因 markers 变化自动 setOpen(false)', () => {
  assert.doesNotMatch(
    src,
    /\[markers && markers\.length, markers && markers\[0\] && markers\[0\]\.seq\]/,
    '自动折叠的 effect 依赖已删',
  )
  // 仍保留用户主动关闭的 setOpen(false)
  assert.ok((src.match(/setOpen\(false\)/g) || []).length >= 1, '用户主动关闭仍可用')
})
