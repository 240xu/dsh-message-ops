// 逐步交互对话框：dump 每步后的完整状态（radio 可用性/mode/confirm/结果）
const pw = require('/data/data/com.termux/files/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const fs = require('fs');
const bootLog = fs.readFileSync('/data/data/com.termux/files/home/dsh3081.log', 'utf8');
const token = (bootLog.match(/token=([A-Za-z0-9_-]+)/) || [])[1];
delete process.env.LD_PRELOAD;
const TEST_SID = 'session-2188f4ac-fa16-4560-9ded-d0555d0793c7';
const log = (...a) => console.log('>>>', ...a);
(async () => {
  const browser = await pw.chromium.launch({ headless: true, executablePath: '/data/data/com.termux/files/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const net = [];
  page.on('response', (r) => { if (r.url().includes('message-ops/revert') || r.url().includes('message-ops/restore')) net.push(r.status() + ' ' + decodeURIComponent(r.url()).slice(-40)); });
  await page.goto('http://127.0.0.1:3081/?token=' + token, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  for (let i = 0; i < 25; i++) { await page.waitForTimeout(1000); if (await page.evaluate(() => document.querySelectorAll('[role=treeitem]').length) > 0) break; }
  // 打开会话（轮询）
  let found = null;
  for (let i = 0; i < 15 && !found; i++) {
    found = await page.evaluate((sid) => {
      const el = Array.from(document.querySelectorAll('[data-row-key]')).find(e => (e.dataset.rowKey || '').includes(sid));
      if (!el) return null; el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return r.width > 0 ? { x: r.x + Math.min(r.width / 2, 150), y: r.y + r.height / 2 } : null;
    }, TEST_SID);
    if (found) break;
    await page.evaluate(() => {
      const ws = Array.from(document.querySelectorAll('[role=treeitem]')).find(e => (e.textContent || '').trim().startsWith('zcode2api'));
      if (ws && ws.getAttribute('aria-expanded') !== 'true') ws.click();
      const more = Array.from(document.querySelectorAll('button')).find(b => /^Show \d+ more/i.test((b.textContent || '').trim()));
      if (more) more.click();
    });
    await page.waitForTimeout(2000);
  }
  if (!found) { log('NO ROW'); await browser.close(); return; }
  await page.mouse.dblclick(found.x, found.y);
  await page.waitForTimeout(7000);
  // dblclick 会话行会弹「Rename session」对话框——先 Esc 关掉它
  const renameOpen = await page.evaluate(() => {
    const d = Array.from(document.querySelectorAll('[role=dialog]')).find(d => /Rename session/.test(d.textContent || ''));
    return !!d;
  });
  if (renameOpen) { await page.keyboard.press('Escape'); await page.waitForTimeout(1200); log('closed rename dialog'); }
  // 直派我们的对话框
  await page.evaluate((sid) => window.dispatchEvent(new CustomEvent('dsh-message-ops:open', { detail: { title: 't', sessionId: sid } })), TEST_SID);
  await page.waitForTimeout(3500);
  // 确认视图开没开
  const viewOk = await page.evaluate(() => (document.body.innerText || '').includes('zcode.z.ai'));
  log('VIEW OPEN:', viewOk);
  const dump = async (tag) => page.evaluate((tg) => {
    const all = Array.from(document.querySelectorAll('[role=dialog]'));
    const d = all.find(x => x.querySelector('input[name=dsh-message-ops-pick]')) || all.find(x => /Message ops/.test(x.textContent || '')) || null;
    if (!d) return { tag: '(no dialog)' };
    const radios = Array.from(d.querySelectorAll('input[type=radio]'));
    const enabled = radios.filter(r => !r.disabled);
    const checked = radios.filter(r => r.checked).map(r => (r.closest('label') || {}).textContent?.slice(0, 30));
    const btns = Array.from(d.querySelectorAll('button')).map(b => ({ t: (b.textContent || '').trim().slice(0, 18), dis: b.disabled }));
    const cb = d.querySelector('input[type=checkbox]');
    return { tag: tg, radios: radios.length, enabled: enabled.length, checked, cbChecked: cb ? cb.checked : null, btns: btns.slice(0, 10) };
  }, tag);
  log('STEP0 dialog:', JSON.stringify(await dump('loaded')));
  // pick 最后一个可用 radio
  const picked = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('[role=dialog]'));
    const d = all.find(x => x.querySelector('input[name=dsh-message-ops-pick]')) || all.find(x => /Message ops/.test(x.textContent || '')) || document.body;
    const radios = Array.from(d.querySelectorAll('input[type=radio]')).filter(r => !r.disabled);
    if (!radios.length) return { ok: false };
    radios[radios.length - 1].click();
    return { ok: true, n: radios.length, label: ((radios[radios.length - 1].closest('label') || {}).textContent || '').slice(0, 40) };
  });
  log('STEP1 picked:', JSON.stringify(picked));
  await page.waitForTimeout(800);
  log('STEP2 after-pick:', JSON.stringify(await dump('picked')));
  // 选 mode（找 label 含 Revert/回滚 的 radio）
  const mode = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('[role=dialog]'));
    const d = all.find(x => x.querySelector('input[name=dsh-message-ops-pick]')) || all.find(x => /Message ops/.test(x.textContent || '')) || document.body;
    const labels = Array.from(d.querySelectorAll('label'));
    const m = labels.find(l => /回滚到此条|Revert: remove|回滚/i.test(l.textContent || '')) || labels.find(l => /^Revert/i.test((l.textContent || '').trim()));
    if (!m) return { found: false, nLabels: labels.length, labels: labels.map(l => (l.textContent || '').trim().slice(0, 40)) };
    const radio = m.querySelector('input[type=radio]');
    if (radio) radio.click(); else m.click();
    return { found: true };
  });
  log('STEP3 mode:', JSON.stringify(mode));
  await page.waitForTimeout(600);
  const ack = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('[role=dialog]'));
    const d = all.find(x => x.querySelector('input[name=dsh-message-ops-pick]')) || all.find(x => /Message ops/.test(x.textContent || '')) || document.body;
    const cb = d.querySelector('input[type=checkbox]');
    if (cb && !cb.checked) cb.click();
    return cb ? cb.checked : 'no-cb';
  });
  log('STEP4 ack:', ack);
  await page.waitForTimeout(400);
  log('STEP5 pre-confirm:', JSON.stringify(await dump('pre')));
  // 点确认（排除 mode 选择按钮——找 disabled=false 且文本为回滚/Revert 且不在 radio label 内）
  const conf = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('[role=dialog]'));
    const d = all.find(x => x.querySelector('input[name=dsh-message-ops-pick]')) || all.find(x => /Message ops/.test(x.textContent || '')) || document.body;
    const btns = Array.from(d.querySelectorAll('button')).filter(b => !b.disabled && /^(回滚|Revert|Delete|删除|Branch|分支|恢复|Restore)$/.test((b.textContent || '').trim()));
    if (!btns.length) return { clicked: false, candidates: Array.from(d.querySelectorAll('button')).map(b => ((b.textContent || '') + '|' + (b.getAttribute('aria-label') || '')).trim().slice(0, 40)).slice(0, 16) };
    const b = btns[btns.length - 1];
    b.click();
    return { clicked: true };
  });
  log('STEP6 confirm:', JSON.stringify(conf));
  await page.waitForTimeout(5000);
  log('STEP7 after-confirm:', JSON.stringify(await dump('done')));
  const fullText = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('[role=dialog]'));
    const d = all.find(x => x.querySelector('input[name=dsh-message-ops-pick]')) || all.find(x => /Message ops/.test(x.textContent || '')) || null;
    return d ? (d.textContent || '').replace(/\s+/g, ' ').slice(0, 400) : null;
  });
  log('DLG-FULL:', fullText);
  // 结构全量：roles + 我们对话框的尾部（mode/ack/confirm 区）
  const struct = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('[role=dialog]'));
    const d = all.find(x => x.querySelector('input[name=dsh-message-ops-pick]')) || all.find(x => /Message ops/.test(x.textContent || ''));
    if (!d) return null;
    const roles = {};
    d.querySelectorAll('[role]').forEach(e => { roles[e.getAttribute('role')] = (roles[e.getAttribute('role)')] || 0); });
    const roleCount = {};
    d.querySelectorAll('[role]').forEach(e => { const r = e.getAttribute('role'); roleCount[r] = (roleCount[r] || 0) + 1; });
    const txt = (d.textContent || '').replace(/\s+/g, ' ');
    return {
      roleCount,
      tail: txt.slice(-500),
      hasRevertText: /回滚|Revert/.test(txt),
      hasAckText: /我已知晓|acknowledge|Acknowledge|I understand|确认了解/.test(txt),
      checkboxes: d.querySelectorAll('input[type=checkbox]').length,
      radioGroups: d.querySelectorAll('[role=radiogroup], [role=radio]').length,
      ariaLabels: Array.from(d.querySelectorAll('button,[role=button]')).map(b => b.getAttribute('aria-label') || (b.textContent || '').trim().slice(0, 14)).slice(0, 16),
    };
  });
  log('STRUCT:', JSON.stringify(struct));
  log('NET:', JSON.stringify(net));
  await browser.close();
})().catch((e) => { console.error('FATAL', String(e).slice(0, 300)); process.exit(1); });
