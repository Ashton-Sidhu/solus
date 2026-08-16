import { z } from 'zod'
import { worktreeProjectRoot, type AgentId, type PlanDescriptor, type PlanRevisionSummary } from '../../shared/types'
import { getDb, withTx } from '../db'
import { extractPlanTitle } from '../agents/plan-text'

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

export function indexLivePlan(input: Omit<IndexedPlanInput, 'title' | 'excerpt' | 'derivedStatus'>): void {
  const lines = input.content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^#{1,6}\s/.test(line))
  upsertIndexedPlan({
    ...input,
    title: extractPlanTitle(input.content),
    excerpt: lines.join(' ').replace(/[*_`]/g, '').slice(0, 240),
    derivedStatus: 'pending',
  })
}

function insertPlan(input: IndexedPlanInput): void {
  getDb().prepare(`
    INSERT INTO indexed_plans (
      provider, session_id, plan_tool_use_id, project_path, cwd, project_root,
      timestamp, title, excerpt, plan_file_path, content, derived_status, session_available
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
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
      session_available = 1
  `).run(
    input.provider,
    input.sessionId,
    input.planToolUseId,
    input.projectPath,
    input.cwd,
    worktreeProjectRoot(input.cwd),
    input.timestamp,
    input.title,
    input.excerpt,
    input.planFilePath ?? null,
    input.content,
    input.derivedStatus,
  )
}

export function upsertIndexedPlan(input: IndexedPlanInput): void {
  insertPlan(input)
}

export function replaceIndexedPlansForSession(
  provider: AgentId,
  sessionId: string,
  plans: IndexedPlanInput[],
): void {
  withTx(() => {
    getDb().prepare('DELETE FROM indexed_plans WHERE provider = ? AND session_id = ?').run(provider, sessionId)
    for (const plan of plans) insertPlan(plan)
  })
}

export function replaceIndexedPlansForProvider(provider: AgentId, plans: IndexedPlanInput[]): void {
  withTx(() => {
    // A full provider rebuild reconciles live transcripts only. Rows already
    // marked unavailable are durable saved artifacts whose source transcript
    // cannot be rediscovered, so a rebuild must not erase them.
    getDb().prepare(`
      DELETE FROM indexed_plans
      WHERE provider = ? AND session_available = 1
    `).run(provider)
    for (const plan of plans) insertPlan(plan)
    getDb().prepare(`
      INSERT INTO plan_index_providers(provider, completed_at) VALUES (?, ?)
      ON CONFLICT(provider) DO UPDATE SET completed_at = excluded.completed_at
    `).run(provider, Date.now())
  })
}

export function markIndexedPlanSessionUnavailable(provider: AgentId, sessionId: string): void {
  getDb().prepare(`
    UPDATE indexed_plans SET session_available = 0
    WHERE provider = ? AND session_id = ?
  `).run(provider, sessionId)
}

export function isPlanIndexComplete(provider: AgentId): boolean {
  return !!getDb().prepare('SELECT 1 FROM plan_index_providers WHERE provider = ?').get(provider)
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

export function listIndexedPlans(
  provider: AgentId,
  projectPath: string | undefined,
  allProjects: boolean,
): PlanDescriptor[] {
  const scopedProjectPath = allProjects ? undefined : projectPath ?? process.cwd()
  const projectFilter = scopedProjectPath ? 'AND p.project_root = ?' : ''
  const params = scopedProjectPath
    ? [provider, worktreeProjectRoot(scopedProjectPath)]
    : [provider]
  const rows = indexedPlanRowSchema.array().parse(getDb().prepare(`
    SELECT
      p.provider, p.session_id, p.plan_tool_use_id, p.project_path, p.cwd, p.project_root,
      p.timestamp, p.title, p.excerpt, p.plan_file_path, p.content,
      p.derived_status, p.session_available, a.status AS annotation_status,
      a.title AS annotation_title, a.bookmarked, a.bookmarked_at, a.comments
    FROM indexed_plans p
    LEFT JOIN plan_annotations a
      ON a.session_id = p.session_id
     AND a.plan_tool_use_id = p.plan_tool_use_id
    WHERE p.provider = ? ${projectFilter}
    ORDER BY p.timestamp DESC
  `).all(...params))
  return rowsToDescriptors(rows)
}

export function loadIndexedPlanContent(
  provider: AgentId,
  sessionId: string,
  planToolUseId: string,
): string | null {
  const row = z.object({ content: z.string() }).nullish().parse(getDb().prepare(`
    SELECT content FROM indexed_plans
    WHERE provider = ? AND session_id = ? AND plan_tool_use_id = ?
  `).get(provider, sessionId, planToolUseId))
  return row?.content ?? null
}
