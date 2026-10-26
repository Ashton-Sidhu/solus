// Adapted from T3 Code apps/mobile/src/features/threads/ThreadDetailScreen.tsx (MIT, see UPSTREAM.md).
import { useKeyboardChatComposerInset, useKeyboardScrollToEnd } from "@legendapp/list/keyboard";
import type { LegendListRef } from "@legendapp/list/react-native";
import { HeaderHeightContext } from "@react-navigation/elements";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../navigation/routes";
import * as Haptics from "expo-haptics";
import { hostReadinessCopy, type HostReadinessState } from "@solus/client-core/host-readiness";
import { isSessionBusyStatus, type SessionOrigin, type SessionStatus } from "@solus/contracts/types";
import { memo, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AppState,
  Keyboard,
  Platform,
  useWindowDimensions,
  View,
  type GestureResponderEvent,
} from "react-native";
import {
  KeyboardController,
  KeyboardEvents,
  KeyboardStickyView,
  useKeyboardState,
} from "react-native-keyboard-controller";
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
import { useKeyboardCommand } from "../keyboard/use-keyboard-command";
import { conversationIdOf, type ConversationMeta, type ConversationStore } from "../conversation/conversation-store";
import { permissionForFeedback } from "../conversation/lib/transcript-model";
import { PendingApprovalCard } from "./PendingApprovalCard";
import { PendingUserInputCard } from "./PendingUserInputCard";
import { AgentPlanCard } from "./ThreadPlanCard";
import { UsageLimitRecoveryCard } from "./UsageLimitRecoveryCard";
import { ThreadSuggestionsCard } from "./ThreadSuggestionsCard";
import { FLOATING_WORKING_CONTROL_COVERAGE, FloatingWorkingControl } from "./floating-working-control";
import { backgroundFloatingStatus, type FloatingWorkingStatus } from "./floating-working-status";
import { showsBackgroundWork } from "@solus/client-core/background-work";
import { derivePendingUserInputMaxHeight, ESTIMATED_KEYBOARD_HEIGHT } from "./pendingUserInputLayout";
import { KeyboardResumeGuard } from "./android-keyboard-resume";
import { useTurnAnnouncements } from "./use-turn-announcements";
import {
  COMPOSER_COLLAPSED_CHROME,
  COMPOSER_EXPANDED_CHROME,
  COMPOSER_LAYOUT_TRANSITION,
  THREAD_COMPOSER_BOTTOM_GUTTER,
  ThreadComposer,
} from "./ThreadComposer";
import { ThreadFeed, type ThreadContentPresentation, type ThreadFeedHistoryControls } from "./ThreadFeed";
import { QuoteInReplyContext } from "./ThreadMarkdown";
import { useAgentRoster } from "./ThreadAgents";
import { ComposerQueuedEditBanner } from "./ComposerQueuedEdit";
import { endQueuedMessageEdit, useQueuedMessageEdit } from "./queued-message-edit";
import { agentsPillLabel } from "./agent-card-presentation";
import { threadHostChrome } from "./lib/thread-host-chrome";
import { HostGraceWhisper } from "./ThreadHostLines";
import { HostAsleepVeil } from "../hosts/HostAsleepVeil";
import { AgentAuthSheet } from "../conversation/components/AgentAuthSheet";
import { IntegrationConnectSheet } from "../conversation/components/IntegrationConnectSheet";

