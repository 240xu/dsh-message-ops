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
  // 打开会话（避开当前主会话 4e10c1a2）
  const pt = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-row-key]')).filter((r) => !(r.dataset.rowKey || '').includes('4e10c1a2'));
    const r = rows[0]; if (!r) return null;
    r.scrollIntoView({ block: 'center' });
    const b = r.getBoundingClientRect();
    return { x: b.x + Math.min(b.width / 2, 150), y: b.y + b.height / 2, key: r.dataset.rowKey };
  });
  log('open row:', JSON.stringify(pt));
  if (pt) { await page.mouse.dblclick(pt.x, pt.y); await page.waitForTimeout(3000); await page.keyboard.press('Escape').catch(() => {}); }
  await page.waitForTimeout(20000);
  const s1 = await page.evaluate(() => ({
    composer: !!document.querySelector('textarea, [contenteditable="true"]'),
    devkitFace: !!window.__dshDevkit, keys: !!window.__dshDevkitKeysInstalled,
    msgOpsBtn: Array.from(document.querySelectorAll('button')).some((b) => /Message ops/i.test((b.getAttribute('aria-label') || ''))),
  }));
  log('AFTER OPEN:', JSON.stringify(s1));
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(3000);
  const s2 = await page.evaluate(() => ({ dialogs: document.querySelectorAll('[role=dialog]').length, text: (document.body.innerText || '').slice(0, 120).replace(/\s+/g, ' ') }));
  log('AFTER Ctrl+K:', JSON.stringify(s2));
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 300)); process.exit(1); });
