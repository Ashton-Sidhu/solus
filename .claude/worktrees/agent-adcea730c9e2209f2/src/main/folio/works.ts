import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { createLogger } from '../logger'
import { getDb, withTx } from '../db'
import { workPreview } from '../../shared/work-preview'
import { git } from '../git/exec'
import type { AgentId, Work, WorkMeta, WorksManifest, WorkPrevious, WorkStorage } from '../../shared/types'

export type { Work, WorkMeta, WorksManifest, WorkPrevious }

const log = createLogger('folio', 'works.ts')
const LOCAL_ROOT = join(homedir(), '.solus', 'works')
const MANIFEST_FILE = 'works-manifest.json'
const PROJECT_WORKS_DIR = join('.solus', 'works')

type WorkLocator = {
  root: string
  storage: WorkStorage
}

type FoundWork = {
  locator: WorkLocator
  manifest?: WorksManifest
  meta: WorkMeta
}

interface WorkRow {
  id: string
  storage: string
  title: string | null
  preview: string | null
  type: string | null
  session_id: string | null
  agent_provider: string | null
  cwd: string | null
  pinned: number | null
  content: string | null
  created_at: number
  updated_at: number
  meta: string | null
}

interface RevisionRow {
  content: string | null
  updated_at: number
}

function epochMs(value: string): number {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid work timestamp: ${value}`)
  return timestamp
}

function isoTime(value: number): string {
  return new Date(value).toISOString()
}

function localMetaJson(meta: WorkMeta): string {
  const {
    title: _title,
    preview: _preview,
    type: _type,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    sessionId: _sessionId,
    agentProvider: _agentProvider,
    cwd: _cwd,
    storage: _storage,
    pinned: _pinned,
    ...extra
  } = meta
  return JSON.stringify(extra)
}

function metaFromRow(row: WorkRow): WorkMeta {
  const extra = row.meta ? JSON.parse(row.meta) as Partial<WorkMeta> : {}
  return {
    ...extra,
    title: row.title ?? '',
    preview: row.preview ?? '',
    type: row.type as WorkMeta['type'],
    createdAt: isoTime(row.created_at),
    updatedAt: isoTime(row.updated_at),
    sessionId: row.session_id ?? undefined,
    agentProvider: row.agent_provider as AgentId,
    cwd: row.cwd ?? '~',
    storage: { kind: 'local' },
    pinned: row.pinned === null ? undefined : row.pinned === 1,
  }
}

function localWorkRow(id: string): WorkRow | undefined {
  return database().prepare("SELECT * FROM works WHERE id = ? AND storage = 'local'").get(id) as WorkRow | undefined
}

function insertLocalWork(db: DatabaseSync, id: string, meta: WorkMeta, content: string): void {
  db.prepare(`
    INSERT INTO works (
      id, storage, title, preview, type, session_id, agent_provider, cwd,
      pinned, content, created_at, updated_at, meta
    ) VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      storage = excluded.storage,
      title = excluded.title,
      preview = excluded.preview,
      type = excluded.type,
      session_id = excluded.session_id,
      agent_provider = excluded.agent_provider,
      cwd = excluded.cwd,
      pinned = excluded.pinned,
      content = excluded.content,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      meta = excluded.meta
  `).run(
    id,
    meta.title,
    meta.preview,
    meta.type,
    meta.sessionId ?? null,
    meta.agentProvider,
    meta.cwd,
    meta.pinned === undefined ? null : meta.pinned ? 1 : 0,
    content,
    epochMs(meta.createdAt),
    epochMs(meta.updatedAt),
    localMetaJson(meta),
  )
}

function updateLocalWork(db: DatabaseSync, id: string, meta: WorkMeta, content?: string): void {
  db.prepare(`
    UPDATE works SET
      title = ?,
      preview = ?,
      type = ?,
      session_id = ?,
      agent_provider = ?,
      cwd = ?,
      pinned = ?,
      updated_at = ?,
      meta = ?
    WHERE id = ? AND storage = 'local'
  `).run(
    meta.title,
    meta.preview,
    meta.type,
    meta.sessionId ?? null,
    meta.agentProvider,
    meta.cwd,
    meta.pinned === undefined ? null : meta.pinned ? 1 : 0,
    epochMs(meta.updatedAt),
    localMetaJson(meta),
    id,
  )
  if (content !== undefined) {
    db.prepare("UPDATE works SET content = ? WHERE id = ? AND storage = 'local'").run(content, id)
  }
}

function latestRevision(db: DatabaseSync, id: string): RevisionRow | undefined {
  return db.prepare(`
    SELECT content, updated_at
    FROM work_revisions
    WHERE work_id = ?
    ORDER BY rev DESC
    LIMIT 1
  `).get(id) as RevisionRow | undefined
}

function insertRevision(db: DatabaseSync, id: string, content: string, updatedAt: string): void {
  db.prepare(`
    INSERT INTO work_revisions (work_id, rev, content, updated_at)
    VALUES (?, COALESCE((SELECT MAX(rev) + 1 FROM work_revisions WHERE work_id = ?), 1), ?, ?)
  `).run(id, id, content, epochMs(updatedAt))
}

function database(): DatabaseSync {
  return getDb()
}

async function ensureDir(root: string): Promise<void> {
  if (!existsSync(root)) {
    await mkdir(root, { recursive: true })
  }
}

function manifestPath(root: string): string {
  return join(root, MANIFEST_FILE)
}

async function readManifest(root: string): Promise<WorksManifest> {
  const path = manifestPath(root)
  if (!existsSync(path)) {
    return { version: 1, works: {} }
  }
  const text = await readFile(path, 'utf8')
  return JSON.parse(text) as WorksManifest
}

async function writeManifest(root: string, manifest: WorksManifest): Promise<void> {
  await ensureDir(root)
  await writeFile(manifestPath(root), JSON.stringify(manifest, null, 2), 'utf8')
}

function contentPath(root: string, id: string): string {
  return join(root, `${id}.json`)
}

function prevPath(root: string, id: string): string {
  return join(root, `${id}.prev.json`)
}

function localLocator(): WorkLocator {
  return { root: LOCAL_ROOT, storage: { kind: 'local' } }
}

function projectLocator(projectRoot: string): WorkLocator {
  const root = join(projectRoot, PROJECT_WORKS_DIR)
  return {
    root,
    storage: { kind: 'project', projectRoot, relativePath: PROJECT_WORKS_DIR },
  }
}

function normalizeStorage(meta: WorkMeta, locator: WorkLocator): WorkMeta {
  return { ...meta, storage: locator.storage.kind === 'project' ? locator.storage : (meta.storage ?? locator.storage) }
}

function manifestMeta(meta: WorkMeta, locator: WorkLocator): WorkMeta {
  if (locator.storage.kind !== 'project') return meta
  return {
    ...meta,
    storage: { kind: 'project', relativePath: PROJECT_WORKS_DIR },
  }
}

function projectRootForCwd(cwd?: string): string | null {
  if (!cwd || cwd === '~') return null
  try {
    return git(['rev-parse', '--show-toplevel'], cwd, { timeout: 5_000 })
  } catch {
    return isAbsolute(cwd) ? cwd : null
  }
}

function assertInsideProject(projectRoot: string, target: string): void {
  const rel = relative(resolve(projectRoot), resolve(target))
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path escapes project root: ${target}`)
  }
}

