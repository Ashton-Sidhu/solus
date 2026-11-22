import { Atom } from "effect/reactivity";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { ProviderInstanceId, ProjectId, type EnvironmentId } from "@t3tools/contracts";
import { MODEL_PROFILES, type AgentId, type PermissionMode } from "@solus/contracts/types";
import { PROVIDERS } from "@solus-mobile/features/conversation/lib/run-settings";
import { appAtomRegistry } from "../state/atom-registry";
import { ThreadSettingsPickerScreen } from "../features/threads/ThreadSettingsSheet";
import { toRuntimeMode } from "./session";
import { Note } from "./SettingsFeedback";
import { solusModelGroup } from "./model-picker-catalog";

interface PickerDraft {
  changed: boolean;
  host: EnvironmentId;
  cwd: string;
  provider: AgentId;
  model: string;
  prompt: string;
  permissions: PermissionMode;
}
export const automationModelDraft = Atom.family((_editorKey: string) =>
  Atom.make<PickerDraft | null>(null),
);
export function AutomationModelPicker({ route }: StaticScreenProps<{ editorKey: string }>) {
  const atom = automationModelDraft(route.params.editorKey);
  const draft = useAtomValue(atom),
    navigation = useNavigation();
  if (!draft) return <Note>Open a scheduled task to choose a model.</Note>;
  const groups = PROVIDERS.map((provider) => {
    const choices = [
      { id: "", label: "Provider default" },
      ...Object.entries(MODEL_PROFILES[provider.id] ?? {}).map(([id, profile]) => ({
        id,
        label: profile.label,
      })),
    ];
    if (provider.id === draft.provider && !choices.some((model) => model.id === draft.model))
      choices.push({ id: draft.model, label: draft.model });
    return solusModelGroup({ ...provider, models: choices, defaultModel: "" });
  });
  function update(patch: Partial<PickerDraft>) {
    const current = appAtomRegistry.get(atom);
    if (current) appAtomRegistry.set(atom, { ...current, ...patch, changed: true });
  }
  const instanceId = ProviderInstanceId.make(
    draft.provider === "claude-code" ? "claudeAgent" : draft.provider,
  );
  return (
    <ThreadSettingsPickerScreen
      environmentId={draft.host}
      projectId={ProjectId.make(draft.cwd)}
      cwd={draft.cwd}
      providerGroups={groups}
      selectedModel={{ instanceId, model: draft.model }}
      prompt={draft.prompt}
      onPromptChange={(prompt) => update({ prompt })}
      runtimeMode={toRuntimeMode(draft.permissions)}
      onUpdateRuntimeMode={(mode) =>
        update({
          permissions:
            mode === "approval-required"
              ? "supervised"
              : mode === "auto-accept-edits"
                ? "accept-edits"
                : mode,
        })
      }
      optionDescriptors={[]}
      onUpdateOptionSelections={() => {}}
      onSelectModel={(option) => {
        const provider = PROVIDERS.find(
          (p) => option.selection.instanceId === (p.id === "claude-code" ? "claudeAgent" : p.id),
        );
        if (provider) update({ provider: provider.id, model: option.selection.model });
      }}
      onClose={() => navigation.goBack()}
    />
  );
}
