import { readSessionFile } from '/data/data/com.termux/files/home/dsh-plugins-src/dsh-message-ops/src/session-file.js'
import fs from 'node:fs'
import path from 'node:path'
const root = path.join(process.env.DSH_HOME || process.env.HOME + '/.dsh', 'sessions')
const slugs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory())
let hits = [], total = 0, extraKeys = new Map()
const KNOWN = new Set(['turn','step','message','content','source','call','name','id','arguments','result','summary'])
for (const s of slugs) {
  let ids = []
  try { ids = fs.readdirSync(path.join(root, s.name), { withFileTypes: true }).filter(d => d.isDirectory()) } catch { continue }
  for (const id of ids) {
    for (const n of ['session.v4.jsonl.zstd','session.v3.jsonl.zstd','session.jsonl.zstd']) {
      const p = path.join(root, s.name, id.name, n)
      try { fs.statSync(p) } catch { continue }
      let ev = []
      try { ev = readSessionFile(p).events } catch { continue }
      total++
      for (const e of ev) {
        if (!e || !e.data || typeof e.data !== 'object') continue
        for (const k of Object.keys(e.data)) {
          if (KNOWN.has(k)) continue
          extraKeys.set(k, (extraKeys.get(k)||0)+1)
        }
        if (typeof e.data.restoresSeq === 'number') hits.push({ file: p.replace(root,''), seq: e.seq, type: e.type, restoresSeq: e.data.restoresSeq })
      }
      break
    }
  }
}
console.log('sessions scanned:', total)
console.log('restoresSeq hits:', hits.length)
console.log(JSON.stringify(hits.slice(0, 10), null, 1))
console.log('top extra data keys:', [...extraKeys.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 25))
