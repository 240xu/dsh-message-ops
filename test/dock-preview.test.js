/**
 * 0.10.2 的三处改动锁（审计 F1/F6/F7 —— 它们此前**零测试覆盖**，
 * 把 src/index.js 的 kind 过滤与 preview reduce 整体还原成 0.10.1 写法，
 * 原 147 条仍全绿，也就是「147/147」根本没背书这次改动）。
 *
 * F1 · dock 无宿主侧刷新触发器（最严重，且正是用户原话那个 bug）
 *   emitChanged() 5 个调用点全在插件写路径；用户用宿主输入框发消息不经过
 *   插件代码 → 不发事件 → dock 不重拉 → 「我发完消息弹窗仍在」只修了一半
 *   （0.10.1 让服务端算对了 committed，但客户端没人来取）。
 *   本文件锁住修复的三个要件：观察器存在、选择器对、首拉门控 + 卸载清理。
 *
 * F7 · seqText 排除注入行 + preview 改为轮内首条真实内容
 *   实测展开 dock 时 44 行预览里成片 `<system-reminder>` / `Agent … sent` /
 *   `Background subagent` —— 用户看到的「将恢复到这条」不是他写的话。
 *
 * F6 · dock.restoreHint 使用点 + 字典键（P0-4 的 must 列表没含它，
 *   两本字典一起删 + 删 title 行即可绕过，title 会退化成字面量 `dock.restoreHint`）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import url from 'node:url'
import { zstdCompressSync } from 'node:zlib'

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-msgops-preview-'))

const { encodeSessionFile } = await import('../src/session-file.js')
const { _internals } = await import('../src/index.js')
const { opsList } = _internals

const SID = 'session-00000000-1111-2222-3333-444444444444'

const clientSrc = fs.readFileSync(path.join(ROOT, 'src', 'client.js'), 'utf8')

/**
 * 抽出 activityTransition 纯函数并**真正执行**它（0.10.6）。
 * 手法沿用 client-perf-locks.test.js:161 的 `new Function` 抽取 —— 不引 react/jsdom。
 * 这是本仓库第一组**客户端行为锁**：前两轮审计证明形状锁可被注释墙整体绕过（W4）。
 */
function loadActivityTransition() {
  const m = clientSrc.match(/function activityTransition\(prev, next\) \{[\s\S]{0,900}?\n    \}/)
  assert.ok(m, 'src/client.js 里找不到 activityTransition —— 判定逻辑必须保持为可抽取的纯函数')
  return new Function(`${m[0]}\nreturn activityTransition`)()
}
const indexSrc = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8')

function header() {
  return { type: 'session', version: 3, id: SID, createdAt: 1, cwd: '/tmp/x', delegationDepth: 0 }
}
function msg(type, seq, text, sourceKind) {
  const m = {
    type, seq, time: 1000 + seq, surfaceOp: 'append',
    data: { turn: 1, step: 1, message: { role: type === 'user/message' ? 'user' : 'assistant', content: [{ type: 'text', text }] } },
  }
  if (sourceKind) m.data.source = { kind: sourceKind }
  return m
}

/** 造一个「轮起点是注入行」的会话：seq2 是 system-reminder 注入、seq3 是真回复。 */
function writeSession(events) {
  const logPath = path.join(process.env.DSH_HOME, 'sessions', 'proj-prev', SID, 'session.v3.jsonl.zstd')
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  fs.writeFileSync(logPath, encodeSessionFile(header(), events))
  return logPath
}

function ctxFor({ log = null } = {}) {
  const session = { id: SID, surface: { nodes: [0, 1, 2, 3] } }
  // log = 宿主内存事件日志（$B/dsh-session/lib/index.js:516 this.log）。
  // 传 null 模拟「会话不在内存里 / 读不到」→ 必须退回磁盘派生语义。
  if (log) session.log = log
  const sessions = { get: () => session, list: () => [session] }
  const agents = { get: () => ({ status: 'idle' }) }
  return { sessions, agents, get: (n) => (n === 'sessions' ? sessions : n === 'agents' ? agents : undefined) }
}

