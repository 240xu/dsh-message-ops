const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
const bootLog = fs.readFileSync('/data/data/com.termux/files/home/dsh3081.log', 'utf8');
const token = (bootLog.match(/token=([A-Za-z0-9_-]+)/) || [])[1];
delete process.env.LD_PRELOAD;
(async () => {
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://127.0.0.1:3081/?token=' + token, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  for (let i = 0; i < 25; i++) { await page.waitForTimeout(1000); if (await page.evaluate(() => document.querySelectorAll('[role=treeitem]').length) > 0) break; }
  const diag = await page.evaluate(() => {
    const treeitems = Array.from(document.querySelectorAll('[role=treeitem]')).map(e => ({
      t: (e.textContent || '').trim().slice(0, 30),
      rk: (e.dataset && e.dataset.rowKey) || '(none)',
      exp: e.getAttribute('aria-expanded'),
    }));
    const rowKeys = Array.from(document.querySelectorAll('[data-row-key]')).map(e => e.dataset.rowKey);
    const hasZcode = treeitems.some(e => e.t.includes('zcode2api'));
    const hasTarget = rowKeys.some(k => k.includes('671d6d35'));
    return { treeN: treeitems.length, rowKeyN: rowKeys.length, hasZcode, hasTarget, treeitems: treeitems.slice(0, 15) };
  });
  console.log('DIAG', JSON.stringify(diag, null, 1).slice(0, 1500));
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 250)); process.exit(1); });
