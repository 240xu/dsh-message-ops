const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
delete process.env.LD_PRELOAD;
const log = (...a) => console.log('>>>', ...a);
(async () => {
  const token = (fs.readFileSync('/data/data/com.termux/files/home/dsh3081.log', 'utf8').match(/token=([A-Za-z0-9_-]+)/) || [])[1];
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const reqs = new Map();
  page.on('request', (r) => {
    const u = r.url();
    if (/\.(js|css|png|svg|woff2?|ico|map)(\?|$)/.test(u)) return;
    const path = u.replace(/^https?:\/\/127\.0\.0\.1:3081/, '').split('?')[0];
    const key = r.method() + ' ' + path + (r.resourceType() === 'websocket' ? ' [WS]' : '');
    reqs.set(key + ' #' + Math.random().toString(36).slice(2, 6), (u.split('?')[1] || '').slice(0, 50));
  });
  page.on('websocket', (ws) => {
    reqs.set('WS ' + ws.url().replace(/^https?:\/\/127\.0\.0\.1:3081/, ''), 'websocket');
    ws.on('framereceived', (f) => { const p = String(f.payload || '').slice(0, 110); if (reqs.size < 500) reqs.set('WS-MSG ← ' + p.replace(/\s+/g, ' '), '') });
  });
  await page.goto('http://127.0.0.1:3081/?token=' + token, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  for (let i = 0; i < 25; i++) { await page.waitForTimeout(1000); if (await page.evaluate(() => document.querySelectorAll('[role=treeitem]').length) > 0) break; }
  await page.waitForTimeout(4000);
  await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /New session|新建会话/i.test(x.getAttribute('aria-label') || x.title || x.textContent || '')); if (b) b.click(); });
  await page.waitForTimeout(6000);
  log('CAPTURED (' + reqs.size + '):');
  let i = 0;
  for (const [k, v] of reqs) { if (i++ > 40) { log('…(truncated)'); break } console.log(' ', k, v ? '│ ' + v : ''); }
  fs.writeFileSync('/data/data/com.termux/files/home/dsh-plugin-hub/docs/dsh-mechanics/v0.2.0-rc.2/07-api-tap-raw.txt', [...reqs.entries()].map(([k, v]) => k + (v ? ' │ ' + v : '')).join('\n'));
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 300)); process.exit(1); });
