// E2E 0.5.0: revert → openSession re-reveal → visible collapse. Read-only on user sessions: use a completed session and intercept-abort? NO — the reveal behavior needs a REAL marker. Use the user's OWN session WITH markers (4e10c1a2, 9 markers) — but revert there mutates it...
// SAFER: verify the QUOTE button (non-destructive!) on the user's session + verify reveal wiring by clicking revert with route-intercept (abort) — the reveal only fires after success so interception proves wiring only.
// Compromise: test quote for real (harmless — just fills composer), test revert wiring via interception, and test reveal semantics in isolation.
const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
const token = fs.readFileSync('/data/data/com.termux/files/home/.config/opencode/kpad-dsh.token', 'utf8').trim();
delete process.env.LD_PRELOAD;
(async () => {
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://127.0.0.1:3080/?token=' + token, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  // wait for app shell (treeitems or sidebar) up to 20s
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000);
    const ready = await page.evaluate(() => document.querySelectorAll('[role=treeitem]').length);
    if (ready > 0) break;
  }

  // open the marker session (4e10c1a2) via row-key
  const tryOpen = async () => {
    for (let i = 0; i < 4; i++) {
      const p = await page.evaluate(() => {
        const row = Array.from(document.querySelectorAll('[data-row-key]')).find(e => (e.dataset.rowKey || '').includes('4e10c1a2'));
        if (!row) return null;
        const b = row.getBoundingClientRect();
        return b.width > 0 ? { x: b.x + Math.min(b.width / 2, 150), y: b.y + b.height / 2 } : null;
      });
      if (p) return p;
      const wp = await page.evaluate(() => {
        const row = Array.from(document.querySelectorAll('[role=treeitem]')).find(e => (e.textContent || '').includes('dsh面板聚合'));
        if (!row) return null; const b = row.getBoundingClientRect(); return { x: b.x + 20, y: b.y + b.height / 2 };
      });
      if (wp) {
        await page.mouse.click(wp.x, wp.y);
        await page.waitForTimeout(2000);
        // check again after this toggle
        const p2 = await page.evaluate(() => {
          const row = Array.from(document.querySelectorAll('[data-row-key]')).find(e => (e.dataset.rowKey || '').includes('4e10c1a2'));
          if (!row) return null;
          const b = row.getBoundingClientRect();
          return b.width > 0 ? { x: b.x + Math.min(b.width / 2, 150), y: b.y + b.height / 2 } : null;
        });
        if (p2) return p2;
      }
      await page.waitForTimeout(1500);
    }
    return null;
  };
  const open1 = await tryOpen();
  console.log('OPEN1', JSON.stringify(open1));
  const tree = await page.evaluate(() => Array.from(document.querySelectorAll('[role=treeitem]')).map(e => ({ t: (e.textContent || '').trim().slice(0, 24), exp: e.getAttribute('aria-expanded') })).slice(0, 12));
  console.log('TREE', JSON.stringify(tree));
  const state = await page.evaluate(() => ({ bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 600) }));
  console.log('BODYTEXT', JSON.stringify(state));
  console.log('FULL-ERRS:');
  for (const e of errors) console.log('  *', e);
  if (open1) await page.mouse.click(open1.x, open1.y);
  await page.waitForTimeout(9000);

  // QUOTE test (harmless): click 引用 button → composer (textarea) should contain '> '
  const qbtn = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '') === 'Quote to composer' || (b.getAttribute('aria-label') || '') === '引用到输入框');
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  console.log('QUOTE-BTN', JSON.stringify(qbtn));
  if (qbtn) await page.mouse.click(qbtn.x, qbtn.y);
  await page.waitForTimeout(1500);
  const composer = await page.evaluate(() => {
    const ta = document.querySelector('textarea');
    return ta ? { len: (ta.value || '').length, startsQuote: (ta.value || '').startsWith('> ') } : null;
  });
  console.log('COMPOSER', JSON.stringify(composer));
  await page.screenshot({ path: '12-quote.png' });
  await browser.close();
})().catch(e => { console.error('FATAL', String(e).slice(0, 250)); process.exit(1); });
