import type { AgentId, GitCheckout, ModelConfig, ReasoningEffort, RunConfig } from '@solus/contracts/types'
import { MODEL_PROFILES, PERMISSION_MODES, isLegacyModel } from '@solus/contracts/types'
import { AUTO_MODEL_ID } from '@solus/contracts/model-routing'
import type { ModelOptionsByProvider } from '@solus/contracts/settings'
import { restoredModelConfig } from './model-options'
import type { ProjectLocation } from '../app/settings.context.svelte'
import { checkoutPlace, fileTasksOn, folderLocation, inheritedLocation, projectHome } from './run-location'

/**
 * The rules that operate on a `RunConfig` — where a session starts and what it
 * runs with. Pure functions of run configs and nothing else, which is what lets
 * a started session and a session draft share every one of them: both hold the
 * same object in the same position.
 */

/**
 * What a new session runs with, given the app's defaults and — when there is one
 * — the session it was opened from. Saved model options override the source
 * tuning so new tabs and drafts use the latest choice for that model.
 *
 * Where the new session works comes from `inheritedLocation`; the permission
 * mode is an app-level preference, never inherited from a session that happened
 * to be loosened for one piece of work.
 */
export function inheritRunConfig(
  defaults: RunConfig,
  inherit?: RunConfig | null,
  remembered: ModelOptionsByProvider = {},
): RunConfig {
  const source = alignRunProvider(inherit ?? defaults, defaults.provider)
  const modelId = source.modelConfig.modelId
  const saved = source.provider && modelId ? remembered[source.provider]?.[modelId] : undefined

  return {
    ...source,
    location: inheritedLocation(source.location),
    modelConfig: saved && source.provider ? restoredModelConfig(source.provider, modelId, saved) : {
      ...source.modelConfig,
      // The model's own default, not whatever the last session was tuned to.
      reasoningEffort: modelDefaultEffort(source) ?? defaults.modelConfig.reasoningEffort,
    },
    sessionSkills: [...source.sessionSkills],
    permissionMode: defaults.permissionMode,
  }
}

export interface NewRunTarget {
  freshTask?: boolean
  workingDirectory?: string
  gitContext?: GitCheckout | null
  serverId?: string
  /** The host that owns the session's task, when it is not `serverId`: a task
   *  in the cloud workspace service runs on an execution host. */
  taskServerId?: string
}

/**
 * Resolve the complete run for a newly opened tab or draft.
 *
 * The source answers what carries forward. The target answers what the opening
 * gesture selected explicitly, and therefore always wins. Keeping this rule
 * here prevents tabs and drafts from disagreeing about the same gesture.
 */
export function resolveNewRunConfig(
  defaults: RunConfig,
  source: RunConfig | null | undefined,
  target: NewRunTarget = {},
  remembered: ModelOptionsByProvider = {},
): RunConfig {
  const run = inheritRunConfig(defaults, target.freshTask ? null : source, remembered)
  let location = target.freshTask && source
    ? inheritedLocation(source.location, { freshTask: true })
    : run.location
  const current = checkoutPlace({ location })
  const serverId = target.serverId ?? current.serverId

  if (target.workingDirectory !== undefined) {
    location = folderLocation({ serverId, path: target.workingDirectory }, { git: target.gitContext ?? null })
  } else if (serverId !== current.serverId) {
    // The old host's checkout describes a folder over there, not on this host.
    location = folderLocation({ serverId, path: current.path }, { git: target.gitContext ?? null })
  } else if (target.gitContext !== undefined) {
    location = folderLocation(current, { git: target.gitContext ? { ...target.gitContext } : null, project: projectHome({ location }) })
  }
  if (target.taskServerId) location = fileTasksOn(location, target.taskServerId)

  run.location = location
  return run
}

/**
 * Keep the provider and its model as one choice at every draft boundary.
 *
 * Older runs can carry `provider: null` beside an explicit model. In that
 * shape, resolving only the provider from today's default can put a Codex mark
 * beside a Claude model. A known model has one owner, so it repairs either a
 * missing or stale provider. This preserves the explicit model the user chose.
 *
 * Unknown model ids stay with their explicit or fallback provider because live
 * agent metadata can contain models that are newer than this build's profiles.
 */
