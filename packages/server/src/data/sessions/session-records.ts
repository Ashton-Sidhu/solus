import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import {
  encodePathAsFolder,
  isSolusWorktreePath,
  SOLUS_WORKTREE_ENCODED_MARKER,
  type AgentId,
  type SessionRecord,
  type SessionRecordDelegation,
  type SessionRecordStatus,
  type SessionRecordUpsert,
  type SessionStatus,
} from '@solus/contracts/types'
import { getDatabase, type Db } from '../../db/database'
import { ANY_ORGANIZATION, isAnyOrganization, LOCAL_ORGANIZATION_ID, type RecordScope } from '../../admission/principal'
import { provisionedOrganizationId } from '../../host/host-category'
import { hostUserKey } from '../../host/host-user'
import { scopeClause } from '../scope'
import { SESSION_LIST_IDLE_MS } from '@solus/contracts/session-state'
import { sessionPullRequests, sessionRecords, sessionStates, sessionViews } from './schema'
import { stateFromColumns, viewFromColumns } from './session-state-columns'

/**
 * The collaboration plane's session records
 * (docs/plans/cloud-service-model.md; organization-scope §3). On a host the
 * transcript indexer and the runtime write them in-process as they learn about
 * sessions; in the cloud a runner reports them over `sessionRecordUpsert`. Every
 * record carries its canonical organization: `local` while unassigned, else an
 * organization id assigned once and never changed. A read names its scope; a
 * write names one organization.
 */

const agentIdSchema = z.enum(['claude-code', 'codex', 'opencode'])
const statusSchema = z.enum(['idle', 'running', 'interrupted'])
const publicationSchema = z.enum(['local', 'published'])
const reasoningEffortSchema = z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode'])
const recordRowSchema = z.object({
  session_id: z.string(),
  organization_id: z.string(),
  publication: publicationSchema.catch('local'),
  owner_key: z.string(),
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
})

type RecordRow = z.infer<typeof recordRowSchema>

const RECORD_COLUMN_NAMES = [
  'session_id', 'organization_id', 'publication', 'owner_key', 'provider', 'project_path', 'project_remote', 'runner_host_id', 'title', 'custom_title',
  'status', 'model', 'reasoning_effort', 'parent_session_id', 'root_session_id', 'created_at', 'last_activity_at', 'size',
  'cwd', 'slug', 'is_worktree', 'branch', 'project_root', 'delegation_message_id', 'delegation_depth', 'delegation_intent', 'delegation_created_at',
]
const RECORD_COLUMNS = sql.raw(RECORD_COLUMN_NAMES.join(', '))
/** The record's columns, its shared state, and the reader's view, for a read
 *  that joins `session_states` and `session_views`. */
const RECORD_WITH_STATE_COLUMNS = sql.raw([
  ...RECORD_COLUMN_NAMES.map((name) => `session_records.${name}`),
  'session_states.settled_at', 'session_states.settled_by',
  'session_views.archived_at', 'session_views.snoozed_until', 'session_views.snooze_note',
].join(', '))

const recordWithStateRowSchema = recordRowSchema.extend({
  settled_at: z.number().nullable(),
  settled_by: z.enum(['person', 'pull-request', 'task', 'idle']).nullable(),
  archived_at: z.number().nullable(),
  snoozed_until: z.number().nullable(),
  snooze_note: z.string().nullable(),
  listed: z.coerce.number(),
})

/**
 * Whether a session is in the reader's list (docs/plans/session-archive.md):
 * it is the reader's — they own it, or they prompted it (a prompt leaves their
 * view row) — they did not archive it, and it was active recently, they snoozed it, or it
 * waits on an open pull request. Reads the `session_views` row the page
 * joins for the reader.
 */
