import { agentProjectInstance } from "@solus/contracts/provider-instance-models";
import { useSyncExternalStore } from "react";
import {
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { Alert } from "react-native";
import { ProjectId } from "@t3tools/contracts";
import type { ConversationStore } from "@solus-mobile/features/conversation/conversation-store";
import {
  ThreadSettingsPickerScreen,
  type ExistingThreadSettingsRouteParams,
} from "../features/threads/ThreadSettingsSheet";
import {
  useComposerDraft,
  setComposerDraftText,
} from "../state/use-composer-drafts";
import { EmptyState } from "../components/ui/EmptyState";
import { toRuntimeMode } from "./session";
import { solus } from "./runtime";
import { resolveProviderOptionDescriptors } from "../lib/providerOptions";
import {
  modelInstanceId,
  permissionModes,
  pickerRunOptions,
  runOptionSelections,
  solusModelGroup,
} from "./model-picker-catalog";
import { isPickerProvider, useModelPickerHost } from "./use-model-picker-host";
export function SolusThreadSettings({
  route,
}: StaticScreenProps<ExistingThreadSettingsRouteParams>) {
  const store =
    route.params &&
    solus.openConversation(route.params.environmentId, route.params.threadId);
  const navigation = useNavigation();
  if (!store)
    return (
      <EmptyState
        title="Session unavailable"
        detail="Open the session to change its settings."
        actionLabel="Back"
        onAction={() => navigation.goBack()}
      />
    );
  return <Picker store={store} params={route.params} />;
}

function Picker({
  store,
  params,
}: {
  store: ConversationStore;
  params: ExistingThreadSettingsRouteParams;
}) {
  const navigation = useNavigation();
  const meta = useSyncExternalStore(store.meta.subscribe, store.metaSnapshotOf);
  const draft = useComposerDraft(params.draftKey);
  const { controller } = store;
  const cwd = meta.run.workingDirectory;
  const host = useModelPickerHost(params.environmentId, cwd);
  const agents = (host.agents ?? meta.runOptions.agents ?? []).filter(
    (agent) =>
      isPickerProvider(agent.id) && !controller.policy.providerDenial(agent.id),
  );
  const defaults = solus.personal.runSettings();
  const groups = agents.map((agent) => {
    const group = solusModelGroup(
      agent,
      defaults,
      agentProjectInstance(agent, cwd),
    );
    return {
      ...group,
      statusNotice: agent.unavailableReason ?? host.providerNotice(agent.id),
      models:
        agent.available === false
          ? []
          : group.models.filter(
              (model) =>
                !controller.policy.modelDenial(agent.id, model.selection.model),
            ),
    };
  });
  const selected = groups
    .flatMap((group) => group.models)
    .find(
      (m) =>
        m.selection.instanceId === modelInstanceId(meta.run.provider) &&
        (meta.run.model ? meta.run.model === m.selection.model : m.isDefault),
    );
  const selectedOptions = runOptionSelections(meta.run);
  const runtimeMode = toRuntimeMode(meta.run.permissionMode);
  return (
    <ThreadSettingsPickerScreen
      environmentId={params.environmentId}
      projectId={ProjectId.make(cwd)}
      cwd={cwd}
      providerInstanceId={modelInstanceId(meta.run.provider)}
      pickerHost={{
        ...host,
        runtimeDenial: (mode, selection) => {
          const agent = agents.find(
            (entry) => modelInstanceId(entry.id) === selection?.instanceId,
          );
          if (!controller.mayDrive) return "You cannot change this session.";
          if (agent?.capabilities?.permissions === false)
            return "This provider controls its own permissions.";
          return controller.policy.modeDenial(permissionModes[mode])?.message;
        },
      }}
      providerGroups={groups}
      selectedModel={
        selected ? { ...selected.selection, options: selectedOptions } : null
      }
      prompt={draft.text}
      onPromptChange={(value) => setComposerDraftText(params.draftKey, value)}
      runtimeMode={runtimeMode}
      onUpdateRuntimeMode={(mode) => {
        if (
          controller.mayDrive &&
          controller.updateRun({ permissionMode: permissionModes[mode] })
        )
          return true;
        Alert.alert(
          "Could not change runtime mode",
          controller.policy.modeDenial(permissionModes[mode])?.message,
        );
        return false;
      }}
      optionDescriptors={resolveProviderOptionDescriptors({
        capabilities: selected?.capabilities,
        selections: selectedOptions,
      })}
      onUpdateOptionSelections={(options) => {
        if (selected && controller.mayDrive)
          controller.updateRun(pickerRunOptions(selected, options));
      }}
      onSelectModel={(option) => {
        const id =
          option.selection.instanceId === "claudeAgent"
            ? "claude-code"
            : option.selection.instanceId;
        const agent = agents.find((candidate) => candidate.id === id);
        if (controller.mayDrive && agent && agent.id !== "opencode") {
          controller.pickProvider(agent.id);
          controller.updateRun({
            model: option.selection.model,
            ...pickerRunOptions(option, option.selection.options ?? []),
          });
        }
      }}
      onClose={() => navigation.goBack()}
    />
  );
}
