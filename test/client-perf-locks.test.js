/**
 * 0.9.7 客户端性能改动的**红线锁**。
 *
 * 这些断言来自只读性能审计，每一条都对应一个「改回去就会复发」的 bug。
 * 与 client-p0-locks 一样：client.js 执行覆盖为 0，只能锁源码结构。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client.js'), 'utf8')

// ═══════════════════════════════════════════════════════════════════════════
// P2-1 · ensureAssign 三签名门控 + 藏行幂等跳写
// ═══════════════════════════════════════════════════════════════════════════
test('P2-1：assignSeqs 有三签名门控（dataSig / domSig / anchorSig）', () => {
  const ea = src.match(/var ensureAssign = \(sid\) => fetchRows\(sid\)\.then\(\(cache\) => \{[\s\S]*?\n {6}\}\)/)
  assert.ok(ea, '找不到 ensureAssign')
  const body = ea[0]
  // ① dataSig = idx.total / shadowed.size / visibleTurns.size
  assert.ok(/idx\.total \+ '\/' \+ idx\.shadowed\.size \+ '\/' \+ idx\.visibleTurns\.size/.test(body), '缺 dataSig')
  // ② domSig = transcript 行数
  assert.ok(/rows\.length/.test(body), '缺 domSig')
  // ③ anchorSig = 每个 user 块的 node-key + 打标状态
  assert.ok(/sigOf\(sid, dataSig, rows\.length, anchors\)/.test(body), '缺签名组装')
  assert.ok(/var anchorSigOf = \(anchors\) => \{/.test(src), '缺 anchorSig 生成器')
  const as = src.indexOf('var anchorSigOf')
  assert.ok(as >= 0 && /getAttribute\('data-mops-seq'\)/.test(src.slice(as, as + 600)),
    'anchorSig 必须包含打标状态（宿主重建块 / CHANGED 摘牌要能被发现）')
  assert.ok(/if \(before !== assignSig\) \{/.test(body), '门控条件缺失 —— 会退回每次全量改写')
  assert.ok(/assignSeqs\(sid, cache, anchors\)/.test(body), 'assignSeqs 必须在门控内')
  // 会话 id 也必须进签名，否则切会话后签名可能撞车
  assert.ok(/var sigOf = \(sid, dataSig, rowsLen, anchors\) =>\s*bareSessionId\(sid\) \+ '\|'/.test(src),
    '签名里没带 sid')
})

test('P2-1 红线：applySurfaceVisibility 保持无条件执行（在门控 if 之外）', () => {
  const ea = src.match(/var ensureAssign = \(sid\) => fetchRows\(sid\)\.then\(\(cache\) => \{[\s\S]*?\n {6}\}\)/)
  assert.ok(ea, '找不到 ensureAssign')
  const body = ea[0]
  assert.ok(/\}\n {8}applySurfaceVisibility\(rows, idx\)/.test(body),
    '藏行必须无条件跑 —— 这是 0.9.6 修的核心，砍成条件执行 = 隐藏不更新')
  assert.ok(!/if\s*\([^\n]*\)\s*applySurfaceVisibility/.test(body), '不许包进任何 if')
})

test('P2-1：藏行改成幂等跳写（判据/时机不变，只省重复 DOM 写）', () => {
  // 目标态 ≠ 当前态才写
  assert.ok(/row\.getAttribute\('hidden'\) !== 'until-found'/.test(src), 'hidden 写入不是幂等的')
  assert.ok(/if \(row\.hasAttribute\('hidden'\)\) row\.removeAttribute\('hidden'\)/.test(src),
    'hidden 移除不是幂等的')
  // 判据本身不许动
  assert.ok(/shouldHide = idx\.shadowed\.has\(hit\.seq\)/.test(src), '藏行判据被改（必须是 shadowed）')
  assert.ok(/shouldHide = !idx\.visibleTurns\.has\(String\(hit\.turn\)\)/.test(src), '回合 chrome 判据被改')
  assert.ok(/if \(hit === null\) \{/.test(src) && /unresolved\+\+/.test(src), '查不到必须保持可见')
  // 判定后必须仍然逐行执行（不允许按签名整段跳过）
  const fn = src.match(/var applySurfaceVisibility = [\s\S]*?\n {6}\};/)
  assert.ok(fn && !/if \([^)]*Sig[^)]*\) return/.test(fn[0]), '不许按签名跳过整段藏行计算')
})

// ═══════════════════════════════════════════════════════════════════════════
// P1-2 · MutationObserver 回调过滤 + 防抖 maxWait
// ═══════════════════════════════════════════════════════════════════════════
test('P1-2：MO 回调先过滤，matches 与 querySelector 两者都试', () => {
  assert.ok(/nodeType !== 1/.test(src), '非元素节点必须跳过')
  assert.ok(/n\.matches\(MO_SEL\)/.test(src), '新增节点自身可能就是目标')
  assert.ok(/n\.querySelector\(MO_SEL\)/.test(src), '新增子树可能是祖先容器')
  assert.ok(/catch \{ scheduleScan\(\) \}/.test(src), '过滤自身出错必须放行（宁可多扫一次）')
  assert.ok(/MO_SEL = '\[data-chat-node-key\]/.test(src), '选择器必须覆盖宿主 chat 行')
  assert.ok(/\[class\*="xzv4MW_actions"\]/.test(src), '选择器必须覆盖官方用户动作行')
})

test('P1-2：防抖 trailing 200ms + maxWait（连续 mutation 不许无限推迟）', () => {
  assert.ok(/scanPendingSince >= 1000/.test(src), '缺 maxWait —— 流式输出时遮蔽行会长时间保持可见')
  assert.ok(/setTimeout\(\(\) => \{ scan\._t = null; scanPendingSince = 0; scan\(\) \}, 200\)/.test(src),
    'trailing 200ms 防抖被改')
})

test('P1-2：attributeFilter 只盯宿主写入的 data-chat-node-key（不自触发）', () => {
  assert.ok(/attributeFilter: \['data-chat-node-key'\]/.test(src))
  assert.ok(!/setAttribute\('data-chat-node-key'/.test(src), '本插件不许写这个属性（会成环）')
})

// ═══════════════════════════════════════════════════════════════════════════
// P0-2-client · 写操作后的读合并
// ═══════════════════════════════════════════════════════════════════════════
test('红线：150/700/1600 三连三处全保留（1600ms 兜底不能砍成 0）', () => {
  assert.equal((src.match(/\[150, 700, 1600\]/g) || []).length, 3,
    'restoreRow / runUserRevert / afterWrite 各一处，缺一处就退回「隐藏不更新」')
})

test('读合并：合并窗口 <1600ms，且兜底档强制走真网络', () => {
  const m = /const MSG_COALESCE_MS = (\d+)/.exec(src)
  assert.ok(m, '缺合并窗口常量')
  const w = Number(m[1])
  assert.ok(w >= 300, `窗口 ${w}ms 太短，盖不住 dock + openSession 后的 scan`)
  assert.ok(w < 1600, `窗口 ${w}ms ≥1600 会把兜底那一发吞掉`)
  const rs = src.match(/__refreshSurface = \(sid\) => \{[\s\S]*?\n {6}\}/)
  assert.ok(rs, '找不到 __refreshSurface')
  assert.ok(/invalidateMessagesMemo\(\)/.test(rs[0]), '兜底档必须先作废窗口再拉，否则吃的是旧响应')
  assert.ok(/refreshDeadline/.test(rs[0]), '三档必须并成一次（deadline 合并），不是各拉各的')
})

test('红线：refillComposer / setDraft 必须发生在首次刷新之前', () => {
  // 悬停回滚按钮：refill → emitChanged → 三连
  const s0 = src.indexOf("notifyDone(__t('done.revert'))")
  assert.ok(s0 >= 0, '找不到 runUserRevert 成功分支')
  const s1 = src.indexOf('.finally(() => { btn.disabled = false })', s0)
  assert.ok(s1 > s0, '找不到 runUserRevert 收尾')
  const block = src.slice(s0, s1)
  const r = block.indexOf('refillComposer(')
  const e = block.indexOf('emitChanged(')
  const l = block.indexOf('for (const delay of [150, 700, 1600]')
  assert.ok(r >= 0, 'runUserRevert 不回填 composer')
  assert.ok(e > r, 'emitChanged（= 首次刷新）必须排在 refillComposer 之后')
  assert.ok(l > e, '三连必须排在 emitChanged 之后')

  // /undo：refill → afterWrite（afterWrite 内部才是 emitChanged + 三连）
  const un = src.indexOf('refillComposer(rawSid, target.seq)')
  assert.ok(un >= 0, '/undo 不回填')
  const aw = src.indexOf('afterWrite(rawSid,', un)
  assert.ok(aw > un, '/undo 必须先回填再走 afterWrite')

  // /redo 是「加回内容」，不回填（既有 composer-refill R2 锁的互补）
  const redo = src.match(/var runRedo = \(\) => \{[\s\S]*?\n {4}\}/)
  assert.ok(redo && !/refillComposer\(/.test(redo[0]), '/redo 不应回填 composer')
})

test('读合并：所有 message 列表 GET 都走 fetchMessagesJson', () => {
  const urls = src.split('\n').filter((l) => /api\/message-ops\/messages\?sessionId=/.test(l))
  assert.ok(urls.length > 0)
  const stray = urls.filter((l) => /(^|[^a-zA-Z])fetch\(/.test(l))
  assert.deepEqual(stray, [], '还有绕过合并窗口的裸 fetch：\n' + stray.join('\n'))
  // 两种 sessionId 写法必须归一，否则 session-xxx / xxx 各占一个缓存槽 = 合并失效
  assert.ok(src.includes('[?&]sessionId=)session-'), 'fetchMessagesJson 没归一 session- 前缀')
  const norm = (u) => String(u).replace(/([?&]sessionId=)session-/, '$1')
  assert.equal(norm('/api/message-ops/messages?sessionId=session-abc'), '/api/message-ops/messages?sessionId=abc')
  assert.equal(norm('/api/message-ops/messages?sessionId=abc'), '/api/message-ops/messages?sessionId=abc')
})

// ═══════════════════════════════════════════════════════════════════════════
// 真·执行测试：把 src/client.js 里的 applySurfaceVisibility 原样抠出来跑。
// client.js 正文此前执行覆盖 = 0，这条是唯一真执行它的用例。
// ═══════════════════════════════════════════════════════════════════════════
/** 与 src/client.js 的 seqOfNodeKey 同构的最小替身：key 形如 `<len><kind><id>` */
const fakeSeqOfNodeKey = (key) => {
  const m = /^(\d+):(.+)$/.exec(String(key || ''))
  if (!m) return null
  const kindLen = Number(m[1])
  const kind = m[2].slice(0, kindLen)
  const id = m[2].slice(kindLen)
  if (kind === 'turn-tail') return { kind, seq: 0, all: [0], turn: id }
  if (kind === 'input-message') return { kind, seq: Number(id), all: [Number(id)] }
  return null
}

