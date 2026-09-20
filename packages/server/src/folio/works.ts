import type { WorkTransfer } from '@solus/contracts/work-transfer'
import { loadWorkAnnotations } from './work-annotations'
import { createHash, randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { createLogger } from '../logger'
import { getDatabase, type Db } from '../db/database'
import { workPreview } from '@solus/contracts/work-preview'
import type { AgentId, Work, WorkMeta, WorkPrevious, WorkType } from '@solus/contracts/types'
import type { WorkExternalLink } from '@solus/contracts/docs'
import { documentContentHash } from '../docs/content-hash'
import { workExternalLinkSchema } from '../docs/schema'
import { workAnnotations, workRevisions, works } from './schema'

export type { Work, WorkMeta, WorkPrevious }

/**
 * Works: documents, slide decks, diagrams, and artifacts
 * (docs/plans/cloud-service-model.md). Every work is a row of `works`; its one
 * previous version is the newest row of `work_revisions`. Every read and write
 * names the organization it is scoped to, and a work of another organization
 * is simply not found.
 */

const log = createLogger('folio', 'works.ts')

const agentProviderSchema = z.enum(['claude-code', 'codex', 'opencode'])
const workTypeSchema = z.enum(['doc', 'slides', 'diagram', 'artifact'])
const workExtraSchema = z.object({
  sessionIds: z.array(z.string()).optional(),
  mirroredDoc: workExternalLinkSchema.optional(),
})
const workRowSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  preview: z.string().nullable(),
  type: workTypeSchema.nullable(),
  session_id: z.string().nullable(),
  agent_provider: agentProviderSchema.nullable(),
  cwd: z.string().nullable(),
  pinned: z.number().nullable(),
  content: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  meta: z.string().nullable(),
})
const revisionRowSchema = z.object({
  content: z.string().nullable(),
  updated_at: z.number(),
})

type WorkRow = z.infer<typeof workRowSchema>
type RevisionRow = z.infer<typeof revisionRowSchema>

