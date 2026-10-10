/* global window, document, fetch, navigator */
/**
 * dsh-message-ops 客户端：会话头部按钮 + 共享操作对话框 + 侧栏行菜单项。
 *
 * 一个对话框承载三种操作（回滚 / 删除 / 分支）：
 *   - 拉取 GET /api/message-ops/messages 展示消息级列表（可见性已标注）
 *   - 回滚/删除为破坏性操作：需勾选风险确认（回滚仍可通过再次发送恢复，
 *     删除为遮蔽语义；日志永远 append-only，原事件保留）
 *   - 分支为唯一非破坏操作：无需确认，成功后提示新会话 id 并刷新列表
 * 回滚/删除成功后整页刷新（surface 变化需要会话重渲染）。
 *
 * 结构照抄 @huanlin/dsh-plugin-session-delete 的成熟模式：slots.inject
 * 延迟注册（宿主晚声明也不白屏）、locale 服务 zh/en、DOM 注入侧栏菜单。
 */
window.__ModuleLoader__.load({
  id: '@240xu/dsh-message-ops',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useState } = React
    const { Modal } = require('@deepseek-ai/dsh-client-ui-primitives')

    const SLOT = 'conversation.session.header.actions'
    const ROW_ID = 'message-ops'
    const OVERLAY_SLOT = 'shell.overlay'
    const INPUT_DOCK_SLOT = 'conversation.input.dock'
    const INPUT_DOCK_ID = 'message-ops-revert-dock'
    const DIALOG_ID = 'message-ops-dialog'
    const EVENT = 'dsh-message-ops:open'
    // 0.5.2（P2）：回滚/恢复成功后广播 → RevertDock 重拉标记（否则 dock 只在切会话时刷新）
    const CHANGED_EVENT = 'dsh-message-ops:changed'
    const emitChanged = () => { try { window.dispatchEvent(new CustomEvent(CHANGED_EVENT)) } catch { /* noop */ } }
    const NS = 'dsh-message-ops'

    const zhDict = {
      'button.title': '消息操作（回滚/删除/分支）',
      'dialog.title': '消息操作',
      'dialog.cancel': '关闭',
      'dialog.loading': '正在读取消息列表…',
      'dialog.loadFail': '消息列表读取失败：',
      'dialog.empty': '该会话没有可操作的消息。',
      'dialog.session': '会话：',
      'dialog.runningWarn': '⚠ 会话正在运行：请先停止该会话再执行回滚/删除/分支。',
      'dialog.pick': '选择一条消息：',
      'dialog.pickFirst': '第 1 步 · 在下方选择一条消息，第 2 步在这里选择操作。',
      'dialog.pickedAs': '已选 #{seq} · {{text}}',
      'dialog.invisible': '（已遮蔽，仅日志可见）',
      'dialog.showMore': '显示更多（剩余 {n} 条）',
      'dialog.more': '…（仅显示最近 200 条，共 {n} 条）',
      'op.revert': '回滚到此条（含）之后全部移除',
      'op.revertDesc': '遮蔽所选消息及其后所有可见内容；日志 append-only，可通过重新发送恢复语境。',
      'op.delete': '仅删除这一条',
      'op.deleteDesc': '仅遮蔽所选的一条消息；其余内容保持不变。',
      'op.branch': '从此条分支为新会话',
      'op.branchDesc': '复制所选消息（含）之前的全部事件为新会话（原会话不变，非破坏操作）。',
      'ack.revert': '我已了解：回滚会遮蔽所选消息及其后的全部内容',
      'ack.delete': '我已了解：将遮蔽这一条消息（日志中仍保留）',
      'confirm.revert': '回滚',
      'confirm.delete': '删除',
      'confirm.branch': '分支',
      'busy.revert': '回滚中…',
      'busy.delete': '删除中…',
      'busy.branch': '分支中…',
      'done.branch': '分支完成：新会话 {id}（列表刷新后可见）',
      'done.revert': '回滚完成，刷新页面后生效',
      'done.delete': '删除完成，刷新页面后生效',
      'action.reload': '刷新页面',
      'errorPrefix': '操作失败：',
      'slot.revert': '回滚到此条',
      'slot.delete': '删除此条',
      'slot.branch': '从此分支',
      'toast.openNew': '打开新会话',
      'fork.official': '分支完成：新会话 {id}',
      'fork.unavailable': '官方分支不可用：通常是因为会话正在运行，请先停止会话后重试。分支功能由 dsh 内置的 session/fork 提供。',
      'done.restore': '恢复完成：重放 {n} 条，跳过不可重放 {s} 条',
      'busy.restore': '恢复中…',
      'dock.title': '已回撤 {n} 条消息',
      'dock.expand': '展开回撤列表',
      'dock.collapse': '折叠回撤列表',
      'dock.restore': '恢复',
      'dock.restoring': '恢复中…',
      'slot.quote': '引用到输入框',
      'quote.done': '已引用到输入框',
      'quote.unavailable': '引用不可用（输入框不可写或无全文）',
      'menu.ops': '消息操作',
    }

    const enDict = {
      'button.title': 'Message ops (revert / delete / branch)',
      'dialog.title': 'Message ops',
      'dialog.cancel': 'Close',
      'dialog.loading': 'Loading messages…',
      'dialog.loadFail': 'Failed to load messages: ',
      'dialog.empty': 'No operable messages in this session.',
      'dialog.session': 'Session: ',
      'dialog.runningWarn': '⚠ Session is running: stop it before revert / delete / branch.',
      'dialog.pick': 'Pick a message:',
      'dialog.pickFirst': 'Step 1 · pick a message below, then choose an operation here.',
      'dialog.pickedAs': 'Selected #${seq} · ${text}',
      'dialog.invisible': ' (shadowed, log-only)',
      'dialog.showMore': 'Show more ({n} older)',
      'dialog.more': '…(showing latest 200 of {n})',
      'op.revert': 'Revert: remove this message and everything after',
      'op.revertDesc': 'Shadows the picked message and all later visible content; the log stays append-only so context can be restored by re-sending.',
      'op.delete': 'Delete only this message',
      'op.deleteDesc': 'Shadows only the picked message; everything else stays.',
      'op.branch': 'Branch into a new session from here',
      'op.branchDesc': 'Copies everything up to and including the picked message into a new session (original untouched, non-destructive).',
      'slot.revert': 'Revert to here',
      'slot.revertUnmatched': 'Cannot locate this message seq in the log (usually the model-written summary drifted too far from the rendered text) — use the Message ops dialog instead.',
      'slot.delete': 'Delete this message',
      'slot.branch': 'Branch from here',
      'toast.openNew': 'Open new session',
      'fork.official': 'Branched (official fork): new session {id}',
      'fork.unavailable': 'Built-in branch unavailable — usually because the session is running. Stop it and retry. Branching is provided by the dsh built-in session/fork.',
      'ack.revert': 'I understand: revert shadows the picked message and everything after it',
      'ack.delete': 'I understand: this message will be shadowed (kept in the log)',
      'confirm.revert': 'Revert',
      'confirm.delete': 'Delete',
      'confirm.branch': 'Branch',
      'busy.revert': 'Reverting…',
      'busy.delete': 'Deleting…',
      'busy.branch': 'Branching…',
      'done.branch': 'Branched: new session {id} (visible after list refresh)',
      'done.restore': 'Restored: replayed {n}, skipped non-replayable {s}',
      'busy.restore': 'Restoring…',
      'done.revert': 'Reverted; reload to apply',
      'done.delete': 'Deleted; reload to apply',
      'action.reload': 'Reload page',
      'errorPrefix': 'Operation failed: ',
      'dock.title': '{n} rolled back messages',
      'dock.expand': 'Expand revert list',
      'dock.collapse': 'Collapse revert list',
      'dock.shadowedN': '{n} shadowed',
      'dock.restore': 'Restore',
      'dock.restoring': 'Restoring…',
      'slot.quote': 'Quote to composer',
      'quote.done': 'Quoted into composer',
      'quote.unavailable': 'Quote unavailable (composer locked or no full text)',
      'undo.label': '回滚上一条消息',
      'undo.desc': '移除最后一条用户消息，原文回填输入框',
      'undo.done.undo': '已回滚上一条消息',
      'undo.done.redo': '已恢复上一条被回滚的消息',
      'undo.none': '没有可回滚的消息',
      'redo.label': '恢复上一条被回滚的消息',
      'redo.desc': '把回滚掉的消息重新放回对话',
      'menu.ops': 'Message ops',
    }

    var __locale = null
    var __sessionsSvc = null
    var __inputActions = null // 0.4.0: 从 session 槽捕获（InputActions.setDraft → composer 回填）
    var __uiWorkspace = null
    var __currentSessionId = null
    // 0.9.1：视图重建后刷新 transcript 可见性的钩子。
    // 之前 restore 路径里直接调 scan()，但 scan 定义在注入器的闭包里，
    // dock 组件根本取不到 —— `typeof scan === 'function'` 静默跳过了，
    // 结果「恢复后消息回来了但仍被藏 / dock 计数不变」，必须重载页面才对。
    var __refreshSurface = null
    // 0.9.3：注入器闭包内 rowsCache 的只读出口。
    // rowsCache 声明在 installUserRevertInjector() 内（闭包私有），而 /undo 的
    // onPick 在模块级作用域 —— 直接引用会 ReferenceError，表现为点菜单毫无反应。
    var __peekRowsCache = null   // 0.6.0：会话视图会话 id（RevertDock/MsgSlotActions 刷新）
    // messageId→seq 索引缓存（每会话一次拉取；0.3.0 assistant-actions 槽用）
    var __seqIndexCache = new Map()
    // messageId→全文缓存（0.5.0 消息引用用）
    var __fullTextCache = new Map()

    function localeFallbackLang() {
      if (typeof navigator === 'undefined') return 'zh'
      for (const tag of (navigator.languages || []).concat([navigator.language])) {
        const primary = String(tag || '').toLowerCase().split('-')[0]
        if (primary === 'zh' || primary === 'en') return primary
      }
      return 'zh'
    }

    function __t(key, vars) {
      let text = key
      if (__locale && typeof __locale.translate === 'function') {
        const translated = __locale.translate(NS, key)
        if (typeof translated === 'string' && translated !== key) text = translated
      }
      if (text === key) text = (localeFallbackLang() === 'en' ? enDict : zhDict)[key] || key
      if (vars) {
        for (const k of Object.keys(vars)) text = text.split('{' + k + '}').join(String(vars[k]))
      }
      return text
    }

    function useLocaleRevision() {
      const [, setRev] = useState(0)
      useEffect(() => {
        if (!__locale || typeof __locale.subscribe !== 'function') return undefined
        return __locale.subscribe(() => setRev((v) => v + 1))
      }, [])
    }

    // --- styles（仅 --dsw-* 主题令牌） ----------------------------------------
    const btnStyle = {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 28, height: 28, padding: 0, border: 'none', borderRadius: 6,
      background: 'transparent',
      color: 'var(--dsw-alias-label-tertiary, #8a8a8e)', cursor: 'pointer', flex: 'none',
    }
    const metaStyle = {
      color: 'var(--dsw-alias-label-secondary, #8a8a8e)', fontSize: 13,
      lineHeight: '20px', margin: '0 0 8px', overflow: 'hidden', textOverflow: 'ellipsis',
    }
    const warnStyle = {
      color: 'var(--dsw-alias-state-warn-primary, #f5a524)', fontSize: 13,
      lineHeight: '20px', margin: '0 0 10px',
    }
    const errStyle = {
      color: 'var(--dsw-alias-state-error-primary, #e5484d)', fontSize: 12,
      lineHeight: '16px', marginTop: 8,
    }
    const statusStyle = {
      color: 'var(--dsw-alias-label-secondary, #8a8a8e)', fontSize: 12,
      lineHeight: '16px', marginTop: 8,
    }
    const listStyle = {
      maxHeight: 260, overflowY: 'auto', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
      borderRadius: 8, margin: '8px 0 4px', padding: '4px 0',
    }
    const rowStyle = {
      display: 'flex', alignItems: 'flex-start', gap: 8,
      padding: '4px 10px', fontSize: 13, lineHeight: '18px', cursor: 'pointer',
    }
    const descStyle = {
      color: 'var(--dsw-alias-label-secondary, #8a8a8e)', fontSize: 12,
      lineHeight: '17px', margin: '6px 0 0',
    }
    const cancelBtnStyle = {
      padding: '6px 14px', borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
      background: 'transparent', color: 'var(--dsw-alias-label-primary, inherit)',
      fontSize: 13, cursor: 'pointer', marginRight: 8,
    }
    const primaryBtnStyle = {
      padding: '6px 14px', borderRadius: 8, border: 'none',
      background: 'var(--dsw-alias-brand-primary, #4d6bfe)', color: '#fff',
      fontSize: 13, cursor: 'pointer',
    }
    const dangerBtnStyle = {
      padding: '6px 14px', borderRadius: 8,
      border: '1px solid var(--dsw-alias-state-error-primary, #e5484d)',
      background: 'var(--dsw-alias-state-error-primary, #e5484d)',
      color: '#fff', fontSize: 13, cursor: 'pointer',
    }
    const optStyle = {
      display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, lineHeight: '20px',
      color: 'var(--dsw-alias-label-primary, inherit)', marginTop: 10,
    }

    // 头部按钮图标：三叉分支（git-branch 风格，16x16）。
    const BRANCH_PATH = 'M5 2.5a2 2 0 1 1-.9 3.78v3.44a2 2 0 1 1-1.2 0V6.28A2 2 0 1 1 5 2.5Zm0 1.2a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6ZM3.5 11.5a.8.8 0 1 0 1.6 0 .8.8 0 0 0-1.6 0ZM12.5 2.5a2 2 0 0 1 .6 3.9v.85c0 1.9-1.54 3.44-3.44 3.44H8.03a2 2 0 1 1 0-1.2h1.63a2.24 2.24 0 0 0 2.24-2.24V6.4a2 2 0 0 1 .6-3.9Zm0 1.2a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6Z'

    function BranchIcon() {
      return React.createElement('svg', {
        width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg',
      }, React.createElement('path', { d: BRANCH_PATH, fill: 'currentColor' }))
    }

    // --- 共享对话框 -------------------------------------------------------------
    // 模块级缓存最近一次 target，事件驱动打开。
    const MAX_RENDER = 200
    const PAGE_SIZE = 50   // 低成本分批渲染：先渲 50 条，按钮渐进展开

    function OpsDialog(props) {
      const t = (props && props.t) || __t
      useLocaleRevision()
      const [target, setTarget] = useState(null)     // {sessionId, title, running}
      const [state, setState] = useState('idle')     // idle|loading|ready|busy|done
      const [messages, setMessages] = useState([])
      const [sessionMeta, setSessionMeta] = useState(null)
      const [picked, setPicked] = useState(null)     // seq
      const [mode, setMode] = useState(null)         // revert|delete|branch|restore
      const [childId, setChildId] = useState(null)   // 官方 fork 成功后的子会话 id
      const [acknowledged, setAcknowledged] = useState(false)
      const [busyMsg, setBusyMsg] = useState('')
      const [renderLimit, setRenderLimit] = useState(PAGE_SIZE) // 已展开的渲染条数
      const [doneMsg, setDoneMsg] = useState('')
      const [error, setError] = useState(null)

      useEffect(() => {
        const handler = (e) => {
          const d = e && e.detail ? e.detail : {}
          setTarget({ sessionId: d.sessionId || null, title: d.title || null, running: d.running === true })
          setState('loading')
          setMessages([]); setSessionMeta(null)
          // 槽按钮预置：携带 seq（picked）与 mode 直接进入确认态
          setPicked(typeof d.seq === 'number' ? d.seq : null)
          setMode(typeof d.mode === 'string' ? d.mode : null)
          setAcknowledged(false); setError(null); setDoneMsg('')
          setRenderLimit(PAGE_SIZE)
        }
        window.addEventListener(EVENT, handler)
        return () => window.removeEventListener(EVENT, handler)
      }, [])

      useEffect(() => {
        if (state !== 'loading' || !target || !target.sessionId) return
        let cancelled = false
        fetch('/api/message-ops/messages?sessionId=' + encodeURIComponent(target.sessionId))
          .then((r) => r.json())
          .then((data) => {
            if (cancelled) return
            if (!data || !data.ok) throw new Error(data && data.error ? data.error : `HTTP ${data && data.status}`)
            setMessages(data.messages || [])
            setSessionMeta(data.session || null)
            if (data.running === true) setTarget((prev) => ({ ...(prev || {}), running: true }))
            setState('ready')
          })
          .catch((reason) => {
            if (cancelled) return
            setError(t('dialog.loadFail') + (reason && reason.message ? reason.message : String(reason)))
            setState('ready')
          })
        return () => { cancelled = true }
      }, [state, target, t])

      const close = useCallback(() => {
        if (state === 'busy') return
        setTarget(null); setError(null)
      }, [state])

      const pick = useCallback((m) => {
        if (state === 'busy') return
        setPicked(m.seq)
        setMode(null); setAcknowledged(false); setError(null)
      }, [state])

      const chooseMode = useCallback((m) => {
        if (picked == null || state === 'busy') return
        setMode(m); setAcknowledged(false); setError(null)
      }, [picked, state])

      const run = useCallback(() => {
        if (state === 'busy' || picked == null || !mode) return
        if (mode !== 'branch' && !acknowledged) return
        setBusyMsg(t('busy.' + (mode === 'revert' || mode === 'delete' ? mode : 'branch')))
        setState('busy'); setError(null)
        if (mode === 'branch') {
          // 0.9.0：分支**只走官方** sessions.fork({atSeq})。
          // 原先有一条「官方失败 → 磁盘 applyBranch」的回落，但那个实现语义是错的：
          // 它删掉 isSeeded（官方 fork 设 true）、不写 inheritedEventCount、
          // 也不调 buildForkSeed 补 step/turn closers → 产出的子会话边界可能悬空。
          // 官方 fork 失败通常意味着源会话正在运行，正确做法是拒绝而非绕过引擎写盘。
          const forkPath = pickForkPath(__sessionsSvc)
          if (forkPath.kind !== 'official') {
            setError(t('fork.unavailable'))
            setBusyMsg('')
            setState('error')
            return
          }
          forkPath.fork({ sessionId: target.sessionId, atSeq: picked, increaseTitle: true })
            .then((childId) => {
              setDoneMsg(t('fork.official', { id: String(childId || '') }))
              setBusyMsg('')
              setChildId(childId || null)
              setState('done')
              notifyDone(t('fork.official', { id: String(childId || '') }))
            })
            .catch((reason) => {
              setError(String((reason && reason.message) || reason || t('fork.unavailable')))
              setBusyMsg('')
              setState('error')
            })
          return
        }
        const path = mode
        const body = { sessionId: target.sessionId, seq: picked }
        Promise.resolve()
          .then(() => fetch('/api/message-ops/' + path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }))
          .then(async (res) => {
            let data = {}
            try { data = await res.json() } catch { /* keep {} */ }
            if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
            // S6 修复（G-M1）：不再 900ms 裸 location.reload。成功走 devkit
            // 标准 toast（无 devkit 时降级为对话框内 doneMsg），并提供手动
            // 「刷新页面」按钮。
              ? t('done.restore', { n: String(data.restoredCount != null ? data.restoredCount : '?'), s: String(data.skipped != null ? data.skipped : 0) })
              : t(mode === 'revert' ? 'done.revert' : 'done.delete')
            // 0.4.0 composer 回填（opencode 式）：回滚用户消息 → 原文回填输入框，「编辑重发」零按钮
            if (mode === 'revert' && pickedMsg && pickedMsg.role === 'user' && pickedMsg.fullText
                && __inputActions && typeof __inputActions.setDraft === 'function') {
              try { __inputActions.setDraft(pickedMsg.fullText) } catch { /* 回填失败不阻断成功反馈 */ }
            }
            setDoneMsg(okMsg)
            setBusyMsg('')
            setState('done')
            notifyDone(okMsg)
            emitChanged()
            // 0.5.7：store-miss 的磁盘追加没有 live 投影事件 —— 成功后强制
            // 重建视图（与 restoreRow 同款 openSession 模式），遮蔽即刻可见。
            try {
              if (__uiWorkspace && typeof __uiWorkspace.openSession === 'function') __uiWorkspace.openSession(target.sessionId)
            } catch { /* 视图重建失败不阻断成功反馈 */ }
          })
          .catch((reason) => {
            setBusyMsg('')
            setState('ready')
            setError(t('errorPrefix') + (reason && reason.message ? reason.message : String(reason)))
          })
      }, [state, picked, mode, acknowledged, target, t])

      if (!target) return null

      // 0.6.0：system prompt 行不可作为回滚/删除/分支目标（引擎拒之以 node0 守卫，
      // 但不该给用户一个必然500的选项）——列表直接排除 role=system。
      const visible = messages.filter((m) => m.visible !== false && m.role !== 'system')
      const shownBase = visible.slice(-MAX_RENDER)
      const hiddenCount = visible.length - shownBase.length
      // 分批渲染（评审 M1）：只渲染 renderLimit 条，更早的留给「显示更多」
      // 渐进展开，避免 200 行 radio 列表一次进 DOM。
      const shown = shownBase.slice(-renderLimit)
      const pagedCount = shownBase.length - shown.length
      const pickedMsg = picked != null ? messages.find((m) => m.seq === picked) : null

      // 0.9.0 可发现性：操作区固定在**消息列表之前**。
      // 原先它在列表之后，而列表是 260px 滚动 + 分批渲染 50 条/页 ——
      // 未选中消息时三个 radio 完全不在视野内，用户以为「只有列表、没有操作」。
      // 未选中时给明确指引，而不是空着。
      const opsPanel = pickedMsg
        ? React.createElement('div', { key: 'ops', style: { margin: '8px 0 0' } },
            React.createElement('div', { style: { ...metaStyle, margin: '0 0 4px' } },
              t('dialog.pickedAs', { seq: String(pickedMsg.seq), text: (pickedMsg.snippet || '').slice(0, 60) })),
            ['revert', 'delete', 'branch'].map((m, i) => React.createElement('div', { key: m, style: { marginTop: i === 0 ? 6 : 4 } },
              React.createElement('label', { style: optStyle },
                React.createElement('input', {
                  type: 'radio', name: 'dsh-message-ops-mode', checked: mode === m,
                  onChange: () => chooseMode(m), disabled: state === 'busy',
                }),
                t('op.' + m)),
              mode === m ? React.createElement('div', { style: descStyle }, t('op.' + m + 'Desc')) : null,
            )),
            mode && mode !== 'branch'
              ? React.createElement('label', { key: 'ack', style: optStyle },
                  React.createElement('input', {
                    type: 'checkbox', checked: acknowledged, disabled: state === 'busy',
                    onChange: (e) => setAcknowledged(e.target.checked),
                  }),
                  t(mode === 'revert' ? 'ack.revert' : 'ack.delete'))
              : null,
          )
        : React.createElement('div', { key: 'opshint', style: { ...metaStyle, margin: '8px 0 0', padding: '6px 8px', borderRadius: 6, background: 'var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1))' } },
            t('dialog.pickFirst'))

      let body
      if (state === 'loading') {
        body = React.createElement('div', { key: 'load', style: statusStyle }, t('dialog.loading'))
      } else if (!messages.length) {
        body = React.createElement('div', { key: 'empty', style: statusStyle }, t('dialog.empty'))
      } else {
        body = React.createElement(React.Fragment, null, [
          target.running ? React.createElement('div', { key: 'warn', style: warnStyle }, t('dialog.runningWarn')) : null,
          opsPanel,
          React.createElement('div', { key: 'pick', style: metaStyle }, t('dialog.pick')),
          React.createElement('div', { key: 'list', style: listStyle },
            hiddenCount > 0
              ? React.createElement('div', { key: 'more', style: { ...rowStyle, cursor: 'default', color: 'var(--dsw-alias-label-secondary,#8a8a8e)' } },
                  t('dialog.more', { n: String(visible.length) }))
              : null,
            pagedCount > 0
              ? React.createElement('button', {
                  key: 'show-more', type: 'button',
                  style: { ...rowStyle, border: 'none', width: '100%', color: 'var(--dsw-alias-label-secondary,#8a8a8e)', cursor: 'pointer' },
                  onClick: () => setRenderLimit((l) => Math.min(l + PAGE_SIZE, MAX_RENDER)),
                }, t('dialog.showMore', { n: String(pagedCount) }))
              : null,
            shown.map((m, i) => React.createElement('label', {
              key: m.seq + '-' + i, style: {
                ...rowStyle,
                background: picked === m.seq ? 'var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))' : 'transparent',
              },
            },
              React.createElement('input', {
                type: 'radio', name: 'dsh-message-ops-pick', checked: picked === m.seq,
                onChange: () => pick(m), disabled: state === 'busy',
              }),
              React.createElement('span', {
                style: {
                  flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  color: m.visible === false ? 'var(--dsw-alias-label-tertiary,#b0b0b4)' : 'inherit',
                },
              },
                '#' + m.seq + ' ' + (m.role || '') + ' · ' + (m.snippet || '') + (m.visible === false ? t('dialog.invisible') : '')),
            )),
          ),
          opsPanel,
        ])
      }

      const canRun = state !== 'busy' && state !== 'loading' && picked != null && mode != null
        && (mode === 'branch' || acknowledged)
      const confirmLabel = busyMsg || (mode ? t('confirm.' + mode) : t('dialog.cancel'))

      return React.createElement(Modal, {
        open: true,
        onClose: close,
        title: t('dialog.title'),
        closeLabel: t('dialog.cancel'),
        description: t('dialog.session') + (target.title || target.sessionId || ''),
        footer: [
          React.createElement('button', {
            key: 'cancel', type: 'button', disabled: state === 'busy',
            onClick: close, style: { ...cancelBtnStyle, ...(state === 'busy' ? { opacity: 0.5, cursor: 'default' } : {}) },
          }, t('dialog.cancel')),
          React.createElement('button', {
            key: 'confirm', type: 'button', disabled: !canRun,
            onClick: run,
            style: {
              ...(mode === 'delete' || mode === 'revert' ? dangerBtnStyle : primaryBtnStyle),
              ...(!canRun ? { opacity: 0.5, cursor: 'default' } : {}),
            },
          }, confirmLabel),
          ...(state === 'done' && (mode === 'revert' || mode === 'delete') ? [React.createElement('button', {
            key: 'reload', type: 'button',
            onClick: () => { try { window.location.reload() } catch { /* non-browser guard */ } },
            style: primaryBtnStyle,
          }, t('action.reload'))] : []),
          ...(state === 'done' && mode === 'branch' && childId ? [React.createElement('button', {
            key: 'open-new', type: 'button',
            onClick: () => {
              try {
                // 0.2.0+：uiWorkspace.openSession 是宿主唯一打开通道
                if (__uiWorkspace && typeof __uiWorkspace.openSession === 'function') __uiWorkspace.openSession(childId)
              } catch { /* 打开失败不阻断 */ }
            },
            style: primaryBtnStyle,
          }, t('toast.openNew'))] : []),
        ],
      }, [
        React.createElement('div', { key: 'meta', style: metaStyle },
          t('dialog.session'), target.sessionId || ''),
        body,
        doneMsg ? React.createElement('div', { key: 'done', style: statusStyle }, doneMsg) : null,
        error ? React.createElement('div', { key: 'err', style: errStyle, role: 'alert' }, error) : null,
      ])
    }

    // --- 头部按钮 ---------------------------------------------------------------

    // 0.3.0 分支双路径选择：0.2.0+ 官方 sessions.fork({atSeq}) 优先。
    function pickForkPath(sessionsSvc) {
      if (sessionsSvc && typeof sessionsSvc.fork === 'function') {
        return { kind: 'official', fork: sessionsSvc.fork.bind(sessionsSvc) }
      }
      return { kind: 'disk' }
    }

    // 成功反馈统一出口：devkit 标准 toast 优先，无 devkit 时对话框内文案兜底。
    function notifyDone(msg, kind) {
      try {
        const dk = window.__dshDevkit
        if (dk && typeof dk.toast === 'function') dk.toast(msg, { kind: kind || 'ok' })
      } catch { /* toast 缺席不阻断成功反馈 */ }
    }

    function OpsButton(props) {
      const { sessionId, useSessions } = props
      const t = (props && props.t) || __t
      useLocaleRevision()
      const sessions = useSessions ? useSessions((s) => s) : undefined
      const summary = sessions && sessions.byId ? sessions.byId[sessionId] : undefined
      const running = summary ? summary.running === true : false

      const openDialog = useCallback(() => {
        window.dispatchEvent(new CustomEvent(EVENT, {
          detail: { sessionId, title: summary && summary.title ? summary.title : null, running },
        }))
      }, [sessionId, summary, running])

      return React.createElement('button', {
        type: 'button', title: t('button.title'), 'aria-label': t('button.title'),
        style: btnStyle, onClick: openDialog,
      }, React.createElement(BranchIcon))
    }

    // 官方图标适配：0.2.0 primitives 的 IconClock 与原生操作行同款；
    // require 失败（0.1.x 或裁剪环境）回退内联 SVG，槽在 0.1.x 本就不存在，仅防御。
    // 0.9.0：移除 IconTrash —— 消息级删除按钮从未渲染（删除只在对话框里），
    // 专家核查确认 IconTrash/TrashFallback 零渲染点，是死代码。
    var IconClock = null
    try {
      const P = require('@deepseek-ai/dsh-client-ui-primitives')
      IconClock = P && P.IconClockOutlineRegular
    } catch { /* fallback below */ }
    if (!IconClock) IconClock = function ClockFallback() {
      // 官方 IconClockOutlineArtwork 1:1 路径（ Regular = 1px stroke）
      return React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, stroke: 'currentColor', strokeWidth: 1 },
        React.createElement('path', { d: 'M8 14C11.3137 14 14 11.3137 14 8C14 4.68629 11.3137 2 8 2C4.68629 2 2 4.68629 2 8C2 11.3137 4.68629 14 8 14Z' }),
        React.createElement('path', { d: 'M8 4.31V8.46L11 10.08' }))
    }
    var IconQuote = null
    try {
      const P2 = require('@deepseek-ai/dsh-client-ui-primitives')
      IconQuote = P2 && (P2.IconChatOutlineRegular || P2.IconCopyOutlineRegular)
    } catch { /* fallback below */ }
    if (!IconQuote) IconQuote = function QuoteFallback() {
      return React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, stroke: 'currentColor', strokeWidth: 1 },
        React.createElement('path', { d: 'M3 6.5A3.5 3.5 0 0 1 6.5 3H7v1.5h-.5A2 2 0 0 0 4.5 6.5V7H7v3.5H3V6.5ZM9 6.5A3.5 3.5 0 0 1 12.5 3H13v1.5h-.5A2 2 0 0 0 10.5 6.5V7H13v3.5H9V6.5Z' }))
    }

    // --- 0.3.0 assistant-actions 官方槽：每条 AI 消息旁的原生回撤按钮 ------------
    // 契约（dsh-cordis-client-runner）：scope session，条目组件收 { messageId } +
    // 标准props（useSessions/sessionId/useSession/useChat…）。0.1.x 无此 key，
    // slots.inject 自动 no-op。
    const CHAT_ACTIONS_SLOT = 'conversation.chat.assistant-actions'
    const CHAT_ACTIONS_ID = 'message-ops-row'

    function MsgSlotActions(props) {
      const { messageId, sessionId, useSessions, inputActions, useChat } = props
      const t = (props && props.t) || __t
      useLocaleRevision()
      if (inputActions && typeof inputActions.setDraft === 'function') __inputActions = inputActions
      const sessions = useSessions ? useSessions((s) => s) : undefined
      const summary = sessions && sessions.byId ? sessions.byId[sessionId] : undefined
      const running = summary ? summary.running === true : false
      const [seq, setSeq] = React.useState(null)
      const [fullText, setFullText] = React.useState(null)
      const [busy, setBusy] = React.useState(null) // 'revert' | null（S11 双提交防护）
      React.useEffect(() => {
        if (!messageId || !sessionId) return
        let alive = true
        const cached = __seqIndexCache.get(sessionId)
        const resolve = (index) => {
          if (!alive) return
          const hit = index && index.get(String(messageId))
          if (typeof hit === 'number') setSeq(hit)
        }
        if (cached && typeof cached.then === 'function') cached.then(resolve).catch(() => {})
        else if (cached) resolve(cached)
        else {
          const p = fetch('/api/message-ops/messages?sessionId=' + encodeURIComponent(sessionId))
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
            .then((data) => {
              const index = new Map()
              const full = new Map()
              for (const m of (data && data.messages) || []) {
                // 0.5.2（P2）：同 id 取**最早** seq——与服务端 buildSeqIndex 口径一致
                // （重试链取最早可见节点；此前内联 set 覆盖=取最大，双实现分裂）
                if (m && m.id != null && !index.has(String(m.id))) index.set(String(m.id), m.seq)
                if (m && m.id != null && m.fullText) full.set(String(m.id), m.fullText)
              }
              __seqIndexCache.set(sessionId, index)
              __fullTextCache.set(sessionId, full)
              return index
            })
          __seqIndexCache.set(sessionId, p)
          // 0.5.2（P2）：失败必须清缓存——否则 rejected promise 被永久缓存，
          // 该会话按钮/dock 到刷新页面为止全部失效
          p.then(resolve).catch(() => { __seqIndexCache.delete(sessionId) })
        }
        return () => { alive = false }
      }, [messageId, sessionId])

      // 原文（引用用）：seq 解析后按需取全文
      React.useEffect(() => {
        if (seq == null || !sessionId) return
        let alive = true
        const cached = __fullTextCache.get(sessionId)
        const resolve = (full) => {
          if (!alive) return
          const hit = full && full.get(String(messageId))
          if (typeof hit === 'string') setFullText(hit)
        }
        if (cached && typeof cached.then === 'function') cached.then(resolve).catch(() => {})
        else if (cached) resolve(cached)
        return () => { alive = false }
      }, [seq, messageId, sessionId])

      // 0.5.0 回撤后的视图刷新：openSession(reveal) 重建会话视图 → 遮蔽立即呈现。
      // （宿主 live 投影只处理 compaction 类 replace，插件标记需要视图重建才可见。）
      const revealSession = () => {
        try {
          if (__uiWorkspace && typeof __uiWorkspace.openSession === 'function') {
            __uiWorkspace.openSession(sessionId)
            return true
          }
        } catch { /* fallthrough */ }
        return false
      }

      const runRevert = () => {
        if (busy || seq == null || running) return
        setBusy('revert')
        // 0.5.2（P2）：Promise.resolve 包裹——fetch/stringify 同步抛出也转为
        // rejection 落进 finally，busy 永不卡死
        Promise.resolve()
          .then(() => fetch('/api/message-ops/revert', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, seq }),
          }))
          .then(async (res) => {
            let data = {}
            try { data = await res.json() } catch { /* keep {} */ }
            if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status))
            notifyDone(t('done.revert'))
            revealSession()
            emitChanged()
          })
          .catch((reason) => {
            notifyDone(t('errorPrefix') + (reason && reason.message ? reason.message : String(reason)), 'error')
          })
          .finally(() => setBusy(null))
      }

      // 0.5.0 消息引用：官方 InputActions.captureInsertion + insertText（零 DOM hack）
      const runQuote = () => {
        try {
          if (!inputActions || typeof inputActions.captureInsertion !== 'function' || typeof inputActions.insertText !== 'function') {
            notifyDone(t('quote.unavailable'), 'warn')
            return
          }
          const span = inputActions.captureInsertion()
          const insertQuote = (text) => {
            if (text == null || text === '') { notifyDone(t('quote.unavailable'), 'warn'); return }
            const quoted = text.split('\n').map((l) => '> ' + l).join('\n') + '\n\n'
            const ok = inputActions.insertText(quoted, span)
            notifyDone(ok ? t('quote.done') : t('quote.unavailable'), ok ? 'ok' : 'warn')
          }
          // assistant 消息 fullText 恒 null（列表不携带）→ 按 seq 向服务端取单条全文
          if (fullText != null && fullText !== '') { insertQuote(fullText); return }
          fetch('/api/message-ops/text?sessionId=' + encodeURIComponent(sessionId) + '&seq=' + encodeURIComponent(seq))
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => insertQuote(d && d.ok && typeof d.text === 'string' ? d.text : null))
            .catch(() => insertQuote(null))
        } catch (e) {
          notifyDone(t('errorPrefix') + (e && e.message ? e.message : String(e)), 'error')
        }
      }

      if (seq == null) return null
      const act = (icon, label, mode, onClick, disabled) => React.createElement('button', {
        type: 'button', title: running && mode === 'revert' ? t('dialog.runningWarn') : label,
        'aria-label': label, disabled: !!disabled,
        style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                 minWidth: 44, minHeight: 44, padding: 0, border: 'none', background: 'transparent',
                 color: 'inherit', opacity: busy && busy !== mode ? 0.4 : running && mode === 'revert' ? 0.35 : 0.72,
                 cursor: disabled ? 'default' : 'pointer', borderRadius: 6 },
        onClick,
      }, icon)
      return React.createElement('span', { style: { display: 'inline-flex', gap: 0 } },
        act(React.createElement(IconClock, { size: 16 }), t('slot.revert'), 'revert', runRevert, running),
        act(React.createElement(IconQuote, { size: 16 }), t('slot.quote'), 'quote', runQuote, false),
      )
    }

    // 0.4.2 引入（恢复的标记自动离开活跃列表 = opencode clear 语义）。
    // 0.5.0 脚本化编辑曾误删本函数 → dock 100% 静默失效（P0，0.5.2 恢复）。
    function activeMarkers(msgs) {
      // 0.8.0：活跃判定收敛到服务端权威字段 restoreComplete
      // （按 restoredSourceSeqs 进度算；旧 notice 无该字段 → 服务端视为整段已恢复）。
      // 旧的"行内 restoresSeq 集合"客户端判定已删除——按轮步进下部分恢复的标记
      // 也带 restoresSeq，旧逻辑会把它们误杀（实测：第一轮恢复后整条消失）。
      return (msgs || []).filter((m) => m.marker && m.sourceKind !== 'compact-checkpoint' && m.restoreComplete !== true)
    }

    function RevertDock(props) {
      const { sessionId, useSessions, inputActions } = props
      if (sessionId) __currentSessionId = sessionId
      const t = (props && props.t) || __t
      useLocaleRevision()
      if (inputActions && typeof inputActions.setDraft === 'function') __inputActions = inputActions
      const sessions = useSessions ? useSessions((s) => s) : undefined
      const summary = sessions && sessions.byId ? sessions.byId[sessionId] : undefined
      const running = summary ? summary.running === true : false
      const [open, setOpen] = useState(false)
      const [markers, setMarkers] = useState(null) // 活跃回撤标记（已恢复的自动消失）
      const [shadowCount, setShadowCount] = useState(0) // 标记 range 内被遮蔽消息数（标题口径）
      const [restoring, setRestoring] = useState(null)
      const [styleInjected, setStyleInjected] = useState(false)

      // opencode SessionRevertDock 视觉（v2 布局，DSH 令牌等价映射）
      useEffect(() => {
        if (styleInjected || typeof document === 'undefined') return
        if (document.getElementById('dsh-message-ops-dock-style')) { setStyleInjected(true); return }
        const tag = document.createElement('style')
        tag.id = 'dsh-message-ops-dock-style'
        tag.textContent = [
          // 容器：rounded-xl + 0.5px 边框 + bg-layer-01（M1 修正令牌）
          // 0.6.0 贴条（对齐 opencode）：宽度锁到输入卡片同源变量（uV2eYG_card 同款
          // max-width），居中；margin-bottom:-5px 把 composerStack 的6px gap 压成
          // **1px 视觉贴合**（实测基线 gap14→目标1）。
          '.mopsRd{width:100%;max-width:var(--dsh-composer-card-max-width);margin-inline:auto;margin-bottom:-5px;overflow:hidden;border-radius:var(--dsw-radius-md,12px);border:.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));background:var(--dsw-alias-bg-layer-1,#1e1e20)}',
          // 头部 42px：图标 + label + 折叠预览 + 旋转 chevron
          '.mopsRdHead{display:flex;height:40px;align-items:center;gap:8px;padding-left:16px;padding-right:8px;cursor:pointer;user-select:none}',
          '.mopsRdIcon{display:inline-flex;color:var(--dsw-alias-label-tertiary,#9a9aa0);flex:none}',
          '.mopsRdLabel{font-size:13px;font-weight:500;line-height:20px;letter-spacing:-.04px;flex:none;cursor:default;color:var(--dsw-alias-label-primary,inherit)}',
          '.mopsRdLabelCollapsed{color:var(--dsw-alias-label-secondary,#a8a8ae)}',
          '.mopsRdPreview{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:400;line-height:20px;letter-spacing:-.04px;cursor:default;color:var(--dsw-alias-label-tertiary,#9a9aa0)}',
          '.mopsRdChevron{margin-left:auto;flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary,#9a9aa0);cursor:pointer;transition:transform .15s ease}',
          // 列表：24px 行 + neutral 小按钮（非文字链）
          '.mopsRdList{display:flex;flex-direction:column;gap:8px;max-height:168px;overflow-y:auto;padding:1px 16px 12px}',
          '.mopsRdRow{display:flex;height:24px;min-width:0;align-items:center;gap:8px}',
          '.mopsRdRowText{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:400;line-height:20px;letter-spacing:-.04px;color:var(--dsw-alias-label-secondary,#a8a8ae)}',
          '.mopsRdRestore{flex:none;font:inherit;font-size:12px;line-height:18px;padding:2px 10px;border-radius:6px;cursor:pointer;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));opacity:1}',
          '.mopsRdRestore:disabled{opacity:.45;cursor:default}',
        ].join('')
        document.head.appendChild(tag)
        setStyleInjected(true)
      }, [styleInjected])

      useEffect(() => {
        let alive = true
        const onChange = () => load()
        window.addEventListener(CHANGED_EVENT, onChange)
        const load = () => fetch('/api/message-ops/messages?sessionId=' + encodeURIComponent(sessionId))
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            if (!alive || !data || !data.ok) return
            const msgs = data.messages || []
            setMarkers(activeMarkers(msgs))
            // 0.5.2（P2）：标题口径 = 标记 range 内 visible=false 的去重 seq 数
            const seen = new Set()
            for (const mk of activeMarkers(msgs)) {
              const start = mk.range && typeof mk.range.start === 'number' ? mk.range.start : mk.seq
              const end = mk.range && typeof mk.range.end === 'number' ? mk.range.end : start
              for (const m of msgs) {
                if (m && m.visible === false && typeof m.seq === 'number' && m.seq >= start && m.seq <= end) seen.add(m.seq)
              }
            }
            setShadowCount(seen.size)
          })
          .catch(() => {})
        load()
        return () => { alive = false; window.removeEventListener(CHANGED_EVENT, onChange) }
      }, [sessionId])

      // items 变化自动折叠（opencode createEffect 同款；必须在早退之前——Hooks 规则）
      useEffect(() => { setOpen(false) }, [markers && markers.length, markers && markers[0] && markers[0].seq])
      if (!markers || !markers.length) return null

      const restoreRow = (row) => {
        if (restoring != null || running) return
        setRestoring(rowKey(row))
        Promise.resolve()
          .then(() => fetch('/api/message-ops/restore', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            // 0.8.0：upToSeq 存在 → 按轮步进恢复（只重放到该 seq）
            body: JSON.stringify(row.upTo != null ? { sessionId, seq: row.seq, upToSeq: row.upTo } : { sessionId, seq: row.seq }),
          }))
          .then(async (res) => {
            let data = {}
            try { data = await res.json() } catch { /* keep {} */ }
            if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status))
            notifyDone(t('done.restore', { n: String(data.restoredCount != null ? data.restoredCount : '?'), s: String(data.skipped != null ? data.skipped : 0) }))
            setRestoring(null)
            // 0.5.0：恢复后重建会话视图（重放消息立即可见）
            try {
              if (__uiWorkspace && typeof __uiWorkspace.openSession === 'function') __uiWorkspace.openSession(sessionId)
            } catch { /* fallthrough */ }
            // 0.9.1：重放的消息带**新 seq**，被恢复的行必须解除 hidden，
            // 同时 dock 的权威 marker 列表要重拉。
            try { window.dispatchEvent(new Event(CHANGED_EVENT)) } catch { /* non-browser */ }
            // 0.9.1：重放的消息带**新 seq**，被恢复的行必须解除 hidden；
            // 同时 dock 的 marker 列表要按权威数据重算（restoreComplete 会变 true）。
            for (const delay of [150, 700, 1600]) setTimeout(() => { if (__refreshSurface) __refreshSurface(sessionId) }, delay)
            const fresh = await fetch('/api/message-ops/messages?sessionId=' + encodeURIComponent(sessionId)).then((r) => (r.ok ? r.json() : null)).catch(() => null)
            if (fresh && fresh.ok) setMarkers(activeMarkers(fresh.messages || []))
          })
          .catch((reason) => {
            notifyDone(t('errorPrefix') + (reason && reason.message ? reason.message : String(reason)), 'error')
          })
          .finally(() => setRestoring(null))
      }


      const headerKbd = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v) } }
      // 0.5.2（P2）：标题报「被遮蔽消息数」而非标记数——一个 revert 可遮蔽数百条，
      // 用标记数会严重低报（0.4.2 文案引入的错口径）；无 range 数据时回退标记数
      const label = t('dock.title', { n: String(shadowCount || markers.length) })
      const preview = markers[0] && markers[0].snippet ? markers[0].snippet : ''

      // 0.8.0：行 = 待恢复"轮"（对齐 opencode 按轮步进）；无可重放轮的标记
      // 保留旧式整段行（空区间 → 停用 notice 路径）。restoring 键区分同标记多轮。
      const rowKey = (row) => (row.upTo != null ? row.seq + ':' + row.upTo : String(row.seq))
      const rowEl = (row) => React.createElement('div', { key: rowKey(row), className: 'mopsRdRow' },
        React.createElement('span', { className: 'mopsRdRowText' }, '#' + row.seq + ' · ' + (row.snippet || '')),
        React.createElement('button', {
          type: 'button', className: 'mopsRdRestore', disabled: restoring != null || running,
          onClick: () => restoreRow(row),
        }, restoring === rowKey(row) ? t('dock.restoring') : t('dock.restore')),
      )
      const dockRows = []
      for (const mk of markers || []) {
        if (Array.isArray(mk.pendingTurns) && mk.pendingTurns.length > 0) {
          for (const t of mk.pendingTurns) {
            dockRows.push({ seq: mk.seq, upTo: t.upTo, snippet: t.preview + (t.count > 1 ? ' (+' + (t.count - 1) + ')' : '') })
          }
        } else {
          dockRows.push({ seq: mk.seq, snippet: mk.snippet })
        }
      }

      const chevron = React.createElement('button', {
        type: 'button', 'aria-label': open ? t('dock.collapse') : t('dock.expand'), 'aria-expanded': open,
        className: 'mopsRdChevron',
        onClick: (e) => { e.stopPropagation(); setOpen((v) => !v) },
      }, React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
        style: { transform: open ? 'rotate(0deg)' : 'rotate(180deg)', transition: 'transform .15s ease' } },
        React.createElement('path', { d: 'M4 6l4 4 4-4', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' })))

      return React.createElement('div', { className: 'mopsRd', role: 'region', 'aria-label': label },
        React.createElement('div', {
          className: 'mopsRdHead', role: 'button', tabIndex: 0,
          onClick: () => setOpen((v) => !v), onKeyDown: headerKbd,
        },
          React.createElement('span', { className: 'mopsRdIcon' },
            React.createElement('svg', { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none' },
              React.createElement('path', { d: 'M2.5 8a5.5 5.5 0 1 0 1.6-3.9', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
              React.createElement('path', { d: 'M2.2 2.8v3h3', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' }))),
          React.createElement('span', { className: 'mopsRdLabel' + (open ? '' : ' mopsRdLabelCollapsed') }, label),
          open ? null : React.createElement('span', { className: 'mopsRdPreview' }, preview),
          React.createElement('span', { style: { marginLeft: 'auto', flex: 'none' } }, chevron)),
        open ? React.createElement('div', { className: 'mopsRdList' }, dockRows.map(rowEl)) : null,
      )
    }

    // --- 侧栏行菜单注入（DOM 级，同 session-delete 模式） ------------------------

    function findOpenSessionRow() {
      var rows = document.querySelectorAll('[class*=sessionRow]')
      for (var i = 0; i < rows.length; i++) {
        if (String(rows[i].className || '').indexOf('menuOpen') >= 0) return rows[i]
      }
      return null
    }

    // --- 0.7.0 用户消息「回滚」按钮（DOM 注入，挂在官方动作行内）-------------------
    // 0.6.0 的教训（用户实测反馈）：absolute 覆盖在气泡上 = 压住文字、布局乱；
    // 且 opacity:0 + :hover 在触屏上永远不显形（点不了）。
    // 官方用户消息的动作行 = .xzv4MW_actions（含 Copy，height28，位于消息下方 16px），
    // 可见性由宿主 [data-actions-reveal] 控制。0.7.0：把按钮 append 进该行，
    // 与 Copy 同级同层，可见性天然继承宿主动作行（不再自己玩 hover）。
    function installUserRevertInjector() {
      if (window.__MOPS_USER_REVERT_INSTALLED) return
      window.__MOPS_USER_REVERT_INSTALLED = true
      var rowsCache = { sid: null, rows: null, at: 0 }
      __peekRowsCache = () => rowsCache
      var norm = (x) => String(x || '').replace(/\s+/g, '')
      var fetchRows = (sid) => {
        if (rowsCache.sid === sid && rowsCache.rows && Date.now() - rowsCache.at < 8000) return Promise.resolve(rowsCache)
        return fetch('/api/message-ops/messages?sessionId=' + encodeURIComponent(sid))
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            // 宿主会把 <system-reminder> / runtime context 等也记为 role=user 的行，
            // DOM 里并不渲���成"我的消息"块 —— 必须滤掉，否则按序配对会错位（0.7.0 根因）。
            //
            // 0.9.0 两个实机 bug（浏览器实测：4 个按钮 data-mops-seq 全为 null，点击必失败）：
            //  ① 正则跑在 norm() 之后的串上，而 norm 是 replace(/\s+/g,'') —— 删掉**全部**空白，
            //     `current\s+runtime\s+context` 永远匹配不上 → runtime-context 伪行漏进配对。
            //     修法：injected() 改判**原始 snippet**。
            //  ② 过滤了 `m.visible !== false`，但宿主聊天视图**不施��**遮蔽模型，照常渲染
            //     被回滚遮蔽的消息 → 配对候选与 DOM 块零交集。
            //     修法：DOM 配对必须覆盖全部 user 行（含遮蔽态）。
            //     注意：对话框的「可回滚目标」列表仍应过滤 visible（那是另一套语义）。
            const injected = (raw) => /^<system-reminder|current\s+runtime\s+context|^<system-Reminder/i.test(String(raw || ''))
            const rows = ((d && d.messages) || [])
              .filter((m) => m && m.role === 'user')
              .map((m) => ({ seq: m.seq, sn: norm(m.snippet), raw: String(m.snippet == null ? '' : m.snippet), fullText: m.fullText ?? null, visible: m.visible !== false }))
              .filter((r) => r.sn && !injected(r.raw))
            // 0.9.1：同时产出 node-key 查表索引（隐藏 transcript 用）
            const idx = buildIndex(d)
            rowsCache = { sid: sid, rows: rows, idx: idx, at: Date.now() }
            return rowsCache
          })
          .catch(() => (rowsCache.sid === sid ? rowsCache : null))
      }

      // ═══ 0.9.1 宿主 node-key ↔ 日志 seq 的精确映射 ═══════════════════════════
      //
      // 背景（浏览器实测 + 源码核实）：dsh 的 transcript **刻意不做 surface 折叠**。
      // 官方 surface.d.ts:51-63 明写 "replacement copies stay model-only" ——
      // 我们写的 surfaceOp replace 只折叠**模型 surface**（实测 393→13 节点），
      // 被遮蔽的消息在人类 transcript 里**照常渲染且完全可见**，连 marker 本身
      // 都不渲染（systemMessageDefinition 对 surfaceOp !== 'append' 直接 return null）。
      // 所以要让回滚「看得见」，只能在渲染层处理。
      //
      // 好消息：每一行的 `data-chat-node-key` 形如 `<len>:<kind><id>`，而 <id>
      // 就是日志事件的字段（user → messageId、assistant-step → `<turn>:<step>`、
      // tool-call → callId、turn-* → turn 号），客户端本来就已经建了
      // messageId → seq 索引（__seqIndexCache）。**精确查表，零启发式。**
      //
      // 旧实现用「40 字符前缀包含匹配」配对 DOM 与日志，实测 4 条里错 2 条
      // （"继续" 命中了 "继续，…"），已整体删除。
      var parseNodeKey = (k) => {
        var m = /^(\d+):/.exec(k || '');
        if (!m) return null;
        var digits = m[1].length;
        var kindLen = Number(m[1]);
        var start = digits + 1;
        if (!Number.isSafeInteger(kindLen) || kindLen <= 0 || k.length < start + kindLen) return null;
        return { kind: k.slice(start, start + kindLen), id: k.slice(start + kindLen) };
      };

      /**
       * 从 /api/message-ops/messages 的响应构建全部查表。
       * 三条铁律：① 索引只认唯一 id；② 缺数据一律返回 undefined（调用方保持可见）；
       *           ③ visible 集合只收显式 true。
       */
      var buildIndex = (payload) => {
        var list = (payload && payload.messages) || []
        // 0.9.1：回合页脚/过程条不是消息，用 turn/end 的 seq 定位（边界常落在 turn 内部，
        // 用 turn/start 会漏判该回合的页脚）
        var turnEnd = (payload && payload.turnEndSeq) || null;
        var byMessageId = new Map();
        var byTurnStep = new Map();
        var byCallId = new Map();
        var byTurn = new Map();
        var visible = new Set();          // 在模型 surface 上的 seq
        var visibleTurns = new Set();     // 含至少一条可见消息的 turn 号
        var dupMessageId = 0
        var dupByMessageId = new Map();
        for (var i = 0; i < list.length; i++) {
          var m = list[i];
          if (!m || typeof m.seq !== 'number') continue;
          if (m.id != null) {
            var k = String(m.id);
            // restore 是「重放」语义 → 原件与副本可能同 id 并存。
            // 0.9.1：不再「保留最早」，而是收集**全部** seq，隐藏判据取「任一 seq 越过
            // fence」。回放副本才是当前 surface 上的那条，用最早的 seq 判会让
            // 「恢复后再回滚」漏藏（实测 fence=70、副本 seq=70、原件 seq=54）。
            if (byMessageId.has(k)) {
              dupMessageId++
              const arr = dupByMessageId.get(k) || [byMessageId.get(k)]
              arr.push(m.seq)
              dupByMessageId.set(k, arr)
              byMessageId.set(k, m.seq)   // 指向最新的
            } else { byMessageId.set(k, m.seq) }
          }
          if (m.type === 'assistant/message' && m.turn != null && m.step != null) {
            byTurnStep.set(m.turn + ':' + m.step, m.seq);
          }
          if (m.type === 'tool/call' && m.id != null) byCallId.set(String(m.id), m.seq);
          if (m.turn != null && !byTurn.has(String(m.turn))) byTurn.set(String(m.turn), m.seq);
          if (m.visible === true) {
            visible.add(m.seq);
            if (m.turn != null) visibleTurns.add(String(m.turn));
          }
        }
        // turnEnd 优先：它对「该 turn 内一条消息都没有」的情况仍然有效
        if (turnEnd) for (const k in turnEnd) if (Object.prototype.hasOwnProperty.call(turnEnd, k)) byTurn.set(k, turnEnd[k])
        return { byMessageId, dupByMessageId, byTurnStep, byCallId, byTurn, visible, visibleTurns, dupMessageId, total: list.length };
      };

      /** node-key → { seq, all }（all = 同 id 的全部 seq，处理 restore 重放副本）。 */
      var seqOfNodeKey = (key, idx) => {
        var parsed = parseNodeKey(key);
        if (!parsed || !idx) return null;
        var id = parsed.id;
        switch (parsed.kind) {
          case 'input-message':            // user / steering / turn-trigger
          case 'developer-message':
          case 'trajectory-note': {
            const hit = idx.byMessageId.get(id)
            if (hit === undefined) return null
            return { kind: parsed.kind, seq: hit, all: idx.dupByMessageId.get(id) || [hit] }
          }
          case 'assistant-step': {
            const hit = idx.byTurnStep.get(id)
            return hit === undefined ? null : { kind: parsed.kind, seq: hit, all: [hit] }
          }
          case 'tool-call': {
            const hit = idx.byCallId.get(id)
            return hit === undefined ? null : { kind: parsed.kind, seq: hit, all: [hit] }
          }
          case 'turn-tail':
          case 'turn-process':
          case 'turn-error':
          case 'turn-max-tokens':
          case 'model-retry': {
            const hit = idx.byTurn.get(id)
            // 这类是**回合 chrome**，id 就是 turn 号 —— 判据要按「这个 turn 还有
            // 没有可见消息」而不是按 seq，因为 turn/end 本身多半不在 surface 上。
            return hit === undefined ? null : { kind: parsed.kind, seq: hit, all: [hit], turn: id }
          }
          default:
            return null;                  // compaction / command / workflow-run 等不参与
        }
      };

      /**
       * 把 transcript 行按模型 surface 可见性打上 hidden。
       * 用 `hidden="until-found"`（与宿主 useSearchableHidden 同款）：Ctrl+F 仍能搜到，
       * 且宿主的分页锚点选择器 `[data-chat-paging-anchor]:not(:empty):not([hidden])`
       * 会自动跳过这些行，滚动恢复不受影响。
       *
       * ⚠️ `seq == null` ⇒ **移除 hidden**（保持可见）。把「查不到」当成「被遮蔽」
       *   是唯一会误藏用户内容的路径。
       */
      var applySurfaceVisibility = (root, idx) => {
        if (!idx) return { hidden: 0, unresolved: 0, shown: 0 };
        var rows = (root || document).querySelectorAll('[data-chat-node-key]');
        var hidden = 0, unresolved = 0, shown = 0;
        for (var i = 0; i < rows.length; i++) {
          var row = rows[i];
          // 0.9.4 判据（见下）：**模型 surface**。此前用 revertFences 塌缩成
          // `seq >= min(fences)`，在一个有 19 个**离散** marker 的会话里
          // min fence=10 → seq>=10 全藏 → 4792/4793 全被隐藏 → 正文几乎空白
          // （截图复现）。改用 visible 后与宿主 visibleCount 精确吻合。
          var hit = seqOfNodeKey(row.getAttribute('data-chat-node-key'), idx);
          if (hit === null) { unresolved++; row.removeAttribute('hidden'); continue; }
          var shouldHide;
          if (hit.turn !== undefined) {
            // 回合 chrome：这个 turn 还有可见消息就露出来
            shouldHide = !idx.visibleTurns.has(String(hit.turn));
          } else {
            // 消息类：直接问「它在模型 surface 上吗」
            shouldHide = !idx.visible.has(hit.seq);
          }
          if (shouldHide) { hidden++; row.setAttribute('hidden', 'until-found'); }
          else { shown++; row.removeAttribute('hidden'); }
        }
        return { hidden, unresolved, shown };
      };

      // 用户消息锚点：优先官方 Sixlwa_userRow（含 .xzv4MW_actions），回退 flow-kind 属性
      // 锚点 = 每条用户消息自己的容器（一个块只算一次）：
      // 从官方动作行 .xzv4MW_actions 反查最近的消息容器，最贴近"一条消息"的粒度。
      var userAnchors = () => {
        const out = []
        const seen = new Set()
        const add = (el) => { if (el && !seen.has(el)) { seen.add(el); out.push(el) } }
        const rows = Array.from(document.querySelectorAll('[class*="xzv4MW_actions"]'))
        for (const r of rows) {
          const block = r.closest('[data-chat-flow-kind="user"]')
            || r.closest('[class*="_userRow"], [class*="_userStack"], [class*="_bubble"]')
            || r.parentElement
          // 0.9.0：只按**稳定属性** + hash-immune 类名后缀判定，不再匹配 CSS-module
          // 生成的前缀（`Sixlwa_*`）。dsh 0.2.0-rc.2 的哈希已变为 `EvIC1a_flowItem`，
          // 旧前缀正则把所有块都滤掉 → anchors 为空 → 按钮拿不到 seq → 点击必失败。
          //
          // ⚠️ 不要把 `_flowItem` 当兜底：那是**通用**流块，官方把 branch 按钮��放在
          // `data-chat-flow-kind="turn-tail"` 的 _flowItem 里（实测会把 turn-tail 当成
          // 用户消息，给它挂上回滚按钮）。只用 user 属性 + user 类名后缀。
          if (block) {
            const flow = block.getAttribute('data-chat-flow-kind')
            const isUser = flow === 'user' || /_userRow|_userStack|_bubble/.test(block.className || '')
            if (isUser) add(block)
          }
        }
        // 回退：属性锚点
        for (const k of document.querySelectorAll('[data-chat-flow-kind="user"]')) add(k)
        return out
      }
      // 0.9.0：把配对结果反映到按钮可用性上。
      // 配不上（data-mops-unmatched）→ 禁用 + 说明原因，绝不留装饰按钮。
      var syncEnabled = (block, btn) => {
        if (!btn) return
        const ok = block.getAttribute('data-mops-seq')
        if (ok) {
          btn.disabled = false
          btn.title = __t('slot.revert')
          btn.removeAttribute('data-mops-unmatched')
        } else {
          btn.disabled = true
          btn.title = __t('slot.revertUnmatched')
          btn.setAttribute('data-mops-unmatched', '1')
        }
      }
      var assignSeqs = (sid, cache) => {
        const idx = cache && cache.idx
        if (!idx) return
        // 0.9.1：node-key 查表，替代旧的 40 字符前缀包含匹配（实测 4 条错 2 条）
        for (const b of userAnchors()) {
          b.removeAttribute('data-mops-seq')
          b.removeAttribute('data-mops-unmatched')
          const hit = seqOfNodeKey(b.getAttribute('data-chat-node-key'), idx)
          const seq = hit === null ? null : hit.seq
          if (seq === null || seq === undefined) {
            b.setAttribute('data-mops-unmatched', '1')
            syncEnabled(b, b.querySelector && b.querySelector('.mopsUserRevert'))
            continue
          }
          b.setAttribute('data-mops-seq', String(seq))
          syncEnabled(b, b.querySelector && b.querySelector('.mopsUserRevert'))
        }
      }
      // 按钮可用性在 assignSeqs 内部**同步**更新（与打标同一次循环）——
      // 之前放在 fetch 回调里做事后全局扫描，会与 DOM 注入/重排竞态，导致
      // 块已打上 seq 而按钮仍是禁用态（实测：block seq=[8,54]，按钮 disabled=true）。
      // 按钮可用性与 transcript 隐藏都在这里统一落地（同一批数据，避免竞态）
      var ensureAssign = (sid) => fetchRows(sid).then((cache) => {
        assignSeqs(sid, cache)
        if (cache && cache.idx) applySurfaceVisibility(document, cache.idx)
        return cache
      })
      // 0.7.0：点击时先**同步完成**配对（打标是异步 fetch 的结果，
      // 早先点在未打标的按钮上会静默失败 = 用户反馈的"点了没用"）。
      var runUserRevert = (btn, block) => {
        const sid = __currentSessionId
        if (!sid) return
        btn.disabled = true
        Promise.resolve()
          .then(() => ensureAssign(sid))
          .then(() => fetchRows(sid))
          .then((cache) => {
          const rows = cache && cache.rows
          // 0.9.1：seq 来自 node-key 精确查表，**不再**做文本前缀匹配验证
          // （旧的前缀包含匹配实测 4 条错 2 条 —— "继续" 命中 "继续，…"）。
          const seq = Number(block.getAttribute('data-mops-seq'))
          const row = rows && rows.find((r) => r.seq === seq)
          if (!row) {
            ensureAssign(sid)
            notifyDone(__t('errorPrefix') + (__t('revert.unresolved') || 'revert target verification failed'), 'error')
            return
          }
          btn.disabled = true
          Promise.resolve()
            .then(() => fetch('/api/message-ops/revert', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId: sid, seq: row.seq }),
            }))
            .then(async (res) => {
              let data = {}
              try { data = await res.json() } catch { /* keep {} */ }
              if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status))
              notifyDone(__t('done.revert'))
              try { window.dispatchEvent(new Event(CHANGED_EVENT)) } catch { /* non-browser */ }
              try {
                if (__uiWorkspace && typeof __uiWorkspace.openSession === 'function') __uiWorkspace.openSession(sid)
              } catch { /* 视图重建失败不阻断 */ }
              // 0.9.1：视图重建后重新拉权威可见性并隐藏被遮蔽的行。
              // openSession 会重挂 DOM，旧节点上的 hidden 属性随之失效，必须重刷。
              if (rowsCache) rowsCache.at = 0
              for (const delay of [150, 700, 1600]) setTimeout(() => { if (__refreshSurface) __refreshSurface(sid) }, delay)
            })
            .catch((reason) => {
              notifyDone(__t('errorPrefix') + (reason && reason.message ? reason.message : String(reason)), 'error')
            })
            .finally(() => { btn.disabled = false })
          })
      }
      var ensureBtn = (block) => {
        // 官方动作行（含 Copy）：把按钮放到这一行里，与 Copy 同级
        let host = block.querySelector('[class*="xzv4MW_actions"]')
        if (!host) {
          host = document.createElement('div')
          host.className = 'mopsUserActionsRow'
          block.appendChild(host)
        }
        let btn = host.querySelector('.mopsUserRevert')
        if (btn) return btn
        btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'mopsUserRevert'
        btn.title = __t('slot.revert')
        btn.setAttribute('aria-label', __t('slot.revert'))
        btn.innerHTML = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" stroke="currentColor" stroke-width="1.2"/><path d="M2.2 2.8v3h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        btn.addEventListener('click', (e) => {
          e.preventDefault(); e.stopPropagation()
          if (btn.disabled) return
          runUserRevert(btn, block)
        })
        host.appendChild(btn)
        return btn
      }
      __refreshSurface = (sid) => {
        const id = sid || __currentSessionId
        if (!id) return
        if (rowsCache) rowsCache.at = 0            // 强制重取权威数据
        try { fetchRows(id).then((cache) => { if (cache && cache.idx) applySurfaceVisibility(document, cache.idx) }) } catch { /* noop */ }
      }
      var scan = () => {
        try {
          const sid = __currentSessionId
          if (!sid) return
          const blocks = userAnchors()
          for (const b of blocks) ensureBtn(b)
          // 0.9.1：**始终**刷新（原先只在按钮未打标时刷）——
          // 打标后 transcript 再变化（openSession 重建 / 分页 / restore 重放）
          // 就再也不会重算隐藏，导致「界面停在旧状态，必须重载页面才对」。
          ensureAssign(sid)
        } catch { /* 注入失败不影响会话 */ }
      }
      // 触发：hover / 滚动 / DOM 变化 / 变更事件
      document.addEventListener('mouseover', (e) => {
        try {
          if (!e || !e.target || !e.target.closest) return
          if (!__currentSessionId) return
          const block = e.target.closest('[class*="Sixlwa_userRow"], [data-chat-flow-kind="user"]')
          if (!block) return
          ensureBtn(block)
          if (!block.hasAttribute('data-mops-seq')) ensureAssign(__currentSessionId)
        } catch { /* noop */ }
      }, { passive: true })
      window.addEventListener('scroll', scan, { passive: true })
      try {
        var mo = new MutationObserver(() => { clearTimeout(scan._t); scan._t = setTimeout(scan, 200) })
        mo.observe(document.body, { childList: true, subtree: true })
      } catch { /* noop */ }
      window.addEventListener(CHANGED_EVENT, () => {
        try {
          document.querySelectorAll('[data-mops-seq]').forEach((b) => b.removeAttribute('data-mops-seq'))
        } catch { /* noop */ }
      })
      // 样式：与官方 action 按钮同款（28px、ghost），可见性继承宿主动作行
      try {
        if (!document.getElementById('dsh-message-ops-user-revert-style')) {
          const tag = document.createElement('style')
          tag.id = 'dsh-message-ops-user-revert-style'
          tag.textContent = [
            // 不再用 absolute + :hover：按钮作为宿主动作行的子元素，
            // 由宿主 [data-actions-reveal] 统一控制显隐（触屏也跟着宿主走）。
            '.mopsUserRevert{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#9a9aa0);cursor:pointer;padding:0;flex:none}',
            '.mopsUserRevert:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}',
            '.mopsUserRevert:disabled{opacity:.4;cursor:default}',
            '.mopsUserActionsRow{height:28px;display:flex;align-items:center;gap:8px;margin-left:-6px}',
            '@media (hover:none){.mopsUserActionsRow{opacity:1}}',
          ].join('')
          document.head.appendChild(tag)
        }
      } catch { /* style 注入失败不影响功能 */ }
    }

    function ensureSidebarOpsItem() {
      var menu = document.querySelector('[role=menu]')
      if (!menu) return
      if (menu.querySelector('[data-dsh-message-ops]')) return
      var row = findOpenSessionRow()
      if (!row) return
      var item = document.createElement('button')
      item.type = 'button'
      item.setAttribute('role', 'menuitem')
      item.setAttribute('data-dsh-message-ops', '1')
      item.style.cssText = [
        'display:flex', 'align-items:center', 'gap:8px', 'width:100%',
        'padding:6px 12px', 'border:none', 'background:transparent',
        'color:var(--dsw-alias-label-primary,inherit)',
        'font:inherit', 'font-size:13px', 'line-height:20px',
        'text-align:left', 'border-radius:6px', 'cursor:pointer',
      ].join(';')
      item.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="flex:none"><path d="' + BRANCH_PATH + '" fill="currentColor"/></svg><span></span>'
      item.querySelector('span').textContent = __t('menu.ops')
      item.addEventListener('mouseenter', function () {
        item.style.background = 'var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))'
      })
      item.addEventListener('mouseleave', function () { item.style.background = 'transparent' })
      item.addEventListener('click', function () {
        var titleEl = row.querySelector('[class*=title]')
        var title = titleEl ? String(titleEl.innerText || '').trim() : ''
        if (!title) return
        // 0.5.2（P1）：必须带 sessionId——否则对话框加载 effect 早退，永久卡「正在读取…」
        var sid = ''
        var rk = row.getAttribute && row.getAttribute('data-row-key')
        if (rk && rk.indexOf('session:') === 0) sid = rk.slice(8)
        window.dispatchEvent(new CustomEvent(EVENT, { detail: { title: title, sessionId: sid || undefined } }))
      })
      var sep = document.createElement('div')
      sep.style.cssText = 'height:1px;margin:4px 8px;background:var(--dsw-alias-border-l1,rgba(128,128,128,.2))'
      menu.appendChild(sep)
      menu.appendChild(item)
    }

    function refreshSidebarOpsLabel() {
      const items = document.querySelectorAll('[data-dsh-message-ops]')
      for (let i = 0; i < items.length; i++) {
        const span = items[i].querySelector('span')
        if (span) span.textContent = __t('menu.ops')
      }
    }

    function installSidebarOps() {
      if (window.__dshMessageOpsSidebarInstalled) return
      window.__dshMessageOpsSidebarInstalled = true
      try { ensureSidebarOpsItem() } catch (e) { /* never crash the UI */ }
      // 观察范围收窄（评审 M2）：仍需 observe document.body（会话行菜单由宿主
      // React 动态渲染在侧栏任意挂载点，安装期无法锚定稳定容器），但回调改为
      // 精确过滤——只有新增节点本身就是（或包含）[role=menu] 时才调度探测，
      // 其余海量 childList mutation（聊天流渲染、流式 chunk 等）零探测成本；
      // 同帧多次命中经 setTimeout 合并为一次探测。
      var pending = false
      function scheduleEnsure() {
        if (pending) return
        pending = true
        setTimeout(function () {
          pending = false
          try { ensureSidebarOpsItem() } catch (e) { /* never crash the UI */ }
        }, 0)
      }
      var observer = new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var added = mutations[i].addedNodes
          for (var j = 0; j < added.length; j++) {
            var n = added[j]
            if (n.nodeType !== 1) continue
            var isMenu = false
            try {
              isMenu = (typeof n.matches === 'function' && n.matches('[role=menu]'))
                || (typeof n.querySelector === 'function' && n.querySelector('[role=menu]') !== null)
            } catch (e) { isMenu = false }
            if (isMenu) { scheduleEnsure(); return }
          }
        }
      })
      observer.observe(document.body, { childList: true, subtree: true })
    }

    // --- apply ------------------------------------------------------------------

    function adoptLocale(locale, ctx) {
      if (!locale) return
      __locale = locale
      try {
        if (typeof locale.register === 'function') {
          ctx.effect(() => locale.register(NS, { zh: zhDict, en: enDict }))
        }
      } catch { /* namespace already registered: keep existing copy */ }
    }


    // ═══ 0.9.3 /undo —— opencode 招牌交互 ═════════════════════════════════════
    //
    // 「我说的那句话不对」→ 一个命令 → 消息从 transcript 消失 + 原文回输入框。
    // 走**官方斜杠命令管线**（`ctx.inputTriggers.registerSource`），不自己劫持键盘，
    // 因此：菜单分组、搜索、Enter 裁决、composer 状态机全部由宿主负责。
    //
    // 契约（dsh-client-ui-input-trigger/lib/types/client/contract.d.ts）：
    //   registerSource({ trigger:'/', name, candidates(session,req), onPick(pick),
    //                     matchEnter?(session,line,signal,envelope) })
    //   PickOutcome = {claim} | {insert} | {text,continue?} | 'handled' | undefined
    //   undefined = 「不是我的」，交回管线；'handled' = 已消费，**不要**当成消���发出去。
    var UNDO_CANDIDATES = [
      { name: 'undo', value: 'undo', icon: 'undo' },
      { name: 'redo', value: 'redo', icon: 'redo' },
    ]
    var __undoSourceName = 'message-ops'

    /**
     * 找到当前会话里最后一条**可回滚**的用户消息。
     *
     * ⚠️ 必须挑 surface 上的那一条。`restore` 是「重放」语义 → 原件被遮蔽、副本带**新 seq**
     * 落在日志尾部。若无脑取最后一条，就会挑到那个副本，而副本不在模型 surface 上，
     * 服务端会以 `surface replace: start seq N not found in surface` 拒绝（实测）。
     * 回滚的前提就是「目标在 surface 上」，所以先筛 visible。
     */
    var lastRevertable = () => {
      const cache = __peekRowsCache ? __peekRowsCache() : null
      if (!cache || !Array.isArray(cache.rows)) return null
      for (var i = cache.rows.length - 1; i >= 0; i--) {
        var r = cache.rows[i]
        if (r && r.seq != null && r.visible) return r
      }
      return null
    }

    /** 执行 undo/redo。返回 true 表示确实动过盘。 */
    /** __currentSessionId 来自 DOM dataset，可能带 `session-` 前缀；API 只要裸 uuid。 */
    var bareSessionId = (id) => String(id || '').replace(/^session-/, '')
    var runUndoRedo = (kind) => {
      const sid = bareSessionId(__currentSessionId)
      if (!sid) return false
      const target = lastRevertable()
      if (!target) {
        notifyDone(__t('undo.none') || '没有可回滚的消息', 'error')
        return false
      }
      const verb = kind === 'redo' ? 'restore' : 'revert'
      fetch('/api/message-ops/' + verb, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: sid, seq: target.seq }),
      })
        .then(async (res) => {
          let data = {}
          try { data = await res.json() } catch { /* keep {} */ }
          if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status))
          notifyDone(kind === 'redo' ? __t('undo.done.redo') : __t('undo.done.undo'))
          // opencode 语义：回滚后**原文回输入框**，用户可改后重发
          if (kind !== 'redo' && target.fullText && __inputActions && typeof __inputActions.setDraft === 'function') {
            try { __inputActions.setDraft(target.fullText) } catch { /* 回填失败不阻断 */ }
          }
          try { window.dispatchEvent(new Event(CHANGED_EVENT)) } catch { /* non-browser */ }
          try {
            if (__uiWorkspace && typeof __uiWorkspace.openSession === 'function') __uiWorkspace.openSession(sid)
          } catch { /* 视图重建失败不阻断 */ }
          if (__peekRowsCache) { const c = __peekRowsCache(); if (c) c.at = 0 }
          for (const delay of [150, 700, 1600]) setTimeout(() => { if (__refreshSurface) __refreshSurface(sid) }, delay)
        })
        .catch((reason) => {
          notifyDone(__t('errorPrefix') + (reason && reason.message ? reason.message : String(reason)), 'error')
        })
      return true
    }

    /** 注册 /undo /redo 到官方斜杠管线。服务缺失时安静 no-op。 */
    var __undoRegistered = false
    var doRegisterUndoSlash = (ctx, it) => {
      if (__undoRegistered || !it || typeof it.registerSource !== 'function') return
      __undoRegistered = true
      try {
        ctx.effect(() => it.registerSource({
          trigger: '/',
          name: __undoSourceName,
          order: 20,
          showGroupTitle: true,
          // ⚠️ 必须返回 **Promise**：宿主在 InputTriggerController.fetchCandidates 里
          //    直接 `source.candidates(...).then(...)`，同步返回数组会抛
          //    `source.candidates(...).then is not a function`，整个菜单静默失效。
          candidates: async (session, req) => {
            const q = String((req && req.query) || '').trim().toLowerCase()
            return UNDO_CANDIDATES
              .filter((c) => !q || c.name.includes(q))
              .map((c) => ({
                name: c.name,
                icon: c.icon,
                label: c.name === 'undo'
                  ? (__t('undo.label') || '回滚上一条消息')
                  : (__t('redo.label') || '恢复上一条被回滚的消息'),
                description: c.name === 'undo'
                  ? (__t('undo.desc') || '移除最后一条用户消息，原文回填输入框')
                  : (__t('redo.desc') || '把回滚掉的消息重新放回对话'),
                value: c.value,
              }))
          },
          onPick: (pick) => {
            const v = pick && pick.candidate && pick.candidate.value
            if (v !== 'undo' && v !== 'redo') return undefined
            runUndoRedo(v)
            return 'handled'
          },
          // Enter 直接执行：`/undo` 不必先在菜单里选中
          matchEnter: (session, line) => {
            const t = String(line || '').trim().toLowerCase()
            if (t !== '/undo' && t !== '/redo') return undefined
            runUndoRedo(t === '/redo' ? 'redo' : 'undo')
            return 'handled'
          },
        }))
      } catch (e) {
        __undoRegistered = false
        if (window.__MOPS_DEBUG) console.warn('[message-ops] /undo 注册失败:', e)
      }
    }

    var registerUndoSlash = (ctx) => {
      // ⚠️ cordis 的 inject 回调**第一个参数是服务本身**，不是 ctx。
      //    早先写成 `registerUndoSlash(sub.ctx || sub)` → 在服务对象上找 .get
      //    必然是 undefined → 静默不注册（表现为 /undo 根本不出现）。
      const it = typeof ctx.get === 'function' ? ctx.get('inputTriggers') : null
      if (it) { doRegisterUndoSlash(ctx, it); return }
      try {
        // ⚠️ cordis inject 回调收到的是**注入命名空间**，服务在其同名字段下
        //    （与本文件 `ctx.inject(['uiWorkspace'], sub => sub.uiWorkspace || sub)` 同模式）。
        //    直接把 sub 当服务用会抛 `cannot get property "registerSource" without inject`。
        ctx.inject(['inputTriggers'], (sub) => {
          doRegisterUndoSlash(ctx, sub && (sub.inputTriggers || sub))
        })
      } catch (e) {
      }
    }

    function apply(ctx) {
      __sessionsSvc = ctx.get('sessions')
      __uiWorkspace = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null
      if (!__uiWorkspace) {
        try { ctx.inject(['uiWorkspace'], (sub) => { __uiWorkspace = sub.uiWorkspace || sub }) } catch { /* 0.1.x 无此服务 */ }
      }
      if (!__sessionsSvc) {
        ctx.inject(['sessions'], (sub) => { __sessionsSvc = sub.sessions })
      }
      registerUndoSlash(ctx)
      adoptLocale(ctx.get('locale'), ctx)
      if (!__locale) {
        ctx.inject(['locale'], (sub) => {
          adoptLocale(sub.locale, ctx)
          refreshSidebarOpsLabel()
        })
      }
      ctx.on('locale/change', refreshSidebarOpsLabel)
      if (window.__MOPS_DISABLE_HEADER !== true) ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT, id: ROW_ID, order: 31,
        ...(__locale ? { locale: NS } : {}),
      }, OpsButton))
      // 0.3.0：每条 AI 消息旁的原生回撤按钮（0.1.x 无此槽，inject 自动 no-op）
      ctx.slots.inject(CHAT_ACTIONS_SLOT, () => ctx.slots.register({
        name: CHAT_ACTIONS_SLOT, id: CHAT_ACTIONS_ID, order: 20,
        ...(__locale ? { locale: NS } : {}),
      }, MsgSlotActions))
      // 0.4.0：composer 上方回撤 dock（0.1.x 无此槽自动 no-op）
      ctx.slots.inject(INPUT_DOCK_SLOT, () => ctx.slots.register({
        name: INPUT_DOCK_SLOT, id: INPUT_DOCK_ID, order: 10,
        ...(__locale ? { locale: NS } : {}),
      }, RevertDock))
      ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
        name: OVERLAY_SLOT, id: DIALOG_ID, order: 101,
        ...(__locale ? { locale: NS } : {}),
      }, OpsDialog))
      installSidebarOps()
      installUserRevertInjector()
    }

    return { apply, inject: ['slots'] }
  },
})
