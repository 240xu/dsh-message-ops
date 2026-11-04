/**
 * 源码形状断言的**格式无关**工具。
 *
 * 背景：本仓库 0.13.0 起代码风格对齐 dsh 官方（无分号、单引号、prettier 重排）。
 * 之前有一批「回归锁」直接对 client.js 的**原始文本**做正则匹配，并且用
 * `'\n    }'` 这种**固定缩进**找函数结尾 —— 一旦格式化就全线崩，
 * 结果变成「谁也不敢改格式」。这是测试的缺陷，不是格式的缺陷。
 *
 * 这里提供两个原语：
 *   - `flat(text)`：把连续空白（含换行）压成单个空格 → 用于"某段代码里出现过 X"类断言。
 *   - `blockAt(text, needle)`：从 needle 起按**大括号配平**切出整块 →
 *     用于"取出这个函数体再断言"类检查，与缩进无关。
 */
import { readFileSync } from 'node:fs'

/** 读源码。 */
export function readSource(relative = '../src/client.js') {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

/** 空白归一化（含换行）：`a\n  b` → `a b`。 */
export function flat(text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

/**
 * 从首次出现 `needle` 的位置起，按大括号配平切出完整代码块。
 * @param text - 源码
 * @param needle - 起始标记（函数名、变量名或任意片段）
 * @returns 从 needle 起到配平 `}` 为止的片段
 */
export function blockAt(text, needle) {
  const at = text.indexOf(needle)
  if (at < 0) return null
  let depth = 0
  let started = false
  for (let i = at; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') {
      depth++
      started = true
    } else if (ch === '}') {
      depth--
      if (started && depth === 0) return text.slice(at, i + 1)
    }
  }
  return text.slice(at)
}

/** 断言辅助：块必须存在，返回归一化后的块（供后续 match）或原始块。 */
export function blockOrThrow(text, needle, label) {
  const block = blockAt(text, needle)
  if (block == null) throw new Error(`找不到 ${label || needle}`)
  return block
}
