import { isLegacyModel, type AgentMetadata } from "@solus/contracts/types";
import { ProviderInstanceId } from "@t3tools/contracts";
import { modelFavoriteKey } from "../features/threads/thread-settings-sheet-state";
import type { ProviderGroup } from "../lib/modelOptions";

export function solusModelGroup(
  agent: Pick<AgentMetadata, "id" | "label" | "models" | "defaultModel" | "modelProfiles">,
): ProviderGroup {
  const instanceId = ProviderInstanceId.make(agent.id === "claude-code" ? "claudeAgent" : agent.id);
  return {
    providerKey: instanceId,
    providerLabel: agent.label,
    models: agent.models.map((model) => ({
      key: modelFavoriteKey(instanceId, model.id),
      label: model.label,
      subtitle: "",
      providerKey: instanceId,
      providerLabel: agent.label,
      providerDriver: instanceId,
      isDefault: agent.defaultModel === model.id,
      isLegacy: isLegacyModel(agent.id, model.id, agent.modelProfiles),
      capabilities: null,
      selection: { instanceId, model: model.id },
    })),
  };
}
