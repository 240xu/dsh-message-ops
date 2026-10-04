/**
 * dsh-message-ops — 新功能零依赖测试（node --test）。
 * 覆盖：export Markdown、restore 重放规划/落定、message_ops 工具构造与
 * 容错注册（缺 tools 服务 / 缺 dsh-tools 包均不 fatal）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const { OpsError, planRestore, applyRestore, exportMarkdown, messageText } =
  await import('../src/ops-core.js')
const { createMessageOpsTool, apply } = await import('../src/index.js')

function msg(type, seq, text, role) {
  return {
    type, seq, time: Date.now(), surfaceOp: 'append',
    data: { turn: 1, message: { role: role || (type === 'user/message' ? 'user' : 'assistant'), content: [{ type: 'text', text }] } },
  }
}

function sampleEvents() {
  return [
    msg('user/message', 0, '第一问'),
    msg('assistant/message', 1, '第一答'),
    { type: 'tool/call', seq: 2, data: { name: 'bash', call: { name: 'bash', arguments: { command: 'ls' } } } },
    msg('user/message', 3, '第二问'),
    msg('assistant/message', 4, '第二答'),
    // 一次 revert 落定：遮蔽 3..4，sourceEventSeqs 覆盖被遮蔽节点
    {
      type: 'system/message', seq: 5, time: Date.now(),
      surfaceOp: { op: 'replace', startSeq: 3, endSeq: 4 },
      sourceEventSeqs: [3, 4],
      data: { message: { role: 'system', content: [{ type: 'text', text: '[消息回滚] 已回滚到 seq 3（含）之后的 2 个节点' }] } },
    },
  ]
}

const header = { type: 'session', version: 3, id: 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', createdAt: 1, cwd: '/tmp/x' }

// --- exportMarkdown ----------------------------------------------------------

test('exportMarkdown：消息按角色小节展开，工具调用折叠为单行', () => {
  const md = exportMarkdown(header, sampleEvents())
  assert.match(md, /^# DSH 会话导出：session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/m)
  assert.match(md, /## \[seq 0\] user\n\n第一问/)
  assert.match(md, /## \[seq 1\] assistant\n\n第一答/)
  // 工具调用是单行引用，且含参数提示
  const toolLines = md.split('\n').filter((l) => l.startsWith('> [seq 2]'))
  assert.equal(toolLines.length, 1)
  assert.match(toolLines[0], /🔧 工具调用：bash/)
  assert.match(toolLines[0], /command/)
  // revert 标记本身是 system 消息，也展开
  assert.match(md, /## \[seq 5\] system/)
})

test('exportMarkdown：seq 上界只导出 ≤ 上界的事件', () => {
  const md = exportMarkdown(header, sampleEvents(), 1)
  assert.match(md, /seq ≤ 1/)
  assert.match(md, /第一问/)
  assert.doesNotMatch(md, /第二问/)
  assert.doesNotMatch(md, /工具调用：bash/)
})

test('exportMarkdown：非法 seq 抛 OpsError(400)', () => {
  assert.throws(() => exportMarkdown(header, sampleEvents(), -1), (e) => e instanceof OpsError && e.status === 400)
  assert.throws(() => exportMarkdown(header, sampleEvents(), 1.5), OpsError)
})

// --- planRestore / applyRestore ----------------------------------------------

test('planRestore：从 revert 标记事件规划重放（含 user/assistant，跳过 tool）', () => {
  const plan = planRestore(sampleEvents(), 5)
  assert.equal(plan.startSeq, 3)
  assert.equal(plan.endSeq, 4)
  assert.equal(plan.replayable.length, 2)
  assert.equal(plan.skipped, 0)
  assert.deepEqual(plan.replayable.map((r) => [r.role, r.seq, r.text]), [
    ['user', 3, '第二问'],
    ['assistant', 4, '第二答'],
  ])
})

test('planRestore：兼容 start/end 拼写（dsh-src 较新引擎形状）', () => {
  const events = [
    msg('user/message', 0, 'a'),
    { type: 'system/message', seq: 1, surfaceOp: { op: 'replace', start: 0, end: 0 }, sourceEventSeqs: [0] },
  ]
  const plan = planRestore(events, 1)
  assert.equal(plan.startSeq, 0)
  assert.equal(plan.replayable[0].text, 'a')
})

test('planRestore：非标记事件 / 越界 seq 拒绝；空可重放区间改为接受（0.5.6 停用语义）', () => {
  const events = sampleEvents()
  assert.throws(() => planRestore(events, 99), (e) => e instanceof OpsError && e.status === 404)
  assert.throws(() => planRestore(events, 0), (e) => e instanceof OpsError && e.status === 409) // 普通消息非标记
  assert.throws(() => planRestore(events, -1), (e) => e instanceof OpsError && e.status === 400)
  // 0.5.6：区间内只有 tool 事件 → 不再 409，返回空可重放计划（停用语义）
  const onlyTool = [
    { type: 'tool/call', seq: 0, data: { name: 'bash' } },
    { type: 'system/message', seq: 1, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, sourceEventSeqs: [0] },
  ]
  const plan = planRestore(onlyTool, 1)
  assert.equal(plan.replayable.length, 0, '空可重放 = 接受为停用计划')
  assert.equal(plan.startSeq, 0)
})

test('applyRestore：重放 append 带 [恢复] 前缀 + system 说明，flush 被调用', () => {
  const appended = []
  let seq = 10
  const session = {
    append(type, data, opts) {
      const event = { seq: seq++, type, data, opts }
      appended.push(event)
      return event
    },
  }
  const plan = planRestore(sampleEvents(), 5)
  let flushed = 0
  const result = applyRestore(session, plan, { flush: () => flushed++ })
  assert.equal(flushed, 1)
  assert.equal(result.restoredCount, 2)
  assert.equal(result.skipped, 0)
  assert.equal(appended.length, 3)
  assert.equal(appended[0].type, 'system/message')
  assert.match(appended[0].data.message.content[0].text, /\[消息恢复\] 重放 seq 3\.\.4 的 2 条消息/)
  assert.equal(appended[1].type, 'user/message')
  assert.equal(appended[1].data.message.content[0].text, '[恢复] 第二问')
  assert.equal(appended[2].data.message.content[0].text, '[恢复] 第二答')
  for (const a of appended) assert.equal(a.opts.surfaceOp, 'append')
})

test('messageText：数组 content 提取首个非空 text；data.content 兼容', () => {
  assert.equal(messageText(msg('user/message', 0, 'hi')), 'hi')
  assert.equal(messageText({ type: 'user/message', data: { content: [{ type: 'text', text: 'legacy' }] } }), 'legacy')
  assert.equal(messageText({ type: 'user/message', data: {} }), '')
})

// --- message_ops 工具（桩 defineTool + 桩 ops） --------------------------------

function stubDefineTool(def) {
  def.__compiled = true
  return def
}

test('createMessageOpsTool：defineTool 桩拿到 name/parameters/execute，execute 分发到 ops', async () => {
  const calls = []
  const ops = {
    list: (ctx, id) => { calls.push(['list', id]); return { ok: true, session: { id }, running: false, total: 0, visibleCount: 0, messages: [] } },
    revert: (ctx, id, seq) => { calls.push(['revert', id, seq]); return { mode: 'revert', seq, shadowedCount: 2, eventSeq: 9 } },
  }
  const tool = createMessageOpsTool({ defineTool: stubDefineTool, ops, ctx: {} })
  assert.equal(tool.name, 'message_ops')
  assert.ok(tool.__compiled)
  assert.equal(tool.parameters.action.enum.length, 6)
  assert.ok(tool.parameters.sessionId.required)
  const out = await tool.execute({ action: 'list', sessionId: 'session-x' })
  assert.match(out, /session session-x/)
  const out2 = await tool.execute({ action: 'revert', sessionId: 'session-x', seq: 3 })
  assert.match(out2, /revert ok: shadowed 2 node\(s\) from seq 3; marker event seq 9/)
  assert.deepEqual(calls[1], ['revert', 'session-x', 3])
})

test('createMessageOpsTool：execute 捕获 OpsError 为失败文本而非抛出', async () => {
  const ops = { delete: () => { throw new OpsError('seq 3 not visible on current surface', 409) } }
  const tool = createMessageOpsTool({ defineTool: stubDefineTool, ops, ctx: {} })
  const out = await tool.execute({ action: 'delete', sessionId: 'session-x', seq: 3 })
  assert.match(out, /^delete failed: seq 3 not visible/)
})

// --- index.js apply：工具注册容错（不 fatal） ----------------------------------

function mockCtx({ tools, webServer } = {}) {
  const registrations = []
  const injects = []
  const host = { register: (route) => registrations.push(route) }
  return {
    registrations, injects, host,
    get(key) {
      if (key === 'webServer') return webServer === undefined ? undefined : webServer
      if (key === 'tools') return tools
      return undefined
    },
    inject(deps, fn) { injects.push([deps, fn]) },
    effect(fn) { return fn() },
  }
}

test('apply：无 webServer、无 tools 时走 inject 等待，不抛错', () => {
  const ctx = mockCtx()
  assert.doesNotThrow(() => apply(ctx))
  assert.deepEqual(ctx.injects.map((i) => i[0]), [['webServer'], ['tools']])
  assert.equal(ctx.registrations.length, 0)
})

test('apply：webServer 存在时注册全部 7 条路由；tools 缺失走 inject 等待', () => {
  const ctx = mockCtx({ webServer: { register: (route) => ctx.registrations.push(route) } })
  assert.doesNotThrow(() => apply(ctx))
  const paths = ctx.registrations.map((r) => r.path).sort()
  assert.deepEqual(paths, [
    '/api/message-ops/branch',
    '/api/message-ops/delete',
    '/api/message-ops/export',
    '/api/message-ops/messages',
    '/api/message-ops/restore',
    '/api/message-ops/revert',
    '/api/message-ops/text',
  ])
  // tools 缺失 → 容错等待而非 fatal
  assert.ok(ctx.injects.some(([deps]) => deps[0] === 'tools'))
})

test('apply：tools 服务存在时直接进入注册路径（包缺失时 catch 静默跳过）', () => {
  const registered = []
  const ctx = mockCtx({ webServer: { register: () => {} }, tools: { register: (t) => registered.push(t) } })
  assert.doesNotThrow(() => apply(ctx))
  // 动态 import('@deepseek-ai/dsh-tools') 在本测试环境不可解析 → 工具跳过，
  // 但绝不能让插件 apply 抛错；异步分支也不能产生未处理拒绝。
  assert.equal(registered.length, 0)
})

// ── 0.5.2 回归：工具层必须 await async ops（0.2.1 改 async 后曾漏同步化，
//    list/restore 抛 TypeError、export 渲出空 text；旧桩是同步的故漏检）──────
test('工具 execute：async ops 被 await（list/branch/restore/export 全路径）', async () => {
  let def
  const defineTool = (d) => { def = d; return d }
  const asyncOps = {
    list: async () => ({ session: { id: 'session-abc', parentSession: null }, running: false, total: 1, visibleCount: 1,
      messages: [{ seq: 10, role: 'user', visible: true, snippet: 'hello' }] }),
    revert: async () => ({ mode: 'revert', shadowedCount: 2, seq: 10, eventSeq: 99 }),
    delete: async () => ({ mode: 'delete', shadowedCount: 1, seq: 10, eventSeq: 98 }),
    branch: async () => ({ newId: 'session-child', keptEvents: 42, parentSession: undefined }),
    restore: async () => ({ restoredCount: 1, skipped: 0, range: { startSeq: 5, endSeq: 6 }, eventSeqs: [7, 8] }),
    export: async () => ({ markdown: '# md' }),
  }
  createMessageOpsTool({ defineTool, ops: asyncOps, ctx: {} })
  assert.ok(def, 'tool defined')
  const outList = await def.execute({ action: 'list', sessionId: 'session-abc' })
  assert.match(String(outList), /session session-abc/)
  assert.doesNotMatch(String(outList), /failed:/)
  const outBranch = await def.execute({ action: 'branch', sessionId: 'session-abc', upToSeq: 10 })
  // 0.5.2 P2：branch 渲染读 keptEvents + parentSession（注入自入参），不再读不存在的 kept/parentId
  assert.match(String(outBranch), /kept 42 event/)
  assert.match(String(outBranch), /parent session-abc/)
  const outRestore = await def.execute({ action: 'restore', sessionId: 'session-abc', seq: 6 })
  assert.match(String(outRestore), /replayed 1 message/)
  const outExport = await def.execute({ action: 'export', sessionId: 'session-abc' })
  assert.equal(String(outExport), '# md')
  // 同步抛出的 ops 仍走错误文案路径
  const errTool = await (async () => {
    let d2
    createMessageOpsTool({ defineTool: (x) => { d2 = x }, ops: { list: () => { throw new Error('boom') } }, ctx: {} })
    return d2.execute({ action: 'list', sessionId: 'session-abc' })
  })()
  assert.match(String(errTool), /list failed: boom/)
})

// ── 0.5.4 P0 回归：system/message 必须带正 turn/step（0.2.0 v4 准入收紧，
//    缺字段 → 持久层 encodeEventBatch 未捕获 → **整个 dsh 进程 exit=1**）────
test('applySurfaceReplace/applyRestore 附带正整数 turn/step（v4 准入）', async () => {
  const { applySurfaceReplace, applyRestore, deriveTurnStep } = await import('../src/ops-core.js');
  const appended = [];
  const fakeSession = { append: (type, data, opts) => { appended.push({ type, data, opts }); return { seq: 999 }; } };
  // 1) deriveTurnStep：尾部回溯 / 兜底
  assert.deepEqual(deriveTurnStep([{ data: { turn: 7, step: 3 } }]), { turn: 7, step: 3 });
  assert.deepEqual(deriveTurnStep([{ data: {} }, { data: { turn: 2, step: 5 } }]), { turn: 2, step: 5 });
  assert.deepEqual(deriveTurnStep([]), { turn: 1, step: 1 });
  assert.deepEqual(deriveTurnStep(undefined), { turn: 1, step: 1 });
  // 2) revert/delete 通知
  applySurfaceReplace(fakeSession, 10, 20, [10], '[消息回滚] x', { turn: 9, step: 4 });
  assert.equal(appended[0].type, 'system/message');
  assert.ok(appended[0].data.turn > 0 && Number.isInteger(appended[0].data.turn), 'data.turn 正整数');
  assert.ok(appended[0].data.step > 0 && Number.isInteger(appended[0].data.step), 'data.step 正整数');
  assert.ok(typeof appended[0].data.message.id === 'string' && appended[0].data.message.id.length > 0, 'message.id 非空字符串（v4 准入第 3 关）');
  // 无坐标参数时兜底 1/1（调用方漏传不致崩）
  applySurfaceReplace(fakeSession, 10, 20, [10], 'x2');
  assert.ok(appended[1].data.turn >= 1 && appended[1].data.step >= 1);
  // 3) restore 通知（plan.turnStep）
  applyRestore(fakeSession, {
    restoreSeq: 5, startSeq: 1, endSeq: 3, skipped: 0, turnStep: { turn: 12, step: 6 },
    replayable: [{ type: 'user/message', role: 'user', text: 'hi' }],
  });
  const notice = appended[2];
  assert.equal(notice.type, 'system/message');
  assert.equal(notice.data.turn, 12);
  assert.equal(notice.data.step, 6);
});

// 0.5.6 回归：空可重放区间 → 优雅停用而非 409（dock 死按钮修复）
test('planRestore 空可重放区间返回空计划；applyRestore 发停用 notice', async () => {
  const { planRestore, applyRestore } = await import('../src/ops-core.js');
  // 事件流：startSeq..endSeq 内只有一条 tool 事件（非 user/assistant）
  const events = [
    { seq: 1, type: 'system/message', data: { turn: 1, step: 1, message: {} } },
    { seq: 8, type: 'tool/result', data: { message: {} } },
    { seq: 9, type: 'system/message', data: { turn: 1, step: 2, message: {} },
      surfaceOp: { op: 'replace', startSeq: 8, endSeq: 8 } },
  ];
  const plan = planRestore(events, 9);
  assert.equal(plan.replayable.length, 0, '无可重放');
  assert.equal(plan.startSeq, 8);
  const appended = [];
  const fakeSession = { append: (type, data, opts) => { appended.push({ type, data, opts }); return { seq: 42 }; } };
  const out = applyRestore(fakeSession, plan);
  assert.equal(out.restoredCount, 0);
  // notice 停用 + restoresSeq 指向标记（dock 由此移除该行）
  assert.equal(appended.length, 1, '只发 notice');
  assert.equal(appended[0].data.restoresSeq, 9);
  assert.match(appended[0].data.message.content[0].text, /无可重放/);
  assert.ok(appended[0].data.turn > 0 && appended[0].data.message.id, 'v4 准入字段齐');
});

// ── 0.5.7 磁盘路径回归：字段镜像引擎金标准 + 计划语义一致 ──────────────────
test('磁盘计划/构建器：可见节点剔除遮蔽、marker 字段逐项镜像金标准', async () => {
  const core = await import('../src/ops-core.js');
  // 事件流：user10 → assistant11 → step/end12（非节点）→ 既有标记 13 遮蔽 11
  const events = [
    { type: 'user/message', seq: 10, data: { message: { role: 'user', content: [] } } },
    { type: 'assistant/message', seq: 11, data: { message: { role: 'assistant', content: [] } } },
    { type: 'step/end', seq: 12, data: {} },
    { type: 'system/message', seq: 13, data: { turn: 1, step: 1, message: {} },
      surfaceOp: { op: 'replace', startSeq: 11, endSeq: 11 }, sourceEventSeqs: [11] },
    { type: 'user/message', seq: 14, data: { message: { role: 'user', content: [] } } },
  ];
  // 可见节点 = [10, 14]（11 已遮蔽；12 非 message；13 是标记本身也是 system 可见）
  const nodes = core.diskVisibleNodes(events);
  assert.deepEqual(nodes, [10, 13, 14], '剔除遮蔽 + 只取 message 类: ' + JSON.stringify(nodes));
  // revert at 14 → 遮蔽 [14]（末尾）
  const plan = core.planRevertFromEvents(events, 14);
  assert.deepEqual(plan.shadowedSeqs, [14]);
  assert.equal(plan.endSeq, 14);
  // revert at 10 → 遮蔽 [10, 13, 14]
  const plan2 = core.planRevertFromEvents(events, 10);
  assert.deepEqual(plan2.shadowedSeqs, [10, 13, 14]);
  // 不可见 seq → 409
  assert.throws(() => core.planRevertFromEvents(events, 11), (e) => e.status === 409);
  // nextSeq
  assert.equal(core.nextSeqFrom(events), 15);
  // marker 构建器字段镜像（对照引擎金标准形状）
  const ev = core.buildMarkerEvent({
    seq: 15, time: 1791105740958, turnStep: { turn: 9, step: 6 }, text: 'x',
    startSeq: 14, endSeq: 14, shadowedSeqs: [14],
  });
  assert.deepEqual(Object.keys(ev), ['type', 'seq', 'time', 'data', 'sourceEventSeqs', 'surfaceOp'], '根键序镜像');
  assert.equal(ev.type, 'system/message');
  assert.equal(ev.data.turn, 9);
  assert.equal(ev.data.step, 6);
  assert.ok(ev.data.message.id.length > 0);
  assert.equal(ev.data.message.role, 'system');
  assert.deepEqual(ev.data.message.content[0], { type: 'text', text: 'x' });
  assert.deepEqual(ev.sourceEventSeqs, [14]);
  assert.deepEqual(ev.surfaceOp, { op: 'replace', startSeq: 14, endSeq: 14 });
  assert.equal(Object.keys(ev.surfaceOp).length, 3, 'replace op 恰好 3 键（引擎 isReplaceOp）');
  // restore notice + replay 镜像
  const nt = core.buildRestoreNoticeEvent({ seq: 16, time: 2, turnStep: { turn: 9, step: 6 }, text: 'n', restoreSeq: 13 });
  assert.equal(nt.surfaceOp, 'append');
  assert.equal(nt.data.restoresSeq, 13);
  const rp = core.buildReplayEvent({ seq: 17, time: 3, item: { type: 'user/message', role: 'user', text: 'hi' } });
  assert.equal(rp.surfaceOp, 'append');
  assert.deepEqual(rp.data.message, { role: 'user', content: [{ type: 'text', text: '[恢复] hi' }] });
  assert.ok(!('id' in rp.data.message), '重放镜像引擎：不带 id');
});
