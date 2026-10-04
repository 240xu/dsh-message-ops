// 可复用：展开 zcode2api + 打开指定会话，带回显
const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
const bootLog = fs.readFileSync('/data/data/com.termux/files/home/dsh3081.log', 'utf8');
const token = (bootLog.match(/token=([A-Za-z0-9_-]+)/) || [])[1];
delete process.env.LD_PRELOAD;
const TEST_SID = process.argv[2] || 'session-671d6d35-39b5-427b-89df-c38e3dbe9bae';
const log = (...a) => console.log('>>>', ...a);
(async () => {
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://127.0.0.1:3081/?token=' + token, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  for (let i = 0; i < 25; i++) { await page.waitForTimeout(1000); if (await page.evaluate(() => document.querySelectorAll('[role=treeitem]').length) > 0) break; }

  // 展开 zcode2api（点 rowKey 或文本行，最多 3 次，回显 exp 变化）
  for (let i = 0; i < 3; i++) {
    const st = await page.evaluate((sid) => {
      const ws = Array.from(document.querySelectorAll('[role=treeitem]')).find(e => (e.textContent || '').trim().startsWith('zcode2api'));
      const target = Array.from(document.querySelectorAll('[data-row-key]')).find(e => (e.dataset.rowKey || '').includes(sid));
      const exp = ws ? ws.getAttribute('aria-expanded') : null;
      const b = ws ? ws.getBoundingClientRect() : null;
      return { exp, hasWs: !!ws, hasTarget: !!target, wsRect: b ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width) } : null,
               sessionRows: document.querySelectorAll('[data-row-key^="session:"]').length };
    }, TEST_SID);
    log('iter' + i, JSON.stringify(st));
    if (st.hasTarget) break;
    if (st.hasWs && st.exp !== 'true' && st.wsRect) {
      await page.mouse.click(st.wsRect.x + 30, st.wsRect.y + st.wsRect.w * 0 + 10); // 点 chevron 附近
      await page.waitForTimeout(2500);
    } else if (st.hasWs && st.exp === 'true') {
      // 已展开但 target 不在 —— 可能分页：找 "Show" 按钮
      const showed = await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button')).find(b => /^Show \d+ more/i.test((b.textContent || '').trim()));
        if (!b) return false; b.click(); return true;
      });
      log('SHOW MORE clicked:', showed);
      await page.waitForTimeout(2000);
    } else break;
  }
  const rowsDump = await page.evaluate(() => Array.from(document.querySelectorAll('[data-row-key^="session:"]')).map(e => e.dataset.rowKey.slice(8, 40)));
  log('ROWS:', JSON.stringify(rowsDump));
  const moreInfo = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button')).map(b => (b.textContent || '').trim()).filter(t => /show|more|显示/i.test(t));
    return { moreBtns: btns.slice(0, 4) };
  });
  log('MORE:', JSON.stringify(moreInfo));
  const found = await page.evaluate((sid) => {
    const el = Array.from(document.querySelectorAll('[data-row-key]')).find(e => (e.dataset.rowKey || '').includes(sid));
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x + Math.min(r.width / 2, 150), y: r.y + r.height / 2 };
  }, TEST_SID);
  log('FOUND ROW:', JSON.stringify(found));
  if (!found) { await browser.close(); process.exit(2); }
  await page.mouse.dblclick(found.x, found.y);
  await page.waitForTimeout(8000);
  const open = await page.evaluate(() => (document.body.innerText || '').includes('loop e2e target message'));
  log('OPEN:', open, '(want true)');
  await browser.close();
  process.exit(open ? 0 : 3);
})().catch((e) => { console.error('FATAL', String(e).slice(0, 250)); process.exit(1); });