const baseEvents = [
  msg('user/message', 0, '真实问题：部署密钥是多少', 'user'),
  msg('assistant/message', 1, '回答：密钥是 ALPHA'),
  msg('user/message', 2, '<system-reminder> Updated instructions for the assistant', 'tool-jobs'),
  msg('assistant/message', 3, '这是紧跟注入行之后的真实回复'),
  {
    type: 'system/message', seq: 4, time: 1100,
    surfaceOp: { op: 'replace', startSeq: 0, endSeq: 3 },
    sourceEventSeqs: [0, 1, 2, 3],
    data: { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: '[消息回滚] 到 seq 3' }] } },
  },
]

// ---------------------------------------------------------------- F7

test('F7: 注入行（source.kind != user）不进 seqText —— 预览不再是 <system-reminder>', async () => {
  writeSession(baseEvents)
  const r = await opsList(ctxFor(), SID)
  const turns = (r.messages.find((m) => m.marker) || {}).pendingTurns || []
  assert.ok(turns.length > 0, '必须有待恢复轮')
  // pendingTurns 只产出 {upTo, count, preview}（无 turnSeq），按内容断言
  assert.deepEqual(turns.map((t) => ({ upTo: t.upTo, count: t.count })),
    [{ upTo: 1, count: 2 }, { upTo: 3, count: 2 }],
    `轮切分应为 [0,1] 与 [2,3]，实际 ${JSON.stringify(turns)}`)
  const previews = turns.map((t) => t.preview)
  assert.ok(!previews.some((p) => /system-reminder/i.test(p)),
    `预览不得含注入文案，实际：${JSON.stringify(previews)}`)
  // 轮一（起点 seq0 真人输入）→ 预览取真实用户文案
  assert.match(previews[0], /部署密钥/, `轮一预览应取真实用户文案，实际 "${previews[0]}"`)
  // 轮二（起点 seq2 是注入行）→ 必须落到同轮的真实回复 seq3，而非 <system-reminder>
  assert.match(previews[1], /真实回复/,
    `轮二起点是注入行，预览应落到同轮真实内容，实际 "${previews[1]}"`)
})

test('F7: 全注入轮（seqs 里没有真实内容）→ 诚实回退 #seq，不编造文案', async () => {
  writeSession([
    msg('user/message', 0, '真实问题', 'user'),
    msg('assistant/message', 1, '真实回答'),
    msg('user/message', 2, '<system-reminder> only injected here', 'tool-jobs'),
    {
      type: 'system/message', seq: 3, time: 1100,
      surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 },
      sourceEventSeqs: [2],
      data: { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: '[消息回滚] 到 seq 2' }] } },
    },
  ])
  const r = await opsList(ctxFor(), SID)
  const turns = (r.messages.find((m) => m.marker) || {}).pendingTurns || []
  assert.equal(turns.length, 1, `应只有 1 个待恢复轮，实际 ${turns.length}`)
  assert.equal(turns[0].preview, '#2', `全注入轮应回退 #seq，实际 "${turns[0].preview}"`)
})

test('F7: 无 marker 的会话 → pendingTurns 空（seqText 短路，preview reduce 不执行）', async () => {
  writeSession([
    msg('user/message', 0, '只有一句', 'user'),
    msg('assistant/message', 1, '只有一答'),
  ])
  const r = await opsList(ctxFor(), SID)
  assert.equal(r.messages.filter((m) => m.marker).length, 0)
  assert.equal(r.messages.filter((m) => m.pendingTurns).length, 0)
})

// ---------------------------------------------------------------- F1

