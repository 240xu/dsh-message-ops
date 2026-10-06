// 0.8.0 按轮步进恢复 全环：行=轮、点一轮回一轮、逐轮清空、无前缀
const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
delete process.env.LD_PRELOAD;
const log = (...a) => console.log('>>>', ...a);
const API = 'http://127.0.0.1:3081';
let SID = null;
const J = async (p, o) => { const r = await fetch(API + p, Object.assign({ headers: { 'content-type': 'application/json' } }, o || {})); const t = await r.text(); try { return { s: r.status, b: JSON.parse(t) } } catch { return { s: r.status, b: t.slice(0, 160) } } };
(async () => {
  const token = (fs.readFileSync('/data/data/com.termux/files/home/dsh3081.log', 'utf8').match(/token=([A-Za-z0-9_-]+)/) || [])[1];
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(API + '/?token=' + token, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  for (let i = 0; i < 25; i++) { await page.waitForTimeout(1000); if (await page.evaluate(() => document.querySelectorAll('[role=treeitem]').length) > 0) break; }
  for (let att = 0; att < 4 && !SID; att++) {
    await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /New session|新建会话/i.test(x.getAttribute('aria-label') || x.title || x.textContent || '')); if (b) b.click(); });
    await page.waitForTimeout(5000);
    SID = await page.evaluate(() => { const a = document.querySelector('[data-row-key][aria-current="true"], [data-row-key][aria-selected="true"]'); const k = a ? a.dataset.rowKey : null; return k && k.startsWith('session:') ? k.slice(8) : null });
    log('new-session attempt', att + 1, '→', SID);
  }
  if (!SID) { log('ABORT no SID'); await browser.close(); return; }
  log('SID:', SID);
  const waitIdle = async () => {
    for (let i = 0; i < 40; i++) {
      const r = await J(`/api/message-ops/messages?sessionId=${SID}`);
      if (!r.b.running) return true;
      if (i % 4 === 0) await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /stop/i.test(x.getAttribute('aria-label') || '')); if (b) b.click() }).catch(() => {});
      await page.waitForTimeout(2000);
    }
    return false;
  };
  const send = async (txt) => {
    const n0 = await page.evaluate(() => document.querySelectorAll('[data-chat-flow-kind="user"]').length);
    const ta = await page.$('textarea, [contenteditable="true"]'); await ta.click(); await page.keyboard.type(txt, { delay: 10 }); await page.keyboard.press('Enter');
    for (let i = 0; i < 20; i++) { await page.waitForTimeout(800); if (await page.evaluate(() => document.querySelectorAll('[data-chat-flow-kind="user"]').length) > n0) break; }
    log('sent:', txt.slice(0, 18));
  };
  await send('S1 alpha round content');
  await waitIdle();
  await send('S2 beta round content');
  await waitIdle();
  // 找第一条真实用户消息 seq（过滤宿主注入行）
  const lst = await J(`/api/message-ops/messages?sessionId=${SID}`);
  const users = (lst.b.messages || []).filter((m) => m.role === 'user' && m.visible !== false && !/^<system-reminder|current runtime context/i.test(m.snippet || ''));
  const firstSeq = users[0] && users[0].seq;
  log('first user seq:', firstSeq, '| users:', JSON.stringify(users.map((u) => u.seq + ':' + (u.snippet || '').slice(0, 18))));
  // 回滚第一条
  const rev = await J('/api/message-ops/revert', { method: 'POST', body: JSON.stringify({ sessionId: SID, seq: firstSeq }) });
  log('revert:', rev.s, JSON.stringify(rev.b).slice(0, 140));
  // marker 进度
  const after = await J(`/api/message-ops/messages?sessionId=${SID}`);
  const marker = (after.b.messages || []).find((m) => m.marker && m.restoreComplete !== true);
  log('marker:', marker && marker.seq, '| pendingTurns:', JSON.stringify(marker && marker.pendingTurns));
  if (!marker || !marker.pendingTurns || marker.pendingTurns.length < 1) { log('ABORT no turns'); await browser.close(); return; }
  const turnCount0 = marker.pendingTurns.length;
  // 客户端（视图已开着——New session 即会话视图）：派 CHANGED 让贴条感知 API 回滚
  await page.evaluate(() => window.dispatchEvent(new Event('dsh-message-ops:changed')));
  let rows0 = [];
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(1500);
    const has = await page.evaluate(() => !!document.querySelector('.mopsRdHead'));
    if (!has) continue;
    await page.evaluate(() => { const b = document.querySelector('.mopsRdHead button'); if (b) b.click() });
    await page.waitForTimeout(1200);
    rows0 = await page.evaluate(() => Array.from(document.querySelectorAll('.mopsRdRow')).map((r) => (r.innerText || '').replace(/\s+/g, ' ').slice(0, 60)));
    if (rows0.length >= turnCount0) break;
  }
  log('DOCK rows (want', turnCount0, '):', rows0.length, JSON.stringify(rows0));
  // 点第一行恢复（只回第一轮）
  const r1 = await page.evaluate(() => { const b = document.querySelector('.mopsRdRestore'); if (!b || b.disabled) return null; b.click(); return true });
  log('client row1 click:', r1);
  await page.waitForTimeout(6000);
  const resp1 = await J(`/api/message-ops/messages?sessionId=${SID}`);
  const mk1 = (resp1.b.messages || []).find((m) => m.marker && m.seq === (marker && marker.seq));
  log('after client row1: visible S1 copies =', (resp1.b.messages || []).filter((m) => m.visible !== false && (m.snippet || '').includes('S1 alpha round content')).length,
      '| remaining turns:', mk1 && mk1.pendingTurns && mk1.pendingTurns.length, '(was', turnCount0, ')',
      '| bar still there:', await page.evaluate(() => !!document.querySelector('.mopsRd')));

  // 逐轮点到清空
  let guard = 0;
  while (guard++ < 8) {
    const mk = await J(`/api/message-ops/messages?sessionId=${SID}`).then((x) => (x.b.messages || []).find((m) => m.marker && m.seq === (marker && marker.seq) && m.restoreComplete !== true));
    if (!mk) break;
    const upTo = mk.pendingTurns && mk.pendingTurns[0] ? mk.pendingTurns[0].upTo : undefined;
    const rr = await J('/api/message-ops/restore', { method: 'POST', body: JSON.stringify(upTo != null ? { sessionId: SID, seq: mk.seq, upToSeq: upTo } : { sessionId: SID, seq: mk.seq }) });
    log('API restore →', rr.s, 'restored', rr.b && rr.b.restoredCount, 'upTo', rr.b && rr.b.upToSeq);
    await page.waitForTimeout(1200);
  }
  let mkFin = null;
  let fin = null;
  for (let i = 0; i < 10; i++) {
    fin = await J(`/api/message-ops/messages?sessionId=${SID}`);
    mkFin = (fin.b.messages || []).find((m) => m.marker && m.seq === (marker && marker.seq) && m.restoreComplete !== true);
    if (!mkFin) break;
    await page.waitForTimeout(2000);
  }
  const prefix = (fin.b.messages || []).some((m) => m.visible !== false && (m.snippet || '').includes('[恢复]'));
  const dup = (fin.b.messages || []).filter((m) => m.visible !== false && (m.snippet || '').includes('S1 alpha round content')).length;
  log('dup check: visible S1 copies =', dup, '(want 1)');
  log('FINAL: markerActive=', !!mkFin, '| prefix:', prefix);
  // 客户端贴条应消失
  await page.evaluate(() => window.dispatchEvent(new Event('dsh-message-ops:changed'))).catch(() => {});
  await page.waitForTimeout(2500);
  const barGone = await page.evaluate(() => !document.querySelector('.mopsRd'));
  log('BAR GONE (client):', barGone);
  log('VERDICT:', !mkFin && !prefix && barGone ? 'GREEN' : 'RED');
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 300)); process.exit(1); });
