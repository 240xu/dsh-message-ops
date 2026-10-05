// 深挖：结构化消息清单（范围语义）+ 细条计算样式 + 恢复行为
const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
delete process.env.LD_PRELOAD;
const OUT = '/data/data/com.termux/files/home/dsh-plugins-src/dsh-message-ops/.e2e/opencode-research';
const log = (...a) => console.log('>>>', ...a);
const sid = fs.readFileSync(OUT + '/session-id.txt', 'utf8').trim();
const msgDump = () => ({
  msgs: Array.from(document.querySelectorAll('[class*="message"], [data-message-id], [data-role]')).map((e) => ({
    cls: String(e.className).slice(0, 50), txt: (e.innerText || '').replace(/\s+/g, ' ').slice(0, 80),
  })).filter((m) => m.txt).slice(0, 16),
});
const barDump = () => {
  const ta = document.querySelector('textarea, [contenteditable="true"]');
  const taRect = ta ? ta.getBoundingClientRect() : null;
  // 找含 rolled back 的元素链
  const cand = Array.from(document.querySelectorAll('div,button')).filter((e) => /rolled back/i.test(e.innerText || '') && e.children.length < 12).sort((a, b) => a.innerText.length - b.innerText.length)[0];
  if (!cand) return { found: false, taRect };
  const r = cand.getBoundingClientRect();
  const cs = getComputedStyle(cand);
  const parent = cand.parentElement;
  const pcs = parent ? getComputedStyle(parent) : null;
  return {
    found: true,
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    taRect: taRect ? { y: Math.round(taRect.y), h: Math.round(taRect.height), w: Math.round(taRect.width) } : null,
    gapToTextarea: taRect ? Math.round(taRect.y - r.bottom) : null,
    style: { display: cs.display, height: cs.height, borderRadius: cs.borderRadius, border: cs.border, background: (cs.backgroundColor + ' / ' + cs.backgroundImage).slice(0, 90), padding: cs.padding, margin: cs.margin, fontSize: cs.fontSize },
    parent: parent ? { cls: String(parent.className).slice(0, 70), display: pcs.display, gap: pcs.gap, padding: pcs.padding } : null,
    text: (cand.innerText || '').replace(/\s+/g, ' ').slice(0, 160),
  };
};
(async () => {
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://127.0.0.1:4096/global/session/${sid}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(5000);

  // 先发两条消息建立可回滚结构：M1 user, A1, M2 user, A2
  const ta = await page.$('textarea, [contenteditable="true"]');
  for (const txt of ['first question about alpha', 'second question about beta']) {
    await ta.click();
    await page.keyboard.type(txt, { delay: 10 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(6000);
  }
  await page.waitForTimeout(4000);
  const msgsA = await page.evaluate(msgDump);
  log('MSGS BEFORE:', JSON.stringify(msgsA.msgs, null, 1).slice(0, 1600));

  // hover 第一条 user 消息 → revert
  const pt = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('div'));
    const t = els.filter((e) => (e.innerText || '').trim().startsWith('first question about alpha') && e.children.length < 12).sort((a, b) => a.innerText.length - b.innerText.length)[0];
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { x: r.x + Math.min(r.width / 2, 300), y: r.y + Math.min(r.height / 2, 30) };
  });
  log('M1 PT:', JSON.stringify(pt));
  if (pt) { await page.mouse.move(pt.x, pt.y, { steps: 5 }); await page.waitForTimeout(900); }
  const rev = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => /revert message/i.test(x.getAttribute('aria-label') || ''));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  log('REVERT:', JSON.stringify(rev));
  if (rev) { await page.mouse.click(rev.x, rev.y); await page.waitForTimeout(2500); }

  const msgsB = await page.evaluate(msgDump);
  log('MSGS AFTER REVERT-OF-FIRST:', JSON.stringify(msgsB.msgs, null, 1).slice(0, 1600));
  const bar = await page.evaluate(barDump);
  log('BAR STYLES:', JSON.stringify(bar, null, 1));
  await page.screenshot({ path: OUT + '/30-bar.png' });

  // 展开钮 → 列表与恢复按钮
  const exp = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => /expand rolled back/i.test(x.getAttribute('aria-label') || ''));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (exp) {
    await page.mouse.click(exp.x, exp.y);
    await page.waitForTimeout(1500);
    const expanded = await page.evaluate(() => {
      const body = document.body.innerText || '';
      const btns = Array.from(document.querySelectorAll('button')).map((b) => {
        const r = b.getBoundingClientRect();
        const t = ((b.getAttribute('aria-label') || b.title || b.textContent) || '').trim();
        if (!t || r.width === 0 || r.y < 600) return null;
        return { t: t.slice(0, 60), x: Math.round(r.x), y: Math.round(r.y), h: Math.round(r.height) };
      }).filter(Boolean);
      return { hint: (body.match(/.{0,50}(restore|Restore|恢复).{0,60}/) || [])[0] || null, btns };
    });
    log('EXPANDED:', JSON.stringify(expanded, null, 1));
    await page.screenshot({ path: OUT + '/31-expanded.png' });
    // 点主条（可能就是恢复）
    const main = await page.evaluate(() => {
      const cand = Array.from(document.querySelectorAll('div,button')).filter((e) => /rolled back/i.test(e.innerText || '') && e.getBoundingClientRect().width > 300 && e.getBoundingClientRect().height <= 60).sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width)[0];
      // 宽的父级里最窄的 ≤60 高
      if (!cand) return null;
      const r = cand.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, t: (cand.innerText || '').slice(0, 60) };
    });
    log('MAIN BAR PT:', JSON.stringify(main));
    if (main) {
      await page.mouse.click(main.x, main.y);
      await page.waitForTimeout(2500);
      const afterMain = await page.evaluate(() => ({
        barGone: !/rolled back/i.test(document.body.innerText || ''),
        head: (document.body.innerText || '').slice(0, 350),
      }));
      log('AFTER MAIN CLICK:', JSON.stringify(afterMain, null, 1));
      await page.screenshot({ path: OUT + '/32-after-main-click.png' });
    }
  } else {
    log('no expand button found');
  }
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 400)); process.exit(1); });
