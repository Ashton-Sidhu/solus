import { MODEL_PROFILES } from "@solus/contracts/types";
import type { AgentId, AgentMetadata, ReasoningEffort } from "@solus/contracts/types";

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

export type ModelPickerColumn = "model" | "reasoning";

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
}

/**
 * Keep vertical movement inside the visual column. Crossing columns is an
 * explicit left/right action so reaching Reasoning never costs a lap through
 * every model.
 */
export function modelPickerNavigationTarget({
  key,
  column,
  index,
  columnLength,
  oppositeColumnLength,
  preferredOppositeIndex,
}: ModelPickerNavigation): { column: ModelPickerColumn; index: number } | null {
  if (key === "ArrowUp")
    return { column, index: Math.max(0, index - 1) };
  if (key === "ArrowDown")
    return { column, index: Math.min(columnLength - 1, index + 1) };
  if (key === "Home") return { column, index: 0 };
  if (key === "End") return { column, index: columnLength - 1 };

  const isCrossing =
    (key === "ArrowRight" && column === "model") ||
    (key === "ArrowLeft" && column === "reasoning");
  if (!isCrossing || oppositeColumnLength === 0) return null;

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
  if (metaModels.length > 0) return metaModels;
  const profiles = MODEL_PROFILES[provider];
  return profiles
    ? Object.entries(profiles).map(([id, profile]) => ({ id, label: profile.label }))
    : [];
}

export function defaultModelIdFor(
  provider: AgentId,
  metadataByAgent: Record<string, AgentMetadata | null>,
): string | null {
  const metaDefault = metadataByAgent[provider]?.defaultModel;
  if (metaDefault) return metaDefault;
  const profiles = MODEL_PROFILES[provider];
  if (!profiles) return null;
  const defaultEntry = Object.entries(profiles).find(([, profile]) => profile.isDefault);
  return defaultEntry?.[0] ?? Object.keys(profiles)[0] ?? null;
}

export function reasoningLevelsFor(provider: AgentId, modelId: string | null): ReasoningEffort[] {
  return MODEL_PROFILES[provider]?.[modelId ?? ""]?.reasoningLevels ?? ["low", "medium", "high"];
}

/** The effort a model lands on when it is picked — the menu previews this on hover. */
export function defaultReasoningFor(
  provider: AgentId,
  modelId: string | null,
): ReasoningEffort | null {
  return MODEL_PROFILES[provider]?.[modelId ?? ""]?.defaultReasoningEffort ?? null;
}

export function supportsFastModeFor(provider: AgentId, modelId: string | null): boolean {
  return MODEL_PROFILES[provider]?.[modelId ?? ""]?.supportsFastMode ?? false;
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
