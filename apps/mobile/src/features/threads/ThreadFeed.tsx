// Adapted from T3 Code apps/mobile/src/features/threads/ThreadFeed.tsx (MIT, see UPSTREAM.md).
import * as Haptics from "expo-haptics";
import { KeyboardAwareLegendList } from "@legendapp/list/keyboard";
import type { LegendListRef } from "@legendapp/list/react-native";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
  type ColorValue,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import Animated, { FadeIn, FadeInUp, type SharedValue } from "react-native-reanimated";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { CopyTextButton } from "../../components/CopyTextButton";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import {
  deriveThreadFeedColumn,
  deriveThreadFeedInitialContentInset,
  deriveThreadWorkLogSizing,
  type LayoutVariant,
} from "../../lib/layout";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useListened } from "../../app/app-context";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import type { ConversationStore } from "../conversation/conversation-store";
import {
  deriveThreadFeedPresentation,
  type FeedSourceEntry,
  type ThreadFeedRow,
} from "./thread-feed-presentation";
import { resolveThreadFeedLiveFollow, type ThreadFeedLiveFollowEvent } from "./thread-feed-live-follow";
import {
  THREAD_DISCLOSURE_TRANSITION_MS,
  ThreadDisclosureChevron,
  ThreadThinkingRow,
  ThreadWorkGroupToggle,
  ThreadWorkLog,
} from "./thread-work-log";
import { WorkLogBlock, WorkLogIconSlot, WorkLogPressable } from "./work-log-layout";
import { ThreadMarkdown } from "./ThreadMarkdown";
import { MarkdownImageAvailableWidthContext } from "./ThreadMarkdownImage";
import { MessageAttachments } from "./MessageAttachments";
import { ThreadAgentGroup } from "./ThreadAgents";
import { ThreadPlanCard } from "./ThreadPlanCard";
import { WorktreeOfferCard } from "./WorktreeOfferCard";
import { useTranscriptItem } from "./use-transcript-items";

const TURN_FOLD_HEIGHT = 42; // min-h-11 (38.5) + mb-1 (3.5), with the mobile 14px rem
// Let neighboring rows move out of the new rows' space before showing their text.
const THREAD_FEED_DISCLOSURE_ENTER_TRANSITION = FadeIn.delay(
  THREAD_DISCLOSURE_TRANSITION_MS,
).duration(140);

/** What the feed shows in place of rows: loading, a failed open, or the conversation. */
export type ThreadContentPresentation =
  | { readonly kind: "loading" }
  | { readonly kind: "ready" }
  | { readonly kind: "unavailable"; readonly title: string; readonly detail: string };

export interface ThreadFeedHistoryControls {
  readonly hasMoreHistory: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onLoadEarlier: () => void;
}

export interface ThreadFeedProps {
  readonly store: ConversationStore;
  readonly threadKey: string;
  readonly contentPresentation: ThreadContentPresentation;
  /** The last turn has not settled. */
  readonly turnActive: boolean;
  /** The agent is producing output now. */
  readonly working: boolean;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly freeze: SharedValue<boolean>;
  readonly submittedMessageId: string | null;
  readonly contentInsetEndAdjustment: SharedValue<number>;
  readonly contentBottomInset?: number;
  readonly historyControls?: ThreadFeedHistoryControls;
  readonly contentMaxWidth?: number;
  readonly layoutVariant?: LayoutVariant;
  readonly usesAutomaticContentInsets?: boolean;
  readonly onEndFollowEnabledChange?: (enabled: boolean) => void;
}

interface FeedInteractionState {
  readonly copiedRowId: string | null;
  readonly expandedWorkGroups: ReadonlySet<string>;
  readonly expandedWorkRows: Readonly<Record<string, boolean>>;
  readonly expandedTurnIds: ReadonlySet<string>;
}

