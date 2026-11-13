import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type { AppSummary } from '@solus/contracts/apps'
import { integrationToolName } from '@solus/contracts/integration-types'
import { actorFor, type Actor } from '../../../admission/actor'
import { INTERNAL_PRINCIPAL } from '../../../admission/principal'
import { workspaceToolAuthority } from '../../../admission/workspace-tool-authority'
import { AppProjectError, readAppBuild } from '../../../apps/app-project'
import { mayUseApps, type AppAuthority, type Apps } from '../../../apps/apps'
import { APP_PREVIEW_DEFAULT_WIDTH, APP_PREVIEW_HEIGHT, previewArtifactHtml, type HtmlPreview } from '../../../data/works/artifact-preview'
import { linkSessionItem } from '../../../data/sessions/session-links'
import { workspaceToolContext } from '../../../data/workspace/tool-context'
import { inputFieldsFor } from '../../../integrations/integration-tools'
import { createLogger } from '../../../logger'
import { resolveHomePath } from '../../../platform/paths'
import { toolAgentAttribution } from './agent-attribution'
import { agentToolImageFromDataUrl, type AgentTool, type AgentToolContext, type AgentToolResult } from './agent-tool'

const log = createLogger('apps', 'app-tools.ts')

/**
 * The agent's tools for apps (docs/plans/apps.md §7): `deploy_app` makes a
 * version from an app project, `preview_app` shows the agent the project's
 * UI and deploys nothing, `checkout_app` writes a version's source into a
 * folder, and `list_apps` says what the host has. Each operation of a
 * running app is also a tool of its own, named `<slug>__<operation>` as an
 * integration's tools are.
 */

let apps: Apps | null = null

/** Installed once at boot. */
export function useAppsForTools(next: Apps | null): void {
  apps = next
}

function requireApps(): Apps {
  if (!apps) throw new Error('This host does not run apps.')
  return apps
}

/** The person the tool call acts for, as the Apps service checks them. */
function toolAuthority(): AppAuthority {
  const principal = workspaceToolAuthority() ?? INTERNAL_PRINCIPAL
  return { principal, actor: actorFor(principal) }
}

function folderOf(context: AgentToolContext, named: string): string {
  return resolve(resolveHomePath(context.cwd), resolveHomePath(named.trim()))
}

const RESULT_MAX_CHARS = 60_000
const MAX_REPORTED_CONSOLE_ENTRIES = 20

// Every byte here is in each agent's tool list (tests/unit/agent-context-budget.json). The visual-artifacts skill holds how an app is built.
const DEPLOY_APP_DESC = [
  'Deploy an app that lives in Solus: a program on this host with a backend, its own SQLite data, and a UI. Its operations are also tools for agents, schedules, and webhooks.',
  'Build it with the visual-artifacts skill (read its app chapter first), run `npm run bundle`, and pass the project folder as path. Check the UI with preview_app first. A deploy makes the version active at once.',
  'For a visual that keeps no data and calls nothing, use render_artifact.',
].join('\n')

const PROJECT_PATH = 'The app project folder, after `npm run bundle`: absolute, or relative to your working directory.'

const deployFields = {
  path: z.string().describe(PROJECT_PATH),
  app: z.string().optional().describe('The slug of the app this is a new version of. Omit to make a new app.'),
  message: z.string().optional().describe('What this version changes, in one line.'),
} as const

const previewFields = {
  path: z.string().describe(PROJECT_PATH),
  width: z.number().int().optional().describe(`CSS pixels, 320-1440. Defaults to ${APP_PREVIEW_DEFAULT_WIDTH}; use about 390 for a phone.`),
  appearance: z.enum(['light', 'dark']).optional(),
  route: z.string().optional().describe('The page to show: what its address has after "#", such as "/customers/3".'),
} as const

type PreviewInput = z.output<z.ZodObject<typeof previewFields>>

async function previewReport(name: string, preview: HtmlPreview): Promise<AgentToolResult> {
  const image = await agentToolImageFromDataUrl(preview.screenshot)
  const logged = preview.console.slice(0, MAX_REPORTED_CONSOLE_ENTRIES).map((entry) => `  [${entry.level}] ${entry.text.slice(0, 300)}`)
  const lines = [
    `Preview of "${name}" at ${preview.width}px, ${preview.appearance}. Nothing was deployed.`,
    image ? 'screenshot: attached to this result.' : 'screenshot: too large to attach. Preview at a smaller width.',
    logged.length ? `console (${preview.console.length}):\n${logged.join('\n')}` : 'console: nothing logged.',
  ]
  const report: AgentToolResult = { ok: true, text: lines.join('\n') }
  if (image) report.image = image
  return report
}

