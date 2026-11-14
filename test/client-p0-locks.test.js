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
/** 按大括号配平抽出以 needle 起始的整块（与缩进/换行无关）。 */
function fnBlock(text, needle) {
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
  return null
}

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
      if (esc) {
        esc = false
        continue
      }
      if (c === '\\') {
        esc = true
        continue
      }
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        j++
        break
      }
    }
  }
  assert.equal(depth, 0, `${name} 对象字面量没闭合`)
  return new Function(`return (${src.slice(start, j)})`)()
}

// ═══════════════════════════════════════════════════════════════════════════
// P0-1 · okMsg 悬挂三元 → 对话框三个操作全部失败
// ═══════════════════════════════════════════════════════════════════════════
test('P0-1：OpsDialog 已删，okMsg 悬挂三元随之消失（0.24.0）', () => {
  // 0.24.0：整段 OpsDialog（约 407 行）已删除 —— 它只能通过
  // window.__MOPS_LEGACY_DIALOG === true 到达，而全仓库无人设该标志。
  // 原先这里锁「okMsg 必须声明」是在保护一个死函数里的活 bug；
  // 现在改成锁「死函数不存在」，bug 自然消失。
  assert.doesNotMatch(src, /function OpsDialog\b/, 'OpsDialog 已删')
  assert.doesNotMatch(src, /__MOPS_LEGACY_DIALOG/, 'LEGACY 分支已删')
  assert.doesNotMatch(src, /const okMsg = /, 'okMsg 是 OpsDialog 专属，应随它一起消失')
  assert.doesNotMatch(src, /setDoneMsg\(/, 'setDoneMsg 是 OpsDialog 专属')
})

test('P0-1：OpsPanel 是唯一 overlay 面板实现', () => {
  const apply = src.slice(src.indexOf('function apply(ctx)'))
  assert.match(apply, /OpsPanel/, 'overlay 槽必须注册 OpsPanel')
  // 0.24.0：OpsDialog 已整体删除。断言要排除注释 —— 说明性注释里提到
  // 「旧的 OpsDialog 已删除」是合法的，不能算引用。
  const applyCode = apply
    .split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
  assert.doesNotMatch(applyCode, /OpsDialog/, '代码里不得再引用 OpsDialog（注释除外）')
  assert.doesNotMatch(src, /function OpsDialog/, 'OpsDialog 函数体已删')
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
test('P0-3：opsPanel 变量已随 OpsDialog 删除（0.24.0）', () => {
  // 原锁是「opsPanel 只出现 2 次」，防同名 radio 互抢 —— 那是 OpsDialog 内部变量。
  // OpsDialog 删除后该变量不该再存在；OpsPanel 用的是完全不同的渲染结构。
  const code = src.split('\n').filter(l => /^\s*(?:const\s+)?opsPanel\b/.test(l))
  assert.deepEqual(code, [], `opsPanel 应随 OpsDialog 消失，仍残留：\n${code.join('\n')}`)
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
    'undo.label',
    'undo.desc',
    'undo.done.undo',
    'undo.done.redo',
    'undo.none',
    'undo.none.redo',
    'redo.label',
    'redo.desc',
    'slot.revertUnmatched',
    'dock.shadowedN',
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
  const names = s => (String(s).match(/\{[a-zA-Z]+\}/g) || []).sort()
  const junk = s => /\{\{|\}\}|\$\{/.test(String(s))
  for (const k of Object.keys(zh)) {
    assert.ok(!junk(zh[k]), `zhDict['${k}'] 占位符异常：${zh[k]}`)
    assert.ok(!junk(en[k]), `enDict['${k}'] 占位符异常：${en[k]}`)
    assert.deepEqual(names(zh[k]), names(en[k]), `占位符集合不一致：${k}`)
  }
})
