// E2E: open live session, probe slot buttons + crashes (clean rewrite)
const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
const token = fs.readFileSync('/data/data/com.termux/files/home/.config/opencode/kpad-dsh.token', 'utf8').trim();

(async () => {
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell' });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('http://127.0.0.1:3080/?token=' + token, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // probe treeitem structure then click the right inner element
  const struct = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('[role=treeitem]'));
    const last = items[items.length - 1];
    return { tag: last ? last.tagName : null, html: last ? last.outerHTML.slice(0, 300) : null, n: items.length };
  });
  console.log('STRUCT', JSON.stringify(struct));
  // click session, then dump ALL button aria-labels/titles to see what actually rendered
  const srow = await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll('[role=treeitem]')).find(e => (e.textContent || '').includes('上服务器看实际运行'));
    if (!row) return null;
    const b = row.getBoundingClientRect();
    return { x: b.x + Math.min(b.width / 2, 180), y: b.y + b.height / 2 };
  });
  if (srow) await page.mouse.click(srow.x, srow.y);
  await page.waitForTimeout(10000);
  const st4 = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const labels = btns.map(b => b.getAttribute('aria-label') || b.title || '').filter(Boolean);
    // any element (not just button) with our slot marker classes/ids
    const ours = document.querySelectorAll('[id*=message-ops],[data-dsh-message-ops],[class*=message-ops]').length;
    return {
      bodyLen: (document.body.innerText || '').length,
      labelsSample: labels.slice(0, 40),
      labelCount: labels.length,
      oursEls: ours,
      dialogProbe: (() => { try { window.dispatchEvent(new CustomEvent('dsh-message-ops:open', { detail: {} })); return 'dispatched'; } catch (e) { return 'err'; } })(),
    };
  });
  console.log('ST4', JSON.stringify(st4));
  await page.waitForTimeout(1200);
  const modal = await page.evaluate(() => {
    const m = document.querySelector('[role=dialog],[aria-modal=true]');
    return { modal: !!m, text: m ? (m.textContent || '').slice(0, 80) : null };
  });
  console.log('MODAL', JSON.stringify(modal));
  console.log('ERRORS', JSON.stringify(bySym));
  await browser.close();
})().catch(e => { console.error('FATAL', String(e).slice(0, 200)); process.exit(1); });
