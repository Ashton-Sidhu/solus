import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { SessionArtifact } from '@solus/contracts/session-artifacts'
import { sessionDigestSchema, type SessionDigest, type SessionSubagentExecution, type SessionTree } from '@solus/contracts/session-digest'
import type { SessionRecord, SessionRecordUpsert } from '@solus/contracts/types'
import { attributionSchema } from '@solus/contracts/user'
import { getDatabase } from '../../db/database'
import type { RecordScope } from '../../admission/principal'
import { scopeClause } from '../scope'
import { workTypeSchema } from '../works/work-rows'
import { session, sessionArtifactCopies, sessionDigests } from './schema'
import { ancestorsOf, getSessionRecord, organizationOfSession, readSessionMetadataPage, upsertSessionRecord } from './session-records'
import { sessionExecutionSchema } from '@solus/contracts/session-execution'
import { readSessionExecutions, writeSessionExecution } from './session-executions'
import { readArtifactsBySession } from './session-artifacts'

/**
 * Each session's stored digest, the copies of sessions another host runs, and
 * the session tree that reads them (docs/plans/session-digests.md). The host's
 * digest owner (`execution/sessions/session-digests.ts`) decides what a digest
 * holds; the orchestrator decides when a remote child is copied.
 */

/** A delegation tree is never this large; the bound also ends a cycle in the rows. */
const MAX_TREE_SESSIONS = 200


const artifactSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('pull-request'),
    link: z.object({
      sessionId: z.string(),
      repository: z.string(),
      number: z.number(),
      url: z.string(),
      title: z.string(),
      source: z.enum(['branch', 'created', 'agent', 'manual']),
      createdBy: attributionSchema.optional(),
      linkedAt: z.number(),
      snapshot: z.object({
        number: z.number(),
        url: z.string(),
        title: z.string(),
        state: z.enum(['open', 'closed', 'merged']),
        draft: z.boolean(),
        updatedAt: z.string(),
        baseRepo: z.object({ host: z.string(), owner: z.string(), repo: z.string() }),
      }).optional(),
      missing: z.boolean().optional(),
      watch: z.object({ startedAt: z.number() }).optional(),
    }),
  }),
  z.object({ kind: z.literal('work'), workId: z.string(), title: z.string(), workType: workTypeSchema, linkedAt: z.number(), pinned: z.boolean().optional(), updatedAt: z.number().optional(), preview: z.string().optional() }),
  z.object({ kind: z.enum(['file', 'image']), hostId: z.string(), path: z.string(), title: z.string(), linkedAt: z.number() }),
  z.object({ kind: z.literal('automation'), hostId: z.string(), automationId: z.string(), title: z.string(), linkedAt: z.number() }),
  z.object({ kind: z.literal('app'), hostId: z.string(), appId: z.string(), slug: z.string(), title: z.string(), linkedAt: z.number() }),
]) satisfies z.ZodType<SessionArtifact>

const jsonRowSchema = z.object({ session_id: z.string(), value: z.string() })

type ChangeListener = (sessionId: string) => void
const listeners = new Set<ChangeListener>()

