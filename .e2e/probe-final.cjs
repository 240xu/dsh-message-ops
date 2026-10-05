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

  const dump = await page.evaluate(() => {
    const R = (e) => { const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; };
    // 1) 消息列表内容
    const list = document.querySelector('[class*=bhn1Oq_list]');
    const listInfo = list ? { rect: R(list), head: (list.innerText || '').replace(/\s+/g, ' ').slice(0, 260), kids: list.children.length, kidCls: Array.from(list.children).slice(0, 8).map((c) => String(c.className).slice(0, 70)) } : null;
    // 2) composer 链（宽度机制）
    const ce = document.querySelector('[contenteditable="true"], textarea');
    const chain = [];
    let n = ce;
    for (let i = 0; i < 6 && n; i++) {
      const cs = getComputedStyle(n);
      chain.push({ tag: n.tagName, cls: String(n.className).slice(0, 70), rect: R(n), w: cs.width, maxW: cs.maxWidth, pad: cs.padding, margin: cs.margin, align: cs.alignSelf, disp: cs.display });
      n = n.parentElement;
    }
    // 3) .mopsRd 父链（谁是 flex item）
    const dock = document.querySelector('.mopsRd');
    const dockChain = [];
    n = dock;
    for (let i = 0; i < 5 && n; i++) {
      const cs = getComputedStyle(n);
      dockChain.push({ tag: n.tagName, cls: String(n.className).slice(0, 60), rect: R(n), disp: cs.display, mb: cs.marginBottom, mt: cs.marginTop, gap: cs.gap, flexDir: cs.flexDirection });
      n = n.parentElement;
    }
    return { listInfo, chain, dockChain };
  });
  log('LIST:', JSON.stringify(dump.listInfo, null, 1).slice(0, 1200));
  log('COMPOSER CHAIN:', JSON.stringify(dump.chain, null, 1).slice(0, 1800));
  log('DOCK CHAIN:', JSON.stringify(dump.dockChain, null, 1).slice(0, 1500));
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 400)); process.exit(1); });
