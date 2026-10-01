// find the disposable "hi, reply with exactly" session via API and check its state
const http = require('http');
const fs = require('fs');
const token = fs.readFileSync('/data/data/com.termux/files/home/.config/opencode/kpad-dsh.token', 'utf8').trim();
function get(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 3080, path, headers: { Authorization: 'Bearer ' + token } }, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d.slice(0, 200)); } });
    }).on('error', reject);
  });
}
(async () => {
  const sess = await get('/api/sessions?limit=5').catch(e => String(e));
  console.log('sessions API:', typeof sess === 'string' ? sess : JSON.stringify(sess).slice(0, 300));
})();
