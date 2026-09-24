import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { worktreeProjectRoot, type AgentId, type PlanDescriptor, type PlanRevisionSummary } from '@solus/contracts/types'
import { getDatabase, type Db } from '../db/database'
import { extractPlanTitle } from '../agents/plan-text'
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
  sessionId: string
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
 * holds (docs/plans/cloud-service-model.md): every read and write names the
 * organization, and a runner writes its own.
 */

export async function indexLivePlan(
  organizationId: string,
  input: Omit<IndexedPlanInput, 'title' | 'excerpt' | 'derivedStatus'>,
): Promise<void> {
  const lines = input.content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^#{1,6}\s/.test(line))
  await upsertIndexedPlan(organizationId, {
    ...input,
    title: extractPlanTitle(input.content),
    excerpt: lines.join(' ').replace(/[*_`]/g, '').slice(0, 240),
    derivedStatus: 'pending',
  })
}

async function insertPlan(db: Db, organizationId: string, input: IndexedPlanInput): Promise<void> {
  await db.run(sql`
    INSERT INTO ${indexedPlans} (
      provider, session_id, plan_tool_use_id, project_path, cwd, project_root,
      timestamp, title, excerpt, plan_file_path, content, derived_status, session_available, organization_id
    ) VALUES (
      ${input.provider}, ${input.sessionId}, ${input.planToolUseId}, ${input.projectPath}, ${input.cwd},
      ${worktreeProjectRoot(input.cwd)}, ${input.timestamp}, ${input.title}, ${input.excerpt},
      ${input.planFilePath ?? null}, ${input.content}, ${input.derivedStatus}, 1, ${organizationId}
    )
    ON CONFLICT(provider, session_id, plan_tool_use_id) DO UPDATE SET
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

export async function upsertIndexedPlan(organizationId: string, input: IndexedPlanInput): Promise<void> {
  await insertPlan(getDatabase(), organizationId, input)
}

export async function replaceIndexedPlansForSession(
  organizationId: string,
  provider: AgentId,
  sessionId: string,
  plans: IndexedPlanInput[],
): Promise<void> {
  await getDatabase().transaction(async (db) => {
    await db.run(sql`
      DELETE FROM ${indexedPlans}
      WHERE organization_id = ${organizationId} AND provider = ${provider} AND session_id = ${sessionId}
    `)
    for (const plan of plans) await insertPlan(db, organizationId, plan)
  })
}

export async function replaceIndexedPlansForProvider(
  organizationId: string,
  provider: AgentId,
  plans: IndexedPlanInput[],
): Promise<void> {
  await getDatabase().transaction(async (db) => {
    // A full provider rebuild reconciles live transcripts only. Rows already
    // marked unavailable are durable saved artifacts whose source transcript
    // cannot be rediscovered, so a rebuild must not erase them.
    await db.run(sql`
      DELETE FROM ${indexedPlans}
      WHERE organization_id = ${organizationId} AND provider = ${provider} AND session_available = 1
    `)
    for (const plan of plans) await insertPlan(db, organizationId, plan)
    await db.run(sql`
      INSERT INTO ${planIndexProviders}(provider, completed_at, organization_id)
      VALUES (${provider}, ${Date.now()}, ${organizationId})
      ON CONFLICT(provider) DO UPDATE SET
        completed_at = excluded.completed_at,
        organization_id = excluded.organization_id
    `)
  })
}

export async function markIndexedPlanSessionUnavailable(
  organizationId: string,
  provider: AgentId,
  sessionId: string,
): Promise<void> {
  await getDatabase().run(sql`
    UPDATE ${indexedPlans} SET session_available = 0
    WHERE organization_id = ${organizationId} AND provider = ${provider} AND session_id = ${sessionId}
  `)
}

export async function isPlanIndexComplete(organizationId: string, provider: AgentId): Promise<boolean> {
  return !!await getDatabase().get(sql`
    SELECT 1 AS present FROM ${planIndexProviders}
    WHERE organization_id = ${organizationId} AND provider = ${provider}
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
  organizationId: string,
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
    WHERE indexed_plans.organization_id = ${organizationId}
      AND indexed_plans.provider = ${provider}
      ${projectFilter}
    ORDER BY indexed_plans.timestamp DESC
  `))
  return rowsToDescriptors(rows)
}

/** The plans these sessions wrote, newest first: ids and title only. */
export async function listPlanRefsForSessions(
  organizationId: string,
  sessionIds: readonly string[],
): Promise<Array<{ sessionId: string; planToolUseId: string; title: string }>> {
  if (!sessionIds.length) return []
  const rows = planRefRowSchema.array().parse(await getDatabase().all(sql`
    SELECT session_id, plan_tool_use_id, title FROM ${indexedPlans}
    WHERE organization_id = ${organizationId}
      AND session_id IN (${sql.join(sessionIds.map((id) => sql`${id}`), sql`, `)})
    ORDER BY timestamp DESC
  `))
  return rows.map((row) => ({ sessionId: row.session_id, planToolUseId: row.plan_tool_use_id, title: row.title }))
}

const planRefRowSchema = z.object({ session_id: z.string(), plan_tool_use_id: z.string(), title: z.string() })

export async function loadIndexedPlanContent(
  organizationId: string,
  provider: AgentId,
  sessionId: string,
  planToolUseId: string,
): Promise<string | null> {
  const row = z.object({ content: z.string() }).nullish().parse(await getDatabase().get(sql`
    SELECT content FROM ${indexedPlans}
    WHERE organization_id = ${organizationId} AND provider = ${provider}
      AND session_id = ${sessionId} AND plan_tool_use_id = ${planToolUseId}
  `))
  return row?.content ?? null
}
