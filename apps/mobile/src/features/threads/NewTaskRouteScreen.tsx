// Adapted from T3 Code apps/mobile/src/features/threads/NewTaskRouteScreen.tsx and
// NewTaskDraftScreen.tsx (MIT, see UPSTREAM.md).
import {
  CommonActions,
  StackActions,
  useNavigation,
} from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { isChat, NEW_CHAT_DIRECTORY } from "@solus/contracts/chat";
import { hostPathBaseName } from "@solus/contracts/host-path";
import type { PermissionMode } from "@solus/contracts/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, View } from "react-native";
import {
  KeyboardController,
  KeyboardStickyView,
} from "react-native-keyboard-controller";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApp, useListened } from "../../app/app-context";
import { AppText as Text } from "../../components/AppText";
import { type ComposerEditorHandle } from "../../components/ComposerEditor";
import { ComposerInlineControl } from "../../components/ComposerToolbar";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { MaterialScreenContent } from "../../components/MaterialScreenContent";
import { NewTaskProjectScreen } from "./NewTaskProjectScreen";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { ScreenHeader } from "../../components/ScreenHeader";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import type { RootStackParamList, ScreenProps } from "../../navigation/routes";
import {
  type ConversationMeta,
  type ConversationStore,
} from "../conversation/conversation-store";
import {
  LEAD_SYMBOL,
  LeadSessionChoice,
} from "../conversation/lib/lead-session";
import {
  offersPlanToggle,
  PERMISSION_MODE_ICON,
  PERMISSION_MODE_TEXT,
} from "../conversation/lib/run-settings";
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
import { COMPOSER_LAYOUT_TRANSITION, ThreadComposer } from "./ThreadComposer";
import { NewTaskConnectHost, useNewTaskHostGate } from "./NewTaskConnectHost";

type Navigation = NativeStackNavigationProp<RootStackParamList>;

/** The new-task sheet: choose a project, then write the first prompt. */
export function NewTaskRouteScreen({ route }: ScreenProps<"NewTask">) {
  const app = useApp();
  const navigation = useNavigation<Navigation>();
  const hostGate = useNewTaskHostGate();
  const hostId = route.params?.hostId;
  const projectPath = route.params?.projectPath;
  const hostChoice = route.params?.hostChoice;
  const balanceRequest = route.params?.balanceRequest;
  // No host can run a task, so there is no composer: ask for a host, and keep
  // the draft's text until one connects (docs/plans/draft-connect-host.md).
  if (hostGate === "connect") {
    return (
      <NewTaskConnectHost
        draftText={
          hostId && projectPath
            ? app.draft(hostId, `new-task:${projectPath}`).trim()
            : ""
        }
        onClose={() => closeNewTaskSheet(navigation)}
      />
    );
  }
  if (hostId && projectPath) {
    // The host picker opens another draft by changing these params.
    return (
      <NewTaskDraftScreen
        key={`${hostId}\n${projectPath}`}
        hostId={hostId}
        projectPath={projectPath}
        hostChoice={hostChoice}
        balanceRequest={balanceRequest}
      />
    );
  }
  return <NewTaskProjectScreen preferredHostId={hostId ?? null} />;
}

/** Leave the whole new-task sheet, however many of its screens are stacked. */
function closeNewTaskSheet(navigation: Navigation) {
  const state = navigation.getState();
  const firstNewTask =
    state?.routes.findIndex((candidate) => candidate.name === "NewTask") ?? -1;
  if (state && firstNewTask > 0) {
    navigation.dispatch(StackActions.pop(state.routes.length - firstNewTask));
    return;
  }
  navigation.goBack();
}

/* ─── Draft ───────────────────────────────────────────────────────────── */

/**
 * The new session this draft starts, made when the draft opens so picked
 * files can upload to its host before the first prompt; the host learns of
 * the session with that prompt. Leaving without starting closes it.
 */
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

