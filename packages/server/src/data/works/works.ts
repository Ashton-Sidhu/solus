import type { WorkTransfer } from '@solus/contracts/work-transfer'
import { loadWorkAnnotations } from './work-annotations'
import { createHash, randomUUID } from 'node:crypto'
import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { createLogger } from '../../logger'
import { getDatabase } from '../../db/database'
import type { AgentId, Work, WorkMeta, WorkPrevious, WorkType } from '@solus/contracts/types'
import { attributionSchema, type Attribution } from '@solus/contracts/user'
import { documentContentHash } from '../../docs/content-hash'
import { workAnnotations, workRevisions, works } from './schema'
import { type RecordScope } from '../../admission/principal'
import { scopeClause } from '../scope'
import { Work as WorkEntity, validateWorkContent } from './work'
import { workLiveBridge } from './work-live-bridge'
import { emitWorkChanged } from './work-events'
import { recordNewMentions } from '../activity/mentions'
import { hostAttribution } from '../stored-attribution'
import {
  REVISION_COLUMNS,
  WORK_COLUMNS,
  copyRevision,
  epochMs,
  insertBaseline,
  insertWorkRow,
  metaFromRow,
  revisionRowSchema,
  revisionSummaryFromRow,
  revisionReasonSchema,
  workFromRow,
  workRow,
  workRowSchema,
  type WorkBody,
} from './work-rows'

export type { Work, WorkMeta, WorkPrevious }

/**
 * Works: documents, slide decks, diagrams, and artifacts
 * (docs/plans/cloud-service-model.md). Every work is a row of `works`; its
 * immutable checkpoints are rows of `work_revisions`. This module holds what is
 * not about one work: creation, collection reads, and transfer. One work's
 * rules and mutations are the `Work` class (`work.ts`). Every row carries its
 * canonical organization (organization-scope §3): a read names its scope, a
 * work outside it is simply not found, and a write to an existing work keeps
 * the organization the row has.
 */

const log = createLogger('folio', 'works.ts')

const workRefRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.enum(['doc', 'slides', 'diagram', 'artifact', 'insights-report']),
  session_id: z.string(),
})

const database = getDatabase

