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

test('MED-4：persistDraft 之后必须回读校验，不能凭「函数存在」就报成功', () => {
  const body = block('startEdit')
  assert.match(body, /readSessionDraft\(/, '必须回读草稿验证真的落盘了')
  assert.match(body, /editUnavailable/, '回读不一致时必须报错，而不是静默 close')
  assert.match(body, /panel\.editDone/, '只有校验通过才显示成功')
})

test('MED-4：readSessionDraft 与 writeSessionDraft 用同一个存储键', () => {
  const read = block('readSessionDraft')
  const write = block('writeSessionDraft')
  assert.ok(read.includes('FORK_SESSION_STORAGE_PREFIX'), '读必须用同一前缀常量')
  assert.ok(write.includes('FORK_SESSION_STORAGE_PREFIX'), '写必须用同一前缀常量')
})

test('MED-5：编辑只允许用**全文**，截断的 snippet 不能冒充原文', () => {
  assert.match(src, /detailFull/, '必须有显式的「是否全文」状态')
  const gate = src.match(/const editTextReady = [^\n]+/)
  assert.ok(gate, '缺 editTextReady 派生')
  assert.match(gate[0], /detailFull === true/, '编辑门槛必须依赖 detailFull，不能只看 detailState')
  assert.doesNotMatch(src, /startEdit\(detail \|\| pickedLive\.snippet/, '不许再把 snippet 当兜底原文')
})

test('MED-5：/text 失败时必须把 detailFull 置回 false', () => {
  const at = src.indexOf("fetch('/api/message-ops/text?")
  assert.ok(at > 0, '找不到 /text 拉取')
  const tail = src.slice(at, at + 1400)
  assert.match(tail, /setDetailFull\(false\)/, '失败分支必须显式降级')
  assert.match(tail, /setDetailFull\(full !== null\)/, '成功分支必须按真实全文置位')
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
