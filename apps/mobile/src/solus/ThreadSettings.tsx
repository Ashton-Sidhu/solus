import { agentProjectInstance } from "@solus/contracts/provider-instance-models";
import { isTaskFolderPath } from "@solus/contracts/codebases";
import { useSyncExternalStore } from "react";
import {
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { Alert } from "react-native";
import { ProjectId } from "@t3tools/contracts";
import { selectModel } from "@solus-mobile/features/conversation/lib/run-settings";
import type { ModelOption } from "../lib/modelOptions";
import { scopedThreadKey } from "../lib/scopedEntities";
import { isQueuedEditDraftKey } from "../state/queued-edit-draft-key";
import { activeComposerDraftKey, selectQueuedRunModel, useQueuedRunEdit } from "../state/queued-run-edit";
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
  const threadKey = scopedThreadKey(params.environmentId, params.threadId);
  const edit = useQueuedRunEdit(threadKey);
  const editingQueue = isQueuedEditDraftKey(params.draftKey);
  const activeEdit = editingQueue && activeComposerDraftKey(threadKey, params.draftKey, edit) === params.draftKey
    ? edit : null;
  const queuedModel = activeEdit?.hostModelSelection ?? activeEdit?.hostInitialModel;
  const provider = queuedModel?.provider ?? meta.run.provider;
  const modelId = queuedModel ? queuedModel.modelConfig.modelId : meta.run.model;
  const draft = useComposerDraft(params.draftKey);
  const { controller } = store;
  // The project folder names the provider settings. The path of a task folder names no project (docs/plans/codebases.md §7).
  const cwd = isTaskFolderPath(meta.run.workingDirectory)
    ? meta.run.projectRoot
    : meta.run.workingDirectory;
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
        m.selection.instanceId === modelInstanceId(provider) &&
        (modelId ? modelId === m.selection.model : m.isDefault),
    );
  const selectedOptions = runOptionSelections(queuedModel?.modelConfig ?? meta.run);
  const runtimeMode = toRuntimeMode(meta.run.permissionMode);
  const pickQueuedModel = (option: ModelOption, options: Parameters<typeof pickerRunOptions>[1]) => {
    if (!activeEdit || !controller.mayDrive) return;
    const agent = agents.find((candidate) => modelInstanceId(candidate.id) === option.selection.instanceId);
    if (!agent || controller.policy.modelDenial(agent.id, option.selection.model)) return;
    const sameModel = provider === agent.id && selected?.selection.model === option.selection.model;
    const defaultsForModel = selectModel(agent.id, option.selection.model, defaults, agent);
    const current = sameModel ? (queuedModel?.modelConfig ?? meta.run) : defaultsForModel;
    selectQueuedRunModel(threadKey, params.draftKey, {
      provider: agent.id,
      modelConfig: {
        modelId: option.selection.model,
        reasoningEffort: current.reasoningEffort,
        contextWindow: sameModel && queuedModel ? queuedModel.modelConfig.contextWindow : defaultsForModel.contextWindow,
        fastMode: current.fastMode,
        ...pickerRunOptions(option, options),
      },
    });
  };

  return (
    <ThreadSettingsPickerScreen
      environmentId={params.environmentId}
      projectId={ProjectId.make(cwd)}
      cwd={cwd}
      providerInstanceId={modelInstanceId(provider)}
      pickerHost={{
        ...host,
        runtimeDenial: (mode, selection) => {
          const agent = agents.find(
            (entry) => modelInstanceId(entry.id) === selection?.instanceId,
          );
          if (editingQueue) return "Runtime mode belongs to the session.";
          if (!controller.mayDrive) return "You cannot change this session.";
          if (agent?.capabilities?.permissions === false)
            return "This provider controls its own permissions.";
          return controller.policy.modeDenial(permissionModes[mode])?.message;
        },
      }}
      providerGroups={groups}
      isolateModelOptions={editingQueue}
      selectedModel={
        selected ? { ...selected.selection, options: selectedOptions } : null
      }
      prompt={draft.text}
      onPromptChange={(value) => {
        if (!editingQueue || activeEdit) setComposerDraftText(params.draftKey, value);
      }}
      runtimeMode={runtimeMode}
      onUpdateRuntimeMode={(mode) => {
        if (editingQueue) return false;
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
        if (!selected || !controller.mayDrive) return;
        if (editingQueue) pickQueuedModel(selected, options);
        else controller.updateRun(pickerRunOptions(selected, options));
      }}
      onSelectModel={(option) => {
        if (editingQueue) {
          pickQueuedModel(option, option.selection.options ?? []);
          return;
        }
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
