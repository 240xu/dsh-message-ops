const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
delete process.env.LD_PRELOAD;
const OUT = '/data/data/com.termux/files/home/dsh-plugins-src/dsh-message-ops/.e2e/opencode-research';
const log = (...a) => console.log('>>>', ...a);
const API = 'http://127.0.0.1:4096';
const listMsgs = `(() => Array.from(document.querySelectorAll('[class*="min-w-0 w-full max-w-full"]')).map((e) => (e.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 90)).filter(Boolean))()`;
(async () => {
  const r = await fetch(API + '/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ directory: '/data/data/com.termux/files/home' }) });
  const ses = await r.json();
  log('SESSION:', ses.id);
  fs.writeFileSync(OUT + '/session-id.txt', ses.id);

  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${API}/global/session/${ses.id}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(5000);
  const send = async (txt) => {
    const ta = await page.$('textarea, [contenteditable="true"]');
    await ta.click();
    await page.keyboard.type(txt, { delay: 10 });
    await page.keyboard.press('Enter');
    // 等生成完（Stop 消失）
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(1500);
      const stopping = await page.evaluate(() => Array.from(document.querySelectorAll('button')).some((b) => /stop/i.test(b.getAttribute('aria-label') || '')));
      if (!stopping && i > 3) break;
    }
    await page.waitForTimeout(1500);
  };
  await send('alpha question one');
  await send('beta question two');
  const before = await page.evaluate(listMsgs);
  log('BEFORE:', JSON.stringify(before, null, 1));

  // hover 第一条 user（居中）
  const pt = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('[class*="min-w-0 w-full max-w-full"]'));
    const t = els.find((e) => (e.innerText || '').trim().startsWith('alpha question one'));
    if (!t) return null;
    t.scrollIntoView({ block: 'center' });
    const r = t.getBoundingClientRect();
    return { x: r.x + Math.min(r.width / 2, 320), y: r.y + Math.min(r.height / 2, 26) };
  });
  log('M1 PT:', JSON.stringify(pt));
  await page.waitForTimeout(600);
  if (pt) { await page.mouse.move(pt.x, pt.y, { steps: 5 }); await page.waitForTimeout(900); }
  const rev = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => /revert message/i.test(x.getAttribute('aria-label') || ''));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, vis: r.width + 'x' + r.height };
  });
  log('REVERT BTN:', JSON.stringify(rev));
  if (rev) { await page.mouse.click(rev.x, rev.y); await page.waitForTimeout(2500); }
  const after = await page.evaluate(listMsgs);
  log('AFTER REVERT M1:', JSON.stringify(after, null, 1));

  // 细条样式 + 与输入框几何
  const bar = await page.evaluate(() => {
    const ta = document.querySelector('textarea, [contenteditable="true"]');
    const taR = ta.getBoundingClientRect();
    const cand = Array.from(document.querySelectorAll('div,button')).filter((e) => /rolled back/i.test(e.innerText || '') && e.children.length < 14 && e.getBoundingClientRect().height <= 70).sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width)[0];
    if (!cand) return { found: false, ta: { y: Math.round(taR.y), w: Math.round(taR.width) } };
    const r = cand.getBoundingClientRect();
    const cs = getComputedStyle(cand);
    return {
      found: true, text: (cand.innerText || '').replace(/\s+/g, ' ').slice(0, 120),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      gapToTextarea: Math.round(taR.y - r.bottom),
      ta: { y: Math.round(taR.y), w: Math.round(taR.width) },
      style: { borderRadius: cs.borderRadius, border: cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor, bg: cs.backgroundColor, padding: cs.padding, fontSize: cs.fontSize, display: cs.display, alignItems: cs.alignItems },
      parentCls: String(cand.parentElement.className || '').slice(0, 90),
      buttons: Array.from(cand.closest('div').querySelectorAll('button') || []).map((b) => ((b.getAttribute('aria-label') || b.textContent) || '').trim().slice(0, 40)).slice(0, 6),
    };
  });
  log('BAR:', JSON.stringify(bar, null, 1));
  await page.screenshot({ path: OUT + '/40-fresh-bar.png' });
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 400)); process.exit(1); });
