import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import {
  type SessionRecord,
  type SessionRecordDelegation,
  type SessionRecordStatus,
  type SessionRecordUpsert,
  type SessionStatus,
} from '@solus/contracts/types'
import { getDatabase, type Db } from '../../db/database'
import { getDb, withTx } from '../../db'
import { removeAttachmentFolder } from '../assets/attachment-store'
import { ANY_ORGANIZATION, isAnyOrganization, LOCAL_ORGANIZATION_ID, type RecordScope } from '../../admission/principal'
import { scopeClause } from '../scope'
import { SESSION_LIST_IDLE_MS } from '@solus/contracts/session-state'
import { parseStoredStarter } from '@solus/contracts/session-starter'
import { aclEntry } from '../../sharing/schema'
import { deleteActivityFor } from '../activity/activity'
import { personalResourceState } from '../personal-state/schema'
import { forgetLeadSession } from './lead-sessions'
import { resourceLinks } from '../links/schema'
import { deleteEdgesOf } from '../links/resource-links'
import { session } from './schema'
import { machineSessionHome, sessionIdentityOf, type SessionHome } from './session-identity'
import { stateFromColumns, viewFromColumns } from './session-state-columns'
import { sessionTranscripts } from './transcript-schema'

/**
 * The collaboration plane's session records (docs/plans/cloud-service-model.md;
 * organization-scope §3), read and written on the one `session` row
 * (plans/029 §4.2). On a host the transcript indexer and the runtime write them
 * in-process as they learn about sessions; in the cloud a runner reports them
 * over `sessionRecordUpsert`. A record is a row whose provider has started:
 * every read here adds `started_at IS NOT NULL`, so a row only an admission or a
 * claim made (`session-identity.ts`) is not a record yet. Every record carries
 * its canonical organization: `local` while unassigned, else an organization id
 * assigned once and never changed. A read names its scope; a write names one
 * organization.
 */

const agentIdSchema = z.enum(['claude-code', 'codex', 'opencode', 'replay'])
const statusSchema = z.enum(['idle', 'running', 'interrupted'])
const publicationSchema = z.enum(['local', 'published'])
const reasoningEffortSchema = z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode'])
const recordRowSchema = z.object({
  session_id: z.string(),
  organization_id: z.string(),
  publication: publicationSchema.catch('local'),
  created_by: z.string(),
  provider: agentIdSchema,
  project_path: z.string(),
  project_remote: z.string().nullable(),
  runner_host_id: z.string().nullable(),
  title: z.string().nullable(),
  custom_title: z.string().nullable(),
  status: statusSchema,
  model: z.string().nullable(),
  reasoning_effort: reasoningEffortSchema.nullable().catch(null),
  parent_session_id: z.string().nullable(),
  root_session_id: z.string().nullable(),
  created_at: z.number(),
  last_activity_at: z.number(),
  size: z.number(),
  cwd: z.string().nullable(),
  slug: z.string().nullable(),
  is_worktree: z.number(),
  branch: z.string().nullable(),
  project_root: z.string().nullable(),
  delegation_message_id: z.string().nullable(),
  delegation_depth: z.number().nullable(),
  delegation_intent: z.enum(['delegate', 'fire_and_forget']).nullable().catch(null),
  delegation_created_at: z.number().nullable(),
  place: z.enum(['chat', 'project']).nullable().catch(null),
  started_by: z.string().nullable(),
  /** 1 when the session was started in Coordinator mode (`lead_started_at` set). */
  is_lead: z.coerce.number().optional(),
})

type RecordRow = z.infer<typeof recordRowSchema>

/** The row as stored, started or not: the provider facts are null until the first report. */
const storedRowSchema = recordRowSchema.extend({
  provider: agentIdSchema.nullable(),
  project_path: z.string().nullable(),
  started_at: z.number().nullable(),
})

const RECORD_COLUMN_NAMES = [
  'session_id', 'organization_id', 'publication', 'created_by', 'provider', 'project_path', 'project_remote', 'runner_host_id', 'title', 'custom_title',
  'status', 'model', 'reasoning_effort', 'parent_session_id', 'root_session_id', 'created_at', 'last_activity_at', 'size',
  'cwd', 'slug', 'is_worktree', 'branch', 'project_root', 'delegation_message_id', 'delegation_depth', 'delegation_intent', 'delegation_created_at',
  'place', 'started_by',
]
/** The lead mark (docs/plans/lead-session.md decision 4): every record read answers it, so the list can mark a Coordinator mode session. */
const LEAD_COLUMN = '(session_records.lead_started_at IS NOT NULL) AS is_lead'
const RECORD_COLUMNS = sql.raw([...RECORD_COLUMN_NAMES.map((name) => `session_records.${name}`), LEAD_COLUMN].join(', '))
/** The record's columns, its shared state, and the reader's view, for a read
 *  that joins the reader's `personal_resource_state` row as `reader_view`. */