test('F1: 宿主 activity 信号 → 重拉（复审后主路径）', () => {
  // ⚠️ 诚实标注：以下是**形状锁**（源码字符串），不是行为锁。client.js 是
  // factory+require 包裹的 React 组件，node --test 无法执行。服务端行为由
  // 「(C) live.log 补算」那几条真实 opsList 测试背书。
  const rd = clientSrc.slice(clientSrc.indexOf('function RevertDock'))
  assert.match(rd, /\}, \[activityAt\]\)/, 'RevertDock 必须有依赖 [activityAt] 的 effect')
  const act = rd.match(/useEffect\(\(\) => \{[\s\S]{0,2500}?\}, \[activityAt\]\)/)
  assert.ok(act, '找不到 activityAt effect 本体')
  assert.match(act[0], /loadRef\.current\(\)/, 'activity effect 必须触发 loadRef')

  // 3) 基线门控 —— **收紧到整条一行**（上一轮实测：只删掉句尾的 `return`
  //    语义就断掉，而逐行断言仍绿 → 假锁 A11）。
  // 3) 判定语义改由**行为测试**覆盖（见文件头的 loadActivityTransition），
  //    这里只锁 effect 确实消费了该纯函数
  assert.match(act[0], /activityTransition\(lastActivityRef\.current, activityAt\)/,
    'effect 必须调用 activityTransition 纯函数（判定逻辑不得再内联）')
  assert.match(act[0], /if \(step\.reload\) loadRef\.current\(\)/, '只有 reload=true 才触发 loadRef')
  // 3b) 切会话重置基线。**R1（架构审计）**：原为 `= undefined`，但若切会话时
  //     activityAt 不变（createdAt 同毫秒 / 都 null），下游 effect 依赖未变不执行
  //     → 基线永远 undefined → **切会话后用户第一条消息被吞，无 reload**（原 bug 上移）。
  //     必须重置到「当前」值而不是 undefined。
  assert.match(rd, /useEffect\(\(\) => \{ lastActivityRef\.current = activityAt \}, \[sessionId, activityAt\]\)/,
    '切会话必须把 activity 基线重置为**当前** activityAt（置 undefined 会吞掉切会话后的第一条消息）')
  // 3b2) **R2（架构审计）**：无请求序号 → 并发 load 乱序响应会把 dock 打回去。
  //      0.10.4 的延迟定时器事实上起到了串行化作用，删除后重叠概率上升。
  assert.match(rd, /const reqSeqRef = useRef\(0\)/, '必须有请求序号 ref（防乱序响应覆盖 markers）')
  assert.match(rd, /const reqSeq = \+\+reqSeqRef\.current/, 'load() 必须领取请求序号')
  assert.match(rd, /if \(reqSeq !== reqSeqRef\.current\) return/, '只有最新请求的结果才允许落地')
  // 3c) **M3 补锁收紧**：上一轮实测把赋值塞进 `if (false) {}` 死分支仍绿（假锁 A10）。
  //     用**行首缩进精确到 8 空格**约束它必须位于 effect 主体顶层。
  assert.match(rd, /^ {8}loadRef\.current = load$/m, 'loadRef 必须赋值为 load，且位于 effect 主体顶层（非死分支/注释）')
  assert.match(rd, /useRef\(undefined\)/, 'lastActivityRef 必须用 undefined 表示未建基线')
  assert.match(rd, /summary && typeof summary\.updatedAt === 'number'/, 'activityAt 必须取自 summary.updatedAt')

  // 4) **A7 补锁**：`activeMarkers` 的**调用点**（不是定义体）。上一轮实测把
  //    `const act = activeMarkers(msgs)` 换成 naive filter（不排 committed，
  //    正是用户原话 bug 的客户端半边）仍 157 条全绿。
  const eff = rd.match(/const load = \(\) => \{[\s\S]{0,2500}?\.catch\(\(\) => \{\}\)\n        \}/)
  assert.ok(eff, '找不到 load 本体')
  assert.match(eff[0], /const act = activeMarkers\(msgs\)/, 'load 必须用 activeMarkers(msgs) 过滤出活跃 marker')
  assert.match(eff[0], /setMarkers\(act\)/, 'setMarkers 必须吃 activeMarkers 的结果（不能吃未过滤的 msgs）')
})

