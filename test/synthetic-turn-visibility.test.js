import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client.js'), 'utf8')

function extractArrow(name) {
  const start = src.indexOf(`const ${name} =`)
  assert.ok(start >= 0, `找不到 ${name}`)
  const bodyStart = src.indexOf('{', src.indexOf('=>', start))
  let depth = 0
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1)
  }
  throw new Error(`${name} 函数体不完整`)
}

function fakeDocument() {
  const head = {
    children: [],
    appendChild(el) { this.children.push(el); el.parent = this },
  }
  return {
    head,
    getElementById(id) { return head.children.find((el) => el.id === id) || null },
    createElement() {
      return {
        id: '',
        textContent: '',
        remove() {
          const at = head.children.indexOf(this)
          if (at >= 0) head.children.splice(at, 1)
        },
      }
    },
  }
}

test('客户端按 syntheticTurn 隐藏旧/新合成 turn 的宿主过程行', () => {
  const doc = fakeDocument()
  const idLine = src.match(/const SYNTHETIC_TURN_STYLE_ID = '[^']+'/)[0]
  const factory = new Function('document', `${idLine}; ${extractArrow('syncSyntheticTurnStyle')}; return syncSyntheticTurnStyle`)
  const sync = factory(doc)

  sync([
    { syntheticTurn: true, turn: 121 },
    { syntheticTurn: true, turn: 123 },
    { syntheticTurn: false, turn: 5 },
  ])

  assert.equal(doc.head.children.length, 1)
  const css = doc.head.children[0].textContent
  assert.match(css, /data-chat-flow-kind="turn-process"\]\[data-chat-turn="121"\]/)
  assert.match(css, /data-chat-flow-kind="turn-process"\]\[data-chat-turn="123"\]/)
  assert.doesNotMatch(css, /data-chat-turn="5"/)

  sync([{ syntheticTurn: false, turn: 121 }])
  assert.equal(doc.head.children.length, 0)
})
