const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
delete process.env.LD_PRELOAD;
const OUT = '/data/data/com.termux/files/home/dsh-plugins-src/dsh-message-ops/.e2e/opencode-research';
const log = (...a) => console.log('>>>', ...a);
const API = 'http://127.0.0.1:4096';
const J = async (p, o) => { const r = await fetch(API + p, Object.assign({ headers: { 'content-type': 'application/json' } }, o || {})); return { s: r.status, b: await r.json().catch(() => null) }; };
const parts = (m) => (m && m.parts || []).filter((x) => x.type === 'text').map((x) => (x.text || '').slice(0, 40));
(async () => {
  const ses = await J('/session', { method: 'POST', body: JSON.stringify({ directory: '/data/data/com.termux/files/home' }) });
  const sid = ses.b.id;
  log('SESSION:', sid);
  const send = async (text) => {
    const r = await J(`/session/${sid}/message`, { method: 'POST', body: JSON.stringify({ parts: [{ type: 'text', text }] }) });
    if (r.s !== 200) log('SEND ERR', r.s, JSON.stringify(r.b).slice(0, 200));
    return r.s;
  };
  // 用一个不太会触发工具的措辞；即使触发也无妨（范围以 API 状态为准）
  log('send M1:', await send('Say OK one. Do not use tools.'));
  log('send M2:', await send('Say OK two. Do not use tools.'));
  log('send M3:', await send('Say OK three. Do not use tools.'));
  const base = await J(`/session/${sid}/message`);
  const arr = (x) => Array.isArray(x) ? x : ((x && (x.messages || x.items)) || []);
  const baseMsgs = arr(base.b).map((m, i) => ({ i, role: m.role, txt: parts(m).join('|'), keys: Object.keys(m) }));
  log('BASELINE:', JSON.stringify(baseMsgs, null, 1));
  log('BASE KEYS:', JSON.stringify(Object.keys(base.b), base.b.messages ? JSON.stringify(Object.keys(base.b.messages[0])) : ''));

  // UI 回滚 M2（第二条 user）
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${API}/global/session/${sid}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  for (let i = 0; i < 20; i++) { await page.waitForTimeout(1500); if (await page.evaluate(() => !!document.querySelector('textarea'))) break; }
  const pt = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('[class*="min-w-0 w-full max-w-full"]'));
    const t = els.find((e) => (e.innerText || '').includes('Say OK two'));
    if (!t) return null;
    t.scrollIntoView({ block: 'center' });
    return null;
  });
  await page.waitForTimeout(800);
  const pt2 = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('[class*="min-w-0 w-full max-w-full"]'));
    const t = els.find((e) => (e.innerText || '').includes('Say OK two'));
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { x: r.x + Math.min(r.width / 2, 320), y: r.y + Math.min(r.height / 2, 26) };
  });
  log('M2 PT:', JSON.stringify(pt2));
  if (pt2 && pt2.y > 80 && pt2.y < 700) {
    await page.mouse.move(pt2.x, pt2.y, { steps: 5 });
    await page.waitForTimeout(900);
    const rev = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => /revert message/i.test(x.getAttribute('aria-label') || ''));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    log('REVERT BTN:', JSON.stringify(rev));
    if (rev) { await page.mouse.click(rev.x, rev.y); await page.waitForTimeout(3000); }
  } else {
    log('M2 pt offscreen — skip click, dump y:', pt2 && pt2.y);
  }
  await page.screenshot({ path: OUT + '/60-scope.png' });

  const after = await J(`/session/${sid}/message`);
  const afterMsgs = arr(after.b).map((m, i) => ({ i, role: m.role, txt: parts(m).join('|'), hidden: m.hidden, rolledBack: m.rolledBack, removed: m.removed, keys: Object.keys(m) }));
  log('AFTER (API):', JSON.stringify(afterMsgs, null, 1));
  const barTxt = await page.evaluate(() => (document.body.innerText.match(/\d+ rolled back messages?/) || [])[0] || null);
  log('BAR:', barTxt);
  // diff 端点
  const diff = await J(`/session/${sid}/diff`);
  log('DIFF:', JSON.stringify(diff).slice(0, 500));
  log('SID', sid);
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 400)); process.exit(1); });
