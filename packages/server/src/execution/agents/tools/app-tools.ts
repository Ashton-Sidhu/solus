import { z } from 'zod'
import { appPermissionsSchema, DEFAULT_APP_PERMISSIONS, describeAppHostAccess, describeAppPermissions, type AppPermissions } from '@solus/contracts/apps'
import { workRecord } from '@solus/contracts/solus-api/records'
import { SolusApiError } from '../../../admission/workspace-error'
import { ANY_ORGANIZATION } from '../../../admission/principal'
import { workspaceToolContext } from '../../../data/workspace/tool-context'
import { Work } from '../../../data/works/work'
import { appContentProblem, appRoles, appServerHash, appServerModule, readAppContent, type AppContent } from '../../../apps/app-content'
import { hostAccessAsked, hostAccessState } from '../../../apps/app-permissions'
import { createLogger } from '../../../logger'
import { resolveHomePath } from '../../../platform/paths'
import type { AgentTool, AgentToolResult } from './agent-tool'
import { readWorkFile } from './work-file'
import { createAgentWork, type OnWorkCreated, type OnWorkUpdated, type WorkCreateCtx } from './work-tools'

const log = createLogger('apps', 'app-tools.ts')

/**
 * Agent-facing `create_app` (docs/plans/apps.md §7): an app that lives in
 * Solus, as one React component (`code`) or as the bundle an app project
 * builds (`bundle_path`, the apps skill). It is saved as an `app` work, so it
 * has history, comments, and `read_work` like any work. `work_id` updates one
 * in place.
 */

const appFields = {
  title: z.string().describe('A short title, as it reads in the works list.'),
  code: z.string().optional().describe('The quick form: ONE TSX module that `export default`s a React component. Pass this or bundle_path.'),
  bundle_path: z.string().optional().describe('The app.bundle.json that `npm run bundle` wrote in an app project (apps skill), absolute or relative to your working directory.'),
  permissions: appPermissionsSchema.optional().describe(
    'The app\'s settings. tools: "all" (default), "read-only", or { selected: ["<slug>/<tool>"] }. writes: "ask" (default) or "allow" (a write runs on click). network: hosts the app reaches, such as ["api.example.com"] or ["*"]. files: { read, write } host paths for its host functions, "*" for every path. The user allows network and files in the app\'s header.',
  ),
  work_id: z.string().optional().describe('An existing app to replace in place. Omit to make a new one.'),
  expected_content_version: z.number().int().min(0).optional().describe('Required with work_id: the content_version read_work returned.'),
} as const

// Every byte here is in each agent's tool list (tests/unit/agent-context-budget.json): say only what an app cannot be written without. The apps skill holds the rest.
const CREATE_APP_TOOL_DESC = [
  'Create an app that lives in Solus: an interactive tool the user asked for, saved as a work and opened on desktop, web, and mobile. For more than one small component, load the apps skill first: its project takes any npm package and code that runs on the host (a database, files), and its build writes the bundle you pass as `bundle_path`.',
  '`code` may import react, react-dom, @tanstack/react-query, recharts, lucide-react, and @solus/app, which has `storage`, `tools`, `useApp()`, and Button, Card, CardTitle, CardDescription, Input, Select, Badge, Table, TableHead, TableBody, TableRow, TableHeader, TableCell, Tabs, Split, NavItem, Skeleton, Empty, Stat. Tailwind works with the Solus palette (bg-card, bg-muted for hover and selected, text-muted-foreground, border-border, chart-1 … chart-6); bg-primary and bg-accent are the loud accent, for one main action.',
  '`storage.get(key)`, `.set(key, value)`, `.delete(key)`, and `.keys()` keep the app\'s own JSON data on the host. `fetch` reaches only the hosts in permissions.network, over HTTPS.',
  'Integrations are optional: `tools.<slug>.<tool>(args)` calls one with the VIEWER\'s own connection, <slug> from connection_status and <tool> the upstream tool name. With TanStack Query: `useQuery(tools.linear.list_issues.queryOptions({ team: "ENG" }))`, `useMutation(tools.github.create_issue.mutationOptions())`, `tools.linear.list_issues.pathFilter()` to invalidate. A write asks first unless writes is "allow". Name no account or credential.',
  'No <html> and no CDN scripts. Show real data, never a hard-coded array in its place. Render loading, empty, and error states. Revise with work_id; do not create a second copy.',
].join('\n')

interface CreateAppArgs {
  title: string
  code?: string
  bundle_path?: string
  permissions?: AppPermissions
  work_id?: string
  expected_content_version?: number
}

export interface AppToolDeps {
  ctx?: WorkCreateCtx
  onWorkCreated?: OnWorkCreated
  onWorkUpdated?: OnWorkUpdated
}

function rolesNote(content: AppContent): string {
  const roles = appRoles(content)
  return roles.length ? ` It reaches ${roles.join(', ')} with the viewer's own connection; a viewer without one sees a connect notice.` : ''
}

/**
 * Writes the app's permissions on a work this host holds, and answers what the
 * receipt says of its settings: the permissions it was given, and the host
 * access it still waits for. A work in an organization's Solus API keeps the
 * default until its page sets them.
 */
