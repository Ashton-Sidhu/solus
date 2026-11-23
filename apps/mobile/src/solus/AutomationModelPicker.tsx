import { agentProjectInstance } from "@solus/contracts/provider-instance-models";
import { Atom } from "effect/reactivity";
import { useAtomValue } from "@effect/atom-react";
import {
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { ProjectId, type EnvironmentId } from "@t3tools/contracts";
import type {
  AgentId,
  PermissionMode,
  ReasoningEffort,
} from "@solus/contracts/types";
import { workPolicy } from "@solus-mobile/features/policy/lib/policy-view";
import {
  newSessionModel,
  selectModel,
} from "@solus-mobile/features/conversation/lib/run-settings";
import { appAtomRegistry } from "../state/atom-registry";
import { ThreadSettingsPickerScreen } from "../features/threads/ThreadSettingsSheet";
import { resolveProviderOptionDescriptors } from "../lib/providerOptions";
import { toRuntimeMode } from "./session";
import { Note } from "./SettingsFeedback";
import {
  modelInstanceId,
  permissionModes,
  pickerRunOptions,
  runOptionSelections,
  solusModelGroup,
} from "./model-picker-catalog";
import { solus } from "./runtime";
import { useModelPickerHost } from "./use-model-picker-host";

interface PickerDraft {
  changed: boolean;
  host: EnvironmentId;
  cwd: string;
  organizationId: string | null;
  provider: AgentId;
  model: string;
  prompt: string;
  permissions: PermissionMode;
  reasoningEffort: ReasoningEffort;
  fastMode: boolean;
}

export const automationModelDraft = Atom.family((_editorKey: string) =>
  Atom.make<PickerDraft | null>(null),
);

export function AutomationModelPicker({
  route,
}: StaticScreenProps<{ editorKey: string }>) {
  const atom = automationModelDraft(route.params.editorKey);
  const draft = useAtomValue(atom);
  if (!draft) return <Note>Open a scheduled task to choose a model.</Note>;
  return (
    <Picker
      draft={draft}
      onUpdate={(patch) => {
        const current = appAtomRegistry.get(atom);
        if (current)
          appAtomRegistry.set(atom, { ...current, ...patch, changed: true });
      }}
    />
  );
}

function Picker({
  draft,
  onUpdate,
}: {
  draft: PickerDraft;
  onUpdate: (patch: Partial<PickerDraft>) => void;
}) {
  const navigation = useNavigation();
  const host = useModelPickerHost(draft.host, draft.cwd);
  const policy = workPolicy(host.policies, draft.organizationId);
  const defaults = solus.personal.runSettings();
  const agents = (host.agents ?? []).filter(
    (agent) =>
      (agent.id === "codex" || agent.id === "claude-code") &&
      !policy.providerDenial(agent.id),
  );
  const groups = agents.map((agent) => {
    const group = solusModelGroup(
      {
        ...agent,
        models: [{ id: "", label: "Provider default" }, ...agent.models],
        defaultModel: "",
      },
      defaults,
      agentProjectInstance(agent, draft.cwd),
    );
    return {
      ...group,
      statusNotice: agent.unavailableReason ?? host.providerNotice(agent.id),
      models:
        agent.available === false
          ? []
          : group.models.filter(
              (model) =>
                !model.selection.model ||
                !policy.modelDenial(agent.id, model.selection.model),
            ),
    };
  });
  const instanceId = modelInstanceId(draft.provider);
  const selected = groups
    .find((group) => group.providerKey === instanceId)
    ?.models.find((model) => model.selection.model === draft.model);
  const selections = runOptionSelections(draft);
  return (
    <ThreadSettingsPickerScreen
      environmentId={draft.host}
      projectId={ProjectId.make(draft.cwd)}
      cwd={draft.cwd}
      providerGroups={groups}
      providerInstanceId={instanceId}
      pickerHost={{
        ...host,
        runtimeDenial: (mode, selection) => {
          const agent = agents.find(
            (entry) => modelInstanceId(entry.id) === selection?.instanceId,
          );
          if (agent?.capabilities?.permissions === false)
            return "This provider controls its own permissions.";
          return policy.modeDenial(permissionModes[mode])?.message;
        },
      }}
      selectedModel={{ instanceId, model: draft.model, options: selections }}
      prompt={draft.prompt}
      onPromptChange={(prompt) => onUpdate({ prompt })}
      runtimeMode={toRuntimeMode(draft.permissions)}
      onUpdateRuntimeMode={(mode) =>
        onUpdate({ permissions: permissionModes[mode] })
      }
      optionDescriptors={resolveProviderOptionDescriptors({
        capabilities: selected?.capabilities,
        selections,
      })}
      onUpdateOptionSelections={(options) => {
        if (selected) onUpdate(pickerRunOptions(selected, options));
      }}
      onSelectModel={(option) => {
        const agent = agents.find(
          (entry) => modelInstanceId(entry.id) === option.selection.instanceId,
        );
        if (!agent) return;
        const model = option.selection.model;
        const run = model
          ? selectModel(agent.id, model, defaults, agent)
          : newSessionModel(agent.id, defaults, agent, false);
        onUpdate({
          provider: agent.id,
          model,
          reasoningEffort: run.reasoningEffort,
          fastMode: !!model && run.fastMode,
          ...pickerRunOptions(option, option.selection.options ?? []),
        });
      }}
      onClose={() => navigation.goBack()}
    />
  );
}
