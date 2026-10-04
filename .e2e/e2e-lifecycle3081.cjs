// 终极全链路 e2e（0.5.1）：新建会话 → 发送 → 等模型回复 → 槽按钮一键回撤 →
// dock 出现 → 展开 → Restore → dock 消失 + 消息重放。只碰本测试新建的会话。
const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
const bootLog = fs.readFileSync('/data/data/com.termux/files/home/dsh3081.log', 'utf8');
const token = (bootLog.match(/token=([A-Za-z0-9_-]+)/) || [])[1];
delete process.env.LD_PRELOAD;
const log = (...a) => console.log('>>>', ...a);
(async () => {
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 150)); });
  await page.goto('http://127.0.0.1:3081/?token=' + token, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  for (let i = 0; i < 25; i++) { await page.waitForTimeout(1000); if (await page.evaluate(() => document.querySelectorAll('[role=treeitem]').length) > 0) break; }
  const bootFail = await page.evaluate(() => (document.body.innerText || '').includes('Failed to load plugins'));
  log('BOOT failure banner:', bootFail, '(want false)');
  const ns = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') || '') === 'New session');
    if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!ns) { log('FAIL: no New session'); await browser.close(); return; }
  await page.mouse.click(ns.x, ns.y);
  await page.waitForTimeout(3000);
  log('NEW SESSION opened');
  const input = page.locator('textarea, [contenteditable=true]').first();
  await input.click().catch(() => {});
  await input.fill('reply with exactly: ok').catch(async () => { await page.keyboard.type('reply with exactly: ok'); });
  await page.waitForTimeout(500);
  const sent = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') || '').includes('Send message'));
    if (b) { b.click(); return true; } return false;
  });
  log('SENT:', sent);
  if (!sent) { log('FAIL: no send'); await browser.close(); return; }
  let slot = null;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(3000);
    slot = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') || '') === 'Revert to here');
      if (!b || b.disabled) return null;
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (slot) break;
  }
  log('SLOT-BTN:', JSON.stringify(slot), '(want object)');
  if (!slot) { log('CERR-N', errors.length, errors.slice(0, 3)); await page.screenshot({ path: 'lifecycle-no-reply.png' }); await browser.close(); return; }
  await page.mouse.click(slot.x, slot.y);
  await page.waitForTimeout(4000);
  const dock1 = await page.evaluate(() => {
    const el = document.querySelector('.mopsRd');
    return el ? { dock: true, label: el.getAttribute('aria-label') } : { dock: false };
  });
  log('DOCK after revert:', JSON.stringify(dock1), '(want dock:true)');
  await page.screenshot({ path: 'lifecycle-1-dock.png' });
  const head = await page.evaluate(() => {
    const el = document.querySelector('.mopsRd .mopsRdHead');
    if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (head) { await page.mouse.click(head.x, head.y); await page.waitForTimeout(1200); }
  const rst = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.mopsRd button')).find((b) => (b.textContent || '').trim() === 'Restore');
    if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: b.disabled };
  });
  log('RESTORE btn:', JSON.stringify(rst), '(want object, disabled:false)');
  if (rst && !rst.disabled) { await page.mouse.click(rst.x, rst.y); await page.waitForTimeout(6000); }
  const dock2 = await page.evaluate(() => !!document.querySelector('.mopsRd'));
  log('DOCK after restore:', dock2, '(want false)');
  const msg = await page.evaluate(() => (document.body.innerText || '').includes('reply with exactly'));
  log('MESSAGE VISIBLE after restore:', msg, '(want true)');
  await page.screenshot({ path: 'lifecycle-2-restored.png' });
  log('CERR-N:', errors.length, errors.slice(0, 3));
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 300)); process.exit(1); });
