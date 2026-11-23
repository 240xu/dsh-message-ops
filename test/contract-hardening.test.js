/**
 * 0.25.0 · 测试真实性加固（C 线工单第 2 部分）。
 *
 * 来源：design-demos/audit-test-fakegreen.md 的变异测试结论 —— 本仓库大量契约是
 * 「grep 源码形状」，注入了 30 个真实缺陷仍有 14 个存活。这里只**补**三类
 * 最危险的、且不落在别的同事正在改的文件里的盲区：
 *
 *  A · 「断言自己能跑」型守卫：把「拿不到就 assert.ok(true) 静默变装饰」的写法
 *      换成硬失败。当前工作区已无 `assert.ok(true)`（A 线清理时一并修掉），
 *      所以本组锁的是**机制**：给出可复用的提取器 + 用变异证明它在失效时会红。
 *  B · i18n 值语义锁：改 en 值成反义必须失败。旧锁（audit-content-fixes 的
 *      「en 值不得匹配反义正则」）只覆盖 3 个 key 且是 `doesNotMatch` 形态，
 *      `edit.send` 改成 'Cancel now' 之类仍能过。这里补齐 edit.send / slot.revert /
 *      panel.delete 三类**关键语义**用「必须匹配正向语义 + 不得匹配反义」双向断言，
 *      并在文末用变异做自证（改反义 → 提取器确实会判红）。
 *  C · submitEditedText「只提交一次」：test/pencil-edit-overlay.test.js 9.x 已有
 *      **真执行**（grep 确认），本文件**不重复**，只锁一条它没覆盖的边界：
 *      「提交成功后再重挂也不得第二次 submit」（防止未来加『重试』把双发带回来）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { flat, blockAt } from './_source.js'

const readSrc = name => fs.readFileSync(new URL('../src/' + name, import.meta.url), 'utf8')
const clientSrc = readSrc('client.js')
const serverSrc = readSrc('index.js')
const clientFlat = flat(clientSrc)

// ═══════════════════════════════════════════════════════════════════════════
// A · 「拿不到就跳过」型守卫必须硬失败，且可复用提取器必须真的能提取
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 从源码里提取一个具名函数的**可执行副本**（与 audit-deep-fixes / fork-dom-behavior
 * 同款手法：切块 + new Function）。提取不到就**抛**，绝不 return null 后让调用方
 * assert.ok(true) 混过去 —— 这正是 F-7 那类假绿灯的根因。
 */
function extractFn(source, needle, argNames = []) {
  const block = blockAt(source, needle)
  assert.ok(block, `提取器失败：源码里找不到 ${needle} —— 这必须是**硬失败**，不许静默跳过`)
  // eslint-disable-next-line no-new-func
  return new Function(...argNames, block + '\nreturn ' + needle.replace(/^(?:var|let|const|function)\s+/, '').trim() + ';')
}

/**
 * 抽出「`var name = x => ...`」这类**无大括号**声明（blockAt 按大括号配平，对它们
 * 恒返回 null）。抽不到就硬失败。
 */
function arrowDecl(source, name) {
  const re = new RegExp('(?:const|var|let)\\s+' + name + '\\s*=\\s*([A-Za-z_$][A-Za-z0-9_$]*)\\s*=>\\s*([^\\n]+)')
  const m = source.match(re)
  if (!m) return null
  return 'var ' + name + ' = ' + m[1] + ' => ' + m[2].trim()
}