function epochMs(value: string): number {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid work timestamp: ${value}`)
  return timestamp
}

function isoTime(value: number): string {
  return new Date(value).toISOString()
}

/** The fields that ride the `meta` JSON column: everything without a column of its own. */
function metaJson(meta: WorkMeta): string {
  const {
    title: _title,
    preview: _preview,
    type: _type,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    sessionId: _sessionId,
    agentProvider: _agentProvider,
    cwd: _cwd,
    pinned: _pinned,
    ...extra
  } = meta
  return JSON.stringify(extra)
}

function metaFromRow(row: WorkRow): WorkMeta {
  const extra = row.meta ? workExtraSchema.parse(JSON.parse(row.meta)) : {}
  return {
    ...extra,
    title: row.title ?? '',
    preview: row.preview ?? '',
    type: row.type ?? 'doc',
    createdAt: isoTime(row.created_at),
    updatedAt: isoTime(row.updated_at),
    sessionId: row.session_id ?? undefined,
    agentProvider: row.agent_provider ?? 'claude-code',
    cwd: row.cwd ?? '~',
    pinned: row.pinned === null ? undefined : row.pinned === 1,
  }
}

const database = getDatabase

async function workRow(db: Db, organizationId: string, id: string): Promise<WorkRow | undefined> {
  return workRowSchema.nullish().parse(await db.get(sql`
    SELECT id, title, preview, type, session_id, agent_provider, cwd, pinned, content, created_at, updated_at, meta
    FROM ${works}
    WHERE id = ${id} AND organization_id = ${organizationId}
  `)) ?? undefined
}

async function requireWorkRow(db: Db, organizationId: string, id: string): Promise<WorkRow> {
  const row = await workRow(db, organizationId, id)
  if (!row) throw new Error(`Work not found: ${id}`)
  return row
}

async function insertWork(db: Db, organizationId: string, id: string, meta: WorkMeta, content: string): Promise<void> {
  // `storage` is a legacy column with no default on a hand-made table; every row is `'local'`.
  await db.run(sql`
    INSERT INTO ${works} (
      id, storage, title, preview, type, session_id, agent_provider, cwd,
      pinned, content, created_at, updated_at, meta, organization_id
    ) VALUES (
      ${id}, 'local', ${meta.title}, ${meta.preview}, ${meta.type}, ${meta.sessionId ?? null},
      ${meta.agentProvider}, ${meta.cwd}, ${meta.pinned === undefined ? null : meta.pinned ? 1 : 0},
      ${content}, ${epochMs(meta.createdAt)}, ${epochMs(meta.updatedAt)}, ${metaJson(meta)}, ${organizationId}
    )
  `)
}

async function updateWorkMeta(db: Db, id: string, meta: WorkMeta, content?: string): Promise<void> {
  await db.run(sql`
    UPDATE ${works} SET
      title = ${meta.title},
      preview = ${meta.preview},
      type = ${meta.type},
      session_id = ${meta.sessionId ?? null},
      agent_provider = ${meta.agentProvider},
      cwd = ${meta.cwd},
      pinned = ${meta.pinned === undefined ? null : meta.pinned ? 1 : 0},
      updated_at = ${epochMs(meta.updatedAt)},
      meta = ${metaJson(meta)}
    WHERE id = ${id}
  `)
  if (content !== undefined) {
    await db.run(sql`UPDATE ${works} SET content = ${content} WHERE id = ${id}`)
  }
}

async function latestRevision(db: Db, id: string): Promise<RevisionRow | undefined> {
  return revisionRowSchema.nullish().parse(await db.get(sql`
    SELECT content, updated_at
    FROM ${workRevisions}
    WHERE work_id = ${id}
    ORDER BY rev DESC
    LIMIT 1
  `)) ?? undefined
}

async function insertRevision(db: Db, organizationId: string, id: string, content: string, updatedAt: string): Promise<void> {
  await db.run(sql`
    INSERT INTO ${workRevisions} (work_id, rev, content, updated_at, organization_id)
    VALUES (
      ${id},
      COALESCE((SELECT MAX(rev) + 1 FROM ${workRevisions} WHERE work_id = ${id}), 1),
      ${content}, ${epochMs(updatedAt)}, ${organizationId}
    )
  `)
}

export const GOOGLE_WORK_READ_ONLY = 'This work is linked to Google Docs and is read-only in Solus. Edit it in Google Docs, then Pull latest. Comments remain available.'

export function assertWorkEditable(meta: WorkMeta): void {
  if (meta.mirroredDoc?.provider === 'gdrive') throw new Error(GOOGLE_WORK_READ_ONLY)
}

type WorkUpdates = Partial<Pick<Work, 'title' | 'preview' | 'content'>>

async function writeWork(db: Db, id: string, row: WorkRow, updates: WorkUpdates): Promise<Work> {
  const meta = { ...metaFromRow(row), updatedAt: new Date().toISOString() }
  if (updates.title !== undefined) meta.title = updates.title
  if (updates.preview !== undefined) meta.preview = updates.preview
  await updateWorkMeta(db, id, meta, updates.content)
  return { id, content: updates.content ?? row.content ?? '', ...meta }
}

/** Provider reads are the only body writes allowed for a Google-linked work. */
export async function savePulledWork(organizationId: string, id: string, updates: Pick<Work, 'title' | 'preview' | 'content'>): Promise<Work> {
  return agentSaveWork(organizationId, id, updates, true)
}

/** Save driven by the agent — snapshots the prior content first so the user can
 * review "what the agent changed". User-initiated saves go through saveWork and
 * stay snapshot-free. `upstreamRead` is the provider pull, which may write a
 * Google-linked work nobody else may. */
export async function agentSaveWork(
  organizationId: string,
  id: string,
  updates: WorkUpdates,
  upstreamRead = false,
): Promise<Work> {
  return database().transaction(async (db) => {
    const row = await requireWorkRow(db, organizationId, id)
    const meta = metaFromRow(row)
    if (!upstreamRead) assertWorkEditable(meta)
    if (updates.content !== undefined) await insertRevision(db, organizationId, id, row.content ?? '', meta.updatedAt)
    return writeWork(db, id, row, updates)
  })
}


/** Restore the single previous snapshot as the current content. The swap is
 * re-invertable: the content being replaced becomes the new snapshot, so a
 * second revert undoes the first. Returns null when there is nothing to revert
 * to. */
export async function revertWork(organizationId: string, id: string): Promise<Work | null> {
  return database().transaction(async (db) => {
    const row = await workRow(db, organizationId, id)
    if (!row) return null
    const meta = metaFromRow(row)
    assertWorkEditable(meta)
    const previous = await latestRevision(db, id)
    if (!previous) return null

    await db.run(sql`
      UPDATE ${workRevisions}
      SET content = ${row.content ?? ''}, updated_at = ${epochMs(meta.updatedAt)}
      WHERE work_id = ${id} AND rev = (SELECT MAX(rev) FROM ${workRevisions} WHERE work_id = ${id})
    `)

    const preview = workPreview(meta.type, previous.content ?? '')
    return writeWork(db, id, row, { content: previous.content ?? '', preview })
  })
}

export async function loadWorkPrevious(organizationId: string, id: string): Promise<WorkPrevious | null> {
  try {
    const db = database()
    if (!await workRow(db, organizationId, id)) return null
    const previous = await latestRevision(db, id)
    return previous ? { content: previous.content ?? '', updatedAt: isoTime(previous.updated_at) } : null
  } catch {
    return null
  }
}

export async function createWork(
  organizationId: string,
  title: string,
  type: WorkType,
  content: string = '',
  preview: string = '',
  sessionId: string | undefined,
  agentProvider: AgentId,
  cwd: string = '~',
  id: string = randomUUID(),
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
  }

  await insertWork(database(), organizationId, id, meta, content)
  return { id, content, ...meta }
}

export async function duplicateWork(organizationId: string, id: string): Promise<Work> {
  const db = database()
  const row = await requireWorkRow(db, organizationId, id)
  const content = row.content ?? ''
  const duplicateId = randomUUID()
  const now = new Date().toISOString()
  const meta: WorkMeta = {
    ...metaFromRow(row),
    title: `${row.title ?? ''} copy`,
    createdAt: now,
    updatedAt: now,
    sessionId: undefined,
    sessionIds: [],
    pinned: undefined,
    // A copy must never inherit the link: two works publishing to one upstream
    // doc would overwrite each other with no way to tell which won.
    mirroredDoc: undefined,
  }
  await insertWork(db, organizationId, duplicateId, meta, content)
  return { id: duplicateId, content, ...meta }
}

export async function saveWork(organizationId: string, id: string, updates: WorkUpdates): Promise<Work> {
  return database().transaction(async (db) => {
    const row = await requireWorkRow(db, organizationId, id)
    assertWorkEditable(metaFromRow(row))
    return writeWork(db, id, row, updates)
  })
}

/**
 * `dirty` cannot be stored, only derived: a work's content changes without the
 * link being touched. Every state the provider owns — conflict, error, upstream
 * change — is stored and left alone here.
 */
function withDerivedSyncState(meta: WorkMeta, content: string): WorkMeta {
  const link = meta.mirroredDoc
  if (!link || link.syncState !== 'ok' && link.syncState !== 'dirty') return meta
  const dirty = link.lastPushedContentHash !== documentContentHash(content)
  if ((link.syncState === 'dirty') === dirty) return meta
  return { ...meta, mirroredDoc: { ...link, syncState: dirty ? 'dirty' : 'ok' } }
}

export async function loadWork(organizationId: string, id: string): Promise<Work | null> {
  try {
    const row = await workRow(database(), organizationId, id)
    if (!row) return null
    const content = row.content ?? ''
    return { id, content, ...withDerivedSyncState(metaFromRow(row), content) }
  } catch (err: any) {
    log.error('work_load_failed', { workId: id, error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

export async function listWorks(organizationId: string): Promise<(WorkMeta & { id: string })[]> {
  try {
    const rows = workRowSchema.array().parse(await database().all(sql`
      SELECT id, title, preview, type, session_id, agent_provider, cwd, pinned, content, created_at, updated_at, meta
      FROM ${works}
      WHERE organization_id = ${organizationId}
      ORDER BY updated_at DESC, id
    `))
    return rows.map((row) => ({
      id: row.id,
      ...withDerivedSyncState(metaFromRow(row), row.content ?? ''),
    }))
  } catch (err: any) {
    log.error('works_list_failed', { error: err instanceof Error ? err.message : String(err) })
    return []
  }
}

export async function setWorkPinned(organizationId: string, id: string, pinned: boolean): Promise<void> {
  await database().transaction(async (db) => {
    const row = await workRow(db, organizationId, id)
    if (!row) return
    const meta = metaFromRow(row)
    if (pinned) meta.pinned = true
    else delete meta.pinned
    await updateWorkMeta(db, id, meta)
  })
}

/**
 * Attach, update, or drop the upstream doc link. Passing null unlinks, which
 * never touches the upstream doc — the page keeps existing, Solus just stops
 * tracking it.
 *
 * Writes only the link, so it cannot bump `updatedAt` and make a work look
 * locally edited when all that happened was a publish.
 */
export async function setWorkMirroredDoc(organizationId: string, id: string, link: WorkExternalLink | null): Promise<void> {
  await database().transaction(async (db) => {
    const row = await requireWorkRow(db, organizationId, id)
    const meta = metaFromRow(row)
    if (link) meta.mirroredDoc = link
    else delete meta.mirroredDoc
    await db.run(sql`UPDATE ${works} SET meta = ${metaJson(meta)} WHERE id = ${id}`)
  })
}

export async function linkWorkSession(organizationId: string, id: string, sessionId: string): Promise<void> {
  await database().transaction(async (db) => {
    const row = await workRow(db, organizationId, id)
    if (!row) return
    const meta = metaFromRow(row)
    const sessionIds = meta.sessionIds ?? (meta.sessionId ? [meta.sessionId] : [])
    if (!sessionIds.includes(sessionId)) sessionIds.push(sessionId)
    meta.sessionIds = sessionIds
    if (!meta.sessionId) meta.sessionId = sessionId
    await updateWorkMeta(db, id, meta)
  })
}

/** Permanently remove a work, its previous revisions, and its annotations. */
export async function deleteWork(organizationId: string, id: string): Promise<void> {
  await database().transaction(async (db) => {
    await requireWorkRow(db, organizationId, id)
    await db.run(sql`DELETE FROM ${workAnnotations} WHERE work_id = ${id}`)
    await db.run(sql`DELETE FROM ${works} WHERE id = ${id}`)
  })
}

/** The file a work exports as: the content is already in that form. */
export function workExportExtension(type: WorkType): 'md' | 'json' | 'html' {
  switch (type) {
    case 'doc':
      return 'md'
    case 'artifact':
      return 'html'
    case 'diagram':
    case 'slides':
      return 'json'
  }
}

/** Capture all state shown in a work, in the same database transaction. */
export async function exportWorkForCloud(organizationId: string, id: string): Promise<WorkTransfer> {
  return database().transaction(async (db) => {
    const row = await requireWorkRow(db, organizationId, id)
    const snapshot = {
      work: { id, content: row.content ?? '', ...metaFromRow(row) },
      annotations: await loadWorkAnnotations(organizationId, id),
      previous: await loadWorkPrevious(organizationId, id),
    }
    return { ...snapshot, fingerprint: transferFingerprint(snapshot) }
  })
}

function transferFingerprint(snapshot: Omit<WorkTransfer, 'fingerprint'>): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
}

/** An import is atomic. An existing different work is never overwritten. */
export async function importWorkFromHost(organizationId: string, transfer: WorkTransfer): Promise<Work> {
  const { work, annotations, previous, fingerprint } = transfer
  if (fingerprint !== transferFingerprint({ work, annotations, previous })) throw new Error('The work snapshot is incomplete.')
  if (annotations && annotations.workId !== work.id) throw new Error('The comments belong to another work.')
  return database().transaction(async (db) => {
    const existing = await workRow(db, organizationId, work.id)
    if (existing) {
      if ((await exportWorkForCloud(organizationId, work.id)).fingerprint !== fingerprint) throw new Error('The cloud already has a different version. Open it before sharing.')
      return work
    }
    await insertWork(db, organizationId, work.id, work, work.content)
    if (annotations) await db.run(sql`INSERT INTO ${workAnnotations} (work_id, data, updated_at, organization_id) VALUES (${work.id}, ${JSON.stringify(annotations)}, ${annotations.updatedAt}, ${organizationId})`)
    if (previous) await insertRevision(db, organizationId, work.id, previous.content, previous.updatedAt)
    return work
  })
}

/** A successful cloud write does not authorize deleting newer local edits. */
export async function removePushedWork(organizationId: string, id: string, fingerprint: string): Promise<void> {
  await database().transaction(async () => {
    const snapshot = await exportWorkForCloud(organizationId, id)
    if (snapshot.fingerprint !== fingerprint) throw new Error('The work changed during the cloud push. Its local copy was kept.')
    await deleteWork(organizationId, id)
  })
}
