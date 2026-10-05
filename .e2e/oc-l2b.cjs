const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
delete process.env.LD_PRELOAD;
const OUT = '/data/data/com.termux/files/home/dsh-plugins-src/dsh-message-ops/.e2e/opencode-research';
const log = (...a) => console.log('>>>', ...a);
const API = 'http://127.0.0.1:4096';
const J = async (p) => { const r = await fetch(API + p); const t = await r.text(); try { return JSON.parse(t) } catch { return t.slice(0, 200) } };
const arr = (x) => Array.isArray(x) ? x : ((x && (x.messages || x.items)) || []);
const SID = 'ses_ef334bcfdffe7HyBkzW1v4TLJj';
(async () => {
  const base = await J(`/session/${SID}/message`);
  log('BASE total:', arr(base).length, '| roles:', JSON.stringify(arr(base).map((m) => (m.info ? m.info.role : m.role))));
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${API}/global/session/${SID}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  for (let i = 0; i < 15; i++) { await page.waitForTimeout(1500); if (await page.evaluate(() => !!document.querySelector('textarea'))) break; }
  await page.waitForTimeout(4000);
  const rowsDump = () => page.evaluate(() => {
    const d = Array.from(document.querySelectorAll('div')).filter((e) => /rolled back/i.test(e.innerText || '') && e.getBoundingClientRect().height < 600 && e.getBoundingClientRect().width > 300).sort((a, b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height)[0];
    if (!d) return null;
    return {
      h: Math.round(d.getBoundingClientRect().height),
      text: (d.innerText || '').replace(/\s+/g, ' ').slice(0, 420),
      rows: Array.from(d.querySelectorAll('button')).map((b) => ((b.getAttribute('aria-label') || b.title || b.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 70)),
    };
  });
  log('COLLAPSED:', JSON.stringify(await rowsDump()));
  const jsExp = await page.evaluate(() => { const b = document.querySelector('[class*=revert] button, .mopsRdHead button') || Array.from(document.querySelectorAll('button')).find((x) => /expand rolled back/i.test(x.getAttribute('aria-label') || '')); if (!b) return 'no-btn'; b.click(); return 'clicked' });
  await page.waitForTimeout(1500);
  log('jsExp:', jsExp, '| EXPANDED:', JSON.stringify(await rowsDump()));
  // 第一行 Restore（JS 直击）→ 真值
  const r1 = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /^restore message$/i.test((x.getAttribute('aria-label') || '').trim())); if (!b) return 'no-btn'; b.click(); return 'clicked' });
  await page.waitForTimeout(3500);
  const after = await J(`/session/${SID}/message`);
  log('after row1 restore → total:', arr(after).length, '| roles:', JSON.stringify(arr(after).map((m) => (m.info ? m.info.role : m.role))));
  const dock1 = await rowsDump();
  log('DOCK after row1:', JSON.stringify(dock1));
  // 剩余行点到干净
  for (let i = 0; i < 8; i++) {
    const r = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /^restore message$/i.test((x.getAttribute('aria-label') || '').trim())); if (!b) return null; b.click(); return true });
    if (!r) break;
    await page.waitForTimeout(2500);
  }
  const final = await rowsDump();
  log('FINAL DOCK:', JSON.stringify(final));
  const fin = await J(`/session/${SID}/message`);
  log('FINAL total:', arr(fin).length, '| roles:', JSON.stringify(arr(fin).map((m) => (m.info ? m.info.role : m.role))));
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 400)); process.exit(1); });
