const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
delete process.env.LD_PRELOAD;
const OUT = '/data/data/com.termux/files/home/dsh-plugins-src/dsh-message-ops/.e2e/opencode-research';
const log = (...a) => console.log('>>>', ...a);
const API = 'http://127.0.0.1:4096';
const listMsgs = `(() => Array.from(document.querySelectorAll('[class*="min-w-0 w-full max-w-full"]')).map((e) => (e.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60)).filter(Boolean))()`;
(async () => {
  const r = await fetch(API + '/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ directory: '/data/data/com.termux/files/home' }) });
  const ses = await r.json();
  log('SESSION:', ses.id);
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let ready = false;
  for (const url of [`${API}/global/session/${ses.id}`, `${API}/session/${ses.id}`]) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(1500);
      ready = await page.evaluate(() => !!document.querySelector('textarea, [contenteditable="true"]'));
      if (ready) break;
    }
    if (ready) break;
  }
  log('composer ready:', ready);
  if (!ready) { await page.screenshot({ path: OUT + '/49-notready.png' }); process.exit(5); }
  const send = async (txt) => {
    const ta = await page.$('textarea, [contenteditable="true"]');
    if (!ta) throw new Error('composer vanished');
    await ta.click();
    await page.keyboard.type(txt, { delay: 10 });
    await page.keyboard.press('Enter');
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(1500);
      const stopping = await page.evaluate(() => Array.from(document.querySelectorAll('button')).some((b) => /stop/i.test(b.getAttribute('aria-label') || '')));
      if (!stopping && i > 3) break;
    }
    await page.waitForTimeout(1200);
  };
  await send('msg one alpha');
  await send('msg two beta');
  await send('msg three gamma');
  const before = await page.evaluate(listMsgs);
  log('BEFORE(3 turns):', JSON.stringify(before));

  // ── A) 助手消息上有哪些动作（hover A1）
  const a1 = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('[class*="min-w-0 w-full max-w-full"]'));
    const t = els.find((e) => /What's the question|without a task|no actual question|gamma/i.test((e.innerText || '')) && /·/.test(e.innerText || ''));
    const t2 = t || els[1];
    if (!t2) return null;
    t2.scrollIntoView({ block: 'center' });
    const r = t2.getBoundingClientRect();
    return { x: r.x + Math.min(r.width / 2, 320), y: r.y + Math.min(r.height / 2, 26), txt: (t2.innerText || '').slice(0, 50) };
  });
  log('HOVER ASSISTANT PT:', JSON.stringify(a1));
  await page.waitForTimeout(500);
  if (a1) { await page.mouse.move(a1.x, a1.y, { steps: 5 }); await page.waitForTimeout(900); }
  const acts = await page.evaluate(() => Array.from(document.querySelectorAll('button')).map((b) => {
    const r = b.getBoundingClientRect();
    const t = b.getAttribute('aria-label') || '';
    if (!t || r.width === 0) return null;
    if (r.y < 90 || r.y > 720) return null;
    return t;
  }).filter(Boolean));
  log('ACTIONS ON ASSISTANT HOVER:', JSON.stringify(acts));

  // ── B) 中段回滚：revert M2（"msg two beta"）
  const m2 = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('[class*="min-w-0 w-full max-w-full"]'));
    const t = els.find((e) => (e.innerText || '').trim().startsWith('msg two beta'));
    if (!t) return null;
    t.scrollIntoView({ block: 'center' });
    const r = t.getBoundingClientRect();
    return { x: r.x + Math.min(r.width / 2, 320), y: r.y + Math.min(r.height / 2, 26) };
  });
  await page.waitForTimeout(500);
  if (m2) { await page.mouse.move(m2.x, m2.y, { steps: 5 }); await page.waitForTimeout(900); }
  const rev2 = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => /revert message/i.test(x.getAttribute('aria-label') || ''));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  log('REVERT M2:', JSON.stringify(rev2));
  if (rev2) { await page.mouse.click(rev2.x, rev2.y); await page.waitForTimeout(2500); }
  const mid = await page.evaluate(listMsgs);
  log('AFTER REVERT M2 (scope!):', JSON.stringify(mid));
  const barText = await page.evaluate(() => (document.body.innerText.match(/\d+ rolled back messages?/) || [])[0] || null);
  log('BAR COUNT:', barText);

  // ── C) 展开 → 内部结构 + 恢复
  const exp = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => /expand rolled back/i.test(x.getAttribute('aria-label') || ''));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  log('EXPAND PT:', JSON.stringify(exp));
  if (exp) {
    await page.mouse.click(exp.x, exp.y);
    await page.waitForTimeout(1500);
    const expanded = await page.evaluate(() => {
      const wrap = Array.from(document.querySelectorAll('div')).filter((e) => /rolled back/i.test(e.innerText || '') && e.getBoundingClientRect().height > 42 && e.getBoundingClientRect().height < 400).sort((a, b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height)[0];
      const btns = Array.from(document.querySelectorAll('button')).map((b) => {
        const r = b.getBoundingClientRect();
        const t = ((b.getAttribute('aria-label') || b.title || b.textContent) || '').trim();
        if (!t || r.width === 0 || r.y < 640) return null;
        return { t: t.slice(0, 55), x: Math.round(r.x), y: Math.round(r.y), h: Math.round(r.height) };
      }).filter(Boolean);
      return { wrapText: wrap ? (wrap.innerText || '').replace(/\s+/g, ' ').slice(0, 300) : null, wrapCls: wrap ? String(wrap.className).slice(0, 80) : null, btns };
    });
    log('EXPANDED:', JSON.stringify(expanded, null, 1));
    await page.screenshot({ path: OUT + '/50-expanded.png' });

    // 点「恢复」类按钮（按 aria/text 找 restore/undo）
    const restorePt = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => /restore|undo/i.test((x.getAttribute('aria-label') || x.title || x.textContent) || ''));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, t: ((b.getAttribute('aria-label') || b.textContent) || '').trim().slice(0, 50) };
    });
    log('RESTORE PT:', JSON.stringify(restorePt));
    if (restorePt) {
      await page.mouse.click(restorePt.x, restorePt.y);
      await page.waitForTimeout(2500);
      const afterRestore = await page.evaluate(listMsgs);
      const barGone = await page.evaluate(() => !/rolled back/i.test(document.body.innerText || ''));
      log('AFTER RESTORE msgs:', JSON.stringify(afterRestore));
      log('AFTER RESTORE barGone:', barGone);
      // 关键：恢复后的消息带 [恢复] 前缀吗？
      const prefix = afterRestore.some((t) => t.includes('[Restored]') || t.includes('[恢复]'));
      log('RESTORE PREFIX?', prefix);
      await page.screenshot({ path: OUT + '/51-after-restore.png' });
    }
  }
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 400)); process.exit(1); });
