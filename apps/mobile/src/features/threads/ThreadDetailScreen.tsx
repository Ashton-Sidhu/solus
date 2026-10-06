// Adapted from T3 Code apps/mobile/src/features/threads/ThreadDetailScreen.tsx (MIT, see UPSTREAM.md).
import { useKeyboardChatComposerInset, useKeyboardScrollToEnd } from "@legendapp/list/keyboard";
import type { LegendListRef } from "@legendapp/list/react-native";
import { HeaderHeightContext } from "@react-navigation/elements";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../navigation/routes";
import * as Haptics from "expo-haptics";
import { isSessionBusyStatus, type SessionStatus } from "@solus/contracts/types";
import { memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  Keyboard,
  Platform,
  useWindowDimensions,
  View,
  type GestureResponderEvent,
} from "react-native";
import { KeyboardController, KeyboardStickyView, useKeyboardState } from "react-native-keyboard-controller";
import Animated, {
  FadeInDown,
  FadeOut,
  ReduceMotion,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useWorkspaceContentWidth } from "../layout/workspace-content-width";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import type { ComposerEditorHandle } from "../../components/ComposerEditor";
import { RenderErrorBoundary, RenderFailureView } from "../../components/RenderErrorBoundary";
import type { LayoutVariant } from "../../lib/layout";
import type { ViewInstance } from "react-native";
import type { HostConnectionPhase } from "../hosts/host-connections";
import { useKeyboardCommand } from "../keyboard/use-keyboard-command";
import type { ConversationMeta, ConversationStore } from "../conversation/conversation-store";
import { PendingApprovalCard } from "./PendingApprovalCard";
import { PendingUserInputCard } from "./PendingUserInputCard";
import { AgentPlanCard } from "./ThreadPlanCard";
import { UsageLimitRecoveryCard } from "./UsageLimitRecoveryCard";
import { FLOATING_WORKING_CONTROL_COVERAGE, FloatingWorkingControl } from "./floating-working-control";
import { connectionFloatingStatus, type FloatingWorkingStatus } from "./floating-working-status";
import { derivePendingUserInputMaxHeight, ESTIMATED_KEYBOARD_HEIGHT } from "./pendingUserInputLayout";
import {
  COMPOSER_COLLAPSED_CHROME,
  COMPOSER_EXPANDED_CHROME,
  COMPOSER_LAYOUT_TRANSITION,
  ThreadComposer,
} from "./ThreadComposer";
import { ThreadFeed, type ThreadContentPresentation, type ThreadFeedHistoryControls } from "./ThreadFeed";
import { ThreadQueueSheet } from "./ThreadQueueSheet";
import { latestTurnAgentIds, useAgentPresentations } from "./ThreadAgents";
import { agentsPillLabel } from "./agent-card-presentation";
import { useListened } from "../../app/app-context";
import { AgentAuthSheet } from "../conversation/components/AgentAuthSheet";

export interface ThreadDetailScreenProps {
  readonly store: ConversationStore;
  readonly meta: ConversationMeta;
  /** `hostId` and session id joined: the feed's identity. */
  readonly threadKey: string;
  /** Where this conversation's composer draft is kept. */
  readonly draftKey: string;
  readonly contentPresentation: ThreadContentPresentation;
  readonly hostLabel: string | null;
  readonly connectionState: HostConnectionPhase | null;
  readonly historyControls?: ThreadFeedHistoryControls;
  readonly layoutVariant?: LayoutVariant;
  readonly usesAutomaticContentInsets?: boolean;
  readonly onReconnectHost: () => void;
}

/** A turn is producing output: the live slot and the working timer show. */
function isWorkingStatus(status: SessionStatus): boolean {
  return status === "running" || status === "connecting";
}

/**
 * When this device first saw the conversation working. Solus reports no turn
 * start time, so the timer counts from then; it survives remounts of the
 * screen for the same conversation.
 */
const workStartedAtByStore = new WeakMap<ConversationStore, number>();

