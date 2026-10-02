# E2E（Playwright 实机测试）

- `inspect3.cjs` — 渲染验证：打开真实会话，枚举主区按钮（含官方 Copy/feedback/Branch 与我们的槽按钮）
- `click-wire-test*.cjs` — 一键回撤接线测试：page.route 拦截 POST（零变更），
  验证 点击→fetch(POST /api/message-ops/revert {sessionId,seq}) 全链路
- 运行：`node inspect3.cjs`（需 live 3080 + ~/.config/opencode/kpad-dsh.token）
- 已证行为：会话 Running 时槽按钮 disabled（busy 保护，与 opencode assertNotBusy 同款）

## 实测结论（2026-10-01）
- 槽按钮在 AI 消息操作行渲染，官方图标，与 feedback/branch 并列 ✅
- 一键点击 → 正确 payload（sessionId+seq）→ 拦截确认 ✅
- 运行中会话按钮禁用 ✅
- 发现：第三方 dsh-message-edit 在 0.2.0 header 槽崩溃（旧 sessions face `.entries`）

## 0.5.x 实测补充（2026-10-02）
- `e2e-quote-final.cjs`：引用按钮实测——点击「Quote to composer」→ composer
  contenteditable 出现 `> ` 引用块 ✅（官方 InputActions.insertText 通道）
- 会话打开的关键：**dblclick** 会话行（单击只选中）；headless locale=en →
  aria-label 断言用英文文案
- 0.5.0 曾因 0.4.2 重写误删 INPUT_DOCK 常量导致客户端整体激活失败
  （页面横幅 Failed to load plugins）→ 0.5.1 修复；vm 冒烟可复现该类问题
