/**
 * 0.26.0 · 第二轮审计（`design-demos/deadcode-lvl2.md`）落地项的**回归锁**。
 *
 * 本文件只锁「修完不许复发」的行为，不重复 `dead-code-cleanup.test.js`（第一轮）
 * 与各专项文件的职责。全部**真执行**优先；必须用源码形态的，一律按**代码形态**
 * （剥注释后）判定，且**锁消费点**而不是锁字面量 —— 后者在「抽常量」之后会
 * 假绿（常量定义行还在文件里，`assert.match(src, /xzv4MW_actions/)` 照样通过）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readSource, blockAt, flat } from './_source.js'

const client = readSource('../src/client.js')
const readIndex = () => readSource('../src/index.js')
/** 剥掉注释后的代码（形态断言一律用它）。 */
const code = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// ═══════════════════════════════════════════════════════════════════════════
// §1.6 + §2.2 · `__resolveSource` 纯写不读 → 改成「原因随 diag 进错误消息」
// ═══════════════════════════════════════════════════════════════════════════
test('§1.6 `__resolveSource` 已彻底删除（声明与赋值都不许复活）', () => {
  const c = code(readIndex())
  assert.doesNotMatch(c, /__resolveSource\s*=/s === undefined ? /x^/ : /\b__resolveSource\s*=/, '只许出现在历史注释里，不许有赋值')
  assert.doesNotMatch(c, /\blet\s+__resolveSource/, '声明也必须删掉')
})

test('§1.6+§2.2 失败原因真的进错误消息（真执行 withResolveDiag 的等价语义）', () => {
  // withResolveDiag 依赖 OpsError 构造，直接真执行它（不 mock）。
  // 这里用与 index.js 同款语义的自证：diag.why 必须出现在 message 里，且 status 不变。
  const idx = readIndex()
  const fn = blockAt(idx, 'function withResolveDiag(')
  assert.ok(fn, '找不到 withResolveDiag —— 必须硬失败，不许静默跳过')
  // 真执行：把函数体 + 一个最小 OpsError 注入 new Function
  // ⚠️ withResolveDiag 用 `err instanceof OpsError` 判类型，所以必须注入**同一个**
  // 构造器（否则永远走 early-return，测试会假绿成「原因没拼进去」）。
  class FakeOpsError extends Error {
    constructor(message, status = 400) {
      super(message)
      this.status = status
    }
  }
  const run = new Function('OpsError', fn + '; return withResolveDiag')(FakeOpsError)
  const err = new FakeOpsError('session not visible', 409)
  const out = run(err, { why: 'no-sessions-service' })
  assert.match(out.message, /no-sessions-service/, 'diag 原因必须真的拼进 message（否则排障线索又进黑洞）')
  assert.equal(out.status, 409, '拼诊断不得改 status（路由层按 err.status 映射 HTTP）')
  // 幂等：同一条原因不拼两遍
  const twice = run(out, { why: 'no-sessions-service' })
  assert.equal(twice.message, out.message, 'catch 里重抛不得把原因拼两遍')
  // 无 diag 时零改动
  assert.equal(run(err, null), err, '没传 diag 时原样返回（成功路径零字符串开销）')
})

// ═══════════════════════════════════════════════════════════════════════════
// §2.4 + §3.4 · readOpsJson / errText 两个单点
// ═══════════════════════════════════════════════════════════════════════════
test('§2.4 `readOpsJson` 单点存在，且写操作 500 不再只报 HTTP xxx', async () => {
  const src = client
  const decl = blockAt(src, 'var readOpsJson = ')
  assert.ok(decl, '找不到 readOpsJson（读响应体 + 校验必须单点）')
  // 真执行：抽出来真的跑一次（它不依赖闭包，只有 res 入参）
  const impl = new Function(decl + '; return readOpsJson')()
  assert.deepEqual(await impl({ ok: true, status: 200, json: async () => ({ ok: true, x: 1 }) }), {
    ok: true,
    status: 200,
    data: { ok: true, x: 1 },
  })
  const bad = await impl({ ok: false, status: 500, json: async () => ({ ok: false, error: 'boom' }) })
  assert.equal(bad.ok, false, 'HTTP 500 必须判失败')
  assert.equal(bad.data.error, 'boom', '必须把服务端 error 文案留在 data 里（下游 opsError 才能报出真因）')
  // §2.4 的收益：错误文案必须经 opsError 单点，而不是各写一套 `HTTP ' + status`
  const errFn = blockAt(src, 'var opsError = ')
  assert.ok(errFn, '找不到 opsError 单点（错误文案唯一出口）')
  assert.match(errFn, /data\.error/, 'opsError 必须优先用服务端文案')
  const rawHttp = (code(src).match(/new Error\('HTTP ' \+ res\.status\)/g) || []).length
  assert.equal(rawHttp, 0, `还有 ${rawHttp} 处直接拼 'HTTP ' + res.status（应改用 opsError/readOpsJson）`)
})