interface FeedRowContext {
  readonly store: ConversationStore;
  readonly copiedRowId: string | null;
  readonly expandedWorkRows: Readonly<Record<string, boolean>>;
  readonly workRowSizing: ReturnType<typeof deriveThreadWorkLogSizing>;
  readonly iconSubtleColor: ColorValue;
  readonly screenColor: string;
  readonly userBubbleColor: ColorValue;
  readonly userBubbleMaxWidth: number;
  readonly onCopyWorkRow: (rowId: string, value: string) => void;
  readonly onToggleWorkGroup: (groupId: string, anchorKey: string) => void;
  readonly onToggleWorkRow: (rowId: string, anchorKey: string) => void;
  readonly onToggleTurnFold: (turnId: string) => void;
}

/** A prompt the person sent, with its delivery state where it has not landed yet. */
const UserMessageRow = memo(function UserMessageRow(props: {
  readonly store: ConversationStore;
  readonly id: string;
  readonly userBubbleColor: ColorValue;
  readonly userBubbleMaxWidth: number;
  readonly iconSubtleColor: ColorValue;
}) {
  const item = useTranscriptItem(props.store, props.id);
  if (item?.kind !== "user") return null;
  // Not yet confirmed by the host; "Queued" waits behind the running turn or the connection.
  const pending = item.delivery === "sending";
  return (
    <Animated.View
      className="mb-5 items-end"
      {...(item.delivery === "sending" ? { entering: FadeInUp.duration(220) } : {})}
    >
      <View
        className="min-w-0 gap-2 rounded-[20px] px-3.5 py-2.5"
        style={{ backgroundColor: props.userBubbleColor, maxWidth: props.userBubbleMaxWidth }}
      >
        <MessageAttachments
          attachments={item.attachments}
          cacheKey={`${props.store.controller.run.sessionId}-${item.id}`}
          // The bubble's inner width: its max less `px-3.5` (14pt) each side.
          width={props.userBubbleMaxWidth - 28}
          store={props.store}
        />
        {item.text.trim().length > 0 ? <ThreadMarkdown markdown={item.text} tone="user" store={props.store} /> : null}
      </View>
      <View className="mt-1 flex-row items-center justify-end gap-1 pr-0.5">
        {item.delivery === "queued" ? (
          <View
            accessible
            accessibilityRole="text"
            accessibilityLabel="Queued"
            className="rounded-full border border-adaptive-amber-500-a25-400-a25 bg-adaptive-amber-500-a10-400-a10 px-1.5 py-0.5"
          >
            <Text className="font-t3-medium text-2xs tracking-wide text-adaptive-amber-700-300">
              Queued
            </Text>
          </View>
        ) : null}
        {pending ? (
          <Text className="font-t3-medium text-xs tabular-nums text-foreground-secondary">Pending</Text>
        ) : null}
        {item.delivery === "failed" ? (
          <Text className="font-t3-medium text-xs text-danger-foreground" numberOfLines={2}>
            {item.error && item.error !== "Not sent." ? `Not sent: ${item.error}` : "Not sent"}
          </Text>
        ) : null}
        {item.delivery === "failed" && item.error !== "Not sent." ? (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send again"
              hitSlop={8}
              className="size-7 items-center justify-center"
              onPress={() => void props.store.controller.retry(item.id)}
            >
              <SymbolView name="arrow.clockwise" size={14} tintColor={props.iconSubtleColor} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Remove message"
              hitSlop={8}
              className="size-7 items-center justify-center"
              onPress={() => props.store.controller.discard(item.id)}
            >
              <SymbolView name="xmark" size={14} tintColor={props.iconSubtleColor} />
            </Pressable>
          </>
        ) : null}
        {item.text.trim().length > 0 ? (
          <CopyTextButton
            accessibilityLabel="Copy message"
            text={item.text}
            tintColor={props.iconSubtleColor}
            buttonSize={28}
            iconSize={13}
          />
        ) : null}
      </View>
    </Animated.View>
  );
});

