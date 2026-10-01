// E2E recon: load live 3080, verify slot buttons render on assistant messages, screenshot.
const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
const token = fs.readFileSync('/data/data/com.termux/files/home/.config/opencode/kpad-dsh.token', 'utf8').trim();

(async () => {
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e).slice(0, 400)));
  await page.goto('http://127.0.0.1:3080/?token=' + token, { waitUntil: 'networkidle', timeout: 60000 }).catch(e => console.log('goto:', String(e).slice(0, 100)));
  await page.waitForTimeout(3000);
  await page.screenshot({ path: '/data/data/com.termux/files/home/dsh-plugins-src/dsh-message-ops/.e2e/01-home.png' });

  // find a session with assistant messages: click through session list
  const cands = ['[class*=sessionRow]', '[class*=session-list]', '[class*=sidebar]', 'aside button', 'nav button', '[class*=Session]', '[role=treeitem]'];
  for (const sel of cands) { const n = await page.locator(sel).count().catch(() => -1); if (n > 0) console.log('SEL', sel, '=', n); }
  await page.screenshot({ path: '/data/data/com.termux/files/home/dsh-plugins-src/dsh-message-ops/.e2e/02-session.png' });

  // our slot buttons: aria-label 回滚到此条 / 删除此条
  const revertBtns = await page.locator('button[aria-label="回滚到此条"]').count().catch(() => -1);
  const deleteBtns = await page.locator('button[aria-label="删除此条"]').count().catch(() => -1);
  console.log('slot revert buttons:', revertBtns, '| delete buttons:', deleteBtns);

  // official buttons for comparison: branch icon button (aria or title)
  // open first treeitem (session in list)
  // click the LAST treeitem (real past session), then verify chat actually opened
  const ti = page.locator('[role=treeitem]').last();
  await ti.click().catch(e => console.log('treeitem click:', String(e).slice(0, 60)));
  await page.waitForTimeout(8000);
  const opened = await page.evaluate(() => {
    const text = document.body.innerText || '';
    const msgEls = document.querySelectorAll('[data-turn-tail],[data-message-id],[class*=messageItem],[class*=chatMessage]');
    return { hasContent: text.length > 500, msgEls: msgEls.length,
             sample: text.replace(/\s+/g, ' ').slice(0, 120) };
  });
  console.log('OPENED', JSON.stringify(opened));
  // our slot buttons + crash attribution per slot
  const probe = await page.evaluate(() => ({
    rev: Array.from(document.querySelectorAll('button')).filter(b => (b.getAttribute('aria-label') || '').includes('回滚')).length,
    del: Array.from(document.querySelectorAll('button')).filter(b => (b.getAttribute('aria-label') || '').includes('删除此条')).length,
    feedbackBtns: Array.from(document.querySelectorAll('button')).filter(b => (b.getAttribute('aria-label') || '').match(/feedback|点赞|好评|好|差/)).length,
  }));
  console.log('SLOT-PROBE', JSON.stringify(probe));
  console.log('AFTER', JSON.stringify(after));
  // KEY: dispatch our dialog EVENT — does the modal open (client factory ran)?
  const openedEvt = await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('dsh-message-ops:open', { detail: {} }));
    return new Promise((resolve) => setTimeout(() => {
      const modal = document.querySelector('[role=dialog], [aria-modal=true]');
      resolve({ modal: !!modal, text: modal ? (modal.textContent || '').slice(0, 60) : null });
    }, 800));
  });
  console.log('EVENT-PROBE', JSON.stringify(openedEvt));
  await page.screenshot({ path: '03.png' });
  const html = await page.content();
  console.log('has assistant-actions feedback slot:', html.includes('feedback') ? 'likely' : 'no');
  console.log('console errors:', errors.length); for (const e of errors.slice(0, 5)) console.log('---', e);
  await browser.close();
})().catch(e => { console.error('FATAL', String(e).slice(0, 300)); process.exit(1); });
