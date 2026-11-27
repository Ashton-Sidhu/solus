import { resolve } from 'node:path'
import { z } from 'zod'
import type { AgentTool } from './agent-tool'
import {
  ATTACHMENTS_FIELD, HOST_FIELD, REASONING_VALUES, REQUEST_ID_FIELD, WAIT_FIELD,
  attachTo, clientReadNote, getSessionController, getSessionOrchestration, listAgentTargets, outcomeNote, reachCallerOf, refusalOf, remoteAgentTargets, remoteTarget, sessionLink, waitedBlock,
  type SessionToolDeps, type SessionToolResult,
} from './session-tools'
import { sessionSettings } from '../../sessions/session-settings'
import type { PersonalSettings } from '@solus/contracts/settings'
import { childPermissionMode, rootPermissionMode } from '../../sessions/child-permissions'
import { hostPolicies } from '../../../host/policy/host-policy-store'
import { LOCAL_ORGANIZATION_ID, organizationForNew } from '../../../admission/principal'
import { workspaceToolAuthority } from '../../../admission/workspace-tool-authority'
import { resolveHomePath } from '../../../platform/paths'
import { resolveRepoRoot } from '../../../git/git-helpers'
import { getHeadCommit } from '../../../git/worktree-manager'
import { runAsync } from '../../../git/exec'
import { isContainer } from '../../../files/codebase-members'
import { realPathOf } from '../../../paths'
import { holdsTooMuch } from '../../sessions/session-codebase-formation'
import { createLogger } from '../../../logger'
import { NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'
import { PERMISSION_MODES } from '@solus/contracts/types'
import type { AgentId, AgentTarget, PermissionMode, ReasoningEffort } from '@solus/contracts/types'
import { formatExchangeTag, ORCHESTRATION_LIMITS } from '@solus/contracts/session-exchange'
import type { RemoteTarget, SpawnedSession, SpawnOrder } from '../../orchestration/session-orders'
import { providerSpent, seatOf, type ProviderSpent } from '../../sessions/provider-usage'
import { chooseRunner, type Checked, type Runner } from './agent-runner'

// session-tools.ts checks the runner of send_session with the same rule.
export { chooseRunner, type Checked, type Runner } from './agent-runner'

const log = createLogger('sessions', 'start-sessions-tool.ts')

/**
 * `start_sessions`: one call starts every session in its list at once. Each is
 * the caller's child. By default its report wakes the caller and the caller's
 * turn stays open for it; with `independent` it runs on its own, still under the caller.
 * Every session is checked before any starts, so a bad entry starts nothing
 * (docs/plans/agent-delegation.md).
 */

const MAX_SESSIONS = 10

const sessionFields = {
  prompt: z.string().describe('The full brief. The session gets no history from you.'),
  title: z
    .string()
    .trim()
    .min(1)
    .max(ORCHESTRATION_LIMITS.title)
    .optional()
    .describe('A short, distinct name for the session and its card. Omit to name it from the prompt.'),
  independent: z
    .boolean()
    .default(false)
    .describe('false (default): a child that reports to you. true: a child that runs on its own: it stays under your session, but does not report or stop with you.'),
  agent_provider: z
    .string()
    .optional()
    .describe('Defaults to yours; list_agent_targets lists providers and models.'),
  model_id: z
    .string()
    .min(1)
    .optional()
    .describe('Model id. With no provider or model: the worker model if set, else yours; the fallback model while that provider is out of usage.'),
  reasoning_effort: z
    .enum(REASONING_VALUES)
    .optional()
    .describe("Reasoning effort. Defaults to the model's default level."),
  permission_mode: z.enum(PERMISSION_MODES).optional(),
  host: HOST_FIELD.describe('Host id or name from list_hosts. Omit for this host.'),
  cwd: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Working directory. Defaults to yours; on another host, a project path there.'),
  isolation: z
    .enum(['shared', 'worktree'])
    .default('shared')
    .describe('shared (default): work in cwd. worktree: its own checkout, or a task folder for a container with multiple repositories.'),
  worktree_base_branch: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('With worktree: the base branch or commit. Defaults to the commit in a Git checkout or to each repository’s default branch in a plain container.'),
  report: z
    .boolean()
    .optional()
    .describe('Send its notices and report to you. Default: true for a child. With false, your turn can finish while the child keeps working under your session.'),
  attachments: ATTACHMENTS_FIELD,
}

const startSessionsFields = {
  sessions: z
    .array(z.object(sessionFields).strict())
    .min(1)
    .max(MAX_SESSIONS)
    .describe(`1 to ${MAX_SESSIONS} sessions, each with its own settings. All start at once.`),
  wait_seconds: WAIT_FIELD,
  request_id: REQUEST_ID_FIELD,
}

const startSessionsSchema = z.object(startSessionsFields).strict()
type StartSessionsInput = z.output<typeof startSessionsSchema>
type SessionInput = StartSessionsInput['sessions'][number]

/** The runner of a session, and, when it is the fallback model, the default provider it replaces. */
interface Choice {
  runner: Runner
  fallbackFrom?: { provider: AgentId; spent: ProviderSpent }
}

/** One session, checked and ready to start: what to order, where, and whether it reports. */
interface Launch extends Choice {
  order: SpawnOrder
  target?: RemoteTarget
  report: boolean
}

export async function startSessions(input: StartSessionsInput, deps: SessionToolDeps): Promise<SessionToolResult> {
  const orchestration = getSessionOrchestration()
  if (!orchestration) return { ok: false, text: 'Session launch is unavailable — it requires an active control plane.' }
  const empty = input.sessions.findIndex((session) => !session.prompt.trim())
  if (empty >= 0) return { ok: false, text: `sessions[${empty}] needs a non-empty prompt. No session was started.` }
  // A session on another host is that host's to admit; one here needs what a person's start needs.
  const refused = input.sessions.some((session) => !session.host) ? await refusalOf(['createHeadlessSession'], '') : null
  if (refused) return { ok: false, text: `${refused}. No session was started.` }
  const launches = await checkedLaunches(input.sessions, deps)
  if ('error' in launches) return { ok: false, text: launches.error }

  const callerSessionId = deps.ctx?.sessionId
  // An outside app sends with its requester key, so it can read each exchange later.
  const sender = callerSessionId ?? deps.ctx?.requesterKey
  const waitMs = input.wait_seconds * 1000
  // Each spawn opens its exchange and card before it awaits anything, so the
  // sessions start together and a wait covers all of them at once.
  const outcomes = await Promise.all(launches.map(async (launch, item): Promise<Checked<SpawnedSession>> => {
    try {
      return await orchestration.spawn(sender, launch.order, launch.report, waitMs, input.request_id && `${input.request_id}#${item}`, launch.target)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn('session_start_failed', { sessionId: callerSessionId, item, error: message })
      return { error: message }
    }
  }))
  return {
    ok: outcomes.some((outcome) => !('error' in outcome)),
    text: formatReceipt(launches, outcomes, waitMs, !callerSessionId),
  }
}

/** What every session inherits from the caller: its runner and its
 *  permission ceiling. Read once for the call. */
interface Caller {
  sessionId: string | undefined
  provider: AgentId
  model: string | undefined
  reasoningEffort: ReasoningEffort | undefined
  permissionMode: PermissionMode | undefined
  workerModel: PersonalSettings['workerModel']
  fallbackModel: PersonalSettings['fallbackModel']
  /** The codebase of the calling session, used unless the child names a different container. */
  codebaseId: string | null
}

/** The codebase of the calling session. Null for a caller with one working directory, and before the caller has a session. */
async function codebaseOfCaller(sessionId: string | undefined): Promise<string | null> {
  if (!sessionId) return null
  return await getSessionController()?.codebaseIdFor?.(sessionId) ?? null
}

async function callerOf(deps: SessionToolDeps): Promise<Caller> {
  const sessionId = deps.ctx?.sessionId
  const controller = getSessionController()
  const info = sessionId ? await controller?.getSessionInfo(sessionId) : null
  const provider = deps.ctx?.agentProvider ?? 'claude-code'
  const runsOnProvider = info?.provider === provider
  return {
    sessionId,
    provider,
    model: runsOnProvider ? info?.model : undefined,
    reasoningEffort: runsOnProvider ? info?.reasoningEffort : undefined,
    workerModel: sessionSettings(sessionId)?.preferences?.workerModel ?? null,
    fallbackModel: sessionSettings(sessionId)?.preferences?.fallbackModel ?? null,
    permissionMode: sessionId ? controller?.permissionModeFor?.(sessionId) : undefined,
    codebaseId: await codebaseOfCaller(sessionId),
  }
}

/** One launch for each session, or the first entry that cannot start: then none starts. */
async function checkedLaunches(sessions: readonly SessionInput[], deps: SessionToolDeps): Promise<Checked<Launch[]>> {
  const caller = await callerOf(deps)
  // The catalog of each host is read once, however many sessions run there.
  const places = new Map<string, Promise<Checked<Place>>>()
  const placeOf = (host: string | undefined) => {
    const key = host ?? ''
    if (!places.has(key)) places.set(key, host ? remotePlace(host, deps) : listAgentTargets().then((targets) => ({ targets })))
    return places.get(key)!
  }
  const launches = await Promise.all(sessions.map(async (session): Promise<Checked<Launch>> => {
    const place = await placeOf(session.host)
    if ('error' in place) return place
    return launchFor(session, caller, place, deps)
  }))
  const refused = launches.findIndex((launch) => 'error' in launch)
  const failure = launches[refused]
  if (failure && 'error' in failure) return { error: `sessions[${refused}]: ${failure.error} No session was started.` }
  return launches.filter((launch): launch is Launch => !('error' in launch))
}

/** Where sessions run: this host's catalog, or another host and its catalog. */
interface Place {
  targets: readonly AgentTarget[]
  target?: RemoteTarget
}

/** Use explicit settings, the default worker model, or the caller's model on the same provider.
 *  The fallback model replaces that default while its provider is out of usage. */
function runnerFor(session: SessionInput, caller: Caller, place: Place): Checked<Choice> {
  const runner = defaultRunnerFor(session, caller, place)
  if ('error' in runner) return runner
  return fallbackFor(session, caller, place, runner) ?? { runner }
}

function defaultRunnerFor(session: SessionInput, caller: Caller, place: Place): Checked<Runner> {
  const worker = !session.independent && !session.agent_provider && !session.model_id ? caller.workerModel : null
  const provider = session.agent_provider ?? worker?.provider ?? caller.provider
  const inheritsModel = !worker && !session.model_id && provider === caller.provider
  const runner = chooseRunner(place.targets, provider,
    session.model_id ?? worker?.model ?? (inheritsModel ? caller.model : undefined),
    session.reasoning_effort ?? worker?.reasoningEffort ?? (inheritsModel ? caller.reasoningEffort : undefined))
  return 'error' in runner && place.target ? { error: `${runner.error} (on ${place.target.host.label})` } : runner
}

/**
 * The fallback model, for a session with neither a provider nor a model whose
 * default provider is out of usage, when the fallback is on another provider,
 * available here, and not out of usage itself. Otherwise null: the default
 * stays. This host knows only its own usage, so a session on another host
 * keeps its default.
 */
function fallbackFor(session: SessionInput, caller: Caller, place: Place, runner: Runner): Choice | null {
  const fallback = caller.fallbackModel
  const providerUsage = getSessionController()?.providerUsage
  if (session.agent_provider || session.model_id || place.target || !fallback || !providerUsage) return null
  if (fallback.provider === runner.provider) return null
  // A child acts for the person its caller acts for, so it runs under the caller's seat.
  const seat = seatOf(providerUsage, caller.sessionId)
  const spent = providerSpent(providerUsage, runner.provider, seat)
  if (!spent || providerSpent(providerUsage, fallback.provider, seat)) return null
  const candidate = chooseRunner(place.targets, fallback.provider, fallback.model, session.reasoning_effort ?? fallback.reasoningEffort)
  if ('error' in candidate) return null
  log.info('session_fallback_model', { sessionId: caller.sessionId, fromProvider: runner.provider, provider: candidate.provider, modelId: candidate.modelId, resetsAt: spent.resetsAt })
  return { runner: candidate, fallbackFrom: { provider: runner.provider, spent } }
}

async function launchFor(session: SessionInput, caller: Caller, place: Place, deps: SessionToolDeps): Promise<Checked<Launch>> {
  const choice = runnerFor(session, caller, place)
  if ('error' in choice) return choice
  const { runner } = choice
  // A child keeps within its caller's policy; an outside app's work on another host, within what it gets here.
  const permission = caller.sessionId || !place.target
    ? { mode: caller.permissionMode ? childPermissionMode(caller.permissionMode, session.permission_mode) : session.permission_mode }
    : appModeThere(session.permission_mode)
  if ('error' in permission) return permission
  const permissionMode = permission.mode
  if (place.target && !permissionMode) return { error: 'The caller’s permission policy is unavailable. Remote work was not started.' }
  const workspace = place.target ? remoteWorkspace(session) : await localWorkspace(session, deps.ctx?.cwd)
  if ('error' in workspace) return workspace
  const order: SpawnOrder = {
    codebaseId: caller.codebaseId,
    ...workspace,
    prompt: session.prompt,
    independent: session.independent,
    permissionMode,
    title: session.title,
    provider: runner.provider,
    modelId: runner.modelId,
    reasoningEffort: runner.reasoningEffort,
    contextWindow: runner.contextWindow,
  }
  const attachError = await attachTo(order, session.attachments, deps)
  if (attachError) return { error: attachError }
  // An outside app has no session to report to: it reads each result itself.
  const report = caller.sessionId ? session.report ?? !session.independent : false
  return { ...choice, order, target: place.target, report }
}

/**
 * The mode an outside app's session starts in on another host: the mode it would
 * start in here, by the same rule and this host's policy, so it is never broader
 * there than here. The other host checks it against its own policy too, and
 * refuses a mode above that (plans/035 §0.6).
 */
function appModeThere(requested: PermissionMode | undefined): Checked<{ mode: PermissionMode }> {
  const principal = workspaceToolAuthority()
  const policy = hostPolicies().forWork(principal ? organizationForNew(principal) : LOCAL_ORGANIZATION_ID)
  const mode = rootPermissionMode(policy, requested, undefined)
  const refused = policy.modeDenial(mode)
  return refused ? { error: `${refused.message} Remote work was not started.` } : { mode }
}

/** Another of the person's hosts, as if they started the sessions there
 *  (docs/plans/cross-host-sessions.md). The caller is a session, or an outside app with its person. */
async function remotePlace(hostRef: string, deps: SessionToolDeps): Promise<Checked<Place>> {
  const caller = reachCallerOf(deps.ctx)
  if (!caller) return { error: 'start_sessions on another host is unavailable before the calling session is initialized.' }
  const target = await remoteTarget(hostRef, caller)
  if ('error' in target) return target
  const targets = await remoteAgentTargets(target.host)
  return 'error' in targets ? targets : { targets, target }
}

interface Workspace {
  cwd: string
  worktreeBaseBranch: string | null
  worktreeSiblingBaseBranch?: string | null
  codebaseId?: null
}

/** Bind a session to its Git checkout or let the launcher plan a task folder for a container. */
async function localWorkspace(session: SessionInput, callerCwd: string | undefined): Promise<Checked<Workspace>> {
  const cwd = resolveHomePath(session.cwd || callerCwd || '~')
  if (session.isolation === 'shared') {
    return session.worktree_base_branch ? { error: 'worktree_base_branch requires isolation=worktree.' } : { cwd, worktreeBaseBranch: null }
  }
  const [root, commit] = await Promise.all([resolveRepoRoot(cwd), getHeadCommit(cwd)])
  if (root && commit) {
    const workspace: Workspace = { cwd: resolveHomePath(root), worktreeBaseBranch: session.worktree_base_branch ?? commit }
    if (session.worktree_base_branch) return workspace
    workspace.worktreeSiblingBaseBranch = null
    const ref = await runAsync('git', ['symbolic-ref', '--quiet', 'HEAD'], cwd).catch(() => null)
    if (!ref?.startsWith('refs/heads/')) return workspace
    const branchCommit = await runAsync('git', ['rev-parse', '--verify', ref], resolveHomePath(root)).catch(() => null)
    if (branchCommit === commit) workspace.worktreeSiblingBaseBranch = ref.slice('refs/heads/'.length)
    return workspace
  }
  const folder = resolve(cwd)
  if (root || await holdsTooMuch(folder) || !await isContainer(folder)) {
    return { error: 'An isolated session needs a Git repository with a commit or a folder that contains multiple repositories.' }
  }
  const workspace: Workspace = {
    cwd: resolveHomePath(folder),
    // HEAD requests worktree setup. A plain member's worktrees use their own defaults.
    worktreeBaseBranch: session.worktree_base_branch ?? 'HEAD',
  }
  // A different container settles its own codebase in the launcher.
  if (session.cwd && callerCwd && await realPathOf(folder) !== await realPathOf(resolveHomePath(callerCwd))) workspace.codebaseId = null
  return workspace
}

/** A path on the other host: it is resolved there, never here. */
function remoteWorkspace(session: SessionInput): Checked<Workspace> {
  if (session.isolation === 'shared' && session.worktree_base_branch) return { error: 'worktree_base_branch requires isolation=worktree.' }
  if (session.isolation === 'worktree' && (!session.cwd || !session.worktree_base_branch)) {
    return { error: 'An isolated session on another host needs cwd and worktree_base_branch on that host.' }
  }
  // oxlint-disable-next-line solus/require-resolved-cwd -- a path on the other host is resolved there; here it would name this host's home.
  return { cwd: session.cwd || NEW_CHAT_DIRECTORY, worktreeBaseBranch: session.worktree_base_branch ?? null }
}

/** Why a session runs on the fallback model. */
function fallbackNote(runner: Runner, { provider, spent }: NonNullable<Choice['fallbackFrom']>): string {
  const until = spent.resetsAt === null ? '' : ` until ${new Date(spent.resetsAt * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')}`
  return `Uses the fallback model ${runner.provider}/${runner.modelId}: ${provider} is out of usage${until}.`
}

/** One line for each session, in list order, each with its exchange tag, then
 *  what arrived while the call waited: a report's reply runs to the end. */
function formatReceipt(launches: readonly Launch[], outcomes: readonly Checked<SpawnedSession>[], waitMs: number, readsItself: boolean): string {
  const head = `Started ${outcomes.filter((outcome) => !('error' in outcome)).length} of ${outcomes.length} sessions.`
  const lines = outcomes.map((outcome, item) => {
    const { order, runner, report, fallbackFrom } = launches[item]!
    const host = launches[item]!.target?.host
    const name = order.title ? ` "${order.title}"` : ''
    if ('error' in outcome) return `${item + 1}.${name} Not started: ${outcome.error}`
    const { provider } = runner
    // A client opens a session on another host by that host; a session whose provider has not started has no transcript to link yet.
    const session = host
      ? sessionLink({ provider, sessionId: outcome.sessionId, slug: null, cwd: '', serverId: host.installationId })
      : outcome.starting ? outcome.sessionId : sessionLink({ provider, sessionId: outcome.sessionId, slug: null, cwd: resolveHomePath(order.cwd) })
    const runs = `${order.independent ? 'Independent, ' : ''}${host ? `on ${host.label}, ` : ''}${provider}/${runner.modelId} (reasoning: ${runner.reasoningEffort}).${fallbackFrom ? ` ${fallbackNote(runner, fallbackFrom)}` : ''}`
    const startup = !outcome.starting ? ''
      : `${outcome.waited?.type === 'report' ? ' Provider startup ended.' : ' Startup continues in the background.'} read_session_exchange with exchange_id=${outcome.exchangeId} reads the startup state.`
    const tag = formatExchangeTag({ messageId: outcome.exchangeId, sessionId: outcome.sessionId, provider, serverId: host?.installationId, item })
    return `${item + 1}. Session ${session}${name}. ${runs}${startup}${outcomeNote(report, waitMs, outcome.waited)}${clientReadNote(readsItself, outcome.exchangeId, outcome.waited)}\n${tag}`
  })
  const waited = outcomes.map((outcome) => ('error' in outcome ? '' : waitedBlock(outcome.waited))).join('')
  return `${head}\n${lines.join('\n')}${waited}`
}

export const startSessionsAgentTool: AgentTool = {
  name: 'start_sessions',
  description: `Start 1 to ${MAX_SESSIONS} Solus sessions at once, on this or another provider or host. Each session is a full conversation with its own card. It gets only its prompt, not your history. Each session has its own settings: provider, model, host, workspace, permission mode, and reports. By default each is your child: its report wakes you, and your turn stays open until it reports. Use report=false for a child that runs without holding your turn open. Use isolation=worktree for separate checkouts. Use independent=true only for a child that continues without you: it stays under your session, but does not report or stop with you. Keep the session and exchange IDs. Reports wake you; do not poll. Follow up with send_session, read with read_session_exchange, stop with stop_session. User questions and permissions stay on each session’s card.`,
  inputFields: startSessionsFields,
  strictInput: true,
  requiresApproval: false,
  alwaysLoad: true,
  execute: async (input, context) => {
    try {
      return await startSessions(startSessionsSchema.parse(input), {
        ctx: { agentProvider: context.provider, cwd: resolveHomePath(context.cwd), sessionId: context.sessionId(), requesterKey: context.requesterKey?.() },
      })
    } catch (error) {
      return { ok: false, text: `start_sessions failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  },
}
