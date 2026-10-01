// E2E: disposable session revert test (opencode-style one-click)
const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
const token = fs.readFileSync('/data/data/com.termux/files/home/.config/opencode/kpad-dsh.token', 'utf8').trim();

(async () => {
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 150)); });
  await page.goto('http://127.0.0.1:3080/?token=' + token, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // click "New session" (first)
  const ns = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '') === 'New session');
    if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  console.log('NS', JSON.stringify(ns));
  if (ns) await page.mouse.click(ns.x, ns.y);
  await page.waitForTimeout(4000);

  // type hi and send
  const input = page.locator('textarea, [contenteditable=true]').first();
  await input.click().catch(e => console.log('input click err'));
  await input.fill('hi, reply with exactly: ok').catch(async () => { await page.keyboard.type('hi, reply with exactly: ok'); });
  await page.waitForTimeout(500);
  // send via button
  const send = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '').includes('Send message'));
    if (!b) return false; const r = b.getBoundingClientRect(); b.click(); return true;
  });
  console.log('SENT', send);
  // wait for assistant reply (up to 120s)
  let replied = false;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(2000);
    const check = await page.evaluate(() => {
      const t = (document.body.innerText || '').toLowerCase();
      return { t, running: t.includes('running') || t.includes('stop') };
    });
    if (check.t.includes('ok') && !check.running) { replied = true; break; }
  }
  console.log('REPLIED', replied);
  await page.screenshot({ path: '04-before-revert.png' });

  // our slot buttons on the assistant reply
  const probe = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return {
      revert: btns.filter(b => (b.getAttribute('aria-label') || '') === 'Revert to here').length,
      del: btns.filter(b => (b.getAttribute('aria-label') || '') === 'Delete this message').length,
    };
  });
  console.log('SLOT', JSON.stringify(probe));

  // click the FIRST revert button (one-click, no dialog)
  const rv = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '') === 'Revert to here');
    if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  console.log('RV', JSON.stringify(rv));
  if (rv) { await page.mouse.click(rv.x, rv.y); }
  await page.waitForTimeout(3000);

  const after = await page.evaluate(() => {
    const dkToast = document.querySelector('[aria-live]');
    return {
      toastish: dkToast ? (dkToast.textContent || '').slice(0, 80) : null,
      bodyLen: (document.body.innerText || '').length,
    };
  });
  console.log('AFTER', JSON.stringify(after));
  await page.screenshot({ path: '05-after-revert.png' });
  console.log('ERR-N', errors.length, errors.slice(0, 2));
  await browser.close();
})().catch(e => { console.error('FATAL', String(e).slice(0, 300)); process.exit(1); });
