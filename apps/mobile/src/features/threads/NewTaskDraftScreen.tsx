// Adapted from T3 Code apps/mobile/src/features/threads/NewTaskRouteScreen.tsx and
// NewTaskDraftScreen.tsx (MIT, see UPSTREAM.md).
import { StackActions, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { isChat, NEW_CHAT_DIRECTORY } from "@solus/contracts/chat";
import { hostPathBaseName } from "@solus/contracts/host-path";
import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, useWindowDimensions, View } from "react-native";
import { KeyboardController } from "react-native-keyboard-controller";

import { useApp, useListened } from "../../app/app-context";
import { AppText as Text } from "../../components/AppText";
import { LoadingScreen } from "../../components/LoadingScreen";
import { ComposerInlineControl } from "../../components/ComposerToolbar";
import { SymbolView } from "../../components/AppSymbol";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { ScreenHeader } from "../../components/ScreenHeader";
import type { RootStackParamList } from "../../navigation/routes";
import {
  conversationIdOf,
  type ConversationMeta,
  type ConversationStore,
} from "../conversation/conversation-store";
import { rememberNewThreadTarget } from "./new-thread-targets";
import {
  hostMachineKind,
  useNewTaskEnvironments,
} from "./NewTaskContextPickerScreens";
import {
  newTaskHostLabel,
  settleNewTaskBalance,
  shouldBalanceNewTask,
} from "./lib/new-task-balance-candidates";
import {
  useNewTaskBalance,
  useNewTaskBalanceCandidates,
  type NewTaskHostChoice,
} from "./new-task-balance";
import { ThreadScreenBinding, ThreadScreenFallback } from "./ThreadScreenHost";
import { deriveLayout } from "../../lib/layout";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { threadKey } from "./thread-directory";
import { submittedThreadParams } from "./thread-route-state";
import { defaultWorktreeBase } from "./lib/worktree-branches";
import { useWorktreeBranches } from "./use-worktree-branches";

type Navigation = NativeStackNavigationProp<RootStackParamList>;

function useDraftConversation(
  hostId: string,
  sessionId: string,
  workingDirectory: string | null,
) {
  const app = useApp();
  const startedRef = useRef(false);
  const store = useMemo(
    () =>
      workingDirectory === null
        ? null
        : app.conversation(hostId, {
            newSession: {
              sessionId,
              provider: "claude-code",
              workingDirectory,
            },
          }),
    [app, hostId, sessionId, workingDirectory],
  );
  useEffect(
    () => () => {
      if (store && !startedRef.current) app.closeConversation(store);
    },
    [app, store],
  );
  return { store, startedRef };
}

export function NewTaskDraftScreen(props: {
  readonly sessionId: string;
  readonly taskId?: string;
  readonly taskHostId?: string;
  readonly hostId: string;
  readonly projectPath: string;
  readonly hostChoice: NewTaskHostChoice | undefined;
  readonly balanceRequest: number | undefined;
}) {
  const chat = isChat(props.projectPath);
  const sessionId = props.sessionId;
  // A chat runs in its own folder; the host names it from the new session.
  const workingDirectory = chat ? NEW_CHAT_DIRECTORY : props.projectPath;
  const { store, startedRef } = useDraftConversation(
    props.hostId,
    sessionId,
    workingDirectory,
  );
  useEffect(() => { if (store && props.taskId && props.taskHostId) store.controller.bindTask(props.taskId, props.taskHostId); }, [store, props.taskId, props.taskHostId]);
  if (!store) {
    return (
      <ThreadScreenFallback><LoadingScreen message="Connecting to host" /></ThreadScreenFallback>
    );
  }
  return (
    <NewTaskDraftContent
      key={sessionId}
      store={store}
      taskId={props.taskId}
      taskHostId={props.taskHostId}
      sessionId={sessionId}
      hostId={props.hostId}
      projectPath={props.projectPath}
      hostChoice={props.hostChoice}
      balanceRequest={props.balanceRequest}
      chat={chat}
      onStarted={() => {
        startedRef.current = true;
      }}
    />
  );
}