async function findWork(id: string, cwd?: string): Promise<FoundWork | null> {
  const localRow = localWorkRow(id)
  if (localRow) return { locator: localLocator(), meta: metaFromRow(localRow) }

  const projectRoot = projectRootForCwd(cwd)
  if (!projectRoot) return null
  const project = projectLocator(projectRoot)
  const projectManifest = await readManifest(project.root)
  const projectMeta = projectManifest.works[id]
  if (!projectMeta) return null
  return { locator: project, manifest: projectManifest, meta: normalizeStorage(projectMeta, project) }
}

/** Snapshot the current project content as the single "previous version" before
 * an agent-driven overwrite. Best-effort — never blocks the save. */
async function snapshotPreviousProjectContent(id: string, found: FoundWork): Promise<void> {
  try {
    const raw = await readFile(contentPath(found.locator.root, id), 'utf8')
    const { content } = JSON.parse(raw) as { content: string }
    const prev: WorkPrevious = { content, updatedAt: found.meta.updatedAt }
    await writeFile(prevPath(found.locator.root, id), JSON.stringify(prev), 'utf8')
  } catch (err: any) {
    log.warn(`snapshotPreviousContent(${id}) failed: ${String(err)}`)
  }
}

/** Save driven by the agent — snapshots the prior content first so the user can
 * review "what the agent changed". User-initiated saves go through saveWork and
 * stay snapshot-free. */
