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
    const ta = await page.$('textarea, [contenteditable="true"]');
    await ta.click(); await page.keyboard.type(txt, { delay: 10 }); await page.keyboard.press('Enter');
    for (let i = 0; i < 15; i++) { await page.waitForTimeout(800); if (await page.evaluate(() => document.querySelectorAll('[data-chat-flow-kind="user"]').length) > n0) break; }
    // 立刻 Stop
    await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /stop/i.test(x.getAttribute('aria-label') || '')); if (b) b.click() });
    await page.waitForTimeout(1500);
    log('sent:', txt.slice(0, 18));
  };
  await send('AA probe first');
  await send('BB probe second');
  await page.waitForTimeout(1500);
  // 悬停第二条用户消息
  await page.evaluate(() => { const b = Array.from(document.querySelectorAll('[data-chat-flow-kind="user"]')).find((x) => (x.innerText || '').includes('BB probe second')); if (b) b.scrollIntoView({ block: 'center' }); });
  await page.waitForTimeout(700);
  const pt = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('[data-chat-flow-kind="user"]')).find((x) => (x.innerText || '').includes('BB probe second')); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + Math.min(r.width / 2, 300), y: r.y + Math.min(r.height / 2, 26) }; });
  if (pt) { await page.mouse.move(pt.x, pt.y, { steps: 5 }); await page.waitForTimeout(1200); }
  const info = await page.evaluate(() => {
    const blk = Array.from(document.querySelectorAll('[data-chat-flow-kind="user"]')).find((x) => (x.innerText || '').includes('BB probe second'));
    const R = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), b: Math.round(r.bottom) }; };
    const actions = blk ? blk.querySelector('[class*="xzv4MW_actions"]') : null;
    const bubble = blk ? blk.querySelector('[class*="Sixlwa_bubble"]') : null;
    const allActions = Array.from((blk || document).querySelectorAll('[class*="xzv4MW_actions"]')).map((a) => ({ rect: R(a), op: getComputedStyle(a).opacity, btns: Array.from(a.querySelectorAll('button')).map((b) => (b.getAttribute('aria-label') || '').trim().slice(0, 20)) }));
    return {
      block: R(blk), bubble: bubble ? R(bubble) : null,
      actionsInBlock: actions ? { rect: R(actions), op: getComputedStyle(actions).opacity, btns: Array.from(actions.querySelectorAll('button')).map((b) => (b.getAttribute('aria-label') || '').trim().slice(0, 22)), kids: Array.from(actions.children).map((c) => String(c.className).slice(0, 44)) } : null,
      allActionsRows: allActions,
      reveal: blk ? (blk.getAttribute('data-actions-reveal') || (blk.parentElement && blk.parentElement.getAttribute && blk.parentElement.getAttribute('data-actions-reveal'))) : null,
      injected: !!document.querySelector('.mopsUserRevert'),
      html: blk ? blk.outerHTML.replace(/\s+/g, ' ').slice(0, 700) : null,
    };
  });
  log('USER MSG ACTIONS:', JSON.stringify(info, null, 1).slice(0, 2000));
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 300)); process.exit(1); });
