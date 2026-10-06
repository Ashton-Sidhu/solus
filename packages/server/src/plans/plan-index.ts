import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { worktreeProjectRoot, type AgentId, type PlanDescriptor, type PlanRevisionSummary } from '@solus/contracts/types'
import { getDatabase, type Db } from '../db/database'
import type { RecordScope } from '../admission/principal'
import { LOCAL_ORGANIZATION_ID, provisionedOrganizationId } from '../host/host-category'
import { scopeClause } from '../data/scope'
import { organizationOfSession, organizationsOfSessions } from '../data/sessions/session-records'
import { extractPlanTitle } from '../execution/agents/plan-text'
import { sessionIdOfThread } from '../data/sessions/session-lineage'
import { indexedPlans, planAnnotations, planIndexProviders } from './schema'

const planStatusSchema = z.enum(['pending', 'accepted', 'rejected'])
const indexedPlanRowSchema = z.object({
  provider: z.enum(['claude-code', 'codex', 'opencode']),
  session_id: z.string(),
  plan_tool_use_id: z.string(),
  project_path: z.string(),
  cwd: z.string(),
  project_root: z.string(),
  timestamp: z.number(),
  title: z.string(),
  excerpt: z.string(),
  plan_file_path: z.string().nullable(),
  content: z.string(),
  derived_status: planStatusSchema,
  session_available: z.number(),
  annotation_status: planStatusSchema.nullable(),
  annotation_title: z.string().nullable(),
  bookmarked: z.number().nullable(),
  bookmarked_at: z.number().nullable(),
  comments: z.string().nullable(),
})

type IndexedPlanRow = z.infer<typeof indexedPlanRowSchema>

export interface IndexedPlanInput {
  provider: AgentId
  /** The session the plan belongs to. */
  sessionId: string
  /** The thread whose transcript holds it. */
  threadId: string
  planToolUseId: string
  projectPath: string
  cwd: string
  timestamp: number
  title: string
  excerpt: string
  planFilePath?: string
  content: string
  derivedStatus: 'pending' | 'accepted' | 'rejected'
}

/**
 * The plan index is a query model over the provider transcripts this machine
 * holds (docs/plans/cloud-service-model.md). A plan is its session's child
 * (organization-scope §3): every row carries the session's organization, a read
 * names its scope, and the provider completion marks are this machine's own.
 */