export async function agentSaveWork(
  id: string,
  updates: Partial<Pick<Work, 'title' | 'preview' | 'content'>>,
  cwd?: string
): Promise<Work> {
  const found = await findWork(id, cwd)
  if (!found) throw new Error(`Work not found: ${id}`)

  if (found.locator.storage.kind === 'local') {
    return withTx(() => {
      const db = database()
      const row = db.prepare("SELECT * FROM works WHERE id = ? AND storage = 'local'").get(id) as unknown as WorkRow | undefined
      if (!row) throw new Error(`Work not found: ${id}`)
      const meta = metaFromRow(row)
      if (updates.content !== undefined) insertRevision(db, id, row.content ?? '', meta.updatedAt)
      return saveLocalWork(db, id, meta, row.content ?? '', updates)
    })
  }

  if (updates.content !== undefined) await snapshotPreviousProjectContent(id, found)
  return saveProjectWork(id, found, updates)
}

/** Restore the single previous snapshot as the current content. The swap is
 * re-invertable: the content being replaced becomes the new snapshot, so a
 * second revert undoes the first. Returns null when there is nothing to revert
 * to. */
export async function revertWork(id: string, cwd?: string): Promise<Work | null> {
  const found = await findWork(id, cwd)
  if (!found) return null

  if (found.locator.storage.kind === 'local') {
    return withTx(() => {
      const db = database()
      const row = db.prepare("SELECT * FROM works WHERE id = ? AND storage = 'local'").get(id) as unknown as WorkRow | undefined
      if (!row) return null
      const meta = metaFromRow(row)
      const previous = latestRevision(db, id)
      if (!previous) return null

      db.prepare(`
        UPDATE work_revisions
        SET content = ?, updated_at = ?
        WHERE work_id = ? AND rev = (SELECT MAX(rev) FROM work_revisions WHERE work_id = ?)
      `).run(row.content ?? '', epochMs(meta.updatedAt), id, id)

      const preview = workPreview(meta.type, previous.content ?? '')
      return saveLocalWork(db, id, meta, row.content ?? '', { content: previous.content ?? '', preview })
    })
  }

  const current = await loadWork(id, cwd)
  const prev = await loadWorkPrevious(id, cwd)
  if (!current || !prev) return null
  const nextPrev: WorkPrevious = { content: current.content, updatedAt: current.updatedAt }
  await writeFile(prevPath(found.locator.root, id), JSON.stringify(nextPrev), 'utf8')
  const preview = workPreview(current.type, prev.content)
  return saveProjectWork(id, found, { content: prev.content, preview })
}

export async function loadWorkPrevious(id: string, cwd?: string): Promise<WorkPrevious | null> {
  try {
    const found = await findWork(id, cwd)
    if (!found) return null
    if (found.locator.storage.kind === 'local') {
      const previous = latestRevision(database(), id)
      return previous ? { content: previous.content ?? '', updatedAt: isoTime(previous.updated_at) } : null
    }

    const file = prevPath(found.locator.root, id)
    if (!existsSync(file)) return null
    return JSON.parse(await readFile(file, 'utf8')) as WorkPrevious
  } catch {
    return null
  }
}

export async function createWork(
  title: string,
  type: 'doc' | 'slides' | 'diagram',
  content: string = '',
  preview: string = '',
  sessionId: string | undefined,
  agentProvider: AgentId,
  cwd: string = '~',
  id: string = randomUUID()
): Promise<Work> {
  const now = new Date().toISOString()
  const meta: WorkMeta = {
    title,
    preview,
    type,
    createdAt: now,
    updatedAt: now,
    sessionId,
    sessionIds: sessionId ? [sessionId] : [],
    agentProvider,
    cwd,
    storage: { kind: 'local' },
  }

  insertLocalWork(database(), id, meta, content)
  return { id, content, ...meta }
}

