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
