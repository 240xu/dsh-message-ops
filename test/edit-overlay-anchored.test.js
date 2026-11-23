/**
 * 0.26.0 · 铅笔编辑框「就地锚定 + 官方发送面 + 运行态可点」的真执行测试。
 *
 * 与 `test/pencil-edit-overlay.test.js` 的分工：
 *   · 那个文件锁**契约形态**（按钮/事件/文案/样式/取消零副作用），可以继续用源码断言；
 *   · 这个文件只放**真执行** —— 注入 fake DOM 元素 / fake sessions 服务，跑真代码。
 *
 * 为什么必须真执行（本仓库的历史教训）：
 *   · 0.20~0.25 的 `sendEditAndRevert` 只有源码形状锁，于是「revert 失败却仍然发了一条
 *     消息」这类错误可以全绿通过；
 *   · 定位逻辑此前藏在组件 return 里，node --test 根本跑不到 —— 这次把落座决策抽成
 *     纯函数 `editSeatOf`，可以直接喂 rect 断言「贴着消息」而不是「居中」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

/** 极小 DOM + 最小宿主桩（与 pencil-edit-overlay.test.js 同款手法，但独立维护）。 */
class El {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase()
    this.children = []
    this.attributes = {}
    this.style = {}
    this.classList = { contains: () => false, add() {}, remove() {} }
    this._listeners = {}
    this.parentElement = null
    this.className = ''
    this.disabled = false
    this.textContent = ''
    this.id = ''
    this.dataset = {}
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
  removeEventListener() {}
  matches() {
    return false
  }
  querySelector() {
    return null
  }
  querySelectorAll() {
    return []
  }
  closest() {
    return null
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  }
  focus() {}
  setSelectionRange() {}
}

function withDom(run) {
  const body = new El('body')
  const g = {
    window: {
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {},
      innerWidth: 1100,
      innerHeight: 900,
      __ModuleLoader__: null,
      requestAnimationFrame: fn => setTimeout(fn, 0),
    },
    document: {
      body,
      head: new El('head'),
      documentElement: { clientWidth: 1100 },
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
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
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
        this.detail = o?.detail
      }
    },
  }
  const saved = {}
  for (const k of Object.keys(g)) {
    saved[k] = globalThis[k]
    globalThis[k] = g[k]
  }
  try {
    return run(g)
  } finally {
    for (const k of Object.keys(g)) {
      if (saved[k] === undefined) delete globalThis[k]
      else globalThis[k] = saved[k]
    }
  }
}

/**
 * 加载插件取出 `__test`。
 *
 * @param extra - 额外的 require 命中（例如官方 primitives 的替身）。
 *   ⚠️ 默认**不提供** primitives，走「老宿主 / 无 primitives」分支 ——
 *   这样 `editSeatOf` 等纯逻辑仍可测；primitives 存在性由独立用例覆盖。
 */
function loadPlugin(g, extra) {
  let api = null
  const hits = []
  g.window.__ModuleLoader__ = {
    load({ factory }) {
      api = factory(id => {
        hits.push(id)
        if (id === 'react') {
          return {
            useState: v => [typeof v === 'function' ? v() : v, () => {}],
            useEffect() {},
            useRef: v => ({ current: v }),
            useCallback: fn => fn,
            createElement: () => null,
            Fragment: {},
          }
        }
        if (extra && id in extra) return extra[id]
        return {}
      })
    },
  }
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
  assert.ok(api, '插件工厂未执行（window.__ModuleLoader__.load 未被调用）')
  // 把 require 命中挂到 api 上，供「primitives 是否被请求」的用例观测。
  api.__requiredIds = hits
  return api
}

// ═══════════════════════════════════════════════════════════════════════════
// A · 落座决策（editSeatOf）—— 「贴着那条消息」的核心判据
// ═══════════════════════════════════════════════════════════════════════════
// 官方 useAnchoredPosition **只 clamp 不翻转**（已读 shell bundle 实现），
// 所以「下方空间不够就上翻」必须由本层决定。这四条锁住那个决策。

test('A1 下方空间充足 → side=bottom，宽度跟随消息块且不超过 560', () => {
  return withDom(g => {
    const { __test } = loadPlugin(g)
    assert.equal(typeof __test.editSeatOf, 'function', 'editSeatOf 必须导出（否则本节全是空转）')
    // 视口 1100x900，消息块 top=141 bottom=217 width=680
    const seat = __test.editSeatOf({ top: 141, bottom: 217, width: 680 }, { width: 1100, height: 900 })
    assert.equal(seat.side, 'bottom', '下方还有 683px，应该往下挂')
    assert.equal(seat.width, 560, '宽度跟随消息块但封顶 560（不再固定整宽）')
    assert.equal(seat.gap, 8, '与消息块的间距 = 8px（官方 PANEL_GAP 同值）')
    assert.equal(seat.margin, 12, '视口边距 = 12px（官方 Menu PANEL_MARGIN 同值）')
    assert.equal(seat.inView, true, '消息块在视口内 → 可锚定')
  })
})

