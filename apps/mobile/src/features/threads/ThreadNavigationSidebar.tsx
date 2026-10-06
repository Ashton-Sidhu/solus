// Adapted from T3 Code apps/mobile/src/features/threads/ThreadNavigationSidebar.tsx (MIT, see UPSTREAM.md).
import { useAndroidControlSizing } from "../../components/useAndroidControlSizing";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { LegendList } from "@legendapp/list/react-native";
import type { MenuAction } from "@react-native-menu/menu";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LayoutChangeEvent } from "react-native";
import { Platform, StyleSheet, TextInput, type TextInputInstance, View } from "react-native";
import { GestureDetector, useNativeGesture } from "react-native-gesture-handler";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { SearchBarCommands } from "react-native-screens";

import { useApp, useListened } from "../../app/app-context";
import { AppText as Text } from "../../components/AppText";
import { CompactBrandTitle } from "../../components/CompactBrandTitle";
import { ControlPillMenu } from "../../components/ControlPill";
import { SymbolView } from "../../components/AppSymbol";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useHomeListOptions } from "../home/home-list-options";
import { buildHomeListFilterMenu } from "../home/home-list-filter-menu";
import { buildHomeProjectScopes, sortHomeProjectScopes } from "../home/homeThreadList";
import { SwipeableScrollGateProvider, useSwipeableScrollGate } from "../home/thread-swipe-actions";
import { useThreadListActions } from "../home/useThreadListActions";
import { useWorkspaceState } from "../home/use-workspace-state";
import {
  getConnectionAwareBrandHeaderOptions,
  WorkspaceConnectionTitle,
} from "../home/WorkspaceConnectionTitle";
import { SidebarHeaderActions } from "./sidebar-header-actions";
import { MaterialThreadListToolbar } from "../home/MaterialThreadListToolbar";
import { useMaterialToolbarLayout } from "../../components/useMaterialToolbarLayout";
import { useMaterialFabScroll } from "../home/MaterialFabScrollContext";
import { SidebarFilterButton } from "./sidebar-filter-button";
import { createSidebarHeaderItems } from "./sidebar-native-header-items";
import { SidebarNavigationShell } from "./sidebar-navigation-shell";
import type { SolusProjectShell, SolusThreadShell } from "./thread-directory";
import {
  ThreadListV2Row,
  ThreadListV2SettledShelfHeader,
  ThreadListV2ShowMoreRow,
  ThreadListV2SnoozedShelfHeader,
} from "./thread-list-v2-items";
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
  isThreadListV2ListItem,
  threadListV2ListItemsAreEqual,
  threadFaviconRoot,
  threadProjectFallbackTitle,
  threadProjectKey,
  THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  THREAD_LIST_V2_SETTLED_PAGE_COUNT,
  type ThreadListV2ListItem,
} from "./threadListV2";
import { useThreadListState } from "./use-thread-list";

/** The sidebar list: flat v2 rows plus a settled "Show more" pager row. */
type SidebarListItem =
  | ThreadListV2ListItem
  | { readonly type: "v2-show-more"; readonly key: string; readonly hiddenCount: number };

const SIDEBAR_STICKY_HEADER_HEIGHT = 106;

const currentMinute = () => Math.floor(Date.now() / 60_000) * 60_000;

interface ThreadNavigationSidebarProps {
  readonly width: number;
  readonly visible: boolean;
  readonly selectedThreadKey: string | null;
  readonly onOpenSettings: () => void;
  readonly onOpenEnvironmentSettings: () => void;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onSelectThread: (thread: SolusThreadShell) => void;
  readonly onRequestVisibility: () => void;
  readonly searchQuery: string;
}

/**
 * iPad/large-width sidebar column.
 *
 * On iOS the pane is hosted inside its own navigation-inert single-screen
 * native stack (SidebarNavigationShell) so the header is a real
 * UINavigationBar: large title, native bar-button items, and a
 * UISearchController search field — the same chrome a UISplitViewController
 * column gets. Other platforms keep the custom header chrome.
 */
export function ThreadNavigationSidebar(props: ThreadNavigationSidebarProps) {
  if (Platform.OS !== "ios") {
    return <ThreadNavigationSidebarPane {...props} nativeChrome={false} />;
  }
  return <NativeSidebarContainer {...props} />;
}

