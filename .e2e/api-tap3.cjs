const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
delete process.env.LD_PRELOAD;
const log = (...a) => console.log('>>>', ...a);
(async () => {
  const token = (fs.readFileSync('/data/data/com.termux/files/home/dsh3081.log', 'utf8').match(/token=([A-Za-z0-9_-]+)/) || [])[1];
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const reqs = [];
  context.on('request', (r) => { const u = r.url(); if (/\.(js|css|png|svg|woff2?|ico|map|html?)(\?|$)/.test(u) && !u.includes('api')) return; reqs.push(r.resourceType() + ' ' + r.method() + ' ' + u.replace(/^https?:\/\/[^/]+/, '').split('?')[0]); });
  context.on('serviceworker', (sw) => log('SERVICE WORKER:', sw.url()));
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:3081/?token=' + token, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  for (let i = 0; i < 25; i++) { await page.waitForTimeout(1000); if (await page.evaluate(() => document.querySelectorAll('[role=treeitem]').length) > 0) break; }
  await page.waitForTimeout(6000);
  log('CONTEXT CAPTURED (' + reqs.length + '):');
  console.log(reqs.slice(0, 50).join('\n'));
  // 检查页面里的传输痕迹
  const transport = await page.evaluate(() => {
    const hints = [];
    if (window.EventSource) hints.push('EventSource available');
    if (window.WebSocket) hints.push('WebSocket available');
    const perf = performance.getEntriesByType('resource').map((r) => r.name.replace(/^https?:\/\/[^/]+/, '').split('?')[0]).filter((n) => n.includes('api') || n.includes('event') || n.includes('stream') || n.includes('ws'));
    return { hints, perfRes: perf.slice(0, 20), swReady: navigator.serviceWorker ? 'controller:' + (navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : 'none') : 'unsupported' };
  });
  log('TRANSPORT HINTS:', JSON.stringify(transport, null, 1));
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 300)); process.exit(1); });
