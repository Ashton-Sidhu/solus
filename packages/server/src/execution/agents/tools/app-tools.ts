import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { appAccessModeSchema, appPlatformKindSchema, appVisitorRoleSchema } from '@solus/contracts/app-deployments'
import { appSignalActionSchema, appSignalNameSchema, type AppCallView, type AppCaller, type AppOperation, type AppSummary } from '@solus/contracts/apps'
import type { AppModelCallView } from '@solus/contracts/app-models'
import { integrationToolName } from '@solus/contracts/integration-types'
import { HOST_USE } from '@solus/contracts/permissions'
import { actorFor, type Actor } from '../../../admission/actor'
import { INTERNAL_PRINCIPAL } from '../../../admission/principal'
import { workspaceToolAuthority } from '../../../admission/workspace-tool-authority'
import { AppBuildError, type AppBuilder } from '../../../apps/app-builder'
import { AppProjectError } from '../../../apps/app-project'
import type { AppModelCalls } from '../../../apps/app-model-calls'
import type { AppSignals } from '../../../apps/app-signals'
import type { AppWorkflows } from '../../../apps/app-workflows'
import { mayUseApps, type AppAuthority, type Apps } from '../../../apps/apps'
import type { AppDeployments } from '../../../apps/deployments/app-deployments'
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
 * The agent's tools for apps (docs/plans/apps.md §7): `save_app` commits an
 * app project as a revision, `deploy_app` has the host build a revision and
 * make it the active version, `preview_app` shows the agent the project's UI
 * and saves nothing, `checkout_app` writes a revision's source into a folder,
 * `list_apps` says what the host has, `inspect_app` reads what an agent needs
 * to repair an app, `retry_app_run` starts a failed workflow run again on the
 * active version, and `set_app_signal_action` makes a signal do something.
 * Each operation of a running app is also a tool of its own, named
 * `<slug>__<operation>` as an integration's tools are.
 */

/** The parts of the apps domain the tools reach. */
export interface AppToolParts {
  apps: Apps
  builder: AppBuilder
  workflows: AppWorkflows
  signals: AppSignals
  modelCalls: AppModelCalls
  /** Where an app is published (docs/plans/app-deploy.md). Absent on a host that cannot publish. */
  deployments?: AppDeployments
}

let parts: AppToolParts | null = null

/** Installed once at boot. */
export function useAppsForTools(next: AppToolParts | null): void {
  parts = next
}

function requireParts(): AppToolParts {
  if (!parts) throw new Error('This host does not run apps.')
  return parts
}

/** The person the tool call acts for, as the Apps service checks them. */
function toolAuthority(): AppAuthority {
  const principal = workspaceToolAuthority() ?? INTERNAL_PRINCIPAL
  return { principal, actor: actorFor(principal) }
}

function folderOf(context: AgentToolContext, named: string): string {
  return resolve(resolveHomePath(context.cwd), resolveHomePath(named.trim()))
}

/** What a tool answers for a failure: a project the host refuses, a build that failed, or anything else. */
function refusal(tool: string, error: Error): AgentToolResult {
  if (error instanceof AppProjectError) return { ok: false, text: `${tool} refused the project: ${error.message}` }
  if (error instanceof AppBuildError) return { ok: false, text: `${tool}: ${error.message}\n\nThe end of the build log:\n${error.log.slice(-BUILD_LOG_TAIL_CHARS)}` }
  return { ok: false, text: `${tool} failed: ${error.message}` }
}

function thrown(error: Error | string): Error {
  return error instanceof Error ? error : new Error(error)
}

const RESULT_MAX_CHARS = 60_000
const MAX_REPORTED_CONSOLE_ENTRIES = 20
const BUILD_LOG_TAIL_CHARS = 4000
const OUTPUT_SCHEMA_MAX_CHARS = 500

// Every byte here is in each agent's tool list (tests/unit/agent-context-budget.json). The create-app skill holds how an app is built.
const SAVE_APP_DESC = [
  'Save an app project as a new revision of an app that lives in Solus: a program on this host with a backend, its own SQLite data, and a UI. Its operations are also tools for agents, schedules, and webhooks.',
  'Build it with the create-app skill (start from its starter app), and check the UI with preview_app. A save changes nothing that runs: deploy_app makes the revision run.',
  'For a visual that keeps no data and calls nothing, use render_artifact.',
].join('\n')

const PROJECT_PATH = 'The app project folder: absolute, or relative to your working directory.'