/** T3's folder for the project's checkout, with a branch mark for a worktree, new or existing. */
function NewTaskWorkspaceIcon(props: { readonly worktree: boolean; readonly size: number }) {
  const folder = <SymbolView name="folder" size={props.size} tintColorClassName="accent-icon-muted" type="monochrome" />;
  if (!props.worktree) return folder;
  const boxSize = (14 * props.size) / 16;
  return (
    <View
      className="size-4"
      style={Platform.OS === "android" ? { width: boxSize, height: boxSize } : undefined}
    >
      {folder}
      <View
        className="absolute -right-1 -bottom-1"
        style={Platform.OS === "android" ? { right: -boxSize / 4, bottom: -boxSize / 4 } : undefined}
      >
        <SymbolView
          name="arrow.triangle.branch"
          size={Math.round((9 * props.size) / 16)}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
      </View>
    </View>
  );
}

/**
 * Where the new session works, above the composer as in T3: the project's
 * checkout or a new worktree, and a branch, the checkout's or the worktree's
 * base. Only for a project in git; the other run options are in the model picker.
 */
function NewTaskWorkspaceControls(props: {
  readonly disabled: boolean;
  readonly hostReady: boolean;
  readonly meta: ConversationMeta;
  readonly store: ConversationStore;
  readonly onChooseBranch: () => void;
}) {
  const offered = props.meta.runOptions.canChooseStart;
  const branchState = useWorktreeBranches(props.store, offered && props.hostReady);
  const branches = branchState?.branches;
  const baseBranch = props.meta.run.worktreeBaseBranch;
  const checkoutBranch = props.meta.run.checkoutBranch ?? branchState?.currentBranch ?? null;
  // Kept, disabled, while the host reconnects, so a chosen worktree stays in sight.
  if (!offered || !branches?.length) return null;
  const disabled = props.disabled || !props.hostReady;
  const newWorktree = baseBranch !== null;
  const inWorktree = props.meta.run.checkoutWorktree !== null;
  const workspaceLabel = newWorktree ? "New worktree" : inWorktree ? "Current worktree" : "Current checkout";
  const branchLabel = (newWorktree ? baseBranch : checkoutBranch) ?? "Choose a branch";
  return (
    <View className="flex-row items-center gap-1 px-2">
      <ComposerInlineControl
        accessibilityHint={newWorktree ? "Switches to the current checkout" : "Switches to a new worktree"}
        accessibilityLabel={workspaceLabel}
        disabled={disabled}
        renderIcon={(size) => <NewTaskWorkspaceIcon worktree={newWorktree || inWorktree} size={size} />}
        label={workspaceLabel}
        maxWidth="100%"
        onPress={() => props.store.controller.chooseWorktreeBase(newWorktree ? null : defaultWorktreeBase(branches, checkoutBranch))}
        showChevron={false}
      />
      <View className="min-w-0 shrink">
        <ComposerInlineControl
          accessibilityLabel={`${newWorktree ? "Base branch" : "Branch"}: ${branchLabel}`}
          chevronDirection="right"
          disabled={disabled}
          icon="arrow.triangle.branch"
          label={branchLabel}
          maxWidth="100%"
          onPress={props.onChooseBranch}
        />
      </View>
    </View>
  );
}

