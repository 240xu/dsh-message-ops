// E2E dock: open disposable session, real one-click revert, verify dock appears above composer
const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
const token = fs.readFileSync('/data/data/com.termux/files/home/.config/opencode/kpad-dsh.token', 'utf8').trim();

delete process.env.LD_PRELOAD;
(async () => {
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 120)); });
  await page.goto('http://127.0.0.1:3080/?token=' + token, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // robust open: try find; if absent click zcode2api row via mouse (toggle up to 2x)
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
  const diag = await page.evaluate(() => ({
    treeitems: document.querySelectorAll('[role=treeitem]').length,
    texts: Array.from(document.querySelectorAll('[role=treeitem]')).map(e => (e.textContent || '').trim().slice(0, 24)),
    bodyLen: (document.body.innerText || '').length,
    btnN: document.querySelectorAll('button').length,
  }));
  console.log('DIAG', JSON.stringify(diag));
  if (open1) await page.mouse.click(open1.x, open1.y);
  await page.waitForTimeout(9000);

  // one-click revert: click the Revert slot button (REAL this time)
  const btn = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '') === 'Revert to here');
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: b.disabled };
  });
  console.log('BTN', JSON.stringify(btn));
  if (btn && !btn.disabled) { await page.mouse.click(btn.x, btn.y); }
  await page.waitForTimeout(4000);

  // dock probe: role=region with aria-label 已回撤 or rolled back
  const dock = await page.evaluate(() => {
    const region = Array.from(document.querySelectorAll('[role=region]')).find(e => (e.getAttribute('aria-label') || '').match(/已回撤|rolled back/));
    if (!region) return { dock: false };
    return { dock: true, label: region.getAttribute('aria-label'), expandable: !!region.querySelector('button') };
  });
  console.log('DOCK', JSON.stringify(dock));
  // composer refill probe: is the draft filled with our reverted content? (only for user-message revert; this revert was on assistant message so draft should be empty)
  const draft = await page.evaluate(() => {
    const ta = document.querySelector('textarea');
    return ta ? (ta.value || '').slice(0, 60) : null;
  });
  console.log('DRAFT', JSON.stringify(draft));
  await page.screenshot({ path: '06-dock.png' });
  console.log('ERR-N', errors.length, errors.slice(0, 2));
  await browser.close();
})().catch(e => { console.error('FATAL', String(e).slice(0, 200)); process.exit(1); });
