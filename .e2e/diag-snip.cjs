const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
delete process.env.LD_PRELOAD;
const log = (...a) => console.log('>>>', ...a);
(async () => {
  const token = (fs.readFileSync('/data/data/com.termux/files/home/dsh3081.log', 'utf8').match(/token=([A-Za-z0-9_-]+)/) || [])[1];
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://127.0.0.1:3081/?token=' + token, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  for (let i = 0; i < 25; i++) { await page.waitForTimeout(1000); if (await page.evaluate(() => document.querySelectorAll('[role=treeitem]').length) > 0) break; }
  await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /New session|新建会话/i.test(x.getAttribute('aria-label') || x.title || x.textContent || '')); if (b) b.click(); });
  await page.waitForTimeout(5000);
  const SID = await page.evaluate(() => { const a = document.querySelector('[data-row-key][aria-current="true"], [data-row-key][aria-selected="true"]'); const k = a ? a.dataset.rowKey : null; return k && k.startsWith('session:') ? k.slice(8) : null });
  log('SID:', SID);
  const send = async (txt) => {
    const n0 = await page.evaluate(() => document.querySelectorAll('[data-chat-flow-kind="user"]').length);
    const ta = await page.$('textarea, [contenteditable="true"]'); await ta.click(); await page.keyboard.type(txt, { delay: 10 }); await page.keyboard.press('Enter');
    for (let i = 0; i < 15; i++) { await page.waitForTimeout(800); if (await page.evaluate(() => document.querySelectorAll('[data-chat-flow-kind="user"]').length) > n0) break; }
    await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /stop/i.test(x.getAttribute('aria-label') || '')); if (b) b.click() });
    await page.waitForTimeout(1500);
  };
  await send('KK delta one');
  await send('LL delta two');
  await page.waitForTimeout(1000);
  const api = await (await fetch(`http://127.0.0.1:3081/api/message-ops/messages?sessionId=${SID}`)).json();
  const snips = (api.messages || []).filter((m) => m.role === 'user').map((m) => ({ seq: m.seq, sn: (m.snippet || '').slice(0, 70), vis: m.visible }));
  log('API user snippets:', JSON.stringify(snips, null, 1));
  const dom = await page.evaluate(() => Array.from(document.querySelectorAll('.mopsUserRevert')).map((x) => {
    const blk = x.closest('[data-chat-flow-kind="user"]') || x.closest('[class*="Sixlwa_userRow"]') || x.parentElement;
    return { seq: blk.getAttribute ? blk.getAttribute('data-mops-seq') : null, txt: (blk.innerText || '').slice(0, 70).replace(/\s+/g, ' ') };
  }));
  log('DOM blocks:', JSON.stringify(dom, null, 1));
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 300)); process.exit(1); });
