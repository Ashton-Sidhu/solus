import { z } from 'zod'
import type { AgentTool } from './agent-tool'
import {
  ATTACHMENTS_FIELD, HOST_FIELD, REASONING_VALUES, REQUEST_ID_FIELD, WAIT_FIELD,
  attachTo, getSessionController, getSessionOrchestration, listAgentTargets, outcomeNote, remoteAgentTargets, remoteTarget, sessionLink, waitedBlock,
  type SessionToolDeps, type SessionToolResult,
} from './session-tools'
import { sessionSettings } from '../../sessions/session-settings'
import type { PersonalSettings } from '@solus/contracts/settings'
import { childPermissionMode } from '../../sessions/child-permissions'
import { resolveHomePath } from '../../../platform/paths'
import { resolveRepoRoot } from '../../../git/git-helpers'
import { getHeadCommit } from '../../../git/worktree-manager'
import { createLogger } from '../../../logger'
import { NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'
import { PERMISSION_MODES } from '@solus/contracts/types'
import type { AgentId, AgentTarget, PermissionMode, ReasoningEffort } from '@solus/contracts/types'
import { formatExchangeTag, ORCHESTRATION_LIMITS } from '@solus/contracts/session-exchange'
import type { RemoteTarget, SpawnedSession, SpawnOrder } from '../../orchestration/session-orders'

const log = createLogger('sessions', 'start-sessions-tool.ts')

/**
 * `start_sessions`: one call starts every session in its list at once. Each is
 * the caller's child by default — its report wakes the caller and the caller's
 * turn stays open for it — or, with `independent`, a separate conversation.
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
    .describe('A short name for the session and its card, such as "Server correctness fixes". Give each session a different name. Omit to name it from the prompt.'),
  independent: z
    .boolean()
    .default(false)
    .describe('false (default): your child; your turn stays open for its report, and stopping you stops it. true: a separate conversation that does not hold your work open and is not stopped with you.'),
  agent_provider: z
    .string()
    .optional()
    .describe('The configured agent that runs the session. Defaults to yours; list_agent_targets lists the providers and models.'),
  model_id: z
    .string()
    .min(1)
    .optional()
    .describe('Model id. An unqualified child uses the configured default worker model if set. Otherwise, omit to inherit your model on the same provider, or use the selected provider’s default.'),
  reasoning_effort: z
    .enum(REASONING_VALUES)
    .optional()
    .describe("Reasoning effort. Defaults to the model's default level."),
  permission_mode: z.enum(PERMISSION_MODES).optional(),
  host: HOST_FIELD.describe('Host id or name from list_hosts. Omit for this host. On another host, cwd, provider, and model must exist there.'),
  cwd: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Working directory. Defaults to yours. On another host: a project path there, or omit for a new chat folder.'),
  isolation: z
    .enum(['shared', 'worktree'])
    .default('shared')
    .describe('shared (default): work in cwd. worktree: a new checkout of its own; use it for separate edits or a pull request. On another host, name cwd and worktree_base_branch.'),
  worktree_base_branch: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('With isolation=worktree: the branch or commit the checkout starts from. Defaults to the commit checked out in cwd.'),
  report: z
    .boolean()
    .optional()
    .describe('Send the session’s notices and final report to you. Defaults to true for a child and false for an independent session.'),
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

/** The provider, model and reasoning level a session runs on. */
interface Runner {
  provider: AgentId
  modelId: string
  reasoningEffort: ReasoningEffort
  contextWindow: number | null
}

/** One session, checked and ready to start: what to order, where, and whether it reports. */
interface Launch {
  order: SpawnOrder
  runner: Runner
  target?: RemoteTarget
  report: boolean
}

type Checked<T> = T | { error: string }

export async function startSessions(input: StartSessionsInput, deps: SessionToolDeps): Promise<SessionToolResult> {
  const orchestration = getSessionOrchestration()
  if (!orchestration) return { ok: false, text: 'Session launch is unavailable — it requires an active control plane.' }
  const empty = input.sessions.findIndex((session) => !session.prompt.trim())
  if (empty >= 0) return { ok: false, text: `sessions[${empty}] needs a non-empty prompt. No session was started.` }
  const launches = await checkedLaunches(input.sessions, deps)
  if ('error' in launches) return { ok: false, text: launches.error }

  const callerSessionId = deps.ctx?.sessionId
  const waitMs = input.wait_seconds * 1000
  // Each spawn opens its exchange and card before it awaits anything, so the
  // sessions start together and a wait covers all of them at once.
  const outcomes = await Promise.all(launches.map(async (launch, item): Promise<Checked<SpawnedSession>> => {
    try {
      return await orchestration.spawn(callerSessionId, launch.order, launch.report, waitMs, input.request_id && `${input.request_id}#${item}`, launch.target)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn('session_start_failed', { sessionId: callerSessionId, item, error: message })
      return { error: message }
    }
  }))
  return {
    ok: outcomes.some((outcome) => !('error' in outcome)),
    text: formatReceipt(launches, outcomes, waitMs),
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
    permissionMode: sessionId ? controller?.permissionModeFor?.(sessionId) : undefined,
  }
}

/** One launch for each session, or the first entry that cannot start: then none starts. */
async function checkedLaunches(sessions: readonly SessionInput[], deps: SessionToolDeps): Promise<Checked<Launch[]>> {
  const caller = await callerOf(deps)
  // The catalog of each host is read once, however many sessions run there.
  const places = new Map<string, Promise<Checked<Place>>>()
  const placeOf = (host: string | undefined) => {
    const key = host ?? ''
    if (!places.has(key)) places.set(key, host ? remotePlace(host, caller.sessionId) : listAgentTargets().then((targets) => ({ targets })))
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

/** Use explicit settings, the default worker model, or the caller's model on the same provider. */
function runnerFor(session: SessionInput, caller: Caller, place: Place): Checked<Runner> {
  const worker = !session.independent && !session.agent_provider && !session.model_id ? caller.workerModel : null
  const provider = session.agent_provider ?? worker?.provider ?? caller.provider
  const inheritsModel = !worker && !session.model_id && provider === caller.provider
  const runner = chooseRunner(place.targets, provider,
    session.model_id ?? worker?.model ?? (inheritsModel ? caller.model : undefined),
    session.reasoning_effort ?? worker?.reasoningEffort ?? (inheritsModel ? caller.reasoningEffort : undefined))
  return 'error' in runner && place.target ? { error: `${runner.error} (on ${place.target.host.label})` } : runner
}

async function launchFor(session: SessionInput, caller: Caller, place: Place, deps: SessionToolDeps): Promise<Checked<Launch>> {
  const runner = runnerFor(session, caller, place)
  if ('error' in runner) return runner
  const permissionMode = caller.permissionMode ? childPermissionMode(caller.permissionMode, session.permission_mode) : session.permission_mode
  if (place.target && !permissionMode) return { error: 'The caller’s permission policy is unavailable. Remote work was not started.' }
  const workspace = place.target ? remoteWorkspace(session) : await localWorkspace(session, deps.ctx?.cwd)
  if ('error' in workspace) return workspace
  const order: SpawnOrder = {
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
  return { order, runner, target: place.target, report: session.report ?? !session.independent }
}

/** Another of the owner's hosts, as if the owner started the sessions there
 *  (docs/plans/cross-host-sessions.md). */
async function remotePlace(hostRef: string, callerSessionId: string | undefined): Promise<Checked<Place>> {
  if (!callerSessionId) return { error: 'start_sessions on another host is unavailable before the calling session is initialized.' }
  const target = await remoteTarget(hostRef, callerSessionId)
  if ('error' in target) return target
  const targets = await remoteAgentTargets(target.host)
  return 'error' in targets ? targets : { targets, target }
}

interface Workspace {
  cwd: string
  worktreeBaseBranch: string | null
}

/** Bind a session to its checkout before launch; a worktree starts from the
 *  commit checked out in cwd unless the session names a base. */
async function localWorkspace(session: SessionInput, callerCwd: string | undefined): Promise<Checked<Workspace>> {
  const cwd = resolveHomePath(session.cwd || callerCwd || '~')
  if (session.isolation === 'shared') {
    return session.worktree_base_branch ? { error: 'worktree_base_branch requires isolation=worktree.' } : { cwd, worktreeBaseBranch: null }
  }
  const [root, commit] = await Promise.all([resolveRepoRoot(cwd), getHeadCommit(cwd)])
  if (!root || !commit) return { error: 'An isolated session needs a Git repository with a commit.' }
  return { cwd: resolveHomePath(root), worktreeBaseBranch: session.worktree_base_branch ?? commit }
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

/** Checks the requested provider, model and reasoning level against what the host offers. */
function chooseRunner(targets: readonly AgentTarget[], requestedProvider: string, requestedModel: string | undefined, requestedEffort: ReasoningEffort | undefined): Checked<Runner> {
  const target = targets.find((candidate) => candidate.provider === requestedProvider)
  if (!target) return { error: `Unknown agent provider "${requestedProvider}". Call list_agent_targets for current choices.` }
  if (!target.available) {
    return { error: `Agent provider "${requestedProvider}" is unavailable${target.unavailableReason ? `: ${target.unavailableReason}` : '.'}` }
  }
  const modelId = requestedModel?.trim() || target.defaultModel
  if (!modelId) return { error: 'start_sessions requires model_id.' }
  const profile = target.models.find((model) => model.id === modelId)
  if (!profile) {
    return { error: `Unknown model "${modelId}" for ${target.provider}. Valid models: ${target.models.map((model) => model.id).join(', ') || '(none)'}.` }
  }
  const reasoningEffort = requestedEffort ?? profile.defaultReasoningEffort
  if (profile.reasoningLevels.length > 0 && !profile.reasoningLevels.includes(reasoningEffort)) {
    return { error: `Model "${modelId}" does not support reasoning level "${reasoningEffort}". Supported: ${profile.reasoningLevels.join(', ')}.` }
  }
  return { provider: target.provider, modelId, reasoningEffort, contextWindow: profile.defaultContextWindow }
}

/** One line for each session, in list order, each with its exchange tag, then
 *  what arrived while the call waited: a report's reply runs to the end. */
function formatReceipt(launches: readonly Launch[], outcomes: readonly Checked<SpawnedSession>[], waitMs: number): string {
  const head = `Started ${outcomes.filter((outcome) => !('error' in outcome)).length} of ${outcomes.length} sessions.`
  const lines = outcomes.map((outcome, item) => {
    const { order, runner, report } = launches[item]!
    const host = launches[item]!.target?.host
    const name = order.title ? ` "${order.title}"` : ''
    if ('error' in outcome) return `${item + 1}.${name} Not started: ${outcome.error}`
    const { provider } = runner
    // A client opens a session on another host by that host; a session whose provider has not started has no transcript to link yet.
    const session = host
      ? sessionLink({ provider, sessionId: outcome.sessionId, slug: null, cwd: '', serverId: host.installationId })
      : outcome.starting ? outcome.sessionId : sessionLink({ provider, sessionId: outcome.sessionId, slug: null, cwd: resolveHomePath(order.cwd) })
    const runs = `${order.independent ? 'Independent, ' : ''}${host ? `on ${host.label}, ` : ''}${provider}/${runner.modelId} (reasoning: ${runner.reasoningEffort}).`
    const startup = !outcome.starting ? ''
      : `${outcome.waited?.type === 'report' ? ' Provider startup ended.' : ' Startup continues in the background.'} read_session_exchange with exchange_id=${outcome.exchangeId} reads the startup state.`
    const tag = formatExchangeTag({ messageId: outcome.exchangeId, sessionId: outcome.sessionId, provider, serverId: host?.installationId, item })
    return `${item + 1}. Session ${session}${name}. ${runs}${startup}${outcomeNote(report, waitMs, outcome.waited)}\n${tag}`
  })
  const waited = outcomes.map((outcome) => ('error' in outcome ? '' : waitedBlock(outcome.waited))).join('')
  return `${head}\n${lines.join('\n')}${waited}`
}

export const startSessionsAgentTool: AgentTool = {
  name: 'start_sessions',
  description: `Start 1 to ${MAX_SESSIONS} Solus sessions at once, on this or another provider or host. Each session is a full conversation with its own card. It gets only its prompt, not your history. Each session has its own settings: provider, model, host, workspace, permission mode, and reports. By default each is your child: its report wakes you, and your turn stays open until it reports. independent=true starts a separate conversation instead. isolation=worktree gives a session its own checkout. Keep the session and exchange IDs. Reports wake you; do not poll. Follow up with send_session, read with read_session_exchange, stop with stop_session. User questions and permissions stay on each session’s card.`,
  inputFields: startSessionsFields,
  strictInput: true,
  requiresApproval: false,
  alwaysLoad: true,
  execute: async (input, context) => {
    try {
      return await startSessions(startSessionsSchema.parse(input), {
        ctx: { agentProvider: context.provider, cwd: resolveHomePath(context.cwd), sessionId: context.sessionId() },
      })
    } catch (error) {
      return { ok: false, text: `start_sessions failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  },
}