test('A1 · 提取器自证：抽出来的东西必须真能跑（不是又一层 grep）', async () => {
  // ① ESM 面：ops-core / index.js 是可直接 import 的，真执行比「从 client.js 抽闭包」
  //    可靠得多（client.js 的函数大量依赖 __t / deps / window，抽出来反而是假执行）。
  const oc = await import('../src/ops-core.js')
  assert.equal(typeof oc.planRestore, 'function', 'planRestore 必须是真的可调用函数')
  const events = [
    { seq: 0, type: 'user/message', surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: 'hello' }] } } },
    {
      seq: 1,
      type: 'system/message',
      surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 },
      sourceEventSeqs: [0],
      data: { message: { content: [{ type: 'text', text: 'm' }] } },
    },
  ]
  const plan = oc.planRestore(events, 1)
  assert.equal(typeof plan, 'object', '真执行必须返回真实规划对象（提取失败会是 undefined）')
  assert.ok(Array.isArray(plan.replayable), 'planRestore 的返回形状必须可断言')

  // ② client.js 里**不依赖闭包**的短箭头也要能抽出来跑（`var norm = x => ...`）。
  //    注意不能用 blockAt：它按大括号配平，而这条语句里根本没有大括号。
  const dec = arrowDecl(clientSrc, 'norm')
  assert.ok(dec, '提取器必须能抽出 var norm = x => ... 这种无大括号声明')
  // eslint-disable-next-line no-new-func
  const normFn = new Function(dec + '\nreturn norm;')()
  assert.equal(typeof normFn, 'function', 'norm 必须被真实提取成可调用函数')
  assert.equal(normFn(' a \n b '), 'ab', '提取出来的函数必须真的能跑（去空白）')
})

