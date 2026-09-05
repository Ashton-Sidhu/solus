<script lang="ts">
  import { tick } from "svelte";
  import { modelLabelFor } from "@solus/contracts/types";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import { markdownSanitizeUrl } from "../../lib/markdownSanitize";
  import {
    HardDrive as DesktopTowerIcon,
    ArrowRight as ArrowRightIcon,
    Code as CodeIcon,
    FileText as FileTextIcon,
    GitFork as GitForkIcon,
    CirclePlus as PlusCircleIcon,
    GitFork as TreeStructureIcon,
  } from "@lucide/svelte";
  import { computeCurrentActivity } from "../../contexts/workspace/session.utils";
  import {
    getWorkspaceContext,
    getPlanStore,
    createSessionHistoryStore,
    getSettingsContext,
    getWindowContext,
    runtime,
    connectRequestStore,
  } from "../../contexts";
  import { useKeybinding } from "../../lib/keybindings/use-keybinding.svelte";
  import { getOuterScrollbarContext } from "../layout/lib/outer-scrollbar.context";
  import PermissionCard from "./PermissionCard.svelte";
  import QuestionCard from "./QuestionCard.svelte";
  import RateLimitCard from "./RateLimitCard.svelte";
  import ConnectCard from "../connections/ConnectCard.svelte";
  import QueuedPromptGroup from "./queued/QueuedPromptGroup.svelte";
  import StatusCard from "./StatusCard.svelte";
  import TranscriptDivider from "./TranscriptDivider.svelte";
  import ClaudeIcon from "../ClaudeIcon.svelte";
  import OpenAIBlossom from "../pickers/OpenAIBlossom.svelte";
  import TranscriptStatusRow from "./TranscriptStatusRow.svelte";
  import TurnActivityRow from "./TurnActivityRow.svelte";
  import TurnEndDivider from "./TurnEndDivider.svelte";
  import MessageHoverRail from "./MessageHoverRail.svelte";

  import UserMessageBubble from "./UserMessageBubble.svelte";
  import ToolGroupItem from "./ToolGroupItem.svelte";
  import SubagentGroup from "./SubagentGroup.svelte";
  import PlanMessageItem from "../plan/PlanMessageItem.svelte";
  import DocumentStackCard from "../work/DocumentStackCard.svelte";
  import type { DocumentStackEntry } from "../work/lib/document-stack";
  import type { TaskLinkContext } from "../tasks/link-control/lib/task-link-control";
  import AutomationRefCard from "../automations/AutomationRefCard.svelte";
  import TaskRefCard from "./TaskRefCard.svelte";
  import BrowserSnapshotCard from "../browser/BrowserSnapshotCard.svelte";
  import BrowserSnapshotGallery from "../browser/BrowserSnapshotGallery.svelte";
  import AgentConversationGroup from "./agent-conversation/AgentConversationGroup.svelte";
  import { agentsAwaitingReply } from "./agent-conversation/lib/agent-conversation";
  import { describeBackgroundWait } from "./lib/activity-summary";
  import ArtifactView from "../artifact/ArtifactView.svelte";
  import ReviewGuideCard from "../review/ReviewGuideCard.svelte";
  import CodeSpan from "../ui/CodeSpan.svelte";
  import MarkdownLink from "./MarkdownLink.svelte";
  import MarkdownImage from "./MarkdownImage.svelte";
  import DiffSummaryCard from "./DiffSummaryCard.svelte";
  import ConversationMinimap from "./ConversationMinimap.svelte";
  import { FindBar } from "../ui/find-bar";
  import { previewText } from "./lib/minimap";
  import {
    CONVERSATION_BREADCRUMB_OFFSET,
    conversationFindTopInset,
    findConversationMatches,
    type ConversationFindMatch,
  } from "./lib/find";
  import { questionAnchorScrollTop } from "./lib/question-scroll";
  import { ConversationFindHighlighter } from "./lib/find-highlight";
  import { noticeText } from "./lib/transient";
  import {
    PAGE_SIZE,
    hasOlderTurns,
    pageOffsetForMessage,
    transcriptWindowStart,
  } from "./lib/transcript-window";
  import {
    buildTurns,
    groupMessages,
    hasVisibleTurnBody,
    itemKey,
    needsLiveRow,
    runIsLive,
    shouldAnimateTurnEntry,
    stabilizeTurns,
    type GroupedItem,
    type Turn,
  } from "./lib/turns";
  import { SvelteMap } from "svelte/reactivity";
  import { assistantMarkdownOptions } from "./lib/assistant-markdown";
  import ActionOrb from "../layout/ActionOrb.svelte";
  import ConversationSkeleton from "./ConversationSkeleton.svelte";
  import SessionContextMenu from "../session/SessionContextMenu.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { LOCAL_SERVER_ID } from "@solus/client-core/server-registry";
  import { serversStore } from "../../contexts/connections/servers.store.svelte";
  import { setMarkdownImageContext } from "./lib/markdown-image";
  import { setSessionLinkContext } from "./lib/session-link-context";
  import { setHtmlBlockOrigin } from "./lib/html-block-origin";
  import { RAW_HTML_TOKEN, rawHtmlMarkedExtension } from "./lib/raw-html";
  import FencedBlock from "./FencedBlock.svelte";
  import HtmlBlock from "./HtmlBlock.svelte";
  import { serverConnections } from "@solus/client-core/server-connections";

  // `code` routes an html fence to a live render or a code block; the raw-html
  // extension does the same for markup written without a fence. Both end at
  // HtmlBlock, so the two ways in look the same on screen.
  const markdownRenderers = {
    code: FencedBlock,
    codespan: CodeSpan,
    image: MarkdownImage,
    link: MarkdownLink,
    [RAW_HTML_TOKEN]: HtmlBlock,
  };

  // Built once per instance: a new array on each render would rebuild the parser.
  const markdownExtensions = [rawHtmlMarkedExtension];


  const session = getWorkspaceContext();
  const outerScrollbar = getOuterScrollbarContext();
  const planStore = getPlanStore();
  const settings = getSettingsContext();
  const windowCtx = getWindowContext();
  const sourceSessionHistory = createSessionHistoryStore();
  $effect(() => () => sourceSessionHistory.cancel());
  const isEditorMode = $derived(
    windowCtx.viewMode === "editor" || windowCtx.isWeb,
  );
  let {
    tabId,
    forceVisible = false,
    surfaceVisible = true,
    retainTranscriptRows = true,
    bandAbove = true,
  }: {
    tabId: string;
    forceVisible?: boolean;
    surfaceVisible?: boolean;
    retainTranscriptRows?: boolean;
    bandAbove?: boolean;
  } = $props();

  // The pool instance is on screen only while its tab is active; the split-pane
  // instance (forceVisible) is always on screen. Visibility gates autoscroll and
  // transcript work; keybindings stay gated on the focused chat so the two visible
  // instances never both respond to one shortcut.
  const isVisible = $derived(
    surfaceVisible && (forceVisible || tabId === session.activeTabId),
  );

  const tab = $derived(session.tabs[tabId]);
  const sess = $derived(session.sessionFor(tabId));
  const activeHandoffDivider = $derived(
    sess?.messages.findLast(
      (message) => message.agentChangedToProvider === sess.run.provider,
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
    isWeb: () => windowCtx.isWeb,
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
    bandAbove && isEditorMode && isVisible && !forceVisible,
  );
  // 46px of band plus the gap under it.
  const CRUMB_OFFSET = CONVERSATION_BREADCRUMB_OFFSET;
  let stripMenu = $state<{ tabId: string; x: number; y: number } | null>(null);

  // A turn's fold sits below its row, so leaving the scroll alone is what makes
  // it open downward: the row holds its place on screen and the content pushes
  // everything under it down. Re-pinning to the bottom instead would drag the
  // row the reader just clicked up and off the top of the view.
  let holdScroll = false;
  let holdScrollTimer: ReturnType<typeof setTimeout> | null = null;
  function holdAutomaticScroll() {
    holdScroll = true;
    if (holdScrollTimer) clearTimeout(holdScrollTimer);
    // Long enough for a newly revealed row or interrupt card to measure before
    // the ResizeObserver is allowed to resume bottom pinning.
    holdScrollTimer = setTimeout(() => {
      holdScroll = false;
      holdScrollTimer = null;
    }, 160);
  }
  $effect(() => () => {
    if (holdScrollTimer) clearTimeout(holdScrollTimer);
  });

  // Glue the view to the bottom after structural changes. Streaming growth is
  // observed below so the reveal loop never forces a scrollHeight read itself.
  function pinToBottom() {
    const el = scrollEl;
    if (holdScroll) return;
    if (el && isVisible && isNearBottom) {
      el.scrollTop = el.scrollHeight;
    }
    // content-visibility:auto rows (e.g. UserMessageBubble) can still report
    // their placeholder contain-intrinsic-size right after insertion, so the
    // read above can undershoot the real bottom. Settle once more after the
    // browser measures them, same retry used by the solus:scroll-conversation-bottom handler.
    setTimeout(() => {
      if (scrollEl && isVisible && isNearBottom && !holdScroll) {
        scrollEl.scrollTop = scrollEl.scrollHeight;
      }
    }, 120);
  }

  let scrollEl: HTMLDivElement | null = $state(null);
  let messagesEl: HTMLDivElement | null = $state(null);
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
    if (!outerScrollbar || !scrollEl || !isVisible) return;
    return outerScrollbar.register(scrollEl);
  });
  let renderOffset = $state(0);
  let expandingHistory = $state(false);
  let isNearBottom = true;
  let loadingOlder = false;
  let savedScrollFromBottom: number | null = null;
  let previouslyRetainedTranscriptRows = false;

  $effect.pre(() => {
    const retained = retainTranscriptRows;
    if (previouslyRetainedTranscriptRows && !retained && scrollEl) {
      savedScrollFromBottom =
        scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
    }
    previouslyRetainedTranscriptRows = retained;
  });

  $effect(() => {
    if (!retainTranscriptRows || savedScrollFromBottom === null) return;
    const distanceFromBottom = savedScrollFromBottom;
    void tick().then(() => {
      requestAnimationFrame(() => {
        if (!scrollEl || !retainTranscriptRows) return;
        scrollEl.scrollTop = Math.max(
          0,
          scrollEl.scrollHeight - scrollEl.clientHeight - distanceFromBottom,
        );
      });
    });
  });

  // Infinite scroll reveals one bounded page whenever the user nears the top.
  // The scroll position is anchored across the insert so the previously-visible
  // messages stay put rather than jumping when content is added above them.
  // Automatic backfill uses the same bounded read when a restored transcript is
  // too short to provide a scroll range.
  const NEAR_TOP_PX = 300;
  // `force` is a tap on the button at the top of the thread rather than a
  // scroll that arrived there, so it does not ask where the scroller is.
  async function maybeLoadOlder(opts?: { force?: boolean }) {
    const el = scrollEl;
    if (!el || loadingOlder) return;
    if (!opts?.force && el.scrollTop > NEAR_TOP_PX) return;
    if (!hasOlderTurnsToLoad) return;

    loadingOlder = true;
    const prevHeight = el.scrollHeight;
    const prevTop = el.scrollTop;
    try {
      // Older messages still on disk — widen the host window by one bounded
      // page, then reveal one render page above the current view.
      if (!hasOlder && sess?.historyTruncated) {
        expandingHistory = true;
        try {
          await session.expandHistory(tabId);
        } finally {
          expandingHistory = false;
        }
      }
      renderOffset++;
      await tick();
      el.scrollTop = el.scrollHeight - prevHeight + prevTop;
    } finally {
      loadingOlder = false;
    }

    // A restored window can contain hundreds of tool events that collapse into
    // only a few completed-turn rows. In that case there is no scrollbar and
    // therefore no scroll event to request the history that precedes the
    // window. Keep backfilling until the user has an actual scroll range (or
    // the complete transcript is mounted).
    if (
      isVisible &&
      el.clientHeight > 0 &&
      el.scrollHeight <= el.clientHeight &&
      hasOlderTurnsToLoad
    ) {
      void maybeLoadOlder();
    }
  }

  function handleScroll() {
    const el = scrollEl;
    if (!el) return;
    isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (el.scrollTop <= NEAR_TOP_PX) void maybeLoadOlder();
  }

  // Load every older message (from disk if needed) and render them all, so the
  // top of the scroll container is the conversation's very first message.
  async function revealAll() {
    if (sess?.historyTruncated) {
      expandingHistory = true;
      try {
        await session.expandHistory(tabId, { full: true });
      } finally {
        expandingHistory = false;
      }
    }
    renderOffset = Math.ceil((sess?.messages.length ?? 0) / PAGE_SIZE);
    await tick();
  }

  function animateScrollTo(el: HTMLElement, target: number) {
    const start = el.scrollTop;
    if (Math.abs(start - target) < 1) return;
    const startTime = performance.now();
    const duration = 300;
    const ease = (t: number) => 1 - (1 - t) ** 3;
    const step = (now: number) => {
      const t = Math.min((now - startTime) / duration, 1);
      el.scrollTop = start + (target - start) * ease(t);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
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
    if (isVisible && isNearBottom) {
      if (questionMounted) {
        // A question needs the turn that led to it. Keep a slice of that turn
        // above the card instead of pinning the card's (potentially very tall)
        // bottom to the viewport.
        holdAutomaticScroll();
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
          isNearBottom = false;
        });
      } else {
        requestAnimationFrame(pinToBottom);
      }
    }
  });

  let prevEditorMode: boolean | undefined;
  $effect(() => {
    const mode = isEditorMode;
    if (prevEditorMode !== undefined && prevEditorMode !== mode) {
      if (isVisible && scrollEl) {
        requestAnimationFrame(() => {
          if (scrollEl) {
            scrollEl.scrollTop = scrollEl.scrollHeight;
          }
        });
      }
    }
    prevEditorMode = mode;
  });

  const totalCount = $derived(sess?.messages.length ?? 0);
  const startIndex = $derived(transcriptWindowStart(totalCount, renderOffset));
  const hasOlder = $derived(startIndex > 0);
  /** Older turns exist above the window, mounted or still on the host's disk. */
  const hasOlderTurnsToLoad = $derived(
    hasOlderTurns(totalCount, renderOffset, sess?.historyTruncated ?? false),
  );

  const visibleMessages = $derived.by(() => {
    const all = sess?.messages ?? [];
    return startIndex > 0 ? all.slice(startIndex) : all;
  });
  const conversationFindMatches = $derived(
    findConversationMatches(sess?.messages ?? [], findQuery),
  );

  const grouped = $derived(groupMessages(visibleMessages));

  // Message navigator (right-gutter rail) is editor-shell only — not the pill or
  // web layouts. The rail itself hides when the gutter is too narrow.
  const isEditorShell = $derived(windowCtx.viewMode === "editor");
  // Gate on isEditorShell: without this the derived rebuilds for every mounted
  // tab on every message change even in pill/web mode where it's never rendered.
  const navItems = $derived(
    isEditorShell && retainTranscriptRows
      ? (sess?.messages ?? [])
          .filter((m) => m.role === "user")
          .map((m) => ({ id: m.id, preview: previewText(m.content) }))
      : [],
  );

  /** The store is the truth for a work's title, preview and type; the message's
   *  own ref is the fallback that keeps a historical row named. */
  function documentStackEntries(messages: Message[]): DocumentStackEntry[] {
    const entries: DocumentStackEntry[] = [];
    for (const message of messages) {
      const ref = message.workRef;
      if (!ref?.workId) continue;
      const work = session.worksStore.get(ref.workId);
      entries.push({
        workId: ref.workId,
        title: work?.title ?? ref.title ?? "Untitled document",
        workType: work?.type ?? ref.workType,
        preview: work?.preview,
        updatedAt: work?.updatedAt,
        streaming: session.worksStore.streaming[ref.workId] ?? false,
      });
    }
    return entries;
  }

  async function prepareMinimapNavigate(id: string) {
    const messages = sess?.messages ?? [];
    const msgIndex = messages.findIndex((m) => m.id === id);
    if (msgIndex === -1) return;
    const requiredOffset = pageOffsetForMessage(messages.length, msgIndex);
    if (requiredOffset > renderOffset) {
      renderOffset = requiredOffset;
      await tick();
    }
  }

  $effect(() => {
    // Every tab stays mounted (hidden via display:none), so without this guard the
    // effect would re-scan `grouped` for all tabs on every message tick. Hidden
    // tabs don't need their work content eagerly hydrated — load on activation.
    if (!isVisible) return;
    for (const item of grouped) {
      if (item.kind !== "document") continue;
      for (const message of item.messages) {
        const workId = message.workRef?.workId;
        // Skip provisional (streaming) ids — their content lives in the store and
        // there is nothing to load from disk yet.
        if (workId && !session.worksStore.streaming[workId]) {
          void session.worksStore.ensureContent(
            workId,
            "conversation-view",
            sess?.run.workingDirectory,
          );
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
  const showActionOrb = $derived(!!tab && !runtime.isMobileViewport);
  let activityReservedWidth = $state(0);

  // §16 — a turn collapses to one row when it ends. Until then it renders the
  // transcript it always did, in the order it happened.
  const isTurnLive = $derived(runIsLive(sess?.status));
  // Keep every settled turn's object identity when event-driven transcript
  // changes rebuild the current turn.
  let previousTurns: Turn[] = [];
  const turns = $derived.by(() => {
    const next = stabilizeTurns(
      buildTurns(grouped, { running: isTurnLive }),
      previousTurns,
    );
    previousTurns = next;
    return next;
  });
  // Scrollback and history loads mount completed turns as one stable transcript.
  // Only new work at the live edge may animate in.
  // Successful and historical work stays compact. The latest failed work opens
  // by default so its commands are immediately available; an explicit user
  // choice then wins and survives transcript re-renders.
  const turnExpansion = new SvelteMap<string, boolean>();
  function toggleTurn(id: string, expanded: boolean) {
    holdAutomaticScroll();
    turnExpansion.set(id, !expanded);
  }

  function turnContainsMessage(
    items: GroupedItem[],
    messageId: string,
  ): boolean {
    return items.some(
      (item) =>
        item.kind !== "tool-group" &&
        item.kind !== "subagent-group" &&
        item.message.id === messageId,
    );
  }

  async function revealFindMatch(match: ConversationFindMatch) {
    const messages = sess?.messages ?? [];
    const messageIndex = messages.findIndex(
      (message) => message.id === match.messageId,
    );
    if (messageIndex === -1) return;

    const requiredOffset = pageOffsetForMessage(messages.length, messageIndex);
    if (requiredOffset > renderOffset) {
      renderOffset = requiredOffset;
      await tick();
    }

    const foldedTurn = turns.find(
      (turn) =>
        turn.body.length > 0 && turnContainsMessage(turn.body, match.messageId),
    );
    if (foldedTurn && !foldedTurn.live) {
      turnExpansion.set(foldedTurn.id, true);
      await tick();
    }

    const target = messagesEl?.querySelector<HTMLElement>(
      `[data-conversation-message-id="${CSS.escape(match.messageId)}"]`,
    );
    // Mount and center the message synchronously first; the second adjustment
    // below can then animate to the exact occurrence inside a long response
    // without fighting an in-flight message-level scroll.
    target?.scrollIntoView({ block: "center" });
    await tick();
    const activeRange = findHighlighter.update(messagesEl, findQuery, match);
    const activeRect = activeRange?.getBoundingClientRect();
    const scrollRect = scrollEl?.getBoundingClientRect();
    if (activeRect && scrollRect && scrollEl) {
      const top = activeRect.top - scrollRect.top;
      const bottom = activeRect.bottom - scrollRect.bottom;
      if (top < 56) {
        scrollEl.scrollBy({ top: top - 80, behavior: "smooth" });
      } else if (bottom > -24) {
        scrollEl.scrollBy({ top: bottom + 48, behavior: "smooth" });
      }
    }
    void findBarRef?.focusInput(false);
  }

  async function openFind() {
    findOpen = true;
    if (sess?.historyTruncated) {
      expandingHistory = true;
      try {
        await session.expandHistory(tabId, { full: true });
      } finally {
        expandingHistory = false;
      }
    }
    await tick();
    await findBarRef?.focusInput();
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
    const query = findQuery;
    const matches = conversationFindMatches;
    if (findIndex >= matches.length)
      findIndex = Math.max(0, matches.length - 1);
    void tick().then(() =>
      findHighlighter.update(messagesEl, query, matches[findIndex] ?? null),
    );
  });

  function handleRetry() {
    session.retryLastMessage(tabId);
  }

  const sessionChangedFiles = $derived(sess?.sessionChangedFiles ?? []);
  const latestTurnSnapshot = $derived(
    sess ? session.turnSnapshots[sess.id]?.at(-1) : undefined,
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
      if (scrollEl) animateScrollTo(scrollEl, 0);
    },
    { enabled: () => tabId === session.focusedChatTabId },
  );

  useKeybinding(
    "conversation.scroll-bottom",
    () => {
      if (!scrollEl) return;
      animateScrollTo(scrollEl, scrollEl.scrollHeight - scrollEl.clientHeight);
      isNearBottom = true;
    },
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
      session.interruptTabSession(tabId);
      session
        .apiFor(tabId)
        .stopSession(session.ctxFor(tabId).session.sessionId);
      requestInputFocus();
    },
    {
      enabled: () =>
        tabId === session.focusedChatTabId &&
        (sess?.status === "running" || sess?.status === "connecting"),
    },
  );

  $effect(() => {
    const handler = (e: Event) => {
      if (!(e instanceof CustomEvent)) return;
      const detail: { tabId?: string } = e.detail;
      if (detail?.tabId && detail.tabId !== tabId) return;
      if (!isVisible) return;
      const snap = () => {
        if (scrollEl) {
          scrollEl.scrollTop = scrollEl.scrollHeight;
          isNearBottom = true;
        }
      };
      requestAnimationFrame(() => {
        snap();
        // content-visibility:auto items settle after initial paint — retry
        // so long sessions land at the true bottom.
        setTimeout(snap, 120);
      });
    };
    window.addEventListener("solus:scroll-conversation-bottom", handler);
    return () =>
      window.removeEventListener("solus:scroll-conversation-bottom", handler);
  });

  // Re-anchor when either the input dock or message content changes the list
  // height. ResizeObserver runs after layout and avoids a forced layout read.
  $effect(() => {
    const el = scrollEl;
    const content = messagesEl;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (
        isVisible &&
        el.clientHeight > 0 &&
        el.scrollHeight <= el.clientHeight &&
        hasOlderTurnsToLoad
      ) {
        void maybeLoadOlder();
        return;
      }
      if (isNearBottom && isVisible && !holdScroll) {
        el.scrollTop = el.scrollHeight;
      }
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
    // Not open — scan history on this conversation's host and resume it. The
    // source session delegated to this one, so it lives on the same host.
    if (!sess) return;
    const meta = await sourceSessionHistory.findSession(
      agentSessionId,
      {
        projectPath: sess.run.workingDirectory || "~",
        serverId: sess.run.serverId,
      },
      session.ctx,
    );
    if (meta) {
      await session.resumeSession(meta);
    }
  }
</script>

<!-- No container: assistant prose sits directly on the canvas. Cards, code and
     tables are the only boxes it may draw. -->
{#snippet assistantBody(displayContent: string)}
  <div
    class="prose-cloud prose-reading prose-transcript prose-transcript-main min-w-0"
  >
    <SvelteMarkdown
      source={displayContent}
      options={assistantMarkdownOptions}
      renderers={markdownRenderers}
      extensions={markdownExtensions}
      sanitizeUrl={markdownSanitizeUrl}
    />
  </div>
{/snippet}

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
    class={isEditorMode ? "flex flex-col h-full min-h-0" : ""}
  >
    <div class="cv-root relative {isEditorMode ? 'flex-1 min-h-0' : ''}">
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
        class="overflow-y-auto overflow-x-hidden px-4 pt-1 conversation-selectable {isEditorMode
          ? 'h-full'
          : ''}"
        style="overscroll-behavior-y:contain; {isEditorMode
          ? ''
          : 'max-height:var(--pill-body-max)'}"
        onscroll={handleScroll}
      >
        <!-- Centered reading column: the message stream and the status strip
             share one fluid column (scales with the conversation
             pane via --solus-reading-max) so everything lines up. No-op in the
             narrow pill window. -->
        <div
          class="w-full"
          style="{isEditorMode
            ? 'max-width:var(--solus-reading-max);margin-inline:auto'
            : 'padding-inline:var(--cv-pill-gutter)'}{reservesBandRoom
            ? `;padding-top:${CRUMB_OFFSET}px`
            : ''}"
        >
          {#if expandingHistory}
            <div
              class="flex justify-center py-2 text-xs text-(--solus-text-tertiary)"
            >
              Loading earlier messages…
            </div>
          {:else if runtime.isTouchDevice && hasOlderTurnsToLoad}
            <!-- Scrolling to the top already pages older turns in, on every
                 client. A phone needs the button as well: it is a hundred rows
                 of flicking to reach the trigger, there is no ⌘↑ to jump to the
                 first message, and in a browser tab a pull at the top reads as
                 the reload gesture rather than as a request for history. -->
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

          {#if retainTranscriptRows}
            <div
              bind:this={messagesEl}
              class="relative messages-list cv-list space-y-2 @max-[30rem]/pane:space-y-3"
            >
              {#each turns as turn, turnIdx (turn.id)}
                {@const skipMotion = !shouldAnimateTurnEntry(
                  turn,
                  turnIdx,
                  turns.length,
                )}
                {@const isLastTurn = turnIdx === turns.length - 1}
                {@const expanded =
                  turnExpansion.get(turn.id) ??
                  (isLastTurn &&
                    turn.end?.kind === "failed" &&
                    hasVisibleTurnBody(turn))}
                {@const live = turn.live}
                <!-- A steer leaves earlier turns live too, and only the last one is
                   where the run is actually working. A turn parked on a question
                   or permission stays live so nothing folds, but the card is what
                   the run is doing — no spinner claims otherwise. -->
                {@const working = live && isLastTurn && !isAwaitingInput}
                <!-- A stop says nothing about the work, so it never stands in for
                   the summary row: the row reports what ran and discloses it,
                   and the stop's own divider follows the turn's content below.
                   A failure keeps its row either way — it carries the error. -->
                {@const hasSummaryRow =
                  !live &&
                  (turn.body.length > 0 || turn.end?.kind === "failed")}
                {#if turn.lead}
                  {@render transcriptItem(turn.lead, skipMotion)}
                {/if}
                <!-- The row only exists once the turn is over; until then the
                   transcript below renders exactly as it always did.
                   Retry re-runs the last prompt, so only the last turn can
                   honestly offer it; an older stop is history. -->
                {#if hasSummaryRow}
                  <TurnActivityRow
                    {turn}
                    live={false}
                    {expanded}
                    attempt={isLastTurn ? (sess.retryAttempt ?? 1) : 1}
                    onToggle={() => toggleTurn(turn.id, expanded)}
                    onRetry={turn.end?.kind === "failed" && isLastTurn
                      ? handleRetry
                      : undefined}
                  />
                {/if}
                <!-- Folding hides this block, it never unmounts it — so ending a
                   turn costs one reflow instead of rebuilding every subtree in
                   it, and expanding hands the same view straight back. -->
                {#if turn.body.length > 0}
                  <div
                    class="turn-body space-y-2 @max-[30rem]/pane:space-y-3"
                    class:is-folded={!live && !expanded}
                    class:is-open={!live && expanded}
                  >
                    {#each turn.body as item, itemIdx (itemKey(item))}
                      {#if item.kind === "tool-group"}
                        <!-- §16 — the transcript keeps its order, but the row at
                           the tail of a working turn is where the run *is*: it
                           takes the spinner rather than letting a second row
                           saying "Thinking" stack underneath it. -->
                        <ToolGroupItem
                          tools={item.messages}
                          {skipMotion}
                          working={working && itemIdx === turn.body.length - 1}
                          {activityLabel}
                          turnStart={working ? sess.currentTurnStart : null}
                          waitingOn={working
                            ? agentsAwaitingReply(turn.body)
                            : []}
                          backgroundWait={working
                            ? describeBackgroundWait(turn.body)
                            : null}
                        />
                      {:else}
                        {@render transcriptItem(item, skipMotion)}
                      {/if}
                    {/each}
                  </div>
                {/if}
                {#if !live && !expanded && turn.visibleWhenCollapsed.length > 0}
                  <div
                    class="space-y-2 @max-[30rem]/pane:space-y-3"
                  >
                    {#each turn.visibleWhenCollapsed as item (itemKey(item))}
                      {@render transcriptItem(item, skipMotion)}
                    {/each}
                  </div>
                {/if}
                {#if hasSummaryRow && turn.tail.length > 0}
                  <div class="turn-rule"></div>
                {/if}
                {#each turn.tail as item (itemKey(item))}
                  {@render transcriptItem(item, skipMotion)}
                {/each}
                <!-- §17's transient endings, in the place they happened: after
                   everything the turn produced, never in front of it. -->
                {#if !live && turn.end && turn.end.kind !== "failed"}
                  <TurnEndDivider
                    end={turn.end}
                    onRetry={isLastTurn ? handleRetry : undefined}
                    {skipMotion}
                  />
                {/if}
                <!-- Only when nothing else is reporting the run: a tool group at
                   the tail already carries the spinner. -->
                {#if working && needsLiveRow(turn)}
                  <TurnActivityRow
                    {turn}
                    live
                    {activityLabel}
                    turnStart={sess.currentTurnStart}
                    backgroundWait={describeBackgroundWait(turn.body)}
                    expanded={false}
                    attempt={sess.retryAttempt ?? 1}
                    onToggle={() => {}}
                  />
                {/if}
              {/each}
            </div>
          {/if}

          {#snippet transcriptItem(item: GroupedItem, skipMotion: boolean)}
            {#if item.kind === "user"}
              <UserMessageBubble message={item.message} {skipMotion} {tabId} />
            {:else if item.kind === "assistant"}
              {@const displayContent = item.message.content.trim()}
              {#if displayContent}
                <!-- The rail hangs in the column's left margin; its copy
                     control aligns with the first line of assistant prose. -->
                <div
                  class="py-2 relative cv-rail-host {skipMotion
                    ? ''
                    : 'animate-msg-in-side'}"
                  data-testid="assistant-message"
                >
                  <!-- A hover rail needs somewhere to hover. That is the
                       pointer, not the window: a touch laptop in a wide window
                       has no hover either, and an iPad with a trackpad does. -->
                  {#if !runtime.isTouchDevice}
                    <MessageHoverRail
                      timestamp={item.message.timestamp}
                      text={displayContent}
                    />
                  {/if}
                  <div
                    class="cv-msg-body min-w-0"
                    data-conversation-message-content
                    data-conversation-message-id={item.message.id}
                  >
                    {@render assistantBody(displayContent)}
                  </div>
                </div>
              {/if}
            {:else if item.kind === "tool-group"}
              <ToolGroupItem tools={item.messages} {skipMotion} />
            {:else if item.kind === "subagent-group"}
              <SubagentGroup messages={item.messages} {tabId} {skipMotion} />
            {:else if item.kind === "system"}
              {#if item.message.forkSourceSessionId}
                <TranscriptDivider
                  glyphClass="text-(--solus-accent)"
                  titleClass="text-(--solus-accent)"
                  ariaLabel="Navigate to source session"
                  onclick={() =>
                    navigateToSourceSession(item.message.forkSourceSessionId!)}
                  testid="fork-session-message"
                  {skipMotion}
                >
                  {#snippet glyph()}<GitForkIcon size={12} />{/snippet}
                  {item.message.forkSourceRunning
                    ? "Forked mid-run from"
                    : "Forked from"}
                  {#snippet title()}"{item.message.forkSourceTitle ||
                      "session"}"{/snippet}
                </TranscriptDivider>
              {:else if item.message.worktreeMovedTo}
                <TranscriptDivider
                  glyphClass="text-(--solus-accent)"
                  titleClass="text-(--solus-accent)"
                  testid="worktree-moved-message"
                  {skipMotion}
                >
                  {#snippet glyph()}<TreeStructureIcon size={12} />{/snippet}
                  Continued in worktree
                  {#snippet title()}{item.message.worktreeMovedTo}{/snippet}
                </TranscriptDivider>
              {:else if item.message.agentChangedTo}
                {@const sourceModel = modelLabelFor(
                  item.message.agentChangedFromProvider,
                  item.message.agentChangedFromModel,
                )}
                {@const targetModel = item.message === activeHandoffDivider
                  ? activeHandoffTargetModel ?? item.message.agentChangedToModel
                  : modelLabelFor(
                      item.message.agentChangedToProvider,
                      item.message.agentChangedToModel,
                    )}
                <TranscriptDivider
                  timestamp={item.message.timestamp}
                  testid="agent-handoff-message"
                  {skipMotion}
                >
                  {#if sourceModel &&
                  targetModel &&
                  item.message.agentChangedFromProvider &&
                  item.message.agentChangedToProvider}
                    <span class="inline-flex max-w-full min-w-0 items-center gap-1.5 align-middle leading-none">
                      <span class="inline-flex min-w-0 items-center gap-1">
                        {#if item.message.agentChangedFromProvider === "claude-code"}
                          <span class="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center text-(--solus-accent)"><ClaudeIcon size={11} /></span>
                        {:else if item.message.agentChangedFromProvider === "codex"}
                          <span class="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-white text-(--solus-accent)"><OpenAIBlossom size={11} /></span>
                        {:else}
                          <span class="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center text-(--solus-accent)"><CodeIcon size={11} /></span>
                        {/if}
                        <span class="truncate">{sourceModel}</span>
                      </span>
                      <ArrowRightIcon size={12} class="flex-shrink-0 text-(--solus-text-tertiary)" />
                      <span class="inline-flex min-w-0 items-center gap-1 text-(--solus-accent)">
                        {#if item.message.agentChangedToProvider === "claude-code"}
                          <span class="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center"><ClaudeIcon size={11} /></span>
                        {:else if item.message.agentChangedToProvider === "codex"}
                          <span class="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-white"><OpenAIBlossom size={11} /></span>
                        {:else}
                          <span class="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center"><CodeIcon size={11} /></span>
                        {/if}
                        <span class="truncate">{targetModel}</span>
                      </span>
                    </span>
                  {:else}
                    Continued with
                    {#snippet title()}{item.message.agentChangedTo}{/snippet}
                  {/if}
                </TranscriptDivider>
              {:else if item.message.newSessionForPlanId}
                <!-- The implementation run keeps none of the planning
                       session's context, only the plan. Stating that is what
                       separates a deliberate restart from a lost thread. -->
                {@const acceptedPlan = planStore.get(
                  item.message.newSessionForPlanId,
                )}
                <TranscriptDivider
                  glyphClass="text-(--solus-accent)"
                  titleClass="text-(--solus-accent)"
                  timestamp={item.message.timestamp}
                  testid="plan-new-session-message"
                  {skipMotion}
                >
                  {#snippet glyph()}<PlusCircleIcon size={12} />{/snippet}
                  New session implementing
                  {#snippet title()}"{acceptedPlan?.title ||
                      "the plan"}"{/snippet}
                </TranscriptDivider>
              {:else}
                <!-- Cancellations, interrupts and errors alike: centred between
                       hairlines, never a bubble and never tinted. A transient
                       state is not a message, so it gets no fill of its own. -->
                <TranscriptDivider
                  timestamp={item.message.timestamp}
                  {skipMotion}
                >
                  {noticeText(item.message.content)}
                </TranscriptDivider>
              {/if}
            {:else if item.kind === "plan"}
              {@const plan = item.message.planId
                ? planStore.get(item.message.planId)
                : undefined}
              <PlanMessageItem
                ref={{
                  kind: "plan",
                  id: plan?.id,
                  title: plan?.title,
                  content: plan?.content,
                  timestamp: plan?.timestamp,
                  comments: plan?.comments,
                  status: plan?.status,
                  bookmarked: plan?.bookmarked,
                }}
                linkTarget={plan
                  ? { kind: "plan", targetScope: plan.sessionId, targetKey: plan.planToolUseId }
                  : undefined}
                {linkContext}
                {skipMotion}
              />
            {:else if item.kind === "document"}
              <!-- One work is not a stack: a single write keeps the plain
                   document card, and the fan begins at two. -->
              {#if item.messages.length === 1}
                {@const workMessage = item.messages[0]}
                {@const work = session.worksStore.get(
                  workMessage.workRef?.workId ?? "",
                )}
                <PlanMessageItem
                  ref={{
                    kind: "document",
                    id: workMessage.workRef?.workId,
                    title: work?.title ?? workMessage.workRef?.title,
                    content: work?.content,
                    updatedAt: work?.updatedAt,
                    workType: work?.type ?? workMessage.workRef?.workType,
                    streaming: workMessage.workRef?.workId
                      ? session.worksStore.streaming[workMessage.workRef.workId]
                      : false,
                  }}
                  linkTarget={workMessage.workRef?.workId
                    ? { kind: "work", targetScope: "", targetKey: workMessage.workRef.workId }
                    : undefined}
                  {linkContext}
                  {skipMotion}
                />
              {:else}
                <DocumentStackCard
                  entries={documentStackEntries(item.messages)}
                  {linkContext}
                  {skipMotion}
                />
              {/if}
            {:else if item.kind === "automation" && item.message.automationRef}
              <AutomationRefCard
                ref={item.message.automationRef}
                {linkContext}
                {skipMotion}
              />
            {:else if item.kind === "task" && item.message.taskRef}
              <TaskRefCard ref={item.message.taskRef} {skipMotion} />
            {:else if item.kind === "browser-snapshot"}
              <!-- One capture is not a gallery: a single frame keeps the card
                   with its full-width picture, and the plate begins at two. -->
              {@const captures = item.messages
                .map((message) => message.browserSnapshot)
                .filter((snapshot) => !!snapshot)}
              {#if captures.length === 1}
                <BrowserSnapshotCard
                  snapshot={captures[0]}
                  serverId={sess?.run.serverId}
                  {skipMotion}
                />
              {:else if captures.length > 1}
                <BrowserSnapshotGallery
                  snapshots={captures}
                  serverId={sess?.run.serverId}
                  {skipMotion}
                />
              {/if}
            {:else if item.kind === "agent-conversation-group"}
              <AgentConversationGroup
                messages={item.messages}
                {tabId}
                {skipMotion}
              />
            {:else if item.kind === "artifact" && item.message.artifact}
              <ArtifactView
                artifact={item.message.artifact}
                workRef={item.message.workRef}
                {linkContext}
                {tabId}
                {skipMotion}
              />
            {:else if item.kind === "review-guide" && item.message.reviewGuideRef}
              <ReviewGuideCard
                ref={item.message.reviewGuideRef}
                {tabId}
                {skipMotion}
              />
            {/if}
          {/snippet}

          {#if sess.statusCard}
            <StatusCard card={sess.statusCard} />
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
          {#if sess.status === "rate_limited" && sess.rateLimitStrategy === "ask"}
            <RateLimitCard tabId={tab.id} />
          {/if}

          <!-- The request belongs to the session whose agent needs Cloudflare;
               a different active conversation must not receive its Continue. -->
          {#if connectRequestStore.visibleFor(sess.run.serverId, sess.id)}
            <ConnectCard tabId={tab.id} />
          {/if}
          <QueuedPromptGroup tabId={tab.id} />

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
                  session.openFilePreview({ path: filePath }, tabId)}
              />
            </div>
          {/if}

          {#if showActionOrb}
            <div class="min-h-16"></div>
          {/if}
        </div>
      </div>

      {#if isEditorShell && retainTranscriptRows}
        <ConversationMinimap
          items={navItems}
          {scrollEl}
          isActive={isVisible}
          prepareNavigate={prepareMinimapNavigate}
        />
      {/if}

      {#if showActionOrb}
        <ActionOrb
          {tabId}
          observeLayout={isVisible}
          leftReservedWidth={showActivityStrip ? activityReservedWidth : 0}
        />
      {/if}

      {#if showActivityStrip}
        <div
          class="activity-strip flex items-end gap-1.5 absolute pointer-events-none"
          class:activity-strip-editor={isEditorMode}
          class:activity-strip-pill={!isEditorMode}
          style="bottom:{isEditorMode ? 3 : 16}px;height:2rem;z-index:7"
        >
          <div
            bind:clientWidth={activityReservedWidth}
            class="flex items-center gap-1.5 text-xs pointer-events-auto"
            class:pl-4={isEditorMode}
            class:pr-2={isEditorMode}
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
  /* Skip layout/paint for messages scrolled out of the viewport. Without this,
     a window resize re-wraps and repaints every message in the conversation
     (markdown, code blocks, tool groups) on each frame — the dominant cause of
     resize lag in editor mode where the full-height column is mounted. The
     `auto` keyword in contain-intrinsic-size remembers each row's last rendered
     height, so the scrollbar stays accurate and scroll position is preserved. */
  .cv-list > :global(*) {
    content-visibility: auto;
    contain-intrinsic-size: auto 3rem;
  }

  /* content-visibility implies paint containment, which clips a child to its
     padding box. An activity row's chassis bleeds into the column gutter so its
     ends can round, and the clip was shearing those ends flat — the same trap
     the rail hit below. These rows are a few spans and an icon, so there is
     nothing worth skipping in them anyway. */
  .cv-list > :global(.activity-block),
  .cv-list > :global(.activity-host),
  .turn-body > :global(.activity-host) {
    content-visibility: visible;
    contain-intrinsic-size: auto;
  }

  /* Pill mode provides the margin needed by the side-mounted message rails. */
  .cv-root {
    --cv-pill-gutter: 2.75rem;
  }

  /* Match the scroll area's 1rem side gutters before applying the reading
     width cap. This keeps the activity label and orb on the same horizontal
     bounds as the message column in narrow split panes. */
  .activity-strip-editor {
    left: 50%;
    width: min(calc(100% - 2rem), var(--solus-reading-max));
    transform: translateX(-50%);
  }

  .activity-strip-pill {
    left: 0;
    right: 0;
    padding-inline: calc(1rem + var(--cv-pill-gutter));
  }

  /* The row itself cannot contain paint because its rail sits outside its
     bounds. Keep the expensive message body independently optimized. */
  .cv-list > :global(.cv-rail-host) {
    content-visibility: visible;
    contain-intrinsic-size: auto;
  }

  .cv-msg-body {
    content-visibility: auto;
    contain-intrinsic-size: auto 3rem;
  }

  /* §16 — the intermediate output is available, not present. While the turn runs
     this block is the transcript itself, undecorated; once it ends it is either
     hidden or indented behind the rule that marks where the fold was. It is
     never unmounted, so ending a turn costs a reflow rather than a rebuild. */
  .turn-body.is-folded {
    display: none;
  }

  .turn-body.is-open {
    margin-left: 0.9375rem;
    padding-left: 0.75rem;
    border-left: 0.0625rem solid
      color-mix(in oklch, var(--foreground) 9%, transparent);
  }

  /* The container itself cannot contain paint because side-mounted rails may
     extend into its margin, so its rows retain the rendering optimization. */
  .cv-list > :global(.turn-body) {
    content-visibility: visible;
    contain-intrinsic-size: auto;
  }

  .turn-body > :global(*) {
    content-visibility: auto;
    contain-intrinsic-size: auto 3rem;
  }

  .turn-body > :global(.cv-rail-host) {
    content-visibility: visible;
    contain-intrinsic-size: auto;
  }

  /* The hairline that closes the activity row and hands the column to the
     answer. */
  .turn-rule {
    height: 0.0625rem;
    margin: 0 0 0.75rem;
    /* A hairline that has never been painted must not claim a row's height in
       the scrollbar when it is off-screen. */
    contain-intrinsic-size: auto 0.0625rem;
    background: color-mix(in oklch, var(--foreground) 8%, transparent);
  }
</style>
