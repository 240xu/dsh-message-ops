/**
 * Reversible session deletion for dsh-message-ops.
 *
 * A delete is a move, never an unlink:
 *   ~/.dsh/sessions/<slug>/<id>/  ->  ~/.dsh/trash/session-ops/<trashId>/data/<slug>/<id>/
 * The projection-cache row and workspace/archive/pin membership are copied into
 * manifest.json, then removed from the live storage domains. Restore puts both
 * the directory and the metadata back. Purge is the only destructive operation.
 *
 * This module deliberately has no dependency on the HTTP layer so the contract
 * can be tested with a temporary DSH_HOME and an in-memory storageDomain.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { OpsError, isSessionId, sessionIdVariants, sessionsRoot, readSessionHeader } from "./session-file.js";

export const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const TRASH_ID_RE = /^\d{10,}-[0-9a-f]{8}$/;

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

export function trashRoot() {
  return path.join(dshHome(), "trash", "session-ops");
}

function cloneJson(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
}

function findAllSessionDirs(sessionId) {
  const root = sessionsRoot();
  const variants = sessionIdVariants(sessionId);
  let slugs = [];
  try { slugs = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const found = [];
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    for (const variant of variants) {
      const dir = path.join(root, slug.name, variant);
      try {
        if (fs.statSync(dir).isDirectory() && !found.some((x) => x.dir === dir)) {
          found.push({ dir, slug: slug.name, name: variant });
        }
      } catch { /* keep scanning */ }
    }
  }
  return found;
}

function storageDomain(ctx) {
  try { return ctx && typeof ctx.get === "function" ? ctx.get("storageDomain") : undefined; } catch { return undefined; }
}

function projectionTable(ctx) {
  const sd = storageDomain(ctx);
  const domain = sd && typeof sd.get === "function" ? sd.get("session_projcache") : undefined;
  if (!domain || typeof domain.table !== "function") return null;
  try { return domain.table("sessions"); } catch { return null; }
}

function workspaceDomain(ctx) {
  const sd = storageDomain(ctx);
  const domain = sd && typeof sd.get === "function" ? sd.get("workspace") : undefined;
  return domain && typeof domain.table === "function" ? domain : null;
}

function titleOfRow(row) {
  const title = row && row.rows && row.rows.title;
  if (title && typeof title.val === "string" && title.val.trim()) return title.val.trim();
  return null;
}

function headerTitle(dir) {
  try {
    const header = readSessionHeader(path.join(dir, fs.readdirSync(dir).find((f) => /^session(\.v[34])?\.jsonl\.zstd$/.test(f)) || ""));
    for (const key of ["title", "name", "displayTitle"]) {
      if (header && typeof header[key] === "string" && header[key].trim()) return header[key].trim();
    }
    if (header && header.session && typeof header.session.title === "string" && header.session.title.trim()) {
      return header.session.title.trim();
    }
  } catch { /* header unreadable: caller decides */ }
  return null;
}

/** Resolve the confirmation text shown by the delete dialog. Prefers the
 * projection-cache title; falls back to the log header; untitled sessions
 * confirm by their stable session id. */
export function resolveSessionTitle(ctx, sessionId) {
  if (!isSessionId(sessionId)) return null;
  const meta = readMetadata(ctx, sessionId);
  const title = titleOfRow(meta.projRow);
  if (title) return title;
  const dirs = findAllSessionDirs(sessionId);
  if (dirs.length === 1) {
    const fromHeader = headerTitle(dirs[0].dir);
    if (fromHeader) return fromHeader;
  }
  return sessionId;
}