export async function indexLivePlan(
  input: Omit<IndexedPlanInput, 'title' | 'excerpt' | 'derivedStatus'>,
): Promise<void> {
  const lines = input.content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^#{1,6}\s/.test(line))
  await insertPlan(getDatabase(), await organizationOfSession(input.sessionId), {
    ...input,
    title: extractPlanTitle(input.content),
    excerpt: lines.join(' ').replace(/[*_`]/g, '').slice(0, 240),
    derivedStatus: 'pending',
  })
}

async function insertPlan(db: Db, organizationId: string, input: IndexedPlanInput): Promise<void> {
  await db.run(sql`
    INSERT INTO ${indexedPlans} (
      provider, session_id, thread_id, plan_tool_use_id, project_path, cwd, project_root,
      timestamp, title, excerpt, plan_file_path, content, derived_status, session_available, organization_id
    ) VALUES (
      ${input.provider}, ${input.sessionId}, ${input.threadId}, ${input.planToolUseId}, ${input.projectPath}, ${input.cwd},
      ${worktreeProjectRoot(input.cwd)}, ${input.timestamp}, ${input.title}, ${input.excerpt},
      ${input.planFilePath ?? null}, ${input.content}, ${input.derivedStatus}, 1, ${organizationId}
    )
    ON CONFLICT(provider, session_id, plan_tool_use_id) DO UPDATE SET
      thread_id = excluded.thread_id,
      project_path = excluded.project_path,
      cwd = excluded.cwd,
      project_root = excluded.project_root,
      timestamp = excluded.timestamp,
      title = excluded.title,
      excerpt = excluded.excerpt,
      plan_file_path = excluded.plan_file_path,
      content = excluded.content,
      derived_status = excluded.derived_status,
      session_available = 1,
      organization_id = excluded.organization_id
  `)
}

/** Replace what one transcript holds: the plans of one thread. */
export async function replaceIndexedPlansForThread(
  provider: AgentId,
  threadId: string,
  plans: IndexedPlanInput[],
): Promise<void> {
  const organizationId = await organizationOfSession(sessionIdOfThread(threadId))
  await getDatabase().transaction(async (db) => {
    await db.run(sql`
      DELETE FROM ${indexedPlans}
      WHERE provider = ${provider} AND thread_id = ${threadId}
    `)
    for (const plan of plans) await insertPlan(db, organizationId, plan)
  })
}

export async function replaceIndexedPlansForProvider(
  provider: AgentId,
  plans: IndexedPlanInput[],
): Promise<void> {
  const organizations = await organizationsOfSessions(plans.map((plan) => plan.sessionId))
  await getDatabase().transaction(async (db) => {
    // A full provider rebuild reconciles live transcripts only. Rows already
    // marked unavailable are durable saved artifacts whose source transcript
    // cannot be rediscovered, so a rebuild must not erase them.
    await db.run(sql`
      DELETE FROM ${indexedPlans}
      WHERE provider = ${provider} AND session_available = 1
    `)
    for (const plan of plans) await insertPlan(db, organizations.get(plan.sessionId) ?? provisionedOrganizationId() ?? LOCAL_ORGANIZATION_ID, plan)
    await db.run(sql`
      INSERT INTO ${planIndexProviders}(provider, completed_at, organization_id)
      VALUES (${provider}, ${Date.now()}, ${provisionedOrganizationId() ?? LOCAL_ORGANIZATION_ID})
      ON CONFLICT(provider) DO UPDATE SET
        completed_at = excluded.completed_at,
        organization_id = excluded.organization_id
    `)
  })
}

/** The thread's transcript is gone: its plans stay, but cannot be resumed. */
export async function markIndexedPlanThreadUnavailable(
  provider: AgentId,
  threadId: string,
): Promise<void> {
  await getDatabase().run(sql`
    UPDATE ${indexedPlans} SET session_available = 0
    WHERE provider = ${provider} AND thread_id = ${threadId}
  `)
}

/** Whether this machine finished indexing a provider's transcripts once. */
export async function isPlanIndexComplete(provider: AgentId): Promise<boolean> {
  return !!await getDatabase().get(sql`
    SELECT 1 AS present FROM ${planIndexProviders}
    WHERE provider = ${provider}
  `)
}

function commentCount(raw: string | null): number {
  if (!raw) return 0
  try {
    const parsed = z.array(z.unknown()).safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data.length : 0
  } catch {
    return 0
  }
}

function effectiveStatus(row: IndexedPlanRow): 'pending' | 'accepted' | 'rejected' {
  return row.annotation_status ?? row.derived_status
}

function revisionFor(row: IndexedPlanRow): PlanRevisionSummary {
  return {
    planToolUseId: row.plan_tool_use_id,
    timestamp: row.timestamp,
    title: row.annotation_title || row.title,
    excerpt: row.excerpt,
    status: effectiveStatus(row),
    commentCount: commentCount(row.comments),
    planFilePath: row.plan_file_path ?? undefined,
  }
}

function rowsToDescriptors(rows: IndexedPlanRow[]): PlanDescriptor[] {
  const groups = new Map<string, IndexedPlanRow[]>()
  for (const row of rows) {
    const key = `${row.provider}\0${row.session_id}`
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  }

  const descriptors: PlanDescriptor[] = []
  for (const group of groups.values()) {
    group.sort((a, b) => b.timestamp - a.timestamp)
    const latest = group[0]
    descriptors.push({
      provider: latest.provider,
      sessionId: latest.session_id,
      planToolUseId: latest.plan_tool_use_id,
      projectPath: latest.project_path,
      cwd: latest.cwd,
      timestamp: latest.timestamp,
      title: latest.annotation_title || latest.title,
      excerpt: latest.excerpt,
      status: effectiveStatus(latest),
      commentCount: commentCount(latest.comments),
      bookmarked: group.some((row) => row.bookmarked === 1),
      bookmarkedAt: group.reduce<number | undefined>(
        (value, row) => row.bookmarked_at === null ? value : Math.max(value ?? 0, row.bookmarked_at),
        undefined,
      ),
      planFilePath: latest.plan_file_path ?? undefined,
      sessionAvailable: group.some((row) => row.session_available === 1),
      revisions: group.map(revisionFor),
    })
  }
  descriptors.sort((a, b) => b.timestamp - a.timestamp)
  return descriptors
}

export async function listIndexedPlans(
  scope: RecordScope,
  provider: AgentId,
  projectPath: string | undefined,
  allProjects: boolean,
): Promise<PlanDescriptor[]> {
  const scopedProjectPath = allProjects ? undefined : projectPath ?? process.cwd()
  const projectFilter: SQL = scopedProjectPath
    ? sql`AND indexed_plans.project_root = ${worktreeProjectRoot(scopedProjectPath)}`
    : sql``
  const rows = indexedPlanRowSchema.array().parse(await getDatabase().all(sql`
    SELECT
      indexed_plans.provider, indexed_plans.session_id, indexed_plans.plan_tool_use_id,
      indexed_plans.project_path, indexed_plans.cwd, indexed_plans.project_root,
      indexed_plans.timestamp, indexed_plans.title, indexed_plans.excerpt, indexed_plans.plan_file_path,
      indexed_plans.content, indexed_plans.derived_status, indexed_plans.session_available,
      plan_annotations.status AS annotation_status,
      plan_annotations.title AS annotation_title,
      plan_annotations.bookmarked, plan_annotations.bookmarked_at, plan_annotations.comments
    FROM ${indexedPlans}
    LEFT JOIN ${planAnnotations}
      ON plan_annotations.session_id = indexed_plans.session_id
     AND plan_annotations.plan_tool_use_id = indexed_plans.plan_tool_use_id
     AND plan_annotations.organization_id = indexed_plans.organization_id
    WHERE ${scopeClause(scope, sql`indexed_plans.organization_id`)}
      AND indexed_plans.provider = ${provider}
      ${projectFilter}
    ORDER BY indexed_plans.timestamp DESC
  `))
  return rowsToDescriptors(rows)
}

/** The plans these sessions wrote, newest first: ids and title only. */
export async function listPlanRefsForSessions(
  scope: RecordScope,
  sessionIds: readonly string[],
): Promise<Array<{ sessionId: string; planToolUseId: string; title: string }>> {
  if (!sessionIds.length) return []
  const rows = planRefRowSchema.array().parse(await getDatabase().all(sql`
    SELECT session_id, plan_tool_use_id, title FROM ${indexedPlans}
    WHERE ${scopeClause(scope)}
      AND session_id IN (${sql.join(sessionIds.map((id) => sql`${id}`), sql`, `)})
    ORDER BY timestamp DESC
  `))
  return rows.map((row) => ({ sessionId: row.session_id, planToolUseId: row.plan_tool_use_id, title: row.title }))
}

const planRefRowSchema = z.object({ session_id: z.string(), plan_tool_use_id: z.string(), title: z.string() })

export async function loadIndexedPlanContent(
  scope: RecordScope,
  provider: AgentId,
  sessionId: string,
  planToolUseId: string,
): Promise<string | null> {
  const row = z.object({ content: z.string() }).nullish().parse(await getDatabase().get(sql`
    SELECT content FROM ${indexedPlans}
    WHERE ${scopeClause(scope)} AND provider = ${provider}
      AND session_id = ${sessionId} AND plan_tool_use_id = ${planToolUseId}
  `))
  return row?.content ?? null
}
