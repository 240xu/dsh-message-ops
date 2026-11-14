/**
 * 0.13.1 回归锁：第二轮对抗审查抓出的问题。
 *
 * 每一条都对应一个**真 bug**，并且都是「测试全绿但功能没生效」那一类：
 *   - 图标识别用了宿主根本不存在的 DOM 形态（功能 100% 静默失效）
 *   - persistDraft 空转时仍报成功
 *   - 截断的 snippet 冒充原文进编辑器
 *   - 未定义的 i18n key 泄漏成字面量
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const flat = src.replace(/\s+/g, ' ')

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

test('0.23：不再有「识别并抑制官方 branch 图标」的逻辑', () => {
  assert.doesNotMatch(flat, /isHostBranchButton/, '识别函数已删')
  assert.doesNotMatch(flat, /suppressHostBranch/, '抑制调用已删')
})

test('0.23：HOST_BRANCH 常量已随「抑制官方分支」一起删除', () => {
  assert.doesNotMatch(flat, /HOST_BRANCH_ICON_ID/, '不再需要识别并隐藏官方按钮')
})

test('MED-4：面板 startEdit 已删（编辑走行内铅笔 + 编辑框，不是面板）', () => {
  assert.doesNotMatch(src, /const startEdit\b/, '面板 startEdit 已删')
})

test('MED-4（0.20）：编辑框写入后必须回读校验，写不进就要让用户知道', () => {
  const send = block('sendEditAndRevert')
  assert.match(send, /readSessionDraft|doRead\(/, '写草稿后必须回读校验（persistDraft 存在 ≠ 真的落盘）')
  assert.match(send, /persisted/, '必须把落盘结果带出（组件据此提示）')
})

test('MED-4：readSessionDraft 与 writeSessionDraft 用同一个存储键', () => {
  const read = block('readSessionDraft')
  const write = block('writeSessionDraft')
  assert.ok(read.includes('FORK_SESSION_STORAGE_PREFIX'), '读必须用同一前缀常量')
  assert.ok(write.includes('FORK_SESSION_STORAGE_PREFIX'), '写必须用同一前缀常量')
})

// MED-5 原锁针对面板 startEdit 的「snippet 冒充原文」。0.20.0 的编辑框同样必须
// 走 /text 取全文（否则会拿列表里 160 字的 snippet 去编辑，用户的原文被截断）。
test('MED-5：/text 全文接口是编辑框/引用/分叉的唯一全文来源', () => {
  const overlay = block('EditResendOverlay')
  assert.match(overlay, /\/api\/message-ops\/text\?/, '编辑框必须走 /text 取全文')
  assert.doesNotMatch(overlay, /\.snippet/, '编辑框不许用 snippet 兜底')
  assert.doesNotMatch(src, /startEdit\(detail \|\| pickedLive\.snippet/, '不许把 snippet 当兜底原文')
  assert.doesNotMatch(src, /detailFull/, 'detailFull 状态已随面板 startEdit 一起删除')
})

test('LOW-6：不许引用未定义的 i18n key', () => {
  // 只取 zhDict 一端的 key 集合：enDict 必须与它一致（已有测试锁），
  // 所以「代码里用的 key 必须在这里」是充分检查。
  const zhStart = src.indexOf('const zhDict = {')
  const zhBlock = src.slice(zhStart, src.indexOf('\n    }', zhStart))
  // key 有两种写法：'quoted.key': 与 identifier:（如 errorPrefix）
  const defined = new Set([
    ...[...zhBlock.matchAll(/'([a-zA-Z][\w.]*)':/g)].map(m => m[1]),
    ...[...zhBlock.matchAll(/(?:^|[{,])\s*([a-zA-Z_]\w*):/g)].map(m => m[1]),
  ])
  const used = [...src.matchAll(/__t\('([a-zA-Z][\w.]*)'/g)].map(m => m[1])
  const missing = [...new Set(used.filter(k => !defined.has(k)))]
  assert.deepEqual(missing, [], `代码引用了未定义的 i18n key：${missing.join(', ')}`)
})

test('LOW-7：op.branchDesc 随 OpsDialog 删除（0.24.0）', () => {
  // 原锁校验 OpsDialog 里那段 radio 文案的 before 语义。OpsDialog 已删，
  // 该 key 只被死代码使用，一并删除。分叉的 before 语义现在由
  // panel.branchHint / slot.forkHint 承载（它们有各自的锁）。
  assert.doesNotMatch(src, /'op\.branchDesc'/, 'op.branchDesc 应随 OpsDialog 删除')
  assert.match(src, /'panel\.branchHint'/, '分叉 before 语义仍由 panel.branchHint 承载')
  assert.match(src, /'slot\.forkHint'/, '分叉 before 语义仍由 slot.forkHint 承载')
})
