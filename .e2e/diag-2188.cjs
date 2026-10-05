const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
delete process.env.LD_PRELOAD;
const log = (...a) => console.log('>>>', ...a);
const TEST_SID = 'session-2188f4ac-fa16-4560-9ded-d0555d0793c7';
(async () => {
  const bootLog = fs.readFileSync('/data/data/com.termux/files/home/dsh3081.log', 'utf8');
  const token = (bootLog.match(/token=([A-Za-z0-9_-]+)/) || [])[1];
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const cerr = [];
  page.on('console', (m) => { if (m.type() === 'error') cerr.push(m.text().slice(0, 500)); });
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
    });
    await page.waitForTimeout(2000);
  }
  if (!target) { log('NO ROW'); await browser.close(); return; }
  await page.mouse.dblclick(target.x, target.y);
  await page.waitForTimeout(8000);
  await page.keyboard.press('Escape').catch(() => {});
  const st = await page.evaluate(() => {
    const col = document.querySelector('[class*=EvIC1a_column], [class*=column]');
    return {
      flowItems: document.querySelectorAll('[data-chat-flow-kind]').length,
      flowKinds: Array.from(document.querySelectorAll('[data-chat-flow-kind]')).map((e) => e.getAttribute('data-chat-flow-kind')).slice(0, 10),
      colCls: col ? String(col.className).slice(0, 60) : null,
      colKids: col ? col.children.length : null,
      colHead: col ? (col.innerText || '').replace(/\s+/g, ' ').slice(0, 200) : null,
      scrollHead: (() => { const s = document.querySelector('[class*=EvIC1a_scroll], [class*=scroll]'); return s ? (s.innerText || '').replace(/\s+/g, ' ').slice(0, 200) : null })(),
      anyErr: (document.body.innerText || '').match(/.{0,60}(failed|失败|error).{0,80}/gi),
    };
  });
  log('2188 STATE:', JSON.stringify(st, null, 1).slice(0, 1500));
  log('CERR FULL:', JSON.stringify(cerr, null, 1).slice(0, 2000));
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 400)); process.exit(1); });
