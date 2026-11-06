import { providerDefaultModel } from "@solus/contracts/provider-model-settings";
import { modelProfileForAgent } from '@solus/contracts/provider-instance-models'
import { MODEL_PROFILES, isLegacyModel } from "@solus/contracts/types";
import type { AgentId, AgentMetadata, ModelProfile, ReasoningEffort } from "@solus/contracts/types";

/**
 * A local agent/model/effort choice a detached SessionChip reads and mutates in
 * place. The host applies it at dispatch (updateModelConfig / approve opts)
 * instead of the chip mutating the session directly.
 */
export interface PickerSelection {
  provider: AgentId;
  modelId: string | null;
  reasoningEffort: ReasoningEffort;
  fastMode: boolean;
}

export type ModelPickerColumn = "rail" | "model" | "reasoning" | "footer";

interface SessionSettingsShortcutTarget {
  isPrimary: boolean;
  tabId?: string;
  targetTabId?: string;
}

/** The unaddressed shortcut belongs to the visible primary composer, including
 * a new-session draft. An addressed shortcut belongs only to that session. */
export function isSessionSettingsShortcutTarget({
  isPrimary,
  tabId,
  targetTabId,
}: SessionSettingsShortcutTarget): boolean {
  return targetTabId === undefined ? isPrimary : targetTabId === tabId;
}

interface ModelPickerNavigation {
  key: string;
  column: ModelPickerColumn;
  index: number;
  columnLength: number;
  oppositeColumnLength: number;
  preferredOppositeIndex: number;
  /** Rows in the footer under the two columns. */
  footerLength?: number;
  /** The rail's row to land on from the model list. Unset when there is no rail. */
  railIndex?: number;
}

/** The key that leaves each column for the other one. */
const CROSSING_KEY = {
  model: "ArrowRight",
  reasoning: "ArrowLeft",
  footer: "ArrowUp",
  rail: "ArrowRight",
} satisfies { [column in ModelPickerColumn]: string };

/** The moves along the footer and onto the rail. Undefined when neither applies. */
function sidewaysTarget({
  key,
  column,
  index,
  columnLength,
  railIndex,
}: Pick<ModelPickerNavigation, "key" | "column" | "index" | "columnLength" | "railIndex">): { column: ModelPickerColumn; index: number } | null | undefined {
  if (key === "ArrowLeft" && column === "model" && railIndex !== undefined) return { column: "rail", index: railIndex };
  if (column !== "footer" || (key !== "ArrowLeft" && key !== "ArrowRight")) return undefined;
  // Right on the last row stays with that row, which opens its own flyout.
  if (key === "ArrowRight" && index === columnLength - 1) return null;
  return { column, index: Math.max(0, index + (key === "ArrowRight" ? 1 : -1)) };
}

/**
 * Keep vertical movement inside the visual column. Crossing columns is an
 * explicit left/right action so reaching Reasoning never costs a lap through
 * every model. The footer is one row under both columns: down from the end of
 * either column reaches it, left and right move along it, and up leaves it.
 * The rail sits left of the model list, one key away from any model.
 */
export function modelPickerNavigationTarget({
  key,
  column,
  index,
  columnLength,
  oppositeColumnLength,
  preferredOppositeIndex,
  footerLength = 0,
  railIndex,
}: ModelPickerNavigation): { column: ModelPickerColumn; index: number } | null {
  const sideways = sidewaysTarget({ key, column, index, columnLength, railIndex });
  if (sideways !== undefined) return sideways;
  if (key === "ArrowUp" && column !== "footer") return { column, index: Math.max(0, index - 1) };
  if (key === "ArrowDown") {
    if (column !== "footer" && index === columnLength - 1 && footerLength > 0) return { column: "footer", index: 0 };
    return { column, index: Math.min(columnLength - 1, index + 1) };
  }
  if (key === "Home") return { column, index: 0 };
  if (key === "End") return { column, index: columnLength - 1 };

  if (key !== CROSSING_KEY[column] || oppositeColumnLength === 0) return null;

  return {
    column: column === "model" ? "reasoning" : "model",
    index: Math.min(Math.max(0, preferredOppositeIndex), oppositeColumnLength - 1),
  };
}

/** Models offered for an agent: live metadata when present, static MODEL_PROFILES otherwise. */
export function modelOptionsFor(
  provider: AgentId,
  metadataByAgent: Record<string, AgentMetadata | null>,
): Array<{ id: string; label: string }> {
  const metaModels = metadataByAgent[provider]?.models ?? [];
  if (metaModels.length > 0 || metadataByAgent[provider]?.modelProfiles) return metaModels;
  const profiles = MODEL_PROFILES[provider];
  return profiles
    ? Object.entries(profiles).map(([id, profile]) => ({ id, label: profile.label }))
    : [];
}

interface ModelOption {
  id: string;
  label: string;
}

/** The disclosure row's `data-picker-value`. Namespaced so it can never collide
 *  with a model id the keyboard navigation is looking up. */
export const LEGACY_SECTION_VALUE = "solus:legacy-models";

/**
 * The model column in two parts: the generation we expect people to pick, and
 * the superseded ones the picker keeps behind a disclosure. Order within each
 * part is the provider's own — resorting would bury the newest model.
 */
