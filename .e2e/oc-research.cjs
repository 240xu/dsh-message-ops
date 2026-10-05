// opencode web 回滚流程实地调研（分步执行，输出 DOM/样式/截图）
const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
delete process.env.LD_PRELOAD;
const OUT = '/data/data/com.termux/files/home/dsh-plugins-src/dsh-message-ops/.e2e/opencode-research';
const step = process.argv[2] || 'probe';
const log = (...a) => console.log('>>>', ...a);
(async () => {
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 120)); });
  await page.goto('http://127.0.0.1:4096/new-session?draftId=c63b9245-322c-4973-afb9-7b8c16b557c6', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => log('goto:', String(e).slice(0, 120)));
  await page.waitForTimeout(6000);
  await page.screenshot({ path: OUT + '/01-landing.png', fullPage: false });
  // 若被弹回首页 → 点 New session 进入会话页
  const inSession = await page.evaluate(() => !!document.querySelector('textarea, [contenteditable="true"]'));
  if (!inSession) {
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button, a')).find((x) => /new session/i.test((x.getAttribute('aria-label') || x.title || x.textContent || '')));
      if (b) b.click();
    });
    await page.waitForTimeout(5000);
    await page.screenshot({ path: OUT + '/02-newsession.png' });
  }
  // 点 New session 后观察路由
  const beforeUrl = page.url();
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button, a')).find((x) => /new session/i.test((x.getAttribute('aria-label') || x.title || x.textContent || '')));
    if (b) b.click();
  });
  await page.waitForTimeout(4000);
  const afterUrl = page.url();
  log('URL before/after New session click:', beforeUrl, '->', afterUrl);
  const state = await page.evaluate(() => {
    const tas = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]'));
    const draft = tas.map((t) => (t.value != null ? t.value : (t.textContent || '')).slice(0, 200));
    const links = Array.from(document.querySelectorAll('a')).map((a) => (a.getAttribute('href') || '') + '|' + (a.textContent || '').trim().slice(0, 20)).filter((x) => x !== '|').slice(0, 20);
    const btns = Array.from(document.querySelectorAll('button')).map((b) => ((b.getAttribute('aria-label') || b.title || b.textContent || '').trim().slice(0, 30))).filter(Boolean).slice(0, 30);
    return { url: location.href, draft, links, btns, bodyLen: (document.body.innerText || '').length, bodyHead: (document.body.innerText || '').slice(0, 300) };
  });
  log('STATE:', JSON.stringify(state, null, 1));
  log('STATE:', JSON.stringify(state, null, 1));
  log('CONSOLE-ERRS:', JSON.stringify(errs));
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 400)); process.exit(1); });
