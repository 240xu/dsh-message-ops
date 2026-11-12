import { readFileSync } from 'node:fs'
const src = readFileSync('src/client.js', 'utf8')
const at = src.indexOf('const clipQuote = ')
let d = 0, started = false, end = at
for (let i = at; i < src.length; i++) {
  if (src[i] === '{') { d++; started = true } else if (src[i] === '}') { d--; if (started && d === 0) { end = i + 1; break } }
}
const body = src.slice(at, end)
const QUOTE_MAX_CHARS = 600
const clipQuote = new Function('QUOTE_MAX_CHARS', body.replace('const clipQuote = ', 'return ').replace(/;\s*$/, '') + ';')(QUOTE_MAX_CHARS)
console.log('1 plain 700 ->', clipQuote('a'.repeat(700)).length)
const emoji = '👨‍👩‍👧‍👦'
const r2 = clipQuote('a'.repeat(598) + emoji)
console.log('2 emoji case ends with:', JSON.stringify(r2.slice(-8)), '| valid pairs:', [...r2].length)
const fence = 'x'.repeat(595) + '\n```js\ncode\n```\n'
console.log('3 fence tail:', JSON.stringify(clipQuote(fence).slice(-24)))
const r4 = clipQuote('a'.repeat(700))
console.log('4 no-ws len:', r4.length, 'tail:', JSON.stringify(r4.slice(-3)))
console.log('5 exactly 600:', clipQuote('a'.repeat(600)).length, 'has ellipsis:', clipQuote('a'.repeat(600)).includes('…'))
