/**
 * 0.12.0 行为测试：分叉边界的**语义**（不是形状）。
 *
 * 前一轮审计的教训（见 client-perf-locks.test.js 头注释）：整个 useEffect 被注释掉
 * 也能全绿，因为锁只断言「源码里有某个字符串」。这组测试反过来：把 client.js 里
 * 的真函数**抽出来执行**，喂真实的 seq 值，断言算出来的边界。
 *
 * 语义依据：opencode `POST /api/session/{id}/fork` 的 `before` 是**排他**边界
 * （projector.ts: `type === "before" ? lt(seq, boundary.seq) : lte(...)`），
 * 而 dsh 官方 `sessions.fork(source, boundary)` 的 boundary 是**闭区间**。
 * 两者对齐的唯一办法就是把边界退一格。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

/** 抽取 `function NAME(...) {...}` 并求值成真函数（无外部依赖时可用）。 */
function extractFn(name) {
  const at = src.indexOf('function ' + name)
  assert.notEqual(at, -1, `找不到 function ${name}`)
  let depth = 0
  let started = false
  for (let i = at; i < src.length; i++) {
    if (src[i] === '{') { depth++; started = true }
    else if (src[i] === '}') {
      depth--
      if (started && depth === 0) {
        const text = src.slice(at, i + 1)
        // eslint-disable-next-line no-new-func
        return new Function(`${text}; return ${name}`)()
      }
    }
  }
  throw new Error(`function ${name} 块未闭合`)
}

const forkBoundaryBefore = extractFn('forkBoundaryBefore')

test('真执行：按轮切 —— 有 turnStartSeq 时边界 = turnStartSeq - 1（不落在 turn 内部）', () => {
  // 真实形状：turn/start(4) → … → system(7) → user(8)
  assert.equal(forkBoundaryBefore(8, 4), 3, '边界应退到 turn/start 之前，而不是 seq-1=7（turn 内的 system/message）')
  assert.equal(forkBoundaryBefore(12, 10), 9, '跨轮：turn 2 的用户消息应切在 turn 1 的 turn/end')
})

test('真执行：没有 turn 信息时保守回退到 seq - 1（老服务端 / 合成行）', () => {
  assert.equal(forkBoundaryBefore(5), 4)
  assert.equal(forkBoundaryBefore(5, null), 4)
  assert.equal(forkBoundaryBefore(5, undefined), 4)
})

test('真执行：turnStartSeq 非法时回退，不能算出 NaN 或负数边界', () => {
  for (const bad of [0, -1, 1.5, Number.NaN, '4', {}]) {
    const b = forkBoundaryBefore(9, bad)
    assert.equal(b, 8, `turnStartSeq=${String(bad)} 必须回退到 seq-1`)
  }
})

test('真执行：首条消息（seq 0）且无 turn 信息 → 哨兵 -1', () => {
  assert.equal(forkBoundaryBefore(0), -1)
  assert.equal(forkBoundaryBefore(0, null), -1)
})

test('真执行：非法 seq 且无 turn 信息 → -1，不静默当 0 处理', () => {
  for (const bad of [null, undefined, -3, 1.5, Number.NaN, Infinity, '7', {}]) {
    assert.equal(forkBoundaryBefore(bad), -1, `输入 ${String(bad)} 应返回 -1`)
  }
})

test('真执行：turnStartSeq 优先于 seq —— 两者都合法时永远按轮切', () => {
  const cases = [[8, 4, 3], [12, 10, 9], [100, 50, 49], [7, 4, 3]]
  for (const [seq, ts, want] of cases) {
    assert.equal(forkBoundaryBefore(seq, ts), want, `seq=${seq} turnStart=${ts} 应得 ${want}`)
  }
})
