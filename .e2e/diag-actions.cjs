// 只读：确认用户消息下方的官方动作行（xzv4MW_actions + copy 按钮）
const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
delete process.env.LD_PRELOAD;
const log = (...a) => console.log('>>>', ...a);
const SID = 'session-185f1f19-2353-4700-a227-862d201d2abf'; // 0.6.0 验证过的测试会话（有可见用户消息）
(async () => {
  const token = (fs.readFileSync('/data/data/com.termux/files/home/dsh3081.log', 'utf8').match(/token=([A-Za-z0-9_-]+)/) || [])[1];
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://127.0.0.1:3081/?token=' + token, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  for (let i = 0; i < 25; i++) { await page.waitForTimeout(1000); if (await page.evaluate(() => document.querySelectorAll('[role=treeitem]').length) > 0) break; }
  let target = null;
  for (let i = 0; i < 15 && !target; i++) {
    target = await page.evaluate((sid) => {
      const el = Array.from(document.querySelectorAll('[data-row-key]')).find((e) => (e.dataset.rowKey || '').includes(sid));
      if (!el) return null; el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return r.width > 0 ? { x: r.x + Math.min(r.width / 2, 150), y: r.y + r.height / 2 } : null;
    }, SID);
    if (target) break;
    await page.evaluate(() => {
      const ws = Array.from(document.querySelectorAll('[role=treeitem]')).find((e) => (e.textContent || '').trim().startsWith('zcode2api'));
      if (ws && ws.getAttribute('aria-expanded') !== 'true') ws.click();
      const more = Array.from(document.querySelectorAll('button')).find((b) => /^Show \d+ more/i.test((b.textContent || '').trim()));
      if (more) more.click();
    });
    await page.waitForTimeout(2000);
  }
  if (!target) { log('NO ROW'); await browser.close(); return; }
  await page.mouse.dblclick(target.x, target.y);
  await page.waitForTimeout(3000);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(5000);
  // 悬停第一条用户消息 → 看动作行
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('[data-chat-flow-kind="user"]'))[0];
    if (b) b.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(700);
  const pt = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('[data-chat-flow-kind="user"]'))[0];
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + Math.min(r.width / 2, 300), y: r.y + Math.min(r.height / 2, 26) };
  });
  if (pt) { await page.mouse.move(pt.x, pt.y, { steps: 5 }); await page.waitForTimeout(1000); }
  const info = await page.evaluate(() => {
    const blk = Array.from(document.querySelectorAll('[data-chat-flow-kind="user"]'))[0];
    const actions = blk ? blk.querySelector('[class*="xzv4MW_actions"]') : null;
    const bubble = blk ? blk.querySelector('[class*="Sixlwa_bubble"]') : null;
    const R = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
    return {
      block: R(blk),
      bubble: R(bubble),
      actionsRow: actions ? { rect: R(actions), cls: String(actions.className), kids: Array.from(actions.children).map((c) => String(c.className).slice(0, 40)), btns: Array.from(actions.querySelectorAll('button')).map((b) => (b.getAttribute('aria-label') || '').trim().slice(0, 24)), opacity: getComputedStyle(actions).opacity } : null,
      revealAttr: blk ? (blk.getAttribute('data-actions-reveal') || (blk.closest('[data-actions-reveal]') || {}).getAttribute && blk.closest('[data-actions-reveal]').getAttribute('data-actions-reveal')) : null,
      myInjected: !!document.querySelector('.mopsUserRevert'),
    };
  });
  log('USER MSG ACTIONS:', JSON.stringify(info, null, 1).slice(0, 1600));
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 300)); process.exit(1); });