/** Agent prose. The final message of a settled turn carries its copy control. */
const AssistantMessageRow = memo(function AssistantMessageRow(props: {
  readonly store: ConversationStore;
  readonly id: string;
  readonly showMeta: boolean;
  readonly iconSubtleColor: ColorValue;
}) {
  const item = useTranscriptItem(props.store, props.id);
  if (item?.kind !== "assistant" || item.text.trim().length === 0) return null;
  return (
    <Animated.View className={props.showMeta ? "mb-5 px-1" : "mb-1 px-1"}>
      <ThreadMarkdown markdown={item.text} tone="assistant" store={props.store} />
      {props.showMeta ? (
        <View className="mt-1 flex-row items-center gap-1">
          <CopyTextButton
            accessibilityLabel="Copy message"
            text={item.text}
            tintColor={props.iconSubtleColor}
            buttonSize={28}
            iconSize={13}
          />
        </View>
      ) : null}
    </Animated.View>
  );
});

/** A host notice in the work log: an error reads in rose, information quietly. */
const NoticeRow = memo(function NoticeRow(props: {
  readonly store: ConversationStore;
  readonly id: string;
  readonly iconSubtleColor: ColorValue;
}) {
  const item = useTranscriptItem(props.store, props.id);
  if (item?.kind !== "notice") return null;
  const error = item.tone === "error";
  return (
    <WorkLogBlock>
      <WorkLogPressable
        accessibilityLabel={item.text}
        accessibilityHint="Long press to copy."
        onLongPress={() => copyTextWithHaptic(item.text, { target: "thread-work-row", feedback: "selection" })}
      >
        <View className="flex-1 py-1">
          <View className="flex-row items-center gap-1.5">
            <WorkLogIconSlot>
              <SymbolView
                name={error ? "exclamationmark.circle" : "info.circle"}
                size={14}
                weight="medium"
                {...(error
                  ? { tintColorClassName: "accent-danger-foreground" }
                  : { tintColor: props.iconSubtleColor })}
                type="monochrome"
              />
            </WorkLogIconSlot>
            <Text
              className={
                error
                  ? "min-w-0 flex-1 font-t3-medium text-sm text-adaptive-rose-600-400"
                  : "min-w-0 flex-1 text-sm text-foreground-muted"
              }
            >
              {item.text}
            </Text>
          </View>
        </View>
      </WorkLogPressable>
    </WorkLogBlock>
  );
});

const PlanRow = memo(function PlanRow(props: { readonly store: ConversationStore; readonly id: string }) {
  const item = useTranscriptItem(props.store, props.id);
  if (item?.kind !== "plan") return null;
  return <ThreadPlanCard store={props.store} plan={item} />;
});

const WorktreeOfferRow = memo(function WorktreeOfferRow(props: { readonly store: ConversationStore; readonly id: string }) {
  const item = useTranscriptItem(props.store, props.id);
  if (item?.kind !== "worktree_offer") return null;
  return <WorktreeOfferCard store={props.store} offer={item} />;
});