test('F1: load() 必须先失效 1000ms 共用窗（R1 —— 否则复用旧 settled 响应，弹窗不清）', () => {
  const rd = clientSrc.slice(clientSrc.indexOf('function RevertDock'))
  const load = rd.match(/const load = \(\) => \{[\s\S]{0,400}?fetchMessagesJson\(/)
  assert.ok(load, '找不到 dock 的 load 定义')
  const invalidateAt = load[0].indexOf('invalidateMessagesMemo()')
  const fetchAt = load[0].indexOf('fetchMessagesJson(')
  assert.ok(invalidateAt >= 0, 'load() 未调用 invalidateMessagesMemo')
  assert.ok(invalidateAt < fetchAt, 'invalidateMessagesMemo 必须在 fetchMessagesJson **之前**')
  assert.ok(!/USER_NODE_SEL/.test(rd), '观察器选择器残留')
  assert.ok(!/ACTIVITY_DELAYS/.test(rd), '固定延迟已随 (C) 根治删除（延迟重拉不再是正确性依赖）')
})

// ---------------------------------------------------------------- F6

test('F6: dock.restoreHint 双字典存在 + 使用点存在（P0-4 的 must 列表不含它）', () => {
  const keys = [...clientSrc.matchAll(/'dock\.restoreHint':\s*'([^']*)'/g)].map((x) => x[1])
  assert.equal(keys.length, 2, `zh/en 两本字典都须有 dock.restoreHint，实际 ${keys.length} 处`)
  assert.ok(keys[0].length > 0 && keys[1].length > 0, '文案不得为空')
  assert.match(clientSrc, /title:\s*t\('dock\.restoreHint'\)/, 'restore 按钮缺少 title 使用点')
})

test('F6: 0.10.2 两处核心改动确实存在于源码（防止被整体回退仍绿）', () => {
  assert.match(indexSrc, /\)\.kind !== "user"\) continue/, 'seqText 的注入行过滤被移除')
  assert.match(indexSrc, /t\.seqs\.reduce\(/, 'preview 的轮内扫描被还原成 seqText.get(t.turnSeq)')
})


// ------------------------------------------------- markCommitted 接线真锁
//
// 上一轮复审沙箱实测：把 `src/index.js` 的 `markCommitted(messages);` 整行删掉，
// 154 条测试仍全绿 —— 0.10.1 的头号修复只有函数级单测（revert-commit.test.js
// 直接 import 调用），没有任何测试断言 **opsList 端到端**返回 committed。
// 这两条是行为锁：删掉那行接线立刻红。
test('接线真锁: marker 之后有真实用户输入 → opsList 返回 committed=true', async () => {
  writeSession([
    msg('user/message', 0, '旧问题', 'user'),
    msg('assistant/message', 1, '旧回答'),
    {
      type: 'system/message', seq: 2, time: 1100,
      surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 },
      sourceEventSeqs: [0, 1],
      data: { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: '[消息回滚] 到 seq 1' }] } },
    },
    // 用户改完发出新消息 → 应触发 commit（对齐 opencode: session.ts:165）
    msg('user/message', 3, '改完重发的新消息', 'user'),
  ])
  const r = await opsList(ctxFor(), SID)
  const mk = r.messages.find((x) => x.marker === true)
  assert.ok(mk, '应存在 marker')
  assert.equal(mk.committed, true,
    'marker 之后有 kind:user 的真实输入 → committed 必须为 true（删掉 markCommitted 接线即红）')
})

test('接线真锁: 无后续用户输入 → committed=false（dock 应显示）', async () => {
  writeSession([
    msg('user/message', 0, '旧问题', 'user'),
    msg('assistant/message', 1, '旧回答'),
    {
      type: 'system/message', seq: 2, time: 1100,
      surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 },
      sourceEventSeqs: [0, 1],
      data: { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: '[消息回滚] 到 seq 1' }] } },
    },
  ])
  const r = await opsList(ctxFor(), SID)
  const mk = r.messages.find((x) => x.marker === true)
  assert.equal(mk.committed, false, '无后续真实输入 → committed 必须 false')
})

test('接线真锁: 注入行（非 kind:user）不得触发 commit', async () => {
  writeSession([
    msg('user/message', 0, '旧问题', 'user'),
    msg('assistant/message', 1, '旧回答'),
    {
      type: 'system/message', seq: 2, time: 1100,
      surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 },
      sourceEventSeqs: [0, 1],
      data: { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: '[消息回滚] 到 seq 1' }] } },
    },
    // system-reminder / tool-jobs 之类注入行不得被当作「用户发了新消息」
    msg('user/message', 3, '<system-reminder> Updated instructions', 'tool-jobs'),
  ])
  const r = await opsList(ctxFor(), SID)
  const mk = r.messages.find((x) => x.marker === true)
  assert.equal(mk.committed, false, '注入行不得触发 commit')
})

