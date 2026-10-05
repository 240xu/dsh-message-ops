// v0.6.0 终验：权威空闲等待 + 网络捕获 + 完整 环
const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
delete process.env.LD_PRELOAD;
const OUT = '/data/data/com.termux/files/home/dsh-plugins-src/dsh-message-ops/.e2e/opencode-research';
const log = (...a) => console.log('>>>', ...a);
let SID = null;
(async () => {
  const bootLog = fs.readFileSync('/data/data/com.termux/files/home/dsh3081.log', 'utf8');
  const token = (bootLog.match(/token=([A-Za-z0-9_-]+)/) || [])[1];
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const net = [];
  page.on('response', async (r) => {
    const u = r.url();
    if (/message-ops\/(revert|restore)/.test(u)) {
      let body = '';
      try { body = (await r.text()).slice(0, 240) } catch { /* noop */ }
      net.push({ url: u.split('3081')[1], status: r.status(), body });
    }
  });
  const cerr = [];
  page.on('console', (m) => { if (m.type() === 'error') cerr.push(m.text().slice(0, 200)); });

  const apiRunning = async () => {
    try {
      const r = await fetch(`http://127.0.0.1:3081/api/message-ops/messages?sessionId=${SID}`);
      const d = await r.json();
      return { running: !!d.running, src: d.runningSource, n: (d.messages || []).length };
    } catch (e) { return { running: true, err: String(e) } }
  };
  const waitIdle = async (label, tries = 60) => {
    for (let i = 0; i < tries; i++) {
      const st = await apiRunning();
      if (!st.running) { log('idle:', label, 'after', i, 'x2s, msgs', st.n); return true }
      if (i % 5 === 0) {
        // Stop 点一次
        await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /stop/i.test(x.getAttribute('aria-label') || '')); if (b) b.click() }).catch(() => {});
      }
      await page.waitForTimeout(2000);
    }
    log('NOT IDLE:', label, JSON.stringify(await apiRunning()));
    return false;
  };

  await page.goto('http://127.0.0.1:3081/?token=' + token, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  for (let i = 0; i < 25; i++) { await page.waitForTimeout(1000); if (await page.evaluate(() => document.querySelectorAll('[role=treeitem]').length) > 0) break; }
  // 新会话
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => /New session|新建会话/i.test(x.getAttribute('aria-label') || x.title || x.textContent || ''));
    if (b) b.click();
  });
  await page.waitForTimeout(5000);
  SID = await page.evaluate(() => {
    const a = document.querySelector('[data-row-key][aria-current="true"], [data-row-key].active, [data-row-key][aria-selected="true"]');
    const k = a ? a.dataset.rowKey : null;
    return k && k.startsWith('session:') ? k.slice(8) : null;
  });
  log('SID:', SID, JSON.stringify(await apiRunning()));

  const userCount = () => page.evaluate(() => document.querySelectorAll('[data-chat-flow-kind="user"]').length);
  const send = async (txt) => {
    const before = await userCount();
    const ta = await page.$('textarea, [contenteditable="true"]');
    await ta.click();
    await page.keyboard.type(txt, { delay: 12 });
    await page.keyboard.press('Enter');
    for (let i = 0; i < 20; i++) { await page.waitForTimeout(700); if (await userCount() > before) break; }
    log('sent:', txt.slice(0, 20), (await userCount()) > before);
  };
  await send('ALPHA first message ok');
  const idle1 = await waitIdle('after-alpha');
  await send('BETA revert target message');
  const idle2 = await waitIdle('after-beta');
  if (!idle1 || !idle2) { log('ABORT not idle'); log('NET:', JSON.stringify(net)); await browser.close(); return; }

  // hover BETA → 按钮 → 点击（网络+toast 捕获）
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('[data-chat-flow-kind="user"]')).find((x) => (x.innerText || '').includes('BETA revert target'));
    if (b) b.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(700);
  const pt = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('[data-chat-flow-kind="user"]')).find((x) => (x.innerText || '').includes('BETA revert target'));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + Math.min(r.width / 2, 320), y: r.y + Math.min(r.height / 2, 30) };
  });
  if (pt) { await page.mouse.move(pt.x, pt.y, { steps: 5 }); await page.waitForTimeout(1200); }
  const btn = await page.evaluate(() => {
    const b = document.querySelector('.mopsUserRevert');
    if (!b) return null;
    const blk = b.closest('[data-chat-flow-kind="user"]');
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), seq: blk ? blk.getAttribute('data-mops-seq') : null };
  });
  log('BTN:', JSON.stringify(btn));
  if (btn) { await page.mouse.click(btn.x, btn.y); await page.waitForTimeout(4000); }
  // toast 抓取
  const toast = await page.evaluate(() => {
    const cand = Array.from(document.querySelectorAll('[role=status], [role=alert], [class*=toast], [class*=Toast], [class*=notice]')).map((e) => (e.innerText || '').trim()).filter(Boolean);
    return cand.slice(0, 4);
  });
  const after = await page.evaluate(() => {
    const dock = document.querySelector('.mopsRd');
    const card = document.querySelector('[class*="uV2eYG_card"]');
    return {
      bar: dock ? { label: dock.getAttribute('aria-label'), rect: (() => { const r = dock.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] })() } : null,
      cardRect: card ? (() => { const r = card.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width)] })() : null,
      gap: dock && card ? Math.round(card.getBoundingClientRect().top - dock.getBoundingClientRect().bottom) : null,
      dx: dock && card ? Math.round(dock.getBoundingClientRect().x - card.getBoundingClientRect().x) : null,
      dw: dock && card ? Math.round(dock.getBoundingClientRect().width - card.getBoundingClientRect().width) : null,
      betaVisible: (document.body.innerText || '').includes('BETA revert target'),
    };
  });
  log('AFTER REVERT:', JSON.stringify(after), '| want bar:yes gap:1 betaVisible:false');
  log('TOAST:', JSON.stringify(toast));
  log('NET:', JSON.stringify(net));

  // 展开 → 恢复 → 干净回
  const exp = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.mopsRd button')).find((x) => (x.getAttribute('aria-label') || '').toLowerCase().includes('expand'));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  log('EXPAND:', JSON.stringify(exp));
  if (exp) { await page.mouse.click(exp.x, exp.y); await page.waitForTimeout(1200); }
  const restore = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.mopsRdList button')).find((x) => /恢复|Restore/.test((x.textContent || '').trim()));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  log('RESTORE PT:', JSON.stringify(restore));
  if (restore) { await page.mouse.click(restore.x, restore.y); await page.waitForTimeout(7000); }
  const done = await page.evaluate(() => ({
    bar: !!document.querySelector('.mopsRd'),
    betaBack: (document.body.innerText || '').includes('BETA revert target'),
    hasPrefix: (document.body.innerText || '').includes('[恢复]'),
  }));
  log('AFTER RESTORE:', JSON.stringify(done), '| want bar:false betaBack:true hasPrefix:false');
  // API 终态
  const fin = await apiRunning();
  log('API FIN:', JSON.stringify(fin));
  log('CERR:', JSON.stringify(cerr.slice(0, 6)));
  await page.screenshot({ path: OUT + '/97-v060c.png' });
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 400)); process.exit(1); });
