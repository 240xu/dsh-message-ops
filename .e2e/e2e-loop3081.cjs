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
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 120)); });
  await page.goto('http://127.0.0.1:3081/?token=' + token, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  for (let i = 0; i < 25; i++) { await page.waitForTimeout(1000); if (await page.evaluate(() => document.querySelectorAll('[role=treeitem]').length) > 0) break; }

  // 1. 打开既有测试会话（open-session.cjs 实证可用流程：文本点 zcode2api → 找行 → dblclick）
  const TEST_SID = 'session-2188f4ac-fa16-4560-9ded-d0555d0793c7';
  for (let i = 0; i < 3; i++) {
    const st = await page.evaluate((sid) => {
      const ws = Array.from(document.querySelectorAll('[role=treeitem]')).find(e => (e.textContent || '').trim().startsWith('zcode2api'));
      const target = Array.from(document.querySelectorAll('[data-row-key]')).find(e => (e.dataset.rowKey || '').includes(sid));
      const exp = ws ? ws.getAttribute('aria-expanded') : null;
      const b = ws ? ws.getBoundingClientRect() : null;
      return { exp, hasWs: !!ws, hasTarget: !!target, wsRect: b ? { x: Math.round(b.x), y: Math.round(b.y) } : null };
    }, TEST_SID);
    log('open-iter' + i, JSON.stringify(st));
    if (st.hasTarget) break;
    if (st.hasWs && st.exp !== 'true' && st.wsRect) {
      await page.mouse.click(st.wsRect.x + 30, st.wsRect.y + 10);
      await page.waitForTimeout(2500);
    } else if (st.hasWs && st.exp === 'true') {
      const showed = await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button')).find(b => /^Show \d+ more/i.test((b.textContent || '').trim()));
        if (!b) return false; b.click(); return true;
      });
      log('SHOW MORE:', showed);
      await page.waitForTimeout(2000);
    } else break;
  }
  const found = await page.evaluate((sid) => {
    const el = Array.from(document.querySelectorAll('[data-row-key]')).find(e => (e.dataset.rowKey || '').includes(sid));
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x + Math.min(r.width / 2, 150), y: r.y + r.height / 2 };
  }, TEST_SID);
  log('FOUND ROW:', JSON.stringify(found));
  if (!found) { log('ABORT: row not found'); await browser.close(); return; }
  await page.mouse.dblclick(found.x, found.y);
  await page.waitForTimeout(8000);
  const sidOk = await page.evaluate(() => (document.body.innerText || '').includes('zcode.z.ai'));
  log('SESSION OPEN (msg visible):', sidOk, '(want true)');
  if (!sidOk) { log('ABORT: session not open'); await browser.close(); return; }

  // 3. 打开我们的对话框（header 按钮）
  const hdr = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') || '').includes('Message ops'));
    if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  log('HDR:', JSON.stringify(hdr));
  if (hdr) await page.mouse.click(hdr.x, hdr.y);
  await page.waitForTimeout(4000);

  // 4. 选第一条（用户消息）→ 回滚模式 → ack → 确认
  const picked = await page.evaluate(() => {
    const radios = Array.from(document.querySelectorAll('input[name=dsh-message-ops-pick]'));
    if (!radios.length) return { ok: false, modal: (document.querySelector('[role=dialog]') || {textContent:''}).textContent.slice(0, 60) };
    radios[0].click();
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

  // 5. 读对话框结果态（done / error）
  const dlgState = await page.evaluate(() => {
    const dlg = document.querySelector('[role=dialog]');
    if (!dlg) return { dlg: false };
    const txt = (dlg.textContent || '');
    return { dlg: true, head: txt.replace(/\s+/g, ' ').slice(0, 140) };
  });
  log('DLG:', JSON.stringify(dlgState));

  // 6. 关对话框 → dock 探测
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(1500);
  const dock1 = await page.evaluate(() => {
    const el = document.querySelector('.mopsRd');
    return el ? { dock: true, label: el.getAttribute('aria-label') } : { dock: false };
  });
  log('DOCK after revert:', JSON.stringify(dock1), '(want dock:true)');

  // 7. 展开 + Restore
  const head = await page.evaluate(() => {
    const el = document.querySelector('.mopsRd .mopsRdHead');
    if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (head) { await page.mouse.click(head.x, head.y); await page.waitForTimeout(1200); }
  const rst = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.mopsRd button')).find((b) => ['Restore', '恢复'].includes((b.textContent || '').trim()));
    if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: b.disabled };
  });
  log('RESTORE:', JSON.stringify(rst), '(want object, disabled:false)');
  if (rst && !rst.disabled) { await page.mouse.click(rst.x, rst.y); await page.waitForTimeout(6000); }

  // 8. dock 应消失（activeMarkers 空）
  const dock2 = await page.evaluate(() => !!document.querySelector('.mopsRd'));
  log('DOCK after restore:', dock2, '(want false)');
  // 9. 消息应重放回来（视图重建后含原消息或 [恢复]）
  const msg = await page.evaluate(() => (document.body.innerText || '').includes('zcode.z.ai'));
  log('MESSAGE VISIBLE after restore:', msg, '(want true — [恢复] 重放)');
  await page.screenshot({ path: 'loop-final.png' });
  log('CERR-N:', errors.length, errors.slice(0, 3));
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 300)); process.exit(1); });