function readMetadata(ctx, sessionId) {
  const variants = sessionIdVariants(sessionId);
  const projRows = [];
  const table = projectionTable(ctx);
  if (table && typeof table.get === "function") {
    for (const variant of variants) {
      let row;
      try { row = table.get(variant); } catch { row = undefined; }
      if (row !== undefined) {
        const copy = cloneJson(row);
        if (copy) projRows.push({ key: variant, row: copy });
      }
    }
  }

  const workspaceIds = [];
  const archived = [];
  const pinned = [];
  const ws = workspaceDomain(ctx);
  if (ws) {
    if (typeof ws.table === "function") {
      try {
        for (const [wid, rec] of ws.table("workspaces").entries()) {
          if (rec && Array.isArray(rec.sessionIds) && rec.sessionIds.some((x) => variants.includes(x))) {
            workspaceIds.push(wid);
          }
        }
      } catch { /* unit absent */ }
    }
    try {
      const state = ws.global && typeof ws.global.get === "function" ? ws.global.get() : null;
      if (state && Array.isArray(state.archivedSessionIds) && state.archivedSessionIds.some((x) => variants.includes(x))) archived.push(sessionId);
      if (state && Array.isArray(state.pinnedSessionIds) && state.pinnedSessionIds.some((x) => variants.includes(x))) pinned.push(sessionId);
    } catch { /* no global slot */ }
  }

  return {
    projRows,
    projRow: projRows.length ? projRows[0].row : null,
    workspaceIds,
    archived: archived.length > 0,
    pinned: pinned.length > 0,
  };
}

async function stripMetadata(ctx, sessionId, meta) {
  const variants = sessionIdVariants(sessionId);
  const table = projectionTable(ctx);
  if (table && typeof table.delete === "function") {
    const keys = new Set((meta.projRows || []).map((x) => x.key));
    for (const variant of variants) keys.add(variant);
    for (const key of keys) {
      try {
        if (typeof table.get !== "function" || table.get(key) !== undefined) await table.delete(key);
      } catch { /* domain closed: the manifest still has the row */ }
    }
  }

  const ws = workspaceDomain(ctx);
  if (ws && typeof ws.table === "function") {
    try {
      const workspaces = ws.table("workspaces");
      for (const [wid, rec] of workspaces.entries()) {
        if (!rec || !Array.isArray(rec.sessionIds)) continue;
        const next = rec.sessionIds.filter((x) => !variants.includes(x));
        if (next.length !== rec.sessionIds.length) await workspaces.put(wid, { ...rec, sessionIds: next });
      }
    } catch { /* unit absent */ }
  }
  if (ws && ws.global) {
    try {
      const state = ws.global.get();
      if (state && (Array.isArray(state.archivedSessionIds) || Array.isArray(state.pinnedSessionIds))) {
        const next = { ...state };
        if (Array.isArray(next.archivedSessionIds)) next.archivedSessionIds = next.archivedSessionIds.filter((x) => !variants.includes(x));
        if (Array.isArray(next.pinnedSessionIds)) next.pinnedSessionIds = next.pinnedSessionIds.filter((x) => !variants.includes(x));
        await ws.global.set(next);
      }
    } catch { /* no global slot */ }
  }
}

async function restoreMetadata(ctx, sessionId, meta) {
  const table = projectionTable(ctx);
  if (table && typeof table.put === "function") {
    for (const item of meta.projRows || []) {
      try { await table.put(item.key, item.row); } catch { /* domain closed */ }
    }
  }
  const ws = workspaceDomain(ctx);
  if (ws && typeof ws.table === "function") {
    try {
      const workspaces = ws.table("workspaces");
      for (const wid of meta.workspaceIds || []) {
        let rec = typeof workspaces.get === "function" ? workspaces.get(wid) : undefined;
        if (!rec && typeof workspaces.entries === "function") {
          for (const [key, value] of workspaces.entries()) {
            if (key === wid) { rec = value; break; }
          }
        }
        if (!rec || !Array.isArray(rec.sessionIds)) continue;
        if (!rec.sessionIds.includes(sessionId)) {
          await workspaces.put(wid, { ...rec, sessionIds: rec.sessionIds.concat([sessionId]) });
        }
      }
    } catch { /* unit absent */ }
  }
  if (ws && ws.global) {
    try {
      const state = ws.global.get();
      if (state) {
        const next = { ...state };
        if (meta.archived && Array.isArray(next.archivedSessionIds) && !next.archivedSessionIds.includes(sessionId)) {
          next.archivedSessionIds = next.archivedSessionIds.concat([sessionId]);
        }
        if (meta.pinned && Array.isArray(next.pinnedSessionIds) && !next.pinnedSessionIds.includes(sessionId)) {
          next.pinnedSessionIds = next.pinnedSessionIds.concat([sessionId]);
        }
        await ws.global.set(next);
      }
    } catch { /* no global slot */ }
  }
}

