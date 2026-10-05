// Part B：真值实验（请求体/全量行 dump/API 隐藏集/部分恢复/刷新持久）
const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
delete process.env.LD_PRELOAD;
const OUT = '/data/data/com.termux/files/home/dsh-plugins-src/dsh-message-ops/.e2e/opencode-research';
const log = (...a) => console.log('>>>', ...a);
const API = 'http://127.0.0.1:4096';
const J = async (p, o) => { const r = await fetch(API + p, Object.assign({ headers: { 'content-type': 'application/json' } }, o || {})); const t = await r.text(); try { return { s: r.status, b: JSON.parse(t) } } catch { return { s: r.status, b: t.slice(0, 300) } } };
(async () => {
  const ses = await J('/session', { method: 'POST', body: JSON.stringify({ directory: '/data/data/com.termux/files/home' }) });
  const sid = ses.b.id;
  log('SESSION:', sid);
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const net = [];
  page.on('request', (req) => { if (/\/revert/.test(req.url())) { try { net.push({ dir: 'REQ', u: req.url().split('4096')[1], body: (req.postData() || '').slice(0, 200) }) } catch {} } });
  page.on('response', async (res) => { if (/\/(un)?revert|revert/.test(res.url())) net.push({ dir: 'RES', u: res.url().split('4096')[1], s: res.status() }); });
  let ready = false;
  for (const url of [`${API}/global/session/${sid}`]) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    for (let i = 0; i < 15; i++) { await page.waitForTimeout(1500); ready = await page.evaluate(() => !!document.querySelector('textarea, [contenteditable="true"]')); if (ready) break; }
  }
  const send = async (txt) => {
    const ta = await page.$('textarea, [contenteditable="true"]');
    await ta.click();
    await page.keyboard.type(txt, { delay: 8 });
    await page.keyboard.press('Enter');
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(1500);
      const stopping = await page.evaluate(() => Array.from(document.querySelectorAll('button')).some((b) => /stop/i.test(b.getAttribute('aria-label') || '')));
      if (!stopping && i > 4) break;
    }
    await page.waitForTimeout(800);
  };
  await send('P1 first question');
  await send('P2 second question');
  await send('P3 third question');
  // API 基线（结构：info/parts keys + 计数）
  const apiBase = await J(`/session/${sid}/message`);
  const arr = (x) => Array.isArray(x) ? x : ((x && (x.messages || x.items)) || []);
  log('API base n:', arr(apiBase.b).length, '| info keys:', JSON.stringify(Object.keys((arr(apiBase.b)[0] || {}).info || {})));
  // hover P2（wrapper 内找按钮 + 邻近按钮兑底）
  const pt = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('[class*="min-w-0 w-full max-w-full"]'));
    const t = els.find((e) => (e.innerText || '').trim().startsWith('P2 second question'));
    if (!t) return null;
    t.scrollIntoView({ block: 'center' });
    return null;
  });
  await page.waitForTimeout(700);
  const hit = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('[class*="min-w-0 w-full max-w-full"]'));
    const t = els.find((e) => (e.innerText || '').trim().startsWith('P2 second question'));
    if (!t) return null;
    const tr = t.getBoundingClientRect();
    // 在 wrapper 自身 + 紧邻（±48px）里找 Revert message
    const btns = Array.from(document.querySelectorAll('button')).filter((b) => /revert message/i.test(b.getAttribute('aria-label') || '') && b.getBoundingClientRect().width > 0);
    let best = null, bestD = 1e9;
    for (const b of btns) {
      const r = b.getBoundingClientRect();
      const cy = r.y + r.height / 2;
      const d = Math.abs(cy - (tr.y + Math.min(tr.height / 2, 30)));
      if (d < bestD) { bestD = d; best = b }
    }
    if (!best) return null;
    const r = best.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), dist: Math.round(bestD), targetY: Math.round(tr.y), targetH: Math.round(tr.height) };
  });
  log('HIT P2:', JSON.stringify(hit));
  if (hit && hit.dist < 60) { await page.mouse.click(hit.x, hit.y); await page.waitForTimeout(2500); }
  else log('ABORT: button not adjacent');
  log('NET:', JSON.stringify(net));
  // API 真值（回滚后）
  const apiAfter = await J(`/session/${sid}/message`);
  const mAfter = arr(apiAfter.b);
  log('API after n:', mAfter.length, '| roles:', JSON.stringify(mAfter.map((m) => ((m.info || {}).role || m.role) + ':' + String(((m.info || {}).role ? '' : '') + (m.role || '')).slice(0, 0) || '').slice(0, 0) || mAfter.map((m) => (m.info || m).role).join(',')));
  log('API after role seq:', JSON.stringify(mAfter.map((m) => (m.info ? m.info.role : m.role))));
  // 会话 info.revert 持久字段
  const info = await J(`/session/${sid}`);
  const rv = info.b && (info.b.revert !== undefined ? info.b.revert : (info.b.info && info.b.info.revert));
  log('SESSION info.revert:', JSON.stringify(rv).slice(0, 300));
  // dock 全量 dump（含行文本）
  const dock = await page.evaluate(() => {
    const d = Array.from(document.querySelectorAll('div')).filter((e) => /rolled back/i.test(e.innerText || '') && e.getBoundingClientRect().height < 500 && e.getBoundingClientRect().width > 300).sort((a, b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height)[0];
    if (!d) return null;
    return { html: d.outerHTML.replace(/\s+/g, ' ').slice(0, 1600), h: Math.round(d.getBoundingClientRect().height) };
  });
  log('DOCK:', JSON.stringify(dock));
  await browser.close();
  fs.writeFileSync(OUT + '/chain-partB.json', JSON.stringify({ sid, net, apiBaseN: arr(apiBase.b).length, apiAfterN: mAfter.length, rolesAfter: mAfter.map((m) => (m.info ? m.info.role : m.role)), rv, dock }, null, 1));
  log('SAVED chain-partB.json SID:', sid);
})().catch((e) => { console.error('FATAL', String(e).slice(0, 400)); process.exit(1); });
