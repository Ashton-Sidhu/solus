import { z } from 'zod'
import { appPermissionsSchema, DEFAULT_APP_PERMISSIONS, describeAppPermissions, type AppPermissions } from '@solus/contracts/apps'
import { workRecord } from '@solus/contracts/solus-api/records'
import { SolusApiError } from '../../../admission/workspace-error'
import { ANY_ORGANIZATION } from '../../../admission/principal'
import { workspaceToolContext } from '../../../data/workspace/tool-context'
import { Work } from '../../../data/works/work'
import { appSourceProblem, extractAppRoles } from '../../../apps/app-source'
import { createLogger } from '../../../logger'
import { resolveHomePath } from '../../../platform/paths'
import type { AgentTool, AgentToolResult } from './agent-tool'
import { createAgentWork, type OnWorkCreated, type OnWorkUpdated, type WorkCreateCtx } from './work-tools'

const log = createLogger('apps', 'app-tools.ts')

/**
 * Agent-facing `create_app` (docs/plans/apps.md §6): one React component that
 * reaches the viewer's own integrations through `tools.<slug>.<tool>`. The
 * component is saved as an `app` work, so it has history, comments, and
 * `read_work`/`update_work` like any work. `work_id` updates one in place.
 */

const appFields = {
  title: z.string().describe('A short title, as it reads in the works list.'),
  code: z.string().describe('ONE TSX module that `export default`s a React component.'),
  permissions: appPermissionsSchema.optional().describe(
    'The app\'s own ceiling. tools: "all" (default), "read-only", or { selected: ["<slug>/<tool>"] }. writes: "ask" (default) or "allow" (a write runs on click).',
  ),
  work_id: z.string().optional().describe('An existing app to replace in place. Omit to make a new one.'),
  expected_content_version: z.number().int().min(0).optional().describe('Required with work_id: the content_version read_work returned.'),
} as const

// Every byte here is in each agent's tool list (tests/unit/agent-context-budget.json): say only what the code cannot be written without.
const CREATE_APP_TOOL_DESC = [
  'Create an app: one interactive React component over the user\'s own integrations, saved as a work and opened on desktop, web, and mobile.',
  '`code` may import react, react-dom, @tanstack/react-query, recharts, lucide-react, and @solus/app, which has `tools`, `useApp()`, and Button, Card, CardTitle, CardDescription, Input, Select, Badge, Table, TableHead, TableBody, TableRow, TableHeader, TableCell, Tabs, Skeleton, Empty, Stat. Tailwind works with the Solus palette (bg-card, text-muted-foreground, border-border, bg-primary, chart-1 … chart-6).',
  'Call an integration as `tools.<slug>.<tool>(args)`: <slug> from connection_status, <tool> the upstream tool name. With TanStack Query: `useQuery(tools.linear.list_issues.queryOptions({ team: "ENG" }))`, `useMutation(tools.github.create_issue.mutationOptions())`, and `tools.linear.list_issues.pathFilter()` to invalidate. A call answers the tool\'s structured content, else its text parsed as JSON.',
  'Each call runs with the VIEWER\'s own connection under the app\'s permissions; a write asks first unless writes is "allow". Name no account or credential. No <html>, fetch, or CDN scripts. Live data comes from `tools`, never a hard-coded array. Render loading, empty, and error states.',
  'Revise with work_id or update_work; do not create a second copy.',
].join('\n')

interface CreateAppArgs {
  title: string
  code: string
  permissions?: AppPermissions
  work_id?: string
  expected_content_version?: number
}

export interface AppToolDeps {
  ctx?: WorkCreateCtx
  onWorkCreated?: OnWorkCreated
  onWorkUpdated?: OnWorkUpdated
}

function rolesNote(code: string): string {
  const roles = extractAppRoles(code)
  return roles.length ? ` It reaches ${roles.join(', ')} with the viewer's own connection; a viewer without one sees a connect notice.` : ' It names no integration.'
}

/** Writes the app's permissions on a work this host holds. A work in an organization's Solus API keeps the default until its page sets them. */
async function applyPermissions(workId: string, permissions: AppPermissions | undefined): Promise<string> {
  if (!permissions) return ''
  const work = await Work.find(ANY_ORGANIZATION, workId)
  if (!work) return ` Permissions stay at the default (${describeAppPermissions(DEFAULT_APP_PERMISSIONS)}) until the app's page sets them.`
  await work.setAppPermissions(permissions)
  return ` Permissions: ${describeAppPermissions(permissions)}.`
}