const RECORD_WITH_STATE_COLUMNS = sql.raw([
  ...RECORD_COLUMN_NAMES.map((name) => `session_records.${name}`),
  LEAD_COLUMN,
  'session_records.settled_at', 'session_records.settled_by',
  'reader_view.settled_at AS view_settled_at', 'reader_view.archived_at', 'reader_view.snoozed_until', 'reader_view.snooze_note',
].join(', '))

/** A row is a record once its provider started; a row only an admission or a claim made is not listed. */
const STARTED = sql.raw('session_records.started_at IS NOT NULL')

const recordWithStateRowSchema = recordRowSchema.extend({
  settled_at: z.number().nullable(),
  settled_by: z.enum(['person', 'pull-request', 'task', 'idle']).nullable(),
  view_settled_at: z.number().nullable(),
  archived_at: z.number().nullable(),
  snoozed_until: z.number().nullable(),
  snooze_note: z.string().nullable(),
  shared_by: z.string().nullable(),
  granted_at: z.coerce.number().nullable(),
  listed: z.coerce.number(),
})

/**
 * The latest direct share of the session that names the reader — a `user`
 * entry for them or a `team` entry for a team they are in — as one column of it
 * (docs/plans/shared-with-you.md §4.2). An organization entry and a link are not
 * direct shares: they give access, not a place in the list. Null when none.
 */
function directShare(reader: SessionPageReader, column: SQL): SQL {
  const { personKey, teamIds = [], now } = reader
  if (!personKey) return sql`NULL`
  const subjects = [sql`(acl.subject_kind = 'user' AND acl.subject_id = ${personKey})`]
  if (teamIds.length) subjects.push(sql`(acl.subject_kind = 'team' AND acl.subject_id IN (${sql.join(teamIds.map((teamId) => sql`${teamId}`), sql`, `)}))`)
  return sql`(SELECT ${column} FROM ${aclEntry} AS acl
    WHERE acl.resource_kind = 'session' AND acl.resource_id = session_records.session_id
      AND (${sql.join(subjects, sql` OR `)}) AND (acl.expires_at IS NULL OR acl.expires_at > ${now})
    ORDER BY COALESCE(acl.granted_at, acl.created_at) DESC LIMIT 1)`
}

const GRANTED_AT = sql`COALESCE(acl.granted_at, acl.created_at)`

/**
 * A pull request link that keeps its session in the list: not dismissed, and
 * not ended. The stored bit `keeps_session` says so (plans/029 §5.1), and the
 * partial index `resource_links_open_session (source_id, organization_id)`
 * covers this read; add no other predicate here without rechecking EXPLAIN.
 */
const OPEN_PULL_REQUEST = sql.raw('resource_links.keeps_session = 1')

/** The reader's own `personal_resource_state` row for the session, joined as `reader_view`. */
function readerViewJoin(reader: SessionPageReader): SQL {
  return sql`LEFT JOIN ${personalResourceState} AS reader_view
    ON reader_view.resource_kind = 'session' AND reader_view.resource_id = session_records.session_id
    AND reader_view.organization_id = session_records.organization_id AND reader_view.created_by = ${reader.personKey ?? ''}`
}

/**
 * Whether a session is in the reader's list (docs/plans/session-archive.md):
 * it is the reader's — they own it, or they prompted it (a prompt leaves their
 * personal-state row) — they did not archive it, and it was active recently, they snoozed it, or it
 * waits on an open pull request. Reads the `reader_view` row the page joins for the reader.
 *
 * A direct share lists the session too, until the reader archives it; a grant
 * made after that archive lists it again (docs/plans/shared-with-you.md §2).
 * Its grant counts as activity, so a session shared today is listed however
 * old it is.
 */
export function sessionListedClause(reader: SessionPageReader): SQL {
  const { personKey, now } = reader
  const since = now - SESSION_LIST_IDLE_MS
  const grantedAt = directShare(reader, GRANTED_AT)
  const active = sql`(
    session_records.last_activity_at >= ${since}
    OR reader_view.snoozed_until IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM ${resourceLinks}
      WHERE resource_links.source_id = session_records.session_id AND resource_links.organization_id = session_records.organization_id AND ${OPEN_PULL_REQUEST}
    )
  )`
  return sql`((reader_view.archived_at IS NULL
  AND (session_records.created_by = ${personKey ?? ''} OR reader_view.created_by IS NOT NULL)
  AND ${active})
  OR (${grantedAt} > COALESCE(reader_view.archived_at, -1)
  AND (${active} OR ${grantedAt} >= ${since})))`
}

function delegationFromRow(row: RecordRow): SessionRecordDelegation | null {
  if (row.delegation_message_id === null || row.delegation_depth === null || row.delegation_intent === null || row.delegation_created_at === null) return null
  return { messageId: row.delegation_message_id, depth: row.delegation_depth, intent: row.delegation_intent, createdAt: row.delegation_created_at }
}

