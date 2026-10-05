// 归因：纯对话框回滚（不碰注入器）是否也触发 open-in-app feed 错误
const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
delete process.env.LD_PRELOAD;
const log = (...a) => console.log('>>>', ...a);
let SID = null;
(async () => {
  const bootLog = fs.readFileSync('/data/data/com.termux/files/home/dsh3081.log', 'utf8');
  const token = (bootLog.match(/token=([A-Za-z0-9_-]+)/) || [])[1];
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const feedErrs = [];
  page.on('console', (m) => { const t = m.text(); if (t.includes('event feed subscriber')) feedErrs.push(t.slice(0, 150)); });
  const net = [];
  page.on('response', async (r) => {
    if (/message-ops\/(revert|restore)/.test(r.url())) {
      let b = ''; try { b = (await r.text()).slice(0, 200) } catch { /* */ }
      net.push({ u: r.url().split('3081')[1], s: r.status(), b });
    }
  });
  await page.goto('http://127.0.0.1:3081/?token=' + token, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  for (let i = 0; i < 25; i++) { await page.waitForTimeout(1000); if (await page.evaluate(() => document.querySelectorAll('[role=treeitem]').length) > 0) break; }
  await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /New session|新建会话/i.test(x.getAttribute('aria-label') || x.title || x.textContent || '')); if (b) b.click(); });
  await page.waitForTimeout(5000);
  SID = await page.evaluate(() => {
    const a = document.querySelector('[data-row-key][aria-current="true"], [data-row-key].active, [data-row-key][aria-selected="true"]');
    const k = a ? a.dataset.rowKey : null;
    return k && k.startsWith('session:') ? k.slice(8) : null;
  });
  log('SID:', SID);
  const waitIdle = async (label) => {
    for (let i = 0; i < 40; i++) {
      const r = await fetch(`http://127.0.0.1:3081/api/message-ops/messages?sessionId=${SID}`).then((x) => x.json()).catch(() => ({ running: true }));
      if (!r.running) { log('idle:', label); return true }
      if (i % 5 === 0) await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /stop/i.test(x.getAttribute('aria-label') || '')); if (b) b.click() }).catch(() => {});
      await page.waitForTimeout(2000);
    }
    return false;
  };
  const send = async (txt) => {
    const n0 = await page.evaluate(() => document.querySelectorAll('[data-chat-flow-kind="user"]').length);
    const ta = await page.$('textarea, [contenteditable="true"]');
    await ta.click();
    await page.keyboard.type(txt, { delay: 12 });
    await page.keyboard.press('Enter');
    for (let i = 0; i < 20; i++) { await page.waitForTimeout(700); if (await page.evaluate(() => document.querySelectorAll('[data-chat-flow-kind="user"]').length) > n0) break; }
    log('sent:', txt.slice(0, 18));
  };
  await send('GAMMA dialog-only test');
  await waitIdle('gamma');
  // 对话框路径（pick → revert radio → confirm）
  await page.evaluate((sid) => window.dispatchEvent(new CustomEvent('dsh-message-ops:open', { detail: { title: 't', sessionId: sid } })), SID);
  await page.waitForTimeout(3500);
  const pick = await page.evaluate(() => {
    const d = Array.from(document.querySelectorAll('[role=dialog]')).find((x) => x.querySelector('input[name=dsh-message-ops-pick]'));
    if (!d) return false;
    const r = d.querySelector('input[name=dsh-message-ops-pick]');
    if (r) r.click();
    return true;
  });
  await page.waitForTimeout(600);
  const probe = await page.evaluate(() => {
    const d = Array.from(document.querySelectorAll('[role=dialog]')).find((x) => x.querySelector('input[name=dsh-message-ops-pick]'));
    if (!d) return { btns: [] };
    return {
      btns: Array.from(d.querySelectorAll('button')).map((b) => ({ t: (b.textContent || '').trim().slice(0, 20), dis: b.disabled })),
      acks: Array.from(d.querySelectorAll('input[type=checkbox]')).map((c) => ({ dis: c.disabled, checked: c.checked })),
      modeLabels: Array.from(d.querySelectorAll('input[name=dsh-message-ops-mode]')).map((r) => ((r.closest('label') || {}).textContent || '').trim().slice(0, 24)),
      picked: Array.from(d.querySelectorAll('input[name=dsh-message-ops-pick]')).filter((r) => r.checked).length,
    };
  });
  log('DIALOG PROBE:', JSON.stringify(probe));
  const done = await page.evaluate(() => {
    const d = Array.from(document.querySelectorAll('[role=dialog]')).find((x) => x.querySelector('input[name=dsh-message-ops-pick]'));
    if (!d) return 'no-dlg';
    const mode = d.querySelector('input[name=dsh-message-ops-mode]');   // 第一项=revert
    if (mode) { mode.click(); }
    return 'mode-set';
  });
  await page.waitForTimeout(500);
  const acked = await page.evaluate(() => {
    const d = Array.from(document.querySelectorAll('[role=dialog]')).find((x) => x.querySelector('input[name=dsh-message-ops-pick]'));
    const ack = Array.from(d.querySelectorAll('input[type=checkbox]')).find((c) => !c.disabled);
    if (ack && !ack.checked) ack.click();
    return ack ? ack.checked || 'clicked' : 'no-ack';
  });
  await page.waitForTimeout(400);
  const run = await page.evaluate(() => {
    const d = Array.from(document.querySelectorAll('[role=dialog]')).find((x) => x.querySelector('input[name=dsh-message-ops-pick]'));
    const b = Array.from(d.querySelectorAll('button')).find((x) => !x.disabled && /^(Revert|回滚)$/.test((x.textContent || '').trim()));
    if (!b) return 'no-confirm';
    b.click();
    return (b.textContent || '').trim();
  });
  await page.waitForTimeout(6000);
  const toast = await page.evaluate(() => Array.from(document.querySelectorAll('[role=status], [role=alert], [class*=toast], [class*=Toast]')).map((e) => (e.innerText || '').trim()).filter(Boolean).slice(0, 5));
  log('dialog pick:', pick, '| mode:', done, '| ack:', acked, '| confirm:', run);
  log('NET:', JSON.stringify(net), '| TOAST:', JSON.stringify(toast));
  await page.waitForTimeout(6000);
  const bar = await page.evaluate(() => { const d = document.querySelector('.mopsRd'); return d ? d.getAttribute('aria-label') : null });
  log('bar:', bar, '| feedErrs pre-restore:', JSON.stringify(feedErrs));
  // 展开 → 恢复 → 归因
  const exp = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.mopsRd button')).find((x) => (x.getAttribute('aria-label') || '').toLowerCase().includes('expand'));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  log('EXP:', JSON.stringify(exp));
  const jsExp = await page.evaluate(() => {
    const b = document.querySelector('.mopsRdHead button');
    if (!b) return 'no-btn';
    b.click();
    return 'clicked';
  });
  await page.waitForTimeout(1200);
  const listState = await page.evaluate(() => ({
    list: !!document.querySelector('.mopsRdList'),
    rows: document.querySelectorAll('.mopsRdRow').length,
    restoreBtns: document.querySelectorAll('.mopsRdRestore').length,
    ariaExp: (document.querySelector('.mopsRdHead button') || {}).ariaExpanded || (document.querySelector('.mopsRdHead button') || {}).getAttribute && document.querySelector('.mopsRdHead button').getAttribute('aria-expanded'),
  }));
  log('LIST STATE:', JSON.stringify(listState), '| jsExp:', jsExp);
  const restore = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.mopsRdList button')).find((x) => /恢复|Restore/.test((x.textContent || '').trim()));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  const dockDump = await page.evaluate(() => {
    const d = document.querySelector('.mopsRd');
    if (!d) return null;
    const R = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height), Math.round(r.bottom)]; };
    const card = document.querySelector('[class*="uV2eYG_card"]');
    const head = d.querySelector('.mopsRdHead');
    const expB = d.querySelector('.mopsRdHead button');
    return {
      barRect: R(d), headRect: R(head), expRect: R(expB), cardRect: R(card),
      gap: card ? Math.round(card.getBoundingClientRect().top - d.getBoundingClientRect().bottom) : null,
      aria: d.getAttribute('aria-label'),
      cls: String(d.className),
      btns: Array.from(d.querySelectorAll('button')).map((b) => ({ t: (b.textContent || '').trim().slice(0, 24), a: (b.getAttribute('aria-label') || '').slice(0, 30), dis: b.disabled })),
      html: d.outerHTML.replace(/\s+/g, ' ').slice(0, 700),
    };
  });
  log('DOCK DUMP:', JSON.stringify(dockDump, null, 1).slice(0, 1400));
  log('RST PT:', JSON.stringify(restore));
  const jsRestore = await page.evaluate(() => {
    const b = document.querySelector('.mopsRdRestore');
    if (!b || b.disabled) return 'no-or-disabled';
    b.click();
    return 'clicked';
  });
  await page.waitForTimeout(7000);
  log('jsRestore:', jsRestore);
  const finState = await page.evaluate(() => ({
    bar: !!document.querySelector('.mopsRd'),
    gammaBack: (document.body.innerText || '').includes('GAMMA dialog-only test'),
    hasPrefix: (document.body.innerText || '').includes('[恢复]'),
  }));
  log('RESTORE:', JSON.stringify(finState), '| feedErrs AFTER:', JSON.stringify(feedErrs));
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 400)); process.exit(1); });