export function sessionListedClause(reader: SessionPageReader): SQL {
  const { personKey, now } = reader
  return sql`(session_views.archived_at IS NULL
  AND (session_records.owner_key = ${personKey ?? ''} OR session_views.person_key IS NOT NULL)
  AND (
    session_records.last_activity_at >= ${now - SESSION_LIST_IDLE_MS}
    OR session_views.snoozed_until IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM ${sessionPullRequests}
      WHERE session_pull_requests.session_id = session_records.session_id
        AND session_pull_requests.source <> 'dismissed'
        AND (session_pull_requests.pr_state IS NULL OR session_pull_requests.pr_state NOT IN ('merged', 'closed', 'missing'))
    )
  ))`
}

function delegationFromRow(row: RecordRow): SessionRecordDelegation | null {
  if (row.delegation_message_id === null || row.delegation_depth === null || row.delegation_intent === null || row.delegation_created_at === null) return null
  return { messageId: row.delegation_message_id, depth: row.delegation_depth, intent: row.delegation_intent, createdAt: row.delegation_created_at }
}

function recordFromRow(row: RecordRow): SessionRecord {
  return {
    sessionId: row.session_id,
    organizationId: row.organization_id,
    publication: row.publication,
    ownerKey: row.owner_key,
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
  }
}