function recordFromRow(row: RecordRow): SessionRecord {
  const record: SessionRecord = {
    sessionId: row.session_id,
    organizationId: row.organization_id,
    publication: row.publication,
    ownerKey: row.created_by,
    provider: row.provider,
    projectPath: row.project_path,
    projectRemote: row.project_remote,
    runnerHostId: row.runner_host_id,
    title: row.title,
    customTitle: row.custom_title,
    status: row.status,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    parentSessionId: row.parent_session_id,
    rootSessionId: row.root_session_id,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    size: row.size,
    cwd: row.cwd,
    slug: row.slug,
    isWorktree: row.is_worktree === 1,
    branch: row.branch,
    projectRoot: row.project_root,
    delegation: delegationFromRow(row),
    place: row.place,
    startedBy: parseStoredStarter(row.started_by),
  }
  if (row.is_lead === 1) record.isLead = true
  return record
}

async function readRecord(db: Db, scope: RecordScope, sessionId: string): Promise<SessionRecord | null> {
  const row = recordRowSchema.nullish().parse(await db.get(sql`
    SELECT ${RECORD_COLUMNS} FROM ${session}
    WHERE ${scopeClause(scope)} AND session_id = ${sessionId} AND ${STARTED}
  `))
  const record = row ? recordFromRow(row) : null
  remember(record)
  return record
}

export async function getSessionRecord(scope: RecordScope, sessionId: string): Promise<SessionRecord | null> {
  return readRecord(getDatabase(), scope, sessionId)
}

/**
 * Whether a session is its organization's work: published to the
 * organization's Solus API, which is then its home. A session's organization
 * alone is the organization of the person who started it, and makes it
 * neither shared nor the organization's (docs/plans/organization-scope.md §3).
 */
export function isOrganizationWork<T extends Pick<SessionRecord, 'organizationId' | 'publication'>>(record: T | null | undefined): record is T {
  return !!record && record.organizationId !== LOCAL_ORGANIZATION_ID && record.publication === 'published'
}

/** Whether a session is its organization's work, also before its provider started: the row says so from its admission. */
export async function sessionIsOrganizationWork(sessionId: string): Promise<boolean> {
  return isOrganizationWork(await sessionIdentityOf(sessionId))
}

/** The records of many sessions in one read, by session id; a session with no record is absent. */
export async function getSessionRecords(scope: RecordScope, sessionIds: readonly string[]): Promise<Map<string, SessionRecord>> {
  const unique = [...new Set(sessionIds)]
  if (!unique.length) return new Map()
  const rows = recordRowSchema.array().parse(await getDatabase().all(sql`
    SELECT ${RECORD_COLUMNS} FROM ${session}
    WHERE ${scopeClause(scope)} AND session_id IN (${sql.join(unique.map((id) => sql`${id}`), sql`, `)}) AND ${STARTED}
  `))
  const records = new Map<string, SessionRecord>()
  for (const row of rows) {
    const record = recordFromRow(row)
    remember(record)
    records.set(record.sessionId, record)
  }
  return records
}

/** Who reads a page: their person key, for their own view and list; null for a reader who is no person. */
export interface SessionPageReader {
  personKey: string | null
  /** The teams the reader is in, which a team share names. */
  teamIds?: readonly string[]
  now: number
}

/**
 * Scoped, authorized seek predicate is applied before LIMIT. The seek must use the same time column.
 * Each record carries its shared state and the reader's view (docs/plans/session-archive.md),
 * read in the same query, and whether it is in the reader's list. For the list itself, use
 * `readSessionListPage`.
 */
export async function readSessionMetadataPage(where: SQL, limit: number, time: 'created_at' | 'last_activity_at' = 'created_at', reader: SessionPageReader = { personKey: null, now: Date.now() }): Promise<SessionRecord[]> {
  return readPage(sql`FROM ${session}`, sql`${where} AND ${STARTED}`, sql`CASE WHEN ${sessionListedClause(reader)} THEN 1 ELSE 0 END`, limit, time, reader)
}

/**
 * The ids that can be in the reader's list, each way in read by its own index:
 * recent activity, the reader's snoozes, open pull requests, and the reader's
 * direct shares. Each part of `sessionListedClause` needs one of them, so this
 * is a superset of the list, and small: it never holds an old, quiet session
 * nobody shared.
 */
