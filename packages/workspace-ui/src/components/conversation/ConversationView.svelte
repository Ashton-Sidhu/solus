<script lang="ts">
  import { shouldReadOlderHistory } from "./lib/history-prefetch";
  import { provideTranscriptDisclosure } from "./lib/transcript-disclosure.svelte";
  import { createArtifactRevisionIndexer } from "./lib/artifact-revisions";
  import { provideTurnDiffReader } from "./lib/inline-review-context";
  import { provideArtifactRevisions } from "./lib/artifact-revisions-context";
  import TranscriptItem from "./TranscriptItem.svelte";
  import ConversationTurn from "./ConversationTurn.svelte";
  import VirtualTranscript from "./VirtualTranscript.svelte";
  import SessionOriginDivider from "./SessionOriginDivider.svelte";
  import { sessionExecutionStatus } from "@solus/contracts/session-execution";
  import { hostStarterOf } from "@solus/contracts/session-starter";
  import PendingHandoffDivider from "./PendingHandoffDivider.svelte";
  import { revealTranscriptMatch } from "./lib/transcript-navigation";
  import { SearchMessageNavigation } from "./lib/search-message-navigation.svelte";
  import { Skeleton } from "../ui/skeleton";
  import { tick, untrack } from "svelte";
  import { modelLabelFor } from "@solus/contracts/types";
  import { setupActivityLabel } from "@solus/contracts/setup-card";
  import {
    FileText as FileTextIcon,
  } from "@lucide/svelte";
  import { computeCurrentActivity } from "../../contexts/workspace/session.utils";
  import {
    getWorkspaceContext,
    getSettingsContext,
    getClientShellContext,
    runtime,
    connectRequestStore,
    seatsStore,
    agentAuthStore,
  } from "../../contexts";
  import { useKeybinding } from "../../lib/keybindings/use-keybinding.svelte";
  import { getOuterScrollbarContext } from "../layout/lib/outer-scrollbar.context";
  import PermissionCard from "./PermissionCard.svelte";
  import QuestionCard from "./QuestionCard.svelte";
  import SecretRequestCard from "./SecretRequestCard.svelte";
  import AddMachineCard from "./AddMachineCard.svelte";
  import HostProvidersCard from "./HostProvidersCard.svelte";
  import CloudMachineCard from "./CloudMachineCard.svelte";
  import RateLimitCard from "./RateLimitCard.svelte";
  import ConnectCard from "../connections/ConnectCard.svelte";
  import SeatConnectCard from "../seats/SeatConnectCard.svelte";
  import TurnRefusalCard from "../connections/TurnRefusalCard.svelte";
  import { turnRefusalStore } from "../../contexts/connections/turn-refusal.store.svelte";
  import SeatNeededNotice from "../seats/SeatNeededNotice.svelte";
  import AgentAuthCard from "../seats/AgentAuthCard.svelte";
  import ComposingLine from "../presence/ComposingLine.svelte";
  import QueuedPromptGroup from "./queued/QueuedPromptGroup.svelte";
  import SuggestionGroup from "./suggestions/SuggestionGroup.svelte";
  import SessionStatusCard from "./SessionStatusCard.svelte";
  import SessionCloudRead from "./SessionCloudRead.svelte";

  import type { TaskLinkContext } from "../tasks/link-control/lib/task-link-control";
  import TurnChangesSummary from "./TurnChangesSummary.svelte";
  import ConversationMinimap from "./ConversationMinimap.svelte";
  import { FindBar } from "../ui/find-bar";
  import { createNavItemBuilder } from "./lib/minimap";
  import {
    CONVERSATION_BREADCRUMB_OFFSET,
    conversationFindTopInset,
  } from "./lib/find";
  import { createEndFollow, newTurnMinHeight, scrollConversationTo } from "./lib/response-scroll";
  import { TurnAnnouncer, turnPhaseFor } from "@solus/client-core/turn-announcement";
  import { questionAnchorScrollTop } from "./lib/question-scroll";
  import { ConversationFind } from "./lib/conversation-find.svelte";
  import {
    hasVisibleTurnBody,
    runIsLive,
    type GroupedItem,
    type Turn,
  } from "./lib/turns";
  import { TranscriptTurns } from "./lib/transcript-turns.svelte";
  import type { UserBurst } from "./lib/user-burst";
  import type { ReplySegment } from "@solus/client-core/reply-pull-requests";
  import { ConversationViewState } from "./lib/conversation-view-state.svelte";
  import { provideConversationVisibility } from "./lib/conversation-visibility";
  import SessionActionRow from "../layout/SessionActionRow.svelte";
  import ConversationLoading from "./ConversationLoading.svelte";
  import { ConversationArrival } from "./lib/conversation-arrival.svelte";
  import SessionContextMenu from "../session/SessionContextMenu.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import { serversStore } from "../../contexts/connections/servers.store.svelte";
  import { canDriveSession } from "../../contexts/sharing/resource-roles";
  import { setMarkdownImageContext } from "./lib/markdown-image";
  import { setSessionLinkContext } from "./lib/session-link-context";
  import { setHtmlBlockOrigin, wideRenderRoom } from "./lib/html-block-origin";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { readSessionMeta } from "@solus/client-core/session-meta";
  import { showsBackgroundWork } from "@solus/client-core/background-work";
  import { checkoutPlace, runHost } from "../../contexts/workspace/run-location";
  import { measureMount } from "../../lib/mount-timing";
  measureMount("ConversationView");

  const session = getWorkspaceContext();
  const outerScrollbar = getOuterScrollbarContext();
  const settings = getSettingsContext();
  const shell = getClientShellContext();
  let {
    tabId,
    forceVisible = false,
    surfaceVisible = true,
    bandAbove = true,
    showActions = true,
    keepTranscriptVisible = false,
    onReady,
    viewState = new ConversationViewState(),
    paneId,
  }: {
    tabId: string;
    forceVisible?: boolean;
    surfaceVisible?: boolean;
    bandAbove?: boolean;
    showActions?: boolean;
    keepTranscriptVisible?: boolean;
    onReady?: () => void;
    /** The pool hands back what the reader left open and where they were.
     *  A split-pane view keeps its own. */
    viewState?: ConversationViewState;
    /** The pane this view fills, when it fills one of its own; unset in the
     *  workspace's own column. The Run on shortcut names it. */
    paneId?: string;
  } = $props();
  // Read once: a view is mounted for one tab and keeps that tab's state.
  const { disclosure, turnExpansion, virtualizer } = untrack(() => viewState);
  provideTranscriptDisclosure(disclosure);

  // The pool instance is on screen only while its tab is active; the split-pane
  // instance (forceVisible) is always on screen. Visibility gates autoscroll and
  // transcript work; keybindings stay gated on the focused chat so the two visible
  // instances never both respond to one shortcut.
  const isVisible = $derived(
    surfaceVisible && (forceVisible || tabId === session.activeTabId),
  );
  provideConversationVisibility(() => isVisible);

  const tab = $derived(session.tabs[tabId]);
  const sess = $derived(session.sessionFor(tabId));
  const execution = $derived(sess ? session.sessions.executionFor(runHost(sess.run), sess.id) : undefined);
  const displayedStatus = $derived(execution ? sessionExecutionStatus(execution) : sess?.status);
  const hostStarter = $derived(hostStarterOf(sess?.startedBy));
  // §16 — a turn collapses to one row when it ends. Until then it renders the
  // transcript it always did, in the order it happened.
  const isTurnLive = $derived(runIsLive(sess?.status));
  // Built one segment at a time: a streamed token or a new tool call rebuilds
  // only the segment it lands in, and settled turns keep their identity.
  const transcript = new TranscriptTurns(
    () => sess?.messages ?? [],
    () => isTurnLive,
  );
  const indexArtifactRevisions = createArtifactRevisionIndexer();
  const artifactRevisions = $derived(
    indexArtifactRevisions(transcript.segments.flatMap((segment) => segment.artifacts)),
  );
  provideArtifactRevisions(() => artifactRevisions);
  const guideSessionId = $derived(sess?.id);
  const guideApi = $derived(sess ? serverConnections.apiFor(runHost(sess.run)) : undefined);
  const guideReadiness = $derived(guideSessionId ? serversStore.readinessFor(runHost(sess!.run)).readiness : undefined);
  const guideReader = $derived.by(() => {
    const api = guideApi;
    const id = guideSessionId;
    const organization = serversStore.activeOrganizationId;
    if (!api || !id || guideReadiness !== "ready") return undefined;
    return (index: number) => {
      const ctx = session.ctxFor(tabId);
      return ctx.session.sessionId === id && organization === serversStore.activeOrganizationId ? api.diff(ctx, { scope: { kind: "turn", index } }) : Promise.resolve(null);
    };
  });
  provideTurnDiffReader(() => guideReader);
  // Only a handoff the host made before its new provider has a thread (plan
  // acceptance) is still open; a send-time handoff names its model itself.
  const activeHandoffDivider = $derived(
    sess?.handoffPending
      ? sess.messages.findLast(
          (message) => message.activity?.kind === "agent_switched" && message.activity.provider === sess.run.provider,
        )
      : undefined,
  );
  const activeHandoffTargetModel = $derived.by(() => {
    const provider = sess?.run.provider;
    const modelId = sess?.run.modelConfig.modelId;
    if (!provider || !modelId) return null;
    return modelLabelFor(provider, modelId);
  });
  setMarkdownImageContext({
    cwd: () => checkoutPlace(sess?.run)?.path,
    serverId: () => runHost(sess?.run),
    ctx: () => (sess ? session.ctxFor(tabId) : undefined),
    api: () => (sess ? serverConnections.apiFor(runHost(sess.run)) : undefined),
  });
  setSessionLinkContext(() => runHost(sess?.run));
  // What every card's Link control needs: the host that owns the
  // conversation's tasks, its project, and the task the conversation itself
  // belongs to — the one-click target. Resolved once here, not per card.
  const conversationTaskId = $derived(
    sess
      ? (session.issuesStore.taskForSession(sess.id)?.id ??
        session.issuesStore.taskForSession(sess.agentSessionId)?.id ??
        null)
      : null,
  );
  const linkContext: TaskLinkContext = $derived({
    serverId: runHost(sess?.run),
    conversationTaskId,
  });
  // An HTML block renders from deep inside the markdown tree, where these props
  // do not reach. Saving one as an artifact still has to file the work against
  // this conversation's host rather than the active tab's.
  setHtmlBlockOrigin(() => ({ tabId, linkContext, sideRoom: wideRoom }));
  const sessionHostId = $derived(runHost(sess?.run));
  const hostState = $derived(sessionHostId ? serversStore.readinessFor(sessionHostId) : null);
  /** Past its grace and not back yet: what needs the host (composer, actions) is
   *  hidden, and the host's state and diagnostics take its place. */
  const isHostAway = $derived(!!hostState?.away);
  // No host shows the session: its copy in Solus Cloud, read only, or why there is none.
  const cloudRead = $derived(sess ? session.cloudTranscripts.stateFor(sess, serverConnections.resolveId(runHost(sess.run)), isHostAway) : null);
  $effect(() => {
    if (cloudRead?.shouldRead && isVisible) untrack(() => void session.cloudTranscripts.open(tabId));
  });
  // ─── Breadcrumb room ───
  // The band that says where you are belongs to the pane, not to this
  // transcript: `WorkspaceBody` draws it over the leading pane and
  // `AsidePaneShell` puts it in its chrome row. Only the leading one floats, so
  // only the pool instance reserves room under it — a pinned instance
  // (forceVisible) sits below a row that already took its own height.
  // A shell that draws no band at all passes `bandAbove={false}`: the mobile web
  // shell states project / task / state in its own opaque navbar instead, and
  // reserving room for a band nobody painted left dead space above the first
  // message. Only the shell knows, so it tells us rather than us guessing from a
  // viewport width that is equally narrow in a desktop split.
  const reservesBandRoom = $derived(
    bandAbove && (isVisible || keepTranscriptVisible) && !forceVisible,
  );
  // 46px of band plus the gap under it.
  const CRUMB_OFFSET = CONVERSATION_BREADCRUMB_OFFSET;
  let stripMenu = $state<{ tabId: string; x: number; y: number } | null>(null);

  let scrollEl: HTMLDivElement | null = $state(null);
  let messagesEl: HTMLDivElement | null = $state(null);
  let readingColumnEl: HTMLDivElement | null = $state(null);
  // Each message's hover rail hangs in this gutter and wraps only when it is too narrow.
  let transcriptWidth = $state(0);
  let readingColumnWidth = $state(0);
  const wideRoom = $derived(wideRenderRoom(transcriptWidth, readingColumnWidth));
  // The one owner of following the end. It lives as long as the scroller, not
  // its visibility, so a hidden view still knows whether the reader was at the
  // end when it is shown again.
  let endFollow: ReturnType<typeof createEndFollow> | undefined;
  $effect(() => {
    if (!scrollEl) return;
    const follower = createEndFollow(scrollEl, untrack(() => viewState.position) === null);
    endFollow = follower;
    return () => { follower.destroy(); endFollow = undefined; };
  });
  // Content grew. While a turn is live, every change glides to the end, as in
  // T3 Code: the sent prompt, the activity row, tool rows, and each paragraph.
  // An instant write for each of them reads as a series of jumps.
  function followEnd() {
    if (!isVisible || waitingForHistory || arrival.pending) return;
    endFollow?.follow(isTurnLive);
  }
  let hovered = $state(false);
  let findBarRef: FindBar | null = $state(null);
  const find = new ConversationFind(
    () => sess?.messages ?? [],
    async (match) => {
      endFollow?.release();
      await revealTranscriptMatch({
        match, turns, turnId: messageTurns.get(match.messageId), virtualizer,
        expand: (turn) => { turnExpansion.set(turn.id, true); void session.toolHistory.load(turn.tools); },
        elements: () => ({ messages: messagesEl, scroll: scrollEl }),
        highlight: (messages) => find.highlighter.update(messages, find.query, match),
      });
    },
  );
  $effect(() => () => find.destroy());

  // The conversation now runs flush to the project rail, so its own 2px track
  // would land exactly on the seam and read as a divider between the thread and
  // the section cards. Hand scroll position to the workspace-edge scrollbar,
  // which sits past the rail. Registered only while visible — every tab stays
  // mounted, and a hidden one would otherwise claim the shared indicator.
  $effect(() => {
    const element = scrollEl;
    if (!outerScrollbar || !element || !isVisible) return;
    // Track visibility and the element, not the target list changed by registration.
    return untrack(() => outerScrollbar.register(element));
  });
  let historyError = $state("");
  let expandingHistory = $state(false);
  let loadingOlder = false;
  const waitingForHistory = $derived(!!sess?.loadingHistory && sess.messages.length === 0);
  const arrival = new ConversationArrival({
    viewState: untrack(() => viewState),
    scroll: () => scrollEl,
    follower: () => endFollow,
    openingSearch: () => searchNavigation.opening,
    pendingRowData: () => (sess ? session.lifecycle.pendingTurnSnapshots(sess.id) : undefined),
    hasOlderHistory: () => hasOlderTurnsToLoad && !historyError,
    loadOlderHistory: () => session.lifecycle.expandHistory(tabId),
    onSettled: () => backfillShortTranscript(),
  });
  const showsCloudPane = $derived(
    !!sess && sess.messages.length === 0 && (isHostAway || !!cloudRead?.view),
  );
  let hasSettled = $state(false);
  const hidesTranscript = $derived(
    waitingForHistory || (arrival.pending && !(hasSettled && keepTranscriptVisible)),
  );
  $effect(() => {
    if (!isVisible || !tab || !sess) return;
    const settled = !waitingForHistory && !arrival.pending;
    if (settled) hasSettled = true;
    if (showsCloudPane || settled) untrack(() => onReady?.());
  });
  async function jumpToEnd() {
    requestInputFocus({ tabId });
    await arrival.jumpToEnd(() => isVisible);
    handleScroll();
  }
  const searchNavigation = new SearchMessageNavigation({
    hostId: () => sessionHostId, sessionId: () => sess?.id ?? "",
    ready: () => isVisible && !!sess && !sess.loadingHistory && !!scrollEl,
    messages: () => sess?.messages ?? [], hasOlder: () => sess?.historyTruncated ?? false,
    loadOlder: () => session.lifecycle.expandHistory(tabId),
    stillWanted: () => isVisible,
    reveal: async (messageId, word) => {
      await tick(); endFollow?.release(); await find.openAt(messageId, word);
      viewState.position = virtualizer.position();
    },
    unavailable: (error) => toasts.error("Could not open the matching message", {
      description: error instanceof Error ? error.message : "The message is no longer available",
    }),
  });
  $effect(() => {
    // Initial reads and reconnects retain usable rows; only an empty read waits.
    const sessionId = sess?.id;
    if (!sessionId || !isVisible || !scrollEl || waitingForHistory) return;
    return untrack(() => arrival.open());
  });

  // A restored window can contain hundreds of tool events that collapse into
  // only a few completed-turn rows. In that case there is no scrollbar and
  // therefore no scroll event to request the history that precedes the
  // window. Keep backfilling until the user has an actual scroll range (or
  // the complete transcript is mounted).
  function backfillShortTranscript() {
    const el = scrollEl;
    if (
      el && isVisible && !arrival.pending &&
      el.clientHeight > 0 &&
      el.scrollHeight <= el.clientHeight &&
      hasOlderTurnsToLoad && !historyError
    ) {
      void maybeLoadOlder();
    }
  }

  // Infinite scroll reads the next page while the reader is still a few
  // screens from the top, so it arrives before they reach it; a reader at the
  // end reads none (`shouldReadOlderHistory`). The scroll position is anchored
  // across the insert so the previously-visible messages stay put rather than
  // jumping when content is added above them.
  const nearTop = (el: HTMLElement) => shouldReadOlderHistory({
    scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, atEnd: endFollow?.atEnd ?? false,
  });
  // `force` is a tap on the button at the top of the thread rather than a
  // scroll that arrived there, so it does not ask where the scroller is.
  async function maybeLoadOlder(opts?: { force?: boolean }) {
    const el = scrollEl;
    if (!el || loadingOlder || waitingForHistory || arrival.pending) return;
    if (!opts?.force && !nearTop(el)) return;
    if (!hasOlderTurnsToLoad || (historyError && !opts?.force)) return;

    loadingOlder = true;
    historyError = "";
    endFollow?.hold();
    try {
      expandingHistory = true;
      await session.lifecycle.expandHistory(tabId);
      await tick();
    } catch (error) {
      historyError = error instanceof Error ? error.message : "Could not load earlier messages.";
    } finally {
      expandingHistory = false;
      loadingOlder = false;
    }
    backfillShortTranscript();
    // A short page can leave the reader still near the top: read the next one.
    if (isVisible && !arrival.pending && !historyError) void maybeLoadOlder();
  }

  function handleScroll() {
    const el = scrollEl;
    // A hidden view's scroll events are its layout being dropped, and an
    // arriving view's are that layout coming back: neither is the reader.
    if (!el || !isVisible || arrival.pending) return;
    if (arrival.jumpingToEnd) return;
    endFollow?.measure();
    arrival.isAwayFromEnd = !(endFollow?.atEnd ?? true);
    viewState.position = endFollow?.atEnd ? null : virtualizer.position();
    if (nearTop(el)) void maybeLoadOlder();
  }

  // Load history for navigation; virtualization still bounds mounted rows.
  async function revealAll() {
    if (sess?.historyTruncated) {
      expandingHistory = true;
      try {
        await session.lifecycle.expandHistory(tabId, { full: true });
      } finally {
        expandingHistory = false;
      }
    }
    await tick();
  }

  // Structural changes that should re-pin the view to the bottom. Content growth
  // inside an existing message is handled by the ResizeObserver below, so it
  // deliberately stays out of this trigger.
  const scrollTrigger = $derived.by(() => {
    const msgCount = sess?.messages.length ?? 0;
    const permLen = sess?.permissionQueue?.length ?? 0;
    const qLen = sess?.questionQueue?.length ?? 0;
    const outbound = sess?.outboundPrompts?.length ?? 0;
    return `${msgCount}:${permLen}:${qLen}:${outbound}`;
  });

  let previousQuestionCount = 0;
  $effect(() => {
    void scrollTrigger;
    const questionCount = sess?.questionQueue?.length ?? 0;
    const questionMounted = previousQuestionCount === 0 && questionCount > 0;
    previousQuestionCount = questionCount;
    if (isVisible && endFollow?.atEnd) {
      if (questionMounted) {
        // A question needs the turn that led to it. Keep a slice of that turn
        // above the card instead of pinning the card's (potentially very tall)
        // bottom to the viewport.
        endFollow?.hold();
        requestAnimationFrame(() => {
          const el = scrollEl;
          const card = el?.querySelector<HTMLElement>(
            '[data-testid="question-card"]',
          );
          if (!el || !card || !isVisible) return;
          const scrollRect = el.getBoundingClientRect();
          const cardRect = card.getBoundingClientRect();
          el.scrollTop = questionAnchorScrollTop(
            el.scrollTop,
            cardRect.top - scrollRect.top,
            el.clientHeight,
          );
          // Keep card expansion and textarea growth from immediately undoing
          // this context-preserving anchor.
          endFollow?.release();
        });
      } else {
        requestAnimationFrame(followEnd);
      }
    }
  });

  const hasOlderTurnsToLoad = $derived(sess?.historyTruncated ?? false);

  // The message navigator is a left-gutter rail in wide layouts only. The rail
  // itself hides when the gutter is too narrow.
  const showMessageNavigation = $derived(shell.hasProjectPanel);
  // Gate on showMessageNavigation: without this the derived rebuilds on every
  // message change in mobile layouts where it is never rendered.
  const buildNavItems = createNavItemBuilder();
  const navItems = $derived(
    showMessageNavigation ? buildNavItems(sess?.messages ?? []) : [],
  );

  async function prepareMinimapNavigate(id: string) {
    const turnId = messageTurns.get(id);
    if (!turnId) return;
    endFollow?.release();
    await virtualizer.reveal(turnId);
  }

  // Screen readers hear a turn start, wait, and end. A phase is only seen as it
  // arrives, so this cannot be a $derived of the current status.
  const turnAnnouncer = new TurnAnnouncer();
  let turnAnnouncement = $state("");
  $effect(() => {
    const phase = sess && displayedStatus ? turnPhaseFor(displayedStatus, execution?.awaitingApproval ?? (sess.permissionQueue.length > 0)) : null;
    turnAnnouncer.observe(tabId, phase);
    turnAnnouncement = turnAnnouncer.text;
  });

  const isAwaitingPlan = $derived(displayedStatus === "awaiting_plan");
  const isAwaitingInput = $derived(displayedStatus === "awaiting_input");
  const currentActivity = $derived(sess ? computeCurrentActivity(sess) : "");
  const activityLabel = $derived(
    isAwaitingPlan ? "Awaiting plan approval" : currentActivity || undefined,
  );
  // While setup runs, the status row names its step, as the setup card does.
  const setupLabel = $derived(setupActivityLabel(sess?.statusCard) ?? undefined);
  // Running, stopped and failed are all reported by the turn's own activity row
  // (§16, §17) — the strip only carries what no turn can express.
  const showActivityStrip = $derived(!!sess && isAwaitingPlan);
  const showSessionActions = $derived(!!tab && showActions && !isHostAway);
  let activityReservedWidth = $state(0);

  const turns = $derived(transcript.turns);
  const messageTurns = $derived(transcript.messageTurns);
  function navigationTop(id: string): number | undefined {
    const turnId = messageTurns.get(id);
    return turnId ? virtualizer.top(turnId) : undefined;
  }
  // Scrollback and history loads mount completed turns as one stable transcript.
  // Only new work at the live edge may animate in.
  // Successful and historical work stays compact. The latest failed work opens
  // by default so its commands are immediately available; an explicit user
  // choice then wins and survives transcript re-renders and remounts
  // (`turnExpansion` belongs to the view state).
  function toggleTurn(id: string, expanded: boolean) {
    // The fold opens below its row: holding the end lets it open downward
    // instead of dragging the row the reader clicked off the top.
    endFollow?.hold();
    turnExpansion.set(id, !expanded);
    if (!expanded) void session.toolHistory.load(turns.find((turn) => turn.id === id)?.tools ?? []);
  }

  async function openFind() {
    find.isOpen = true;
    if (sess?.historyTruncated) {
      expandingHistory = true;
      try {
        await session.lifecycle.expandHistory(tabId, { full: true });
      } finally {
        expandingHistory = false;
      }
    }
    await tick();
    await findBarRef?.focusInput();
  }

  /** Ends only what the agent left running; its finished turn is untouched. */
  async function stopBackgroundWork(): Promise<void> {
    try {
      const stopped = await session
        .apiFor(tabId)
        .stopBackgroundTasks(session.ctxFor(tabId).session.sessionId);
      if (!stopped) toasts.error("The background task could not be stopped");
    } catch {
      toasts.error("The background task could not be stopped");
    }
    requestInputFocus({ tabId });
  }

  function closeFind() {
    find.close();
    requestInputFocus({ tabId });
  }

  async function updateFindQuery(value: string) {
    find.setQuery(value);
    await tick();
    if (find.matches.length > 0) await find.step(1);
    else find.paint(messagesEl);
    void findBarRef?.focusInput(false);
  }

  async function navigateFind(direction: 1 | -1) {
    await find.step(direction);
    void findBarRef?.focusInput(false);
  }

  $effect(() => {
    if (!find.isOpen) {
      find.highlighter.clear();
      return;
    }
    void virtualizer.range;
    void virtualizer.pinnedKeys;
    void find.matches;
    void find.active;
    void tick().then(() => find.paint(messagesEl));
  });

  function handleRetry() {
    session.dispatch.retryLastMessage(tabId);
  }

  const sessionChangedFiles = $derived(sess?.sessionChangedFiles ?? []);
  // Each settled turn keeps its own closing summary: what that run touched. It
  // stays with the turn when the next prompt lands, and the next turn gets its own.
  const turnSnapshots = $derived(
    sess ? (session.lifecycle.turnSnapshots[sess.id] ?? []) : [],
  );
  // Snapshots otherwise load when a live turn settles, so a conversation opened
  // from history asks for its own once.
  $effect(() => {
    if (!settings.showDiffSummaryAfterTurn || !sess?.agentSessionId) return;
    if (sess.id in session.lifecycle.turnSnapshots) return;
    const sessionId = sess.id;
    untrack(() => void session.lifecycle.refreshTurnSnapshots(sessionId));
  });

  useKeybinding("conversation.find", () => openFind(), {
    enabled: () => tabId === session.focusedChatTabId,
  });

  useKeybinding("conversation.close-find", closeFind, {
    enabled: () => find.isOpen && tabId === session.focusedChatTabId,
  });

  useKeybinding(
    "conversation.scroll-top",
    async () => {
      if (!scrollEl) return;
      // Pull in any older messages first so "top" is the real first message.
      await revealAll();
      endFollow?.release();
      if (scrollEl) scrollConversationTo(scrollEl, 0);
    },
    { enabled: () => tabId === session.focusedChatTabId },
  );

  useKeybinding(
    "conversation.scroll-bottom",
    () => void jumpToEnd(),
    { enabled: () => tabId === session.focusedChatTabId },
  );

  useKeybinding(
    "conversation.open-files",
    () => {
      window.dispatchEvent(
        new CustomEvent("solus:review-changed-files", {
          detail: { tabId },
        }),
      );
    },
    { enabled: () => tabId === session.focusedChatTabId },
  );

  useKeybinding(
    "conversation.open-artifacts",
    () => {
      if (sess?.id) session.openArtifacts(sess.id);
    },
    { enabled: () => tabId === session.focusedChatTabId && !!sess?.id },
  );

  // The interrupt key, and Cancel on a setup card: the tab settles now, the host stops the run.
  function stopRun() {
    session.controls.interruptTabSession(tabId);
    void session.apiFor(tabId).stopSession(session.ctxFor(tabId).session.sessionId);
    requestInputFocus();
  }

  useKeybinding(
    "conversation.interrupt",
    stopRun,
    {
      enabled: () =>
        tabId === session.focusedChatTabId &&
        (sess?.status === "running" || sess?.status === "connecting") &&
        canDriveSession(runHost(sess.run), sess.id),
    },
  );

  // The first message of a session, sent from this view, keeps a view of room
  // while its turn is the last one, so the end shows it at the top and its
  // reply fills down.
  let firstMessageId = $state<string | null>(null);
  let scrollerHeight = $state(0);
  const reservedTurn = $derived.by(() => {
    const turnId = firstMessageId ? messageTurns.get(firstMessageId) : undefined;
    if (!turnId || turnId !== turns.at(-1)?.id) return undefined;
    return { key: turnId, minHeight: newTurnMinHeight(scrollerHeight, reservesBandRoom ? CRUMB_OFFSET : 0) };
  });
  $effect(() => {
    const handler = (e: Event) => {
      if (!(e instanceof CustomEvent)) return;
      const detail: { tabId?: string; sent?: { firstMessageId?: string } } = e.detail;
      if (detail?.tabId && detail.tabId !== tabId) return;
      if (!isVisible) return;
      if (detail.sent?.firstMessageId) firstMessageId = detail.sent.firstMessageId;
      // Rows that settle after this frame grow the reading column, and its
      // ResizeObserver follows them to the true end. A sent prompt paints
      // first and then glides up into view.
      if (detail.sent) endFollow?.glideAfterPaint();
      else requestAnimationFrame(() => endFollow?.jump());
    };
    window.addEventListener("solus:scroll-conversation-bottom", handler);
    return () =>
      window.removeEventListener("solus:scroll-conversation-bottom", handler);
  });

  // Re-anchor when either the input dock or the reading column changes height.
  // Observe the whole column, not only the message list: the turn's diff
  // summary and the action-row spacer mount below the list when a turn ends,
  // and without a re-pin the action row covers them.
  // ResizeObserver runs after layout and avoids a forced layout read.
  $effect(() => {
    const el = scrollEl;
    const content = readingColumnEl;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (el.clientHeight > 0 && el.scrollHeight <= el.clientHeight && hasOlderTurnsToLoad) {
        backfillShortTranscript();
        return;
      }
      followEnd();
    });
    ro.observe(el);
    ro.observe(content);
    return () => ro.disconnect();
  });

  async function navigateToSourceSession(sourceSessionId: string) {
    // The source session lives on the same host as the transcript citing it.
    const matchingTabId = session.tabIdForHostSession(
      sourceSessionId,
      runHost(sess?.run),
    );
    if (matchingTabId) {
      session.selectTab(matchingTabId);
      return;
    }
    // Not open — read it on this conversation's host and resume it. The
    // source session delegated to this one, so it lives on the same host.
    if (!sess) return;
    const meta = await readSessionMeta(runHost(sess.run), sourceSessionId);
    if (meta) {
      await session.opening.resumeSession(meta);
    }
  }