function workStartedAt(store: ConversationStore, working: boolean): number | null {
  if (!working) {
    workStartedAtByStore.delete(store);
    return null;
  }
  let startedAt = workStartedAtByStore.get(store);
  if (startedAt === undefined) {
    startedAt = Date.now();
    workStartedAtByStore.set(store, startedAt);
  }
  return startedAt;
}

export const ThreadDetailScreen = memo(function ThreadDetailScreen(props: ThreadDetailScreenProps) {
  const { store, meta } = props;
  const insets = useSafeAreaInsets();
  const isKeyboardVisible = useKeyboardState((state) => state.isVisible);
  const liveKeyboardHeight = useKeyboardState((state) => state.height);
  // Android can swallow the IME hide callbacks when the app is backgrounded
  // mid keyboard-hide; quarantine the sticky translation on every resume until
  // the keyboard reports again.
  const [keyboardStateSuspect, setKeyboardStateSuspect] = useState(false);
  useEffect(() => {
    if (Platform.OS !== "android") {
      return;
    }
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        setKeyboardStateSuspect(true);
      }
    });
    return () => {
      subscription.remove();
    };
  }, []);
  useEffect(() => {
    setKeyboardStateSuspect(false);
  }, [isKeyboardVisible, liveKeyboardHeight]);
  const handleOwnedInputFocusChange = useCallback((focused: boolean) => {
    if (focused) {
      setKeyboardStateSuspect(false);
    }
  }, []);
  const windowHeight = useWindowDimensions().height;
  const navigationHeaderHeight = useContext(HeaderHeightContext) || insets.top + 44;
  const composerEditorRef = useRef<ComposerEditorHandle>(null);
  const composerOverlayRef = useRef<ViewInstance>(null);
  const listRef = useRef<LegendListRef>(null);
  const feedTouchStartRef = useRef<{ pageX: number; pageY: number } | null>(null);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const handleComposerFocusChange = useCallback(
    (focused: boolean) => {
      setComposerFocused(focused);
      handleOwnedInputFocusChange(focused);
    },
    [handleOwnedInputFocusChange],
  );
  const [submittedMessageId, setSubmittedMessageId] = useState<string | null>(null);
  const [endFollowEnabled, setEndFollowEnabled] = useState(true);
  // Android keys the safe-area padding on keyboard visibility; iOS on focus,
  // because visibility only flips after the hide animation.
  const composerBottomInset = (
    Platform.OS === "android" ? isKeyboardVisible : composerExpanded || composerFocused
  )
    ? 0
    : Math.max(insets.bottom, 12);
  const contentPresentationKind = props.contentPresentation.kind;
  const turnActive = isSessionBusyStatus(meta.status);
  // A settled turn can leave background work running; Stop ends it too.
  const canStop = turnActive || meta.status === "background";
  const working = isWorkingStatus(meta.status);
  const activeWorkStartedAt = workStartedAt(store, working);
  const activePendingApproval = meta.permissions[0] ?? null;
  const activePendingUserInput = meta.questions[0] ?? null;
  const queuedCount = meta.queue.entries.length;
  // The newest turn's agents, for the Agents pill. Rows are added rarely; an
  // agent's status changes its own item only.
  const order = useListened(store.order, store.orderSnapshot);
  const agentIds = useMemo(() => latestTurnAgentIds(store, order), [store, order]);
  const agentRows = useAgentPresentations(store, agentIds);
  const agentsPill = agentsPillLabel(agentRows, turnActive);
  // One floating pill above the composer: the connection while disconnected,
  // the sync state while messages load, then the working timer.
  const floatingStatus = ((): FloatingWorkingStatus | null => {
    const connectionStatus = connectionFloatingStatus({
      connectionState: props.connectionState,
      hostLabel: props.hostLabel,
      onReconnect: props.onReconnectHost,
    });
    if (connectionStatus !== null) {
      return connectionStatus;
    }
    if (activePendingApproval !== null || activePendingUserInput !== null) {
      return null;
    }
    if (contentPresentationKind === "loading") {
      return { kind: "syncing", label: "Loading messages..." };
    }
    if (activeWorkStartedAt !== null && contentPresentationKind === "ready") {
      return { kind: "working", startedAt: activeWorkStartedAt };
    }
    if (meta.status === "background" && contentPresentationKind === "ready") {
      return {
        kind: "background",
        label: "Background task running",
        accessibilityLabel: "A background task the agent started is still running",
        waiting: true,
      };
    }
    return null;
  })();
  const showFloatingStatus =
    floatingStatus !== null || queuedCount > 0 || agentsPill !== null || props.connectionState !== "connected";
  const composerChrome = composerExpanded ? COMPOSER_EXPANDED_CHROME : COMPOSER_COLLAPSED_CHROME;
  const composerOverlapHeight = composerChrome + composerBottomInset;
  // While a question is pending, the questionnaire owns the composer slot.
  // Collapse state is keyed by request id so a new request re-expands.
  const [collapsedUserInputRequestId, setCollapsedUserInputRequestId] = useState<string | null>(
    null,
  );
  const [respondingRequestId, setRespondingRequestId] = useState<string | null>(null);
  const activeUserInputRequestId = activePendingUserInput?.questionId ?? null;
  const userInputCollapsed =
    activeUserInputRequestId !== null && collapsedUserInputRequestId === activeUserInputRequestId;
  const [lastKnownKeyboardHeight, setLastKnownKeyboardHeight] = useState(0);
  useEffect(() => {
    if (liveKeyboardHeight > 0 && liveKeyboardHeight !== lastKnownKeyboardHeight) {
      setLastKnownKeyboardHeight(liveKeyboardHeight);
    }
  }, [lastKnownKeyboardHeight, liveKeyboardHeight]);
  const pendingUserInputMaxHeight = derivePendingUserInputMaxHeight({
    windowHeight,
    keyboardHeight:
      lastKnownKeyboardHeight > 0 ? lastKnownKeyboardHeight : ESTIMATED_KEYBOARD_HEIGHT,
    navigationHeaderHeight,
    composerOverlapHeight: composerBottomInset,
  });
  const estimatedOverlayHeight = composerOverlapHeight;
  // UIKit adds the safe-area bottom to the content inset again under automatic
  // insets; report the overlay height without it.
  const nativeInsetOvercount =
    props.usesAutomaticContentInsets === true && Platform.OS === "ios" ? insets.bottom : 0;
  const { contentInsetEndAdjustment, onComposerLayout } = useKeyboardChatComposerInset(
    listRef,
    composerOverlayRef,
    Math.max(0, estimatedOverlayHeight - nativeInsetOvercount),
  );
  const floatingControlCoverage = useSharedValue(
    showFloatingStatus ? FLOATING_WORKING_CONTROL_COVERAGE : 0,
  );
  useEffect(() => {
    floatingControlCoverage.value = withTiming(
      showFloatingStatus ? FLOATING_WORKING_CONTROL_COVERAGE : 0,
      { duration: 180, reduceMotion: ReduceMotion.System },
    );
  }, [floatingControlCoverage, showFloatingStatus]);
  const combinedContentInsetEndAdjustment = useSharedValue(
    Math.max(0, estimatedOverlayHeight - nativeInsetOvercount),
  );
  useAnimatedReaction(
    () => contentInsetEndAdjustment.value + floatingControlCoverage.value,
    (value) => {
      combinedContentInsetEndAdjustment.value = value;
    },
  );
  const { freeze, scrollMessageToEnd } = useKeyboardScrollToEnd({ listRef });
  const endFollowEnabledRef = useRef(true);
  endFollowEnabledRef.current = endFollowEnabled;
  const overlayRepinTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousFloatingVisibleRef = useRef({ threadKey: props.threadKey, visible: false });
  // The list's own corrections for inset changes drift on short content, so
  // re-pin the end once a change settles — unless the reader scrolled away.
  const scheduleOverlayRepin = useCallback(
    (delayMs: number) => {
      if (overlayRepinTimerRef.current !== null) {
        clearTimeout(overlayRepinTimerRef.current);
      }
      overlayRepinTimerRef.current = setTimeout(() => {
        overlayRepinTimerRef.current = null;
        if (!endFollowEnabledRef.current) {
          return;
        }
        void scrollMessageToEnd({ animated: false, closeKeyboard: false }).catch(() => {
          freeze.set(false);
        });
      }, delayMs);
    },
    [freeze, scrollMessageToEnd],
  );
  useEffect(
    () => () => {
      if (overlayRepinTimerRef.current !== null) {
        clearTimeout(overlayRepinTimerRef.current);
      }
    },
    [],
  );
  useEffect(() => {
    const previous = previousFloatingVisibleRef.current;
    const threadChanged = previous.threadKey !== props.threadKey;
    const visibilityChanged = previous.visible !== showFloatingStatus;
    previousFloatingVisibleRef.current = { threadKey: props.threadKey, visible: showFloatingStatus };
    if ((!threadChanged && !visibilityChanged) || (threadChanged && !showFloatingStatus)) {
      return;
    }
    scheduleOverlayRepin(230);
  }, [scheduleOverlayRepin, props.threadKey, showFloatingStatus]);
  const handleToggleUserInputCollapsed = useCallback(() => {
    if (activeUserInputRequestId === null) {
      return;
    }
    if (userInputCollapsed) {
      setCollapsedUserInputRequestId(null);
    } else {
      // Collapsing hides the answer fields; release the keyboard with them.
      Keyboard.dismiss();
      setCollapsedUserInputRequestId(activeUserInputRequestId);
    }
    scheduleOverlayRepin(260);
  }, [activeUserInputRequestId, scheduleOverlayRepin, userInputCollapsed]);
  const isSplitLayout = props.layoutVariant === "split";
  const workspaceContentWidth = useWorkspaceContentWidth();
  const composerWidthStyle = useAnimatedStyle(() =>
    isSplitLayout && workspaceContentWidth !== null
      ? { width: workspaceContentWidth.value }
      : { width: "100%" },
  );

  useLayoutEffect(() => {
    // A replaced or unmounted editor may not emit a blur event.
    setComposerFocused(false);
  }, [props.threadKey]);

  useEffect(() => {
    setSubmittedMessageId(null);
    setEndFollowEnabled(true);
    freeze.set(false);
  }, [freeze, props.threadKey]);

  const stopThread = useCallback(() => {
    void store.controller.stop();
  }, [store]);
  // Stop applies only to a running turn; otherwise the command passes on.
  useKeyboardCommand("stop", () => {
    if (!canStop) return false;
    stopThread();
  });

  const handleSent = useCallback(() => {
    const targetThreadKey = props.threadKey;
    setSubmittedMessageId(`${targetThreadKey}:${Date.now()}`);
    composerEditorRef.current?.blur();
    // Wait for the keyboard to leave before scrolling, so the keyboard inset
    // freeze cannot swallow its close event.
    requestAnimationFrame(() => {
      void KeyboardController.dismiss()
        .then(() => scrollMessageToEnd({ animated: true, closeKeyboard: false }))
        .catch(() => {
          freeze.set(false);
        });
    });
  }, [freeze, props.threadKey, scrollMessageToEnd]);

  const handleScrollToEnd = useCallback(() => {
    void Haptics.selectionAsync();
    void scrollMessageToEnd({ animated: true, closeKeyboard: false }).catch(() => {
      freeze.set(false);
    });
  }, [freeze, scrollMessageToEnd]);

  const answerPermission = useCallback(
    async (questionId: string, optionId: string) => {
      setRespondingRequestId(questionId);
      try {
        await store.controller.answerPermission(questionId, optionId);
      } finally {
        setRespondingRequestId(null);
      }
    },
    [store],
  );
  const answerQuestion = useCallback(
    async (answers: Record<string, string>) => {
      if (activeUserInputRequestId === null) return;
      setRespondingRequestId(activeUserInputRequestId);
      try {
        await store.controller.answerQuestion(activeUserInputRequestId, answers);
      } finally {
        setRespondingRequestId(null);
      }
    },
    [activeUserInputRequestId, store],
  );

  const showScrollToEndButton = contentPresentationKind === "ready" && !endFollowEnabled;
  const { themeAppearance } = useAppearancePreferences();
  const isDarkMode = themeAppearance === "dark";

  const collapseComposer = useCallback(() => {
    composerEditorRef.current?.blur();
  }, []);
  const handleFeedTouchStart = useCallback((event: GestureResponderEvent) => {
    feedTouchStartRef.current = {
      pageX: event.nativeEvent.pageX,
      pageY: event.nativeEvent.pageY,
    };
  }, []);
  const handleFeedTouchMove = useCallback((event: GestureResponderEvent) => {
    const start = feedTouchStartRef.current;
    if (!start) {
      return;
    }
    const deltaX = event.nativeEvent.pageX - start.pageX;
    const deltaY = event.nativeEvent.pageY - start.pageY;
    if (Math.hypot(deltaX, deltaY) > 8) {
      feedTouchStartRef.current = null;
    }
  }, []);
  const handleFeedTouchEnd = useCallback(() => {
    if (feedTouchStartRef.current) {
      collapseComposer();
    }
    feedTouchStartRef.current = null;
  }, [collapseComposer]);
  const handleFeedTouchCancel = useCallback(() => {
    feedTouchStartRef.current = null;
  }, []);

  return (
    <View className="flex-1">
      <View
        style={{ flex: 1 }}
        onTouchStart={handleFeedTouchStart}
        onTouchMove={handleFeedTouchMove}
        onTouchEnd={handleFeedTouchEnd}
        onTouchCancel={handleFeedTouchCancel}
      >
        <View
          pointerEvents="none"
          className={
            Platform.OS === "android"
              ? "absolute inset-0 bg-thread-canvas"
              : "absolute inset-0 bg-screen"
          }
        />
        <RenderErrorBoundary
          key={props.threadKey}
          renderFallback={(fallback) => (
            <RenderFailureView
              {...fallback}
              title="The conversation couldn't be displayed"
              bottomInset={estimatedOverlayHeight}
            />
          )}
        >
          <ThreadFeed
            store={store}
            threadKey={props.threadKey}
            contentPresentation={props.contentPresentation}
            turnActive={turnActive}
            working={working}
            listRef={listRef}
            freeze={freeze}
            submittedMessageId={submittedMessageId}
            contentInsetEndAdjustment={combinedContentInsetEndAdjustment}
            contentBottomInset={
              estimatedOverlayHeight + (showFloatingStatus ? FLOATING_WORKING_CONTROL_COVERAGE : 0)
            }
            historyControls={props.historyControls}
            layoutVariant={props.layoutVariant}
            usesAutomaticContentInsets={props.usesAutomaticContentInsets}
            onEndFollowEnabledChange={setEndFollowEnabled}
          />
        </RenderErrorBoundary>
      </View>

      {/* Floating composer — sticks to keyboard via KeyboardStickyView */}
      <KeyboardStickyView
        enabled={Platform.OS === "ios" || (isKeyboardVisible && !keyboardStateSuspect)}
        pointerEvents="box-none"
        style={{ position: "absolute", bottom: 0, left: 0, right: 0, top: 0 }}
        offset={{ closed: 0, opened: 0 }}
      >
        <Animated.View
          layout={COMPOSER_LAYOUT_TRANSITION}
          pointerEvents="box-none"
          style={[{ position: "absolute", bottom: 0, left: 0 }, composerWidthStyle]}
        >
          {/* No paddingTop here: the overlay's measured height becomes the
              list's bottom inset. */}
          <View ref={composerOverlayRef} onLayout={onComposerLayout} className="w-full">
            <FloatingWorkingControl
              colorScheme={isDarkMode ? "dark" : "light"}
              status={floatingStatus}
              showScrollToEnd={showScrollToEndButton}
              onScrollToEnd={handleScrollToEnd}
              queuedCount={queuedCount}
              onOpenQueue={() => {
                Keyboard.dismiss();
                setQueueOpen(true);
              }}
              agents={agentsPill}
              onOpenAgents={() => {
                Keyboard.dismiss();
                const { record, newSession } = store.controller.target;
                navigation.navigate("ThreadAgents", {
                  hostId: store.controller.hostId,
                  conversationId: record?.sessionId ?? newSession?.sessionId ?? store.controller.run.sessionId,
                });
              }}
            />
            <View className="w-full self-center">
              {meta.rateLimit ? <UsageLimitRecoveryCard store={store} rateLimit={meta.rateLimit} /> : null}
              {meta.agentPlans.length > 0 && activeUserInputRequestId === null ? (
                <Animated.View
                  className="shrink-0 gap-3 px-4 pb-3"
                  entering={FadeInDown.duration(220)}
                  exiting={FadeOut.duration(140)}
                >
                  {meta.agentPlans.map((plan) => (
                    <AgentPlanCard key={`${plan.targetSessionId}:${plan.messageId}`} store={store} plan={plan} />
                  ))}
                </Animated.View>
              ) : null}
              {activePendingApproval || activePendingUserInput ? (
                <Animated.View
                  className="shrink-0 gap-3 px-4 pb-3"
                  // The questionnaire replaces the composer, so it pads the home indicator.
                  style={
                    activeUserInputRequestId !== null
                      ? { paddingBottom: composerBottomInset }
                      : undefined
                  }
                  entering={FadeInDown.duration(220)}
                  exiting={FadeOut.duration(140)}
                >
                  {activePendingApproval ? (
                    <PendingApprovalCard
                      approval={activePendingApproval}
                      respondingApprovalId={respondingRequestId}
                      onRespond={answerPermission}
                    />
                  ) : null}
                  {activePendingUserInput ? (
                    <PendingUserInputCard
                      key={activePendingUserInput.questionId}
                      pendingUserInput={activePendingUserInput}
                      maxHeight={pendingUserInputMaxHeight}
                      collapsed={userInputCollapsed}
                      onToggleCollapsed={handleToggleUserInputCollapsed}
                      onStopThread={stopThread}
                      responding={respondingRequestId === activePendingUserInput.questionId}
                      onSubmit={answerQuestion}
                    />
                  ) : null}
                </Animated.View>
              ) : null}
            </View>

            {/* Hidden (not unmounted) while a question owns the composer slot,
                so the draft and editor state survive. */}
            <View style={activeUserInputRequestId !== null ? { display: "none" } : undefined}>
              <ThreadComposer
                store={store}
                meta={meta}
                draftKey={props.draftKey}
                editorRef={composerEditorRef}
                placeholder="Ask the repo agent, or run a command…"
                    connected={props.connectionState === "connected"}
                sendBlockedReason={
                  meta.phase.kind === "error"
                    ? "Conversation unavailable"
                    : meta.phase.kind === "loading"
                      ? "Loading conversation"
                      : props.connectionState === "blocked"
                        ? "Host unavailable"
                        : null
                }
                canStopThread={canStop}
                bottomInset={composerBottomInset}
                onStopThread={stopThread}
                onSent={handleSent}
                onExpandedChange={setComposerExpanded}
                onEditorFocusChange={handleComposerFocusChange}
              />
            </View>
          </View>
        </Animated.View>
      </KeyboardStickyView>
      <ThreadQueueSheet
        visible={queueOpen}
        store={store}
        meta={meta}
        onClose={() => {
          setQueueOpen(false);
          composerEditorRef.current?.focus();
        }}
      />
      <AgentAuthSheet store={store} onClose={() => composerEditorRef.current?.focus()} />
    </View>
  );
});
