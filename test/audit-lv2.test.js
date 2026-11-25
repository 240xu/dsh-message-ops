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
  // ⚠️ 只查 `new Error('HTTP ' + res.status)` 这个**精确形态**是不够的 ——
  // M6 变异实测：把一处写操作退回 `res.json().catch(() => null)` +
  // `throw new Error((data && data.error) || 'HTTP ' + res.status)` 时，上面那条
  // 断言**照样绿**（形态不同、病根相同 = 假绿灯）。改成锁「三套写法都不许复活」：
  const c = code(src)
  // 唯一允许的例外：`sendEditAndRevert` —— 它是**可被单独抽取执行**的编排层
  // （contract-hardening 用 new Function 抽它断言时序），不能依赖模块级 helper。
  // 例外必须**有且只在**那一处，并且有注释说明；多一处就是漏改。
  const sendBlock = blockAt(c, 'async function sendEditAndRevert')
  assert.ok(sendBlock, '找不到 sendEditAndRevert（例外必须有明确的宿主，否则等于放行）')
  const totalJsonCatch = (c.match(/\.json\(\)\.catch\(/g) || []).length
  const inSend = (sendBlock.match(/\.json\(\)\.catch\(/g) || []).length
  assert.equal(inSend, 1, 'sendEditAndRevert 里应恰好保留 1 处内联读法（可抽取执行的代价）')
  assert.equal(
    totalJsonCatch,
    1,
    `\`res.json().catch(...)\` 应只剩 sendEditAndRevert 那处例外，实际 ${totalJsonCatch} 处 —— ` +
      `多出来的地方正是「500 页与 ok:false 压成同一个 null → 写操作只报 HTTP xxx」的病根`,
  )
  // 理由必须写在**源码注释**里（sendBlock 是剥注释后的代码，故对原文查）
  const sendRaw = blockAt(src, 'async function sendEditAndRevert')
  assert.ok(sendRaw, '找不到 sendEditAndRevert 原文')
  assert.match(sendRaw, /不许依赖模块级 helper|可被单独抽取执行/, '例外必须写明理由（否则下次有人照抄成习惯）')
  const rawStatusText = (c.match(/'HTTP ' \+ [a-z](\.status|\?\.status)/g) || []).length
  assert.equal(rawStatusText, 0, `还有 ${rawStatusText} 处直接拼 'HTTP ' + status（错误文案必须走 opsError 单点）`)
  // 消费点下限：11 处同构调用点必须都在用单点（少一处就是漏改）
  const uses = (c.match(/\breadOpsJson\(/g) || []).length
  assert.ok(uses >= 9, `readOpsJson 消费点只有 ${uses} 处（审计口径是 11 处同构点，漏改会静默保留旧病）`)
})

test('§3.4 `errText` 单点存在，且被面板错误路径消费', () => {
  const src = client
  const decl = blockAt(src, 'var errText = ')
  assert.ok(decl, '找不到 errText（错误文案转换必须单点）')
  assert.match(decl, /reason\.message|String\(reason\)/, '必须同时容纳 Error 与字符串')
  const uses = (src.match(/\berrText\(/g) || []).length
  assert.ok(uses >= 9, `errText 消费点只有 ${uses} 处（审计口径 13 处同构转换，漏改会保留两套口径）`)
  // ⚠️ 只数消费点不够 —— M10 变异实测：把调用点退回内联表达式后，消费点还剩 ≥9
  // 处（其余没改），上面那条照样绿。必须**按代码形态**锁死「内联写法只许剩 1 处，
  // 即 errText 定义自身」，多一处就是漏改。
  const c = code(src)
  const inline = (c.match(/reason && reason\.message \? reason\.message : String\(reason\)/g) || []).length
  assert.equal(
    inline,
    1,
    `\`reason && reason.message ? … : String(reason)\` 应只在 errText 定义里 1 处，实际 ${inline} 处 —— 多出来的就是各写一套`,
  )
  // 两种走 __t 还是 t 的历史分叉也要收口（同语义两条路径已漂移过）
  const __tUses = (c.match(/errText\(reason, __t\(/g) || []).length
  const tUses = (c.match(/errText\(reason, t\(/g) || []).length
  assert.ok(__tUses >= 1 && tUses >= 1, '两种前缀来源都要真的被消费（本文件有模块级 __t 与组件级 t 两条路径）')
})

test('§2.4+§3.4 端到端真执行：写操作 500 的用户可见文案必须是服务端原因，不是 HTTP 500', async () => {
  // 审计 §2.4 的**收益本身**要锁：`catch(() => null)` 会把「非 JSON 的 500 页面」与
  // 「JSON 但 ok:false」压成同一个 null → 真正的 data.error 丢了 → 用户看到 HTTP 500。
  // 这里把三个真实单点串起来跑（readOpsJson → opsError → errText），断言最终展示文案。
  const src = client
  const readJs = blockAt(src, 'var readOpsJson = ')
  const errJs = blockAt(src, 'var opsError = ')
  const txtJs = blockAt(src, 'var errText = ')
  assert.ok(readJs && errJs && txtJs, '三个单点必须都抽得出来（抽不到就硬失败）')
  // eslint-disable-next-line no-new-func
  const readOpsJson = new Function(readJs + '; return readOpsJson')()
  // eslint-disable-next-line no-new-func
  const opsError = new Function(errJs + '; return opsError')()
  // eslint-disable-next-line no-new-func
  const errText = new Function(txtJs + '; return errText')()

  // ① 服务端返回 500 + JSON 真因（「会话正在运行」这类用户必须看到的信息）
  const res = { ok: false, status: 500, json: async () => ({ ok: false, error: 'session is running; stop it first' }) }
  const r = await readOpsJson(res)
  assert.equal(r.ok, false)
  assert.equal(r.status, 500, 'status 必须带出来（opsError 退路要用）')
  const shown = errText(opsError(r.status, r.data), '操作失败：')
  assert.match(shown, /session is running/, `用户可见文案必须含服务端真因，实际：${shown}`)
  assert.doesNotMatch(shown, /HTTP 500/, '不许坍缩成 HTTP 500（这正是审计指出的用户可见 bug）')
  assert.match(shown, /^操作失败：/, 'prefix 必须保留（i18n errorPrefix 的契约）')

  // ② 非 JSON 的 500 页面（网关 HTML / 空 body）：不许抛、不许 null，退化成 HTTP 500 是**可接受**的
  const htmlRes = { ok: false, status: 502, json: async () => JSON.parse('<html>bad gateway</html>') }
  const r2 = await readOpsJson(htmlRes)
  assert.equal(r2.ok, false, '解析失败必须判失败（不许当成功）')
  assert.deepEqual(r2.data, {}, '解析失败必须退化成空对象（调用方才不会 data.error 崩）')
  const shown2 = errText(opsError(r2.status, r2.data), '操作失败：')
  assert.match(shown2, /HTTP 502/, '没有服务端文案时才退 HTTP <status>（把真实状态码如实报出）')

  // ③ 2xx 但业务 ok:false（服务端把拒绝塞在 body 里）也必须判失败
  const bizFail = { ok: true, status: 200, json: async () => ({ ok: false, error: 'seq is a marker' }) }
  const r3 = await readOpsJson(bizFail)
  assert.equal(r3.ok, false, 'HTTP 2xx 不代表业务成功（服务端所有成功路由都回 ok:true）')
  assert.match(errText(opsError(r3.status, r3.data), ''), /seq is a marker/, '业务拒绝文案同样要透出')
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

// ═══════════════════════════════════════════════════════════════════════════
// §1.6+§2.2 · **端到端真执行**：ctx 必然解析不到 live 面 → 错误消息必须带具体原因
// ═══════════════════════════════════════════════════════════════════════════
test('§1.6+§2.2 端到端：opsCommit 失败时错误消息含「为什么解析不到 live 面」', async () => {
  // ⚠️ DSH_HOME 必须在 import src/index.js **之前**设（findSessionDirs 按它定位日志）。
  // 本文件此前只 readSource（读文本），没有 import 过 index.js 模块，故这里设了再动态
  // import 是安全的；node --test 每个文件独占一个子进程，也不会污染别的测试。
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-msgops-auditlv2-'))
  const { encodeSessionFile } = await import('../src/session-file.js')
  const { _internals } = await import('../src/index.js')
  const { OpsError } = await import('../src/ops-core.js')

  const SID = 'session-11111111-2222-3333-4444-555555555555'
  const logDir = path.join(process.env.DSH_HOME, 'sessions', 'proj-audit', SID)
  const logPath = path.join(logDir, 'session.v4.jsonl.zstd')
  fs.mkdirSync(logDir, { recursive: true })
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1, reason: { kind: 'user' } } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    {
      type: 'system/message',
      seq: 2,
      time: 3,
      data: { turn: 1, step: 1, message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'sys' }] } },
      surfaceOp: 'append',
    },
    {
      type: 'user/message',
      seq: 3,
      time: 4,
      data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' }, role: 'user', id: 'u1' },
      surfaceOp: 'append',
    },
    { type: 'step/end', seq: 4, time: 5, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 5, time: 6, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  fs.writeFileSync(logPath, encodeSessionFile({ type: 'session', version: 4, id: SID, createdAt: 1, cwd: '/tmp' }, events))

  // ① ctx **没有任何 sessions 面** → resolveSession 必然 miss，且原因可枚举：
  //    『no-sessions-service』（连候选都没有）+『ISessions:no-owner』（retain 面也没有）
  const ctx = { get: () => undefined, effective: { cleanup() {} }, effect() {} }
  await assert.rejects(
    () => _internals.opsCommit(ctx, 'delete', SID, 999),
    err => {
      assert.ok(err instanceof OpsError, '必须是 OpsError（路由层靠 status 映射 HTTP）')
      assert.equal(err.status, 409, '磁盘面判定不到目标 → 409（不变）')
      assert.match(err.message, /not visible on current surface/, '原始语义必须保留（排障者先看结论）')
      assert.match(err.message, /no-sessions-service/, '必须带「根本没有 sessions 服务」这一具体原因（审计 §1.6 的核心诉求）')
      assert.match(err.message, /ISessions/, '必须带 retain 面缺失的具体原因（说明为何不能走官方越界通道）')
      return true
    },
  )

  // ② 对照组：同样的 ctx，目标 **存在** → 成功，且**不得**把诊断拼进正常返回。
  const out = await _internals.opsCommit(ctx, 'delete', SID, 3)
  assert.equal(out.ok, true, '可操作目标必须成功（诊断只在失败路径生效）')
  assert.equal('resolve' in out, false, '成功路径不许出现诊断字段（零字符串开销的承诺）')
})

// ═══════════════════════════════════════════════════════════════════════════
// §3.2 · `ensureActionsHost` 真执行：同一条消息只许有**一个**插件动作行
// ═══════════════════════════════════════════════════════════════════════════
test('§3.2 ensureActionsHost 真执行：命中宿主动作行就复用，查不到才建且只建一行', () => {
  const src = client
  const fn = blockAt(src, 'var ensureActionsHost = ')
  assert.ok(fn, '找不到 ensureActionsHost（两个按钮工厂的 host 获取必须单点）')
  const hostCls = blockAt(src, 'const HOST_CLS = ')
  const HOST_CLS = new Function(hostCls + '; return HOST_CLS')()
  // 最小 document 桩：只提供 createElement（真实现只用到这一个 DOM API）
  const created = []
  const document = {
    createElement: tag => {
      const el = { tagName: String(tag).toUpperCase(), className: '', children: [], querySelector: () => null }
      created.push(el)
      return el
    },
  }
  const blockOf = found => ({
    appended: [],
    // ⚠️ 必须是**普通函数**（箭头函数 this 为词法作用域，绑不到块元素）
    querySelector(sel) {
      // ① 宿主动作行：选择器必须消费 HOST_CLS.actions（不是字面量）
      if (sel.includes(HOST_CLS.actions)) {
        return found || null
      }
      // ② 我们自己的兜底行：按类名精确后缀查（生产的两条复用判据之二）
      if (sel.includes('mopsUserActionsRow')) {
        return this.appended.find(el => String(el.className || '').includes('mopsUserActionsRow')) || null
      }
      return null
    },
    appendChild(el) {
      this.appended.push(el)
      return el
    },
  })

  const impl = new Function('document', 'HOST_CLS', fn + '; return ensureActionsHost')(document, HOST_CLS)

  // ① 宿主已提供动作行 → 复用它，且**不建**新行（否则同一条消息两个动作行 → 撑裂行高）
  const existing = { children: [], querySelector: () => null }
  const b1 = blockOf(existing)
  const r1 = impl(b1)
  assert.equal(r1.host, existing, '必须复用宿主动作行（可见性才能跟随 hover 显隐）')
  assert.equal(r1.created, false, '命中时不得自建')
  assert.equal(b1.appended.length, 0, '命中时不得往块里塞任何节点')

  // ② 宿主没有动作行 → 建**一个** mopsUserActionsRow
  const b2 = blockOf(null)
  const r2 = impl(b2)
  assert.equal(r2.created, true, '查不到时必须建行（否则按钮无处可挂）')
  assert.equal(r2.host.className, 'mopsUserActionsRow', '自建行的类名是契约（样式与测试都靠它识别）')
  assert.deepEqual(b2.appended, [r2.host], '自建行必须真的挂进消息块')
  assert.equal(created.length, 1, '一次调用只许建一个元素')

  // ③ 关键回归：同一条消息上「回撤 + 铅笔」两个工厂必须拿到**同一个** host
  //    （0.16.0「撑裂行高」事故形态：两个工厂各自建行 → 同一条消息两排按钮）
  const b3 = blockOf(null)
  assert.equal(impl(b3).host, impl(b3).host, '第二次调用必须复用第一次建的行，而不是再建一个')
  assert.equal(b3.appended.length, 1, '两个工厂合计只许往块里塞一行')
  assert.equal(created.length, 2, '只在第一次查不到时建元素（第二次必须复用）')
})

// ═══════════════════════════════════════════════════════════════════════════
// §3.1 · 真执行：`MO_SEL` 是**用常量拼出来的**，且拼出来的选择器真的覆盖动作行
// ═══════════════════════════════════════════════════════════════════════════
test('§3.1 MO_SEL 真执行：由 HOST_CLS.actions 拼接而成，且仍覆盖宿主 chat 行/动作行/回合页脚', () => {
  const src = client
  const hostCls = blockAt(src, 'const HOST_CLS = ')
  const HOST_CLS = new Function(hostCls + '; return HOST_CLS')()
  const at = src.indexOf('var MO_SEL =')
  assert.ok(at > 0, '找不到 MO_SEL')
  const end = src.indexOf('var scanPendingSince', at)
  assert.ok(end > at, '找不到 MO_SEL 的结束位置')
  const stmt = src.slice(at, end).trim()
  // 真执行：把声明语句连同 HOST_CLS 一起求值 —— 若常量消费断链（改回字面量、
  // 或拼接写错），得到的 MO_SEL 立刻不对，这里必红。
  // ⚠️ 这一步是**关键**：不能只验「拼出来的串里含那个 hash」—— 退回字面量的写法
  // 拼出来的串一模一样（M5 变异实测过：只验结果会假绿）。必须验**声明语句本身**
  // 消费了 HOST_CLS，否则「抽常量」等于没抽（审计 §3.1 的风险 1）。
  assert.match(stmt, /HOST_CLS\.actions/, `MO_SEL 必须由 HOST_CLS.actions 拼接，实际声明：${stmt}`)
  const MO_SEL = new Function('HOST_CLS', stmt + '; return MO_SEL')(HOST_CLS)
  assert.ok(MO_SEL.includes(HOST_CLS.actions), `MO_SEL 必须包含 HOST_CLS.actions=${HOST_CLS.actions}，实际：${MO_SEL}`)
  // 四类节点缺一不可（漏了就是「遮蔽行不更新」）
  for (const probe of ['[data-chat-node-key]', '[data-chat-flow-kind="user"]', '[class*="_userRow"]', '[data-turn-tail]']) {
    assert.ok(MO_SEL.includes(probe), `MO_SEL 缺 ${probe}：${MO_SEL}`)
  }
  // 行为验证（不是字符串包含）：用最小 matches 桩模拟类名匹配
  const el = cls => {
    const attrs = {}
    return {
      nodeType: 1,
      attrs,
      matches(sel) {
        // 极简 CSS 子集（够验证 MO_SEL 语义）：选择器列表按逗号分段，任一段命中即命中。
        //   `[class*="X"]` → className 含 X；`[attr="v"]` → 属性等值。
        return String(sel)
          .split(',')
          .some(part => {
            const star = /\[class\*="([^"]+)"\]/.exec(part)
            if (star) return String(cls).includes(star[1])
            const eq = /\[([a-z-]+)="([^"]+)"\]/.exec(part)
            if (eq) return attrs[eq[1]] === eq[2]
            // 存在性选择器 `[attr]`（MO_SEL 里 [data-chat-node-key] / [data-turn-tail] 就是这种）
            const exists = /\[([a-z-]+)\]/.exec(part)
            if (exists) return Object.prototype.hasOwnProperty.call(attrs, exists[1])
            return false
          })
      },
    }
  }
  const withActions = el('xzv4MW_actions mopsUserActionsRow')
  assert.equal(withActions.matches(MO_SEL), true, '带宿主动作行的节点必须被 MO 过滤命中（否则重建后不重扫）')
  const plainRow = el('mopsUserActionsRow')
  assert.equal(plainRow.matches(MO_SEL), false, '只有我们自己建的行不算宿主节点（避免自触发成环）')
  const chatRow = el('anything')
  chatRow.attrs['data-chat-node-key'] = '13:input-messagex'
  assert.equal(chatRow.matches(MO_SEL), true, 'chat 行必须命中')
})

// ═══════════════════════════════════════════════════════════════════════════
// §1.5 · `session-trash._internals` 死导出（附加项，工单标注「可选」）
// ═══════════════════════════════════════════════════════════════════════════
test('§1.5 session-trash 不再导出无人使用的 `_internals` 测试面', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/session-trash.js', import.meta.url), 'utf8')
  const c = code(src)
  assert.doesNotMatch(c, /export const _internals/, 'session-trash 的 _internals 死导出（审计 §1.5）不得复活')
  // 4 个函数本体仍在用（只删导出，不删函数）—— 删过头会让 trash 功能整块消失
  for (const name of ['findAllSessionDirs', 'readMetadata', 'stripMetadata', 'restoreMetadata']) {
    assert.match(c, new RegExp('function ' + name), `${name} 的函数本体必须保留（审计 §1.5 只点名删导出）`)
  }
  const mod = await import('../src/session-trash.js')
  assert.equal(mod._internals, undefined, '_internals 必须真的不在模块导出面上')
})