function listCandidates(where: SQL, reader: SessionPageReader): SQL {
  const { personKey, teamIds = [], now } = reader
  const parts = [
    sql`SELECT session_id FROM ${session} WHERE last_activity_at >= ${now - SESSION_LIST_IDLE_MS} AND ${where}`,
    sql`SELECT resource_id AS session_id FROM ${personalResourceState} WHERE created_by = ${personKey ?? ''} AND resource_kind = 'session' AND snoozed_until IS NOT NULL`,
    sql`SELECT source_id AS session_id FROM ${resourceLinks} WHERE ${OPEN_PULL_REQUEST}`,
  ]
  if (personKey) {
    const subjects = [sql`(subject_kind = 'user' AND subject_id = ${personKey})`]
    if (teamIds.length) subjects.push(sql`(subject_kind = 'team' AND subject_id IN (${sql.join(teamIds.map((teamId) => sql`${teamId}`), sql`, `)}))`)
    parts.push(sql`SELECT resource_id FROM ${aclEntry} WHERE resource_kind = 'session' AND (${sql.join(subjects, sql` OR `)})`)
  }
  return sql.join(parts, sql` UNION `)
}

/**
 * One page of the reader's list (docs/plans/session-archive.md): the records
 * `readSessionMetadataPage` answers with `sessionListedClause` in `where`. It
 * picks the page's ids from `listCandidates` instead of every record, then
 * builds full rows for those ids alone. `where` names only `session`
 * columns, since it also narrows the recent ids, and not `sessionListedClause`
 * itself. Every row is listed.
 */
export async function readSessionListPage(where: SQL, limit: number, time: 'created_at' | 'last_activity_at', reader: SessionPageReader): Promise<SessionRecord[]> {
  const order = sql`ORDER BY session_records.${sql.identifier(time)} DESC, session_records.session_id DESC`
  // CROSS JOIN keeps the left side the outer loop on SQLite, so each record is one primary key read.
  const ids = sql`SELECT session_records.session_id FROM (${listCandidates(where, reader)}) AS list_candidates
    CROSS JOIN ${session}
    ${readerViewJoin(reader)}
    WHERE session_records.session_id = list_candidates.session_id AND ${where} AND ${STARTED} AND ${sessionListedClause(reader)}
    ${order} LIMIT ${limit}`
  return readPage(sql`FROM (${ids}) AS list_page CROSS JOIN ${session}`, sql`session_records.session_id = list_page.session_id`, sql`1`, limit, time, reader)
}

async function readPage(from: SQL, where: SQL, listed: SQL, limit: number, time: 'created_at' | 'last_activity_at', reader: SessionPageReader): Promise<SessionRecord[]> {
  const rows = recordWithStateRowSchema.array().parse(await getDatabase().all(sql`
    SELECT ${RECORD_WITH_STATE_COLUMNS},
      ${directShare(reader, sql`acl.created_by`)} AS shared_by, ${directShare(reader, GRANTED_AT)} AS granted_at,
      ${listed} AS listed
    ${from}
    ${readerViewJoin(reader)}
    WHERE ${where} ORDER BY session_records.${sql.identifier(time)} DESC, session_records.session_id DESC LIMIT ${limit}
  `))
  return rows.map((row) => {
    const record: SessionRecord = { ...recordFromRow(row), state: stateFromColumns(row), view: viewFromColumns(row), listed: row.listed === 1 }
    // Only another person's session carries its share: the owner's own is never "shared with you".
    if (row.shared_by !== null && row.granted_at !== null && row.created_by !== reader.personKey) {
      record.sharedBy = row.shared_by
      record.grantedAt = row.granted_at
    }
    return record
  })
}

/**
 * Writes to one record apply in the order they were asked for. A start report is
 * a read-merge-write while a status change is one update; without this, a
 * turn that settles quickly could see its start report land after its settle
 * and leave the record `running`.
 */
const inFlight = new Map<string, Promise<unknown>>()

function serialized<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
  const previous = inFlight.get(sessionId) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(work)
  inFlight.set(sessionId, next)
  void next.catch(() => undefined).finally(() => {
    if (inFlight.get(sessionId) === next) inFlight.delete(sessionId)
  })
  return next
}

type SessionRecordListener = (record: SessionRecord) => void
const changedListeners = new Set<SessionRecordListener>()

/**
 * Hear every change this host makes to one of its own records, with the whole
 * record as stored: how the runner delivery reports them to the Solus API
 * (organization-scope §6). A record another runner reported into the service
 * (`runnerHostId` set) is not this host's own fact to forward again.
 */
export function onSessionRecordChanged(listener: SessionRecordListener): () => void {
  changedListeners.add(listener)
  return () => changedListeners.delete(listener)
}

function emitChanged(record: SessionRecord | null): void {
  remember(record)
  if (!record || record.runnerHostId !== null) return
  for (const listener of changedListeners) listener(record)
}

/** The stored record after a partial write, handed to the listeners. */
async function emitStored(sessionId: string): Promise<void> {
  if (changedListeners.size === 0) return
  emitChanged(await getSessionRecord(ANY_ORGANIZATION, sessionId))
}

/** The reported value when one was given (null included), else what is stored, else nothing. */
function reported<T>(next: T | null | undefined, stored: T | null | undefined): T | null {
  if (next !== undefined) return next
  return stored ?? null
}

