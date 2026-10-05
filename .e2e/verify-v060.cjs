// v0.6.0 综合验证：几何贴合 / 用户消息 hover 回滚 / 对话框无恢复模式 / 干净恢复
const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
delete process.env.LD_PRELOAD;
const OUT = '/data/data/com.termux/files/home/dsh-plugins-src/dsh-message-ops/.e2e/opencode-research';
const log = (...a) => console.log('>>>', ...a);
const TEST_SID = 'session-2188f4ac-fa16-4560-9ded-d0555d0793c7';
const API = 'http://127.0.0.1:3081';
(async () => {
  const bootLog = fs.readFileSync('/data/data/com.termux/files/home/dsh3081.log', 'utf8');
  const token = (bootLog.match(/token=([A-Za-z0-9_-]+)/) || [])[1];
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const cerr = [];
  page.on('console', (m) => { if (m.type() === 'error') cerr.push(m.text().slice(0, 130)); });
  await page.goto(API + '/?token=' + token, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  for (let i = 0; i < 25; i++) { await page.waitForTimeout(1000); if (await page.evaluate(() => document.querySelectorAll('[role=treeitem]').length) > 0) break; }
  // 打开会话（轮询 + Show more）
  let target = null;
  for (let i = 0; i < 15 && !target; i++) {
    target = await page.evaluate((sid) => {
      const el = Array.from(document.querySelectorAll('[data-row-key]')).find((e) => (e.dataset.rowKey || '').includes(sid));
      if (!el) return null; el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return r.width > 0 ? { x: r.x + Math.min(r.width / 2, 150), y: r.y + r.height / 2 } : null;
    }, TEST_SID);
    if (target) break;
    await page.evaluate(() => {
      const ws = Array.from(document.querySelectorAll('[role=treeitem]')).find((e) => (e.textContent || '').trim().startsWith('zcode2api'));
      if (ws && ws.getAttribute('aria-expanded') !== 'true') ws.click();
      const more = Array.from(document.querySelectorAll('button')).find((b) => /^Show \d+ more/i.test((b.textContent || '').trim()));
      if (more) more.click();
    });
    await page.waitForTimeout(2000);
  }
  if (!target) { log('ABORT no row'); await browser.close(); return; }
  await page.mouse.dblclick(target.x, target.y);
  await page.waitForTimeout(3000);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(6000);

  // ── V1 几何
  const geo = await page.evaluate(() => {
    const R = (e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), b: Math.round(r.bottom) }; };
    const dock = document.querySelector('.mopsRd');
    const card = document.querySelector('[class*="uV2eYG_card"]');
    return {
      dock: dock ? R(dock) : null,
      label: dock ? dock.getAttribute('aria-label') : null,
      card: card ? R(card) : null,
      gapToCard: dock && card ? Math.round(card.getBoundingClientRect().top - dock.getBoundingClientRect().bottom) : null,
      dx: dock && card ? Math.round(dock.getBoundingClientRect().x - card.getBoundingClientRect().x) : null,
      dw: dock && card ? Math.round(dock.getBoundingClientRect().width - card.getBoundingClientRect().width) : null,
    };
  });
  log('V1 GEOMETRY:', JSON.stringify(geo), '| want gap=1±1, dx/dw=±4');

  // ── V2 用户消息 hover 注入按钮
  const firstUser = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('[data-chat-flow-kind="user"]'))[0];
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    return null;
  });
  await page.waitForTimeout(700);
  const pt = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('[data-chat-flow-kind="user"]'))[0];
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 30), txt: (b.innerText || '').slice(0, 50) };
  });
  log('V2 first user block:', JSON.stringify(pt));
  if (pt) {
    await page.mouse.move(pt.x, pt.y, { steps: 5 });
    await page.waitForTimeout(1200);
  }
  const btnState = await page.evaluate(() => {
    const btn = document.querySelector('.mopsUserRevert');
    const blk = document.querySelector('[data-chat-flow-kind="user"]');
    return { exists: !!btn, seq: blk ? blk.getAttribute('data-mops-seq') : null, op: btn ? getComputedStyle(btn).opacity : null, aria: btn ? btn.getAttribute('aria-label') : null };
  });
  log('V2 HOVER BTN:', JSON.stringify(btnState), '| want exists:true seq>0');

  // ── V3 对话框模式数（直派事件）
  await page.evaluate((sid) => window.dispatchEvent(new CustomEvent('dsh-message-ops:open', { detail: { title: 't', sessionId: sid } })), TEST_SID);
  await page.waitForTimeout(3500);
  const modes = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('[role=dialog]'));
    const d = all.find((x) => x.querySelector('input[name=dsh-message-ops-pick]')) || null;
    if (!d) return { dlg: false };
    const modeRadios = Array.from(d.querySelectorAll('input[name=dsh-message-ops-mode]'));
    const labels = modeRadios.map((r) => ((r.closest('label') || {}).textContent || '').trim().slice(0, 14));
    return { dlg: true, modeCount: modeRadios.length, labels, hasRestore: labels.some((l) => /恢复|Restore/.test(l)) };
  });
  log('V3 DIALOG MODES:', JSON.stringify(modes), '| want modeCount:3 hasRestore:false');
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(1200);
  await page.screenshot({ path: OUT + '/95-v060.png' });
  log('CERR:', JSON.stringify(cerr.slice(0, 6)));
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 400)); process.exit(1); });
