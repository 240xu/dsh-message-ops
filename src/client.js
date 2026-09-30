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
    const DIALOG_ID = 'message-ops-dialog'
    const EVENT = 'dsh-message-ops:open'
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
      'ack.revert': 'I understand: revert shadows the picked message and everything after it',
      'ack.delete': 'I understand: this message will be shadowed (kept in the log)',
      'confirm.revert': 'Revert',
      'confirm.delete': 'Delete',
      'confirm.branch': 'Branch',
      'busy.revert': 'Reverting…',
      'busy.delete': 'Deleting…',
      'busy.branch': 'Branching…',
      'done.branch': 'Branched: new session {id} (visible after list refresh)',
      'done.revert': 'Reverted; reload to apply',
      'done.delete': 'Deleted; reload to apply',
      'action.reload': 'Reload page',
      'errorPrefix': 'Operation failed: ',
      'menu.ops': 'Message ops',
    }

    var __locale = null
    var __sessionsSvc = null

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
      const [mode, setMode] = useState(null)         // revert|delete|branch
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
          setMessages([]); setSessionMeta(null); setPicked(null)
          setMode(null); setAcknowledged(false); setError(null); setDoneMsg('')
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
        setBusyMsg(t(mode === 'revert' ? 'busy.revert' : mode === 'delete' ? 'busy.delete' : 'busy.branch'))
        setState('busy'); setError(null)
        const path = mode === 'revert' ? 'revert' : mode === 'delete' ? 'delete' : 'branch'
        const body = mode === 'branch'
          ? { sessionId: target.sessionId, upToSeq: picked }
          : { sessionId: target.sessionId, seq: picked }
        fetch('/api/message-ops/' + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then(async (res) => {
            let data = {}
            try { data = await res.json() } catch { /* keep {} */ }
            if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
            if (mode === 'branch') {
              setDoneMsg(t('done.branch', { id: data.newId || '' }))
              setBusyMsg('')
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
            } else {
              // S6 修复（G-M1）：不再 900ms 裸 location.reload。成功走 devkit
              // 标准 toast（无 devkit 时降级为对话框内 doneMsg），并提供手动
              // 「刷新页面」按钮；与 branch 路径的 refreshList 不刷新行为拉齐。
              setDoneMsg(t(mode === 'revert' ? 'done.revert' : 'done.delete'))
              setBusyMsg('')
              setState('done')
              try {
                const dk = window.__dshDevkit
                if (dk && typeof dk.toast === 'function') {
                  dk.toast(t(mode === 'revert' ? 'done.revert' : 'done.delete'), { kind: 'ok' })
                }
              } catch { /* toast 缺席不阻断成功反馈 */ }
            }
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
            ['revert', 'delete', 'branch'].map((m, i) => React.createElement('div', { key: m, style: { marginTop: i === 0 ? 8 : 4 } },
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
                t(mode === 'revert' ? 'ack.revert' : 'ack.delete'))
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
        window.dispatchEvent(new CustomEvent(EVENT, { detail: { title: title } }))
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
      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT, id: ROW_ID, order: 31,
        ...(__locale ? { locale: NS } : {}),
      }, OpsButton))
      ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
        name: OVERLAY_SLOT, id: DIALOG_ID, order: 101,
        ...(__locale ? { locale: NS } : {}),
      }, OpsDialog))
      installSidebarOps()
    }

    return { apply, inject: ['slots'] }
  },
})
