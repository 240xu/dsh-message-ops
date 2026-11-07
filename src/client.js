/* global window, document, fetch, navigator */
/**
 * dsh-message-ops 客户端：会话头部按钮 + 共享操作对话框 + 侧栏行菜单项。
 * 一个对话框承载回滚 / 删除 / 分支三种操作；日志 append-only，遮蔽可恢复。
 * 结构照抄 @huanlin/dsh-plugin-session-delete。事故复盘见 README「历史事故记录」#1。
 */
window.__ModuleLoader__.load({
  id: '@240xu/dsh-message-ops',
  factory: require => {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
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
    // 0.9.7（P4）：messageId→seq 索引失效（dataSig 变化）—— 已挂载的
    // MsgSlotActions 靠它重跑解析 effect，否则「新 AI 消息旁没有按钮」。
    const SEQ_INDEX_EVENT = 'dsh-message-ops:seq-index'
    // 0.9.7（P0-2 读合并）：一次写操作会同时触发 150/700/1600ms 三连 +
    // RevertDock 的 CHANGED 重拉 + openSession 后 MO 调度的 scan（5~6 次 GET）。
    // 同一会话在此窗口内的请求共享同一个 promise；窗口**必须 < 1600ms**，
    // 否则「视图重建后重算隐藏」的 1600ms 兜底会被上一次响应吞掉。
    const MSG_COALESCE_MS = 1000
    var __messagesMemo = { url: null, at: 0, p: null, settled: false }
    var invalidateMessagesMemo = () => {
      __messagesMemo = { url: null, at: 0, p: null, settled: false }
    }
    const SYNTHETIC_TURN_STYLE_ID = 'dsh-message-ops-synthetic-turn-hide'
    const syncSyntheticTurnStyle = messages => {
      if (typeof document === 'undefined' || !document.head) return
      const turns = new Set()
      for (const m of messages || []) {
        if (m && m.syntheticTurn === true && Number.isSafeInteger(m.turn)) turns.add(m.turn)
      }
      let tag = document.getElementById(SYNTHETIC_TURN_STYLE_ID)
      if (turns.size === 0) {
        if (tag) tag.remove()
        return
      }
      if (!tag) {
        tag = document.createElement('style')
        tag.id = SYNTHETIC_TURN_STYLE_ID
        document.head.appendChild(tag)
      }
      tag.textContent = Array.from(turns)
        .map(turn => '[data-chat-flow-kind="turn-process"][data-chat-turn="' + turn + '"]{display:none!important}')
        .join('\n')
    }
    const emitChanged = () => {
      // 数据变了：连同本地缓存一起作废（否则 8s TTL 会让 openSession 后的
      // scan 拿旧 payload 重算隐藏 = 「回滚了但界面没变」）。
      invalidateMessagesMemo()
      if (__peekRowsCache) {
        const c = __peekRowsCache()
        if (c) c.at = 0
      }
      try {
        window.dispatchEvent(new CustomEvent(CHANGED_EVENT))
      } catch {
        /* noop */
      }
    }
    const NS = 'dsh-message-ops'

    /**
     * GET /api/message-ops/messages 的唯一出口（0.9.7 读合并）。
     * - 并发调用共享同一个 promise；
     * - 已结算的响应在 MSG_COALESCE_MS 内复用（一次写操作的 5~6 路重拉 → 1~2 次网络）；
     * - 只在 `ok:true` 时才留窗口：失败/非 2xx 立刻作废，免得把后续重试也吃掉；
     * - 1600ms 那档兜底刷新由调用方先 `invalidateMessagesMemo()` 再拉，保证是真网络。
     */
    var fetchMessagesJson = rawUrl => {
      // 归一 sessionId 写法：本文件有的调用方传 `session-xxx`（dock / 对话框），
      // 有的传裸 uuid（fetchRows / /redo）。不归一就是两个缓存槽，合并直接失效。
      // 服务端两种写法都认（index.js "uuid or session-<uuid> form"）。
      const url = String(rawUrl).replace(/([?&]sessionId=)session-/, '$1')
      const m = __messagesMemo
      if (m.url === url && m.p && (!m.settled || Date.now() - m.at < MSG_COALESCE_MS)) return m.p
      const entry = { url, at: Date.now(), p: null, settled: false }
      entry.p = fetch(url)
        .then(r =>
          r
            .json()
            .catch(() => null)
            .then(d => ({ r, d })),
        )
        .then(({ r, d }) => {
          if (!r.ok || !d || d.ok !== true) throw new Error((d && d.error) || 'HTTP ' + r.status)
          entry.settled = true
          entry.at = Date.now()
          return d
        })
        .catch(e => {
          if (__messagesMemo === entry) invalidateMessagesMemo()
          throw e
        })
      __messagesMemo = entry
      return entry.p
    }

    // 0.9.7（P0-4）：zh/en 两本字典 key 集合**必须一致且顺序一致**——宿主 locale
    // 的 translate() 按「活跃语言 → en」回退链查表（zh 回退 en，en 无回退），
    // 所以缺 key 不一定看得见：zh 缺 → 落到 en（0.9.x 这批 en 值是中文，
    // zh 用户"碰巧"正常）；en 缺 → 直接把 key 当文案显示。
    // 反过来 en 值写成中文时，英文用户会看到中文。测试锁死了两侧 key 序列相等。
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
      'dialog.pickedAs': '已选 #{seq} · {text}',
      'dialog.invisible': '（已遮蔽，仅日志可见）',
      'dialog.showMore': '显示更多（剩余 {n} 条）',
      'dialog.more': '…（仅显示最近 200 条，共 {n} 条）',
      'op.revert': '回滚到此条（含）之后全部移除',
      'op.revertDesc': '遮蔽所选消息及其后所有可见内容；日志 append-only，可通过重新发送恢复语境。',
      'op.delete': '仅删除这一条',
      'op.deleteDesc': '仅遮蔽所选的一条消息；其余内容保持不变。',
      'op.branch': '从此条分叉为新会话',
      'op.branchDesc': '把此条之前的对话复制到新会话，并把此条原文放回新会话输入框（原会话不变，非破坏操作）。',
      'slot.revert': '回滚到此条',
      'slot.revertUnmatched': '在日志里定位不到这条消息的 seq（通常是模型写的摘要与渲染文本偏差过大）——请改用「消息操作」对话框。',
      'slot.fork': '从此条分叉',
      'slot.forkHint': '复制此条之前的对话到新会话，并把此条原文放回新会话输入框',
      'slot.forkDone': '已分叉：新会话 {id}',
      'slot.forkUnavailable': '分叉不可用：会话正在运行，或宿主未提供 session/fork',
      'toast.openNew': '打开新会话',
      'fork.official': '分支完成：新会话 {id}',
      'fork.unavailable': '官方分支不可用：通常是因为会话正在运行，请先停止会话后重试。分支功能由 dsh 内置的 session/fork 提供。',
      'ack.revert': '我已了解：回滚会遮蔽所选消息及其后的全部内容',
      'ack.delete': '我已了解：将遮蔽这一条消息（日志中仍保留）',
      'confirm.revert': '回滚',
      'confirm.delete': '删除',
      'confirm.branch': '分支',
      'busy.revert': '回滚中…',
      'busy.delete': '删除中…',
      'busy.branch': '分支中…',
      'done.restore': '恢复完成：重放 {n} 条，跳过不可重放 {s} 条',
      'done.revert': '回滚完成，刷新页面后生效',
      'done.delete': '删除完成，刷新页面后生效',
      'action.reload': '刷新页面',
      errorPrefix: '操作失败：',
      'dock.title': '已回撤 {n} 条消息',
      'dock.expand': '展开回撤列表',
      'dock.collapse': '折叠回撤列表',
      'dock.shadowedN': '{n} 条已遮蔽',
      'dock.restore': '恢复',
      'dock.restoreHint': '恢复为重放：消息将出现在会话末尾，不会回到原位',
      'dock.restoring': '恢复中…',
      'slot.quote': '引用到输入框',
      'quote.done': '已引用到输入框',
      'quote.unavailable': '引用不可用（输入框不可写或无全文）',
      'quote.sourcePrefix': '引用自 seq {seq}',
      'undo.label': '回滚上一条消息',
      'undo.desc': '移除最后一条用户消息，原文回填输入框',
      'undo.done.undo': '已回滚上一条消息',
      'undo.done.redo': '已恢复上一条被回滚的消息',
      'undo.none': '没有可回滚的消息',
      'undo.none.redo': '没有可恢复的回滚',
      'redo.label': '恢复上一条被回滚的消息',
      'redo.desc': '把回滚掉的消息重新放回对话',
      'panel.messages': '消息',
      'panel.trash': '回收站',
      'panel.search': '搜索当前会话',
      'panel.searchHint': '搜索全文，不只是摘要',
      'panel.all': '全部',
      'panel.user': '用户',
      'panel.assistant': '助手',
      'panel.tool': '工具',
      'panel.includeShadowed': '含已回滚',
      'panel.loading': '正在读取…',
      'panel.loadFail': '读取失败：',
      'panel.searchFail': '搜索失败：',
      'panel.empty': '没有可显示的消息。',
      'panel.noMatch': '没有匹配结果。',
      'panel.selectHint': '选择一条消息，查看全文和操作。',
      'panel.detailLoading': '正在读取全文…',
      'panel.shadowed': '已回滚',
      'panel.running': '会话正在运行：回滚、删除、分支需先停止。',
      'panel.revert': '回滚到此条',
      'panel.revertHint': '包含此条及其后的可见消息',
      'panel.revertConfirmTitle': '回滚到 #{seq}？',
      'panel.revertConfirmBody': '将遮蔽 #{start}–#{end} 的 {n} 条消息，其中可见 {v} 条；日志仍保留，可恢复。',
      'panel.deleteConfirmTitle': '仅删除 #{seq}？',
      'panel.deleteConfirmBody': '将遮蔽这 1 条消息，其他内容不动；日志仍保留，可恢复。',
      'panel.confirmRevert': '确认回滚',
      'panel.confirmDeleteOne': '确认删除',
      'panel.retry': '重试',
      'panel.searching': '搜索中…',
      'panel.deleteSessionImpact': '共 {n} 条消息；移入回收站后 7 天内可恢复。',
      'panel.deleteUnavailable': '会话信息尚未就绪，暂不能删除。',
      'panel.delete': '仅删除此条',
      'panel.deleteHint': '只遮蔽这一条，其他消息不动',
      'panel.branch': '从此条分叉',
      'panel.branchHint': '复制此条之前的对话到新会话，并把此条原文放回新会话输入框',
      'panel.branchDone': '已分叉：新会话 {id}',
      'panel.branchUserOnly': '分叉只对用户消息可用（AI 消息没有可回填的原文）',
      // 0.17.0（冲突 R2）：行为是「复制原文到输入框」，不修改原消息。
      // 旧文案「编辑并重发」暗示会改原消息，实测会误导（发出后是新增一条，
      // 原消息仍在，界面出现两条相似消息）。opencode 也没有消息级编辑。
      'panel.openNew': '打开新会话',
      'panel.revertDone': '回滚已生效',
      'panel.deleteDone': '删除已生效',
      'panel.count': '共 {n} 条 · 可见 {v} · 已回滚 {s}',
      'panel.deleteSession': '删除整条会话',
      'panel.deleteSessionHint': '移入回收站，7 天内可恢复。请输入标题确认：',
      'panel.cancel': '取消',
      'panel.confirmDelete': '确认删除',
      'panel.deleting': '删除中…',
      'panel.deleted': '会话已移入回收站',
      'panel.trashEmpty': '回收站是空的。',
      'panel.untitled': '未命名会话',
      'panel.restore': '恢复',
      'panel.purge': '永久删除',
      'panel.purgeConfirm': '再点一次永久删除',
      'panel.restored': '会话已恢复',
      'panel.purged': '回收站条目已永久删除',
      'panel.expires': '到期',
      'panel.busy': '处理中…',
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
      'dialog.pickedAs': 'Selected #{seq} · {text}',
      'dialog.invisible': ' (shadowed, log-only)',
      'dialog.showMore': 'Show more ({n} older)',
      'dialog.more': '…(showing latest 200 of {n})',
      'op.revert': 'Revert: remove this message and everything after',
      'op.revertDesc':
        'Shadows the picked message and all later visible content; the log stays append-only so context can be restored by re-sending.',
      'op.delete': 'Delete only this message',
      'op.deleteDesc': 'Shadows only the picked message; everything else stays.',
      'op.branch': 'Fork into a new session from here',
      'op.branchDesc':
        'Copies the conversation above the picked message into a new session and puts this message back in the new composer (original untouched, non-destructive).',
      'slot.revert': 'Revert to here',
      'slot.revertUnmatched':
        'Cannot locate this message seq in the log (usually the model-written summary drifted too far from the rendered text) — use the Message ops dialog instead.',
      'slot.fork': 'Branch from here',
      'slot.forkHint': 'Copies the conversation above this message into a new session and puts this message back in the new composer',
      'slot.forkDone': 'Branched: new session {id}',
      'slot.forkUnavailable': 'Branch unavailable: the session is running, or the host provides no session/fork',
      'toast.openNew': 'Open new session',
      'fork.official': 'Branched (official fork): new session {id}',
      'fork.unavailable':
        'Built-in branch unavailable — usually because the session is running. Stop it and retry. Branching is provided by the dsh built-in session/fork.',
      'ack.revert': 'I understand: revert shadows the picked message and everything after it',
      'ack.delete': 'I understand: this message will be shadowed (kept in the log)',
      'confirm.revert': 'Revert',
      'confirm.delete': 'Delete',
      'confirm.branch': 'Branch',
      'busy.revert': 'Reverting…',
      'busy.delete': 'Deleting…',
      'busy.branch': 'Branching…',
      'done.restore': 'Restored: replayed {n}, skipped non-replayable {s}',
      'done.revert': 'Reverted; reload to apply',
      'done.delete': 'Deleted; reload to apply',
      'action.reload': 'Reload page',
      errorPrefix: 'Operation failed: ',
      'dock.title': '{n} rolled back messages',
      'dock.expand': 'Expand revert list',
      'dock.collapse': 'Collapse revert list',
      'dock.shadowedN': '{n} shadowed',
      'dock.restore': 'Restore',
      'dock.restoreHint': 'Restores by replay: messages appear at the end of the session, not in their original place',
      'dock.restoring': 'Restoring…',
      'slot.quote': 'Quote to composer',
      'quote.done': 'Quoted into composer',
      'quote.unavailable': 'Quote unavailable (composer locked or no full text)',
      'quote.sourcePrefix': 'Quoted from seq {seq}',
      'undo.label': 'Undo last message',
      'undo.desc': 'Remove the last user message and put its original text back into the composer',
      'undo.done.undo': 'Undid the last message',
      'undo.done.redo': 'Restored the last reverted message',
      'undo.none': 'No message to undo',
      'undo.none.redo': 'No revert to redo',
      'redo.label': 'Restore the last reverted message',
      'redo.desc': 'Put the reverted message back into the conversation',
      'panel.messages': 'Messages',
      'panel.trash': 'Trash',
      'panel.search': 'Search this session',
      'panel.searchHint': 'Search full text, not just snippets',
      'panel.all': 'All',
      'panel.user': 'User',
      'panel.assistant': 'Assistant',
      'panel.tool': 'Tool',
      'panel.includeShadowed': 'Include shadowed',
      'panel.loading': 'Loading…',
      'panel.loadFail': 'Failed to load: ',
      'panel.searchFail': 'Search failed: ',
      'panel.empty': 'No messages to show.',
      'panel.noMatch': 'No matches.',
      'panel.selectHint': 'Pick a message to see its full text and actions.',
      'panel.detailLoading': 'Loading full text…',
      'panel.shadowed': 'reverted',
      'panel.running': 'Session is running: stop it before revert, delete, or branch.',
      'panel.revert': 'Revert to here',
      'panel.revertHint': 'Includes this message and all visible messages after it',
      'panel.revertConfirmTitle': 'Revert to #{seq}?',
      'panel.revertConfirmBody':
        'This shadows {n} messages (#{start}–#{end}), including {v} visible. The log stays append-only and can be restored.',
      'panel.deleteConfirmTitle': 'Delete only #{seq}?',
      'panel.deleteConfirmBody': 'This shadows this one message; everything else stays. The log stays append-only and can be restored.',
      'panel.confirmRevert': 'Confirm revert',
      'panel.confirmDeleteOne': 'Confirm delete',
      'panel.retry': 'Retry',
      'panel.searching': 'Searching…',
      'panel.deleteSessionImpact': 'Total {n} messages; recoverable from trash for 7 days.',
      'panel.deleteUnavailable': 'Session details are not ready yet; deletion is disabled.',
      'panel.delete': 'Delete only this',
      'panel.deleteHint': 'Shadows only this message',
      'panel.branch': 'Fork from here',
      'panel.branchHint': 'Copy the conversation above this message into a new session and put this message back in the new composer',
      'panel.branchDone': 'Forked: {id}',
      'panel.branchUserOnly': 'Fork works on user messages only (assistant messages have no text to hand back)',
      'panel.openNew': 'Open new session',
      'panel.revertDone': 'Revert applied',
      'panel.deleteDone': 'Delete applied',
      'panel.count': 'Total {n} · visible {v} · shadowed {s}',
      'panel.deleteSession': 'Delete whole session',
      'panel.deleteSessionHint': 'Moves it to trash for 7 days. Type the title to confirm:',
      'panel.cancel': 'Cancel',
      'panel.confirmDelete': 'Delete',
      'panel.deleting': 'Deleting…',
      'panel.deleted': 'Session moved to trash',
      'panel.trashEmpty': 'Trash is empty.',
      'panel.untitled': 'Untitled session',
      'panel.restore': 'Restore',
      'panel.purge': 'Delete forever',
      'panel.purgeConfirm': 'Click again to delete forever',
      'panel.restored': 'Session restored',
      'panel.purged': 'Trash entry permanently deleted',
      'panel.expires': 'expires',
      'panel.busy': 'Working…',
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
    var __peekRowsCache = null // 0.6.0：会话视图会话 id（RevertDock/MsgSlotActions 刷新）
    // messageId→seq 索引缓存（每会话一次拉取；0.3.0 assistant-actions 槽用）
    var __seqIndexCache = new Map()
    // messageId→全文缓存（0.5.0 消息引用用）
    var __fullTextCache = new Map()

    function localeFallbackLang() {
      if (typeof navigator === 'undefined') return 'zh'
      for (const tag of (navigator.languages || []).concat([navigator.language])) {
        const primary = String(tag || '')
          .toLowerCase()
          .split('-')[0]
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
        return __locale.subscribe(() => setRev(v => v + 1))
      }, [])
    }

    // --- styles（仅 --dsw-* 主题令牌） ----------------------------------------
    const btnStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 28,
      height: 28,
      padding: 0,
      border: 'none',
      borderRadius: 4,
      background: 'transparent',
      color: 'var(--dsw-alias-label-tertiary, #8a8a8e)',
      cursor: 'pointer',
      flex: 'none',
    }
    const metaStyle = {
      color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
      fontSize: 13,
      lineHeight: '20px',
      margin: '0 0 8px',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    }
    const warnStyle = {
      color: 'var(--dsw-alias-state-warn-primary, #f5a524)',
      fontSize: 13,
      lineHeight: '20px',
      margin: '0 0 10px',
    }
    const errStyle = {
      color: 'var(--dsw-alias-state-error-primary, #e5484d)',
      fontSize: 12,
      lineHeight: '16px',
      marginTop: 8,
    }
    const statusStyle = {
      color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
      fontSize: 12,
      lineHeight: '16px',
      marginTop: 8,
    }
    const listStyle = {
      maxHeight: 260,
      overflowY: 'auto',
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
      borderRadius: 8,
      margin: '8px 0 4px',
      padding: '4px 0',
    }
    const rowStyle = {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 8,
      padding: '4px 10px',
      fontSize: 13,
      lineHeight: '18px',
      cursor: 'pointer',
    }
    const descStyle = {
      color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
      fontSize: 12,
      lineHeight: '17px',
      margin: '6px 0 0',
    }
    const cancelBtnStyle = {
      padding: '6px 14px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary, inherit)',
      fontSize: 13,
      cursor: 'pointer',
      marginRight: 8,
    }
    const primaryBtnStyle = {
      padding: '6px 14px',
      borderRadius: 8,
      border: 'none',
      background: 'var(--dsw-alias-brand-primary, #4d6bfe)',
      color: '#fff',
      fontSize: 13,
      cursor: 'pointer',
    }
    const dangerBtnStyle = {
      padding: '6px 14px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-state-error-primary, #e5484d)',
      background: 'var(--dsw-alias-state-error-primary, #e5484d)',
      color: '#fff',
      fontSize: 13,
      cursor: 'pointer',
    }
    const optStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      fontSize: 13,
      lineHeight: '20px',
      color: 'var(--dsw-alias-label-primary, inherit)',
      marginTop: 10,
    }

    // 头部按钮图标：三叉分支（git-branch 风格，16x16）。
    // ⚠️ 这条 path 是按**描边**（stroke）设计的：圆点用 arc 画、连接线用
    // `v3.44` / `V6.28` / `v.85` 这类**零宽度线段**。若用 fill 渲染，线段没有
    // 面积 → 整条分支线消失，只剩几个孤立色块（0.11.x 实测症状：
    // 「那个 svg 渲染有问题」）。必须 stroke + round cap/join。
    // 唯一数据源：所有图标入口（React 组件 / innerHTML 字符串）都从这里取，
    // 以免再次出现「一处改名、另一处仍用旧名 → d="undefined"」的回归。
    const BRANCH_PATH =
      'M5 2.5a2 2 0 1 1-.9 3.78v3.44a2 2 0 1 1-1.2 0V6.28A2 2 0 1 1 5 2.5Zm0 1.2a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6ZM3.5 11.5a.8.8 0 1 0 1.6 0 .8.8 0 0 0-1.6 0ZM12.5 2.5a2 2 0 0 1 .6 3.9v.85c0 1.9-1.54 3.44-3.44 3.44H8.03a2 2 0 1 1 0-1.2h1.63a2.24 2.24 0 0 0 2.24-2.24V6.4a2 2 0 0 1 .6-3.9Zm0 1.2a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6Z'
    const BRANCH_STROKE = 1.4

    /** 生成分支图标的 SVG 标记（供 innerHTML 场景复用）。 */
    function branchIconMarkup(size) {
      const px = size || 16
      return (
        '<svg width="' +
        px +
        '" height="' +
        px +
        '" viewBox="0 0 16 16" fill="none"' +
        ' xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"' +
        ' style="flex:none"><path d="' +
        BRANCH_PATH +
        '" fill="none"' +
        ' stroke="currentColor" stroke-width="' +
        BRANCH_STROKE +
        '"' +
        ' stroke-linecap="round" stroke-linejoin="round"/></svg>'
      )
    }

    /**
     * 面板唤起按钮的图标：官方 `list-pen-outline`（列表 + 笔）。
     *
     * 0.18.0 前的 bug：这里用的是**分叉图标**（IconBranch）—— 一个"消息操作"
     * 面板却长着"分叉"的脸，用户会以为点它是 fork。语义错位就是用户说的
     * 「唤起它的 UI 显示明显有问题」。
     *
     * 「列表 + 笔」同时表达了两件事：浏览消息列表、编辑内容 —— 正是这个面板
     * 的用途（用户也确认它可以当作"编辑 + AI 对话上下文面板"）。
     *
     * 几何取自宿主 icon sprite 的 `dsw-icon-list-pen-outline-regular`
     * （16 viewBox，描边 1.2，与宿主动作行图标同一套视觉）。
     */
    /**
     * 分叉图标组件。0.18.0 起**不再用于面板唤起按钮**（那曾造成语义错位：
     * "消息操作"面板长着"分叉"的脸），但保留它是因为 `branchIconMarkup`
     * 与它共用 `BRANCH_PATH` 常量 —— `test/icon-render.test.js` 锁定了这条同源约束，
     * 防止两处各画一套分叉几何而慢慢漂移。
     */
    function BranchIcon() {
      return React.createElement(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 16 16',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        React.createElement('path', {
          d: BRANCH_PATH,
          stroke: 'currentColor',
          strokeWidth: BRANCH_STROKE,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          fill: 'none',
        }),
      )
    }

    function OpsPanelIcon() {
      return React.createElement(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 16 16',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        React.createElement('path', { d: 'M4.9375 5.90295H11.0625', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
        React.createElement('path', { d: 'M4.9375 9.02991H8.27841', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
        React.createElement('path', {
          d: 'M12.5 1.32617C13.3039 1.32617 14 1.95171 14 2.77637V7.61328L13 8.68164V2.77637C13 2.55186 12.8007 2.32617 12.5 2.32617H3.5C3.1993 2.32617 3 2.55186 3 2.77637V13.2246C3.00044 13.4489 3.19963 13.6738 3.5 13.6738H8.32812L7.39258 14.6738H3.5C2.69637 14.6738 2.00042 14.0489 2 13.2246V2.77637C2 1.95171 2.69613 1.32617 3.5 1.32617H12.5Z',
          fill: 'currentColor',
        }),
        React.createElement('path', {
          d: 'M8.97212 14.3693C9.17511 14.5723 9.37811 14.7753 9.5811 14.9783C9.67012 14.8953 9.75914 14.8123 9.84815 14.7293C11.4505 13.2352 13.0528 11.7411 14.6551 10.247C14.7441 10.164 14.8331 10.081 14.9221 9.99803C14.5989 9.6748 14.2756 9.35157 13.9524 9.02834C13.8694 9.11736 13.7864 9.20637 13.7034 9.29539C12.2093 10.8977 10.7152 12.5 9.22113 14.1023C9.13813 14.1913 9.05513 14.2803 8.97212 14.3693Z',
          fill: 'currentColor',
        }),
      )
    }

    // --- 共享对话框 -------------------------------------------------------------
    // 模块级缓存最近一次 target，事件驱动打开。
    const MAX_RENDER = 200
    const PAGE_SIZE = 50 // 低成本分批渲染：先渲 50 条，按钮渐进展开

    function OpsDialog(props) {
      const t = (props && props.t) || __t
      useLocaleRevision()
      const [target, setTarget] = useState(null) // {sessionId, title, running}
      const [state, setState] = useState('idle') // idle|loading|ready|busy|done
      const [messages, setMessages] = useState([])
      const [sessionMeta, setSessionMeta] = useState(null)
      const [picked, setPicked] = useState(null) // seq
      const [mode, setMode] = useState(null) // revert|delete|branch|restore
      const [childId, setChildId] = useState(null) // 官方 fork 成功后的子会话 id
      const [acknowledged, setAcknowledged] = useState(false)
      const [busyMsg, setBusyMsg] = useState('')
      const [renderLimit, setRenderLimit] = useState(PAGE_SIZE) // 已展开的渲染条数
      const [doneMsg, setDoneMsg] = useState('')
      const [error, setError] = useState(null)

      useEffect(() => {
        const handler = e => {
          const d = e && e.detail ? e.detail : {}
          setTarget({ sessionId: d.sessionId || null, title: d.title || null, running: d.running === true })
          setState('loading')
          setMessages([])
          setSessionMeta(null)
          // 槽按钮预置：携带 seq（picked）与 mode 直接进入确认态
          setPicked(typeof d.seq === 'number' ? d.seq : null)
          setMode(typeof d.mode === 'string' ? d.mode : null)
          setAcknowledged(false)
          setError(null)
          setDoneMsg('')
          setRenderLimit(PAGE_SIZE)
        }
        window.addEventListener(EVENT, handler)
        return () => window.removeEventListener(EVENT, handler)
      }, [])

      useEffect(() => {
        if (state !== 'loading' || !target || !target.sessionId) return
        let cancelled = false
        fetchMessagesJson('/api/message-ops/messages?sessionId=' + encodeURIComponent(target.sessionId))
          .then(data => {
            if (cancelled) return
            if (!data || !data.ok) throw new Error(data && data.error ? data.error : `HTTP ${data && data.status}`)
            setMessages(data.messages || [])
            setSessionMeta(data.session || null)
            if (data.running === true) setTarget(prev => ({ ...(prev || {}), running: true }))
            setState('ready')
          })
          .catch(reason => {
            if (cancelled) return
            setError(t('dialog.loadFail') + (reason && reason.message ? reason.message : String(reason)))
            setState('ready')
          })
        return () => {
          cancelled = true
        }
      }, [state, target, t])

      const close = useCallback(() => {
        if (state === 'busy') return
        setTarget(null)
        setError(null)
      }, [state])

      const pick = useCallback(
        m => {
          if (state === 'busy') return
          setPicked(m.seq)
          setMode(null)
          setAcknowledged(false)
          setError(null)
        },
        [state],
      )

      const chooseMode = useCallback(
        m => {
          if (picked == null || state === 'busy') return
          setMode(m)
          setAcknowledged(false)
          setError(null)
        },
        [picked, state],
      )

      const run = useCallback(() => {
        if (state === 'busy' || picked == null || !mode) return
        if (mode !== 'branch' && !acknowledged) return
        setBusyMsg(t('busy.' + (mode === 'revert' || mode === 'delete' ? mode : 'branch')))
        setState('busy')
        setError(null)
        if (mode === 'branch') {
          // 0.12.0：与面板/消息行同一实现 —— opencode 的 before 语义
          // （新会话不含此条，原文回新会话输入框）。只对用户消息成立；
          // 分支不再回落写盘（被删的磁盘 applyBranch 语义复盘见 README）。
          const pickedRow = picked != null ? messages.find(m => m.seq === picked) : null
          if (!pickedRow || pickedRow.role !== 'user') {
            setError(t('panel.branchUserOnly'))
            setBusyMsg('')
            setState('error')
            return
          }
          Promise.resolve()
            .then(() =>
              forkFromUserMessage(target.sessionId, picked, pickedRow.fullText || pickedRow.snippet || '', pickedRow.turnStartSeq),
            )
            .then(childId => {
              setDoneMsg(t('fork.official', { id: String(childId || '') }))
              setBusyMsg('')
              setChildId(childId || null)
              setState('done')
              notifyDone(t('fork.official', { id: String(childId || '') }))
            })
            .catch(reason => {
              setError(String((reason && reason.message) || reason || t('fork.unavailable')))
              setBusyMsg('')
              setState('error')
            })
          return
        }
        const path = mode
        const body = { sessionId: target.sessionId, seq: picked }
        Promise.resolve()
          .then(() =>
            fetch('/api/message-ops/' + path, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }),
          )
          .then(async res => {
            let data = {}
            try {
              data = await res.json()
            } catch {
              /* keep {} */
            }
            if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
            // S6 修复（G-M1）：不再 900ms 裸 location.reload。成功走 devkit
            // 标准 toast（无 devkit 时降级为对话框内 doneMsg），并提供手动
            // 「刷新页面」按钮。
            // 0.9.7：补回 ec862d6(0.9.0) 误删的 `const okMsg =`——留下悬挂的
            // `? :` 会让成功路径抛 ReferenceError 落进 .catch（用户看到「操作失败」，
            // notifyDone/emitChanged/openSession/回填全不执行），失败路径则恒走
            // `?` 分支把成功文案当错误抛出。对话框 mode 只有 revert|delete|branch，
            // branch 在上面已 return，故 done.restore 分支在此不可达，一并删掉。
            const okMsg = mode === 'revert' ? t('done.revert') : t('done.delete')
            // 0.19.0：回填统一由 refillComposer 承担；老 setDraft 路径已删（见 spec §9）。
            setDoneMsg(okMsg)
            setBusyMsg('')
            setState('done')
            notifyDone(okMsg)
            emitChanged()
            // 0.5.7：store-miss 的磁盘追加没有 live 投影事件 —— 成功后强制
            // 重建视图（与 restoreRow 同款 openSession 模式），遮蔽即刻可见。
            try {
              if (__uiWorkspace && typeof __uiWorkspace.openSession === 'function') __uiWorkspace.openSession(target.sessionId)
            } catch {
              /* 视图重建失败不阻断成功反馈 */
            }
          })
          .catch(reason => {
            setBusyMsg('')
            setState('ready')
            setError(t('errorPrefix') + (reason && reason.message ? reason.message : String(reason)))
          })
      }, [state, picked, mode, acknowledged, target, t])

      if (!target) return null

      // 0.6.0：system prompt 行不可作为回滚/删除/分支目标（引擎拒之以 node0 守卫，
      // 但不该给用户一个必然500的选项）——列表直接排除 role=system。
      const visible = messages.filter(m => m.visible !== false && m.role !== 'system')
      const shownBase = visible.slice(-MAX_RENDER)
      const hiddenCount = visible.length - shownBase.length
      // 分批渲染（评审 M1）：只渲染 renderLimit 条，更早的留给「显示更多」
      // 渐进展开，避免 200 行 radio 列表一次进 DOM。
      const shown = shownBase.slice(-renderLimit)
      const pagedCount = shownBase.length - shown.length
      const pickedMsg = picked != null ? messages.find(m => m.seq === picked) : null

      // 0.9.0 可发现性：操作区固定在**消息列表之前**。
      // 原先它在列表之后，而列表是 260px 滚动 + 分批渲染 50 条/页 ——
      // 未选中消息时三个 radio 完全不在视野内，用户以为「只有列表、没有操作」。
      // 未选中时给明确指引，而不是空着。
      const opsPanel = pickedMsg
        ? React.createElement(
            'div',
            { key: 'ops', style: { margin: '8px 0 0' } },
            React.createElement(
              'div',
              { style: { ...metaStyle, margin: '0 0 4px' } },
              t('dialog.pickedAs', { seq: String(pickedMsg.seq), text: (pickedMsg.snippet || '').slice(0, 60) }),
            ),
            ['revert', 'delete', 'branch'].map((m, i) =>
              React.createElement(
                'div',
                { key: m, style: { marginTop: i === 0 ? 6 : 4 } },
                React.createElement(
                  'label',
                  { style: optStyle },
                  React.createElement('input', {
                    type: 'radio',
                    name: 'dsh-message-ops-mode',
                    checked: mode === m,
                    onChange: () => chooseMode(m),
                    disabled: state === 'busy',
                  }),
                  t('op.' + m),
                ),
                mode === m ? React.createElement('div', { style: descStyle }, t('op.' + m + 'Desc')) : null,
              ),
            ),
            mode && mode !== 'branch'
              ? React.createElement(
                  'label',
                  { key: 'ack', style: optStyle },
                  React.createElement('input', {
                    type: 'checkbox',
                    checked: acknowledged,
                    disabled: state === 'busy',
                    onChange: e => setAcknowledged(e.target.checked),
                  }),
                  t(mode === 'revert' ? 'ack.revert' : 'ack.delete'),
                )
              : null,
          )
        : React.createElement(
            'div',
            {
              key: 'opshint',
              style: {
                ...metaStyle,
                margin: '8px 0 0',
                padding: '6px 8px',
                borderRadius: 6,
                background: 'var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1))',
              },
            },
            t('dialog.pickFirst'),
          )

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
          React.createElement(
            'div',
            { key: 'list', style: listStyle },
            hiddenCount > 0
              ? React.createElement(
                  'div',
                  { key: 'more', style: { ...rowStyle, cursor: 'default', color: 'var(--dsw-alias-label-secondary,#8a8a8e)' } },
                  t('dialog.more', { n: String(visible.length) }),
                )
              : null,
            pagedCount > 0
              ? React.createElement(
                  'button',
                  {
                    key: 'show-more',
                    type: 'button',
                    style: {
                      ...rowStyle,
                      border: 'none',
                      width: '100%',
                      color: 'var(--dsw-alias-label-secondary,#8a8a8e)',
                      cursor: 'pointer',
                    },
                    onClick: () => setRenderLimit(l => Math.min(l + PAGE_SIZE, MAX_RENDER)),
                  },
                  t('dialog.showMore', { n: String(pagedCount) }),
                )
              : null,
            shown.map((m, i) =>
              React.createElement(
                'label',
                {
                  key: m.seq + '-' + i,
                  style: {
                    ...rowStyle,
                    background: picked === m.seq ? 'var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))' : 'transparent',
                  },
                },
                React.createElement('input', {
                  type: 'radio',
                  name: 'dsh-message-ops-pick',
                  checked: picked === m.seq,
                  onChange: () => pick(m),
                  disabled: state === 'busy',
                }),
                React.createElement(
                  'span',
                  {
                    style: {
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: m.visible === false ? 'var(--dsw-alias-label-tertiary,#b0b0b4)' : 'inherit',
                    },
                  },
                  '#' + m.seq + ' ' + (m.role || '') + ' · ' + (m.snippet || '') + (m.visible === false ? t('dialog.invisible') : ''),
                ),
              ),
            ),
          ),
          // 0.9.7：删掉列表**之后**的旧 opsPanel——0.9.0 把操作区挪到列表之前时
          // 没删旧位置，两组同名 radio（name='dsh-message-ops-mode'）互抢，
          // checked 状态在两份 DOM 之间互相顶掉。
        ])
      }

      const canRun = state !== 'busy' && state !== 'loading' && picked != null && mode != null && (mode === 'branch' || acknowledged)
      const confirmLabel = busyMsg || (mode ? t('confirm.' + mode) : t('dialog.cancel'))

      return React.createElement(
        Modal,
        {
          open: true,
          onClose: close,
          title: t('dialog.title'),
          closeLabel: t('dialog.cancel'),
          description: t('dialog.session') + (target.title || target.sessionId || ''),
          footer: [
            React.createElement(
              'button',
              {
                key: 'cancel',
                type: 'button',
                disabled: state === 'busy',
                onClick: close,
                style: { ...cancelBtnStyle, ...(state === 'busy' ? { opacity: 0.5, cursor: 'default' } : {}) },
              },
              t('dialog.cancel'),
            ),
            React.createElement(
              'button',
              {
                key: 'confirm',
                type: 'button',
                disabled: !canRun,
                onClick: run,
                style: {
                  ...(mode === 'delete' || mode === 'revert' ? dangerBtnStyle : primaryBtnStyle),
                  ...(!canRun ? { opacity: 0.5, cursor: 'default' } : {}),
                },
              },
              confirmLabel,
            ),
            ...(state === 'done' && (mode === 'revert' || mode === 'delete')
              ? [
                  React.createElement(
                    'button',
                    {
                      key: 'reload',
                      type: 'button',
                      onClick: () => {
                        try {
                          window.location.reload()
                        } catch {
                          /* non-browser guard */
                        }
                      },
                      style: primaryBtnStyle,
                    },
                    t('action.reload'),
                  ),
                ]
              : []),
            ...(state === 'done' && mode === 'branch' && childId
              ? [
                  React.createElement(
                    'button',
                    {
                      key: 'open-new',
                      type: 'button',
                      onClick: () => {
                        try {
                          // 0.2.0+：uiWorkspace.openSession 是宿主唯一打开通道
                          if (__uiWorkspace && typeof __uiWorkspace.openSession === 'function') __uiWorkspace.openSession(childId)
                        } catch {
                          /* 打开失败不阻断 */
                        }
                      },
                      style: primaryBtnStyle,
                    },
                    t('toast.openNew'),
                  ),
                ]
              : []),
          ],
        },
        [
          React.createElement('div', { key: 'meta', style: metaStyle }, t('dialog.session'), target.sessionId || ''),
          body,
          doneMsg ? React.createElement('div', { key: 'done', style: statusStyle }, doneMsg) : null,
          error ? React.createElement('div', { key: 'err', style: errStyle, role: 'alert' }, error) : null,
        ],
      )
    }

    // --- A · 功能主义抽屉 -------------------------------------------------------

    const PANEL_ROW_H = 46
    const PANEL_SEARCH_LIMIT = 100

    function fmtClock(value) {
      if (typeof value !== 'number') return ''
      try {
        return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      } catch {
        return ''
      }
    }

    function roleCode(role) {
      if (role === 'user') return 'U'
      if (role === 'assistant') return 'A'
      if (role === 'tool') return 'T'
      return 'S'
    }

    function focusablesIn(root) {
      if (!root || typeof root.querySelectorAll !== 'function') return []
      const selector =
        'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
      return Array.prototype.slice.call(root.querySelectorAll(selector)).filter(el => {
        if (el.getAttribute('aria-hidden') === 'true') return false
        return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0
      })
    }

    function ensurePanelStyle() {
      try {
        if (document.getElementById('dsh-message-ops-panel-style')) return
        const tag = document.createElement('style')
        tag.id = 'dsh-message-ops-panel-style'
        tag.textContent = [
          '.mopsPanelScrim{position:fixed;inset:0;z-index:1200;background:rgba(15,17,21,.28);display:flex;align-items:center;justify-content:center;padding:24px;animation:mopsFade .12s ease-out}',
          '@keyframes mopsFade{from{opacity:0}to{opacity:1}}',
          '@keyframes mopsRise{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}',
          '.mopsPanel{width:560px;max-width:min(560px,100%);height:min(760px,100%);max-height:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-primary,#fff);color:var(--dsw-alias-label-primary,#0f1115);border:1px solid var(--dsw-alias-border-l2,#e6e6e6);box-shadow:0 24px 64px rgba(15,17,21,.24);font-family:inherit;font-size:13px;line-height:1.45;animation:mopsRise .16s cubic-bezier(.2,.8,.3,1)}',
          '@media(prefers-reduced-motion:reduce){.mopsPanelScrim,.mopsPanel{animation:none}}',
          '.mopsPanel *{box-sizing:border-box}',
          '.mopsPanel button{font:inherit;color:inherit;border-radius:0}',
          '.mopsPanelHead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px 18px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,#e6e6e6)}',
          '.mopsPanelKicker{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#8a8a8e)}',
          '.mopsPanelTitle{font-size:15px;font-weight:600;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px}',
          '.mopsPanelSub{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a8e);margin-top:2px}',
          '.mopsPanelClose{width:30px;height:30px;border:1px solid var(--dsw-alias-border-l2,#e6e6e6);background:transparent;cursor:pointer;font-size:16px;line-height:1;flex:none}',
          '.mopsPanelClose:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(15,17,21,.06))}',
          '.mopsTabs{display:flex;border-bottom:1px solid var(--dsw-alias-border-l2,#e6e6e6)}',
          '.mopsTab{flex:1;padding:9px 12px;border:0;border-bottom:2px solid transparent;background:transparent;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary,#6b6b70)}',
          '.mopsTab.on{border-bottom-color:var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-label-primary,#0f1115);font-weight:600}',
          '.mopsSearchRow{display:flex;gap:8px;padding:12px 18px 8px}',
          '.mopsSearch{flex:1;min-width:0;height:32px;border:1px solid var(--dsw-alias-border-l2,#d8d8d8);background:transparent;color:inherit;padding:0 9px;font:inherit;font-size:12px;outline:none}',
          '.mopsSearch:focus{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}',
          '.mopsChips{display:flex;gap:6px;padding:0 18px 10px;flex-wrap:wrap;align-items:center}',
          '.mopsChip{height:26px;padding:0 9px;border:1px solid var(--dsw-alias-border-l2,#d8d8d8);background:transparent;cursor:pointer;font-size:11px;color:var(--dsw-alias-label-secondary,#6b6b70)}',
          '.mopsChip.on{border-color:var(--dsw-alias-label-primary,#0f1115);background:var(--dsw-alias-label-primary,#0f1115);color:var(--dsw-alias-bg-primary,#fff)}',
          '.mopsToggle{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--dsw-alias-label-secondary,#6b6b70);margin-left:auto;cursor:pointer}',
          '.mopsToggle input{accent-color:var(--dsw-alias-brand-primary,#4d6bfe)}',
          '.mopsList{flex:1;min-height:0;overflow-y:auto;position:relative;border-top:1px solid var(--dsw-alias-border-l1,#efefef)}',
          '.mopsList:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:-2px}',
          '.mopsRow{position:absolute;left:0;right:0;display:grid;grid-template-columns:44px 26px minmax(0,1fr) 48px;align-items:center;gap:8px;width:100%;border:0;border-bottom:1px solid var(--dsw-alias-border-l1,#f0f0f0);background:transparent;text-align:left;cursor:pointer;padding:0 12px 0 18px;color:inherit;font:inherit}',
          '.mopsRow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(15,17,21,.045))}',
          '.mopsRow.on{background:rgba(77,107,254,.08);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary,#4d6bfe)}',
          '.mopsRow.shadowed{opacity:.42}',
          '.mopsSeq{font-variant-numeric:tabular-nums;font-size:10px;color:var(--dsw-alias-label-tertiary,#9a9aa0)}',
          '.mopsRole{width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border-l2,#d8d8d8);font-size:9px;font-weight:600;color:var(--dsw-alias-label-secondary,#6b6b70)}',
          '.mopsSnippet{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}',
          '.mopsClock{font-size:10px;color:var(--dsw-alias-label-tertiary,#9a9aa0);text-align:right;font-variant-numeric:tabular-nums}',
          '.mopsEmpty{padding:28px 18px;color:var(--dsw-alias-label-tertiary,#8a8a8e);font-size:12px}',
          '.mopsErrorState{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap;color:var(--dsw-alias-state-error-primary,#c63b32)}',
          '.mopsErrorState .mopsAction{flex:none}',
          '.mopsDetail{flex:none;max-height:37%;overflow-y:auto;border-top:1px solid var(--dsw-alias-border-l2,#e6e6e6);padding:12px 18px 10px;background:var(--dsw-alias-bg-secondary,#fafafa)}',
          '.mopsDetailMeta{display:flex;gap:8px;align-items:center;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a8e);margin-bottom:6px}',
          '.mopsDetailText{margin:0;white-space:pre-wrap;word-break:break-word;max-height:108px;overflow:auto;font-family:inherit;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-primary,#0f1115)}',
          '.mopsDetailHint{padding:10px 0 14px;color:var(--dsw-alias-label-tertiary,#8a8a8e);font-size:12px}',
          '.mopsActions{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}',
          '.mopsActionConfirm{display:flex;flex-direction:column;gap:7px;margin-top:10px;padding:10px;border:1px solid var(--dsw-alias-border-l2,#e6e6e6);background:var(--dsw-alias-bg-primary,#fff)}',
          '.mopsImpactTitle{font-size:12px;font-weight:600}',
          '.mopsImpact{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,#6b6b70)}',
          '.mopsAction{height:30px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,#cfcfcf);background:transparent;cursor:pointer;font-size:11px}',
          '.mopsAction:hover:not(:disabled){border-color:var(--dsw-alias-label-primary,#0f1115)}',
          '.mopsAction.primary{border-color:var(--dsw-alias-label-primary,#0f1115);background:var(--dsw-alias-label-primary,#0f1115);color:var(--dsw-alias-bg-primary,#fff)}',
          '.mopsAction.danger{border-color:var(--dsw-alias-state-error-primary,#c63b32);color:var(--dsw-alias-state-error-primary,#c63b32)}',
          '.mopsAction:disabled{opacity:.35;cursor:default}',
          '.mopsPanelFoot{flex:none;display:flex;align-items:center;gap:10px;justify-content:space-between;padding:10px 18px;border-top:1px solid var(--dsw-alias-border-l2,#e6e6e6);background:var(--dsw-alias-bg-primary,#fff)}',
          '.mopsCount{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a8e)}',
          '.mopsDanger{border:1px solid var(--dsw-alias-state-error-primary,#c63b32);background:transparent;color:var(--dsw-alias-state-error-primary,#c63b32);height:28px;padding:0 9px;cursor:pointer;font-size:11px}',
          '.mopsDanger:hover{background:rgba(198,59,50,.06)}',
          '.mopsBanner{padding:7px 18px;font-size:11px;border-bottom:1px solid var(--dsw-alias-border-l1,#efefef)}',
          '.mopsBanner.warn{color:var(--dsw-alias-state-warn-primary,#9a6500);background:rgba(154,101,0,.06)}',
          '.mopsBanner.err{color:var(--dsw-alias-state-error-primary,#c63b32);background:rgba(198,59,50,.06)}',
          '.mopsBanner.ok{color:var(--dsw-alias-state-success-primary,#2f7d4a);background:rgba(47,125,74,.06)}',
          '.mopsConfirm{position:absolute;inset:0;z-index:2;background:var(--dsw-alias-bg-primary,#fff);display:flex;flex-direction:column;justify-content:center;padding:28px 24px;gap:10px}',
          '.mopsConfirm h3{margin:0;font-size:15px}',
          '.mopsConfirm p{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary,#6b6b70)}',
          '.mopsConfirm p.mopsImpact{font-size:11px}',
          '.mopsConfirm .mopsBanner{margin:0 -24px;border-top:1px solid var(--dsw-alias-border-l1,#efefef);border-bottom:1px solid var(--dsw-alias-border-l1,#efefef)}',
          '.mopsConfirm input{height:34px;border:1px solid var(--dsw-alias-border-l2,#d8d8d8);background:transparent;color:inherit;padding:0 9px;font:inherit;font-size:13px}',
          '.mopsConfirm input:disabled{opacity:.5}',
          '.mopsConfirmRow{display:flex;gap:8px;margin-top:4px}',
          '.mopsTrashItem{display:flex;align-items:center;gap:10px;padding:11px 18px;border-bottom:1px solid var(--dsw-alias-border-l1,#f0f0f0)}',
          '.mopsTrashMain{flex:1;min-width:0}',
          '.mopsTrashTitle{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
          '.mopsTrashMeta{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a8e);margin-top:2px}',
          '@media(max-width:760px){.mopsPanelScrim{padding:0}.mopsPanel{width:100%;height:100%;max-width:100%;max-height:100%;border:0}.mopsDetail{max-height:42%}}',
        ].join('')
        document.head.appendChild(tag)
      } catch {
        /* style failure must not break the panel */
      }
    }

    function OpsPanel(props) {
      const t = (props && props.t) || __t
      useLocaleRevision()
      const [open, setOpen] = useState(false)
      const [target, setTarget] = useState(null)
      const [state, setState] = useState('idle')
      const [loadError, setLoadError] = useState(null)
      const [messages, setMessages] = useState([])
      const [query, setQuery] = useState('')
      const [role, setRole] = useState('all')
      const [includeShadowed, setIncludeShadowed] = useState(false)
      const [picked, setPicked] = useState(null)
      const [detail, setDetail] = useState('')
      const [detailState, setDetailState] = useState('idle')
      // MED-5：detail 是**全文**还是 snippet 回退？只有全文才允许「编辑并重发」。
      const [tab, setTab] = useState('messages')
      const [hits, setHits] = useState(null)
      const [searching, setSearching] = useState(false)
      const [trash, setTrash] = useState([])
      const [trashState, setTrashState] = useState('idle')
      const [trashError, setTrashError] = useState(null)
      const [confirmDelete, setConfirmDelete] = useState(false)
      const [confirmTitle, setConfirmTitle] = useState('')
      const [deleteError, setDeleteError] = useState(null)
      const [confirmAction, setConfirmAction] = useState(null)
      const [purgeId, setPurgeId] = useState(null)
      const [childId, setChildId] = useState(null)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState(null)
      const [done, setDone] = useState('')
      const [scrollTop, setScrollTop] = useState(0)
      const [viewport, setViewport] = useState(480)
      const listRef = useRef(null)
      const searchRef = useRef(null)
      const panelRef = useRef(null)
      const scrimRef = useRef(null)
      const confirmRef = useRef(null)
      const actionConfirmRef = useRef(null)
      const triggerRef = useRef(null)
      const deleteBtnRef = useRef(null)
      const revertBtnRef = useRef(null)
      const deleteOneBtnRef = useRef(null)
      const detailReq = useRef(0)
      const loadSeqRef = useRef(0)
      const trashSeqRef = useRef(0)
      const openRef = useRef(false)
      const sessionRef = useRef(null)
      openRef.current = open
      sessionRef.current = target && target.sessionId ? target.sessionId : null

      useEffect(() => {
        ensurePanelStyle()
        const handler = e => {
          const d = e && e.detail ? e.detail : {}
          if (!d.sessionId) return
          const active = document.activeElement
          if (!panelRef.current || !panelRef.current.contains(active)) triggerRef.current = active
          loadSeqRef.current += 1
          trashSeqRef.current += 1
          detailReq.current += 1
          setTarget({ sessionId: d.sessionId, title: d.title || null, running: d.running === true })
          setOpen(true)
          setState('loading')
          setLoadError(null)
          setMessages([])
          setHits(null)
          setQuery('')
          setRole('all')
          setIncludeShadowed(false)
          setPicked(null)
          setDetail('')
          setDetailState('idle')
          setTab('messages')
          setTrash([])
          setTrashState('idle')
          setTrashError(null)
          setConfirmDelete(false)
          setConfirmTitle('')
          setDeleteError(null)
          setConfirmAction(null)
          setPurgeId(null)
          setChildId(null)
          setError(null)
          setDone('')
          setScrollTop(0)
        }
        window.addEventListener(EVENT, handler)
        return () => window.removeEventListener(EVENT, handler)
      }, [])

      const sid = target && target.sessionId

      const loadMessages = useCallback(
        async quiet => {
          if (!sid) return
          const requestId = ++loadSeqRef.current
          const requestSid = sid
          if (!quiet) {
            setState('loading')
            setLoadError(null)
          }
          try {
            const data = await fetchMessagesJson('/api/message-ops/messages?sessionId=' + encodeURIComponent(requestSid) + '&view=compact')
            if (requestId !== loadSeqRef.current) return
            setMessages(Array.isArray(data.messages) ? data.messages : [])
            setTarget(prev =>
              prev && prev.sessionId === requestSid
                ? {
                    ...prev,
                    running: data.running === true,
                    title: prev.title || (data.session && data.session.title) || null,
                    expectedTitle: (data.session && data.session.confirmTitle) || prev.expectedTitle || prev.title || prev.sessionId,
                  }
                : prev,
            )
            setLoadError(null)
            setError(null)
            setState('ready')
          } catch (reason) {
            if (requestId !== loadSeqRef.current) return
            const message = t('panel.loadFail') + (reason && reason.message ? reason.message : String(reason))
            if (quiet) setError(message)
            else {
              setLoadError(message)
              setState('error')
            }
          }
        },
        [sid, t],
      )

      useEffect(() => {
        if (!open || !sid) return
        loadMessages(false)
      }, [open, sid, loadMessages])

      useEffect(() => {
        if (!open || tab !== 'messages') return
        const q = query.trim()
        if (!q) {
          setHits(null)
          setSearching(false)
          return
        }
        setSearching(true)
        let cancelled = false
        const timer = setTimeout(() => {
          setError(null)
          const url =
            '/api/message-ops/search?sessionId=' +
            encodeURIComponent(sid) +
            '&q=' +
            encodeURIComponent(q) +
            (role !== 'all' ? '&role=' + encodeURIComponent(role) : '') +
            '&limit=' +
            PANEL_SEARCH_LIMIT
          fetch(url)
            .then(res =>
              res
                .json()
                .catch(() => null)
                .then(data => ({ res, data })),
            )
            .then(({ res, data }) => {
              if (cancelled) return
              if (!res.ok || !data || data.ok !== true) throw new Error((data && data.error) || 'HTTP ' + res.status)
              setHits(Array.isArray(data.results) ? data.results : [])
              setError(null)
            })
            .catch(reason => {
              if (!cancelled) setError(t('panel.searchFail') + (reason && reason.message ? reason.message : String(reason)))
            })
            .finally(() => {
              if (!cancelled) setSearching(false)
            })
        }, 200)
        return () => {
          cancelled = true
          clearTimeout(timer)
        }
      }, [open, tab, sid, query, role, t])

      const loadTrash = useCallback(async () => {
        const requestId = ++trashSeqRef.current
        setTrashState('loading')
        setTrashError(null)
        try {
          const res = await fetch('/api/message-ops/session/trash')
          const data = await res.json().catch(() => null)
          if (requestId !== trashSeqRef.current) return
          if (!res.ok || !data || data.ok !== true) throw new Error((data && data.error) || 'HTTP ' + res.status)
          setTrash(Array.isArray(data.entries) ? data.entries : [])
          setTrashError(null)
          setTrashState('ready')
        } catch (reason) {
          if (requestId !== trashSeqRef.current) return
          setTrashError(t('panel.loadFail') + (reason && reason.message ? reason.message : String(reason)))
          setTrashState('error')
        }
      }, [t])

      useEffect(() => {
        if (open && tab === 'trash') loadTrash()
      }, [open, tab, loadTrash])

      const close = useCallback(() => {
        if (busy) return
        loadSeqRef.current += 1
        trashSeqRef.current += 1
        detailReq.current += 1
        setOpen(false)
        setTarget(null)
        setPicked(null)
        setConfirmDelete(false)
        setConfirmAction(null)
        setDeleteError(null)
        setLoadError(null)
        setTrashError(null)
      }, [busy])

      const closeConfirm = useCallback(() => {
        if (busy === 'session-delete') return
        setConfirmDelete(false)
        setConfirmTitle('')
        setDeleteError(null)
        setTimeout(() => {
          const el = deleteBtnRef.current
          if (el && !el.disabled) el.focus()
          else if (panelRef.current) panelRef.current.focus()
        }, 0)
      }, [busy])

      const cancelAction = useCallback(() => {
        if (busy) return
        const mode = confirmAction
        setConfirmAction(null)
        setTimeout(() => {
          const targetRef = mode === 'revert' ? revertBtnRef.current : deleteOneBtnRef.current
          if (targetRef && !targetRef.disabled) targetRef.focus()
          else if (panelRef.current) panelRef.current.focus()
        }, 0)
      }, [busy, confirmAction])

      useEffect(() => {
        if (!open) return undefined
        const onKey = e => {
          if (e.key === 'Escape') {
            if (busy) return
            if (confirmDelete) closeConfirm()
            else if (confirmAction) cancelAction()
            else close()
          } else if (e.key === '/') {
            if (confirmDelete || confirmAction) return
            const el = e.target
            const tag = el && el.tagName
            if (el && (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable)) return
            e.preventDefault()
            if (searchRef.current) searchRef.current.focus()
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open, busy, confirmDelete, confirmAction, close, closeConfirm, cancelAction])

      useEffect(() => {
        if (!open) return undefined
        if (!triggerRef.current) triggerRef.current = document.activeElement
        const timer = setTimeout(() => {
          if (searchRef.current) searchRef.current.focus()
          else if (panelRef.current) panelRef.current.focus()
        }, 0)
        const scrim = scrimRef.current
        const hidden = []
        // 0.11.8：槽位会把 scrim 挂进一个**只有 scrim 自己**的独立容器，
        // 于是「遍历 parent.children」永远遍历不到真实背景 —— inert 形同虚设
        // （实测：inert=false，Tab 能跑到背后的会话列表，读屏也读得到）。
        // 正确做法是从宿主挂载点（body 直接子节点）出发，把**包含 scrim 的那条
        // 祖先链之外**的兄弟节点全部隔离；祖先链本身不能 inert（会连面板一起废掉）。
        if (scrim && document.body) {
          const chain = new Set()
          for (let el = scrim; el && el !== document.body; el = el.parentElement) chain.add(el)
          for (const child of Array.from(document.body.children)) {
            if (chain.has(child)) continue
            if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE' || child.tagName === 'LINK') continue
            hidden.push({ child, inert: child.hasAttribute('inert'), aria: child.getAttribute('aria-hidden') })
            child.setAttribute('inert', '')
            child.setAttribute('aria-hidden', 'true')
          }
          // 祖先链上的每一层：把**除当前链节点以外**的兄弟也隔离掉。
          // 典型结构 body > #root > ... > 槽位容器 > scrim，中途每层都可能带界面。
          for (const el of chain) {
            const parent = el.parentElement
            if (!parent || parent === document.body) continue
            for (const sib of Array.from(parent.children)) {
              if (sib === el || chain.has(sib)) continue
              if (sib.tagName === 'SCRIPT' || sib.tagName === 'STYLE' || sib.tagName === 'LINK') continue
              hidden.push({ child: sib, inert: sib.hasAttribute('inert'), aria: sib.getAttribute('aria-hidden') })
              sib.setAttribute('inert', '')
              sib.setAttribute('aria-hidden', 'true')
            }
          }
        }
        // 居中模态必须锁背景滚动：否则滚轮/触屏拖拽会把背后的会话列表滚走，
        // 关闭后视口停在别处。用 overflow:hidden 而非 position:fixed，
        // 后者会丢失滚动位置。保留原有内联值以便精确还原。
        const body = document.body
        const prevOverflow = body && body.style ? body.style.overflow : ''
        const prevPaddingRight = body && body.style ? body.style.paddingRight : ''
        let scrollbarW = 0
        try {
          scrollbarW = window.innerWidth - document.documentElement.clientWidth
        } catch {
          /* non-browser */
        }
        if (body && body.style) {
          body.style.overflow = 'hidden'
          // 为被隐藏的经典滚动条补回等宽内边距，避免整页横向跳动。
          if (scrollbarW > 0) {
            const base = Number.parseFloat(getComputedStyle(body).paddingRight) || 0
            body.style.paddingRight = base + scrollbarW + 'px'
          }
        }
        return () => {
          clearTimeout(timer)
          for (const item of hidden) {
            if (!item.inert) item.child.removeAttribute('inert')
            if (item.aria === null) item.child.removeAttribute('aria-hidden')
            else item.child.setAttribute('aria-hidden', item.aria)
          }
          if (body && body.style) {
            body.style.overflow = prevOverflow
            body.style.paddingRight = prevPaddingRight
          }
          if (openRef.current) return
          const trigger = triggerRef.current
          triggerRef.current = null
          if (trigger && typeof trigger.focus === 'function') {
            setTimeout(() => {
              try {
                trigger.focus()
              } catch {
                /* detached trigger */
              }
            }, 0)
          }
        }
      }, [open, sid])

      useEffect(() => {
        if (!open) return undefined
        const onKeyDown = e => {
          if (e.key !== 'Tab') return
          const scope = confirmDelete ? confirmRef.current : confirmAction ? actionConfirmRef.current : panelRef.current
          if (!scope) return
          const nodes = focusablesIn(scope)
          if (!nodes.length) {
            e.preventDefault()
            scope.focus()
            return
          }
          const first = nodes[0]
          const last = nodes[nodes.length - 1]
          const active = document.activeElement
          if (active === scope || !scope.contains(active)) {
            e.preventDefault()
            const fallback = e.shiftKey ? last : first
            fallback.focus()
          } else if (e.shiftKey && active === first) {
            e.preventDefault()
            last.focus()
          } else if (!e.shiftKey && active === last) {
            e.preventDefault()
            first.focus()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [open, confirmDelete, confirmAction])

      useEffect(() => {
        if (!open) return
        if (confirmDelete) {
          const input = confirmRef.current && confirmRef.current.querySelector('input')
          if (input) input.focus()
        } else if (confirmAction) {
          const first = actionConfirmRef.current && actionConfirmRef.current.querySelector('button')
          if (first) first.focus()
        }
      }, [open, confirmDelete, confirmAction])

      const baseRows = query.trim() ? hits || [] : messages
      const rows = baseRows
        .filter(m => m && m.role !== 'system' && (role === 'all' || m.role === role) && (includeShadowed || !m.shadowed))
        .sort((a, b) => b.seq - a.seq)
      const activeIndex = picked ? rows.findIndex(m => m.seq === picked.seq) : -1

      const clearPick = () => {
        detailReq.current += 1
        setPicked(null)
        setDetail('')
        setDetailState('idle')
        setConfirmAction(null)
      }

      const previewRow = m => {
        if (!m) return
        detailReq.current += 1
        setPicked(m)
        setDetail(m.snippet || '')
        setDetailState('ready')
        setConfirmAction(null)
        setDone('')
      }

      const scrollRowIntoView = index => {
        const el = listRef.current
        if (!el) return
        const top = index * PANEL_ROW_H
        const view = el.clientHeight || viewport
        let next = el.scrollTop
        if (top < next) next = top
        else if (top + PANEL_ROW_H > next + view) next = top + PANEL_ROW_H - view
        if (next !== el.scrollTop) {
          el.scrollTop = next
          setScrollTop(next)
        }
      }

      const handleListKeyDown = e => {
        if (!rows.length) return
        const page = Math.max(1, Math.floor(((listRef.current && listRef.current.clientHeight) || viewport) / PANEL_ROW_H) - 1)
        let next = activeIndex
        if (e.key === 'ArrowDown') next = activeIndex < 0 ? 0 : Math.min(rows.length - 1, activeIndex + 1)
        else if (e.key === 'ArrowUp') next = activeIndex < 0 ? rows.length - 1 : Math.max(0, activeIndex - 1)
        else if (e.key === 'Home') next = 0
        else if (e.key === 'End') next = rows.length - 1
        else if (e.key === 'PageDown') next = activeIndex < 0 ? 0 : Math.min(rows.length - 1, activeIndex + page)
        else if (e.key === 'PageUp') next = activeIndex < 0 ? rows.length - 1 : Math.max(0, activeIndex - page)
        else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          const row = rows[activeIndex >= 0 ? activeIndex : 0]
          if (row) {
            pick(row)
            if (listRef.current) listRef.current.focus()
          }
          return
        } else {
          return
        }
        e.preventDefault()
        const row = rows[next]
        if (!row) return
        previewRow(row)
        scrollRowIntoView(next)
      }

      useEffect(() => {
        if (!open || tab !== 'messages') return undefined
        const el = listRef.current
        if (!el) return undefined
        const measure = () => setViewport(el.clientHeight || 480)
        measure()
        if (typeof ResizeObserver === 'undefined') return undefined
        const ro = new ResizeObserver(measure)
        ro.observe(el)
        return () => ro.disconnect()
      }, [open, tab, rows.length])

      useEffect(() => {
        if (!open || tab !== 'messages') return
        const el = listRef.current
        if (!el) return
        const max = Math.max(0, rows.length * PANEL_ROW_H - (el.clientHeight || viewport))
        if (el.scrollTop > max) {
          el.scrollTop = max
          setScrollTop(max)
        }
      }, [open, tab, rows.length, viewport])

      const pick = useCallback(
        m => {
          if (!m || busy) return
          setConfirmAction(null)
          setPicked(m)
          setDetail(m.snippet || '')
          setDetailState('loading')
          setDone('')
          const req = ++detailReq.current
          fetch('/api/message-ops/text?sessionId=' + encodeURIComponent(sid) + '&seq=' + encodeURIComponent(m.seq))
            .then(res =>
              res
                .json()
                .catch(() => null)
                .then(data => ({ res, data })),
            )
            .then(({ res, data }) => {
              if (req !== detailReq.current) return
              if (!res.ok || !data || data.ok !== true) throw new Error((data && data.error) || 'HTTP ' + res.status)
              const full = typeof data.text === 'string' && data.text !== '' ? data.text : null
              setDetail(full ?? (m.snippet || ''))
              setDetailState('ready')
            })
            .catch(() => {
              if (req !== detailReq.current) return
              setDetail(m.snippet || '') // 拉全文失败 → 只有截断的 snippet，不许冒充原文
              setDetailState('ready')
            })
        },
        [busy, sid],
      )

      const runAction = useCallback(
        async (mode, confirmed) => {
          if (!target || !picked || busy) return
          if (target.running && mode !== 'branch') return
          if ((mode === 'revert' || mode === 'delete') && confirmed !== true) return
          const actionSid = target.sessionId
          setBusy(mode)
          setError(null)
          setDone('')
          try {
            if (mode === 'branch') {
              // 0.12.0：分叉 = opencode 的 before 语义（新会话不含此条，原文回输入框）。
              // 非破坏操作，故不受 running 限制（官方 fork 会自己拒绝运行中源会话）。
              // 取文本用 `detail`（该条全文，pick 时已按 seq 拉好）；非用户消息不带文本。
              const pickedRole = picked && picked.role
              const created = await forkFromUserMessage(actionSid, picked.seq, pickedRole === 'user' ? detail : '', picked.turnStartSeq)
              if (sessionRef.current !== actionSid) return
              setChildId(created || null)
              setDone(t('panel.branchDone', { id: String(created || '') }))
              notifyDone(t('panel.branchDone', { id: String(created || '') }))
              return
            }
            const res = await fetch('/api/message-ops/' + mode, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId: target.sessionId, seq: picked.seq }),
            })
            const data = await res.json().catch(() => null)
            if (sessionRef.current !== actionSid) return
            if (!res.ok || !data || data.ok !== true) {
              if (res.status === 409) setTarget(prev => (prev ? { ...prev, running: true } : prev))
              throw new Error((data && data.error) || 'HTTP ' + res.status)
            }
            if (mode === 'revert') {
              setMessages(prev => prev.map(m => (m.seq >= picked.seq ? { ...m, shadowed: true, visible: false } : m)))
              if (picked.role === 'user') {
                try {
                  refillComposer(target.sessionId, picked.seq)
                } catch {
                  /* non-blocking */
                }
              }
            } else {
              setMessages(prev => prev.map(m => (m.seq === picked.seq ? { ...m, shadowed: true, visible: false } : m)))
            }
            const msg = t(mode === 'revert' ? 'panel.revertDone' : 'panel.deleteDone')
            setDone(msg)
            setConfirmAction(null)
            setTimeout(() => {
              if (listRef.current) listRef.current.focus()
            }, 0)
            notifyDone(msg)
            emitChanged()
            try {
              if (__uiWorkspace && typeof __uiWorkspace.openSession === 'function') __uiWorkspace.openSession(target.sessionId)
            } catch {
              /* view rebuild is best effort */
            }
            setTimeout(() => {
              loadMessages(true).catch(() => {})
            }, 650)
          } catch (reason) {
            if (sessionRef.current !== actionSid) return
            setError(t('errorPrefix') + (reason && reason.message ? reason.message : String(reason)))
          } finally {
            setBusy('')
          }
        },
        [target, picked, busy, t, loadMessages],
      )

      const deleteSession = useCallback(async () => {
        if (!target || busy || target.running) return
        const expected = target.expectedTitle || ''
        if (!expected || confirmTitle.trim() !== expected) return
        const actionSid = target.sessionId
        setBusy('session-delete')
        setDeleteError(null)
        setDone('')
        try {
          const res = await fetch('/api/message-ops/session/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: target.sessionId, confirmTitle: confirmTitle }),
          })
          const data = await res.json().catch(() => null)
          if (sessionRef.current !== actionSid) return
          if (!res.ok || !data || data.ok !== true) {
            if (res.status === 409) setTarget(prev => (prev ? { ...prev, running: true } : prev))
            throw new Error((data && data.error) || 'HTTP ' + res.status)
          }
          setConfirmDelete(false)
          setDone(t('panel.deleted'))
          notifyDone(t('panel.deleted'))
          emitChanged()
          setTimeout(() => {
            try {
              window.location.reload()
            } catch {
              /* non-browser guard */
            }
          }, 700)
        } catch (reason) {
          if (sessionRef.current !== actionSid) return
          setDeleteError(t('errorPrefix') + (reason && reason.message ? reason.message : String(reason)))
        } finally {
          setBusy('')
        }
      }, [target, busy, confirmTitle, t])

      const restoreEntry = useCallback(
        async trashId => {
          if (busy) return
          setBusy('restore:' + trashId)
          setError(null)
          setDone('')
          try {
            const res = await fetch('/api/message-ops/session/restore', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ trashId }),
            })
            const data = await res.json().catch(() => null)
            if (!res.ok || !data || data.ok !== true) throw new Error((data && data.error) || 'HTTP ' + res.status)
            setTrash(prev => prev.filter(x => x.trashId !== trashId))
            setDone(t('panel.restored'))
            notifyDone(t('panel.restored'))
            emitChanged()
            setTimeout(() => {
              try {
                window.location.reload()
              } catch {
                /* non-browser guard */
              }
            }, 700)
          } catch (reason) {
            setError(t('errorPrefix') + (reason && reason.message ? reason.message : String(reason)))
          } finally {
            setBusy('')
          }
        },
        [busy, t],
      )

      const purgeEntry = useCallback(
        async trashId => {
          if (busy) return
          if (purgeId !== trashId) {
            setPurgeId(trashId)
            return
          }
          setBusy('purge:' + trashId)
          setError(null)
          setDone('')
          try {
            const res = await fetch('/api/message-ops/session/purge', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ trashId }),
            })
            const data = await res.json().catch(() => null)
            if (!res.ok || !data || data.ok !== true) throw new Error((data && data.error) || 'HTTP ' + res.status)
            setTrash(prev => prev.filter(x => x.trashId !== trashId))
            setPurgeId(null)
            setDone(t('panel.purged'))
            notifyDone(t('panel.purged'))
          } catch (reason) {
            setError(t('errorPrefix') + (reason && reason.message ? reason.message : String(reason)))
          } finally {
            setBusy('')
          }
        },
        [busy, purgeId, t],
      )

      if (!open) return null

      const pickedLive = picked ? messages.find(m => m.seq === picked.seq) || picked : null
      const canAct = !busy && !target.running && pickedLive && !pickedLive.shadowed
      const visibleCount = messages.filter(m => m.role !== 'system' && m.visible && !m.shadowed).length
      const shadowedCount = messages.filter(m => m.role !== 'system' && m.shadowed).length
      const totalCount = messages.filter(m => m.role !== 'system').length
      const revertImpact = pickedLive ? messages.filter(m => m.role !== 'system' && !m.shadowed && m.seq >= pickedLive.seq) : []
      const revertCount = revertImpact.length
      const revertVisibleCount = revertImpact.filter(m => m.visible).length
      const revertEnd = revertImpact.reduce((max, m) => Math.max(max, m.seq), pickedLive ? pickedLive.seq : 0)
      const expectedDeleteTitle = target.expectedTitle || ''
      // 0.12.0：分叉/编辑只对**用户消息**成立（与 opencode 一致：fork 的语义是
      // 「这句话说错了，拿回去重说」，AI 消息没有可回填的原文）。
      const pickedIsUser = !!pickedLive && pickedLive.role === 'user'
      const canFork = !busy && !target.running && pickedIsUser && !pickedLive.shadowed && pickedLive.seq > 0
      // MED-5：只有**真拉到全文**才允许编辑。detail 在 /text 失败时会退化成
      // snippet，而 snippet 被服务端硬截断到 160 字（session-file.js:331）——
      // 拿它冒充原文会让用户改完发出时静默丢掉后半段。
      const deleteBlockedReason = target.running
        ? t('panel.running')
        : state !== 'ready'
          ? state === 'error'
            ? t('panel.loadFail')
            : t('panel.loading')
          : !expectedDeleteTitle
            ? t('panel.deleteUnavailable')
            : ''
      const canConfirmDelete =
        !busy && state === 'ready' && !target.running && !!expectedDeleteTitle && confirmTitle.trim() === expectedDeleteTitle
      const start = Math.min(Math.max(0, rows.length - 1), Math.max(0, Math.floor(scrollTop / PANEL_ROW_H) - 6))
      const end = Math.min(rows.length, start + Math.ceil(viewport / PANEL_ROW_H) + 12)
      const windowRows = rows.slice(start, end)
      const activeRendered = picked && windowRows.some(m => m.seq === picked.seq)
      const showSearchLoading = searching && query.trim().length > 0

      return React.createElement(
        'div',
        {
          className: 'mopsPanelScrim',
          role: 'presentation',
          ref: scrimRef,
          onMouseDown: e => {
            if (e.target === e.currentTarget) close()
          },
        },
        React.createElement(
          'section',
          {
            className: 'mopsPanel',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'mops-panel-title',
            'aria-describedby': 'mops-panel-session',
            'aria-busy': busy || state === 'loading' ? 'true' : undefined,
            tabIndex: -1,
            ref: panelRef,
            style: { position: 'relative' },
          },
          React.createElement(
            'header',
            { className: 'mopsPanelHead' },
            React.createElement(
              'div',
              { style: { minWidth: 0 } },
              React.createElement('div', { className: 'mopsPanelKicker' }, t('dialog.title')),
              React.createElement(
                'div',
                { className: 'mopsPanelTitle', id: 'mops-panel-title' },
                target.title || target.expectedTitle || target.sessionId,
              ),
              React.createElement('div', { className: 'mopsPanelSub', id: 'mops-panel-session' }, target.sessionId),
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'mopsPanelClose',
                title: t('dialog.cancel'),
                'aria-label': t('dialog.cancel'),
                onClick: close,
                disabled: !!busy,
              },
              '×',
            ),
          ),
          React.createElement(
            'div',
            { className: 'mopsTabs' },
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'mopsTab' + (tab === 'messages' ? ' on' : ''),
                onClick: () => {
                  setTab('messages')
                  setConfirmDelete(false)
                  setConfirmAction(null)
                  setDeleteError(null)
                },
              },
              t('panel.messages') + ' ' + totalCount,
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'mopsTab' + (tab === 'trash' ? ' on' : ''),
                onClick: () => {
                  setTab('trash')
                  setConfirmDelete(false)
                  setConfirmAction(null)
                  setDeleteError(null)
                },
              },
              t('panel.trash') + (trash.length ? ' ' + trash.length : ''),
            ),
          ),
          target.running && tab === 'messages' ? React.createElement('div', { className: 'mopsBanner warn' }, t('panel.running')) : null,
          error ? React.createElement('div', { className: 'mopsBanner err', role: 'alert' }, error) : null,
          done
            ? React.createElement(
                'div',
                { className: 'mopsBanner ok' },
                done,
                childId
                  ? React.createElement(
                      'button',
                      {
                        type: 'button',
                        className: 'mopsAction primary',
                        style: { marginLeft: 10 },
                        onClick: () => {
                          try {
                            if (__uiWorkspace && typeof __uiWorkspace.openSession === 'function') __uiWorkspace.openSession(childId)
                          } catch {
                            /* best effort */
                          }
                        },
                      },
                      t('panel.openNew'),
                    )
                  : null,
              )
            : null,
          tab === 'messages'
            ? React.createElement(
                React.Fragment,
                null,
                React.createElement(
                  'div',
                  { className: 'mopsSearchRow' },
                  React.createElement('input', {
                    ref: searchRef,
                    className: 'mopsSearch',
                    value: query,
                    placeholder: t('panel.searchHint'),
                    'aria-label': t('panel.search'),
                    onChange: e => {
                      setQuery(e.target.value)
                      clearPick()
                      setScrollTop(0)
                      if (listRef.current) listRef.current.scrollTop = 0
                    },
                  }),
                ),
                React.createElement(
                  'div',
                  { className: 'mopsChips' },
                  ['all', 'user', 'assistant', 'tool'].map(key =>
                    React.createElement(
                      'button',
                      {
                        key,
                        type: 'button',
                        className: 'mopsChip' + (role === key ? ' on' : ''),
                        onClick: () => {
                          setRole(key)
                          clearPick()
                          setScrollTop(0)
                          if (listRef.current) listRef.current.scrollTop = 0
                        },
                      },
                      t('panel.' + key),
                    ),
                  ),
                  React.createElement(
                    'label',
                    { className: 'mopsToggle' },
                    React.createElement('input', {
                      type: 'checkbox',
                      checked: includeShadowed,
                      onChange: e => {
                        setIncludeShadowed(e.target.checked)
                        clearPick()
                        setScrollTop(0)
                        if (listRef.current) listRef.current.scrollTop = 0
                      },
                    }),
                    t('panel.includeShadowed'),
                  ),
                ),
                React.createElement(
                  'div',
                  {
                    className: 'mopsList',
                    ref: listRef,
                    role: state === 'ready' && rows.length ? 'listbox' : 'region',
                    tabIndex: state === 'ready' && rows.length ? 0 : -1,
                    'aria-label': t('panel.messages'),
                    'aria-busy': state === 'loading' || showSearchLoading ? 'true' : undefined,
                    'aria-activedescendant': state === 'ready' && activeRendered ? 'mops-opt-' + picked.seq : undefined,
                    onKeyDown: handleListKeyDown,
                    onScroll: e => setScrollTop(e.currentTarget.scrollTop),
                  },
                  state === 'loading' || state === 'idle'
                    ? React.createElement('div', { className: 'mopsEmpty', role: 'status', 'aria-live': 'polite' }, t('panel.loading'))
                    : state === 'error'
                      ? React.createElement(
                          'div',
                          { className: 'mopsEmpty mopsErrorState', role: 'alert' },
                          React.createElement('span', null, loadError || t('panel.loadFail')),
                          React.createElement(
                            'button',
                            {
                              type: 'button',
                              className: 'mopsAction',
                              onClick: () => {
                                loadMessages(false)
                                setTimeout(() => {
                                  if (searchRef.current) searchRef.current.focus()
                                }, 0)
                              },
                            },
                            t('panel.retry'),
                          ),
                        )
                      : rows.length === 0
                        ? React.createElement(
                            'div',
                            { className: 'mopsEmpty', role: 'status', 'aria-live': 'polite' },
                            showSearchLoading ? t('panel.searching') : query.trim() ? t('panel.noMatch') : t('panel.empty'),
                          )
                        : React.createElement(
                            'div',
                            { style: { height: rows.length * PANEL_ROW_H, position: 'relative' } },
                            windowRows.map((m, i) =>
                              React.createElement(
                                'div',
                                {
                                  key: m.seq,
                                  id: 'mops-opt-' + m.seq,
                                  role: 'option',
                                  'aria-selected': pickedLive && pickedLive.seq === m.seq,
                                  'aria-setsize': rows.length,
                                  'aria-posinset': start + i + 1,
                                  tabIndex: -1,
                                  className:
                                    'mopsRow' + (pickedLive && pickedLive.seq === m.seq ? ' on' : '') + (m.shadowed ? ' shadowed' : ''),
                                  style: { top: (start + i) * PANEL_ROW_H, height: PANEL_ROW_H },
                                  onClick: () => {
                                    pick(m)
                                    if (listRef.current) listRef.current.focus()
                                  },
                                  title: '#' + m.seq + ' ' + (m.role || '') + ' · ' + (m.snippet || ''),
                                  'aria-label':
                                    '#' +
                                    m.seq +
                                    ' ' +
                                    (m.role || '') +
                                    (m.shadowed ? ' ' + t('panel.shadowed') : '') +
                                    ' · ' +
                                    (m.snippet || '') +
                                    (m.time ? ' · ' + fmtClock(m.time) : ''),
                                },
                                React.createElement('span', { className: 'mopsSeq' }, '#' + m.seq),
                                React.createElement('span', { className: 'mopsRole' }, roleCode(m.role)),
                                React.createElement('span', { className: 'mopsSnippet' }, m.snippet || '—'),
                                React.createElement('span', { className: 'mopsClock' }, fmtClock(m.time)),
                              ),
                            ),
                          ),
                ),
                React.createElement(
                  'div',
                  { className: 'mopsDetail' },
                  pickedLive
                    ? React.createElement(
                        React.Fragment,
                        null,
                        React.createElement(
                          'div',
                          { className: 'mopsDetailMeta' },
                          React.createElement('span', null, '#' + pickedLive.seq),
                          React.createElement('span', null, pickedLive.role || ''),
                          pickedLive.shadowed ? React.createElement('span', null, t('panel.shadowed')) : null,
                          pickedLive.time ? React.createElement('span', null, fmtClock(pickedLive.time)) : null,
                        ),
                        React.createElement(
                          'pre',
                          { className: 'mopsDetailText' },
                          detailState === 'loading' ? t('panel.detailLoading') : detail || pickedLive.snippet || '—',
                        ),
                        React.createElement(
                          'div',
                          { className: 'mopsActions' },
                          React.createElement(
                            'button',
                            {
                              type: 'button',
                              className: 'mopsAction primary',
                              disabled: !canAct || !!confirmAction,
                              ref: revertBtnRef,
                              onClick: () => setConfirmAction('revert'),
                              title: t('panel.revertHint'),
                            },
                            t('panel.revert') + (revertCount ? ' · ' + revertCount : ''),
                          ),
                          React.createElement(
                            'button',
                            {
                              type: 'button',
                              className: 'mopsAction danger',
                              disabled: !canAct || !!confirmAction,
                              ref: deleteOneBtnRef,
                              onClick: () => setConfirmAction('delete'),
                              title: t('panel.deleteHint'),
                            },
                            t('panel.delete'),
                          ),
                          // 分叉同样只对用户消息可用（AI 消息没有可回填的原文），
                          // 语义 = opencode 的 before：新会话不含此条，原文进新会话输入框。
                          React.createElement(
                            'button',
                            {
                              type: 'button',
                              className: 'mopsAction',
                              disabled: !canFork || !!confirmAction,
                              onClick: () => runAction('branch'),
                              title: pickedIsUser ? t('panel.branchHint') : t('panel.branchUserOnly'),
                            },
                            t('panel.branch'),
                          ),
                        ),
                        confirmAction
                          ? React.createElement(
                              'div',
                              {
                                className: 'mopsActionConfirm',
                                ref: actionConfirmRef,
                                role: 'group',
                                tabIndex: -1,
                                'aria-labelledby': 'mops-action-confirm-title',
                              },
                              React.createElement(
                                'div',
                                { className: 'mopsImpactTitle', id: 'mops-action-confirm-title' },
                                t(confirmAction === 'revert' ? 'panel.revertConfirmTitle' : 'panel.deleteConfirmTitle', {
                                  seq: String(pickedLive.seq),
                                }),
                              ),
                              React.createElement(
                                'div',
                                { className: 'mopsImpact' },
                                confirmAction === 'revert'
                                  ? t('panel.revertConfirmBody', {
                                      start: String(pickedLive.seq),
                                      end: String(revertEnd),
                                      n: String(revertCount),
                                      v: String(revertVisibleCount),
                                    })
                                  : t('panel.deleteConfirmBody'),
                              ),
                              React.createElement(
                                'div',
                                { className: 'mopsConfirmRow' },
                                React.createElement(
                                  'button',
                                  {
                                    type: 'button',
                                    className: 'mopsAction',
                                    onClick: cancelAction,
                                    disabled: !!busy,
                                  },
                                  t('panel.cancel'),
                                ),
                                React.createElement(
                                  'button',
                                  {
                                    type: 'button',
                                    className: 'mopsAction danger',
                                    onClick: () => runAction(confirmAction, true),
                                    disabled: !!busy || !canAct,
                                  },
                                  busy === confirmAction
                                    ? t('panel.busy')
                                    : t(confirmAction === 'revert' ? 'panel.confirmRevert' : 'panel.confirmDeleteOne'),
                                ),
                              ),
                            )
                          : null,
                      )
                    : React.createElement('div', { className: 'mopsDetailHint' }, t('panel.selectHint')),
                ),
                React.createElement(
                  'footer',
                  { className: 'mopsPanelFoot' },
                  React.createElement(
                    'span',
                    { className: 'mopsCount' },
                    t('panel.count', { n: String(totalCount), v: String(visibleCount), s: String(shadowedCount) }),
                  ),
                  React.createElement(
                    'button',
                    {
                      type: 'button',
                      className: 'mopsDanger',
                      ref: deleteBtnRef,
                      disabled: !!busy || !!deleteBlockedReason,
                      title: deleteBlockedReason || undefined,
                      onClick: () => {
                        setConfirmTitle('')
                        setDeleteError(null)
                        setConfirmAction(null)
                        setConfirmDelete(true)
                      },
                    },
                    t('panel.deleteSession'),
                  ),
                ),
                confirmDelete
                  ? React.createElement(
                      'div',
                      {
                        className: 'mopsConfirm',
                        ref: confirmRef,
                        role: 'alertdialog',
                        'aria-modal': 'true',
                        'aria-labelledby': 'mops-delete-title',
                        'aria-describedby': 'mops-delete-hint mops-delete-impact',
                        tabIndex: -1,
                      },
                      React.createElement('h3', { id: 'mops-delete-title' }, t('panel.deleteSession')),
                      React.createElement('p', { id: 'mops-delete-hint' }, t('panel.deleteSessionHint')),
                      React.createElement(
                        'p',
                        { className: 'mopsImpact', id: 'mops-delete-impact' },
                        t('panel.deleteSessionImpact', { n: String(totalCount) }),
                      ),
                      target.running
                        ? React.createElement('div', { className: 'mopsBanner warn', role: 'status' }, t('panel.running'))
                        : null,
                      deleteError ? React.createElement('div', { className: 'mopsBanner err', role: 'alert' }, deleteError) : null,
                      React.createElement('input', {
                        id: 'mops-delete-title-input',
                        value: confirmTitle,
                        autoFocus: true,
                        'aria-label': t('panel.deleteSessionHint'),
                        'aria-describedby': 'mops-delete-hint',
                        placeholder: expectedDeleteTitle || target.title || target.sessionId,
                        disabled: !!busy || target.running || !expectedDeleteTitle,
                        onChange: e => setConfirmTitle(e.target.value),
                        onKeyDown: e => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            if (canConfirmDelete) deleteSession()
                          } else if (e.key === 'Escape') {
                            e.preventDefault()
                            e.stopPropagation()
                            closeConfirm()
                          }
                        },
                      }),
                      React.createElement(
                        'div',
                        { className: 'mopsConfirmRow' },
                        React.createElement(
                          'button',
                          {
                            type: 'button',
                            className: 'mopsAction',
                            onClick: closeConfirm,
                            disabled: busy === 'session-delete',
                          },
                          t('panel.cancel'),
                        ),
                        React.createElement(
                          'button',
                          {
                            type: 'button',
                            className: 'mopsAction danger',
                            disabled: !canConfirmDelete,
                            onClick: deleteSession,
                          },
                          busy === 'session-delete' ? t('panel.deleting') : t('panel.confirmDelete'),
                        ),
                      ),
                    )
                  : null,
              )
            : React.createElement(
                'div',
                { className: 'mopsList', style: { borderTop: 0 }, 'aria-busy': trashState === 'loading' ? 'true' : undefined },
                trashState === 'loading' || trashState === 'idle'
                  ? React.createElement('div', { className: 'mopsEmpty', role: 'status', 'aria-live': 'polite' }, t('panel.loading'))
                  : trashState === 'error'
                    ? React.createElement(
                        'div',
                        { className: 'mopsEmpty mopsErrorState', role: 'alert' },
                        React.createElement('span', null, trashError || t('panel.loadFail')),
                        React.createElement(
                          'button',
                          {
                            type: 'button',
                            className: 'mopsAction',
                            onClick: () => {
                              loadTrash()
                              setTimeout(() => {
                                if (panelRef.current) panelRef.current.focus()
                              }, 0)
                            },
                          },
                          t('panel.retry'),
                        ),
                      )
                    : trash.length === 0
                      ? React.createElement('div', { className: 'mopsEmpty' }, t('panel.trashEmpty'))
                      : trash.map(item =>
                          React.createElement(
                            'div',
                            { className: 'mopsTrashItem', key: item.trashId },
                            React.createElement(
                              'div',
                              { className: 'mopsTrashMain' },
                              React.createElement('div', { className: 'mopsTrashTitle' }, item.title || t('panel.untitled')),
                              React.createElement(
                                'div',
                                { className: 'mopsTrashMeta' },
                                item.sessionId +
                                  (item.expiresAt ? ' · ' + t('panel.expires') + ' ' + new Date(item.expiresAt).toLocaleDateString() : ''),
                              ),
                            ),
                            React.createElement(
                              'button',
                              {
                                type: 'button',
                                className: 'mopsAction',
                                disabled: !!busy,
                                onClick: () => restoreEntry(item.trashId),
                              },
                              busy === 'restore:' + item.trashId ? t('panel.busy') : t('panel.restore'),
                            ),
                            React.createElement(
                              'button',
                              {
                                type: 'button',
                                className: 'mopsAction danger',
                                disabled: !!busy,
                                onClick: () => purgeEntry(item.trashId),
                              },
                              busy === 'purge:' + item.trashId
                                ? t('panel.busy')
                                : purgeId === item.trashId
                                  ? t('panel.purgeConfirm')
                                  : t('panel.purge'),
                            ),
                          ),
                        ),
              ),
        ),
      )
    }

    // --- 头部按钮 ---------------------------------------------------------------

    // 0.3.0 分支双路径选择：0.2.0+ 官方 sessions.fork({atSeq}) 优先。
    function pickForkPath(sessionsSvc) {
      if (sessionsSvc && typeof sessionsSvc.fork === 'function') {
        return { kind: 'official', fork: sessionsSvc.fork.bind(sessionsSvc) }
      }
      return { kind: 'disk' }
    }

    // --- 0.12.0 消息级分叉（opencode 语义：分叉点**排他**，原文回到新会话输入框）-----
    //
    // 官方 `sessions.fork(source, boundary)` 的 boundary 是**闭区间**（含该事件）。
    // opencode 的 fork 是 before 语义（不含该条用户消息）+ 把该条放回新会话 composer。
    // 两者要一致，就必须把边界退到「该用户消息所在 turn 之前」。
    //
    // ⚠️ 不能退到 `seq - 1`。实测 40 份语料：真人输入的前一个事件**恒是同一 turn
    // 内的 system/message**（turn/start → agent/inbox/spliced → step/start →
    // system/message → user/message）。按 seq-1 切会得到一个「turn/step 已开、
    // 却没有任何 user 消息」的悬空前缀，引擎必须补合成 closers，语义也不是
    // 用户要的「这条之前」。
    // 正确边界 = 该 turn 的 turn/start seq 的**前一个**事件（`turnStartSeq - 1`）。
    // 服务端在 `GET /messages?view=compact` 里直接给出 `turnStartSeq`（见
    // src/index.js buildDerived），客户端不猜。
    const FORK_SESSION_STORAGE_PREFIX = 'dsh.conversation.'

    /**
     * 官方 fork 边界（inclusive）：目标用户消息所在 turn 的 turn/start 前一个事件。
     *
     * @param seq - 目标用户消息的日志 seq（仅用于无 turn 信息时的保守回退）
     * @param turnStartSeq - 该消息所在 turn 的 turn/start seq；服务端 compact 视图提供
     * @returns 可直接作为 `sessions.fork({ atSeq })` 的闭区间边界；不可分叉时 -1
     */
    function forkBoundaryBefore(seq, turnStartSeq) {
      // 首选：按轮切（服务端已给出 turnStartSeq）
      if (Number.isSafeInteger(turnStartSeq) && turnStartSeq > 0) return turnStartSeq - 1
      // 回退：没有 turn 信息（老服务端 / 合成行）时退一格。
      // 这时切点可能落在 turn 内部，官方会补合成 closers —— 结果仍可加载，
      // 只是前缀边界不如按轮切干净。宁可这样也不静默不分叉。
      return Number.isSafeInteger(seq) && seq > 0 ? seq - 1 : -1
    }

    /**
     * 官方 assistant turn-tail 的 branch 按钮识别（0.12.0）。
     *
     * 为什么不能靠 aria-label：官方文案有 8 种语言（zh/en/ja/es/fr/de/ru/pt），
     * 逐个匹配等于把 i18n 表抄进来。也不能靠 class：CSS Modules 会哈希前缀
     * （实测 0.2.0-rc.2 是 `xzv4MW_`，0.2.1 起变过）。
     *
     * ⚠️ 也不能靠 `<path d="…">`（0.12.0 的错误做法，0.13.1 修）：0.2.2-alpha.2 的
     * 图标已改为 **sprite 复用**，官方组件长这样（见已安装 app bundle 的工厂函数）：
     *
     *   <svg data-icon="dsw-icon-branch-outline-regular" aria-hidden="true">
     *     <use href="#dsw-icon-branch-outline-regular"/>
     *   </svg>
     *
     * DOM 里**根本没有 `<path>`**，`M13.0762…` 在整个已安装 dsh 里 0 次命中。
     * 唯一稳定的是 `data-icon` 的 id：`dsw-icon-${name}-${size}`（工厂 `Qv`），
     * name 来自 ui-primitives 的图标表，属契约级常量。
     *
     * 我们自己的分叉按钮也故意用同一图标，所以必须按 class 显式排除。
     *
     * @param btn - 候选按钮（任意元素；非 button 的宿主节点返回 false）
     * @returns 是否官方 branch 按钮
     */
    const HOST_BRANCH_ICON_ID = 'dsw-icon-branch-outline-regular'
    const HOST_BRANCH_CLASS = 'mopsUserFork'
    function isHostBranchButton(btn) {
      if (!btn || typeof btn.querySelector !== 'function') return false
      const cls = String((btn.classList && btn.classList.value) || btn.className || '')
      if (cls.split(/\s+/).includes(HOST_BRANCH_CLASS)) return false
      // 首选 sprite 形态：<svg data-icon="dsw-icon-branch-outline-regular">
      const svg = btn.querySelector('svg')
      if (svg && svg.getAttribute('data-icon') === HOST_BRANCH_ICON_ID) return true
      // 兼容旧宿主的内联 path 形态（0.2.0-rc.x）：仍接受官方几何前缀
      const path = btn.querySelector('svg path')
      const d = path ? path.getAttribute('d') || '' : ''
      return d.startsWith(HOST_BRANCH_D_PREFIX)
    }

    /** 旧宿主的内联 path 几何前缀（仅作兼容回退，不是主判据）。 */
    const HOST_BRANCH_D_PREFIX = 'M13.0762 1.37207'

    /**
     * 把文本预置成某个会话的草稿（新会话刚 fork 出来时输入框是空的）。
     *
     * 为什么直接写 localStorage 而不是 `inputActions.setDraft`：fork 出来的是一个**还没
     * 挂载**的会话，此刻 `inputActions` 仍绑定在源会话上；宿主挂载新会话时会用
     * `readConversationDraft(sessionId)` 从 localStorage 初始化编辑器。所以**先落盘再
     * openSession** 才是无竞态的路径（`{ draft: '<text>' }` 是宿主 `parseStoredDraft`
     * 支持的字符串形态，见 dsh-client-ui-conversation:4455-4456）。
     */
    function writeSessionDraft(childSessionId, text) {
      try {
        if (!childSessionId || typeof localStorage === 'undefined') return false
        const key = FORK_SESSION_STORAGE_PREFIX + childSessionId
        // ⚠️ 必须**合并**，不能整体覆盖：同一个键里宿主还存着 `view` /
        // `viewRequest` 等会话视图偏好（见 dsh-client-ui-conversation 的
        // readConversationView / persist）。0.12.0 只写 `{draft}` 时，
        // fork 出的子会话恰好还没有偏好所以没暴露；0.14.0 的回填写在**正在用
        // 的会话**上，直接覆盖会静默清掉用户的视图选择。
        let base = {}
        try {
          const raw = localStorage.getItem(key)
          if (raw != null) {
            const parsed = JSON.parse(raw)
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed
          }
        } catch {
          /* 旧值不可解析 → 当作空对象重写（总比抛错好） */
        }
        const next = { ...base, draft: String(text || '') }
        localStorage.setItem(key, JSON.stringify(next))
        return true
      } catch (e) {
        console.warn('[message-ops] writeSessionDraft failed:', e)
        return false
      }
    }

    /**
     * 读回某会话的已保存草稿文本（宿主同一存储键）。
     * @param sessionId - 会话 id
     * @returns 文本；存储里没有该会话、或格式不可解析时返回 null
     */
    function readSessionDraft(sessionId) {
      try {
        if (!sessionId || typeof localStorage === 'undefined') return null
        const raw = localStorage.getItem(FORK_SESSION_STORAGE_PREFIX + sessionId)
        if (raw == null) return null
        const parsed = JSON.parse(raw)
        const draft = parsed && typeof parsed === 'object' ? parsed.draft : undefined
        if (typeof draft === 'string') return draft
        if (draft && typeof draft === 'object' && typeof draft.text === 'string') return draft.text
        return null
      } catch {
        return null
      }
    }

    /** 打开会话（宿主唯一通道）。childId 需要 `session-` 前缀才不会抛 unknown session。 */
    function openSessionById(sessionId) {
      try {
        if (__uiWorkspace && typeof __uiWorkspace.openSession === 'function') {
          __uiWorkspace.openSession(sessionId)
          return true
        }
      } catch (e) {
        console.warn('[message-ops] openSession failed:', e)
      }
      return false
    }

    /**
     * 从一条**用户消息**分叉：复制到该条之前，并把该条原文放回新会话输入框。
     *
     * @param sessionId - 源会话 id（前缀写法都接受，官方 store 自己归一）。
     * @param seq - 目标用户消息的日志 seq。
     * @param text - 该条用户消息原文；缺省时新会话输入框留空。
     * @returns 新会话 id。
     * @throws 无官方 fork、seq 无前驱、或宿主拒绝（会话运行中）时抛出可展示的错误。
     */
    async function forkFromUserMessage(sessionId, seq, text, turnStartSeq) {
      const forkPath = pickForkPath(__sessionsSvc)
      if (forkPath.kind !== 'official') throw new Error(__t('slot.forkUnavailable'))
      const boundary = forkBoundaryBefore(seq, turnStartSeq)
      if (boundary < 0) throw new Error(__t('slot.forkUnavailable'))
      const childId = await forkPath.fork({ sessionId, atSeq: boundary, increaseTitle: true })
      if (childId && text) writeSessionDraft(childId, text)
      return childId
    }

    // 成功反馈统一出口：devkit 标准 toast 优先，无 devkit 时对话框内文案兜底。
    function notifyDone(msg, kind) {
      try {
        const dk = window.__dshDevkit
        if (dk && typeof dk.toast === 'function') dk.toast(msg, { kind: kind || 'ok' })
      } catch {
        /* toast 缺席不阻断成功反馈 */
      }
    }

    function OpsButton(props) {
      const { sessionId, useSessions } = props
      const t = (props && props.t) || __t
      useLocaleRevision()
      const sessions = useSessions ? useSessions(s => s) : undefined
      const summary = sessions && sessions.byId ? sessions.byId[sessionId] : undefined
      const running = summary ? summary.running === true : false

      const openDialog = useCallback(() => {
        window.dispatchEvent(
          new CustomEvent(EVENT, {
            detail: { sessionId, title: summary && summary.title ? summary.title : null, running },
          }),
        )
      }, [sessionId, summary, running])

      return React.createElement(
        'button',
        {
          type: 'button',
          title: t('button.title'),
          'aria-label': t('button.title'),
          style: btnStyle,
          onClick: openDialog,
        },
        React.createElement(OpsPanelIcon),
      )
    }

    var IconQuote = null
    try {
      const P2 = require('@deepseek-ai/dsh-client-ui-primitives')
      // 0.19.0：不再回退到 IconCopyOutlineRegular —— 宿主在 AI 消息下方本来就
      // 有一个 Copy 按钮，用复制图标做「引用」会变成两个一模一样的复制按钮。
      // 优先官方 chat 类图标；拿不到就用下面的引号几何（明确的引用语义）。
      IconQuote = P2 && P2.IconChatOutlineRegular
    } catch {
      /* fallback below */
    }
    if (!IconQuote)
      IconQuote = function QuoteFallback() {
        return React.createElement(
          'svg',
          { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, stroke: 'currentColor', strokeWidth: 1 },
          React.createElement('path', {
            d: 'M3 6.5A3.5 3.5 0 0 1 6.5 3H7v1.5h-.5A2 2 0 0 0 4.5 6.5V7H7v3.5H3V6.5ZM9 6.5A3.5 3.5 0 0 1 12.5 3H13v1.5h-.5A2 2 0 0 0 10.5 6.5V7H13v3.5H9V6.5Z',
          }),
        )
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
      const sessions = useSessions ? useSessions(s => s) : undefined
      const summary = sessions && sessions.byId ? sessions.byId[sessionId] : undefined
      const running = summary ? summary.running === true : false
      const [seq, setSeq] = React.useState(null)
      const [fullText, setFullText] = React.useState(null)
      const [busy, setBusy] = React.useState(null) // 'revert' | null（S11 双提交防护）
      // 0.9.7（P4）：索引被 dataSig 重建后要重跑解析，否则「新 AI 消息旁
      // 没有回撤/引用按钮」—— 已经挂载的槽位 effect 不会因缓存被换而重跑。
      const [idxRev, setIdxRev] = React.useState(0)
      React.useEffect(() => {
        const onIdx = () => setIdxRev(v => v + 1)
        window.addEventListener(SEQ_INDEX_EVENT, onIdx)
        return () => window.removeEventListener(SEQ_INDEX_EVENT, onIdx)
      }, [])
      React.useEffect(() => {
        if (!messageId || !sessionId) return
        let alive = true
        let retried = false
        const load = () => {
          const p = fetchMessagesJson('/api/message-ops/messages?sessionId=' + encodeURIComponent(sessionId)).then(data => {
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
          // 0.9.7：只在缓存里还是**我们这条** promise 时才删（syncSeqIndex 可能已换掉）
          p.catch(() => {
            if (__seqIndexCache.get(sessionId) === p) __seqIndexCache.delete(sessionId)
          })
          return p
        }
        const resolve = index => {
          if (!alive) return
          const hit = index && index.get(String(messageId))
          if (typeof hit === 'number') {
            setSeq(hit)
            return
          }
          // 0.9.7（P4）：索引里没有这个 messageId = 会话已增长（或索引过期）。
          // 旧实现这里**什么都不做**，`seq` 永远是 null → 组件 return null →
          // 按钮再也不渲染。现在失效并重拉一次（retried 保证不自旋）；
          // 复用 fetchMessagesJson 的 1s 合并窗口，连续上新不会打爆请求。
          if (retried) return
          retried = true
          __seqIndexCache.delete(sessionId)
          __fullTextCache.delete(sessionId)
          load()
            .then(resolve)
            .catch(() => {})
        }
        const cached = __seqIndexCache.get(sessionId)
        if (cached && typeof cached.then === 'function') cached.then(resolve).catch(() => {})
        else if (cached) resolve(cached)
        else
          load()
            .then(resolve)
            .catch(() => {})
        return () => {
          alive = false
        }
      }, [messageId, sessionId, idxRev])

      // 原文（引用用）：seq 解析后按需取全文
      React.useEffect(() => {
        if (seq == null || !sessionId) return
        let alive = true
        const cached = __fullTextCache.get(sessionId)
        const resolve = full => {
          if (!alive) return
          const hit = full && full.get(String(messageId))
          if (typeof hit === 'string') setFullText(hit)
        }
        if (cached && typeof cached.then === 'function') cached.then(resolve).catch(() => {})
        else if (cached) resolve(cached)
        return () => {
          alive = false
        }
      }, [seq, messageId, sessionId])

      // 0.5.0 回撤后的视图刷新：openSession(reveal) 重建会话视图 → 遮蔽立即呈现。
      // （宿主 live 投影只处理 compaction 类 replace，插件标记需要视图重建才可见。）
      const revealSession = () => {
        try {
          if (__uiWorkspace && typeof __uiWorkspace.openSession === 'function') {
            __uiWorkspace.openSession(sessionId)
            return true
          }
        } catch {
          /* fallthrough */
        }
        return false
      }

      // ── 0.18.0：引用改用官方 insertQuote（结构化 QuoteNode）──────────────────
      //
      // 旧实现（0.5.0）用 `captureInsertion` + `insertText` 手工拼 `> ` markdown：
      //
      //     text.split('\n').map(l => '> ' + l).join('\n') + '\n\n'
      //
      // 问题（用户实测反馈「这 UI 做的怎么这么诡异」）：
      //   1. **不是引用**，是一段普通 markdown 文本 —— 宿主不会渲染成引用块，
      //      也不会给删除按钮、不进结构化编辑语义；
      //   2. `captureInsertion` 返回的是**插入位置快照**，用户在菜单里点完到
      //      文本到达之间若改过草稿，位置就失效，文本会插到奇怪的地方；
      //   3. 手工拼的 `> ` 会和用户已有内容粘连（无空行分隔时）。
      //
      // 宿主其实提供了官方能力（dsh-client-ui-conversation:15369）：
      //     insertQuote: (text) => this.insertQuote(text)
      // 它内部走 `draftEditor.insertQuote(text, labels)` →
      // `$replaceDetectSpanWithNodes([$createQuoteNode(text, labels), Go(" ")])`
      // 即：在当前光标处插入一个**真正的 QuoteNode**（带 remove 标签、独立 undo），
      // 并自动补一个空格分隔。这才是"规范"的引用。
      /**
       * 0.19.0 引用：只引用「选中的一小段」，不再把整条 AI 消息塞进 composer。
       *
       * 用户原话：「这个引用为什么是直接把这个消息直接给我填进输入框，这什么情况？」
       * 根因：旧实现把 fullText / /text 接口返回的**整条全文**传给 insertQuote，
       * 于是 composer 里冒出一个几千字的巨大引用块，看起来就像"把消息整个塞进去"。
       *
       * 宿主官方 insertQuote 的语义是「引用一段选中文字」（QuoteNode +
       * QuotePreview 可视化 + 模型可见的 markdown blockquote），本就该用小段。
       *
       * 文本来源优先级：
       *   1. 用户在该消息内选中的文字（window.getSelection，限定消息节点内）
       *   2. 无选中 → 取整条但截断到 QUOTE_MAX_CHARS，并标注来源（seq / 角色）
       */
      const QUOTE_MAX_CHARS = 600
      const selectionInMessage = () => {
        try {
          const sel = window.getSelection && window.getSelection()
          if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
          const text = String(sel.toString() || '').replace(/\s+$/g, '')
          if (!text || text.length > QUOTE_MAX_CHARS * 2) return null
          // 只认落在消息节点内的选区，避免把别处选的文字当成这条消息的引用
          const anchor = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement)
          const root = anchor && anchor.closest && anchor.closest('[data-chat-node-key],[data-chat-flow-kind]')
          if (!root) return null
          return text.length > QUOTE_MAX_CHARS ? text.slice(0, QUOTE_MAX_CHARS) + '…' : text
        } catch {
          return null
        }
      }
      const runQuote = () => {
        const finish = ok => notifyDone(ok ? t('quote.done') : t('quote.unavailable'), ok ? 'ok' : 'warn')
        try {
          if (!inputActions || typeof inputActions.insertQuote !== 'function') {
            finish(false)
            return
          }
          const put = text => {
            if (typeof text !== 'string' || text.trim() === '') {
              finish(false)
              return
            }
            let ok = false
            try {
              ok = inputActions.insertQuote(text.replace(/\r\n?/g, '\n')) !== false
            } catch (e) {
              console.warn('[message-ops] insertQuote failed:', e)
              ok = false
            }
            finish(ok)
          }
          // ① 选中片段优先（结构化的小段引用，模型可见）
          const selected = selectionInMessage()
          if (selected != null) {
            put(selected)
            return
          }
          // ② 无选中：取整条但截断 + 标注来源，不再静默塞全文
          const withSource = full => {
            const clipped = full.length > QUOTE_MAX_CHARS ? full.slice(0, QUOTE_MAX_CHARS) + '…' : full
            return t('quote.sourcePrefix', { seq: String(seq) }) + '\n' + clipped
          }
          if (fullText != null && fullText !== '') {
            put(withSource(fullText))
            return
          }
          fetch('/api/message-ops/text?sessionId=' + encodeURIComponent(sessionId) + '&seq=' + encodeURIComponent(seq))
            .then(r => (r.ok ? r.json() : null))
            .then(d => put(d && d.ok && typeof d.text === 'string' ? withSource(d.text) : null))
            .catch(() => put(null))
        } catch (e) {
          notifyDone(t('errorPrefix') + (e && e.message ? e.message : String(e)), 'error')
        }
      }

      if (seq == null) return null
      const act = (icon, label, mode, onClick, disabled) =>
        React.createElement(
          'button',
          {
            type: 'button',
            title: running && mode === 'revert' ? t('dialog.runningWarn') : label,
            'aria-label': label,
            disabled: !!disabled,
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              minWidth: 44,
              minHeight: 44,
              padding: 0,
              border: 'none',
              background: 'transparent',
              color: 'inherit',
              opacity: busy && busy !== mode ? 0.4 : running && mode === 'revert' ? 0.35 : 0.72,
              cursor: disabled ? 'default' : 'pointer',
              borderRadius: 6,
            },
            onClick,
          },
          icon,
        )
      // 0.19.0（spec §9）：AI 消息动作区只留「引用」。
      // 原时钟图标 = runRevert（回滚到此条），与用户消息回撤重复，用户要求删除。
      return act(React.createElement(IconQuote, { size: 16 }), t('slot.quote'), 'quote', runQuote, false)
    }

    // 0.4.2 引入（恢复的标记自动离开活跃列表 = opencode clear 语义）。
    // 0.5.0 脚本化编辑曾误删本函数 → dock 100% 静默失效（P0，0.5.2 恢复）。
    function activeMarkers(msgs) {
      // 0.8.0：活跃判定收敛到服务端权威字段 restoreComplete
      // （按 restoredSourceSeqs 进度算；旧 notice 无该字段 → 服务端视为整段已恢复）。
      // 旧的"行内 restoresSeq 集合"客户端判定已删除——按轮步进下部分恢复的标记
      // 也带 restoresSeq，旧逻辑会把它们误杀（实测：第一轮恢复后整条消失）。
      // 0.10.1：再排掉**已提交**的 marker —— 对齐 opencode
      // （用户发出下一条真实消息后，opencode 在 Session.prompt 里自动
      //  SessionRevert.commit() → revert:null → affordance 消失）。
      // 我们是 append-only，marker 不会真消失，所以由服务端按
      // 「marker 之后有无 source.kind==='user' 的真实输入」算出 committed。
      return (
        (msgs || [])
          .filter(m => m.marker && m.sourceKind !== 'compact-checkpoint' && m.restoreComplete !== true && m.committed !== true)
          // 0.14.0：排掉「自噬 marker」—— 它的 replace 区间恰好覆盖**另一条 marker**
          // （典型是 `startSeq === endSeq === 前一条 marker 的 seq`，content 为空）。
          // 这种记录不是用户做过的回滚，是旧版 dock 拿 marker 当目标留下的残迹；
          // 列出来只会让用户点「恢复」再生成一条同样的垃圾。
          .filter(m => {
            const rng = m.range
            if (!rng || !Number.isSafeInteger(rng.startSeq)) return true
            if (rng.startSeq !== rng.endSeq) return true
            const target = (msgs || []).find(x => x && x.seq === rng.startSeq)
            return !(target && target.marker === true)
          })
      )
    }

    /**
     * activity 信号 → 是否重拉的**纯决策**（0.10.6 · 测试性改造）。
     *
     * 为什么抽出来：三轮测试审计的结论是「客户端 F1 的锁全是形状锁」——整个
     * useEffect 可以被注释掉而 164 条测试全绿（审计 W4 实测）。根因是判定逻辑
     * 埋在 hook 里，node --test 无法执行。抽成纯函数后可用 `new Function` 抽出来
     * **行为测试**（client-perf-locks.test.js:161 已有同款手法，零新依赖）。
     *
     * 语义（三态，返回「推进后的基线」让调用方无脑赋值）：
     *   next == null        → 不动基线（宿主 store 还没就绪）
     *   prev == undefined   → **建基线**。首帧渲染时 activityAt 常先是 null 再被
     *                         填充（或经 lastPromptAt 投影折入），把这次「null→值」
     *                         当成新活动会让开会话白拉一次（实测曾达 6 次 GET）
     *   next <= prev        → 单调门，不动基线（refreshList 可能压低再抬高）
     *   next >  prev        → 真活动：重拉并推进基线
     */
    function activityTransition(prev, next) {
      if (next == null) return { reload: false, baseline: prev }
      if (prev === undefined) return { reload: false, baseline: next }
      if (next <= prev) return { reload: false, baseline: prev }
      return { reload: true, baseline: next }
    }

    function RevertDock(props) {
      const { sessionId, useSessions, inputActions } = props
      if (sessionId) __currentSessionId = sessionId
      const t = (props && props.t) || __t
      useLocaleRevision()
      if (inputActions && typeof inputActions.setDraft === 'function') __inputActions = inputActions
      const sessions = useSessions ? useSessions(s => s) : undefined
      const summary = sessions && sessions.byId ? sessions.byId[sessionId] : undefined
      const running = summary ? summary.running === true : false
      // F1 主路径：宿主 activity 信号（见下方 effect）；null = 无 useSessions 或尚无活动
      const activityAt = summary && typeof summary.updatedAt === 'number' ? summary.updatedAt : null
      const loadRef = useRef(() => {})
      const lastActivityRef = useRef(undefined)
      // R2（审计）：invalidateMessagesMemo() 只丢 memo 引用、**不取消在途 fetch**。
      // 两个并发 load（mount + activity，或 CHANGED + activity）时慢的那个可能后落，
      // setMarkers 会把已正确的 markers 覆盖回去 → dock 重新出现。
      // 0.10.4 的 350/1400ms 延迟事实上起到了串行化作用，删除后重叠概率上升。
      const reqSeqRef = useRef(0)
      const sessRef = useRef(sessionId) // 真正的「切了会话」判据（R1 回归修复）
      const landedSeqRef = useRef(0) // 已成功落地的最大请求序号（R2：失败不回滚）
      const [open, setOpen] = useState(false)
      const [markers, setMarkers] = useState(null) // 活跃回撤标记（已恢复的自动消失）
      const [shadowCount, setShadowCount] = useState(0) // 标记 range 内被遮蔽消息数（标题口径）
      const [restoring, setRestoring] = useState(null)
      const [styleInjected, setStyleInjected] = useState(false)

      // opencode SessionRevertDock 视觉（v2 布局，DSH 令牌等价映射）
      useEffect(() => {
        if (styleInjected || typeof document === 'undefined') return
        if (document.getElementById('dsh-message-ops-dock-style')) {
          setStyleInjected(true)
          return
        }
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
        syncSyntheticTurnStyle([])
        let alive = true
        const onChange = () => load()
        window.addEventListener(CHANGED_EVENT, onChange)
        const load = () => {
          const reqSeq = ++reqSeqRef.current // 发起序号（防慢响应覆盖快响应）
          // R1（复审实测）：fetchMessagesJson 有 MSG_COALESCE_MS=1000 共用窗——
          // 既有 scan 观察器在 T+200ms 已取到**落盘批窗(200ms)之前**的旧响应，
          // 本路径若不先失效 memo，会原样复用它 → committed 仍是 false → 弹窗不清。
          // emitChanged() 自己就是先 invalidate 再发事件，这里同款红线。
          invalidateMessagesMemo()
          return fetchMessagesJson('/api/message-ops/messages?sessionId=' + encodeURIComponent(sessionId))
            .then(data => {
              if (!alive || !data || !data.ok) return
              // R2：只有**最新发起且仍未被更新的请求**的结果才允许落地。
              // 注意不能只看 reqSeq 是否等于当前发起序号 —— 后发请求若失败（fetchMessagesJson
              // 对非 2xx / ok!==true 会 throw，被下面 catch 吞掉），它的序号已被占用，
              // 先发那次**成功的**好响应就会被这里丢弃 → markers 停在旧值且无重试。
              // 故另记一个「已落地序号」，失败不回滚它。
              if (reqSeq !== reqSeqRef.current || reqSeq <= landedSeqRef.current) return
              landedSeqRef.current = reqSeq
              const msgs = data.messages || []
              syncSyntheticTurnStyle(msgs)
              const act = activeMarkers(msgs)
              setMarkers(act)
              // 0.5.2（P2）：标题口径 = 标记 range 内 visible=false 的去重 seq 数
              const seen = new Set()
              for (const mk of act) {
                const start = mk.range && typeof mk.range.start === 'number' ? mk.range.start : mk.seq
                const end = mk.range && typeof mk.range.end === 'number' ? mk.range.end : start
                for (const m of msgs) {
                  if (m && m.visible === false && typeof m.seq === 'number' && m.seq >= start && m.seq <= end) seen.add(m.seq)
                }
              }
              setShadowCount(seen.size)
            })
            .catch(() => {})
        }

        // F1（复审后重做）：宿主在 user/message(source.kind==='user') 时会
        // `ctx.emit("api-session/activity", id, event.time)`
        // （$B/dsh-api-session-controller/lib/index.js:2890-2896），客户端
        // :3624 收到后抬高 summary.updatedAt（:3002 case "activity"）——
        // 这是与服务端 markCommitted **完全同判据**的一等信号。
        //
        // 第一版用 MutationObserver 盯 DOM 属性，复审判定为次优：
        //  - 判据靠近似（data-chat-flow-kind / 13:input-message 会命中注入行）
        //  - 多挂第三个 body-subtree 观察器
        //  - ready 门控在首拉失败时永久失效
        // 本组件本就经 useSessions 读 summary（running 同源依赖），零新增依赖。
        loadRef.current = load
        load()

        return () => {
          alive = false
          loadRef.current = () => {}
          syncSyntheticTurnStyle([])
          window.removeEventListener(CHANGED_EVENT, onChange)
        }
      }, [sessionId])

      // F1 主路径：宿主 activity 信号抬高 updatedAt → 重拉。
      // lastActivityRef 让 mount 那次（与初始值相等）不触发，避免开会话双请求。
      //
      // R2（复审推翻原「闪一下」定性，实为**弹窗可能一直不消失**）：
      //   宿主在 session.append 后**同步** emit api-session/activity
      //   （$B/dsh-api-session-controller/lib/index.js:2890-2896），而落盘是
      //   **异步批窗**（$B/dsh-session/lib/index.js:1406 "hot path never blocks
      //   on I/O"；persistence-jsonl:187 buffered/batchTimer）。
      //   我们的 GET 读磁盘 + derivedCache 按 mtimeMs+size 失效（index.js:376），
      //   拉取链 ≈30-150ms **几乎必然早于落盘** → 服务端 markCommitted 看不到
      //   新 user 消息 → committed 仍是 false。
      //   而 updatedAt 每条消息只跳变一次、scan 走 fetchRows 碰不到 markers、
      //   宿主输入也不发 CHANGED_EVENT —— **没有第二次触发**，弹窗会一直留到
      //   下一条消息或一次插件写操作。这正是用户原话的病灶。
      //   故：有界重试，直到 dock 清空或重试耗尽（每条消息最多 3 次 GET）。
      // R1（审计）：原为 `= undefined`，但若切会话时 activityAt **不变**
      // （同毫秒 createdAt / 都为 null 且新会话 summary 未进 store），
      // 下游 effect 的依赖未变 → 不执行 → 基线永远停在 undefined →
      // **用户切会话后的第一条消息撞上基线分支被吞，无任何 reload**（原 bug 上移一层）。
      // 重置到「当前」值：变了则基线=B（下游 B<=B 直接 return，不多拉）；
      // 没变则基线=null，下次真实跳变 `x <= null` 为 false → 正常 load。
      // ⚠️ 必须**只有一个** effect。上一版拆成「重置 + 判定」两段、且重置段的依赖
      // 带上了 activityAt —— 同一次 commit 里 React 按声明顺序 flush，重置先把基线
      // 写成当前值，判定再拿到 T(B,B) → next <= prev → **活动信号被 100% 吃掉**，
      // F1 主路径彻底哑火（第四轮架构复审实跑抓出）。判据必须是「sessionId 真的
      // 变了」（sessRef），而不是「依赖数组里出现了 activityAt」。
      //
      // R1 原目标同样要达成：切会话时基线重置为**新会话当前值**（而非 undefined）——
      // 置 undefined 时若 activityAt 不变，下游不执行、基线永远 undefined，
      // 切会话后用户第一条消息撞上「建基线」分支被吞。
      useEffect(() => {
        if (sessRef.current !== sessionId) {
          sessRef.current = sessionId
          lastActivityRef.current = activityAt // 切会话：以新会话当前值为基线
          return
        }
        const step = activityTransition(lastActivityRef.current, activityAt)
        lastActivityRef.current = step.baseline
        if (step.reload) loadRef.current()
      }, [sessionId, activityAt])

      // 0.19.0（spec §3.4）：去掉「markers 变化就自动折叠」。
      // 用户反馈：点开 dock 后一操作就被收回去，很烦。折叠状态只由用户
      // 点击 header / chevron 改变；恢复=重放的语义与文案保持不变。
      // 注意：不能整个删掉这个 useEffect 的「早退之前」位置约束 —— 这里只是
      // 不再写 setOpen(false)，Hooks 顺序不受影响（下方无其它 Hook 依赖它）。
      if (!markers || !markers.length) return null

      const restoreRow = row => {
        if (restoring != null || running) return
        setRestoring(rowKey(row))
        Promise.resolve()
          .then(() =>
            fetch('/api/message-ops/restore', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              // 0.8.0：upToSeq 存在 → 按轮步进恢复（只重放到该 seq）
              body: JSON.stringify(row.upTo != null ? { sessionId, seq: row.seq, upToSeq: row.upTo } : { sessionId, seq: row.seq }),
            }),
          )
          .then(async res => {
            let data = {}
            try {
              data = await res.json()
            } catch {
              /* keep {} */
            }
            if (!res.ok || !data.ok) throw new Error(data.error || 'HTTP ' + res.status)
            notifyDone(
              t('done.restore', {
                n: String(data.restoredCount != null ? data.restoredCount : '?'),
                s: String(data.skipped != null ? data.skipped : 0),
              }),
            )
            setRestoring(null)
            // 0.5.0：恢复后重建会话视图（重放消息立即可见）
            try {
              if (__uiWorkspace && typeof __uiWorkspace.openSession === 'function') __uiWorkspace.openSession(sessionId)
            } catch {
              /* fallthrough */
            }
            // 0.9.1：重放的消息带**新 seq**，被恢复的行必须解除 hidden；dock 的
            // marker 列表要按权威数据重算（restoreComplete 会变 true）后重拉。
            emitChanged()
            for (const delay of [150, 700, 1600])
              setTimeout(() => {
                if (__refreshSurface) __refreshSurface(sessionId)
              }, delay)
            const fresh = await fetchMessagesJson('/api/message-ops/messages?sessionId=' + encodeURIComponent(sessionId)).catch(() => null)
            if (fresh && fresh.ok) setMarkers(activeMarkers(fresh.messages || []))
          })
          .catch(reason => {
            notifyDone(t('errorPrefix') + (reason && reason.message ? reason.message : String(reason)), 'error')
          })
          .finally(() => setRestoring(null))
      }

      const headerKbd = e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          setOpen(v => !v)
        }
      }
      // 0.5.2（P2）：标题报「被遮蔽消息数」而非标记数——一个 revert 可遮蔽数百条，
      // 用标记数会严重低报（0.4.2 文案引入的错口径）；无 range 数据时回退标记数
      const label = t('dock.title', { n: String(shadowCount || markers.length) })
      const preview = markers[0] && markers[0].snippet ? markers[0].snippet : ''

      // 0.8.0：行 = 待恢复"轮"（对齐 opencode 按轮步进）；无可重放轮的标记
      // 保留旧式整段行（空区间 → 停用 notice 路径）。restoring 键区分同标记多轮。
      const rowKey = row => (row.upTo != null ? row.seq + ':' + row.upTo : String(row.seq))
      const rowEl = row =>
        React.createElement(
          'div',
          { key: rowKey(row), className: 'mopsRdRow' },
          React.createElement('span', { className: 'mopsRdRowText' }, '#' + row.seq + ' · ' + (row.snippet || '')),
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'mopsRdRestore',
              disabled: restoring != null || running,
              // 0.10.2 专家组评估结论：唯一「严重度=高」的真实缺口是 restore 为**重放**语义 ——
              // 消息带新 seq 落到会话末尾，**不会回到原位**（引擎 SurfaceOp 只有 append/replace，
              // 不存在解除遮蔽的原语）。用户点下去看到消息"搬家到底部"会以为出 bug，
              // 所以把语义写在按钮上，别让人靠猜。
              title: t('dock.restoreHint'),
              onClick: () => restoreRow(row),
            },
            restoring === rowKey(row) ? t('dock.restoring') : t('dock.restore'),
          ),
        )
      const dockRows = []
      for (const mk of markers || []) {
        // 0.14.0（dock 文案修复）：`mk.snippet` 是 **marker 自己**的正文 ——
        // 也就是「[消息回滚] 已回滚到 seq N…」这句拼接文案本身。
        // 用户看到「#3417 · [消息回滚] 已回滚到 seq 3410…」，点「恢复」后
        // 日志里又落一条遮蔽 marker 自己的空 replace（实测 5 次）。
        // 正确口径：这一行代表的是「被 marker 遮蔽的那段对话」，文案必须取自
        // range 区间里的真实内容；区间取不到才显示序号。
        const rng = mk.range && Number.isSafeInteger(mk.range.startSeq) ? mk.range : null
        // 预览文案必须描述「被遮蔽的那段」，不能是 marker 自己的 notice 文本。
        // 区间退化成单点且恰好是另一条 marker 时，这条 marker 是**冗余生成**的，
        // 直接标出来，别让用户以为它是一轮真实对话。
        const span = rng ? (rng.endSeq > rng.startSeq ? 'seq ' + rng.startSeq + '..' + rng.endSeq : '#' + rng.startSeq) : ''
        const rangeSnippet = mk.previewFirst || span
        if (Array.isArray(mk.pendingTurns) && mk.pendingTurns.length > 0) {
          for (const t of mk.pendingTurns) {
            dockRows.push({
              seq: mk.seq,
              upTo: t.upTo,
              snippet: t.preview + (t.count > 1 ? ' (+' + (t.count - 1) + ')' : ''),
            })
          }
        } else if (rng) {
          dockRows.push({ seq: mk.seq, snippet: rangeSnippet, markerRange: rng })
        }
      }

      const chevron = React.createElement(
        'button',
        {
          type: 'button',
          'aria-label': open ? t('dock.collapse') : t('dock.expand'),
          'aria-expanded': open,
          className: 'mopsRdChevron',
          onClick: e => {
            e.stopPropagation()
            setOpen(v => !v)
          },
        },
        React.createElement(
          'svg',
          {
            width: 14,
            height: 14,
            viewBox: '0 0 16 16',
            fill: 'none',
            style: { transform: open ? 'rotate(0deg)' : 'rotate(180deg)', transition: 'transform .15s ease' },
          },
          React.createElement('path', {
            d: 'M4 6l4 4 4-4',
            stroke: 'currentColor',
            strokeWidth: 1.3,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        ),
      )

      return React.createElement(
        'div',
        { className: 'mopsRd', role: 'region', 'aria-label': label },
        React.createElement(
          'div',
          {
            className: 'mopsRdHead',
            role: 'button',
            tabIndex: 0,
            onClick: () => setOpen(v => !v),
            onKeyDown: headerKbd,
          },
          React.createElement(
            'span',
            { className: 'mopsRdIcon' },
            React.createElement(
              'svg',
              { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none' },
              React.createElement('path', {
                d: 'M2.5 8a5.5 5.5 0 1 0 1.6-3.9',
                stroke: 'currentColor',
                strokeWidth: 1.2,
                strokeLinecap: 'round',
              }),
              React.createElement('path', {
                d: 'M2.2 2.8v3h3',
                stroke: 'currentColor',
                strokeWidth: 1.2,
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
              }),
            ),
          ),
          React.createElement('span', { className: 'mopsRdLabel' + (open ? '' : ' mopsRdLabelCollapsed') }, label),
          open ? null : React.createElement('span', { className: 'mopsRdPreview' }, preview),
          React.createElement('span', { style: { marginLeft: 'auto', flex: 'none' } }, chevron),
        ),
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
    // 官方用户消息的动作行 = .xzv4MW_actions（含 Copy，height28，位于消息下方 16px），
    // 可见性由宿主 [data-actions-reveal] 控制。把按钮 append 进该行、与 Copy 同级同层，
    // 可见性天然继承宿主动作行（不再自己玩 hover）。0.6.0 的 absolute 覆盖教训见 README「历史事故记录」#2。
    function installUserRevertInjector() {
      if (window.__MOPS_USER_REVERT_INSTALLED) return
      window.__MOPS_USER_REVERT_INSTALLED = true
      var rowsCache = { sid: null, rows: null, at: 0 }
      __peekRowsCache = () => rowsCache
      var norm = x => String(x || '').replace(/\s+/g, '')

      // 0.9.7（P4）：messageId→seq / 全文索引挂在**同一个 dataSig** 上。
      // 旧实现每会话只写一次、仅失败时 delete —— 会话增长后新 assistant 消息的
      // messageId 不在索引里，`seq == null` → MsgSlotActions 直接 return null，
      // 那条消息旁的回撤/引用按钮**再也不渲染**。dataSig 变了就用手里这份全量
      // 载荷就地重建（零额外请求），并广播 SEQ_INDEX_EVENT 让已挂载的槽位重跑解析。
      var __seqDataSig = null
      var syncSeqIndex = (sid, messages, idx) => {
        const sig = sid + '/' + idx.total + '/' + idx.shadowed.size + '/' + idx.visibleTurns.size
        if (sig === __seqDataSig) return
        __seqDataSig = sig
        const index = new Map()
        const full = new Map()
        for (const m of messages || []) {
          if (!m || m.id == null) continue
          const k = String(m.id)
          // 同 id 取**最早** seq —— 与槽位自己的 buildSeqIndex 口径一致
          // （隐藏判据 buildIndex 取最新，两套语义不能混）。
          if (!index.has(k)) index.set(k, m.seq)
          if (m.fullText) full.set(k, m.fullText)
        }
        for (const key of [sid, 'session-' + sid]) {
          __seqIndexCache.set(key, index)
          __fullTextCache.set(key, full)
        }
        try {
          window.dispatchEvent(new CustomEvent(SEQ_INDEX_EVENT))
        } catch {
          /* non-browser */
        }
      }

      var fetchRows = sidIn => {
        // 0.9.7：统一按**裸 uuid** 作缓存键。调用方有的传 `session-xxx`（scan /
        // /undo 的 rawSid）有的传裸 uuid（/redo 的 bareSessionId）—— 混用会让
        // rowsCache.sid 在两个键之间来回横跳，每次都是缓存未命中（白白多发 GET）。
        const sid = bareSessionId(sidIn)
        if (rowsCache.sid === sid && rowsCache.rows && Date.now() - rowsCache.at < 8000) return Promise.resolve(rowsCache)
        return fetchMessagesJson('/api/message-ops/messages?sessionId=' + encodeURIComponent(sid))
          .then(d => {
            // 宿主会把 <system-reminder> / runtime context 等也记为 role=user 的行，
            // DOM 里并不渲染成"我的消息"块 —— 必须滤掉，否则按序配对会错位（0.7.0 根因）。
            // 注意：对话框的「可回滚目标」列表仍应过滤 visible（那是另一套语义）。
            // 稳妥做法本该在服务端打 injected 标志，先在客户端补齐正则。
            // 判据一律用**原始 snippet**（norm() 删掉全部空白，正则必然失配）。
            // 0.9.0 / 0.9.6 两轮事故复盘 + 120 份日志普查样本见 README「历史事故记录」#3。
            // 关键约束：id 后必须跟得上具体形态（[\w-]+ / [0-9a-f]{8}-），
            // 否则 `Background job 是我自己的问题` 这种真人输入会被误杀
            // （曾用 ^background job\b，测试当场抓到这个误杀）。
            // 样本里没出现过的模式（已停止 / User feedback:）一律**不加** —— 没证据就不猜。
            const injected = raw =>
              /^<system-reminder|current\s+runtime\s+context|^<system-Reminder|^background job\s+[\w-]+|^Background subagent\s+[0-9a-f]{8}-|^Agent\s+[0-9a-f]{8}-|^\[model changed:/i.test(
                String(raw || ''),
              )
            const rows = ((d && d.messages) || [])
              .filter(m => m && m.role === 'user')
              .map(m => ({
                seq: m.seq,
                sn: norm(m.snippet),
                raw: String(m.snippet == null ? '' : m.snippet),
                fullText: m.fullText ?? null,
                visible: m.visible !== false,
                turnStartSeq: m.turnStartSeq ?? null,
              }))
              .filter(r => r.sn && !injected(r.raw))
            // 0.9.1：同时产出 node-key 查表索引（隐藏 transcript 用）
            const idx = buildIndex(d)
            rowsCache = { sid: sid, rows: rows, idx: idx, at: Date.now() }
            syncSeqIndex(sid, d && d.messages, idx)
            return rowsCache
          })
          .catch(() => (rowsCache.sid === sid ? rowsCache : null))
      }

      // ═══ 0.9.1 宿主 node-key ↔ 日志 seq 的精确映射 ═══════════════════════════
      // dsh transcript 刻意不折叠（surface.d.ts:51-63 "replacement copies stay
      // model-only"），回滚只能在渲染层按 `data-chat-node-key` 精确查表（零启发式）。
      // 背景长文与「40 字符前缀匹配」事故见 README「0.9.1 / 0.9.2 · 回滚「真的生效了」」。
      var parseNodeKey = k => {
        var m = /^(\d+):/.exec(k || '')
        if (!m) return null
        var digits = m[1].length
        var kindLen = Number(m[1])
        var start = digits + 1
        if (!Number.isSafeInteger(kindLen) || kindLen <= 0 || k.length < start + kindLen) return null
        return { kind: k.slice(start, start + kindLen), id: k.slice(start + kindLen) }
      }

      /**
       * 从 /api/message-ops/messages 的响应构建全部查表。
       * 两条铁律：① 索引只认唯一 id；② 缺数据一律返回 undefined（调用方保持可见）。
       */
      var buildIndex = payload => {
        var list = (payload && payload.messages) || []
        // 0.9.1：回合页脚/过程条不是消息，用 turn/end 的 seq 定位（边界常落在 turn 内部，
        // 用 turn/start 会漏判该回合的页脚）
        var turnEnd = (payload && payload.turnEndSeq) || null
        var byMessageId = new Map()
        var byTurnStep = new Map()
        var byCallId = new Map()
        var byTurn = new Map()
        var shadowed = new Set() // 落在 replace 区间内 = 已被回滚（transcript 藏行判据）
        var visibleTurns = new Set() // 含至少一条**未被遮蔽**消息的 turn 号（回合 chrome）
        var dupByMessageId = new Map()
        for (var i = 0; i < list.length; i++) {
          var m = list[i]
          if (!m || typeof m.seq !== 'number') continue
          if (m.id != null) {
            var k = String(m.id)
            // restore 是「重放」语义 → 原件与副本可能同 id 并存。
            // 0.9.1：不再「保留最早」，而是收集**全部** seq，隐藏判据取「任一 seq 越过
            // fence」。回放副本才是当前 surface 上的那条，用最早的 seq 判会让
            // 「恢复后再回滚」漏藏（实测 fence=70、副本 seq=70、原件 seq=54）。
            if (byMessageId.has(k)) {
              const arr = dupByMessageId.get(k) || [byMessageId.get(k)]
              arr.push(m.seq)
              dupByMessageId.set(k, arr)
              byMessageId.set(k, m.seq) // 指向最新的
            } else {
              byMessageId.set(k, m.seq)
            }
          }
          if (m.type === 'assistant/message' && m.turn != null && m.step != null) {
            byTurnStep.set(m.turn + ':' + m.step, m.seq)
          }
          if (m.type === 'tool/call' && m.id != null) byCallId.set(String(m.id), m.seq)
          if (m.turn != null && !byTurn.has(String(m.turn))) byTurn.set(String(m.turn), m.seq)
          // 0.9.6：藏行判据用 shadowed（replace 区间），**不用** m.visible（模型 surface）。
          // visible 在 live 路径下对 tool/call 恒 false → 拿它当判据会把整页工具行全藏，
          // 故这里连集合都不建（判据样本见 test/surface-visibility.test.js）。
          if (m.shadowed === true) shadowed.add(m.seq)
          else if (m.turn != null) visibleTurns.add(String(m.turn))
        }
        // turnEnd 优先：它对「该 turn 内一条消息都没有」的情况仍然有效
        if (turnEnd) for (const k in turnEnd) if (Object.prototype.hasOwnProperty.call(turnEnd, k)) byTurn.set(k, turnEnd[k])
        return { byMessageId, dupByMessageId, byTurnStep, byCallId, byTurn, shadowed, visibleTurns, total: list.length }
      }

      /** node-key → { seq, all }（all = 同 id 的全部 seq，处理 restore 重放副本）。 */
      var seqOfNodeKey = (key, idx) => {
        var parsed = parseNodeKey(key)
        if (!parsed || !idx) return null
        var id = parsed.id
        switch (parsed.kind) {
          case 'input-message': // user / steering / turn-trigger
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
            return null // compaction / command / workflow-run 等不参与
        }
      }

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
        if (!idx) return { hidden: 0, unresolved: 0, shown: 0 }
        // 0.9.7（P2-1）：root 既可传 document/元素（调用方自查），也可直接传
        // 已经查好的行集合 —— ensureAssign 每次都要算 rows.length 当签名，
        // 传集合避免同一次扫描里 querySelectorAll 跑两遍。
        var rows =
          root && typeof root.querySelectorAll === 'function'
            ? root.querySelectorAll('[data-chat-node-key]')
            : root || document.querySelectorAll('[data-chat-node-key]')
        var hidden = 0,
          unresolved = 0,
          shown = 0
        for (var i = 0; i < rows.length; i++) {
          var row = rows[i]
          // 0.9.6 藏行判据 = **replace 区间（shadowed）**；revertFences→visible→shadowed
          // 演进史（含 4792/4793 全藏事故）见 README「历史事故记录」#4。
          var hit = seqOfNodeKey(row.getAttribute('data-chat-node-key'), idx)
          // 0.9.7（P2-1）幂等跳写：判据与执行时机**一字未改**，只在
          // 「目标状态 ≠ 当前状态」时才碰属性 —— 省掉全表几百次无效写。
          if (hit === null) {
            unresolved++
            if (row.hasAttribute('hidden')) row.removeAttribute('hidden')
            continue
          }
          var shouldHide
          if (hit.turn !== undefined) {
            // 回合 chrome：本 turn 还有未被遮蔽的消息就露出
            shouldHide = !idx.visibleTurns.has(String(hit.turn))
          } else {
            // 消息/工具类：**是否落在 replace 区间内**（= 被回滚掉了）。
            // ⚠️ 不能用 visible（模型 surface）——live 路径下 tool/call 恒不在 surface，
            //    会把整页工具行全藏（实测 157 行藏 152 行）。
            shouldHide = idx.shadowed.has(hit.seq)
          }
          if (shouldHide) {
            hidden++
            if (row.getAttribute('hidden') !== 'until-found') row.setAttribute('hidden', 'until-found')
          } else {
            shown++
            if (row.hasAttribute('hidden')) row.removeAttribute('hidden')
          }
        }
        return { hidden, unresolved, shown }
      }

      // 用户消息锚点：优先官方 Sixlwa_userRow（含 .xzv4MW_actions），回退 flow-kind 属性
      // 锚点 = 每条用户消息自己的容器（一个块只算一次）：
      // 从官方动作行 .xzv4MW_actions 反查最近的消息容器，最贴近"一条消息"的粒度。
      var userAnchors = () => {
        const out = []
        const seen = new Set()
        const add = el => {
          if (el && !seen.has(el)) {
            seen.add(el)
            out.push(el)
          }
        }
        const rows = Array.from(document.querySelectorAll('[class*="xzv4MW_actions"]'))
        for (const r of rows) {
          const block =
            r.closest('[data-chat-flow-kind="user"]') ||
            r.closest('[class*="_userRow"], [class*="_userStack"], [class*="_bubble"]') ||
            r.parentElement
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
        // 0.18.0：三种按钮各有自己的提示文案（新增编辑按钮后不能都写 revert）
        const hintKey = btn.classList.contains('mopsUserFork') ? 'slot.forkHint' : 'slot.revert'
        const ok = block.getAttribute('data-mops-seq')
        if (ok) {
          btn.disabled = false
          btn.title = __t(hintKey)
          btn.removeAttribute('data-mops-unmatched')
        } else {
          btn.disabled = true
          btn.title = __t('slot.revertUnmatched')
          btn.setAttribute('data-mops-unmatched', '1')
        }
      }
      /** 块内全部插件按钮一起同步（回滚 / 分叉同一动作行）。 */
      var syncBlockButtons = block => {
        if (!block || !block.querySelectorAll) return
        for (const b of block.querySelectorAll('.mopsUserRevert, .mopsUserFork')) syncEnabled(block, b)
      }
      var assignSeqs = (sid, cache, anchors) => {
        const idx = cache && cache.idx
        if (!idx) return
        // 0.9.1：node-key 查表，替代旧的 40 字符前缀包含匹配（实测 4 条错 2 条）
        for (const b of anchors || userAnchors()) {
          b.removeAttribute('data-mops-seq')
          b.removeAttribute('data-mops-unmatched')
          const hit = seqOfNodeKey(b.getAttribute('data-chat-node-key'), idx)
          const seq = hit === null ? null : hit.seq
          if (seq === null || seq === undefined) {
            b.setAttribute('data-mops-unmatched', '1')
            syncBlockButtons(b)
            continue
          }
          b.setAttribute('data-mops-seq', String(seq))
          syncBlockButtons(b)
        }
      }
      // 按钮可用性在 assignSeqs 内部**同步**更新（与打标同一次循环）——
      // 之前放在 fetch 回调里做事后全局扫描，会与 DOM 注入/重排竞态，导致
      // 块已打上 seq 而按钮仍是禁用态（实测：block seq=[8,54]，按钮 disabled=true）。
      // 按钮可用性与 transcript 隐藏都在这里统一落地（同一批数据，避免竞态）
      //
      // 0.9.7（P2-1）三签名门控。scan **无条件**调 ensureAssign 是故意的
      // （早先做成「只在没打标时刷」→ 界面停在旧状态），所以门控只放在
      // assignSeqs 的全量 DOM 改写上，三者全等才跳过：
      //   dataSig   —— idx.total / shadowed.size / visibleTurns.size（数据变了必须重算）
      //   domSig    —— transcript 行数（行集合变了必须重算）
      //   anchorSig —— 每个 user 块的 node-key + 打标状态（宿主重建块 / CHANGED
      //               摘牌后 node-key 相同但打标为空，靠这里发现）
      // 🔴 applySurfaceVisibility 仍然**无条件**执行，藏行判据与时机一字未改。
      var assignSig = null
      var anchorSigOf = anchors => {
        let s = ''
        for (let i = 0; i < anchors.length; i++) {
          const b = anchors[i]
          s +=
            (b.getAttribute('data-chat-node-key') || '') +
            '=' +
            (b.getAttribute('data-mops-seq') || (b.hasAttribute('data-mops-unmatched') ? '?' : '-')) +
            ','
        }
        return s
      }
      var sigOf = (sid, dataSig, rowsLen, anchors) => bareSessionId(sid) + '|' + dataSig + '|' + rowsLen + '|' + anchorSigOf(anchors)
      var ensureAssign = sid =>
        fetchRows(sid).then(cache => {
          if (!cache || !cache.idx) return cache
          const idx = cache.idx
          const rows = document.querySelectorAll('[data-chat-node-key]')
          const dataSig = idx.total + '/' + idx.shadowed.size + '/' + idx.visibleTurns.size
          const anchors = userAnchors()
          const before = sigOf(sid, dataSig, rows.length, anchors)
          if (before !== assignSig) {
            assignSeqs(sid, cache, anchors)
            // 存**改写之后**的真实签名：下一次直接相等就跳过，不用跑两轮才收敛
            assignSig = sigOf(sid, dataSig, rows.length, anchors)
          }
          applySurfaceVisibility(rows, idx)
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
          .then(cache => {
            const rows = cache && cache.rows
            // 0.9.1：seq 来自 node-key 精确查表，**不再**做文本前缀匹配验证
            // （旧的前缀包含匹配实测 4 条错 2 条 —— "继续" 命中 "继续，…"）。
            const seq = Number(block.getAttribute('data-mops-seq'))
            const row = rows && rows.find(r => r.seq === seq)
            if (!row) {
              ensureAssign(sid)
              notifyDone(__t('errorPrefix') + __t('slot.revertUnmatched'), 'error')
              return
            }
            btn.disabled = true
            Promise.resolve()
              .then(() =>
                fetch('/api/message-ops/revert', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ sessionId: sid, seq: row.seq }),
                }),
              )
              .then(async res => {
                let data = {}
                try {
                  data = await res.json()
                } catch {
                  /* keep {} */
                }
                if (!res.ok || !data.ok) throw new Error(data.error || 'HTTP ' + res.status)
                notifyDone(__t('done.revert'))
                // 0.17.0（冲突 C2）：按钮路径原先漏了「立刻标遮蔽」，
                // 导致刷新窗口内重复点击会拿已遮蔽的 seq 去 POST → 409。
                markRowsShadowedFrom(row.seq)
                // 0.9.6：统一回填出口 —— 这个入口原先也不回填
                refillComposer(sid, row.seq)
                emitChanged()
                try {
                  if (__uiWorkspace && typeof __uiWorkspace.openSession === 'function') __uiWorkspace.openSession(sid)
                } catch {
                  /* 视图重建失败不阻断 */
                }
                // 0.9.1：视图重建后重新拉权威可见性并隐藏被遮蔽的行。
                // openSession 会重挂 DOM，旧节点上的 hidden 属性随之失效，必须重刷。
                if (rowsCache) rowsCache.at = 0
                for (const delay of [150, 700, 1600])
                  setTimeout(() => {
                    if (__refreshSurface) __refreshSurface(sid)
                  }, delay)
              })
              .catch(reason => {
                notifyDone(__t('errorPrefix') + (reason && reason.message ? reason.message : String(reason)), 'error')
              })
              .finally(() => {
                btn.disabled = false
              })
          })
      }
      /**
       * 0.12.0 用户消息「从此条分叉」：非破坏操作，源会话一字不动。
       *
       * opencode 语义 = 复制此条**之前**的对话到一个新会话，并把此条原文放回
       * 新会话的输入框，让用户改完再发。因此这里要三步：
       *   1. 解析 seq（点击当下可能还没打标 → 先 ensureAssign 再 fetchRows）
       *   2. 取该条用户消息的**原文**（列表只携带 snippet，长度会被截断）
       *   3. fork(boundary = seq - 1) → 把原文写进子会话草稿 → 打开子会话
       */
      var runUserFork = (btn, block) => {
        const sid = __currentSessionId
        if (!sid) return
        btn.disabled = true
        Promise.resolve()
          .then(() => ensureAssign(sid))
          .then(() => fetchRows(sid))
          .then(async cache => {
            const rows = cache && cache.rows
            const seq = Number(block.getAttribute('data-mops-seq'))
            const row = rows && rows.find(r => r.seq === seq)
            if (!row) {
              notifyDone(__t('errorPrefix') + __t('slot.revertUnmatched'), 'error')
              return
            }
            if (!(seq > 0)) {
              notifyDone(__t('slot.forkUnavailable'), 'warn')
              return
            }
            let text = typeof row.fullText === 'string' ? row.fullText : ''
            if (!text) {
              try {
                const res = await fetch(
                  '/api/message-ops/text?sessionId=' + encodeURIComponent(bareSessionId(sid)) + '&seq=' + encodeURIComponent(seq),
                )
                const data = res.ok ? await res.json().catch(() => null) : null
                if (data && data.ok && typeof data.text === 'string') text = data.text
              } catch {
                /* 取全文失败：分叉照做，只是输入框留空 */
              }
            }
            const childId = await forkFromUserMessage(sid, seq, text, row.turnStartSeq)
            notifyDone(__t('slot.forkDone', { id: String(childId || '') }))
            if (childId) openSessionById(childId)
          })
          .catch(reason => {
            notifyDone(__t('errorPrefix') + (reason && reason.message ? reason.message : String(reason)), 'error')
          })
          .finally(() => {
            btn.disabled = false
          })
      }

      var ensureBtn = block => {
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
        btn.innerHTML =
          '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" stroke="currentColor" stroke-width="1.2"/><path d="M2.2 2.8v3h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        btn.addEventListener('click', e => {
          e.preventDefault()
          e.stopPropagation()
          if (btn.disabled) return
          runUserRevert(btn, block)
        })
        host.appendChild(btn)
        // 0.9.7（P2-1）：新按钮按块的**当前**打标状态立刻同步一次。
        // 门控之后 assignSeqs 可能被跳过（签名未变），靠这里保证「宿主重建了
        // 动作行 → 按钮重新挂上」这种情况仍然是 disabled/title 正确的。
        syncEnabled(block, btn)
        return btn
      }

      /** 0.12.0 分叉按钮：与回滚按钮**同一动作行**（opencode 把 fork 放在 copy/undo 同组）。 */
      var ensureForkBtn = block => {
        let host = block.querySelector('[class*="xzv4MW_actions"]')
        if (!host) {
          host = document.createElement('div')
          host.className = 'mopsUserActionsRow'
          block.appendChild(host)
        }
        const existing = host.querySelector('.mopsUserFork')
        if (existing) return existing
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'mopsUserFork'
        btn.title = __t('slot.forkHint')
        btn.setAttribute('aria-label', __t('slot.fork'))
        // 官方 IconBranchOutline16 的 1:1 路径（packages/client/ui-primitives/src/icons/index.tsx:149）
        btn.innerHTML =
          '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="none"><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M13.0762 1.37207C14.0846 1.37228 14.9021 2.19077 14.9023 3.19922C14.9022 4.20772 14.0847 5.02518 13.0762 5.02539C12.2967 5.02539 11.6325 4.53691 11.3701 3.84961H4.35547C4.79397 4.26458 5.15861 4.7644 5.41699 5.33496L7.10645 9.06738C7.88526 10.7875 9.55104 11.9228 11.4189 12.0371C11.7085 11.4109 12.3411 10.9756 13.0762 10.9756C14.0843 10.9759 14.9023 11.7936 14.9023 12.8018C14.9023 13.81 14.0843 14.6277 13.0762 14.6279C12.2534 14.6279 11.5574 14.0832 11.3291 13.335C8.9868 13.1879 6.89981 11.7612 5.92285 9.60352L4.23242 5.87109C3.67503 4.64033 2.44878 3.84961 1.09766 3.84961V2.54883C1.10665 2.54883 1.11601 2.54975 1.125 2.5498L11.3701 2.54883C11.6326 1.86151 12.2969 1.37207 13.0762 1.37207ZM13.0762 12.2764C12.7858 12.2764 12.5508 12.5114 12.5508 12.8018C12.5508 13.0921 12.7858 13.3281 13.0762 13.3281C13.3664 13.3279 13.6025 13.092 13.6025 12.8018C13.6025 12.5115 13.3664 12.2766 13.0762 12.2764ZM13.0762 2.67285C12.7855 2.67285 12.55 2.90861 12.5498 3.19922C12.5499 3.48987 12.7855 3.72559 13.0762 3.72559C13.3667 3.72538 13.6024 3.48975 13.6025 3.19922C13.6023 2.90874 13.3666 2.67306 13.0762 2.67285Z"/></svg>'
        btn.addEventListener('click', e => {
          e.preventDefault()
          e.stopPropagation()
          if (btn.disabled) return
          runUserFork(btn, block)
        })
        host.appendChild(btn)
        syncEnabled(block, btn)
        return btn
      }
      // 两个按钮的顺序由 DOM 顺序决定：回滚在前（破坏性更高），分叉在后（非破坏）。
      var ensureUserActions = block => {
        // 0.19.0（spec §9）：编辑并重发由已装的 message-edit 插件在 turnTail 提供，
        // 本插件动作行收敛为：回撤 → 分叉。
        ensureBtn(block)
        ensureForkBtn(block)
      }
      // 0.9.7（P0-2 读合并）：把 150/700/1600ms 三档并成**一次**真网络请求，
      // 落点 = 本 burst 第一档 + 1500ms ≈ 原来的 1600ms 那一档。
      // 🔴 红线：这一档是「视图重建后重算隐藏」的兜底，绝不能砍成 0。
      // 调用当下立刻 rowsCache.at = 0 —— openSession 触发的那次 scan 因此能用
      // 共享窗口里的新鲜载荷先把隐藏刷对，不必等兜底那一发。
      var refreshTimer = null
      var refreshDeadline = 0
      __refreshSurface = sid => {
        const id = sid || __currentSessionId
        if (!id) return
        if (rowsCache) rowsCache.at = 0 // 强制重取权威数据
        const now = Date.now()
        if (!refreshTimer) refreshDeadline = now + 1500
        clearTimeout(refreshTimer)
        refreshTimer = setTimeout(
          () => {
            refreshTimer = null
            try {
              // 会话已切走就别把旧会话的 idx 刷到新会话的 DOM 上
              if (bareSessionId(__currentSessionId) !== bareSessionId(id)) return
              invalidateMessagesMemo() // 兜底档必须是真网络，不许吃缓存
              if (rowsCache) rowsCache.at = 0
              fetchRows(id)
                .then(cache => {
                  if (cache && cache.idx) applySurfaceVisibility(document, cache.idx)
                })
                .catch(() => {})
            } catch {
              /* noop */
            }
          },
          Math.max(0, refreshDeadline - now),
        )
      }
      var scan = () => {
        try {
          const sid = __currentSessionId
          if (!sid) return
          const blocks = userAnchors()
          for (const b of blocks) ensureUserActions(b)
          suppressHostBranch()
          // 0.9.1：**始终**刷新（原先只在按钮未打标时刷）——
          // 打标后 transcript 再变化（openSession 重建 / 分页 / restore 重放）
          // 就再也不会重算隐藏，导致「界面停在旧状态，必须重载页面才对」。
          ensureAssign(sid)
        } catch {
          /* 注入失败不影响会话 */
        }
      }
      /**
       * 0.12.0 隐藏官方 assistant turn-tail 上的 branch 按钮。
       *
       * 产品决定：分叉只属于**用户消息**（opencode 语义 —— fork 的目的是「这句话说错了，
       * 拿回输入框重说」，AI 消息没有可回填的原文，分叉出去只会得到一个半截对话）。
       * 官方把 branch 画在 MessageIconActions 里，与 copy 同一行；官方没有开关
       * （ui-chat 的 Config 只有折叠/性能/链接几项），所以只能在渲染层隐藏。
       *
       * 识别方式不用 aria-label（8 种语言各不同），也不用哈希 class，而用
       * **图标路径前缀**：官方 IconBranchOutline16 的 d 是固定字符串
       * （packages/client/ui-primitives/src/icons/index.tsx:149）。作用域限定在
       * `[data-turn-tail]`（官方 TurnTailNodeView 渲染的稳定属性），
       * 并排除我们自己注入的 .mopsUserFork（它复用同一 path）。
       */
      var suppressHostBranch = () => {
        let hidden = 0
        for (const btn of document.querySelectorAll('[data-turn-tail] button')) {
          if (!isHostBranchButton(btn)) continue
          hidden++
          if (btn.getAttribute('data-mops-host-branch') !== 'hidden') {
            btn.setAttribute('data-mops-host-branch', 'hidden')
            btn.style.display = 'none'
          }
        }
        return hidden
      }

      // 触发：hover / 滚动 / DOM 变化 / 变更事件
      document.addEventListener(
        'mouseover',
        e => {
          try {
            if (!e || !e.target || !e.target.closest) return
            if (!__currentSessionId) return
            const block = e.target.closest('[class*="Sixlwa_userRow"], [data-chat-flow-kind="user"]')
            if (!block) return
            ensureUserActions(block)
            if (!block.hasAttribute('data-mops-seq')) ensureAssign(__currentSessionId)
          } catch {
            /* noop */
          }
        },
        { passive: true },
      )
      window.addEventListener('scroll', scan, { passive: true })
      try {
        // 0.9.7（P1-2）回调过滤 + maxWait。
        // ① 过滤：整个 document.body 的 childList 海量 mutation（流式文本、
        //    chunk 重排）里，绝大多数与「打标 / 藏行」无关。只认本插件真正
        //    关心的四类节点。🔴 判据宁可**漏判放行**（多扫一次 ~0.4ms）也不可
        //    误杀 —— 漏了就是「遮蔽行不更新」。新增子树可能是祖先容器，
        //    matches() 与 querySelector() 两者都试；过滤自身抛错一律放行。
        // ② 防抖 trailing 200ms + maxWait 1000ms：纯 trailing 在连续 mutation
        //    下会**无限推迟**，流式输出时新挂载的遮蔽行会长时间保持可见 ——
        //    这是正确性问题，不只是性能。
        // ③ attributeFilter 只盯 data-chat-node-key：本插件不写该属性（写的是
        //    data-mops-seq / hidden），所以不会被自己触发成环。
        var MO_SEL = '[data-chat-node-key],[data-chat-flow-kind="user"],[class*="xzv4MW_actions"],[class*="_userRow"],[data-turn-tail]'
        var scanPendingSince = 0
        var scheduleScan = () => {
          var now = Date.now()
          if (!scan._t) {
            scanPendingSince = now
          } else if (now - scanPendingSince >= 1000) {
            clearTimeout(scan._t)
            scan._t = null
            scanPendingSince = 0
            scan()
            return
          }
          clearTimeout(scan._t)
          scan._t = setTimeout(() => {
            scan._t = null
            scanPendingSince = 0
            scan()
          }, 200)
        }
        var mo = new MutationObserver(records => {
          try {
            for (var i = 0; i < records.length; i++) {
              var rec = records[i]
              if (rec.type === 'attributes') {
                var tgt = rec.target
                if (tgt && tgt.nodeType === 1 && typeof tgt.matches === 'function' && tgt.matches(MO_SEL)) {
                  scheduleScan()
                  return
                }
                continue
              }
              var added = rec.addedNodes
              for (var j = 0; j < added.length; j++) {
                var n = added[j]
                if (!n || n.nodeType !== 1) continue
                if (
                  (typeof n.matches === 'function' && n.matches(MO_SEL)) ||
                  (typeof n.querySelector === 'function' && n.querySelector(MO_SEL))
                ) {
                  scheduleScan()
                  return
                }
              }
            }
          } catch {
            scheduleScan()
          }
        })
        mo.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['data-chat-node-key'],
        })
      } catch {
        /* noop */
      }
      window.addEventListener(CHANGED_EVENT, () => {
        try {
          document.querySelectorAll('[data-mops-seq]').forEach(b => b.removeAttribute('data-mops-seq'))
        } catch {
          /* noop */
        }
      })
      // 样式：与官方 action 按钮同款（28px、ghost），可见性继承宿主动作行
      try {
        if (!document.getElementById('dsh-message-ops-user-revert-style')) {
          const tag = document.createElement('style')
          tag.id = 'dsh-message-ops-user-revert-style'
          tag.textContent = [
            // 不再用 absolute + :hover：按钮作为宿主动作行的子元素，
            // 由宿主 [data-actions-reveal] 统一控制显隐（触屏也跟着宿主走）。
            // 0.16.0 视觉对齐 opencode（sst/opencode @82229fb7 实测规格）：
            //   · 图标 14px / 描边 1.2（opencode IconButton size="small"）
            //   · 颜色 #808080（--v2-icon-icon-muted，映射到 DSH 的 label-tertiary）
            //   · 圆角 4px（opencode）而非宿主默认 6px —— 按钮本身是我们注入的，
            //     radius 可自由设置；只有 28px 尺寸受宿主动作行高度物理约束
            //     （宿主 .xzv4MW_actions 已定 height:28px，改小会撑裂行高）。
            //   · 无淡入动画（opencode 源码注释明写 "Hover actions show and hide
            //     at once, without a fade"）—— 显隐完全交给宿主 [data-actions-reveal]。
            '.mopsUserRevert,.mopsUserFork{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:4px;background:transparent;color:var(--dsw-alias-label-tertiary,#808080);cursor:pointer;padding:0;flex:none}',
            '.mopsUserRevert svg,.mopsUserFork svg{width:14px;height:14px;display:block}',
            '.mopsUserRevert:hover,.mopsUserFork:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));color:var(--dsw-alias-label-secondary,#6b6b70)}',
            '.mopsUserRevert:disabled,.mopsUserFork:disabled{opacity:.4;cursor:default;background:transparent}',
            '.mopsUserRevert:focus-visible,.mopsUserFork:focus-visible{outline:2px solid var(--dsw-alias-border-l2,#b8b8b8);outline-offset:1px}',
            // 0.18.0：用户反馈「点时间图标也会回撤」——根因不是绑定错误，而是
            // 我们的按钮被 appendChild 到宿主 .actions 行末尾，而该行在
            // data-clock="start"（用户消息）时第一个子元素就是**时间文本**：
            //   [时间文本 padding-right:12px] 8px [复制] 8px [回滚][编辑][分叉]
            // 触屏上 28px 按钮的命中区紧贴时间文本，点时间很容易滑到回滚上。
            // 修：给插件按钮组加一道**视觉与命中分隔**（左侧细线 + 额外间距），
            // 让"消息元信息（时间/复制）"和"破坏性操作"在视觉上分成两组。
            '.mopsUserRevert:first-of-type{margin-left:10px;position:relative}',
            '.mopsUserRevert:first-of-type::before{content:"";position:absolute;left:-9px;top:50%;transform:translateY(-50%);width:1px;height:14px;background:var(--dsw-alias-border-l1,rgba(128,128,128,.28));pointer-events:none}',
            '.mopsUserActionsRow{height:28px;display:flex;align-items:center;gap:8px;margin-left:-6px}',
            '@media (hover:none){.mopsUserActionsRow{opacity:1}}',
          ].join('')
          document.head.appendChild(tag)
        }
      } catch {
        /* style 注入失败不影响功能 */
      }
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
        'display:flex',
        'align-items:center',
        'gap:8px',
        'width:100%',
        'padding:6px 12px',
        'border:none',
        'background:transparent',
        'color:var(--dsw-alias-label-primary,inherit)',
        'font:inherit',
        'font-size:13px',
        'line-height:20px',
        'text-align:left',
        'border-radius:6px',
        'cursor:pointer',
      ].join(';')
      item.innerHTML = branchIconMarkup(16) + '<span></span>'
      item.querySelector('span').textContent = __t('menu.ops')
      item.addEventListener('mouseenter', function () {
        item.style.background = 'var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))'
      })
      item.addEventListener('mouseleave', function () {
        item.style.background = 'transparent'
      })
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
      try {
        ensureSidebarOpsItem()
      } catch (e) {
        /* never crash the UI */
      }
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
          try {
            ensureSidebarOpsItem()
          } catch (e) {
            /* never crash the UI */
          }
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
              isMenu =
                (typeof n.matches === 'function' && n.matches('[role=menu]')) ||
                (typeof n.querySelector === 'function' && n.querySelector('[role=menu]') !== null)
            } catch (e) {
              isMenu = false
            }
            if (isMenu) {
              scheduleEnsure()
              return
            }
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
      } catch {
        /* namespace already registered: keep existing copy */
      }
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
        // 0.11.3：必须同时排除 shadowed。只用 visible 会在「回滚刚落盘、索引还没刷新」
        // 的窗口里再次选中已被遮蔽的 seq → 服务端 409
        // `surface replace: start seq N not found in surface`（实测 2026-10-25）。
        if (r && r.seq != null && r.visible && r.shadowed !== true) return r
      }
      return null
    }

    /** 执行 undo/redo。返回 true 表示确实动过盘。 */
    /** __currentSessionId 来自 DOM dataset，可能带 `session-` 前缀；API 只要裸 uuid。 */
    var bareSessionId = id => String(id || '').replace(/^session-/, '')
    /** 写盘成功后的统一收尾：通知、刷新、重放隐藏。 */
    /**
     * 写盘成功后的统一收尾。
     *
     * ⚠️ `rawSid` 必须是**带 `session-` 前缀**的 id：`uiWorkspace.openSession`
     * 内部 `sessions.retain(bare)` 只认 `session-<uuid>`（manager.js resolveTarget），
     * 传裸 uuid 会抛 `unknown session <bare>` —— 而外层 `catch { }` 静默吞掉，
     * 结果「视图重建」这条路径**从来没生效过**，只剩 150/700/1600ms 的 DOM 打补丁。
     * 本文件其它调用点（对话框 :403、:684、:858、:1229）传的都是带前缀的，
     * 只有 /undo /redo 因为先 `bareSessionId` 而传错。
     */
    var afterWrite = (rawSid, okMsg) => {
      notifyDone(okMsg)
      // emitChanged = 作废消息读缓存 + 清 rowsCache TTL + 广播 CHANGED
      // （dock 重拉 / 已打标 seq 摘牌），一次写只做一次。
      emitChanged()
      try {
        if (__uiWorkspace && typeof __uiWorkspace.openSession === 'function') __uiWorkspace.openSession(rawSid)
      } catch (e) {
        if (window.__MOPS_DEBUG) console.warn('[message-ops] openSession failed:', e)
      }
      const bare = bareSessionId(rawSid)
      for (const delay of [150, 700, 1600])
        setTimeout(() => {
          if (__refreshSurface) __refreshSurface(bare)
        }, delay)
    }

    /**
     * 回填 composer（opencode 语义：回滚后把被删掉的那句原文还给输入框）。
     *
     * 0.9.6 统一出口 —— 此前「5 个入口只有 2 个回填」的事故史见 README「历史事故记录」#5。
     *
     * 0.11.3 修「回滚成功但输入框还是空的」：
     *   宿主 `inputActions.setDraft()` **只改编辑器，不落 localStorage**；
     *   只有 `persistDraft()`（→ 内部 persistCurrentDraft）才写
     *   `dsh.conversation.<sessionId>`。而所有回滚入口紧接着都调
     *   `openSession()` 重挂会话视图，挂载时 shell 会
     *   `setDraft(readConversationDraft(sessionId))` —— 从 localStorage 重读。
     *   于是刚回填的文本被旧草稿（常见为空）覆盖回去，用户看到的就是空输入框。
     *   修法：回填后立刻 `persistDraft()` 落盘，让重建读到的就是同一份草稿。
     *
     * 取文本规则：rowsCache 里 seq <= boundary 的最后一条带 fullText 的行。
     *   - /undo        → boundary 就是被回滚的那条用户消息 → 取到它自己 ✓
     *   - AI 时钟按钮  → boundary 是 AI 消息 seq → 取到它之前那条用户消息 ✓
     * 会话不匹配时直接放弃（不跨会话写，避免串台）。
     */
    /**
     * 回滚成功后立刻把本地行缓存标成已遮蔽（0.17.0 · 冲突 C2）。
     *
     * 为什么必须做：回滚成功后到视图刷新完成之间有一个窗口期，
     * `rowsCache.rows[*].shadowed` 还是旧值。此时用户再点同一行按钮
     * （或另一行更靠后的），`runUserRevert` 会拿**已被遮蔽的 seq** 去
     * POST /revert → 服务端 409 `start seq N not found in surface`。
     *
     * 原先只有 `/undo` 路径（`runUndo`）做了这件事，按钮路径漏了 ——
     * 同一语义两套实现、其中一套少了护栏。这里抽成共享函数，两条路径都调。
     *
     * @param boundarySeq - 本次回滚的目标 seq；>= 它的都已不可再回滚
     */
    var markRowsShadowedFrom = boundarySeq => {
      const cache = __peekRowsCache ? __peekRowsCache() : null
      if (!cache || !Array.isArray(cache.rows)) return
      for (const r of cache.rows) {
        if (r && typeof r.seq === 'number' && r.seq >= boundarySeq) r.shadowed = true
      }
      cache.at = 0
    }

    var refillComposer = (rawSid, boundarySeq) => {
      try {
        const cache = __peekRowsCache ? __peekRowsCache() : null
        if (!cache || !Array.isArray(cache.rows)) return false
        const want = bareSessionId(rawSid)
        if (bareSessionId(cache.sid) !== want) return false
        const rows = cache.rows.filter(r => r && typeof r.seq === 'number' && r.seq <= boundarySeq && r.fullText)
        if (!rows.length) return false
        const text = rows[rows.length - 1].fullText
        // ── 0.14.0（回填失效修复）────────────────────────────────────────────
        // 旧实现：`__inputActions.setDraft(text)` + `persistDraft()`，然后调用方
        // **紧接着** `openSession(sid)` 重建整个会话视图。重建会卸载并重挂
        // 编辑器，新挂载走 `readConversationDraft(sid)` 从 localStorage 初始化 ——
        // 也就是说「回填」实际取决于 persistDraft 是否成功落盘，而再叠上
        // `bindDraftPersistence` 的时序（见 0.13.1 MED-4），失败时
        // 用户看到「已回滚」却拿不到原文。
        //
        // 唯一无竞态的路径：**直接写宿主的草稿存储键**（writeSessionDraft），
        // 与 fork 回填同一机制。它是 openSession 之后读到的权威值，不依赖
        // 编辑器是否已挂载、也不依赖 inputActions 此刻绑在哪个会话上。
        const persisted = writeSessionDraft(rawSid, text)
        // 再尽力更新活着的编辑器（视图没重建的路径，例如 dock 内联恢复）。
        let editorSet = false
        if (__inputActions && typeof __inputActions.setDraft === 'function') {
          try {
            __inputActions.setDraft(text)
            editorSet = true
          } catch (e) {
            console.warn('[message-ops] setDraft failed:', e)
          }
        }
        // 诚实返回：落盘成功（openSession 后必能读到）或活着编辑器已更新，任一即为真。
        // 不再用 `|| true` —— 那会让调用方永远看不到失败。
        return persisted || editorSet
      } catch (e) {
        // 原来这里 `catch {}` 完全静默 —— 失败了连痕迹都没有，排查时看不到
        console.warn('[message-ops] setDraft failed:', e)
        return false
      }
    }

    /**
     * /undo —— 回滚最后一条**在模型 surface 上**的用户消息，原文回填输入框。
     * 目标必须是 surface 上的那条：restore 是「重放」语义，副本带新 seq 落在日志
     * 尾部但不在 surface 上，服务端会以 `surface replace: start seq N not found in surface` 拒绝。
     */
    var runUndo = () => {
      const rawSid = __currentSessionId
      const sid = bareSessionId(rawSid)
      if (!sid) {
        notifyDone(__t('undo.none') || '没有可回滚的消息', 'error')
        return false
      }
      const target = lastRevertable()
      if (!target) {
        notifyDone(__t('undo.none') || '没有可回滚的消息', 'error')
        return false
      }
      fetch('/api/message-ops/revert', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: sid, seq: target.seq }),
      })
        .then(async res => {
          const data = await res.json().catch(() => ({}))
          if (!res.ok || !data.ok) throw new Error(data.error || 'HTTP ' + res.status)
          // 0.11.3：立刻把本行标成已遮蔽，否则 afterWrite 的异步刷新窗里
          // 再点一次 /undo 仍会选中同一个 seq → 409。
          markRowsShadowedFrom(target.seq)
          refillComposer(rawSid, target.seq) // 先回填，再重建视图（与对话框一致）
          afterWrite(rawSid, __t('undo.done.undo'))
        })
        .catch(reason => notifyDone(__t('errorPrefix') + (reason && reason.message ? reason.message : String(reason)), 'error'))
      return true
    }

    /**
     * /redo —— 恢复**最新一条未恢复的 marker**。
     *
     * ⚠️ 0.9.5 修正：先前把 `lastRevertable()`（用户**消息** seq）传给 /restore，
     * 但 `opsRestore` 走 `planRestore(events, restoreSeq)` —— 它要的是 **marker seq**
     * （dock 传的 row.seq 就来自 activeMarkers）。传消息 seq 会找不到 marker 空转。
     */
    var runRedo = () => {
      const rawSid = __currentSessionId
      const sid = bareSessionId(rawSid)
      if (!sid) return false
      fetchMessagesJson('/api/message-ops/messages?sessionId=' + encodeURIComponent(sid))
        .then(d => {
          if (!d || !d.ok) throw new Error((d && d.error) || 'messages unavailable')
          const markers = activeMarkers(d.messages || [])
          if (!markers.length) {
            notifyDone(__t('undo.none.redo') || '没有可恢复的回滚', 'error')
            return null
          }
          const mk = markers[markers.length - 1] // 最新一条未恢复标记
          return fetch('/api/message-ops/restore', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: sid, seq: mk.seq }),
          }).then(async res => {
            const data = await res.json().catch(() => ({}))
            if (!res.ok || !data.ok) throw new Error(data.error || 'HTTP ' + res.status)
            // afterWrite 契约：rawSid 必须带 session- 前缀（传裸 uuid 会抛
            // `sessions.retain: unknown session` 并被外层 catch 静默吞掉）
            afterWrite(rawSid, __t('undo.done.redo'))
          })
        })
        .catch(reason => notifyDone(__t('errorPrefix') + (reason && reason.message ? reason.message : String(reason)), 'error'))
      return true
    }

    var runUndoRedo = kind => (kind === 'redo' ? runRedo() : runUndo())

    /** 注册 /undo /redo 到官方斜杠管线。服务缺失时安静 no-op。 */
    var __undoRegistered = false
    var doRegisterUndoSlash = (ctx, it) => {
      if (__undoRegistered || !it || typeof it.registerSource !== 'function') return
      __undoRegistered = true
      try {
        ctx.effect(() =>
          it.registerSource({
            trigger: '/',
            name: __undoSourceName,
            order: 20,
            showGroupTitle: true,
            // ⚠️ 必须返回 **Promise**：宿主在 InputTriggerController.fetchCandidates 里
            //    直接 `source.candidates(...).then(...)`，同步返回数组会抛
            //    `source.candidates(...).then is not a function`，整个菜单静默失效。
            candidates: async (session, req) => {
              const q = String((req && req.query) || '')
                .trim()
                .toLowerCase()
              return UNDO_CANDIDATES.filter(c => !q || c.name.includes(q)).map(c => ({
                name: c.name,
                icon: c.icon,
                label: c.name === 'undo' ? __t('undo.label') || '回滚上一条消息' : __t('redo.label') || '恢复上一条被回滚的消息',
                description:
                  c.name === 'undo'
                    ? __t('undo.desc') || '移除最后一条用户消息，原文回填输入框'
                    : __t('redo.desc') || '把回滚掉的消息重新放回对话',
                value: c.value,
              }))
            },
            onPick: pick => {
              const v = pick && pick.candidate && pick.candidate.value
              if (v !== 'undo' && v !== 'redo') return undefined
              runUndoRedo(v)
              return 'handled'
            },
            // Enter 直接执行：`/undo` 不必先在菜单里选中
            matchEnter: (session, line) => {
              const t = String(line || '')
                .trim()
                .toLowerCase()
              if (t !== '/undo' && t !== '/redo') return undefined
              runUndoRedo(t === '/redo' ? 'redo' : 'undo')
              return 'handled'
            },
          }),
        )
      } catch (e) {
        __undoRegistered = false
        if (window.__MOPS_DEBUG) console.warn('[message-ops] /undo 注册失败:', e)
      }
    }

    var registerUndoSlash = ctx => {
      // ⚠️ cordis 的 inject 回调**第一个参数是服务本身**，不是 ctx。
      //    早先写成 `registerUndoSlash(sub.ctx || sub)` → 在服务对象上找 .get
      //    必然是 undefined → 静默不注册（表现为 /undo 根本不出现）。
      const it = typeof ctx.get === 'function' ? ctx.get('inputTriggers') : null
      if (it) {
        doRegisterUndoSlash(ctx, it)
        return
      }
      try {
        // ⚠️ cordis inject 回调收到的是**注入命名空间**，服务在其同名字段下
        //    （与本文件 `ctx.inject(['uiWorkspace'], sub => sub.uiWorkspace || sub)` 同模式）。
        //    直接把 sub 当服务用会抛 `cannot get property "registerSource" without inject`。
        ctx.inject(['inputTriggers'], sub => {
          doRegisterUndoSlash(ctx, sub && (sub.inputTriggers || sub))
        })
      } catch (e) {}
    }

    function apply(ctx) {
      __sessionsSvc = ctx.get('sessions')
      __uiWorkspace = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null
      if (!__uiWorkspace) {
        try {
          ctx.inject(['uiWorkspace'], sub => {
            __uiWorkspace = sub.uiWorkspace || sub
          })
        } catch {
          /* 0.1.x 无此服务 */
        }
      }
      if (!__sessionsSvc) {
        ctx.inject(['sessions'], sub => {
          __sessionsSvc = sub.sessions
        })
      }
      registerUndoSlash(ctx)
      adoptLocale(ctx.get('locale'), ctx)
      if (!__locale) {
        ctx.inject(['locale'], sub => {
          adoptLocale(sub.locale, ctx)
          refreshSidebarOpsLabel()
        })
      }
      ctx.on('locale/change', refreshSidebarOpsLabel)
      if (window.__MOPS_DISABLE_HEADER !== true)
        ctx.slots.inject(SLOT, () =>
          ctx.slots.register(
            {
              name: SLOT,
              id: ROW_ID,
              order: 31,
              ...(__locale ? { locale: NS } : {}),
            },
            OpsButton,
          ),
        )
      // 0.3.0：每条 AI 消息旁的原生回撤按钮（0.1.x 无此槽，inject 自动 no-op）
      ctx.slots.inject(CHAT_ACTIONS_SLOT, () =>
        ctx.slots.register(
          {
            name: CHAT_ACTIONS_SLOT,
            id: CHAT_ACTIONS_ID,
            order: 20,
            ...(__locale ? { locale: NS } : {}),
          },
          MsgSlotActions,
        ),
      )
      // 0.4.0：composer 上方回撤 dock（0.1.x 无此槽自动 no-op）
      ctx.slots.inject(INPUT_DOCK_SLOT, () =>
        ctx.slots.register(
          {
            name: INPUT_DOCK_SLOT,
            id: INPUT_DOCK_ID,
            order: 10,
            ...(__locale ? { locale: NS } : {}),
          },
          RevertDock,
        ),
      )
      ctx.slots.inject(OVERLAY_SLOT, () =>
        ctx.slots.register(
          {
            name: OVERLAY_SLOT,
            id: DIALOG_ID,
            order: 101,
            ...(__locale ? { locale: NS } : {}),
          },
          window.__MOPS_LEGACY_DIALOG === true ? OpsDialog : OpsPanel,
        ),
      )
      installSidebarOps()
      installUserRevertInjector()
    }

    return {
      apply,
      inject: ['slots'],
      __test: { activityTransition, forkBoundaryBefore, isHostBranchButton, writeSessionDraft, HOST_BRANCH_ICON_ID, HOST_BRANCH_D_PREFIX },
    }
  },
})
