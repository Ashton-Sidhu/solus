<script lang="ts">
  import { tick } from "svelte";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import { markdownSanitizeUrl } from "../../lib/markdownSanitize";
  import {
    ArrowCounterClockwiseIcon,
    ArrowsLeftRightIcon,
    ClipboardTextIcon,
    GitForkIcon,
    TreeStructureIcon,
  } from "phosphor-svelte";
  import { computeCurrentActivity } from "../../contexts/workspace/session.utils";
  import {
    getWorkspaceContext,
    getPlanStore,
    createSessionHistoryStore,
    getWindowContext,
    runtime,
  } from "../../contexts";
  import { useKeybinding } from "../../lib/keybindings/use-keybinding.svelte";
  import PermissionCard from "./PermissionCard.svelte";
  import QuestionCard from "./QuestionCard.svelte";
  import RateLimitCard from "./RateLimitCard.svelte";
  import StatusCard from "./StatusCard.svelte";

  import UserMessageBubble from "./UserMessageBubble.svelte";
  import ToolGroupItem from "./ToolGroupItem.svelte";
  import SubagentGroup from "./SubagentGroup.svelte";
  import PlanMessageItem from "../plan/PlanMessageItem.svelte";
  import AutomationRefCard from "../automations/AutomationRefCard.svelte";
  import TaskRefCard from "./TaskRefCard.svelte";
  import SessionRefCard from "./SessionRefCard.svelte";
  import ArtifactView from "../artifact/ArtifactView.svelte";
  import CopyButton from "../ui/CopyButton.svelte";
  import CodeBlock from "../ui/CodeBlock.svelte";
  import CodeSpan from "../ui/CodeSpan.svelte";
  import MarkdownLink from "./MarkdownLink.svelte";
  import ProgressTracker from "./ProgressTracker.svelte";
  import ConversationMinimap from "./ConversationMinimap.svelte";
  import { previewText } from "./lib/minimap";
  import { assistantMarkdownExtensions } from "./lib/assistant-markdown";
  import ActionOrb from "../layout/ActionOrb.svelte";
  import ConversationSkeleton from "./ConversationSkeleton.svelte";
  import NewTabHome from "../layout/NewTabHome.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { formatMessageTime } from "../../lib/sessionUtils";

  const markdownRenderers = {
    code: CodeBlock,
    codespan: CodeSpan,
    link: MarkdownLink,
  };
  import type { Message } from "../../../shared/types";

  const INITIAL_RENDER_CAP = 100;
  const PAGE_SIZE = 100;

  type GroupedItem =
    | { kind: "user"; message: Message }
    | { kind: "assistant"; message: Message }
    | {
        kind: "live-assistant";
        id: string;
        content: string;
        settledMessageId?: string;
      }
    | { kind: "system"; message: Message }
    | { kind: "tool-group"; messages: Message[] }
    | { kind: "subagent-group"; messages: Message[] }
    | { kind: "plan"; message: Message }
    | { kind: "document"; message: Message }
    | { kind: "automation"; message: Message }
    | { kind: "task"; message: Message }
    | { kind: "session"; message: Message }
    | { kind: "artifact"; message: Message };

  function groupMessages(messages: Message[]): GroupedItem[] {
    const result: GroupedItem[] = [];
    let toolBuf: Message[] = [];
    let subagentBuf: Message[] = [];
    const flushTools = () => {
      if (toolBuf.length > 0) {
        result.push({ kind: "tool-group", messages: [...toolBuf] });
        toolBuf = [];
      }
    };
    const flushSubagents = () => {
      if (subagentBuf.length > 0) {
        result.push({ kind: "subagent-group", messages: [...subagentBuf] });
        subagentBuf = [];
      }
    };
    for (const msg of messages) {
      if (msg.role === "tool" && msg.subMessages) {
        // Consecutive sub-agents share one compact surface instead of repeating
        // card chrome for every member of an orchestrated batch.
        flushTools();
        subagentBuf.push(msg);
      } else if (msg.role === "tool") {
        flushSubagents();
        toolBuf.push(msg);
      } else {
        flushTools();
        flushSubagents();
        if (msg.role === "user") result.push({ kind: "user", message: msg });
        else if (msg.workRef) result.push({ kind: "document", message: msg });
        else if (msg.automationRef)
          result.push({ kind: "automation", message: msg });
        else if (msg.taskRef) result.push({ kind: "task", message: msg });
        else if (msg.sessionRef) result.push({ kind: "session", message: msg });
        else if (msg.artifact) result.push({ kind: "artifact", message: msg });
        else if (msg.role === "assistant")
          result.push({ kind: "assistant", message: msg });
        else if (msg.role === "plan")
          result.push({ kind: "plan", message: msg });
        else result.push({ kind: "system", message: msg });
      }
    }
    flushTools();
    flushSubagents();
    return result;
  }

  const session = getWorkspaceContext();
  const planStore = getPlanStore();
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
  }: {
    tabId: string;
    onDiffToggle?: () => void;
    forceVisible?: boolean;
  } = $props();

  // The pool instance is on screen only while its tab is active; the split-pane
  // instance (forceVisible) is always on screen. Visibility gates autoscroll and
  // streaming work; keybindings stay gated on the focused chat so the two visible
  // instances never both respond to one shortcut.
  const isVisible = $derived(forceVisible || tabId === session.activeTabId);

  const tab = $derived(session.tabs[tabId]);
  const sess = $derived(session.sessionFor(tabId));
  const streamingText = $derived(session.streaming.text[tabId] ?? "");

  // ── Smooth typewriter reveal ──────────────────────────────────────────────
  // Text arrives in coarse ~300ms batches (control-plane TEXT_FLUSH_INTERVAL_MS).
  // Rendering each batch directly makes Claude's output appear in jumpy bursts.
  // Instead we reveal the buffered text with an adaptive rAF loop: the reveal
  // rate scales with how far behind we are, so it stays gently ahead of arrival
  // and reads like fast, continuous typing (Codex-style) rather than chunks.
  const REVEAL_DRAIN_MS = 300; // aim to drain the current backlog over ~this window
  const REVEAL_MIN_CPS = 140; // floor so short bursts still animate visibly
  const REVEAL_MAX_CPS = 4200; // ceiling so huge dumps finish well under a second
  const REVEAL_FRAME_MS = 1000 / 60; // keep streamed text visually continuous
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

  // Glue the view to the bottom after structural changes. Streaming growth is
  // observed below so the reveal loop never forces a scrollHeight read itself.
  function pinToBottom() {
    const el = scrollEl;
    if (el && isVisible && isNearBottom) {
      el.scrollTop = el.scrollHeight;
    }
    // content-visibility:auto rows (e.g. UserMessageBubble) can still report
    // their placeholder contain-intrinsic-size right after insertion, so the
    // read above can undershoot the real bottom. Settle once more after the
    // browser measures them, same retry used by the solus:scroll-conversation-bottom handler.
    setTimeout(() => {
      if (scrollEl && isVisible && isNearBottom) {
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
  let renderOffset = $state(0);
  let expandingHistory = $state(false);
  let isNearBottom = true;
  let loadingOlder = false;

  // Infinite scroll: reveal older messages as the user nears the top. Pages
  // through already-loaded messages first (instant), then pulls the rest of a
  // windowed transcript from disk on demand. The scroll position is anchored
  // across the insert so the previously-visible messages stay put rather than
  // jumping when content is added above them.
  const NEAR_TOP_PX = 300;
  async function maybeLoadOlder() {
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
    const queued = sess?.serverQueuedPrompts?.length ?? 0;
    return `${msgCount}:${permLen}:${qLen}:${queued}`;
  });

  $effect(() => {
    void scrollTrigger;
    if (isVisible && isNearBottom) {
      requestAnimationFrame(pinToBottom);
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
  const historicalThreshold = $derived(Math.max(0, totalCount - 20));

  const visibleMessages = $derived.by(() => {
    const all = sess?.messages ?? [];
    const start = Math.max(
      0,
      all.length - INITIAL_RENDER_CAP - renderOffset * PAGE_SIZE,
    );
    return start > 0 ? all.slice(start) : all;
  });

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
    isEditorShell
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
          sess?.workingDirectory,
        );
      }
    }
  });

  const isRunning = $derived(
    sess?.status === "running" || sess?.status === "connecting",
  );
  const isDead = $derived(sess?.status === "dead");
  const isFailed = $derived(sess?.status === "failed");
  const isInterrupted = $derived(sess?.status === "interrupted");
  const isAwaitingPlan = $derived(sess?.status === "awaiting_plan");
  const currentActivity = $derived(sess ? computeCurrentActivity(sess) : "");
  const showActivityStrip = $derived(
    !!sess &&
      (isRunning || isAwaitingPlan || isDead || isFailed || isInterrupted),
  );
  let activityReservedWidth = $state(0);

  // The pending plan whose approval the session is blocked on — used to jump
  // straight to it from the awaiting-plan footer below.
  const pendingPlanId = $derived.by(() => {
    if (!sess) return undefined;
    for (let i = sess.messages.length - 1; i >= 0; i--) {
      const m = sess.messages[i];
      if (
        m.role === "plan" &&
        m.planId &&
        planStore.get(m.planId)?.status === "pending"
      )
        return m.planId;
    }
    return undefined;
  });

  function handleRetry() {
    session.retryLastMessage(tabId);
  }

  const sessionChangedFiles = $derived(sess?.sessionChangedFiles ?? []);

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
      session.interruptTab(tabId);
      window.solus.stopTab(session.ctxFor(tabId));
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
      if (isNearBottom && isVisible) {
        el.scrollTop = el.scrollHeight;
      }
    });
    ro.observe(el);
    ro.observe(content);
    return () => ro.disconnect();
  });

  async function navigateToSourceSession(agentSessionId: string) {
    // Find an open tab whose session has this agent session ID
    const matchingTabId = session.tabOrder.find((tid) => {
      const s = session.sessionFor(tid);
      return (
        s?.agentSessionId === agentSessionId ||
        s?.forkedFromSessionId === agentSessionId
      );
    });
    if (matchingTabId) {
      session.selectTab(matchingTabId);
      return;
    }
    // Not open — scan history and resume it.
    const meta = await sourceSessionHistory.findSession(
      agentSessionId,
      { projectPath: sess?.workingDirectory || "~" },
      session.ctx,
    );
    if (meta) {
      await session.resumeSession(meta);
    }
  }