async function readRecord(db: Db, scope: RecordScope, sessionId: string): Promise<SessionRecord | null> {
  const row = recordRowSchema.nullish().parse(await db.get(sql`
    SELECT ${RECORD_COLUMNS} FROM ${sessionRecords}
    WHERE ${scopeClause(scope)} AND session_id = ${sessionId}
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

/** The records of many sessions in one read, by session id; a session with no record is absent. */
export async function getSessionRecords(scope: RecordScope, sessionIds: readonly string[]): Promise<Map<string, SessionRecord>> {
  const unique = [...new Set(sessionIds)]
  if (!unique.length) return new Map()
  const rows = recordRowSchema.array().parse(await getDatabase().all(sql`
    SELECT ${RECORD_COLUMNS} FROM ${sessionRecords}
    WHERE ${scopeClause(scope)} AND session_id IN (${sql.join(unique.map((id) => sql`${id}`), sql`, `)})
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
  now: number
}

/**
 * Scoped, authorized seek predicate is applied before LIMIT. The seek must use the same time column.
 * Each record carries its shared state and the reader's view (docs/plans/session-archive.md),
 * read in the same query; `where` may use `sessionListedClause`.
 */
export async function readSessionMetadataPage(where: SQL, limit: number, time: 'created_at' | 'last_activity_at' = 'created_at', reader: SessionPageReader = { personKey: null, now: Date.now() }): Promise<SessionRecord[]> {
  const rows = recordWithStateRowSchema.array().parse(await getDatabase().all(sql`
    SELECT ${RECORD_WITH_STATE_COLUMNS}, CASE WHEN ${sessionListedClause(reader)} THEN 1 ELSE 0 END AS listed
    FROM ${sessionRecords}
    LEFT JOIN ${sessionStates} ON session_states.session_id = session_records.session_id
    LEFT JOIN ${sessionViews} ON session_views.session_id = session_records.session_id AND session_views.person_key = ${reader.personKey ?? ''}
    WHERE ${where} ORDER BY session_records.${sql.identifier(time)} DESC, session_records.session_id DESC LIMIT ${limit}
  `))
  return rows.map((row) => ({ ...recordFromRow(row), state: stateFromColumns(row), view: viewFromColumns(row), listed: row.listed === 1 }))
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

/** The organization this machine's own records start in when nothing else named one: a managed machine's, else Local. */
function machineOrganizationId(): string {
  return provisionedOrganizationId() ?? LOCAL_ORGANIZATION_ID
}

/** A session the plane has not seen: every fact absent, born at the report's own time, in its birth home when admission named one. */
function firstRecord(organizationId: string, input: SessionRecordUpsert, birth: SessionBirth | null = null): SessionRecord {
  return {
    sessionId: input.sessionId,
    organizationId,
    publication: birth?.published ? 'published' : 'local',
    ownerKey: birth?.ownerKey ?? claimedOwners.get(input.sessionId)?.ownerKey ?? hostUserKey(),
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
  }
}

/**
 * Write what the caller knows. A field left out keeps the stored value, so the
 * indexer's sweep and the runtime's status report never erase each other's
 * facts; a field given as null clears it. The organization and the publication
 * state are the stored record's, never the report's.
 */
function mergeRecord(existing: SessionRecord | null, organizationId: string, input: SessionRecordUpsert, birth: SessionBirth | null = null): SessionRecord {
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
  }
}

/**
 * A report into one organization: a runner's on the Solus API, or a member's on
 * a host. A record that exists in another organization is not touched — a
 * session id names one record, and its organization never moves. `birth`
 * applies only when the report creates the record.
 */
export function upsertSessionRecord(organizationId: string, input: SessionRecordUpsert, birth?: SessionBirth): Promise<SessionRecord> {
  return serialized(input.sessionId, () => upsertRecordNow(organizationId, input, birth))
}

/**
 * The host's own writers — the indexer, the runtime — report what they saw of a
 * session on this disk. The record keeps the organization it has; a session
 * nobody recorded yet starts in this machine's organization (R9).
 */
export function upsertOwnSessionRecord(input: SessionRecordUpsert): Promise<SessionRecord> {
  return serialized(input.sessionId, () => upsertRecordNow(ANY_ORGANIZATION, input))
}

/**
 * Where a session admitted before its record existed is born
 * (execution/sessions/turn-organization.ts): its organization, and for a new
 * root on a machine attached for organization work (organization-vms §3), its
 * home on the Solus API from the first write — published, owned by the verified
 * person who started it, and reported under the admission the API accepted.
 */
export interface SessionBirth {
  organizationId: string
  published?: boolean
  ownerKey?: string
  admissionId?: string
}

/** Set once per session and consumed by the write that creates the record. */
const bornInto = new Map<string, SessionBirth>()
/** The birth of each API-owned record, whose reports name its admission; kept until the process ends, since the first report may wait for delivery. */
const admittedBirths = new Map<string, SessionBirth>()

export function rememberSessionBirth(sessionId: string, birth: SessionBirth): void {
  bornInto.set(sessionId, birth)
  if (birth.admissionId) admittedBirths.set(sessionId, birth)
}

/** The Solus API admission a record was born under, for its reports (organization-vms §3). */
export function admissionIdFor(sessionId: string): string | undefined {
  return admittedBirths.get(sessionId)?.admissionId
}

/**
 * The organization and owner of a session the Solus API admitted (organization-vms §3).
 * It lives there from its admission, also while its record is not written yet or
 * still reads Local here: the agent's first tool call can come before either write.
 */
export function admittedHomeOf(sessionId: string): { organizationId: string; ownerKey: string | null } | null {
  const birth = admittedBirths.get(sessionId)
  return birth ? { organizationId: birth.organizationId, ownerKey: birth.ownerKey ?? null } : null
}

/** Whether a session is its organization's work (`isOrganizationWork`), also
 *  while the record of a session the Solus API admitted is not written yet. */
export async function sessionIsOrganizationWork(sessionId: string): Promise<boolean> {
  return isOrganizationWork(await getSessionRecord(ANY_ORGANIZATION, sessionId)) || admittedHomeOf(sessionId) !== null
}

/** The person who started a session no record holds yet, and the organization they started it in; consumed by the write that creates the record. */
const claimedOwners = new Map<string, SessionHome>()

/** Who a session belongs to and where, before or after its record exists (docs/plans/access-model.md §2.2). */
export interface SessionHome {
  ownerKey: string
  organizationId: string
}

/**
 * The person who starts a session owns it: the first claim before its record is
 * written decides, and the record takes it as its owner. A claim on a session
 * that already has a record or a claim changes nothing. Answers whether it claimed.
 */
export async function claimSessionOwner(sessionId: string, home: SessionHome): Promise<boolean> {
  if (pendingSessionHome(sessionId) || await getSessionRecord(ANY_ORGANIZATION, sessionId)) return false
  claimedOwners.set(sessionId, home)
  return true
}

/**
 * The home of a session no record holds yet: its admitted birth, else its claim.
 * Null when nobody started it here. A session this machine knows but has not
 * recorded yet is the machine's own (`machineSessionHome`).
 */
export function pendingSessionHome(sessionId: string): SessionHome | null {
  const birth = bornInto.get(sessionId)
  const claim = claimedOwners.get(sessionId)
  const ownerKey = birth?.ownerKey ?? claim?.ownerKey
  if (!ownerKey) return null
  return { ownerKey, organizationId: birth?.organizationId ?? claim?.organizationId ?? machineOrganizationId() }
}

/** The home a record this machine writes for a session nobody started here gets: the host's user, in the machine's organization. */
export function machineSessionHome(): SessionHome {
  return { ownerKey: hostUserKey(), organizationId: machineOrganizationId() }
}

async function upsertRecordNow(scope: RecordScope, input: SessionRecordUpsert, birth?: SessionBirth): Promise<SessionRecord> {
  const merged = await getDatabase().transaction(async (db) => {
    const existing = await readRecord(db, scope, input.sessionId)
    const born = existing ? null : birth ?? bornInto.get(input.sessionId) ?? null
    if (!existing) bornInto.delete(input.sessionId)
    const organizationId = isAnyOrganization(scope) ? born?.organizationId ?? machineOrganizationId() : scope
    const merged = mergeRecord(existing, organizationId, input, born)
    if (!existing) claimedOwners.delete(input.sessionId)
    await db.run(sql`
      INSERT INTO ${sessionRecords} (
        session_id, organization_id, publication, owner_key, provider, project_path, project_remote, runner_host_id,
        title, custom_title, status, model, reasoning_effort, parent_session_id, root_session_id,
        created_at, last_activity_at, size,
        cwd, slug, is_worktree, branch, project_root, delegation_message_id, delegation_depth, delegation_intent, delegation_created_at
      ) VALUES (
        ${merged.sessionId}, ${merged.organizationId}, ${merged.publication}, ${merged.ownerKey}, ${merged.provider}, ${merged.projectPath},
        ${merged.projectRemote}, ${merged.runnerHostId}, ${merged.title}, ${merged.customTitle}, ${merged.status},
        ${merged.model}, ${merged.reasoningEffort}, ${merged.parentSessionId}, ${merged.rootSessionId},
        ${merged.createdAt}, ${merged.lastActivityAt}, ${merged.size},
        ${merged.cwd}, ${merged.slug}, ${merged.isWorktree ? 1 : 0}, ${merged.branch}, ${merged.projectRoot},
        ${merged.delegation?.messageId ?? null}, ${merged.delegation?.depth ?? null}, ${merged.delegation?.intent ?? null}, ${merged.delegation?.createdAt ?? null}
      )
      ON CONFLICT(session_id) DO UPDATE SET
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
        created_at = excluded.created_at,
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
        delegation_created_at = excluded.delegation_created_at
      WHERE session_records.organization_id = excluded.organization_id
    `)
    return merged
  })
  emitChanged(merged)
  return merged
}

/**
 * The one-time assignment of an unassigned record (organization-scope §3, R10):
 * `local` becomes `organizationId`, once. Answers the record as it now stands,
 * whether this call assigned it or it already belonged to that organization;
 * null when the record is another organization's or does not exist. A birth
 * the admission decided (organization-vms §3) is applied whole: a record the
 * indexer wrote first as Local takes its API home and owner too.
 */
export function assignSessionOrganization(sessionId: string, organizationId: string, birth: Pick<SessionBirth, 'published' | 'ownerKey'> = {}): Promise<SessionRecord | null> {
  return serialized(sessionId, async () => {
    if (organizationId === LOCAL_ORGANIZATION_ID) return getSessionRecord(LOCAL_ORGANIZATION_ID, sessionId)
    const result = await getDatabase().run(sql`
      UPDATE ${sessionRecords} SET organization_id = ${organizationId},
        publication = ${birth.published ? 'published' : sql`publication`},
        owner_key = ${birth.ownerKey ?? sql`owner_key`}
      WHERE session_id = ${sessionId} AND organization_id = ${LOCAL_ORGANIZATION_ID}
    `)
    const record = await getSessionRecord(organizationId, sessionId)
    if (result.changes > 0) emitChanged(record)
    return record
  })
}

/** The transcript reached the Solus API (organization-scope §7): the record says so from now on. */
export function markSessionPublished(sessionId: string): Promise<void> {
  return serialized(sessionId, async () => {
    const result = await getDatabase().run(sql`
      UPDATE ${sessionRecords} SET publication = 'published'
      WHERE session_id = ${sessionId} AND publication <> 'published' AND organization_id <> ${LOCAL_ORGANIZATION_ID}
    `)
    if (result.changes > 0) await emitStored(sessionId)
  })
}

/** The transcript is gone from the runner and nothing else holds the session: the record goes with it. */
export function deleteSessionRecord(scope: RecordScope, sessionId: string): Promise<void> {
  return serialized(sessionId, async () => {
    await getDatabase().run(sql`
      DELETE FROM ${sessionRecords} WHERE ${scopeClause(scope)} AND session_id = ${sessionId}
    `)
    organizationBySession.delete(sessionId)
  })
}

/** The record's status as the runtime reports it; a session with no record yet is left for its start to write. */
export function setSessionRecordStatus(scope: RecordScope, sessionId: string, status: SessionRecordStatus): Promise<void> {
  return serialized(sessionId, async () => {
    const result = await getDatabase().run(sql`
      UPDATE ${sessionRecords} SET status = ${status}, last_activity_at = ${Date.now()}
      WHERE ${scopeClause(scope)} AND session_id = ${sessionId}
    `)
    if (result.changes > 0) await emitStored(sessionId)
  })
}

export function setSessionRecordBranch(sessionId: string, branch: string): Promise<void> {
  return serialized(sessionId, async () => {
    const result = await getDatabase().run(sql`
      UPDATE ${sessionRecords} SET branch = ${branch} WHERE session_id = ${sessionId}
    `)
    if (result.changes > 0) await emitStored(sessionId)
  })
}

export function setSessionRecordTitle(scope: RecordScope, sessionId: string, customTitle: string | null): Promise<void> {
  return serialized(sessionId, async () => {
    const result = await getDatabase().run(sql`
      UPDATE ${sessionRecords} SET custom_title = ${customTitle}
      WHERE ${scopeClause(scope)} AND session_id = ${sessionId}
    `)
    if (result.changes > 0) await emitStored(sessionId)
  })
}

/** A generated name cannot replace a name the person set while generation ran. */
export function setSessionRecordGeneratedTitle(sessionId: string, title: string): Promise<boolean> {
  return serialized(sessionId, async () => {
    const result = await getDatabase().run(sql`
      UPDATE ${sessionRecords} SET custom_title = ${title}
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
    UPDATE ${sessionRecords} SET status = 'interrupted'
    WHERE status = 'running' AND runner_host_id IS NULL
    RETURNING session_id
  `))
  return rows.map((row) => row.session_id)
}

/** This host's own published organization sessions: what it sends its Solus API once at boot. */
export async function ownPublishedSessionIds(): Promise<string[]> {
  const rows = z.array(z.object({ session_id: z.string() })).parse(await getDatabase().all(sql`
    SELECT session_id FROM ${sessionRecords}
    WHERE publication = 'published' AND runner_host_id IS NULL AND organization_id <> ${LOCAL_ORGANIZATION_ID}
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

export interface SessionRecordQuery {
  provider?: AgentId
  /** Exact provider project folder keys. */
  projectPaths?: string[]
  /** One plain project path; encoded here as the provider spells it. */
  projectPath?: string
  /** With `projectPath`: the project's worktree folders too, unless the path is itself a worktree. */
  includeWorktrees?: boolean
  limit?: number
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
 * the record's, or this machine's own when the session has no record yet.
 */
export async function organizationOfSession(sessionId: string): Promise<string> {
  const known = organizationBySession.get(sessionId)
  // A remembered fallback holds only while this machine's organization is the same one.
  if (known && (known.fromRecord || known.organizationId === machineOrganizationId())) return known.organizationId
  const row = z.object({ organization_id: z.string() }).nullish().parse(await getDatabase().get(sql`
    SELECT organization_id FROM ${sessionRecords} WHERE session_id = ${sessionId}
  `))
  // A session with no record yet is this machine's; every later write of its record goes through `remember`.
  const organizationId = row?.organization_id ?? machineOrganizationId()
  organizationBySession.set(sessionId, { organizationId, fromRecord: row !== null && row !== undefined })
  return organizationId
}

/**
 * The organization of every record this process wrote or read, so a turn's
 * spans learn their organization without a read per turn. Every write in this
 * module goes through `remember`; a record another process changed is read
 * again only when its id was never seen here, which on a host is its own file.
 */
const organizationBySession = new Map<string, { organizationId: string; fromRecord: boolean }>()

function remember(record: SessionRecord | null): void {
  if (record) organizationBySession.set(record.sessionId, { organizationId: record.organizationId, fromRecord: true })
}

/** The same for many sessions at once; a session with no record maps to this machine's organization. */
export async function organizationsOfSessions(sessionIds: readonly string[]): Promise<Map<string, string>> {
  const fallback = machineOrganizationId()
  const result = new Map<string, string>(sessionIds.map((id) => [id, fallback]))
  const unique = [...new Set(sessionIds)]
  if (unique.length === 0) return result
  const rows = z.array(z.object({ session_id: z.string(), organization_id: z.string() })).parse(await getDatabase().all(sql`
    SELECT session_id, organization_id FROM ${sessionRecords}
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
    session_id: z.string(), project_remote: z.string(), branch: z.string(), owner_key: z.string(), status: z.string(),
  }).array().parse(await getDatabase().all(sql`
    SELECT session_records.session_id, session_records.project_remote, session_records.branch, session_records.owner_key, session_records.status
    FROM ${sessionRecords}
    LEFT JOIN ${sessionStates} ON session_states.session_id = session_records.session_id
    WHERE session_records.organization_id <> ${LOCAL_ORGANIZATION_ID}
      AND session_records.project_remote IS NOT NULL AND session_records.branch IS NOT NULL
      AND session_records.last_activity_at >= ${activeSince}
      AND session_states.settled_at IS NULL
  `))
  return rows.map((row) => ({
    sessionId: row.session_id, repositoryKey: row.project_remote, branch: row.branch, ownerKey: row.owner_key, isRunning: row.status === 'running',
  }))
}

/** Newest activity first, with the picker's filters. */
export async function listSessionRecords(scope: RecordScope, query: SessionRecordQuery = {}): Promise<SessionRecord[]> {
  const clauses: SQL[] = [scopeClause(scope)]
  if (query.provider) clauses.push(sql`provider = ${query.provider}`)
  if (query.projectPaths) {
    if (query.projectPaths.length === 0) return []
    clauses.push(sql`project_path IN (${sql.join(query.projectPaths.map((path) => sql`${path}`), sql`, `)})`)
  }
  if (query.projectPath !== undefined) {
    const normalized = query.projectPath.replace(/\/$/, '')
    const encoded = encodePathAsFolder(normalized)
    const withWorktrees = query.includeWorktrees === true && !isSolusWorktreePath(normalized)
    clauses.push(withWorktrees
      ? sql`(project_path = ${encoded} OR project_path LIKE ${`${encoded}${SOLUS_WORKTREE_ENCODED_MARKER}%`})`
      : sql`project_path = ${encoded}`)
  }
  const limit = query.limit === undefined ? sql`` : sql`LIMIT ${query.limit}`
  const rows = recordRowSchema.array().parse(await getDatabase().all(sql`
    SELECT ${RECORD_COLUMNS} FROM ${sessionRecords}
    WHERE ${sql.join(clauses, sql` AND `)}
    ORDER BY last_activity_at DESC, session_id
    ${limit}
  `))
  return rows.map(recordFromRow)
}