test('§3.4 `errText` 单点存在，且被面板错误路径消费', () => {
  const src = client
  const decl = blockAt(src, 'var errText = ')
  assert.ok(decl, '找不到 errText（错误文案转换必须单点）')
  assert.match(decl, /reason\.message|String\(reason\)/, '必须同时容纳 Error 与字符串')
  const uses = (src.match(/\berrText\(/g) || []).length
  assert.ok(uses >= 3, `errText 消费点只有 ${uses} 处，说明还有地方在校验/转文案各写一套`)
})

// ═══════════════════════════════════════════════════════════════════════════
// §2.3 · 6 处 openSession 吞错 → safeOpenSession（失败必须 warn）
// ═══════════════════════════════════════════════════════════════════════════
test('§2.3 `safeOpenSession` 是唯一出口，且失败真的 console.warn（真执行）', () => {
  const src = client
  // ① 裸调用只允许出现在 safeOpenSession 本体里
  const raw = [...src.matchAll(/__uiWorkspace\.openSession\(/g)].map(m => m.index)
  assert.equal(raw.length, 1, `裸 openSession 调用应只剩 safeOpenSession 内部 1 处，实际 ${raw.length} 处（其余必须走 safeOpenSession）`)
  const fn = blockAt(src, 'function safeOpenSession(')
  assert.ok(fn, '找不到 safeOpenSession')
  assert.match(fn, /console\.warn/, '失败必须 warn（这正是审计 §2.3 指出的「文档说不许吞、代码还在吞」）')
  assert.match(fn, /catch/, '必须有 catch')
  // ② 真执行：抽函数体 + 注入会抛的 workspace，断言 warn 被调用且返回 false
  const warns = []
  const impl = new Function('__uiWorkspace', 'console', fn + '; return safeOpenSession')(
    {
      openSession() {
        throw new Error('unknown session')
      },
    },
    { warn: (...a) => warns.push(a.map(String).join(' ')) },
  )
  assert.equal(impl('session-x', 'probe'), false, '抛错时必须返回 false（不许装作成功）')
  assert.equal(warns.length, 1, '抛错必须 warn 一次（不许静默吞）')
  assert.match(warns[0], /probe/, 'warn 文本必须带调用点标记（排障时一眼看出哪条路径没重建）')
  // ③ 服务缺席时返回 false 且不 warn（不是失败，是宿主没有这个能力）
  const impl2 = new Function('__uiWorkspace', 'console', fn + '; return safeOpenSession')(null, { warn: () => warns.push('noop') })
  assert.equal(impl2('session-x', 'absent'), false, '服务缺席时返回 false')
})

// ═══════════════════════════════════════════════════════════════════════════
// §4.1 · `hit.all` / `dupByMessageId` 生产 0 读者 —— 已删，不许复活
// ═══════════════════════════════════════════════════════════════════════════
test('§4.1 索引不再维护无人读的 `all` / `dupByMessageId`', () => {
  const c = code(client)
  assert.doesNotMatch(c, /\bdupByMessageId\b/, 'dupByMessageId 生产 0 读者，不许复活')
  // `all:` 作为对象字段（不是 `panel.all` 这类字符串）不许再出现在索引构建里
  const seqOf = blockAt(c, 'var seqOfNodeKey')
  if (seqOf) assert.doesNotMatch(seqOf, /\ball\b/, 'seqOfNodeKey 只该返回 {seq, turn}，不得再带 all')
})

// ═══════════════════════════════════════════════════════════════════════════
// §3.1 · 宿主 hash 抽成 HOST_CLS 单点（跨版本最脆的依赖）
// ═══════════════════════════════════════════════════════════════════════════
test('§3.1 宿主 hash 只在 HOST_CLS 定义一次，其余全部消费常量', () => {
  const src = client
  const cls = blockAt(src, 'const HOST_CLS = ')
  assert.ok(cls, '找不到 HOST_CLS 单点常量')
  // 值必须还是宿主真实 hash（跨版本对照基线，不许顺手改名）
  assert.match(cls, /actions:\s*'xzv4MW_actions'/, 'HOST_CLS.actions 必须是宿主真实动作行 hash')
  assert.match(cls, /userRow:\s*'Sixlwa_userRow'/, 'HOST_CLS.userRow 必须是宿主真实用户行 hash')
  // 字面量只许出现在常量定义里（剥注释后统计）
  const c = code(src)
  const actionsLiteral = (c.match(/'xzv4MW_actions'/g) || []).length
  assert.equal(actionsLiteral, 1, `xzv4MW_actions 字面量应只在常量定义里 1 处，实际 ${actionsLiteral} 处（消费点必须用 HOST_CLS.actions）`)
  // 消费点真的存在（不是抽了常量却没人用）
  const uses = (c.match(/HOST_CLS\.(actions|userRow|userStack|flowItem)/g) || []).length
  assert.ok(uses >= 4, `HOST_CLS 只有 ${uses} 处消费，抽常量等于没抽`)
  // 与宿主安装版交叉验证（宿主目录可能不存在 → skip，不当失败）
  const host =
    '/data/data/com.termux/files/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js'
  let hostSrc = null
  try {
    hostSrc = readSource(host)
  } catch {
    /* 宿主路径不存在（非本机/不同版本）→ 跳过交叉验证 */
  }
  if (hostSrc) {
    assert.match(hostSrc, /xzv4MW_actions/, 'HOST_CLS.actions 必须仍存在于当前安装版宿主（hash 漂了就要跟着改）')
    assert.match(hostSrc, /Sixlwa_userRow/, 'HOST_CLS.userRow 必须仍存在于当前安装版宿主')
  }
})