export function splitLegacyModels(
  provider: AgentId,
  models: readonly ModelOption[],
  profiles?: Record<string, ModelProfile>,
): { current: ModelOption[]; legacy: ModelOption[] } {
  const current: ModelOption[] = [];
  const legacy: ModelOption[] = [];
  for (const model of models) {
    (isLegacyModel(provider, model.id, profiles) ? legacy : current).push(model);
  }
  return { current, legacy };
}

/** Personal defaults take precedence over the catalog default. */
export function defaultModelIdFor(
  provider: AgentId,
  metadataByAgent: Record<string, AgentMetadata | null>,
  savedModel?: string,
  allowAuto = true,
): string | null {
  const metadata = metadataByAgent[provider];
  const profiles = metadata?.modelProfiles ?? MODEL_PROFILES[provider] ?? {};
  const chosen = savedModel;
  if (chosen !== undefined && chosen !== null && (allowAuto || chosen !== "auto")) {
    const configured = providerDefaultModel(provider, chosen, profiles);
    if (configured) return configured;
  }
  return providerDefaultModel(provider, undefined, profiles) ?? metadata?.defaultModel ?? Object.keys(profiles)[0] ?? null;
}

export function reasoningLevelsFor(provider: AgentId, modelId: string | null, metadata?: AgentMetadata | null): ReasoningEffort[] {
  return modelProfileForAgent(provider, modelId, metadata)?.reasoningLevels ?? ["low", "medium", "high"];
}

/** The effort a model lands on when it is picked — the menu previews this on hover. */
export function defaultReasoningFor(
  provider: AgentId,
  modelId: string | null,
  metadata?: AgentMetadata | null,
): ReasoningEffort | null {
  return modelProfileForAgent(provider, modelId, metadata)?.defaultReasoningEffort ?? null;
}

export function supportsFastModeFor(provider: AgentId, modelId: string | null, metadata?: AgentMetadata | null): boolean {
  return modelProfileForAgent(provider, modelId, metadata)?.supportsFastMode ?? false;
}

/** Keep the chosen effort when the model supports it; otherwise fall back to the model's default. */
export function clampReasoningEffort(
  provider: AgentId,
  modelId: string | null,
  effort: ReasoningEffort,
): ReasoningEffort {
  const profile = MODEL_PROFILES[provider]?.[modelId ?? ""];
  if (!profile) return effort;
  if (profile.reasoningLevels.includes(effort)) return effort;
  return profile.defaultReasoningEffort ?? "high";
}

/** A choice made inside the model picker. */
export type ModelPickerPick = "model" | "effort" | "fast-mode" | "agent" | "permission-mode";

/**
 * An effort and a permission mode are final choices: they close the picker and
 * focus returns to the input bar. A model pick moves on to that model's effort,
 * and Fast mode and the agent are steps on the way, so they keep the picker
 * open. Escape and a click outside close it at any step.
 */
export function pickClosesModelPicker(pick: ModelPickerPick): boolean {
  return pick === "effort" || pick === "permission-mode";
}

/** Why the picker is placing focus: it just opened, a model was picked, or the
 *  shortcut fired while the picker was already open. */
export type ModelPickerFocusReason = "open" | "model-picked" | "shortcut";

/** The row to focus: a column and the `data-picker-value` of a row in it. */
export interface ModelPickerFocus {
  column: ModelPickerColumn;
  value: string | null;
}

/**
 * The row that takes focus. Opening lands on the current model, so → reaches
 * its levels in one key. A model pick, or the shortcut while open, lands on the
 * current level, so model then effort is one flow. A model with no levels to
 * pick (Auto, a model-only picker) keeps focus on the model itself.
 */
export function modelPickerFocusTarget({
  reason,
  modelId,
  effort,
  levels,
}: {
  reason: ModelPickerFocusReason;
  modelId: string | null;
  effort: ReasoningEffort;
  levels: readonly ReasoningEffort[];
}): ModelPickerFocus {
  if (reason === "open" || levels.length === 0) return { column: "model", value: modelId };
  return { column: "reasoning", value: levels.includes(effort) ? effort : levels[0] };
}

/**
 * Rows the Reasoning column holds for its levels, taken over every model of
 * every agent on offer. The model column scrolls
 * inside this height, so the popup keeps one size while the cursor crosses
 * models, the legacy list opens, or the agent changes.
 */
export function reservedReasoningRows(
  agentIds: readonly AgentId[],
  metadataByAgent: Record<string, AgentMetadata | null>,
): number {
  let deepest = 0;
  for (const agentId of agentIds) {
    const metadata = metadataByAgent[agentId];
    for (const model of modelOptionsFor(agentId, metadataByAgent)) {
      deepest = Math.max(deepest, reasoningLevelsFor(agentId, model.id, metadata).length);
    }
  }
  return deepest;
}

/**
 * Whether any model of any agent on offer can take Fast mode. A footer that
 * holds only that control stays while the agent changes, so the popup keeps one
 * size.
 */
export function offersFastMode(
  agentIds: readonly AgentId[],
  metadataByAgent: Record<string, AgentMetadata | null>,
): boolean {
  return agentIds.some(
    (agentId) =>
      agentId === "codex" &&
      modelOptionsFor(agentId, metadataByAgent).some((model) => supportsFastModeFor(agentId, model.id, metadataByAgent[agentId])),
  );
}
