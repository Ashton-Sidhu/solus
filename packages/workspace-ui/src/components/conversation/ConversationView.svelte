<script lang="ts">
  import { provideTranscriptDisclosure } from "./lib/transcript-disclosure.svelte";
  import { createArtifactRevisionIndexer } from "./lib/artifact-revisions";
  import { provideArtifactRevisions } from "./lib/artifact-revisions-context";
  import TranscriptItem from "./TranscriptItem.svelte";
  import ConversationTurn from "./ConversationTurn.svelte";
  import VirtualTranscript from "./VirtualTranscript.svelte";
  import { revealTranscriptMatch } from "./lib/transcript-navigation";
  import ContentSkeleton from "../ui/ContentSkeleton.svelte";
  import { tick, untrack } from "svelte";
  import { modelLabelFor } from "@solus/contracts/types";
  import {
    HardDrive as DesktopTowerIcon,
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
  import RateLimitCard from "./RateLimitCard.svelte";
  import ConnectCard from "../connections/ConnectCard.svelte";
  import SeatConnectCard from "../seats/SeatConnectCard.svelte";
  import TurnRefusalCard from "../connections/TurnRefusalCard.svelte";
  import { turnRefusalStore } from "../../contexts/connections/turn-refusal.store.svelte";
  import SeatNeededNotice from "../seats/SeatNeededNotice.svelte";
  import AgentAuthCard from "../seats/AgentAuthCard.svelte";
  import ComposingLine from "../presence/ComposingLine.svelte";
  import QueuedPromptGroup from "./queued/QueuedPromptGroup.svelte";
  import StatusCard from "./StatusCard.svelte";
  import TranscriptStatusRow from "./TranscriptStatusRow.svelte";

  import type { TaskLinkContext } from "../tasks/link-control/lib/task-link-control";
  import DiffSummaryCard from "./DiffSummaryCard.svelte";
  import ConversationMinimap from "./ConversationMinimap.svelte";
  import { FindBar } from "../ui/find-bar";
  import { createNavItemBuilder } from "./lib/minimap";
  import {
    CONVERSATION_BREADCRUMB_OFFSET,
    conversationFindTopInset,
    findConversationMatches,
    type ConversationFindMatch,
  } from "./lib/find";
  import { createEndFollow, scrollConversationTo } from "./lib/response-scroll";
  import { questionAnchorScrollTop } from "./lib/question-scroll";
  import { ConversationFindHighlighter } from "./lib/find-highlight";
  import {
    hasVisibleTurnBody,
    runIsLive,
    type GroupedItem,
    type Turn,
  } from "./lib/turns";
  import { TranscriptTurns } from "./lib/transcript-turns.svelte";
  import { ConversationViewState } from "./lib/conversation-view-state.svelte";
  import { provideConversationVisibility } from "./lib/conversation-visibility";
  import SessionActionRow from "../layout/SessionActionRow.svelte";
  import ConversationSkeleton from "./ConversationSkeleton.svelte";
  import SessionContextMenu from "../session/SessionContextMenu.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import { LOCAL_SERVER_ID } from "@solus/client-core/server-registry";
  import { serversStore } from "../../contexts/connections/servers.store.svelte";
  import { canDriveSession } from "../../contexts/sharing/session-drive";
  import { setMarkdownImageContext } from "./lib/markdown-image";
  import { setSessionLinkContext } from "./lib/session-link-context";
  import { setHtmlBlockOrigin } from "./lib/html-block-origin";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { readSessionMeta } from "@solus/client-core/session-meta";

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
    viewState = new ConversationViewState(),
  }: {
    tabId: string;
    forceVisible?: boolean;
    surfaceVisible?: boolean;
    bandAbove?: boolean;
    showActions?: boolean;
    /** The pool hands back what the reader left open and where they were.
     *  A split-pane view keeps its own. */
    viewState?: ConversationViewState;
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
  const activeHandoffDivider = $derived(
    sess?.messages.findLast(
      (message) => message.activity?.kind === "agent_switched" && message.activity.provider === sess.run.provider,
    ),
  );
  const activeHandoffTargetModel = $derived.by(() => {
    const provider = sess?.run.provider;
    const modelId = sess?.run.modelConfig.modelId;
    if (!provider || !modelId) return null;
    return modelLabelFor(provider, modelId);
  });
  setMarkdownImageContext({
    cwd: () => sess?.run.workingDirectory,
    serverId: () => sess?.run.serverId,
    ctx: () => (sess ? session.ctxFor(tabId) : undefined),
    api: () =>
      sess?.run.serverId
        ? serverConnections.apiFor(sess.run.serverId)
        : undefined,
  });
  setSessionLinkContext(() => sess?.run.serverId);
  // What every card's Link control needs: the host that owns the
  // conversation's tasks, its project, and the task the conversation itself
  // belongs to — the one-click target. Resolved once here, not per card.
  const conversationTaskId = $derived(
    sess
      ? (session.tasksStore.taskForSession(sess.handoffId ?? sess.id)?.id ??
        session.tasksStore.taskForSession(sess.agentSessionId)?.id ??
        null)
      : null,
  );
  const linkContext: TaskLinkContext = $derived({
    serverId: sess?.run.serverId,
    projectKey: sess?.run.gitContext?.repoRoot ?? sess?.run.workingDirectory ?? null,
    conversationTaskId,
  });
  // An HTML block renders from deep inside the markdown tree, where these props
  // do not reach. Saving one as an artifact still has to file the work against
  // this conversation's host and project rather than the active tab's.
  setHtmlBlockOrigin(() => ({ tabId, linkContext }));
  const remoteServer = $derived(
    sess?.run.serverId && sess.run.serverId !== LOCAL_SERVER_ID
      ? serversStore.servers.find((server) => server.id === sess.run.serverId)
      : null,
  );
  const remoteStatus = $derived(
    sess?.run.serverId && sess.run.serverId !== LOCAL_SERVER_ID
      ? serversStore.statusFor(sess.run.serverId)
      : "online",
  );
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
    bandAbove && isVisible && !forceVisible,
  );
  // 46px of band plus the gap under it.
  const CRUMB_OFFSET = CONVERSATION_BREADCRUMB_OFFSET;
  let stripMenu = $state<{ tabId: string; x: number; y: number } | null>(null);

  let scrollEl: HTMLDivElement | null = $state(null);
  let messagesEl: HTMLDivElement | null = $state(null);
  let readingColumnEl: HTMLDivElement | null = $state(null);
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
  // Content grew. Paragraph streaming glides to each new paragraph.
  function followEnd() {
    if (!isVisible) return;
    endFollow?.follow(settings.responseStreamingMode === "paragraph" && !!sess?.isStreamingText);
  }
  let hovered = $state(false);
  let findOpen = $state(false);
  let findQuery = $state("");
  let findIndex = $state(0);
  let findBarRef: FindBar | null = $state(null);
  const findHighlighter = new ConversationFindHighlighter();
  $effect(() => () => findHighlighter.destroy());

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
  // Where the view stands is decided when the reader arrives — the view
  // mounts, or a hidden one is shown again: at their saved place, or at the
  // end. Chromium drops a `display: none` scroller's offset, so the scroll
  // events of an arrival are the browser resetting layout, not the reader.
  // Until it settles they must not unpin the view, save a place, or page in
  // older history (a view reset to the top looked like a reader asking for it).
  let loadingOlder = false;
  let arriving = false;
  let wasShown = false;
  $effect(() => {
    const shown = isVisible && !!scrollEl;
    if (shown && !wasShown) untrack(arrive);
    wasShown = shown;
  });

  function arrive() {
    const position = viewState.position;
    arriving = true;
    if (position) endFollow?.release();
    void tick().then(() => requestAnimationFrame(async () => {
      if (!position || !(await virtualizer.restore(position))) {
        viewState.position = null;
        endFollow?.jump();
      }
      // Rows mounted by the jump measure in the next frames, and the reading
      // column's ResizeObserver follows them. The reader's own scrolling
      // counts again once they settle.
      setTimeout(() => {
        arriving = false;
        backfillShortTranscript();
      }, 120);
    }));
  }

  // A restored window can contain hundreds of tool events that collapse into
  // only a few completed-turn rows. In that case there is no scrollbar and
  // therefore no scroll event to request the history that precedes the
  // window. Keep backfilling until the user has an actual scroll range (or
  // the complete transcript is mounted).
  function backfillShortTranscript() {
    const el = scrollEl;
    if (
      el && isVisible && !arriving &&
      el.clientHeight > 0 &&
      el.scrollHeight <= el.clientHeight &&
      hasOlderTurnsToLoad && !historyError
    ) {
      void maybeLoadOlder();
    }
  }

  // Infinite scroll reveals one bounded page whenever the user nears the top.
  // The scroll position is anchored across the insert so the previously-visible
  // messages stay put rather than jumping when content is added above them.
  const NEAR_TOP_PX = 300;
  // `force` is a tap on the button at the top of the thread rather than a
  // scroll that arrived there, so it does not ask where the scroller is.
  async function maybeLoadOlder(opts?: { force?: boolean }) {
    const el = scrollEl;
    if (!el || loadingOlder) return;
    if (!opts?.force && el.scrollTop > NEAR_TOP_PX) return;
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
  }

  function handleScroll() {
    const el = scrollEl;
    // A hidden view's scroll events are its layout being dropped, and an
    // arriving view's are that layout coming back: neither is the reader.
    if (!el || !isVisible || arriving) return;
    endFollow?.measure();
    viewState.position = endFollow?.atEnd ? null : virtualizer.position();
    if (el.scrollTop <= NEAR_TOP_PX) void maybeLoadOlder();
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
  const conversationFindMatches = $derived(
    findConversationMatches(sess?.messages ?? [], findQuery),
  );

  // The message navigator is a right-gutter rail in wide layouts only. The rail
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
  $effect(() => {
    // A hidden pool view doesn't need its work content eagerly hydrated — load
    // on activation.
    if (!isVisible) return;
    for (const segment of transcript.segments) {
      for (const item of segment.grouped) {
        if (item.kind !== "document") continue;
        for (const message of item.messages) {
          const workId = message.workRef?.workId;
          // Skip provisional (streaming) ids — their content lives in the store and
          // there is nothing to load from disk yet.
          if (workId && !session.worksStore.streaming[workId]) {
            void session.worksStore.ensureContent(workId, "conversation-view");
          }
        }
      }
    }
  });

  const isAwaitingPlan = $derived(sess?.status === "awaiting_plan");
  const isAwaitingInput = $derived(sess?.status === "awaiting_input");
  const currentActivity = $derived(sess ? computeCurrentActivity(sess) : "");
  const activityLabel = $derived(
    isAwaitingPlan ? "Awaiting plan approval" : currentActivity || undefined,
  );
  // Running, stopped and failed are all reported by the turn's own activity row
  // (§16, §17) — the strip only carries what no turn can express.
  const showActivityStrip = $derived(!!sess && isAwaitingPlan);
  const showSessionActions = $derived(!!tab && showActions);
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

  async function revealFindMatch(match: ConversationFindMatch) {
    endFollow?.release();
    await revealTranscriptMatch({
      match, turns, turnId: messageTurns.get(match.messageId), virtualizer,
      expand: (turn) => { turnExpansion.set(turn.id, true); void session.toolHistory.load(turn.tools); },
      elements: () => ({ messages: messagesEl, scroll: scrollEl }),
      highlighter: findHighlighter, query: findQuery,
    });
    void findBarRef?.focusInput(false);
  }

  async function openFind() {
    findOpen = true;
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
    findOpen = false;
    findQuery = "";
    findIndex = 0;
    findHighlighter.clear();
    requestInputFocus({ tabId });
  }

  async function updateFindQuery(value: string) {
    findQuery = value;
    findIndex = 0;
    await tick();
    const first = conversationFindMatches[0];
    if (first) await revealFindMatch(first);
    else findHighlighter.update(messagesEl, findQuery, null);
  }

  async function navigateFind(direction: 1 | -1) {
    const total = conversationFindMatches.length;
    if (total === 0) return;
    findIndex = (((findIndex + direction) % total) + total) % total;
    await revealFindMatch(conversationFindMatches[findIndex]);
  }

  $effect(() => {
    if (!findOpen) {
      findHighlighter.clear();
      return;
    }
    void virtualizer.range;
    void virtualizer.pinnedKeys;
    const query = findQuery;
    const matches = conversationFindMatches;
    if (findIndex >= matches.length)
      findIndex = Math.max(0, matches.length - 1);
    void tick().then(() =>
      findHighlighter.update(messagesEl, query, matches[findIndex] ?? null),
    );
  });

  function handleRetry() {
    session.dispatch.retryLastMessage(tabId);
  }

  const sessionChangedFiles = $derived(sess?.sessionChangedFiles ?? []);
  const latestTurnSnapshot = $derived(
    sess ? session.lifecycle.turnSnapshots[sess.id]?.at(-1) : undefined,
  );
  const latestTurnScope = $derived(
    latestTurnSnapshot
      ? ({ kind: "turn", index: latestTurnSnapshot.index } as const)
      : null,
  );
  // The turn's closing summary: what the run touched, standing at the end of the
  // transcript while the user is still only reading it. It steps aside when the
  // next ask actually lands in the transcript — not on the first keystroke,
  // because the summary is usually what the composer is being typed *about*.
  const hasAskedAgain = $derived(sess?.messages.at(-1)?.role === "user");
  const showTurnDiffSummary = $derived(
    settings.showDiffSummaryAfterTurn &&
      !isTurnLive &&
      !hasAskedAgain &&
      latestTurnSnapshot !== undefined &&
      latestTurnSnapshot.filesChanged > 0,
  );

  useKeybinding("conversation.find", () => openFind(), {
    enabled: () => tabId === session.focusedChatTabId,
  });

  useKeybinding("conversation.close-find", closeFind, {
    enabled: () => findOpen && tabId === session.focusedChatTabId,
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
    () => endFollow?.jump(true),
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
    "conversation.interrupt",
    () => {
      session.controls.interruptTabSession(tabId);
      session
        .apiFor(tabId)
        .stopSession(session.ctxFor(tabId).session.sessionId);
      requestInputFocus();
    },
    {
      enabled: () =>
        tabId === session.focusedChatTabId &&
        (sess?.status === "running" || sess?.status === "connecting") &&
        canDriveSession(sess.run.serverId, sess.id),
    },
  );

  $effect(() => {
    const handler = (e: Event) => {
      if (!(e instanceof CustomEvent)) return;
      const detail: { tabId?: string } = e.detail;
      if (detail?.tabId && detail.tabId !== tabId) return;
      if (!isVisible) return;
      // Rows that settle after this frame grow the reading column, and its
      // ResizeObserver follows them to the true end.
      requestAnimationFrame(() => endFollow?.jump());
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

  async function navigateToSourceSession(agentSessionId: string) {
    // The source session lives on the same host as the transcript citing it.
    const matchingTabId = session.tabIdForAgentSession(
      agentSessionId,
      sess?.run.serverId,
    );
    if (matchingTabId) {
      session.selectTab(matchingTabId);
      return;
    }
    // Not open — read it on this conversation's host and resume it. The
    // source session delegated to this one, so it lives on the same host.
    if (!sess) return;
    const meta = await readSessionMeta(sess.run.serverId, agentSessionId);
    if (meta) {
      await session.opening.resumeSession(meta);
    }
  }
</script>

<!-- No container: assistant prose sits directly on the canvas. Cards, code and
     tables are the only boxes it may draw. -->

<!-- §13 — the machine's reachability belongs to the host, not to a turn, so it
     is a row: the condition, the host, and the one thing the user can do. -->
{#if sess?.run.serverId !== LOCAL_SERVER_ID && remoteStatus !== "online"}
  <div class="mx-4 mt-2 shrink-0">
    <TranscriptStatusRow
      tone={remoteStatus === "connecting" ? "warning" : "destructive"}
      progress={remoteStatus === "connecting" ? null : undefined}
      data-testid="host-status-row"
    >
      {#snippet glyph()}
        <DesktopTowerIcon size={13} />
      {/snippet}
      {remoteStatus === "connecting" ? "Reconnecting to" : "Can’t reach"}
      <span class="font-mono text-xs"
        >{remoteServer?.label ?? "remote host"}</span
      >
      {#snippet actions()}
        {#if remoteStatus !== "connecting"}
          <button
            type="button"
            class="status-row-action"
            onclick={() => serversStore.retryActive()}
          >
            Reconnect
          </button>
          <button
            type="button"
            class="status-row-action text-"
            onclick={() => serversStore.useLocalHost()}
          >
            Run locally
          </button>
        {/if}
      {/snippet}
    </TranscriptStatusRow>
  </div>
{/if}

{#if tab && sess && sess.loadingHistory}
  <ConversationSkeleton />
{:else if tab && sess}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    onmouseenter={() => (hovered = true)}
    onmouseleave={() => (hovered = false)}
    class="flex h-full min-h-0 flex-col"
  >
    <div class="cv-root relative min-h-0 flex-1">
      {#if findOpen}
        <div
          class="absolute right-3 z-20"
          style:top="{conversationFindTopInset(reservesBandRoom)}px"
        >
          <FindBar
            bind:this={findBarRef}
            query={findQuery}
            current={conversationFindMatches.length === 0 ? 0 : findIndex + 1}
            total={conversationFindMatches.length}
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
        data-conversation-tab-id={tabId}
        class:outer-scroll-source={!!outerScrollbar}
        class="conversation-selectable h-full overflow-y-auto overflow-x-hidden px-4 pt-1 pb-[var(--solus-composer-inset,0px)]"
        style="overscroll-behavior-y:contain"
        onscroll={handleScroll}
      >
        <!-- Centered reading column: the message stream and the status strip
             share one fluid column (scales with the conversation pane via
             --solus-reading-max) so everything lines up. -->
        <div
          bind:this={readingColumnEl}
          class="w-full"
          style="max-width:var(--solus-reading-max);margin-inline:auto{reservesBandRoom
            ? `;padding-top:${CRUMB_OFFSET}px`
            : ''}"
        >
          {#if expandingHistory}
            <ContentSkeleton label="Loading earlier messages" />
          {:else if historyError}
            <div role="alert" class="py-2 text-sm">
              {historyError}
              <button type="button" class="underline" onclick={() => void maybeLoadOlder({ force: true })}>Retry</button>
            </div>
          {:else if runtime.isTouchDevice && hasOlderTurnsToLoad}
            <!-- Touch clients can request earlier turns with a button as well
                 as the automatic paging available when scrolling up. -->
            <div class="flex justify-center pt-1 pb-2">
              <button
                type="button"
                class="flex h-8 cursor-pointer items-center rounded-full border-0 bg-(--card) px-3.5 text-xs font-medium text-(--solus-text-primary) shadow-[shadow:var(--elev-ring)] transition-transform duration-[120ms] active:scale-[0.96] [-webkit-tap-highlight-color:transparent]"
                onclick={() => void maybeLoadOlder({ force: true })}
              >
                Load earlier turns
              </button>
            </div>
          {/if}

          <VirtualTranscript {tabId}
            {turns}
            {virtualizer}
            scrollElement={scrollEl}
            active={isVisible}
            bind:element={messagesEl}
          >
            {#snippet children(turn: Turn, turnIdx: number)}
              <ConversationTurn {turn} index={turnIdx} total={turns.length}
                expanded={turnExpansion.get(turn.id) ?? (turnIdx === turns.length - 1 && turn.end?.kind === "failed" && hasVisibleTurnBody(turn))}
                {isAwaitingInput} {activityLabel} turnStart={sess.currentTurnStart}
                hasBackgroundWork={sess.status === "background"}
                onStopBackgroundWork={stopBackgroundWork}
                attempt={sess.retryAttempt ?? 1} history={session.toolHistory}
                onToggle={(expanded) => toggleTurn(turn.id, expanded)} onRetry={handleRetry}
                serverId={sess.run.serverId} sessionId={sess.id} {transcriptItem} />
            {/snippet}
          </VirtualTranscript>

          {#snippet transcriptItem(item: GroupedItem, skipMotion: boolean)}
            <TranscriptItem {item} {skipMotion} {tabId} {linkContext}
              {activeHandoffDivider} {activeHandoffTargetModel}
              navigateToSourceSession={navigateToSourceSession} />
          {/snippet}

          {#if sess.statusCard}
            <StatusCard card={sess.statusCard} onRetry={() => session.controls.recoverWorktreeSetup(tabId, false)} onWorkLocally={() => session.controls.recoverWorktreeSetup(tabId, true)} />
          {/if}

          {#if sess.permissionQueue.length > 0}
            <PermissionCard
              tabId={tab.id}
              permission={sess.permissionQueue[0]}
              queueLength={sess.permissionQueue.length}
            />
          {/if}

          {#if sess.questionQueue.length > 0}
            <QuestionCard
              tabId={tab.id}
              request={sess.questionQueue[0]}
              provider={sess.run.provider}
            />
          {/if}

          <!-- The card is the *decision* surface, so it only stands while the
               user still has one to make. Once the prompt is queued, its state
               rides on the bubble instead. -->
          {#if sess.status === "rate_limited"}
            <RateLimitCard tabId={tab.id} />
          {/if}

          <!-- The request belongs to the session whose agent needs Cloudflare;
               a different active conversation must not receive its Continue. -->
          {#if connectRequestStore.visibleFor(sess.run.serverId, sess.id)}
            <ConnectCard tabId={tab.id} />
          {/if}
          <!-- The host refused this conversation's prompt for want of a seat; the
               card offers the connect flow where the turn would have run. -->
          <!-- The organization model refused this reader's turn: which
               organization it needs, and the control that fixes it. -->
          {#if turnRefusalStore.visibleFor(sess.run.serverId, sess.id)}
            <TurnRefusalCard />
          {/if}
          {#if seatsStore.visibleFor(sess.run.serverId, sess.id)}
            <SeatConnectCard />
          {:else if sess.run.serverId}
            <!-- Before they send: the reader's seat for this agent on this host. -->
            <SeatNeededNotice serverId={sess.run.serverId} provider={sess.run.provider} turnRunning={isTurnLive} />
          {/if}
          <!-- A sign-in this conversation asked for with /design-login or /mcp login. -->
          {#if agentAuthStore.visibleFor(sess.run.serverId, sess.id)}
            <AgentAuthCard />
          {/if}
          <QueuedPromptGroup tabId={tab.id} />
          <!-- Someone else's prompt is on its way: it lands here, so the notice does too. -->
          <ComposingLine serverId={sess.run.serverId} sessionId={sess.id} />

          {#if showTurnDiffSummary && latestTurnScope}
            <!-- Stands off the turn it reports on: the summary is a footnote to
                 the last message, not the next line of it. -->
            <div class="flex justify-center pt-3 animate-msg-in-up">
              <DiffSummaryCard
                {tabId}
                scope={latestTurnScope}
                onOpenDiff={(filePath) =>
                  session.showDiff(tabId, latestTurnScope, filePath)}
                onOpenFile={(filePath) =>
                  session.openFileInFiles({ path: filePath }, tabId)}
              />
            </div>
          {/if}

          {#if showSessionActions}
            <div class="min-h-16"></div>
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
