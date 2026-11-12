import { readFileSync } from 'node:fs'
const src = readFileSync('src/client.js', 'utf8')
const at = src.indexOf('const clipQuote = ')
let d=0,started=false,end=at
for(let i=at;i<src.length;i++){if(src[i]==='{'){d++;started=true}else if(src[i]==='}'){d--;if(started&&d===0){end=i+1;break}}}
const QUOTE_MAX_CHARS=600
const clipQuote = new Function('QUOTE_MAX_CHARS', src.slice(at,end).replace('const clipQuote = ','return ').replace(/;\s*$/,'')+';')(QUOTE_MAX_CHARS)

const family='👨‍👩‍👧‍👦'
const out = clipQuote('a'.repeat(598)+family)
const tail=[...out].slice(-4)
console.log('tail code points:', tail.map(c=>'U+'+c.codePointAt(0).toString(16)).join(' '))
console.log('ends with ZWJ before ellipsis:', out.endsWith('\u200d…'))
// grapheme-level check
const segs=[...new Intl.Segmenter('en',{granularity:'grapheme'}).segment(out)]
const last=segs[segs.length-1].segment
console.log('last grapheme:', JSON.stringify(last), 'is complete family?', last===family)
console.log('LEN out:', out.length, 'code points:', [...out].length)
