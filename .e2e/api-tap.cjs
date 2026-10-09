const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
delete process.env.LD_PRELOAD;
const log = (...a) => console.log('>>>', ...a);
(async () => {
  const token = (fs.readFileSync('/data/data/com.termux/files/home/dsh3081.log', 'utf8').match(/token=([A-Za-z0-9_-]+)/) || [])[1];
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const urls = new Map();
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith('http://127.0.0.1:3081')) return;
    const path = u.replace(/^https?:\/\/127\.0\.0\.1:3081/, '').split('?')[0];
    if (!path.startsWith('/api/')) return;
    const key = r.method() + ' ' + path;
    if (!urls.has(key)) urls.set(key, { n: 0, qs: (u.split('?')[1] || '').slice(0, 60) });
    urls.get(key).n++;
  });
  await page.goto('http://127.0.0.1:3081/?token=' + token, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  for (let i = 0; i < 25; i++) { await page.waitForTimeout(1000); if (await page.evaluate(() => document.querySelectorAll('[role=treeitem]').length) > 0) break; }
  await page.waitForTimeout(5000);
  // 打开一个会话（New session + 发一条）触发更多 API
  await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /New session|新建会话/i.test(x.getAttribute('aria-label') || x.title || x.textContent || '')); if (b) b.click(); });
  await page.waitForTimeout(5000);
  const ta = await page.$('textarea, [contenteditable="true"]');
  if (ta) { await ta.click(); await page.keyboard.type('api tap probe', { delay: 8 }); await page.keyboard.press('Enter'); await page.waitForTimeout(8000); }
  await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /stop/i.test(x.getAttribute('aria-label') || '')); if (b) b.click() }).catch(() => {});
  await page.waitForTimeout(4000);
  const rows = [...urls.entries()].sort().map(([k, v]) => k + '  x' + v.n);
  log('OFFICIAL API SURFACE (' + urls.size + '):');
  console.log(rows.join('\n'));
  fs.writeFileSync('/data/data/com.termux/files/home/dsh-plugin-hub/docs/dsh-mechanics/v0.2.0-rc.2/07-api-tap-raw.txt', rows.join('\n'));
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 300)); process.exit(1); });
