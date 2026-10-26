import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

/** 截出 BranchIcon 组件体 */
function branchIconBody() {
  const start = src.indexOf('function BranchIcon()')
  assert.ok(start > 0, '找不到 BranchIcon')
  const end = src.indexOf('\n    }', start)
  return src.slice(start, end)
}

test('BranchIcon 必须用 stroke 渲染（path 是描边几何，fill 会丢连接线）', () => {
  const body = branchIconBody()
  assert.match(body, /stroke:\s*'currentColor'/, '缺 stroke → 零宽线段不可见')
  assert.match(body, /fill:\s*'none'/, 'fill 必须为 none，否则实心圆会糊成色块')
  assert.match(body, /strokeLinecap:\s*'round'/, '端帽缺失会让线头是方角')
  assert.match(body, /strokeLinejoin:\s*'round'/, '拐角缺失会让分叉处出现尖角')
})

test('BranchIcon 不得再用单纯 fill:currentColor 的旧写法', () => {
  const body = branchIconBody()
  assert.doesNotMatch(body, /fill:\s*'currentColor'/, '描边几何用 fill 渲染 = 只剩孤立色块')
})

test('所有含零宽线段的 svg 图标都必须声明 stroke', () => {
  const svgs = [...src.matchAll(/createElement\('svg'[\s\S]{0,700}?\)\)/g)].map((m) => m[0])
  for (const svg of svgs) {
    if (!/\sd="[^"]*[vhVH][-\d.]/.test(svg)) continue
    assert.ok(svg.includes("stroke"), '含零宽线段的图标必须用 stroke 渲染')
  }
})
