const { chromium } = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
delete process.env.LD_PRELOAD;
const log = (...a) => console.log('>>>', ...a);
(async () => {
  const token = (fs.readFileSync('/data/data/com.termux/files/home/.config/opencode/kpad-dsh.token', 'utf8') || '').trim();
  const browser = await chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('console', (m) => { const t = m.text(); if (m.type() === 'error' || /devkit/i.test(t)) errs.push(m.type() + ': ' + t.slice(0, 160)) });
  page.on('pageerror', (e) => errs.push('pageerror: ' + String(e).slice(0, 160)));
  await page.goto('http://127.0.0.1:3080/?token=' + token, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  for (let i = 0; i < 30; i++) { await page.waitForTimeout(1000); if (await page.evaluate(() => document.querySelectorAll('[role=treeitem]').length) > 0) break }
  await page.waitForTimeout(6000);
  const ctrl = await page.evaluate(() => ({
    msgOpsHeaderBtn: Array.from(document.querySelectorAll('button')).some((b) => /Message ops|消息操作/i.test((b.getAttribute('aria-label') || b.title || b.textContent || ''))),
    websearchBtn: Array.from(document.querySelectorAll('button,[role=button]')).some((b) => /websearch|网络搜索/i.test((b.getAttribute('aria-label') || b.title || b.textContent || ''))),
    mopsRd: !!document.querySelector('.mopsRd'),
  }));
  log('CONTROL (其他插件客户端是否活跃):', JSON.stringify(ctrl));
  log('DEVKIT-RELATED CONSOLE (' + errs.length + '):');
  console.log(errs.slice(0, 12).join('\n'));
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 300)); process.exit(1); });