// ------------------------------------------------- R2 前提：落盘后缓存失效
//
// R2（复审推翻原「闪一下」定性）：宿主 append 后**同步** emit activity
// （$B/dsh-api-session-controller/lib/index.js:2890-2896），而落盘是**异步批窗**
// （$B/dsh-session/lib/index.js:1406 "hot path never blocks on I/O"；
// persistence-jsonl:187 buffered/batchTimer）。
// 客户端 GET 读磁盘 + derivedCache 按 mtimeMs+size 失效（src/index.js:376），
// 拉取链 ≈30-150ms **几乎必然早于落盘** → markCommitted 看不到新 user 消息 →
// committed 仍是 false；而 updatedAt 每条消息只跳变一次，**没有第二次触发**。
//
// 本组锁住「重试能生效」的那个前提：**落盘发生后，派生缓存必须失效并翻转
// committed**。若这条不成立，客户端重试多少次都没用。
test('R2 前提: 落盘追加后派生缓存失效 → committed 翻转 true', async () => {
  writeSession([
    msg('user/message', 0, '旧问题', 'user'),
    msg('assistant/message', 1, '旧回答'),
    {
      type: 'system/message', seq: 2, time: 1100,
      surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 },
      sourceEventSeqs: [0, 1],
      data: { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: '[消息回滚] 到 seq 1' }] } },
    },
  ])
  const logPath = path.join(process.env.DSH_HOME, 'sessions', 'proj-prev', SID, 'session.v3.jsonl.zstd')

  // 第一次：落盘前（模拟 activity 已到、批窗未刷）→ 派生缓存填的是未提交态
  const before = await opsList(ctxFor(), SID)
  assert.equal(before.messages.find((x) => x.marker === true).committed, false,
    '落盘前应 committed=false（这正是 R2 的病灶）')

  // 模拟批窗 flush：追加一帧真实用户输入（size 必变 → 缓存必然失效）
  const jsonl = JSON.stringify(msg('user/message', 3, '改完重发的新消息', 'user')) + '\n'
  fs.appendFileSync(logPath, zstdCompressSync(Buffer.from(jsonl, 'utf8')))

  // 第二次：落盘后 → 缓存必须重算，committed 翻转
  const after = await opsList(ctxFor(), SID)
  assert.equal(after.messages.find((x) => x.marker === true).committed, true,
    '落盘追加后 derivedCache 必须失效并把 committed 翻成 true —— 否则客户端重试无效')
})

// ------------------------------------------------- (C) live.log 补算 committed
//
// R2 的根治（服务端侧）。宿主 append 后**同步** emit activity，落盘是**异步批窗**
// （$B/dsh-session/lib/index.js:1406；persistence-jsonl:187，批窗 200ms）。
// 磁盘派生 + derivedCache(mtime+size) 因此在批窗内是陈旧的 → markCommitted 看不到
// 刚发出的 user 消息 → 弹窗不清。
//
// 根治：live Session 暴露内存日志 this.log（$B/dsh-session/lib/index.js:516），
// 元素与磁盘事件同构（:1454-1459）→ opsList 用它补算 committed，客户端不再需要
// 靠「延迟重拉」赌落盘已完成。
//
// **这组是行为锁**（走真实 opsList + 真实会话文件），不是源码字符串锁。

const MARKER_SESSION = () => [
  msg('user/message', 0, '旧问题', 'user'),
  msg('assistant/message', 1, '旧回答'),
  {
    type: 'system/message', seq: 2, time: 1100,
    surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 },
    sourceEventSeqs: [0, 1],
    data: { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: '[消息回滚] 到 seq 1' }] } },
  },
]
const liveUser = (seq, kind = 'user') => ({ type: 'user/message', seq, time: 2000, data: { source: { kind }, message: { role: 'user', content: [{ type: 'text', text: '改完重发' }] } } })
const markerCommitted = (r) => r.messages.find((x) => x.marker === true).committed

