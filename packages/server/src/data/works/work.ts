import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type {
  AgentId,
  Work as WorkRecord,
  WorkMeta,
  WorkPrevious,
  WorkRevision,
  WorkRevisionSummary,
  WorkType,
} from '@solus/contracts/types'
import type { WorkExternalLink } from '@solus/contracts/docs'
import type { Attribution } from '@solus/contracts/user'
import { workPreview } from '@solus/contracts/work-preview'
import { parseDiagram } from '@solus/contracts/diagram-types'
import { getDatabase, type Db } from '../../db/database'
import { documentContentHash } from '../../docs/content-hash'
import { type RecordScope } from '../../admission/principal'
import { workAnnotations, workRevisions, works } from './schema'
import { emitWorkChanged } from './work-events'
import { workLiveBridge } from './work-live-bridge'
import { recordNewMentions } from '../activity/mentions'
import { removeNotificationsFor } from '../notifications/store'
import { hostAttribution } from '../stored-attribution'
import {
  REVISION_COLUMNS,
  authorJson,
  insertRevision,
  isoTime,
  metaFromRow,
  metaJson,
  revisionRow,
  revisionRowSchema,
  revisionSummaryFromRow,
  workFromRow,
  workLocation,
  workRow,
  type WorkLocation,
  type WorkRow,
} from './work-rows'

export const GOOGLE_WORK_READ_ONLY = 'This work is linked to Google Docs and is read-only in Solus. Edit it in Google Docs, then Pull latest. Comments remain available.'

export function assertWorkEditable(meta: WorkMeta): void {
  if (meta.mirroredDoc?.provider === 'gdrive') throw new Error(GOOGLE_WORK_READ_ONLY)
}

/** A work that Share moved to an organization (cloud-sharing.md §3a): this host
 *  has only its location. The code lets a client ask the work's new owner. */
export class WorkMovedError extends Error {
  readonly code = 'MOVED' as const

  constructor(readonly workId: string, readonly location: WorkLocation) {
    super(`Work ${workId} moved to organization ${location.organizationId}.`)
    this.name = 'WorkMovedError'
  }
}

/** A body the work's type cannot hold. Nothing was written. */
export class WorkContentInvalidError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkContentInvalidError'
  }
}

/**
 * Every body that reaches storage passes here, whoever writes it: an API
 * request, an RPC, an outbox op, or an import. A diagram must parse, or it
 * renders as a blank canvas over the good content it replaced.
 */
export function validateWorkContent(type: WorkType, content: string): void {
  if (type !== 'diagram') return
  try {
    parseDiagram(content)
  } catch (error) {
    throw new WorkContentInvalidError(`Invalid diagram content: ${error instanceof Error ? error.message : String(error)}. The content must be JSON shaped like {"nodes":[...],"edges":[...]}.`)
  }
}

/**
 * Why a body changes. `edit` is a person's save: it advances the version and
 * adds no history row. `agent` checkpoints both the body it displaces and the
 * body it writes. The provider pull is its own operation, `applyUpstream`.
 */
export type WorkContentChangeReason = 'edit' | 'agent'

/** A write named a version the work has moved past. `content` is the body's
 * `contentVersion`; `record` is the whole record's `updatedAt`. */
export class WorkVersionConflictError extends Error {
  constructor(readonly precondition: 'content' | 'record') {
    super(precondition === 'content'
      ? 'This work changed after it was read. Read it again before saving.'
      : 'This work changed in the cloud. Reload the saved copy before saving.')
    this.name = 'WorkVersionConflictError'
  }
}

/**
 * What a content writer read, checked inside its transaction. Every writer
 * names `expectedContentVersion`, the body's version it read: a record
 * version fetched at write time would miss an edit made after that read. A
 * writer that also holds the whole record's version (the HTTP ETag) passes
 * `expectedUpdatedAt`, and both must still hold.
 */
interface WorkPreconditions {
  expectedContentVersion: number
  expectedUpdatedAt?: string
}

interface WorkBodyWrite {
  content: string
  /** Written in the same transaction, under the same preconditions. */
  title?: string
  author: Attribution | null
}

type UpdateWorkContent = WorkBodyWrite & WorkPreconditions & { reason: WorkContentChangeReason }

/** The next record version: strictly after the current one, even within one millisecond. */
function nextUpdatedAt(row: WorkRow): number {
  return Math.max(Date.now(), row.updated_at + 1)
}