function NativeSidebarContainer(props: ThreadNavigationSidebarProps) {
  return (
    <View
      testID="thread-navigation-sidebar"
      className="flex-1 border-border bg-drawer"
      style={{ borderRightWidth: StyleSheet.hairlineWidth, width: props.width }}
    >
      <SidebarNavigationShell>
        <ThreadNavigationSidebarPane {...props} nativeChrome />
      </SidebarNavigationShell>
    </View>
  );
}

function ThreadNavigationSidebarPane(
  props: ThreadNavigationSidebarProps & { readonly nativeChrome: boolean },
) {
  const app = useApp();
  const { themeVariables: materialTheme } = useAppearancePreferences();
  const drawerColor = materialTheme["--color-drawer"];

  const insets = useSafeAreaInsets();
  const { fabClearance } = useAndroidControlSizing();
  const projects = useListened(app.threads.changes, app.threads.projects);
  const threads = useListened(app.threads.changes, app.threads.threads);
  const hosts = useListened(app.registry.changes, app.registry.hosts);
  const list = useThreadListState();
  const facts = useListened(list.changes, list.facts);
  const shelfExpansion = useListened(list.changes, list.shelfExpansion);
  const catalogState = useWorkspaceState();
  const isLoadingThreads = useListened(app.threads.changes, app.threads.isLoading);
  const searchInputRef = useRef<TextInputInstance>(null);
  const searchBarRef = useRef<SearchBarCommands>(null);
  const openSwipeableRef = useRef<SwipeableMethods | null>(null);
  const sidebarScrollGesture = useNativeGesture();
  const { settleThread, snoozeThread, unsnoozeThread, unsettleThread, renameThread } =
    useThreadListActions();
  const handleSnoozeThread = useCallback(
    (thread: SolusThreadShell, snoozedUntil: number) => void snoozeThread(thread, snoozedUntil),
    [snoozeThread],
  );
  const handleUnsnoozeThread = useCallback(
    (thread: SolusThreadShell) => void unsnoozeThread(thread),
    [unsnoozeThread],
  );
  const handleUnsettleThread = useCallback(
    (thread: SolusThreadShell) => void unsettleThread(thread),
    [unsettleThread],
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
  const { options, setSelectedEnvironmentId } = useHomeListOptions(availableEnvironmentIds);
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);
  const knownProjectKeys = useMemo(
    () => new Set(projects.map((project) => project.key)),
    [projects],
  );
  const projectScopes = useMemo(
    () =>
      sortHomeProjectScopes({
        scopes: buildHomeProjectScopes({ projects, hostId: options.selectedEnvironmentId }),
        threads,
        knownProjectKeys,
      }),
    [knownProjectKeys, options.selectedEnvironmentId, projects, threads],
  );
  const projectFilterOptions = useMemo(
    () =>
      projectScopes.map((scope) => ({
        key: scope.key,
        label: scope.title,
      })),
    [projectScopes],
  );
  const projectTitleByProjectKey = useMemo(
    () =>
      new Map(
        projectScopes.flatMap((scope) =>
          Array.from(scope.projectKeys, (projectKey) => [projectKey, scope.title] as const),
        ),
      ),
    [projectScopes],
  );
  const selectedProjectScope = useMemo(
    () =>
      selectedProjectKey === null
        ? null
        : (projectScopes.find((scope) => scope.key === selectedProjectKey) ?? null),
    [projectScopes, selectedProjectKey],
  );
  useEffect(() => {
    if (
      selectedProjectKey !== null &&
      !projectFilterOptions.some((project) => project.key === selectedProjectKey)
    ) {
      setSelectedProjectKey(null);
    }
  }, [projectFilterOptions, selectedProjectKey]);
  const projectByKey = useMemo(() => {
    const map = new Map<string, SolusProjectShell>();
    for (const project of projects) map.set(project.key, project);
    return map;
  }, [projects]);

  // Same model as the compact Home list (HomeScreen.tsx): newest-first card
  // block + snoozed and settled shelves. The settled tail renders in pages;
  // expansion resets when the filter context changes so environment/search
  // flips never inherit a deep page.
  const [settledVisibleCount, setSettledVisibleCount] = useState(
    THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  );
  const settledResetKey = `${options.selectedEnvironmentId ?? "all"}:${selectedProjectKey ?? "all"}:${props.searchQuery.trim()}`;
  const lastSettledResetKeyRef = useRef(settledResetKey);
  if (lastSettledResetKeyRef.current !== settledResetKey) {
    lastSettledResetKeyRef.current = settledResetKey;
    setSettledVisibleCount(THREAD_LIST_V2_SETTLED_INITIAL_COUNT);
  }
  const showMoreSettled = useCallback(
    () => setSettledVisibleCount((count) => count + THREAD_LIST_V2_SETTLED_PAGE_COUNT),
    [],
  );
  const settledShelfExpanded = shelfExpansion.settled;
  const snoozedShelfExpanded = shelfExpansion.snoozed;
  const toggleSettledShelf = useCallback(() => list.toggleShelf("settled"), [list]);
  const toggleSnoozedShelf = useCallback(() => list.toggleShelf("snoozed"), [list]);
  // The snooze helpers need a clock while the pane stays open.
  const [nowMinute, setNowMinute] = useState(currentMinute);
  // Snooze wake times are second-precise; a counter bumped exactly at the
  // next wake boundary re-runs the partition with a fresh clock so a woken
  // thread reappears immediately instead of on the next minute tick.
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);
  useEffect(() => {
    // Refresh immediately because the mount-time value can be hours old.
    setNowMinute(currentMinute());
    const id = setInterval(() => setNowMinute(currentMinute()), 60_000);
    return () => clearInterval(id);
  }, []);
  const threadListV2Layout = useMemo(
    () =>
      buildThreadListV2Items({
        threads,
        facts,
        hostId: options.selectedEnvironmentId,
        projectKeys: selectedProjectScope === null ? null : selectedProjectScope.projectKeys,
        knownProjectKeys,
        searchQuery: props.searchQuery,
        settledLimit: settledVisibleCount,
        now: Date.now(),
        snoozedShelfExpanded,
        settledShelfExpanded,
        selectedThreadKey: props.selectedThreadKey ?? null,
      }),
    [
      facts,
      knownProjectKeys,
      nowMinute,
      snoozeWakeTick,
      snoozedShelfExpanded,
      settledShelfExpanded,
      props.selectedThreadKey,
      options.selectedEnvironmentId,
      props.searchQuery,
      settledVisibleCount,
      threads,
      selectedProjectScope,
    ],
  );
  // Re-partition the moment the earliest snooze expires (clamped to the
  // signed-32-bit setTimeout range; far-future wakes re-arm at the clamp).
  const nextSnoozeWakeAt = threadListV2Layout.nextSnoozeWakeAt;
  useEffect(() => {
    if (nextSnoozeWakeAt === null) return;
    const delayMs = Math.min(Math.max(0, nextSnoozeWakeAt - Date.now()) + 50, 2_147_483_647);
    const id = setTimeout(() => bumpSnoozeWakeTick((tick) => tick + 1), delayMs);
    return () => clearTimeout(id);
    // snoozeWakeTick must re-arm the timer even when nextSnoozeWakeAt is
    // unchanged: after a clamped fire the boundary is identical and the chain
    // would die.
  }, [nextSnoozeWakeAt, snoozeWakeTick]);
  const listItems = useMemo<readonly SidebarListItem[]>(() => {
    const items: SidebarListItem[] = buildThreadListV2ListItems({
      items: threadListV2Layout.items,
      facts,
      snoozedCount: threadListV2Layout.snoozedCount,
      snoozedShelfExpanded,
      snoozedShelfHeaderIndex: threadListV2Layout.snoozedShelfHeaderIndex,
      settledCount: threadListV2Layout.settledCount,
      settledShelfExpanded,
      settledShelfHeaderIndex: threadListV2Layout.settledShelfHeaderIndex,
      now: nowMinute,
    });
    if (settledShelfExpanded && threadListV2Layout.hiddenSettledCount > 0) {
      items.push({
        type: "v2-show-more",
        key: "v2-show-more",
        hiddenCount: threadListV2Layout.hiddenSettledCount,
      });
    }
    return items;
  }, [facts, nowMinute, settledShelfExpanded, snoozedShelfExpanded, threadListV2Layout]);
  const listMenuActions = useMemo<MenuAction[]>(
    () => [
      {
        id: "environment",
        title: "Host",
        subactions: [
          {
            id: "environment:all",
            title: "All hosts",
            subtitle: "Show threads from every host",
            state: options.selectedEnvironmentId === null ? "on" : "off",
          },
          ...environments.map((environment) => ({
            id: `environment:${environment.environmentId}`,
            title: environment.label,
            state:
              options.selectedEnvironmentId === environment.environmentId
                ? ("on" as const)
                : ("off" as const),
          })),
        ],
      },
      ...(projectFilterOptions.length === 0
        ? []
        : ([
            {
              id: "project",
              title: "Project",
              subactions: [
                {
                  id: "project:all",
                  title: "All projects",
                  subtitle: "Show threads from every project",
                  state: selectedProjectKey === null ? "on" : "off",
                },
                ...projectFilterOptions.map((project) => ({
                  id: `project:${project.key}`,
                  title: project.label,
                  state: selectedProjectKey === project.key ? ("on" as const) : ("off" as const),
                })),
              ],
            },
          ] satisfies MenuAction[])),
    ],
    [environments, options, projectFilterOptions, selectedProjectKey],
  );
  const handleListMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      const event = nativeEvent.event;
      if (event === "environment:all") {
        setSelectedEnvironmentId(null);
        return;
      }
      if (event.startsWith("environment:")) {
        const environment = environments.find(
          (candidate) => candidate.environmentId === event.slice("environment:".length),
        );
        if (environment) setSelectedEnvironmentId(environment.environmentId);
        return;
      }
      if (event === "project:all") {
        setSelectedProjectKey(null);
        return;
      }
      if (event.startsWith("project:")) {
        const projectKey = event.slice("project:".length);
        if (projectFilterOptions.some((project) => project.key === projectKey)) {
          setSelectedProjectKey(projectKey);
        }
        return;
      }
    },
    [environments, projectFilterOptions, setSelectedEnvironmentId],
  );

  const [measuredHeaderHeight, setMeasuredHeaderHeight] = useState<number | null>(null);
  const { height, paddingTop, paddingBottom } = useMaterialToolbarLayout();
  // The sticky header (title row, search field, optional connection status)
  // is measured so the list inset always matches its real height — no
  // hardcoded per-variant constants.
  const stickyHeaderHeight =
    measuredHeaderHeight ??
    (Platform.OS === "android"
      ? paddingTop + height + paddingBottom
      : insets.top + SIDEBAR_STICKY_HEADER_HEIGHT);
  const topListInset = stickyHeaderHeight + 6;
  const handleStickyHeaderLayout = useCallback((event: LayoutChangeEvent) => {
    const nextHeight = event.nativeEvent.layout.height;
    setMeasuredHeaderHeight((current) => (current === nextHeight ? current : nextHeight));
  }, []);
  const handleSwipeableWillOpen = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current !== methods) {
      openSwipeableRef.current?.close();
      openSwipeableRef.current = methods;
    }
  }, []);
  const handleSwipeableClose = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current === methods) {
      openSwipeableRef.current = null;
    }
  }, []);
  const handleSelectThread = useCallback(
    (thread: SolusThreadShell) => {
      props.onSelectThread(thread);
      openSwipeableRef.current?.close();
    },
    [props.onSelectThread],
  );
  const handleScrollBeginDrag = useCallback(() => {
    openSwipeableRef.current?.close();
  }, []);
  const onMaterialFabScroll = useMaterialFabScroll();
  const { swipeEnabled, scrollGateHandlers } = useSwipeableScrollGate({
    onScroll: onMaterialFabScroll,
    onScrollBeginDrag: handleScrollBeginDrag,
  });
  // The project shells feed row props, so they have to bust the recycler's
  // memoization — otherwise a row keeps the fallback title it was first
  // rendered with. The minute clock deliberately stays out: its per-row text
  // lives on the items, so a tick only re-renders rows whose displayed text
  // actually moved.
  const listExtraData = useMemo(
    () => ({
      selectedThreadKey: props.selectedThreadKey ?? "",
      projectByKey,
      projectTitleByProjectKey,
      environmentCount: environments.length,
    }),
    [props.selectedThreadKey, projectByKey, projectTitleByProjectKey, environments.length],
  );
  const sidebarItemsAreEqual = useCallback(
    (previous: SidebarListItem, item: SidebarListItem): boolean => {
      if (isThreadListV2ListItem(previous) && isThreadListV2ListItem(item)) {
        return threadListV2ListItemsAreEqual(previous, item);
      }
      if (previous.type === "v2-show-more" && item.type === "v2-show-more") {
        return previous.hiddenCount === item.hiddenCount;
      }
      return false;
    },
    [],
  );
  const renderListItem = useCallback(
    ({ item }: { readonly item: SidebarListItem }) => {
      switch (item.type) {
        case "v2-thread": {
          const thread = item.item.thread;
          const scopeKey = threadProjectKey(thread, knownProjectKeys);
          // Intentional difference from Home: the sidebar never passes
          // `showTrailingDivider` because its rows render no Home-style row
          // hairline at all.
          return (
            <ThreadListV2Row
              thread={thread}
              variant={item.item.variant}
              snoozed={item.item.snoozed}
              status={item.status}
              pr={item.pr}
              snoozePresetMinute={item.snoozePresetMinute ?? ""}
              snoozeWakeLabelText={item.snoozeWakeLabelText}
              timeLabel={item.timeLabel}
              projectPath={threadFaviconRoot(thread.record, projectByKey.get(scopeKey)?.project.path ?? null)}
              projectTitle={
                projectTitleByProjectKey.get(scopeKey) ?? threadProjectFallbackTitle(thread.record)
              }
              environmentLabel={environments.length > 1 ? thread.hostLabel : null}
              pane="sidebar"
              selected={thread.key === props.selectedThreadKey}
              fullSwipeWidth={props.width - 20}
              onSelectThread={handleSelectThread}
              onRenameThread={renameThread}
              onSettleThread={settleThread}
              onSnoozeThread={handleSnoozeThread}
              onUnsnoozeThread={handleUnsnoozeThread}
              onUnsettleThread={handleUnsettleThread}
              onSwipeableClose={handleSwipeableClose}
              onSwipeableWillOpen={handleSwipeableWillOpen}
              simultaneousSwipeGesture={sidebarScrollGesture}
            />
          );
        }
        case "v2-snoozed-shelf":
          return (
            <ThreadListV2SnoozedShelfHeader
              count={item.count}
              disabled={item.disabled}
              expanded={item.expanded}
              onToggle={toggleSnoozedShelf}
              pane="sidebar"
            />
          );
        case "v2-settled-shelf":
          return (
            <ThreadListV2SettledShelfHeader
              count={item.count}
              disabled={item.disabled}
              expanded={item.expanded}
              onToggle={toggleSettledShelf}
              pane="sidebar"
            />
          );
        case "v2-show-more":
          return (
            <ThreadListV2ShowMoreRow
              pane="sidebar"
              hiddenCount={item.hiddenCount}
              onPress={showMoreSettled}
            />
          );
      }
    },
    [
      environments.length,
      handleSelectThread,
      handleSnoozeThread,
      handleSwipeableClose,
      handleSwipeableWillOpen,
      handleUnsettleThread,
      handleUnsnoozeThread,
      knownProjectKeys,
      projectByKey,
      projectTitleByProjectKey,
      props.selectedThreadKey,
      props.width,
      renameThread,
      settleThread,
      showMoreSettled,
      sidebarScrollGesture,
      toggleSettledShelf,
      toggleSnoozedShelf,
    ],
  );
  // Only the environment and project filters can light the "customized" state.
  const filterCustomized = options.selectedEnvironmentId !== null || selectedProjectKey !== null;
  const filterIcon = filterCustomized
    ? "line.3.horizontal.decrease.circle.fill"
    : "line.3.horizontal.decrease.circle";
  const filterMenu = useMemo(
    () =>
      buildHomeListFilterMenu({
        environments,
        projects: projectFilterOptions,
        selectedEnvironmentId: options.selectedEnvironmentId,
        selectedProjectKey,
        onEnvironmentChange: setSelectedEnvironmentId,
        onProjectChange: setSelectedProjectKey,
      }),
    [environments, options, projectFilterOptions, selectedProjectKey, setSelectedEnvironmentId],
  );
  const nativeHeaderItems = useMemo(
    () =>
      createSidebarHeaderItems({
        filterIcon,
        filterMenu,
        onOpenSettings: props.onOpenSettings,
      }),
    [filterIcon, filterMenu, props.onOpenSettings],
  );
  // Snoozed threads need no special case: the shelf header is a list row
  // even while collapsed.
  const listEmpty = (
    <Text
      className={
        Platform.OS === "android"
          ? "px-4 py-4 text-center text-sm text-drawer-foreground-muted"
          : "px-2 py-4 text-sm text-drawer-foreground-muted"
      }
    >
      {isLoadingThreads && threads.length === 0
        ? "Loading threads…"
        : Platform.OS === "android" && !catalogState.hasConnections
          ? "No hosts connected"
          : props.searchQuery.trim().length > 0
            ? "No matching threads"
            : selectedProjectScope !== null
              ? `No threads in ${selectedProjectScope.title}`
              : "No threads yet"}
    </Text>
  );

  if (props.nativeChrome) {
    return (
      <>
        <NativeStackScreenOptions
          optionsVersion={[nativeHeaderItems, props.width]}
          options={{
            // Re-applies the shell's static brand slot with the
            // connection-status swap so reconnects surface in the header
            // instead of shifting the list.
            ...getConnectionAwareBrandHeaderOptions({
              headerWidth: props.width,
              trailingItemCount: nativeHeaderItems.length,
              onOpenEnvironments: props.onOpenEnvironmentSettings,
              fallbackTitleStyle: { fontSize: 18, fontWeight: "800" },
            }),
            headerSearchBarOptions: {
              ref: searchBarRef,
              autoCapitalize: "none",
              hideNavigationBar: false,
              // Keep the search bar pinned under the title — UIKit's default
              // hidesSearchBarWhenScrolling collapses it on scroll.
              hideWhenScrolling: false,
              obscureBackground: false,
              placeholder: "Search",
              placement: "stacked",
              onCancelButtonPress: () => {
                props.onSearchQueryChange("");
              },
              onChangeText: (event) => {
                props.onSearchQueryChange(event.nativeEvent.text);
              },
            },
            unstable_headerRightItems: () => nativeHeaderItems,
          }}
        />
        <View className="flex-1">
          <SwipeableScrollGateProvider enabled={swipeEnabled}>
            <GestureDetector gesture={sidebarScrollGesture}>
              <LegendList
                data={listItems}
                drawDistance={500}
                estimatedItemSize={64}
                extraData={listExtraData}
                getItemType={(item) => item.type}
                itemsAreEqual={sidebarItemsAreEqual}
                keyExtractor={(item) => item.key}
                renderItem={renderListItem}
                automaticallyAdjustsScrollIndicatorInsets={NATIVE_LIQUID_GLASS_SUPPORTED}
                contentInsetAdjustmentBehavior={
                  NATIVE_LIQUID_GLASS_SUPPORTED ? "automatic" : "never"
                }
                contentContainerStyle={[
                  styles.threadListContent,
                  Platform.OS === "android" ? { paddingHorizontal: 0 } : null,
                  {
                    paddingBottom: Math.max(insets.bottom, 16) + 16,
                    paddingTop: 6,
                  },
                ]}
                keyboardDismissMode="on-drag"
                keyboardShouldPersistTaps="handled"
                {...scrollGateHandlers}
                recycleItems
                scrollEventThrottle={16}
                showsVerticalScrollIndicator={false}
                style={styles.threadList}
                ListEmptyComponent={listEmpty}
              />
            </GestureDetector>
          </SwipeableScrollGateProvider>
        </View>
      </>
    );
  }

  return (
    <View
      testID="thread-navigation-sidebar"
      className={
        Platform.OS === "android" ? "flex-1 bg-header" : "flex-1 border-r border-border bg-drawer"
      }
      style={{ width: props.width }}
    >
      <View
        className="flex-1"
        style={
          Platform.OS === "android"
            ? {
                marginTop: stickyHeaderHeight,
                marginHorizontal: 4,
                paddingBottom: insets.bottom,
                backgroundColor: drawerColor,
                borderTopLeftRadius: 28,
                borderTopRightRadius: 28,
                overflow: "hidden",
              }
            : { paddingBottom: insets.bottom }
        }
      >
        {Platform.OS === "android" && listItems.length === 0 ? (
          <View className="flex-1 items-center justify-center">{listEmpty}</View>
        ) : (
          <SwipeableScrollGateProvider enabled={swipeEnabled}>
            <GestureDetector gesture={sidebarScrollGesture}>
              <LegendList
                data={listItems}
                drawDistance={500}
                estimatedItemSize={64}
                extraData={listExtraData}
                getItemType={(item) => item.type}
                itemsAreEqual={sidebarItemsAreEqual}
                keyExtractor={(item) => item.key}
                renderItem={renderListItem}
                contentContainerStyle={[
                  styles.threadListContent,
                  Platform.OS === "android" ? { paddingHorizontal: 0 } : null,
                  {
                    paddingBottom:
                      Platform.OS === "android"
                        ? Math.max(insets.bottom, 16) + fabClearance - insets.bottom
                        : 16 + insets.bottom,
                    paddingTop: Platform.OS === "android" ? 6 : topListInset,
                  },
                ]}
                keyboardDismissMode="on-drag"
                keyboardShouldPersistTaps="handled"
                {...scrollGateHandlers}
                recycleItems
                scrollEventThrottle={16}
                showsVerticalScrollIndicator={false}
                style={styles.threadList}
                ListEmptyComponent={listEmpty}
              />
            </GestureDetector>
          </SwipeableScrollGateProvider>
        )}
      </View>

      {Platform.OS === "android" ? (
        <MaterialThreadListToolbar
          sidebar
          onLayout={handleStickyHeaderLayout}
          searchQuery={props.searchQuery}
          onSearchQueryChange={props.onSearchQueryChange}
          filterActions={listMenuActions}
          filterCustomized={filterCustomized}
          onFilterAction={handleListMenuAction}
          onOpenSettings={props.onOpenSettings}
          onOpenEnvironments={props.onOpenEnvironmentSettings}
          onRequestVisibility={props.onRequestVisibility}
        />
      ) : (
        <View
          className="absolute inset-x-0 top-0 z-[4] bg-drawer"
          collapsable={false}
          onLayout={handleStickyHeaderLayout}
          pointerEvents="auto"
          style={{ paddingTop: insets.top }}
        >
          <View className="h-[50px] flex-row items-end gap-0.5 pr-2 pl-5">
            {/* Title slot doubles as the connection status surface: while a
              host reconnects, the brand fades to a status label in place (no
              layout shift in the list below). */}
            <WorkspaceConnectionTitle
              grow
              onPress={props.onOpenEnvironmentSettings}
              size="pageTitle"
              brand={
                <View className="h-11 flex-1 justify-center">
                  <CompactBrandTitle allowFontScaling={false} />
                </View>
              }
            />
            <View className="flex-row items-center gap-2.5">
              <ControlPillMenu actions={listMenuActions} onPressAction={handleListMenuAction}>
                <SidebarFilterButton accessibilityLabel="Filter threads" icon={filterIcon} />
              </ControlPillMenu>
              <SidebarHeaderActions onOpenSettings={props.onOpenSettings} />
            </View>
          </View>

          <View className="mx-4 mt-[9px] h-[38px] flex-row items-center gap-1.5 rounded-xl bg-sidebar-search pr-2.5 pl-[11px]">
            <SymbolView
              name="magnifyingglass"
              size={15}
              tintColorClassName="accent-drawer-foreground-muted"
              type="monochrome"
            />
            <TextInput
              ref={searchInputRef}
              accessibilityLabel="Search threads"
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
              onChangeText={props.onSearchQueryChange}
              placeholder="Search"
              placeholderTextColorClassName="accent-placeholder"
              returnKeyType="search"
              className="h-[34px] flex-1 px-0 py-0 font-sans text-base text-drawer-foreground"
              value={props.searchQuery}
            />
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  threadList: {
    flex: 1,
  },
  threadListContent: {
    paddingHorizontal: 8,
  },
});