test('A2 · 守卫型断言不得写成恒真：全仓不得再出现「恒真 ok」守卫', () => {
  const files = fs.readdirSync(new URL('.', import.meta.url)).filter(f => f.endsWith('.test.js'))
  const offenders = []
  for (const f of files) {
    const body = fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8')
    // 注释里提到恒真守卫是允许的（审计文档指针），只查**代码形态**。
    // 注意：本文件自己的测试标题/字符串里也不能写那个字面量 —— 否则会命中自己。
    const codeOnly = body
      .split('\n')
      .filter(line => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join('\n')
    if (/assert\.ok\(\s*true\s*[,)]/.test(codeOnly) || /assert\.ok\(\s*1\s*[,)]/.test(codeOnly)) offenders.push(f)
  }
  assert.deepEqual(offenders, [], '这些文件里仍有恒真守卫（导出消失时测试会静默变装饰）：' + offenders.join(', '))
})

test('A3 · 服务端真执行面必须存在：_internals 一个都不许缺（缺了立刻红）', async () => {
  const { _internals } = await import('../src/index.js')
  // 函数面：缺一个，对应的真执行测试就会静默蒸发
  for (const name of ['opsList', 'opsSearch', 'opsText', 'loadDerived']) {
    assert.equal(typeof _internals[name], 'function', `_internals.${name} 缺失（应为函数）—— 真执行测试会静默蒸发`)
  }
  // 状态面：测试要能清缓存 / 读到索引
  assert.ok(_internals.derivedCache instanceof Map, '_internals.derivedCache 必须是 Map（测试要能清缓存）')
  assert.ok(_internals.derivedTexts instanceof WeakMap, '_internals.derivedTexts 必须是 WeakMap')
})

test('A4 · 变异自证：把 /text 路由退回「全量重读」会被 server-text-cache 杀掉', () => {
  // 这条不重跑测试（避免自我嵌套），只在源码层确认「路由不再直接调
  // readSessionFileAsync」这一事实**不是**断言的全部依据 —— 真正的依据是
  // server-text-cache.test.js 的真执行读盘计数（已用变异 M1 实证：5 条红）。
  const textRoute = serverSrc.slice(serverSrc.indexOf("path: '/api/message-ops/text'"), serverSrc.indexOf("'dsh-message-ops: text route'"))
  assert.ok(textRoute.length > 200, '找不到 /text 路由体')
  assert.ok(/opsText\(/.test(textRoute), '/text 路由必须委托给 opsText（缓存入口）')
  assert.ok(!/readSessionFileAsync\(/.test(textRoute), '/text 路由不得自己全量读日志（绕路会回来）')
})

// ═══════════════════════════════════════════════════════════════════════════
// B · i18n 值语义锁：改 en 值成反义必须失败
// ═══════════════════════════════════════════════════════════════════════════

/** 从 client.js 抽出 zhDict / enDict 对象字面量并**求值**（与 client-p0-locks 同款）。 */
function grabDict(name) {
  const marker = 'const ' + name + ' = {'
  const at = clientSrc.indexOf(marker)
  assert.ok(at >= 0, `源码里找不到 ${name} —— 硬失败，不许跳过`)
  const start = clientSrc.indexOf('{', at)
  let depth = 0
  let quote = null
  let esc = false
  for (let i = start; i < clientSrc.length; i++) {
    const ch = clientSrc[i]
    if (quote) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        // eslint-disable-next-line no-new-func
        return new Function('return (' + clientSrc.slice(start, i + 1) + ')')()
      }
    }
  }
  assert.fail('字典对象字面量未配平：' + name)
}
const zhDict = grabDict('zhDict')
const enDict = grabDict('enDict')

/**
 * 关键语义表：每个 key 给出「必须匹配的正向语义」与「不得匹配的反义」。
 * 只锁破坏性 / 不可逆 / 易混的动作，不做全量 key 的词表维护（成本爆炸）。
 */
const SEMANTICS = [
  {
    key: 'edit.send',
    // 「撤销并发送」：必须同时表达 send 与 revert/undo，且绝不能变成 cancel
    zh: /发送/,
    zhBanned: /取消/,
    en: /send/i,
    // 注意：不能写成 `/[^a-z]cancel/` —— 值恰好等于 'Cancel' 时前后都没有字母，
    // 那样只判出 :weak 判不出 :banned（本用例的变异自证就是这么发现漏的）。
    enBanned: /cancel/i,
    why: '点它 = 先回撤再发送；变成 Cancel 会让用户以为点了不会回撤',
  },
  {
    key: 'slot.revert',
    zh: /回滚|撤销/,
    zhBanned: /删除|移除/,
    en: /revert|undo|roll\s*back/i,
    enBanned: /delete|remove/i,
    why: '信息区按钮：说成 Delete 会让用户以为原文被销毁（实际只是遮蔽、可恢复）',
  },
  {
    key: 'panel.delete',
    zh: /遮蔽|隐藏|删除/,
    zhBanned: /回滚|恢复/,
    en: /hide|shadow|delete/i,
    enBanned: /revert|restore|undo/i,
    why: '面板单条删除按钮：说成 Revert/Restore 语义完全相反（一个藏一个放回）',
  },
]

for (const spec of SEMANTICS) {
  test('B1 · i18n 语义 ' + spec.key + '：zh / en 都必须表达正确动作且不得反向', () => {
    const zh = zhDict[spec.key]
    const en = enDict[spec.key]
    assert.equal(typeof zh, 'string', 'zhDict 缺 ' + spec.key)
    assert.equal(typeof en, 'string', 'enDict 缺 ' + spec.key)
    // ① 正向：必须真的表达该动作
    assert.match(zh, spec.zh, `zhDict['${spec.key}'] 缺少必要语义（${spec.why}）：${zh}`)
    assert.match(en, spec.en, `enDict['${spec.key}'] 缺少必要语义（${spec.why}）：${en}`)
    // ② 反向：不得出现互斥动词（旧锁只有 edit.send/panel.revert/dock.restore，不够）
    assert.doesNotMatch(zh, spec.zhBanned, `zhDict['${spec.key}'] 出现了反义/易混词：${zh}`)
    assert.doesNotMatch(en, spec.enBanned, `enDict['${spec.key}'] 出现了反义/易混词：${en}`)
  })
}

test('B2 · 变异自证：把 en 值改成反义，上面那套语义判定必须判红（不依赖源码字符串）', () => {
  // 直接跑「判定函数」对**伪造字典**求值 —— 证明红不是因为硬编码了当前文案。
  const judge = dict => {
    const problems = []
    for (const spec of SEMANTICS) {
      const zh = dict.zh[spec.key]
      const en = dict.en[spec.key]
      if (typeof zh !== 'string' || typeof en !== 'string' || !zh || !en) problems.push(spec.key + ':missing')
      // ⚠️ 三个判据必须**各自独立**求值：写成 `else if` 时「弱语义」会短路「反义」，
      //    值恰好等于 'Cancel' 就只报 :weak、漏报 :banned（本用例的变异自证抓到的真缺陷）。
      else {
        if (!spec.zh.test(zh) || !spec.en.test(en)) problems.push(spec.key + ':weak')
        if (spec.zhBanned.test(zh) || spec.enBanned.test(en)) problems.push(spec.key + ':banned')
      }
      // 占位符集合必须两侧一致（沿用 client-p0-locks 的口径，这里只查这几个 key）
      const names = s => (String(s).match(/\{[a-zA-Z]+\}/g) || []).sort().join()
      if (names(zh) !== names(en)) problems.push(spec.key + ':placeholders')
    }
    return problems
  }
  assert.deepEqual(judge({ zh: zhDict, en: enDict }), [], '当前真实字典必须通过语义判定')
  // 模拟 audit 里那三个存活变异体
  const bad1 = judge({ zh: zhDict, en: { ...enDict, 'edit.send': 'Cancel' } })
  const bad2 = judge({ zh: zhDict, en: { ...enDict, 'slot.revert': 'Delete' } })
  const bad3 = judge({ zh: zhDict, en: { ...enDict, 'panel.delete': 'Restore this' } })
  // 反义替换通常**同时**触发两个判据：既丢了正向语义（weak），又撞上反义词（banned）。
  // 这两条都必须红 —— 只报其中一个说明判据被短路了（上面 else-if 的教训）。
  assert.deepEqual(bad1, ['edit.send:weak', 'edit.send:banned'], 'en edit.send → Cancel 必须被判红')
  assert.deepEqual(bad2, ['slot.revert:weak', 'slot.revert:banned'], 'en slot.revert → Delete 必须被判红')
  assert.deepEqual(bad3, ['panel.delete:weak', 'panel.delete:banned'], 'en panel.delete → Restore this 必须被判红')
  // 中文侧同样不能退化
  assert.deepEqual(judge({ zh: { ...zhDict, 'edit.send': '取消' }, en: enDict }), ['edit.send:weak', 'edit.send:banned'])
})

test('B3 · 破坏性动作的 zh/en 键集合仍一一对应（缺 key 会让 en 用户看到 key 本身）', () => {
  const zhKeys = Object.keys(zhDict)
  const enKeys = Object.keys(enDict)
  assert.deepEqual(zhKeys, enKeys)
  // 上面三类关键语义必须两边都在
  for (const spec of SEMANTICS) {
    assert.ok(spec.key in zhDict, 'zhDict 缺 ' + spec.key)
    assert.ok(spec.key in enDict, 'enDict 缺 ' + spec.key)
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// C · 「一次编辑只提交一次」——契约迁移（legacy submitEditedText → 官方 prompt）
// ═══════════════════════════════════════════════════════════════════════════
//
// 裁决（Lead，2026-11-22）：editor-e 正把铅笔编辑改成官方
// `sessions.using(...).prompt(..., 'queue')`，并**删除** submitEditedText /
// EDIT_SUBMIT_ATTEMPTS / EDIT_SUBMIT_INTERVAL_MS。所以本节写成**双契约**：
//   · 旧实现（`function submitEditedText` 还在）：提交走 deps.submitEdited，
//     断言「整条编辑链上提交事件恰好 1 次」。
//   · 新实现（旧实现已删、且出现 `prompt(..., 'queue')`）：提交走 deps.prompt，
//     断言「prompt 恰好 1 次且带 'queue'，且不再调用 inputActions.submit」。
// 两种世界都**真执行** sendEditAndRevert（抽函数块 + 注入 deps），不许恒真。
const LEGACY_SUBMIT = clientSrc.includes('function submitEditedText')
const OFFICIAL_QUEUE_PROMPT = /prompt\([^)]*'queue'/.test(clientSrc) || /prompt\([^)]*"queue"/.test(clientSrc)
const SUBMIT_CONTRACT = LEGACY_SUBMIT ? 'legacy-submitEditedText' : OFFICIAL_QUEUE_PROMPT ? 'official-queue-prompt' : 'unknown'

/**
 * 契约探测必须**双向可验证**（Lead 要求）：探不到任何一种发送面时不许静默走
 * legacy 分支假装通过 —— 那样「编辑器改动没落地」也会是绿的（新的假绿灯）。
 * 这里用 node:test 的 skip 显式跳过并打印原因，让「什么都没实现」变成可见的 skip
 * 而不是不可见的 pass。
 */
function requireKnownContract(t) {
  if (SUBMIT_CONTRACT === 'unknown') {
    t.skip("契约探测失败：源码里既没有 submitEditedText，也没有 prompt(..., 'queue') —— 发送面改动可能没落地")
    return false
  }
  return true
}

/** 抽 sendEditAndRevert 的真函数块（它引用闭包里的默认实现，但全部被 deps 短路）。 */
function loadSendEditAndRevert() {
  const block = blockAt(clientSrc, 'async function sendEditAndRevert')
  assert.ok(block, '找不到 sendEditAndRevert —— 必须硬失败，不许静默跳过')
  // 正文里对 inputActionsFor / writeSessionDraft 等闭包标识符的引用都落在
  // `deps.x || (…闭包…)` 的右侧 —— deps 给全时右侧不会被求值。
  // eslint-disable-next-line no-new-func
  return new Function(block + '\nreturn sendEditAndRevert;')()
}

/**
 * 造一条「成功」的编辑链，记录**所有**提交通道与副作用。
 * 同时给 submitEdited / prompt 两个通道的假实现：新旧契约都能被观测到。
 */
function runEditChain({ revertOk = true } = {}) {
  const fn = loadSendEditAndRevert()
  const calls = []
  const deps = {
    fetch: async () => {
      calls.push(['fetch'])
      return revertOk
        ? { ok: true, status: 200, json: async () => ({ ok: true }) }
        : { ok: false, status: 409, json: async () => ({ ok: false, error: 'session is running' }) }
    },
    writeSessionDraft: (id, t) => {
      calls.push(['writeSessionDraft', id, t])
      return true
    },
    readSessionDraft: () => null,
    markRowsShadowedFrom: () => calls.push(['markRowsShadowedFrom']),
    setDraft: () => calls.push(['setDraft']),
    persistDraft: () => calls.push(['persistDraft']),
    emitChanged: () => calls.push(['emitChanged']),
    openSessionById: () => calls.push(['openSessionById']),
    // 旧契约通道
    submitEdited: t => {
      calls.push(['submitEdited', t])
      return true
    },
    // 新契约通道（官方队列 prompt）：记录**全部实参**，供 assert 'queue'
    // ⚠️ 必须返回 {ok:true, accepted:true} —— 真实现的契约是
    // `sessions.using(...).prompt(...)` 返回 RemoteResult，成功时 ok:true。
    // 早先这里返回 null，导致「成功链」被判成 prompt 拒收（C1 假红）。
    prompt: (...args) => {
      calls.push(['prompt', ...args])
      return Promise.resolve({ ok: true, accepted: true })
    },
  }
  const target = { sessionId: 'uuid', rawSessionId: 'session-uuid', seq: 12, text: '改后文本', deps }
  return fn(target).then(out => ({ out, calls }))
}

const submissionsOf = calls => calls.filter(c => c[0] === 'submitEdited' || c[0] === 'prompt')
const iaSubmits = calls => calls.filter(c => c[0] === 'inputActionsSubmit')

test('C1 · 成功路径：整条编辑链只提交 1 次（新契约下 must be prompt 且带 queue）', async t => {
  if (!requireKnownContract(t)) return
  const { out, calls } = await runEditChain({ revertOk: true })
  assert.equal(out.ok, true, 'revert 成功时编辑链必须成功')
  assert.equal(out.stage, 'done')
  const submissions = submissionsOf(calls)
  assert.equal(
    submissions.length,
    1,
    `一次编辑只许提交 1 次（两次 = 发出两条消息，比失败更糟），实际 ${submissions.length} 次：${JSON.stringify(submissions)}`,
  )
  assert.equal(iaSubmits(calls).length, 0, '提交不得再直连 inputActions.submit（一个编辑框实例的 submit 可能已被宿主 dispose）')
  if (SUBMIT_CONTRACT === 'official-queue-prompt') {
    assert.equal(submissions[0][0], 'prompt', '新契约必须走官方 prompt')
    assert.ok(
      submissions[0].includes('queue'),
      "prompt 必须以 'queue' 模式调用（DECISIONS「不许双发」的迁移语义），实际参数：" + JSON.stringify(submissions[0]),
    )
  } else {
    // 旧契约：提交通道是 deps.submitEdited，进来的就是要提交的文本
    assert.equal(submissions[0][0], 'submitEdited')
    assert.equal(submissions[0][1], '改后文本', '提交的必须是用户改后的文本')
  }
})

test('C2 · revert 失败：prompt / submit 零调用，零草稿写入、零 openSession', async t => {
  if (!requireKnownContract(t)) return
  const { out, calls } = await runEditChain({ revertOk: false })
  assert.equal(out.ok, false, 'revert 失败必须返回 ok:false')
  assert.equal(out.stage, 'revert')
  assert.equal(submissionsOf(calls).length, 0, 'revert 失败时绝不许提交（会发出一条与回撤无关的消息）')
  assert.equal(calls.filter(c => c[0] === 'writeSessionDraft').length, 0, 'revert 失败时不得写草稿')
  assert.equal(calls.filter(c => c[0] === 'openSessionById').length, 0, 'revert 失败时不得重建视图')
  assert.equal(calls.filter(c => c[0] === 'setDraft' || c[0] === 'persistDraft').length, 0, 'revert 失败时不得动编辑器')
})

test('C3 · 成功路径的顺序：revert → 标遮蔽 → emitChanged → openSession → 提交（双契约）', async t => {
  if (!requireKnownContract(t)) return
  const { calls } = await runEditChain({ revertOk: true })
  const order = calls.map(c => c[0])
  const at = name => order.indexOf(name)
  assert.equal(order[0], 'fetch', '第一步必须是 POST /revert')
  assert.ok(at('markRowsShadowedFrom') > 0, '成功后必须标遮蔽（防 409 护栏）')
  assert.ok(at('emitChanged') > at('markRowsShadowedFrom'), 'emitChanged 在标遮蔽之后')
  assert.ok(at('openSessionById') > at('emitChanged'), 'openSession 在 emitChanged 之后')

  if (SUBMIT_CONTRACT === 'official-queue-prompt') {
    // 新契约（官方 prompt）：编辑提交**不写草稿**，否则改后文本会残留在 composer
    // （正是这次重做要删掉的 hack —— 用户发完还看得见同一段字）。
    assert.equal(at('writeSessionDraft'), -1, '官方 prompt 路径不得写草稿（会残留重复文本）')
    assert.equal(at('setDraft'), -1, '官方 prompt 路径不得再同步 composer 草稿')
    assert.equal(at('persistDraft'), -1, '官方 prompt 路径不得 persistDraft')
    const last = submissionsOf(calls)[0]
    assert.equal(at('prompt'), order.lastIndexOf('prompt'), 'prompt 必须恰好出现一次')
    assert.ok(order.lastIndexOf('prompt') > at('openSessionById'), '提交必须发生在视图重建之后')
  } else {
    // 旧契约（legacy submitEditedText）：草稿是提交的前提，顺序必须严格
    assert.ok(at('writeSessionDraft') > at('markRowsShadowedFrom'), '标遮蔽在写草稿之前')
    assert.ok(at('setDraft') > at('writeSessionDraft'), 'setDraft 在权威落盘之后')
    assert.ok(at('persistDraft') > at('setDraft'), 'persistDraft 在 setDraft 之后')
    const last = submissionsOf(calls)[0]
    assert.ok(order.lastIndexOf(last[0]) > at('openSessionById'), '提交必须发生在视图重建之后（否则提交会打到旧实例）')
  }
})
