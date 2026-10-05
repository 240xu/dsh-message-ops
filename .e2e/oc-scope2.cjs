const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
delete process.env.LD_PRELOAD;
const OUT = '/data/data/com.termux/files/home/dsh-plugins-src/dsh-message-ops/.e2e/opencode-research';
const log = (...a) => console.log('>>>', ...a);
const API = 'http://127.0.0.1:4096';
const J = async (p, o) => { const r = await fetch(API + p, Object.assign({ headers: { 'content-type': 'application/json' } }, o || {})); return { s: r.status, b: await r.json().catch(() => null) }; };
const listMsgs = `(() => Array.from(document.querySelectorAll('[class*="min-w-0 w-full max-w-full"]')).map((e) => ({ t: (e.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 55), y: Math.round(e.getBoundingClientRect().y) })).filter((m) => m.t))()`;
(async () => {
  const ses = await J('/session', { method: 'POST', body: JSON.stringify({ directory: '/data/data/com.termux/files/home' }) });
  const sid = ses.b.id;
  log('SESSION:', sid);
  // 用 UI 发（API send 500）
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let ready = false;
  for (const url of [`${API}/global/session/${sid}`, `${API}/session/${sid}`, `${API}/home/session/${sid}`]) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(1500);
      ready = await page.evaluate(() => !!document.querySelector('textarea, [contenteditable="true"]'));
      if (ready) break;
    }
    log('route', url, 'ready', ready);
    if (ready) break;
  }
  if (!ready) { await page.screenshot({ path: OUT + '/69-notready.png' }); process.exit(6); }
  const send = async (txt) => {
    const ta = await page.$('textarea, [contenteditable="true"]');
    await ta.click();
    await page.keyboard.type(txt, { delay: 10 });
    await page.keyboard.press('Enter');
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(1500);
      const stopping = await page.evaluate(() => Array.from(document.querySelectorAll('button')).some((b) => /stop/i.test(b.getAttribute('aria-label') || '')));
      if (!stopping && i > 3) break;
    }
    await page.waitForTimeout(1000);
  };
  await send('FIRST alpha payload');
  await send('SECOND beta payload');
  await send('THIRD gamma payload');
  const before = await page.evaluate(listMsgs);
  log('BEFORE:', JSON.stringify(before));

  // 精确 hover SECOND：找以 SECOND 开头的元素，取其 rect 中心
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('[class*="min-w-0 w-full max-w-full"]'));
    const t = els.find((e) => (e.innerText || '').trim().startsWith('THIRD gamma'));
    if (t) t.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(900);
  const m2 = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('[class*="min-w-0 w-full max-w-full"]'));
    const t = els.find((e) => (e.innerText || '').trim().startsWith('THIRD gamma'));
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { y0: Math.round(r.y), y1: Math.round(r.bottom), x: Math.round(r.x + Math.min(r.width / 2, 320)), yc: Math.round(r.y + Math.min(r.height / 2, 26)) };
  });
  log('M3 RECT:', JSON.stringify(m2));
  await page.mouse.move(m2.x, m2.yc, { steps: 5 });
  await page.waitForTimeout(900);
  const btn = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => /revert message/i.test(x.getAttribute('aria-label') || ''));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), y0: Math.round(r.y) };
  });
  log('BTN:', JSON.stringify(btn), '| M3 y0/y1:', m2.y0, m2.y1, '| adjacent:', btn && btn.y >= m2.y0 - 40 && btn.y <= m2.y1 + 40);
  if (btn) { await page.mouse.click(btn.x, btn.y); await page.waitForTimeout(3000); }
  const after = await page.evaluate(listMsgs);
  const bar = await page.evaluate(() => (document.body.innerText.match(/\d+ rolled back messages?/) || [])[0] || null);
  log('AFTER VISIBLE:', JSON.stringify(after));
  log('BAR COUNT:', bar);
  await page.screenshot({ path: OUT + '/70-scope2.png' });
  await browser.close();
  log('SID', sid);
})().catch((e) => { console.error('FATAL', String(e).slice(0, 300)); process.exit(1); });