test('A2 下方空间不足 → side=top（上翻，官方 hook 不做这件事）', () => {
  return withDom(g => {
    const { __test } = loadPlugin(g)
    // 消息块底部离视口底只剩 50px —— 下方放不下面板
    const seat = __test.editSeatOf({ top: 700, bottom: 850, width: 680 }, { width: 1100, height: 900 })
    assert.equal(seat.side, 'top', '下方只剩 50px，必须上翻')
    assert.equal(seat.inView, true, '仍在视口内')
  })
})

test('A3 窄消息块 → 宽度抬到 280 下限（不窄到没法编辑）', () => {
  return withDom(g => {
    const { __test } = loadPlugin(g)
    const seat = __test.editSeatOf({ top: 100, bottom: 140, width: 120 }, { width: 1100, height: 900 })
    assert.equal(seat.width, __test.EDIT_PANEL_MIN_WIDTH, '宽度低于下限时必须抬到 280')
  })
})

test('A4 消息块滚出视口 → inView=false（调用方据此退回屏幕中央，不贴视口边缘）', () => {
  return withDom(g => {
    const { __test } = loadPlugin(g)
    // 整块在视口上方（长会话向上滚之后很常见）
    const above = __test.editSeatOf({ top: -900, bottom: -800, width: 680 }, { width: 1100, height: 900 })
    assert.equal(above.inView, false, '块完全在视口上方 → 不可锚定（否则官方 clamp 会把面板贴到视口顶）')
    const below = __test.editSeatOf({ top: 1000, bottom: 1100, width: 680 }, { width: 1100, height: 900 })
    assert.equal(below.inView, false, '块完全在视口下方 → 不可锚定')
  })
})

