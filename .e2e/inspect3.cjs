// E2E v3: clean flow — no stray modal blocking clicks
const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
const token = fs.readFileSync('/data/data/com.termux/files/home/.config/opencode/kpad-dsh.token', 'utf8').trim();

delete process.env.LD_PRELOAD;
(async () => {
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  await page.goto('http://127.0.0.1:3080/?token=' + token, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // expand zcode2api project (single click)
  const wp = await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll('[role=treeitem]')).find(e => (e.textContent || '').includes('zcode2api'));
    if (!row) return null;
    const b = row.getBoundingClientRect();
    return { x: b.x + 20, y: b.y + b.height / 2 };
  });
  if (wp) await page.mouse.click(wp.x, wp.y);
  await page.waitForTimeout(3000);

  // find the session row ANYWHERE (may already be visible from persisted expansion)
  const findRow = () => page.evaluate(() => {
    let title = null;
    for (const el of document.querySelectorAll('[role=treeitem] *')) {
      if ((el.textContent || '').includes('上服务器看实际运行') && (!title || el.textContent.length < title.textContent.length)) title = el;
    }
    if (!title) return { ok: false };
    const b = title.getBoundingClientRect();
    return { ok: b.width > 0, x: b.x + Math.min(b.width / 2, 150), y: b.y + b.height / 2 };
  });
  let srow = await findRow();
  if (!srow.ok) {
    // expand zcode2api project again (may be collapsed), then re-find
    const wp2 = await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll('[role=treeitem]')).find(e => (e.textContent || '').includes('zcode2api'));
      if (!row) return null;
      const b = row.getBoundingClientRect();
      return { x: b.x + 20, y: b.y + b.height / 2 };
    });
    if (wp2) await page.mouse.click(wp2.x, wp2.y);
    await page.waitForTimeout(2500);
    srow = await findRow();
  }
  console.log('SROW', JSON.stringify(srow));
  console.log('SROW', JSON.stringify(srow));
  if (srow.ok) await page.mouse.click(srow.x, srow.y);
  await page.waitForTimeout(10000);

  const st = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const inMain = btns.filter(b => { const r = b.getBoundingClientRect(); return r.x > 320; }); // right of sidebar
    return {
      bodyLen: (document.body.innerText || '').length,
      total: btns.length,
      inMain: inMain.length,
      inMainLabels: inMain.map(b => b.getAttribute('aria-label') || b.title || '(none)').slice(0, 20),
      revert: btns.filter(b => (b.getAttribute('aria-label') || '').includes('回滚')).length,
      del: btns.filter(b => (b.getAttribute('aria-label') || '').includes('删除此条')).length,
    };
  });
  console.log('ST', JSON.stringify({ bodyLen: st.bodyLen, total: st.total, inMain: st.inMain, revert: st.revert, del: st.del }));
  console.log('ALL-LABELS', JSON.stringify(st.inMainLabels));
  console.log('ERR-N', errors.length, errors.slice(0, 2));
  await browser.close();
})().catch(e => { console.error('FATAL', String(e).slice(0, 200)); process.exit(1); });