export function alignRunProvider(
  run: RunConfig,
  fallbackProvider: AgentId | null,
): RunConfig {
  const provider =
    knownProviderForModel(run.modelConfig.modelId) ?? run.provider ?? fallbackProvider
  return provider && run.provider !== provider ? { ...run, provider } : run
}

function knownProviderForModel(modelId: string | null): AgentId | null {
  if (!modelId) return null
  const providers: AgentId[] = ['claude-code', 'codex', 'opencode']
  const matches = providers.filter((provider) => MODEL_PROFILES[provider]?.[modelId])
  return matches.length === 1 ? matches[0] : null
}

/** The reasoning effort a model ships with, or null when it declares none. */
function modelDefaultEffort(run: RunConfig): RunConfig['modelConfig']['reasoningEffort'] | null {
  if (run.modelConfig.modelId === AUTO_MODEL_ID) return 'medium'
  if (!run.modelConfig.modelId || !run.provider) return null
  const profiles = MODEL_PROFILES[run.provider]
  return profiles?.[run.modelConfig.modelId]?.defaultReasoningEffort ?? null
}

/**
 * The model after the run's current one in picker order: current models, then
 * legacy models, preserving provider order within each group and wrapping around
 * — what "cycle model" lands on. Null when the provider offers no models. Reads
 * the run, so a draft and a started session answer it the same way.
 */
export function cycledModelId(
  run: RunConfig,
  models: readonly { id: string }[],
  defaultModelId: string | null,
  provider: AgentId | null = run.provider,
): string | null {
  if (models.length === 0) return null
  const orderedModels = [...models].sort((a, b) =>
    Number(isLegacyModel(provider, a.id)) - Number(isLegacyModel(provider, b.id)),
  )
  const current = run.modelConfig.modelId || defaultModelId || orderedModels[0].id
  const idx = orderedModels.findIndex((model) => model.id === current)
  return orderedModels[((idx === -1 ? 0 : idx) + 1) % orderedModels.length].id
}

/**
 * The model config a run takes on when it switches to `modelId`: the model's own
 * profile defaults, never the outgoing model's tuning. Each model ships its own
 * reasoning effort, context window, and fast-mode support, so carrying the old
 * values over would run the new model against limits it never declared.
 */
export function modelConfigForModel(run: RunConfig, modelId: string): ModelConfig {
  const profile = run.provider ? MODEL_PROFILES[run.provider]?.[modelId] : undefined
  return {
    modelId,
    reasoningEffort: profile?.defaultReasoningEffort ?? 'high',
    contextWindow: profile?.defaultContextWindow ?? null,
    fastMode: profile?.supportsFastMode ? run.modelConfig.fastMode : false,
  }
}

/** The run on another agent and model, with that model's own defaults and the
 *  reasoning level the selection names. A task lead starts on the lead model
 *  the user set (Settings → Tasks). */
export function runOnModel(
  run: RunConfig,
  selection: { provider: AgentId; model: string; reasoningEffort?: ReasoningEffort },
): RunConfig {
  const next = { ...run, provider: selection.provider }
  const modelConfig = modelConfigForModel(next, selection.model)
  if (selection.reasoningEffort) modelConfig.reasoningEffort = selection.reasoningEffort
  return { ...next, modelConfig }
}

/** The permission mode after `mode`, in `PERMISSION_MODES` order, wrapping at the end. */
export function nextPermissionMode(mode: RunConfig['permissionMode']): RunConfig['permissionMode'] {
  const idx = PERMISSION_MODES.indexOf(mode)
  return PERMISSION_MODES[(idx + 1) % PERMISSION_MODES.length]
}

/**
 * Where a new session starts when nothing on screen names a project: the
 * project the last session started in, unless its host is known to be down;
 * else a new chat on the default host. "Known to be down", not
 * "not yet up": at boot every host is still connecting, and the draft seeded
 * then must already name the right project. A session opened *from* something
 * takes that source's project first — `resolveNewRunConfig` owns that step.
 */
export function defaultStartProject(
  lastProject: ProjectLocation | null,
  isDown: (serverId: string) => boolean,
  newChat: ProjectLocation,
): ProjectLocation {
  return lastProject && !isDown(lastProject.serverId) ? lastProject : newChat
}
