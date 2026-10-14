// Adapted from T3 Code apps/mobile/src/features/home/HomeRouteScreen.tsx (MIT, see UPSTREAM.md).
import { useFocusEffect, useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { use, useCallback, useEffect, useMemo } from "react";
import { Platform, useWindowDimensions } from "react-native";

import { useApp, useListened } from "../../app/app-context";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { NativePrimaryColumnContext } from "../../native/v5-workspace-context";
import type { RootStackParamList } from "../../navigation/routes";
import { useKeyboardCommand } from "../keyboard/use-keyboard-command";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { WorkspaceEmptyDetail } from "../layout/WorkspaceEmptyDetail";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { MaterialScreenContent } from "../../components/MaterialScreenContent";
import { PullRequestsHeader } from "../prs/PullRequestsHeader";
import { PullRequestsScreen } from "../prs/PullRequestsScreen";
import { pullRequestPreferencesForHost } from "../workspace/list-preferences";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { WorkspaceTabsFrame } from "../workspace/WorkspaceTabsFrame";
import { WorkspaceToolbar } from "../workspace/WorkspaceToolbar";
import type { SolusThreadShell } from "../threads/thread-directory";
import type { ThreadListShelfExpansion } from "../threads/thread-list-state";
import { useReloadThreadLists, useThreadListState } from "../threads/use-thread-list";
import { AndroidHomeFabLayout } from "./AndroidHomeFab";
import { HomeScreen } from "./HomeScreen";
import { HomeHeader } from "./HomeHeader";
import { ThreadListFilters } from "./ThreadListFilters";
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
  const route = useRoute<RouteProp<RootStackParamList, "Home">>();
  // The iPad primary column: Home is the sidebar beside UIKit's detail column.
  const nativePrimaryColumn = use(NativePrimaryColumnContext);
  // The workspace owns the tab state, so the tab stays while a detail screen is pushed.
  const {
    state: tabs,
    dispatch: dispatchTabs,
    pullRequestPreferences,
    setPullRequestPreferences,
  } = useWorkspaceTabs();
  const searchQuery = tabs.query;
  const setSearchQuery = useCallback(
    (query: string) => dispatchTabs({ type: "query", query }),
    [dispatchTabs],
  );
  // A host's "Open pull requests" opens the Pull Requests tab narrowed to that
  // host. The params are read once, then cleared.
  const requestedTab = route.params?.tab;
  const requestedHostId = route.params?.hostId;
  useEffect(() => {
    if (!requestedTab && !requestedHostId) return;
    if (requestedTab) dispatchTabs({ type: "select", tab: requestedTab });
    if (requestedHostId) {
      setPullRequestPreferences((current) => pullRequestPreferencesForHost(current, requestedHostId));
    }
    navigation.setParams({ tab: undefined, hostId: undefined });
  }, [navigation, requestedTab, requestedHostId, dispatchTabs, setPullRequestPreferences]);
  const handleSelectThread = useHomeThreadSelection();
  const reloadThreadLists = useReloadThreadLists();
  // A thread pushed over Home may have changed the list; read it again.
  useFocusEffect(reloadThreadLists);
  useKeyboardCommand("newSession", () => navigation.navigate("NewTask"));

  const { settleThread, snoozeThread, unsnoozeThread, renameThread, unsettleThread, setPullRequestWatch } =
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
  const { options: listOptions, setSelectedEnvironmentId, setSelectedProjectKey } =
    useHomeListOptions(availableEnvironmentIds);
  const selectedEnvironmentId = listOptions.selectedEnvironmentId;
  const projectFilterOptions = useMemo(
    () =>
      buildHomeProjectScopes({ projects, hostId: selectedEnvironmentId }).map((scope) => ({
        key: scope.key,
        label: scope.title,
      })),
    [projects, selectedEnvironmentId],
  );
  // A saved project its host has not listed yet is kept, not cleared.
  const selectedProjectKey = projectFilterOptions.some(
    (project) => project.key === listOptions.selectedProjectKey,
  )
    ? listOptions.selectedProjectKey
    : null;

  const openSettings = () => navigation.navigate("Settings");
  // Solus keeps its hosts on their own screen; T3 opens environment settings.
  const openEnvironments = () => navigation.navigate("Hosts");
  const addConnection = () => navigation.navigate("PairHost");
  const retryHosts = () => {
    for (const host of app.registry.hosts()) app.connections.retry(host.id);
  };
  const startNewTask = () => navigation.navigate("NewTask");

  const pullRequests = (
    <MaterialScreenContent>
      <PullRequestsScreen
        query={searchQuery}
        preferences={pullRequestPreferences}
        onPreferencesChange={setPullRequestPreferences}
      />
    </MaterialScreenContent>
  );

  // The iPad primary column's header is only as wide as the column.
  const headerWidth = nativePrimaryColumn ? (layout.listPaneWidth ?? windowWidth) : windowWidth;
  // iOS: one toolbar owns the header of both tabs; Android draws each tab's header.
  const workspaceToolbar =
    Platform.OS === "ios" ? (
      <WorkspaceToolbar onNewTask={startNewTask} onOpenSettings={openSettings} />
    ) : null;

  // A split layout drawn in React Native (Android, or an iPad before iOS 26)
  // has a persistent sidebar that IS the thread list — Home becomes an empty
  // detail pane so selecting a thread never transitions layouts. The Pull
  // Requests tab shows its list in that pane. The iPad's native columns put
  // Home itself in the primary column instead.
  if (layout.usesSplitView && !nativePrimaryColumn) {
    return (
      <WorkspaceTabsFrame>
        <NativeStackScreenOptions
          options={
            Platform.OS === "android"
              ? { headerShown: false }
              : { title: "", headerTitle: "", unstable_headerLeftItems: () => [] }
          }
        />
        {tabs.selectedTab === "pullRequests" ? (
          <>
            {workspaceToolbar}
            <PullRequestsHeader
              searchQuery={searchQuery}
              onSearchQueryChange={setSearchQuery}
              onOpenSettings={openSettings}
              onOpenEnvironments={openEnvironments}
            />
            {pullRequests}
          </>
        ) : (
          <>
            {Platform.OS === "ios" ? (
              <>
                {/* Search and settings belong to the sidebar here. */}
                <NativeStackScreenOptions
                  options={{
                    headerSearchBarOptions: undefined,
                    unstable_headerRightItems: () => [],
                    unstable_headerToolbarItems: () => [],
                  }}
                />
                <NativeHeaderToolbar placement="left">
                  <NativeHeaderToolbar.Button
                    accessibilityLabel="New session"
                    icon="square.and.pencil"
                    onPress={startNewTask}
                  />
                </NativeHeaderToolbar>
              </>
            ) : (
              <AndroidScreenHeader title="Threads" />
            )}
            <WorkspaceEmptyDetail
              onAddConnection={
                Platform.OS === "android" && !catalogState.hasConnections ? addConnection : undefined
              }
              onStartNewTask={
                Platform.OS === "android" && panes.primarySidebarVisible ? undefined : startNewTask
              }
            />
          </>
        )}
      </WorkspaceTabsFrame>
    );
  }

  return (
    <WorkspaceTabsFrame>
      {/* Restore the header after leaving split view; screen options are
          shallow-merged. The brand slot also doubles as the connection
          status surface while a host reconnects. */}
      <NativeStackScreenOptions
        optionsVersion={headerWidth}
        options={{
          ...getConnectionAwareBrandHeaderOptions({
            headerWidth,
            // iOS: Settings and Search (WorkspaceToolbar); Android draws its own header.
            trailingItemCount: Platform.OS === "ios" ? 2 : 1,
            onOpenEnvironments: openEnvironments,
          }),
          headerShown: true,
        }}
      />
      {workspaceToolbar}
      {tabs.selectedTab === "pullRequests" ? (
        <>
          <PullRequestsHeader
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            onOpenSettings={openSettings}
            onOpenEnvironments={openEnvironments}
          />
          {pullRequests}
        </>
      ) : (
        <AndroidHomeFabLayout onStartNewTask={startNewTask}>
          <>
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
              listFilters={
                Platform.OS === "ios" ? (
                  <ThreadListFilters
                    environments={environments}
                    projects={projectFilterOptions}
                    selectedEnvironmentId={selectedEnvironmentId}
                    selectedProjectKey={selectedProjectKey}
                    onEnvironmentChange={setSelectedEnvironmentId}
                    onProjectChange={setSelectedProjectKey}
                  />
                ) : undefined
              }
              onAddConnection={addConnection}
              onRetryHosts={retryHosts}
              onOpenHosts={openEnvironments}
              onSettleThread={settleThread}
              onSnoozeThread={snoozeThread}
              onUnsnoozeThread={unsnoozeThread}
              onUnsettleThread={handleUnsettleThread}
              onSetPullRequestWatch={setPullRequestWatch}
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
      )}
    </WorkspaceTabsFrame>
  );
}
