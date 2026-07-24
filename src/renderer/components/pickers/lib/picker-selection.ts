import { MODEL_PROFILES } from "../../../../shared/types";
import type { AgentId, AgentMetadata, ReasoningEffort } from "../../../../shared/types";

/**
 * A local agent/model/effort choice a detached SessionChip reads and mutates in
 * place. The host applies it at dispatch (updateModelConfig / approve opts)
 * instead of the chip mutating the session directly.
 */
export interface PickerSelection {
  provider: AgentId;
  modelId: string | null;
  reasoningEffort: ReasoningEffort;
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
