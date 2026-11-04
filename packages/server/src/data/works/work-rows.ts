import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import type { Work as WorkRecord, WorkMeta, WorkRevision, WorkRevisionReason, WorkRevisionSummary } from '@solus/contracts/types'
import type { Attribution } from '@solus/contracts/user'
import type { Db } from '../../db/database'
import { workExternalLinkSchema } from '../../docs/schema'
import { type RecordScope } from '../../admission/principal'
import { scopeClause } from '../scope'
import { attributionJson, parseStoredAttribution, userOfStoredKey } from '../stored-attribution'
import { resourceLinks } from '../links/schema'
import { workRevisions, works } from './schema'
import './database-work-storage'
import { initializeWorkStorage, storageForWork } from './work-storage'

/**
 * The storage rows of one work and its revisions, shared by `Work` (one work's
 * mutations) and `works.ts` (collection reads, creation, and transfer). Nothing
 * here is exported past the works domain.
 */

const agentProviderSchema = z.enum(['claude-code', 'codex', 'opencode', 'replay'])
export const workTypeSchema = z.enum(['doc', 'slides', 'artifact'])
const workExtraSchema = z.object({
  mirroredDoc: workExternalLinkSchema.optional(),
})
const memberSessionIdsSchema = z.array(z.string())

/** A body author as rows written before plan 012 stage 4 hold it. */
const legacyAuthorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('person'), userId: z.string(), displayName: z.string() }),
  z.object({ kind: z.literal('agent'), sessionId: z.string().nullable() }),
  z.object({ kind: z.literal('upstream'), provider: z.enum(['gdrive', 'confluence']) }),
  z.object({ kind: z.literal('unknown') }),
])
export const revisionReasonSchema: z.ZodType<WorkRevisionReason> = z.enum(['baseline', 'checkpoint', 'agent', 'upstream', 'review', 'restore'])

export const workRowSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
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
  content_version: z.number(),
  content_hash: z.string(),
  content_author: z.string().nullable(),
  previous_revision_id: z.number().nullable(),
  /** The sessions the work is a member of, as a JSON array (`memberSessionIdsColumn`). */
  member_session_ids: z.string().nullable(),
})
export type WorkRow = z.infer<typeof workRowSchema>
/** A work row without its body: what a list reads (plan 029 P2). */
export const workMetaRowSchema = workRowSchema.omit({ content: true })
export type WorkMetaRow = z.infer<typeof workMetaRowSchema>

export const revisionRowSchema = z.object({
  work_id: z.string(),
  rev: z.number(),
  content: z.string().nullable(),
  updated_at: z.number(),
  source_content_version: z.number().nullable(),
  author: z.string().nullable(),
  reason: revisionReasonSchema,
  content_hash: z.string(),
})
export type RevisionRow = z.infer<typeof revisionRowSchema>
/** A revision row without its body: what the history list reads. */
export const revisionSummaryRowSchema = revisionRowSchema.omit({ content: true })
export type RevisionSummaryRow = z.infer<typeof revisionSummaryRowSchema>

/**
 * The sessions a work is a member of (`resource_links`, relation `member`),
 * oldest membership first, as one JSON array column `member_session_ids` of a
 * read `FROM works`. Membership is the one work fact outside the row, and a list
 * reads it in the same statement rather than once per work.
 */
export function memberSessionIdsColumn(engine: Db['engine']): SQL {
  const members = sql`FROM ${resourceLinks} AS member
    WHERE member.source_kind = 'session' AND member.target_kind = 'work' AND member.relation = 'member'
      AND member.status = 'active' AND member.target_key = works.id`
  return engine === 'postgres'
    ? sql`(SELECT COALESCE(json_agg(member.source_id ORDER BY member.created_at, member.source_id)::text, '[]') ${members}) AS member_session_ids`
    : sql`(SELECT json_group_array(source_id) FROM (SELECT member.source_id ${members} ORDER BY member.created_at, member.source_id)) AS member_session_ids`
}

const WORK_META_COLUMN_LIST = sql`id, organization_id, title, preview, type, session_id, agent_provider, cwd, pinned, created_at, updated_at, meta, content_version, content_hash, content_author, previous_revision_id`
/** A work row without its body: what a list reads (plan 029 P2). */
export function workMetaColumns(engine: Db['engine']): SQL {
  return sql`${WORK_META_COLUMN_LIST}, ${memberSessionIdsColumn(engine)}`
}
export function workColumns(engine: Db['engine']): SQL {
  return sql`${workMetaColumns(engine)}, content`
}
export const REVISION_SUMMARY_COLUMNS = sql`work_id, rev, updated_at, source_content_version, author, reason, content_hash`
export const REVISION_COLUMNS = sql`${REVISION_SUMMARY_COLUMNS}, content`