/**
 * The home the report's record is born with when no row exists yet
 * (organization-vms §3; `runner-intake.ts`): its organization, and for a
 * runner's report of an organization session, published and owned by the
 * person the API admitted or the person delivering.
 */
export interface SessionBirth {
  organizationId: string
  published?: boolean
  ownerKey?: string
}

/** A session the plane has not seen: every fact absent, born at the report's own time, in its birth home when one was named. */
function firstRecord(organizationId: string, input: SessionRecordUpsert, birth: SessionBirth | null): SessionRecord {
  return {
    sessionId: input.sessionId,
    organizationId,
    publication: birth?.published ? 'published' : 'local',
    ownerKey: birth?.ownerKey ?? machineSessionHome().ownerKey,
    provider: input.provider,
    projectPath: input.projectPath,
    projectRemote: null,
    runnerHostId: null,
    title: null,
    customTitle: null,
    status: 'idle',
    model: null,
    reasoningEffort: null,
    parentSessionId: null,
    rootSessionId: null,
    createdAt: input.createdAt ?? input.lastActivityAt,
    lastActivityAt: 0,
    size: 0,
    cwd: null,
    slug: null,
    isWorktree: false,
    branch: null,
    projectRoot: null,
    delegation: null,
    place: null,
    startedBy: null,
  }
}

/**
 * Write what the caller knows. A field left out keeps the stored value, so the
 * indexer's sweep and the runtime's status report never erase each other's
 * facts; a field given as null clears it. The organization, the owner, and the
 * publication state are the stored row's, never the report's.
 */
function mergeRecord(existing: SessionRecord | null, organizationId: string, input: SessionRecordUpsert, birth: SessionBirth | null): SessionRecord {
  const stored = existing ?? firstRecord(organizationId, input, birth)
  return {
    sessionId: input.sessionId,
    organizationId: stored.organizationId,
    publication: stored.publication,
    ownerKey: stored.ownerKey,
    provider: input.provider,
    projectPath: input.projectPath,
    projectRemote: reported(input.projectRemote, stored.projectRemote),
    runnerHostId: reported(input.runnerHostId, stored.runnerHostId),
    title: reported(input.title, stored.title),
    customTitle: reported(input.customTitle, stored.customTitle),
    status: input.status ?? stored.status,
    model: reported(input.model, stored.model),
    reasoningEffort: reported(input.reasoningEffort, stored.reasoningEffort),
    parentSessionId: reported(input.parentSessionId, stored.parentSessionId),
    rootSessionId: reported(input.rootSessionId, stored.rootSessionId),
    createdAt: stored.createdAt,
    lastActivityAt: Math.max(input.lastActivityAt, stored.lastActivityAt),
    size: input.size ?? stored.size,
    cwd: reported(input.cwd, stored.cwd),
    slug: reported(input.slug, stored.slug),
    isWorktree: input.isWorktree ?? stored.isWorktree,
    branch: reported(input.branch, stored.branch),
    projectRoot: reported(input.projectRoot, stored.projectRoot),
    delegation: reported(input.delegation, stored.delegation),
    // Written once, by the write that knows them (session-starter.md §3); a later report never changes them.
    place: stored.place ?? input.place ?? null,
    startedBy: stored.startedBy ?? input.startedBy ?? null,
  }
}

/**
 * A report into one organization: a runner's on the Solus API, or a member's on
 * a host. A row that exists in another organization is not touched — a
 * session id names one row, and its organization never moves. `birth`
 * applies only when the report creates the row.
 */
export function upsertSessionRecord(organizationId: string, input: SessionRecordUpsert, birth?: SessionBirth): Promise<SessionRecord> {
  return serialized(input.sessionId, () => upsertRecordNow(organizationId, input, birth ?? null))
}

/**
 * The host's own writers — the indexer, the runtime — report what they saw of a
 * session on this disk. The row keeps the home it has; a session nobody
 * claimed or admitted yet starts as this machine's own (R9).
 */
export function upsertOwnSessionRecord(input: SessionRecordUpsert): Promise<SessionRecord> {
  return serialized(input.sessionId, () => upsertRecordNow(ANY_ORGANIZATION, input, null))
}

/**
 * The row as stored, whether or not its provider started: what a report merges
 * into. An unstarted row has no provider facts; the report's stand in so the
 * merge has a whole record to start from, and the report then writes them.
 */
async function readStoredRecord(db: Db, scope: RecordScope, input: SessionRecordUpsert): Promise<{ record: SessionRecord; startedAt: number | null } | null> {
  const row = storedRowSchema.nullish().parse(await db.get(sql`
    SELECT ${RECORD_COLUMNS}, session_records.started_at FROM ${session}
    WHERE ${scopeClause(scope)} AND session_id = ${input.sessionId}
  `))
  if (!row) return null
  return { record: recordFromRow({ ...row, provider: row.provider ?? input.provider, project_path: row.project_path ?? input.projectPath }), startedAt: row.started_at }
}