const saveFields = {
  path: z.string().describe(PROJECT_PATH),
  app: z.string().optional().describe('The slug of the app. Omit for a new app, and for a folder that checkout_app or an earlier save wrote.'),
  name: z.string().optional().describe('The name of a new app, when app.ts does not give it as plain text.'),
  message: z.string().optional().describe('What this revision changes, in one line.'),
} as const

const deployFields = {
  app: z.string().describe('The slug of the app.'),
  revision: z.string().optional().describe('The revision to build. Omit for the newest.'),
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
    `Preview of "${name}" at ${preview.width}px, ${preview.appearance}. Nothing was saved or deployed.`,
    image ? 'screenshot: attached to this result.' : 'screenshot: too large to attach. Preview at a smaller width.',
    logged.length ? `console (${preview.console.length}):\n${logged.join('\n')}` : 'console: nothing logged.',
  ]
  const report: AgentToolResult = { ok: true, text: lines.join('\n') }
  if (image) report.images = [image]
  return report
}

async function previewApp(input: PreviewInput, folder: string): Promise<AgentToolResult> {
  const { apps, builder } = requireParts()
  // The host builds the folder in place, with the bundler a deploy uses.
  const { build } = await builder.buildProject(folder)
  if (build.ui === null) return { ok: true, text: `The project builds: ${build.descriptor.operations.length} operations, ${build.migrations.length} migrations. This app has no UI to preview: its operations are what an agent and a schedule call.` }
  const scratch = await mkdtemp(join(tmpdir(), 'solus-app-preview-'))
  const filesDir = join(scratch, 'files')
  await mkdir(filesDir)
  const { host, dispose } = await apps.previewHost(toolAuthority(), build, { appFolder: scratch, filesDir })
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
 * Links the app to the session that deployed it (decision 19), on this host.
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

export const saveAppAgentTool: AgentTool<typeof saveFields> = {
  name: 'save_app',
  description: SAVE_APP_DESC,
  inputFields: saveFields,
  requiresApproval: false,
  execute: async (input, context) => {
    try {
      const sessionId = context.sessionId()
      const saved = await requireParts().apps.save(toolAuthority(), {
        project: folderOf(context, input.path),
        app: input.app?.trim() || undefined,
        name: input.name,
        message: input.message,
        createdBy: await toolAgentAttribution({ sessionId, agentProvider: context.provider }),
      })
      const { app } = saved
      const lines = [`Saved ${saved.created ? 'the new app' : 'a new revision of'} "${app.name}" (app: ${app.slug}), revision ${saved.revision.slice(0, 7)}. Nothing that runs changed.`]
      if (saved.removed.length) lines.push(`This revision removed ${saved.removed.length} file${saved.removed.length === 1 ? '' : 's'} that the revision before it had: ${saved.removed.slice(0, 20).join(', ')}${saved.removed.length > 20 ? ', …' : ''}. If that is wrong, put them back and save again.`)
      lines.push(`Deploy it with deploy_app and app: "${app.slug}".`)
      return { ok: true, text: lines.join('\n') }
    } catch (error) {
      return refusal('save_app', thrown(error instanceof Error ? error : String(error)))
    }
  },
}

export const deployAppAgentTool: AgentTool<typeof deployFields> = {
  name: 'deploy_app',
  description: 'Deploy a saved revision of an app: this host builds it and makes the version run at once. A version that fails does not replace the one that runs. Save the project with save_app first.',
  inputFields: deployFields,
  requiresApproval: true,
  execute: async (input, context) => {
    try {
      const sessionId = context.sessionId()
      const deployed = await requireParts().apps.deploy(toolAuthority(), {
        app: input.app.trim(),
        revision: input.revision?.trim() || undefined,
        createdBy: await toolAgentAttribution({ sessionId, agentProvider: context.provider }),
        sessionId: sessionId ?? null,
      })
      const { app } = deployed
      if (!deployed.active) {
        const lines = [`Version ${deployed.version} of "${app.name}" (app: ${app.slug}) failed: ${deployed.error}${app.activeVersion === null ? ' The app has no version that runs.' : ` Version ${app.activeVersion} still runs.`}`]
        if (deployed.buildLog) lines.push(`The end of the build log:\n${deployed.buildLog.slice(-BUILD_LOG_TAIL_CHARS)}`)
        lines.push('Fix the project, save it with save_app, and deploy again.')
        return { ok: false, text: lines.join('\n') }
      }
      const isLinked = await linkAppToSession(app, context)
      const lines = [`Deployed "${app.name}" (app: ${app.slug}, id: ${app.id}) as version ${deployed.version}. It is active${isLinked ? ' and linked to this session' : ''}.`]
      if (deployed.permissionsNotice) lines.push(deployed.permissionsNotice)
      if (deployed.secretsMissing.length) lines.push(`Not set: ${deployed.secretsMissing.join(', ')}. Tell the user to set ${deployed.secretsMissing.length === 1 ? 'it' : 'them'} on the app's Manage page, under Secrets. An operation that needs one fails until then.`)
      if (app.operationCount > 0) lines.push(app.agentAccess ? `Its operations are tools named ${app.slug}__<operation> from the next turn.` : 'The owner turned off agent access for this app, so its operations are not tools.')
      // A fix is proven when the run that failed passes on it: the deploy alone leaves that failure in front of the owner.
      const stale = app.attention.filter((item) => item.kind === 'workflow-stale')
      if (stale.length) {
        lines.push(`Failed on an older version: ${stale.map((item) => `${item.detail} (run ${item.runId})`).join(' ')}`)
        lines.push(`If this version fixes ${stale.length === 1 ? 'it' : 'them'}, run ${stale.length === 1 ? 'it' : 'each'} again with retry_app_run and check the result with inspect_app before you tell the user it is fixed.`)
      }
      return { ok: true, text: lines.join('\n') }
    } catch (error) {
      return refusal('deploy_app', thrown(error instanceof Error ? error : String(error)))
    }
  },
}

const retryRunFields = {
  app: z.string().describe('The slug of the app.'),
  run_id: z.string().describe('The id of the failed run, from deploy_app or inspect_app.'),
} as const

const publishFields = {
  app: z.string().describe('The slug of the app.'),
  platform: appPlatformKindSchema.optional().describe('Where the copy runs, on a first publish: "docker" is a container (the default), "solus-cloud" is Solus Cloud, where it runs while this host is off.'),
  host: z.string().optional().describe('On a first publish to "docker": the id or the name of another host of the user that runs the container. Omit it to run the container on this host.'),
  access: appAccessModeSchema.optional().describe('Who the published copy answers: "link" is each person who has its link (the default of a first publish; private until the link is given), "public" is each person, "people" is only the people that the user names in the Deployment section of the Manage page, who each sign in to Solus. Omit it to keep what the copy has.'),
  role: appVisitorRoleSchema.optional().describe('What a visitor may do: "editor" runs queries and mutations (the default of a first publish), "viewer" runs queries only. Omit it to keep what the copy has.'),
  new_link: z.boolean().optional().describe('True makes a new link: the old one stops.'),
} as const

function requireDeployments(): AppDeployments {
  const { deployments } = requireParts()
  if (!deployments) throw new Error('This host cannot publish an app.')
  return deployments
}

export const publishAppAgentTool: AgentTool<typeof publishFields> = {
  name: 'publish_app',
  description: 'Publish the active version of an app: it runs as a copy in a container of its own, with its own data and an address that other people open in a browser. The app in Solus does not change. Deploy the version with deploy_app first. A published copy uses only the app\'s `appIntegrations`.',
  inputFields: publishFields,
  requiresApproval: true,
  execute: async (input) => {
    try {
      const published = await requireDeployments().publish(toolAuthority(), { appId: input.app.trim(), platform: input.platform, hostId: input.host?.trim() || undefined, access: input.access, role: input.role, newLink: input.new_link })
      const { deployment } = published
      if (!published.active) return { ok: false, text: `Version of "${input.app}" did not start in its deployment: ${published.error} Version ${deployment.version} still runs there. Fix the app, deploy it with deploy_app, and publish again.` }
      const who = { public: 'It is public: each person who has the address can open it.', link: 'It is private: only a person who has the link can open it.', people: 'Only the user and the people they named can open it, after a sign-in to Solus. The user names them in the Deployment section of the Manage page.' }[deployment.access]
      const lines = [`Published version ${deployment.version} of "${input.app}". ${who}`]
      lines.push(`Give the user this ${deployment.access === 'link' ? 'link' : 'address'}, exactly as it is: ${deployment.link}`)
      lines.push('The published copy has its own data. What the user did in the app in Solus is not there.')
      return { ok: true, text: lines.join('\n') }
    } catch (error) {
      return refusal('publish_app', thrown(error instanceof Error ? error : String(error)))
    }
  },
}

const exportFields = {
  app: z.string().describe('The slug of the app.'),
  path: z.string().describe('The absolute path of a new or empty folder for the build context.'),
} as const

export const exportAppAgentTool: AgentTool<typeof exportFields> = {
  name: 'export_app',
  description: 'Write the build context of a self-contained Docker image of an app\'s active version into a folder: a Dockerfile, the version, and a README with the docker commands and the env vars. Use it when the user wants to run the app on a platform of their own. The image has no Solus: integrations and signals do not work in it.',
  inputFields: exportFields,
  requiresApproval: false,
  execute: async (input) => {
    try {
      const exported = await requireDeployments().exportImage(toolAuthority(), input.app.trim(), resolveHomePath(input.path.trim()))
      return { ok: true, text: `Wrote the build context of version ${exported.version} to ${exported.folder}. Its README has the commands.${exported.env.length ? ` The app needs these env vars: ${exported.env.join(', ')}.` : ''}` }
    } catch (error) {
      return refusal('export_app', thrown(error instanceof Error ? error : String(error)))
    }
  },
}

const unpublishFields = {
  app: z.string().describe('The slug of the app.'),
} as const

export const unpublishAppAgentTool: AgentTool<typeof unpublishFields> = {
  name: 'unpublish_app',
  description: 'Remove the published copy of an app, with all the data that copy holds. The app in Solus does not change. Ask the user before you call this: the data cannot come back.',
  inputFields: unpublishFields,
  requiresApproval: true,
  execute: async (input) => {
    try {
      await requireDeployments().unpublish(toolAuthority(), input.app.trim())
      return { ok: true, text: `The app ${input.app.trim()} is not published now. Its container and the data in it are gone.` }
    } catch (error) {
      return refusal('unpublish_app', thrown(error instanceof Error ? error : String(error)))
    }
  },
}

export const retryAppRunAgentTool: AgentTool<typeof retryRunFields> = {
  name: 'retry_app_run',
  description: 'Start a failed workflow run of an app again on its active version: its failed step runs again, and its finished steps answer from their receipts. Use it after a deploy that fixes the failure, then read the run with inspect_app.',
  inputFields: retryRunFields,
  requiresApproval: false,
  execute: async (input) => {
    try {
      const run = await requireParts().workflows.retry(toolAuthority(), input.app.trim(), input.run_id.trim())
      return { ok: true, text: `The run ${run.id} of ${run.workflow} runs again${run.version === null ? '' : ` on version ${run.version}`}. Read its result with inspect_app, view "run", id "${run.id}".` }
    } catch (error) {
      return refusal('retry_app_run', thrown(error instanceof Error ? error : String(error)))
    }
  },
}

export const previewAppAgentTool: AgentTool<typeof previewFields> = {
  name: 'preview_app',
  description: `Check an app project before you save it: this host builds the folder and answers a screenshot of its window, ${APP_PREVIEW_HEIGHT}px tall, and what it logged. Nothing is saved. Its operations run against a new, empty database.`,
  inputFields: previewFields,
  requiresApproval: false,
  execute: async (input, context) => {
    try {
      return await previewApp(input, folderOf(context, input.path))
    } catch (error) {
      return refusal('preview_app', thrown(error instanceof Error ? error : String(error)))
    }
  },
}

const checkoutFields = {
  app: z.string().describe('The slug of the app.'),
  path: z.string().describe('A new or empty folder for the source.'),
  version: z.number().int().min(1).optional().describe('The version whose revision to write. Omit for the newest revision.'),
  revision: z.string().optional().describe('The revision to write, in place of a version.'),
} as const

export const checkoutAppAgentTool: AgentTool<typeof checkoutFields> = {
  name: 'checkout_app',
  description: 'Write the source of an app into a folder, so you can change it, save a new revision, and deploy it.',
  inputFields: checkoutFields,
  requiresApproval: false,
  execute: async (input, context) => {
    try {
      const folder = folderOf(context, input.path)
      const written = await requireParts().apps.checkout(toolAuthority(), input.app.trim(), folder, { version: input.version, revision: input.revision?.trim() || undefined })
      return { ok: true, text: `Wrote the source of "${written.app.name}", revision ${written.revision.slice(0, 7)}, to ${folder} (${written.files} files). Run \`npm install\` there before preview_app. Save the change with save_app and this folder as path: the folder names the app.` }
    } catch (error) {
      return refusal('checkout_app', thrown(error instanceof Error ? error : String(error)))
    }
  },
}

export const listAppsAgentTool: AgentTool = {
  name: 'list_apps',
  description: 'List the apps of this host with their operations and what needs the user.',
  inputFields: {},
  requiresApproval: false,
  execute: async () => {
    const { apps } = requireParts()
    const authority = toolAuthority()
    const listed = await apps.list(authority)
    if (listed.length === 0) return { ok: true, text: 'This host has no apps.' }
    const lines: string[] = []
    for (const app of listed) {
      const state = app.activeVersion === null ? 'no version runs' : `version ${app.activeVersion} runs${app.stopped ? ' (stopped)' : ''}`
      const waits = app.hasUndeployedRevision ? ', a newer revision waits for a deploy' : ''
      lines.push(`- ${app.slug} (id: ${app.id}): "${app.name}", ${state}${waits}${app.hasUi ? ', has a UI' : ''}${app.agentAccess ? '' : ', agent access is off'}`)
      const descriptor = (await apps.read(authority, app.id)).descriptor
      for (const operation of descriptor?.operations ?? []) lines.push(`    ${operation.kind} ${operation.name}${operation.description ? `: ${operation.description}` : ''}`)
      for (const item of app.attention) lines.push(`    needs the user: ${item.detail}`)
    }
    return { ok: true, text: lines.join('\n') }
  },
}

// ─── inspect_app: what an agent needs to repair an app ───

const inspectFields = {
  app: z.string().describe('The slug of the app.'),
  view: z.enum(['overview', 'calls', 'call', 'runs', 'run', 'signals', 'build', 'models', 'model']).optional().describe('overview (default), calls (the call log), call (one call: input, log lines, trace), runs, run (one run: steps), signals, build (a build log), models (model calls), model (one model call: text, steps, result).'),
  id: z.string().optional().describe('call, run, model: its id. build: a version number.'),
  operation: z.string().optional().describe('calls: only this operation.'),
  outcome: z.enum(['ok', 'failed', 'running']).optional(),
  limit: z.number().int().min(1).max(100).optional(),
} as const

function time(at: number | null): string {
  return at === null ? 'never' : new Date(at).toISOString()
}

function ms(value: number | null): string {
  return value === null ? '—' : `${value} ms`
}

function callerText(caller: AppCaller): string {
  switch (caller.kind) {
    case 'ui': return 'ui'
    case 'agent': return 'agent'
    case 'schedule': return `schedule ${caller.name}`
    case 'webhook': return 'webhook'
    case 'workflow': return caller.step ? `step ${caller.step} of ${caller.workflow}` : `run of ${caller.workflow}`
    case 'model': return `model call ${caller.callId}`
  }
}

function callLine(call: AppCallView): string {
  // A model call goes by its setting; its id opens it with the view `model`.
  const what = call.kind === 'model' ? `model call ${call.operation}` : call.operation
  return `- ${call.id} ${time(call.startedAt)} ${what} (${callerText(call.caller)}, v${call.version}): ${call.outcome}, ${ms(call.durationMs)}${call.error ? ` — ${call.error}` : ''}`
}

type InspectInput = z.output<z.ZodObject<typeof inspectFields>>

async function inspectOverview(slug: string): Promise<string> {
  const { apps } = requireParts()
  const authority = toolAuthority()
  const state = await apps.read(authority, slug)
  const metrics = await apps.metrics(authority, slug)
  const { app, descriptor } = state
  const lines = [
    `"${app.name}" (app: ${app.slug}): ${app.activeVersion === null ? 'no version runs' : `version ${app.activeVersion} runs`}${app.stopped ? ', stopped' : ''}${app.hasUndeployedRevision ? ', a newer revision waits for a deploy' : ''}. Agent access is ${app.agentAccess ? 'on' : 'off'}.`,
    `Last 24 hours: ${metrics.calls} calls, ${metrics.failed} failed, median ${ms(metrics.p50Ms)}, 95th percentile ${ms(metrics.p95Ms)}.`,
  ]
  for (const item of app.attention) lines.push(`Needs the user: ${item.detail}`)
  if (state.permissionsNotice) lines.push(state.permissionsNotice)
  for (const operation of metrics.operations) lines.push(`  ${operation.operation}: ${operation.calls} calls, ${operation.failed} failed, median ${ms(operation.p50Ms)}`)
  const unset = state.secrets.filter((secret) => !secret.isSet).map((secret) => secret.name)
  if (unset.length) lines.push(`Secrets not set: ${unset.join(', ')}`)
  // The user sets config on the Manage page; an agent reads it to explain what the app does.
  if (state.config.length) lines.push(`Config (the user changes it on the Manage page): ${state.config.map((field) => `${field.name} = ${JSON.stringify(field.value)}${field.isDefault ? ' (default)' : ''}`).join(', ')}`)
  if (!descriptor) return lines.join('\n')
  if (descriptor.instructions) lines.push(`Instructions:\n${descriptor.instructions}`)
  if (descriptor.workflows.length) lines.push(`Workflows: ${descriptor.workflows.map((workflow) => workflow.name).join(', ')}`)
  if (descriptor.signals.length) lines.push(`Signals: ${descriptor.signals.map((signal) => signal.name).join(', ')}`)
  if (descriptor.schedules.length) lines.push(`Schedules: ${descriptor.schedules.map((schedule) => `${schedule.name} runs ${schedule.run}`).join(', ')}`)
  return lines.join('\n')
}

async function inspectCalls(slug: string, input: InspectInput): Promise<string> {
  const calls = await requireParts().apps.calls(toolAuthority(), slug, input.limit ?? 20, { operation: input.operation, outcome: input.outcome })
  return calls.length ? calls.map(callLine).join('\n') : 'The call log has no such call.'
}

async function inspectCall(slug: string, input: InspectInput): Promise<string> {
  if (!input.id) return 'Give the id of the call. The calls view lists them.'
  const call = await requireParts().apps.callRead(toolAuthority(), slug, input.id)
  if (!call) return 'The call log no longer has this call.'
  const lines = [callLine(call), `input${call.inputTruncated ? ' (cut)' : ''}: ${call.input ?? 'not kept'}`]
  if (call.traceId) lines.push(`trace id: ${call.traceId}`)
  if (call.errorStack) lines.push(`stack:\n${call.errorStack}`)
  if (call.spans.length) lines.push(`trace:\n${call.spans.map((span) => `  +${span.startMs} ms ${span.kind} ${span.name}: ${span.ok ? 'ok' : 'failed'}, ${span.durationMs} ms${span.detail ? ` (${span.detail})` : ''}`).join('\n')}`)
  lines.push(call.logs.length ? `log${call.logsTruncated ? ' (cut)' : ''}:\n${call.logs.map((line) => `  +${line.atMs} ms [${line.level}] ${line.text}`).join('\n')}` : 'log: nothing logged.')
  return lines.join('\n')
}

async function inspectRuns(slug: string, input: InspectInput): Promise<string> {
  const runs = await requireParts().workflows.list(toolAuthority(), slug, { limit: input.limit ?? 20 })
  return runs.length ? runs.map((run) => `- ${run.id} ${run.workflow}: ${run.state}${run.version === null ? '' : ` on version ${run.version}`}${run.dismissedAt ? ' (dismissed)' : ''}, started ${time(run.startedAt)}, ${run.stepCount} steps${run.wakeAt ? `, wakes ${time(run.wakeAt)}` : ''}${run.error ? ` — ${run.error}` : ''}`).join('\n') : 'This app has no run.'
}

async function inspectRun(slug: string, input: InspectInput): Promise<string> {
  if (!input.id) return 'Give the id of the run. The runs view lists them.'
  const run = await requireParts().workflows.read(toolAuthority(), slug, input.id)
  if (!run) return 'This app has no run with this id.'
  const lines = [`${run.workflow} ${run.id}: ${run.state}, started ${time(run.startedAt)}${run.error ? ` — ${run.error}` : ''}`, `input: ${run.input}`]
  for (const step of run.steps) lines.push(`  ${step.kind} ${step.name}: ${step.state}, ${step.attempts} attempt${step.attempts === 1 ? '' : 's'}${step.wakeAt ? `, wakes ${time(step.wakeAt)}` : ''}${step.error ? ` — ${step.error}` : ''}`)
  if (run.result !== null) lines.push(`result: ${run.result}`)
  lines.push('The log of the run is in the call log: use the calls view.')
  return lines.join('\n')
}

async function inspectSignals(slug: string): Promise<string> {
  const { signals } = requireParts()
  const authority = toolAuthority()
  const declared = await signals.list(authority, slug)
  if (declared.length === 0) return 'This app declares no signal.'
  const lines: string[] = []
  for (const signal of declared) {
    lines.push(`- ${signal.name}: ${signal.description || 'no description'} (${signal.count24h} in 24 hours, last ${time(signal.lastEmittedAt)})`)
    for (const action of signal.actions) lines.push(`    action ${action.id}: ${action.action.type}, ${action.enabled ? 'on' : 'off'}`)
  }
  for (const occurrence of await signals.occurrences(authority, slug, undefined, 10)) {
    lines.push(`  ${time(occurrence.emittedAt)} ${occurrence.name}: ${occurrence.deliveries.map((delivery) => `${delivery.type} ${delivery.status}${delivery.detail ? ` (${delivery.detail})` : ''}`).join(', ') || 'no action'}`)
  }
  return lines.join('\n')
}

async function inspectBuild(slug: string, input: InspectInput): Promise<string> {
  const { apps } = requireParts()
  const authority = toolAuthority()
  const versions = await apps.versions(authority, slug)
  const number = input.id ? Number(input.id) : versions[0]?.number
  if (number === undefined || !Number.isInteger(number)) return 'This app has no version.'
  const build = await apps.buildLog(authority, slug, number)
  const version = versions.find((entry) => entry.number === number)
  return [`Version ${number}: ${version?.state ?? 'unknown'}${version?.error ? ` — ${version.error}` : ''}, build ${ms(build.buildMs)}.`, build.log || 'This version has no build log.'].join('\n')
}

function modelCallLine(call: AppModelCallView): string {
  const tokens = call.usage ? `, ${call.usage.inputTokens ?? '?'} in / ${call.usage.outputTokens ?? '?'} out` : ''
  return `- ${call.id} ${time(call.createdAt)} ${call.setting} → ${call.model ?? 'not resolved'} (${callerText(call.caller)}): ${call.status}${tokens}${call.error ? ` — ${call.error}` : ''}`
}

async function inspectModels(slug: string, input: InspectInput): Promise<string> {
  const calls = await requireParts().modelCalls.listFor(toolAuthority(), slug, { limit: input.limit ?? 20 })
  return calls.length ? calls.map(modelCallLine).join('\n') : 'This app has made no model call.'
}

async function inspectModel(slug: string, input: InspectInput): Promise<string> {
  if (!input.id) return 'Give the id of the model call. The models view lists them.'
  const call = await requireParts().modelCalls.readFor(toolAuthority(), slug, input.id)
  if (!call) return 'This app has no model call with this id.'
  const lines = [modelCallLine(call), `tools: ${call.tools.join(', ') || 'none'}`, `prompt: ${call.prompt}`]
  for (const step of call.steps) lines.push(`  ${step.tool}: ${step.state}${step.endedAt ? `, ${step.endedAt - step.startedAt} ms` : ''}${step.error ? ` — ${step.error}` : ''}`)
  if (call.text) lines.push(`text:\n${call.text}`)
  if (call.result !== null) lines.push(`result: ${JSON.stringify(call.result)}`)
  return lines.join('\n')
}

/** What each view of `inspect_app` reads. */
const INSPECT_VIEWS = {
  overview: inspectOverview,
  calls: inspectCalls,
  call: inspectCall,
  runs: inspectRuns,
  run: inspectRun,
  signals: inspectSignals,
  build: inspectBuild,
  models: inspectModels,
  model: inspectModel,
} satisfies { [View in NonNullable<InspectInput['view']>]: (slug: string, input: InspectInput) => Promise<string> }

export const inspectAppAgentTool: AgentTool<typeof inspectFields> = {
  name: 'inspect_app',
  description: 'Read what you need to repair or use an app: its state and instructions, its call log with each call\'s input, log lines, and trace, its workflow runs, its signals, its model calls, and its build logs.',
  inputFields: inspectFields,
  requiresApproval: false,
  execute: async (input) => {
    try {
      const text = await INSPECT_VIEWS[input.view ?? 'overview'](input.app.trim(), input)
      return { ok: true, text: text.length > RESULT_MAX_CHARS ? `${text.slice(0, RESULT_MAX_CHARS)}\n… (cut at ${RESULT_MAX_CHARS} characters; ask for less)` : text }
    } catch (error) {
      return { ok: false, text: `inspect_app failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  },
}

const signalActionFields = {
  app: z.string().describe('The slug of the app.'),
  signal: appSignalNameSchema.describe('A signal the app declares.'),
  type: z.enum(['notify', 'send_to_session', 'run_automation']).describe('notify: a notification for the user. send_to_session: a prompt to one session. run_automation: one run of an automation.'),
  session_id: z.string().optional().describe('For send_to_session.'),
  automation_id: z.string().optional().describe('For run_automation.'),
  template: z.string().optional().describe('The prompt, or the title of a notification. It takes {{payload.path}}, {{payload}}, {{signal}}, and {{app}}. Empty gives the signal and its payload.'),
  action_id: z.string().optional().describe('The signal action to change, from inspect_app. Omit to make a new one.'),
  enabled: z.boolean().optional().describe('Defaults to true.'),
} as const

export const setAppSignalActionAgentTool: AgentTool<typeof signalActionFields> = {
  name: 'set_app_signal_action',
  description: 'Make or change what one signal of an app does when the app emits it.',
  inputFields: signalActionFields,
  requiresApproval: true,
  execute: async (input) => {
    try {
      const template = input.template ?? ''
      const action = appSignalActionSchema.parse(input.type === 'notify'
        ? { type: 'notify', title: template }
        : input.type === 'send_to_session' ? { type: 'send_to_session', sessionId: input.session_id, template } : { type: 'run_automation', automationId: input.automation_id, template })
      const views = await requireParts().signals.saveAction(toolAuthority(), input.app.trim(), { actionId: input.action_id, signal: input.signal, enabled: input.enabled ?? true, action })
      const signal = views.find((view) => view.name === input.signal)
      return { ok: true, text: `The signal ${input.signal} now has ${signal?.actions.length ?? 0} action${signal?.actions.length === 1 ? '' : 's'}: ${signal?.actions.map((entry) => `${entry.action.type} (${entry.enabled ? 'on' : 'off'})`).join(', ')}.` }
    } catch (error) {
      return { ok: false, text: `set_app_signal_action failed: ${error instanceof z.ZodError ? 'send_to_session needs session_id, and run_automation needs automation_id.' : error instanceof Error ? error.message : String(error)}` }
    }
  },
}

/** Whether this host runs apps and this person may use them: then an outside app lists `tool_search` and `tool_call`, even before the first app runs. */
export function hostRunsAppsFor(actor: Actor): boolean {
  return parts !== null && mayUseApps(actor.principal)
}

/** An app's operation as an agent tool: a query reads the app's data, a mutation writes it. */
export interface AppOperationTool extends AgentTool {
  operationKind: AppOperation['kind']
}

/**
 * The operations of the host's running apps as agent tools (§7.1), for a
 * run's person. A name another tool of the run already has is left out: an
 * integration the person added after the app keeps its tools.
 *
 * An outside app has no `inspect_app` (plans/035 §7.3). With
 * `instructionTools`, each app with instructions also gets a tool that
 * answers them, `<slug>__app-instructions`: an operation's name has no `-`,
 * so no operation has that name.
 */
export async function appOperationAgentTools(actor: Actor, taken: ReadonlySet<string>, options: { instructionTools?: boolean } = {}): Promise<AppOperationTool[]> {
  const service = parts?.apps
  const authority: AppAuthority = { principal: actor.principal, actor }
  if (!service || !mayUseApps(actor.principal)) return []
  const tools: AppOperationTool[] = []
  for (const { app, descriptor } of await service.running(authority)) {
    const instructionsTool = descriptor.instructions === '' ? null : options.instructionTools ? `${app.slug}__app-instructions` : 'inspect_app'
    if (instructionsTool && options.instructionTools) {
      tools.push({
        name: instructionsTool,
        description: `${app.name}: how to use this app's operations. Read it once before you call them.`,
        inputFields: {},
        alwaysLoad: false,
        requiresApproval: false,
        access: { permission: HOST_USE },
        operationKind: 'query',
        execute: async () => ({ ok: true, text: descriptor.instructions }),
      })
    }
    for (const operation of descriptor.operations) {
      const name = integrationToolName(app.slug, operation.name)
      if (taken.has(name)) {
        log.warn('app_tool_name_taken', { appId: app.id, operation: operation.name, name })
        continue
      }
      const fields = inputFieldsFor({ ...operation.input, type: 'object' })
      const tool: AppOperationTool = {
        name,
        description: operationToolDescription(app.name, operation, instructionsTool),
        operationKind: operation.kind,
        inputFields: fields ?? {},
        alwaysLoad: false,
        requiresApproval: false,
        // As appCall.
        access: { permission: HOST_USE },
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

/** What an agent reads of one operation: what it does, the shape of what it answers when the app declares one, and the tool that gives the app's instructions. */
function operationToolDescription(appName: string, operation: AppOperation, instructionsTool: string | null): string {
  const lines = [`${appName}: ${operation.description || operation.name}`]
  if (operation.output) lines.push(`Returns: ${JSON.stringify(operation.output).slice(0, OUTPUT_SCHEMA_MAX_CHARS)}`)
  if (instructionsTool) lines.push(`Read this app's instructions once with ${instructionsTool} before you use it.`)
  return lines.join('\n').slice(0, 1000)
}

/** The app a `link` or an `unlink` names, for the tool's authority. */
export async function linkedAppNamed(named: string): Promise<{ id: string; name: string }> {
  const app = await requireParts().apps.record(toolAuthority(), named)
  return { id: app.id, name: app.name }
}