export function epochMs(value: string): number {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid work timestamp: ${value}`)
  return timestamp
}

export function isoTime(value: number): string {
  return new Date(value).toISOString()
}

export function authorJson(author: Attribution | null): string | null {
  return author ? attributionJson(author) : null
}

/**
 * A stored body author. Null is a body nobody recorded. An older row's person
 * is the user it names (the legacy host-owner key is the host's user), and its
 * agent with no session keeps an empty session id.
 */
export function authorFromJson(value: string | null): Attribution | null {
  if (value === null) return null
  const stored = parseStoredAttribution(value)
  if (stored) return stored
  const legacy = legacyAuthorSchema.parse(JSON.parse(value))
  switch (legacy.kind) {
    case 'person': return { kind: 'user', user: userOfStoredKey(legacy.userId, legacy.displayName) }
    case 'agent': return { kind: 'agent', sessionId: legacy.sessionId ?? '' }
    case 'upstream': return legacy
    case 'unknown': return null
  }
}

/** The fields that ride the `meta` JSON column: everything without a column of
 * its own. Named, so a record passed as its meta cannot store its body here.
 * Membership is not one of them: it is the session's edge (`resource_links`). */
export function metaJson(meta: WorkMeta): string {
  const extra: z.infer<typeof workExtraSchema> = { mirroredDoc: meta.mirroredDoc }
  return JSON.stringify(extra)
}

export function metaFromRow(row: WorkMetaRow): WorkMeta {
  const extra = row.meta ? workExtraSchema.parse(JSON.parse(row.meta)) : {}
  return {
    ...extra,
    sessionIds: row.member_session_ids ? memberSessionIdsSchema.parse(JSON.parse(row.member_session_ids)) : [],
    organizationId: row.organization_id,
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

export function workFromRow(row: WorkRow): WorkRecord {
  return {
    id: row.id,
    content: row.content ?? '',
    ...metaFromRow(row),
    contentVersion: row.content_version,
    contentHash: row.content_hash,
    contentAuthor: authorFromJson(row.content_author),
  }
}

/** `lock` holds the row for the rest of the transaction on Postgres; SQLite's
 * write transaction already serializes. A shared work is not here: its row
 * holds only where it went (`workLocation`). */
export async function workRow(db: Db, scope: RecordScope, id: string, lock = false): Promise<WorkRow | undefined> {
  const row = workRowSchema.nullish().parse(await db.get(sql`
    SELECT ${workColumns(db.engine)}
    FROM ${works}
    WHERE id = ${id} AND ${scopeClause(scope)} AND location IS NULL
    ${lock && db.engine === 'postgres' ? sql`FOR UPDATE` : sql``}
  `)) ?? undefined
  if (row) row.content = await (await storageForWork(db, row.organization_id, row.id)).read(db, { organizationId: row.organization_id, workId: row.id, contentHash: row.content_hash, revisionId: null }, row.content)
  return row
}

/** Where a shared work is now (cloud-sharing.md §3a). */
export const workLocationSchema = z.strictObject({ organizationId: z.string().min(1) })
export type WorkLocation = z.infer<typeof workLocationSchema>

/** The location of a work that left this host, or null when it is here or unknown. */
export async function workLocation(db: Db, scope: RecordScope, id: string): Promise<WorkLocation | null> {
  const row = z.object({ location: z.string().nullable() }).nullish().parse(await db.get(sql`
    SELECT location FROM ${works} WHERE id = ${id} AND ${scopeClause(scope)}
  `))
  return row?.location ? workLocationSchema.parse(JSON.parse(row.location)) : null
}

/** The body, version, author, and hash a new or imported work starts with. */
export interface WorkBody {
  content: string
  contentVersion: number
  contentHash: string
  contentAuthor: Attribution | null
}

/** `ownerKey` is the person the new work belongs to (docs/plans/access-model.md §2.2). */
export async function insertWorkRow(db: Db, organizationId: string, ownerKey: string, id: string, meta: WorkMeta, body: WorkBody, previousRevisionId: number | null = null): Promise<void> {
  await initializeWorkStorage(db, organizationId, id)
  await db.run(sql`
    INSERT INTO ${works} (
      id, title, preview, type, session_id, agent_provider, cwd,
      pinned, content, created_at, updated_at, meta, organization_id,
      content_version, content_hash, content_author, previous_revision_id, created_by
    ) VALUES (
      ${id}, ${meta.title}, ${meta.preview}, ${meta.type}, ${meta.sessionId ?? null},
      ${meta.agentProvider}, ${meta.cwd}, ${meta.pinned === undefined ? null : meta.pinned ? 1 : 0},
      NULL, ${epochMs(meta.createdAt)}, ${epochMs(meta.updatedAt)}, ${metaJson(meta)}, ${organizationId},
      ${body.contentVersion}, ${body.contentHash}, ${authorJson(body.contentAuthor)}, ${previousRevisionId}, ${ownerKey}
    )
  `)
  await (await storageForWork(db, organizationId, id)).capture(db, { organizationId, workId: id, contentHash: body.contentHash, revisionId: null }, body.content)
}

export interface NewRevision {
  content: string
  capturedAt: number
  sourceContentVersion: number | null
  author: Attribution | null
  reason: WorkRevisionReason
  contentHash: string
}

/** Appends one immutable checkpoint and answers its `rev`. A revision is never
 * updated after this insert; the caller holds the work row, so the next `rev`
 * cannot race. */
export async function insertRevision(db: Db, organizationId: string, workId: string, revision: NewRevision): Promise<number> {
  const next = z.object({ rev: z.number() }).parse(await db.get(sql`
    SELECT COALESCE(MAX(rev), 0) + 1 AS rev FROM ${workRevisions} WHERE work_id = ${workId}
  `)).rev
  await db.run(sql`
    INSERT INTO ${workRevisions} (work_id, rev, content, updated_at, organization_id, source_content_version, author, reason, content_hash)
    VALUES (
      ${workId}, ${next}, NULL, ${revision.capturedAt}, ${organizationId},
      ${revision.sourceContentVersion}, ${authorJson(revision.author)}, ${revision.reason}, ${revision.contentHash}
    )
  `)
  await (await storageForWork(db, organizationId, workId)).capture(db, { organizationId, workId, contentHash: revision.contentHash, revisionId: next }, revision.content)
  return next
}

/** An imported checkpoint, under the identity and capture time it has at its
 * source. Like every revision, it is written once and never updated. */
export async function copyRevision(db: Db, organizationId: string, revision: WorkRevision): Promise<void> {
  await db.run(sql`
    INSERT INTO ${workRevisions} (work_id, rev, content, updated_at, organization_id, source_content_version, author, reason, content_hash)
    VALUES (
      ${revision.workId}, ${revision.revisionId}, NULL, ${epochMs(revision.capturedAt)}, ${organizationId},
      ${revision.sourceContentVersion}, ${authorJson(revision.author)}, ${revision.reason}, ${revision.contentHash}
    )
  `)
  await (await storageForWork(db, organizationId, revision.workId)).capture(db, { organizationId, workId: revision.workId, contentHash: revision.contentHash, revisionId: revision.revisionId }, revision.content)
}

export function revisionSummaryFromRow(row: RevisionSummaryRow): WorkRevisionSummary {
  return {
    workId: row.work_id,
    revisionId: row.rev,
    reason: row.reason,
    sourceContentVersion: row.source_content_version,
    author: authorFromJson(row.author),
    contentHash: row.content_hash,
    capturedAt: isoTime(row.updated_at),
  }
}

export async function revisionRow(db: Db, organizationId: string, workId: string, rev: number): Promise<RevisionRow | undefined> {
  const row = revisionRowSchema.nullish().parse(await db.get(sql`
    SELECT ${REVISION_COLUMNS} FROM ${workRevisions} WHERE work_id = ${workId} AND rev = ${rev} AND organization_id = ${organizationId}
  `)) ?? undefined
  if (row) row.content = await readRevisionBody(db, organizationId, row)
  return row
}

export async function readRevisionBody(db: Db, organizationId: string, row: RevisionRow): Promise<string> {
  return (await storageForWork(db, organizationId, row.work_id)).read(db, { organizationId, workId: row.work_id, contentHash: row.content_hash, revisionId: row.rev }, row.content)
}

/** A new work's first history row: its initial body. */
export async function insertBaseline(db: Db, organizationId: string, workId: string, body: WorkBody, capturedAt: number): Promise<number> {
  return insertRevision(db, organizationId, workId, {
    content: body.content,
    capturedAt,
    sourceContentVersion: body.contentVersion,
    author: body.contentAuthor,
    reason: 'baseline',
    contentHash: body.contentHash,
  })
}