test('(C) 落盘批窗内：磁盘还没有新消息，但 live.log 有 → committed 必须 true', async () => {
  writeSession(MARKER_SESSION())          // 磁盘上只有 marker，之后什么都没有
  const r = await opsList(ctxFor({ log: [liveUser(3)] }), SID)
  assert.equal(markerCommitted(r), true,
    'live.log 里 marker 之后有真实用户输入 → 必须补算成 committed（这正是 R2 病灶的解药）')
})

test('(C) 无 live.log（会话不在内存 / 读不到）→ 退回磁盘语义 committed=false', async () => {
  writeSession(MARKER_SESSION())
  const r = await opsList(ctxFor(), SID)   // 不传 log
  assert.equal(markerCommitted(r), false, '读不到 live.log 时必须退回磁盘派生值，不得凭空置 true')
})

test('(C) live.log 里只有注入行 / 重放副本 → 不得触发 commit', async () => {
  writeSession(MARKER_SESSION())
  const r = await opsList(ctxFor({ log: [liveUser(3, 'tool-jobs'), liveUser(4, 'plugin:@240xu/dsh-message-ops')] }), SID)
  assert.equal(markerCommitted(r), false, '注入行与重放副本都不是「用户发了新消息」')
})

test('(C) live.log 陈旧（seq 都小于 marker）→ 不得触发 commit', async () => {
  writeSession(MARKER_SESSION())
  const r = await opsList(ctxFor({ log: [liveUser(0)] }), SID)
  assert.equal(markerCommitted(r), false, 'live.log 不含 marker 之后的真实输入 → 不得置 true')
})

test('(C) 绝不污染派生缓存：补算后不带 live.log 再读，必须回到 false', async () => {
  writeSession(MARKER_SESSION())
  const hot = await opsList(ctxFor({ log: [liveUser(3)] }), SID)
  assert.equal(markerCommitted(hot), true, '前置：带 live.log 时应为 true')
  const cold = await opsList(ctxFor(), SID)
  assert.equal(markerCommitted(cold), false,
    'derivedCache 里的对象被改写了！这会让「本次活会话提交」泄漏到后续所有请求')
})

test('(C) live.log 乱序 / 重复 / 非事件项 → 不得抛错', async () => {
  writeSession(MARKER_SESSION())
  const noisy = [liveUser(5), null, { seq: 3 }, 'x', liveUser(3), liveUser(3)]
  const r = await opsList(ctxFor({ log: noisy }), SID)
  assert.equal(markerCommitted(r), true, '有 seq>2 的真实输入即应置 true')
})

// ------------------------------------------------- 第三轮审计点名的缺失覆盖
//
// 上一轮审计自写 19 条突变：**10 条存活**，其中两条对应真实缺陷。
// 这里逐条补上。

/**
 * 两个 marker，且**两者之间没有真实用户输入**。
 *
 * ⚠️ 场景必须这样造：`applyLiveCommitted` 的 pending 只收 `committed !== true` 的
 * marker。若两个 marker 之间夹着一条真实用户消息，磁盘侧的 `markCommitted` 就已把
 * 前一个判为 true，pending 里只剩一个 —— 此时「只补算第一个 + break」**不可观测**
 * （上一轮突变脚本正是被这个错误场景骗过，报了假存活）。只有「两 marker 相邻」时
 * 两个才同时落在 pending 里，break 才会漏掉第二个。
 */
const twoMarkers = () => {
  writeSession([
    msg('user/message', 0, '旧问题', 'user'),
    msg('assistant/message', 1, '旧回答'),
    {
      type: 'system/message', seq: 2, time: 1100,
      surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 },
      sourceEventSeqs: [0, 1],
      data: { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: '[消息回滚] 一' }] } },
    },
    // 紧接着第二个 marker：seq 3 是 system/message，不是用户输入
    {
      type: 'system/message', seq: 3, time: 1200,
      surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 },
      sourceEventSeqs: [0, 1],
      data: { turn: 2, step: 1, message: { role: 'system', content: [{ type: 'text', text: '[消息回滚] 二' }] } },
    },
  ])
}
const allMarkers = (r) => r.messages.filter((x) => x.marker === true)

