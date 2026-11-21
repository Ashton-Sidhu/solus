// Adapted from T3 Code apps/mobile/src/features/threads/ThreadDetailScreen.tsx (MIT, see UPSTREAM.md).
import { useKeyboardScrollToEnd } from "@legendapp/list/keyboard";
import type { LegendListRef } from "@legendapp/list/react-native";
import { HeaderHeightContext } from "@react-navigation/elements";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../navigation/routes";
import * as Haptics from "expo-haptics";
import { hostReadinessCopy, type HostReadinessState } from "@solus/client-core/host-readiness";
import { isSessionBusyStatus, type SessionStarterFromHost, type SessionStatus } from "@solus/contracts/types";
import { memo, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  AppState,
  Keyboard,
  Platform,
  useWindowDimensions,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
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
  useReducedMotion,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useWorkspaceContentWidth } from "../layout/workspace-content-width";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import type { ComposerEditorHandle } from "../../components/ComposerEditor";
import { RenderErrorBoundary, RenderFailureView } from "../../components/RenderErrorBoundary";
import type { LayoutVariant } from "../../lib/layout";
import { useKeyboardCommand } from "../keyboard/use-keyboard-command";
import { conversationIdOf, type ConversationMeta, type ConversationStore } from "../conversation/conversation-store";
import { permissionForFeedback } from "../conversation/lib/transcript-model";
import { PendingApprovalCard } from "./PendingApprovalCard";
import { PendingSecretCard } from "./PendingSecretCard";
import { PendingUserInputCard } from "./PendingUserInputCard";
import { AgentPlanCard } from "./ThreadPlanCard";
import { UsageLimitRecoveryCard } from "./UsageLimitRecoveryCard";
import { ThreadSuggestionsCard } from "./ThreadSuggestionsCard";
import { FLOATING_WORKING_CONTROL_COVERAGE, FloatingWorkingControl } from "./floating-working-control";
import { backgroundFloatingStatus, type FloatingWorkingStatus } from "./floating-working-status";
import { showsBackgroundWork } from "@solus/client-core/background-work";
import { mcpTaskIsLive } from "@solus/contracts/integrations/mcp-task";
import { ThreadMcpTasks } from "./ThreadMcpTasks";
import { useMcpTasks } from "./use-mcp-tasks";
import { ThreadBackgroundWork } from "./ThreadBackgroundWork";
import { RESOURCE_WATCHES } from "@solus/client-core/resource-watch-row";
import { useResourceWatches } from "./use-resource-watches";
import { derivePendingUserInputMaxHeight, ESTIMATED_KEYBOARD_HEIGHT } from "./pendingUserInputLayout";
import { KeyboardResumeGuard } from "./android-keyboard-resume";
import { ThreadMcpPipDock } from "./ThreadMcpPipDock";
import { useTurnAnnouncements } from "./use-turn-announcements";
import {
  COMPOSER_COLLAPSED_CHROME,
  THREAD_COMPOSER_BOTTOM_GUTTER,
  ThreadComposer,
} from "./ThreadComposer";
import { ThreadFeed, type ThreadContentPresentation, type ThreadFeedHistoryControls } from "./ThreadFeed";
import { QuoteInReplyContext } from "./ThreadMarkdown";
import { useAgentRoster } from "./ThreadAgents";
import { ComposerQueuedEditBanner } from "./ComposerQueuedEdit";
import { endQueuedMessageEdit, useQueuedMessageEdit } from "./queued-message-edit";
import { agentsPillLabel } from "./agent-card-presentation";
import { threadHostChrome, withRunHostChoice } from "./lib/thread-host-chrome";
import { HostGraceWhisper } from "./ThreadHostLines";
import { ThreadRunHostRow, useRunHostRow, useRunningHostSend } from "./ThreadRunHostRow";
import { SessionPushRefusedCard } from "./SessionPushRefusedCard";
import { HostAsleepCard } from "../hosts/HostAsleepCard";
import { CloudReadNote } from "./CloudReadNote";
import type { CloudReadView } from "./lib/cloud-read-view";
import { AgentAuthSheet } from "../conversation/components/AgentAuthSheet";
import { ThreadBrowserFloat } from "../browser/ThreadBrowserFloat";
import { composerSubmissionBehavior, resolveThreadFeedSubmissionAnchor } from "./thread-feed-scroll-position";
import { useThreadViewers } from "./use-thread-viewers";
import { IntegrationConnectSheet } from "../conversation/components/IntegrationConnectSheet";