async function previewApp(input: PreviewInput, folder: string): Promise<AgentToolResult> {
  const build = await readAppBuild(folder)
  if (build.ui === null) return { ok: false, text: 'preview_app: this app has no UI to preview. Its operations are what an agent and a schedule call.' }
  const scratch = await mkdtemp(join(tmpdir(), 'solus-app-preview-'))
  const filesDir = join(scratch, 'files')
  await mkdir(filesDir)
  const { host, dispose } = await requireApps().previewHost(toolAuthority(), build, { appFolder: scratch, filesDir })
  try {
    return await previewReport(build.descriptor.name, await previewArtifactHtml({
      html: build.ui,
      width: input.width,
      appearance: input.appearance,
      app: input.route ? { ...host, route: input.route } : host,
    }))
  } finally {
    dispose()
    await rm(scratch, { recursive: true, force: true })
  }
}

/**
 * Links the app to the session that deployed it (decision 18), on this host.
 * An organization session's links are on its Solus API, which holds no app
 * links yet, so it gets none. Answers whether the link is there.
 */
async function linkAppToSession(app: AppSummary, context: AgentToolContext): Promise<boolean> {
  const sessionId = context.sessionId()
  if (!sessionId) return false
  try {
    const home = await workspaceToolContext(sessionId)
    if (home.remote || home.context.home.kind !== 'local') return false
    await linkSessionItem(sessionId, { target: { kind: 'app', targetId: app.id, hostId: home.context.home.hostId }, title: app.name }, await toolAgentAttribution({ sessionId, agentProvider: context.provider }))
    return true
  } catch (error) {
    // The deploy stands without the link.
    log.warn('app_session_link_failed', { appId: app.id, sessionId, error: error instanceof Error ? error.message : String(error) })
    return false
  }
}