export interface ThreadDetailScreenProps {
  readonly store: ConversationStore;
  readonly meta: ConversationMeta;
  /** `hostId` and session id joined: the feed's identity. */
  readonly threadKey: string;
  /** Where this conversation's composer draft is kept. */
  readonly draftKey: string;
  readonly contentPresentation: ThreadContentPresentation;
  readonly hostLabel: string | null;
  /** The readiness of this thread's host, not of any other host. */
  readonly hostReadiness: HostReadinessState;
  readonly historyControls?: ThreadFeedHistoryControls;
  readonly startedBy?: SessionOrigin | null;
  readonly layoutVariant?: LayoutVariant;
  readonly usesAutomaticContentInsets?: boolean;
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
  // mid keyboard-hide; quarantine the sticky translation on resume until the
  // keyboard reports again, unless the composer kept focus and no hide was
  // under way (android-keyboard-resume.ts).
  const [keyboardStateSuspect, setKeyboardStateSuspect] = useState(false);
  // Owned by events only; read in handlers and effects, never during render.
  const keyboardResumeRef = useRef(new KeyboardResumeGuard());
  useEffect(() => {
    if (Platform.OS !== "android") {
      return;
    }
    const subscriptions = [
      ...(["keyboardWillShow", "keyboardWillHide", "keyboardDidHide"] as const).map((event) =>
        KeyboardEvents.addListener(event, () => keyboardResumeRef.current.keyboardEvent(event)),
      ),
      AppState.addEventListener("change", (state) => {
        if (state === "active") {
          setKeyboardStateSuspect(keyboardResumeRef.current.suspectOnResume());
        }
      }),
    ];
    return () => {
      for (const subscription of subscriptions) subscription.remove();
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
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const queuedEdit = useQueuedMessageEdit(store);
  const handleComposerFocusChange = useCallback(
    (focused: boolean) => {
      keyboardResumeRef.current.composerFocusChanged(focused);
      handleOwnedInputFocusChange(focused);
    },
    [handleOwnedInputFocusChange],
  );
  const [submittedMessageId, setSubmittedMessageId] = useState<string | null>(null);
  const [endFollowEnabled, setEndFollowEnabled] = useState(true);
  // The composer already adds its own gutter; the iPad aligns the pill's edge
  // with the native bar, so the inset does not count the gutter a second time.
  const composerBottomGutter = composerExpanded
    ? THREAD_COMPOSER_BOTTOM_GUTTER.card
    : THREAD_COMPOSER_BOTTOM_GUTTER.row;
  const alignedBottomInset =
    Platform.OS === "ios" && Platform.isPad
      ? Math.max(0, Math.max(insets.bottom, 12) - composerBottomGutter)
      : Math.max(insets.bottom, 12);
  // Android keys the safe-area padding on keyboard visibility; iOS on the
  // keyboard's height, because visibility only flips after the hide animation.
  // A hardware keyboard can focus the editor without any screen height, and
  // then the inset stays.
  const composerBottomInset = (Platform.OS === "android" ? isKeyboardVisible : liveKeyboardHeight > 0)
    ? 0
    : alignedBottomInset;
  const contentPresentationKind = props.contentPresentation.kind;
  const turnActive = isSessionBusyStatus(meta.status);
  // A reader the session is shared with to view cannot prompt or stop it (docs/plans/access-model.md §2.7).
  const mayDrive = store.controller.mayDrive;
  // Answering the agent's cards is its own action, apart from prompting (docs/plans/custom-roles.md §3).
  const mayApprove = store.controller.mayApprove;
  // A settled turn can leave background work running; Stop ends it too.
  const isBackground = showsBackgroundWork(meta.status, meta.backgroundWorkRunning);
  const canStop = mayDrive && (turnActive || isBackground);
  const working = isWorkingStatus(meta.status);
  const activeWorkStartedAt = workStartedAt(store, working);
  const hostChrome = threadHostChrome(props.hostReadiness);
  const hostLabel = props.hostLabel ?? "This host";
  // Nobody can answer a request while the host is away: its cards come back with the host.
  const activePendingApproval = hostChrome.showsRequestCards ? (meta.permissions[0] ?? null) : null;
  const activePendingUserInput = hostChrome.showsRequestCards ? (meta.questions[0] ?? null) : null;
  useTurnAnnouncements(`${store.controller.hostId}:${conversationIdOf(store)}`, meta.status, activePendingApproval !== null);
  const queuedCount = meta.queue.entries.length;
  // The Agents pill: the newest turn's agents and earlier ones still running.
  // Rows are added rarely; an agent's status changes its own item only.
  const agentRows = useAgentRoster(store);
  const agentsPill = hostChrome.showsAgentsPill ? agentsPillLabel(agentRows, turnActive) : null;
  // The pill's Stop is pending until the host takes the request; it is released
  // after, so a stop that left work running can be tried again. Keyed by the
  // session, so another thread's pill is not shown as stopping.
  const [stoppingBackgroundKey, setStoppingBackgroundKey] = useState<string | null>(null);
  const stoppingBackground = stoppingBackgroundKey === props.threadKey;
  const stopBackgroundWork = () => {
    if (stoppingBackground) return;
    const threadKey = props.threadKey;
    setStoppingBackgroundKey(threadKey);
    void store.controller
      .stopBackgroundWork()
      .finally(() => setStoppingBackgroundKey((current) => (current === threadKey ? null : current)));
  };
  const isHostReady = props.hostReadiness.readiness === "ready";
  // One floating pill above the composer: the sync state while messages load,
  // then the working timer. A host that is not ready has no status pill: the
  // grace whisper or the host footer says its state.
  const floatingStatus = ((): FloatingWorkingStatus | null => {
    if (!isHostReady) return null;
    if (activePendingApproval !== null || activePendingUserInput !== null) {
      return null;
    }
    if (contentPresentationKind === "loading") {
      return { kind: "syncing", label: "Loading messages..." };
    }
    if (activeWorkStartedAt !== null && contentPresentationKind === "ready") {
      return { kind: "working", startedAt: activeWorkStartedAt };
    }
    if (isBackground && contentPresentationKind === "ready") {
      return backgroundFloatingStatus({ mayDrive, stopping: stoppingBackground, onStop: stopBackgroundWork });
    }
    return null;
  })();
  const showFloatingStatus =
    floatingStatus !== null || queuedCount > 0 || agentsPill !== null;
  // The composer is hidden, not unmounted, while the host is away: its
  // keyboard must not stay up over the host footer.
  useEffect(() => {
    if (!hostChrome.showsComposer) Keyboard.dismiss();
  }, [hostChrome.showsComposer]);
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
  // A question hides the composer without unmounting it, so a hidden editor
  // may never report its blur; it does not own the keyboard then.
  useLayoutEffect(() => {
    keyboardResumeRef.current.questionShownChanged(activeUserInputRequestId !== null);
  }, [activeUserInputRequestId]);
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
  // Read only by the re-pin timer, after commit. A write during render would
  // stop the React Compiler.
  useLayoutEffect(() => {
    endFollowEnabledRef.current = endFollowEnabled;
  });
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
    keyboardResumeRef.current.composerFocusChanged(false);
  }, [props.threadKey]);

  useEffect(() => {
    setSubmittedMessageId(null);
    setEndFollowEnabled(true);
    freeze.set(false);
  }, [freeze, props.threadKey]);

  const stopThread = useCallback(() => {
    // The turn already ended: Stop ends the work it left running, as the
    // desktop and web background row does.
    if (isBackground) void store.controller.stopBackgroundWork();
    else void store.controller.stop();
  }, [store, isBackground]);
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
      // The React Compiler cannot compile try/finally. The async wrapper turns
      // a synchronous throw into a rejection, so finally sees both.
      await (async () => {
        await store.controller.answerPermission(questionId, optionId);
      })().finally(() => {
        setRespondingRequestId(null);
      });
    },
    [store],
  );
  const answerQuestion = useCallback(
    async (answers: Record<string, string>) => {
      if (activeUserInputRequestId === null) return;
      setRespondingRequestId(activeUserInputRequestId);
      await (async () => {
        await store.controller.answerQuestion(activeUserInputRequestId, answers);
      })().finally(() => {
        setRespondingRequestId(null);
      });
    },
    [activeUserInputRequestId, store],
  );

  // A sleeping thread takes no touch, so it offers no jump to its end.
  const showScrollToEndButton = contentPresentationKind === "ready" && !endFollowEnabled && !hostChrome.isAsleep;
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
        {/* While the host is away the thread sleeps under a scrim: it takes no
            touch and no screen reader focus. */}
        <View
          className="flex-1"
          pointerEvents={hostChrome.isAsleep ? "none" : "auto"}
          accessibilityElementsHidden={hostChrome.isAsleep}
          importantForAccessibility={hostChrome.isAsleep ? "no-hide-descendants" : "auto"}
        >
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
            <QuoteInReplyContext value={store.quoteInReply}>
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
                startedBy={props.startedBy}
                handoffPending={meta.handoffPending}
                isHostAsleep={hostChrome.isAsleep}
                layoutVariant={props.layoutVariant}
                usesAutomaticContentInsets={props.usesAutomaticContentInsets}
                onEndFollowEnabledChange={setEndFollowEnabled}
              />
            </QuoteInReplyContext>
          </RenderErrorBoundary>
        </View>
        {hostChrome.isAsleep ? (
          <View className="absolute inset-0">
            {/* A scrim in the canvas colour: a faint trace of the thread stays,
                and nothing in it reads through the statement or its details. */}
            <View
              pointerEvents="none"
              className={
                Platform.OS === "android"
                  ? "absolute inset-0 bg-thread-canvas opacity-90"
                  : "absolute inset-0 bg-screen opacity-90"
              }
            />
            <HostAsleepVeil hostId={store.controller.hostId} bottomInset={composerBottomInset} />
          </View>
        ) : null}
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
                navigation.navigate("ThreadQueue", { hostId: store.controller.hostId, conversationId: conversationIdOf(store) });
              }}
              agents={agentsPill}
              onOpenAgents={() => {
                Keyboard.dismiss();
                navigation.navigate("ThreadAgents", { hostId: store.controller.hostId, conversationId: conversationIdOf(store) });
              }}
            />
            <View className="w-full self-center">
              {queuedEdit !== null ? (
                <Animated.View className="shrink-0" entering={FadeInDown.duration(180)} exiting={FadeOut.duration(120)}>
                  <ComposerQueuedEditBanner saving={queuedEdit.saving} onCancel={() => endQueuedMessageEdit(store)} />
                </Animated.View>
              ) : null}
              {meta.rateLimit && hostChrome.showsRequestCards ? <UsageLimitRecoveryCard store={store} rateLimit={meta.rateLimit} /> : null}
              {activeUserInputRequestId === null ? <ThreadSuggestionsCard controller={store.controller} /> : null}
              {meta.agentPlans.length > 0 && activeUserInputRequestId === null && hostChrome.showsRequestCards ? (
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
                      mayDrive={mayApprove}
                      onRespond={answerPermission}
                    />
                  ) : null}
                  {activePendingUserInput ? (
                    <PendingUserInputCard
                      key={activePendingUserInput.questionId}
                      pendingUserInput={activePendingUserInput}
                      store={store}
                      maxHeight={pendingUserInputMaxHeight}
                      collapsed={userInputCollapsed}
                      onToggleCollapsed={handleToggleUserInputCollapsed}
                      onStopThread={canStop ? stopThread : undefined}
                      responding={respondingRequestId === activePendingUserInput.questionId}
                      mayDrive={mayApprove}
                      onSubmit={answerQuestion}
                      onUnsentRemarks={store.returnRemarksToDraft}
                    />
                  ) : null}
                </Animated.View>
              ) : null}
            </View>

            {hostChrome.showsGraceWhisper ? (
              <HostGraceWhisper headline={hostReadinessCopy(props.hostReadiness, hostLabel).headline} />
            ) : null}
            {/* Hidden (not unmounted) while a question owns the composer slot
                or the host is away, so the draft and editor state survive. */}
            <View
              style={
                activeUserInputRequestId !== null || !hostChrome.showsComposer ? { display: "none" } : undefined
              }
            >
              <ThreadComposer
                store={store}
                meta={meta}
                draftKey={props.draftKey}
                editorRef={composerEditorRef}
                placeholder={permissionForFeedback(meta.permissions) ? "Send feedback to deny this request" : "Ask the repo agent, or run a command…"}
                    connected={isHostReady}
                sendBlockedReason={
                  meta.phase.kind === "error"
                    ? "Conversation unavailable"
                    : meta.phase.kind === "loading"
                      ? "Loading conversation"
                      : props.hostReadiness.readiness === "refused"
                        ? "Host unavailable"
                        : mayDrive
                          ? null
                          : "Shared with you to view"
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
      <AgentAuthSheet store={store} onClose={() => composerEditorRef.current?.focus()} />
      <IntegrationConnectSheet store={store} onClose={() => composerEditorRef.current?.focus()} />
    </View>
  );
});
