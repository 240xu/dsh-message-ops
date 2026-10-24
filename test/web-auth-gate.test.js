import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { webAuthGate, browserAuthPayload, loadBrowserAuthSecret, _resetWebAuth, _setWebAuthSecret } from '../src/ops-core.js'

const req = { headers: { host: 'example.test' } }

test('webAuthGate：无 credentials 服务的老宿主保持旧围栏（allow）', async () => {
  _resetWebAuth()
  const ctx = { get: () => undefined }
  assert.equal(await webAuthGate(ctx, req), true)
})

test('webAuthGate：有 credentials 服务但认证记录不可读时 fail-closed', async () => {
  _resetWebAuth()
  const ctx = {
    get: (name) => name === 'credentials'
      ? { modifyRecord: async () => undefined }
      : undefined,
  }
  assert.equal(await webAuthGate(ctx, req), false)
  assert.equal(await webAuthGate(ctx, req), false, 'negative cache must stay closed')
})

test('webAuthGate：首次探测期间的并发请求不得 fail-open', async () => {
  _resetWebAuth()
  let release
  const pending = new Promise((resolve) => { release = resolve })
  let calls = 0
  const ctx = {
    get: (name) => name === 'credentials'
      ? { modifyRecord: async () => { calls++; return pending } }
      : undefined,
  }
  const first = webAuthGate(ctx, req)
  const second = webAuthGate(ctx, req)
  release(undefined)
  const [a, b] = await Promise.all([first, second])
  assert.equal(a, false)
  assert.equal(b, false)
  assert.equal(calls, 1, 'concurrent probes must be single-flight')
})

test('webAuthGate：有效宿主 cookie 仍放行，过期 cookie 拒绝', async () => {
  _resetWebAuth()
  const secret = Buffer.alloc(32, 7)
  _setWebAuthSecret(secret)
  const authority = 'example.test'
  const b64 = (v) => Buffer.from(v).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
  const make = (issuedAt, expiresAt) => {
    const body = b64(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }))
    const sig = b64(createHmac('sha256', secret).update(body).digest())
    return `dsh-auth-${b64(createHash('sha256').update(authority).digest())}=v1.${body}.${sig}`
  }
  const now = Date.now()
  assert.equal(await webAuthGate({ get: () => undefined }, { headers: { host: authority, cookie: make(now, now + 60_000) } }), true)
  assert.equal(await webAuthGate({ get: () => undefined }, { headers: { host: authority, cookie: make(now - 120_000, now - 60_000) } }), false)
})

test('loadBrowserAuthSecret：按宿主 credentials 记录格式读取 32 字节 secret', async () => {
  const secret = Buffer.alloc(32, 9)
  const encoded = secret.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
  const record = { kind: 'grant', payload: { version: 1, secret: encoded } }
  let seenKey = null
  const credentials = {
    async modifyRecord(key, mutate) {
      seenKey = key
      assert.equal(await mutate(record), undefined)
      return record
    },
  }
  assert.deepEqual(await loadBrowserAuthSecret(credentials), secret)
  assert.equal(seenKey, 'client-connection/browser-session')
  const invalid = { modifyRecord: async () => ({ kind: 'grant', payload: { version: 2, secret: encoded } }) }
  assert.equal(await loadBrowserAuthSecret(invalid), null)
  assert.equal(await loadBrowserAuthSecret({ modifyRecord: async () => ({ kind: 'grant', payload: { version: 1, secret: 'x' } }) }), null)
})
