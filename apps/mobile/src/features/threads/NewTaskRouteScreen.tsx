// Adapted from T3 Code apps/mobile/src/features/threads/NewTaskRouteScreen.tsx and
// NewTaskDraftScreen.tsx (MIT, see UPSTREAM.md).
import { CommonActions, StackActions, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { chatFolderIn, isChat, NEW_CHAT_DIRECTORY } from "@solus/contracts/chat";
import { MAX_ATTACHMENT_UPLOAD_COUNT } from "@solus/contracts/rpc";
import type { PermissionMode } from "@solus/contracts/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { KeyboardController, KeyboardStickyView } from "react-native-keyboard-controller";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApp, useListened } from "../../app/app-context";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ComposerAttachmentButton } from "../../components/ComposerAttachmentButton";
import { ComposerAttachmentStrip } from "../../components/ComposerAttachmentStrip";
import { useOpenHostFile } from "./MessageAttachments";
import { ComposerEditor, type ComposerEditorHandle } from "../../components/ComposerEditor";
import {
  ComposerActionButton,
  ComposerInlineControl,
  ComposerToolbarRow,
} from "../../components/ComposerToolbar";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { MaterialButton } from "../../components/MaterialButton";
import { MaterialListRow } from "../../components/MaterialListRow";
import { MaterialScreenContent } from "../../components/MaterialScreenContent";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { ScreenHeader } from "../../components/ScreenHeader";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { cn } from "../../lib/cn";
import { MOBILE_FONTS } from "../../lib/typography";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import type { RootStackParamList, ScreenProps } from "../../navigation/routes";
import type { ConversationMeta, ConversationStore } from "../conversation/conversation-store";
import type { PickedFile } from "../conversation/lib/attachments";
import { modelLabel, offersPlanToggle, PERMISSION_MODE_ICON, PERMISSION_MODE_TEXT } from "../conversation/lib/run-settings";
import { useKeyboardCommand } from "../keyboard/use-keyboard-command";
import { useProjectsFolder } from "../projects/use-open-project";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import { pickComposerFiles, pickComposerMedia } from "./composer-attachment-pickers";
import { rememberNewThreadTarget } from "./new-thread-targets";
import {
  filterProjectScopes,
  getProjectScopeSelectionTarget,
  groupProjectScopes,
  scopeOfProject,
  type ProjectScope,
} from "./new-task-project-selection";
import {
  hostMachineKind,
  NewTaskEnvironmentPicker,
  type NewTaskEnvironmentChoice,
} from "./NewTaskContextPickerScreens";
import { COMPOSER_LAYOUT_TRANSITION, ComposerSurface } from "./ThreadComposer";
import { ThreadSettingsSheet } from "./ThreadSettingsSheet";
import { NewTaskConnectHost, useNewTaskHostGate } from "./NewTaskConnectHost";

type Navigation = NativeStackNavigationProp<RootStackParamList>;

const DRAFT_SAVE_DELAY_MS = 400;

/** The new-task sheet: choose a project, then write the first prompt. */
export function NewTaskRouteScreen({ route }: ScreenProps<"NewTask">) {
  const app = useApp();
  const navigation = useNavigation<Navigation>();
  const hostGate = useNewTaskHostGate();
  const hostId = route.params?.hostId;
  const projectPath = route.params?.projectPath;
  // No host can run a task, so there is no composer: ask for a host, and keep
  // the draft's text until one connects (docs/plans/draft-connect-host.md).
  if (hostGate === "connect") {
    return (
      <NewTaskConnectHost
        draftText={hostId && projectPath ? app.draft(hostId, `new-task:${projectPath}`).trim() : ""}
        onClose={() => closeNewTaskSheet(navigation)}
      />
    );
  }
  if (hostId && projectPath) {
    return <NewTaskDraftScreen hostId={hostId} projectPath={projectPath} />;
  }
  return <NewTaskProjectScreen preferredHostId={hostId ?? null} />;
}

/** Leave the whole new-task sheet, however many of its screens are stacked. */
function closeNewTaskSheet(navigation: Navigation) {
  const state = navigation.getState();
  const firstNewTask = state?.routes.findIndex((candidate) => candidate.name === "NewTask") ?? -1;
  if (state && firstNewTask > 0) {
    navigation.dispatch(StackActions.pop(state.routes.length - firstNewTask));
    return;
  }
  navigation.goBack();
}

/* ─── Choose project ──────────────────────────────────────────────────── */

function NewTaskHeader(props: {
  readonly title: string;
  readonly canAddProject: boolean;
  readonly searchText: string;
  readonly onAddProject: () => void;
  readonly onSearchTextChange: (text: string) => void;
}) {
  const navigation = useNavigation<Navigation>();
  return (
    <ScreenHeader
      title={props.title}
      sidebar={false}
      backInSplitView={{
        accessibilityLabel: "Go back",
        icon: "chevron.left",
      }}
      hideBottomBorder
      onBack={() => navigation.goBack()}
      actions={
        props.canAddProject
          ? [
              {
                accessibilityLabel: "Add project",
                icon: "plus",
                onPress: props.onAddProject,
              },
            ]
          : []
      }
      search={{
        value: props.searchText,
        onChangeText: props.onSearchTextChange,
        placeholder: "Search projects",
      }}
    />
  );
}

function NewTaskProjectScreen(props: { readonly preferredHostId: string | null }) {
  const app = useApp();
  const navigation = useNavigation<Navigation>();
  const insets = useSafeAreaInsets();
  const [searchText, setSearchText] = useState("");
  const hosts = useListened(app.registry.changes, app.registry.hosts);
  const projects = useListened(app.threads.changes, app.threads.projects);
  const loading = useListened(app.threads.changes, app.threads.isLoading);
  const listScopes = useMemo(() => groupProjectScopes(projects), [projects]);
  const visibleScopes = filterProjectScopes(listScopes, searchText);
  const scratchHostId =
    hosts.find((host) => host.id === props.preferredHostId)?.id ?? hosts[0]?.id ?? null;
  const hasHosts = hosts.length > 0;

  // Projects come from every host this device knows.
  useEffect(() => {
    void app.threads.loadAll();
  }, [app]);

  const selectProject = (scope: ProjectScope) => {
    const target = getProjectScopeSelectionTarget(scope, props.preferredHostId);
    navigation.dispatch(
      StackActions.push("NewTask", { hostId: target.hostId, projectPath: target.project.path }),
    );
  };
  const startScratch = () => {
    if (!scratchHostId) return;
    navigation.dispatch(
      StackActions.push("NewTask", { hostId: scratchHostId, projectPath: NEW_CHAT_DIRECTORY }),
    );
  };
  const addProject = () => {
    if (scratchHostId) navigation.navigate("OpenProject", { hostId: scratchHostId });
  };
  const emptyState = !hasHosts
    ? { title: "No hosts connected", detail: "Add a host before creating a task.", loading: false }
    : loading
      ? { title: "Loading projects", detail: "Reading projects from your hosts.", loading: true }
      : {
          title: "No projects found",
          detail: "The connected hosts did not report any projects.",
          loading: false,
        };

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NewTaskHeader
        title="Choose project"
        canAddProject={hasHosts}
        searchText={searchText}
        onAddProject={addProject}
        onSearchTextChange={setSearchText}
      />

      <MaterialScreenContent>
        <ScreenScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          className="flex-1"
          contentContainerStyle={{
            gap: Platform.OS === "android" ? 8 : 12,
            paddingBottom: Math.max(insets.bottom, 18) + 18,
            paddingHorizontal: Platform.OS === "android" ? 16 : 20,
            paddingTop: Platform.OS === "android" ? 16 : 8,
            ...(Platform.OS === "android" && visibleScopes.length === 0
              ? { flexGrow: 1, justifyContent: "center" as const }
              : {}),
          }}
        >
          {scratchHostId !== null && listScopes.length > 0 ? (
            Platform.OS === "android" ? (
              <View collapsable={false} className="overflow-hidden rounded-[28px] bg-grouped-card">
                <MaterialListRow
                  className="bg-grouped-card"
                  title="No project"
                  subtitle="Start a task without a project"
                  onPress={startScratch}
                  leading={
                    <SymbolView
                      name="text.bubble"
                      size={22}
                      tintColorClassName="accent-icon-muted"
                      type="monochrome"
                    />
                  }
                />
              </View>
            ) : (
              <View collapsable={false} className="overflow-hidden rounded-[24px] bg-grouped-card">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="No project"
                  onPress={startScratch}
                  className="flex-row items-center gap-3 bg-grouped-card px-4 py-3.5"
                >
                  <View className="h-7 w-7 items-center justify-center">
                    <SymbolView
                      name="text.bubble"
                      size={18}
                      tintColorClassName="accent-icon-muted"
                      type="monochrome"
                    />
                  </View>
                  <View className="min-w-0 flex-1">
                    <Text className="text-base font-t3-bold leading-snug">No project</Text>
                    <Text className="text-xs leading-snug text-foreground-muted" numberOfLines={1}>
                      Start a task without a project
                    </Text>
                  </View>
                  <SymbolView
                    name="chevron.right"
                    size={14}
                    tintColorClassName="accent-chevron"
                    type="monochrome"
                  />
                </Pressable>
              </View>
            )
          ) : null}
          {listScopes.length === 0 ? (
            <View
              collapsable={false}
              className={cn(
                "items-center gap-3 px-6 py-8",
                Platform.OS !== "android" && "rounded-[24px] bg-grouped-card",
              )}
            >
              {emptyState.loading ? <ActivityIndicator colorClassName="accent-icon-muted" /> : null}
              <Text className="text-center text-lg font-t3-bold text-foreground">
                {emptyState.title}
              </Text>
              <Text className="text-center text-sm leading-normal text-foreground-muted">
                {emptyState.detail}
              </Text>
              {Platform.OS === "android" ? (
                <>
                  <MaterialButton
                    label={hasHosts ? "Add new project" : "Add host"}
                    tone="primary"
                    onPress={() => (hasHosts ? addProject() : navigation.navigate("Hosts"))}
                  />
                  {scratchHostId !== null ? (
                    <MaterialButton
                      label="Start without a project"
                      tone="secondary"
                      onPress={startScratch}
                    />
                  ) : null}
                </>
              ) : !hasHosts ? (
                <Pressable
                  className="mt-1 rounded-full bg-primary px-4 py-2.5 active:opacity-70"
                  onPress={() => navigation.navigate("Hosts")}
                >
                  <Text className="text-sm font-t3-bold text-primary-foreground">Add host</Text>
                </Pressable>
              ) : (
                <>
                  <Pressable
                    className="mt-1 rounded-full bg-primary px-4 py-2.5 active:opacity-70"
                    onPress={addProject}
                  >
                    <Text className="text-sm font-t3-bold text-primary-foreground">
                      Add new project
                    </Text>
                  </Pressable>
                  {scratchHostId !== null ? (
                    <Pressable
                      className="rounded-full bg-subtle px-4 py-2.5 active:opacity-70"
                      onPress={startScratch}
                    >
                      <Text className="text-sm font-t3-bold text-foreground">
                        Start without a project
                      </Text>
                    </Pressable>
                  ) : null}
                </>
              )}
            </View>
          ) : visibleScopes.length === 0 ? (
            <View className="items-center gap-2 px-6 py-8">
              <Text className="text-center text-lg font-t3-bold text-foreground">
                No matching projects
              </Text>
              <Text className="text-center text-sm leading-normal text-foreground-muted">
                Try a different project name or workspace path.
              </Text>
            </View>
          ) : (
            <View
              collapsable={false}
              className={
                Platform.OS === "android"
                  ? "overflow-hidden rounded-[28px] bg-grouped-card"
                  : "overflow-hidden rounded-[24px] bg-grouped-card"
              }
            >
              {visibleScopes.map((scope, scopeIndex) => {
                const hasMultipleProjects = scope.projects.length > 1;
                const selectionTarget = getProjectScopeSelectionTarget(scope, props.preferredHostId);
                const subtitle = hasMultipleProjects
                  ? `${scope.projects.length} workspaces`
                  : selectionTarget.project.path;
                if (Platform.OS === "android") {
                  return (
                    <MaterialListRow
                      className="bg-grouped-card"
                      key={scope.key}
                      title={scope.title}
                      subtitle={subtitle}
                      onPress={() => selectProject(scope)}
                      leading={
                        <ProjectFavicon
                          environmentId={scope.representative.hostId}
                          size={24}
                          projectTitle={scope.title}
                          workspaceRoot={scope.representative.project.path}
                        />
                      }
                    />
                  );
                }
                return (
                  <View
                    key={scope.key}
                    className={cn(scopeIndex > 0 && "border-t border-border-subtle")}
                  >
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={scope.title}
                      onPress={() => selectProject(scope)}
                      className="flex-row items-center gap-3 bg-grouped-card px-4 py-3.5"
                    >
                      <View className="h-7 w-7 items-center justify-center">
                        <ProjectFavicon
                          environmentId={scope.representative.hostId}
                          size={20}
                          projectTitle={scope.title}
                          workspaceRoot={scope.representative.project.path}
                        />
                      </View>
                      <View className="min-w-0 flex-1">
                        <Text className={cn("text-base leading-snug", "font-t3-bold")}>
                          {scope.title}
                        </Text>
                        <Text
                          className="text-xs leading-snug text-foreground-muted"
                          ellipsizeMode="middle"
                          numberOfLines={1}
                        >
                          {subtitle}
                        </Text>
                      </View>
                      <SymbolView
                        name="chevron.right"
                        size={14}
                        tintColorClassName="accent-chevron"
                        type="monochrome"
                      />
                    </Pressable>
                  </View>
                );
              })}
            </View>
          )}
        </ScreenScrollView>
      </MaterialScreenContent>
    </View>
  );
}

