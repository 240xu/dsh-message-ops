/**
 * 0.25.0 · 响应手感优化的回归锁（工单 B 的四条）。
 *
 * 原则：能真执行的都真执行，形状断言只留给「闭包深处、抽不出来」的部分。
 *   · 1 三连刷新 → 立即一次 + 300ms 尾随：形状断言 + 真执行防抖合并（连调 3 次只发 1 次请求）。
 *   · 2 ensureAssign 后紧跟重复 fetchRows：形状断言 + 真执行计数（命中 cache 时 0 次额外 fetchRows）。
 *   · 3 scroll 无节流 → rAF 合并：抽出 onScroll 闭包真执行，同步连发 6 次只扫 1 次。
 *   · 4 面板 /text 无缓存 → Map + 尾随防抖 + 单飞：走 __test.loadPanelText 真执行，
 *     注入 fake fetch 断言「两次 pick 只发 1 次请求」等 7 条行为。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readSource, blockAt } from './_source.js'

const src = readSource()

// ═══════════════════════════════════════════════════════════════════════════
// 共用：极小 DOM + 最小宿主桩，只为让插件工厂跑完并交出 __test
// ═══════════════════════════════════════════════════════════════════════════
class El {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase()
    this.children = []
    this.attributes = {}
    this.style = {}
    this.classList = {
      _s: new Set(),
      add(c) {
        this._s.add(c)
      },
      remove(c) {
        this._s.delete(c)
      },
      contains(c) {
        return this._s.has(c)
      },
      get value() {
        return [...this._s].join(' ')
      },
    }
    this._listeners = {}
    this.parentElement = null
    this.className = ''
    this.disabled = false
  }
  appendChild(c) {
    c.parentElement = this
    this.children.push(c)
    return c
  }
  removeChild(c) {
    this.children = this.children.filter(x => x !== c)
    return c
  }
  remove() {}
  setAttribute(k, v) {
    this.attributes[k] = String(v)
  }
  getAttribute(k) {
    return k in this.attributes ? this.attributes[k] : null
  }
  hasAttribute(k) {
    return k in this.attributes
  }
  removeAttribute(k) {
    delete this.attributes[k]
  }
  addEventListener(t, fn) {
    ;(this._listeners[t] ||= []).push(fn)
  }
  matches() {
    return false
  }
  querySelectorAll() {
    return []
  }
  querySelector() {
    return null
  }
  closest() {
    return null
  }
  getBoundingClientRect() {
    return { top: 0, left: 0, width: 0, height: 0 }
  }
}

/**
 * 加载插件并取出 __test 面。
 * `fetchImpl` 必须在**加载那一刻**注入 —— 插件工厂闭包当场捕获 fetch，
 * 加载后再改 globalThis.fetch 无效（踩过的坑）。
 */