function NewTaskDraftContent(props: {
  readonly taskId?: string;
  readonly taskHostId?: string;
  readonly store: ConversationStore;
  readonly sessionId: string;
  readonly hostId: string;
  readonly projectPath: string;
  readonly hostChoice: NewTaskHostChoice | undefined;
  readonly balanceRequest: number | undefined;
  readonly chat: boolean;
  readonly onStarted: () => void;
}) {
  const app = useApp();
  const { store } = props;
  const navigation = useNavigation<Navigation>();
  const layout = deriveLayout(useWindowDimensions());
  const hostReadiness = useListened(app.connections.changes, () => app.connections.readiness(props.hostId));
  const meta = useListened(store.meta, store.metaSnapshotOf);
  const hosts = useListened(app.registry.changes, app.registry.hosts);
  const draftKey = `new-task:${props.projectPath}`;
  const [prompt, setPrompt] = useState(() => app.draft(props.hostId, draftKey));
  const submitting = meta.phase.kind !== "ready";

  const host = hosts.find((candidate) => candidate.id === props.hostId);
  const { scope, environments } = useNewTaskEnvironments(
    props.hostId,
    props.projectPath,
  );
  const balanceCandidates = useNewTaskBalanceCandidates(
    environments,
    meta.run.provider,
  );
  const [startedEmpty] = useState(() => prompt.trim() === "");
  const balanceState = useNewTaskBalance({
    shouldCheck: shouldBalanceNewTask({
      balanceRequest: props.balanceRequest,
      hostChoice: props.hostChoice,
      startedEmpty,
    }),
    request: props.balanceRequest,
    candidates: balanceCandidates,
    read: (hostId) => {
      const connection = app.connections.connection(hostId);
      return connection
        ? connection.api.hostResources()
        : Promise.reject(new Error("Not connected"));
    },
    onChosen: (choice) => {
      return settleNewTaskBalance(
        choice,
        {
          hostId: props.hostId,
          draftKey,
          text: prompt,
          attachments: meta.attachments.length + meta.uploading,
          submitting,
          requested: props.balanceRequest !== undefined,
        },
        {
          saveDraft: (hostId, key, text) => app.saveDraft(hostId, key, text),
          setParams: (params) => navigation.setParams({
            hostId: params.hostId ?? props.hostId,
            draft: {
              projectPath: props.projectPath,
              taskId: props.taskId,
              taskHostId: props.taskHostId,
              ...params,
            },
          }),
        },
      );
    },
  });
  const selectedEnvironmentLabel = newTaskHostLabel(balanceState, host?.label);
  const projectTitle =
    scope?.title ?? (hostPathBaseName(props.projectPath) || "project");
  const isComposerInteractionLocked = submitting;

  const closeNewTask = () => {
    void KeyboardController.dismiss({ animated: true });
    navigation.goBack();
  };
  const chooseProject = () => {
    if (isComposerInteractionLocked) {
      return;
    }
    void KeyboardController.dismiss({ animated: true });
    const state = navigation.getState();
    const previous = state?.routes[state.index - 1];
    // Came from the project list: go back to it rather than stacking another.
    // SAFETY: a route named NewTask carries RootStackParamList's NewTask parameters.
    const previousParams =
      previous?.name === "NewTask"
        ? (previous.params as RootStackParamList["NewTask"])
        : null;
    if (previous?.name === "NewTask" && !previousParams?.projectPath)
      navigation.goBack();
    else
      navigation.dispatch(
        StackActions.push("NewTask", { hostId: props.hostId, taskId: props.taskId, taskHostId: props.taskHostId }),
      );
  };
  const openEnvironmentPicker = () => {
    // The picker moves the saved draft text, so save it now.
    app.saveDraft(props.hostId, draftKey, prompt);
    void KeyboardController.dismiss({ animated: true });
    navigation.navigate("NewTaskEnvironment", {
      hostId: props.hostId,
      projectPath: props.projectPath,
      hostChoice: props.hostChoice,
    });
  };

  const handleStarted = () => {
    props.onStarted();
    rememberNewThreadTarget(props.hostId, {
      sessionId: props.sessionId,
      provider: store.controller.run.provider,
      workingDirectory: store.controller.run.workingDirectory,
    });
    navigation.setParams(submittedThreadParams(props.hostId, props.sessionId));
  };

  const environmentControl = environments.some((environment) => environment.hostId !== props.hostId) ? (
    <ComposerInlineControl
      accessibilityLabel={`Host: ${selectedEnvironmentLabel}`}
      chevronDirection="right"
      disabled={isComposerInteractionLocked}
      renderIcon={(size) => (
        <EnvironmentMachineSymbol
          kind={hostMachineKind(host?.os)}
          size={size}
          tintColorClassName="accent-icon-muted"
        />
      )}
      label={`on ${selectedEnvironmentLabel}`}
      maxWidth={props.chat ? 170 : 260}
      onPress={openEnvironmentPicker}
      showChevron
    />
  ) : null;
  // A task without a project has no project to name, so it asks plainly and
  // puts the project picker beside the machine as a control.
  const hero = props.chat ? (
    <View className="items-center gap-2 px-6" testID="new-task-hero">
      <Text className="text-center text-2xl font-t3-medium tracking-tight text-foreground">
        What should we work on?
      </Text>
      <View className="flex-row flex-wrap items-center justify-center gap-x-1">
        <ComposerInlineControl
          accessibilityHint="Opens the project picker"
          accessibilityLabel="Choose a project"
          chevronDirection="right"
          disabled={isComposerInteractionLocked}
          icon="folder"
          label="Choose a project"
          onPress={chooseProject}
        />
        {environmentControl}
      </View>
    </View>
  ) : (
    <View className="items-center gap-6 px-6" testID="new-task-hero">
      <View className="w-full items-center gap-1.5">
        <Text className="text-center text-2xl font-t3-medium tracking-tight text-foreground">
          What should we build
        </Text>
        <View className="max-w-full flex-row items-center justify-center">
          <Text className="text-2xl font-t3-medium tracking-tight text-foreground">
            in{" "}
          </Text>
          <Pressable
            accessibilityHint="Opens the project picker"
            accessibilityLabel={projectTitle}
            accessibilityRole="button"
            disabled={isComposerInteractionLocked}
            onPress={chooseProject}
            className="min-w-0 max-w-[250px] border-b border-foreground-muted active:opacity-65"
          >
            <Text
              className="text-2xl font-t3-medium tracking-tight text-foreground"
              numberOfLines={1}
            >
              {projectTitle}
            </Text>
          </Pressable>
          <Text className="text-2xl font-t3-medium tracking-tight text-foreground">
            ?
          </Text>
        </View>
      </View>

      {environmentControl}
    </View>
  );
  const heroViewport = (composerDockHeight: number) => (
    <View className="flex-1" collapsable={false}>
      {/* The native-marked scroll view: UIKit insets the hero under the glass
          header, whose height differs between an iPhone sheet and an iPad
          column, and keeps the header clear at rest. */}
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="grow items-center justify-center pt-12"
        contentContainerStyle={{ paddingBottom: composerDockHeight + 16 }}
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        style={{ flex: 1 }}
        testID="new-task-hero-scroll"
      >
        {hero}
      </ScreenScrollView>
    </View>
  );

  const openBranchPicker = () => {
    if (isComposerInteractionLocked) return;
    void KeyboardController.dismiss({ animated: true });
    navigation.navigate("NewTaskBranch", { hostId: props.hostId, conversationId: conversationIdOf(store) });
  };
  const draftControls = (
    <View className="pb-1">
      <NewTaskWorkspaceControls
        disabled={isComposerInteractionLocked}
        hostReady={hostReadiness.readiness === "ready"}
        meta={meta}
        store={store}
        onChooseBranch={openBranchPicker}
      />
    </View>
  );

  const draftHeader = (
    <ScreenHeader
      title="New session"
      sidebar={false}
      onBack={closeNewTask}
      hideBottomBorder
      options={{
        headerSearchBarOptions: undefined,
        unstable_headerToolbarItems: () => [],
        unstable_headerLeftItems: () => [],
        unstable_navigationItemStyle: "editor",
      }}
      groupActions
      actions={
        props.chat
          ? []
          : [
              {
                accessibilityLabel: "Open files",
                icon: "folder",
                disabled: hostReadiness.readiness !== "ready",
                onPress: () =>
                  navigation.navigate("Files", {
                    hostId: props.hostId,
                    projectPath: props.projectPath,
                    folderPath: "",
                  }),
              },
            ]
      }
    />
  );

  return (
    <ThreadScreenBinding
      header={draftHeader}
      store={store}
      meta={meta}
      threadKey={threadKey(props.hostId, props.sessionId)}
      draftKey={draftKey}
      contentPresentation={{ kind: "ready" }}
      hostLabel={host?.label ?? null}
      hostReadiness={hostReadiness}
      layoutVariant={layout.variant}
      usesAutomaticContentInsets={NATIVE_LIQUID_GLASS_SUPPORTED}
      draftMode={{ content: heroViewport, controls: draftControls, onDraftChange: setPrompt, onSent: handleStarted }}
    />
  );
}
