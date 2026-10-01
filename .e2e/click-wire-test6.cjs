// wiring test: click our Revert slot button with the POST intercepted+aborted (no real mutation)
const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
const token = fs.readFileSync('/data/data/com.termux/files/home/.config/opencode/kpad-dsh.token', 'utf8').trim();

(async () => {
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let intercepted = null;
  await page.route('**/api/message-ops/revert', (route) => {
    intercepted = { url: route.request().url(), body: route.request().postData() };
    route.abort();
  });
  await page.goto('http://127.0.0.1:3080/?token=' + token, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3000);
  // open the session (zcode2api expanded persisted)
  let srow = await page.evaluate(() => {
    let title = null;
    for (const el of document.querySelectorAll('[role=treeitem] *')) {
      if ((el.textContent || '').includes('hi, reply with exactly') && (!title || el.textContent.length < title.textContent.length)) title = el;
    }
    if (!title) return null;
    const b = title.getBoundingClientRect();
    return { ok: b.width > 0, x: b.x + Math.min(b.width / 2, 150), y: b.y + b.height / 2 };
  });
  if (!srow || !srow.ok) {
    const wp = await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll('[role=treeitem]')).find(e => (e.textContent || '').includes('zcode2api'));
      if (!row) return null; const b = row.getBoundingClientRect(); return { x: b.x + 20, y: b.y + b.height / 2 };
    });
    if (wp) await page.mouse.click(wp.x, wp.y);
    await page.waitForTimeout(2500);
    srow = await page.evaluate(() => {
      let title = null;
      for (const el of document.querySelectorAll('[role=treeitem] *')) {
        if ((el.textContent || '').includes('hi, reply with exactly') && (!title || el.textContent.length < title.textContent.length)) title = el;
      }
      if (!title) return null;
      const b = title.getBoundingClientRect();
      return { ok: b.width > 0, x: b.x + Math.min(b.width / 2, 150), y: b.y + b.height / 2 };
    });
  }
  if (srow && srow.ok) {
    await page.mouse.click(srow.x, srow.y);
  } else {
    // expand 'dsh插件开发' workspace, then find the session
    const wp = await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll('[role=treeitem]')).find(e => (e.textContent || '').includes('dsh插件开发'));
      if (!row) return null; const b = row.getBoundingClientRect(); return { x: b.x + 20, y: b.y + b.height / 2 };
    });
    console.log('WP-EXPAND', JSON.stringify(wp));
    // after first click, dump tree to see what's actually expanded
    await page.waitForTimeout(2500);
    const tree = await page.evaluate(() => Array.from(document.querySelectorAll('[role=treeitem]')).map(e => ({ t: (e.textContent || '').trim().slice(0, 30), exp: e.getAttribute('aria-expanded') })));
    console.log('TREE1', JSON.stringify(tree));
  // dump all visible treeitems to see actual session titles
  const dump = await page.evaluate(() => Array.from(document.querySelectorAll('[role=treeitem]')).map(e => ({ t: (e.textContent || '').trim().slice(0, 34), exp: e.getAttribute('aria-expanded') })));
  console.log('TREE', JSON.stringify(dump));
    for (let attempt = 0; attempt < 3 && !(srow && srow.ok); attempt++) {
      if (wp) await page.mouse.click(wp.x, wp.y);
      await page.waitForTimeout(2500);
      srow = await page.evaluate(() => {
        let title = null;
        for (const el of document.querySelectorAll('[role=treeitem] *')) {
          if ((el.textContent || '').includes('hi, reply with exactly') && (!title || el.textContent.length < title.textContent.length)) title = el;
        }
        if (!title) return { ok: false };
        const b = title.getBoundingClientRect();
        return { ok: b.width > 0, x: b.x + Math.min(b.width / 2, 150), y: b.y + b.height / 2 };
      });
      console.log('SROW-try' + attempt, JSON.stringify(srow));
    }
    if (srow && srow.ok) await page.mouse.click(srow.x, srow.y);
  }
  await page.waitForTimeout(9000);

  // click our Revert slot button (fetch will be intercepted+aborted)
  // find the button; if absent, hover the assistant turn tails to reveal action rows
  let btn = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '') === 'Revert to here');
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, visible: r.y > 0 && r.y < window.innerHeight };
  });
  console.log('BTN-first', JSON.stringify(btn));
  // deep check: disabled? covered? event listeners present? (dispatch click directly and watch fetch)
  const deep = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => (x.getAttribute('aria-label') || '') === 'Revert to here');
    if (!b) return { found: false };
    const r = b.getBoundingClientRect();
    const topEl = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    // call the click handler DIRECTLY (bypasses hit-testing)
    let fetchFired = false;
    const orig = window.fetch;
    window.fetch = function (...args) { if (String(args[0]).includes('message-ops/revert')) { fetchFired = true; return Promise.reject(new Error('intercepted-test')); } return orig.apply(this, args); };
    b.click();
    window.fetch = orig;
    return { found: true, disabled: b.disabled, topElIsSelf: topEl === b || b.contains(topEl), topElCls: topEl ? String(topEl.className).slice(0, 40) : null, fetchFired };
  });
  console.log('DEEP', JSON.stringify(deep));
  // probe the host sessions snapshot: is this session marked running?
  const snap = await page.evaluate(() => {
    // reach the host store via any slot component? Not directly accessible. Instead check sidebar row text: does the row show 'Running'?
    const rows = Array.from(document.querySelectorAll('[role=treeitem]'));
    const row = rows.find(e => (e.textContent || '').includes('hi, reply with exactly'));
    return { rowText: row ? (row.textContent || '').slice(0, 50) : null };
  });
  console.log('SNAP', JSON.stringify(snap));
  await page.waitForTimeout(1500);
  if (!btn) {
    // hover over turn tails to reveal actions
    const tails = await page.evaluate(() => Array.from(document.querySelectorAll('[data-turn-tail]')).map(e => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, top: r.top }; }));
    console.log('TAILS', tails.length);
    for (const t of tails.slice(-4)) {
      await page.mouse.move(t.x, t.y);
      await page.waitForTimeout(600);
      btn = await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '') === 'Revert to here');
        if (!b) return null;
        b.scrollIntoView({ block: 'center' });
        const r = b.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, visible: r.y > 0 && r.y < window.innerHeight };
      });
      if (btn) break;
    }
    console.log('BTN-hover', JSON.stringify(btn));
  }
  if (btn && btn.visible) await page.mouse.click(btn.x, btn.y);
  await page.waitForTimeout(2500);
  console.log('INTERCEPTED', JSON.stringify(intercepted));
  await browser.close();
})().catch(e => { console.error('FATAL', String(e).slice(0, 200)); process.exit(1); });
