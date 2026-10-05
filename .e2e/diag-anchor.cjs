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
  const send = async (txt) => {
    const n0 = await page.evaluate(() => document.querySelectorAll('[data-chat-flow-kind="user"]').length);
    const ta = await page.$('textarea, [contenteditable="true"]'); await ta.click(); await page.keyboard.type(txt, { delay: 10 }); await page.keyboard.press('Enter');
    for (let i = 0; i < 15; i++) { await page.waitForTimeout(800); if (await page.evaluate(() => document.querySelectorAll('[data-chat-flow-kind="user"]').length) > n0) break; }
    await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /stop/i.test(x.getAttribute('aria-label') || '')); if (b) b.click() });
    await page.waitForTimeout(1500);
  };
  await send('MM one body'); await send('NN two body'); await send('OO three body');
  const snap = () => page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[class*="xzv4MW_actions"]'));
    const userRows = Array.from(document.querySelectorAll('[class*="Sixlwa_userRow"]'));
    const kind = Array.from(document.querySelectorAll('[data-chat-flow-kind="user"]'));
    const btns = Array.from(document.querySelectorAll('.mopsUserRevert'));
    return {
      actionsRows: rows.length,
      userRowEls: userRows.length,
      kindEls: kind.length,
      myBtns: btns.length,
      btnParents: btns.map((b) => String(b.parentElement.className).slice(0, 40)),
      btnSeqs: btns.map((b) => { const blk = b.closest('[data-chat-flow-kind="user"]') || b.parentElement; return blk.getAttribute && blk.getAttribute('data-mops-seq'); }),
      kindTexts: kind.map((k) => (k.innerText || '').slice(0, 26).replace(/\s+/g, ' ')),
      actionsParents: rows.map((r) => { const p = r.closest('[data-chat-flow-kind="user"]') ? 'kind-user' : (r.closest('[class*="Sixlwa_userRow"]') ? 'userRow' : String(r.parentElement.className).slice(0, 30)); return p; }),
    };
  });
  log('SID:', SID);
  log('SNAP 1:', JSON.stringify(await snap()));
  await page.mouse.move(700, 400, { steps: 4 }); await page.waitForTimeout(1500);
  log('SNAP 2 (after hover):', JSON.stringify(await snap()));
  await page.evaluate(() => window.dispatchEvent(new Event('scroll'))); await page.waitForTimeout(2000);
  log('SNAP 3 (after scan):', JSON.stringify(await snap()));
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 300)); process.exit(1); });
