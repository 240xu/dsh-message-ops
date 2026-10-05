const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
delete process.env.LD_PRELOAD;
const log = (...a) => console.log('>>>', ...a);
const API = 'http://127.0.0.1:4096';
const DSH = 'http://127.0.0.1:3081';
(async () => {
  const bootLog = require('fs').readFileSync('/data/data/com.termux/files/home/dsh3081.log', 'utf8');
  const token = (bootLog.match(/token=([A-Za-z0-9_-]+)/) || [])[1];
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const cerr = [];
  page.on('console', (m) => { if (m.type() === 'error') cerr.push(m.text().slice(0, 160)); });
  await page.goto(DSH + '/?token=' + token, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  for (let i = 0; i < 25; i++) { await page.waitForTimeout(1000); if (await page.evaluate(() => document.querySelectorAll('[role=treeitem]').length) > 0) break; }
  // 新建会话（绕开旧会话）
  const created = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => /New session|新建会话/i.test(x.getAttribute('aria-label') || x.title || x.textContent || ''));
    if (b) { b.click(); return true }
    return false
  });
  log('new session clicked:', created);
  await page.waitForTimeout(5000);
  const st = await page.evaluate(() => ({
    flowKinds: Array.from(document.querySelectorAll('[data-chat-flow-kind]')).map((e) => e.getAttribute('data-chat-flow-kind')).slice(0, 10),
    userBlocks: document.querySelectorAll('[data-chat-flow-kind="user"]').length,
    composer: !!document.querySelector('textarea, [contenteditable="true"]'),
    bodyTail: (document.body.innerText || '').replace(/\s+/g, ' ').slice(-200),
  }));
  log('FRESH STATE:', JSON.stringify(st, null, 1));
  // 发一条消息
  const ta = await page.$('textarea, [contenteditable="true"]');
  if (ta) {
    await ta.click();
    await page.keyboard.type('render probe message alpha', { delay: 10 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(9000);
    const st2 = await page.evaluate(() => ({
      flowKinds: Array.from(document.querySelectorAll('[data-chat-flow-kind]')).map((e) => e.getAttribute('data-chat-kind') || e.getAttribute('data-chat-flow-kind')).slice(0, 14),
      userBlocks: document.querySelectorAll('[data-chat-flow-kind="user"]').length,
      hasText: (document.body.innerText || '').includes('render probe message alpha'),
    }));
    log('AFTER SEND:', JSON.stringify(st2, null, 1));
  }
  log('CERR:', JSON.stringify(cerr.slice(0, 8)));
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 400)); process.exit(1); });
