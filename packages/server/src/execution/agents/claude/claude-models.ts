import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk'
import { MODEL_PROFILES, REASONING_EFFORT_LABELS, type ModelProfile, type ReasoningEffort } from '@solus/contracts/types'

/** Claude Code names no context window for a model; the window Claude runs a model at without `[1m]`. */
const REPORTED_CONTEXT_WINDOW = 200_000
/** Claude Code's own wait for a gateway's model list, when no setting changes it. */
const GATEWAY_DISCOVERY_TIMEOUT_MS = 3_000
/** A setting can ask for any wait; a read of the model list never holds a process longer than this. */
const GATEWAY_DISCOVERY_MAX_MS = 30_000

function isReasoningEffort(effort: string): effort is ReasoningEffort {
  return Object.hasOwn(REASONING_EFFORT_LABELS, effort)
}

/** One spelling for a model id: Claude Code names the long-context variant `<model>[1m]`. */
function comparableModelId(id: string): string {
  return id.replace(/\[[^\]]*\]$/, '').trim().toLowerCase()
}

function defaultEffortOf(levels: readonly ReasoningEffort[]): ReasoningEffort {
  return levels.includes('medium') ? 'medium' : levels[0] ?? 'medium'
}

/**
 * Profiles for the models Claude Code reports that the published model list
 * does not know (t3code #30511), such as a gateway's models. The published list
 * stays authoritative: a model it knows is never returned, by its id or by the
 * model an alias resolves to, so `sonnet` adds no row. It is read at call time,
 * because the host replaces it daily.
 */
export function unlistedClaudeModelProfiles(models: readonly ModelInfo[]) {
  const known = new Set(Object.keys(MODEL_PROFILES['claude-code'] ?? {}).map(comparableModelId))
  const profiles = new Map<string, ModelProfile>()
  for (const model of models) {
    const id = model.value.trim()
    // `default` is Claude Code's pointer at its own default model, not a model.
    if (!id || id === 'default') continue
    const names = [id, model.resolvedModel ?? ''].map(comparableModelId).filter(Boolean)
    if (names.some((name) => known.has(name))) continue
    for (const name of names) known.add(name)
    const reasoningLevels = model.supportsEffort ? (model.supportedEffortLevels ?? []).filter(isReasoningEffort) : []
    profiles.set(id, {
      label: model.displayName.trim() || id,
      reasoningLevels,
      defaultReasoningEffort: defaultEffortOf(reasoningLevels),
      supportsFastMode: model.supportsFastMode === true,
      contextWindows: [REPORTED_CONTEXT_WINDOW],
      defaultContextWindow: REPORTED_CONTEXT_WINDOW,
    })
  }
  return Object.fromEntries(profiles)
}

/**
 * The catalog id of a model Claude reports running. Claude names a dated id
 * (`claude-opus-4-5-20251101`); when the published list does not know it, the
 * id without its date (`claude-opus-4-5`) is the one a person asks for.
 */
export function catalogClaudeModelId(model: string): string {
  return Object.hasOwn(MODEL_PROFILES['claude-code'] ?? {}, model) ? model : model.replace(/-\d{8}$/, '')
}

/**
 * The effort a run sends for a reported model: the requested one if the model
 * offers it, else the model's default, and none for a model with no levels.
 */
export function reportedModelEffort(profile: ModelProfile, requested: ReasoningEffort | undefined): ReasoningEffort | undefined {
  if (!profile.reasoningLevels.length) return undefined
  return requested && profile.reasoningLevels.includes(requested) ? requested : profile.defaultReasoningEffort
}

/**
 * How long a model read keeps Claude open for a gateway's models. Claude Code
 * fetches them in the background after it starts, so a read at once misses them
 * on a new config folder. Zero unless discovery is on and a gateway is set.
 * `settingsEnv` is the `env` of the user's settings.json, where gateway users
 * usually put these; its values can be unquoted, so they are read as strings.
 */
export function gatewayDiscoveryWaitMs(processEnv: NodeJS.ProcessEnv, settingsEnv: Record<string, string | number | boolean>): number {
  const value = (name: string) => String(settingsEnv[name] ?? processEnv[name] ?? '').trim()
  const enabled = value('CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY').toLowerCase()
  if (!enabled || enabled === '0' || enabled === 'false' || !value('ANTHROPIC_BASE_URL')) return 0
  const configured = Number(value('CLAUDE_CODE_GATEWAY_MODEL_DISCOVERY_TIMEOUT_MS'))
  return configured > 0 ? Math.min(configured, GATEWAY_DISCOVERY_MAX_MS) : GATEWAY_DISCOVERY_TIMEOUT_MS
}
