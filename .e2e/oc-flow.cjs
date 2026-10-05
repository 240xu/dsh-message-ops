// opencode 回滚全流程调研：建测试会话 → 发消息 → hover 动作 → 回滚 → 恢复条样式
const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
delete process.env.LD_PRELOAD;
const OUT = '/data/data/com.termux/files/home/dsh-plugins-src/dsh-message-ops/.e2e/opencode-research';
const log = (...a) => console.log('>>>', ...a);
const API = 'http://127.0.0.1:4096';
const j = async (path, opts) => {
  const r = await fetch(API + path, Object.assign({ headers: { 'content-type': 'application/json' } }, opts || {}));
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t.slice(0, 200) }; }
};
(async () => {
  // 1. 建测试会话
  let ses = await j('/session', { method: 'POST', body: JSON.stringify({ directory: '/data/data/com.termux/files/home' }) });
  log('CREATE SESSION:', ses.status, JSON.stringify(ses.body).slice(0, 220));
  const sid = ses.body && ses.body.id;
  if (!sid) { log('no session id'); process.exit(2); }

  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => { if (m.type() === 'error') log('CERR:', m.text().slice(0, 140)); });
  // 2. 打开会话页（双路由兜底）
  for (const url of [`${API}/session/${sid}`, `${API}/global/session/${sid}`, `${API}/home/session/${sid}`]) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3500);
    const ok = await page.evaluate(() => !!document.querySelector('textarea, [contenteditable="true"]'));
    log('route try', url, 'composer:', ok);
    if (ok) break;
  }
  await page.screenshot({ path: OUT + '/10-session.png' });
  // 3. 发消息（UI 键入）
  const composer = await page.$('textarea, [contenteditable="true"]');
  if (!composer) { log('NO COMPOSER'); await browser.close(); process.exit(3); }
  await composer.click();
  await page.keyboard.type('Reply with exactly: OK research.', { delay: 15 });
  await page.keyboard.press('Enter');
  log('message sent');
  // 4. 轮询等 assistant 回复
  let msgs = [];
  for (let i = 0; i < 45; i++) {
    await page.waitForTimeout(2000);
    const r = await j(`/session/${sid}/message`);
    msgs = (r.body && (r.body.info ? [r.body] : r.body)) || [];
    const parts = r.body && r.body.parts ? r.body.parts : [];
    const roles = (Array.isArray(msgs) ? msgs.map((m) => m.role || (m.info && m.info.role)) : []).filter(Boolean);
    log('poll', i, 'status', r.status, 'roles', JSON.stringify(roles.slice(-4)));
    const text = JSON.stringify(r.body || {}).slice(0, 0);
    if (JSON.stringify(r.body || {}).includes('OK research')) { log('assistant replied'); break; }
    if (i > 20 && roles.filter((x) => x === 'assistant').length) { log('assistant role seen'); break; }
  }
  await page.waitForTimeout(3000);
  await page.screenshot({ path: OUT + '/11-with-reply.png' });
  // 5. 消息 DOM 结构 + hover 动作
  const dom1 = await page.evaluate(() => {
    const msgsEls = Array.from(document.querySelectorAll('[data-role], [data-message-id], [class*=message]')).slice(0, 40);
    return {
      dataRole: Array.from(document.querySelectorAll('[data-role]')).map((e) => e.getAttribute('data-role') + '|' + (e.className || '').slice(0, 40)).slice(0, 12),
      candidates: msgsEls.map((e) => (e.tagName + '.' + String(e.className).slice(0, 60))).slice(0, 20),
      bodyHead: (document.body.innerText || '').slice(0, 400),
    };
  });
  log('DOM:', JSON.stringify(dom1, null, 1).slice(0, 1500));
  // 6. hover 到 assistant 消息（找可点动作）
  const hoverInfo = await page.evaluate(() => {
    // 找含 OK research 的块
    const all = Array.from(document.querySelectorAll('div,article,li'));
    const target = all.filter((e) => (e.innerText || '').includes('OK research') && e.children.length < 40).sort((a, b) => a.innerText.length - b.innerText.length)[0];
    if (!target) return null;
    const r = target.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 40), cls: String(target.className).slice(0, 60) };
  });
  log('HOVER TARGET:', JSON.stringify(hoverInfo));
  if (hoverInfo) {
    await page.mouse.move(hoverInfo.x, hoverInfo.y, { steps: 6 });
    await page.waitForTimeout(1200);
    const acts = await page.evaluate(() => Array.from(document.querySelectorAll('button, [role=button]')).map((b) => {
      const r = b.getBoundingClientRect();
      if (r.width === 0 || r.y < 100) return null;
      return { t: ((b.getAttribute('aria-label') || b.title || b.textContent) || '').trim().slice(0, 40), x: Math.round(r.x), y: Math.round(r.y), cls: String(b.className).slice(0, 40) };
    }).filter(Boolean).slice(0, 40));
    log('VISIBLE ACTIONS AFTER HOVER:', JSON.stringify(acts, null, 1));
  }
  await page.screenshot({ path: OUT + '/12-hover.png' });
  fs.writeFileSync(OUT + '/session-id.txt', sid);
  log('SESSION:', sid);
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 400)); process.exit(1); });