/** Replaces an app in place. The work's host validates the body again; a stale version saves nothing. */
async function updateApp(workId: string, title: string, input: CreateAppArgs, deps: AppToolDeps): Promise<AgentToolResult> {
  if (input.expected_content_version === undefined) return { ok: false, text: 'create_app with work_id requires expected_content_version: the content_version read_work returned.' }
  const { operations, context } = await workspaceToolContext(deps.ctx?.sessionId)
  const current = await operations.getWork(context, workId).catch((error) => {
    if (error instanceof SolusApiError && error.status === 404 && error.code !== 'MOVED') return null
    throw error
  })
  const existing = current ? workRecord(current) : null
  if (!existing) return { ok: false, text: `No work found with id "${workId}".` }
  if (existing.type !== 'app') return { ok: false, text: `"${existing.title}" is a ${existing.type}, not an app. Nothing was saved.` }
  let saved
  try {
    saved = await operations.updateWork(context, workId, { content: input.code, title, expectedContentVersion: input.expected_content_version }, existing.updatedAt)
  } catch (error) {
    if (error instanceof SolusApiError && error.code === 'STALE_VERSION') return { ok: false, text: `Stale write: "${existing.title}" changed after you read it. Nothing was saved. Call read_work again and pass its content_version.` }
    if (error instanceof SolusApiError && error.code === 'INVALID_REQUEST') return { ok: false, text: error.message }
    throw error
  }
  const permissionsNote = await applyPermissions(saved.id, input.permissions)
  deps.onWorkUpdated?.({ workId: saved.id, title: saved.title, docType: 'app', content: saved.content, updatedAt: saved.updatedAt, contentVersion: saved.contentVersion, organizationId: context.home.kind === 'organization' ? context.home.organizationId : null })
  // The result text starts as it does on purpose: the history projection reads the work id from it.
  return { ok: true, text: `Updated the app "${saved.title}" (id: ${saved.id}). New content_version: ${saved.contentVersion}.${permissionsNote}${rolesNote(input.code)}` }
}

export async function executeCreateAppTool(args: CreateAppArgs, deps: AppToolDeps = {}): Promise<AgentToolResult> {
  try {
    const input = createAppInputSchema.parse(args)
    const title = input.title.trim()
    if (!title) return { ok: false, text: 'create_app requires a title.' }
    const problem = appSourceProblem(input.code)
    if (problem) return { ok: false, text: `create_app refused the code: ${problem}` }
    if (input.work_id) return await updateApp(input.work_id, title, input, deps)

    const created = await createAgentWork(title, 'app', input.code, deps.ctx, false)
    const permissionsNote = await applyPermissions(created.workId, input.permissions)
    deps.onWorkCreated?.({ workId: created.workId, title: created.title, docType: 'app', content: input.code, organizationId: created.organizationId })
    // The result text starts as it does on purpose: the history projection reads the work id from it.
    return {
      ok: true,
      text: `Created the app "${created.title}" (id: ${created.workId}). It opens from the conversation and the works list. Revise it with create_app and work_id ${created.workId}.${permissionsNote}${rolesNote(input.code)}`,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('create_app_failed', { error: message })
    return { ok: false, text: `create_app error: ${message}` }
  }
}

const createAppInputSchema = z.object({
  title: z.string().catch(''),
  code: z.string().catch(''),
  permissions: appPermissionsSchema.optional().catch(undefined),
  work_id: z.string().optional().catch(undefined),
  expected_content_version: z.number().int().optional().catch(undefined),
})

export const createAppAgentTool: AgentTool = {
  name: 'create_app',
  description: CREATE_APP_TOOL_DESC,
  inputFields: appFields,
  requiresApproval: false,
  execute: async (args, context) => executeCreateAppTool(args, {
    ctx: { sessionId: context.sessionId(), agentProvider: context.provider, cwd: resolveHomePath(context.cwd) },
    onWorkCreated: (work) => context.emit({ type: 'work_created', workId: work.workId, title: work.title, docType: work.docType, content: work.content, organizationId: work.organizationId }),
    onWorkUpdated: (work) => context.emit({ type: 'work_updated', toolId: context.parentToolUseId(), workId: work.workId, title: work.title, docType: work.docType, content: work.content, updatedAt: work.updatedAt, contentVersion: work.contentVersion, organizationId: work.organizationId }),
  }),
}