async function upsertRecordNow(scope: RecordScope, input: SessionRecordUpsert, birth: SessionBirth | null): Promise<SessionRecord> {
  const now = Date.now()
  const merged = await getDatabase().transaction(async (db) => {
    const stored = await readStoredRecord(db, scope, input)
    const organizationId = isAnyOrganization(scope) ? birth?.organizationId ?? machineSessionHome().organizationId : scope
    const merged = mergeRecord(stored?.record ?? null, organizationId, input, birth)
    // The first report starts the session; a later one never moves `started_at`,
    // and never names the owner, the organization, or the publication.
    await db.run(sql`
      INSERT INTO ${session} (
        session_id, organization_id, created_by, publication, started_at, provider, project_path, project_remote, runner_host_id,
        title, custom_title, status, model, reasoning_effort, parent_session_id, root_session_id,
        created_at, last_activity_at, size,
        cwd, slug, is_worktree, branch, project_root, delegation_message_id, delegation_depth, delegation_intent, delegation_created_at,
        place, started_by
      ) VALUES (
        ${merged.sessionId}, ${merged.organizationId}, ${merged.ownerKey}, ${merged.publication}, ${now}, ${merged.provider}, ${merged.projectPath},
        ${merged.projectRemote}, ${merged.runnerHostId}, ${merged.title}, ${merged.customTitle}, ${merged.status},
        ${merged.model}, ${merged.reasoningEffort}, ${merged.parentSessionId}, ${merged.rootSessionId},
        ${merged.createdAt}, ${merged.lastActivityAt}, ${merged.size},
        ${merged.cwd}, ${merged.slug}, ${merged.isWorktree ? 1 : 0}, ${merged.branch}, ${merged.projectRoot},
        ${merged.delegation?.messageId ?? null}, ${merged.delegation?.depth ?? null}, ${merged.delegation?.intent ?? null}, ${merged.delegation?.createdAt ?? null},
        ${merged.place}, ${merged.startedBy ? JSON.stringify(merged.startedBy) : null}
      )
      ON CONFLICT(session_id) DO UPDATE SET
        started_at = COALESCE(session_records.started_at, excluded.started_at),
        provider = excluded.provider,
        project_path = excluded.project_path,
        project_remote = excluded.project_remote,
        runner_host_id = excluded.runner_host_id,
        title = excluded.title,
        custom_title = excluded.custom_title,
        status = excluded.status,
        model = excluded.model,
        reasoning_effort = excluded.reasoning_effort,
        parent_session_id = excluded.parent_session_id,
        root_session_id = excluded.root_session_id,
        last_activity_at = excluded.last_activity_at,
        size = excluded.size,
        cwd = excluded.cwd,
        slug = excluded.slug,
        is_worktree = excluded.is_worktree,
        branch = excluded.branch,
        project_root = excluded.project_root,
        delegation_message_id = excluded.delegation_message_id,
        delegation_depth = excluded.delegation_depth,
        delegation_intent = excluded.delegation_intent,
        delegation_created_at = excluded.delegation_created_at,
        place = COALESCE(session_records.place, excluded.place),
        started_by = COALESCE(session_records.started_by, excluded.started_by)
      WHERE session_records.organization_id = excluded.organization_id
    `)
    return merged
  })
  emitChanged(merged)
  return merged
}

/**
 * The one-time assignment of an unassigned row (organization-scope §3, R10):
 * `local` becomes `organizationId`, once, started or not; with `published` and
 * `admittedAt`, the row also takes the admission the Solus API accepted, as an
 * attached machine decides for a session a watch claimed Local first. The owner
 * never changes. Answers the session's home as it now stands, whether this call
 * assigned it or it already belonged to that organization; null when the row is
 * another organization's or does not exist.
 */
export function assignSessionOrganization(sessionId: string, organizationId: string, options: { published?: boolean; admittedAt?: number } = {}): Promise<SessionHome | null> {
  return serialized(sessionId, async () => {
    const identity = await sessionIdentityOf(sessionId)
    if (!identity) return null
    if (organizationId === LOCAL_ORGANIZATION_ID) return identity.organizationId === LOCAL_ORGANIZATION_ID ? identity : null
    const result = await getDatabase().run(sql`
      UPDATE ${session} SET organization_id = ${organizationId},
        publication = ${options.published ? 'published' : sql`publication`},
        admitted_at = COALESCE(admitted_at, ${options.admittedAt ?? null})
      WHERE session_id = ${sessionId} AND organization_id = ${LOCAL_ORGANIZATION_ID}
    `)
    organizationBySession.delete(sessionId)
    if (result.changes > 0) await emitStored(sessionId)
    const assigned = await sessionIdentityOf(sessionId)
    return assigned?.organizationId === organizationId ? assigned : null
  })
}

