const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
delete process.env.LD_PRELOAD;
const OUT = '/data/data/com.termux/files/home/dsh-plugins-src/dsh-message-ops/.e2e/opencode-research';
const log = (...a) => console.log('>>>', ...a);
const API = 'http://127.0.0.1:4096';
const J = async (p, o) => { const r = await fetch(API + p, Object.assign({ headers: { 'content-type': 'application/json' } }, o || {})); const t = await r.text(); try { return { s: r.status, b: JSON.parse(t) } } catch { return { s: r.status, b: t.slice(0, 300) } } };
const arr = (x) => Array.isArray(x) ? x : ((x && (x.messages || x.items)) || []);
const roles = (b) => arr(b).map((m) => (m.info ? m.info.role : m.role));
(async () => {
  const ses = await J('/session', { method: 'POST', body: JSON.stringify({ directory: '/data/data/com.termux/files/home' }) });
  const sid = ses.b.id;
  log('SESSION:', sid);
  const pollMsgs = async () => { const r = await J(`/session/${sid}/message`); return r.b };
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const net = [];
  page.on('request', (req) => { if (/\/revert/.test(req.url())) { try { net.push({ dir: 'REQ', u: req.url().split('4096')[1], body: (req.postData() || '').slice(0, 160) }) } catch { net.push({ dir: 'REQ', u: req.url().split('4096')[1], body: '?' }) } } });
  page.on('response', (res) => { if (/\/revert/.test(res.url())) net.push({ dir: 'RES', u: res.url().split('4096')[1], s: res.status() }) });
  await page.goto(`${API}/global/session/${sid}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  for (let i = 0; i < 15; i++) { await page.waitForTimeout(1500); if (await page.evaluate(() => !!document.querySelector('textarea, [contenteditable="true"]'))) break; }
  const send = async (txt) => {
    const before = roles(await pollMsgs()).length;
    const ta = await page.$('textarea, [contenteditable="true"]');
    await ta.click();
    await page.keyboard.type(txt, { delay: 8 });
    await page.keyboard.press('Enter');
    for (let i = 0; i < 50; i++) {
      await page.waitForTimeout(1500);
      const n = roles(await pollMsgs()).length;
      if (n >= before + 2) break;   // user + assistant 都落了
    }
    log('sent:', txt.slice(0, 16), '| roles n =', roles(await pollMsgs()).length);
  };
  await send('Q1 alpha round');
  await send('Q2 beta round');
  await send('Q3 gamma round');
  const base = roles(await pollMsgs());
  log('BASE roles:', JSON.stringify(base));
  // hover Q2 → 按钮（邻近约束）
  const t1 = await page.evaluate(() => { const els = Array.from(document.querySelectorAll('[class*="min-w-0 w-full max-w-full"]')); const t = els.find((e) => (e.innerText || '').trim().startsWith('Q2 beta round')); if (t) t.scrollIntoView({ block: 'center' }); return !!t });
  await page.waitForTimeout(700);
  const t2 = await page.evaluate(() => { const els = Array.from(document.querySelectorAll('[class*="min-w-0 w-full max-w-full"]')); const t = els.find((e) => (e.innerText || '').trim().startsWith('Q2 beta round')); if (!t) return null; const r = t.getBoundingClientRect(); return { x: r.x + Math.min(r.width / 2, 320), y: r.y + Math.min(r.height / 2, 26), y0: Math.round(r.y), y1: Math.round(r.bottom) } });
  log('Q2 target:', JSON.stringify(t2), 'found:', t1);
  if (t2) { await page.mouse.move(t2.x, t2.y, { steps: 5 }); await page.waitForTimeout(1000); }
  const hit = await page.evaluate((band) => {
    const btns = Array.from(document.querySelectorAll('button')).filter((b) => /revert message/i.test(b.getAttribute('aria-label') || '') && b.getBoundingClientRect().width > 0);
    let best = null, bestD = 1e9;
    for (const b of btns) { const r = b.getBoundingClientRect(); const d = Math.abs((r.y + r.height / 2) - ((band.y0 + band.y1) / 2)); if (d < bestD) { bestD = d; best = b } }
    if (!best) return null;
    const r = best.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), dist: Math.round(bestD) };
  }, { y0: t2.y0, y1: t2.y1 });
  log('HIT:', JSON.stringify(hit));
  if (hit && hit.dist < 60) { await page.mouse.click(hit.x, hit.y); await page.waitForTimeout(3000); }
  log('NET:', JSON.stringify(net));
  // 真值
  const after = roles(await pollMsgs());
  log('AFTER roles:', JSON.stringify(after), '(n', after.length, 'vs base', base.length, ')');
  const info = await J(`/session/${sid}`);
  const s = JSON.stringify(info.b || {});
  log('session revert field:', (s.match(/"revert":\s*[^,}]{0,160}/) || ['none'])[0]);
  // Q2 还在 DOM?
  const q2vis = await page.evaluate(() => Array.from(document.querySelectorAll('[class*="min-w-0 w-full max-w-full"]')).some((e) => (e.innerText || '').trim().startsWith('Q2 beta round')));
  log('Q2 visible in DOM:', q2vis);
  // dock 全量（先展开）
  const exp = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /expand rolled back/i.test(x.getAttribute('aria-label') || '') && x.getBoundingClientRect().width > 0); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } });
  if (exp) { await page.mouse.click(exp.x, exp.y); await page.waitForTimeout(1200); }
  const dock = await page.evaluate(() => {
    const d = Array.from(document.querySelectorAll('div')).filter((e) => /rolled back/i.test(e.innerText || '') && e.getBoundingClientRect().height < 500 && e.getBoundingClientRect().width > 300).sort((a, b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height)[0];
    if (!d) return null;
    const btns = Array.from(d.querySelectorAll('button')).map((b) => ((b.getAttribute('aria-label') || b.title || b.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 70));
    return { h: Math.round(d.getBoundingClientRect().height), text: (d.innerText || '').replace(/\s+/g, ' ').slice(0, 400), btns };
  });
  log('DOCK EXPANDED:', JSON.stringify(dock, null, 1).slice(0, 1200));
  // 第一行恢复（部分恢复语义）
  const r1 = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /^restore message$/i.test((x.getAttribute('aria-label') || '').trim()) && x.getBoundingClientRect().width > 0); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } });
  log('row1 restore pt:', JSON.stringify(r1));
  if (r1) { await page.mouse.click(r1.x, r1.y); await page.waitForTimeout(3000); }
  const afterRow1 = roles(await pollMsgs());
  const q1vis = await page.evaluate(() => Array.from(document.querySelectorAll('[class*="min-w-0 w-full max-w-full"]')).filter((e) => /Q[123] (alpha|beta|gamma)/.test(e.innerText || '')).map((e) => (e.innerText || '').trim().slice(0, 24)));
  log('after row1 restore: roles n =', afterRow1.length, '| visible Q-blocks:', JSON.stringify(q1vis));
  const dock2 = await page.evaluate(() => { const d = Array.from(document.querySelectorAll('div')).filter((e) => /rolled back/i.test(e.innerText || '') && e.getBoundingClientRect().height < 500 && e.getBoundingClientRect().width > 300).sort((a, b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height)[0]; return d ? { text: (d.innerText || '').replace(/\s+/g, ' ').slice(0, 300) } : null });
  log('dock after row1:', JSON.stringify(dock2));
  // 刷新持久
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);
  const dockAfterReload = await page.evaluate(() => { const d = Array.from(document.querySelectorAll('div')).filter((e) => /rolled back/i.test(e.innerText || '') && e.getBoundingClientRect().height < 500 && e.getBoundingClientRect().width > 300)[0]; return d ? (d.innerText || '').replace(/\s+/g, ' ').slice(0, 200) : null });
  log('dock AFTER RELOAD:', JSON.stringify(dockAfterReload));
  await browser.close();
  fs.writeFileSync(OUT + '/chain-partC.json', JSON.stringify({ sid, net, base, after, afterRow1 }, null, 1));
  log('SAVED. SID:', sid);
})().catch((e) => { console.error('FATAL', String(e).slice(0, 400)); process.exit(1); });