export async function duplicateWork(id: string, cwd?: string): Promise<Work> {
  const found = await findWork(id, cwd)
  if (!found) throw new Error(`Work not found: ${id}`)

  let content: string
  if (found.locator.storage.kind === 'local') {
    content = localWorkRow(id)?.content ?? ''
  } else {
    const raw = await readFile(contentPath(found.locator.root, id), 'utf8')
    content = (JSON.parse(raw) as { content: string }).content
  }

  const duplicateId = randomUUID()
  const now = new Date().toISOString()
  const meta: WorkMeta = {
    ...found.meta,
    title: `${found.meta.title} copy`,
    createdAt: now,
    updatedAt: now,
    sessionId: undefined,
    sessionIds: [],
    pinned: undefined,
  }

  if (found.locator.storage.kind === 'local') {
    insertLocalWork(database(), duplicateId, meta, content)
  } else {
    const manifest = found.manifest!
    manifest.works[duplicateId] = manifestMeta(meta, found.locator)
    await writeManifest(found.locator.root, manifest)
    await writeFile(contentPath(found.locator.root, duplicateId), JSON.stringify({ content }), 'utf8')
  }

  return { id: duplicateId, content, ...meta }
}

function saveLocalWork(
  db: DatabaseSync,
  id: string,
  originalMeta: WorkMeta,
  originalContent: string,
  updates: Partial<Pick<Work, 'title' | 'preview' | 'content'>>,
): Work {
  const meta = { ...originalMeta, updatedAt: new Date().toISOString() }
  if (updates.title !== undefined) meta.title = updates.title
  if (updates.preview !== undefined) meta.preview = updates.preview
  updateLocalWork(db, id, meta, updates.content)
  return { id, content: updates.content ?? originalContent, ...meta }
}

async function saveProjectWork(
  id: string,
  found: FoundWork,
  updates: Partial<Pick<Work, 'title' | 'preview' | 'content'>>,
): Promise<Work> {
  const meta = found.meta
  if (updates.title !== undefined) meta.title = updates.title
  if (updates.preview !== undefined) meta.preview = updates.preview
  meta.updatedAt = new Date().toISOString()

  const manifest = found.manifest!
  manifest.works[id] = manifestMeta(meta, found.locator)
  await writeManifest(found.locator.root, manifest)

  let content: string
  if (updates.content !== undefined) {
    await writeFile(contentPath(found.locator.root, id), JSON.stringify({ content: updates.content }), 'utf8')
    content = updates.content
  } else {
    const raw = await readFile(contentPath(found.locator.root, id), 'utf8')
    content = (JSON.parse(raw) as { content: string }).content
  }
  return { id, content, ...meta }
}

export async function saveWork(
  id: string,
  updates: Partial<Pick<Work, 'title' | 'preview' | 'content'>>,
  cwd?: string
): Promise<Work> {
  const found = await findWork(id, cwd)
  if (!found) throw new Error(`Work not found: ${id}`)
  if (found.locator.storage.kind === 'local') {
    return withTx(() => {
      const db = database()
      const row = db.prepare("SELECT * FROM works WHERE id = ? AND storage = 'local'").get(id) as unknown as WorkRow | undefined
      if (!row) throw new Error(`Work not found: ${id}`)
      return saveLocalWork(db, id, metaFromRow(row), row.content ?? '', updates)
    })
  }
  return saveProjectWork(id, found, updates)
}

export async function loadWork(id: string, cwd?: string): Promise<Work | null> {
  try {
    const found = await findWork(id, cwd)
    if (!found) return null
    if (found.locator.storage.kind === 'local') {
      const row = localWorkRow(id)!
      return { id, content: row.content ?? '', ...found.meta }
    }

    const raw = await readFile(contentPath(found.locator.root, id), 'utf8')
    const { content } = JSON.parse(raw) as { content: string }
    return { id, content, ...found.meta }
  } catch (err: any) {
    log.error(`Error loading work ${id}: ${String(err)}`)
    return null
  }
}

export async function listWorks(cwd?: string): Promise<(WorkMeta & { id: string })[]> {
  try {
    const rows = database().prepare("SELECT * FROM works WHERE storage = 'local'").all() as unknown as WorkRow[]
    const entries: (WorkMeta & { id: string })[] = rows.map((row) => ({ id: row.id, ...metaFromRow(row) }))

    const projectRoot = projectRootForCwd(cwd)
    if (projectRoot) {
      const project = projectLocator(projectRoot)
      const projectManifest = await readManifest(project.root)
      entries.push(...Object.entries(projectManifest.works).map(([id, meta]) => ({ id, ...normalizeStorage(meta, project) })))
    }

    return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  } catch (err: any) {
    log.error(`Error listing works: ${String(err)}`)
    return []
  }
}

