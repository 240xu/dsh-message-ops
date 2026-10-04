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

  // 1. 打开既有测试会话（轮询式：展开→找行→Show more→找行，直到出现）
    // TEST_SID 来自 argv（顶部已声明）
  const findRow = async () => page.evaluate((sid) => {
    const el = Array.from(document.querySelectorAll('[data-row-key]')).find(e => (e.dataset.rowKey || '').includes(sid));
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return r.width > 0 ? { x: r.x + Math.min(r.width / 2, 150), y: r.y + r.height / 2 } : null;
  }, TEST_SID);
  let found = null;
  for (let i = 0; i < 15 && !found; i++) {
    found = await findRow();
    if (found) break;
    // 未找到：确保 zcode2api 展开 + 尝试 Show more
    await page.evaluate(() => {
      const ws = Array.from(document.querySelectorAll('[role=treeitem]')).find(e => (e.textContent || '').trim().startsWith('zcode2api'));
      if (ws && ws.getAttribute('aria-expanded') !== 'true') ws.click();
      const more = Array.from(document.querySelectorAll('button')).find(b => /^Show \d+ more/i.test((b.textContent || '').trim()));
      if (more) more.click();
    });
    await page.waitForTimeout(2000);
  }
  log('FOUND ROW:', JSON.stringify(found));

  log('FOUND ROW:', JSON.stringify(found));
  if (!found) { await browser.close(); process.exit(2); }
  await page.mouse.dblclick(found.x, found.y);
  await page.waitForTimeout(8000);
  const open = await page.evaluate(() => (document.body.innerText || '').includes('zcode.z.ai'));
  log('OPEN:', open, '(want true)');
  await browser.close();
  process.exit(open ? 0 : 3);
})().catch((e) => { console.error('FATAL', String(e).slice(0, 250)); process.exit(1); });
