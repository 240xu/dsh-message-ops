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
    // 0.26.0：官方 primitives 回到本文件的依赖面（编辑框改用官方定位 / 点外关闭）。
    //
    // 为什么能直接 require：client-modules 的 require 第一分支就是 **platform seed 表**
    // 命中（host shell bundle 的 seed 表显式列了 '@deepseek-ai/dsh-client-ui-primitives'），
    // 与是否在 package.json 的 dsh.client.external 里声明无关。0.20.0 的 IconQuote
    // 已经用同一条路径拿过组件，有实证。
    //
    // 拿不到时不能炸（老宿主 / 测试桩）：两个 hook 退化成**同签名 no-op**，
    // 保证 hooks 调用顺序在所有环境里恒定（条件调用 hook 是 React 的硬违规）。
    let __primitives = null
    try {
      __primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch {
      /* 老宿主：走下面的降级定位；编辑本身不受影响 */
    }
    const useAnchoredPosition = (__primitives && __primitives.useAnchoredPosition) || (() => null)
    const useDismissOnOutsidePointer = (__primitives && __primitives.useDismissOnOutsidePointer) || (() => {})

    const SLOT = 'conversation.session.header.actions'
    const ROW_ID = 'message-ops'
    const OVERLAY_SLOT = 'shell.overlay'
    const INPUT_DOCK_SLOT = 'conversation.input.dock'
    const INPUT_DOCK_ID = 'message-ops-revert-dock'
    const DIALOG_ID = 'message-ops-dialog'
    const EVENT = 'dsh-message-ops:open'
    /**
     * 宿主 CSS-module hash（**单点**，审计 §3.1）。
     *
     * ⚠️ 这是本插件跨版本最脆的一处依赖：这些类名是宿主 CSS module 编译产物，
     * **每个版本都可能变**（README 事故：0.9.0 写死 `Sixlwa_*` 前缀 → 宿主换成
     * `EvIC1a_*` → 锚点集为空 → 按钮拿不到 seq → 点击必失败；`_flowItem` 当兜底
     * → 把官方 turn-tail 当用户消息挂回滚按钮）。现在写法已修正为
     * 「**稳定属性 `data-chat-flow-kind` 优先 + hash-immune 后缀 `_userRow` 兜底**」，
     * 全 hash 只在宿主确实提供、且无法用稳定属性表达的地方用。
     *
     * 新增候选**只加这里**，不许在各调用点各写一份 —— 否则宿主一升级，
     * 4 处漏 1 处 = 「一半按钮挂得上、一半挂不上」。
     * 只收录**真有消费点**的 hash：`Sixlwa_userStack`/`EvIC1a_flowItem`/`TS9iAW_*`
     * 在本文件没有任何全 hash 消费（前两者靠 `_userStack`/`_flowItem` 后缀与稳定属性，
     * 后者宿主换过一轮、我们根本没碰 TurnTailNodeView），收进来就是新的死配置。
     */
    const HOST_CLS = {
      actions: 'xzv4MW_actions', // MessageIconActions.module.css（官方用户消息动作行）
      userRow: 'Sixlwa_userRow', // MessageItem.module.css（用户消息容器）
    }
    // 0.5.2（P2）：回滚/恢复成功后广播 → RevertDock 重拉标记（否则 dock 只在切会话时刷新）
    const CHANGED_EVENT = 'dsh-message-ops:changed'
    // 0.9.7（P0-2 读合并）：一次写操作会同时触发「写后立即一次刷新」+
    // RevertDock 的 CHANGED 重拉 + openSession 后 MO 调度的 scan（5~6 次 GET）。
    // 同一会话在此窗口内的请求共享同一个 promise。
    // 0.25.0（手感）：尾随兜底刷新由 __refreshSurface 的 300ms 防抖承担，且它拉取前
    // 会先 invalidateMessagesMemo() 强制走真网络 —— 所以本窗口值不再与刷新时机挂钩。
    const MSG_COALESCE_MS = 1000
    var __messagesMemo = { url: null, at: 0, p: null, settled: false }
    var invalidateMessagesMemo = () => {
      __messagesMemo = { url: null, at: 0, p: null, settled: false }
    }

    /**
     * 统一读 `/api/message-ops/*` 响应体（审计 §2.4 单点）。
     *
     * 改前有**三套**写法：`res.json().catch(() => null)`（6 处）、
     * `.catch(() => ({}))`（2 处）、`try { ... } catch {}`（2 处）。其中
     * `catch(() => null)` 把「服务端返回非 JSON 的 500 页面」与「返回了 JSON 但
     * `ok:false`」压成同一个 `null` → 真正的 `data.error` 丢了 → 写操作
     * （revert / restore）的用户可见文案坍缩成 `HTTP 500`，看不到「会话正在运行」
     * 这类真原因。
     *
     * 本函数**只负责读**：恒返回对象（解析失败 / 空 body = `{}`），**绝不抛、绝不
     * null** —— 调用方才能统一按 `data.error || 'HTTP ' + status` 拼文案。
     * 成功判定统一走 `ok`（HTTP 2xx **且** 业务 `data.ok === true`，服务端所有
     * 路由成功都回 `{ ok: true, ... }`）。
     *
     * ⚠️ 它**不**替代 fetch、不判 409、不碰 AbortController —— `setTarget(running:true)`
     * 这类组件语义分支仍留在各调用点（审计 §6.1：万能 `fetchOpsJson` 不值得抽）。
     *
     * @returns {Promise<{ok: boolean, status: number, data: object}>}
     */
    var readOpsJson = async res => {
      let data = null
      try {
        data = await res.json()
      } catch {
        /* 非 JSON 响应（网关 HTML 500 页 / 空 body）：按空对象处理，别丢 round-trip */
      }
      if (!data || typeof data !== 'object') data = {}
      return { ok: res.ok === true && data.ok === true, status: Number(res.status) || 0, data }
    }

    /**
     * 把任意 catch 值转成用户可读文案（审计 §3.4 单点：原先同一表达式写 13 遍）。
     *
     * @param reason - catch 到的任意值（Error / string / undefined）
     * @param prefix - 前置文案（通常是 `t('errorPrefix')` / `t('panel.loadFail')`）
     */
    var errText = (reason, prefix) => String(prefix || '') + (reason && reason.message ? reason.message : String(reason))

    /** 统一失败出口：服务端文案优先，退 `HTTP <status>`（`status` 为 0 时退 `?`）。 */
    var opsError = (status, data) => new Error((data && data.error) || 'HTTP ' + (status || '?'))
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
    /**
     * 0.25.0（手感）面板全文取数层：缓存 + 尾随防抖 + 单飞。
     *
     * 改前：面板 `pick` 每选中一条就直连一次 `GET /api/message-ops/text`，
     * 无缓存、无防抖 —— 用 ↑/↓ 连续划过列表时按条发请求（服务端每条都要
     * 解析一次会话日志），而用户真正停下来看的只有最后那一条；回看同一
     * seq 也照样重打一遍。
     * 改后：① 命中过的 `sid|seq` 零请求；② 150ms 尾随防抖，快速划过时只发
     * 停下来的那一条；③ 同 key 在途请求共享同一个 promise（不重复发）。
     *
     * 失效：`emitChanged()`（任何写操作后全文都可能变）清空整张表；缓存键
     * 带 sessionId，切会话天然隔离。**只缓存成功拿到的非空全文** —— 失败
     * 不缓存，否则一次网络抖动会把详情永久钉在 snippet 上（MED-5 红线：
     * snippet 不许冒充原文，失败时由调用方回退并保持「这不是全文」的语义）。
     */
    const PANEL_TEXT_DEBOUNCE_MS = 150
    var __panelTextCache = new Map()
    var __panelTextInflight = new Map()
    var __panelTextPending = null
    const clearPanelTextCache = () => {
      __panelTextCache.clear()
      __panelTextInflight.clear()
      if (__panelTextPending) {
        clearTimeout(__panelTextPending.timer)
        __panelTextPending.resolve(null)
        __panelTextPending = null
      }
    }
    var loadPanelText = (sessionId, seq) => {
      const sid = String(sessionId == null ? '' : sessionId)
      if (!sid || seq == null) return Promise.resolve(null)
      const key = sid + '|' + String(seq)
      const hit = __panelTextCache.get(key)
      if (hit != null) return Promise.resolve(hit)
      const inflight = __panelTextInflight.get(key)
      if (inflight) return inflight
      // 尾随防抖：被更新的一次选择取代时，上一次的 promise 以 null 收尾
      // （调用方本来就按 detailReq 竞态序号丢弃过期结果）。
      if (__panelTextPending) {
        clearTimeout(__panelTextPending.timer)
        __panelTextPending.resolve(null)
        __panelTextPending = null
      }
      return new Promise(resolve => {
        const timer = setTimeout(() => {
          __panelTextPending = null
          const url = '/api/message-ops/text?sessionId=' + encodeURIComponent(sid) + '&seq=' + encodeURIComponent(seq)
          const started = fetch(url)
            .then(readOpsJson)
            .then(r => {
              if (!r.ok) throw opsError(r.status, r.data)
              const full = typeof r.data.text === 'string' && r.data.text !== '' ? r.data.text : null
              if (full != null) __panelTextCache.set(key, full)
              return full
            })
            .catch(() => null)
          __panelTextInflight.set(
            key,
            started.then(text => {
              __panelTextInflight.delete(key)
              return text
            }),
          )
          started.then(resolve)
        }, PANEL_TEXT_DEBOUNCE_MS)
        __panelTextPending = { key, timer, resolve }
      })
    }
    const emitChanged = () => {
      // 数据变了：连同本地缓存一起作废（否则 8s TTL 会让 openSession 后的
      // scan 拿旧 payload 重算隐藏 = 「回滚了但界面没变」）。
      clearPanelTextCache()
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
     * - 尾随兜底刷新（`__refreshSurface` 的 300ms 防抖）自己先 `invalidateMessagesMemo()`
     *   再拉，保证是真网络。
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
        .then(readOpsJson)
        .then(r => {
          if (!r.ok) throw opsError(r.status, r.data)
          entry.settled = true
          entry.at = Date.now()
          return r.data
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
      'slot.revert': '回滚到此条',
      'slot.revertPrivacyHint': '回滚到此条（不是删除：AI 看不到，但原文仍在本地会话文件）',
      'slot.revertUnmatched': '在日志里定位不到这条消息的 seq（通常是模型写的摘要与渲染文本偏差过大）——请改用「消息操作」对话框。',
      'slot.forkUnavailable': '分叉不可用：会话正在运行，或宿主未提供 session/fork',
      // 0.24.0（P3 入口收敛）：改名消除与外部插件 message-edit 的「同名不同义」。
      // 外部插件在 turnTail 也叫「编辑并重发」，但它 fork 出新分支、源会话不动；
      // 我们（铅笔）是**回撤源会话**再重发。同名让用户无法预判后果，故显式写出「回撤」。
      'slot.edit': '编辑并回撤重发',
      'slot.editHint': '打开编辑框；点「撤销并发送」会回撤此条及之后的全部可见消息，再把改后文本当新消息发出',
      'slot.editNoText': '这条消息没有可编辑的文本',
      'slot.editUnmatched': '在日志里定位不到这条消息的 seq，暂时无法编辑',
      'edit.title': '编辑并回撤重发',
      'edit.subtitle': '这条消息 · seq #{seq}',
      'edit.loading': '正在读取原文…',
      'edit.loadFail': '原文读取失败：',
      'edit.retry': '重试',
      'edit.placeholder': '编辑这条消息…',
      'edit.cancel': '取消',
      'edit.send': '撤销并发送',
      'edit.sending': '撤销并发送中…',
      'edit.resend': '重新发送',
      'edit.sendFailed': '回撤已生效，但发送被拒：',
      'edit.empty': '内容为空，无法发送',
      'edit.failed': '回撤失败：',
      'edit.doneSubmitted': '已回撤，改后的消息已提交',
      'edit.manual': '已回撤，改后的文本已放进输入框——请按回车发送',
      'edit.running': '会话正在运行：可以先改文字，但要等它停下来才能撤销并发送',
      'edit.replaceHint':
        '发送会先回撤此条及其之后的全部可见消息，再把改后的文本作为新消息发出。注意：这不是删除——AI 看不到被回撤的内容，但原文仍保留在本地会话文件、可被恢复，直接翻看会话文件仍能读到。',
      'edit.shortcut': 'Ctrl/⌘ + Enter 发送 · Esc 取消',
      'done.restore': '恢复完成：重放 {n} 条，跳过不可重放 {s} 条',
      'done.revert': '已回滚，原文可从恢复区放回',
      'done.revertNoRefill': '已回滚，但原文未能放回输入框（会话可能尚未挂载）；可重试或从消息操作面板手动复制',
      errorPrefix: '操作失败：',
      'dock.title': '已回撤 {n} 条消息',
      'dock.expand': '展开回撤列表',
      'dock.collapse': '折叠回撤列表',
      'dock.restore': '恢复',
      'dock.restoreHint': '恢复为重放：消息将出现在会话末尾，不会回到原位',
      'dock.restoring': '恢复中…',
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
      // 0.23.0：隐私告知并入确认正文（原 body 37 字 + privacy 56 字 = 93 字，合并后 55 字）。
      // 告知内容一条没少：AI 看不到 / 原文仍在本地文件 / 可恢复。只是不再分两层说。
      'panel.revertConfirmBody':
        '将遮蔽 #{start}–#{end} 共 {n} 条消息（可见 {v} 条）。AI 将看不到它们，但原文仍保留在本地会话文件、可恢复。',
      'panel.deleteConfirmTitle': '仅删除 #{seq}？',
      'panel.deleteConfirmBody': '将遮蔽这 1 条消息，其他内容不动；日志仍保留，可恢复。',
      'panel.confirmRevert': '确认回滚',
      'panel.confirmDeleteOne': '确认遮蔽',
      'panel.retry': '重试',
      'panel.searching': '搜索中…',
      'panel.deleteSessionImpact': '共 {n} 条消息；移入回收站后 7 天内可恢复。',
      'panel.deleteUnavailable': '会话信息尚未就绪，暂不能删除。',
      'panel.delete': '遮蔽此条',
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
      'panel.deleteDone': '已遮蔽',
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
      'slot.revert': 'Revert to here',
      'slot.revertPrivacyHint': 'Revert to here (not deletion: hidden from the AI, but the original text stays in the local session file)',
      'slot.revertUnmatched':
        'Cannot locate this message seq in the log (usually the model-written summary drifted too far from the rendered text) — use the Message ops dialog instead.',
      'slot.forkUnavailable': 'Branch unavailable: the session is running, or the host provides no session/fork',
      // 0.24.0 (P3): renamed to disambiguate from the third-party message-edit plugin,
      // which also says "Edit and resend" but forks a NEW branch and leaves the source
      // session untouched. This one REVERTS the source session. Same words, opposite
      // consequences — so the revert is now spelled out in the label itself.
      'slot.edit': 'Edit & revert-resend',
      'slot.editHint':
        'Opens the editor. Pressing "Undo and send" reverts this message and every visible message after it, then sends the edited text as a new message.',
      'slot.editNoText': 'This message has no text to edit',
      'slot.editUnmatched': 'Cannot locate this message seq in the log, so it cannot be edited yet',
      'edit.title': 'Edit & revert-resend',
      'edit.subtitle': 'This message · seq #{seq}',
      'edit.loading': 'Loading the original text…',
      'edit.loadFail': 'Could not load the original text: ',
      'edit.retry': 'Retry',
      'edit.placeholder': 'Edit this message…',
      'edit.cancel': 'Cancel',
      'edit.send': 'Undo and send',
      'edit.sending': 'Undoing and sending…',
      'edit.resend': 'Send again',
      'edit.sendFailed': 'The revert went through, but sending was rejected: ',
      'edit.empty': 'Nothing to send — the text is empty',
      'edit.failed': 'Revert failed: ',
      'edit.doneSubmitted': 'Reverted; the edited message has been submitted',
      'edit.manual': 'Reverted; the edited text is in the composer — press Enter to send',
      'edit.running': 'The session is running: edit freely, but Undo and send waits until it stops',
      'edit.replaceHint':
        'Sending reverts this message and every visible message after it, then sends the edited text as a new message. Note: this is not deletion — the AI will not see the reverted content, but the original text stays in the local session file, can be restored, and is still readable by opening that file directly.',
      'edit.shortcut': 'Ctrl/⌘ + Enter to send · Esc to cancel',
      'done.restore': 'Restored: replayed {n}, skipped non-replayable {s}',
      'done.revert': 'Reverted — restore the original from the restore area',
      'done.revertNoRefill':
        'Reverted, but the original text could not be put back in the composer (the view may not be mounted yet); retry or copy it manually from Message Ops',
      errorPrefix: 'Operation failed: ',
      'dock.title': '{n} rolled back messages',
      'dock.expand': 'Expand revert list',
      'dock.collapse': 'Collapse revert list',
      'dock.restore': 'Restore',
      'dock.restoreHint': 'Restores by replay: messages appear at the end of the session, not in their original place',
      'dock.restoring': 'Restoring…',
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
        'Shadows {n} messages (#{start}–#{end}, {v} visible). The AI will no longer see them, but the original text stays in the local session file and can be restored.',
      'panel.deleteConfirmTitle': 'Delete only #{seq}?',
      'panel.deleteConfirmBody': 'This shadows this one message; everything else stays. The log stays append-only and can be restored.',
      'panel.confirmRevert': 'Confirm revert',
      'panel.confirmDeleteOne': 'Confirm hide',
      'panel.retry': 'Retry',
      'panel.searching': 'Searching…',
      'panel.deleteSessionImpact': 'Total {n} messages; recoverable from trash for 7 days.',
      'panel.deleteUnavailable': 'Session details are not ready yet; deletion is disabled.',
      'panel.delete': 'Hide this',
      'panel.deleteHint': 'Shadows only this message',
      'panel.branch': 'Fork from here',
      'panel.branchHint': 'Copy the conversation above this message into a new session and put this message back in the new composer',
      'panel.branchDone': 'Forked: {id}',
      'panel.branchUserOnly': 'Fork works on user messages only (assistant messages have no text to hand back)',
      'panel.openNew': 'Open new session',
      'panel.revertDone': 'Revert applied',
      'panel.deleteDone': 'Hidden',
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
    /**
     * 0.24.0 P4：InputActions **按会话隔离**。
     *
     * 为什么必须隔离：宿主 `conversation.chat.assistant-actions` 槽声明
     * `scope: "session"`（dsh-client-ui-chat:9238），且 `inputActions` 由
     * `inputHub.shellFor(binding).actions` 提供（dsh-client-ui-conversation:22713）。
     * `shellFor` 按 binding 缓存**独立的 SessionInputShell**（:16145-16147），
     * 每个会话的 `.actions` 是不同对象。
     *
     * 旧实现用模块级单变量 `__inputActions`，写入点是 per-session 组件：
     *   · MsgSlotActions —— 每条 AI 消息一个实例
     *   · RevertDock      —— 每个会话一个实例
     * 多会话同时挂载 / 切会话 / HMR 时会被**最后挂载的会话**覆盖，
     * 于是回填、编辑框提交、dock 内联恢复都可能写进**别的会话的 composer**。
     *
     * 现在：`sessionId -> InputActions`。读写一律按会话取，
     * 取不到就走**明确失败路径**，绝不静默退到别的会话。
     * （0.25.0 清理：无 sessionId 的全局兜底变量 `__inputActions` 已删除——
     *   它 0 个读取方，留着只会让后来者以为还有一条「最后一次已知」的退路。）
     */
    var __inputActionsBySession = new Map()

    /** 会话键归一：`session-x` 与 `x` 视为同一会话（宿主两种拼写都会传）。 */
    function sessionKeyOf(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return null
      return sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId
    }

    /**
     * 按会话取 InputActions。
     * @returns 该会话的 InputActions，或 null（调用方必须显式处理 null，不得回退到别的会话）
     */
    function inputActionsFor(sessionId) {
      const key = sessionKeyOf(sessionId)
      if (key == null) return null
      return __inputActionsBySession.get(key) || null
    }

    /** 捕获：会话挂载时登记它自己的 InputActions。 */
    function rememberInputActions(sessionId, inputActions) {
      if (!inputActions || typeof inputActions.setDraft !== 'function') return
      const key = sessionKeyOf(sessionId)
      if (key == null) return
      __inputActionsBySession.set(key, inputActions)
    }

    /** 卸载：只在登记的仍是这一个实例时才删，避免把同会话新挂的实例删掉。 */
    function forgetInputActions(sessionId, inputActions) {
      const key = sessionKeyOf(sessionId)
      if (key == null) return
      if (__inputActionsBySession.get(key) === inputActions) __inputActionsBySession.delete(key)
    }
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
    // 0.25.0 清理：messageId→seq / messageId→全文 两份缓存已删。
    // 它们唯一的读者是 MsgSlotActions 的引用解析（0.23.0 起该插槽 return null），
    // 写入方 syncSeqIndex 也随之删除；dataSig 驱动的失效广播一并退场。
    // 现在 seq 的唯一权威来源是 rowsCache（DOM 注入器自己按会话维护）。

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
    // 0.25.0 清理：React 版 `BranchIcon` 组件已删（0 处渲染）。
    // 分叉几何现在只有一个入口 —— 侧栏菜单用的 `branchIconMarkup()`（innerHTML 场景），
    // 两者原本共用 `BRANCH_PATH` / `BRANCH_STROKE`，删掉组件后常量仍是唯一数据源。
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
          '.mopsPanel{width:560px;max-width:min(560px,100%);height:min(760px,100%);max-height:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f1115);border:1px solid var(--dsw-alias-border-l2,#e6e6e6);box-shadow:0 24px 64px rgba(15,17,21,.24);font-family:inherit;font-size:13px;line-height:1.45;animation:mopsRise .16s cubic-bezier(.2,.8,.3,1)}',
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
          '.mopsChip.on{border-color:var(--dsw-alias-label-primary,#0f1115);background:var(--dsw-alias-label-primary,#0f1115);color:var(--dsw-alias-bg-layer-1,#fff)}',
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
          '.mopsActionConfirm{display:flex;flex-direction:column;gap:7px;margin-top:10px;padding:10px;border:1px solid var(--dsw-alias-border-l2,#e6e6e6);background:var(--dsw-alias-bg-layer-1,#fff)}',
          '.mopsImpactTitle{font-size:12px;font-weight:600}',
          '.mopsImpact{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,#6b6b70)}',
          // 常显隐私告知条：左竖线 + 灰底，与红色错误条区分；不可关闭，避免"勾了就真删"的误解
          '.mopsPrivacyNote{margin-top:2px;padding:6px 9px;border-left:2px solid var(--dsw-alias-label-tertiary,#9a9aa0);background:var(--dsw-alias-bg-layer-2,#efefef);border-radius:0 4px 4px 0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,#6b6b70)}',
          '.mopsAction{height:30px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,#cfcfcf);background:transparent;cursor:pointer;font-size:11px}',
          '.mopsAction:hover:not(:disabled){border-color:var(--dsw-alias-label-primary,#0f1115)}',
          '.mopsAction.primary{border-color:var(--dsw-alias-label-primary,#0f1115);background:var(--dsw-alias-label-primary,#0f1115);color:var(--dsw-alias-bg-layer-1,#fff)}',
          '.mopsAction.danger{border-color:var(--dsw-alias-state-error-primary,#c63b32);color:var(--dsw-alias-state-error-primary,#c63b32)}',
          '.mopsAction:disabled{opacity:.35;cursor:default}',
          '.mopsPanelFoot{flex:none;display:flex;align-items:center;gap:10px;justify-content:space-between;padding:10px 18px;border-top:1px solid var(--dsw-alias-border-l2,#e6e6e6);background:var(--dsw-alias-bg-layer-1,#fff)}',
          '.mopsCount{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a8e)}',
          '.mopsDanger{border:1px solid var(--dsw-alias-state-error-primary,#c63b32);background:transparent;color:var(--dsw-alias-state-error-primary,#c63b32);height:28px;padding:0 9px;cursor:pointer;font-size:11px}',
          '.mopsDanger:hover{background:rgba(198,59,50,.06)}',
          '.mopsBanner{padding:7px 18px;font-size:11px;border-bottom:1px solid var(--dsw-alias-border-l1,#efefef)}',
          '.mopsBanner.warn{color:var(--dsw-alias-state-warn-primary,#9a6500);background:rgba(154,101,0,.06)}',
          '.mopsBanner.err{color:var(--dsw-alias-state-error-primary,#c63b32);background:rgba(198,59,50,.06)}',
          '.mopsBanner.ok{color:var(--dsw-alias-state-success-primary,#2f7d4a);background:rgba(47,125,74,.06)}',
          '.mopsConfirm{position:absolute;inset:0;z-index:2;background:var(--dsw-alias-bg-layer-1,#fff);display:flex;flex-direction:column;justify-content:center;padding:28px 24px;gap:10px}',
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
            const message = errText(reason, t('panel.loadFail'))
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
            .then(readOpsJson)
            .then(r => {
              if (cancelled) return
              if (!r.ok) throw opsError(r.status, r.data)
              setHits(Array.isArray(r.data.results) ? r.data.results : [])
              setError(null)
            })
            .catch(reason => {
              if (!cancelled) setError(errText(reason, t('panel.searchFail')))
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
          // 竞态门是组件语义（requestId 是 hook state），保留在调用点；
          // 只把「读响应体 + 校验 + 转文案」换成单点（审计 §2.4）。
          const r = await readOpsJson(await fetch('/api/message-ops/session/trash'))
          if (requestId !== trashSeqRef.current) return
          if (!r.ok) throw opsError(r.status, r.data)
          setTrash(Array.isArray(r.data.entries) ? r.data.entries : [])
          setTrashError(null)
          setTrashState('ready')
        } catch (reason) {
          if (requestId !== trashSeqRef.current) return
          setTrashError(errText(reason, t('panel.loadFail')))
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
          // 0.25.0（手感）：全文取数交给 loadPanelText —— 命中缓存零请求、
          // 快速划过列表只发停下来的那一条、同 seq 在途共享。竞态仍由
          // detailReq 把关（过期结果一律丢弃）。
          loadPanelText(sid, m.seq).then(full => {
            if (req !== detailReq.current) return
            // 失败（null）→ 只有截断的 snippet，不许冒充原文（MED-5）
            setDetail(full ?? (m.snippet || ''))
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
            // 0.26.0：统一走 safeOpenSession（失败 warn，不静默吞 —— 审计 §2.3）
            safeOpenSession(target.sessionId, 'panel-action')
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
      // 0.20.0（bug-hunt H-1 / M-3）：AI 消息回滚已在 0.19.0 从动作区下线
      // （用户明确要求「回撤是用户消息那边的用处」）。面板不能留一个
      // 「能回滚 AI 消息却静默不回填」的旁路，故回滚按钮同样限定为用户消息。
      // 删除按钮仍用 canAct —— 删单条 AI 消息是合理能力，不受此限。
      const canRevert = canAct && pickedLive && pickedLive.role === 'user'
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
                          safeOpenSession(childId, 'panel-branch')
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
                              disabled: !canRevert || !!confirmAction,
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

    // --- 0.26.0 · 「编辑并回撤重发」的编排层 -------------------------------------
    //
    // 语义（用户原话：干净的定制编辑框，就在那条消息旁边弹出，然后发送）：
    //
    //   点铅笔 → **纯读**：GET /text 取全文，在贴着该消息的浮层里改文字。零写操作。
    //   取消 / Esc / 点外面 → 只清本地 state。零 fetch、零写盘、零 openSession。
    //   点「撤销并发送」这一刻才写，顺序严格如下：
    //     ① POST /api/message-ops/revert { sessionId, seq }
    //          失败（含 409 运行中）→ 保留浮层与用户已改的文本，报错，**零副作用**
    //     ② markRowsShadowedFrom(seq)  —— 与其它回滚入口共用同一个防 409 护栏
    //     ③ emitChanged + openSession  —— 视图重建（遮蔽才立即可见）
    //     ④ sessions.using(...).prompt([{ type: 'text', text }], 'queue')
    //          —— 官方发送面。失败按 error.code/message 上抛，**不再**假成功
    //
    // 为什么删掉 0.20~0.25 的「写草稿 + 轮询 inputActions.submit」：
    //   老路径要先写 localStorage 草稿 → 重建视图 → 等宿主重挂编辑器（8×120ms 有界
    //   轮询）→ 再 setDraft + submit()。它有两个副作用：①改后的文本**留在 composer**
    //   （用户发完还看得见同一段字，正是「UI 上又复现一遍」）；②轮询期间宿主任何重渲染
    //   都可能让 submit 打到已 dispose 的实例。官方 `sessions.using` + `session.prompt`
    //   是宿主自己的发送面：排队语义由宿主保证，失败有结构化 error code。
    //
    // 老宿主降级（sessions 服务 / session.prompt 缺席）：**唯一**兜底 = 把文本写进该
    // 会话草稿并回读校验，再提示按回车（edit.manual）。只有这一条，绝不复制第二套
    // composer 逻辑。降级路径返回 persisted，组件据此选择文案。
    //
    // 为什么不用 fork：「分叉」的语义是源会话一字不动；同一个「编辑」动作若在铅笔里
    // 改写源会话、在分叉里保留源会话，就是两套相反语义 —— 用户无法预期。
    const EDIT_EVENT = 'dsh-message-ops:edit'
    const EDIT_ID = 'message-ops-edit-resend'
    const EDIT_STYLE_ID = 'dsh-message-ops-edit-style'
    /** 视口边距 / 与锚点的间距：与官方 Menu 的 PANEL_MARGIN / PANEL_GAP 对齐。 */
    const EDIT_PANEL_MARGIN = 12
    const EDIT_PANEL_GAP = 8
    /** 浮层宽度跟随目标消息块，落在 280~560 之间（不再是固定 560 居中模态）。 */
    const EDIT_PANEL_MIN_WIDTH = 280
    const EDIT_PANEL_MAX_WIDTH = 560
    /** 锚点下方空间不足这个预算就上翻（官方 useAnchoredPosition 只 clamp、不翻转）。 */
    const EDIT_FLIP_MIN_HEIGHT = 260
    /**
     * 官方 session 引用来源标签。
     *
     * `SessionReferenceSource` 是**声明合并可扩展**的开放表（宿主只内置
     * controllerOperation / gateway 两项），第三方插件自报一个标签是官方允许的用法
     * （第三方 message-edit 插件同样用 'messageEdit'）。它只进 retainedBy 计数，
     * 运行时**不做白名单校验**（已读 dsh-api-session-controller 的 retainScope 源码）。
     */
    const EDIT_SOURCE = 'messageEdit'

    /**
     * 浮层落座决策（**纯函数**，可真执行断言）。
     *
     * 官方 `useAnchoredPosition` 只做视口 clamp，**不翻转**（已读 shell bundle 里的
     * 实现：算完 top/bottom 后只有 Math.min/max，没有 side 切换）。所以「下方空间不够
     * 就上翻」由本层决定，再把 side 交给官方 hook —— 定位本身仍由官方实现，
     * 我们只补一个官方没有的输入。
     *
     * @param anchorRect - 目标消息块的 getBoundingClientRect 快照（只需 top/bottom/width）
     * @param viewport - { width, height }
     * @returns { side: 'bottom'|'top', width, gap, margin }
     */
    function editSeatOf(anchorRect, viewport) {
      const rect = anchorRect || {}
      const vw = Math.max(0, Number(viewport && viewport.width) || 0)
      const vh = Math.max(0, Number(viewport && viewport.height) || 0)
      const anchorBottom = Number(rect.bottom) || 0
      const anchorWidth = Number(rect.width) || 0
      // 锚点完全滚出视口（长会话里很常见）→ 判定为「不可锚定」，由调用方退回屏幕中央。
      // 不看这条的话，官方 clamp 会把面板贴到视口顶/底，用户会以为它「飘」到别处。
      const inView = Number(rect.top) < vh && anchorBottom > 0
      // 下方剩余空间 = 视口底 - 消息块底。够 260px 就往下挂（用户最常改的是最后一条）；
      // 往下挂会盖住 composer 时翻到上方。
      const side = vh - anchorBottom >= EDIT_FLIP_MIN_HEIGHT ? 'bottom' : 'top'
      // 宽度**跟随消息块**（用户要的「贴着那条消息」），但不无限拉宽、也不窄到没法编辑。
      const wanted = Math.max(EDIT_PANEL_MIN_WIDTH, Math.min(EDIT_PANEL_MAX_WIDTH, anchorWidth))
      const room = vw - EDIT_PANEL_MARGIN * 2
      const width = Math.max(EDIT_PANEL_MIN_WIDTH, Math.min(wanted, Math.max(EDIT_PANEL_MIN_WIDTH, room)))
      return { side: side, width: width, gap: EDIT_PANEL_GAP, margin: EDIT_PANEL_MARGIN, inView: inView }
    }

    /**
     * 官方发送面：`sessions.using(target, { source }, ref => ref.binding.session.prompt(...))`。
     *
     * 为什么手写 using 而不是 retain/release：官方 `using` 的实现就是
     * `retain()` → `await reference.ready` → `operation()` → **`finally release()`**
     * （已读 dsh-api-session-controller/lib/client.js）。自己 retain 就得多写一遍
     * release，失败路径更容易漏 —— 漏了就是 scope 永远不回收。
     *
     * 为什么 `prompt(..., 'queue')`：queue = 追加一轮，steer = 打断当前轮。回撤之后
     * 会话本来就在等新输入，queue 是官方的「接着跑一轮」语义（与宿主 composer 回车
     * 同一条 API）。运行中会话的回撤会被服务端 409 拦住（见 ①），所以不需要 steer 抢跑。
     *
     * @param text - 改后的文本
     * @param options - { rawSessionId, sessions }
     * @returns { ok, accepted?, unavailable?, reason? }
     */
    async function promptEditedText(text, options) {
      const opts = options || {}
      const rawSessionId = String(opts.rawSessionId || '').trim()
      const sessions = opts.sessions || __sessionsSvc
      if (!sessions || typeof sessions.using !== 'function') {
        return { ok: false, unavailable: true, reason: 'sessions service unavailable' }
      }
      try {
        return await sessions.using(rawSessionId, { source: EDIT_SOURCE }, async reference => {
          if (reference && reference.ready) await reference.ready
          const face = reference && reference.binding ? reference.binding.session : null
          if (!face || typeof face.prompt !== 'function') {
            return { ok: false, unavailable: true, reason: 'session.prompt unavailable' }
          }
          let result = null
          try {
            result = await face.prompt([{ type: 'text', text: text }], 'queue')
          } catch (e) {
            return { ok: false, reason: e && e.message ? e.message : String(e) }
          }
          if (!result || result.ok !== true) {
            const err = result && result.error
            return { ok: false, reason: (err && (err.code || err.message)) || 'prompt rejected' }
          }
          return { ok: true, accepted: true }
        })
      } catch (e) {
        // `using` 的 acquisition 失败（未知会话 / generation 已 dispose）也走这里。
        return { ok: false, reason: e && e.message ? e.message : String(e) }
      }
    }

    /**
     * 「撤销并发送」的唯一编排实现。
     *
     * 抽成具名函数（而不是埋在组件里）有两个理由：
     *   1. 时序是本功能的核心契约，必须能被测试**真执行**断言
     *      （revert 失败 → 零 prompt、零草稿、零视图重建）。
     *   2. 组件只负责 UI 状态；失败时「保留文本」由调用方按返回值决定。
     *
     * @param options - { sessionId, rawSessionId, seq, text, deps, reverted }
     *   sessionId    裸 uuid（给 HTTP）
     *   rawSessionId `session-` 前缀（给 sessions.using 与草稿键）；缺省从 sessionId 补
     *   reverted     已经成功回撤过一次（「重新发送」）：跳过 ①~③，直接走 ④。
     *                同一个 seq 再回撤必然 409，所以重试只能重发。
     *   deps         可注入的副作用集合（测试用）；缺省取真实实现
     * @returns Promise<{ok, stage, submitted?, mode?, manual?, persisted?, reason?, status?}>
     *   stage: 'validate' | 'revert' | 'send' | 'done'
     */
    async function sendEditAndRevert(options) {
      const opts = options || {}
      const sessionId = String(opts.sessionId || '').trim()
      // sessions.using 与草稿键都必须用带 `session-` 前缀的写法：裸 uuid 会让宿主
      // `sessions.retain` 抛 `unknown session`（0.9.6 事故，见 afterWrite 注释）。
      const rawSessionId = String(opts.rawSessionId || '').trim() || (sessionId ? 'session-' + sessionId : '')
      const seq = opts.seq
      const text = typeof opts.text === 'string' ? opts.text : ''
      const deps = opts.deps || {}
      const reverted = opts.reverted === true
      // ⚠️ 先只解析 fetch：revert 失败时**不得**触碰任何草稿/视图副作用，
      // 连「解析实现」都不该发生在失败之前（解析顺序 = 语义顺序）。
      const doFetch = deps.fetch || fetch

      if (!sessionId) return { ok: false, stage: 'validate', reason: 'invalid target' }
      if (!reverted && !(Number.isSafeInteger(seq) && seq >= 0)) return { ok: false, stage: 'validate', reason: 'invalid target' }
      if (text.trim() === '') return { ok: false, stage: 'validate', reason: 'empty' }

      if (!reverted) {
        // ① 回撤：失败就**什么都不做**（不写草稿、不重建视图、不动编辑器）
        let res = null
        let data = null
        try {
          res = await doFetch('/api/message-ops/revert', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, seq }),
          })
          data = await res.json().catch(() => null)
        } catch (e) {
          return { ok: false, stage: 'revert', reason: e && e.message ? e.message : String(e) }
        }
        if (!res || !res.ok || !data || data.ok !== true) {
          return {
            ok: false,
            stage: 'revert',
            status: res ? res.status : 0,
            reason: (data && data.error) || 'HTTP ' + (res ? res.status : '?'),
          }
        }

        // ── 回撤已成功 ── 从这里开始才解析并使用其余副作用 ──────────────────────
        const markShadowed = deps.markRowsShadowedFrom || markRowsShadowedFrom
        const doEmitChanged = deps.emitChanged || emitChanged
        const doOpenSession = deps.openSessionById || openSessionById

        // ② 防 409 护栏：本地缓存里 >= seq 的行立刻标成已遮蔽（与 runUserRevert/runUndo 同一函数）
        try {
          markShadowed(seq)
        } catch (e) {
          console.warn('[message-ops] markRowsShadowedFrom failed:', e)
        }

        // ③ 通知 + 重建视图（rawSessionId 带前缀；裸 uuid 会抛 unknown session）
        try {
          doEmitChanged()
        } catch (e) {
          /* 广播失败不阻断写结果 */
        }
        try {
          doOpenSession(rawSessionId)
        } catch (e) {
          console.warn('[message-ops] openSession failed:', e)
        }
      }

      // ④ 官方 prompt —— **恰好一次**。注入位是 deps.prompt(text, 'queue')：
      //    真执行测试与 contract-hardening 都从这个面观测，不靠源码形状。
      const doPrompt = deps.prompt || (t => promptEditedText(t, { rawSessionId: rawSessionId, sessions: deps.sessions }))
      let sent = null
      try {
        sent = await doPrompt(text, 'queue')
      } catch (e) {
        sent = { ok: false, reason: e && e.message ? e.message : String(e) }
      }
      if (sent && sent.ok === true) {
        return { ok: true, stage: 'done', submitted: true, mode: 'official' }
      }

      // 老宿主（官方发送面缺席）→ **唯一**降级：写草稿 + 回读校验 + 提示按回车。
      // 这一条真落盘才算成功；回读到的值不同就如实报 persisted=false。
      if (sent && sent.unavailable === true) {
        const doWrite = deps.writeSessionDraft || writeSessionDraft
        const doRead = deps.readSessionDraft || readSessionDraft
        let persisted = false
        try {
          persisted = doWrite(rawSessionId, text) === true
        } catch (e) {
          console.warn('[message-ops] writeSessionDraft failed:', e)
        }
        // 回读校验：只有读到**不同的非空值**才算落盘失败（读不到时保持原判断，不误判）
        if (persisted && typeof doRead === 'function') {
          try {
            const stored = doRead(rawSessionId)
            if (stored != null && stored !== text) persisted = false
          } catch (e) {
            /* 读回失败不推翻写入结果 */
          }
        }
        return { ok: true, stage: 'done', submitted: false, mode: 'manual', manual: true, persisted: persisted }
      }

      // 官方面在、但拒收/抛错：**回撤已经成功**，绝不能返回 ok:false 让 UI 报「回撤失败」。
      // 单列 stage:'send'，组件据此给「回撤成功但发送被拒」的文案。
      const reason = sent && sent.reason ? String(sent.reason) : 'prompt rejected'
      return { ok: false, stage: 'send', submitted: false, mode: 'official', reason: reason }
    }

    /**
     * 编辑框样式：颜色全走 `--dsw-alias-*`，圆角全走 `--dsw-radius-*`，无裸 hex。
     *
     * 0.26.0 形态变化：从「全屏遮罩 + 居中 560px 模态」改成「贴着目标消息的浮层」——
     * 所以不再有 .mopsErScrim（不再遮住整个会话），面板宽度由 JS 按锚点消息块算好后
     * 内联给出（不写死 560px）。定位坐标同样由官方 useAnchoredPosition 以 fixed 内联
     * 给出，样式表只负责观感。
     *
     * ⚠️ 只用**已确认存在**的 token：`--dsw-alias-label-error` 在宿主 theme 包里并不存在
     * （别处有误用），错误色一律 `--dsw-alias-state-error-primary`。
     */
    function ensureEditStyle() {
      try {
        if (typeof document === 'undefined' || !document.head) return
        if (document.getElementById(EDIT_STYLE_ID)) return
        const tag = document.createElement('style')
        tag.id = EDIT_STYLE_ID
        tag.textContent = [
          '.mopsErPanel{position:fixed;z-index:60;display:flex;flex-direction:column;gap:8px;padding:12px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f1115);border:1px solid var(--dsw-alias-border-l2,#e6e6e6);border-radius:var(--dsw-radius-md,12px);box-shadow:0 12px 32px rgba(15,17,21,.18);font-family:inherit;font-size:13px;line-height:1.45}',
          '.mopsErPanel *{box-sizing:border-box}',
          // 测量 pass：useAnchoredPosition 需要面板真实尺寸才能 clamp。首帧没有坐标时
          // 面板必须**已挂载但不可见且不可点**（visibility:hidden 仍会吃掉点击，所以
          // 必须同时 pointer-events:none —— 否则透明面板会挡住消息本身）。
          '.mopsErPanel[data-mops-measure="1"]{visibility:hidden;pointer-events:none}',
          // 锚点块已不在 DOM（宿主重建/切会话）：退化为屏幕中央，不再追求贴附。
          '.mopsErPanel[data-mops-fallback="1"]{left:50%;top:50%;transform:translate(-50%,-50%)}',
          '.mopsErHead{display:flex;align-items:baseline;gap:6px;flex:none;min-width:0}',
          '.mopsErTitle{font-size:13px;font-weight:600;line-height:18px;white-space:nowrap}',
          '.mopsErSub{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8a8a8e);font-variant-numeric:tabular-nums;white-space:nowrap}',
          '.mopsErText{width:100%;min-height:74px;max-height:32vh;resize:vertical;padding:8px 9px;border:1px solid var(--dsw-alias-border-l2,#e6e6e6);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-2,#f7f7f8);color:var(--dsw-alias-label-primary,#0f1115);font:inherit;font-size:13px;line-height:1.55;outline:none}',
          '.mopsErText::placeholder{color:var(--dsw-alias-label-tertiary,#8a8a8e)}',
          '.mopsErText:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-1,#fff),0 0 0 4px var(--dsw-alias-brand-primary,#4d6bfe)}',
          '.mopsErText:disabled{opacity:.6;cursor:progress}',
          '.mopsErText[aria-invalid="true"]{border-color:var(--dsw-alias-state-error-primary,#c63b32)}',
          '.mopsErHint{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,#8a8a8e);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
          '.mopsErError{font-size:12px;line-height:17px;color:var(--dsw-alias-state-error-primary,#c63b32);overflow-wrap:anywhere}',
          '.mopsErOk{font-size:12px;line-height:17px;color:var(--dsw-alias-state-success-primary,#2f7d4a)}',
          // 一条极简行：提示在左，[取消] 与 [撤销并发送] 在右 —— 不再有独立的
          // actions 区、快捷键行、关闭 ×，也不复现 composer 的布局。
          '.mopsErActions{flex:none;display:flex;align-items:center;gap:8px;min-width:0}',
          '.mopsErActions .mopsErHint{flex:1;min-width:0}',
          '.mopsErBtn{min-height:26px;padding:3px 9px;border-radius:var(--dsw-radius-xs,4px);font:inherit;font-size:12px;line-height:18px;cursor:pointer;border:1px solid transparent;flex:none}',
          '.mopsErGhost{color:var(--dsw-alias-label-secondary,#6b6b70);background:transparent}',
          '.mopsErGhost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary,#0f1115)}',
          '.mopsErPrimary{background:var(--dsw-alias-button-primary-fill,#2b2b2e);color:var(--dsw-alias-label-primary-foreground,#fff)}',
          '.mopsErPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#3a3a3e)}',
          '.mopsErBtn:disabled{opacity:.5;cursor:not-allowed}',
          '.mopsErBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px}',
          '@media(prefers-reduced-motion:no-preference){.mopsErPanel{animation:mopsErRise .12s cubic-bezier(.2,.8,.3,1)}}',
          '@keyframes mopsErRise{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}',
          // 窄屏：贴边铺满，但仍不遮整屏（无 scrim，会话内容依旧可读）。
          '@media(max-width:760px){.mopsErPanel{width:auto!important;left:8px!important;right:8px;transform:none}}',
        ].join('')
        document.head.appendChild(tag)
      } catch (e) {
        /* 样式注入失败不影响功能 */
      }
    }

    /** 按 node-key 精确定位目标消息块（宿主重渲染后 node-key 保持不变）。 */
    function findChatNode(nodeKey) {
      const key = String(nodeKey || '')
      if (!key || typeof document === 'undefined') return null
      const nodes = document.querySelectorAll('[data-chat-node-key]')
      for (let i = 0; i < nodes.length; i++) if (nodes[i].getAttribute('data-chat-node-key') === key) return nodes[i]
      return null
    }

    /**
     * 「撤销并发送」浮层 —— 贴着那条消息弹出，**不是**居中模态。
     *
     * 为什么仍走 shell.overlay 槽：`ctx.slots.register` 的组件在 overlay 层里常驻挂载，
     * 内部 state 控制显隐（与 OpsPanel 同款）。改成「就地渲染进消息块旁边」需要把
     * React 子树塞进宿主 DOM（portal），宿主没提供这种跨树能力；而 overlay 槽 +
     * 官方 useAnchoredPosition 计算的 fixed 坐标，视觉上等价于「贴着消息」，
     * 且不依赖宿主内部结构 —— 这是约束下最干净的一种。
     */
    function EditResendOverlay(props) {
      const { sessionId, useSessions } = props
      const t = (props && props.t) || __t
      useLocaleRevision()
      if (sessionId) __currentSessionId = sessionId
      const sessions = useSessions ? useSessions(s => s) : undefined
      // target: { sessionId, rawSessionId, seq, nodeKey }
      const [target, setTarget] = useState(null)
      const [draft, setDraft] = useState('')
      const [textState, setTextState] = useState('idle') // idle|loading|ready|error
      const [loadError, setLoadError] = useState(null)
      const [saving, setSaving] = useState(false)
      const [error, setError] = useState(null)
      const [done, setDone] = useState('')
      // 「回撤已成功、发送被拒」时只允许重发（同 seq 再回撤必然 409）
      const [sendOnly, setSendOnly] = useState(false)
      // 锚点：宿主重渲染会换掉块节点，ref 存**当前**节点，定位由官方 hook 在
      // scroll/resize 时按 ref.current 重算。
      const [anchorRect, setAnchorRect] = useState(null)
      const [anchored, setAnchored] = useState(false)
      const textRef = useRef(null)
      const panelRef = useRef(null)
      const anchorRef = useRef(null)
      const dismissRef = useRef(null)
      const reqRef = useRef(0)

      const open = !!target
      // 落座决策（side / 宽度）是纯函数，官方 hook 只负责 clamp 与坐标。
      const seat = editSeatOf(
        anchorRect,
        typeof window === 'undefined' ? { width: 0, height: 0 } : { width: window.innerWidth, height: window.innerHeight },
      )
      // ⚠️ 两个官方 hook 必须**无条件调用**（React hooks 顺序恒定）。
      // 锚点缺失时 open 传 false：官方 hook 不做非锚点定位，由 CSS 的 fallback 兜底。
      const pos = useAnchoredPosition({
        open: open && anchored,
        anchorRef: anchorRef,
        panelRef: panelRef,
        side: seat.side,
        gap: seat.gap,
        margin: seat.margin,
      })
      // 点面板外关闭（官方实现：pointerdown 落在 panel 与 anchor 之外才触发）。
      useDismissOnOutsidePointer(
        anchorRef,
        open,
        () => {
          if (dismissRef.current) dismissRef.current(false)
        },
        panelRef,
      )

      const resetState = () => {
        reqRef.current += 1
        setTarget(null)
        setDraft('')
        setTextState('idle')
        setLoadError(null)
        setError(null)
        setDone('')
        setSendOnly(false)
        setAnchorRect(null)
        setAnchored(false)
        anchorRef.current = null
      }

      useEffect(() => {
        ensureEditStyle()
        const handler = e => {
          const d = e && e.detail ? e.detail : {}
          if (!d.sessionId || !Number.isSafeInteger(d.seq)) return
          // 锚点解析顺序：① 事件直接带的元素（最准，零查询）② node-key 精确查表
          // ③ 都没有 → 退回屏幕中央（宿主已重建块时常见）。
          const block = (d.block && d.block.nodeType === 1 ? d.block : null) || findChatNode(d.nodeKey)
          // 只有块**还在视口里**才锚定；块已被滚走/被宿主卸载时退回屏幕中央，
          // 否则官方 clamp 会把面板贴到视口边缘，看起来像「飘到别处」。
          const viewport =
            typeof window === 'undefined' ? { width: 0, height: 0 } : { width: window.innerWidth, height: window.innerHeight }
          let rect = null
          try {
            rect = block ? block.getBoundingClientRect() : null
          } catch (e) {
            rect = null
          }
          const anchoredNow = !!block && !!rect && editSeatOf(rect, viewport).inView
          anchorRef.current = anchoredNow ? block : null
          setAnchored(anchoredNow)
          setAnchorRect(rect)
          reqRef.current += 1
          setTarget({ sessionId: String(d.sessionId), rawSessionId: d.rawSessionId || d.sessionId, seq: d.seq, nodeKey: d.nodeKey || null })
          setDraft('')
          setTextState('loading')
          setLoadError(null)
          setError(null)
          setDone('')
          setSendOnly(false)
        }
        window.addEventListener(EDIT_EVENT, handler)
        return () => window.removeEventListener(EDIT_EVENT, handler)
      }, [])

      const loadText = useCallback(() => {
        if (!target) return
        const req = ++reqRef.current
        const sid = target.sessionId
        setTextState('loading')
        setLoadError(null)
        fetch('/api/message-ops/text?sessionId=' + encodeURIComponent(sid) + '&seq=' + encodeURIComponent(target.seq))
          .then(res =>
            res
              .json()
              .catch(() => null)
              .then(data => ({ res, data })),
          )
          .then(({ res, data }) => {
            if (req !== reqRef.current) return
            if (!res.ok || !data || data.ok !== true) throw new Error((data && data.error) || 'HTTP ' + res.status)
            if (typeof data.text !== 'string' || data.text === '') throw new Error(t('slot.editNoText'))
            // ⚠️ 只认 /text 的全文：绝不拿 160 字 snippet 冒充原文
            setDraft(data.text)
            setTextState('ready')
          })
          .catch(reason => {
            if (req !== reqRef.current) return
            setLoadError(t('edit.loadFail') + (reason && reason.message ? reason.message : String(reason)))
            setTextState('error')
          })
      }, [target, t])

      useEffect(() => {
        if (!target) return undefined
        loadText()
        return undefined
      }, [target, loadText])

      // 光标置末尾：长消息从第一行开始编辑很难受，用户多半是改尾部
      useEffect(() => {
        if (textState !== 'ready' || !textRef.current) return
        const el = textRef.current
        try {
          el.focus()
          const end = el.value.length
          el.setSelectionRange(end, end)
        } catch (e) {
          /* 非浏览器 / 不支持的输入类型：忽略 */
        }
      }, [textState])

      const cancel = useCallback(() => {
        if (saving) return
        // 零副作用：只清本地 state。不清宿主草稿、不碰会话、不发请求。
        resetState()
      }, [saving])
      useEffect(() => {
        dismissRef.current = cancel
      }, [cancel])
      // Esc 关闭（面板内 textarea 有焦点时靠冒泡；焦点跑到别处时靠 document）
      useEffect(() => {
        if (!open) return undefined
        const onKeyDown = e => {
          if (e.key !== 'Escape' || e.defaultPrevented) return
          e.preventDefault()
          if (!saving) cancel()
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [open, saving, cancel])

      // 运行中：发送会被服务端 409 拦住，所以只拦「发送」，**不拦打开**（打开是纯读）。
      const running = (() => {
        if (!target) return false
        if (sessions && sessions.byId) {
          const summary =
            sessions.byId[target.rawSessionId] || sessions.byId['session-' + target.sessionId] || sessions.byId[target.sessionId]
          if (summary) return summary.running === true
        }
        const cache = __peekRowsCache ? __peekRowsCache() : null
        return !!(cache && cache.running === true)
      })()

      const canSubmit = textState === 'ready' && !saving && draft.trim() !== '' && !running

      const send = useCallback(async () => {
        if (!target || !canSubmit) return
        setSaving(true)
        setError(null)
        setDone('')
        const result = await sendEditAndRevert({
          sessionId: target.sessionId,
          rawSessionId: target.rawSessionId,
          seq: target.seq,
          text: draft,
          reverted: sendOnly,
        })
        setSaving(false)
        if (!result.ok) {
          // ⚠️ 失败必须保留浮层 + 用户已输入的文本（不清 draft、不 close）
          if (result.stage === 'send') {
            // 回撤已成功、发送被拒：不能再回撤（同 seq 必然 409），只允许重发
            setSendOnly(true)
            setError(t('edit.sendFailed') + (result.reason || ''))
            return
          }
          setError(
            result.stage === 'revert'
              ? t('edit.failed') + (result.reason || 'HTTP ' + result.status)
              : result.reason === 'empty'
                ? t('edit.empty')
                : String(result.reason || ''),
          )
          return
        }
        setSendOnly(true)
        if (result.submitted) {
          notifyDone(t('edit.doneSubmitted'))
          cancel()
          return
        }
        // 官方发送面缺席（老宿主）：文本已写进草稿，明确让用户按回车，别让人以为没发生
        notifyDone(t('edit.manual'), 'warn')
        setDone(t('edit.manual'))
      }, [target, canSubmit, draft, t, cancel, sendOnly])

      const onKeyDown = e => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          if (canSubmit) send()
        }
      }

      if (!target) return null

      const measure = !pos && anchored
      const style = {}
      if (measure) {
        style.visibility = 'hidden'
        style.pointerEvents = 'none'
        style.left = 0
        style.top = 0
      } else if (anchored && pos) {
        style.left = pos.left
        style.top = pos.top
      }
      style.width = seat.width
      style.boxSizing = 'border-box'
      if (!anchored) style.width = Math.min(EDIT_PANEL_MAX_WIDTH, Math.max(EDIT_PANEL_MIN_WIDTH, seat.width))

      return React.createElement(
        'section',
        {
          className: 'mopsErPanel',
          role: 'dialog',
          'aria-modal': 'false',
          'aria-labelledby': 'mops-er-title',
          'data-mops-panel': '1',
          'data-mops-measure': measure ? '1' : undefined,
          'data-mops-fallback': !anchored ? '1' : undefined,
          ref: panelRef,
          style: style,
          onKeyDown: onKeyDown,
        },
        React.createElement(
          'div',
          { className: 'mopsErHead' },
          React.createElement('div', { className: 'mopsErTitle', id: 'mops-er-title' }, t('edit.title')),
          React.createElement('div', { className: 'mopsErSub' }, t('edit.subtitle', { seq: String(target.seq) })),
        ),
        React.createElement('textarea', {
          className: 'mopsErText',
          ref: textRef,
          value: draft,
          rows: 3,
          readOnly: saving,
          disabled: textState !== 'ready',
          'aria-invalid': error || textState === 'error' ? 'true' : undefined,
          placeholder: textState === 'loading' ? t('edit.loading') : t('edit.placeholder'),
          onChange: e => setDraft(e.target.value),
          'aria-label': t('edit.title'),
        }),
        textState === 'error'
          ? React.createElement(
              'div',
              { className: 'mopsErError', role: 'alert' },
              loadError,
              ' ',
              React.createElement('button', { type: 'button', className: 'mopsErBtn mopsErGhost', onClick: loadText }, t('edit.retry')),
            )
          : null,
        running ? React.createElement('div', { className: 'mopsErError', role: 'alert' }, t('edit.running')) : null,
        error ? React.createElement('div', { className: 'mopsErError', role: 'alert' }, error) : null,
        done ? React.createElement('div', { className: 'mopsErOk', role: 'status' }, done) : null,
        React.createElement(
          'div',
          { className: 'mopsErActions' },
          // 一句提示（含 D-3 的「不是删除 / 原文仍在本地文件」告知，不可删）
          React.createElement('div', { className: 'mopsErHint' }, t('edit.replaceHint')),
          React.createElement(
            'button',
            { type: 'button', className: 'mopsErBtn mopsErGhost', onClick: cancel, disabled: saving },
            t('edit.cancel'),
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'mopsErBtn mopsErPrimary',
              onClick: send,
              disabled: !canSubmit,
              // 快捷键提示并进主按钮的 title：不再单独占一行
              title: t('edit.shortcut'),
            },
            saving ? t('edit.sending') : sendOnly ? t('edit.resend') : t('edit.send'),
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

    /**
     * 打开会话（宿主唯一通道），**失败必须留痕**（审计 §2.3 的 6 处吞错单点）。
     *
     * 为什么不能继续静默 `catch {}`：`openSession` 失败的用户可见后果正是本轮反复
     * 修的那一类 ——「回滚后界面没变灰 / 恢复后消息不回来 / 铅笔点不开」。而
     * `/undo`、`/redo` 的 `afterWrite` 注释已把 0.9.6 事故写死：传裸 uuid →
     * 宿主 `sessions.retain` 抛 `unknown session <bare>` → 外层 `catch {}` 静默吞掉
     * → **「视图重建」这条路径从来没生效过**，只剩 150/700/1600ms 的 DOM 打补丁。
     * 同一份事故档案写在文档里，代码里 6 个调用点却有 5 个还在吞 —— 这条单点就是
     * 把「文档说的」变成「代码做的」。
     *
     * ⚠️ 仍然必须 catch：不 swallow 会让 React 渲染抛（这是渲染期调用）。
     * ⚠️ `sessionId` 必须带 `session-` 前缀：宿主 `sessions.retain(bare)` 只认
     * `session-<uuid>`（manager.js resolveTarget），传裸 uuid 必抛。
     *
     * @param sessionId - 会话 id（`session-<uuid>` 形态）
     * @param where - 调用点标记，写进 warn 文本 —— 排障时一眼看出是哪条路径没重建
     * @returns `true` = 真的调了宿主 `openSession`；`false` = 服务缺席 / 未挂载 / 抛了
     */
    function safeOpenSession(sessionId, where) {
      try {
        if (__uiWorkspace && typeof __uiWorkspace.openSession === 'function') {
          __uiWorkspace.openSession(sessionId)
          return true
        }
      } catch (e) {
        console.warn('[message-ops] openSession failed @' + String(where || 'unknown') + ':', e)
      }
      return false
    }

    /**
     * `sendEditAndRevert` 的可注入依赖面：测试用 `deps.openSessionById` 观测时序，
     * 生产路径就是 {@link safeOpenSession}（保留本名是为了不破坏既有注入契约）。
     */
    function openSessionById(sessionId) {
      return safeOpenSession(sessionId, 'send-edit-revert')
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

    // --- 0.3.0 assistant-actions 官方槽：AI 消息动作区 -------------------------
    // 契约（dsh-cordis-client-runner）：scope session，条目组件收 { messageId } +
    // 标准props（useSessions/sessionId/useSession/useChat…）。0.1.x 无此 key，
    // slots.inject 自动 no-op。
    //
    // 0.23.0 起本槽**不渲染任何按钮**（引用让位宿主、回撤按钮让位行内注入）。
    // 它留下的唯一职责 = 按会话捕获 inputActions（上面 ⚠️ 注释），必须保留注册。
    const CHAT_ACTIONS_SLOT = 'conversation.chat.assistant-actions'
    const CHAT_ACTIONS_ID = 'message-ops-row'

    function MsgSlotActions(props) {
      const { sessionId, inputActions } = props
      // 0.24.0 P4：按会话登记（本组件每条 AI 消息一个实例，必须带 sessionId 隔离）。
      React.useEffect(() => {
        rememberInputActions(sessionId, inputActions)
        return () => forgetInputActions(sessionId, inputActions)
      }, [sessionId, inputActions])
      // 0.23.0：AI 消息动作区**不再注入任何按钮**。
      //
      // 用户反馈：「引用不要每次把一整个上下文重新全部塞给 AI」。核查结论：
      //   · 宿主自带完整划词引用 —— dsh-message-quotes/lib/client.js:48 调
      //     inputActions.insertQuote(text)，注册在 conversation.chat.text-interaction
      //     槽，只在用户选中文字（textInteraction.active !== null）时渲染，
      //     「选中多少引多少」，从不引整条。
      //   · 我们旧按钮用 [data-chat-node-key] 判选区，与宿主的
      //     [data-text-interaction-source] 体系不匹配 → 高频判不出选区 →
      //     退化成 clipQuote(fullText) 把 600 字塞进 composer。
      //   · 而 deriveMessages() 本就遍历 surface.nodes 给出完整历史，
      //     引用当前会话里未被遮蔽的消息 = 同一内容在 prompt 里出现两遍，纯冗余。
      // 所以正确做法是让位给宿主，不再重复造轮子。
      // 引用机械（IconQuote / clipQuote / runQuote / selectionInMessage / 选区归属判定）
      // 与配套的 fullText / seq 解析已随之删除；不得再在本槽重建（docs/DECISIONS.md D-4）。
      //
      // ⚠️ 本组件**必须保留**：它负责按会话捕获 inputActions 到
      // __inputActionsBySession（编辑框 / 面板 / 行内回填都依赖），
      // 删组件会让这些功能静默失效。只 return null，不删注册。
      return null
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
      // 0.24.0 P4：dock 也是 per-session 实例，登记时必须带 sessionId。
      React.useEffect(() => {
        rememberInputActions(sessionId, inputActions)
        return () => forgetInputActions(sessionId, inputActions)
      }, [sessionId, inputActions])
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
                // 0.23.0（深挖 S-2）：服务端 buildDerived 用 readReplaceOp 把 range
                // 覆盖成 {startSeq,endSeq}，而旧代码只读 {start,end} → 计数恒为 0。
                // 两种形状都兼容，并防御旧缓存里仍是 {start,end} 的情况。
                const rng = mk.range || {}
                const start = Number.isSafeInteger(rng.startSeq) ? rng.startSeq : Number.isSafeInteger(rng.start) ? rng.start : mk.seq
                const end = Number.isSafeInteger(rng.endSeq) ? rng.endSeq : Number.isSafeInteger(rng.end) ? rng.end : start
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
            // 0.26.0：统一走 safeOpenSession（失败 warn —— 审计 §2.3 指出的 6 处吞错之一）
            safeOpenSession(sessionId, 'dock-restore')
            // 0.9.1：重放的消息带**新 seq**，被恢复的行必须解除 hidden；dock 的
            // marker 列表要按权威数据重算（restoreComplete 会变 true）后重拉。
            emitChanged()
            // 0.25.0（手感）：三连 [150,700,1600] 改成「立即一次」（__refreshSurface
            // 自带 300ms 尾随防抖）。恢复是**重放**语义：重放出来的消息带新 seq，
            // 被恢复的行必须解除 hidden —— 这条兜底路径必须留，只是不再让用户白等。
            if (__refreshSurface) __refreshSurface(sessionId)
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
      var rowsCache = { sid: null, rows: null, at: 0, running: false }
      __peekRowsCache = () => rowsCache
      var norm = x => String(x || '').replace(/\s+/g, '')

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
            // 0.25.0：把服务端 isRunning 一起缓存 —— 注入器是纯 DOM 闭包，拿不到
            // useSessions，只能靠这里带出来的 running 给按钮做状态提示。
            rowsCache = { sid: sid, rows: rows, idx: idx, at: Date.now(), running: d && d.running === true }
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
        for (var i = 0; i < list.length; i++) {
          var m = list[i]
          if (!m || typeof m.seq !== 'number') continue
          if (m.id != null) {
            var k = String(m.id)
            // restore 是「重放」语义 → 原件与副本可能同 id 并存。
            // ⚠️ 0.26.0（审计 §4.1）：这里**只保留最新 seq 一个值**。
            // 0.9.1 曾额外维护 `dupByMessageId`（收集同 id 的全部 seq）+ `seqOfNodeKey`
            // 返回 `hit.all`，声称供「隐藏判据取任一 seq 越过 fence」用 —— 但 0.9.1 的
            // `fences` 判据早已换成 `idx.shadowed`（见 applySurfaceVisibility），
            // 生产里**没有任何读取方会读 `hit.all`**（grep `hit.all` = 0）。
            // 测试（test/surface-visibility.test.js）当时测的是它自己手抄的副本，
            // 于是「生产 0 读者 / 测试绿」= 假绿灯。0.26.0 删掉：索引只留被消费的字段。
            byMessageId.set(k, m.seq) // 最新（当前 surface 上的那条）
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
        // ⚠️ 返回形状 = **被消费的字段全集**（多一个字段 = 多一份要维护却没人读的状态）：
        //   byMessageId / byTurnStep / byCallId / byTurn → seqOfNodeKey 查表
        //   shadowed                                    → applySurfaceVisibility 藏行判据
        //   visibleTurns                                → 回合 chrome 的藏行判据
        //   total                                       → ensureAssign 的 dataSig（变化重算）
        return { byMessageId, byTurnStep, byCallId, byTurn, shadowed, visibleTurns, total: list.length }
      }

      /** node-key → `{ kind, seq[, turn] }`（**只返回查到的 seq**；同 id 只留最新，见 buildIndex）。 */
      var seqOfNodeKey = (key, idx) => {
        var parsed = parseNodeKey(key)
        if (!parsed || !idx) return null
        var id = parsed.id
        switch (parsed.kind) {
          case 'input-message': // user / steering / turn-trigger
          case 'developer-message':
          case 'trajectory-note': {
            const hit = idx.byMessageId.get(id)
            return hit === undefined ? null : { kind: parsed.kind, seq: hit }
          }
          case 'assistant-step': {
            const hit = idx.byTurnStep.get(id)
            return hit === undefined ? null : { kind: parsed.kind, seq: hit }
          }
          case 'tool-call': {
            const hit = idx.byCallId.get(id)
            return hit === undefined ? null : { kind: parsed.kind, seq: hit }
          }
          case 'turn-tail':
          case 'turn-process':
          case 'turn-error':
          case 'turn-max-tokens':
          case 'model-retry': {
            const hit = idx.byTurn.get(id)
            // 这类是**回合 chrome**，id 就是 turn 号 —— 判据要按「这个 turn 还有
            // 没有可见消息」而不是按 seq，因为 turn/end 本身多半不在 surface 上。
            return hit === undefined ? null : { kind: parsed.kind, seq: hit, turn: id }
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

      // 用户消息锚点：优先官方 `HOST_CLS.userRow`（含 `HOST_CLS.actions` 动作行），
      // 回退稳定属性 `data-chat-flow-kind="user"`（二者都在顶部 HOST_CLS 单点定义）。
      // 锚点 = 每条用户消息自己的容器（一个块只算一次）：
      // 从官方动作行反查最近的消息容器，最贴近"一条消息"的粒度。
      var userAnchors = () => {
        const out = []
        const seen = new Set()
        const add = el => {
          if (el && !seen.has(el)) {
            seen.add(el)
            out.push(el)
          }
        }
        const rows = Array.from(document.querySelectorAll('[class*="' + HOST_CLS.actions + '"]'))
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
        // 0.18.0/0.20.0：两种按钮各有自己的提示文案（编辑按钮不能写 revert 的 hint）
        // 0.21.0：回滚按钮统一用「带隐私提示」的 title —— syncEnabled 会在
        // 注入后重设 title，若这里仍用 slot.revert 会覆盖掉 ensureBtn 里的隐私提示。
        const isEdit = btn.classList.contains('mopsUserEdit')
        const hintKey = isEdit ? 'slot.editHint' : 'slot.revertPrivacyHint'
        const ok = block.getAttribute('data-mops-seq')
        if (ok) {
          // 🔴 0.26.0 红线：**铅笔任何时候都可点**。
          //
          // 打开浮层是纯读（GET /text），不需要 idle；真正会被服务端 409 拦住的是
          // 「撤销并发送」，那一层已经由浮层里的发送按钮 disabled + edit.running 拦住。
          // 所以这里绝不允许出于「会话运行中」把入口 disabled —— 那正是用户投诉
          // 「运行时铅笔根本无法点击」的形态。
          //
          // 0.24~0.25 里这条路径本来就只改 title/attr、没动 disabled（已用真实浏览器
          // 138 点采样 + 原生鼠标点击验证过：运行中 disabled=false、可点开）。
          // 保留 running 字样是**告知**，不是禁用；视觉上只做轻微淡化，不再用
          // 0.5 那样容易被读成「禁用」的透明度。
          btn.disabled = false
          const running = rowsCache.running === true
          if (isEdit) {
            btn.title = running ? __t('edit.running') : __t(hintKey)
            // running 是「可点但发送要等」的信号：写进 aria 与 data-*，样式只做
            // 非常轻的提示（0.82 仍清晰可辨，不像 disabled 的 0.4/0.5）
            if (running) {
              btn.setAttribute('data-mops-running', '1')
              btn.setAttribute('aria-label', __t('edit.running'))
            } else {
              btn.removeAttribute('data-mops-running')
              btn.setAttribute('aria-label', __t('slot.edit'))
            }
          } else {
            btn.title = __t(hintKey)
            btn.removeAttribute('data-mops-running')
          }
          btn.removeAttribute('data-mops-unmatched')
        } else {
          btn.disabled = true
          btn.title = __t(isEdit ? 'slot.editUnmatched' : 'slot.revertUnmatched')
          btn.setAttribute('data-mops-unmatched', '1')
        }
      }
      /** 块内全部插件按钮一起同步（回滚 / 编辑 / 分叉同一动作行）。 */
      var syncBlockButtons = block => {
        if (!block || !block.querySelectorAll) return
        for (const b of block.querySelectorAll('.mopsUserRevert, .mopsUserEdit')) syncEnabled(block, b)
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
        // 0.25.0（手感）：ensureAssign 内部第一件事就是 fetchRows，并把同一个
        // cache 返回出来 —— 旧实现在它后面再 fetchRows(sid) 一次是纯重复
        // （命中 8s 缓存只是空转，未命中时平白多打一次 GET /messages）。
        // 复用返回值即可；只有 ensureAssign 彻底拿不到数据（网络失败 → null）
        // 时才补一次，避免「一次抖动就让这次点击变成点了没用」。
        Promise.resolve()
          .then(() => ensureAssign(sid))
          .then(cache => cache || fetchRows(sid))
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
                // 0.23.0（深挖）：先回填再报成功，回填失败要让用户知道。
                // 旧实现先 notifyDone(done.revert) 再 refillComposer 且丢弃返回值 →
                // 用户看到「已回滚」却拿到空输入框（0.14.0 踩过的同一类静默失败）。
                // 0.17.0（冲突 C2）：按钮路径原先漏了「立刻标遮蔽」，
                // 导致刷新窗口内重复点击会拿已遮蔽的 seq 去 POST → 409。
                markRowsShadowedFrom(row.seq)
                const filled = refillComposer(sid, row.seq)
                if (filled) notifyDone(__t('done.revert'))
                else notifyDone(__t('done.revertNoRefill'), 'warn')
                emitChanged()
                // 0.26.0：统一走 safeOpenSession（失败 warn，不静默吞）
                safeOpenSession(sid, 'user-revert')
                // 0.9.1：视图重建后重新拉权威可见性并隐藏被遮蔽的行。
                // openSession 会重挂 DOM，旧节点上的 hidden 属性随之失效，必须重刷。
                // 0.25.0（手感）：三连 [150,700,1600] → 立即一次（自带 300ms 尾随防抖）。
                if (rowsCache) rowsCache.at = 0
                if (__refreshSurface) __refreshSurface(sid)
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
       * 0.20.0 铅笔编辑按钮：与回滚**同一动作行**，插在回滚与分叉之间。
       *
       * 语义 = 打开「编辑并重发」浮层（`EditResendOverlay`），编辑框里改文字；
       * **点「发送并回撤」那一刻**才回撤并重发。点按钮本身零写操作。
       *
       * 与 0.19.0 删掉的行内编辑的区别：那版只是把原文**回填 composer**
       * （`refillComposer`），跟回滚回填是同一件事，所以被判为重复入口而删除。
       * 这一版是独立编辑框 + 延迟回撤，是用户明确要求的产品行为。
       *
       * 图标取官方 `edit-outline` 几何（16 viewBox，填充几何 —— 与分叉图标同族写法）。
       */
      /**
       * 取得（必要时创建）本条消息的**插件动作行**，返回 `{ host, created }`。
       *
       * 审计 §3.2：`ensureBtn` / `ensureEditBtn` 原先是两段**逐字相同**的
       * 「查宿主动作行 → 查不到就建一个 `mopsUserActionsRow`」。
       * 合并成一个函数不是为了省 4 行，而是为了消灭一个真实风险：
       * 若宿主将来只提供 `TS9iAW_actions`、不再有 `xzv4MW_actions`，两个工厂会
       * **各自**建一行 → 同一条消息下出现**两个**插件动作行（回滚/铅笔分两排），
       * 这正是 0.16.0「撑裂行高」事故的同一类形态。
       *
       * 现在只有这一处会建行：先到先得，后来的复用同一个 host。
       */
      var ensureActionsHost = block => {
        let host = block.querySelector('[class*="' + HOST_CLS.actions + '"]')
        if (host) return { host: host, created: false }
        host = document.createElement('div')
        host.className = 'mopsUserActionsRow'
        block.appendChild(host)
        return { host: host, created: true }
      }

      var ensureEditBtn = block => {
        const { host } = ensureActionsHost(block)
        const existing = host.querySelector('.mopsUserEdit')
        if (existing) return existing
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'mopsUserEdit'
        btn.title = __t('slot.editHint')
        btn.setAttribute('aria-label', __t('slot.edit'))
        // 铅笔：官方 edit-outline 的几何（与分支图标同为 fill 几何，不用 stroke）
        btn.innerHTML =
          '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="none">' +
          '<path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M11.9 1.4a1.6 1.6 0 0 1 2.3 0l.4.4a1.6 1.6 0 0 1 0 2.3l-1 1-2.7-2.7 1-1ZM9.8 3.5l2.7 2.7-6.9 6.9a1 1 0 0 1-.4.2l-2.6.7a.5.5 0 0 1-.6-.6l.7-2.6a1 1 0 0 1 .2-.4l6.9-6.9Z"/>' +
          '</svg>'
        btn.addEventListener('click', e => {
          e.preventDefault()
          e.stopPropagation()
          if (btn.disabled) return
          runUserEdit(btn, block)
        })
        host.appendChild(btn)
        syncEnabled(block, btn)
        return btn
      }

      /**
       * 0.20.0 行内编辑入口：解析 seq → 派发 `EDIT_EVENT` 打开编辑浮层。
       *
       * 这一步**纯读**：`ensureAssign` / `fetchRows` 只读 `/api/message-ops/messages`，
       * 不发任何写请求、不改草稿。真正的写操作全在 `sendEditAndRevert` 里，
       * 由用户在编辑框里点「发送并回撤」才触发。
       */
      var runUserEdit = (btn, block) => {
        const sid = __currentSessionId
        if (!sid) return
        btn.disabled = true
        Promise.resolve()
          .then(() => ensureAssign(sid))
          .then(() => fetchRows(sid))
          .then(cache => {
            const rows = cache && cache.rows
            const seq = Number(block.getAttribute('data-mops-seq'))
            const row = rows && rows.find(r => r.seq === seq)
            if (!row) {
              notifyDone(__t('errorPrefix') + __t('slot.editUnmatched'), 'error')
              return
            }
            if (!Number.isSafeInteger(seq) || seq < 0) {
              notifyDone(__t('slot.editUnmatched'), 'warn')
              return
            }
            // 裸 uuid 给 HTTP，rawSessionId 给 sessions.using / 草稿键。
            // node-key 与块元素一起带上：浮层要**贴着这条消息**弹出，而宿主会在
            // 流式渲染里重建 DOM，所以两者都传 —— block 是最准的锚点（零查询），
            // node-key 是存活到重渲染之后的重解析依据（块被换掉后仍能找回）。
            window.dispatchEvent(
              new CustomEvent(EDIT_EVENT, {
                detail: {
                  sessionId: bareSessionId(sid),
                  rawSessionId: sid,
                  seq: seq,
                  nodeKey: block.getAttribute('data-chat-node-key') || null,
                  block: block,
                },
              }),
            )
          })
          .catch(reason => {
            notifyDone(__t('errorPrefix') + (reason && reason.message ? reason.message : String(reason)), 'error')
          })
          .finally(() => {
            // 0.26.0：收尾交给 syncEnabled 而不是无条件 disabled=false ——
            // 配对失败的块必须保持 disabled（抛 true 会让装饰按钮可点且点了报错）。
            syncEnabled(block, btn)
          })
      }

      // 三个按钮的顺序由 DOM 顺序决定：回滚在前（破坏性更高），编辑居中，分叉最后（非破坏）。
      var ensureBtn = block => {
        // 官方动作行（含 Copy）：把按钮放到这一行里，与 Copy 同级
        const { host } = ensureActionsHost(block)
        let btn = host.querySelector('.mopsUserRevert')
        if (btn) return btn
        btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'mopsUserRevert'
        // 0.21.0：行内回滚按钮不经过面板确认框，隐私告知必须挂在这里（hover 可见）
        btn.title = __t('slot.revertPrivacyHint')
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

      var ensureUserActions = block => {
        // 0.20.0：铅笔回归，但语义变了 —— 独立编辑框 + 点「发送并回撤」才写，
        // 不再是 0.18.0 那种「只回填 composer」的伪编辑。
        // 0.23.0：行内 fork 按钮已删 —— dsh 官方在 AI 回合尾部已有
        // sessions.fork（conversation.chat.assistant-actions / TurnTailNodeView）。
        // 分叉能力统一由官方按钮 + 面板 branch（同样走官方 sessions.fork）承担。
        ensureBtn(block)
        ensureEditBtn(block)
      }
      // 0.9.7（P0-2 读合并）/ 0.25.0（手感）：写操作后的兜底刷新 = **一次**真网络请求。
      //
      // 历史：写操作后曾排 150/700/1600ms 三连调用，指望「DOM 重建在不同时刻完成，
      // 多打几档总能补上」。而本函数自身有防抖（窗口内重复调用只留最后一次），
      // 三连实际只跑一发 —— 但落点固定在 1500ms 后，用户点完回撤要**白等 1.6 秒**
      // 才看到灰。0.25.0 改成：调用方写后**立即**调一次（本函数立刻按防抖排程），
      // 防抖窗口 1500ms → **300ms**（尾随），既够宿主完成 openSession 的 DOM 重挂，
      // 又不让用户干等。
      // 🔴 红线：这一档是「视图重建后重算隐藏」的兜底，绝不能砍成 0 —— 300ms 是
      // 「一帧/两帧 + 一次重挂预算」，宁可多 300ms 也不许没有。
      // 调用当下立刻 rowsCache.at = 0 —— 紧随其后的 scan 因此能用
      // 共享窗口里的新鲜载荷先把隐藏刷对，不必等兜底那一发。
      var refreshTimer = null
      var refreshDeadline = 0
      __refreshSurface = sid => {
        const id = sid || __currentSessionId
        if (!id) return
        if (rowsCache) rowsCache.at = 0 // 强制重取权威数据
        const now = Date.now()
        if (!refreshTimer) refreshDeadline = now + 300
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
          for (const b of blocks) {
            ensureUserActions(b)
            // 0.25.0：running 变了要立刻同步按钮 title（否则要等 8s 缓存过期）。
            // 用缓存值，零额外请求。
            syncBlockButtons(b)
          }
          // 0.9.1：**始终**刷新（原先只在按钮未打标时刷）——
          // 打标后 transcript 再变化（openSession 重建 / 分页 / restore 重放）
          // 就再也不会重算隐藏，导致「界面停在旧状态，必须重载页面才对」。
          ensureAssign(sid)
        } catch {
          /* 注入失败不影响会话 */
        }
      }
      // 触发：hover / 滚动 / DOM 变化 / 变更事件
      document.addEventListener(
        'mouseover',
        e => {
          try {
            if (!e || !e.target || !e.target.closest) return
            if (!__currentSessionId) return
            // hash 单点：HOST_CLS.userRow 不硬编码在选择器里（见顶部常量块）。
            // 稳定属性 `data-chat-flow-kind="user"` 在前 —— 宿主换 hash 也不会失配。
            const block = e.target.closest('[class*="' + HOST_CLS.userRow + '"], [data-chat-flow-kind="user"]')
            if (!block) return
            ensureUserActions(block)
            if (!block.hasAttribute('data-mops-seq')) ensureAssign(__currentSessionId)
          } catch {
            /* noop */
          }
        },
        { passive: true },
      )
      // 0.25.0（手感）：滚动走 rAF 合并。
      //
      // 改前：`scroll` 上一次事件跑一次 `scan()`，而 scan 每次要做 **3 次全文档
      // querySelectorAll**（userAnchors / data-chat-node-key / 块内动作行）。
      // 滚动是每帧多次派发的高频事件 —— 长会话里肉眼可见地发涩。
      // 改后：一帧内不管派发多少次，只跑一次 scan（rAF 合并，天然对齐宿主渲染节奏）。
      // 不改成 MO 的 scheduleScan()（200ms 尾随）：那是为「宿主重建块」服务的防抖，
      // 拿它接滚动会让藏行/打标慢半拍，手感更差。
      var rafPending = false
      var onScroll = () => {
        if (rafPending) return
        rafPending = true
        var run = () => {
          rafPending = false
          scan()
        }
        // 老宿主/测试环境没有 rAF 时退回宏任务，语义仍是「合并到下一拍」
        try {
          if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(run)
          else setTimeout(run, 16)
        } catch {
          rafPending = false
          scan()
        }
      }
      window.addEventListener('scroll', onScroll, { passive: true })
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
        // ④ `data-chat-flow-kind` / `class*` 只认 **added/removed 节点**（attributeFilter
        //    不含 className 与 flow-kind，见下方 observe 选项）；hash 单点见 HOST_CLS。
        var MO_SEL =
          '[data-chat-node-key],[data-chat-flow-kind="user"],[class*="' + HOST_CLS.actions + '"],[class*="_userRow"],[data-turn-tail]'
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
            '.mopsUserRevert,.mopsUserEdit{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:4px;background:transparent;color:var(--dsw-alias-label-tertiary,#808080);cursor:pointer;padding:0;flex:none}',
            '.mopsUserRevert svg,.mopsUserEdit svg{width:14px;height:14px;display:block}',
            '.mopsUserRevert:hover,.mopsUserEdit:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));color:var(--dsw-alias-label-secondary,#6b6b70)}',
            '.mopsUserRevert:disabled,.mopsUserEdit:disabled{opacity:.4;cursor:default;background:transparent}',
            '.mopsUserEdit[data-mops-running="1"]{opacity:.82}',
            '.mopsUserEdit[data-mops-running="1"]:hover{opacity:1}',
            '.mopsUserRevert:focus-visible,.mopsUserEdit:focus-visible{outline:2px solid var(--dsw-alias-border-l2,#b8b8b8);outline-offset:1px}',
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
      // 0.26.0：统一走 safeOpenSession。原实现只在 __MOPS_DEBUG 下才 warn，
      // 而这段注释本身就把「静默吞掉 → 视图重建从未生效」写成了事故档案 ——
      // 现在无条件 warn（排障时不必先知道要开哪个开关）。
      safeOpenSession(rawSid, 'after-write')
      const bare = bareSessionId(rawSid)
      // 0.25.0（手感）：三连 [150,700,1600] → 立即一次（__refreshSurface 自带
      // 300ms 尾随防抖）。视图重建后的「重算隐藏」兜底必须留，只是不再白等 1.6s。
      if (__refreshSurface) __refreshSurface(bare)
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
        // 0.24.0 P4：按 rawSid 取该会话自己的 InputActions；取不到就跳过 ——
        // 绝不能用别的会话的编辑器，那会把原文写进用户正在看的另一个会话。
        let editorSet = false
        const liveActions = inputActionsFor(rawSid)
        if (liveActions && typeof liveActions.setDraft === 'function') {
          try {
            liveActions.setDraft(text)
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
          // 0.24.0：旧对话框（约 407 行）已删除 —— 它只能通过一个从未有人
          // 设置的 LEGACY 开关到达（全仓库零处赋值）。面板是唯一实现。
          OpsPanel,
        ),
      )
      // 0.20.0：编辑并重发浮层（同族模态，order 102 排在 OpsPanel 之后 —— 两者互斥打开）
      ctx.slots.inject(OVERLAY_SLOT, () =>
        ctx.slots.register(
          {
            name: OVERLAY_SLOT,
            id: EDIT_ID,
            order: 102,
            ...(__locale ? { locale: NS } : {}),
          },
          EditResendOverlay,
        ),
      )
      installSidebarOps()
      installUserRevertInjector()
    }

    return {
      apply,
      inject: ['slots'],
      __test: {
        activityTransition,
        forkBoundaryBefore,
        writeSessionDraft,
        // 0.26.0：编辑并重发的编排层 + 官方发送面（可注入 deps 真执行断言时序）
        sendEditAndRevert,
        promptEditedText,
        editSeatOf,
        EDIT_SOURCE,
        EDIT_PANEL_GAP,
        EDIT_PANEL_MARGIN,
        EDIT_PANEL_MIN_WIDTH,
        EDIT_PANEL_MAX_WIDTH,
        EDIT_FLIP_MIN_HEIGHT,
        // 0.24.0 P4：按会话隔离的 InputActions 访问面（真执行测试用）
        rememberInputActions,
        forgetInputActions,
        inputActionsFor,
        sessionKeyOf,
        __inputActionsBySession,
        // 0.25.0（手感）：面板全文取数层（缓存 + 尾随防抖 + 单飞）的真执行测试面
        loadPanelText,
        clearPanelTextCache,
        PANEL_TEXT_DEBOUNCE_MS,
        EDIT_EVENT,
        EDIT_ID,
      },
    }
  },
})
