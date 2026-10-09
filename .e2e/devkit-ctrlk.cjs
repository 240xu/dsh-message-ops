const { chromium } = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
delete process.env.LD_PRELOAD;
const log = (...a) => console.log('>>>', ...a);
(async () => {
  const token = (fs.readFileSync('/data/data/com.termux/files/home/.config/opencode/kpad-dsh.token', 'utf8') || '').trim();
  const browser = await chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://127.0.0.1:3080/?token=' + token, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  for (let i = 0; i < 30; i++) { await page.waitForTimeout(1000); if (await page.evaluate(() => document.querySelectorAll('[role=treeitem]').length) > 0) break }
  await page.waitForTimeout(6000);
  const pre = await page.evaluate(() => ({ face: !!window.__dshDevkit, keys: !!window.__dshDevkitKeysInstalled, dialogs: document.querySelectorAll('[role=dialog]').length }));
  log('BEFORE Ctrl+K:', JSON.stringify(pre));
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(3000);
  const post = await page.evaluate(() => ({
    dialogs: document.querySelectorAll('[role=dialog]').length,
    face: !!window.__dshDevkit,
    paletteText: (document.body.innerText || '').slice(0, 200).replace(/\s+/g, ' '),
  }));
  log('AFTER Ctrl+K:', JSON.stringify(post).slice(0, 400));
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 300)); process.exit(1); });
