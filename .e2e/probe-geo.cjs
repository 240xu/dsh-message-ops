const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
delete process.env.LD_PRELOAD;
const OUT = '/data/data/com.termux/files/home/dsh-plugins-src/dsh-message-ops/.e2e/opencode-research';
const log = (...a) => console.log('>>>', ...a);
const TEST_SID = 'session-2188f4ac-fa16-4560-9ded-d0555d0793c7';
(async () => {
  const bootLog = fs.readFileSync('/data/data/com.termux/files/home/dsh3081.log', 'utf8');
  const token = (bootLog.match(/token=([A-Za-z0-9_-]+)/) || [])[1];
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
    }, TEST_SID);
    if (target) break;
    await page.evaluate(() => {
      const ws = Array.from(document.querySelectorAll('[role=treeitem]')).find((e) => (e.textContent || '').trim().startsWith('zcode2api'));
      if (ws && ws.getAttribute('aria-expanded') !== 'true') ws.click();
      const more = Array.from(document.querySelectorAll('button')).find((b) => /^Show \d+ more/i.test((b.textContent || '').trim()));
      if (more) more.click();
    });
    await page.waitForTimeout(2000);
  }
  if (!target) { log('NO ROW'); await browser.close(); process.exit(2); }
  await page.mouse.dblclick(target.x, target.y);
  await page.waitForTimeout(3000);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(6000);

  const geo = await page.evaluate(() => {
    const R = (e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
    const stack = document.querySelector('[class*=composerStack]');
    const stackKids = stack ? Array.from(stack.children).map((c) => ({ tag: c.tagName, cls: String(c.className).slice(0, 60), slot: c.getAttribute('data-slot') || '', rect: R(c), disp: getComputedStyle(c).display })) : [];
    const docks = Array.from(document.querySelectorAll('.mopsRd')).map((e) => ({ rect: R(e), label: e.getAttribute('aria-label'), parentCls: String(e.parentElement.className).slice(0, 60), parentRect: R(e.parentElement) }));
    const tas = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]')).map((e) => ({ tag: e.tagName, rect: R(e) }));
    // 消息区滚动容器：scrollHeight-clientHeight>400 的可视元素
    const scrollers = Array.from(document.querySelectorAll('div')).filter((e) => e.scrollHeight - e.clientHeight > 400 && e.clientHeight > 300).slice(0, 5).map((e) => ({ cls: String(e.className).slice(0, 60), sh: e.scrollHeight, ch: e.clientHeight, st: e.scrollTop }));
    // 消息文本存在性（全页）
    const bodyHasFirst = (document.body.innerText || '').includes('分配多个子代理');
    // 会话体消息块粗采样（排除 sidebar/header：只在 centerCol 的滚动区）
    const center = document.querySelector('[data-dshCenterCol]');
    const centerTextLen = center ? (center.innerText || '').length : -1;
    return { stackKids, docks, tas, scrollers, bodyHasFirst, centerTextLen, scrollContainersSample: scrollers.map(s => s.cls) };
  });
  log('GEO:', JSON.stringify(geo, null, 1).slice(0, 3000));
  // 尝试把所有大滚动容器拉到顶，再查用户消息
  await page.evaluate(() => {
    document.querySelectorAll('div').forEach((e) => { if (e.scrollHeight - e.clientHeight > 400 && e.clientHeight > 300) e.scrollTop = 0; });
  });
  await page.waitForTimeout(1500);
  const msgCheck = await page.evaluate(() => {
    const hits = Array.from(document.querySelectorAll('div, p, span')).filter((e) => (e.innerText || '').trim().startsWith('分配多个子代理')).slice(0, 6).map((e) => {
      const r = e.getBoundingClientRect();
      return { cls: String(e.className).slice(0, 80), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), kids: e.children.length, dataAttrs: Object.keys(e.dataset || {}).join(',') };
    });
    return hits;
  });
  log('USER TEXT NODES AFTER SCROLL:', JSON.stringify(msgCheck, null, 1).slice(0, 1600));
  await page.screenshot({ path: OUT + '/91-geo.png' });
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 400)); process.exit(1); });
