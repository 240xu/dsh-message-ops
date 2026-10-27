import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const cssLine = (name) => {
  const marker = `'.${name}{`
  const at = src.indexOf(marker)
  assert.ok(at >= 0, `找不到 .${name} 样式`)
  const end = src.indexOf("'", at + marker.length)
  assert.ok(end > at, `.${name} 样式未闭合`)
  return src.slice(at + marker.length, end)
}

test('面板是屏幕中央悬浮，不是右侧抽屉', () => {
  const scrim = cssLine('mopsPanelScrim')
  assert.match(scrim, /align-items:center/, '垂直居中')
  assert.match(scrim, /justify-content:center/, '水平居中')
  assert.doesNotMatch(scrim, /flex-end/, '不得再用右侧贴边布局')
  assert.match(scrim, /position:fixed/, '仍应是覆盖层')
})

test('面板本体不再满高贴边', () => {
  const panel = cssLine('mopsPanel')
  assert.doesNotMatch(panel, /(^|;)height:100%/, '不应再有独立的 height:100% 拉满整屏（max-height 不算）')
  assert.match(panel, /height:min\(760px,100%\)/, '应限制最大高度')
  assert.match(panel, /max-width:min\(560px,100%\)/, '应限制最大宽度')
  assert.doesNotMatch(panel, /border-left:1px/, '不再是抽屉，左侧描边应去掉')
  assert.match(panel, /box-shadow/, '悬浮需要有投影')
})

test('小屏回落为全屏（否则 560px 会溢出）', () => {
  const media = src.match(/@media\(max-width:760px\)\{([^']*)\}/)
  assert.ok(media, '缺少小屏媒体查询')
  assert.match(media[1], /\.mopsPanelScrim\{padding:0\}/, '小屏去掉外边距')
  assert.match(media[1], /\.mopsPanel\{width:100%;height:100%/, '小屏占满')
})

test('尊重 prefers-reduced-motion', () => {
  assert.match(src, /prefers-reduced-motion:reduce\)\{\.mopsPanelScrim,\.mopsPanel\{animation:none\}\}/)
})

test('关闭按钮是右上角叉叉且可键盘操作', () => {
  const m = src.match(/createElement\('button', \{[\s\S]{0,260}?className: 'mopsPanelClose'[\s\S]{0,220}?\}, '×'\)/)
  assert.ok(m, '找不到关闭按钮')
  assert.match(m[0], /type: 'button'/, '必须是 button 才能被键盘触发')
  assert.match(m[0], /aria-label/, '需要无障碍名称')
  assert.match(m[0], /onClick: close/, '点击要真的关闭')
})

test('居中模态必须锁背景滚动，且关闭后精确还原', () => {
  const src = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  assert.match(src, /body\.style\.overflow = 'hidden'/, '缺滚动锁 → 滚轮会把背后列表滚走')
  assert.match(src, /body\.style\.overflow = prevOverflow/, '关闭时必须还原原始 overflow，不能一律设成空串')
  assert.match(src, /body\.style\.paddingRight = prevPaddingRight/, '内边距也要还原')
  assert.match(src, /scrollbarW = window\.innerWidth - document\.documentElement\.clientWidth/,
    '应补回滚动条宽度，否则关闭时整页横向跳动')
})

test('滚动锁不得用 position:fixed（会丢滚动位置）', () => {
  const src = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  const at = src.indexOf('居中模态必须锁背景滚动')
  const seg = src.slice(at, at + 900)
  assert.doesNotMatch(seg, /position\s*=\s*['"]fixed['"]/, '锁滚动不该改 body 定位')
  assert.doesNotMatch(seg, /scrollTop\s*=/, '不该靠重置滚动位置来"复原"')
})

test('背景隔离三件套齐全：inert + aria-hidden + 焦点回归', () => {
  const src = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  // 锚到"背景隔离"那个 effect 的起点（含 inert/aria/焦点回归的那段）
  const at = src.indexOf("if (!open) return undefined")
  const seg = src.slice(at, at + 5200)
  assert.match(seg, /setAttribute\('inert', ''\)/, '背景节点必须 inert（不可聚焦/点击）')
  assert.match(seg, /setAttribute\('aria-hidden', 'true'\)/, '背景需对读屏隐藏')
  assert.match(seg, /trigger\.focus\(\)/, '关闭后焦点应回到触发元素')
})

test('背景隔离必须能覆盖"scrim 独占容器"的真实槽位结构', () => {
  const src = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  const at = src.indexOf('0.11.8：槽位会把 scrim 挂进')
  assert.ok(at > 0, '找不到 0.11.8 的隔离逻辑')
  const seg = src.slice(at, at + 1800)
  assert.match(seg, /document\.body\.children/, '必须从 body 直接子节点出发遍历，而非只遍历 scrim.parentElement')
  assert.match(seg, /const chain = new Set\(\)/, '要计算 scrim 的祖先链')
  assert.match(seg, /chain\.has\(child\)\) continue/, '祖先链本身不能 inert（否则面板一起废掉）')
  assert.match(seg, /for \(const el of chain\)/, '中间每层的兄弟节点也要隔离')
  // 反例：不能再只靠 parent.children
  assert.doesNotMatch(seg, /for \(const child of Array\.from\(parent\.children\)\)\s*\{\s*if \(child === scrim/,
    '旧的「只看 parent.children」写法对独立槽位容器无效')
})

test('隔离是可逆的：每处都记录原值再还原', () => {
  const src = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  const at = src.indexOf('0.11.8：槽位会把 scrim 挂进')
  const seg = src.slice(at, at + 1800)
  const pushes = (seg.match(/hidden\.push\(\{ child\b/g) || []).length
  assert.equal(pushes, 2, `两处隔离都要先记录原值，实测 ${pushes} 处`)
  assert.match(seg, /inert: child\.hasAttribute\('inert'\)/)
  assert.match(seg, /aria: child\.getAttribute\('aria-hidden'\)/)
  assert.match(seg, /inert: sib\.hasAttribute\('inert'\)/, '兄弟节点那处也要记录原 inert')
  assert.match(seg, /aria: sib\.getAttribute\('aria-hidden'\)/, '兄弟节点那处也要记录原 aria-hidden')
  assert.match(seg, /hidden\.push\(\{ child: sib,/, '第二处 push 用 child: sib 形式')
})
