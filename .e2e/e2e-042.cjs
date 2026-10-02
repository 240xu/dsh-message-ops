// E2E 0.4.2: real revert → dock appears → restore → dock disappears
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

  // open the disposable session (robust: expand zcode2api up to 3x)
  const tryOpen = async () => {
    for (let i = 0; i < 3; i++) {
      const p = await page.evaluate(() => {
        let title = null;
        for (const el of document.querySelectorAll('[role=treeitem] *')) {
          if ((el.textContent || '').includes('hi, reply with exactly') && (!title || el.textContent.length < title.textContent.length)) title = el;
        }
        if (!title) return null;
        const b = title.getBoundingClientRect();
        return b.width > 0 ? { x: b.x + Math.min(b.width / 2, 150), y: b.y + b.height / 2 } : null;
      });
      if (p) return p;
      const wp = await page.evaluate(() => {
        const row = Array.from(document.querySelectorAll('[role=treeitem]')).find(e => (e.textContent || '').includes('zcode2api'));
        if (!row) return null; const b = row.getBoundingClientRect(); return { x: b.x + 20, y: b.y + b.height / 2 };
      });
      if (wp) await page.mouse.click(wp.x, wp.y);
      await page.waitForTimeout(2500);
    }
    return null;
  };
  const open1 = await tryOpen();
  console.log('OPEN1', JSON.stringify(open1));
  const tree = await page.evaluate(() => Array.from(document.querySelectorAll('[role=treeitem]')).map(e => ({ t: (e.textContent || '').trim().slice(0, 26), exp: e.getAttribute('aria-expanded') })));
  console.log('TREE', JSON.stringify(tree));
  if (open1) await page.mouse.click(open1.x, open1.y);
  await page.waitForTimeout(9000);

  // REAL one-click revert on the assistant reply
  const btn = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '') === 'Revert to here');
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: b.disabled };
  });
  console.log('BTN', JSON.stringify(btn));
  if (btn && !btn.disabled) await page.mouse.click(btn.x, btn.y);
  await page.waitForTimeout(5000);

  // dock probe: our region with aria-label 已回撤
  const dock1 = await page.evaluate(() => {
    const region = Array.from(document.querySelectorAll('[role=region],[aria-label]')).find(e => (e.getAttribute && (e.getAttribute('aria-label') || '')).match ? (e.getAttribute('aria-label') || '').includes('已回撤') : false);
    if (!region) return { dock: false };
    const r = region.getBoundingClientRect();
    return { dock: true, label: region.getAttribute('aria-label'), h: Math.round(r.height), w: Math.round(r.width) };
  });
  console.log('DOCK-1', JSON.stringify(dock1));
  await page.screenshot({ path: '06-dock-after-revert.png' });

  // expand the dock (click header) and find Restore button
  const head = await page.evaluate(() => {
    const region = Array.from(document.querySelectorAll('[role=region]')).find(e => (e.getAttribute('aria-label') || '').includes('已回撤'));
    if (!region) return null;
    const h = region.querySelector('[role=button]') || region.querySelector('button');
    if (!h) return null; const r = h.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (head) { await page.mouse.click(head.x, head.y); await page.waitForTimeout(1200); }
  const restoreBtn = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim() === '恢复');
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  console.log('RESTORE-BTN', JSON.stringify(restoreBtn));
  if (restoreBtn) await page.mouse.click(restoreBtn.x, restoreBtn.y);
  await page.waitForTimeout(5000);

  // dock should disappear (restored → active markers empty)
  const dock2 = await page.evaluate(() => {
    const region = Array.from(document.querySelectorAll('[role=region],[aria-label]')).find(e => (e.getAttribute && (e.getAttribute('aria-label') || '')).match ? (e.getAttribute('aria-label') || '').includes('已回撤') : false);
    return { dock: !!region };
  });
  console.log('DOCK-2 (should be false)', JSON.stringify(dock2));
  await page.screenshot({ path: '07-dock-after-restore.png' });
  console.log('ERR-N', errors.length, errors.slice(0, 2));
  await browser.close();
})().catch(e => { console.error('FATAL', String(e).slice(0, 250)); process.exit(1); });