async function writeMeta(db: Db, id: string, meta: WorkMeta): Promise<void> {
  await db.run(sql`
    UPDATE ${works} SET
      title = ${meta.title},
      preview = ${meta.preview},
      type = ${meta.type},
      session_id = ${meta.sessionId ?? null},
      agent_provider = ${meta.agentProvider},
      cwd = ${meta.cwd},
      pinned = ${meta.pinned === undefined ? null : meta.pinned ? 1 : 0},
      updated_at = ${Date.parse(meta.updatedAt)},
      meta = ${metaJson(meta)}
    WHERE id = ${id}
  `)
}

/** The checkpoint holding the current body, captured now if none does. */
async function checkpointOfCurrent(db: Db, row: WorkRow): Promise<number> {
  const existing = z.object({ rev: z.number() }).nullish().parse(await db.get(sql`
    SELECT rev FROM ${workRevisions}
    WHERE work_id = ${row.id} AND source_content_version = ${row.content_version}
    ORDER BY rev DESC LIMIT 1
  `))
  if (existing) return existing.rev
  const current = workFromRow(row)
  return insertRevision(db, row.organization_id, row.id, {
    content: current.content,
    capturedAt: Date.now(),
    sourceContentVersion: current.contentVersion,
    author: current.contentAuthor,
    reason: 'checkpoint',
    contentHash: current.contentHash,
  })
}

/**
 * Replace the body, or only the title when the body is equal. A checkpointed
 * write (`agent`, `upstream`) keeps both the displaced body (unless a
 * checkpoint already holds it) and the new one, and points the previous
 * version at the displaced body. A person's edit (`null`) adds no history row.
 */
async function changeBody(db: Db, row: WorkRow, write: WorkBodyWrite, checkpoint: 'agent' | 'upstream' | null): Promise<void> {
  if (write.content === (row.content ?? '')) {
    const meta = metaFromRow(row)
    if (write.title !== undefined && write.title !== meta.title) {
      await writeMeta(db, row.id, { ...meta, title: write.title, updatedAt: isoTime(nextUpdatedAt(row)) })
    }
    return
  }
  validateWorkContent(row.type ?? 'doc', write.content)
  const displaced = checkpoint === null ? null : await checkpointOfCurrent(db, row)
  const written = await writeBody(db, row, write)
  if (checkpoint === null || displaced === null) return
  await insertRevision(db, row.organization_id, row.id, {
    content: write.content,
    capturedAt: Date.now(),
    sourceContentVersion: written.contentVersion,
    author: write.author,
    reason: checkpoint,
    contentHash: written.contentHash,
  })
  await db.run(sql`UPDATE ${works} SET previous_revision_id = ${displaced} WHERE id = ${row.id}`)
}

/** Replace the body: one version step, a new hash and author, and the preview.
 *  A person the new body first mentions is recorded as `mentioned` activity. */
async function writeBody(db: Db, row: WorkRow, body: { content: string; author: Attribution | null; title?: string }): Promise<{ contentVersion: number; contentHash: string }> {
  await recordNewMentions(db, row.organization_id, { kind: 'work', id: row.id, title: body.title ?? row.title ?? undefined }, body.author ?? hostAttribution(), row.content ?? '', body.content)
  const contentVersion = row.content_version + 1
  const contentHash = documentContentHash(body.content)
  await db.run(sql`
    UPDATE ${works} SET
      title = ${body.title ?? row.title},
      preview = ${workPreview(row.type ?? 'doc', body.content)},
      content = ${body.content},
      content_version = ${contentVersion},
      content_hash = ${contentHash},
      content_author = ${authorJson(body.author)},
      updated_at = ${nextUpdatedAt(row)}
    WHERE id = ${row.id}
  `)
  return { contentVersion, contentHash }
}

function checkPreconditions(row: WorkRow, expected: { expectedContentVersion?: number; expectedUpdatedAt?: string }): void {
  if (expected.expectedUpdatedAt !== undefined && expected.expectedUpdatedAt !== isoTime(row.updated_at)) {
    throw new WorkVersionConflictError('record')
  }
  if (expected.expectedContentVersion !== undefined && expected.expectedContentVersion !== row.content_version) {
    throw new WorkVersionConflictError('content')
  }
}