test('A5 视口比最大宽度还窄 → 宽度夹到「视口 - 2×margin」以内', () => {
  return withDom(g => {
    const { __test } = loadPlugin(g)
    const seat = __test.editSeatOf({ top: 100, bottom: 160, width: 900 }, { width: 400, height: 900 })
    assert.ok(seat.width <= 400 - __test.EDIT_PANEL_MARGIN * 2, `宽度 ${seat.width} 超出视口可用宽度`)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// B · 官方发送面（promptEditedText）—— 真执行 fake sessions
// ═══════════════════════════════════════════════════════════════════════════

/** 造一个 fake `ctx.sessions`：using 会 finally release，prompt 记录实参。 */
function fakeSessions(opts) {
  const o = opts || {}
  const calls = { released: 0, retained: 0, prompts: [] }
  return {
    calls,
    using(target, options, op) {
      calls.retained += 1
      calls.target = target
      calls.source = options && options.source
      const reference = {
        sessionId: target,
        ready: Promise.resolve({}),
        binding: {
          session: {
            prompt: (content, mode) => {
              calls.prompts.push([content, mode])
              if (o.throws) throw o.throws
              return Promise.resolve(o.promptResult || { ok: true, value: { accepted: true } })
            },
          },
        },
        release() {
          calls.released += 1
        },
      }
      return Promise.resolve(op(reference))
    },
  }
}

test('B1 真执行：官方 using + prompt([{type:text}], queue)，且 using 自动释放', async () => {
  return withDom(g => {
    const { __test } = loadPlugin(g)
    assert.equal(typeof __test.promptEditedText, 'function', 'promptEditedText 必须导出（否则发送面没有真执行覆盖）')
    const fake = fakeSessions()
    return __test.promptEditedText('改后文本', { rawSessionId: 'session-uuid', sessions: fake }).then(out => {
      assert.equal(out.ok, true, 'prompt ok:true 时应判成功')
      assert.equal(fake.calls.prompts.length, 1, '必须恰好调用一次 prompt')
      const [content, mode] = fake.calls.prompts[0]
      assert.equal(mode, 'queue', "必须用 'queue' 模式（追加一轮，不打断当前轮）")
      assert.equal(content.length, 1, 'content 只有一个 part（纯文本编辑重发）')
      assert.equal(content[0].type, 'text', 'part 类型必须是 text')
      assert.equal(content[0].text, '改后文本', '发送的必须是用户改后的文本')
      assert.equal(fake.calls.retained, 1, '必须通过 sessions.using 取引用（不自造 retain/release）')
      assert.equal(fake.calls.target, 'session-uuid', '必须传带前缀的 rawSessionId（裸 uuid 会抛 unknown session）')
      // 官方 using 自己负责 release —— 这里断言我们的实现没有绕过 using 直接 prompt
      assert.equal(fake.calls.source, __test.EDIT_SOURCE, 'source 必须带本插件自报标签（用于 retainedBy 计数）')
      assert.equal(__test.EDIT_SOURCE, 'messageEdit', '标签值固定为 messageEdit（与官方 SessionReferenceSource 开放表的第三方约定一致）')
    })
  })
})

test('B2 真执行：prompt 拒收 → 按 error.code 上抛，不吞、不假成功', async () => {
  return withDom(g => {
    const { __test } = loadPlugin(g)
    const fake = fakeSessions({ promptResult: { ok: false, error: { code: 'session-busy', message: 'busy' } } })
    return __test.promptEditedText('x', { rawSessionId: 'session-uuid', sessions: fake }).then(out => {
      assert.equal(out.ok, false, '拒收必须判失败')
      assert.match(String(out.reason), /session-busy/, 'reason 必须带官方 error.code（否则用户只看到一个无语的失败）')
    })
  })
})

test('B3 真执行：prompt 抛异常 → 捕获并带出 message（不让 Promise 悬空）', async () => {
  return withDom(g => {
    const { __test } = loadPlugin(g)
    const fake = fakeSessions({ throws: new Error('prompt boom') })
    return __test.promptEditedText('x', { rawSessionId: 'session-uuid', sessions: fake }).then(out => {
      assert.equal(out.ok, false)
      assert.match(String(out.reason), /prompt boom/, '异常必须被带出来（不吞）')
    })
  })
})

test('B4 真执行：sessions 服务缺席 → unavailable（供上层走唯一降级路径）', async () => {
  return withDom(g => {
    const { __test } = loadPlugin(g)
    return __test.promptEditedText('x', { rawSessionId: 'session-uuid', sessions: null }).then(out => {
      assert.equal(out.ok, false)
      assert.equal(out.unavailable, true, '老宿主必须显式标记 unavailable（区别于「被拒」）')
    })
  })
})

test('B5 真执行：using 抛错（未知会话）→ 返回 ok:false 而不是 reject', async () => {
  return withDom(g => {
    const { __test } = loadPlugin(g)
    const fake = {
      using() {
        throw new Error('sessions.retain: unknown session session-uuid')
      },
    }
    return __test.promptEditedText('x', { rawSessionId: 'session-uuid', sessions: fake }).then(out => {
      assert.equal(out.ok, false)
      assert.match(String(out.reason), /unknown session/, 'acquisition 失败也要带原因')
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// C · 官方化副产物：旧轮询/hack 必须真的消失（防「删一半又长回来」）
// ═══════════════════════════════════════════════════════════════════════════
test('C1 旧的 inputActions 轮询提交面已整体删除（含常量与函数）', () => {
  assert.doesNotMatch(src, /function submitEditedText/, 'submitEditedText 必须删除（官方 prompt 取代）')
  assert.doesNotMatch(src, /EDIT_SUBMIT_ATTEMPTS/, '轮询次数常量必须删除')
  assert.doesNotMatch(src, /EDIT_SUBMIT_INTERVAL_MS/, '轮询间隔常量必须删除')
  // 允许注释里解释「为什么删」，但**代码形态**不得再有 setTimeout 轮询提交
  const codeOnly = src
    .split('\n')
    .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n')
  assert.doesNotMatch(codeOnly, /\.submit\(\)/, '不得再直接调宿主 inputActions.submit()（会打到已 dispose 的实例）')
})

test('C2 primitives 必须来自官方 seed 路径，且有 no-op 降级（不许条件调用 hook）', () => {
  assert.match(src, /require\('@deepseek-ai\/dsh-client-ui-primitives'\)/, '必须 require 官方 primitives（platform seed 命中）')
  // hooks 必须**无条件**取别名：条件调用 hook 会破坏 React hooks 顺序
  assert.match(
    src,
    /const useAnchoredPosition = \(__primitives && __primitives\.useAnchoredPosition\) \|\|/,
    '缺 primitives 时必须退化成 no-op 别名',
  )
  assert.match(
    src,
    /const useDismissOnOutsidePointer = \(__primitives && __primitives\.useDismissOnOutsidePointer\) \|\|/,
    '点外关闭也必须走官方 hook（不自己写监听）',
  )
  // 组件里必须真的调用它，而且不再自己写 pointerdown 监听（那正是被替换掉的手搓实现）
  const overlayBody = src.slice(src.indexOf('function EditResendOverlay'), src.indexOf('// --- 头部按钮'))
  assert.match(overlayBody, /useDismissOnOutsidePointer\(/, '组件必须调用官方点外关闭')
  assert.doesNotMatch(overlayBody, /addEventListener\('pointerdown'/, '不得再自己写 pointerdown 关闭（官方 hook 已负责）')
})

test('C3 面板不再有全屏遮罩：.mopsErScrim 已删，且 z-index 不再是 1200', () => {
  // 注释里会解释「为什么删掉 scrim」（那是文档），只禁**代码形态**：
  //   · 类名出现在 className / 样式表里 = 还在渲染
  //   · 注释里出现 = 只是解释，允许
  const codeLines = src.split('\n').filter(l => {
    const t = l.trim()
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  })
  const scrimCode = codeLines.filter(l => l.includes('mopsErScrim'))
  assert.deepEqual(scrimCode, [], '全屏遮罩必须删除（用户要求「不要遮住整个会话」）：\n' + scrimCode.join('\n'))
  // 编辑框样式表里不得再出现全屏遮罩的 z-index；`.mopsPanelScrim`（面板确认框）
  // 是另一套 UI（面板自身仍是模态），不在本工单范围，用「限定段落」避免误伤。
  const styleBlock = src.slice(src.indexOf('function ensureEditStyle'), src.indexOf('function findChatNode'))
  assert.doesNotMatch(styleBlock, /z-index:1200/, '编辑框不得再压 1200 的全屏遮罩层')
  assert.match(styleBlock, /position:fixed;z-index:6[0-9]/, '编辑框必须是 fixed 的小层级浮层（不遮全屏）')
  // 测量 pass 的不可点性：隐藏时既要 visibility:hidden 也要 pointer-events:none
  assert.match(
    src,
    /data-mops-measure="1"\]\{visibility:hidden;pointer-events:none\}/,
    '测量态必须同时不可见且不可点（否则透明面板吃掉点击）',
  )
})

test('C4 运行中：铅笔不得被 disabled；发送按钮必须 disabled 且给出 edit.running', () => {
  // 入口（syncEnabled）：只允许 disabled=true 出现在「配对失败」分支
  const at = src.indexOf('var syncEnabled = (block, btn) => {')
  assert.notEqual(at, -1, '找不到 syncEnabled')
  const body = src.slice(at, src.indexOf('\n      }', at))
  const seqMissingAt = body.indexOf('} else {')
  assert.notEqual(seqMissingAt, -1, 'syncEnabled 应该有「有 seq / 无 seq」两条分支')
  const okBranch = body.slice(0, seqMissingAt)
  assert.match(okBranch, /btn\.disabled = false/, '有 seq 时铅笔必须可点')
  assert.doesNotMatch(okBranch, /btn\.disabled = true/, '有 seq 时**绝不许**把铅笔禁用（用户投诉 #1）')
  assert.match(okBranch, /data-mops-running/, '运行中必须留可读的运行态信号')
  const missingBranch = body.slice(seqMissingAt)
  assert.match(missingBranch, /btn\.disabled = true/, '配对失败时才禁用（并说明原因）')
  // 组件：running 时发送按钮 disabled（由 canSubmit 里的 !running 决定）
  assert.match(
    src,
    /const canSubmit = textState === 'ready' && !saving && draft\.trim\(\) !== '' && !running/,
    '运行中发送按钮必须 disabled',
  )
})

test('C5 事件 detail 必须带锚点信息（block 元素 + nodeKey），供浮层贴近消息', () => {
  const runner = src.slice(src.indexOf('var runUserEdit = '), src.indexOf('var ensureBtn = '))
  assert.match(runner, /nodeKey: block\.getAttribute\('data-chat-node-key'\)/, '必须带 nodeKey（宿主重渲染后仍能找回锚点）')
  assert.match(runner, /block: block/, '必须带块元素本身（零查询，最准）')
})

test('C6 重试语义：同一 seq 再回撤必然 409，所以「重新发送」必须跳过回撤', () => {
  assert.match(src, /const reverted = opts\.reverted === true/, '编排层必须有 reverted 短路开关')
  assert.match(src, /if \(!reverted\) \{/, 'reverted=true 时必须跳过回撤与视图重建')
  assert.match(src, /edit\.resend/, '重试按钮文案必须是「重新发送」')
  assert.match(src, /stage: 'send'/, "回撤成功但发送被拒必须单列 stage:'send'（不能谎报回撤失败）")
})
