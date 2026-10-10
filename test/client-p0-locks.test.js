/**
 * 0.9.7 client.js 源码锁 —— 四个 P0 活 bug + 性能改动的红线。
 *
 * 为什么是「扫源码字符串」而不是跑代码：client.js 走 window.__ModuleLoader__
 * + require('@deepseek-ai/...')，107→114 条既有测试里没有一条执行它
 * （执行覆盖 = 0）。下面每条锁死一个**改得回去**的字面量。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client.js'), 'utf8')

/** 从源码里截出 `const <name> = { … }` 的对象字面量并求值（引号内跳过花括号）。 */
function grabDict(name) {
  const marker = `const ${name} = {`
  const i = src.indexOf(marker)
  assert.ok(i >= 0, `源码里找不到 ${name}`)
  const start = src.indexOf('{', i)
  let depth = 0
  let quote = null
  let esc = false
  let j = start
  for (; j < src.length; j++) {
    const c = src[j]
    if (quote) {
      if (esc) { esc = false; continue }
      if (c === '\\') { esc = true; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) { j++; break } }
  }
  assert.equal(depth, 0, `${name} 对象字面量没闭合`)
  return new Function(`return (${src.slice(start, j)})`)()
}

// ═══════════════════════════════════════════════════════════════════════════
// P0-1 · okMsg 悬挂三元 → 对话框三个操作全部失败
// ═══════════════════════════════════════════════════════════════════════════
test('P0-1：对话框成功路径必须有 const okMsg 声明', () => {
  // 只认**代码行**——注释里提到 `const okMsg =` 不算数
  const m = src.match(/^\s*const okMsg = .*$/m)
  assert.ok(m, 'ec862d6(0.9.0) 删掉声明后留下悬挂 `? :`')
  const decl = m[0]
  assert.ok(/done\.revert/.test(decl) && /done\.delete/.test(decl), 'okMsg 应在 revert/delete 里二选一')
  assert.ok(!/done\.restore/.test(decl),
    '对话框 mode 只有 revert|delete|branch（branch 在上游已 return），restore 分支不可达')
  assert.ok(/setDoneMsg\(okMsg\)/.test(src), '成功态文案没接上')
  assert.ok(/notifyDone\(okMsg\)/.test(src), 'toast 没接上')
})

test('P0-1：成功块里不再出现裸三元（失败时会把成功文案当错误抛出）', () => {
  const i = src.indexOf('if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)')
  assert.ok(i >= 0, '找不到对话框的成功判定')
  const block = src.slice(i, src.indexOf('setDoneMsg(okMsg)', i))
  assert.ok(!/^\s*\? t\(/m.test(block), '残留的悬挂 `? t(...)`')
  assert.ok(!/:\s*t\('done\.revert'/.test(block), '残留的悬挂 `: t(...)`')
})

// ═══════════════════════════════════════════════════════════════════════════
// P0-2 · /redo 仍传裸 uuid 给 afterWrite
// ═══════════════════════════════════════════════════════════════════════════
test('P0-2：afterWrite 只能收带 session- 前缀的 rawSid', () => {
  assert.ok(!/afterWrite\(sid,/.test(src), '/redo 仍传裸 uuid → openSession 抛 unknown session 被 catch 吞掉')
  const redo = src.match(/var runRedo = \(\) => \{[\s\S]*?\n    \}/)
  assert.ok(redo, '找不到 runRedo')
  assert.ok(/afterWrite\(rawSid,/.test(redo[0]), 'runRedo 必须把 rawSid 交给 afterWrite')
  assert.ok(/const sid = bareSessionId\(rawSid\)/.test(redo[0]), 'POST /restore 仍要裸 uuid')
  // afterWrite 本体的契约（与 composer-refill R4 互补）
  const aw = src.match(/var afterWrite = \([\s\S]*?\n    \}/)
  assert.ok(aw && /openSession\(rawSid\)/.test(aw[0]))
  assert.ok(!/openSession\(bare\)|openSession\(bareSessionId/.test(aw[0]))
})

// ═══════════════════════════════════════════════════════════════════════════
// P0-3 · opsPanel 渲染两次（两组同名 radio 互抢 name）
// ═══════════════════════════════════════════════════════════════════════════
test('P0-3：opsPanel 全文只出现 2 次（1 次定义 + 1 次渲染）', () => {
  // 只数**代码行**：`const opsPanel = …` 与数组里单独成行的 `opsPanel,`
  const code = src.split('\n').filter((l) => /^\s*(?:const\s+)?opsPanel\b/.test(l))
  assert.equal(code.length, 2, `opsPanel 代码行 ${code.length} 行，应为 2：\n${code.join('\n')}`)
  assert.equal(code.filter((l) => /^\s*const opsPanel = /.test(l)).length, 1, '定义只能有一处')
  assert.equal(code.filter((l) => /^\s*opsPanel,\s*$/.test(l)).length, 1,
    '渲染点只能留列表之前那一处（列表之后的旧位置是 P0）')
})

// ═══════════════════════════════════════════════════════════════════════════
// P0-4 · locale 字典不一致
// ═══════════════════════════════════════════════════════════════════════════
test('P0-4：zhDict / enDict 的 key 序列完全一致（含顺序）', () => {
  const zh = grabDict('zhDict')
  const en = grabDict('enDict')
  assert.deepEqual(Object.keys(zh), Object.keys(en))
  assert.equal(Object.keys(zh).length, Object.keys(en).length)
})

test('P0-4：undo/redo 等 10 个 key 两侧都有，且各写各的语言', () => {
  const zh = grabDict('zhDict')
  const en = grabDict('enDict')
  const must = [
    'undo.label', 'undo.desc', 'undo.done.undo', 'undo.done.redo',
    'undo.none', 'undo.none.redo', 'redo.label', 'redo.desc',
    'slot.revertUnmatched', 'dock.shadowedN',
  ]
  const cjk = /[㐀-鿿]/
  for (const k of must) {
    assert.ok(k in zh, `zhDict 缺 ${k}`)
    assert.ok(k in en, `enDict 缺 ${k}`)
    assert.ok(cjk.test(zh[k]), `zhDict['${k}'] 不是中文：${zh[k]}`)
    assert.ok(!cjk.test(en[k]), `enDict['${k}'] 是中文（英文用户会看到中文）：${en[k]}`)
  }
  for (const [k, v] of Object.entries(zh)) assert.ok(cjk.test(v), `zhDict['${k}'] 不是中文`)
  for (const [k, v] of Object.entries(en)) assert.ok(!cjk.test(v), `enDict['${k}'] 混进了中文：${v}`)
})

test('P0-4：占位符写法两侧一致（{{text}} / ${seq} 都会被 __t 留成垃圾）', () => {
  const zh = grabDict('zhDict')
  const en = grabDict('enDict')
  const names = (s) => (String(s).match(/\{[a-zA-Z]+\}/g) || []).sort()
  const junk = (s) => /\{\{|\}\}|\$\{/.test(String(s))
  for (const k of Object.keys(zh)) {
    assert.ok(!junk(zh[k]), `zhDict['${k}'] 占位符异常：${zh[k]}`)
    assert.ok(!junk(en[k]), `enDict['${k}'] 占位符异常：${en[k]}`)
    assert.deepEqual(names(zh[k]), names(en[k]), `占位符集合不一致：${k}`)
  }
})