/** One work in Solus: its record, and everything you can do to it.
 *
 * `WorkRecord` is the wire shape, and this class implements it. A loaded
 * instance is a snapshot, not a lock: every mutation rereads and locks the row
 * inside its own transaction, checks its preconditions there, and refreshes
 * the instance after. Anything crossing RPC or HTTP returns `record()`.
 *
 * History is immutable. A revision row is written once, with the body,
 * version, author, and hash that existed when it was captured; restore adds
 * rows and never updates one. The previous-version comparison and revert use
 * the explicit `previousRevisionId`, never the newest revision.
 *
 * Listing, search, creation, and transfer are not about one work and stay in
 * `works.ts`, `work-search.ts`, and `work-sync.ts`.
 */
export class Work implements WorkRecord {
  id!: string
  organizationId!: string
  title!: string
  preview!: string
  type!: WorkType
  createdAt!: string
  updatedAt!: string
  sessionId?: string
  sessionIds?: string[]
  agentProvider!: AgentId
  cwd!: string
  pinned?: boolean
  mirroredDoc?: WorkExternalLink
  content!: string
  contentVersion!: number
  contentHash!: string
  contentAuthor!: Attribution | null
  /** The organization every write lands in, from the row, never the caller. */
  readonly #organizationId: string
  #previousRevisionId: number | null = null

  private constructor(row: WorkRow) {
    this.#organizationId = row.organization_id
    this.hydrate(row)
  }

  /** Replace the fields wholesale, so a cleared optional does not survive a refresh. */
  private hydrate(row: WorkRow): void {
    const record = workFromRow(row)
    for (const key of Object.keys(this)) {
      if (!(key in record)) Reflect.deleteProperty(this, key)
    }
    Object.assign(this, record)
    this.#previousRevisionId = row.previous_revision_id
  }

  /** Loads the work inside `scope`. Throws when the id is unknown there. */
  static async byId(scope: RecordScope, workId: string): Promise<Work> {
    const work = await Work.find(scope, workId)
    if (work) return work
    const location = await workLocation(getDatabase(), scope, workId)
    if (location) throw new WorkMovedError(workId, location)
    throw new Error(`Work not found: ${workId}`)
  }

  /** Loads the work inside `scope`, or null when the id is unknown there.
   *  Edits made live are written to the body first, so a read sees them. */
  static async find(scope: RecordScope, workId: string): Promise<Work | null> {
    await workLiveBridge()?.flush(workId)
    const row = await workRow(getDatabase(), scope, workId)
    return row ? new Work(row) : null
  }

  /** The plain serializable shape. Everything crossing RPC returns this. */
  record(): WorkRecord {
    return structuredClone(this)
  }

  /** The revision the previous-version comparison and revert use. */
  get previousRevisionId(): number | null {
    return this.#previousRevisionId
  }