</script>

<div class="sr-only" role="status" aria-live="polite">{turnAnnouncement}</div>

<!-- No container: assistant prose sits directly on the canvas. Cards, code and
     tables are the only boxes it may draw. -->

<!-- A host that is away has nothing to load: the pane stays empty rather than
     a skeleton that never ends. Its state is in the composer's place. -->
{#if tab && showsCloudPane}
  {#if cloudRead?.view}<SessionCloudRead {tabId} view={cloudRead.view} placement="pane" />{:else}<div class="h-full"></div>{/if}
{:else if tab && sess}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- The anchor an MCP App frame in picture-in-picture floats against
       (McpAppFrame): scoped, so each visible conversation holds its own. -->
  <div
    onmouseenter={() => (hovered = true)}
    onmouseleave={() => (hovered = false)}
    class="flex h-full min-h-0 flex-col [anchor-name:--solus-conversation] [anchor-scope:--solus-conversation]"
    data-slot="conversation"
    aria-busy={waitingForHistory || arrival.pending}
  >
    <div class="cv-root relative min-h-0 flex-1">
      {#if hidesTranscript}
        <div class="pointer-events-none absolute inset-0">
          <ConversationLoading />
        </div>
      {/if}
      {#if find.isOpen}
        <div
          class="absolute right-3 z-20"
          style:top="{conversationFindTopInset(reservesBandRoom)}px"
        >
          <FindBar
            bind:this={findBarRef}
            query={find.query}
            current={find.position}
            total={find.matches.length}
            onQueryChange={updateFindQuery}
            onNext={() => navigateFind(1)}
            onPrev={() => navigateFind(-1)}
            onClose={closeFind}
            placeholder="Find in conversation"
            ariaLabel="Find in conversation"
            debounceMs={120}
          />
        </div>
      {/if}
      <div
        bind:this={scrollEl}
        bind:clientWidth={transcriptWidth}
        bind:clientHeight={scrollerHeight}
        data-slot="transcript"
        data-conversation-tab-id={tabId}
        class:outer-scroll-source={!!outerScrollbar}
        class="conversation-selectable h-full overflow-y-auto overflow-x-hidden px-4 pt-1 pb-[var(--solus-composer-inset,0px)] transition-opacity duration-300 motion-reduce:transition-none"
        style="overscroll-behavior-y:contain;overflow-anchor:none"
        onscroll={handleScroll}
      >
        <!-- Centered reading column: the message stream and the status strip
             share one fluid column (scales with the conversation pane via
             --solus-reading-max) so everything lines up. -->
        <div
          bind:this={readingColumnEl}
          bind:clientWidth={readingColumnWidth}
          class="w-full"
          class:opacity-0={hidesTranscript}
          inert={hidesTranscript}
          style="max-width:var(--solus-reading-max);margin-inline:auto;--transcript-gutter:{Math.max(0, (transcriptWidth - readingColumnWidth) / 2)}px;--wide-render-room:{wideRoom}px{reservesBandRoom
            ? `;padding-top:${CRUMB_OFFSET}px`
            : ''}"
        >
          <!-- One row of fixed height while older history exists. Its states
               swap inside it, so the rows below never move: the virtualizer
               holds the reader's place when rows change, not when content
               above the list grows mid-scroll. The row leaves in the same
               update that renders the last page, which the virtualizer
               corrects. -->
          {#if hasOlderTurnsToLoad || historyError}
            <div class="flex h-12 items-center justify-center">
              {#if expandingHistory}
                <div class="flex w-full flex-col gap-2 px-3" role="status" aria-busy="true" aria-label="Loading earlier messages">
                  <Skeleton class="h-3 w-3/4" />
                  <Skeleton class="h-3 w-1/2" />
                </div>
              {:else if historyError}
                <div role="alert" class="flex min-w-0 items-center gap-2 text-sm">
                  <span class="truncate">{historyError}</span>
                  <button type="button" class="shrink-0 underline" onclick={() => void maybeLoadOlder({ force: true })}>Retry</button>
                </div>
              {:else if runtime.isTouchDevice}
                <!-- Touch clients can request earlier turns with a button as
                     well as the automatic paging available when scrolling up. -->
                <button
                  type="button"
                  class="flex h-8 cursor-pointer items-center rounded-full border-0 bg-(--card) px-3.5 text-xs font-medium text-(--solus-text-primary) shadow-[shadow:var(--elev-ring)] transition-transform duration-[120ms] active:scale-[0.96] [-webkit-tap-highlight-color:transparent]"
                  onclick={() => void maybeLoadOlder({ force: true })}
                >
                  Load earlier turns
                </button>
              {/if}
            </div>
          {/if}

          {#if hostStarter && !hasOlderTurnsToLoad}
            <SessionOriginDivider origin={hostStarter} />
          {/if}

          <VirtualTranscript {tabId}
            {turns}
            {virtualizer}
            {reservedTurn}
            scrollElement={scrollEl}
            paintReady={!waitingForHistory && !arrival.pending}
            active={isVisible}
            bind:element={messagesEl}
          >
            {#snippet children(turn: Turn, turnIdx: number, burst: UserBurst)}
              <ConversationTurn {turn} {burst} {tabId} index={turnIdx} total={turns.length}
                nextStartedAt={turns[turnIdx + 1]?.startedAt ?? null}
                expanded={turnExpansion.get(turn.id) ?? (turnIdx === turns.length - 1 && turn.end?.kind === "failed" && hasVisibleTurnBody(turn))}
                {isAwaitingInput} {activityLabel} {setupLabel} turnStart={sess.currentTurnStart}
                providerStartup={turnIdx === turns.length - 1 && turn.live ? sess.providerStartup : undefined}
                hasBackgroundWork={showsBackgroundWork(sess.status, !!sess.backgroundWorkRunning)}
                onStopBackgroundWork={stopBackgroundWork}
                attempt={sess.retryAttempt ?? 1} history={session.toolHistory}
                onToggle={(expanded) => toggleTurn(turn.id, expanded)} onRetry={handleRetry}
                serverId={runHost(sess.run)} {transcriptItem}
                settledSetupCard={turnIdx === turns.length - 1 && sess.statusCard?.status === "done" ? sess.statusCard : undefined} />
              {#if settings.showDiffSummaryAfterTurn}
                <TurnChangesSummary {tabId} sessionId={sess.id} {turns} {turnIdx} {turnSnapshots} />
              {/if}
            {/snippet}
          </VirtualTranscript>

          <PendingHandoffDivider session={sess} />
          <!-- At the end, where the reader is: what the copy is, and what is newer. -->
          {#if cloudRead?.view}<SessionCloudRead {tabId} view={cloudRead.view} placement="notice" />{/if}

          {#snippet transcriptItem(item: GroupedItem, skipMotion: boolean, burst?: UserBurst, replySegments?: ReplySegment[])}
            <TranscriptItem {item} {skipMotion} {burst} {replySegments} {tabId} {linkContext}
              {activeHandoffDivider} {activeHandoffTargetModel}
              navigateToSourceSession={navigateToSourceSession} />
          {/snippet}

          <!-- Every card below asks the host for something. While the host is
               away none of them can work, so the host panel stands alone.
               They paint over an MCP App frame in picture-in-picture (z-6):
               a decision is never under the app. -->
          <div class="relative z-[7]">
          {#if !isHostAway}
          <!-- A finished setup card belongs to the turn its send started, so the
               last turn draws it; this slot is for setup that runs or failed. -->
          <SessionStatusCard {sess} {tabId} onCancel={stopRun} />

          {#if sess.permissionQueue.length > 0}
            <PermissionCard
              tabId={tab.id}
              permission={sess.permissionQueue[0]}
              queueLength={sess.permissionQueue.length}
            />
          {/if}

          {#if sess.questionQueue.length > 0}
            {#if sess.questionQueue[0].kind === "secret"}
              <!-- A request_secret card: answered with secretRequestAnswer, never respondQuestion.
                   Keyed so the next card starts with empty fields. -->
              {#key sess.questionQueue[0].questionId}
                <SecretRequestCard tabId={tab.id} request={sess.questionQueue[0]} />
              {/key}
            {:else if sess.questionQueue[0].kind === "host-link"}
              <!-- An add_host card: it does the work on the session host, then answers with respondQuestion.
                   Keyed so the next card starts with empty fields. -->
              {#key sess.questionQueue[0].questionId}
                <AddMachineCard tabId={tab.id} request={sess.questionQueue[0]} />
              {/key}
            {:else if sess.questionQueue[0].kind === "host-providers" && sess.questionQueue[0].hostProviders}
              <!-- add_host's Sign in card: the session host closes it when the new host reports the sign-in. -->
              {#key sess.questionQueue[0].questionId}
                <HostProvidersCard tabId={tab.id} request={sess.questionQueue[0]} ask={sess.questionQueue[0].hostProviders} />
              {/key}
            {:else if sess.questionQueue[0].kind === "cloud-machine" && sess.questionQueue[0].cloudMachine}
              <!-- A cloud machine tool's card: it collects the choice and answers with respondQuestion.
                   Keyed so the next card starts with its own fields. -->
              {#key sess.questionQueue[0].questionId}
                <CloudMachineCard tabId={tab.id} request={sess.questionQueue[0]} ask={sess.questionQueue[0].cloudMachine} />
              {/key}
            {:else}
              <QuestionCard
                tabId={tab.id}
                request={sess.questionQueue[0]}
                provider={sess.run.provider}
              />
            {/if}
          {/if}

          <!-- The card is the *decision* surface, so it only stands while the
               user still has one to make. Once the prompt is queued, its state
               rides on the bubble instead. -->
          {#if sess.status === "rate_limited"}
            <RateLimitCard tabId={tab.id} />
          {/if}

          <!-- The request belongs to the session whose agent needs the account;
               a different active conversation must not receive its Continue. -->
          {#if connectRequestStore.visibleFor(runHost(sess.run), sess.id)}
            <ConnectCard tabId={tab.id} />
          {/if}
          <!-- The host refused this conversation's prompt for want of a seat; the
               card offers the connect flow where the turn would have run. -->
          <!-- The organization model refused this reader's turn: which
               organization it needs, and the control that fixes it. -->
          {#if turnRefusalStore.visibleFor(runHost(sess.run), sess.id)}
            <TurnRefusalCard tabId={tab.id} />
          {/if}
          {#if seatsStore.visibleFor(runHost(sess.run), sess.id)}
            <SeatConnectCard />
          {:else if runHost(sess.run)}
            <!-- Before they send: the reader's seat for this agent on this host. -->
            <SeatNeededNotice serverId={runHost(sess.run)} provider={sess.run.provider} turnRunning={isTurnLive} />
          {/if}
          <!-- A sign-in this conversation asked for with /design-login or /mcp login. -->
          {#if agentAuthStore.visibleFor(runHost(sess.run), sess.id)}
            <AgentAuthCard />
          {/if}
          {/if}
          </div>
          <QueuedPromptGroup tabId={tab.id} />
          <SuggestionGroup tabId={tab.id} />
          <!-- Someone else's prompt is on its way: it lands here, so the notice does too. -->
          <ComposingLine serverId={runHost(sess.run)} sessionId={sess.id} />

          {#if showSessionActions}
            <div class="min-h-9"></div>
          {/if}
        </div>
      </div>

      {#if showMessageNavigation}
        <ConversationMinimap
          items={navItems}
          windowStart={virtualizer.range.start}
          geometryRevision={virtualizer.revision}
          topForMessage={navigationTop}
          {scrollEl}
          isActive={isVisible}
          prepareNavigate={prepareMinimapNavigate}
        />
      {/if}

      {#if showSessionActions}
        <SessionActionRow
          {tabId}
          {paneId}
          isAwayFromEnd={arrival.isAwayFromEnd}
          onJumpToEnd={jumpToEnd}
          leftReservedWidth={showActivityStrip ? activityReservedWidth : 0}
        />
      {/if}

      <!-- The transcript's own bottom edge. Rows scroll under the floating
           composer (ADR-0027) and would otherwise be cut in half at its top
           edge, so they dissolve into it. It rides that edge like the action
           row, and sits under the row: painted from the dock instead, it
           washed out the row's lower half. -->
      <div
        class="transcript-fade pointer-events-none absolute inset-x-0 z-5 h-5"
        style="bottom:var(--solus-composer-height, 0px)"
      ></div>

      {#if showActivityStrip}
        <div
          class="activity-strip activity-strip-editor flex items-end gap-1.5 absolute pointer-events-none"
          style="bottom:calc(var(--solus-composer-height, 0px) + 3px);height:2rem;z-index:7"
        >
          <div
            bind:clientWidth={activityReservedWidth}
            class="flex items-center gap-1.5 pl-4 pr-2 text-xs pointer-events-auto"
          >
            <!-- Running, stopped and failed are all reported by the turn's own
                 row (§16, §17), not up here: the state belongs to the turn, not
                 to the chrome. Only conditions the turn can't express stay in
                 this strip. -->
            {#if isAwaitingPlan}
              <span class="flex items-center gap-1.5">
                <FileTextIcon
                  size={11}
                  weight="bold"
                  style="color:var(--solus-status-running)"
                />
                <span class="text-(--solus-text-tertiary)"
                  >Waiting for plan approval</span
                >
              </span>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}

{#if stripMenu}
  <SessionContextMenu
    x={stripMenu.x}
    y={stripMenu.y}
    tabId={stripMenu.tabId}
    onClose={() => (stripMenu = null)}
  />
{/if}

<style>
  /* Match the scroll area's 1rem side gutters before applying the reading
     width cap. This keeps the activity label and orb on the same horizontal
     bounds as the message column in narrow split panes. */
  .activity-strip-editor {
    left: 50%;
    width: min(calc(100% - 2rem), var(--solus-reading-max));
    transform: translateX(-50%);
  }

  /* The strip sits left of the session action row, so it rides the composer's
     top edge on the fold's curve exactly as the row does. The fade under them
     rides the same edge. */
  .activity-strip,
  .transcript-fade {
    transition: bottom var(--solus-composer-fold-duration, 0ms)
      var(--solus-composer-fold-easing, linear);
  }
  @media (prefers-reduced-motion: reduce) {
    .activity-strip,
    .transcript-fade {
      transition: none;
    }
  }

  .transcript-fade {
    background: linear-gradient(
      to top,
      var(--solus-container-bg),
      transparent
    );
  }

</style>
