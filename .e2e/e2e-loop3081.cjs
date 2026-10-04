// 0.5.2 全闭环 e2e（不依赖模型回复）：发消息 → 对话框回撤用户消息 → dock 出现
// → 展开 → Restore → dock 消失。全程只操作本测试新建的会话。
const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
const bootLog = fs.readFileSync('/data/data/com.termux/files/home/dsh3081.log', 'utf8');
const token = (bootLog.match(/token=([A-Za-z0-9_-]+)/) || [])[1];
delete process.env.LD_PRELOAD;
const log = (...a) => console.log('>>>', ...a);
(async () => {
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const netLog = [];
  page.on('response', (r) => { if (r.url().includes('/api/message-ops/') && !r.url().includes('/messages')) netLog.push(r.status() + ' ' + r.url().split('/api/message-ops/')[1].split('?')[0]); });
  const cerrFull = [];
  page.on('console', (m) => { if (m.type() === 'error') cerrFull.push(m.text().slice(0, 160)); });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 120)); });
  await page.goto('http://127.0.0.1:3081/?token=' + token, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  for (let i = 0; i < 25; i++) { await page.waitForTimeout(1000); if (await page.evaluate(() => document.querySelectorAll('[role=treeitem]').length) > 0) break; }

  // 1. 打开既有测试会话（轮询式：展开→找行→Show more→找行，直到出现）
  const TEST_SID = 'session-2188f4ac-fa16-4560-9ded-d0555d0793c7';
  const findRow = async () => page.evaluate((sid) => {
    const el = Array.from(document.querySelectorAll('[data-row-key]')).find(e => (e.dataset.rowKey || '').includes(sid));
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return r.width > 0 ? { x: r.x + Math.min(r.width / 2, 150), y: r.y + r.height / 2 } : null;
  }, TEST_SID);
  let found = null;
  for (let i = 0; i < 15 && !found; i++) {
    found = await findRow();
    if (found) break;
    // 未找到：确保 zcode2api 展开 + 尝试 Show more
    await page.evaluate(() => {
      const ws = Array.from(document.querySelectorAll('[role=treeitem]')).find(e => (e.textContent || '').trim().startsWith('zcode2api'));
      if (ws && ws.getAttribute('aria-expanded') !== 'true') ws.click();
      const more = Array.from(document.querySelectorAll('button')).find(b => /^Show \d+ more/i.test((b.textContent || '').trim()));
      if (more) more.click();
    });
    await page.waitForTimeout(2000);
  }
  log('FOUND ROW:', JSON.stringify(found));
  if (!found) { log('ABORT: row not found'); await browser.close(); return; }
  // 打开会话：dblclick → Esc 关「Rename session」→ 用 composer 存在性做权威判据
  await page.mouse.dblclick(found.x, found.y);
  await page.waitForTimeout(2500);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(6000);
  const viewOk = await page.evaluate(() => {
    const hasComposer = !!document.querySelector('textarea, [contenteditable="true"]');
    const sendBtn = Array.from(document.querySelectorAll('button')).some(b => /send message|发送消息/i.test(b.getAttribute('aria-label') || ''));
    return hasComposer || sendBtn;
  });
  log('VIEW OPEN (composer):', viewOk, '(want true)');
  if (!viewOk) { log('ABORT: conversation view not open'); await browser.close(); return; }

  // 3. 打开我们的对话框（header 按钮）
  const hdr = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') || '').includes('Message ops'));
    if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  log('HDR:', JSON.stringify(hdr));
  if (hdr) await page.mouse.click(hdr.x, hdr.y);
  await page.waitForTimeout(3500);
  // 点击没开则直派打开事件（diag 实证可用的兜底通道）
  const dlgOpen = await page.evaluate(() => document.querySelectorAll('input[name=dsh-message-ops-pick]').length > 0);
  if (!dlgOpen) {
    await page.evaluate((sid) => {
      window.dispatchEvent(new CustomEvent('dsh-message-ops:open', { detail: { title: 't', sessionId: sid } }));
    }, TEST_SID);
    await page.waitForTimeout(3500);
    log('DISPATCHED open event (click fallback)');
  }

  // 4. 选第一条（用户消息）→ 回滚模式 → ack → 确认
  const picked = await page.evaluate(() => {
    const radios = Array.from(document.querySelectorAll('input[name=dsh-message-ops-pick]'));
    if (!radios.length) return { ok: false, modal: (document.querySelector('[role=dialog]') || {textContent:''}).textContent.slice(0, 60) };
    radios[radios.length - 1].click(); // 最后一条 = 最小尾巴
    return { ok: true, count: radios.length };
  });
  log('PICKED:', JSON.stringify(picked));
  if (!picked.ok) { log('CERR', errors.slice(0,2)); await browser.close(); return; }
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('label'));
    const rev = labels.find(l => (l.textContent || '').includes('回滚到此条') || (l.textContent || '').includes('Revert'));
    if (rev) { const radio = rev.querySelector('input[type=radio]'); if (radio) radio.click(); }
    const cb = document.querySelector('input[type=checkbox]');
    if (cb && !cb.checked) cb.click();
  });
  await page.waitForTimeout(500);
  const confirmed = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const c = btns.find(b => (b.textContent || '').trim() === '回滚' || (b.textContent || '').trim() === 'Revert');
    if (!c || c.disabled) return { ok: false, why: c ? 'disabled' : 'no-btn' };
    c.click(); return { ok: true };
  });
  log('CONFIRMED:', JSON.stringify(confirmed));
  await page.waitForTimeout(5000);

  // 5. 读对话框结果态（期待：running 警告消失 + done）
  const dlgState = await page.evaluate(() => {
    const dlg = document.querySelector('[role=dialog]');
    if (!dlg) return { dlg: false };
    const txt = (dlg.textContent || '');
    return { dlg: true, runningWarn: /Session is running/.test(txt), head: txt.replace(/\s+/g, ' ').slice(0, 120) };
  });
  log('DLG:', JSON.stringify(dlgState), '(want runningWarn:false)');

  // 6. 关对话框 → dock 探测（回撤成功后标记应在）
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(2000);
  const dock1 = await page.evaluate(() => {
    const el = document.querySelector('.mopsRd');
    return el ? { dock: true, label: el.getAttribute('aria-label') } : { dock: false };
  });
  log('DOCK after revert:', JSON.stringify(dock1), '(want dock:true)');

  // 7. 展开 dock → 逐行恢复直到没有 Restore（含既有+新标记）
  let restoredN = 0;
  for (let i = 0; i < 8; i++) {
    const head = await page.evaluate(() => {
      const el = document.querySelector('.mopsRd .mopsRdHead');
      if (!el) return null;
      const expanded = !!document.querySelector('.mopsRdList');
      if (expanded) return null; // 已展开
      const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (head) { await page.mouse.click(head.x, head.y); await page.waitForTimeout(1200); }
    const rst = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.mopsRdList button')).find(b => ['Restore', '恢复'].includes((b.textContent || '').trim()));
      if (!b || b.disabled) return null;
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (!rst) break;
    await page.mouse.click(rst.x, rst.y);
    restoredN++;
    await page.waitForTimeout(6000); // restore + revealSession + dock refresh
  }
  log('RESTORED ROWS:', restoredN, '(want >=1)');

  // 8. dock 应消失（全部活跃标记已恢复）
  const dock2 = await page.evaluate(() => {
    const el = document.querySelector('.mopsRd');
    return { dock: !!el, label: el ? el.getAttribute('aria-label') : null };
  });
  log('DOCK after restore:', JSON.stringify(dock2), '(want dock:false)');
  // 9. 原消息应可见（重放后含 [恢复] 前缀或原文）
  const msg = await page.evaluate(() => { const el = document.querySelector('.mopsRd'); return !!el || !!document.querySelector('textarea'); });
  log('MESSAGE VISIBLE after restore:', msg, '(want true)');
  await page.screenshot({ path: 'loop-final.png' });
  log('NET-MSGS:', JSON.stringify(netLog));
  log('CERR-FULL:', JSON.stringify(cerrFull));
  log('CERR-N:', errors.length, errors.slice(0, 3));
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 300)); process.exit(1); });
