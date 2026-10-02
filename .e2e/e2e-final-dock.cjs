// FINAL dock e2e: deterministic — no assistant reply needed (revert via dialog on user msg)
const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
const token = fs.readFileSync('/data/data/com.termux/files/home/.config/opencode/kpad-dsh.token', 'utf8').trim();
delete process.env.LD_PRELOAD;
(async () => {
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 120)); });
  await page.goto('http://127.0.0.1:3080/?token=' + token, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // 1. New session
  const ns = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '') === 'New session');
    if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (ns) await page.mouse.click(ns.x, ns.y);
  await page.waitForTimeout(4000);

  // 2. type + send
  const input = page.locator('textarea, [contenteditable=true]').first();
  await input.click().catch(() => {});
  await input.fill('dock e2e test message').catch(async () => { await page.keyboard.type('dock e2e test message'); });
  await page.waitForTimeout(400);
  const sent = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '').includes('Send message'));
    if (!b) return false; b.click(); return true;
  });
  console.log('SENT', sent);
  await page.waitForTimeout(12000); // give the model a chance; reply not required

  // 3. open our dialog via header button
  const hdr = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '').includes('Message ops'));
    if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  console.log('HDR', JSON.stringify(hdr));
  if (hdr) await page.mouse.click(hdr.x, hdr.y);
  await page.waitForTimeout(4000);

  // 4. pick the user message (radio of first message) — dialogs list messages; select first radio
  const picked = await page.evaluate(() => {
    const radios = Array.from(document.querySelectorAll('input[name=dsh-message-ops-pick]'));
    if (!radios.length) return { ok: false, modalText: (document.querySelector('[role=dialog],[aria-modal]') || {}).textContent?.slice(0, 80) || 'no modal' };
    radios[0].click();
    return { ok: true, count: radios.length };
  });
  console.log('PICKED', JSON.stringify(picked));
  await page.waitForTimeout(800);

  // 5. choose revert mode + ack + confirm
  const step2 = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('label'));
    const revLabel = labels.find(l => (l.textContent || '').includes('回滚到此条') || (l.textContent || '').includes('Revert'));
    if (!revLabel) return { step: 'no-revert-label' };
    const radio = revLabel.querySelector('input[type=radio]');
    if (radio) radio.click();
    return { step: 'mode-selected' };
  });
  console.log('STEP2', JSON.stringify(step2));
  await page.waitForTimeout(500);
  const step3 = await page.evaluate(() => {
    const cb = document.querySelector('input[type=checkbox]');
    if (cb && !cb.checked) cb.click();
    return { ack: true };
  });
  console.log('STEP3', JSON.stringify(step3));
  await page.waitForTimeout(400);
  const confirmed = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const confirm = btns.find(b => (b.textContent || '').trim() === '回滚' || (b.textContent || '').trim() === 'Revert');
    if (!confirm || confirm.disabled) return { ok: false, disabled: confirm ? confirm.disabled : 'no-btn' };
    confirm.click(); return { ok: true };
  });
  console.log('CONFIRMED', JSON.stringify(confirmed));
  await page.waitForTimeout(5000);

  // 6. dock probe (close dialog first)
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(1500);
  const dock = await page.evaluate(() => {
    const el = document.querySelector('.mopsRd');
    if (!el) return { dock: false };
    return { dock: true, label: el.getAttribute('aria-label') };
  });
  console.log('DOCK-FINAL', JSON.stringify(dock));
  console.log('ERR-N', errors.length, errors.slice(0, 2));
  await page.screenshot({ path: '09-final-dock.png' });
  await browser.close();
})().catch(e => { console.error('FATAL', String(e).slice(0, 250)); process.exit(1); });