/** The transcript reached the Solus API (organization-scope §7): the record says so from now on. */
export function markSessionPublished(sessionId: string): Promise<void> {
  return serialized(sessionId, async () => {
    const result = await getDatabase().run(sql`
      UPDATE ${session} SET publication = 'published'
      WHERE session_id = ${sessionId} AND publication <> 'published' AND organization_id <> ${LOCAL_ORGANIZATION_ID}
    `)
    if (result.changes > 0) await emitStored(sessionId)
  })
}

/**
 * The host tables that name a session cannot reference the ported row (on the
 * Postgres engine it is in another database): the session's execution ledger,
 * its open questions, and its mirror cursors go with it here.
 */
function deleteHostRowsOfSession(sessionId: string): void {
  withTx(() => {
    const db = getDb()
    for (const table of ['runs', 'run_queue', 'async_questions', 'transcript_mirror_rows', 'activity_mirror_rows']) {
      db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId)
    }
    db.prepare('DELETE FROM run_exchanges WHERE sender_session_id = ? OR target_session_id = ?').run(sessionId, sessionId)
  })
}

/**
 * The transcript is gone from the runner and nothing else holds the session:
 * the row goes, and everything of the session with it (plans/029 §4.1). Its
 * edges (`resource_links`: its pull requests with their watches, its links, its
 * memberships, and the tasks' edges to it), the personal state, the activity, and
 * the mirrored transcript rows have no foreign key and are deleted here.
 */
export function deleteSessionRecord(scope: RecordScope, sessionId: string): Promise<void> {
  return serialized(sessionId, async () => {
    const removed = await getDatabase().transaction(async (db) => {
      const removed = (await db.run(sql`
        DELETE FROM ${session} WHERE ${scopeClause(scope)} AND session_id = ${sessionId}
      `)).changes > 0
      if (!removed) return false
      await deleteEdgesOf(db, 'session', sessionId)
      await db.run(sql`DELETE FROM ${personalResourceState} WHERE resource_kind = 'session' AND resource_id = ${sessionId}`)
      await db.run(sql`DELETE FROM ${sessionTranscripts} WHERE session_id = ${sessionId}`)
      await deleteActivityFor({ kind: 'session', id: sessionId }, db)
      return true
    })
    organizationBySession.delete(sessionId)
    forgetLeadSession(sessionId)
    if (removed) {
      deleteHostRowsOfSession(sessionId)
      await removeAttachmentFolder(sessionId)
    }
  })
}

/**
 * The record's status as the runtime reports it: one UPDATE, which also lands
 * on a row admitted before its start. The row comes back with the write, so
 * the listeners hear the stored record without a second read; a row whose
 * provider has not started is no record yet, and is not announced.
 */
export function setSessionRecordStatus(scope: RecordScope, sessionId: string, status: SessionRecordStatus): Promise<void> {
  return serialized(sessionId, async () => {
    const rows = storedRowSchema.array().parse(await getDatabase().all(sql`
      UPDATE ${session} SET status = ${status}, last_activity_at = ${Date.now()}
      WHERE ${scopeClause(scope)} AND session_id = ${sessionId}
      RETURNING ${RECORD_COLUMNS}, session_records.started_at
    `))
    const row = rows[0]
    if (row && row.started_at !== null) emitChanged(recordFromRow(recordRowSchema.parse(row)))
  })
}

export function setSessionRecordBranch(sessionId: string, branch: string): Promise<void> {
  return serialized(sessionId, async () => {
    const result = await getDatabase().run(sql`
      UPDATE ${session} SET branch = ${branch} WHERE session_id = ${sessionId}
    `)
    if (result.changes > 0) await emitStored(sessionId)
  })
}

export function setSessionRecordTitle(scope: RecordScope, sessionId: string, customTitle: string | null): Promise<void> {
  return serialized(sessionId, async () => {
    const result = await getDatabase().run(sql`
      UPDATE ${session} SET custom_title = ${customTitle}
      WHERE ${scopeClause(scope)} AND session_id = ${sessionId}
    `)
    if (result.changes > 0) await emitStored(sessionId)
  })
}

/** A generated name cannot replace a name the person set while generation ran. */
export function setSessionRecordGeneratedTitle(sessionId: string, title: string): Promise<boolean> {
  return serialized(sessionId, async () => {
    const result = await getDatabase().run(sql`
      UPDATE ${session} SET custom_title = ${title}
      WHERE session_id = ${sessionId} AND custom_title IS NULL
    `)
    if (result.changes > 0) await emitStored(sessionId)
    return result.changes > 0
  })
}

/**
 * At boot, a record this host reported as `running` names a turn its previous
 * process never settled. Only the host's own records, whatever their
 * organization: a record another runner reported is that runner's to settle.
 * Returns the sessions it marked, so the sessions waiting on them can be told.
 */
