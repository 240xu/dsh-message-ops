const { chromium } = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
delete process.env.LD_PRELOAD;
const log = (...a) => console.log('>>>', ...a);
(async () => {
  const token = (fs.readFileSync('/data/data/com.termux/files/home/.config/opencode/kpad-dsh.token', 'utf8') || '').trim();
  const browser = await chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://127.0.0.1:3080/?token=' + token, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(1000);
    const s = await page.evaluate(() => ({ mops: !!window.__dshDevkit || Array.from(document.querySelectorAll('button')).some((b) => /Message ops/i.test((b.getAttribute('aria-label') || ''))), tree: document.querySelectorAll('[role=treeitem]').length }));
    if (s.mops || (s.tree > 0 && i > 25)) { log('t=' + i + 's state:', JSON.stringify(s)); break }
  }
  await page.waitForTimeout(20000);
  const fin = await page.evaluate(() => ({
    devkitFace: !!window.__dshDevkit, keysInstalled: !!window.__dshDevkitKeysInstalled,
    msgOpsBtn: Array.from(document.querySelectorAll('button')).some((b) => /Message ops/i.test((b.getAttribute('aria-label') || ''))),
    mopsRd: !!document.querySelector('.mopsRd'),
  }));
  log('FINAL (after ~45s):', JSON.stringify(fin));
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 300)); process.exit(1); });
