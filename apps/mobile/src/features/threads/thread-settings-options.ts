// Adapted from T3 Code apps/mobile/src/features/threads/thread-settings-options.ts and
// thread-settings-sheet-state.ts (MIT, see UPSTREAM.md).
import { MODEL_PROFILES, isLegacyModel, providerModelsFor, type AgentId, type AgentMetadata, type PermissionMode, type ReasoningEffort } from '@solus/contracts/types'
import { AUTO_MODEL_ID } from '@solus/contracts/model-routing'
import { effortChoices, PERMISSION_MODE_TEXT, permissionModesFor, PROVIDERS, type AgentCapabilities } from '../conversation/lib/run-settings'

/**
 * The thread settings sheet's catalog and options, on Solus terms: a T3
 * provider instance is a Solus agent (Claude Code, Codex), its models come
 * from the host's model profiles, "Reasoning" is the reasoning effort, and
 * "Permission mode" is the Solus permission mode, as the desktop composer
 * names them.
 */

/** Desktop-only effort keywords that are workflow triggers, not reasoning levels. */
const HIDDEN_EFFORT_OPTION_IDS: ReadonlySet<ReasoningEffort> = new Set(['ultracode'])

export interface PermissionModeChoice {
  readonly mode: PermissionMode
  readonly label: string
  readonly description: string
}

/** The desktop permission picker's modes, labels, and descriptions, in its
 *  order, less the modes this agent does not offer. */
export function permissionModeChoices(capabilities: AgentCapabilities): PermissionModeChoice[] {
  return permissionModesFor(capabilities).map((mode) => ({ mode, ...PERMISSION_MODE_TEXT[mode] }))
}

export interface ModelOption {
  /** `<provider>:<model>`, unique across the catalog. */
  readonly key: string
  readonly provider: AgentId
  readonly providerLabel: string
  readonly model: string
  readonly label: string
  /** The model the agent starts on: one per agent, as the desktop picker's default. */
  readonly isDefault: boolean
  readonly isLegacy: boolean
}

export interface ProviderGroup {
  readonly providerKey: AgentId
  readonly providerLabel: string
  readonly models: ReadonlyArray<ModelOption>
  /** Why this agent cannot be picked now; null when it can. */
  readonly unavailableReason: string | null
}

/**
 * Whether a picker may move the session to an agent, by the desktop rule
 * (`agentAvailability.ts`): only an agent the host reports installed. The
 * session's own agent stays pickable, as on desktop, so its models can change
 * while the host is still answering. Unknown is said as unknown.
 */
export function agentUnavailableReason(input: {
  readonly provider: AgentId
  readonly currentProvider: AgentId
  readonly agents: readonly AgentMetadata[] | null
}): string | null {
  if (input.provider === input.currentProvider) return null
  if (!input.agents) return 'Checking availability'
  const agent = input.agents.find((candidate) => candidate.id === input.provider)
  if (!agent) return 'Not on this host'
  return agent.available === true ? null : 'Not installed'
}

export function modelOptionKey(provider: AgentId, model: string): string {
  return `${provider}:${model}`
}

/** Auto as a pick: the host chooses the agent and model for the first prompt.
 *  It stays on the session's agent until then, as on desktop. */
export function autoModelOption(provider: AgentId): ModelOption {
  return { key: AUTO_MODEL_ID, provider, providerLabel: 'Solus', model: AUTO_MODEL_ID, label: 'Auto', isDefault: false, isLegacy: false }
}

/**
 * Every model a picker offers, grouped by agent. A session that cannot switch
 * agents keeps its own group only. The session's own legacy model stays listed.
 */
export function buildProviderGroups(input: {
  readonly currentProvider: AgentId
  readonly currentModel: string | null
  readonly canSwitchProvider: boolean
  /** The host's agents; null while it has not answered. */
  readonly agents: readonly AgentMetadata[] | null
}): ProviderGroup[] {
  return PROVIDERS
    .filter((provider) => input.canSwitchProvider || provider.id === input.currentProvider)
    .map((provider) => {
      // Several profiles can carry `isDefault`; the agent starts on the first.
      const { defaultModel } = providerModelsFor(provider.id)
      return {
        providerKey: provider.id,
        providerLabel: provider.label,
        unavailableReason: agentUnavailableReason({ provider: provider.id, currentProvider: input.currentProvider, agents: input.agents }),
        models: Object.entries(MODEL_PROFILES[provider.id] ?? {}).map(([model, profile]) => ({
          key: modelOptionKey(provider.id, model),
          provider: provider.id,
          providerLabel: provider.label,
          model,
          label: profile.label,
          isDefault: model === defaultModel,
          isLegacy: isLegacyModel(provider.id, model) && !(provider.id === input.currentProvider && model === input.currentModel),
        })),
      }
    })
    .filter((group) => group.models.length > 0)
}

/** Reasoning levels a phone offers for a model. A value set elsewhere still shows. */
export function selectableEffortChoices(provider: AgentId, model: string | null): ReasoningEffort[] {
  return effortChoices(provider, model).filter((effort) => !HIDDEN_EFFORT_OPTION_IDS.has(effort))
}

/** Match the terms a user can actually see or recognize in the model picker. */
export function modelMatchesCatalogQuery(input: { readonly model: ModelOption; readonly query: string }): boolean {
  const query = input.query.trim().toLocaleLowerCase()
  if (query.length === 0) return true
  return [input.model.label, input.model.model, input.model.providerLabel]
    .some((value) => value.toLocaleLowerCase().includes(query))
}

/** Tapping the applied model clears a staged pick; tapping another stages it. */
export function pendingModelAfterPress(input: {
  readonly current: ModelOption | null
  readonly pressed: ModelOption
  readonly pressedIsApplied: boolean
}): ModelOption | null {
  if (input.pressedIsApplied) return null
  return input.current?.key === input.pressed.key ? input.current : input.pressed
}

/**
 * Primary and selected providers start open; all other catalogs start closed.
 * A user's disclosure tap inverts that default until the picker is dismissed.
 */
export function providerSectionIsCollapsed(input: {
  readonly defaultExpanded: boolean
  readonly hasExpansionOverride: boolean
  readonly isNarrowed: boolean
}): boolean {
  if (input.isNarrowed) return false
  return input.defaultExpanded ? input.hasExpansionOverride : !input.hasExpansionOverride
}
