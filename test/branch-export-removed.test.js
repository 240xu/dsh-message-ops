/**
 * 0.9.0 结构性回归：与 dsh 官方重复的能力必须**不存在**于本插件。
 *
 * 背景（专家核查结论）：
 *  - 分支：官方有完整 `session/fork`（RPC typert.host.js:1512，atSeq 任意）
 *    + SessionStore.fork() + UI 消息级按钮 + 埋点 branch_session_click。
 *    本插件的磁盘分支实现语义是**错的**：branch.js 删掉了 isSeeded（官方设 true）、
 *    不写 inheritedEventCount、不调 buildForkSeed 补 closers → 子会话 turn 边界可能悬空。
 *    官方 fork 失败通常意味着源会话在运行，正确做法是拒绝而非绕过引擎。
 *  - 导出：官方 /api/session.export 已有；但用户决定**直接删掉我们的 Markdown 导出**，
 *    导出一律用官方（尽管两者格式不重叠：官方 ZIP 归档 vs 我们 Markdown）。
 *
 * 本测试锁死这两个能力不复活，并验证 branch 只走官方。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

test('src/branch.js 已删除（磁盘分支不再存在）', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'src/branch.js')), false, 'src/branch.js 仍在 —— 磁盘分支实现未清除')
})

test('src/index.js 不再 import applyBranch', () => {
  const s = read('src/index.js')
  assert.ok(!/import\s*\{[^}]*applyBranch/.test(s), 'index.js 仍 import applyBranch')
  assert.ok(!s.includes('applyBranch('), 'index.js 仍有 applyBranch( 调用')
})

test('后端不再有 /api/message-ops/branch 路由', () => {
  const s = read('src/index.js')
  assert.ok(!s.includes('/api/message-ops/branch'), 'branch 路由仍在')
})

test('后端不再有 /api/message-ops/export 路由', () => {
  const s = read('src/index.js')
  assert.ok(!s.includes('/api/message-ops/export'), 'export 路由仍在')
})

test('客户端不再有磁盘分支回落（只走官方 sessions.fork）', () => {
  const s = read('src/client.js')
  assert.ok(!s.includes('diskBranch'), 'client.js 仍有 diskBranch 回落')
  assert.ok(!s.includes('/api/message-ops/branch'), 'client.js 仍调磁盘分支端点')
  assert.ok(s.includes('fork'), 'client.js 应保留官方 fork 调用')
})

test('客户端不再有 fork.disk 文案', () => {
  const s = read('src/client.js')
  assert.ok(!s.includes('fork.disk'), 'fork.disk locale 仍在')
})

test('ops-core 不再导出 exportMarkdown', async () => {
  const mod = await import('../src/ops-core.js')
  assert.equal(mod.exportMarkdown, undefined, 'exportMarkdown 仍被导出')
})

test('message_ops tool 的 enum 不含 export', () => {
  const s = read('src/index.js')
  const m = s.match(/enum:\s*\[([^\]]+)\]/g) ?? [];
  const enums = m.map((x) => x).join(' ');
  assert.ok(!/["']export["']/.test(enums), `tool enum 仍含 export: ${enums}`)
})

test('message_ops tool 仍保留核心三操作（revert/delete/restore）', () => {
  const s = read('src/index.js')
  for (const op of ['revert', 'delete', 'restore']) {
    assert.ok(s.includes(`"${op}"`), `tool enum 缺少 ${op}`)
  }
})
