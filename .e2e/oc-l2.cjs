// L2 实测：行级恢复语义 + 刷新持久（锚定 API 文本、验证视图已开）
const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
delete process.env.LD_PRELOAD;
const OUT = '/data/data/com.termux/files/home/dsh-plugins-src/dsh-message-ops/.e2e/opencode-research';
const log = (...a) => console.log('>>>', ...a);
const API = 'http://127.0.0.1:4096';
const J = async (p, o) => { const r = await fetch(API + p, Object.assign({ headers: { 'content-type': 'application/json' } }, o || {})); const t = await r.text(); try { return { s: r.status, b: JSON.parse(t) } } catch { return { s: r.status, b: t.slice(0, 300) } } };
const arr = (x) => Array.isArray(x) ? x : ((x && (x.messages || x.items)) || []);
(async () => {
  const ses = await J('/session', { method: 'POST', body: JSON.stringify({ directory: '/data/data/com.termux/files/home' }) });
  const sid = ses.b.id;
  log('SESSION:', sid);
  const getMsgs = async () => { const r = await J(`/session/${sid}/message`); return arr(r.b) };
  const userTexts = async () => (await getMsgs()).filter((m) => (m.info ? m.info.role : m.role) === 'user').map((m) => {
    const parts = m.parts || [];
    return (parts.filter((p) => p.type === 'text').map((p) => p.text).join(' ') || '').slice(0, 40);
  });
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const net = [];
  page.on('request', (req) => { if (/\/revert/.test(req.url())) { try { net.push({ u: req.url().split('4096')[1], body: (req.postData() || '').slice(0, 140) }) } catch { net.push({ u: req.url().split('4096')[1], body: '?' }) } } });
  await page.goto(`${API}/global/session/${sid}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  for (let i = 0; i < 15; i++) { await page.waitForTimeout(1500); if (await page.evaluate(() => !!document.querySelector('textarea, [contenteditable="true"]'))) break; }
  const send = async (txt) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const n0 = (await userTexts()).length;
      const ta = await page.$('textarea, [contenteditable="true"]');
      await ta.click();
      await page.keyboard.type(txt, { delay: 8 });
      const typed = await page.evaluate((t) => { const x = document.querySelector('textarea, [contenteditable="true"]'); return x && (x.value || x.innerText || '').includes(t.slice(0, 12)) }, txt.slice(0, 12));
      await page.keyboard.press('Enter');
      for (let i = 0; i < 40; i++) {
        await page.waitForTimeout(1500);
        const u = (await userTexts()).length;
        if (u > n0) { log('sent:', txt.slice(0, 18), '(typed:', typed, ')'); return true }
      }
      log('send retry', attempt + 1, txt.slice(0, 14));
    }
    return false;
  };
  await send('WA first content');
  await send('WB second content');
  await send('WC third content');
  const uTexts = await userTexts();
  log('API user texts:', JSON.stringify(uTexts));
  // 验证视图开着：wrapper 数量
  let wrappers = await page.evaluate(() => document.querySelectorAll('[class*="min-w-0 w-full max-w-full"]').length);
  log('wrappers in DOM:', wrappers);
  if (wrappers === 0) { await page.goto(`${API}/session/${sid}`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(8000); wrappers = await page.evaluate(() => document.querySelectorAll('[class*="min-w-0 w-full max-w-full"]').length); log('after alt route wrappers:', wrappers); }
  // hover 第一条用户消息（includes 锚定）
  const anchor = (uTexts[0] || 'WA first').slice(0, 18);
  await page.evaluate((a) => { const els = Array.from(document.querySelectorAll('[class*="min-w-0 w-full max-w-full"]')); const t = els.find((e) => (e.innerText || '').includes(a)); if (t) t.scrollIntoView({ block: 'center' }) }, anchor);
  await page.waitForTimeout(700);
  const pt = await page.evaluate((a) => { const els = Array.from(document.querySelectorAll('[class*="min-w-0 w-full max-w-full"]')); const t = els.find((e) => (e.innerText || '').includes(a)); if (!t) return null; const r = t.getBoundingClientRect(); return { x: r.x + Math.min(r.width / 2, 300), y: r.y + Math.min(r.height / 2, 24) } }, anchor);
  log('anchor:', anchor, 'pt:', JSON.stringify(pt));
  if (pt) { await page.mouse.move(pt.x, pt.y, { steps: 5 }); await page.waitForTimeout(1000); }
  const rev = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /revert message/i.test(x.getAttribute('aria-label') || '') && x.getBoundingClientRect().width > 0); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } });
  log('revert btn:', JSON.stringify(rev));
  if (rev) { await page.mouse.click(rev.x, rev.y); await page.waitForTimeout(3000); }
  log('NET:', JSON.stringify(net));
  // 展开 + 行真值
  const exp = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /expand rolled back/i.test(x.getAttribute('aria-label') || '') && x.getBoundingClientRect().width > 0); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } });
  if (exp) { await page.mouse.click(exp.x, exp.y); await page.waitForTimeout(1500); }
  const rowsDump = () => page.evaluate(() => {
    const d = Array.from(document.querySelectorAll('div')).filter((e) => /rolled back/i.test(e.innerText || '') && e.getBoundingClientRect().height < 600 && e.getBoundingClientRect().width > 300).sort((a, b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height)[0];
    if (!d) return null;
    const btns = Array.from(d.querySelectorAll('button')).map((b) => ((b.getAttribute('aria-label') || b.title || b.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 64));
    return { h: Math.round(d.getBoundingClientRect().height), text: (d.innerText || '').replace(/\s+/g, ' ').slice(0, 360), btns };
  });
  const rows0 = await rowsDump();
  log('ROWS initial:', JSON.stringify(rows0));
  // 点第一行的 Restore message（= 语义判定）
  const r1 = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /^restore message$/i.test((x.getAttribute('aria-label') || '').trim()) && x.getBoundingClientRect().width > 0); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } });
  log('row1 restore:', JSON.stringify(r1));
  if (r1) { await page.mouse.click(r1.x, r1.y); await page.waitForTimeout(3500); }
  const rows1 = await rowsDump();
  const visAfter1 = await page.evaluate((texts) => texts.map((t) => Array.from(document.querySelectorAll('[class*="min-w-0 w-full max-w-full"]')).some((e) => (e.innerText || '').includes(t.slice(0, 14)))), uTexts);
  log('ROWS after row1:', JSON.stringify(rows1));
  log('user texts visible flags:', JSON.stringify(uTexts.map((t, i) => t.slice(0, 12) + '=' + visAfter1[i])));
  // 刷新持久
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);
  const dockReload = await rowsDump();
  log('DOCK after reload:', JSON.stringify(dockReload));
  await browser.close();
  fs.writeFileSync(OUT + '/chain-L2.json', JSON.stringify({ sid, net, uTexts, rows0, rows1, visAfter1, dockReload }, null, 1));
  log('SAVED SID:', sid);
})().catch((e) => { console.error('FATAL', String(e).slice(0, 400)); process.exit(1); });