export interface ThreadDetailScreenProps {
  readonly header?: ReactNode;
  readonly draftMode?: {
    readonly content: (composerHeight: number) => ReactNode;
    readonly controls: ReactNode;
    readonly onDraftChange: (text: string) => void;
    readonly onSent: () => void;
  };
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
  readonly startedBy?: SessionStarterFromHost | null;
  readonly layoutVariant?: LayoutVariant;
  readonly usesAutomaticContentInsets?: boolean;
  /** Runs the next prompt of this started session on another host (docs/plans/portable-sessions.md §10). */
  readonly onChooseHost?: (hostId: string) => void;
  /** Opens the conversation on another host and answers it, for a prompt that goes there. */
  readonly onFollowHost?: (hostId: string) => ConversationStore | null;
  /** The session's copy from Solus Cloud stands for the host (`useCloudRead`); null when a host shows it. */
  readonly cloudRead?: { readonly view: CloudReadView; readonly onAction: () => void } | null;
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
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const isKeyboardVisible = useKeyboardState((state) => state.isVisible);
  const [sendingWithKeyboard, setSendingWithKeyboard] = useState(false);
  if (sendingWithKeyboard && !isKeyboardVisible) setSendingWithKeyboard(false);
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
  const [contentViewportHeight, setContentViewportHeight] = useState(windowHeight);
  const navigationHeaderHeight = useContext(HeaderHeightContext) || insets.top + 44;
  const composerEditorRef = useRef<ComposerEditorHandle>(null);
  const listRef = useRef<LegendListRef>(null);
  const feedTouchStartRef = useRef<{ pageX: number; pageY: number } | null>(null);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [composerHeight, setComposerHeight] = useState<number | null>(null);
  const composerHeightSettle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleComposerHeightChange = useCallback((height: number) => {
    // T3 lets native layout drive the inset each frame and settles React's
    // estimate after the 220 ms composer transition.
    setComposerHeight((current) => current ?? height);
    if (composerHeightSettle.current !== null) clearTimeout(composerHeightSettle.current);
    composerHeightSettle.current = setTimeout(() => {
      composerHeightSettle.current = null;
      setComposerHeight(height);
    }, 220);
  }, []);
  useEffect(() => () => {
    if (composerHeightSettle.current !== null) clearTimeout(composerHeightSettle.current);
  }, []);
  const [composerOverlayHeight, setComposerOverlayHeight] = useState<number | null>(null);
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const queuedEdit = useQueuedMessageEdit(store);
  const handleComposerFocusChange = useCallback(
    (focused: boolean) => {
      keyboardResumeRef.current.composerFocusChanged(focused);
      handleOwnedInputFocusChange(focused);
    },
    [handleOwnedInputFocusChange],
  );
  const [anchorMessageId, setAnchorMessageId] = useState<string | null>(null);
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
  // T3 keeps this padding fixed while the sticky view follows the keyboard.
  // Changing it at keyboardDidHide creates another layout after the keyboard lands.
  const composerBottomInset = alignedBottomInset;
  const contentPresentationKind = props.contentPresentation.kind;
  const turnActive = isSessionBusyStatus(meta.status);
  // A reader the session is shared with to view cannot prompt or stop it (docs/plans/access-model.md §2.7).
  const mayDrive = store.controller.mayDrive;
  // Answering the agent's cards is its own action, apart from prompting (docs/plans/custom-roles.md §3).
  const mayApprove = store.controller.mayApprove;
  // A live MCP task holds the session in `background`; its own row says so, with its own Cancel.
  const mcpTasks = useMcpTasks(store.controller.hostId, conversationIdOf(store), turnActive);
  const backgroundIsMcpTasks = mcpTasks.tasks.some(mcpTaskIsLive) && !meta.backgroundWorkRunning;
  // A resource watch waits for news: its row shows, and it does not hold `background`.
  const resourceWatches = useResourceWatches(store.controller.hostId, conversationIdOf(store), turnActive);
  // A settled turn can leave background work running; Stop ends it too.
  const isBackground = showsBackgroundWork(meta.status, meta.backgroundWorkRunning) && !backgroundIsMcpTasks;
  const canStop = mayDrive && (turnActive || isBackground);
  const working = isWorkingStatus(meta.status);
  const activeWorkStartedAt = workStartedAt(store, working);
  const runHostRow = useRunHostRow(store, meta);
  // While another host runs a turn of the session, the prompt goes to that host.
  const sendStore = useRunningHostSend(store, runHostRow, props.onFollowHost);
  // A copy from the cloud keeps the composer while another host can take the prompt.
  const hostChrome = withRunHostChoice(threadHostChrome(props.hostReadiness), runHostRow.keepsComposerWhileAway || (!!props.cloudRead && runHostRow.isShown));
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
    if (meta.setupStep !== null && contentPresentationKind === "ready") {
      return { kind: "preparing", label: meta.setupStep };
    }
    if (activeWorkStartedAt !== null && contentPresentationKind === "ready") {
      return { kind: "working", startedAt: activeWorkStartedAt };
    }
    if (isBackground && contentPresentationKind === "ready") {
      return backgroundFloatingStatus({ mayDrive, stopping: stoppingBackground, onStop: stopBackgroundWork });
    }
    return null;
  })();
  const hostId = store.controller.hostId;
  const sessionId = conversationIdOf(store);
  const { devicePreview, browserPreview, openBrowserPreview } = useThreadViewers(hostId, sessionId, isHostReady);
  const showFloatingStatus =
    floatingStatus !== null || queuedCount > 0 || agentsPill !== null || devicePreview !== null || browserPreview !== null;
  // The composer is hidden, not unmounted, while the host is away: its
  // keyboard must not stay up over the host footer.
  useEffect(() => {
    if (!hostChrome.showsComposer) Keyboard.dismiss();
  }, [hostChrome.showsComposer]);
  const composerOverlapHeight = composerHeight ?? COMPOSER_COLLAPSED_CHROME + composerBottomInset;
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
  // T3 reports the animated native layout directly, rather than measuring again.
  const contentInsetEndAdjustment = useSharedValue(estimatedOverlayHeight);
  const handleComposerOverlayLayout = useCallback((event: LayoutChangeEvent) => {
    const height = event.nativeEvent.layout.height;
    contentInsetEndAdjustment.set(height);
    const roundedHeight = Math.round(height);
    if (props.draftMode) setComposerOverlayHeight((current) => current === roundedHeight ? current : roundedHeight);
  }, [contentInsetEndAdjustment, props.draftMode]);
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
    estimatedOverlayHeight,
  );
  useAnimatedReaction(
    () => contentInsetEndAdjustment.value + floatingControlCoverage.value,
    (value) => {
      combinedContentInsetEndAdjustment.value = value;
    },
  );
  const { freeze, scrollMessageToEnd } = useKeyboardScrollToEnd({ listRef });
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
  }, [activeUserInputRequestId, userInputCollapsed]);
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
    setAnchorMessageId(null);
    setEndFollowEnabled(true);
    freeze.set(false);
  }, [freeze, props.threadKey]);

  const stopThread = useCallback(() => {
    // The turn already ended: Stop ends the work it left running, as the
    // desktop and web background row does.
    if (isBackground) void store.controller.stopBackgroundWork();
    else void store.controller.stop();
  }, [store, isBackground]);
  // Navigation keeps older screens mounted. They must never receive Stop
  // when the visible thread has no work to stop.
  useKeyboardCommand("stop", () => {
    if (canStop) stopThread();
  }, isFocused);

  const reduceMotion = useReducedMotion();
  const handleSent = useCallback(() => {
    props.draftMode?.onSent();
    const userIds = store.orderSnapshot().filter((id) => store.item(id)?.kind === "user");
    const messageId = userIds.at(-1) ?? null;
    let nextAnchorMessageId = anchorMessageId;
    if (messageId !== null) {
      setSubmittedMessageId(messageId);
      nextAnchorMessageId = resolveThreadFeedSubmissionAnchor({
        currentAnchorMessageId: anchorMessageId,
        submittedMessageId: messageId,
        hasStartedTurn: store.controller.run.agentSessionId !== null,
        hasUserMessage: userIds.length > 1,
        queuedMessageCount: queuedCount,
        deliveryDeferred: !isHostReady,
      });
      setAnchorMessageId(nextAnchorMessageId);
    }
    const behavior = composerSubmissionBehavior({
      isIOS: Platform.OS === "ios",
      keyboardVisible: KeyboardController.isVisible(),
      hasUserMessage: userIds.length > 1,
      contentReady: contentPresentationKind === "ready",
      anchorsSubmission: messageId !== null && nextAnchorMessageId === messageId,
    });
    if (!behavior.blurEditor) setSendingWithKeyboard(true);
    if (behavior.blurEditor) composerEditorRef.current?.blur();
    if (!behavior.dismissKeyboard) return;
    // Commit the optimistic row, then let the keyboard leave before freezing its inset.
    requestAnimationFrame(() => {
      void KeyboardController.dismiss()
        .then(() => {
          if (behavior.followSubmission) return scrollMessageToEnd({ animated: !reduceMotion, closeKeyboard: false });
        })
        .catch(() => {
          freeze.set(false);
        });
    });
  }, [anchorMessageId, contentPresentationKind, freeze, props.draftMode, reduceMotion, scrollMessageToEnd, store, queuedCount, isHostReady]);

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
  const answerSecretRequest = useCallback(
    async (values: (string | null)[]) => {
      if (activeUserInputRequestId === null) return;
      setRespondingRequestId(activeUserInputRequestId);
      await (async () => {
        await store.controller.answerSecretRequest(activeUserInputRequestId, values);
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
    <View className="flex-1" onLayout={(event) => setContentViewportHeight(event.nativeEvent.layout.height)}>
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
        {/* While the host is away the thread stays readable and scrolls; its
            state takes the composer's place below. */}
        <View className="flex-1">
          {props.draftMode ? (
            props.draftMode.content(composerOverlayHeight ?? estimatedOverlayHeight)
          ) : (
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
                  anchorMessageId={anchorMessageId}
                  contentTopInset={props.usesAutomaticContentInsets ? navigationHeaderHeight : 0}
                  contentInsetEndAdjustment={combinedContentInsetEndAdjustment}
                  sendingWithKeyboard={sendingWithKeyboard}
                  contentBottomInset={
                    estimatedOverlayHeight + (showFloatingStatus ? FLOATING_WORKING_CONTROL_COVERAGE : 0)
                  }
                  historyControls={props.historyControls}
                  startedBy={props.startedBy}
                  handoffPending={meta.handoffPending}
                  isHostAsleep={hostChrome.isAsleep && !props.cloudRead}
                  layoutVariant={props.layoutVariant}
                  usesAutomaticContentInsets={props.usesAutomaticContentInsets}
                  onEndFollowEnabledChange={setEndFollowEnabled}
                />
              </QuoteInReplyContext>
            </RenderErrorBoundary>
          )}
        </View>
      </View>

      {isHostReady ? (
        <ThreadBrowserFloat
          key={props.threadKey}
          hostId={hostId}
          sessionId={sessionId}
          top={navigationHeaderHeight + 8}
          onOpen={openBrowserPreview}
        />
      ) : null}

      {/* Floating composer — sticks to keyboard via KeyboardStickyView */}
      <KeyboardStickyView
        enabled={Platform.OS === "ios" || !keyboardStateSuspect}
        pointerEvents="box-none"
        style={{ position: "absolute", bottom: 0, left: 0, right: 0, top: 0 }}
        offset={{ closed: 0, opened: composerBottomInset }}
      >
        <Animated.View
          pointerEvents="box-none"
          style={[{ position: "absolute", bottom: 0, left: 0 }, composerWidthStyle]}
        >
          {/* No paddingTop here: the overlay's measured height becomes the
              list's bottom inset. */}
          <View onLayout={handleComposerOverlayLayout} className="w-full">
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
              devicePreview={devicePreview}
              browserPreview={browserPreview}
              agents={agentsPill}
              onOpenAgents={() => {
                Keyboard.dismiss();
                navigation.navigate("ThreadAgents", { hostId: store.controller.hostId, conversationId: conversationIdOf(store) });
              }}
            />
            {/* An MCP App in picture-in-picture rides above the composer and every request card. */}
            <ThreadMcpPipDock store={store} isKeyboardVisible={isKeyboardVisible} />
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
              {activeUserInputRequestId === null && hostChrome.showsRequestCards ? (
                <>
                  <ThreadMcpTasks view={mcpTasks} store={store} mayDrive={mayDrive} maxHeight={pendingUserInputMaxHeight} />
                  <ThreadBackgroundWork kind={RESOURCE_WATCHES} records={resourceWatches.watches} mayDrive={mayDrive} onAction={resourceWatches.stop} />
                </>
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
                      maxHeight={pendingUserInputMaxHeight}
                      onRespond={answerPermission}
                    />
                  ) : null}
                  {activePendingUserInput?.kind === "secret" ? (
                    <PendingSecretCard
                      key={activePendingUserInput.questionId}
                      request={activePendingUserInput}
                      maxHeight={pendingUserInputMaxHeight}
                      responding={respondingRequestId === activePendingUserInput.questionId}
                      mayDrive={mayApprove}
                      onSubmit={answerSecretRequest}
                    />
                  ) : activePendingUserInput ? (
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

            {props.cloudRead ? <CloudReadNote view={props.cloudRead.view} onAction={props.cloudRead.onAction} /> : null}
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
              <SessionPushRefusedCard
                store={store}
                text={runHostRow.pushRefusedText}
                onDone={() => composerEditorRef.current?.focus()}
              />
              <ThreadRunHostRow
                store={store}
                view={runHostRow}
                onChooseHost={props.onChooseHost}
                onClosed={() => composerEditorRef.current?.focus()}
              />
              {props.draftMode?.controls}
              <ThreadComposer
                store={store}
                meta={meta}
                draftKey={props.draftKey}
                editorRef={composerEditorRef}
                placeholder={permissionForFeedback(meta.permissions) ? "Send feedback to decline this request" : "Ask anything"}
                    connected={isHostReady}
                disabled={hostChrome.showsGraceWhisper}
                sendBlockedReason={
                  hostChrome.showsGraceWhisper
                    ? "Reconnecting"
                    : props.cloudRead && !isHostReady
                      ? "Choose a host in Run on"
                      : meta.phase.kind === "error"
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
                onDraftChange={props.draftMode?.onDraftChange}
                onSent={handleSent}
                sendStore={sendStore}
                onExpandedChange={setComposerExpanded}
                onHeightChange={handleComposerHeightChange}
                onEditorFocusChange={handleComposerFocusChange}
              />
            </View>
            {hostChrome.isAsleep ? (
              <HostAsleepCard
                hostId={store.controller.hostId}
                bottomInset={composerBottomInset}
                maxHeight={Math.max(0, Math.min(
                  contentViewportHeight * 0.6,
                  contentViewportHeight - navigationHeaderHeight -
                    FLOATING_WORKING_CONTROL_COVERAGE - composerBottomInset - 8,
                ))}
              />
            ) : null}
          </View>
        </Animated.View>
      </KeyboardStickyView>
      <AgentAuthSheet store={store} onClose={() => composerEditorRef.current?.focus()} />
      <IntegrationConnectSheet store={store} onClose={() => composerEditorRef.current?.focus()} />
    </View>
  );
});