test('C-b（真实 bug）: 连续回撤两次 → live.log 补算必须覆盖**全部** marker', async () => {
  twoMarkers()
  const r = await opsList(ctxFor({ log: [liveUser(9)] }), SID)
  const ms = allMarkers(r)
  assert.equal(ms.length, 2, '应有两个 marker')
  assert.deepEqual(ms.map((m) => m.committed), [true, true],
    '只补算第一个 + break 会让**第二条 dock 行在发消息后不消失** —— 用户原话的残留形态')
})

test('C-b 变体: 只补算第一个（break）时本测试必须红', async () => {
  // 这条是 C-b 的对照：若实现只补第一个 marker，上面那条会红；本条锁住「数量」语义
  twoMarkers()
  const r = await opsList(ctxFor({ log: [liveUser(9)] }), SID)
  assert.equal(allMarkers(r).filter((m) => m.committed === true).length, 2,
    '两个 marker 都必须被补算')
})

test('C-o 单调性: 磁盘已判 committed=true 的 marker 不得被补算改回 false', async () => {
  writeSession([
    msg('user/message', 0, '旧问题', 'user'),
    msg('assistant/message', 1, '旧回答'),
    {
      type: 'system/message', seq: 2, time: 1100,
      surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 },
      sourceEventSeqs: [0, 1],
      data: { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: '[消息回滚] 到 seq 1' }] } },
    },
    msg('user/message', 3, '改完重发的新消息', 'user'),   // 磁盘上就有 → markCommitted 已判 true
  ])
  // live.log 里**没有**更新的真实输入。补算必须让这个 true 原封不动。
  const r = await opsList(ctxFor({ log: [{ type: 'user/message', seq: 0, data: { source: { kind: 'user' } } }] }), SID)
  assert.equal(markerCommitted(r), true, 'committed 是只叠加的单调量，补算不得反向改写')

  // 关键：把 pending 的构造也放开（committed===true 也进 pending），
  // 此时「赋值而非条件置位」的写法就会把 true 抹成 false —— 必须红。
  // （上一轮突变脚本报它存活，是因为 pending 只收 committed!==true，写法等价。）
  const { _internals: I } = await import('../src/index.js')
  const messages = r.messages.map((m) => ({ ...m }))
  const applyMutated = (ms, live) => {
    let maxUserSeq = -1
    for (const e of live) {
      if (e.type === 'user/message' && ((e.data || {}).source || {}).kind === 'user' && e.seq > maxUserSeq) maxUserSeq = e.seq
    }
    for (const m of ms) {
      if (m.marker !== true || typeof m.seq !== 'number') continue
      m.committed = maxUserSeq > m.seq            // ← 无条件赋值（被测的坏写法）
    }
  }
  applyMutated(messages, [{ type: 'user/message', seq: 0, data: { source: { kind: 'user' } } }])
  assert.equal(messages.find((m) => m.marker === true).committed, false,
    '本用例证明「无条件赋值」在 pending 放开时确实会破坏单调性 —— 故它是等价变异，'
    + '而 pending 的 committed!==true 过滤是承重前提（由 C-g 单独锁）')
  void I
})

test('C-g 契约: 非 marker 行不得带 committed 字段', async () => {
  twoMarkers()
  const r = await opsList(ctxFor({ log: [liveUser(9)] }), SID)
  const nonMarkers = r.messages.filter((m) => m.marker !== true)
  assert.ok(nonMarkers.length > 0, '应存在非 marker 行')
  for (const m of nonMarkers) {
    assert.ok(!('committed' in m),
      `非 marker 行 seq=${m.seq} 被写上了 committed —— applyLiveCommitted 的 marker 判据被破坏`)
  }
})

test('R4 早退: 无 marker 的会话不得为了补算而扫 live.log', async () => {
  writeSession([msg('user/message', 0, '普通会话', 'user'), msg('assistant/message', 1, '普通回答')])
  const r = await opsList(ctxFor({ log: [liveUser(2), liveUser(3), liveUser(4)] }), SID)
  assert.equal(r.messages.filter((m) => m.marker === true).length, 0, '无 marker 会话')
  assert.equal(r.messages.filter((m) => 'committed' in m).length, 0, '无 marker 会话不应有任何 committed 写入')
})

