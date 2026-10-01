import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Work as WorkRecord, WorkMeta, WorkRevision, WorkRevisionReason, WorkRevisionSummary } from '@solus/contracts/types'
import type { Attribution } from '@solus/contracts/user'
import type { Db } from '../../db/database'
import { workExternalLinkSchema } from '../../docs/schema'
import { type RecordScope } from '../../admission/principal'
import { scopeClause } from '../scope'
import { attributionJson, parseStoredAttribution, userOfStoredKey } from '../stored-attribution'
import { workRevisions, works } from './schema'

/**
 * The storage rows of one work and its revisions, shared by `Work` (one work's
 * mutations) and `works.ts` (collection reads, creation, and transfer). Nothing
 * here is exported past the works domain.
 */

const agentProviderSchema = z.enum(['claude-code', 'codex', 'opencode'])
export const workTypeSchema = z.enum(['doc', 'slides', 'diagram', 'artifact', 'insights-report'])
const workExtraSchema = z.object({
  sessionIds: z.array(z.string()).optional(),
  mirroredDoc: workExternalLinkSchema.optional(),
})

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
})
export type WorkRow = z.infer<typeof workRowSchema>

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

export const WORK_COLUMNS = sql`id, organization_id, title, preview, type, session_id, agent_provider, cwd, pinned, content, created_at, updated_at, meta, content_version, content_hash, content_author, previous_revision_id`
export const REVISION_COLUMNS = sql`work_id, rev, content, updated_at, source_content_version, author, reason, content_hash`

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
 * its own. Named, so a record passed as its meta cannot store its body here. */
export function metaJson(meta: WorkMeta): string {
  const extra: z.infer<typeof workExtraSchema> = { sessionIds: meta.sessionIds, mirroredDoc: meta.mirroredDoc }
  return JSON.stringify(extra)
}

export function metaFromRow(row: WorkRow): WorkMeta {
  const extra = row.meta ? workExtraSchema.parse(JSON.parse(row.meta)) : {}
  return {
    ...extra,
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
 * write transaction already serializes. */
export async function workRow(db: Db, scope: RecordScope, id: string, lock = false): Promise<WorkRow | undefined> {
  return workRowSchema.nullish().parse(await db.get(sql`
    SELECT ${WORK_COLUMNS}
    FROM ${works}
    WHERE id = ${id} AND ${scopeClause(scope)}
    ${lock && db.engine === 'postgres' ? sql`FOR UPDATE` : sql``}
  `)) ?? undefined
}

/** The body, version, author, and hash a new or imported work starts with. */
export interface WorkBody {
  content: string
  contentVersion: number
  contentHash: string
  contentAuthor: Attribution | null
}

export async function insertWorkRow(db: Db, organizationId: string, id: string, meta: WorkMeta, body: WorkBody, previousRevisionId: number | null = null): Promise<void> {
  await db.run(sql`
    INSERT INTO ${works} (
      id, title, preview, type, session_id, agent_provider, cwd,
      pinned, content, created_at, updated_at, meta, organization_id,
      content_version, content_hash, content_author, previous_revision_id
    ) VALUES (
      ${id}, ${meta.title}, ${meta.preview}, ${meta.type}, ${meta.sessionId ?? null},
      ${meta.agentProvider}, ${meta.cwd}, ${meta.pinned === undefined ? null : meta.pinned ? 1 : 0},
      ${body.content}, ${epochMs(meta.createdAt)}, ${epochMs(meta.updatedAt)}, ${metaJson(meta)}, ${organizationId},
      ${body.contentVersion}, ${body.contentHash}, ${authorJson(body.contentAuthor)}, ${previousRevisionId}
    )
  `)
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
      ${workId}, ${next}, ${revision.content}, ${revision.capturedAt}, ${organizationId},
      ${revision.sourceContentVersion}, ${authorJson(revision.author)}, ${revision.reason}, ${revision.contentHash}
    )
  `)
  return next
}

/** An imported checkpoint, under the identity and capture time it has at its
 * source. Like every revision, it is written once and never updated. */
export async function copyRevision(db: Db, organizationId: string, revision: WorkRevision): Promise<void> {
  await db.run(sql`
    INSERT INTO ${workRevisions} (work_id, rev, content, updated_at, organization_id, source_content_version, author, reason, content_hash)
    VALUES (
      ${revision.workId}, ${revision.revisionId}, ${revision.content}, ${epochMs(revision.capturedAt)}, ${organizationId},
      ${revision.sourceContentVersion}, ${authorJson(revision.author)}, ${revision.reason}, ${revision.contentHash}
    )
  `)
}

export function revisionSummaryFromRow(row: RevisionRow): WorkRevisionSummary {
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

export async function revisionRow(db: Db, workId: string, rev: number): Promise<RevisionRow | undefined> {
  return revisionRowSchema.nullish().parse(await db.get(sql`
    SELECT ${REVISION_COLUMNS} FROM ${workRevisions} WHERE work_id = ${workId} AND rev = ${rev}
  `)) ?? undefined
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