export async function setWorkPinned(id: string, pinned: boolean, cwd?: string): Promise<void> {
  const found = await findWork(id, cwd)
  if (!found) return

  if (found.locator.storage.kind === 'local') {
    withTx(() => {
      const db = database()
      const row = db.prepare("SELECT * FROM works WHERE id = ? AND storage = 'local'").get(id) as unknown as WorkRow | undefined
      if (!row) return
      const meta = metaFromRow(row)
      if (pinned) meta.pinned = true
      else delete meta.pinned
      updateLocalWork(db, id, meta)
    })
  } else {
    if (pinned) found.meta.pinned = true
    else delete found.meta.pinned
    const manifest = found.manifest!
    manifest.works[id] = manifestMeta(found.meta, found.locator)
    await writeManifest(found.locator.root, manifest)
  }
}

export async function linkWorkSession(id: string, sessionId: string, cwd?: string): Promise<void> {
  const found = await findWork(id, cwd)
  if (!found) return

  if (found.locator.storage.kind === 'local') {
    withTx(() => {
      const db = database()
      const row = db.prepare("SELECT * FROM works WHERE id = ? AND storage = 'local'").get(id) as unknown as WorkRow | undefined
      if (!row) return
      const meta = metaFromRow(row)
      const localSessionIds = meta.sessionIds ?? (meta.sessionId ? [meta.sessionId] : [])
      if (!localSessionIds.includes(sessionId)) localSessionIds.push(sessionId)
      meta.sessionIds = localSessionIds
      if (!meta.sessionId) meta.sessionId = sessionId
      updateLocalWork(db, id, meta)
    })
  } else {
    const sessionIds = found.meta.sessionIds ?? (found.meta.sessionId ? [found.meta.sessionId] : [])
    if (!sessionIds.includes(sessionId)) sessionIds.push(sessionId)
    found.meta.sessionIds = sessionIds
    if (!found.meta.sessionId) found.meta.sessionId = sessionId
    const manifest = found.manifest!
    manifest.works[id] = manifestMeta(found.meta, found.locator)
    await writeManifest(found.locator.root, manifest)
  }
}

/** Permanently remove a work and its previous revisions. */
export async function deleteWork(id: string, cwd?: string): Promise<void> {
  const found = await findWork(id, cwd)
  if (!found) throw new Error(`Work not found: ${id}`)

  if (found.locator.storage.kind === 'local') {
    withTx(() => {
      const db = database()
      db.prepare('DELETE FROM work_annotations WHERE work_id = ?').run(id)
      db.prepare("DELETE FROM works WHERE id = ? AND storage = 'local'").run(id)
    })
    return
  }

  const manifest = found.manifest!
  delete manifest.works[id]
  await writeManifest(found.locator.root, manifest)
  await rmWorkFiles(found.locator.root, id)
  database().prepare('DELETE FROM work_annotations WHERE work_id = ?').run(id)
}

export async function promoteWorkToProject(id: string, projectRoot: string): Promise<Work> {
  const resolvedRoot = resolve(projectRoot)
  const project = projectLocator(resolvedRoot)
  assertInsideProject(resolvedRoot, project.root)

  const localRow = localWorkRow(id)
  if (!localRow) {
    const existing = await loadWork(id, resolvedRoot)
    if (existing?.storage?.kind === 'project') return existing
    throw new Error(`Work not found: ${id}`)
  }

  const content = localRow.content ?? ''
  const now = new Date().toISOString()
  const meta: WorkMeta = {
    ...metaFromRow(localRow),
    updatedAt: now,
    storage: project.storage,
  }

  const projectManifest = await readManifest(project.root)
  projectManifest.works[id] = manifestMeta(meta, project)
  await writeManifest(project.root, projectManifest)
  await writeFile(contentPath(project.root, id), JSON.stringify({ content }), 'utf8')

  const previous = latestRevision(database(), id)
  if (previous) {
    const value: WorkPrevious = { content: previous.content ?? '', updatedAt: isoTime(previous.updated_at) }
    await writeFile(prevPath(project.root, id), JSON.stringify(value), 'utf8')
  }

  withTx(() => {
    const db = database()
    db.prepare("DELETE FROM works WHERE id = ? AND storage = 'local'").run(id)
  })

  return { id, content, ...meta }
}

async function rmWorkFiles(root: string, id: string): Promise<void> {
  const path = contentPath(root, id)
  if (existsSync(path)) {
    await rm(path)
  }
  const prev = prevPath(root, id)
  if (existsSync(prev)) {
    await rm(prev)
  }
}
