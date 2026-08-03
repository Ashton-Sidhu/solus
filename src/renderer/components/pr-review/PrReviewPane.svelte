<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import {
    ArrowsClockwiseIcon,
    ArrowsInIcon,
    ArrowsOutIcon,
    ChatCircleIcon,
    XIcon,
  } from "phosphor-svelte";
  import type {
    PrReviewContext,
    DiffScope,
    IpcContext,
    PrInterdiffResult,
  } from "../../../shared/types";
  import { worktreeProjectRoot } from "../../../shared/types";
  import type { DiffBase } from "../../../shared/stack-types";
  import { reviewGuideKeyForBase } from "../../../shared/review";
  import type { DraftReview, ReviewThread } from "../../../shared/providers";
  import type { GuideDiffCommentSave } from "./guide/lib/guide-data";
  import {
    getWorkspaceContext,
    getSettingsContext,
    getAgentContext,
    toasts,
  } from "../../contexts";
  import { resolveReviewAgent } from "../../lib/reviewAgent";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { serverConnections } from "@client-core/server-connections";
  import { useKeybinding, useScope } from "../../lib/keybindings/use-keybinding.svelte";
  import GuideSurface from "../review/GuideSurface.svelte";
  import { GuideLoader } from "../review/lib/guide-loader.svelte";
  import { ReviewDrafts } from "../review/lib/review-drafts.svelte";
  import DiffPanel from "../diff/DiffPanel.svelte";
  import ActivityFeed from "./ActivityFeed.svelte";
  import type { PrActivityTarget } from "./lib/activity-data";
  import PendingReviewTray from "./PendingReviewTray.svelte";
  import SubmitReviewModal from "./SubmitReviewModal.svelte";
  import SinceReviewBar from "./SinceReviewBar.svelte";
  import { matchedReviewComments } from "./lib/since-review";
  import { interdiffReviewThreads } from "../diff/lib/interdiff-annotations";
  import * as Tabs from "../ui/tabs";
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
    onToggleSecondaryMaximize,
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
    onToggleSecondaryMaximize?: () => void;
    activeTab?: ContentTab;
    onActiveTabChange?: (tab: ContentTab) => void;
    headless?: boolean;
    guideEnabled?: boolean;
    onUnresolvedCountChange?: (count: number) => void;
  } = $props();

  const session = getWorkspaceContext();
  const settings = getSettingsContext();
  const agentContext = getAgentContext();
  const panes = session.panes;
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
  // DiffPanel still needs a tab id for its reusable session-oriented plumbing,
  // but this embedded PR diff is owned by the review worktree. Keep the id
  // stable for the lifetime of the review so attaching Chat cannot reset the
  // diff state, refresh turn snapshots, or subscribe it to a new transcript.
  const reviewTabId = untrack(() => activeChatTabId ?? session.activeTabId);

  let stackReady = $state(false);
  let stackLoadFailed = $state(false);
  let showingFullDiff = $state(false);
  let ownDeltaFileCount = $state<number | null>(null);

  $effect(() => {
    const review = pr;
    stackReady = false;
    stackLoadFailed = false;
    if (!review) return;
    const ctx = untrack(prCtx);
    void stacks.load(ctx)
      .catch(() => {
        if (pr?.number === review.number) stackLoadFailed = true;
      })
      .finally(() => {
        if (pr?.number === review.number) stackReady = true;
      });
  });

  const liveDiffBase = $derived<DiffBase>(
    settings.stackedPrsEnabled && pr && stackReady && !stackLoadFailed
      ? stacks.resolveDiffBase(pr.number, pr.baseRef)
      : { kind: "target", ref: pr?.baseRef ?? "" },
  );
  const ownDeltaBase = $derived(
    liveDiffBase.kind === "own-delta" && liveDiffBase.parent
      ? { parent: liveDiffBase.parent, headSha: liveDiffBase.ref }
      : null,
  );
  // Guides are keyed by the local review branch, so one exists only once the
  // worktree does. Every load below is gated on `stackReady`, which the pending
  // phase never reaches, so the empty key is never used to read or write.
  const guideKey = $derived(pr ? pr.branch.replace(/\//g, "__") : "");
  const effectiveGuideKey = $derived(
    reviewGuideKeyForBase(guideKey, ownDeltaBase?.headSha),
  );

  $effect(() => {
    if (liveDiffBase.kind === "target") showingFullDiff = false;
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
  $effect(() => {
    void effectiveGuideKey;
    if (!guideEnabled || !stackReady || showingFullDiff) return;
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
      !stackReady ||
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

  const diffScope = $derived<DiffScope>(
    ownDeltaBase && !showingFullDiff
      ? {
          kind: "pr",
          baseSha: pr?.baseSha ?? "",
          ownDeltaBaseSha: ownDeltaBase.headSha,
          parentPr: ownDeltaBase.parent,
        }
      : { kind: "pr", baseSha: pr?.baseSha ?? "" },
  );

  $effect(() => {
    const base = ownDeltaBase;
    if (!base || !pr) {
      ownDeltaFileCount = null;
      return;
    }
    const review = pr;
    const key = `${review.number}:${review.headSha}:${base.headSha}`;
    ownDeltaFileCount = null;
    const ctx = untrack(prCtx);
    void window.solus
      .diffStats(ctx, {
        scope: {
          kind: "pr",
          baseSha: review.baseSha,
          ownDeltaBaseSha: base.headSha,
          parentPr: base.parent,
        },
      })
      .then((files) => {
        if (`${pr?.number}:${pr?.headSha}:${ownDeltaBase?.headSha ?? ""}` === key) {
          ownDeltaFileCount = files.length;
        }
      })
      .catch(() => {});
  });

  // Existing GitHub inline review comments. Fetched once here and shared with
  // both the Diff tab (read-only, anchored at their line) and the Activity tab
  // (which owns reply / resolve, mutating these objects in place) — so the
  // heaviest read isn't duplicated across the two surfaces.
  let reviewThreads = $state<ReviewThread[]>([]);
  let threadsLoadFailed = $state(false);
  function loadThreads(force = false) {
    const number = target.number;
    threadsLoadFailed = false;
    void session.prsStore
      .loadThreads(prCtx(), number, { force })
      .then((t) => {
        if (target.number === number) {
          reviewThreads = t;
          markPrReviewProfile("threads-ready", { count: t.length });
        }
      })
      .catch(() => {
        // Surfaced through the Activity tab's error banner rather than a toast,
        // so a dead provider doesn't read as "no threads".
        if (target.number === number) threadsLoadFailed = true;
      });
  }
  // Provider-backed, so this runs during the pending phase too — the threads are
  // part of the Activity timeline, not of the worktree.
  $effect(() => {
    void target.number;
    untrack(() => loadThreads());
  });
  $effect(() => {
    onUnresolvedCountChange?.(
      reviewThreads.filter((thread) => !thread.isResolved).length,
    );
  });

  let interdiff = $state<PrInterdiffResult | null>(null);
  let showingSinceReview = $state(false);
  let interdiffKey = "";

  function loadInterdiff(force = false) {
    const review = pr;
    if (!review) return;
    const key = `${review.number}:${review.baseSha}:${review.headSha}`;
    const shouldDefaultMode = key !== interdiffKey || force;
    interdiffKey = key;
    void session.prsStore
      .loadInterdiff(prCtx(), review, { force })
      .then((result) => {
        if (`${pr?.number}:${pr?.baseSha}:${pr?.headSha}` !== key) return;
        interdiff = result;
        if (shouldDefaultMode) showingSinceReview = result.state === "changed";
      })
      .catch(() => {
        if (`${pr?.number}:${pr?.baseSha}:${pr?.headSha}` === key) interdiff = null;
      });
  }

  $effect(() => {
    void pr?.number;
    void pr?.baseSha;
    void pr?.headSha;
    untrack(() => loadInterdiff());
  });

  const hasReviewCheckpointNotice = $derived(
    interdiff?.state === "changed" || interdiff?.state === "invalid",
  );
  const isSinceReviewMode = $derived(
    !ownDeltaBase && interdiff?.state === "changed" && showingSinceReview,
  );
  const sinceReviewThreads = $derived(
    isSinceReviewMode && interdiff
      ? interdiffReviewThreads(matchedReviewComments(interdiff))
      : [],
  );

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
  function replyToThread(threadId: string, body: string) {
    return window.solus.prReplyThread(prCtx(), target.number, threadId, body);
  }

  async function resolveThread(threadId: string, resolved: boolean): Promise<void> {
    if (resolved) {
      await window.solus.prResolveThread(prCtx(), target.number, threadId);
    } else {
      await window.solus.prUnresolveThread(prCtx(), target.number, threadId);
    }
  }

  // GitHub-bound draft comments, persisted per guide key (shared store with the
  // local review guide surface, where drafts become agent feedback instead).
  const reviewDrafts = new ReviewDrafts({
    getCtx: prCtx,
    getKey: () => effectiveGuideKey,
  });
  $effect(() => {
    void effectiveGuideKey;
    if (!stackReady) return;
    void untrack(() => reviewDrafts.load());
  });

  const drafts = $derived(reviewDrafts.drafts);
  const diffComments = $derived(reviewDrafts.diffComments);
  const saveDiffComment = (c: GuideDiffCommentSave) => reviewDrafts.save(c);
  const removeDraft = (id: string) => reviewDrafts.remove(id);

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
    reviewDrafts.clear();
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

  function select(next: ContentTab) {
    if (next === "guide" && showingFullDiff) return;
    if (activeTab === undefined) session.prsStore.prReviewTab = next;
    onActiveTabChange?.(next);
    requestInputFocus();
  }

  function toggleFullDiff() {
    showingFullDiff = !showingFullDiff;
    if (activeTab === undefined) session.prsStore.prReviewTab = "diff";
    onActiveTabChange?.("diff");
    mountedDiff = true;
    requestInputFocus();
  }

  // File chips in the Guide / threads in Activity jump to the Diff tab rather
  // than spawning a separate diff pane (which would clobber this surface).
  let diffPanelRef: DiffPanel | null = $state(null);

  function jumpToDiff(path?: string, line?: number | null, side: "old" | "new" = "new") {
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

  // Esc closes the PR review panel. Skip when a comment/text field is focused
  // (it cancels its own edit) or the submit modal is open (it owns Esc).
  function onWindowKeydown(e: KeyboardEvent) {
    if (headless) return;
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (showSubmit) return;
    const el = e.target as HTMLElement | null;
    if (el && (el.isContentEditable || el.closest("input, textarea"))) return;
    e.preventDefault();
    exit();
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<section class="flex h-full min-h-0 flex-col bg-card">
  {#if !headless}
    <!-- One chrome-height bar: navigation, the PR's identity, and the pane controls that
         PaneChrome floats for every other surface. Consolidated here (rather
         than in PaneChrome) so this review reads as a single header row while
         every other pane keeps the shared floating cluster.
         No rule beneath it, and no centred measure: the bar spans the pane's
         full width with the same leading gutter as the diff toolbar while the
         trailing controls reach the pane's right edge. -->
    <div
      class="@container h-[var(--solus-chrome-row-h,2.5rem)] shrink-0 overflow-hidden"
    >
      <div
        class="flex h-full w-full items-center justify-between gap-4 pr-3 pl-[max(0.75rem,var(--solus-chrome-lead-inset,0px))]"
      >
        <div class="flex min-w-0 flex-1 items-center gap-3">
          <Tabs.Root
            value={sub}
            onValueChange={(value) => select(value as ContentTab)}
            class="contents"
          >
            <Tabs.List
              aria-label="PR review tabs"
              class="h-7 shrink-0 gap-0.5 rounded-lg border-0 bg-muted p-0.5"
            >
              {#each TABS as t (t.id)}
                <Tabs.Trigger
                  value={t.id}
                  disabled={(t.id === "guide" && showingFullDiff) ||
                    (t.id !== "activity" && !pr)}
                  title={t.id === "guide" && showingFullDiff
                    ? "Guides cover the stacked view"
                    : t.id !== "activity" && !pr
                      ? "Checking out this PR's worktree…"
                      : undefined}
                  class="h-full flex-none rounded-md border-0 px-2.5 text-[12px] font-normal text-muted-foreground hover:text-foreground data-active:bg-card data-active:font-medium data-active:text-foreground data-active:shadow-[0_1px_2px_rgba(0,0,0,0.06)] dark:data-active:shadow-none dark:data-active:ring-1 dark:data-active:ring-white/10"
                  onclick={requestInputFocus}
                >
                  {t.label}
                </Tabs.Trigger>
              {/each}
            </Tabs.List>
          </Tabs.Root>

          <!-- Below the comp's breakpoint the controls need the whole row, so
               the title steps aside — the Activity tab states it at full size
               anyway. It stays a button (opening the PR on its host is
               reachable from every tab) but rests as the design's plain
               `#28 · title` line. -->
          <div
            class="flex min-w-0 flex-1 items-center gap-1 text-[12px] text-muted-foreground @max-[1100px]:hidden"
          >
            <Button
              type="button"
              variant="ghost"
              size="xs"
              class="h-auto shrink-0 rounded-none bg-transparent p-0 font-mono text-[12px] font-normal text-foreground transition-colors hover:bg-transparent hover:text-primary"
              onclick={openPr}
              disabled={!prUrl}
              title={pr ? "Open PR on " + pr.host : undefined}
            >
              #{target.number}
            </Button>
            <span class="shrink-0 opacity-40" aria-hidden="true">·</span>
            <span class="truncate">{target.title}</span>
          </div>
        </div>

        <div class="flex shrink-0 items-center gap-1.5">
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
            class={`relative h-[28px] gap-1.5 rounded-lg border border-transparent px-2 text-[12px] font-normal transition-colors after:absolute after:h-10 after:w-full ${activeChatTabId ? "bg-secondary text-secondary-foreground" : "bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground"}`}
            onclick={openChat}
            disabled={openingChat || !pr}
            title={!pr
              ? "Checking out this PR's worktree…"
              : activeChatTabId
                ? "Focus agent chat"
                : "Open agent chat"}
          >
            <ChatCircleIcon size={13} />
            Chat
          </Button>

          {#if sub === "guide" && !showingFullDiff}
            <Button
              type="button"
              variant="ghost"
              class="flex size-[28px] shrink-0 items-center justify-center rounded-lg border-0 bg-transparent p-0 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Regenerate review guide"
              title="Regenerate review"
              onclick={() => guideLoader.refresh()}
            >
              <ArrowsClockwiseIcon size={13} />
            </Button>
          {/if}

          <FrameExpandButton variant="projectPanel" size="header" />

          {#if onToggleSecondaryMaximize}
            <TooltipUI.Root>
              <TooltipUI.Trigger>
                {#snippet child({ props })}
                  <button
                    {...props}
                    type="button"
                    class="flex size-[28px] shrink-0 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    onclick={onToggleSecondaryMaximize}
                    aria-label={panes.maximized ? "Restore panel size" : "Maximize panel"}
                  >
                    {#if panes.maximized}
                      <ArrowsInIcon size={13} />
                    {:else}
                      <ArrowsOutIcon size={13} />
                    {/if}
                  </button>
                {/snippet}
              </TooltipUI.Trigger>
              <TooltipUI.Content
                value={panes.maximized ? "Restore panel (⌥M)" : "Maximize (⌥M)"}
              />
            </TooltipUI.Root>
          {/if}

          <button
            type="button"
            class="flex size-[28px] shrink-0 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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
          {#if ownDeltaBase}
            <StackDiffBanner
              parent={ownDeltaBase.parent}
              fileCount={ownDeltaFileCount}
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
            fileCount={ownDeltaFileCount}
            showingFull={showingFullDiff}
            onToggle={toggleFullDiff}
          />
        {/if}
        {#if !ownDeltaBase && hasReviewCheckpointNotice && interdiff}
          <SinceReviewBar
            result={interdiff}
            showingSince={isSinceReviewMode}
            onModeChange={(sinceReview) => {
              showingSinceReview = sinceReview;
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
            onToggleMaximize={onToggleSecondaryMaximize}
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
        />
      </div>
    {/if}
  </div>

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
