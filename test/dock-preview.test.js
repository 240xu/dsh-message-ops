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

function ctxFor() {
  const session = { id: SID, surface: { nodes: [0, 1, 2, 3] } }
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
  // factory+require 包裹的 React 组件，node --test 无法执行，故客户端侧
  // 只能锁「代码长这样」。**服务端行为**由下方 markCommitted 接线测试真锁。
  // 第一版曾用 MutationObserver，复审判定为次优（判据近似、多挂第三个
  // body-subtree 观察器、ready 门控在首拉失败时永久失效），已删除。
  const rd = clientSrc.slice(clientSrc.indexOf('function RevertDock'))
  // 1) 存在以 activityAt 为依赖的 effect
  assert.match(rd, /\}, \[activityAt\]\)/, 'RevertDock 必须有依赖 [activityAt] 的 effect')
  // 2) 该 effect 调用 loadRef（首拉 effect 把 load 存进 ref）
  const act = rd.match(/useEffect\(\(\) => \{[\s\S]{0,2500}?\}, \[activityAt\]\)/)
  assert.ok(act, '找不到 activityAt effect 本体')
  assert.match(act[0], /loadRef\.current\(\)/, 'activity effect 必须触发 loadRef')
  // 3) mount 不得双请求：首值相等时跳过
  assert.match(act[0], /lastActivityRef\.current === activityAt/, '缺少 mount 去重门控')
  // 3a) 基线建立：首帧宿主 store 常未就绪（activityAt 先 null 后被填充），
  //     若把「null→值」当成新活动，开会话会白跑重试链（活体实测 6 次 GET，本应 1 次）。
  assert.match(act[0], /lastActivityRef\.current === undefined/, '缺少「首个非空值只建基线」门控')
  assert.match(rd, /useRef\(undefined\)/, 'lastActivityRef 必须用 undefined 表示未建基线（用 activityAt 初值会漏判）')
  // 3b) **M3 假锁补丁**：上一轮复审沙箱实测 —— 只断言 effect 调 loadRef.current()，
  //     删掉 `loadRef.current = load` 这行赋值后 157 条仍全绿（effect 调的是
  //     useRef(()=>{}) 的初始空函数 → 宿主 activity 永不重拉 → 用户 bug 原样回归）。
  //     这里补锁赋值本身：ref 里装的必须真的是 load。
  assert.match(rd, /loadRef\.current = load\b/, 'loadRef 必须被赋值为 load（否则 effect 调的是空函数）')
  // 3c) **R2**：activity 同步发 / 落盘异步批窗 → 必须有界重试，否则首次拉到旧
  //     派生缓存后**再无第二次触发**，弹窗一直留着（复审推翻了「闪一下」的定性）
  assert.match(act[0], /ACTIVITY_DELAYS\.map\(/, 'activity 路径必须延迟重拉（R2：落盘批窗 200ms）')
  assert.match(act[0], /clearTimeout/, '延迟定时器必须可清理（否则切会话后仍会对旧 sessionId 重拉）')
  assert.match(act[0], /for \(let i = 0; i < timers\.length; i\+\+\) clearTimeout/, '必须清全部定时器')
  // 4) activityAt 来源是 summary.updatedAt（宿主 api-session/activity 抬高的那个字段）
  assert.match(rd, /summary && typeof summary\.updatedAt === 'number'/, 'activityAt 必须取自 summary.updatedAt')
})

test('F1: load() 必须先失效 1000ms 共用窗（R1 —— 否则复用旧 settled 响应，弹窗不清）', () => {
  // 复审实测：fetchMessagesJson 有 MSG_COALESCE_MS=1000；既有 scan 在 T+200ms
  // 已取到「落盘批窗(200ms)之前」的旧响应，本路径若不先失效 memo 会原样复用
  // → committed 仍是 false → 弹窗不清。emitChanged() 自己就是先 invalidate 再发事件。
  const rd = clientSrc.slice(clientSrc.indexOf('function RevertDock'))
  const load = rd.match(/const load = \(\) => \{[\s\S]{0,400}?fetchMessagesJson\(/)
  assert.ok(load, '找不到 dock 的 load 定义')
  const invalidateAt = load[0].indexOf('invalidateMessagesMemo()')
  const fetchAt = load[0].indexOf('fetchMessagesJson(')
  assert.ok(invalidateAt >= 0, 'load() 未调用 invalidateMessagesMemo')
  assert.ok(invalidateAt < fetchAt, 'invalidateMessagesMemo 必须在 fetchMessagesJson **之前**（否则仍复用旧响应）')
  // 观察器方案已删除，不得残留（否则是两套机制并存）
  assert.ok(!/USER_NODE_SEL/.test(rd), '观察器选择器残留（应已由 activity 信号取代）')
  assert.ok(!/ready = true/.test(rd), 'ready 门控残留（activity 信号方案不需要）')
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

test('R2 前提: 缓存确实在两次读之间被复用（不是每次都重读盘）', async () => {
  // 若 opsList 每次都重读盘，上面那条就证明不了「缓存失效」这件事。
  // 用 mtime+size 未变时的两次读断言结果恒等，间接确认命中缓存路径。
  writeSession([
    msg('user/message', 0, '问题', 'user'),
    msg('assistant/message', 1, '回答'),
  ])
  const a = await opsList(ctxFor(), SID)
  const b = await opsList(ctxFor(), SID)
  assert.deepEqual(
    a.messages.map((m) => [m.seq, m.type, m.committed === true]),
    b.messages.map((m) => [m.seq, m.type, m.committed === true]),
    'mtime+size 未变时两次读必须逐条恒等（否则 derivedCache 未生效，R2 前提不成立）',
  )
})
