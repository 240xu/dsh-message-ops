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
    if (src[i] === '{') { depth++; started = true }
    else if (src[i] === '}') {
      depth--
      if (started && depth === 0) return src.slice(at, i + 1)
    }
  }
  throw new Error(`块未闭合：${name}`)
}

test('HIGH-1：图标识别主判据是 sprite 的 data-icon，而不是 <path d>', () => {
  const body = block('isHostBranchButton')
  assert.match(body, /data-icon/, '主判据必须是 sprite 的 data-icon（0.2.2-alpha.2 的 DOM 里没有 <path>）')
  assert.match(body, /dsw-icon-branch-outline-regular/, '必须是官方图标 id')
  // 顺序：sprite 判定必须在前，path 只是兼容回退
  const spriteAt = body.indexOf('data-icon')
  const pathAt = body.indexOf('svg path')
  assert.ok(pathAt === -1 || spriteAt < pathAt, 'sprite 判定必须优先于 path 回退')
})

test('HIGH-1：HOST_BRANCH_ICON_ID 与官方图标工厂的拼法一致', () => {
  // 宿主：function Qv(e,t){return `dsw-icon-${e}-${t}`}
  //       IconBranchOutlineRegular = T("branch-outline","regular")
  assert.ok(
    flat.includes("HOST_BRANCH_ICON_ID = 'dsw-icon-branch-outline-regular'"),
    'id 必须是 dsw-icon-branch-outline-regular',
  )
})

// 0.19.0：MED-4 原锁针对已删的 startEdit。回读校验能力保留在
// writeSessionDraft/readSessionDraft 上，由 MED-4 第二条锁住同键。
test('0.19：startEdit 已删，回读校验不再挂在编辑入口上', () => {
  assert.doesNotMatch(src, /const startEdit\b/, 'startEdit 已删')
})

test('MED-4：readSessionDraft 与 writeSessionDraft 用同一个存储键', () => {
  const read = block('readSessionDraft')
  const write = block('writeSessionDraft')
  assert.ok(read.includes('FORK_SESSION_STORAGE_PREFIX'), '读必须用同一前缀常量')
  assert.ok(write.includes('FORK_SESSION_STORAGE_PREFIX'), '写必须用同一前缀常量')
})

// 0.19.0：MED-5 的两条原锁针对已删除的 startEdit/detailFull（编辑交给
// message-edit 插件）。替换为仍然成立的契约：/text 接口仍是引用与分叉的全文来源，
// 且不得拿 160 字 snippet 冒充全文。
test('0.19：/text 全文接口仍被引用/分叉使用，且不许用 snippet 冒充全文', () => {
  assert.match(src, /\/api\/message-ops\/text\?/, '全文接口仍在')
  assert.doesNotMatch(src, /startEdit\(detail \|\| pickedLive\.snippet/, '不许把 snippet 当兜底原文')
  assert.doesNotMatch(src, /detailFull/, 'detailFull 状态已随 startEdit 一起删除')
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

test('LOW-7：对话框的分叉文案必须是 before 语义（与其它入口一致）', () => {
  const opBranch = src.match(/'op\.branchDesc': '([^']*)'/)
  assert.ok(opBranch, '缺 op.branchDesc')
  assert.doesNotMatch(opBranch[1], /含/, '中文文案不能再说「含该条」')
  assert.match(opBranch[1], /放回新会话输入框|之前的对话/, '必须说明 before 语义 + 原文回输入框')
  const en = src.match(/'op\.branchDesc': '([^']*)'[\s\S]*?'op\.branchDesc': '([^']*)'/)
  if (en) assert.doesNotMatch(en[2], /including/i, '英文文案不能再说 "including"')
})