test('污染锁前提: 第二次读必须真的命中派生缓存（否则该锁会静默空转）', async () => {
  const { derivedCache } = _internals
  writeSession(MARKER_SESSION())
  await opsList(ctxFor({ log: [liveUser(3)] }), SID)     // 第一次：MISS → 填缓存
  const before = derivedCache.size
  await opsList(ctxFor(), SID)                            // 第二次：必须 HIT
  assert.ok(derivedCache.size >= before, '派生缓存不应在第二次读后消失')
  // 若两次读之间清空缓存，「补算后不带 live.log 再读回到 false」就会变成
  // 「本来就没缓存所以没被污染」的同义反复 —— 这里把前提钉死。
  assert.equal(derivedCache.size, before, '第二次读必须复用同一条缓存条目（LRU 上限 16，本测试只碰 1 个 key）')
})

// ------------------------------------------------- 客户端第一组行为锁
//
// 前两轮审计的结论：客户端 F1 全是形状锁，整段注释掉 164 条仍全绿（W4 实测）。
// 这里把判定逻辑抽成纯函数 activityTransition 并**真正执行**它 —— 前三轮里
// 第一次对客户端代码做行为断言。零新依赖（new Function 抽取，同 client-perf-locks）。

const T = loadActivityTransition()

test('行为锁: activityAt 首次出现 → 只建基线，不重拉（prev=undefined）', () => {
  assert.deepEqual(T(undefined, 1000), { reload: false, baseline: 1000 })
})

test('行为锁: 基线后真实跳变 → 重拉并推进基线', () => {
  assert.deepEqual(T(1000, 2000), { reload: true, baseline: 2000 })
})

test('行为锁: null → 值（store 就绪 / lastPromptAt 投影折入）→ 不重拉', () => {
  // prev 仍是 undefined（从未见过非空值）时，这一步只该建基线
  assert.deepEqual(T(undefined, 1234), { reload: false, baseline: 1234 })
  // 已有基线后又来一个 null：不得清空基线、不得重拉
  assert.deepEqual(T(2000, null), { reload: false, baseline: 2000 })
})

test('行为锁: 单调门 —— 相等或变小 → 不重拉，且**不得把基线推回去**', () => {
  assert.deepEqual(T(2000, 2000), { reload: false, baseline: 2000 })
  const back = T(2000, 1500)
  assert.equal(back.reload, false, 'updatedAt 被压低时不得重拉')
  assert.equal(back.baseline, 2000, '基线必须**保持高水位**，否则下一次普通跳变会被误判成大跳变')
})

test('行为锁: 连续多次跳变 → 每次都重拉', () => {
  let base
  const seen = []
  for (const v of [10, 20, 30]) {
    const r = T(base, v)
    seen.push(r.reload)
    base = r.baseline
  }
  assert.deepEqual(seen, [false, true, true], '首次建基线，后两次都应重拉')
  assert.equal(base, 30)
})

test('行为锁: R1 —— 切会话重置为「当前值」而非 undefined（否则吞掉第一条消息）', () => {
  // 重置是**直接赋值**：useEffect(() => { ref = activityAt }, [sessionId, activityAt])
  const OLD_SESSION_BASE = 5000
  const NEW_SESSION_ACTIVITY = 300

  // ✅ 现行修法：重置到新会话当前的 activityAt
  let good = OLD_SESSION_BASE
  good = NEW_SESSION_ACTIVITY                      // 切会话时重置
  assert.equal(T(good, 400).reload, true,
    '切会话后的第一条真实消息必须能触发重拉')

  // ❌ 旧写法（重置为 undefined）：若切会话时 activityAt **不变**，下游 effect 的
  //    依赖未变 → 根本不执行 → 基线永远停在 undefined → 第一条消息撞上
  //    「建基线」分支被吞，无任何 reload（原 bug 上移一层）。
  let bad = OLD_SESSION_BASE
  bad = undefined                                  // 旧写法
  assert.equal(T(bad, 400).reload, false,
    '这正是 R1 的 bug：置 undefined 时第一条消息被吞 —— 本断言锁住该差异')
  // 且第二次才恢复（用户必须再发一条消息才会看到 dock 更新）
  const after = T(bad, 400)
  assert.equal(after.baseline, 400, '旧写法下第一条消息只建基线')
  assert.equal(T(after.baseline, 500).reload, true, '要到第二条消息才恢复')
})