  /** Reread and lock the row in one transaction, run `change`, then refresh
   * this snapshot from what was committed inside it. A write that changed the
   * row announces `works.changed` once the outermost transaction commits. */
  private async mutate(change: (db: Db, row: WorkRow) => Promise<void>): Promise<this> {
    return getDatabase().transaction(async (db) => {
      const row = await workRow(db, this.#organizationId, this.id, true)
      if (!row) throw new Error(`Work not found: ${this.id}`)
      await change(db, row)
      const committed = await workRow(db, this.#organizationId, this.id)
      if (!committed) throw new Error(`Work not found: ${this.id}`)
      this.hydrate(committed)
      if (committed.updated_at !== row.updated_at || committed.content_version !== row.content_version || committed.meta !== row.meta || committed.pinned !== row.pinned) {
        emitWorkChanged({ workId: this.id, version: this.updatedAt, contentVersion: this.contentVersion })
      }
      return this
    })
  }

  /**
   * Write a new body. An equal body is not a change: the version stays, and
   * only a changed title is written. `edit` adds no history row. `agent`
   * checkpoints the displaced body (unless a checkpoint already holds it) and
   * the new one, and points the previous version at the displaced body.
   */
  async updateContent(input: UpdateWorkContent): Promise<this> {
    return this.throughLiveDoc(input.author, () => this.mutate(async (db, row) => {
      assertWorkEditable(metaFromRow(row))
      checkPreconditions(row, input)
      await changeBody(db, row, input, input.reason === 'agent' ? 'agent' : null)
    }))
  }

  /**
   * The body the live doc projects, written when its edits pause or before a
   * read. It is the people's own edits, so it adds no history row, and it
   * never goes back into the live doc it came from.
   */
  async applyLiveProjection(input: { content: string; author: Attribution | null }): Promise<this> {
    return this.mutate(async (db, row) => {
      await changeBody(db, row, { content: input.content, author: input.author }, null)
    })
  }

  /** A body write from outside the live doc holds the work while it writes,
   *  then reaches the people editing it live (`WorkLiveBridge.write`). */
  private async throughLiveDoc(by: Attribution | null, write: () => Promise<this>): Promise<this> {
    const bridge = workLiveBridge()
    if (!bridge) return write()
    await bridge.write(this.id, by, async () => (await write()).content)
    return this
  }

  /**
   * The provider pull: the only body write a Google-linked work accepts, and
   * only for a linked work. `expectedContentVersion` is the version read
   * before the provider was asked, so a save made while the pull was in
   * flight is refused, never replaced. The body, title, and refreshed link
   * are written in one transaction, with `upstream` checkpoints.
   */
  async applyUpstream(input: { content: string; title: string; link: WorkExternalLink; expectedContentVersion: number }): Promise<this> {
    return this.mutate(async (db, row) => {
      if (!metaFromRow(row).mirroredDoc) throw new Error('Only a linked work takes its body from upstream.')
      checkPreconditions(row, input)
      await changeBody(db, row, { content: input.content, title: input.title, author: { kind: 'upstream', provider: input.link.provider } }, 'upstream')
      const written = await workRow(db, this.#organizationId, this.id)
      if (!written) throw new Error(`Work not found: ${this.id}`)
      await db.run(sql`UPDATE ${works} SET meta = ${metaJson({ ...metaFromRow(written), mirroredDoc: input.link })} WHERE id = ${row.id}`)
    })
  }

  /** A metadata-only change: the record version moves, the content version does not. */
  async updateTitle(input: { title: string; expectedUpdatedAt?: string }): Promise<this> {
    return this.mutate(async (db, row) => {
      const meta = metaFromRow(row)
      assertWorkEditable(meta)
      checkPreconditions(row, input)
      if (input.title === meta.title) return
      await writeMeta(db, row.id, { ...meta, title: input.title, updatedAt: isoTime(nextUpdatedAt(row)) })
    })
  }

  /**
   * Make a checkpoint's body current again. The displaced body is held by a
   * checkpoint first, the restored body is a new `restore` checkpoint at the
   * next version, and the previous version points at the displaced body, so
   * a second restore of it undoes the first. No existing revision changes.
   * Restoring the body the work already has changes nothing.
   */
  async restoreRevision(input: { revisionId: number; author: Attribution | null } & WorkPreconditions): Promise<this> {
    return this.throughLiveDoc(input.author, () => this.mutate(async (db, row) => {
      assertWorkEditable(metaFromRow(row))
      checkPreconditions(row, input)
      const target = await revisionRow(db, row.id, input.revisionId)
      if (!target) throw new Error(`Revision ${input.revisionId} of work ${row.id} not found.`)
      const content = target.content ?? ''
      if (content === (row.content ?? '')) return
      const displaced = await checkpointOfCurrent(db, row)
      const written = await writeBody(db, row, { content, author: input.author })
      await insertRevision(db, row.organization_id, row.id, {
        content,
        capturedAt: Date.now(),
        sourceContentVersion: written.contentVersion,
        author: input.author,
        reason: 'restore',
        contentHash: written.contentHash,
      })
      await db.run(sql`UPDATE ${works} SET previous_revision_id = ${displaced} WHERE id = ${row.id}`)
    }))
  }

  /** Pin the current body as a checkpoint, for a reviewer to name the exact
   * version they saw. Refused when the body moved past `expectedContentVersion`.
   * A checkpoint of this body for the same reason is reused: asking three
   * reviewers, or deciding twice, names one version, not three copies. */
  async checkpoint(input: { reason: 'checkpoint' | 'review'; expectedContentVersion: number }): Promise<WorkRevision> {
    let revisionId = 0
    await this.mutate(async (db, row) => {
      checkPreconditions(row, input)
      const existing = z.object({ rev: z.number() }).nullish().parse(await db.get(sql`
        SELECT rev FROM ${workRevisions}
        WHERE work_id = ${row.id} AND source_content_version = ${row.content_version} AND reason = ${input.reason}
        ORDER BY rev DESC LIMIT 1
      `))
      if (existing) {
        revisionId = existing.rev
        return
      }
      const current = workFromRow(row)
      revisionId = await insertRevision(db, row.organization_id, row.id, {
        content: current.content,
        capturedAt: Date.now(),
        sourceContentVersion: current.contentVersion,
        author: current.contentAuthor,
        reason: input.reason,
        contentHash: current.contentHash,
      })
    })
    return this.revision(revisionId)
  }

  /** Every checkpoint, oldest first, without bodies. */
  async revisions(): Promise<WorkRevisionSummary[]> {
    const rows = revisionRowSchema.array().parse(await getDatabase().all(sql`
      SELECT ${REVISION_COLUMNS} FROM ${workRevisions} WHERE work_id = ${this.id} ORDER BY rev
    `))
    return rows.map(revisionSummaryFromRow)
  }

  async revision(revisionId: number): Promise<WorkRevision> {
    const row = await revisionRow(getDatabase(), this.id, revisionId)
    if (!row) throw new Error(`Revision ${revisionId} of work ${this.id} not found.`)
    return { ...revisionSummaryFromRow(row), content: row.content ?? '' }
  }

  /** The existing previous-version comparison: the body the last agent write,
   * upstream pull, or restore displaced. */
  async previous(): Promise<WorkPrevious | null> {
    if (this.#previousRevisionId === null) return null
    const row = await revisionRow(getDatabase(), this.id, this.#previousRevisionId)
    return row ? { content: row.content ?? '', updatedAt: isoTime(row.updated_at) } : null
  }

  /** Pinning is a gallery preference: neither version moves. */
  async setPinned(pinned: boolean): Promise<this> {
    return this.mutate(async (db, row) => {
      const meta = metaFromRow(row)
      if (pinned) meta.pinned = true
      else delete meta.pinned
      await writeMeta(db, row.id, meta)
    })
  }

  /**
   * Attach, update, or drop the upstream doc link. Null unlinks, which never
   * touches the upstream doc. Writes only the link, so a publish cannot make
   * the work look locally edited.
   */
  async setMirroredDoc(link: WorkExternalLink | null): Promise<this> {
    return this.mutate(async (db, row) => {
      const meta = metaFromRow(row)
      if (link) meta.mirroredDoc = link
      else delete meta.mirroredDoc
      await db.run(sql`UPDATE ${works} SET meta = ${metaJson(meta)} WHERE id = ${row.id}`)
    })
  }

  async linkSession(sessionId: string): Promise<this> {
    return this.mutate(async (db, row) => {
      const meta = metaFromRow(row)
      const sessionIds = meta.sessionIds ?? (meta.sessionId ? [meta.sessionId] : [])
      if (!sessionIds.includes(sessionId)) sessionIds.push(sessionId)
      meta.sessionIds = sessionIds
      if (!meta.sessionId) meta.sessionId = sessionId
      await writeMeta(db, row.id, meta)
    })
  }

  /**
   * Point the work at where it went (cloud-sharing.md §3a). The organization's
   * copy is the authority now, so a read or edit here answers `WORK_MOVED`. The
   * body, its history, comments, and reviews stay on this host: Share changes
   * the pointer and deletes nothing.
   */
  async moveTo(location: WorkLocation): Promise<void> {
    await getDatabase().transaction(async (db) => {
      const row = await workRow(db, this.#organizationId, this.id, true)
      if (!row) throw new Error(`Work not found: ${this.id}`)
      // The organization's copy is the authority now; its notifications are there.
      await removeNotificationsFor(db, row.organization_id, { kind: 'work', workId: this.id })
      await db.run(sql`UPDATE ${works} SET location = ${JSON.stringify(location)} WHERE id = ${this.id}`)
    })
  }

  /** Permanently remove the work, its revisions (by cascade), and its annotations. */
  async delete(): Promise<void> {
    await getDatabase().transaction(async (db) => {
      const row = await workRow(db, this.#organizationId, this.id, true)
      if (!row) throw new Error(`Work not found: ${this.id}`)
      await db.run(sql`DELETE FROM ${workAnnotations} WHERE work_id = ${this.id}`)
      await db.run(sql`DELETE FROM ${works} WHERE id = ${this.id}`)
      await removeNotificationsFor(db, row.organization_id, { kind: 'work', workId: this.id })
    })
  }
}
