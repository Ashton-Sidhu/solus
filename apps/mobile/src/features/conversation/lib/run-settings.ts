import {
  defaultContextWindowFor,
  isLegacyModel,
  MODEL_PROFILES,
  PERMISSION_MODES,
  REASONING_EFFORT_LABELS,
  runtimeModelVariant,
  type AgentId,
  type PermissionMode,
  type ReasoningEffort,
} from '@solus/contracts/types'
import { AUTO_MODEL_ID } from '@solus/contracts/model-routing'
import type { PersonalSettings } from '@solus/contracts/settings'

/**
 * The model, reasoning effort, and permission mode a native conversation runs
 * with. Same rules as the desktop session config (`session-config.svelte.ts`):
 * a model change starts from the model's profile and the person's saved
 * options for it; the window always follows the model, because a session
 * resumed without its window drops to the provider default and loses history.
 * A change applies to the next prompt; the host has no call that changes a
 * running turn.
 */

/** The labels the desktop permission picker shows (`lib/permission-modes.ts`). */
export const PERMISSION_MODE_TEXT = {
  supervised: { label: 'Supervised', description: 'Ask before commands and edits' },
  'accept-edits': { label: 'Accept edits', description: 'Edit files, ask before commands' },
  auto: { label: 'Auto', description: 'Approve routine actions' },
  'full-access': { label: 'Full access', description: 'Never ask for approval' },
  plan: { label: 'Plan', description: 'Read only, propose a plan' },
} satisfies Record<PermissionMode, { label: string; description: string }>

export { PERMISSION_MODES }

/** The agents a session can start on from this app. */
export const PROVIDERS: Array<{ id: AgentId; label: string }> = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
]

export type RunDefaults = Pick<PersonalSettings, 'defaultModels' | 'modelOptionsByProvider'>

export interface ModelSelection {
  preferredModel: string | null
  reasoningEffort: ReasoningEffort
  contextWindow: number | null
}

/** Models a picker offers: current ones, plus the session's own model if it is legacy. */
export function modelChoices(provider: AgentId, currentModel: string | null): Array<{ id: string; label: string }> {
  return Object.entries(MODEL_PROFILES[provider] ?? {})
    .filter(([id]) => !isLegacyModel(provider, id) || id === currentModel)
    .map(([id, profile]) => ({ id, label: profile.label }))
}

export function effortChoices(provider: AgentId, modelId: string | null): ReasoningEffort[] {
  return (modelId ? MODEL_PROFILES[provider]?.[modelId]?.reasoningLevels : undefined) ?? ['low', 'medium', 'high']
}

export function effortLabel(effort: ReasoningEffort): string {
  return REASONING_EFFORT_LABELS[effort]
}

export function modelLabel(provider: AgentId, modelId: string | null): string {
  if (!modelId) return 'Host default'
  if (modelId === AUTO_MODEL_ID) return 'Auto'
  return MODEL_PROFILES[provider]?.[modelId]?.label ?? modelId
}

/** A model with the person's saved options for it, clamped to what it offers. */
export function selectModel(provider: AgentId, modelId: string, defaults: RunDefaults | null): ModelSelection {
  // Auto is routed by the host on the first prompt, with fixed options.
  if (modelId === AUTO_MODEL_ID) return { preferredModel: modelId, reasoningEffort: 'medium', contextWindow: null }
  const profile = MODEL_PROFILES[provider]?.[modelId]
  const saved = defaults?.modelOptionsByProvider[provider]?.[modelId]
  const levels = profile?.reasoningLevels ?? []
  const effort = saved && levels.includes(saved.reasoningEffort) ? saved.reasoningEffort : profile?.defaultReasoningEffort ?? 'high'
  const window = saved?.contextWindow && profile?.contextWindows.includes(saved.contextWindow)
    ? saved.contextWindow
    : defaultContextWindowFor(provider, modelId)
  return { preferredModel: modelId, reasoningEffort: effort, contextWindow: window }
}

/** A new session's model: the person's default for the provider, else the profile's. */
export function newSessionModel(provider: AgentId, defaults: RunDefaults | null): ModelSelection {
  const chosen = defaults?.defaultModels[provider]
  const profiles = MODEL_PROFILES[provider] ?? {}
  if (chosen === AUTO_MODEL_ID) return selectModel(provider, AUTO_MODEL_ID, defaults)
  if (chosen && profiles[chosen]) return selectModel(provider, chosen, defaults)
  const fallback = Object.keys(profiles).find((id) => profiles[id]?.isDefault)
  return fallback ? selectModel(provider, fallback, defaults) : { preferredModel: null, reasoningEffort: 'high', contextWindow: null }
}

/** A saved session's model as it ran: Claude reports its long-context variant
 *  as `<model>[1m]`, which is a model id and a window, not a model of its own. */
export function savedSessionModel(provider: AgentId, model: string | null, effort: ReasoningEffort | null): ModelSelection {
  if (!model) return { preferredModel: null, reasoningEffort: effort ?? 'high', contextWindow: null }
  const variant = runtimeModelVariant(provider, model)
  return {
    preferredModel: variant.modelId,
    reasoningEffort: effort ?? MODEL_PROFILES[provider]?.[variant.modelId]?.defaultReasoningEffort ?? 'high',
    contextWindow: variant.contextWindow ?? defaultContextWindowFor(provider, variant.modelId),
  }
}