function loadPlugin(fetchImpl) {
  const body = new El('body')
  const g = {
    window: {
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {},
      __MOPS_DEBUG: false,
      __ModuleLoader__: null,
      requestAnimationFrame: cb => setTimeout(cb, 0),
      innerWidth: 1200,
    },
    document: {
      body,
      head: new El('head'),
      documentElement: { clientWidth: 1200 },
      activeElement: null,
      getElementById: () => null,
      createElement: t => new El(t),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {},
    },
    localStorage: {
      _m: new Map(),
      getItem(k) {
        return this._m.has(k) ? this._m.get(k) : null
      },
      setItem(k, v) {
        this._m.set(k, String(v))
      },
      removeItem(k) {
        this._m.delete(k)
      },
    },
    fetch: fetchImpl,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    CustomEvent: class {
      constructor(t, o) {
        this.type = t
        this.detail = o && o.detail
      }
    },
  }
  const saved = {}
  for (const k of Object.keys(g)) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k)
    try {
      globalThis[k] = g[k]
    } catch {
      /* 不可写的全局跳过 */
    }
  }
  let api = null
  g.window.__ModuleLoader__ = {
    load({ factory }) {
      api = factory(id => {
        if (id === 'react') {
          return {
            useState: v => [typeof v === 'function' ? v() : v, () => {}],
            useEffect() {},
            useRef: v => ({ current: v }),
            useCallback: fn => fn,
            createElement: () => null,
            Fragment: {},
            useMemo: fn => fn(),
          }
        }
        return {}
      })
    },
  }
  try {
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'localStorage', 'fetch', 'MutationObserver', 'ResizeObserver', 'CustomEvent', src)(
      g.window,
      g.document,
      g.localStorage,
      g.fetch,
      g.MutationObserver,
      g.ResizeObserver,
      g.CustomEvent,
    )
  } finally {
    for (const k of Object.keys(g)) {
      if (saved[k] === undefined) delete globalThis[k]
      else Object.defineProperty(globalThis, k, saved[k])
    }
  }
  assert.ok(api, '插件工厂未执行（window.__ModuleLoader__.load 未被调用）')
  assert.ok(api.__test, '插件必须导出 __test 面（否则本组真执行测试静默蒸发）')
  return api.__test
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 · 回滚后三连刷新 → 立即一次 + 300ms 尾随防抖
// ═══════════════════════════════════════════════════════════════════════════
test('1a 形状：三连 [150,700,1600] 彻底消失，且不再有「按 delay 数组排 setTimeout」', () => {
  assert.doesNotMatch(src, /\[150, 700, 1600\]/, '三连字面量必须消失（注释里也别留，防止照抄回去）')
  assert.doesNotMatch(src, /for \(const delay of \[/, '不许再用 delay 数组批量排刷新')
  const sites = [...src.matchAll(/if \(__refreshSurface\) __refreshSurface\(/g)]
  assert.ok(sites.length >= 3, `三处兜底刷新调用必须保留（restoreRow/runUserRevert/afterWrite），实际 ${sites.length} 处`)
})

test('1b 形状：__refreshSurface 尾随防抖 = 300ms，且仍是「真网络 + 重算隐藏」', () => {
  const rs = blockAt(src, '__refreshSurface = sid =>')
  assert.ok(rs, '找不到 __refreshSurface')
  assert.match(rs, /refreshDeadline = now \+ 300/, '尾随窗口必须降到 300ms')
  assert.doesNotMatch(rs, /now \+ 1500/, '1500ms 落点必须消失')
  assert.match(rs, /invalidateMessagesMemo\(\)/, '兜底必须强制走真网络（不吃合并缓存）')
  assert.match(rs, /applySurfaceVisibility\(document, cache\.idx\)/, '兜底必须重算隐藏（回滚后变灰的最终保障）')
  assert.match(rs, /if \(rowsCache\) rowsCache\.at = 0/, '调用当下就要作废行缓存')
})

test('1c 真执行：__refreshSurface 连调 3 次只发 1 次请求（防抖合并）', async () => {
  const at = src.indexOf('var refreshTimer = null')
  const end = src.indexOf('var scan = () =>', at)
  assert.ok(at >= 0 && end > at, '找不到刷新器闭包')
  let fetches = 0
  let applied = 0
  const rowsCache = { sid: null, rows: null, at: 9000, running: false }
  const fetchRows = sid => {
    fetches += 1
    return Promise.resolve({ sid: String(sid).replace(/^session-/, ''), idx: { total: 0, shadowed: new Set(), visibleTurns: new Set() } })
  }
  // 抽出的闭包通过 arguments 注入外部依赖：rowsCache / bareSessionId /
  // __currentSessionId / invalidateMessagesMemo / fetchRows / applySurfaceVisibility / document
  // eslint-disable-next-line no-new-func
  const make = new Function(
    'rowsCache',
    'bareSessionId',
    '__currentSessionId',
    'invalidateMessagesMemo',
    'fetchRows',
    'applySurfaceVisibility',
    'document',
    `${src.slice(at, end)}; return __refreshSurface`,
  )
  const refresh = make(
    rowsCache,
    id => String(id || '').replace(/^session-/, ''),
    'session-abc',
    () => {},
    fetchRows,
    () => {
      applied += 1
    },
    { body: new El('body') },
  )
  assert.equal(typeof refresh, 'function', '抽出的 __refreshSurface 必须可调用')
  refresh('session-abc')
  refresh('session-abc')
  refresh('session-abc')
  // 防抖落点在 ~300ms：200ms 时还一发都没发（证明不再白等 1.6s）
  await new Promise(r => setTimeout(r, 180))
  assert.equal(fetches, 0, `180ms 时不应已发请求（旧实现要等 1.6s，新实现 300ms 时才发）`)
  await new Promise(r => setTimeout(r, 220))
  assert.equal(fetches, 1, `连调 3 次必须只发 1 次请求（实际 ${fetches} 次）`)
  assert.equal(applied, 1, '隐藏重算必须跑且只跑一次')
})

test('1d 真执行：尾随刷新跨会话必须丢弃（不把旧会话 idx 刷到新会话 DOM 上）', async () => {
  const at = src.indexOf('var refreshTimer = null')
  const end = src.indexOf('var scan = () =>', at)
  let fetches = 0
  let applied = 0
  const rowsCache = { sid: null, rows: null, at: 0, running: false }
  // eslint-disable-next-line no-new-func
  const make = new Function(
    'rowsCache',
    'bareSessionId',
    '__currentSessionId',
    'invalidateMessagesMemo',
    'fetchRows',
    'applySurfaceVisibility',
    'document',
    `${src.slice(at, end)}; return __refreshSurface`,
  )
  // 注意：闭包里读的是「当时的」__currentSessionId —— 这里用 getter 模拟会话已切走
  const holder = { id: 'session-old' }
  const refresh = make(
    rowsCache,
    id => String(id || '').replace(/^session-/, ''),
    holder,
    () => {},
    sid => {
      fetches += 1
      return Promise.resolve({ sid, idx: {} })
    },
    () => {
      applied += 1
    },
    { body: new El('body') },
  )
  refresh('session-old')
  holder.id = 'session-new'
  await new Promise(r => setTimeout(r, 420))
  assert.equal(fetches, 0, '会话已切走 → 尾随刷新必须放弃（否则旧 idx 污染新会话）')
  assert.equal(applied, 0)
})

// ═══════════════════════════════════════════════════════════════════════════
// 2 · ensureAssign 之后不再重复 fetchRows（只改 runUserRevert）
// ═══════════════════════════════════════════════════════════════════════════
test('2a 形状：runUserRevert 复用 ensureAssign 的返回值，不再 .then(() => fetchRows(sid))', () => {
  const body = blockAt(src, 'var runUserRevert = (btn, block) =>')
  assert.ok(body, '找不到 runUserRevert')
  assert.doesNotMatch(body, /\.then\(\(\) => fetchRows\(sid\)\)/, '重复的第二次 fetchRows 必须删掉')
  assert.match(body, /\.then\(cache => cache \|\| fetchRows\(sid\)\)/, '必须复用 ensureAssign 返回的 cache（仅 null 时补一次）')
  assert.match(body, /\.then\(\(\) => ensureAssign\(sid\)\)/, 'ensureAssign 仍是点击时的同步配对入口')
})

test('2b 真执行：ensureAssign 命中数据时，一次点击 0 次额外 fetchRows', async () => {
  const body = blockAt(src, 'var runUserRevert = (btn, block) =>')
  assert.ok(body, '找不到 runUserRevert')
  const chainStart = body.indexOf('Promise.resolve()')
  const chainEnd = body.indexOf('.then(cache => {')
  assert.ok(chainStart >= 0 && chainEnd > chainStart, '找不到取数链')
  const chainSrc = body.slice(chainStart, chainEnd)
  let ensureCalls = 0
  let fetchRowsCalls = 0
  // eslint-disable-next-line no-new-func
  const run = new Function('ensureAssign', 'fetchRows', 'sid', 'return ' + chainSrc)
  const cache = await run(
    () => {
      ensureCalls += 1
      return Promise.resolve({ sid: 'abc', rows: [], idx: {} })
    },
    () => {
      fetchRowsCalls += 1
      return Promise.resolve({ sid: 'abc', rows: [], idx: {} })
    },
    'abc',
  )
  assert.equal(ensureCalls, 1, 'ensureAssign 必须恰好 1 次')
  assert.equal(fetchRowsCalls, 0, `复用 cache 时不得再打 fetchRows（实际 ${fetchRowsCalls} 次）`)
  assert.ok(cache && cache.sid === 'abc', '下游必须拿到 ensureAssign 的 cache')
  assert.ok(cache.rows, 'cache 必须带 rows')
})

test('2c 真执行：ensureAssign 拿不到数据（null）时才补一次 fetchRows', async () => {
  const body = blockAt(src, 'var runUserRevert = (btn, block) =>')
  const chainStart = body.indexOf('Promise.resolve()')
  const chainEnd = body.indexOf('.then(cache => {')
  const chainSrc = body.slice(chainStart, chainEnd)
  let fetchRowsCalls = 0
  // eslint-disable-next-line no-new-func
  const run = new Function('ensureAssign', 'fetchRows', 'sid', 'return ' + chainSrc)
  const cache = await run(
    () => Promise.resolve(null),
    () => {
      fetchRowsCalls += 1
      return Promise.resolve({ sid: 'abc', rows: [{ seq: 8 }], idx: {} })
    },
    'abc',
  )
  assert.equal(fetchRowsCalls, 1, 'ensureAssign 失败时必须补一次（否则「一次抖动 = 点了没用」）')
  assert.ok(cache && cache.rows && cache.rows.length === 1, '补拉的数据必须交给下游')
})

// ═══════════════════════════════════════════════════════════════════════════
// 3 · scroll 走 rAF 合并（不是每事件一次 scan）
// ═══════════════════════════════════════════════════════════════════════════
test('3a 形状：scroll 绑局部 onScroll，且用 requestAnimationFrame 合并', () => {
  assert.match(src, /window\.addEventListener\('scroll', onScroll, \{ passive: true \}\)/, 'scroll 必须绑 onScroll（保留 passive）')
  const body = blockAt(src, 'var onScroll = () =>')
  assert.ok(body, '找不到 onScroll')
  assert.match(body, /if \(rafPending\) return/, '必须有 rafPending 合并门')
  assert.match(body, /window\.requestAnimationFrame\(run\)/, '必须走 rAF')
  assert.match(body, /setTimeout\(run, 16\)/, '无 rAF 宿主必须有宏任务兜底')
  assert.doesNotMatch(body, /scheduleScan/, 'scroll 不许退回 MutationObserver 的 200ms 防抖（手感更差）')
})

test('3b 真执行：同步连发 6 次滚动只扫 1 次，flush 之后可再扫', () => {
  const at = src.indexOf('var rafPending = false')
  const end = src.indexOf("window.addEventListener('scroll', onScroll", at)
  assert.ok(at >= 0 && end > at, '找不到 onScroll 闭包（源码结构变了？）')
  let scans = 0
  const frameQueue = []
  // eslint-disable-next-line no-new-func
  const make = new Function('scan', 'window', 'setTimeout', src.slice(at, end) + '; return onScroll')
  const onScroll = make(
    () => {
      scans += 1
    },
    { requestAnimationFrame: cb => frameQueue.push(cb) },
    cb => frameQueue.push(cb),
  )
  assert.equal(typeof onScroll, 'function', '必须抽出可调用的 onScroll')
  for (let i = 0; i < 6; i += 1) onScroll()
  assert.equal(scans, 0, '事件同步派发期间不许直接扫（必须推迟到下一帧）')
  assert.equal(frameQueue.length, 1, '一帧内多次事件只许排一次 rAF')
  frameQueue.shift()()
  assert.equal(scans, 1, `6 次滚动只许扫 1 次（实际 ${scans} 次）`)
  onScroll()
  assert.equal(frameQueue.length, 1, 'flush 之后仍可再排一拍')
  frameQueue.shift()()
  assert.equal(scans, 2)
})

test('3c 真执行：无 requestAnimationFrame 的老宿主走宏任务兜底，语义仍是「合并到下一拍」', () => {
  const at = src.indexOf('var rafPending = false')
  const end = src.indexOf("window.addEventListener('scroll', onScroll", at)
  let scans = 0
  const timers = []
  // eslint-disable-next-line no-new-func
  const make = new Function('scan', 'window', 'setTimeout', src.slice(at, end) + '; return onScroll')
  const onScroll = make(
    () => {
      scans += 1
    },
    {},
    cb => timers.push(cb),
  )
  onScroll()
  onScroll()
  onScroll()
  assert.equal(scans, 0, '兜底也必须先合并')
  assert.equal(timers.length, 1, '只许排一个宏任务')
  timers.shift()()
  assert.equal(scans, 1)
})

// ═══════════════════════════════════════════════════════════════════════════
// 4 · 面板 /text：Map 缓存 + 尾随防抖 + 单飞（真执行）
// ═══════════════════════════════════════════════════════════════════════════
test('4a 形状：pick 不再直连 /text，改走 loadPanelText；竞态仍由 detailReq 把关', () => {
  const pick = blockAt(src, 'const pick = useCallback')
  assert.ok(pick, '找不到 pick')
  assert.match(pick, /loadPanelText\(sid, m\.seq\)/, 'pick 必须走缓存层')
  assert.doesNotMatch(pick, /fetch\('\/api\/message-ops\/text/, 'pick 不许直连 /text（绕开缓存）')
  assert.match(pick, /if \(req !== detailReq\.current\) return/, 'detailReq 竞态门必须保留')
  assert.match(pick, /m\.snippet/, '失败时的 snippet 回退语义必须保留')
})

test('4b 形状：缓存失效点是 emitChanged（写操作后全文可能变）', () => {
  const ec = blockAt(src, 'const emitChanged = () =>')
  assert.ok(ec, '找不到 emitChanged')
  assert.match(ec, /clearPanelTextCache\(\)/, 'emitChanged 必须清面板全文缓存')
})

test('4c 真执行：同一 seq 两次 pick 只发 1 次 /text（命中缓存零请求）', async () => {
  const calls = []
  const testApi = loadPlugin(async url => {
    calls.push(String(url))
    return { ok: true, status: 200, json: async () => ({ ok: true, text: 'FULL TEXT of ' + String(url) }) }
  })
  const load = testApi.loadPanelText
  assert.equal(typeof load, 'function', '__test.loadPanelText 必须导出（否则本条真执行蒸发）')
  const debounce = testApi.PANEL_TEXT_DEBOUNCE_MS
  assert.ok(debounce <= 200, `尾随防抖必须 ≤200ms，实际 ${debounce}ms`)

  const first = await load('session-abc', 7)
  assert.equal(first, 'FULL TEXT of ' + calls[0], '必须拿到 /text 的全文（不是 null、不是 snippet）')
  assert.equal(calls.length, 1, '第一次 pick 必须发 1 次请求')

  const second = await load('session-abc', 7)
  assert.equal(second, first, '第二次 pick 必须命中缓存、返回同一份全文')
  assert.equal(calls.length, 1, `同一 seq 两次 pick 只许 1 次请求（实际 ${calls.length} 次）`)

  await load('session-xyz', 7)
  assert.equal(calls.length, 2, '不同会话必须各自取数（缓存键带 sessionId，不许串台）')
})

test('4d 真执行：150ms 内连换两条只发最后一次请求，前一次以 null 收尾', async () => {
  const calls = []
  const testApi = loadPlugin(async url => {
    calls.push(String(url))
    return { ok: true, status: 200, json: async () => ({ ok: true, text: 'FULL:' + String(url) }) }
  })
  const load = testApi.loadPanelText
  const p1 = load('s', 1)
  await new Promise(r => setTimeout(r, 40))
  const p2 = load('s', 2)
  const [r1, r2] = await Promise.all([p1, p2])
  assert.equal(r1, null, '被取代的那次必须以 null 收尾（调用方按 detailReq 丢弃）')
  assert.match(String(r2), /seq=2/, '停下来看的那条必须拿到全文')
  assert.equal(calls.length, 1, `划动过程中只许发 1 次请求（实际 ${calls.length} 次）`)
  assert.match(calls[0], /seq=2/, '发出去的必须是最后停留的那条')
})

test('4e 真执行：失败不缓存（一次抖动不许把详情永久钉在 snippet 上）', async () => {
  let fail = true
  const calls = []
  const testApi = loadPlugin(async url => {
    calls.push(String(url))
    if (fail) return { ok: false, status: 500, json: async () => ({ ok: false, error: 'boom' }) }
    return { ok: true, status: 200, json: async () => ({ ok: true, text: 'RECOVERED' }) }
  })
  const load = testApi.loadPanelText
  const bad = await load('s', 9)
  assert.equal(bad, null, '失败必须返回 null（pick 回退 snippet，保持「不是全文」语义）')
  assert.equal(calls.length, 1)
  fail = false
  const good = await load('s', 9)
  assert.equal(good, 'RECOVERED', '失败结果不许进缓存 —— 重试必须能真的取到')
  assert.equal(calls.length, 2, '重试必须真的再发一次请求')
})

test('4f 真执行：清缓存后同一 seq 必须重新取数（emitChanged 的失效路径）', async () => {
  const calls = []
  const testApi = loadPlugin(async url => {
    calls.push(String(url))
    return { ok: true, status: 200, json: async () => ({ ok: true, text: 'T' + calls.length }) }
  })
  const load = testApi.loadPanelText
  const clear = testApi.clearPanelTextCache
  assert.equal(typeof clear, 'function', '__test.clearPanelTextCache 必须导出')
  await load('s', 5)
  assert.equal(calls.length, 1)
  clear()
  const after = await load('s', 5)
  assert.equal(calls.length, 2, `清缓存后必须重新取数（实际仍是 ${calls.length} 次 = 没清）`)
  assert.equal(after, 'T2', '重新取到的必须是新数据')
})

test('4g 真执行：同一 seq 在途请求共享一个 promise（单飞，不重复发）', async () => {
  const calls = []
  const testApi = loadPlugin(async url => {
    calls.push(String(url))
    await new Promise(r => setTimeout(r, 30))
    return { ok: true, status: 200, json: async () => ({ ok: true, text: 'ONE' }) }
  })
  const load = testApi.loadPanelText
  const p1 = load('s', 3)
  // 等过防抖窗口，让第一条真正进入「在飞」状态
  await new Promise(r => setTimeout(r, 170))
  const p2 = load('s', 3)
  const [a, b] = await Promise.all([p1, p2])
  assert.equal(a, 'ONE')
  assert.equal(b, 'ONE')
  assert.equal(calls.length, 1, `在途请求必须共享，实际发了 ${calls.length} 次`)
})