function moveDir(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    fs.renameSync(src, dst);
  } catch (err) {
    if (!err || err.code !== "EXDEV") throw err;
    fs.cpSync(src, dst, { recursive: true, errorOnExist: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

function writeManifest(dir, manifest) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, "manifest.json.tmp");
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  fs.renameSync(tmp, path.join(dir, "manifest.json"));
}

function assertTrashId(trashId) {
  if (typeof trashId !== "string" || !TRASH_ID_RE.test(trashId)) throw new OpsError("invalid trashId", 400);
}

function readManifest(trashId) {
  assertTrashId(trashId);
  const file = path.join(trashRoot(), trashId, "manifest.json");
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { throw new OpsError("trash entry not found", 404); }
  try { return JSON.parse(raw); } catch { throw new OpsError("corrupt trash manifest", 500); }
}

function agentRunning(ctx, sessionId) {
  let agents;
  try { agents = ctx && typeof ctx.get === "function" ? ctx.get("agents") : undefined; } catch { return false; }
  if (!agents || typeof agents.get !== "function") return false;
  for (const variant of sessionIdVariants(sessionId)) {
    const agent = agents.get(variant);
    if (agent && agent.status === "running") return true;
  }
  return false;
}

/**
 * Move one session into the trash. Refuses running sessions and mismatched
 * confirmation titles; the caller must pass the title shown in the UI.
 */
export async function deleteSessionToTrash(ctx, sessionId, confirmTitle) {
  if (!isSessionId(sessionId)) throw new OpsError("invalid sessionId", 400);
  const dirs = findAllSessionDirs(sessionId);
  if (dirs.length === 0) throw new OpsError("session not found", 404);
  if (dirs.length > 1) throw new OpsError(`ambiguous session id: found ${dirs.length} directories`, 409);
  if (agentRunning(ctx, sessionId)) throw new OpsError("session is running; stop it first", 409);

  const meta = readMetadata(ctx, sessionId);
  const title = titleOfRow(meta.projRow) || headerTitle(dirs[0].dir);
  const expected = title || sessionId;
  if (String(confirmTitle == null ? "" : confirmTitle).trim() !== expected) {
    throw new OpsError(`title mismatch: type "${expected}" to delete`, 400);
  }

  const now = Date.now();
  const trashId = `${now}-${randomUUID().slice(0, 8)}`;
  const root = path.join(trashRoot(), trashId);
  const rel = path.relative(sessionsRoot(), dirs[0].dir);
  const dataRel = path.join("data", rel);
  const manifest = {
    version: 1,
    trashId,
    sessionId,
    title: title || null,
    state: "moving",
    deletedAt: now,
    expiresAt: now + TRASH_RETENTION_MS,
    dirs: [{ rel, originalSlug: dirs[0].slug, originalName: dirs[0].name }],
    ...meta,
  };
  writeManifest(root, manifest);

  const source = dirs[0].dir;
  const target = path.join(root, dataRel);
  let moved = false;
  try {
    moveDir(source, target);
    moved = true;
    if (findAllSessionDirs(sessionId).length > 0) throw new OpsError("session directory still present after move", 500);
    await stripMetadata(ctx, sessionId, meta);
    manifest.state = "trashed";
    writeManifest(root, manifest);
  } catch (err) {
    let dataBack = !moved && fs.existsSync(source) && !fs.existsSync(target);
    let metadataBack = dataBack;
    if (moved) {
      try {
        moveDir(target, source);
        dataBack = true;
        await restoreMetadata(ctx, sessionId, meta);
        metadataBack = true;
      } catch { /* leave the manifest for manual restore */ }
    }
    if (dataBack && metadataBack) {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    throw err;
  }

  return {
    ok: true,
    trashId,
    sessionId,
    title: title || null,
    expiresAt: manifest.expiresAt,
    workspaceIds: meta.workspaceIds,
    archived: meta.archived,
    pinned: meta.pinned,
  };
}

export async function listTrash(ctx, { purgeExpired = false, now = Date.now() } = {}) {
  let names = [];
  try { names = fs.readdirSync(trashRoot(), { withFileTypes: true }); } catch { return []; }
  const entries = [];
  for (const name of names) {
    if (!name.isDirectory() || !TRASH_ID_RE.test(name.name)) continue;
    let manifest;
    try { manifest = readManifest(name.name); } catch { continue; }
    if (purgeExpired && typeof manifest.expiresAt === "number" && manifest.expiresAt <= now) {
      try { fs.rmSync(path.join(trashRoot(), name.name), { recursive: true, force: true }); } catch { /* retry next time */ }
      continue;
    }
    entries.push({
      trashId: name.name,
      sessionId: manifest.sessionId,
      title: manifest.title || null,
      state: manifest.state || "trashed",
      deletedAt: manifest.deletedAt || null,
      expiresAt: manifest.expiresAt || null,
      workspaceIds: Array.isArray(manifest.workspaceIds) ? manifest.workspaceIds : [],
    });
  }
  entries.sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
  return entries;
}

function restoreTarget(manifest) {
  if (!manifest || !Array.isArray(manifest.dirs) || manifest.dirs.length !== 1) {
    throw new OpsError("unsupported trash manifest", 500);
  }
  if (!isSessionId(manifest.sessionId)) {
    throw new OpsError("invalid trash manifest sessionId", 500);
  }
  const raw = manifest.dirs[0].rel;
  if (typeof raw !== "string" || raw.length === 0 || path.isAbsolute(raw)) {
    throw new OpsError("invalid trash manifest rel", 500);
  }
  const parts = raw.split(/[\\/]+/);
  if (parts.length !== 2 || parts.some((part) => !part || part === "." || part === "..")) {
    throw new OpsError("invalid trash manifest rel", 500);
  }
  if (!sessionIdVariants(manifest.sessionId).includes(parts[1])) {
    throw new OpsError("trash manifest rel does not match sessionId", 500);
  }
  const root = path.resolve(sessionsRoot());
  const target = path.join(root, ...parts);
  if (!target.startsWith(root + path.sep)) {
    throw new OpsError("trash manifest rel escapes the sessions root", 500);
  }
  return { rel: path.join(...parts), target };
}

export async function restoreTrash(ctx, trashId) {
  const manifest = readManifest(trashId);
  const { rel, target } = restoreTarget(manifest);
  if (fs.existsSync(target)) throw new OpsError("session directory already exists; refusing to overwrite", 409);

  const root = path.join(trashRoot(), trashId);
  const source = path.join(root, "data", rel);
  let sourceStat;
  try { sourceStat = fs.lstatSync(source); } catch { throw new OpsError("trash payload missing", 404); }
  if (!sourceStat.isDirectory()) throw new OpsError("trash payload is not a directory", 500);

  try {
    moveDir(source, target);
    if (!fs.existsSync(target)) throw new OpsError("restore move failed", 500);
    await restoreMetadata(ctx, manifest.sessionId, manifest);
  } catch (err) {
    try {
      if (fs.existsSync(target) && !fs.existsSync(source)) moveDir(target, source);
    } catch { /* leave both for manual recovery */ }
    throw err;
  }

  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* manifest cleanup is best effort */ }
  return { ok: true, trashId, sessionId: manifest.sessionId, title: manifest.title || null };
}

export async function purgeTrash(ctx, trashId) {
  assertTrashId(trashId);
  const root = path.join(trashRoot(), trashId);
  if (!fs.existsSync(root)) throw new OpsError("trash entry not found", 404);
  fs.rmSync(root, { recursive: true, force: true });
  return { ok: true, trashId };
}

export const _internals = { findAllSessionDirs, readMetadata, stripMetadata, restoreMetadata };