const loadApplySurfaceVisibility = () => {
  const m = src.match(/var applySurfaceVisibility = \(root, idx\) => \{[\s\S]*?\n {6}\};/)
  assert.ok(m, '源码里抠不出 applySurfaceVisibility')
  const factory = new Function('seqOfNodeKey', `${m[0]}\nreturn applySurfaceVisibility`)
  return factory(fakeSeqOfNodeKey)
}

const makeRow = (key, hidden) => {
  const attrs = {}
  if (key != null) attrs['data-chat-node-key'] = key
  if (hidden != null) attrs.hidden = hidden
  return {
    attrs,
    writes: 0,
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null },
    hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) },
    setAttribute(n, v) { this.attrs[n] = v; this.writes++ },
    removeAttribute(n) { delete this.attrs[n]; this.writes++ },
  }
}
const idxOf = (shadowedSeqs, visibleTurns) => ({
  shadowed: new Set(shadowedSeqs),
  visibleTurns: new Set((visibleTurns ?? []).map(String)),
})

test('真执行：shadowed 行被藏、未遮蔽行保持可见（0.9.6 判据）', () => {
  const apply = loadApplySurfaceVisibility()
  const rows = [
    makeRow('13:input-message8'),     // seq 8，未遮蔽
    makeRow('13:input-message54'),    // seq 54，已遮蔽
    makeRow('9:turn-tail3'),          // turn 3，有可见消息
    makeRow('9:turn-tail4'),          // turn 4，全遮蔽
    makeRow('garbage'),               // 查不到 → 必须保持可见
  ]
  const out = apply(rows, idxOf([54], [3]))
  assert.equal(out.hidden, 2, 'seq54 + turn4 应被藏')
  assert.equal(out.unresolved, 1)
  assert.equal(rows[0].getAttribute('hidden'), null, '未遮蔽行不许藏')
  assert.equal(rows[1].getAttribute('hidden'), 'until-found')
  assert.equal(rows[2].getAttribute('hidden'), null)
  assert.equal(rows[3].getAttribute('hidden'), 'until-found')
  assert.equal(rows[4].getAttribute('hidden'), null, '查不到时保持可见（唯一会误藏用户内容的路径）')
})

