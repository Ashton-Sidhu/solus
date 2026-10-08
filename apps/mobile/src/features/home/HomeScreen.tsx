// Adapted from T3 Code apps/mobile/src/features/home/HomeScreen.tsx (MIT, see UPSTREAM.md).
import { useAndroidControlSizing } from "../../components/useAndroidControlSizing";
import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  View,
  type GestureResponderEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { cn } from "../../lib/cn";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { MaterialFloatingActionButton } from "../../components/MaterialFloatingActionButton";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import type { SolusProjectShell, SolusThreadShell } from "../threads/thread-directory";
import {
  ThreadListV2Row,
  ThreadListV2SettledShelfHeader,
  ThreadListV2ShowMoreRow,
  ThreadListV2SnoozedShelfHeader,
} from "../threads/thread-list-v2-items";
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
  threadListV2ListItemsAreEqual,
  threadFaviconRoot,
  threadProjectFallbackTitle,
  threadProjectKey,
  THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  THREAD_LIST_V2_SETTLED_PAGE_COUNT,
  type ThreadListV2Facts,
  type ThreadListV2ListItem,
  type ThreadPrWatchTarget,
} from "../threads/threadListV2";
import type { ThreadListShelfExpansion } from "../threads/thread-list-state";
import type { HomeListFilterMenuEnvironment } from "./home-list-filter-menu";
import { buildHomeProjectScopes, sortHomeProjectScopes } from "./homeThreadList";
import { createSwipeRowActivation } from "./swipe-row-activation";
import { SwipeableScrollGateProvider, useSwipeableScrollGate } from "./thread-swipe-actions";
import { useMaterialFabScroll } from "./MaterialFabScrollContext";
import { deriveHomeEmptyState } from "./home-empty-state";
import type { WorkspaceState } from "./workspace-connection-status";

/* ─── Types ──────────────────────────────────────────────────────────── */

interface HomeScreenProps {
  readonly projects: ReadonlyArray<SolusProjectShell>;
  readonly threads: ReadonlyArray<SolusThreadShell>;
  readonly facts: ThreadListV2Facts;
  readonly shelfExpansion: ThreadListShelfExpansion;
  readonly catalogState: WorkspaceState;
  readonly environments: ReadonlyArray<HomeListFilterMenuEnvironment>;
  readonly searchQuery: string;
  readonly selectedEnvironmentId: string | null;
  readonly selectedProjectKey: string | null;
  readonly onAddConnection: () => void;
  /** Dials every saved host again now. */
  readonly onRetryHosts: () => void;
  readonly onOpenHosts: () => void;
  readonly onSelectThread: (thread: SolusThreadShell) => void;
  /** Resolves true iff the settle was dispatched and succeeded. */
  readonly onSettleThread: (thread: SolusThreadShell) => Promise<boolean>;
  readonly onSnoozeThread: (thread: SolusThreadShell, snoozedUntil: number) => Promise<boolean>;
  readonly onUnsnoozeThread: (thread: SolusThreadShell) => Promise<boolean>;
  readonly onUnsettleThread: (thread: SolusThreadShell) => void;
  readonly onSetPullRequestWatch: (thread: SolusThreadShell, target: ThreadPrWatchTarget, watching: boolean) => void;
  readonly onRenameThread: (thread: SolusThreadShell) => void;
  readonly onToggleShelf: (shelf: keyof ThreadListShelfExpansion) => void;
}

/* ─── Layout constants ───────────────────────────────────────────────── */

// v2 rows are mixed-height: settled slim rows run ~60dp, single-line cards
// ~74dp, two-line cards ~94dp. An estimate at or below the average row height
// starts LegendList's container pool at or above the item count for short
// lists.
const ESTIMATED_THREAD_LIST_V2_ROW_HEIGHT = 72;
// Rows away from the viewport are cheap dormant frames (see
// swipe-row-activation), so render further ahead: a fast fling then reaches
// rows that are already built instead of rows still being rebuilt.
const THREAD_LIST_V2_DRAW_DISTANCE = 1_000;
const PRE_LIQUID_GLASS_BOTTOM_TOOLBAR_HEIGHT = 44;

