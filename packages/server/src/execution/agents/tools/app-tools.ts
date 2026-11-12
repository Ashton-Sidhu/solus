import { z } from 'zod'
import { readAppPage } from '@solus/contracts/apps'
import { ANY_ORGANIZATION, INTERNAL_PRINCIPAL } from '../../../admission/principal'
import { workspaceToolAuthority } from '../../../admission/workspace-tool-authority'
import { hostAccessReceiptNote } from '../../../apps/app-permissions'
import type { Apps } from '../../../apps/apps'
import { APP_PREVIEW_DEFAULT_WIDTH, APP_PREVIEW_HEIGHT, previewArtifactHtml } from '../../../data/works/artifact-preview'
import { Work } from '../../../data/works/work'
import { resolveHomePath } from '../../../platform/paths'
import type { AgentTool, AgentToolResult } from './agent-tool'
import { executeArtifactTool, type ArtifactToolDeps } from './artifact-tools'
import { readWorkFile } from './work-file'

/**
 * Agent-facing `create_app` (docs/plans/apps.md §2 decision 6): saves an app.
 * An app is an artifact whose page has an app manifest, so this is
 * `render_artifact` with three things added: it refuses a page that is not an
 * app, its preview answers the page's calls, and its receipt says what host
 * access the app waits for. A revision goes through `update_work`.
 */

let apps: Apps | null = null

/** Installed once at boot: a preview asks it what answers an app page's calls. */
export function useAppsForTools(next: Apps | null): void {
  apps = next
}

const appFields = {
  title: z.string().describe('A short title, as it reads in the works list.'),
  html_path: z.string().describe('The bundle.html that `npm run bundle` wrote in a visual-artifacts project that has an app.json, absolute or relative to your working directory.'),
  preview: z.boolean().optional().describe(`Check the app instead of saving it: you get a screenshot of its window, ${APP_PREVIEW_HEIGHT}px tall, and what the page logged. The page's calls are answered: storage from memory, a host function only for a saved app the user allowed.`),
  preview_width: z.number().int().optional().describe(`Preview width in CSS pixels, 320-1440. Defaults to ${APP_PREVIEW_DEFAULT_WIDTH}, a pane; use about 390 to check a phone.`),
  preview_appearance: z.enum(['light', 'dark']).optional().describe('Theme to preview in. Defaults to light.'),
  preview_route: z.string().optional().describe('The page of the app to preview: what its address has after "#", such as "/customers/3". Omit for its first page.'),
  work_id: z.string().optional().describe('With preview: the saved app this page revises, so the preview reads its storage and runs its host functions. To save a revision, call update_work with html_path.'),
} as const

// Every byte here is in each agent's tool list (tests/unit/agent-context-budget.json). The visual-artifacts skill holds how an app is built.
const CREATE_APP_TOOL_DESC = [
  'Save an app that lives in Solus: a full application the user asked for, with as many pages as it needs. It keeps its own data, can run its own code on the host (a database, files, any npm package), and can use the user\'s connected integrations. It opens in its own window on desktop, web, and mobile.',
  'Build it with the visual-artifacts skill and read that skill\'s app chapter first: an app.json in the project makes it an app. Pass the built bundle.html as html_path.',
  'Check it with preview: true before you save, each page with preview_route, and fix what the screenshots show. Revise a saved app with update_work and html_path; do not create a second copy.',
  'For a visual that keeps no data and calls nothing, use render_artifact.',
].join('\n')

interface CreateAppArgs {
  title: string
  html_path: string
  preview?: boolean
  preview_width?: number
  preview_appearance?: 'light' | 'dark'
  preview_route?: string
  work_id?: string
}

const createAppInputSchema = z.object({
  title: z.string().catch(''),
  html_path: z.string().catch(''),
  preview: z.boolean().optional().catch(undefined),
  preview_width: z.number().int().optional().catch(undefined),
  preview_appearance: z.enum(['light', 'dark']).optional().catch(undefined),
  preview_route: z.string().optional().catch(undefined),
  work_id: z.string().optional().catch(undefined),
})

export async function executeCreateAppTool(args: CreateAppArgs, deps: ArtifactToolDeps = {}): Promise<AgentToolResult> {
  const input = createAppInputSchema.parse(args)
  const read = await readWorkFile('html_path', input.html_path, deps.ctx?.cwd ?? '~')
  if ('error' in read) return { ok: false, text: `create_app error: ${read.error}` }
  const page = readAppPage(read.body)
  if (page.kind === 'invalid') return { ok: false, text: `create_app refused the page: ${page.problem} Build it with \`npm run bundle\` in the app project.` }
  if (page.kind === 'none') {
    return { ok: false, text: 'create_app refused the page: it has no app manifest. Add an app.json to the visual-artifacts project and run `npm run bundle` again. For a visual that keeps no data and calls nothing, call render_artifact.' }
  }
  // The artifact tool does the save and the render check; for an app, its headless page answers the page's calls.
  const host = await apps?.previewHost(read.body, input.preview ? input.work_id : undefined, workspaceToolAuthority() ?? INTERNAL_PRINCIPAL)
  const result = await executeArtifactTool(
    { title: input.title, html_path: input.html_path, preview: input.preview, preview_width: input.preview_width, preview_appearance: input.preview_appearance },
    host ? { ...deps, preview: (page) => (deps.preview ?? previewArtifactHtml)({ ...page, app: { ...host, route: input.preview_route } }) } : deps,
  )
  if (!result.ok || input.preview) return { ...result, text: result.text.replaceAll('render_artifact', 'create_app') }
  const workId = /\(id: ([^\s)]+)\)/.exec(result.text)?.[1]
  const saved = workId ? await Work.find(ANY_ORGANIZATION, workId) : null
  // The receipt keeps the artifact tool's own first sentence: the history projection reads the work id from it.
  const [first, ...rest] = result.text.split('\n\n')
  return { ...result, text: [`${first}${hostAccessReceiptNote(read.body, saved?.app?.allowed)}`, ...rest].join('\n\n') }
}

export const createAppAgentTool: AgentTool = {
  name: 'create_app',
  description: CREATE_APP_TOOL_DESC,
  inputFields: appFields,
  requiresApproval: false,
  execute: async (args, context) => executeCreateAppTool(args, {
    ctx: { sessionId: context.sessionId(), agentProvider: context.provider, cwd: resolveHomePath(context.cwd) },
    onArtifact: (artifact) => context.emit({
      type: 'artifact_created',
      toolId: context.parentToolUseId(),
      kind: 'html',
      html: artifact.html,
      workId: artifact.workId,
      title: artifact.title,
      organizationId: artifact.organizationId,
    }),
  }),
}