export const deployAppAgentTool: AgentTool<typeof deployFields> = {
  name: 'deploy_app',
  description: DEPLOY_APP_DESC,
  inputFields: deployFields,
  requiresApproval: true,
  execute: async (input, context) => {
    const folder = folderOf(context, input.path)
    try {
      const sessionId = context.sessionId()
      const deployed = await requireApps().deploy(toolAuthority(), {
        project: folder,
        app: input.app?.trim() || undefined,
        message: input.message,
        createdBy: await toolAgentAttribution({ sessionId, agentProvider: context.provider }),
        sessionId: sessionId ?? null,
      })
      const isLinked = await linkAppToSession(deployed.app, context)
      const { app } = deployed
      const lines = [deployed.active
        ? `Deployed "${app.name}" (app: ${app.slug}, id: ${app.id}) as version ${deployed.version}. It is active${isLinked ? ' and linked to this session' : ''}.`
        : `Version ${deployed.version} of "${app.name}" (app: ${app.slug}) did not start: ${deployed.error}${app.activeVersion === null ? ' The app has no version that runs.' : ` Version ${app.activeVersion} still runs.`} Fix it and deploy again with app: "${app.slug}".`]
      if (deployed.permissionsNotice) lines.push(deployed.permissionsNotice)
      if (deployed.secretsMissing.length) lines.push(`Not set: ${deployed.secretsMissing.join(', ')}. Tell the user to set ${deployed.secretsMissing.length === 1 ? 'it' : 'them'} in the app's menu, under Secrets. An operation that needs one fails until then.`)
      if (app.operationCount > 0 && deployed.active) lines.push(`Its operations are tools named ${app.slug}__<operation> from the next turn.`)
      return { ok: deployed.active, text: lines.join('\n') }
    } catch (error) {
      if (error instanceof AppProjectError) return { ok: false, text: `deploy_app refused the project: ${error.message}` }
      return { ok: false, text: `deploy_app failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  },
}

export const previewAppAgentTool: AgentTool<typeof previewFields> = {
  name: 'preview_app',
  description: `Check an app project's UI before you deploy it: a screenshot of its window, ${APP_PREVIEW_HEIGHT}px tall, and what it logged. Nothing is deployed. Its operations run against a new, empty database.`,
  inputFields: previewFields,
  requiresApproval: false,
  execute: async (input, context) => {
    try {
      return await previewApp(input, folderOf(context, input.path))
    } catch (error) {
      if (error instanceof AppProjectError) return { ok: false, text: `preview_app refused the project: ${error.message}` }
      return { ok: false, text: `preview_app failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  },
}

const checkoutFields = {
  app: z.string().describe('The slug of the app.'),
  path: z.string().describe('A new or empty folder for the source.'),
  version: z.number().int().min(1).optional().describe('Omit for the newest.'),
} as const

export const checkoutAppAgentTool: AgentTool<typeof checkoutFields> = {
  name: 'checkout_app',
  description: 'Write the source of an app into a folder, so you can change it and deploy a new version.',
  inputFields: checkoutFields,
  requiresApproval: false,
  execute: async (input, context) => {
    try {
      const folder = folderOf(context, input.path)
      const written = await requireApps().checkout(toolAuthority(), input.app.trim(), folder, input.version)
      return { ok: true, text: `Wrote the source of "${written.app.name}" version ${written.version} to ${folder} (${written.files} files). Run \`npm install\` there before \`npm run bundle\`. Deploy the change with app: "${written.app.slug}".` }
    } catch (error) {
      return { ok: false, text: `checkout_app failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  },
}

export const listAppsAgentTool: AgentTool = {
  name: 'list_apps',
  description: 'List the apps of this host with their operations and what needs the user.',
  inputFields: {},
  requiresApproval: false,
  execute: async () => {
    const service = requireApps()
    const authority = toolAuthority()
    const listed = await service.list(authority)
    if (listed.length === 0) return { ok: true, text: 'This host has no apps.' }
    const lines: string[] = []
    for (const app of listed) {
      const state = app.activeVersion === null ? 'no version runs' : `version ${app.activeVersion} runs${app.stopped ? ' (stopped)' : ''}`
      lines.push(`- ${app.slug} (id: ${app.id}): "${app.name}", ${state}${app.hasUi ? ', has a UI' : ''}`)
      const descriptor = (await service.read(authority, app.id)).descriptor
      for (const operation of descriptor?.operations ?? []) lines.push(`    ${operation.kind} ${operation.name}${operation.description ? `: ${operation.description}` : ''}`)
      for (const item of app.attention) lines.push(`    needs the user: ${item.detail}`)
    }
    return { ok: true, text: lines.join('\n') }
  },
}

/**
 * The operations of the host's running apps as agent tools (§7.1), for a
 * run's person. A name another tool of the run already has is left out: an
 * integration the person added after the app keeps its tools.
 */
export async function appOperationAgentTools(actor: Actor, taken: ReadonlySet<string>): Promise<AgentTool[]> {
  const service = apps
  const authority: AppAuthority = { principal: actor.principal, actor }
  if (!service || !mayUseApps(actor.principal)) return []
  const tools: AgentTool[] = []
  for (const { app, descriptor } of await service.running(authority)) {
    for (const operation of descriptor.operations) {
      const name = integrationToolName(app.slug, operation.name)
      if (taken.has(name)) {
        log.warn('app_tool_name_taken', { appId: app.id, operation: operation.name, name })
        continue
      }
      const fields = inputFieldsFor({ ...operation.input, type: 'object' })
      const tool: AgentTool = {
        name,
        description: `${app.name}: ${operation.description || operation.name}`.slice(0, 1000),
        inputFields: fields ?? {},
        alwaysLoad: false,
        requiresApproval: false,
        execute: async (input, context) => {
          try {
            const value = await service.callOperation(app.id, operation.name, input, { kind: 'agent', sessionId: context.sessionId() ?? null }, authority)
            const text = JSON.stringify(value, null, 1) ?? 'null'
            return { ok: true, text: text.length > RESULT_MAX_CHARS ? `${text.slice(0, RESULT_MAX_CHARS)}\n… (cut at ${RESULT_MAX_CHARS} characters; ask for less)` : text }
          } catch (error) {
            return { ok: false, text: error instanceof Error ? error.message : String(error) }
          }
        },
      }
      if (!fields) tool.passthroughInput = true
      tools.push(tool)
    }
  }
  return tools
}

/** The app a `link` or an `unlink` names, for the tool's authority. */
export async function linkedAppNamed(named: string): Promise<{ id: string; name: string }> {
  const app = await requireApps().record(toolAuthority(), named)
  return { id: app.id, name: app.name }
}