/** Hear each session whose tree changed: what it, or a session below it, did. */
export function onSessionDigestChanged(listener: ChangeListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Announce a change to a session's digest, to the session and each ancestor: an event reaches only the readers of the session it names. */
export async function emitSessionDigestChanged(sessionId: string): Promise<void> {
  for (const reader of await ancestorsOf(sessionId)) {
    for (const listener of listeners) listener(reader)
  }
}

/** Replace the session's digest, in the session's organization. */
export async function writeSessionDigest(digest: SessionDigest): Promise<void> {
  const organizationId = await organizationOfSession(digest.sessionId)
  await getDatabase().run(sql`
    INSERT INTO ${sessionDigests}(session_id, organization_id, digest, updated_at)
    VALUES (${digest.sessionId}, ${organizationId}, ${JSON.stringify(digest)}, ${digest.updatedAt})
    ON CONFLICT(session_id) DO UPDATE SET digest = excluded.digest, updated_at = excluded.updated_at
  `)
}

/** The stored digests of these sessions; a session with none is not in the map. */
export async function readSessionDigests(scope: RecordScope, sessionIds: readonly string[]): Promise<Map<string, SessionDigest>> {
  if (sessionIds.length === 0) return new Map()
  const rows = jsonRowSchema.array().parse(await getDatabase().all(sql`
    SELECT session_id, digest AS value FROM ${sessionDigests}
    WHERE ${scopeClause(scope, sql`${sessionDigests}.organization_id`)} AND session_id IN (${inList(sessionIds)})
  `))
  return new Map(rows.map((row) => [row.session_id, sessionDigestSchema.parse(JSON.parse(row.value))]))
}

/**
 * The session, then every session below it, level by level, oldest started
 * first: each with its record, its digest, and its artifacts. One statement
 * walks the tree and reads the records. The digests and executions each use
 * a batched read. The artifacts are the batched read of `session-artifacts.ts` for the sessions this host
 * runs, and the stored copies for the sessions another host runs. The count of
 * reads does not grow with the tree. Empty when the session has no record.
 */
export async function readSessionTree(scope: RecordScope, sessionId: string): Promise<SessionTree> {
  const records = levelOrder(sessionId, await readSessionMetadataPage(sql`${scopeClause(scope, sql`session_records.organization_id`)} AND session_records.session_id IN (
    WITH RECURSIVE tree(session_id, depth) AS (
      SELECT root_row.session_id, 0 FROM ${session} root_row WHERE root_row.session_id = ${sessionId}
      UNION ALL
      SELECT child.session_id, tree.depth + 1 FROM ${session} child JOIN tree ON child.parent_session_id = tree.session_id
      WHERE tree.depth < ${MAX_TREE_SESSIONS}
    )
    SELECT session_id FROM tree
  )`, MAX_TREE_SESSIONS + 1))
  if (records.length === 0) return { nodes: [] }
  const ids = records.map((record) => record.sessionId)
  const localIds = records.filter((record) => !record.runnerHostId).map((record) => record.sessionId)
  const remoteIds = records.filter((record) => record.runnerHostId).map((record) => record.sessionId)
  const [digests, artifacts, copies, executions] = await Promise.all([
    readSessionDigests(scope, ids),
    localIds.length ? readArtifactsBySession(scope, localIds) : new Map<string, SessionArtifact[]>(),
    readArtifactCopies(scope, remoteIds),
    readSessionExecutions(scope, ids, true),
  ])
  return {
    nodes: records.map((record) => {
      const digest = digests.get(record.sessionId) ?? null
      const saved = executions.get(record.sessionId)
      const toolIds = new Set(digest?.subagents.map((agent) => agent.id))
      return {
        record: { ...record, execution: saved?.execution },
        subagentExecutions: saved?.subagents.filter(({ toolId }) => toolIds.has(toolId)),
        digest,
        artifacts: artifacts.get(record.sessionId) ?? copies.get(record.sessionId) ?? [],
      }
    }),
  }
}

/** One session another host runs, as this host stores it: the record facts its host reported, checked at the boundary. */
export interface RemoteSessionNode {
  record: SessionRecordUpsert
  digest: SessionDigest | null
  subagentExecutions?: SessionSubagentExecution[]
  artifacts: SessionArtifact[]
}

/**
 * Store a subtree of sessions that another host runs, under the local session
 * that started its root: each record (with the host that runs it), each
 * digest, and each artifact list as a copy. Then tell the readers of the local
 * session and its ancestors. A parent this host no longer has stores nothing.
 */
export async function storeRemoteSessionTree(parentSessionId: string, nodes: readonly RemoteSessionNode[]): Promise<void> {
  const parent = await getSessionRecord(await organizationOfSession(parentSessionId), parentSessionId)
  if (!parent || nodes.length === 0) return
  const birth = { organizationId: parent.organizationId, ownerKey: parent.ownerKey }
  for (const node of nodes) {
    await upsertSessionRecord(parent.organizationId, { ...node.record, rootSessionId: parent.rootSessionId ?? parent.sessionId }, birth)
    for (const agent of node.subagentExecutions ?? []) {
      await writeSessionExecution(parent.organizationId, node.record.sessionId, agent.toolId, sessionExecutionSchema.parse(agent.execution))
    }
    if (node.digest) await writeSessionDigest(sessionDigestSchema.parse(node.digest))
    await writeArtifactCopy(node.record.sessionId, parent.organizationId, artifactSchema.array().parse(node.artifacts))
  }
  await emitSessionDigestChanged(parentSessionId)
}

async function writeArtifactCopy(sessionId: string, organizationId: string, artifacts: SessionArtifact[]): Promise<void> {
  await getDatabase().run(sql`
    INSERT INTO ${sessionArtifactCopies}(session_id, organization_id, artifacts, updated_at)
    VALUES (${sessionId}, ${organizationId}, ${JSON.stringify(artifacts)}, ${Date.now()})
    ON CONFLICT(session_id) DO UPDATE SET artifacts = excluded.artifacts, updated_at = excluded.updated_at
  `)
}

async function readArtifactCopies(scope: RecordScope, sessionIds: readonly string[]): Promise<Map<string, SessionArtifact[]>> {
  if (sessionIds.length === 0) return new Map()
  const rows = jsonRowSchema.array().parse(await getDatabase().all(sql`
    SELECT session_id, artifacts AS value FROM ${sessionArtifactCopies}
    WHERE ${scopeClause(scope, sql`${sessionArtifactCopies}.organization_id`)} AND session_id IN (${inList(sessionIds)})
  `))
  return new Map(rows.map((row) => [row.session_id, artifactSchema.array().parse(JSON.parse(row.value))]))
}

/** The root, then each level below it, oldest started first. A record the walk cannot reach from the root is left out. */
function levelOrder(rootId: string, records: SessionRecord[]): SessionRecord[] {
  const children = new Map<string, SessionRecord[]>()
  let root: SessionRecord | undefined
  for (const record of records) {
    if (record.sessionId === rootId) root = record
    else if (record.parentSessionId) children.set(record.parentSessionId, [...children.get(record.parentSessionId) ?? [], record])
  }
  if (!root) return []
  const ordered = [root]
  const seen = new Set([rootId])
  for (let level = [root]; level.length > 0;) {
    const next = level.flatMap((record) => children.get(record.sessionId) ?? [])
      .filter((record) => !seen.has(record.sessionId))
      .sort((a, b) => a.createdAt - b.createdAt)
    for (const record of next) seen.add(record.sessionId)
    ordered.push(...next)
    level = next
  }
  return ordered
}

function inList(ids: readonly string[]): ReturnType<typeof sql.join> {
  return sql.join(ids.map((id) => sql`${id}`), sql`, `)
}
