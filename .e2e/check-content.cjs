// 终验：devkit 开会话 → composer + [恢复] 重放内容可见 + dock 状态
const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
const bootLog = fs.readFileSync('/data/data/com.termux/files/home/dsh3081.log', 'utf8');
const token = (bootLog.match(/token=([A-Za-z0-9_-]+)/) || [])[1];
delete process.env.LD_PRELOAD;
const TEST_SID = 'session-2188f4ac-fa16-4560-9ded-d0555d0793c7';
const log = (...a) => console.log('>>>', ...a);
(async () => {
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://127.0.0.1:3081/?token=' + token, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  for (let i = 0; i < 25; i++) { await page.waitForTimeout(1000); if (await page.evaluate(() => document.querySelectorAll('[role=treeitem]').length) > 0) break; }
  // devkit 会话切换 → 打开目标
  const dk = await page.evaluate(() => !!(window.__dshDevkit && typeof window.__dshDevkit.openSessions === 'function'));
  log('devkit:', dk);
  if (dk) {
    await page.evaluate(() => window.__dshDevkit.openSessions());
    await page.waitForTimeout(1500);
    await page.evaluate((sid) => {
      const inp = Array.from(document.querySelectorAll('input')).find((i) => i.offsetParent !== null && !i.disabled);
      if (!inp) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, sid.slice(8, 20));
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.focus();
    }, TEST_SID);
    await page.waitForTimeout(1200);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(7000);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(1000);
  }
  const state = await page.evaluate((sid) => {
    const active = document.querySelector('[data-row-key][aria-current="true"], [data-row-key].active, [data-row-key][data-active="true"]');
    const body = document.body.innerText || '';
    return {
      activeKey: active ? active.dataset.rowKey.slice(0, 40) : null,
      composer: !!document.querySelector('textarea, [contenteditable="true"]'),
      replayVisible: body.includes('[恢复]'),
      dock: !!document.querySelector('.mopsRd'),
      want: sid.slice(0, 40),
    };
  }, TEST_SID);
  log('STATE:', JSON.stringify(state));
  await page.screenshot({ path: 'content-final.png' });
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 300)); process.exit(1); });
