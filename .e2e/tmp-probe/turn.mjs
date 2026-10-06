import { readSessionFile } from '/data/data/com.termux/files/home/dsh-plugins-src/dsh-message-ops/src/session-file.js'
const p = process.argv[2]
const { events } = readSessionFile(p)
const rows = events.filter(e => e && (e.type==='user/message'||e.type==='assistant/message'||e.type==='system/message')).slice(-25)
for (const e of rows) console.log(String(e.seq).padStart(5), e.type.padEnd(18), 'turn=' + JSON.stringify(e.data?.turn ?? null), 'step=' + JSON.stringify(e.data?.step ?? null), (JSON.stringify(e.data?.message?.content?.[0]?.text ?? '').slice(0,40)))