test('真执行：幂等跳写 —— 已在目标态时零 DOM 写', () => {
  const apply = loadApplySurfaceVisibility()
  const idx = idxOf([54], [3])
  const rows = [
    makeRow('13:input-message8'),
    makeRow('13:input-message54', 'until-found'),
    makeRow('9:turn-tail4', 'until-found'),
    makeRow('garbage'),
  ]
  apply(rows, idx)                     // 第一次：把状态摆到位
  const writesAfterFirst = rows.reduce((n, r) => n + r.writes, 0)
  assert.equal(writesAfterFirst, 0, '已在目标态 → 一次写都不该发生')
  apply(rows, idx)                     // 第二次：仍然零写
  assert.equal(rows.reduce((n, r) => n + r.writes, 0), 0, '重复扫描不该再碰属性')
})

test('真执行：状态翻转时仍然会写（幂等不是「不写」）', () => {
  const apply = loadApplySurfaceVisibility()
  const clean = makeRow('13:input-message54')
  apply([clean], idxOf([], []))
  assert.equal(clean.writes, 0, '未遮蔽 → 保持无 hidden，零写')
  apply([clean], idxOf([54], []))
  assert.equal(clean.getAttribute('hidden'), 'until-found')
  assert.equal(clean.writes, 1, '状态翻转必须写')
  apply([clean], idxOf([54], []))
  assert.equal(clean.writes, 1, '翻转后重复扫描不再写')
  apply([clean], idxOf([], []))
  assert.equal(clean.getAttribute('hidden'), null)
  assert.equal(clean.writes, 2, '解除隐藏也要写')
})

