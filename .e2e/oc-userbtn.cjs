// 只读探测3080：宿主用户消息 hover 的官方按钮 + composerStack 几何
const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
delete process.env.LD_PRELOAD;
const TOK = fs.readFileSync('/data/data/com.termux/files/home/.config/opencode/kpad-dsh.token', 'utf8').trim();
const log = (...a) => console.log('>>>', ...a);
(async () => {
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://127.0.0.1:3080/?token=${TOK}`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  for (let i = 0; i < 25; i++) { await page.waitForTimeout(1000); if (await page.evaluate(() => document.querySelectorAll('[role=treeitem]').length) > 0) break; }
  // 打开当前会话（devkit 切换浮层 or 侧栏）
  const dk = await page.evaluate(() => !!(window.__dshDevkit && typeof window.__dshDevkit.openSessions === 'function'));
  log('devkit:', dk);
  if (dk) {
    await page.evaluate(() => window.__dshDevkit.openSessions());
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      const inp = Array.from(document.querySelectorAll('input')).find((i) => i.offsetParent !== null && !i.disabled);
      if (!inp) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, '4e10c1a2');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.focus();
    });
    await page.waitForTimeout(1200);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(7000);
    await page.keyboard.press('Escape').catch(() => {});
  }
  await page.waitForTimeout(2000);
  // composer 几何
  const geo = await page.evaluate(() => {
    const ta = document.querySelector('textarea, [contenteditable="true"]');
    const stack = ta ? ta.closest('[class*=composerStack], [class*=composer]') : null;
    const taR = ta ? ta.getBoundingClientRect() : null;
    // dock 插槽元素
    const dock = document.querySelector('#message-ops-revert-dock, [data-slot=conversation\\.input\\.dock]');
    const dR = dock ? dock.getBoundingClientRect() : null;
    const stackEl = dock ? dock.parentElement : null;
    const stackCs = stackEl ? getComputedStyle(stackEl) : null;
    return {
      ta: taR ? { y: Math.round(taR.y), w: Math.round(taR.width), x: Math.round(taR.x) } : null,
      dock: dR ? { y: Math.round(dR.y), h: Math.round(dR.height), x: Math.round(dR.x), w: Math.round(dR.width) } : null,
      gapDockToTa: taR && dR ? Math.round(taR.y - dR.bottom) : null,
      parentCls: stackEl ? String(stackEl.className).slice(0, 70) : null,
      parentGap: stackCs ? stackCs.gap : null,
      dockHtml: dock ? dock.outerHTML.slice(0, 200) : null,
    };
  });
  log('GEOMETRY:', JSON.stringify(geo, null, 1));
  // hover 第一条用户消息 → 官方按钮
  const um = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('p, div'));
    const cand = nodes.filter((e) => (e.innerText || '').length > 10 && (e.innerText || '').length < 300 && e.children.length < 6).slice(0, 80);
    return cand.length;
  });
  log('probe candidates:', um);
  // 简化：移动鼠标到会话顶部区（用户消息典型位置）
  await page.mouse.move(720, 300, { steps: 5 });
  await page.waitForTimeout(800);
  const acts = await page.evaluate(() => Array.from(document.querySelectorAll('button')).map((b) => {
    const r = b.getBoundingClientRect();
    const t = b.getAttribute('aria-label') || '';
    if (!t || r.width === 0 || r.y < 90 || r.y > 760) return null;
    return { t: t.slice(0, 40), y: Math.round(r.y) };
  }).filter(Boolean).slice(0, 20));
  log('HOVERED ACTIONS:', JSON.stringify(acts));
  await page.screenshot({ path: '/data/data/com.termux/files/home/dsh-plugins-src/dsh-message-ops/.e2e/opencode-research/80-host.png' });
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 300)); process.exit(1); });