function renderFeedEntry(row: ThreadFeedRow, context: FeedRowContext) {
  if (row.type === "run-fold") {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: row.expanded }}
        onPress={() => context.onToggleTurnFold(row.turnId)}
        hitSlop={4}
        className="mb-1 min-h-11 flex-row items-center gap-2 border-b border-border-subtle px-2"
        style={{
          minHeight: Math.max(TURN_FOLD_HEIGHT - 3.5, context.workRowSizing.estimatedRowHeight),
        }}
      >
        <Text
          key={context.workRowSizing.textSizeKey}
          className="font-t3-medium text-sm tabular-nums text-foreground-muted"
        >
          {row.label}
        </Text>
        <ThreadDisclosureChevron
          expanded={row.expanded}
          collapsedDirection="right"
          size={15}
          tintColor={context.iconSubtleColor}
        />
      </Pressable>
    );
  }

  if (row.type === "thinking") {
    return <ThreadThinkingRow rowSizing={context.workRowSizing} iconSubtleColor={context.iconSubtleColor} />;
  }

  if (row.type === "work-toggle") {
    return (
      <ThreadWorkGroupToggle
        store={context.store}
        toolIds={row.toolIds}
        rowSizing={context.workRowSizing}
        expanded={row.expanded}
        live={row.live}
        iconSubtleColor={context.iconSubtleColor}
        onToggle={() => context.onToggleWorkGroup(row.groupId, row.id)}
      />
    );
  }

  if (row.type === "work-details") {
    return (
      <ThreadWorkLog
        store={context.store}
        toolIds={row.toolIds}
        continuesWorkLog={row.continuesWorkLog}
        anchorKey={row.id}
        copiedRowId={context.copiedRowId}
        expandedRows={context.expandedWorkRows}
        rowSizing={context.workRowSizing}
        iconSubtleColor={context.iconSubtleColor}
        edgeFadeColor={context.screenColor}
        onCopyRow={context.onCopyWorkRow}
        onToggleRow={context.onToggleWorkRow}
      />
    );
  }

  if (row.type === "notice") {
    return <NoticeRow store={context.store} id={row.id} iconSubtleColor={context.iconSubtleColor} />;
  }

  if (row.type === "plan") {
    return <PlanRow store={context.store} id={row.id} />;
  }

  if (row.type === "worktree-offer") {
    return <WorktreeOfferRow store={context.store} id={row.id} />;
  }

  if (row.type === "agents") {
    return (
      <ThreadAgentGroup
        store={context.store}
        itemIds={row.itemIds}
        expanded={row.expanded}
        iconSubtleColor={context.iconSubtleColor}
        onToggle={() => context.onToggleWorkGroup(row.groupId, row.id)}
      />
    );
  }

  return row.role === "user" ? (
    <UserMessageRow
      store={context.store}
      id={row.id}
      userBubbleColor={context.userBubbleColor}
      userBubbleMaxWidth={context.userBubbleMaxWidth}
      iconSubtleColor={context.iconSubtleColor}
    />
  ) : (
    <AssistantMessageRow
      store={context.store}
      id={row.id}
      showMeta={row.showMeta}
      iconSubtleColor={context.iconSubtleColor}
    />
  );
}

function ThreadFeedPlaceholder(props: {
  readonly bottomInset: number;
  readonly detail: string;
  readonly horizontalPadding: number;
  readonly title: string;
  readonly topInset: number;
}) {
  return (
    <View
      style={{
        flex: 1,
        flexGrow: 1,
        alignItems: "center",
        justifyContent: "center",
        paddingTop: props.topInset,
        paddingBottom: props.bottomInset,
        paddingHorizontal: props.horizontalPadding + 24,
      }}
    >
      <View className="max-w-[320px] items-center gap-2">
        <Text className="text-center font-t3-bold text-lg text-foreground">{props.title}</Text>
        <Text className="text-center text-sm leading-normal text-foreground-secondary">
          {props.detail}
        </Text>
      </View>
    </View>
  );
}