</script>

{#snippet assistantBody(displayContent: string)}
  <div
    class="pl-3 relative z-[1] border-l-2 border-(--solus-assistant-left-border) min-w-0"
  >
    <div class="prose-cloud prose-reading min-w-0">
      <SvelteMarkdown
        source={displayContent}
        extensions={assistantMarkdownExtensions}
        renderers={markdownRenderers}
        sanitizeUrl={markdownSanitizeUrl}
      />
    </div>
  </div>
{/snippet}

{#if tab && sess && sess.loadingHistory}
  <ConversationSkeleton />
{:else if tab && sess && sess.agentSessionId && sess.messages.length === 0 && !sess.statusCard}
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
      <div
        bind:this={scrollEl}
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
          style={isEditorMode
            ? "max-width:var(--solus-reading-max);margin-inline:auto"
            : "padding-inline:var(--cv-pill-gutter)"}
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

          <div
            bind:this={messagesEl}
            class="relative messages-list cv-list {runtime.isMobileViewport
              ? 'space-y-3'
              : 'space-y-2'}"
          >
            {#each displayGrouped as item, idx (item.kind === "tool-group" ? `tg-${item.messages[0].id}` : item.kind === "subagent-group" ? `sg-${item.messages[0].id}` : item.kind === "live-assistant" ? item.id : item.message.id)}
              {@const msgIndex = startIndex + idx}
              {@const skipMotion = msgIndex < historicalThreshold}
              {#if item.kind === "user"}
                <UserMessageBubble message={item.message} {skipMotion} />
              {:else if item.kind === "live-assistant"}
                <div
                  class="py-2 group/msg relative cv-stamp-host {skipMotion ||
                  item.settledMessageId
                    ? ''
                    : 'animate-msg-in-side'}"
                  data-testid="assistant-message"
                >
                  <div class="cv-msg-body">
                    <div
                      class="pl-3 relative z-[1] border-l-2 border-(--solus-assistant-left-border) min-w-0"
                    >
                      <div class="prose-cloud prose-reading min-w-0">
                        <SvelteMarkdown
                          source={item.content}
                          streaming
                          extensions={assistantMarkdownExtensions}
                          renderers={markdownRenderers}
                          sanitizeUrl={markdownSanitizeUrl}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              {:else if item.kind === "assistant"}
                {@const displayContent = item.message.content.trim()}
                {#if displayContent && item.message.id !== settlingCommittedId}
                  <!-- Timestamp lives in the reading column's left margin (outside
                       the panel) so the assistant text lines up flush with
                       tool-call rows in both modes. The gutter room comes from the
                       reading column's auto-margins in editor mode and from the
                       pill column's horizontal inset in pill mode. The row root
                       opts out of content-visibility (which would clip the margin
                       stamp); the heavy markdown keeps it via .cv-msg-body. -->
                  <div
                    class="py-2 group/msg relative cv-stamp-host {skipMotion ||
                    finalizedStreamMessageIds[item.message.id]
                      ? ''
                      : 'animate-msg-in-side'}"
                    data-testid="assistant-message"
                  >
                    {#if !runtime.isMobileViewport}
                      <span
                        class="cv-stamp-gutter-left text-[0.625rem] text-(--solus-text-tertiary) tabular-nums select-none transition-opacity duration-100 {runtime.isTouchDevice
                          ? 'opacity-100'
                          : 'opacity-0 group-hover/msg:opacity-100'}"
                      >
                        {formatMessageTime(item.message.timestamp)}
                      </span>
                    {/if}
                    <div class="cv-msg-body">
                      {@render assistantBody(displayContent)}
                    </div>
                    {#if !runtime.isMobileViewport}
                      <div
                        class="absolute top-full right-0 -mt-1 z-10 transition-opacity duration-100 {runtime.isTouchDevice
                          ? 'opacity-100'
                          : 'opacity-0 group-hover/msg:opacity-100'}"
                      >
                        <CopyButton text={displayContent} />
                      </div>
                    {/if}
                  </div>
                {/if}
              {:else if item.kind === "tool-group"}
                <ToolGroupItem tools={item.messages} {skipMotion} />
              {:else if item.kind === "subagent-group"}
                <SubagentGroup messages={item.messages} {tabId} {skipMotion} />
              {:else if item.kind === "system"}
                {#if item.message.handoffDivider}
                  <div
                    class="flex items-center gap-2.5 py-2.5 {skipMotion ? '' : 'animate-msg-in-side'}"
                    data-testid="session-handoff-message"
                  >
                    <div class="h-px min-w-3 flex-1 bg-(--solus-tool-border)"></div>
                    <div class="flex max-w-[80%] min-w-0 items-center gap-1.5 rounded-full bg-(--solus-container-bg) px-2.5 py-1 text-center text-[0.6875rem] leading-4 text-pretty text-(--solus-text-tertiary) shadow-[0_0_0_1px_var(--solus-tool-border)]">
                      <ArrowsLeftRightIcon size={12} class="flex-shrink-0 text-(--solus-accent)" />
                      <span>{item.message.content}</span>
                    </div>
                    <div class="h-px min-w-3 flex-1 bg-(--solus-tool-border)"></div>
                  </div>
                {:else if item.message.forkSourceSessionId}
                  <div class="fork-divider" data-testid="fork-session-message">
                    <div class="fork-divider-line"></div>
                    <button
                      class="fork-divider-label"
                      onclick={() =>
                        navigateToSourceSession(
                          item.message.forkSourceSessionId!,
                        )}
                      title="Navigate to source session"
                    >
                      <GitForkIcon size={12} style="flex-shrink:0" />
                      <span>Forked from</span>
                      <span class="fork-divider-title"
                        >"{item.message.forkSourceTitle || "session"}"</span
                      >
                    </button>
                    <div class="fork-divider-line"></div>
                  </div>
                {:else if item.message.worktreeMovedTo}
                  <div
                    class="fork-divider"
                    data-testid="worktree-moved-message"
                  >
                    <div class="fork-divider-line"></div>
                    <div class="fork-divider-label">
                      <TreeStructureIcon size={12} style="flex-shrink:0" />
                      <span>Continued in worktree</span>
                      <span class="fork-divider-title"
                        >{item.message.worktreeMovedTo}</span
                      >
                    </div>
                    <div class="fork-divider-line"></div>
                  </div>
                {:else}
                  {@const isError =
                    item.message.content.startsWith("Error:") ||
                    item.message.content.includes("unexpectedly")}
                  <div class="py-0.5 {skipMotion ? '' : 'animate-msg-in-side'}">
                    <div
                      class="text-[0.6875rem] leading-[1.5] px-2.5 py-1 rounded-lg inline-block whitespace-pre-wrap {isError
                        ? 'bg-(--solus-status-error-bg) text-(--solus-status-error)'
                        : 'bg-(--solus-surface-hover) text-(--solus-text-tertiary)'}"
                    >
                      {item.message.content}
                    </div>
                  </div>
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
                      ? session.worksStore.streaming[
                          item.message.workRef.workId
                        ]
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
              {:else if item.kind === "session" && item.message.sessionRef}
                <SessionRefCard ref={item.message.sessionRef} {skipMotion} />
              {:else if item.kind === "artifact" && item.message.artifact}
                <ArtifactView artifact={item.message.artifact} {skipMotion} />
              {/if}
            {/each}
          </div>

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
              provider={sess.provider}
            />
          {/if}

          {#if sess.status === "rate_limited" && (sess.rateLimitStrategy === "ask" || sess.rateLimitStrategy === "queue")}
            <RateLimitCard tabId={tab.id} />
          {/if}
          {#each sess.serverQueuedPrompts as prompt (`server-queued-${prompt.queueId}`)}
            <UserMessageBubble
              content={prompt.text}
              attachments={prompt.images?.map((img) => ({
                name: "",
                dataUrl: img.dataUrl,
                mimeType: img.mimeType,
                type: "image" as const,
              }))}
              queued
              queueId={prompt.queueId}
              onCancel={(queueId) =>
                window.solus
                  .cancelQueuedPrompt(session.ctxFor(tabId), queueId)
                  .catch((err: Error) =>
                    session.handleError(tabId, {
                      message: err.message,
                      stderrTail: [],
                      exitCode: null,
                      elapsedMs: 0,
                      toolCallCount: 0,
                    }),
                  )}
            />
          {/each}

          <div class="min-h-[6.25rem]"></div>
        </div>
      </div>

      {#if isEditorShell}
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
          style="bottom:{isEditorMode
            ? 3
            : 16}px;height:2rem;z-index:7"
        >
          <div
            bind:clientWidth={activityReservedWidth}
            class="flex items-center gap-1.5 text-[0.6875rem] pointer-events-auto"
            class:pl-4={isEditorMode}
            class:pr-2={isEditorMode}
          >
            {#if isRunning}
              <span class="flex items-center gap-1.5">
                <span class="flex gap-0.75">
                  <span
                    class="w-1.25 h-[0.3125rem] rounded-full animate-breathing bg-(--solus-status-running)"
                    style="animation-delay:0ms"
                  ></span>
                  <span
                    class="w-[0.3125rem] h-[0.3125rem] rounded-full animate-breathing bg-(--solus-status-running)"
                    style="animation-delay:250ms"
                  ></span>
                  <span
                    class="w-[0.3125rem] h-[0.3125rem] rounded-full animate-breathing bg-(--solus-status-running)"
                    style="animation-delay:500ms"
                  ></span>
                </span>
                <span class="text-(--solus-text-tertiary)"
                  >{currentActivity || "Running..."}</span
                >
              </span>
            {:else if isAwaitingPlan}
              <span class="flex items-center gap-1.5">
                <ClipboardTextIcon
                  size={11}
                  weight="bold"
                  style="color:var(--solus-status-running)"
                />
                <span class="text-(--solus-text-tertiary)"
                  >Waiting for plan approval</span
                >
              </span>
            {:else if isDead}
              <span class="text-(--solus-status-error)"
                >Session ended unexpectedly</span
              >
              <button
                onclick={handleRetry}
                class="flex items-center gap-1 rounded-full px-2 py-0.5 transition-colors text-(--solus-accent)"
              >
                <ArrowCounterClockwiseIcon size={10} />Retry
              </button>
            {:else if isFailed}
              <span class="text-(--solus-status-error)">Failed</span>
              <button
                onclick={handleRetry}
                class="flex items-center gap-1 rounded-full px-2 py-0.5 transition-colors text-(--solus-accent)"
              >
                <ArrowCounterClockwiseIcon size={10} />Retry
              </button>
            {:else if isInterrupted}
              <span class="text-(--solus-text-tertiary)">Interrupted</span>
              <button
                onclick={handleRetry}
                class="flex items-center gap-1 rounded-full px-2 py-0.5 transition-colors text-(--solus-accent)"
              >
                <ArrowCounterClockwiseIcon size={10} />Retry
              </button>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  </div>
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

  /* Pill mode has no centered reading column, so it carves a small horizontal
     inset on the message column to host the absolutely-positioned timestamp
     gutters (assistant on the left, user on the right) — the same stamp markup
     editor mode uses, just with locally-provided gutter room. */
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

  /* Assistant rows whose timestamp sits in the column margin must opt out of
     content-visibility on the row itself — paint containment would clip the
     out-of-box stamp. The off-screen optimization moves to .cv-msg-body, which
     holds the heavy markdown, so resize perf is preserved. */
  .cv-list > :global(.cv-stamp-host) {
    content-visibility: visible;
    contain-intrinsic-size: auto;
  }

  .cv-msg-body {
    content-visibility: auto;
    contain-intrinsic-size: auto 3rem;
  }

  /* Timestamp lives in the reading column's left margin (outside the panel) so
     the assistant text's accent border lines up flush with tool-call rows at the
     panel's left edge. right:100% anchors its right edge to the panel edge and it
     extends left into the gutter. Editor mode only; pill keeps the inline stamp. */
  .cv-stamp-gutter-left {
    position: absolute;
    right: 100%;
    /* Anchored to the last text line's baseline: row py-2 bottom padding (0.5rem)
       + paragraph bottom margin (~0.42rem) + the line's leading/descent (~0.5rem).
       line-height:1 keeps the stamp's own baseline predictable. Tuned for messages
       ending in a paragraph. */
    bottom: 1.3125rem;
    margin-right: 0.375rem;
    line-height: 1;
    white-space: nowrap;
  }

  .fork-divider {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.625rem 0;
  }

  .fork-divider-line {
    flex: 1;
    height: 0.0625rem;
    background: var(--solus-tool-border);
  }

  .fork-divider-label {
    display: flex;
    align-items: center;
    gap: 0.3125rem;
    flex-shrink: 0;
    color: var(--solus-text-tertiary);
    font-size: 0.6875rem;
    background: transparent;
    border: none;
    padding: 0.1875rem 0.5rem;
    border-radius: 1.25rem;
    cursor: pointer;
    transition:
      background 0.15s ease,
      color 0.15s ease;
    line-height: 1.4;
  }

  .fork-divider-label:hover,
  .fork-divider-label:active {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }

  .fork-divider-label:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.125rem;
  }

  .fork-divider-title {
    color: var(--solus-accent);
    max-width: 12.5rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: inline-block;
    vertical-align: bottom;
  }
</style>
