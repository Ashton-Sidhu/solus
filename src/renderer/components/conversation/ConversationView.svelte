<script lang="ts">
  import { tick } from "svelte";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import { markdownSanitizeUrl } from "../../lib/markdownSanitize";
  import {
    DesktopTowerIcon,
    FileTextIcon,
    GitForkIcon,
    PlusCircleIcon,
    TreeStructureIcon,
  } from "phosphor-svelte";
  import { computeCurrentActivity } from "../../contexts/workspace/session.utils";
  import {
    getWorkspaceContext,
    getPlanStore,
    createSessionHistoryStore,
    getSettingsContext,
    getWindowContext,
    runtime,
    cloudflareStore,
  } from "../../contexts";
  import { useKeybinding } from "../../lib/keybindings/use-keybinding.svelte";
  import { getOuterScrollbarContext } from "../layout/lib/outer-scrollbar.context";
  import PermissionCard from "./PermissionCard.svelte";
  import QuestionCard from "./QuestionCard.svelte";
  import RateLimitCard from "./RateLimitCard.svelte";
  import CloudflareConnectCard from "../cloudflare/ConnectCard.svelte";
  import QueuedPromptGroup from "./queued/QueuedPromptGroup.svelte";
  import StatusCard from "./StatusCard.svelte";
  import TranscriptDivider from "./TranscriptDivider.svelte";
  import TranscriptStatusRow from "./TranscriptStatusRow.svelte";
  import TurnActivityRow from "./TurnActivityRow.svelte";
  import TurnEndDivider from "./TurnEndDivider.svelte";
  import MessageHoverRail from "./MessageHoverRail.svelte";

  import UserMessageBubble from "./UserMessageBubble.svelte";
  import ToolGroupItem from "./ToolGroupItem.svelte";
  import SubagentGroup from "./SubagentGroup.svelte";
  import PlanMessageItem from "../plan/PlanMessageItem.svelte";
  import AutomationRefCard from "../automations/AutomationRefCard.svelte";
  import TaskRefCard from "./TaskRefCard.svelte";
  import AgentConversationGroup from "./agent-conversation/AgentConversationGroup.svelte";
  import { agentsAwaitingReply } from "./agent-conversation/lib/agent-conversation";
  import ArtifactView from "../artifact/ArtifactView.svelte";
  import CodeBlock from "../ui/CodeBlock.svelte";
  import CodeSpan from "../ui/CodeSpan.svelte";
  import MarkdownLink from "./MarkdownLink.svelte";
  import MarkdownImage from "./MarkdownImage.svelte";
  import ProgressTracker from "./ProgressTracker.svelte";
  import DiffSummaryCard from "./DiffSummaryCard.svelte";
  import ConversationMinimap from "./ConversationMinimap.svelte";
  import { FindBar } from "../ui/find-bar";
  import { previewText } from "./lib/minimap";
  import {
    findConversationMatches,
    type ConversationFindMatch,
  } from "./lib/find";
  import { questionAnchorScrollTop } from "./lib/question-scroll";
  import { ConversationFindHighlighter } from "./lib/find-highlight";
  import { noticeText } from "./lib/transient";
  import {
    buildTurns,
    groupMessages,
    hasVisibleTurnBody,
    itemKey,
    needsLiveRow,
    runIsLive,
    type GroupedItem,
  } from "./lib/turns";
  import { SvelteMap } from "svelte/reactivity";
  import { assistantMarkdownOptions } from "./lib/assistant-markdown";
  import ActionOrb from "../layout/ActionOrb.svelte";
  import ConversationSkeleton from "./ConversationSkeleton.svelte";
  import SessionContextMenu from "../session/SessionContextMenu.svelte";
  import NewTabHome from "../layout/NewTabHome.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { LOCAL_SERVER_ID } from "@client-core/server-registry";
  import { serversStore } from "../../contexts/connections/servers.store.svelte";
  import { setMarkdownImageContext } from "./lib/markdown-image";
  import { setSessionLinkContext } from "./lib/session-link-context";

  const markdownRenderers = {
    code: CodeBlock,
    codespan: CodeSpan,
    image: MarkdownImage,
    link: MarkdownLink,
  };

  const INITIAL_RENDER_CAP = 100;
  const PAGE_SIZE = 100;

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
    onDiffToggle,
    forceVisible = false,
    surfaceVisible = true,
    retainTranscriptRows = true,
  }: {
    tabId: string;
    onDiffToggle?: () => void;
    forceVisible?: boolean;
    surfaceVisible?: boolean;
    retainTranscriptRows?: boolean;
  } = $props();

  // The pool instance is on screen only while its tab is active; the split-pane
  // instance (forceVisible) is always on screen. Visibility gates autoscroll and
  // streaming work; keybindings stay gated on the focused chat so the two visible
  // instances never both respond to one shortcut.
  const isVisible = $derived(
    surfaceVisible && (forceVisible || tabId === session.activeTabId),
  );

  const tab = $derived(session.tabs[tabId]);
  const sess = $derived(session.sessionFor(tabId));
  setMarkdownImageContext({
    cwd: () => sess?.run.workingDirectory,
    serverId: () => sess?.run.serverId,
    ctx: () => (sess ? session.ctxFor(tabId) : undefined),
    isWeb: () => windowCtx.isWeb,
  });
  setSessionLinkContext(() => sess?.run.serverId);
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
  const streamingText = $derived(
    sess ? session.streamingTextFor(sess.id, isVisible) : "",
  );

  // ─── Breadcrumb room ───
  // The band that says where you are belongs to the pane, not to this
  // transcript: `WorkspaceBody` draws it over the leading pane and
  // `AsidePaneShell` puts it in its chrome row. Only the leading one floats, so
  // only the pool instance reserves room under it — a pinned instance
  // (forceVisible) sits below a row that already took its own height.
  const reservesBandRoom = $derived(isEditorMode && isVisible && !forceVisible);
  // 46px of band plus the gap under it.
  const CRUMB_OFFSET = 58;
  let stripMenu = $state<{ tabId: string; x: number; y: number } | null>(null);

  // ── Smooth typewriter reveal ──────────────────────────────────────────────
  // Text arrives in coarse ~300ms batches (control-plane TEXT_FLUSH_INTERVAL_MS).
  // Rendering each batch directly makes Claude's output appear in jumpy bursts.
  // Instead we reveal the buffered text with an adaptive rAF loop: the reveal
  // rate scales with how far behind we are, so it stays gently ahead of arrival
  // and reads like fast, continuous typing (Codex-style) rather than chunks.
  const REVEAL_DRAIN_MS = 300; // aim to drain the current backlog over ~this window
  const REVEAL_MIN_CPS = 140; // floor so short bursts still animate visibly
  const REVEAL_MAX_CPS = 4200; // ceiling so huge dumps finish well under a second
  // Markdown parsing, DOM reconciliation, and ResizeObserver work all follow
  // this cursor. 30 FPS remains visually continuous while preventing coarse
  // transport batches from becoming up to 18 full markdown renders apiece.
  const REVEAL_FRAME_MS = 1000 / 30;
  const prefersReducedMotion =
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  let revealLen = $state(0);
  let revealExact = 0; // float cursor; revealLen is its floor
  let revealRaf = 0;
  let revealLastTs = 0;
  let revealWasVisible = false;

  function stopReveal() {
    if (revealRaf) cancelAnimationFrame(revealRaf);
    revealRaf = 0;
    revealLastTs = 0;
  }

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

  function revealTick(ts: number) {
    revealRaf = 0;
    const target = streamingText;
    if (revealLastTs === 0) revealLastTs = ts - REVEAL_FRAME_MS;
    const dt = ts - revealLastTs;
    if (dt < REVEAL_FRAME_MS) {
      revealRaf = requestAnimationFrame(revealTick);
      return;
    }
    revealLastTs = ts;
    const backlog = target.length - revealExact;
    if (backlog <= 0) {
      revealExact = target.length;
      revealLen = target.length;
      revealLastTs = 0;
      return; // caught up — effect restarts the loop when more text arrives
    }
    // Faster when further behind so we never lag the stream, easing as we catch up.
    const cps = Math.min(
      REVEAL_MAX_CPS,
      Math.max(REVEAL_MIN_CPS, backlog / (REVEAL_DRAIN_MS / 1000)),
    );
    revealExact = Math.min(target.length, revealExact + cps * (dt / 1000));
    revealLen = Math.floor(revealExact);
    revealRaf = requestAnimationFrame(revealTick);
  }

  $effect(() => {
    const target = streamingText;
    if (!isVisible) {
      revealWasVisible = false;
      stopReveal();
      return;
    }

    const becameVisible = !revealWasVisible;
    revealWasVisible = true;
    // Catch a previously hidden tab up in one update. Reduced-motion users and
    // committed/reset buffers also skip the animated reveal.
    if (becameVisible || prefersReducedMotion || target.length < revealExact) {
      stopReveal();
      revealExact = target.length;
      revealLen = target.length;
      return;
    }
    if (revealExact < target.length && revealRaf === 0) {
      revealLastTs = 0;
      revealRaf = requestAnimationFrame(revealTick);
    }
  });

  // Tear down the loop when the view unmounts.
  $effect(() => () => stopReveal());

  const displayedText = $derived(streamingText.slice(0, revealLen));
  // Hold the streaming renderer across the commit boundary so finalization
  // doesn't look like the assistant message was removed and re-inserted.
  let lastStreamingText = "";
  let settlingText = $state("");
  let settlingTimer: ReturnType<typeof setTimeout> | null = null;
  let finalizedStreamMessageIds = $state<Record<string, true>>({});

  function clearSettlingTimer() {
    if (settlingTimer) clearTimeout(settlingTimer);
    settlingTimer = null;
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

  // Infinite scroll: reveal older messages as the user nears the top. Pages
  // through already-loaded messages first (instant), then pulls the rest of a
  // windowed transcript from disk on demand. The scroll position is anchored
  // across the insert so the previously-visible messages stay put rather than
  // jumping when content is added above them.
  // `auto` marks the backfill nobody asked for — filling a viewport the restored
  // window left short. That one pages through disk history; only a user scrolling
  // to the top is worth reading a long session end to end.
  const NEAR_TOP_PX = 300;
  async function maybeLoadOlder(opts?: { auto?: boolean }) {
    const el = scrollEl;
    if (!el || loadingOlder || el.scrollTop > NEAR_TOP_PX) return;
    if (!hasOlder && !sess?.historyTruncated) return;

    loadingOlder = true;
    const prevHeight = el.scrollHeight;
    const prevTop = el.scrollTop;
    try {
      // Older messages still on disk — load the full transcript first, then the
      // renderOffset bump below reveals the page above the current view.
      if (!hasOlder && sess?.historyTruncated) {
        expandingHistory = true;
        try {
          await session.expandHistory(tabId, { paged: opts?.auto });
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
      (hasOlder || sess?.historyTruncated)
    ) {
      void maybeLoadOlder({ auto: true });
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
        await session.expandHistory(tabId);
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

  // Structural changes that should re-pin the view to the bottom. Streaming text
  // is handled by the content ResizeObserver below, so it deliberately stays out
  // of this trigger — otherwise the effect below would fire
  // (and force a full-document layout) every ~80 streamed characters, thrashing
  // everything on screen, including the input dock, throughout a response.
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
  const startIndex = $derived(
    Math.max(0, totalCount - INITIAL_RENDER_CAP - renderOffset * PAGE_SIZE),
  );
  const hasOlder = $derived(startIndex > 0);

  const visibleMessages = $derived.by(() => {
    const all = sess?.messages ?? [];
    const start = Math.max(
      0,
      all.length - INITIAL_RENDER_CAP - renderOffset * PAGE_SIZE,
    );
    return start > 0 ? all.slice(start) : all;
  });
  const conversationFindMatches = $derived(
    findConversationMatches(sess?.messages ?? [], findQuery),
  );

  const grouped = $derived(groupMessages(visibleMessages));
  const settlingCommittedId = $derived.by(() => {
    if (!settlingText.trim()) return "";
    const settled = settlingText.trim();
    for (let i = grouped.length - 1; i >= 0; i--) {
      const item = grouped[i];
      if (item.kind === "assistant") {
        const committed = item.message.content.trim();
        // The final text chunk and task_complete can land in one Svelte batch.
        // In that case the effect above may only have observed a long prefix or
        // suffix of the stream even though the reducer committed the full text.
        // Reconcile that same turn instead of briefly rendering two assistants.
        if (
          committed === settled ||
          committed.startsWith(settled) ||
          committed.endsWith(settled)
        ) {
          return item.message.id;
        }
        continue;
      }
      if (item.kind === "user") break;
    }
    return "";
  });
  const liveStreamContent = $derived(
    streamingText ? displayedText : settlingText,
  );
  const displayGrouped = $derived.by(() => {
    if (!liveStreamContent) return grouped;
    if (settlingCommittedId) {
      return grouped.map((item) =>
        item.kind === "assistant" && item.message.id === settlingCommittedId
          ? {
              kind: "live-assistant" as const,
              id: `live-${settlingCommittedId}`,
              // Once the reducer has committed, prefer its authoritative full
              // text even if the last render only observed part of the stream.
              content: item.message.content.trim(),
              settledMessageId: settlingCommittedId,
            }
          : item,
      );
    }
    return [
      ...grouped,
      {
        kind: "live-assistant" as const,
        id: "live-stream",
        content: liveStreamContent,
      },
    ];
  });

  $effect(() => {
    const text = streamingText;
    if (text) {
      lastStreamingText = text;
      if (settlingText) settlingText = "";
      clearSettlingTimer();
      return;
    }

    if (!lastStreamingText) return;
    settlingText = lastStreamingText;
    lastStreamingText = "";
    const delay = prefersReducedMotion ? 0 : 180;
    clearSettlingTimer();
    settlingTimer = setTimeout(() => {
      settlingText = "";
      settlingTimer = null;
    }, delay);
  });

  $effect(() => {
    const id = settlingCommittedId;
    if (id) finalizedStreamMessageIds[id] = true;
  });

  $effect(() => () => clearSettlingTimer());

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

  async function prepareMinimapNavigate(id: string) {
    const messages = sess?.messages ?? [];
    const msgIndex = messages.findIndex((m) => m.id === id);
    if (msgIndex === -1) return;
    const requiredOffset = Math.ceil(
      Math.max(0, messages.length - INITIAL_RENDER_CAP - msgIndex) / PAGE_SIZE,
    );
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
      const workId = item.message.workRef?.workId;
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
  });

  const isInterrupted = $derived(sess?.status === "interrupted");
  const isAwaitingPlan = $derived(sess?.status === "awaiting_plan");
  const isAwaitingInput = $derived(sess?.status === "awaiting_input");
  const currentActivity = $derived(sess ? computeCurrentActivity(sess) : "");
  const activityLabel = $derived(
    isAwaitingPlan ? "Awaiting plan approval" : currentActivity || undefined,
  );
  // Running, stopped and failed are all reported by the turn's own activity row
  // (§16, §17) — the strip only carries what no turn can express.
  const showActivityStrip = $derived(!!sess && isAwaitingPlan);
  let activityReservedWidth = $state(0);

  // §16 — a turn collapses to one row when it ends. Until then it renders the
  // transcript it always did, in the order it happened.
  const isTurnLive = $derived(runIsLive(sess?.status, !!liveStreamContent));
  const turns = $derived(buildTurns(displayGrouped, { running: isTurnLive }));
  // Scrollback and history loads must not replay two hundred entry animations;
  // only the turns at the live end of the transcript animate in.
  const animatedTurnStart = $derived(Math.max(0, turns.length - 2));
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
        item.kind !== "live-assistant" &&
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

    const requiredOffset = Math.ceil(
      Math.max(0, messages.length - INITIAL_RENDER_CAP - messageIndex) /
        PAGE_SIZE,
    );
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
        await session.expandHistory(tabId);
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
      session.apiFor(tabId).stopSession(session.ctxFor(tabId).session.sessionId);
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
      const detail = (e as CustomEvent<{ tabId?: string }>).detail;
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

  // Re-anchor when either the input dock changes the viewport height or streamed
  // markdown changes the message-list height. ResizeObserver runs after layout,
  // avoiding a forced layout read in every reveal frame.
  $effect(() => {
    const el = scrollEl;
    const content = messagesEl;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (
        isVisible &&
        el.clientHeight > 0 &&
        el.scrollHeight <= el.clientHeight &&
        (hasOlder || sess?.historyTruncated)
      ) {
        void maybeLoadOlder({ auto: true });
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
    const matchingTabId = session.tabIdForAgentSession(agentSessionId);
    if (matchingTabId) {
      session.selectTab(matchingTabId);
      return;
    }
    // Not open — scan history and resume it.
    const meta = await sourceSessionHistory.findSession(
      agentSessionId,
      { projectPath: sess?.run.workingDirectory || "~" },
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
  <div class="prose-cloud prose-reading prose-transcript min-w-0">
    <SvelteMarkdown
      source={displayContent}
      options={assistantMarkdownOptions}
      renderers={markdownRenderers}
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
      <span class="font-mono text-[0.75rem]"
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
            class="status-row-action"
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
{:else if tab && sess && sess.messages.length === 0 && !sess.statusCard}
  <NewTabHome {tab} />
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
        <div class="absolute top-2 right-3 z-20">
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
        <!-- Centered reading column: progress tracker, message stream and the
             status strip share one fluid column (scales with the conversation
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
          {#if runtime.isMobileViewport}
            <!-- Mobile has no action row, so progress stays as a top card here.
                 On desktop the progress lives inside the ActionOrb action row. -->
            <ProgressTracker
              progress={sess?.progress ?? null}
              interrupted={isInterrupted}
            />
          {/if}
          {#if expandingHistory}
            <div
              class="flex justify-center py-2 text-[0.6875rem] text-(--solus-text-tertiary)"
            >
              Loading earlier messages…
            </div>
          {/if}

          {#if retainTranscriptRows}
            <div
              bind:this={messagesEl}
              class="relative messages-list cv-list {runtime.isMobileViewport
                ? 'space-y-3'
                : 'space-y-2'}"
            >
              {#each turns as turn, turnIdx (turn.id)}
                {@const skipMotion = turnIdx < animatedTurnStart}
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
                    class="turn-body {runtime.isMobileViewport
                      ? 'space-y-3'
                      : 'space-y-2'}"
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
                        />
                      {:else}
                        {@render transcriptItem(item, skipMotion)}
                      {/if}
                    {/each}
                  </div>
                {/if}
                {#if !live && !expanded && turn.visibleWhenCollapsed.length > 0}
                  <div
                    class={runtime.isMobileViewport ? "space-y-3" : "space-y-2"}
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
                   the tail already carries the spinner, and streaming text is
                   itself the evidence that work is happening. -->
                {#if working && needsLiveRow(turn)}
                  <TurnActivityRow
                    {turn}
                    live
                    {activityLabel}
                    turnStart={sess.currentTurnStart}
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
              <UserMessageBubble message={item.message} {skipMotion} />
            {:else if item.kind === "live-assistant"}
              <!-- Nothing appears while a message is streaming; the rail
                     arrives with the last token. -->
              <div
                class="py-2 relative {skipMotion || item.settledMessageId
                  ? ''
                  : 'animate-msg-in-side'}"
                data-testid="assistant-message"
              >
                <div
                  class="cv-msg-body min-w-0"
                  data-conversation-message-content
                  data-conversation-message-id={item.settledMessageId}
                >
                  <div
                    class="prose-cloud prose-reading prose-transcript min-w-0"
                  >
                    <SvelteMarkdown
                      source={item.content}
                      streaming
                      options={assistantMarkdownOptions}
                      renderers={markdownRenderers}
                      sanitizeUrl={markdownSanitizeUrl}
                    />
                  </div>
                </div>
              </div>
            {:else if item.kind === "assistant"}
              {@const displayContent = item.message.content.trim()}
              {#if displayContent && item.message.id !== settlingCommittedId}
                <!-- The rail hangs in the column's left margin and aligns with
                       the bottom of the assistant message. -->
                <div
                  class="py-2 relative cv-rail-host {skipMotion ||
                  finalizedStreamMessageIds[item.message.id]
                    ? ''
                    : 'animate-msg-in-side'}"
                  data-testid="assistant-message"
                >
                  {#if !runtime.isMobileViewport}
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
                {skipMotion}
              />
            {:else if item.kind === "document"}
              {@const work = session.worksStore.get(
                item.message.workRef?.workId ?? "",
              )}
              <PlanMessageItem
                ref={{
                  kind: "document",
                  id: item.message.workRef?.workId,
                  title: work?.title ?? item.message.workRef?.title,
                  content: work?.content,
                  updatedAt: work?.updatedAt,
                  workType: work?.type ?? item.message.workRef?.workType,
                  streaming: item.message.workRef?.workId
                    ? session.worksStore.streaming[item.message.workRef.workId]
                    : false,
                }}
                {skipMotion}
              />
            {:else if item.kind === "automation" && item.message.automationRef}
              <AutomationRefCard
                ref={item.message.automationRef}
                {skipMotion}
              />
            {:else if item.kind === "task" && item.message.taskRef}
              <TaskRefCard ref={item.message.taskRef} {skipMotion} />
            {:else if item.kind === "agent-conversation-group"}
              <AgentConversationGroup
                messages={item.messages}
                {tabId}
                {skipMotion}
              />
            {:else if item.kind === "artifact" && item.message.artifact}
              <ArtifactView artifact={item.message.artifact} {tabId} {skipMotion} />
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

          <!-- The request is app-wide, not per-session, so it stands in the one
               conversation the user is looking at rather than in all of them. -->
          {#if cloudflareStore.connectCardVisible && tab.id === session.activeTabId}
            <CloudflareConnectCard tabId={tab.id} />
          {/if}
          <QueuedPromptGroup tabId={tab.id} />

          {#if showTurnDiffSummary && latestTurnScope}
            <!-- Stands off the turn it reports on: the summary is a footnote to
                 the last message, not the next line of it. -->
            <div class="flex justify-center pt-3 animate-msg-in-up">
              <DiffSummaryCard
                {tabId}
                scope={latestTurnScope}
                onOpenDiff={(filePath) => session.showDiff(tabId, latestTurnScope, filePath)}
              />
            </div>
          {/if}

          <div class="min-h-[6.25rem]"></div>
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

      {#if tab && !runtime.isMobileViewport}
        <ActionOrb
          {tabId}
          {onDiffToggle}
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
            class="flex items-center gap-1.5 text-[0.6875rem] pointer-events-auto"
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
