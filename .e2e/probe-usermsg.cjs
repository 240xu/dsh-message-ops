// 探官方用户消息 DOM + assistant-actions 槽容器（3081，只读）
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
  // 侧栏轮询打开测试会话（既有实证流程）
  let target = null;
  for (let i = 0; i < 15 && !target; i++) {
    target = await page.evaluate((sid) => {
      const el = Array.from(document.querySelectorAll('[data-row-key]')).find((e) => (e.dataset.rowKey || '').includes(sid));
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
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
  // 滚到顶部（用户消息在上）
  await page.evaluate(() => {
    const scroll = document.querySelector('[class*=scrollBody], [class*=ScrollBody]');
    if (scroll) scroll.scrollTop = 0;
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(1500);
  // 用户消息锚点：已知首条用户文本（header 也会有 → 只取 y>90 的会话体）
  const userMsg = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('div,article,p'));
    const hits = all.filter((e) => (e.innerText || '').trim().startsWith('https://zcode.z.ai/cn#all-downloads') && e.children.length < 20);
    return hits.map((e) => {
      const r = e.getBoundingClientRect();
      return {
        cls: String(e.className).slice(0, 110),
        y: Math.round(r.y), h: Math.round(r.height), w: Math.round(r.width),
        txt: (e.innerText || '').replace(/\s+/g, ' ').slice(0, 70),
        depth: (() => { let d = 0, n = e; while (n.parentElement) { d++; n = n.parentElement; } return d; })(),
        btns: Array.from(e.querySelectorAll('button')).map((b) => ((b.getAttribute('aria-label') || b.textContent) || '').trim().slice(0, 30)).slice(0, 10),
        dataAttrs: Object.keys(e.dataset || {}).join(','),
        childCls: Array.from(e.children).slice(0, 6).map((c) => String(c.className).slice(0, 55)),
      };
    });
  });
  const userMsgLog = 'USER MSG CANDIDATES: ' + JSON.stringify(userMsg, null, 1).slice(0, 2600);
  log(userMsgLog);
  // 官方 assistant-actions 槽容器（我们按钮挂哪） + slot wrapper 元素链
  const slot = await page.evaluate(() => {
    const mine = document.querySelector('button[aria-label*="回滚"], button[aria-label*="Revert"], [aria-label*="引用"], [aria-label*="Quote"]');
    if (!mine) return { found: false };
    const chain = [];
    let n = mine;
    for (let i = 0; i < 7 && n; i++) {
      chain.push({ tag: n.tagName, cls: String(n.className).slice(0, 90), slot: n.getAttribute('data-slot') || '' });
      n = n.parentElement;
    }
    return { found: true, chain };
  });
  log('OUR SLOT CHAIN:', JSON.stringify(slot, null, 1).slice(0, 1400));
  // composerStack 几何（基线）
  const geo = await page.evaluate(() => {
    const ta = document.querySelector('textarea, [contenteditable="true"]');
    const dockWrap = document.querySelector('[data-slot=conversation\\.input\\.dock]');
    const taR = ta ? ta.getBoundingClientRect() : null;
    const dR = dockWrap ? dockWrap.getBoundingClientRect() : null;
    const parent = dockWrap ? dockWrap.parentElement : null;
    return {
      ta: taR ? { y: Math.round(taR.y), x: Math.round(taR.x), w: Math.round(taR.width) } : null,
      dockWrap: dR ? { y: Math.round(dR.y), h: Math.round(dR.height), x: Math.round(dR.x), w: Math.round(dR.width) } : null,
      gap: taR && dR ? Math.round(taR.y - dR.bottom) : null,
      parentCls: parent ? String(parent.className).slice(0, 80) : null,
      parentGap: parent ? getComputedStyle(parent).gap : null,
      dockChildren: dockWrap ? dockWrap.innerHTML.slice(0, 150) : null,
    };
  });
  log('COMPOSER GEO:', JSON.stringify(geo, null, 1));
  await page.screenshot({ path: OUT + '/90-host-usermsg.png' });
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 400)); process.exit(1); });
