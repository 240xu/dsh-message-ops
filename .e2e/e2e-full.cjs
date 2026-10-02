// Full lifecycle: new session → send → wait reply (patient) → slot revert (real) → dock appears → restore → dock gone
const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
const token = fs.readFileSync('/data/data/com.termux/files/home/.config/opencode/kpad-dsh.token', 'utf8').trim();
delete process.env.LD_PRELOAD;
(async () => {
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 100)); });
  await page.goto('http://127.0.0.1:3080/?token=' + token, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // New session (first button)
  const ns = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '') === 'New session');
    if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (ns) await page.mouse.click(ns.x, ns.y);
  await page.waitForTimeout(4000);

  // send message
  const input = page.locator('textarea, [contenteditable=true]').first();
  await input.click().catch(() => {});
  await input.fill('reply with exactly: ok').catch(async () => { await page.keyboard.type('reply with exactly: ok'); });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '').includes('Send message'));
    if (b) b.click();
  });

  // patient reply wait: poll for an assistant actions row (Revert button) up to 150s
  let btn = null;
  for (let i = 0; i < 75; i++) {
    await page.waitForTimeout(2000);
    btn = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '') === 'Revert to here');
      if (!b) return null;
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: b.disabled };
    });
    if (btn) break;
  }
  console.log('SLOT-BTN', JSON.stringify(btn));
  if (!btn) { console.log('ERR-N', errors.length, errors.slice(0, 2)); await browser.close(); return; }

  // REAL revert click
  await page.mouse.click(btn.x, btn.y);
  await page.waitForTimeout(5000);

  // dock present?
  const dock1 = await page.evaluate(() => {
    const el = document.querySelector('.mopsRd');
    return el ? { dock: true, label: el.getAttribute('aria-label') } : { dock: false };
  });
  console.log('DOCK-1', JSON.stringify(dock1));
  await page.screenshot({ path: '10-dock.png' });

  // expand + restore
  const head = await page.evaluate(() => {
    const el = document.querySelector('.mopsRd .mopsRdHead');
    if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (head) { await page.mouse.click(head.x, head.y); await page.waitForTimeout(1000); }
  const rst = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim() === '恢复');
    if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: b.disabled };
  });
  console.log('RESTORE', JSON.stringify(rst));
  if (rst && !rst.disabled) await page.mouse.click(rst.x, rst.y);
  await page.waitForTimeout(5000);
  const dock2 = await page.evaluate(() => !!document.querySelector('.mopsRd'));
  console.log('DOCK-2 (should be false)', dock2);
  await page.screenshot({ path: '11-after-restore.png' });
  console.log('ERR-N', errors.length, errors.slice(0, 2));
  await browser.close();
})().catch(e => { console.error('FATAL', String(e).slice(0, 250)); process.exit(1); });