/** A new work row and its baseline checkpoint, in one transaction. */
async function insertNewWork(organizationId: string, id: string, meta: WorkMeta, content: string, author: Attribution | null): Promise<Work> {
  const body: WorkBody = { content, contentVersion: 1, contentHash: documentContentHash(content), contentAuthor: author }
  await database().transaction(async (db) => {
    await insertWorkRow(db, organizationId, id, meta, body)
    await insertBaseline(db, organizationId, id, body, epochMs(meta.updatedAt))
    await recordNewMentions(db, organizationId, { kind: 'work', id, title: meta.title }, author ?? hostAttribution(), '', content)
    emitWorkChanged({ workId: id, version: meta.updatedAt, contentVersion: body.contentVersion })
  })
  return { id, ...meta, ...body }
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
  /** From the admitted request that creates the work; null when nothing admitted names one. */
  author: Attribution | null = null,
): Promise<Work> {
  validateWorkContent(type, content)
  const now = new Date().toISOString()
  const meta: WorkMeta = {
    organizationId,
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
  return insertNewWork(organizationId, id, meta, content, author)
}

/** A copy is a new work: its own baseline at version 1, with the body's author kept. */
export async function duplicateWork(scope: RecordScope, id: string): Promise<Work> {
  await workLiveBridge()?.flush(id)
  const row = await workRow(database(), scope, id)
  if (!row) throw new Error(`Work not found: ${id}`)
  const source = workFromRow(row)
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
  return insertNewWork(row.organization_id, randomUUID(), meta, source.content, source.contentAuthor)
}

/**
 * `dirty` cannot be stored, only derived: a work's content changes without the
 * link being touched. Every state the provider owns — conflict, error, upstream
 * change — is stored and left alone here.
 */
function withDerivedSyncState<T extends WorkMeta>(meta: T, content: string): T {
  const link = meta.mirroredDoc
  if (!link || link.syncState !== 'ok' && link.syncState !== 'dirty') return meta
  const dirty = link.lastPushedContentHash !== documentContentHash(content)
  if ((link.syncState === 'dirty') === dirty) return meta
  return { ...meta, mirroredDoc: { ...link, syncState: dirty ? 'dirty' : 'ok' } }
}

/** A work's organization, or null when there is no such work: the one column the access policy reads on every call. */
export async function workOrganizationId(id: string): Promise<string | null> {
  const row = z.object({ organization_id: z.string() }).nullish().parse(await database().get(sql`
    SELECT organization_id FROM ${works} WHERE id = ${id}
  `))
  return row?.organization_id ?? null
}

export async function loadWork(scope: RecordScope, id: string): Promise<Work | null> {
  try {
    // Edits made live are written to the body first, so a read sees them.
    await workLiveBridge()?.flush(id)
    const row = await workRow(database(), scope, id)
    if (!row) return null
    const work = workFromRow(row)
    return withDerivedSyncState(work, work.content)
  } catch (err: any) {
    log.error('work_load_failed', { workId: id, error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

export async function listWorks(scope: RecordScope): Promise<(WorkMeta & { id: string })[]> {
  try {
    const rows = workRowSchema.array().parse(await database().all(sql`
      SELECT ${WORK_COLUMNS}
      FROM ${works}
      WHERE ${scopeClause(scope)} AND location IS NULL
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

/** Bounded metadata read; work bodies are loaded only by the individual endpoint. */
export async function readWorkMetadataPage(where: SQL, limit: number): Promise<(WorkMeta & { id: string })[]> {
  const columns = works.columnNames().map(name => name === 'content'
    ? sql`NULL AS content`
    : sql`${sql.identifier('works')}.${sql.identifier(name)}`)
  const rows = workRowSchema.array().parse(await database().all(sql`
    SELECT ${sql.join(columns, sql`, `)} FROM ${works}
    WHERE ${where} AND location IS NULL ORDER BY created_at DESC, id DESC LIMIT ${limit}
  `))
  return rows.map(row => ({ id: row.id, ...metaFromRow(row) }))
}

/** The works these sessions made, newest first: id, title and type only. */
export async function listWorkRefsForSessions(
  scope: RecordScope,
  sessionIds: readonly string[],
): Promise<Array<{ id: string; title: string; type: WorkType; sessionId: string }>> {
  if (!sessionIds.length) return []
  const rows = workRefRowSchema.array().parse(await database().all(sql`
    SELECT id, title, type, session_id FROM ${works}
    WHERE ${scopeClause(scope)} AND location IS NULL
      AND session_id IN (${sql.join(sessionIds.map((id) => sql`${id}`), sql`, `)})
    ORDER BY created_at DESC, id
  `))
  return rows.map((row) => ({ id: row.id, title: row.title, type: row.type, sessionId: row.session_id }))
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
    case 'insights-report':
      return 'json'
  }
}

/**
 * Capture a work whole, in one transaction: its record, every checkpoint, the
 * previous-version reference, and its comments. Every hash the transfer
 * carries is one the source stores, so a later export answers the same
 * fingerprint.
 */
export async function exportWorkForCloud(scope: RecordScope, id: string): Promise<WorkTransfer> {
  await workLiveBridge()?.flush(id)
  return database().transaction(async (db) => {
    const row = await workRow(db, scope, id, true)
    if (!row) throw new Error(`Work not found: ${id}`)
    const revisions = revisionRowSchema.array().parse(await db.all(sql`
      SELECT ${REVISION_COLUMNS} FROM ${workRevisions} WHERE work_id = ${id} ORDER BY rev
    `)).map((revision) => ({ ...revisionSummaryFromRow(revision), content: revision.content ?? '' }))
    const snapshot: WorkSnapshot = {
      work: workFromRow(row),
      previousRevisionId: row.previous_revision_id,
      revisions,
      annotations: await loadWorkAnnotations(scope, id),
    }
    return { ...snapshot, fingerprint: workTransferFingerprint(snapshot) }
  })
}

type WorkSnapshot = Omit<WorkTransfer, 'fingerprint'>

/**
 * The fingerprint names the content, not the home: the same work in `local`
 * and in the organization it was published to hashes the same, so the
 * destination can tell a retry from a different version. It covers the body,
 * every revision, the previous-version reference, and the comments. Both
 * sides assemble these records with the same row readers, so their keys come
 * in the same order.
 */
export function workTransferFingerprint(snapshot: WorkSnapshot): string {
  const { organizationId: _organizationId, ...work } = snapshot.work
  return createHash('sha256').update(JSON.stringify({
    work,
    previousRevisionId: snapshot.previousRevisionId,
    revisions: snapshot.revisions,
    annotations: snapshot.annotations,
  })).digest('hex')
}

/**
 * A self-consistent fingerprint proves nothing about the history inside it:
 * every hash is recomputed, every revision must belong to this work under a
 * unique id and a version the work had, and the previous version must name
 * one of them. Nothing is written when any check fails.
 */
function verifySnapshot({ work, previousRevisionId, revisions, annotations }: WorkSnapshot): void {
  if (work.contentHash !== documentContentHash(work.content)) throw new Error('The work snapshot does not match its content hash.')
  if (!Number.isInteger(work.contentVersion) || work.contentVersion < 1) throw new Error('The work snapshot has no valid content version.')
  attributionSchema.nullable().parse(work.contentAuthor)
  if (annotations && annotations.workId !== work.id) throw new Error('The comments belong to another work.')
  let lastRevisionId = 0
  for (const revision of revisions) {
    if (revision.workId !== work.id) throw new Error(`Revision ${revision.revisionId} belongs to another work.`)
    if (!Number.isInteger(revision.revisionId) || revision.revisionId <= lastRevisionId) throw new Error('The work history has a repeated or out-of-order revision.')
    lastRevisionId = revision.revisionId
    if (revision.contentHash !== documentContentHash(revision.content)) throw new Error(`Revision ${revision.revisionId} does not match its content hash.`)
    const version = revision.sourceContentVersion
    if (version !== null && (!Number.isInteger(version) || version < 1 || version > work.contentVersion)) {
      throw new Error(`Revision ${revision.revisionId} names a content version the work never had.`)
    }
    attributionSchema.nullable().parse(revision.author)
    revisionReasonSchema.parse(revision.reason)
    epochMs(revision.capturedAt)
  }
  if (previousRevisionId !== null && !revisions.some((revision) => revision.revisionId === previousRevisionId)) {
    throw new Error('The previous version names a revision this work does not have.')
  }
}

/**
 * An import is atomic, into `organizationId` (organization-scope §7): the
 * snapshot's own organization is the source host's fact, the destination
 * decides. The work, every revision under its source id, the previous-version
 * reference, and the comments are written in one transaction. An existing
 * different work is never overwritten; the same fingerprint is a retry and
 * answers the stored work without writing.
 */
export async function importWorkFromHost(organizationId: string, transfer: WorkTransfer): Promise<Work> {
  const { work, previousRevisionId, revisions, annotations, fingerprint } = transfer
  const snapshot: WorkSnapshot = { work, previousRevisionId, revisions, annotations }
  if (fingerprint !== workTransferFingerprint(snapshot)) throw new Error('The work snapshot is incomplete.')
  verifySnapshot(snapshot)
  const imported: Work = { ...work, organizationId }
  return database().transaction(async (db) => {
    const existing = await workRow(db, organizationId, work.id)
    if (existing) {
      if ((await exportWorkForCloud(organizationId, work.id)).fingerprint !== fingerprint) throw new Error('The cloud already has a different version. Open it before sharing.')
      return imported
    }
    await insertWorkRow(db, organizationId, work.id, imported, imported, previousRevisionId)
    for (const revision of revisions) await copyRevision(db, organizationId, revision)
    if (annotations) await db.run(sql`INSERT INTO ${workAnnotations} (work_id, data, updated_at, organization_id) VALUES (${work.id}, ${JSON.stringify(annotations)}, ${annotations.updatedAt}, ${organizationId})`)
    emitWorkChanged({ workId: work.id, version: work.updatedAt, contentVersion: work.contentVersion })
    return imported
  })
}

/** After the cloud has the work, point this host's row at it (cloud-sharing.md §3a).
 *  The content stays here. A work edited after it was read is not pointed away:
 *  the cloud copy would be older than this one. */
export async function markWorkMoved(scope: RecordScope, id: string, fingerprint: string, organizationId: string): Promise<void> {
  await database().transaction(async () => {
    const snapshot = await exportWorkForCloud(scope, id)
    if (snapshot.fingerprint !== fingerprint) throw new Error('The work changed during the cloud push. Its local copy was kept.')
    await (await WorkEntity.byId(scope, id)).moveTo({ organizationId })
  })
}
