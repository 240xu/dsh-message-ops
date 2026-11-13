/**
 * 0.12.0/0.23.0 真执行测试：把 client.js 的工厂函数跑起来，喂一个最小 DOM，
 * 断言 **writeSessionDraft** 的真实行为，以及官方 branch 抑制能力已移除。
 *
 * 为什么必须真执行：形状锁（grep 源码）挡不住「函数被注释掉」。
 * 这组用 window.__ModuleLoader__ 捕获插件导出的 __test 面。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC_URL = new URL('../src/client.js', import.meta.url)
const src = readFileSync(SRC_URL, 'utf8')

/** 极小 DOM：只实现本插件实际用到的 API。 */
class El {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase()
    this.children = []
    this.attributes = {}
    this.style = {}
    this.classList = { _s: new Set(), add(c) { this._s.add(c) }, contains(c) { return this._s.has(c) }, get value() { return [...this._s].join(' ') } }
    this._listeners = {}
    this.parentElement = null
    this.className = ''
    this.disabled = false
  }
  appendChild(c) { c.parentElement = this; this.children.push(c); return c }
  setAttribute(k, v) { this.attributes[k] = String(v) }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null }
  hasAttribute(k) { return k in this.attributes }
  removeAttribute(k) { delete this.attributes[k] }
  addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn) }
  matches() { return false }
  querySelectorAll(sel) {
    const out = []
    const match = (c) => {
      if (sel === 'svg path') return c.tagName === 'PATH'
      if (sel === 'svg') return c.tagName === 'SVG'
      if (sel === 'use') return c.tagName === 'USE'
      return false
    }
    const walk = (n) => { for (const c of n.children) { if (match(c)) out.push(c); walk(c) } }
    walk(this)
    return out
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null }
  closest() { return null }
}

function withDom(fn) {
  const body = new El('body')
  const g = {
    window: {
      addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, __MOPS_DEBUG: false,
      __ModuleLoader__: null,
    },
    document: {
      body, head: new El('head'), documentElement: { clientWidth: 1200 }, activeElement: null,
      getElementById: () => null,
      createElement: (t) => new El(t),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    localStorage: { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null }, setItem(k, v) { this._m.set(k, String(v)) }, removeItem(k) { this._m.delete(k) } },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o?.detail } },
  }
  const saved = {}
  for (const k of Object.keys(g)) { saved[k] = globalThis[k]; globalThis[k] = g[k] }
  try { return fn(g) } finally {
    for (const k of Object.keys(g)) { if (saved[k] === undefined) delete globalThis[k]; else globalThis[k] = saved[k] }
  }
}

/** 加载插件并取出 __test 面（每个用例独立加载，避免共享模块状态）。 */
function loadPlugin(g) {
  let api = null
  g.window.__ModuleLoader__ = {
    load({ factory }) {
      api = factory((id) => {
        if (id === 'react') {
          return {
            useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
            useEffect() {}, useRef: (v) => ({ current: v }), useCallback: (f) => f,
            createElement: () => null, Fragment: {},
          }
        }
        return {}
      })
    },
  }
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'localStorage', 'fetch', 'MutationObserver', 'ResizeObserver', 'CustomEvent', src)(
    g.window, g.document, g.localStorage, g.fetch, g.MutationObserver, g.ResizeObserver, g.CustomEvent,
  )
  assert.ok(api, '插件工厂未执行（window.__ModuleLoader__.load 未被调用）')
  return api
}

test('真执行：writeSessionDraft 写的是宿主能读的 { draft: <string> } 且键名正确', () => {
  withDom((g) => {
    const { __test } = loadPlugin(g)
    assert.equal(__test.writeSessionDraft('session-abc', 'hello 世界'), true)
    const raw = g.localStorage.getItem('dsh.conversation.session-abc')
    assert.ok(raw, '草稿必须写进 dsh.conversation.<sessionId>')
    assert.deepEqual(JSON.parse(raw), { draft: 'hello 世界' }, '宿主 parseStoredDraft 只认 { draft: <string> } 形态')
  })
})

test('真执行：writeSessionDraft 对空 id 返回 false 且不写脏键', () => {
  withDom((g) => {
    const { __test } = loadPlugin(g)
    assert.equal(__test.writeSessionDraft('', 'x'), false)
    assert.equal(g.localStorage._m.size, 0, '没有会话 id 时不能落任何键')
  })
})

test('0.23：__test 不再导出 branch 抑制相关符号', () => {
  withDom((g) => {
    const { __test } = loadPlugin(g)
    assert.equal(__test.isHostBranchButton, undefined, '抑制判定已删')
    assert.equal(__test.HOST_BRANCH_ICON_ID, undefined, '图标常量已删')
    assert.equal(__test.HOST_BRANCH_D_PREFIX, undefined, 'path 常量已删')
    assert.equal(typeof __test.writeSessionDraft, 'function', '草稿写入仍可用')
  })
})