export async function markOwnRunningSessionRecordsInterrupted(): Promise<string[]> {
  const rows = z.array(z.object({ session_id: z.string() })).parse(await getDatabase().all(sql`
    UPDATE ${session} SET status = 'interrupted'
    WHERE status = 'running' AND runner_host_id IS NULL
    RETURNING session_id
  `))
  return rows.map((row) => row.session_id)
}

/** This host's own published organization sessions: what it sends its Solus API once at boot. */
export async function ownPublishedSessionIds(): Promise<string[]> {
  const rows = z.array(z.object({ session_id: z.string() })).parse(await getDatabase().all(sql`
    SELECT session_id FROM ${session}
    WHERE publication = 'published' AND runner_host_id IS NULL AND organization_id <> ${LOCAL_ORGANIZATION_ID} AND ${STARTED}
  `))
  return rows.map((row) => row.session_id)
}

/** What a runtime status means to the record: a turn open, or not. */
export function sessionRecordStatusOf(status: SessionStatus): SessionRecordStatus {
  switch (status) {
    case 'connecting':
    case 'running':
    case 'awaiting_input':
    case 'awaiting_plan':
    case 'rate_limited':
      return 'running'
    case 'interrupted':
      return 'interrupted'
    case 'idle':
    case 'completed':
    case 'background':
    case 'failed':
    case 'dead':
      return 'idle'
  }
}

/**
 * Whether this host's records hold every session on its disk yet. Boot
 * installs the transcript indexer's answer; the workspace service keeps the
 * default, because its records arrive from runners and have no first sweep.
 */
let indexComplete: () => boolean = () => true

export function useSessionIndexState(isComplete: () => boolean): void {
  indexComplete = isComplete
}

/** True while the first index sweep runs: a list read now is not every session. */
export function sessionRecordsIndexing(): boolean {
  return !indexComplete()
}

/**
 * The organization a session's owned children inherit (organization-scope §3):
 * the row's, started or not, or this machine's own when no row names the
 * session yet.
 */
export async function organizationOfSession(sessionId: string): Promise<string> {
  const known = organizationBySession.get(sessionId)
  if (known) return known
  const row = z.object({ organization_id: z.string() }).nullish().parse(await getDatabase().get(sql`
    SELECT organization_id FROM ${session} WHERE session_id = ${sessionId}
  `))
  // A miss is not remembered: the row may be born later, in a home this machine's is not.
  if (!row) return machineSessionHome().organizationId
  organizationBySession.set(sessionId, row.organization_id)
  return row.organization_id
}

/**
 * The organization of every row this process wrote or read, so a turn's spans
 * learn their organization without a read per turn. A row's organization
 * changes at most once, from Local (`assignSessionOrganization`), which forgets it.
 */
const organizationBySession = new Map<string, string>()

function remember(record: SessionRecord | null): void {
  if (record) organizationBySession.set(record.sessionId, record.organizationId)
}

/** The same for many sessions at once; a session with no row maps to this machine's organization. */
export async function organizationsOfSessions(sessionIds: readonly string[]): Promise<Map<string, string>> {
  const fallback = machineSessionHome().organizationId
  const result = new Map<string, string>(sessionIds.map((id) => [id, fallback]))
  const unique = [...new Set(sessionIds)]
  if (unique.length === 0) return result
  const rows = z.array(z.object({ session_id: z.string(), organization_id: z.string() })).parse(await getDatabase().all(sql`
    SELECT session_id, organization_id FROM ${session}
    WHERE session_id IN (${sql.join(unique.map((id) => sql`${id}`), sql`, `)})
  `))
  for (const row of rows) result.set(row.session_id, row.organization_id)
  return result
}

/** A session a home's PR sync keeps fresh: an organization session that is not
 *  settled, active recently, on a branch of a known repository. */
export interface LiveSessionBranch {
  sessionId: string
  /** The repository key (`host/owner/repo`) its runner reported. */
  repositoryKey: string
  branch: string
  ownerKey: string
  isRunning: boolean
}

/** The live organization sessions whose branches PR sync asks about (docs/plans/session-archive.md). */
export async function liveSessionBranches(activeSince: number): Promise<LiveSessionBranch[]> {
  const rows = z.object({
    session_id: z.string(), project_remote: z.string(), branch: z.string(), created_by: z.string(), status: z.string(),
  }).array().parse(await getDatabase().all(sql`
    SELECT session_id, project_remote, branch, created_by, status
    FROM ${session}
    WHERE organization_id <> ${LOCAL_ORGANIZATION_ID}
      AND project_remote IS NOT NULL AND branch IS NOT NULL
      AND last_activity_at >= ${activeSince}
      AND settled_at IS NULL AND ${STARTED}
  `))
  return rows.map((row) => ({
    sessionId: row.session_id, repositoryKey: row.project_remote, branch: row.branch, ownerKey: row.created_by, isRunning: row.status === 'running',
  }))
}
