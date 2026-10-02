// Quote button test on the currently-open session
const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
const token = fs.readFileSync('/data/data/com.termux/files/home/.config/opencode/kpad-dsh.token', 'utf8').trim();
delete process.env.LD_PRELOAD;
(async () => {
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://127.0.0.1:3080/?token=' + token, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  for (let i = 0; i < 20; i++) { await page.waitForTimeout(1000); if (await page.evaluate(() => document.querySelectorAll('[role=treeitem]').length) > 0) break; }
  // open the 聚合用量 session
  const srow = await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll('[role=treeitem]')).find(e => (e.textContent || '').includes('聚合用量，侧边栏'));
    if (!row) return null; const b = row.getBoundingClientRect(); return { x: b.x + Math.min(b.width / 2, 150), y: b.y + b.height / 2 };
  });
  if (srow) {
    // click the TITLE span inside the row (not row center where hover actions sit)
    const tclick = await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll('[role=treeitem]')).find(e => (e.textContent || '').includes('聚合用量，侧边栏'));
      if (!row) return null;
      // find deepest element with the title text
      let title = null;
      for (const el of row.querySelectorAll('*')) {
        if ((el.textContent || '').includes('聚合用量') && (!title || el.textContent.length < title.textContent.length)) title = el;
      }
      const target = title || row;
      const r = target.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    console.log('TCLICK', JSON.stringify(tclick));
    if (tclick) await page.mouse.click(tclick.x, tclick.y);
  }
  await page.waitForTimeout(10000);
  // hover over the last assistant turn tail to reveal actions, find Quote button
  const q = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '') === '引用到输入框');
    if (!b) return { found: false };
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect(); return { found: true, x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: b.disabled };
  });
  console.log('QUOTE', JSON.stringify(q));
  const labels = await page.evaluate(() => Array.from(document.querySelectorAll('button')).map(b => b.getAttribute('aria-label') || b.title || '').filter(Boolean).slice(0, 50));
  console.log('LABELS', JSON.stringify(labels));
  const main = await page.evaluate(() => {
    // dump the main pane (right of x=320) text head + any data-pane elements
    const panes = Array.from(document.querySelectorAll('[data-pane]')).map(e => ({ pane: e.dataset.pane, len: (e.textContent || '').length }));
    const body = (document.body.innerText || '').replace(/\s+/g, ' ');
    return { panes, bodyTail: body.slice(-200) };
  });
  console.log('MAIN', JSON.stringify(main));
  // dump the session row's inner structure (find the real clickable child)
  const rowHtml = await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll('[role=treeitem]')).find(e => (e.textContent || '').includes('聚合用量，侧边栏'));
    if (!row) return { found: false };
    return { found: true, html: row.outerHTML.replace(/\s+/g, ' ').slice(0, 900), children: row.childElementCount };
  });
  console.log('ROWHTML', JSON.stringify(rowHtml));
  // multi-strategy open: focus+Enter, dblclick title, click row at x=60
  const strategies = await page.evaluate(() => {
    const row = document.querySelector('[data-row-key*="4e10c1a2"]');
    if (!row) return { found: false };
    row.focus();
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return { found: true };
  });
  await page.waitForTimeout(3000);
  let opened = await page.evaluate(() => (document.querySelector('[data-pane=conversation]') || { textContent: '' }).textContent.length);
  console.log('STRAT1 convLen', opened);
  // dblclick title
  const t2 = await page.evaluate(() => {
    const row = document.querySelector('[data-row-key*="4e10c1a2"]');
    const title = row && row.querySelector('.YDXeBa_title');
    if (!title) return null; const r = title.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (t2) { await page.mouse.dblclick(t2.x, t2.y); }
  await page.waitForTimeout(8000);
  opened = await page.evaluate(() => (document.querySelector('[data-pane=conversation]') || { textContent: '' }).textContent.length);
  const btnsNow = await page.evaluate(() => {
    const inMain = Array.from(document.querySelectorAll('button')).filter(b => { const r = b.getBoundingClientRect(); return r.x > 320; });
    return { inMain: inMain.length, labels: inMain.map(b => b.getAttribute('aria-label') || b.title || '(none)').slice(0, 14) };
  });
  console.log('OPEN2 convLen', opened, JSON.stringify(btnsNow));
  // QUOTE test on the open session
  const q2 = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '') === '引用到输入框');
    if (!b) return { found: false };
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect(); return { found: true, x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: b.disabled };
  });
  console.log('QUOTE2', JSON.stringify(q2));
  const ours = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return {
      revert: btns.filter(b => (b.getAttribute('aria-label') || '') === 'Revert to here').length,
      quote: btns.filter(b => (b.getAttribute('aria-label') || '') === 'Quote to composer').length,
      revertZh: btns.filter(b => (b.getAttribute('aria-label') || '') === '回滚到此条').length,
      quoteZh: btns.filter(b => (b.getAttribute('aria-label') || '') === '引用到输入框').length,
      assistantSlotEls: document.querySelectorAll('[class*=mopsRd],[aria-label*=Revert],[aria-label*=回滚]').length,
    };
  });
  console.log('OURS', JSON.stringify(ours));
  // click whichever quote button exists
  if (ours.quote > 0 || ours.quoteZh > 0) {
    const clicked = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find(b => ['Quote to composer', '引用到输入框'].includes(b.getAttribute('aria-label') || ''));
      if (!b) return { clicked: false };
      b.scrollIntoView({ block: 'center' });
      b.click();
      return { clicked: true };
    });
    console.log('CLICKED', JSON.stringify(clicked));
    await page.waitForTimeout(2000);
    const composer = await page.evaluate(() => {
      const ta = document.querySelector('textarea');
      const ce = document.querySelector('[contenteditable=true]');
      return { textarea: ta ? { len: (ta.value || '').length, startsQuote: (ta.value || '').startsWith('> ') } : null, contenteditable: ce ? (ce.textContent || '').slice(0, 60) : null };
    });
    console.log('COMPOSER-FINAL', JSON.stringify(composer));
  }
  if (q2.found) {
    await page.mouse.click(q2.x, q2.y);
    await page.waitForTimeout(2000);
    const composer = await page.evaluate(() => {
      const ta = document.querySelector('textarea');
      return ta ? { len: (ta.value || '').length, startsQuote: (ta.value || '').startsWith('> '), head: (ta.value || '').slice(0, 50) } : { noTextarea: true };
    });
    console.log('COMPOSER2', JSON.stringify(composer));
  }
  if (q.found) {
    await page.mouse.click(q.x, q.y);
    await page.waitForTimeout(1500);
    const composer = await page.evaluate(() => {
      const ta = document.querySelector('textarea');
      return ta ? { len: (ta.value || '').length, head: (ta.value || '').slice(0, 40) } : null;
    });
    console.log('COMPOSER', JSON.stringify(composer));
  }
  await browser.close();
})().catch(e => { console.error('FATAL', String(e).slice(0, 200)); process.exit(1); });
