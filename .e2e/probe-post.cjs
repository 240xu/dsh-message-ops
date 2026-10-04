// 会话保持打开 → 页内 POST revert → 精确错误 + 实例存活判定
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
  page.on('response', (r) => { if (r.url().includes('message-ops/revert')) log('NET-REVERT', r.status()); });
  await page.goto('http://127.0.0.1:3081/?token=' + token, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  for (let i = 0; i < 25; i++) { await page.waitForTimeout(1000); if (await page.evaluate(() => document.querySelectorAll('[role=treeitem]').length) > 0) break; }
  let found = null;
  for (let i = 0; i < 15 && !found; i++) {
    found = await page.evaluate((sid) => {
      const el = Array.from(document.querySelectorAll('[data-row-key]')).find(e => (e.dataset.rowKey || '').includes(sid));
      if (!el) return null; el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return r.width > 0 ? { x: r.x + Math.min(r.width / 2, 150), y: r.y + r.height / 2 } : null;
    }, TEST_SID);
    if (found) break;
    await page.evaluate(() => {
      const ws = Array.from(document.querySelectorAll('[role=treeitem]')).find(e => (e.textContent || '').trim().startsWith('zcode2api'));
      if (ws && ws.getAttribute('aria-expanded') !== 'true') ws.click();
      const more = Array.from(document.querySelectorAll('button')).find(b => /^Show \d+ more/i.test((b.textContent || '').trim()));
      if (more) more.click();
    });
    await page.waitForTimeout(2000);
  }
  if (!found) { log('NO ROW'); await browser.close(); return; }
  await page.mouse.dblclick(found.x, found.y);
  await page.waitForTimeout(6000);
  await page.keyboard.press('Escape'); // rename
  await page.waitForTimeout(800);
  // 页内 POST（与对话框同通道）：先取 running 与最后 assistant seq
  const res1 = await page.evaluate(async (sid) => {
    const r = await fetch('/api/message-ops/messages?sessionId=' + encodeURIComponent(sid));
    const d = await r.json();
    const assistants = (d.messages || []).filter(m => m.role === 'assistant');
    const lastSeq = assistants.length ? assistants[assistants.length - 1].seq : null;
    return { running: d.running, src: d.runningSource, lastSeq, markers: (d.messages || []).filter(m => m.marker).length };
  }, TEST_SID);
  log('STATE:', JSON.stringify(res1));
  const res2 = await page.evaluate(async ({ sid, seq }) => {
    try {
      const r = await fetch('/api/message-ops/revert', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: sid, seq }),
      });
      const text = await r.text();
      return { status: r.status, body: text.slice(0, 200) };
    } catch (e) { return { failed: String(e).slice(0, 120) }; }
  }, { sid: TEST_SID, seq: res1.lastSeq });
  log('POST-REVERT:', JSON.stringify(res2));
  await page.waitForTimeout(3000);
  // 实例存活？
  const alive = await page.evaluate(async () => { try { await fetch('/'); return true; } catch { return false; } });
  log('SERVER ALIVE AFTER POST:', alive);
  // 标记数变化
  const res3 = await page.evaluate(async (sid) => {
    try {
      const r = await fetch('/api/message-ops/messages?sessionId=' + encodeURIComponent(sid));
      const d = await r.json();
      return { markers: (d.messages || []).filter(m => m.marker).length, err: d.error };
    } catch (e) { return { dead: String(e).slice(0, 60) }; }
  }, TEST_SID);
  log('MARKERS AFTER:', JSON.stringify(res3));
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 300)); process.exit(1); });