/** EmptyState's own button look, for a state with more than one action. */
function HomeEmptyButton(props: {
  readonly label: string;
  readonly tone: "primary" | "plain";
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      className={cn(
        "min-h-11 items-center justify-center rounded-full px-5 py-3 active:opacity-70",
        props.tone === "primary" && "bg-primary",
      )}
      onPress={props.onPress}
    >
      <Text
        className={cn(
          "text-sm font-t3-bold",
          props.tone === "primary" ? "text-primary-foreground" : "text-primary-text",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function HomeTopContentSpacer() {
  return <View className="h-4" />;
}

const currentMinute = () => Math.floor(Date.now() / 60_000) * 60_000;

/* ─── Main screen ────────────────────────────────────────────────────── */

export function HomeScreen(props: HomeScreenProps) {
  const openSwipeableRef = useRef<SwipeableMethods | null>(null);
  const insets = useSafeAreaInsets();
  const { fabClearance } = useAndroidControlSizing();
  const iosBottomToolbarClearance =
    Platform.OS === "ios" && !NATIVE_LIQUID_GLASS_SUPPORTED
      ? PRE_LIQUID_GLASS_BOTTOM_TOOLBAR_HEIGHT
      : 0;
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

  const handleScrollBeginDrag = useCallback(() => {
    openSwipeableRef.current?.close();
  }, []);
  const onMaterialFabScroll = useMaterialFabScroll();
  const listRef = useRef<LegendListRef>(null);
  const swipeRowActivation = useMemo(() => createSwipeRowActivation(), []);
  const activateVisibleRows = useCallback(
    (rows: ReadonlyArray<ThreadListV2ListItem>) => {
      const state = listRef.current?.getState();
      if (state === undefined || !(state.end >= 0)) return;
      swipeRowActivation.activate(
        rows.slice(Math.max(0, state.start - 2), state.end + 3).map((row) => row.key),
      );
    },
    [swipeRowActivation],
  );
  // Status-bar, accessibility and programmatic scrolls never arm the scroll
  // gate, so every scroll also activates the visible rows once it settles.
  const activationTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(activationTimerRef.current), []);
  const handleListScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      onMaterialFabScroll?.(event);
      clearTimeout(activationTimerRef.current);
      activationTimerRef.current = setTimeout(
        () => activateVisibleRows((listRef.current?.getState().data ?? []) as ThreadListV2ListItem[]),
        200,
      );
    },
    [activateVisibleRows, onMaterialFabScroll],
  );
  const trackListTouches = useCallback(
    (event: GestureResponderEvent, started: boolean) => {
      const { changedTouches, touches } = event.nativeEvent;
      swipeRowActivation.trackTouches(
        started ? changedTouches.map((touch) => String(touch.identifier)) : [],
        touches.map((touch) => String(touch.identifier)),
      );
    },
    [swipeRowActivation],
  );
  const { swipeEnabled, scrollGateHandlers } = useSwipeableScrollGate({
    onScroll: handleListScroll,
    onScrollBeginDrag: handleScrollBeginDrag,
  });

  const knownProjectKeys = useMemo(
    () => new Set(props.projects.map((project) => project.key)),
    [props.projects],
  );
  const projectScopes = useMemo(
    () =>
      sortHomeProjectScopes({
        scopes: buildHomeProjectScopes({
          projects: props.projects,
          hostId: props.selectedEnvironmentId,
        }),
        threads: props.threads,
        knownProjectKeys,
      }),
    [knownProjectKeys, props.projects, props.selectedEnvironmentId, props.threads],
  );
  const hasSearchQuery = props.searchQuery.trim().length > 0;
  const projectByKey = useMemo(() => {
    const map = new Map<string, SolusProjectShell>();
    for (const project of props.projects) map.set(project.key, project);
    return map;
  }, [props.projects]);

  const v2ProjectScopeKey = props.selectedProjectKey;
  const v2ScopedProjectGroup = useMemo(
    () =>
      v2ProjectScopeKey === null
        ? null
        : (projectScopes.find((scope) => scope.key === v2ProjectScopeKey) ?? null),
    [v2ProjectScopeKey, projectScopes],
  );
  const v2ProjectTitleByProjectKey = useMemo(
    () =>
      new Map(
        projectScopes.flatMap((scope) =>
          Array.from(scope.projectKeys, (projectKey) => [projectKey, scope.title] as const),
        ),
      ),
    [projectScopes],
  );
  // Thread List v2: one flat list, newest first, no grouping. Settled
  // threads collapse into a recency tail below the card block.
  const handleSettleThread = props.onSettleThread;
  const handleSnoozeThread = useCallback(
    (thread: SolusThreadShell, snoozedUntil: number) => {
      void props.onSnoozeThread(thread, snoozedUntil);
    },
    [props.onSnoozeThread],
  );
  const handleUnsnoozeThread = useCallback(
    (thread: SolusThreadShell) => {
      void props.onUnsnoozeThread(thread);
    },
    [props.onUnsnoozeThread],
  );
  const handleRenameThread = useCallback(
    (thread: SolusThreadShell) => props.onRenameThread(thread),
    [props.onRenameThread],
  );
  const handleUnsettleThread = props.onUnsettleThread;
  // The settled tail renders in pages; expansion resets when the filter
  // context changes so environment/search flips never inherit a deep page.
  const [settledVisibleCount, setSettledVisibleCount] = useState(
    THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  );
  const settledResetKey = `${props.selectedEnvironmentId ?? "all"}:${v2ProjectScopeKey ?? "all"}:${props.searchQuery.trim()}`;
  const lastSettledResetKeyRef = useRef(settledResetKey);
  if (lastSettledResetKeyRef.current !== settledResetKey) {
    lastSettledResetKeyRef.current = settledResetKey;
    setSettledVisibleCount(THREAD_LIST_V2_SETTLED_INITIAL_COUNT);
  }
  const showMoreSettled = useCallback(
    () => setSettledVisibleCount((count) => count + THREAD_LIST_V2_SETTLED_PAGE_COUNT),
    [],
  );
  const settledShelfExpanded = props.shelfExpansion.settled;
  const snoozedShelfExpanded = props.shelfExpansion.snoozed;
  const toggleSettledShelf = useCallback(() => props.onToggleShelf("settled"), [props.onToggleShelf]);
  const toggleSnoozedShelf = useCallback(() => props.onToggleShelf("snoozed"), [props.onToggleShelf]);
  // The snooze helpers need a clock while the list stays open.
  const [nowMinute, setNowMinute] = useState(currentMinute);
  // Snooze wake times are second-precise; a counter bumped exactly at the
  // next wake boundary re-runs the partition with a fresh clock so a woken
  // thread reappears immediately instead of on the next minute tick.
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);
  useFocusEffect(
    useCallback(() => {
      // Refresh immediately on focus because the previous value can be hours old.
      setNowMinute(currentMinute());
      const id = setInterval(() => setNowMinute(currentMinute()), 60_000);
      return () => clearInterval(id);
    }, []),
  );
  const threadListV2Layout = useMemo(
    () =>
      buildThreadListV2Items({
        threads: props.threads,
        facts: props.facts,
        hostId: props.selectedEnvironmentId,
        projectKeys: v2ScopedProjectGroup === null ? null : v2ScopedProjectGroup.projectKeys,
        knownProjectKeys,
        searchQuery: props.searchQuery,
        settledLimit: settledVisibleCount,
        now: Date.now(),
        snoozedShelfExpanded,
        settledShelfExpanded,
        selectedThreadKey: null,
      }),
    [
      knownProjectKeys,
      nowMinute,
      snoozeWakeTick,
      snoozedShelfExpanded,
      settledShelfExpanded,
      settledVisibleCount,
      props.facts,
      props.searchQuery,
      props.selectedEnvironmentId,
      props.threads,
      v2ScopedProjectGroup,
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
  const threadListV2Items = useMemo(
    () =>
      buildThreadListV2ListItems({
        items: threadListV2Layout.items,
        facts: props.facts,
        snoozedCount: threadListV2Layout.snoozedCount,
        snoozedShelfExpanded,
        snoozedShelfHeaderIndex: threadListV2Layout.snoozedShelfHeaderIndex,
        settledCount: threadListV2Layout.settledCount,
        settledShelfExpanded,
        settledShelfHeaderIndex: threadListV2Layout.settledShelfHeaderIndex,
        now: nowMinute,
      }),
    [
      nowMinute,
      props.facts,
      settledShelfExpanded,
      snoozedShelfExpanded,
      threadListV2Layout,
    ],
  );

  useEffect(() => {
    if (swipeEnabled) activateVisibleRows(threadListV2Items);
  }, [activateVisibleRows, swipeEnabled, threadListV2Items]);

  const environmentLabelFor = useCallback(
    (thread: SolusThreadShell) => (props.environments.length > 1 ? thread.hostLabel : null),
    [props.environments.length],
  );

  const renderV2Item = useCallback(
    ({ item }: { readonly item: ThreadListV2ListItem }) => {
      if (item.type === "v2-snoozed-shelf") {
        return (
          <ThreadListV2SnoozedShelfHeader
            count={item.count}
            disabled={item.disabled}
            expanded={item.expanded}
            onToggle={toggleSnoozedShelf}
          />
        );
      }
      if (item.type === "v2-settled-shelf") {
        return (
          <ThreadListV2SettledShelfHeader
            count={item.count}
            disabled={item.disabled}
            expanded={item.expanded}
            onToggle={toggleSettledShelf}
          />
        );
      }
      const thread = item.item.thread;
      const projectKey = threadProjectKey(thread, knownProjectKeys);
      const project = projectByKey.get(projectKey) ?? null;
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
          showTrailingDivider={item.showTrailingDivider}
          projectPath={threadFaviconRoot(thread.record, project?.project.path ?? null)}
          projectTitle={
            v2ProjectTitleByProjectKey.get(projectKey) ?? threadProjectFallbackTitle(thread.record)
          }
          environmentLabel={environmentLabelFor(thread)}
          onSelectThread={props.onSelectThread}
          onRenameThread={handleRenameThread}
          onSettleThread={handleSettleThread}
          onSnoozeThread={handleSnoozeThread}
          onUnsnoozeThread={handleUnsnoozeThread}
          onUnsettleThread={handleUnsettleThread}
          onSetPullRequestWatch={props.onSetPullRequestWatch}
          onSwipeableClose={handleSwipeableClose}
          onSwipeableWillOpen={handleSwipeableWillOpen}
          activationKey={item.key}
        />
      );
    },
    [
      environmentLabelFor,
      handleRenameThread,
      handleSettleThread,
      handleSnoozeThread,
      handleSwipeableClose,
      handleSwipeableWillOpen,
      handleUnsettleThread,
      handleUnsnoozeThread,
      knownProjectKeys,
      projectByKey,
      props.onSelectThread,
      toggleSettledShelf,
      toggleSnoozedShelf,
      v2ProjectTitleByProjectKey,
    ],
  );
  const v2KeyExtractor = useCallback((item: ThreadListV2ListItem) => item.key, []);

  // FlatList/LegendList treat a changed extraData identity as "re-render every
  // visible row", so an inline object literal would invalidate all rows on
  // every HomeScreen render — and the minute clock must stay out of it for
  // the same reason: the clock text is precomputed per item instead.
  const v2ExtraData = useMemo(
    () => ({
      projectByKey,
      projectTitleByProjectKey: v2ProjectTitleByProjectKey,
      environmentCount: props.environments.length,
    }),
    [projectByKey, props.environments.length, v2ProjectTitleByProjectKey],
  );

  /* Empty states */
  // The signal must ignore the search/environment filters: an active query
  // that matches nothing needs the in-list "No results" state, not the
  // full-page "No threads yet".
  const hasAnyThreads = props.threads.length > 0;
  const selectedEnvironmentLabel =
    props.selectedEnvironmentId === null
      ? null
      : (props.environments.find(
          (environment) => environment.environmentId === props.selectedEnvironmentId,
        )?.label ?? "this host");
  // Connection state surfaces in the header title slot
  // (WorkspaceConnectionTitle) — nothing renders inside the list, so
  // reconnects never shift the rows.
  const emptyState = deriveHomeEmptyState({
    catalogState: props.catalogState,
    projectCount: props.projects.length,
  });

  if (!hasAnyThreads) {
    return (
      <View className="flex-1 bg-screen android:bg-header">
        <View
          className={cn(
            "flex-1 items-center justify-center bg-screen px-8",
            Platform.OS === "android" && "overflow-hidden rounded-t-[28px]",
          )}
          style={{
            paddingBottom: Math.max(insets.bottom, 24) + iosBottomToolbarClearance,
            paddingTop: NATIVE_LIQUID_GLASS_SUPPORTED ? insets.top + 72 : 0,
          }}
        >
          <View className="w-full max-w-[430px]">
            <EmptyState
              title={emptyState.title}
              detail={emptyState.detail}
              action={
                emptyState.action === "add-host" ? (
                  Platform.OS === "android" ? (
                    <MaterialFloatingActionButton
                      label="Add host"
                      icon="plus"
                      variant="extended"
                      tone="primary"
                      onPress={props.onAddConnection}
                    />
                  ) : (
                    <HomeEmptyButton label="Add host" tone="primary" onPress={props.onAddConnection} />
                  )
                ) : emptyState.action === "retry-hosts" ? (
                  <View className="items-center gap-2">
                    <HomeEmptyButton label="Try again" tone="primary" onPress={props.onRetryHosts} />
                    <HomeEmptyButton label="Manage hosts" tone="plain" onPress={props.onOpenHosts} />
                  </View>
                ) : undefined
              }
              variant="plain"
            />
            {emptyState.loading ? (
              <View className="mt-4 items-center">
                <ActivityIndicator colorClassName="accent-icon-muted" />
              </View>
            ) : null}
          </View>
        </View>
      </View>
    );
  }

  const listHeader = Platform.OS === "ios" ? undefined : <HomeTopContentSpacer />;

  // Project scoping lives in the header filter menu (no inline chip row on
  // mobile — the menu is the one filter surface).
  const v2ListHeader = listHeader;

  // Use the v2 project scope for its empty state. Snoozed threads need no
  // special empty state: their shelf header is a list row even while collapsed.
  const v2ListEmpty = hasSearchQuery ? (
    <EmptyState
      title="No results"
      detail={`No threads matching "${props.searchQuery}".`}
      variant={Platform.OS === "android" ? "plain" : undefined}
    />
  ) : v2ScopedProjectGroup !== null ? (
    <EmptyState
      title={`No threads in ${v2ScopedProjectGroup.title}`}
      detail="Choose another project or create a new task."
      variant={Platform.OS === "android" ? "plain" : undefined}
    />
  ) : selectedEnvironmentLabel ? (
    <EmptyState
      title={`No threads in ${selectedEnvironmentLabel}`}
      detail="Choose another host or create a new task."
      variant={Platform.OS === "android" ? "plain" : undefined}
    />
  ) : (
    <EmptyState
      title="No threads yet"
      detail="Create a task to start a new coding session."
      variant={Platform.OS === "android" ? "plain" : undefined}
    />
  );

  if (Platform.OS === "android" && threadListV2Items.length === 0) {
    return (
      <View className="flex-1 bg-header">
        <View
          className="flex-1 items-center justify-center overflow-hidden rounded-t-[28px] bg-screen px-4"
          style={{ paddingBottom: insets.bottom }}
        >
          {v2ListEmpty}
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-screen android:bg-header">
      <View
        className={
          Platform.OS === "android"
            ? "flex-1 overflow-hidden rounded-t-[28px] bg-screen"
            : "flex-1 bg-screen"
        }
      >
        {/* Shared with the iPad sidebar: cells are reused across data
            rebuilds and `itemsAreEqual` keeps a minute tick (or an unrelated
            shell update) from re-rendering untouched rows. */}
        <SwipeableScrollGateProvider enabled={swipeEnabled} activation={swipeRowActivation}>
          <LegendList
            ref={listRef}
            onLoad={() => activateVisibleRows(threadListV2Items)}
            onTouchStart={(event) => trackListTouches(event, true)}
            onTouchEnd={(event) => trackListTouches(event, false)}
            onTouchCancel={(event) => trackListTouches(event, false)}
            data={threadListV2Items}
            renderItem={renderV2Item}
            keyExtractor={v2KeyExtractor}
            getItemType={(item) => item.type}
            itemsAreEqual={threadListV2ListItemsAreEqual}
            estimatedItemSize={ESTIMATED_THREAD_LIST_V2_ROW_HEIGHT}
            drawDistance={THREAD_LIST_V2_DRAW_DISTANCE}
            recycleItems
            extraData={v2ExtraData}
            ListHeaderComponent={v2ListHeader}
            ListFooterComponent={
              settledShelfExpanded && threadListV2Layout.hiddenSettledCount > 0 ? (
                <ThreadListV2ShowMoreRow
                  hiddenCount={threadListV2Layout.hiddenSettledCount}
                  onPress={showMoreSettled}
                />
              ) : null
            }
            ListEmptyComponent={v2ListEmpty}
            style={{ flex: 1 }}
            automaticallyAdjustsScrollIndicatorInsets={Platform.OS === "ios"}
            contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
            showsVerticalScrollIndicator={false}
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
            {...scrollGateHandlers}
            scrollEventThrottle={16}
            contentContainerStyle={{
              paddingBottom:
                Platform.OS === "ios"
                  ? Math.max(insets.bottom, 24) + 96 + iosBottomToolbarClearance
                  : Math.max(insets.bottom, 16) + (Platform.OS === "android" ? fabClearance : 88),
            }}
          />
        </SwipeableScrollGateProvider>
      </View>
    </View>
  );
}
