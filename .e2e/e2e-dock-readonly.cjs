// E2E dock READ-ONLY: open session with markers, verify dock renders + count semantics. NO mutation.
const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
const token = fs.readFileSync('/data/data/com.termux/files/home/.config/opencode/kpad-dsh.token', 'utf8').trim();
delete process.env.LD_PRELOAD;

(async () => {
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const mopsRequests = [];
  const mopsResponses = [];
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 400)); });
  page.on('request', (req) => { if (req.url().includes('message-ops/messages')) mopsRequests.push(decodeURIComponent(req.url()).slice(-60)); });
  page.on('response', async (res) => {
    if (res.url().includes('message-ops/messages')) {
      try { const d = await res.json(); mopsResponses.push({ url: decodeURIComponent(res.url()).slice(-40), markers: (d.messages || []).filter(m => m.marker && m.sourceKind !== 'compact-checkpoint').length }); } catch {}
    }
  });
  await page.goto('http://127.0.0.1:3080/?token=' + token, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // expand dsh面板聚合 workspace, open the 聚合用量 session
  const tryOpen = async () => {
    for (let i = 0; i < 4; i++) {
      const p = await page.evaluate(() => {
        const row = Array.from(document.querySelectorAll('[data-row-key]')).find(e => (e.dataset.rowKey || '').includes('4e10c1a2'));
        if (!row) return null;
        const b = row.getBoundingClientRect();
        return b.width > 0 ? { x: b.x + Math.min(b.width / 2, 150), y: b.y + b.height / 2 } : null;
      });
      if (p) return p;
      // expand dsh面板聚合 project (row-key workspace:...)
      const wp = await page.evaluate(() => {
        const row = Array.from(document.querySelectorAll('[data-row-key]')).find(e => (e.dataset.rowKey || '').startsWith('workspace:') && (e.textContent || '').includes('dsh面板聚合'));
        if (!row) return null; const b = row.getBoundingClientRect(); return { x: b.x + 20, y: b.y + b.height / 2 };
      });
      if (wp) await page.mouse.click(wp.x, wp.y);
      await page.waitForTimeout(2500);
    }
    return null;
  };
  const open1 = await tryOpen();
  console.log('OPEN1', JSON.stringify(open1));
  if (open1) await page.mouse.click(open1.x, open1.y);
  await page.waitForTimeout(10000);

  // dock probe (READ-ONLY: no revert clicks)
  const dock = await page.evaluate(() => {
    const region = Array.from(document.querySelectorAll('[role=region]')).find(e => (e.getAttribute('aria-label') || '').includes('回撤'));
    if (!region) return { dock: false };
    const r = region.getBoundingClientRect();
    const labelEl = region.querySelector('.mopsRdLabel');
    return { dock: true, label: region.getAttribute('aria-label'), h: Math.round(r.height), w: Math.round(r.width), labelShown: labelEl ? labelEl.textContent : null };
  });
  console.log('DOCK', JSON.stringify(dock));
  const dbg = await page.evaluate(() => window.__mopsDockDebug || []);
  console.log('DOCK-DEBUG', JSON.stringify(dbg));
  const diag = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return {
      headerOps: btns.filter(b => (b.getAttribute('aria-label') || '').includes('Message ops') || (b.getAttribute('aria-label') || '').includes('消息操作')).length,
      dockStyleInjected: !!document.getElementById('dsh-message-ops-dock-style'),
      dockSlotEls: document.querySelectorAll('.mopsRd').length,
      composerArea: document.querySelectorAll('[class*=composer],[class*=Composer],[class*=input-dock]').length,
    };
  });
  console.log('DIAG', JSON.stringify(diag));
  console.log('MOPS-REQS', JSON.stringify(mopsRequests.slice(0, 6)));
  console.log('CERR-N', errors.length);
  for (const e of errors.slice(0, 4)) console.log('  CERR:', e);
  console.log('MOPS-RESP', JSON.stringify(mopsResponses));
  // poll .mopsRd presence for 6s
  for (let i = 0; i < 6; i++) {
    const there = await page.evaluate(() => !!document.querySelector('.mopsRd'));
    console.log('MOPSRD-poll' + i, there);
    if (there) break;
    await page.waitForTimeout(1000);
  }
  // probe the fetch the dock makes — from the page (auth'd)
  const fetchProbe = await page.evaluate(async () => {
    // find current sessionId from the header ops button's neighbor? Use the URL/known: probe via a session row? Instead call with the known marker session id:
    const r = await fetch('/api/message-ops/messages?sessionId=session-4e10c1a2-ec8a-4e72-9286-7d8cb5856232');
    const d = await r.json().catch(() => null);
    if (!d || !d.ok) return { status: r.status, ok: false };
    const msgs = d.messages || [];
    return {
      status: r.status, total: msgs.length,
      markers: msgs.filter(m => m.marker).length,
      manualMarkers: msgs.filter(m => m.marker && m.sourceKind !== 'compact-checkpoint').length,
      withRange: msgs.filter(m => m.marker && m.range).length,
    };
  });
  console.log('FETCH-PROBE', JSON.stringify(fetchProbe));
  // expand (read-only: just opens the list) and count rows
  const head = await page.evaluate(() => {
    const region = Array.from(document.querySelectorAll('[role=region]')).find(e => (e.getAttribute('aria-label') || '').includes('回撤'));
    if (!region) return null;
    const h = region.querySelector('[role=button]');
    if (!h) return null; const r = h.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (head) { await page.mouse.click(head.x, head.y); await page.waitForTimeout(1200); }
  const rows = await page.evaluate(() => {
    const region = Array.from(document.querySelectorAll('[role=region]')).find(e => (e.getAttribute('aria-label') || '').includes('回撤'));
    if (!region) return { rows: 0 };
    const list = region.querySelector('.mopsRdList');
    const rowTexts = list ? Array.from(list.querySelectorAll('.mopsRdRowText')).map(e => e.textContent.slice(0, 40)) : [];
    return { rows: rowTexts.length, rowTexts };
  });
  console.log('ROWS', JSON.stringify(rows));
  const direct = await page.evaluate(() => {
    const el = document.querySelector('.mopsRd');
    if (!el) return { found: false };
    const label = el.getAttribute('aria-label');
    const r = el.getBoundingClientRect();
    const list = el.querySelector('.mopsRdList');
    const rowsN = list ? list.querySelectorAll('.mopsRdRow').length : 0;
    // auto-expand via header click for row dump
    const head = el.querySelector('.mopsRdHead');
    if (head && !list) head.click();
    return { found: true, label, h: Math.round(r.height), w: Math.round(r.width), rowsN };
  });
  console.log('DIRECT', JSON.stringify(direct));
  await page.screenshot({ path: '08-dock-readonly.png' });
  await browser.close();
})().catch(e => { console.error('FATAL', String(e).slice(0, 250)); process.exit(1); });
