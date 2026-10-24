/**
 * Session trash contract (TDD).
 *
 * The trash is a reversible move: the session directory is renamed into
 * $DSH_HOME/trash/session-ops/<trashId>/data/... and the projection/workspace
 * metadata is captured in a manifest before being removed from the live
 * domains. Restore must put all of it back; purge must be explicit.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  deleteSessionToTrash,
  listTrash,
  restoreTrash,
  purgeTrash,
  trashRoot,
} from '../src/session-trash.js'

const SID = 'session-11111111-1111-4111-8111-111111111111'
const OTHER = 'session-22222222-2222-4222-8222-222222222222'

function makeCtx({ running = false, onDelete } = {}) {
  const proj = new Map([[SID, {
    identity: { createdAt: 1790000000000 },
    rows: { title: { val: '会话标题' } },
  }]])
  const workspaces = {
    w1: { path: '/tmp/project', title: '项目', sessionIds: [SID, OTHER] },
    w2: { path: '/tmp/other', title: 'Other', sessionIds: [OTHER] },
  }
  const global = {
    initialized: true,
    archivedSessionIds: [SID],
    pinnedSessionIds: [SID],
  }
  const projTable = {
    get: (k) => proj.get(k),
    delete: async (k) => { if (onDelete) await onDelete(k); proj.delete(k) },
    put: async (k, v) => { proj.set(k, v) },
    entries: () => proj.entries(),
  }
  const wsTable = {
    entries: () => Object.entries(workspaces),
    put: async (k, v) => { workspaces[k] = v },
  }
  const sd = {
    get(name) {
      if (name === 'session_projcache') return { table: () => projTable }
      if (name === 'workspace') return { table: () => wsTable, global: { get: () => global, set: async (v) => Object.assign(global, v) } }
      return undefined
    },
  }
  const ctx = {
    get(name) {
      if (name === 'storageDomain') return sd
      if (name === 'agents') return { get: () => (running ? { status: 'running' } : undefined) }
      if (name === 'sessions') return { get: () => undefined, flush: async () => {} }
      return undefined
    },
  }
  return { ctx, proj, workspaces, global }
}

function setup(t, ctxOptions = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mops-trash-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const dir = path.join(home, 'sessions', '--tmp-project--', SID)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), 'fake-frame')
  const env = makeCtx(ctxOptions)
  t.after(() => {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    fs.rmSync(home, { recursive: true, force: true })
  })
  return { home, dir, ...env }
}

test('delete moves the session directory into trash and strips metadata', async (t) => {
  const { ctx, dir, proj, workspaces, global } = setup(t)
  const result = await deleteSessionToTrash(ctx, SID, '会话标题')

  assert.equal(result.ok, true)
  assert.match(result.trashId, /^\d+-[0-9a-f]{8}$/)
  assert.equal(fs.existsSync(dir), false, 'source session dir must be moved away')
  assert.equal(proj.has(SID), false, 'projection row must be removed')
  assert.deepEqual(workspaces.w1.sessionIds, [OTHER], 'workspace membership must be stripped')
  assert.deepEqual(global.archivedSessionIds, [], 'archived marker must be stripped')
  assert.deepEqual(global.pinnedSessionIds, [], 'pinned marker must be stripped')

  const manifestPath = path.join(trashRoot(), result.trashId, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  assert.equal(manifest.state, 'trashed')
  assert.equal(manifest.sessionId, SID)
  assert.equal(manifest.title, '会话标题')
  assert.ok(manifest.projRow, 'projection row must be captured for restore')
  assert.deepEqual(manifest.workspaceIds, ['w1'])
  assert.equal(manifest.archived, true)
  assert.equal(manifest.pinned, true)
  assert.ok(fs.existsSync(path.join(trashRoot(), result.trashId, 'data', '--tmp-project--', SID, 'session.v4.jsonl.zstd')))

  const entries = await listTrash(ctx)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].trashId, result.trashId)
  assert.equal(entries[0].title, '会话标题')
})

test('restore puts the directory and all metadata back', async (t) => {
  const { ctx, dir, proj, workspaces, global } = setup(t)
  const { trashId } = await deleteSessionToTrash(ctx, SID, '会话标题')

  await restoreTrash(ctx, trashId)

  assert.equal(fs.existsSync(path.join(dir, 'session.v4.jsonl.zstd')), true)
  assert.equal(proj.has(SID), true)
  assert.equal(proj.get(SID).rows.title.val, '会话标题')
  assert.ok(workspaces.w1.sessionIds.includes(SID))
  assert.ok(global.archivedSessionIds.includes(SID))
  assert.ok(global.pinnedSessionIds.includes(SID))
  assert.deepEqual(await listTrash(ctx), [])
})

test('delete refuses a running session', async (t) => {
  const { home } = setup(t)
  const { ctx } = makeCtx({ running: true })
  await assert.rejects(
    () => deleteSessionToTrash(ctx, SID, '会话标题'),
    (e) => e.status === 409 && /running/i.test(e.message),
  )
  assert.equal(fs.existsSync(path.join(home, 'sessions', '--tmp-project--', SID)), true)
})

test('delete requires the exact title', async (t) => {
  const { ctx, dir } = setup(t)
  await assert.rejects(
    () => deleteSessionToTrash(ctx, SID, 'wrong title'),
    (e) => e.status === 400 && /title/i.test(e.message),
  )
  assert.equal(fs.existsSync(dir), true)
})

test('purge permanently removes a trash entry', async (t) => {
  const { ctx } = setup(t)
  const { trashId } = await deleteSessionToTrash(ctx, SID, '会话标题')
  await purgeTrash(ctx, trashId)
  assert.equal(fs.existsSync(path.join(trashRoot(), trashId)), false)
  assert.deepEqual(await listTrash(ctx), [])
})

test('expired trash entries can be swept without touching fresh ones', async (t) => {
  const { ctx } = setup(t)
  const old = await deleteSessionToTrash(ctx, SID, '会话标题')
  const manifestPath = path.join(trashRoot(), old.trashId, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.expiresAt = Date.now() - 1000
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))

  const entries = await listTrash(ctx, { purgeExpired: true })
  assert.deepEqual(entries, [])
  assert.equal(fs.existsSync(path.join(trashRoot(), old.trashId)), false)
})

test('restore refuses to overwrite an existing session directory', async (t) => {
  const { ctx, dir } = setup(t)
  const { trashId } = await deleteSessionToTrash(ctx, SID, '会话标题')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), 'new-frame')

  await assert.rejects(
    () => restoreTrash(ctx, trashId),
    (e) => e.status === 409 && /exists/i.test(e.message),
  )
  assert.equal(fs.readFileSync(path.join(dir, 'session.v4.jsonl.zstd'), 'utf8'), 'new-frame')
})

test('restore rejects a manifest whose rel escapes the sessions root', async (t) => {
  const { ctx, home } = setup(t)
  const { trashId } = await deleteSessionToTrash(ctx, SID, '会话标题')
  const manifestPath = path.join(trashRoot(), trashId, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const rel = '../../' + path.basename(home) + '-escape'
  manifest.dirs[0].rel = rel
  t.after(() => fs.rmSync(path.resolve(path.join(home, 'sessions'), rel), { recursive: true, force: true }))
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))

  const source = path.resolve(path.join(trashRoot(), trashId), 'data', rel)
  fs.mkdirSync(source, { recursive: true })
  fs.writeFileSync(path.join(source, 'session.v4.jsonl.zstd'), 'evil-frame')
  const escaped = path.resolve(path.join(home, 'sessions'), rel)

  await assert.rejects(
    () => restoreTrash(ctx, trashId),
    (e) => /invalid|rel|path|escape/i.test(e.message),
  )
  assert.equal(fs.existsSync(escaped), false, 'must not move outside the sessions root')
})

test('restore rejects a manifest with a non-session id', async (t) => {
  const { ctx } = setup(t)
  const { trashId } = await deleteSessionToTrash(ctx, SID, '会话标题')
  const manifestPath = path.join(trashRoot(), trashId, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.sessionId = '../../pwn'
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))

  await assert.rejects(
    () => restoreTrash(ctx, trashId),
    (e) => /invalid|sessionId/i.test(e.message),
  )
})

test('delete keeps the trash payload when rollback cannot restore the source', async (t) => {
  const { ctx } = setup(t, {
    onDelete: async () => {
      const source = path.join(process.env.DSH_HOME, 'sessions', '--tmp-project--', SID)
      fs.mkdirSync(source, { recursive: true })
      fs.writeFileSync(path.join(source, 'blocker'), 'x')
      const entries = fs.readdirSync(trashRoot(), { withFileTypes: true }).filter((e) => e.isDirectory())
      const tmp = path.join(trashRoot(), entries[0].name, 'manifest.json.tmp')
      fs.mkdirSync(tmp, { recursive: true })
    },
  })

  await assert.rejects(() => deleteSessionToTrash(ctx, SID, '会话标题'))

  const names = fs.readdirSync(trashRoot(), { withFileTypes: true }).filter((e) => e.isDirectory())
  assert.equal(names.length, 1, 'failed rollback must retain the trash entry')
  const root = path.join(trashRoot(), names[0].name)
  assert.ok(fs.existsSync(path.join(root, 'manifest.json')), 'manifest must survive')
  assert.ok(
    fs.existsSync(path.join(root, 'data', '--tmp-project--', SID, 'session.v4.jsonl.zstd')),
    'only copy of the session must survive',
  )
})
