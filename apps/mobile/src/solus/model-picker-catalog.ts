import {
  isLegacyModel,
  REASONING_EFFORT_LABELS,
  type AgentMetadata,
  type PermissionMode,
  type ReasoningEffort,
} from "@solus/contracts/types";
import { modelProfileForAgent } from "@solus/contracts/provider-instance-models";
import { providerDefaultModel } from "@solus/contracts/provider-model-settings";
import type { ProviderInstanceChoice } from "@solus/contracts/provider-instances";
import {
  selectModel,
  supportsFastMode,
  type RunDefaults,
} from "@solus-mobile/features/conversation/lib/run-settings";
import {
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type RuntimeMode,
} from "@t3tools/contracts";
import { modelFavoriteKey } from "../features/threads/thread-settings-sheet-state";
import type { ModelOption, ProviderGroup } from "../lib/modelOptions";

export const permissionModes = {
  "approval-required": "supervised",
  "auto-accept-edits": "accept-edits",
  auto: "auto",
  "full-access": "full-access",
} as const satisfies Record<RuntimeMode, PermissionMode>;

type CatalogAgent = Pick<
  AgentMetadata,
  "id" | "label" | "models" | "defaultModel" | "modelProfiles" | "capabilities"
>;

export function modelInstanceId(provider: AgentMetadata["id"]) {
  return ProviderInstanceId.make(
    provider === "claude-code" ? "claudeAgent" : provider,
  );
}

export function runOptionSelections(run: {
  reasoningEffort?: ReasoningEffort;
  fastMode?: boolean;
}) {
  const options: ProviderOptionSelection[] = [];
  if (run.reasoningEffort !== undefined)
    options.push({ id: "effort", value: run.reasoningEffort });
  if (run.fastMode !== undefined)
    options.push({ id: "fastMode", value: run.fastMode });
  return options;
}

/** Accept only values offered for this model, including a staged model switch. */
export function pickerRunOptions(
  model: ModelOption,
  selections: ReadonlyArray<ProviderOptionSelection>,
) {
  const effort = selections.find(({ id }) => id === "effort")?.value;
  const fastMode = selections.find(({ id }) => id === "fastMode")?.value;
  const descriptors = model.capabilities?.optionDescriptors;
  const reasoning = descriptors?.find(
    (option) => option.type === "select" && option.id === "effort",
  );
  return {
    ...(typeof effort === "string" &&
    isReasoningEffort(effort) &&
    reasoning?.type === "select" &&
    reasoning.options.some(({ id }) => id === effort)
      ? { reasoningEffort: effort }
      : {}),
    ...(typeof fastMode === "boolean" &&
    descriptors?.some((option) => option.id === "fastMode")
      ? { fastMode }
      : {}),
  };
}

function isReasoningEffort(value: string): value is ReasoningEffort {
  return Object.hasOwn(REASONING_EFFORT_LABELS, value);
}

export function solusModelGroup(
  agent: CatalogAgent,
  defaults: RunDefaults | null = null,
  instance?: ProviderInstanceChoice,
): ProviderGroup {
  const instanceId = modelInstanceId(agent.id);
  const defaultModel =
    providerDefaultModel(
      agent.id,
      defaults?.defaultModels[agent.id],
      agent.modelProfiles,
    ) ?? agent.defaultModel;
  const custom = new Set(instance?.customModels.map(({ id }) => id));
  const hidden = new Set(instance?.hiddenModels);
  const models = [
    ...agent.models,
    ...(instance?.hiddenModels.flatMap((id) => {
      const profile = modelProfileForAgent(agent.id, id, agent);
      return profile && !agent.models.some((model) => model.id === id)
        ? [{ id, label: profile.label }]
        : [];
    }) ?? []),
  ];
  return {
    providerKey: instanceId,
    providerLabel: agent.label,
    models: models.map((model) => {
      const profile = modelProfileForAgent(agent.id, model.id, agent);
      const run = selectModel(agent.id, model.id, defaults, agent);
      const descriptors: ProviderOptionDescriptor[] = [];
      if (profile?.reasoningLevels.length) {
        const promptInjected = agent.id === "claude-code";
        descriptors.push({
          id: "effort",
          label: "Reasoning",
          type: "select",
          role: "reasoning",
          options: [
            ...profile.reasoningLevels.map((id) => ({
              id,
              label: REASONING_EFFORT_LABELS[id],
              isDefault: id === profile.defaultReasoningEffort,
            })),
            ...(promptInjected
              ? [{ id: "ultrathink", label: "Ultrathink" }]
              : []),
          ],
          currentValue: run.reasoningEffort,
          ...(promptInjected ? { promptInjectedValues: ["ultrathink"] } : {}),
        });
      }
      const hasFastMode = supportsFastMode(agent.id, model.id, agent);
      if (hasFastMode) {
        descriptors.push({
          id: "fastMode",
          label: "Fast Mode",
          type: "boolean",
          currentValue: run.fastMode,
        });
      }
      return {
        key: modelFavoriteKey(instanceId, model.id),
        label: model.label,
        subtitle: "",
        providerKey: instanceId,
        providerLabel: agent.label,
        providerDriver: instanceId,
        isDefault: agent.defaultModel === model.id,
        isLegacy: isLegacyModel(agent.id, model.id, agent.modelProfiles),
        isHidden: !custom.has(model.id) && hidden.has(model.id),
        canHide:
          !!instance &&
          !!model.id &&
          !custom.has(model.id) &&
          (hidden.has(model.id) || model.id !== defaultModel),
        capabilities: descriptors.length
          ? { optionDescriptors: descriptors }
          : null,
        selection: {
          instanceId,
          model: model.id,
          options: runOptionSelections({
            ...(profile?.reasoningLevels.length
              ? { reasoningEffort: run.reasoningEffort }
              : {}),
            ...(hasFastMode ? { fastMode: run.fastMode } : {}),
          }),
        },
      };
    }),
  };
}
