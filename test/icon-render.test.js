import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

function block(startMarker, endMarker = '\n    }') {
  const start = src.indexOf(startMarker)
  assert.ok(start >= 0, `找不到 ${startMarker}`)
  return src.slice(start, src.indexOf(endMarker, start))
}

test('分支图标不得在任何 innerHTML 里手写（必须走 branchIconMarkup）', () => {
  // 其它图标（如重试）自带 stroke，不在本规则范围内；这里只钉分支图标的唯一来源。
  const sites = [...src.matchAll(/innerHTML\s*=\s*([\s\S]{0,120})/g)]
  const branchHandWritten = sites.filter(
    m => !m[1].startsWith('branchIconMarkup') && m[1].includes('M5 2.5a2 2 0 1 1-.9 3.78'))
  assert.equal(branchHandWritten.length, 0,
    `分支 path 被手写进 innerHTML ${branchHandWritten.length} 次，应改用 branchIconMarkup`)
  assert.match(src, /item\.innerHTML = branchIconMarkup\(16\)/, '侧栏菜单项必须用工厂')
})

test('其它图标若含零宽线段，必须带 stroke（回归防线）', () => {
  for (const m of src.matchAll(/innerHTML\s*=\s*'([^']*<svg[^']*)'/g)) {
    const html = m[1]
    if (!/[vhVH][-\d.]/.test(html)) continue
    assert.ok(html.includes('stroke'), '含零宽线段的 innerHTML 图标缺 stroke：' + html.slice(0, 60))
  }
})

test('branchIconMarkup 生成的标记必须带 stroke 且 fill:none', () => {
  const body = block('function branchIconMarkup')
  assert.match(body, /stroke="currentColor"/, '缺 stroke → 连接线不可见')
  assert.match(body, /fill="none"/, 'fill 必须 none')
  assert.match(body, /stroke-linecap="round"/)
  assert.match(body, /stroke-linejoin="round"/)
  assert.doesNotMatch(body, /fill="currentColor"/, '描边几何不能用 fill 上色')
})

test('BranchIcon 组件与 branchIconMarkup 共用 BRANCH_PATH（禁止分叉常量）', () => {
  assert.match(src, /const BRANCH_PATH\s*=\s*'M5 2\.5/, 'BRANCH_PATH 必须存在且为原始 path')
  assert.doesNotMatch(src, /BRANCH_PATHS/, '旧的分叉常量 BRANCH_PATHS 必须彻底移除')
  const comp = block('function BranchIcon()')
  assert.match(comp, /d: BRANCH_PATH/, 'React 组件也要引用同一常量')
  const markup = block('function branchIconMarkup')
  assert.ok(markup.includes('BRANCH_PATH'), 'markup 生成器也要引用同一常量')
})

test('不得留下 d="undefined" 的隐患：所有拼接 path 的变量都必须已定义', () => {
  // 抓出所有 `" + VAR + "` 形式注入到 path d 属性的变量名
  const injected = [...src.matchAll(/<path d="' \+ (\w+) \+ '"/g)].map(m => m[1])
  for (const name of new Set(injected)) {
    assert.ok(new RegExp(`const ${name}\\s*=`).test(src), `注入的 ${name} 未定义 → d="undefined"`)
  }
  // 旧回归形态：直接用已改名的 BRANCH_PATHS[0] 拼进 innerHTML
  assert.doesNotMatch(src, /BRANCH_PATHS\[0\]/, '禁止再引用旧名')
})

test('图标不得使用零宽线段却只填色（几何契约）', () => {
  const ICON = 'M5 2.5a2 2 0 1 1-.9 3.78v3.44'
  assert.ok(src.includes(ICON), 'path 数据应存在')
  // 该 path 含 v/V 零宽线段 → 必须有 stroke 声明（markup 与组件各一处）
  const strokeCount = (src.match(/stroke(-width)?[=:]\s*['"]?currentColor|strokeWidth: BRANCH_STROKE|stroke="currentColor"/g) || []).length
  assert.ok(strokeCount >= 2, `stroke 声明只有 ${strokeCount} 处，两处图标入口都要有`)
})
