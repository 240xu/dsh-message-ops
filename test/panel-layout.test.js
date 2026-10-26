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
