// Round B：3080 上只读探测 devkit window 面 + e2e 打开会话通道
const { chromium } = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
delete process.env.LD_PRELOAD;
const log = (...a) => console.log('>>>', ...a);
(async () => {
  const token = (fs.readFileSync('/data/data/com.termux/files/home/.config/opencode/kpad-dsh.token', 'utf8') || '').trim();
  const browser = await chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://127.0.0.1:3080/?token=' + token, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  let booted = false;
  for (let i = 0; i < 30; i++) { await page.waitForTimeout(1000); if (await page.evaluate(() => document.querySelectorAll('[role=treeitem]').length) > 0) { booted = true; break } }
  log('GUI booted:', booted);
  await page.waitForTimeout(6000);
  const face = await page.evaluate(() => {
    const d = window.__dshDevkit;
    if (!d) return { present: false };
    return { present: true, keys: Object.keys(d), hasOpenSessions: typeof d.openSessions === 'function', hasToast: typeof d.toast === 'function', hasRegisterCommand: typeof d.registerCommand === 'function' };
  });
  log('DEVKIT FACE:', JSON.stringify(face));
  if (face.present && face.hasToast) {
    await page.evaluate(() => window.__dshDevkit.toast('devkit probe ok', { kind: 'info' }));
    await page.waitForTimeout(1500);
    const toastSeen = await page.evaluate(() => /devkit probe ok/.test(document.body.innerText || ''));
    log('toast rendered:', toastSeen);
  }
  if (face.present && face.hasOpenSessions) {
    const before = await page.evaluate(() => document.body.innerText.slice(0, 60));
    await page.evaluate(() => window.__dshDevkit.openSessions());
    await page.waitForTimeout(3000);
    const after = await page.evaluate(() => ({ text: document.body.innerText.slice(0, 120), dialogs: document.querySelectorAll('[role=dialog]').length }));
    log('openSessions → dialogs:', after.dialogs, '| changed:', before !== after.text);
  }
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 300)); process.exit(1); });
