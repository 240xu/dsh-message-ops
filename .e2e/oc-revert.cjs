// 研究：点 Revert message → 前后 DOM/样式/语义
const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
delete process.env.LD_PRELOAD;
const OUT = '/data/data/com.termux/files/home/dsh-plugins-src/dsh-message-ops/.e2e/opencode-research';
const log = (...a) => console.log('>>>', ...a);
const sid = fs.readFileSync(OUT + '/session-id.txt', 'utf8').trim();
(async () => {
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://127.0.0.1:4096/global/session/${sid}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(5000);
  const before = await page.evaluate(() => (document.body.innerText || '').slice(0, 500));
  log('BEFORE TEXT:', JSON.stringify(before.slice(0, 300)));

  // hover 用户消息（第一段消息区）→ 找 Revert message
  const userMsg = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('div'));
    const t = els.filter((e) => (e.innerText || '').trim().startsWith('Reply with exactly: OK research.') && e.children.length < 12).sort((a, b) => a.innerText.length - b.innerText.length)[0];
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { x: r.x + Math.min(r.width / 2, 300), y: r.y + Math.min(r.height / 2, 30) };
  });
  log('USER MSG PT:', JSON.stringify(userMsg));
  if (userMsg) { await page.mouse.move(userMsg.x, userMsg.y, { steps: 5 }); await page.waitForTimeout(900); }
  const rev = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button, [role=button]')).find((x) => /revert message/i.test(x.getAttribute('aria-label') || x.title || ''));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, label: b.getAttribute('aria-label'), html: b.outerHTML.slice(0, 200) };
  });
  log('REVERT BTN:', JSON.stringify(rev));
  if (!rev) { await page.screenshot({ path: OUT + '/20-no-revert-btn.png' }); await browser.close(); process.exit(4); }

  // 点击前：bar 检测
  const preBar = await page.evaluate(() => (document.body.innerText.match(/rolled back|revert/i) || [])[0] || null);
  log('PRE text hint:', preBar);

  await page.mouse.click(rev.x, rev.y);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: OUT + '/21-after-revert-click.png' });

  // 点击后全量结构
  const after = await page.evaluate(() => {
    const dlg = document.querySelector('[role=dialog], [role=alertdialog]');
    const body = document.body.innerText || '';
    // 找 textarea 上方的兄弟元素（bar 判定）
    const ta = document.querySelector('textarea, [contenteditable="true"]');
    let above = null;
    if (ta) {
      // 向上爬5层找包含 revert/restore 文案的祖先/兄弟
      let node = ta;
      for (let i = 0; i < 6 && node; i++) {
        node = node.parentElement;
        if (!node) break;
        const txt = (node.innerText || '');
        if (/restore|rolled back|reverted/i.test(txt)) {
          above = { depth: i, cls: String(node.className).slice(0, 80), snippet: txt.slice(0, 260) };
          break;
        }
      }
    }
    return {
      dialog: dlg ? { cls: String(dlg.className).slice(0, 60), text: (dlg.innerText || '').replace(/\s+/g, ' ').slice(0, 300) } : null,
      bodyHead: body.slice(0, 400),
      above,
      btns: Array.from(document.querySelectorAll('button, [role=button]')).map((b) => {
        const r = b.getBoundingClientRect();
        const t = ((b.getAttribute('aria-label') || b.title || b.textContent) || '').trim();
        if (!t || r.width === 0) return null;
        if (!/restore|revert|undo|roll|保留|恢复|撤销/i.test(t)) return null;
        return { t: t.slice(0, 60), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      }).filter(Boolean),
    };
  });
  log('AFTER:', JSON.stringify(after, null, 1));
  fs.writeFileSync(OUT + '/after-revert.json', JSON.stringify(after, null, 1));
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 400)); process.exit(1); });
