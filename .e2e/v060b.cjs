// v0.6.0 完整用户流（全新会话，确定性路径）
const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
delete process.env.LD_PRELOAD;
const OUT = '/data/data/com.termux/files/home/dsh-plugins-src/dsh-message-ops/.e2e/opencode-research';
const log = (...a) => console.log('>>>', ...a);
const fs = require('fs');
(async () => {
  const bootLog = fs.readFileSync('/data/data/com.termux/files/home/dsh3081.log', 'utf8');
  const token = (bootLog.match(/token=([A-Za-z0-9_-]+)/) || [])[1];
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const cerr = [];
  page.on('console', (m) => { if (m.type() === 'error') cerr.push(m.text().slice(0, 200)); });
  await page.goto('http://127.0.0.1:3081/?token=' + token, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  for (let i = 0; i < 25; i++) { await page.waitForTimeout(1000); if (await page.evaluate(() => document.querySelectorAll('[role=treeitem]').length) > 0) break; }
  // 新建会话
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => /New session|新建会话/i.test(x.getAttribute('aria-label') || x.title || x.textContent || ''));
    if (b) b.click();
  });
  await page.waitForTimeout(5000);
  // 发3条（等每条生成完）
  const userCount = () => page.evaluate(() => document.querySelectorAll('[data-chat-flow-kind="user"]').length);
  const waitIdle = async () => {
    for (let i = 0; i < 20; i++) {
      const stopping = await page.evaluate(() => Array.from(document.querySelectorAll('button')).find((b) => /stop/i.test(b.getAttribute('aria-label') || '')));
      if (!stopping) return;
      if (i === 0) { await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /stop/i.test(x.getAttribute('aria-label') || '')); if (b) b.click() }); }
      await page.waitForTimeout(1000);
    }
  };
  // 发一条：输入 → Enter → 等 user 块出现 → 立刻 Stop（不依赖模型回复）
  const send = async (txt) => {
    const before = await userCount();
    await waitIdle();
    const ta = await page.$('textarea, [contenteditable="true"]');
    await ta.click();
    await page.keyboard.type(txt, { delay: 12 });
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(800);
      if (await userCount() > before) break;
      if (i === 4) await page.keyboard.press('Enter');
    }
    const n = await userCount();
    log('sent:', n > before, txt.slice(0, 22), '(', before, '->', n, ')');
    await waitIdle();  // 立刻停掉生成
    await page.waitForTimeout(800);
  };
  await send('FIRST u-geometry test message');
  await send('SECOND u-revert target message');
  await send('THIRD u-tail message');
  const pre = await page.evaluate(() => ({
    userBlocks: document.querySelectorAll('[data-chat-flow-kind="user"]').length,
    flow: document.querySelectorAll('[data-chat-flow-kind]').length,
  }));
  log('V0 pre-send state:', JSON.stringify(pre));

  // ── V2 hover 第二条用户消息 → 注入按钮 → 点击回滚
  const pt = await page.evaluate(() => {
    const blocks = Array.from(document.querySelectorAll('[data-chat-flow-kind="user"]'));
    const t = blocks.find((b) => (b.innerText || '').includes('SECOND u-revert target'));
    if (!t) return null;
    t.scrollIntoView({ block: 'center' });
    return null;
  });
  await page.waitForTimeout(800);
  const pt2 = await page.evaluate(() => {
    const blocks = Array.from(document.querySelectorAll('[data-chat-flow-kind="user"]'));
    const t = blocks.find((b) => (b.innerText || '').includes('SECOND u-revert target'));
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { x: r.x + Math.min(r.width / 2, 320), y: r.y + Math.min(r.height / 2, 30) };
  });
  log('V2 target pt:', JSON.stringify(pt2));
  if (pt2) { await page.mouse.move(pt2.x, pt2.y, { steps: 6 }); await page.waitForTimeout(1500); }
  const btn = await page.evaluate(() => {
    const b = document.querySelector('.mopsUserRevert');
    if (!b) return null;
    const blk = b.closest('[data-chat-flow-kind="user"]');
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), seq: blk ? blk.getAttribute('data-mops-seq') : null, op: getComputedStyle(b).opacity, aria: b.getAttribute('aria-label') };
  });
  log('V2 BTN:', JSON.stringify(btn), '| want exists, seq>0');
  if (btn) {
    log('V2 click opacity(before):', btn.op);
    await page.mouse.click(btn.x, btn.y);
    await page.waitForTimeout(4000);
  }
  const post = await page.evaluate(() => {
    const dock = document.querySelector('.mopsRd');
    const card = document.querySelector('[class*="uV2eYG_card"]');
    const secondVisible = (document.body.innerText || '').includes('SECOND u-revert target');
    const R = (e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), b: Math.round(r.bottom) }; };
    return {
      bar: dock ? { ...R(dock), label: dock.getAttribute('aria-label') } : null,
      card: card ? R(card) : null,
      gap: dock && card ? Math.round(card.getBoundingClientRect().top - dock.getBoundingClientRect().bottom) : null,
      dx: dock && card ? Math.round(dock.getBoundingClientRect().x - card.getBoundingClientRect().x) : null,
      dw: dock && card ? Math.round(dock.getBoundingClientRect().width - card.getBoundingClientRect().width) : null,
      secondStillVisible: secondVisible,
      flowNow: document.querySelectorAll('[data-chat-flow-kind]').length,
    };
  });
  log('V2 POST-REVERT:', JSON.stringify(post, null, 1));

  // ── V4 展开贴条 → 逐行恢复 → 干净文本
  const exp = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.mopsRd button')).find((x) => (x.getAttribute('aria-label') || '').toLowerCase().includes('expand'));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  log('V4 expand pt:', JSON.stringify(exp));
  if (exp) { await page.mouse.click(exp.x, exp.y); await page.waitForTimeout(1500); }
  const restore = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.mopsRdList button')).find((x) => /恢复|Restore/.test((x.textContent || '').trim()));
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), disabled: b.disabled };
  });
  log('V4 restore pt:', JSON.stringify(restore));
  if (restore && !restore.disabled) { await page.mouse.click(restore.x, restore.y); await page.waitForTimeout(6000); }
  const postRestore = await page.evaluate(() => ({
    bar: !!document.querySelector('.mopsRd'),
    secondBack: (document.body.innerText || '').includes('SECOND u-revert target'),
    hasPrefix: (document.body.innerText || '').includes('[恢复]'),
  }));
  log('V4 POST-RESTORE:', JSON.stringify(postRestore), '| want bar:false secondBack:true hasPrefix:false');

  // ── V3 对话框（选中一条 → 数模式）
  const curSid = await page.evaluate(() => {
    const a = document.querySelector('[data-row-key][aria-current="true"], [data-row-key].active, [data-row-key][data-active="true"], [data-row-key][aria-selected="true"]');
    const k = a ? a.dataset.rowKey : null;
    return k && k.startsWith('session:') ? k.slice(8) : null;
  });
  log('current session:', curSid);
  await page.evaluate((sid) => window.dispatchEvent(new CustomEvent('dsh-message-ops:open', { detail: { title: 't', sessionId: sid } })), curSid);
  await page.waitForTimeout(3500);
  const modes = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('[role=dialog]'));
    const d = all.find((x) => x.querySelector('input[name=dsh-message-ops-pick]'));
    if (!d) return { dlg: false };
    const picks = Array.from(d.querySelectorAll('input[name=dsh-message-ops-pick]')).filter((r) => !r.disabled);
    if (picks.length) picks[0].click();
    return { dlg: true, picks: picks.length, pending: true };
  });
  await page.waitForTimeout(800);
  const modes2 = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('[role=dialog]'));
    const d = all.find((x) => x.querySelector('input[name=dsh-message-ops-pick]'));
    if (!d) return { dlg: false };
    const modeRadios = Array.from(d.querySelectorAll('input[name=dsh-message-ops-mode]'));
    const labels = modeRadios.map((r) => ((r.closest('label') || {}).textContent || '').trim().slice(0, 16));
    return { modeCount: modeRadios.length, labels, hasRestore: labels.some((l) => /恢复|Restore/.test(l)) };
  });
  log('V3 DIALOG:', JSON.stringify(modes), JSON.stringify(modes2), '| want modeCount:3 hasRestore:false');
  await page.keyboard.press('Escape').catch(() => {});
  await page.screenshot({ path: OUT + '/96-v060b.png' });
  log('CERR:', JSON.stringify(cerr.slice(0, 8)));
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 400)); process.exit(1); });