function NewTaskDraftScreen(props: {
  readonly hostId: string;
  readonly projectPath: string;
  readonly hostChoice: NewTaskHostChoice | undefined;
  readonly balanceRequest: number | undefined;
}) {
  const app = useApp();
  const chat = isChat(props.projectPath);
  const [sessionId] = useState(() => app.newSessionId());
  // A chat runs in its own folder; the host names it from the new session.
  const workingDirectory = chat ? NEW_CHAT_DIRECTORY : props.projectPath;
  const { store, startedRef } = useDraftConversation(
    props.hostId,
    sessionId,
    workingDirectory,
  );
  if (!store) {
    return (
      <View className="flex-1 items-center justify-center bg-sheet">
        <ActivityIndicator colorClassName="accent-icon-muted" />
      </View>
    );
  }
  return (
    <NewTaskDraftContent
      key={sessionId}
      store={store}
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

/**
 * A shortcut into the Solus permission modes: Plan, and back to the mode the
 * run had before it. It shows only where the agent offers Plan.
 */
function PlanModeToggle(props: {
  readonly disabled: boolean;
  readonly meta: ConversationMeta;
  readonly store: ConversationStore;
}) {
  const mode = props.meta.run.permissionMode;
  const planMode = mode === "plan";
  // Leaving Plan returns to the mode before it: the person's default to start.
  // Kept in state and updated during render, so React re-renders at once.
  const [otherMode, setOtherMode] = useState<PermissionMode>(
    planMode ? "supervised" : mode,
  );
  if (!planMode && otherMode !== mode) setOtherMode(mode);
  if (!offersPlanToggle(props.meta.runOptions.capabilities)) return null;
  return (
    <ComposerInlineControl
      accessibilityHint={`Switches to ${planMode ? PERMISSION_MODE_TEXT[otherMode].label : "Plan"}`}
      accessibilityLabel={`Permission mode: ${PERMISSION_MODE_TEXT[mode].label}`}
      disabled={props.disabled}
      emphasized
      icon={PERMISSION_MODE_ICON[mode]}
      label={PERMISSION_MODE_TEXT[mode].label}
      onPress={() =>
        props.store.controller.updateRun({
          permissionMode: planMode ? otherMode : "plan",
        })
      }
      showChevron={false}
    />
  );
}

/**
 * Meta mode: makes the new session a lead, which plans the work, starts
 * other sessions to do it, and reports back. The choice goes with the first
 * prompt and is fixed after it. Selected, the control fills, as every selected
 * inline control does.
 */
function LeadToggle(props: {
  readonly disabled: boolean;
  readonly meta: ConversationMeta;
  readonly store: ConversationStore;
}) {
  const app = useApp();
  const [choice] = useState(() => new LeadSessionChoice());
  const toggle = () => {
    // An empty change keeps the new run inside what the agent offers and shows it.
    if (
      choice.choose(
        props.store.controller.run,
        !props.meta.lead,
        app.personal.current().leadModel,
        app.personal.runSettings(),
      )
    ) {
      props.store.controller.updateRun({});
    }
  };
  return (
    <ComposerInlineControl
      accessibilityHint="Plans the work, starts other sessions to do it, and reports back. It does not do the work itself. Fixed once the session starts."
      accessibilityLabel="Meta mode: plan the work and start other sessions to do it"
      disabled={props.disabled}
      icon={LEAD_SYMBOL}
      label="Meta mode"
      onPress={toggle}
      selected={props.meta.lead}
      showChevron={false}
    />
  );
}

function NewTaskDraftContent(props: {
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
  const insets = useSafeAreaInsets();
  const meta = useListened(store.meta, store.metaSnapshotOf);
  const hosts = useListened(app.registry.changes, app.registry.hosts);
  const connected = useListened(
    app.connections.changes,
    () => app.connections.state(props.hostId)?.readiness === "ready",
  );
  const controlsBottomPadding = Math.max(insets.bottom, 10);
  const keyboardOpenedOffset = Math.max(0, controlsBottomPadding - 8);
  const promptInputRef = useRef<ComposerEditorHandle>(null);
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
          setParams: (params) => navigation.setParams(params),
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
    closeNewTaskSheet(navigation);
  };
  const chooseProject = () => {
    if (isComposerInteractionLocked) {
      return;
    }
    promptInputRef.current?.blur();
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
        StackActions.push("NewTask", { hostId: props.hostId }),
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
    const state = navigation.getState();
    const firstNewTask = state.routes.findIndex(
      (candidate) => candidate.name === "NewTask",
    );
    const base = firstNewTask >= 0 ? state.routes.slice(0, firstNewTask) : [];
    navigation.dispatch(
      CommonActions.reset({
        index: base.length,
        routes: [
          ...base.map((candidate) => ({
            name: candidate.name,
            params: candidate.params,
          })),
          {
            name: "Thread",
            params: { hostId: props.hostId, sessionId: props.sessionId },
          },
        ],
      }),
    );
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
  const heroViewport = (
    <View className="flex-1" collapsable={false}>
      {/* The native-marked scroll view: UIKit insets the hero under the glass
          header, whose height differs between an iPhone sheet and an iPad
          column, and keeps the header clear at rest. */}
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="grow items-center justify-center pb-[236px] pt-12"
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

  const composerDock = (
    <View className="bg-sheet" style={{ paddingBottom: controlsBottomPadding }}>
      <View className="flex-row items-center px-4">
        <PlanModeToggle
          disabled={isComposerInteractionLocked}
          meta={meta}
          store={store}
        />
        {props.chat ? null : (
          <LeadToggle
            disabled={isComposerInteractionLocked}
            meta={meta}
            store={store}
          />
        )}
      </View>
      <ThreadComposer
        store={store}
        meta={meta}
        draftKey={draftKey}
        placeholder="Ask anything…"
        connected={connected}
        disabled={isComposerInteractionLocked}
        sendBlockedReason={
          meta.phase.kind === "ready" ? null : "Connecting to host"
        }
        canStopThread={false}
        onStopThread={() => undefined}
        editorRef={promptInputRef}
        onDraftChange={setPrompt}
        onSent={handleStarted}
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
                disabled: !connected,
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

  if (Platform.OS === "android") {
    return (
      <View className="flex-1 bg-sheet" collapsable={false}>
        <NativeStackScreenOptions options={{ headerShown: false }} />
        {draftHeader}
        <MaterialScreenContent>
          {heroViewport}

          <KeyboardStickyView
            style={{ position: "absolute", bottom: 0, left: 0, right: 0 }}
            offset={{ closed: 0, opened: keyboardOpenedOffset }}
          >
            {composerDock}
          </KeyboardStickyView>
        </MaterialScreenContent>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-sheet" collapsable={false}>
      {draftHeader}

      {heroViewport}
      <KeyboardStickyView
        pointerEvents="box-none"
        style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0 }}
        offset={{ closed: 0, opened: keyboardOpenedOffset }}
      >
        <Animated.View
          layout={COMPOSER_LAYOUT_TRANSITION}
          pointerEvents="box-none"
          style={{ position: "absolute", bottom: 0, left: 0, right: 0 }}
        >
          {composerDock}
        </Animated.View>
      </KeyboardStickyView>
    </View>
  );
}