async function applySettings(workId: string, permissions: AppPermissions | undefined, content: AppContent): Promise<string> {
  const work = await Work.find(ANY_ORGANIZATION, workId)
  if (!work) return permissions ? ` Permissions stay at the default (${describeAppPermissions(DEFAULT_APP_PERMISSIONS)}) until the app's page sets them.` : ''
  if (permissions) await work.setAppPermissions(permissions)
  const asks = hostAccessAsked(work.app?.permissions ?? DEFAULT_APP_PERMISSIONS, appServerModule(content) !== null)
  const waits = hostAccessState(asks, appServerHash(content), work.app?.allowed) === 'pending'
  return [
    permissions ? ` Permissions: ${describeAppPermissions(permissions)}.` : '',
    waits ? ` It asks to ${describeAppHostAccess(asks)}. Tell the user to allow that in the app's header: until then, those parts of the app do not work.` : '',
  ].join('')
}

/** The app's content from the call: the component it wrote, or the bundle file its project built. */
async function contentOf(input: CreateAppArgs, cwd: string): Promise<{ text: string; content: AppContent } | { error: string }> {
  // An agent often sends an empty string for the input it does not use.
  const code = input.code?.trim() ? input.code : undefined
  const bundlePath = input.bundle_path?.trim() || undefined
  if ((code === undefined) === (bundlePath === undefined)) return { error: 'create_app takes one of code or bundle_path.' }
  let text = code ?? ''
  if (bundlePath !== undefined) {
    const read = await readWorkFile('bundle_path', bundlePath, cwd)
    if ('error' in read) return { error: read.error }
    text = read.body
  }
  const problem = appContentProblem(text)
  if (problem) return { error: `create_app refused the app: ${problem}` }
  const content = readAppContent(text)
  if (bundlePath !== undefined && content.kind !== 'bundle') return { error: `bundle_path does not name an app bundle: ${bundlePath}. Run \`npm run bundle\` in the app project and pass its app.bundle.json.` }
  return { text, content }
}

/** Replaces an app in place. The work's host validates the body again; a stale version saves nothing. */
async function updateApp(workId: string, title: string, app: { text: string; content: AppContent }, input: CreateAppArgs, deps: AppToolDeps): Promise<AgentToolResult> {
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
    saved = await operations.updateWork(context, workId, { content: app.text, title, expectedContentVersion: input.expected_content_version }, existing.updatedAt)
  } catch (error) {
    if (error instanceof SolusApiError && error.code === 'STALE_VERSION') return { ok: false, text: `Stale write: "${existing.title}" changed after you read it. Nothing was saved. Call read_work again and pass its content_version.` }
    if (error instanceof SolusApiError && error.code === 'INVALID_REQUEST') return { ok: false, text: error.message }
    throw error
  }
  const settingsNote = await applySettings(saved.id, input.permissions, app.content)
  deps.onWorkUpdated?.({ workId: saved.id, title: saved.title, docType: 'app', content: saved.content, updatedAt: saved.updatedAt, contentVersion: saved.contentVersion, organizationId: context.home.kind === 'organization' ? context.home.organizationId : null })
  // The result text starts as it does on purpose: the history projection reads the work id from it.
  return { ok: true, text: `Updated the app "${saved.title}" (id: ${saved.id}). New content_version: ${saved.contentVersion}.${settingsNote}${rolesNote(app.content)}` }
}

export async function executeCreateAppTool(args: CreateAppArgs, deps: AppToolDeps = {}): Promise<AgentToolResult> {
  try {
    const input = createAppInputSchema.parse(args)
    const title = input.title.trim()
    if (!title) return { ok: false, text: 'create_app requires a title.' }
    // Permissions that do not parse are refused, never dropped: an app saved without the hosts it asked for would fail with no word of why.
    const permissions = appPermissionsSchema.optional().safeParse(args.permissions)
    if (!permissions.success) return { ok: false, text: `create_app refused the permissions: ${permissions.error.issues[0]?.path.join('.') ?? 'permissions'}: ${permissions.error.issues[0]?.message ?? 'not valid'}. Nothing was saved.` }
    const app = await contentOf(input, deps.ctx?.cwd ?? '~')
    if ('error' in app) return { ok: false, text: app.error }
    const settled = { ...input, permissions: permissions.data }
    if (input.work_id) return await updateApp(input.work_id, title, app, settled, deps)

    const created = await createAgentWork(title, 'app', app.text, deps.ctx, false)
    const settingsNote = await applySettings(created.workId, settled.permissions, app.content)
    deps.onWorkCreated?.({ workId: created.workId, title: created.title, docType: 'app', content: app.text, organizationId: created.organizationId })
    // The result text starts as it does on purpose: the history projection reads the work id from it.
    return {
      ok: true,
      text: `Created the app "${created.title}" (id: ${created.workId}). It opens from the conversation and the works list. Revise it with create_app and work_id ${created.workId}.${settingsNote}${rolesNote(app.content)}`,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('create_app_failed', { error: message })
    return { ok: false, text: `create_app error: ${message}` }
  }
}

const createAppInputSchema = z.object({
  title: z.string().catch(''),
  code: z.string().optional().catch(undefined),
  bundle_path: z.string().optional().catch(undefined),
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
