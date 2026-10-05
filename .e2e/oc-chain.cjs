// opencode 全链路实验：范围真值/逐行恢复语义/边界移动/刷新持久/运行中守卫/回滚后发信
const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
delete process.env.LD_PRELOAD;
const OUT = '/data/data/com.termux/files/home/dsh-plugins-src/dsh-message-ops/.e2e/opencode-research';
const log = (...a) => console.log('>>>', ...a);
const API = 'http://127.0.0.1:4096';
const J = async (p, o) => { const r = await fetch(API + p, Object.assign({ headers: { 'content-type': 'application/json' } }, o || {})); const t = await r.text(); try { return { s: r.status, b: JSON.parse(t) } } catch { return { s: r.status, b: t.slice(0, 200) } } };
(async () => {
  const ses = await J('/session', { method: 'POST', body: JSON.stringify({ directory: '/data/data/com.termux/files/home' }) });
  const sid = ses.b.id;
  fs.writeFileSync(OUT + '/chain-session.txt', sid);
  log('SESSION:', sid);
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const toasts = [];
  page.on('response', async (r) => {
    if (/\/(un)?revert|revert\//.test(r.url())) {
      let b = ''; try { b = (await r.text()).slice(0, 160) } catch {}
      toasts.push({ u: r.url().split('4096')[1], s: r.status(), b });
    }
  });
  let ready = false;
  for (const url of [`${API}/global/session/${sid}`, `${API}/session/${sid}`]) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    for (let i = 0; i < 15; i++) { await page.waitForTimeout(1500); ready = await page.evaluate(() => !!document.querySelector('textarea, [contenteditable="true"]')); if (ready) break; }
    if (ready) break;
  }
  log('ready:', ready);
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
  const listMsgs = () => page.evaluate(() => Array.from(document.querySelectorAll('[class*="min-w-0 w-full max-w-full"]')).map((e) => (e.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 64)).filter(Boolean));
  const barInfo = () => page.evaluate(() => {
    const cand = Array.from(document.querySelectorAll('div,button')).filter((e) => /rolled back/i.test(e.innerText || '') && e.getBoundingClientRect().height <= 300 && e.children.length < 20).sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width)[0];
    if (!cand) return { bar: false };
    const rows = Array.from(cand.querySelectorAll('button')).map((b) => ((b.getAttribute('aria-label') || b.title || b.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 60));
    return { bar: true, summary: (cand.innerText || '').replace(/\s+/g, ' ').slice(0, 120), rows };
  });
  const hoverRevert = async (anchorText) => {
    const pt = await page.evaluate((a) => {
      const els = Array.from(document.querySelectorAll('[class*="min-w-0 w-full max-w-full"]'));
      const t = els.find((e) => (e.innerText || '').trim().startsWith(a));
      if (!t) return null;
      t.scrollIntoView({ block: 'center' });
      return null;
    }, anchorText);
    await page.waitForTimeout(700);
    const pt2 = await page.evaluate((a) => {
      const els = Array.from(document.querySelectorAll('[class*="min-w-0 w-full max-w-full"]'));
      const t = els.find((e) => (e.innerText || '').trim().startsWith(a));
      if (!t) return null;
      const r = t.getBoundingClientRect();
      return { x: r.x + Math.min(r.width / 2, 320), y: r.y + Math.min(r.height / 2, 26) };
    }, anchorText);
    if (pt2) { await page.mouse.move(pt2.x, pt2.y, { steps: 4 }); await page.waitForTimeout(800); }
    const btn = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => /revert message/i.test(x.getAttribute('aria-label') || ''));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      if (r.width === 0) return null;
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), vis: r.width + 'x' + r.height, dis: b.disabled };
    });
    return btn;
  };

  // ── A: 三轮独立（等回复，避免分组），中段回滚 → 行真值 → 逐行恢复语义
  await send('TA first round question');
  await send('TB second round question');
  await send('TC third round question');
  const before = await listMsgs();
  log('A BEFORE:', JSON.stringify(before));
  const btn2 = await hoverRevert('TB second round');
  log('A hover TB →', JSON.stringify(btn2));
  if (btn2) { await page.mouse.click(btn2.x, btn2.y); await page.waitForTimeout(2500); }
  const aBar = await barInfo();
  log('A BAR after revert-TB:', JSON.stringify(aBar));
  const aAfter = await listMsgs();
  log('A VISIBLE:', JSON.stringify(aAfter));

  // 展开 → 逐行恢复第一行 → 真值
  const exp = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => /expand rolled back/i.test(x.getAttribute('aria-label') || '') && x.getBoundingClientRect().width > 0);
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  if (exp) { await page.mouse.click(exp.x, exp.y); await page.waitForTimeout(1200); }
  const expanded = await barInfo();
  log('A EXPANDED rows:', JSON.stringify(expanded));
  // 点第一行的 Restore message
  const firstRestore = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => /^restore message$/i.test((x.getAttribute('aria-label') || '').trim()) && x.getBoundingClientRect().width > 0);
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  log('A first-row restore pt:', JSON.stringify(firstRestore));
  if (firstRestore) { await page.mouse.click(firstRestore.x, firstRestore.y); await page.waitForTimeout(2500); }
  const afterOne = await listMsgs();
  const barAfterOne = await barInfo();
  log('A VISIBLE after ONE row restore:', JSON.stringify(afterOne));
  log('A BAR after one restore:', JSON.stringify(barAfterOne));
  // 恢复剩余（逐行点到干净）
  for (let i = 0; i < 6; i++) {
    const b = await page.evaluate(() => {
      const x = Array.from(document.querySelectorAll('button')).find((k) => /^restore message$/i.test((k.getAttribute('aria-label') || '').trim()) && k.getBoundingClientRect().width > 0);
      if (!x) return null;
      const r = x.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    if (!b) break;
    await page.mouse.click(b.x, b.y);
    await page.waitForTimeout(1800);
  }
  log('A final:', JSON.stringify(await barInfo()), '| msgs', JSON.stringify(await listMsgs()));
  log('NET so far:', JSON.stringify(toasts));
  fs.writeFileSync(OUT + '/chain-partA.json', JSON.stringify({ sid, before, aBar, expanded, afterOne, barAfterOne, net: toasts }, null, 1));
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 400)); process.exit(1); });
