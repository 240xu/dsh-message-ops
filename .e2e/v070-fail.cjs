// 0.7.0 失败用例：断言回滚按钮与官方 Copy 同一行、不覆盖气泡、可点击生效
const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
delete process.env.LD_PRELOAD;
const log = (...a) => console.log('>>>', ...a);
(async () => {
  const token = (fs.readFileSync('/data/data/com.termux/files/home/dsh3081.log', 'utf8').match(/token=([A-Za-z0-9_-]+)/) || [])[1];
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const net = [];
  page.on('response', async (r) => { if (/message-ops\/revert/.test(r.url())) { let b = ''; try { b = (await r.text()).slice(0, 120) } catch {} net.push({ s: r.status(), b }) } });
  await page.goto('http://127.0.0.1:3081/?token=' + token, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  for (let i = 0; i < 25; i++) { await page.waitForTimeout(1000); if (await page.evaluate(() => document.querySelectorAll('[role=treeitem]').length) > 0) break; }
  await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /New session|新建会话/i.test(x.getAttribute('aria-label') || x.title || x.textContent || '')); if (b) b.click(); });
  await page.waitForTimeout(5000);
  const SID = await page.evaluate(() => { const a = document.querySelector('[data-row-key][aria-current="true"], [data-row-key][aria-selected="true"]'); const k = a ? a.dataset.rowKey : null; return k && k.startsWith('session:') ? k.slice(8) : null });
  log('SID:', SID);
  const send = async (txt) => {
    const n0 = await page.evaluate(() => document.querySelectorAll('[data-chat-flow-kind="user"]').length);
    const ta = await page.$('textarea, [contenteditable="true"]');
    await ta.click(); await page.keyboard.type(txt, { delay: 10 }); await page.keyboard.press('Enter');
    for (let i = 0; i < 15; i++) { await page.waitForTimeout(800); if (await page.evaluate(() => document.querySelectorAll('[data-chat-flow-kind="user"]').length) > n0) break; }
    await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /stop/i.test(x.getAttribute('aria-label') || '')); if (b) b.click() });
    await page.waitForTimeout(1500);
    log('sent:', txt.slice(0, 18));
  };
  await send('ZZ alpha body');
  await send('YY beta body');
  // 悬停第二条用户消息
  // 确保 YY 块已渲染（虚拟化只渲染窗口）：循环悬停/滚动直到出现
  for (let i = 0; i < 12; i++) {
    const ok = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('[data-chat-flow-kind="user"]')).find((x) => (x.innerText || '').includes('YY beta body'));
      if (!b) return false;
      b.scrollIntoView({ block: 'center' });
      return true;
    });
    if (ok) break;
    await page.mouse.move(700, 500, { steps: 3 });
    await page.waitForTimeout(1200);
  }
  await page.waitForTimeout(1500);
  const pt = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('[data-chat-flow-kind="user"]')).find((x) => (x.innerText || '').includes('YY beta body')); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + Math.min(r.width / 2, 300), y: r.y + Math.min(r.height / 2, 26) }; });
  if (pt) { await page.mouse.move(pt.x, pt.y, { steps: 5 }); await page.waitForTimeout(1200); }
  const probe = await page.evaluate(() => {
    const R = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), b: Math.round(r.bottom), r: Math.round(r.right) }; };
    const btn = document.querySelector('.mopsUserRevert');
    const rows = Array.from(document.querySelectorAll('[class*="xzv4MW_actions"]'));
    const targetRow = rows.find((r) => r.querySelector('button') && /copy/i.test(Array.from(r.querySelectorAll('button')).map((b) => b.getAttribute('aria-label') || '').join(' ')));
    const copyBtn = targetRow ? Array.from(targetRow.querySelectorAll('button')).find((b) => /copy/i.test(b.getAttribute('aria-label') || '')) : null;
    // 气泡（含文本的消息体）
    const bubble = Array.from(document.querySelectorAll('[class*="Sixlwa_bubble"]')).find((e) => (e.innerText || '').includes('YY beta body'));
    const intersects = (a, b) => !!a && !!b && !(a.r <= b.x || b.r <= a.x || a.b <= b.y || b.b <= a.y);
    return {
      btn: btn ? { rect: R(btn), opacity: getComputedStyle(btn).opacity, parentCls: String(btn.parentElement.className) } : null,
      copyBtn: copyBtn ? R(copyBtn) : null,
      actionsRow: targetRow ? { rect: R(targetRow), opacity: getComputedStyle(targetRow).opacity, cls: String(targetRow.className) } : null,
      bubble: bubble ? R(bubble) : null,
      overlapsBubble: intersects(btn ? R(btn) : null, bubble ? R(bubble) : null),
      sameRowAsCopy: btn && copyBtn ? Math.abs((btn.getBoundingClientRect().y + btn.getBoundingClientRect().height / 2) - (copyBtn.getBoundingClientRect().y + copyBtn.getBoundingClientRect().height / 2)) <= 6 : false,
      inOfficialRow: btn ? !!btn.closest('[class*="xzv4MW_actions"]') : false,
    };
  });
  log('PROBE:', JSON.stringify(probe, null, 1).slice(0, 1400));
  const pass = probe.btn && probe.inOfficialRow && probe.sameRowAsCopy && !probe.overlapsBubble;
  log('ASSERT (inOfficialRow && sameRowAsCopy && !overlapsBubble):', pass);
  // 点击生效
  // 权威空闲等待（running=false 才允许回滚，服务端 409 是预期守卫）
  const SID2 = await page.evaluate(() => { const a = document.querySelector('[data-row-key][aria-current="true"], [data-row-key][aria-selected="true"]'); const k = a ? a.dataset.rowKey : null; return k && k.startsWith('session:') ? k.slice(8) : null });
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`http://127.0.0.1:3081/api/message-ops/messages?sessionId=${SID2}`).then((x) => x.json()).catch(() => ({ running: true }));
    if (!r.running) { log('idle after', i, 'x2s'); break }
    if (i % 4 === 0) await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /stop/i.test(x.getAttribute('aria-label') || '')); if (b) b.click() }).catch(() => {});
    await page.waitForTimeout(2000);
  }
  const preClick = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.mopsUserRevert'));
    return btns.map((x) => {
      const blk = x.closest('[class*="Sixlwa_userRow"], [data-chat-flow-kind="user"]');
      const r = x.getBoundingClientRect();
      return { seq: blk ? blk.getAttribute('data-mops-seq') : null, vis: r.width > 0, op: getComputedStyle(x).opacity, txt: (blk ? blk.innerText : '').slice(0, 22).replace(/\s+/g, ' ') };
    });
  });
  log('BTNS BEFORE CLICK:', JSON.stringify(preClick));
  // 点有 seq 的那个（第二条消息 YY）
  const b = await page.evaluate(() => {
    const x = Array.from(document.querySelectorAll('.mopsUserRevert')).find((k) => {
      const blk = k.closest('[class*="Sixlwa_userRow"], [data-chat-flow-kind="user"]');
      return blk && (blk.innerText || '').includes('YY beta body');
    });
    if (!x) return null;
    x.scrollIntoView({ block: 'center' });
    const r = x.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  log('CLICK PT:', JSON.stringify(b));
  if (b) { await page.mouse.click(b.x, b.y); await page.waitForTimeout(4500); }
  const toast = await page.evaluate(() => Array.from(document.querySelectorAll('[role=status],[role=alert],[class*=toast],[class*=Toast]')).map((e) => (e.innerText || '').trim()).filter(Boolean).slice(0, 4));
  log('TOAST:', JSON.stringify(toast));
  const bar = await page.evaluate(() => { const d = document.querySelector('.mopsRd'); return d ? d.getAttribute('aria-label') : null });
  log('NET:', JSON.stringify(net), '| BAR:', bar);
  log('RESULT:', pass && net.some((n) => n.s === 200) ? 'GREEN' : 'RED');
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 300)); process.exit(1); });