/* ─── Draft ───────────────────────────────────────────────────────────── */

/**
 * The new session this draft starts, made when the draft opens so picked
 * files can upload to its host before the first prompt; the host learns of
 * the session with that prompt. Leaving without starting closes it.
 */
function useDraftConversation(hostId: string, sessionId: string, workingDirectory: string | null) {
  const app = useApp();
  const startedRef = useRef(false);
  const store = useMemo(
    () =>
      workingDirectory === null
        ? null
        : app.conversation(hostId, {
            newSession: { sessionId, provider: "claude-code", workingDirectory },
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

function NewTaskDraftScreen(props: { readonly hostId: string; readonly projectPath: string }) {
  const app = useApp();
  const chat = isChat(props.projectPath);
  const projectsFolder = useProjectsFolder(props.hostId);
  const [sessionId] = useState(() => app.newSessionId());
  // A chat runs in its own folder, named from the new session; the host names
  // it itself when it has not said where its projects are.
  const workingDirectory = !chat
    ? props.projectPath
    : projectsFolder === null
      ? null
      : projectsFolder !== "~"
        ? chatFolderIn(projectsFolder, sessionId)
        : NEW_CHAT_DIRECTORY;
  const { store, startedRef } = useDraftConversation(props.hostId, sessionId, workingDirectory);
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
  const otherModeRef = useRef<PermissionMode>(planMode ? "supervised" : mode);
  if (!planMode) otherModeRef.current = mode;
  if (!offersPlanToggle(props.meta.runOptions.capabilities)) return null;
  return (
    <ComposerInlineControl
      accessibilityHint={`Switches to ${planMode ? PERMISSION_MODE_TEXT[otherModeRef.current].label : "Plan"}`}
      accessibilityLabel={`Permission mode: ${PERMISSION_MODE_TEXT[mode].label}`}
      disabled={props.disabled}
      emphasized
      icon={PERMISSION_MODE_ICON[mode]}
      label={PERMISSION_MODE_TEXT[mode].label}
      onPress={() =>
        props.store.controller.updateRun({ permissionMode: planMode ? otherModeRef.current : "plan" })
      }
      showChevron={false}
    />
  );
}

function NewTaskDraftContent(props: {
  readonly store: ConversationStore;
  readonly sessionId: string;
  readonly hostId: string;
  readonly projectPath: string;
  readonly chat: boolean;
  readonly onStarted: () => void;
}) {
  const app = useApp();
  const { store } = props;
  const navigation = useNavigation<Navigation>();
  const openHostFile = useOpenHostFile(store);
  const insets = useSafeAreaInsets();
  const meta = useListened(store.meta, store.metaSnapshotOf);
  const hosts = useListened(app.registry.changes, app.registry.hosts);
  const projects = useListened(app.threads.changes, app.threads.projects);
  const connected = useListened(
    app.connections.changes,
    () => app.connections.state(props.hostId)?.phase === "connected",
  );
  const controlsBottomPadding = Math.max(insets.bottom, 10);
  const keyboardOpenedOffset = Math.max(0, controlsBottomPadding - 8);
  const promptInputRef = useRef<ComposerEditorHandle>(null);
  const foregroundColor = useUniwindTheme()["--color-foreground"];
  const bodyText = useScaledTextRole("body");
  const draftKey = `new-task:${props.projectPath}`;
  const [prompt, setPrompt] = useState(() => app.draft(props.hostId, draftKey));
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [environmentPickerOpen, setEnvironmentPickerOpen] = useState(false);

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );
  const changePrompt = useCallback(
    (value: string) => {
      setPrompt(value);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(
        () => app.saveDraft(props.hostId, draftKey, value),
        DRAFT_SAVE_DELAY_MS,
      );
    },
    [app, draftKey, props.hostId],
  );

  const host = hosts.find((candidate) => candidate.id === props.hostId);
  const selectedEnvironmentLabel = host?.label ?? "Host";
  const scope = useMemo(
    () =>
      props.chat
        ? null
        : scopeOfProject(groupProjectScopes(projects), props.hostId, props.projectPath),
    [projects, props.chat, props.hostId, props.projectPath],
  );
  // The hosts this task could run on: the same repository's checkouts, or any host for a chat.
  const environments = useMemo<NewTaskEnvironmentChoice[]>(
    () =>
      props.chat
        ? hosts.map((candidate) => ({ hostId: candidate.id, label: candidate.label, os: candidate.os }))
        : (scope?.projects ?? []).map((project) => ({
            hostId: project.hostId,
            label: project.hostLabel,
            os: hosts.find((candidate) => candidate.id === project.hostId)?.os,
            subtitle: project.project.path,
          })),
    [hosts, props.chat, scope],
  );
  const projectTitle = scope?.title ?? props.projectPath.split("/").filter(Boolean).at(-1) ?? "project";
  const attachmentsFull = meta.attachments.length + meta.uploading >= MAX_ATTACHMENT_UPLOAD_COUNT;
  const isComposerInteractionLocked = submitting;
  const canStart =
    !submitting &&
    meta.phase.kind === "ready" &&
    meta.uploading === 0 &&
    prompt.trim().length > 0;

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
    const previousParams = previous?.name === "NewTask" ? (previous.params as RootStackParamList["NewTask"]) : null;
    if (previous?.name === "NewTask" && !previousParams?.projectPath) navigation.goBack();
    else navigation.dispatch(StackActions.push("NewTask", { hostId: props.hostId }));
  };
  const selectEnvironment = (hostId: string) => {
    if (hostId === props.hostId) return;
    const target = props.chat
      ? NEW_CHAT_DIRECTORY
      : scope?.projects.find((project) => project.hostId === hostId)?.project.path;
    if (!target) return;
    app.saveDraft(hostId, `new-task:${target}`, prompt);
    navigation.dispatch(StackActions.replace("NewTask", { hostId, projectPath: target }));
  };

  const attach = async (pick: (existingCount: number) => Promise<PickedFile[]>) => {
    try {
      const files = await pick(meta.attachments.length + meta.uploading);
      if (files.length > 0) void store.controller.attach(files);
    } catch (error) {
      Alert.alert("Could not attach", error instanceof Error ? error.message : String(error));
    }
  };

  const handleStart = async () => {
    if (!canStart) return;
    setSubmitting(true);
    const text = prompt.trim();
    try {
      props.onStarted();
      rememberNewThreadTarget(props.hostId, {
        sessionId: props.sessionId,
        provider: store.controller.run.provider,
        workingDirectory: store.controller.run.workingDirectory,
      });
      const sending = store.controller.send(text);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      app.saveDraft(props.hostId, draftKey, "");
      // The thread replaces the whole new-task sheet; Back returns to where it opened.
      const state = navigation.getState();
      const firstNewTask = state?.routes.findIndex((candidate) => candidate.name === "NewTask") ?? -1;
      const base = state && firstNewTask >= 0 ? state.routes.slice(0, firstNewTask) : [];
      navigation.dispatch(
        CommonActions.reset({
          index: base.length,
          routes: [
            ...base.map((candidate) => ({ name: candidate.name, params: candidate.params })),
            { name: "Thread", params: { hostId: props.hostId, sessionId: props.sessionId } },
          ],
        }),
      );
      await sending;
    } catch (error) {
      Alert.alert("Could not start task", error instanceof Error ? error.message : String(error));
      setSubmitting(false);
    }
  };

  useKeyboardCommand("send", () => {
    if (canStart) void handleStart();
  });

  const promptEditor = (
    <ComposerEditor
      ref={promptInputRef}
      // The context-first screen opens with the keyboard closed.
      autoFocus={false}
      editable={!submitting}
      multiline
      scrollEnabled
      value={prompt}
      onChangeText={changePrompt}
      placeholder="Ask anything…"
      singleLineCentered={false}
      contentInsetVertical={0}
      style={{
        minHeight: 72,
        maxHeight: 160,
        paddingVertical: 4,
      }}
      textStyle={{ ...bodyText, color: foregroundColor, fontFamily: MOBILE_FONTS.regular }}
    />
  );

  const environmentControl = (
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
      onPress={environments.length > 1 ? () => setEnvironmentPickerOpen(true) : undefined}
      showChevron={environments.length > 1}
      static={environments.length <= 1}
    />
  );
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
          <Text className="text-2xl font-t3-medium tracking-tight text-foreground">in </Text>
          <HeroProjectMark scope={scope} projectTitle={projectTitle} />
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
          <Text className="text-2xl font-t3-medium tracking-tight text-foreground">?</Text>
        </View>
      </View>

      {environmentControl}
    </View>
  );
  const heroViewport = (
    <View className="flex-1" collapsable={false}>
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="never"
        contentContainerClassName="grow items-center pb-[236px] pt-12 ios:pt-[72px]"
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        style={{ flex: 1 }}
        testID="new-task-hero-scroll"
      >
        {hero}
      </ScrollView>
    </View>
  );

  const composerDock = (
    <View
      className={
        Platform.OS === "android" ? "bg-sheet-solid px-[12px] pt-1" : "bg-sheet px-[12px] pt-1"
      }
      style={{ paddingBottom: controlsBottomPadding }}
    >
      {meta.phase.kind === "error" ? (
        <Pressable
          accessibilityRole="button"
          className="px-3 py-2"
          onPress={() => void store.controller.load()}
        >
          <Text className="text-xs text-foreground">
            {`The host did not answer: ${meta.phase.message}. Tap to try again.`}
          </Text>
        </Pressable>
      ) : null}

      <ComposerSurface
        style={{
          borderRadius: 26,
          minHeight: 140,
          overflow: "hidden",
          paddingBottom: 6,
          paddingTop: 14,
        }}
      >
        {meta.attachments.length > 0 || meta.uploading > 0 ? (
          <View className="px-[14px] pb-2.5">
            <ComposerAttachmentStrip
              attachments={meta.attachments}
              uploading={meta.uploading}
              imageBorderRadius={16}
              imageSize={72}
              onPressDocument={(attachment) => openHostFile(attachment.hostPath)}
              onRemove={
                isComposerInteractionLocked
                  ? () => undefined
                  : (id) => store.controller.removeAttachment(id)
              }
            />
          </View>
        ) : null}

        <View className="px-[14px]">{promptEditor}</View>
        <View className="h-1" />

        <Animated.View layout={COMPOSER_LAYOUT_TRANSITION} collapsable={false}>
          <View className="relative h-[44px] overflow-hidden">
            <View className="absolute inset-0">
              <ComposerToolbarRow
                paddingBottom={0}
                paddingHorizontal={0}
                paddingTop={0}
                style={{ gap: 0 }}
              >
                <ComposerAttachmentButton
                  disabled={isComposerInteractionLocked || attachmentsFull}
                  supportsFiles
                  onPickMedia={() => attach(pickComposerMedia)}
                  onPickFiles={() => attach(pickComposerFiles)}
                />
                <View className="min-w-0 flex-1 flex-row items-center justify-end gap-2">
                  <View className="min-w-0 shrink">
                    <ComposerInlineControl
                      accessibilityLabel="Model and reasoning settings"
                      disabled={isComposerInteractionLocked}
                      emphasized
                      label={meta.run.model ? modelLabel(meta.run.provider, meta.run.model) : "Choose model"}
                      maxWidth="100%"
                      onPress={() => {
                        promptInputRef.current?.blur();
                        setSettingsOpen(true);
                      }}
                    />
                  </View>
                  <PlanModeToggle disabled={isComposerInteractionLocked} meta={meta} store={store} />
                </View>
                <ComposerActionButton
                  accessibilityLabel={
                    meta.uploading > 0
                      ? "Uploading attachments"
                      : submitting
                        ? "Starting task"
                        : connected
                          ? "Start task"
                          : "Queue task"
                  }
                  disabled={!canStart}
                  icon={connected ? "arrow.up" : "tray.and.arrow.up"}
                  onPress={() => void handleStart()}
                  variant="primary"
                />
              </ComposerToolbarRow>
            </View>
          </View>
        </Animated.View>
      </ComposerSurface>
      <ThreadSettingsSheet
        visible={settingsOpen}
        onClose={() => {
          setSettingsOpen(false);
          setTimeout(() => promptInputRef.current?.focus(), 100);
        }}
        store={store}
        meta={meta}
      />
      <NewTaskEnvironmentPicker
        visible={environmentPickerOpen}
        environments={environments}
        selectedHostId={props.hostId}
        onSelect={selectEnvironment}
        onClose={() => setEnvironmentPickerOpen(false)}
      />
    </View>
  );

  if (Platform.OS === "android") {
    return (
      <View className="flex-1 bg-sheet" collapsable={false}>
        <NativeStackScreenOptions options={{ headerShown: false }} />
        <AndroidScreenHeader title="New thread" hideBottomBorder onBack={closeNewTask} />
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
      <NativeStackScreenOptions
        options={{
          headerBackVisible: false,
          headerShadowVisible: false,
          title: "",
        }}
      />
      <NativeHeaderToolbar placement="left">
        <NativeHeaderToolbar.Button
          accessibilityLabel="Cancel new task"
          label="Cancel"
          onPress={closeNewTask}
        />
      </NativeHeaderToolbar>

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

/** The project's own mark before its name in the hero, as the web draft shows
 *  it. A project the host does not list has no mark to show. */
function HeroProjectMark(props: { readonly scope: ProjectScope | null; readonly projectTitle: string }) {
  if (!props.scope) return null;
  return (
    <View className="mr-1.5">
      <ProjectFavicon
        environmentId={props.scope.representative.hostId}
        size={22}
        projectTitle={props.projectTitle}
        workspaceRoot={props.scope.representative.project.path}
      />
    </View>
  );
}
