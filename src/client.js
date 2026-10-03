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
      'op.restore': '恢复（重放被遮蔽的消息）',
      'op.restoreDesc': '仅当选中行是回滚/删除标记时可用。这是重放而非取消遮蔽：被遮蔽的用户/助手消息会以新 seq 重新追加并带「[恢复]」前缀；不可重放的事件（如工具调用）会被跳过并计数。',
      'slot.revert': '回滚到此条',
      'slot.delete': '删除此条',
      'slot.branch': '从此分支',
      'toast.openNew': '打开新会话',
      'fork.official': '分支完成：新会话 {id}',
      'fork.disk': '分支完成：新会话 {id}（列表刷新后可见）',
      'done.restore': '恢复完成：重放 {n} 条，跳过不可重放 {s} 条',
      'busy.restore': '恢复中…',
      'confirm.restore': '恢复',
      'ack.restore': '我已了解：恢复将以新 seq 重放被遮蔽的消息（原日志不变）',
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
      'dialog.invisible': ' (shadowed, log-only)',
      'dialog.showMore': 'Show more ({n} older)',
      'dialog.more': '…(showing latest 200 of {n})',
      'op.revert': 'Revert: remove this message and everything after',
      'op.revertDesc': 'Shadows the picked message and all later visible content; the log stays append-only so context can be restored by re-sending.',
      'op.delete': 'Delete only this message',
      'op.deleteDesc': 'Shadows only the picked message; everything else stays.',
      'op.branch': 'Branch into a new session from here',
      'op.branchDesc': 'Copies everything up to and including the picked message into a new session (original untouched, non-destructive).',
      'op.restore': 'Restore (replay shadowed messages)',
      'op.restoreDesc': 'Only when the selected row is a revert/delete marker. This is a replay, not an un-shadow: shadowed user/assistant messages are re-appended with NEW seqs and a [Restored] prefix; non-replayable events (tool calls) are skipped and counted.',
      'slot.revert': 'Revert to here',
      'slot.delete': 'Delete this message',
      'slot.branch': 'Branch from here',
      'toast.openNew': 'Open new session',
      'fork.official': 'Branched (official fork): new session {id}',
      'fork.disk': 'Branched: new session {id} (visible after list refresh)',
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
      'confirm.restore': 'Restore',
      'ack.restore': 'I understand: restore re-appends shadowed messages with new seqs (the log stays append-only)',
      'done.revert': 'Reverted; reload to apply',
      'done.delete': 'Deleted; reload to apply',
      'action.reload': 'Reload page',
      'errorPrefix': 'Operation failed: ',
      'dock.title': '{n} messages rolled back',
      'dock.expand': 'Expand revert list',
      'dock.collapse': 'Collapse revert list',
      'dock.shadowedN': '{n} shadowed',
      'dock.restore': 'Restore',
      'dock.restoring': 'Restoring…',
      'slot.quote': 'Quote to composer',
      'quote.done': 'Quoted into composer',
      'quote.unavailable': 'Quote unavailable (composer locked or no full text)',
      'menu.ops': 'Message ops',
    }

    var __locale = null
    var __sessionsSvc = null
    var __inputActions = null // 0.4.0: 从 session 槽捕获（InputActions.setDraft → composer 回填）
    var __uiWorkspace = null
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

      // 磁盘分支回退（0.1.x / 官方 fork 失败时）：POST /api/message-ops/branch
      const diskBranch = (cause) => {
        const finish = () => {
          fetch('/api/message-ops/branch', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: target.sessionId, upToSeq: picked }),
          })
            .then(async (res) => {
              let data = {}
              try { data = await res.json() } catch { /* keep {} */ }
              if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
              setDoneMsg(t('fork.disk', { id: data.newId || '' }))
              setBusyMsg('')
              setChildId(null)
              setState('done')
              // ISessions.refresh() 是宿主现行 API；refreshList 是旧名兜底。
              if (__sessionsSvc) {
                try {
                  const r = typeof __sessionsSvc.refresh === 'function'
                    ? __sessionsSvc.refresh()
                    : (typeof __sessionsSvc.refreshList === 'function' ? __sessionsSvc.refreshList() : null)
                  if (r != null) Promise.resolve(r).catch(() => {})
                } catch { /* ignore */ }
              }
            })
            .catch((reason) => {
              setBusyMsg('')
              setState('ready')
              setError(t('errorPrefix') + (reason && reason.message ? reason.message : String(reason)))
            })
        }
        if (cause) {
          // 官方 fork 失败原因留痕后回退
          setError(t('errorPrefix') + (cause && cause.message ? cause.message : String(cause)) + ' → fallback')
        }
        finish()
      }

      const run = useCallback(() => {
        if (state === 'busy' || picked == null || !mode) return
        if (mode !== 'branch' && mode !== 'restore' && !acknowledged) return
        setBusyMsg(t('busy.' + (mode === 'revert' || mode === 'delete' || mode === 'restore' ? mode : 'branch')))
        setState('busy'); setError(null)
        if (mode === 'branch') {
          // 0.3.0 分支双路径：官方 sessions.fork({atSeq})（0.2.0+，子会话进宿主
          // 列表并可立即打开）优先；0.1.x / fork 缺席回退磁盘 applyBranch。
          const forkPath = pickForkPath(__sessionsSvc)
          if (forkPath.kind === 'official') {
            forkPath.fork({ sessionId: target.sessionId, atSeq: picked, increaseTitle: true })
              .then((childId) => {
                setDoneMsg(t('fork.official', { id: String(childId || '') }))
                setBusyMsg('')
                setChildId(childId || null)
                setState('done')
                notifyDone(t('fork.official', { id: String(childId || '') }))
              })
              .catch((reason) => {
                // 官方 fork 失败（如未编目）→ 回退磁盘分支，不中断用户
                return diskBranch(reason)
              })
            return
          }
          diskBranch(null)
          return
        }
        const path = mode === 'restore' ? 'restore' : mode
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
            const okMsg = mode === 'restore'
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
          })
          .catch((reason) => {
            setBusyMsg('')
            setState('ready')
            setError(t('errorPrefix') + (reason && reason.message ? reason.message : String(reason)))
          })
      }, [state, picked, mode, acknowledged, target, t])

      if (!target) return null

      const visible = messages.filter((m) => m.visible !== false)
      const shownBase = visible.slice(-MAX_RENDER)
      const hiddenCount = visible.length - shownBase.length
      // 分批渲染（评审 M1）：只渲染 renderLimit 条，更早的留给「显示更多」
      // 渐进展开，避免 200 行 radio 列表一次进 DOM。
      const shown = shownBase.slice(-renderLimit)
      const pagedCount = shownBase.length - shown.length
      const pickedMsg = picked != null ? messages.find((m) => m.seq === picked) : null

      let body
      if (state === 'loading') {
        body = React.createElement('div', { key: 'load', style: statusStyle }, t('dialog.loading'))
      } else if (!messages.length) {
        body = React.createElement('div', { key: 'empty', style: statusStyle }, t('dialog.empty'))
      } else {
        body = React.createElement(React.Fragment, null, [
          target.running ? React.createElement('div', { key: 'warn', style: warnStyle }, t('dialog.runningWarn')) : null,
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
          pickedMsg ? React.createElement('div', { key: 'ops' },
            // restore 仅对 revert/delete 落定的 replace 标记行提供（重放语义）
            ['revert', 'delete', 'branch'].concat(pickedMsg.marker ? ['restore'] : []).map((m, i) => React.createElement('div', { key: m, style: { marginTop: i === 0 ? 8 : 4 } },
              React.createElement('label', { style: optStyle },
                React.createElement('input', {
                  type: 'radio', name: 'dsh-message-ops-mode', checked: mode === m,
                  onChange: () => chooseMode(m), disabled: state === 'busy',
                }),
                t('op.' + m)),
              mode === m ? React.createElement('div', { style: descStyle }, t('op.' + m + 'Desc')) : null,
            ))) : null,
          mode && mode !== 'branch'
            ? React.createElement('label', { key: 'ack', style: optStyle },
                React.createElement('input', {
                  type: 'checkbox', checked: acknowledged, disabled: state === 'busy',
                  onChange: (e) => setAcknowledged(e.target.checked),
                }),
                t(mode === 'revert' ? 'ack.revert' : mode === 'restore' ? 'ack.restore' : 'ack.delete'))
            : null,
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

    // 官方图标适配：0.2.0 primitives 的 IconClock/IconTrash 与原生操作行同款；
    // require 失败（0.1.x 或裁剪环境）回退内联 SVG，槽在 0.1.x 本就不存在，仅防御。
    var IconClock = null
    var IconTrash = null
    try {
      const P = require('@deepseek-ai/dsh-client-ui-primitives')
      IconClock = P && P.IconClockOutlineRegular
      IconTrash = P && P.IconTrashOutlineRegular
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
    if (!IconTrash) IconTrash = function TrashFallback() {
      // 官方 IconTrashOutlineArtwork 1:1 路径
      return React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, stroke: 'currentColor', strokeWidth: 1 },
        React.createElement('path', { d: 'M1.28149 3.88831H14.7187' }),
        React.createElement('path', { d: 'M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4752 2.11366 10.5841 2.29282 10.5841 2.47962V3.88833' }),
        React.createElement('path', { d: 'M3.29749 5.10193L4.06585 13.0192C4.10899 13.4595 4.48223 13.7942 4.92504 13.7942H11.0751C11.5179 13.7942 11.8912 13.4595 11.9343 13.0192L12.7027 5.10193' }),
        React.createElement('path', { d: 'M6.27637 7.51831V11.1829M9.72378 7.51831V11.1829' }))
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
      const restored = new Set()
      for (const m of msgs || []) {
        if (m && typeof m.restoresSeq === 'number') restored.add(m.restoresSeq)
      }
      return (msgs || []).filter((m) => m.marker && m.sourceKind !== 'compact-checkpoint' && !restored.has(m.seq))
    }

    function RevertDock(props) {
      const { sessionId, useSessions, inputActions } = props
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
          '.mopsRd{width:100%;overflow:hidden;border-radius:var(--dsw-radius-md,12px);border:.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));background:var(--dsw-alias-bg-layer-1,#1e1e20)}',
          // 头部 42px：图标 + label + 折叠预览 + 旋转 chevron
          '.mopsRdHead{display:flex;height:42px;align-items:center;gap:8px;padding-left:16px;padding-right:8px;cursor:pointer;user-select:none}',
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
          // 折叠时 18px sacrificial 空间（composer 负 lift 重叠）
          '.mopsRdSpacer{height:18px}',
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
        setRestoring(row.seq)
        Promise.resolve()
          .then(() => fetch('/api/message-ops/restore', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, seq: row.seq }),
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

      const rowEl = (row) => React.createElement('div', { key: row.seq, className: 'mopsRdRow' },
        React.createElement('span', { className: 'mopsRdRowText' }, '#' + row.seq + ' · ' + (row.snippet || '')),
        React.createElement('button', {
          type: 'button', className: 'mopsRdRestore', disabled: restoring != null || running,
          onClick: () => restoreRow(row),
        }, restoring === row.seq ? t('dock.restoring') : t('dock.restore')),
      )

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
        open ? React.createElement('div', { className: 'mopsRdList' }, markers.map(rowEl)) : null,
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

    function apply(ctx) {
      __sessionsSvc = ctx.get('sessions')
      __uiWorkspace = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null
      if (!__uiWorkspace) {
        try { ctx.inject(['uiWorkspace'], (sub) => { __uiWorkspace = sub.uiWorkspace || sub }) } catch { /* 0.1.x 无此服务 */ }
      }
      if (!__sessionsSvc) {
        ctx.inject(['sessions'], (sub) => { __sessionsSvc = sub.sessions })
      }
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
    }

    return { apply, inject: ['slots'] }
  },
})
