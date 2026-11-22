import { useSyncExternalStore } from "react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { ProviderInstanceId, ProjectId, type RuntimeMode } from "@t3tools/contracts";
import type { ConversationStore } from "@solus-mobile/features/conversation/conversation-store";
import {
  ThreadSettingsPickerScreen,
  type ExistingThreadSettingsRouteParams,
} from "../features/threads/ThreadSettingsSheet";
import { useComposerDraft, setComposerDraftText } from "../state/use-composer-drafts";
import { EmptyState } from "../components/ui/EmptyState";
import { toRuntimeMode } from "./session";
import { solus } from "./runtime";

const permissionModes = {
  "approval-required": "supervised",
  "auto-accept-edits": "accept-edits",
  auto: "auto",
  "full-access": "full-access",
} as const;
export function SolusThreadSettings({
  route,
}: StaticScreenProps<ExistingThreadSettingsRouteParams>) {
  const store = solus.openConversation(route.params.environmentId, route.params.threadId);
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
  const agents = (meta.runOptions.agents ?? []).filter(
    (agent) =>
      agent.available !== false &&
      agent.id !== "opencode" &&
      (__DEV__ || agent.id !== "replay") &&
      !controller.policy.providerDenial(agent.id),
  );
  const groups = agents.map((agent) => {
    const instanceId = ProviderInstanceId.make(
      agent.id === "claude-code" ? "claudeAgent" : agent.id,
    );
    return {
      providerKey: instanceId,
      providerLabel: agent.label,
      models: agent.models
        .filter((model) => !controller.policy.modelDenial(agent.id, model.id))
        .map((model) => ({
          key: JSON.stringify([instanceId, model.id]),
          label: model.label,
          subtitle: agent.label,
          providerKey: instanceId,
          providerLabel: agent.label,
          providerDriver: instanceId,
          isDefault: agent.defaultModel === model.id,
          isLegacy: false,
          capabilities: null,
          selection: { instanceId, model: model.id },
        })),
    };
  });
  const selected = groups
    .flatMap((group) => group.models)
    .find(
      (m) =>
        m.selection.instanceId ===
          (meta.run.provider === "claude-code" ? "claudeAgent" : meta.run.provider) &&
        (meta.run.model ? meta.run.model === m.selection.model : m.isDefault),
    );
  const runtimeMode = toRuntimeMode(meta.run.permissionMode);
  return (
    <ThreadSettingsPickerScreen
      environmentId={params.environmentId}
      projectId={ProjectId.make(controller.run.workingDirectory)}
      cwd={controller.run.workingDirectory}
      providerGroups={groups}
      selectedModel={selected?.selection ?? null}
      prompt={draft.text}
      onPromptChange={(value) => setComposerDraftText(params.draftKey, value)}
      runtimeMode={runtimeMode}
      onUpdateRuntimeMode={(mode) => {
        if (controller.mayDrive) controller.updateRun({ permissionMode: permissionModes[mode] });
      }}
      optionDescriptors={[]}
      onUpdateOptionSelections={() => {}}
      onSelectModel={(option) => {
        const id =
          option.selection.instanceId === "claudeAgent"
            ? "claude-code"
            : option.selection.instanceId;
        const agent = agents.find((candidate) => candidate.id === id);
        if (controller.mayDrive && agent && agent.id !== "opencode") {
          controller.pickProvider(agent.id);
          controller.updateRun({ model: option.selection.model });
        }
      }}
      onClose={() => navigation.goBack()}
    />
  );
}
