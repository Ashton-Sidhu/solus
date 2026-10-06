// Adapted from T3 Code apps/mobile/src/features/home/HomeRouteScreen.tsx (MIT, see UPSTREAM.md).
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Platform, useWindowDimensions } from "react-native";

import { useApp, useListened } from "../../app/app-context";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import type { RootStackParamList } from "../../navigation/routes";
import { useKeyboardCommand } from "../keyboard/use-keyboard-command";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { WorkspaceEmptyDetail } from "../layout/WorkspaceEmptyDetail";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import type { SolusThreadShell } from "../threads/thread-directory";
import type { ThreadListShelfExpansion } from "../threads/thread-list-state";
import { useReloadThreadLists, useThreadListState } from "../threads/use-thread-list";
import { AndroidHomeFabLayout } from "./AndroidHomeFab";
import { HomeScreen } from "./HomeScreen";
import { HomeHeader } from "./HomeHeader";
import { useHomeListOptions } from "./home-list-options";
import { useHomeThreadSelection } from "./home-thread-navigation";
import { buildHomeProjectScopes } from "./homeThreadList";
import { useThreadListActions } from "./useThreadListActions";
import { useWorkspaceState } from "./use-workspace-state";
import { getConnectionAwareBrandHeaderOptions } from "./WorkspaceConnectionTitle";

/* ─── Route screen ───────────────────────────────────────────────────── */

export function HomeRouteScreen() {
  const app = useApp();
  const { width: windowWidth } = useWindowDimensions();
  const { layout, panes } = useAdaptiveWorkspaceLayout();
  const projects = useListened(app.threads.changes, app.threads.projects);
  const threads = useListened(app.threads.changes, app.threads.threads);
  const list = useThreadListState();
  const facts = useListened(list.changes, list.facts);
  const shelfExpansion = useListened(list.changes, list.shelfExpansion);
  const hosts = useListened(app.registry.changes, app.registry.hosts);
  const catalogState = useWorkspaceState();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList, "Home">>();
  const [searchQuery, setSearchQuery] = useState("");
  const handleSelectThread = useHomeThreadSelection();
  const reloadThreadLists = useReloadThreadLists();
  // A thread pushed over Home may have changed the list; read it again.
  useFocusEffect(reloadThreadLists);
  useKeyboardCommand("newSession", () => navigation.navigate("NewTask"));

  const { settleThread, snoozeThread, unsnoozeThread, renameThread, unsettleThread } =
    useThreadListActions();
  const handleUnsettleThread = useCallback(
    (thread: SolusThreadShell) => void unsettleThread(thread),
    [unsettleThread],
  );
  const handleToggleShelf = useCallback(
    (shelf: keyof ThreadListShelfExpansion) => list.toggleShelf(shelf),
    [list],
  );
  const environments = useMemo(
    () =>
      hosts
        .map((host) => ({ environmentId: host.id, label: host.label }))
        .sort((left, right) => left.label.localeCompare(right.label)),
    [hosts],
  );
  const availableEnvironmentIds = useMemo(
    () => new Set(environments.map((environment) => environment.environmentId)),
    [environments],
  );
  const { options: listOptions, setSelectedEnvironmentId } =
    useHomeListOptions(availableEnvironmentIds);
  const selectedEnvironmentId = listOptions.selectedEnvironmentId;
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);
  const projectFilterOptions = useMemo(
    () =>
      buildHomeProjectScopes({ projects, hostId: selectedEnvironmentId }).map((scope) => ({
        key: scope.key,
        label: scope.title,
      })),
    [projects, selectedEnvironmentId],
  );
  useEffect(() => {
    if (
      selectedProjectKey !== null &&
      !projectFilterOptions.some((project) => project.key === selectedProjectKey)
    ) {
      setSelectedProjectKey(null);
    }
  }, [projectFilterOptions, selectedProjectKey]);

  const openSettings = () => navigation.navigate("Settings");
  // Solus keeps its hosts on their own screen; T3 opens environment settings.
  const openEnvironments = () => navigation.navigate("Hosts");
  const addConnection = () => navigation.navigate("PairHost");
  const retryHosts = () => {
    for (const host of app.registry.hosts()) app.connections.retry(host.id);
  };
  const startNewTask = () => navigation.navigate("NewTask");

  // In split layouts the persistent sidebar IS the thread list — Home becomes
  // an empty detail pane so selecting a thread never transitions layouts.
  if (layout.usesSplitView) {
    return (
      <>
        <NativeStackScreenOptions
          options={
            Platform.OS === "android"
              ? { headerShown: false }
              : { title: "", headerTitle: "", unstable_headerLeftItems: () => [] }
          }
        />
        {Platform.OS === "ios" ? (
          <NativeHeaderToolbar placement="left">
            <NativeHeaderToolbar.Button
              accessibilityLabel="New task"
              icon="square.and.pencil"
              onPress={startNewTask}
            />
          </NativeHeaderToolbar>
        ) : null}
        {Platform.OS === "android" ? <AndroidScreenHeader title="Threads" /> : null}
        <WorkspaceEmptyDetail
          onAddConnection={
            Platform.OS === "android" && !catalogState.hasConnections ? addConnection : undefined
          }
          onStartNewTask={
            Platform.OS === "android" && panes.primarySidebarVisible ? undefined : startNewTask
          }
        />
      </>
    );
  }

  return (
    <AndroidHomeFabLayout onStartNewTask={startNewTask}>
      <>
        {/* Restore the header after leaving split view; screen options are
            shallow-merged. The brand slot also doubles as the connection
            status surface while a host reconnects. */}
        <NativeStackScreenOptions
          optionsVersion={windowWidth}
          options={{
            ...getConnectionAwareBrandHeaderOptions({
              headerWidth: windowWidth,
              onOpenEnvironments: openEnvironments,
            }),
            headerShown: true,
          }}
        />
        <HomeHeader
          environments={environments}
          projects={projectFilterOptions}
          searchQuery={searchQuery}
          selectedEnvironmentId={selectedEnvironmentId}
          selectedProjectKey={selectedProjectKey}
          onEnvironmentChange={setSelectedEnvironmentId}
          onProjectChange={setSelectedProjectKey}
          onOpenEnvironments={openEnvironments}
          onOpenSettings={openSettings}
          onSearchQueryChange={setSearchQuery}
          onStartNewTask={startNewTask}
        />

        <HomeScreen
          catalogState={catalogState}
          environments={environments}
          facts={facts}
          shelfExpansion={shelfExpansion}
          onAddConnection={addConnection}
          onRetryHosts={retryHosts}
          onOpenHosts={openEnvironments}
          onSettleThread={settleThread}
          onSnoozeThread={snoozeThread}
          onUnsnoozeThread={unsnoozeThread}
          onUnsettleThread={handleUnsettleThread}
          onRenameThread={renameThread}
          onSelectThread={handleSelectThread}
          onToggleShelf={handleToggleShelf}
          projects={projects}
          searchQuery={searchQuery}
          selectedEnvironmentId={selectedEnvironmentId}
          selectedProjectKey={selectedProjectKey}
          threads={threads}
        />
      </>
    </AndroidHomeFabLayout>
  );
}
