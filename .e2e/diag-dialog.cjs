const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
const bootLog = fs.readFileSync('/data/data/com.termux/files/home/dsh3081.log', 'utf8');
const token = (bootLog.match(/token=([A-Za-z0-9_-]+)/) || [])[1];
delete process.env.LD_PRELOAD;
const TEST_SID = 'session-2188f4ac-fa16-4560-9ded-d0555d0793c7';
const log = (...a) => console.log('>>>', ...a);
(async () => {
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const net = [];
  page.on('response', (r) => { if (r.url().includes('message-ops')) net.push(r.status() + ' ' + decodeURIComponent(r.url()).slice(-70)); });
  const cerr = [];
  page.on('console', (m) => { if (m.type() === 'error') cerr.push(m.text().slice(0, 200)); });
  await page.goto('http://127.0.0.1:3081/?token=' + token, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  for (let i = 0; i < 25; i++) { await page.waitForTimeout(1000); if (await page.evaluate(() => document.querySelectorAll('[role=treeitem]').length) > 0) break; }
  // open session (proven flow)
  for (let i = 0; i < 3; i++) {
    const st = await page.evaluate((sid) => {
      const ws = Array.from(document.querySelectorAll('[role=treeitem]')).find(e => (e.textContent || '').trim().startsWith('zcode2api'));
      const target = Array.from(document.querySelectorAll('[data-row-key]')).find(e => (e.dataset.rowKey || '').includes(sid));
      return { hasTarget: !!target, exp: ws ? ws.getAttribute('aria-expanded') : null, rect: ws ? { x: ws.getBoundingClientRect().x, y: ws.getBoundingClientRect().y } : null };
    }, TEST_SID);
    if (st.hasTarget) break;
    if (st.exp !== 'true' && st.rect) { await page.mouse.click(st.rect.x + 30, st.rect.y + 10); await page.waitForTimeout(2500); }
    else { await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find(b => /^Show \d+ more/i.test((b.textContent || '').trim())); if (b) b.click(); }); await page.waitForTimeout(2000); }
  }
  const found = await page.evaluate((sid) => {
    const el = Array.from(document.querySelectorAll('[data-row-key]')).find(e => (e.dataset.rowKey || '').includes(sid));
    if (!el) return null; el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect(); return { x: r.x + Math.min(r.width / 2, 150), y: r.y + r.height / 2 };
  }, TEST_SID);
  if (!found) { log('NO ROW'); await browser.close(); return; }
  await page.mouse.dblclick(found.x, found.y);
  await page.waitForTimeout(8000);
  log('OPEN:', await page.evaluate(() => (document.body.innerText || '').includes('zcode.z.ai')));
  // dock probe (session has 1 marker → dock should render!)
  const dock = await page.evaluate(() => {
    const el = document.querySelector('.mopsRd');
    return el ? { dock: true, label: el.getAttribute('aria-label'), html: el.outerHTML.slice(0, 150) } : { dock: false };
  });
  log('DOCK:', JSON.stringify(dock));
  // click header ops button
  const hdr = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '').includes('Message ops'));
    if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  log('HDR:', JSON.stringify(hdr));
  if (hdr) { await page.mouse.click(hdr.x, hdr.y); await page.waitForTimeout(3000); }
  // 若点击没开，直接派发我们的打开事件（与 header 按钮同一通道）
  const opened = await page.evaluate(() => !!document.querySelector('[role=dialog]'));
  if (!opened) {
    await page.evaluate((sid) => {
      window.dispatchEvent(new CustomEvent('dsh-message-ops:open', { detail: { title: 't', sessionId: sid } }));
    }, TEST_SID);
    await page.waitForTimeout(4000);
    log('DISPATCHED open event');
  }
  const state = await page.evaluate(() => {
    const d = document.querySelector('[role=dialog]');
    const picks = document.querySelectorAll('input[name=dsh-message-ops-pick]').length;
    return { dlg: !!d, text: d ? (d.textContent || '').replace(/\s+/g, ' ').slice(0, 150) : null, picks };
  });
  log('DIALOG:', JSON.stringify(state));
  log('NET:', JSON.stringify(net));
  log('CERR:', JSON.stringify(cerr));
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 300)); process.exit(1); });