test('真执行：接受已查好的行集合（省一次 querySelectorAll）', () => {
  const apply = loadApplySurfaceVisibility()
  const rows = [makeRow('13:input-message1')]
  assert.deepEqual(apply(rows, idxOf([], [])), { hidden: 0, unresolved: 0, shown: 1 })
  // root 为 null 时退回自查询 —— 没有 document 的环境下不抛
  const fakeDoc = { querySelectorAll: () => rows }
  assert.deepEqual(apply(fakeDoc, idxOf([], [])), { hidden: 0, unresolved: 0, shown: 1 })
  assert.equal(apply(rows, null).hidden, 0, 'idx 为空直接短路')
})

// ═══════════════════════════════════════════════════════════════════════════
// P4 · __seqIndexCache 挂到 dataSig
// ═══════════════════════════════════════════════════════════════════════════
test('P4：seq 索引随 dataSig 失效并广播，已挂载槽位会重解析', () => {
  assert.ok(/SEQ_INDEX_EVENT/.test(src), '缺失效广播')
  assert.ok(/syncSeqIndex\(/.test(src), '缺 dataSig 驱动的索引重建')
  const fn = src.match(/var syncSeqIndex = \(sid, messages, idx\) => \{[\s\S]*?\n {6}\}/)
  assert.ok(fn, '找不到 syncSeqIndex')
  assert.ok(/idx\.total/.test(fn[0]) && /idx\.shadowed\.size/.test(fn[0]), '签名必须含数据规模')
  assert.ok(/if \(sig === __seqDataSig\) return/.test(fn[0]), '签名没变就别重建')
  assert.ok(/__seqIndexCache\.set\(key, index\)/.test(fn[0]), '必须真的写回索引')
  // 槽位侧订阅
  assert.ok(/window\.addEventListener\(SEQ_INDEX_EVENT, onIdx\)/.test(src), '槽位没订阅失效事件')
  assert.ok(/\[messageId, sessionId, idxRev\]/.test(src), '解析 effect 没把失效代号放进依赖')
  // miss 必须重试一次（否则 seq 恒 null → 按钮永不渲染）
  assert.ok(/if \(retried\) return/.test(src), '缺一次性重试')
})
