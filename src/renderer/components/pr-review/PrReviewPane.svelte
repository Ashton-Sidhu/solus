<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import {
    ArrowsClockwiseIcon,
    ArrowsInIcon,
    ArrowsOutIcon,
    ChatCircleIcon,
    XIcon,
  } from "phosphor-svelte";
  import type { PrReviewContext, IpcContext } from "../../../shared/types";
  import { worktreeProjectRoot } from "../../../shared/types";
  import type { DraftReview } from "../../../shared/providers";
  import type { GuideDiffCommentSave } from "./guide/lib/guide-data";
  import {
    getWorkspaceContext,
    getSettingsContext,
    getAgentContext,
  } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import { resolveReviewAgent } from "../../lib/reviewAgent";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { serverConnections } from "@client-core/server-connections";
  import { useKeybinding, useScope } from "../../lib/keybindings/use-keybinding.svelte";
  import GuideSurface from "../review/GuideSurface.svelte";
  import { GuideLoader } from "../review/lib/guide-loader.svelte";
  import DiffPanel from "../diff/DiffPanel.svelte";
  import ActivityFeed from "./ActivityFeed.svelte";
  import type { PrActivityTarget } from "./lib/activity-data";
  import PendingReviewTray from "./PendingReviewTray.svelte";
  import SubmitReviewModal from "./SubmitReviewModal.svelte";
  import SinceReviewBar from "./SinceReviewBar.svelte";
  import { prReviewState } from "./lib/pr-review.store.svelte";
  import PrDetailChrome from "./PrDetailChrome.svelte";
  import PrDetailMasthead from "./PrDetailMasthead.svelte";
  import { ListHintBand } from "../ui/list-page";
  import * as TooltipUI from "@renderer/components/ui/tooltip";
  import { Button } from "../ui/button";
  import FrameExpandButton from "../layout/FrameExpandButton.svelte";
  import PrChecksChip from "../prs/PrChecksChip.svelte";
  import StackDiffBanner from "./StackDiffBanner.svelte";
  import {
    beginPrReviewProfile,
    markPrReviewProfile,
  } from "./lib/pr-review-profiler";

  // The review surface (M3–M5): Activity · Guide · Diff content tabs over a PR's
  // change, living maximized in the secondary pane. The "Chat" button lazily
  // creates a worktree-rooted conversation and pops it out alongside the review.
  //
  // The surface mounts the moment a PR is clicked, before its worktree has been
  // fetched and checked out: `pr` is null until then, and everything that reads
  // the checkout — the stack, the guide, the diff, the interdiff, chat — waits
  // for it. Activity does not: it is provider-backed, so it renders from
  // `target` against `targetCtx` and is usually filled from PrsStore's prefetch
  // by first paint. One mounted component across both phases is what keeps the
  // open to a single page filling in rather than a placeholder swap.
  let {
    pr,
    target,
    targetCtx = null,
    chatTabId = null,
    onToggleMaximize,
    maximized = false,
    activeTab,
    onActiveTabChange,
    headless = false,
    guideEnabled = true,
    onUnresolvedCountChange,
  }: {
    pr: PrReviewContext | null;
    /** PR identity, known from the click; `pr` once the worktree exists. */
    target: PrActivityTarget;
    /** Project context for the provider reads made before the worktree exists. */
    targetCtx?: IpcContext | null;
    chatTabId?: string | null;
    onToggleMaximize?: () => void;
    maximized?: boolean;
    activeTab?: ContentTab;
    onActiveTabChange?: (tab: ContentTab) => void;
    headless?: boolean;
    guideEnabled?: boolean;
    onUnresolvedCountChange?: (count: number) => void;
  } = $props();

  const session = getWorkspaceContext();
  const settings = getSettingsContext();
  const agentContext = getAgentContext();
  const stacks = session.stacksStore;

  onMount(() => {
    beginPrReviewProfile(target.number);
    markPrReviewProfile("review-pane-mounted");
    requestAnimationFrame(() => markPrReviewProfile("review-pane-first-paint"));
  });
  let activeChatTabId = $state<string | null>(null);
  let openingChat = $state(false);
  $effect(() => {
    activeChatTabId = chatTabId;
  });
  // Review data belongs to the checked-out PR worktree, not to whichever chat
  // happens to be attached. Only a different review worktree changes this
  // context, so revealing Chat cannot invalidate the cached domain state. Both
  // contexts key PrsStore's caches by project root, so the reads made while the
  // worktree is still checking out stay warm once it lands.
  const reviewContext = $derived.by(() =>
    pr
      ? session.ctxForDirectory(worktreeProjectRoot(pr.worktreePath))
      : (targetCtx ?? session.ctx),
  );
  const prCtx = () => reviewContext;
  // Sibling pull requests live in the *project*, not in this PR's worktree, so
  // stepping to one must resolve against the project scope the review was
  // opened from — `targetCtx` — rather than the checkout it is showing.
  const projectCtx = () => targetCtx ?? session.ctx;
  // DiffPanel still needs a tab id for its reusable session-oriented plumbing,
  // but this embedded PR diff is owned by the review worktree. Keep the id
  // stable for the lifetime of the review so attaching Chat cannot reset the
  // diff state, refresh turn snapshots, or subscribe it to a new transcript.
  const reviewTabId = untrack(() => activeChatTabId ?? session.activeTabId);

  // Everything about *this pull request's review* — threads, drafts, interdiff,
  // diff base — belongs to the PR, not to this component: the popped-out diff is
  // a second pane over the same review, and two `ReviewDrafts` over one
  // review-state file would silently diverge. See pr-review.store.
  const review = $derived(
    prReviewState(target.number, {
      fallbackCtx: () => targetCtx ?? session.ctx,
      ctxForDirectory: (path) => session.ctxForDirectory(path),
      stackedPrsEnabled: () => settings.stackedPrsEnabled,
      resolveDiffBase: (number, baseRef) => stacks.resolveDiffBase(number, baseRef),
      loadStacks: (ctx) => stacks.load(ctx),
      loadThreads: (ctx, number, force) =>
        session.prsStore.loadThreads(ctx, number, { force }),
      loadInterdiff: (ctx, target, force) =>
        session.prsStore.loadInterdiff(ctx, target, { force }),
      diffStats: (ctx, scope) => window.solus.diffStats(ctx, { scope }).then((f) => f.length),
      replyThread: (ctx, number, threadId, body) =>
        window.solus.prReplyThread(ctx, number, threadId, body),
      resolveThread: async (ctx, number, threadId, resolved) => {
        if (resolved) await window.solus.prResolveThread(ctx, number, threadId);
        else await window.solus.prUnresolveThread(ctx, number, threadId);
      },
    }),
  );

  // The resolved worktree arrives after the surface mounts; hand it to the state
  // so everything gated on the checkout unblocks at once.
  $effect(() => {
    review.pr = pr;
  });

  $effect(() => {
    void review.pr?.number;
    untrack(() => review.loadStack());
  });

  const effectiveGuideKey = $derived(review.effectiveGuideKey);
  const ownDeltaBase = $derived(review.ownDeltaBase);
  const showingFullDiff = $derived(review.showingFullDiff);

  $effect(() => {
    if (review.liveDiffBase.kind === "target") review.showingFullDiff = false;
  });

  // The guide tab's data layer. This host renders its own chrome (header +
  // regenerate), so it drives the loader directly rather than through a child.
  const guideLoader = new GuideLoader({
    getCtx: prCtx,
    getKey: () => effectiveGuideKey,
    getScope: () => "branch",
    getOwnDeltaBase: () => ownDeltaBase,
    getAgent: () => resolveReviewAgent(settings, agentContext),
  });
  const guideStatus = $derived(session.prsStore.guideStatusFor(target.number));
  // Follow generation progress for the whole time this review is open, not just
  // around the loader's own call — the Generate button queues the work in the
  // background, and its progress is what fills the stepped screen.
  $effect(() => guideLoader.trackProgress());
  $effect(() => {
    void effectiveGuideKey;
    if (!guideEnabled || !review.stackReady || showingFullDiff) return;
    const backgroundStatus = untrack(() =>
      session.prsStore.guideStatusFor(target.number),
    );
    if (backgroundStatus === "queued" || backgroundStatus === "generating") return;
    const generateIfMissing = settings.generatePrGuidesOnOpen;
    void untrack(() => guideLoader.load(false, generateIfMissing));
  });

  // A background "Generate guide" (Activity header / PRs page) finishing while
  // this pane sits on the empty or stale Guide state: pick up the cached guide.
  // Remember the ready transition we consumed so an old ready status plus a
  // stale cached guide cannot create a reload loop after the PR head moves.
  let handledReadyKey: string | null = null;
  $effect(() => {
    const readyKey =
      guideStatus === "ready" && pr
        ? `${pr.number}:${pr.headSha}:${effectiveGuideKey}`
        : null;
    if (!readyKey) {
      handledReadyKey = null;
      return;
    }
    if (
      handledReadyKey === readyKey ||
      !review.stackReady ||
      showingFullDiff ||
      guideLoader.loading ||
      (guideLoader.guide && !guideLoader.stale)
    ) {
      return;
    }
    handledReadyKey = readyKey;
    void untrack(() => guideLoader.load(false, false));
  });

  // Size of the change, for the Guide empty state's "what will this cost me"
  // line. `loadChangedFiles` is the same cached call the Activity tab makes, so
  // opening on Guide doesn't add a request.
  let changedFileCount = $state<number | null>(null);
  $effect(() => {
    const number = target.number;
    changedFileCount = null;
    const ctx = untrack(prCtx);
    void session.prsStore
      .loadChangedFiles(ctx, number)
      .then((files) => {
        if (target.number === number) changedFileCount = files.length;
      })
      .catch(() => {});
  });
  const guideEmptyHint = $derived.by(() => {
    const count = changedFileCount;
    if (count === null) return undefined;
    const files = `${count} ${count === 1 ? "file" : "files"} changed`;
    return count > 20
      ? `${files} · a minute or two for a change this size`
      : `${files} · usually under a minute`;
  });
  function generateGuide() {
    void session.prsStore
      .requestGuides(prCtx(), [target.number], {
        onSettled: ({ failed }) => {
          if (failed > 0) {
            toasts.error(
              `Review guide generation failed for PR #${target.number}. Try again from Activity or Guide.`,
            );
          } else {
            toasts.success(
              `Review guide for PR #${target.number} is ready in the Guide tab.`,
            );
          }
        },
      })
      .catch((error) => {
        toasts.error(
          `Couldn't queue the review guide: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    requestInputFocus();
  }

  // The active content tab lives in the PR store so chrome outside this
  // component can react to it (see PrsStore.prReviewTab).
  type ContentTab = "activity" | "guide" | "diff";
  // Guide and Diff both read the worktree, so the pending phase can only be on
  // Activity — a stored selection of either is honoured once `pr` arrives.
  const sub = $derived(
    pr ? (activeTab ?? session.prsStore.prReviewTab) : "activity",
  );

  const diffScope = $derived(review.diffScope);

  $effect(() => {
    void review.ownDeltaBase?.headSha;
    untrack(() => review.loadOwnDeltaFileCount());
  });

  // Threads, the interdiff and the draft comments all live on the shared review
  // state — the popped-out diff is another pane over this same review.
  const reviewThreads = $derived(review.threads);
  const threadsLoadFailed = $derived(review.threadsLoadFailed);
  function loadThreads(force = false) {
    review.loadThreads(force);
  }
  // Provider-backed, so this runs during the pending phase too — the threads are
  // part of the Activity timeline, not of the worktree.
  $effect(() => {
    void target.number;
    untrack(() => loadThreads());
  });
  $effect(() => {
    markPrReviewProfile("threads-ready", { count: review.threads.length });
  });
  $effect(() => {
    onUnresolvedCountChange?.(review.unresolvedCount);
  });

  function loadInterdiff(force = false) {
    review.loadInterdiff(force);
  }

  $effect(() => {
    void review.pr?.number;
    void review.pr?.baseSha;
    void review.pr?.headSha;
    untrack(() => loadInterdiff());
  });

  const interdiff = $derived(review.interdiff);
  const hasReviewCheckpointNotice = $derived(review.hasReviewCheckpointNotice);
  const isSinceReviewMode = $derived(review.isSinceReviewMode);
  const sinceReviewThreads = $derived(review.sinceReviewThreads);

  $effect(() => {
    const currentNumber = target.number;
    const prCwd = pr?.worktreePath;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = serverConnections.eventsFor().subscribe('prs.invalidated', ({ projectRoot: changedCwd }) => {
      const paneCtx = prCtx();
      const ctxCwd = paneCtx.session.projectPath || paneCtx.session.workingDirectory;
      if (changedCwd !== ctxCwd && changedCwd !== prCwd) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (target.number !== currentNumber) return;
        loadThreads(true);
        activityFeedRef?.refresh();
      }, 500);
    });
    return () => {
      unsub();
      clearTimeout(timer);
    };
  });

  // Reply / resolve for the threads rendered inline in the Diff tab. Mirrors the
  // Activity tab's affordances; mutation of the thread object lives in
  // DiffThreadComment so the inline card and the popover update in place.
  const replyToThread = (threadId: string, body: string) =>
    review.replyToThread(threadId, body);
  const resolveThread = (threadId: string, resolved: boolean) =>
    review.resolveThread(threadId, resolved);

  // GitHub-bound draft comments, persisted per guide key (shared store with the
  // local review guide surface, where drafts become agent feedback instead).
  $effect(() => {
    void effectiveGuideKey;
    void review.stackReady;
    untrack(() => review.loadDrafts());
  });

  const drafts = $derived(review.drafts.drafts);
  const diffComments = $derived(review.drafts.diffComments);
  const saveDiffComment = (c: GuideDiffCommentSave) => review.drafts.save(c);
  const removeDraft = (id: string) => review.drafts.remove(id);

  let showSubmit = $state(false);
  let activityFeedRef: ActivityFeed | null = $state(null);
  // Owned here so a typed summary survives closing/reopening the submit modal.
  let submitEvent = $state<DraftReview["event"]>("COMMENT");
  let submitBody = $state("");

  // A submitted review creates threads and flips the viewer's review state —
  // reload so the result is visible without a manual refresh. The feed's
  // refresh() covers detail/reviewers and re-triggers loadThreads; when the
  // Activity tab was never mounted, reload the shared threads directly.
  function onReviewSubmitted() {
    review.drafts.clear();
    loadInterdiff(true);
    if (activityFeedRef) activityFeedRef.refresh();
    else loadThreads(true);
  }

  useScope("pr-review", { active: () => !headless });
  useKeybinding(
    "pr-review.approve",
    () => {
      submitEvent = "APPROVE";
      showSubmit = true;
    },
    { enabled: () => !headless && !showSubmit && !!pr },
  );

  // Keep each visited tab mounted (DiffState / scroll / derived chains survive
  // toggles) and hide the inactive ones via display:none, per the Svelte perf rule.
  // Mount whichever tab we open on (Activity by default) so it renders without a
  // blank frame; the others mount lazily on first visit.
  let mountedGuide = $state(untrack(() => sub === "guide"));
  let mountedDiff = $state(untrack(() => sub === "diff"));
  let mountedActivity = $state(untrack(() => sub === "activity"));
  $effect(() => {
    if (sub === "guide") mountedGuide = true;
    else if (sub === "diff") mountedDiff = true;
    else if (sub === "activity") mountedActivity = true;
  });

  const TABS: { id: ContentTab; label: string }[] = [
    { id: "activity", label: "Activity" },
    { id: "guide", label: "Guide" },
    { id: "diff", label: "Diff" },
  ];

  // The diff is a pane, not a tab. Reading a change is a two-handed job — the
  // conversation on one side, the code on the other — so Diff pops out beside
  // the review rather than replacing what you were reading. Review Mode
  // (headless) has no pane to pop into and keeps the diff inline.
  const diffPoppedOut = $derived(
    !headless && session.router.params("prDiff")?.number === target.number,
  );

  /** Put the left column on Activity — the conversation that belongs beside an
   *  open diff. */
  function showActivityColumn() {
    if (activeTab === undefined) session.prsStore.prReviewTab = "activity";
    onActiveTabChange?.("activity");
    mountedActivity = true;
  }

  // A row whose verb was "Review" lands on the diff: honour that by popping it
  // out, with Activity behind it.
  $effect(() => {
    if (headless || session.prsStore.prReviewTab !== "diff" || !pr) return;
    untrack(() => {
      showActivityColumn();
      session.openPrDiff(target.number, prCtx());
    });
  });

  function select(next: ContentTab) {
    if (next === "guide" && showingFullDiff) return;
    if (next === "diff" && !headless) {
      if (diffPoppedOut) {
        session.closePrDiff();
      } else {
        // Reading a diff is a two-handed job: the change on the right, the
        // conversation about it on the left. Landing on the guide's empty state
        // beside a diff is the one pairing that says nothing, so opening the
        // change brings Activity with it.
        showActivityColumn();
        session.openPrDiff(target.number, prCtx());
      }
      requestInputFocus();
      return;
    }
    if (activeTab === undefined) session.prsStore.prReviewTab = next;
    onActiveTabChange?.(next);
    requestInputFocus();
  }

  function toggleFullDiff() {
    review.showingFullDiff = !review.showingFullDiff;
    if (headless) {
      if (activeTab === undefined) session.prsStore.prReviewTab = "diff";
      onActiveTabChange?.("diff");
      mountedDiff = true;
    } else {
      showActivityColumn();
      session.openPrDiff(target.number, prCtx());
    }
    requestInputFocus();
  }

  // File chips in the Guide / threads in Activity open the change beside the
  // review and scroll it to the file, so the explanation stays on screen.
  let diffPanelRef: DiffPanel | null = $state(null);

  function jumpToDiff(path?: string, line?: number | null, side: "old" | "new" = "new") {
    if (!headless) {
      // A jump from the guide keeps the guide: you asked to see one file while
      // reading the narrative, not to leave it.
      session.openPrDiff(target.number, prCtx());
      // Usually asked for in the same tick the pane is opened, so the request is
      // parked on the shared state and consumed once the pane mounts.
      if (path) review.requestJump(path, line, side);
      requestInputFocus();
      return;
    }
    if (activeTab === undefined) session.prsStore.prReviewTab = "diff";
    onActiveTabChange?.("diff");
    mountedDiff = true;
    if (path) {
      // First visit mounts the panel on this tick; navigate once it exists.
      void tick().then(() => diffPanelRef?.navigateTo(path, line ?? undefined, side));
    }
    requestInputFocus();
  }

  // Chat changes only the primary pane. The review stays mounted in secondary;
  // openPrReviewChat reveals the conversation and restores the split geometry.
  async function openChat() {
    const review = pr;
    if (!review || openingChat) return;
    openingChat = true;
    try {
      activeChatTabId = await session.openPrReviewChat(review, activeChatTabId);
    } finally {
      openingChat = false;
    }
    requestInputFocus();
  }

  function exit() {
    session.exitPrReview();
    requestInputFocus();
  }

  // Built from the review context rather than `target`, whose host/owner/repo
  // are only populated once detail lands — the Activity tab owns the link that
  // covers the pending phase.
  const prUrl = $derived(
    pr ? `https://${pr.host}/${pr.owner}/${pr.repo}/pull/${pr.number}` : null,
  );

  function openPr() {
    if (prUrl) void window.solus.openExternal(prUrl);
  }

  // Esc is the only way out, and J / K walk the queue. All three skip while a
  // comment/text field is focused (it owns its own keys) or the submit modal is
  // up (it owns Esc).
  function onWindowKeydown(e: KeyboardEvent) {
    if (headless || e.defaultPrevented || showSubmit) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const el = e.target as HTMLElement | null;
    if (el && (el.isContentEditable || el.closest("input, textarea"))) return;
    if (e.key === "Escape") {
      e.preventDefault();
      exit();
    } else if (e.key === "j" || e.key === "J") {
      e.preventDefault();
      session.stepPrReview(1, projectCtx());
    } else if (e.key === "k" || e.key === "K") {
      e.preventDefault();
      session.stepPrReview(-1, projectCtx());
    }
  }

  // What the keyboard does here — the same footer band the list uses, so the
  // two read as one surface.
  const hints = $derived([
    { key: "J K", label: "next / previous PR" },
    { key: "⏎", label: "merge" },
    { key: "C", label: "comment" },
    { key: "Esc", label: "back to list" },
  ]);
  // The pill agrees with the list's own grouping rather than inventing a second
  // vocabulary — a row filed under "Awaiting your review" says so here too.
  const summary = $derived(session.prsStore.get(target.number));
  const statusKey = $derived.by(() => {
    const item = summary;
    if (!item) return "open";
    if (item.state === "merged") return "merged";
    if (item.state === "closed") return "closed";
    if (item.draft) return "draft";
    if (item.needsMyReview) return "review";
    return "open";
  });

  const position = $derived(session.prsStore.listOrder.indexOf(target.number) + 1);
  const footCount = $derived(
    position > 0
      ? `#${target.number} · ${position} of ${session.prsStore.listOrder.length}`
      : `#${target.number}`,
  );
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#snippet detailMasthead()}
  <PrDetailMasthead
    status={statusKey}
    headRef={pr?.headRef ?? summary?.headRef}
    baseRef={pr?.baseRef ?? summary?.baseRef}
    tab={sub === "guide" ? "guide" : "activity"}
    diffOpen={diffPoppedOut}
    guideDisabled={showingFullDiff}
    guideDisabledReason="Guides cover the stacked view"
    tabsDisabled={!pr}
    onSelect={select}
  />
{/snippet}

<section class="flex h-full min-h-0 flex-col bg-background">
  {#if !headless}
    <!-- One chrome band: the way back, the way sideways, and where you are.
         The tabs have moved down into the masthead where they belong to the
         content; what stays up here is navigation and the pane controls that
         PaneChrome floats for every other surface, consolidated so this review
         reads as a single header row.
         No rule beneath it, and no centred measure: the bar spans the pane's
         full width with the same leading gutter as the diff toolbar while the
         trailing controls reach the pane's right edge. -->
    <!-- Same height and seam as every other chrome row in the app (the diff
         toolbar beside it, the conversation's own strip), so the two panes'
         headers share one baseline. -->
    <div
      class="@container h-(--solus-chrome-row-h,2.5rem) shrink-0 border-b border-[var(--hairline)]"
    >
      <div
        class="flex h-full w-full items-center justify-between gap-2 pr-3.5 pl-[max(1rem,var(--solus-chrome-lead-inset,0px))]"
      >
        <div class="flex min-w-0 flex-1 items-center">
          <PrDetailChrome number={target.number} {projectCtx} onExit={exit} />
        </div>

        <!-- Pane controls, pill-shaped and quiet: the band's only ink is the
             breadcrumb, so these read as affordances rather than a toolbar. -->
        <div class="flex shrink-0 items-center gap-0.5">
          <PrChecksChip
            summary={session.prsStore.checksFor(target.number)}
            headSha={pr?.headSha ?? target.headSha ?? ""}
            loadFailed={session.prsStore.checksLoadFailed}
            pill
          />

          <Button
            type="button"
            variant="ghost"
            size="xs"
            class={`relative ml-1 h-[26px] gap-1.5 rounded-full border border-transparent px-2.5 text-[12px] font-normal transition-colors after:absolute after:h-10 after:w-full ${activeChatTabId ? "bg-secondary text-secondary-foreground" : "bg-transparent text-muted-foreground hover:bg-[var(--wash-2)] hover:text-foreground"}`}
            onclick={openChat}
            disabled={openingChat || !pr}
            title={!pr
              ? "Checking out this PR's worktree…"
              : activeChatTabId
                ? "Focus agent chat"
                : "Open agent chat"}
          >
            <ChatCircleIcon size={13} />
            Ask about this PR
          </Button>

          {#if sub === "guide" && !showingFullDiff}
            <Button
              type="button"
              variant="ghost"
              class="flex size-[26px] shrink-0 items-center justify-center rounded-full border-0 bg-transparent p-0 text-muted-foreground transition-colors hover:bg-[var(--wash-2)] hover:text-foreground"
              aria-label="Regenerate review guide"
              title="Regenerate review"
              onclick={() => guideLoader.refresh()}
            >
              <ArrowsClockwiseIcon size={13} />
            </Button>
          {/if}

          <FrameExpandButton variant="projectPanel" size="header" />

          {#if onToggleMaximize}
            <TooltipUI.Root>
              <TooltipUI.Trigger>
                {#snippet child({ props })}
                  <button
                    {...props}
                    type="button"
                    class="flex size-[26px] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-muted-foreground transition-colors hover:bg-[var(--wash-2)] hover:text-foreground"
                    onclick={onToggleMaximize}
                    aria-label={maximized ? "Restore panel size" : "Maximize panel"}
                  >
                    {#if maximized}
                      <ArrowsInIcon size={13} />
                    {:else}
                      <ArrowsOutIcon size={13} />
                    {/if}
                  </button>
                {/snippet}
              </TooltipUI.Trigger>
              <TooltipUI.Content
                value={maximized ? "Restore panel (⌥M)" : "Maximize (⌥M)"}
              />
            </TooltipUI.Root>
          {/if}

          <button
            type="button"
            class="flex size-[26px] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-muted-foreground transition-colors hover:bg-[var(--wash-2)] hover:text-foreground"
            onclick={exit}
            aria-label="Exit PR review"
          >
            <XIcon size={13} />
          </button>
        </div>
      </div>
    </div>
  {/if}

  <div class="relative min-h-0 flex-1">
    <!-- Both of these read the checked-out worktree, so neither can be reached
         before `pr` lands — their tabs are disabled until then. -->
    {#if mountedGuide && pr}
      <div
        class="absolute inset-0 flex flex-col"
        class:hidden={sub !== "guide"}
      >
        {#if !guideEnabled}
          <div class="grid h-full place-items-center px-8 text-center">
            <div class="max-w-sm">
              <p class="text-[13px] font-medium">Guide skipped for this quick review</p>
              <p class="mt-1.5 text-pretty text-[12.5px] leading-[1.6] text-muted-foreground">
                The complete diff is ready in view 3. Activity and Diff remain fully available.
              </p>
            </div>
          </div>
        {:else}
          <!-- The guide reads full width: it is a narrative about the whole
               change, not a column beside a rail. The masthead rides above it
               so the same row appears whichever tab is showing. -->
          {#if !headless}
            <!-- Match GuideView's measure and asymmetric reading gutters so
                 the status/refs begin on the title's left edge and the tabs
                 end on the guide content's right edge. -->
            <div
              class="mx-auto w-full max-w-[92rem] pt-[clamp(20px,1.8vw,32px)] pr-8 pl-14 2xl:max-w-[104rem]"
            >
              {@render detailMasthead()}
            </div>
          {/if}
          {#if ownDeltaBase}
            <StackDiffBanner
              parent={ownDeltaBase.parent}
              fileCount={review.ownDeltaFileCount}
              showingFull={false}
              onToggle={toggleFullDiff}
            />
          {/if}
          <GuideSurface
            loader={guideLoader}
            onFileJump={jumpToDiff}
            comments={diffComments}
            onCommentSave={saveDiffComment}
            onCommentDelete={removeDraft}
            meta={{ repo: pr.repo, number: pr.number, baseRef: pr.baseRef, branch: pr.headRef }}
            emptyHint={guideEmptyHint}
            generationStatus={guideStatus}
            onGenerate={generateGuide}
            onAlwaysGenerate={settings.generatePrGuidesOnOpen
              ? undefined
              : () => {
                  settings.update({ generatePrGuidesOnOpen: true });
                  generateGuide();
                }}
          />
        {/if}
      </div>
    {/if}
    {#if mountedDiff && pr}
      <div class="absolute inset-0 flex flex-col" class:hidden={sub !== "diff"}>
        {#if ownDeltaBase}
          <StackDiffBanner
            parent={ownDeltaBase.parent}
            fileCount={review.ownDeltaFileCount}
            showingFull={showingFullDiff}
            onToggle={toggleFullDiff}
          />
        {/if}
        {#if !ownDeltaBase && hasReviewCheckpointNotice && interdiff}
          <SinceReviewBar
            result={interdiff}
            showingSince={isSinceReviewMode}
            onModeChange={(sinceReview) => {
              review.showingSinceReview = sinceReview;
              requestInputFocus();
            }}
          />
        {/if}
        <div class="min-h-0 flex-1">
          <DiffPanel
            bind:this={diffPanelRef}
            tabId={reviewTabId}
            getCtx={prCtx}
            projectPath={pr.worktreePath}
            worktreePath={pr.worktreePath}
            worktreeBranch={pr.headRef}
            targetBranch={pr.baseRef}
            isWorktree
            onClose={() => select(showingFullDiff ? "activity" : "guide")}
            embedded
            onToggleMaximize={onToggleMaximize}
            initialScope={diffScope}
            patchOverride={isSinceReviewMode ? (interdiff?.patch ?? "") : null}
            emptyState={isSinceReviewMode
              ? {
                  title: "No patch changes since your review",
                  description: "The PR head moved, but its effective patch stayed the same.",
                }
              : undefined}
            externalComments={diffComments}
            onExternalCommentSave={saveDiffComment}
            onExternalCommentDelete={removeDraft}
            reviewThreads={isSinceReviewMode ? sinceReviewThreads : reviewThreads}
            onThreadReply={replyToThread}
            onThreadResolve={resolveThread}
          />
        </div>
      </div>
    {/if}
    {#if mountedActivity}
      <div class="absolute inset-0" class:hidden={sub !== "activity"}>
        <ActivityFeed
          bind:this={activityFeedRef}
          pr={target}
          threads={reviewThreads}
          threadsFailed={threadsLoadFailed}
          getCtx={prCtx}
          addressCommentsReady={!!pr}
          onAddressComments={async () => {
            if (pr) await session.startPrCommentsFixSession(pr);
          }}
          onRefreshThreads={() => loadThreads(true)}
          onJump={jumpToDiff}
          masthead={headless ? undefined : detailMasthead}
        />
      </div>
    {/if}
  </div>

  {#if !headless}
    <ListHintBand {hints} count={footCount} fullWidth />
  {/if}

  {#if drafts.length > 0}
    <PendingReviewTray
      {drafts}
      onSubmit={() => (showSubmit = true)}
      onRemove={removeDraft}
      onJump={jumpToDiff}
    />
  {/if}
</section>

{#if showSubmit && pr}
  <SubmitReviewModal
    {pr}
    {drafts}
    getCtx={prCtx}
    bind:event={submitEvent}
    bind:body={submitBody}
    onClose={() => (showSubmit = false)}
    onSubmitted={onReviewSubmitted}
  />
{/if}