export const ThreadFeed = memo(function ThreadFeed(props: ThreadFeedProps) {
  const { store } = props;
  const copyFeedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userScrollSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const { appearance } = useAppearancePreferences();
  const workRowSizing = useMemo(
    () => deriveThreadWorkLogSizing({ baseFontSize: appearance.baseFontSize, fontScale }),
    [appearance.baseFontSize, fontScale],
  );
  const [viewportWidth, setViewportWidth] = useState(() =>
    props.layoutVariant === "split" ? 0 : windowWidth,
  );
  const [viewportHeight, setViewportHeight] = useState(0);
  // Live-follow latch: follow breaks when the reader scrolls up and away, and
  // re-arms only when the list returns to the end (or on send / thread switch).
  const [endFollowEnabled, setEndFollowEnabled] = useState(true);
  const endFollowEnabledRef = useRef(true);
  const userScrollSessionRef = useRef(false);
  const setEndFollow = useCallback(
    (enabled: boolean) => {
      if (endFollowEnabledRef.current === enabled) {
        return;
      }
      endFollowEnabledRef.current = enabled;
      setEndFollowEnabled(enabled);
      props.onEndFollowEnabledChange?.(enabled);
    },
    [props.onEndFollowEnabledChange],
  );
  const transitionEndFollow = useCallback(
    (event: ThreadFeedLiveFollowEvent) => {
      setEndFollow(resolveThreadFeedLiveFollow(endFollowEnabledRef.current, event));
    },
    [setEndFollow],
  );
  const [interactionState, setInteractionState] = useState<FeedInteractionState>({
    copiedRowId: null,
    expandedWorkGroups: new Set(),
    expandedWorkRows: {},
    expandedTurnIds: new Set(),
  });
  const { copiedRowId, expandedWorkGroups, expandedWorkRows, expandedTurnIds } = interactionState;
  const [disclosureToggleSettling, setDisclosureToggleSettling] = useState(false);
  const horizontalPadding = props.layoutVariant === "split" ? 20 : 16;
  const { contentHorizontalPadding, contentWidth } = deriveThreadFeedColumn({
    viewportWidth,
    contentMaxWidth: props.contentMaxWidth ?? null,
    horizontalPadding,
  });
  const userBubbleMaxWidth = contentWidth * 0.85;
  // Assistant rows are inset by `px-1` (3.5) on each side.
  const markdownContentWidth = Math.max(0, contentWidth - 3.5 * 2);
  const bottomContentInset = props.contentBottomInset ?? 18;
  const usesNativeAutomaticInsets =
    props.usesAutomaticContentInsets === true && Platform.OS === "ios";
  const initialContentInset = deriveThreadFeedInitialContentInset({
    platform: Platform.OS,
    usesNativeAutomaticInsets,
    bottomContentInset,
  });

  const theme = useUniwindTheme();
  const iconSubtleColor = theme["--color-icon-subtle"];
  const screenColor = theme["--color-screen"];
  const userBubbleColor = theme["--color-user-bubble"];

  // Rows are added rarely; a streamed token changes one row's own item only.
  const order = useListened(store.order, store.orderSnapshot);
  const entries = useMemo<FeedSourceEntry[]>(
    () =>
      order.flatMap((id) => {
        const item = store.item(id);
        if (!item) return [];
        // A provider subagent's call is an agent in the feed, not a tool row.
        const kind = item.kind === "tool" && item.subagent ? "agent" : item.kind;
        return [{ id, kind, ...(item.kind === "notice" ? { tone: item.tone } : {}) }];
      }),
    [order, store],
  );
  const presentedFeed = useMemo(
    () =>
      deriveThreadFeedPresentation({
        entries,
        turnActive: props.turnActive,
        working: props.working,
        expandedTurnIds,
        expandedWorkGroupIds: expandedWorkGroups,
      }),
    [entries, expandedTurnIds, expandedWorkGroups, props.turnActive, props.working],
  );

  const handleScroll = useCallback(
    (_event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const listState = props.listRef.current?.getState();
      if (listState) {
        transitionEndFollow({
          type: "scroll",
          isAtEnd: listState.isAtEnd,
          userScrollSessionActive: userScrollSessionRef.current,
        });
      }
    },
    [props.listRef, transitionEndFollow],
  );
  const clearUserScrollSettle = useCallback(() => {
    if (userScrollSettleTimerRef.current !== null) {
      clearTimeout(userScrollSettleTimerRef.current);
      userScrollSettleTimerRef.current = null;
    }
  }, []);
  const handleScrollBeginDrag = useCallback(() => {
    clearUserScrollSettle();
    userScrollSessionRef.current = true;
    transitionEndFollow({ type: "user-scroll-begin" });
  }, [clearUserScrollSettle, transitionEndFollow]);
  const finishUserScroll = useCallback(
    (releaseIsAtEnd?: boolean) => {
      clearUserScrollSettle();
      const userScrollSessionActive = userScrollSessionRef.current;
      userScrollSessionRef.current = false;
      transitionEndFollow({
        type: "user-scroll-end",
        isAtEnd: releaseIsAtEnd ?? props.listRef.current?.getState().isAtEnd ?? false,
        userScrollSessionActive,
      });
    },
    [clearUserScrollSettle, props.listRef, transitionEndFollow],
  );
  // Finger-lift velocity is not a reliable momentum signal: give native
  // momentum a short window to announce itself before ending the session.
  const handleScrollEndDrag = useCallback(() => {
    clearUserScrollSettle();
    const releaseIsAtEnd = props.listRef.current?.getState().isAtEnd ?? false;
    userScrollSettleTimerRef.current = setTimeout(() => finishUserScroll(releaseIsAtEnd), 160);
  }, [clearUserScrollSettle, finishUserScroll, props.listRef]);
  const handleMomentumScrollBegin = useCallback(() => {
    if (userScrollSessionRef.current) {
      clearUserScrollSettle();
    }
  }, [clearUserScrollSettle]);
  const handleMomentumScrollEnd = useCallback(() => {
    finishUserScroll();
  }, [finishUserScroll]);

  useEffect(() => clearUserScrollSettle, [clearUserScrollSettle]);

  // A thread switch opens pinned to the end; a send returns to the live edge.
  useEffect(() => {
    clearUserScrollSettle();
    userScrollSessionRef.current = false;
    transitionEndFollow({ type: "reset" });
  }, [clearUserScrollSettle, props.threadKey, transitionEndFollow]);
  useEffect(() => {
    if (props.submittedMessageId !== null) {
      clearUserScrollSettle();
      userScrollSessionRef.current = false;
      transitionEndFollow({ type: "reset" });
    }
  }, [clearUserScrollSettle, props.submittedMessageId, transitionEndFollow]);

  const handleViewportLayout = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = Math.round(event.nativeEvent.layout.width);
    const nextHeight = Math.round(event.nativeEvent.layout.height);
    setViewportWidth((current) => (Math.abs(current - nextWidth) > 1 ? nextWidth : current));
    setViewportHeight((current) => (Math.abs(current - nextHeight) > 1 ? nextHeight : current));
  }, []);

  // The empty↔filled key remounts the list when rows first arrive, so it opens at the end.
  const listMountKey = `${props.threadKey}:${presentedFeed.some((row) => row.type !== "thinking") ? "filled" : "empty"}`;
  useLayoutEffect(() => {
    const bottom = props.contentInsetEndAdjustment.value;
    if (bottom > 0) {
      props.listRef.current?.reportContentInset({ bottom });
    }
  }, [listMountKey, props.contentInsetEndAdjustment, props.listRef]);

  useEffect(
    () => () => {
      if (copyFeedbackTimeoutRef.current) {
        clearTimeout(copyFeedbackTimeoutRef.current);
      }
    },
    [],
  );

  // A disclosure can move the reader off the end without a drag; reconcile
  // follow once the list has settled the new layout.
  const settleDisclosure = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const listState = props.listRef.current?.getState();
        if (listState) {
          transitionEndFollow({
            type: "disclosure-settled",
            isAtEnd: listState.isAtEnd,
            userScrollSessionActive: userScrollSessionRef.current,
          });
        }
        setDisclosureToggleSettling(false);
      });
    });
  }, [props.listRef, transitionEndFollow]);

  const onCopyWorkRow = useCallback((rowId: string, value: string) => {
    copyTextWithHaptic(value, { target: "thread-work-row", feedback: "selection" });
    setInteractionState((current) => ({ ...current, copiedRowId: rowId }));
    if (copyFeedbackTimeoutRef.current) {
      clearTimeout(copyFeedbackTimeoutRef.current);
    }
    copyFeedbackTimeoutRef.current = setTimeout(() => {
      setInteractionState((current) =>
        current.copiedRowId === rowId ? { ...current, copiedRowId: null } : current,
      );
      copyFeedbackTimeoutRef.current = null;
    }, 1200);
  }, []);

  const onToggleWorkGroup = useCallback(
    (groupId: string) => {
      setDisclosureToggleSettling(true);
      setInteractionState((current) => {
        const next = new Set(current.expandedWorkGroups);
        if (!next.delete(groupId)) next.add(groupId);
        return { ...current, expandedWorkGroups: next };
      });
      settleDisclosure();
    },
    [settleDisclosure],
  );

  const onToggleWorkRow = useCallback(
    (rowId: string) => {
      setDisclosureToggleSettling(true);
      setInteractionState((current) => ({
        ...current,
        expandedWorkRows: {
          ...current.expandedWorkRows,
          [rowId]: !(current.expandedWorkRows[rowId] ?? false),
        },
      }));
      settleDisclosure();
    },
    [settleDisclosure],
  );

  const onToggleTurnFold = useCallback(
    (turnId: string) => {
      void Haptics.selectionAsync();
      setDisclosureToggleSettling(true);
      setInteractionState((current) => {
        const next = new Set(current.expandedTurnIds);
        if (!next.delete(turnId)) next.add(turnId);
        return { ...current, expandedTurnIds: next };
      });
      settleDisclosure();
    },
    [settleDisclosure],
  );

  const rowContext = useMemo<FeedRowContext>(
    () => ({
      store,
      copiedRowId,
      expandedWorkRows,
      workRowSizing,
      iconSubtleColor,
      screenColor,
      userBubbleColor,
      userBubbleMaxWidth,
      onCopyWorkRow,
      onToggleWorkGroup,
      onToggleWorkRow,
      onToggleTurnFold,
    }),
    [
      store,
      copiedRowId,
      expandedWorkRows,
      workRowSizing,
      iconSubtleColor,
      screenColor,
      userBubbleColor,
      userBubbleMaxWidth,
      onCopyWorkRow,
      onToggleWorkGroup,
      onToggleWorkRow,
      onToggleTurnFold,
    ],
  );

  // Disclosures can mount existing offscreen rows as well as new work rows.
  // Fade those in after movement.
  const renderItem = useCallback(
    (info: { item: ThreadFeedRow; index: number }) => (
      <Animated.View
        key={info.item.id}
        entering={disclosureToggleSettling ? THREAD_FEED_DISCLOSURE_ENTER_TRANSITION : undefined}
      >
        {renderFeedEntry(info.item, rowContext)}
      </Animated.View>
    ),
    [disclosureToggleSettling, rowContext],
  );

  if (props.contentPresentation.kind === "unavailable") {
    return (
      <ThreadFeedPlaceholder
        title={props.contentPresentation.title}
        detail={props.contentPresentation.detail}
        topInset={0}
        bottomInset={bottomContentInset}
        horizontalPadding={horizontalPadding}
      />
    );
  }

  return (
    <View className="flex-1" onLayout={handleViewportLayout}>
      <View className="flex-1">
        <MarkdownImageAvailableWidthContext value={markdownContentWidth}>
          <KeyboardAwareLegendList
            ref={props.listRef}
            key={listMountKey}
            style={{ flex: 1 }}
            // RN 0.81+ drops touches inside the contentInset area; the end space
            // after a send is pure inset, so without this it cannot be scrolled.
            applyWorkaroundForContentInsetHitTestBug
            contentInsetAdjustmentBehavior={usesNativeAutomaticInsets ? "automatic" : "never"}
            automaticallyAdjustsScrollIndicatorInsets={usesNativeAutomaticInsets}
            scrollIndicatorInsets={{ top: 0, left: 0, right: 0, bottom: 0 }}
            contentInsetEndAdjustment={props.contentInsetEndAdjustment}
            {...(initialContentInset ? { contentInset: initialContentInset } : {})}
            freeze={props.freeze}
            maintainScrollAtEnd={
              disclosureToggleSettling || !endFollowEnabled
                ? false
                : { animated: false, on: { dataChange: true, itemLayout: true, layout: true } }
            }
            maintainVisibleContentPosition={
              endFollowEnabled && !disclosureToggleSettling ? false : { data: true, size: true }
            }
            data={presentedFeed}
            extraData={rowContext}
            renderItem={renderItem}
            keyExtractor={(row) => row.id}
            getItemType={(row) => (row.type === "message" ? `message:${row.role}` : row.type)}
            drawDistance={500}
            keyboardShouldPersistTaps="always"
            keyboardDismissMode="none"
            keyboardLiftBehavior="whenAtEnd"
            {...(viewportHeight > 0 && viewportWidth > 0
              ? { estimatedListSize: { height: viewportHeight, width: viewportWidth } }
              : {})}
            estimatedItemSize={180}
            // Chat-style bottom alignment: a short thread rests just above the composer.
            alignItemsAtEnd
            initialScrollAtEnd
            onScroll={handleScroll}
            onScrollBeginDrag={handleScrollBeginDrag}
            onScrollEndDrag={handleScrollEndDrag}
            onMomentumScrollBegin={handleMomentumScrollBegin}
            onMomentumScrollEnd={handleMomentumScrollEnd}
            scrollEventThrottle={16}
            ListHeaderComponent={
              props.historyControls ? <ThreadFeedLoadEarlierControl {...props.historyControls} /> : null
            }
            contentContainerStyle={{
              paddingTop: 12,
              paddingHorizontal: contentHorizontalPadding,
            }}
          />
        </MarkdownImageAvailableWidthContext>
      </View>
      {props.contentPresentation.kind === "loading" && presentedFeed.length === 0 ? (
        <View pointerEvents="none" style={StyleSheet.absoluteFill} className="items-center justify-center">
          <ActivityIndicator accessibilityLabel="Loading messages" colorClassName="accent-icon-muted" />
        </View>
      ) : null}
      {presentedFeed.length === 0 && props.contentPresentation.kind === "ready" ? (
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <ThreadFeedPlaceholder
            title="No conversation yet"
            detail="Ask the agent to inspect the repo, run a command, or continue the active thread."
            topInset={0}
            bottomInset={bottomContentInset}
            horizontalPadding={horizontalPadding}
          />
        </View>
      ) : null}
    </View>
  );
});

function ThreadFeedLoadEarlierControl(props: ThreadFeedHistoryControls) {
  const theme = useUniwindTheme();
  const mutedColor = theme["--color-icon-subtle"];
  const accentColor = theme["--color-primary"];
  if (!props.hasMoreHistory && props.error === null) {
    return null;
  }
  return (
    <View className="mb-3 items-center gap-1.5 px-2">
      {props.hasMoreHistory ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Load earlier activity"
          disabled={props.loading}
          onPress={props.onLoadEarlier}
          className="min-h-9 flex-row items-center justify-center gap-2 rounded-full border border-border/60 bg-surface/80 px-4 py-2 disabled:opacity-50"
        >
          {props.loading ? (
            <ActivityIndicator size="small" color={accentColor} />
          ) : (
            <SymbolView name="chevron.up" size={12} tintColor={accentColor} type="monochrome" />
          )}
          <Text className="text-sm font-medium text-foreground">
            {props.loading ? "Loading earlier activity…" : "Load earlier activity"}
          </Text>
        </Pressable>
      ) : null}
      {props.error !== null ? (
        <Text className="text-center text-xs" style={{ color: mutedColor }}>
          {props.error}
        </Text>
      ) : null}
    </View>
  );
}
