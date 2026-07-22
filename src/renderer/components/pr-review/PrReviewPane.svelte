<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import {
    XIcon,
    ArrowsClockwiseIcon,
    ArrowsInSimpleIcon,
    ArrowsOutSimpleIcon,
    ChatCircleIcon,
    ArrowSquareOutIcon,
  } from "phosphor-svelte";
  import type { PrReviewContext, DiffScope, PrInterdiffResult } from "../../../shared/types";
  import { worktreeProjectRoot } from "../../../shared/types";
  import type { DiffBase } from "../../../shared/stack-types";
  import { reviewGuideKeyForBase } from "../../../shared/review";
  import type { DraftReview, ReviewThread } from "../../../shared/providers";
  import type { GuideDiffCommentSave } from "./guide/lib/guide-data";
  import { getWorkspaceContext, getSettingsContext, getAgentContext } from "../../contexts";
  import { resolveReviewAgent } from "../../lib/reviewAgent";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { useKeybinding, useScope } from "../../lib/keybindings/use-keybinding.svelte";
  import GuideSurface from "../review/GuideSurface.svelte";
  import { GuideLoader } from "../review/lib/guide-loader.svelte";
  import { ReviewDrafts } from "../review/lib/review-drafts.svelte";
  import DiffPanel from "../diff/DiffPanel.svelte";
  import ActivityFeed from "./ActivityFeed.svelte";
  import PendingReviewTray from "./PendingReviewTray.svelte";
  import SubmitReviewModal from "./SubmitReviewModal.svelte";
  import SinceReviewBar from "./SinceReviewBar.svelte";
  import { matchedReviewComments } from "./lib/since-review";
  import { interdiffReviewThreads } from "../diff/lib/interdiff-annotations";
  import * as Tabs from "../ui/tabs";
  import { Button } from "../ui/button";
  import PrChecksChip from "../prs/PrChecksChip.svelte";
  import StackDiffBanner from "./StackDiffBanner.svelte";
  import {
    beginPrReviewProfile,
    markPrReviewProfile,
  } from "./lib/pr-review-profiler";

  // The review surface (M3–M5): Activity · Guide · Diff content tabs over a PR's
  // change, living maximized in the secondary pane. The "Chat" button lazily
  // creates a worktree-rooted conversation and pops it out alongside the review.
  let {
    pr,
    chatTabId = null,
    guideKey,
    onToggleSecondaryMaximize,
    activeTab,
    onActiveTabChange,
    headless = false,
    guideEnabled = true,
    onUnresolvedCountChange,
  }: {
    pr: PrReviewContext;
    chatTabId?: string | null;
    guideKey: string;
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
    beginPrReviewProfile(pr.number);
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
  // context, so revealing Chat cannot invalidate the cached domain state.
  const reviewContext = $derived.by(() =>
    session.ctxForDirectory(worktreeProjectRoot(pr.worktreePath)),
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
    const number = pr.number;
    stackReady = false;
    stackLoadFailed = false;
    const ctx = untrack(prCtx);
    void stacks.load(ctx)
      .catch(() => {
        if (pr.number === number) stackLoadFailed = true;
      })
      .finally(() => {
        if (pr.number === number) stackReady = true;
      });
  });

  const liveDiffBase = $derived<DiffBase>(
    stackReady && !stackLoadFailed
      ? stacks.resolveDiffBase(pr.number, pr.baseRef)
      : { kind: "target", ref: pr.baseRef },
  );
  const ownDeltaBase = $derived(
    liveDiffBase.kind === "own-delta" && liveDiffBase.parent
      ? { parent: liveDiffBase.parent, headSha: liveDiffBase.ref }
      : null,
  );
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
  $effect(() => {
    void effectiveGuideKey;
    if (!guideEnabled || !stackReady || showingFullDiff) return;
    const generateIfMissing = settings.generatePrGuidesOnOpen;
    void untrack(() => guideLoader.load(false, generateIfMissing));
  });

  // A background "Generate guide" (Activity header / PRs page) finishing while
  // this pane sits on the empty or stale Guide state: pick up the cached guide.
  $effect(() => {
    const number = pr.number;
    return window.solus.onPrGuideStatus((event) => {
      if (event.number !== number || event.status !== "ready") return;
      if (guideLoader.loading || (guideLoader.guide && !guideLoader.stale)) return;
      void guideLoader.load(false, false);
    });
  });

  // The active content tab lives in the pane store so chrome outside this
  // component can react to it (see PaneViewStore.prReviewTab).
  type ContentTab = "activity" | "guide" | "diff";
  const sub = $derived(activeTab ?? panes.prReviewTab);

  const diffScope = $derived<DiffScope>(
    ownDeltaBase && !showingFullDiff
      ? {
          kind: "pr",
          baseSha: pr.baseSha,
          ownDeltaBaseSha: ownDeltaBase.headSha,
          parentPr: ownDeltaBase.parent,
        }
      : { kind: "pr", baseSha: pr.baseSha },
  );

  $effect(() => {
    const base = ownDeltaBase;
    if (!base) {
      ownDeltaFileCount = null;
      return;
    }
    const key = `${pr.number}:${pr.headSha}:${base.headSha}`;
    ownDeltaFileCount = null;
    const ctx = untrack(prCtx);
    void window.solus
      .diffStats(ctx, {
        scope: {
          kind: "pr",
          baseSha: pr.baseSha,
          ownDeltaBaseSha: base.headSha,
          parentPr: base.parent,
        },
      })
      .then((files) => {
        if (`${pr.number}:${pr.headSha}:${ownDeltaBase?.headSha ?? ""}` === key) {
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
    const number = pr.number;
    threadsLoadFailed = false;
    void session.prsStore
      .loadThreads(prCtx(), number, { force })
      .then((t) => {
        if (pr.number === number) {
          reviewThreads = t;
          markPrReviewProfile("threads-ready", { count: t.length });
        }
      })
      .catch(() => {
        // Surfaced through the Activity tab's error banner rather than a toast,
        // so a dead provider doesn't read as "no threads".
        if (pr.number === number) threadsLoadFailed = true;
      });
  }
  $effect(() => {
    void pr.number;
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
    const key = `${pr.number}:${pr.baseSha}:${pr.headSha}`;
    const shouldDefaultMode = key !== interdiffKey || force;
    interdiffKey = key;
    void session.prsStore
      .loadInterdiff(prCtx(), pr, { force })
      .then((result) => {
        if (`${pr.number}:${pr.baseSha}:${pr.headSha}` !== key) return;
        interdiff = result;
        if (shouldDefaultMode) showingSinceReview = result.state === "changed";
      })
      .catch(() => {
        if (`${pr.number}:${pr.baseSha}:${pr.headSha}` === key) interdiff = null;
      });
  }

  $effect(() => {
    void pr.number;
    void pr.baseSha;
    void pr.headSha;
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
    const currentNumber = pr.number;
    const prCwd = pr.worktreePath;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = window.solus.onPrsChanged((changedCwd) => {
      const paneCtx = prCtx();
      const ctxCwd = paneCtx.session.projectPath || paneCtx.session.workingDirectory;
      if (changedCwd !== ctxCwd && changedCwd !== prCwd) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (pr.number !== currentNumber) return;
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
    return window.solus.prReplyThread(prCtx(), pr.number, threadId, body);
  }

  async function resolveThread(threadId: string, resolved: boolean): Promise<void> {
    if (resolved) {
      await window.solus.prResolveThread(prCtx(), pr.number, threadId);
    } else {
      await window.solus.prUnresolveThread(prCtx(), pr.number, threadId);
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
    { enabled: () => !headless && !showSubmit },
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
    if (activeTab === undefined) panes.prReviewTab = next;
    onActiveTabChange?.(next);
    requestInputFocus();
  }

  function toggleFullDiff() {
    showingFullDiff = !showingFullDiff;
    if (activeTab === undefined) panes.prReviewTab = "diff";
    onActiveTabChange?.("diff");
    mountedDiff = true;
    requestInputFocus();
  }

  // File chips in the Guide / threads in Activity jump to the Diff tab rather
  // than spawning a separate diff pane (which would clobber this surface).
  let diffPanelRef: DiffPanel | null = $state(null);

  function jumpToDiff(path?: string, line?: number | null, side: "old" | "new" = "new") {
    if (activeTab === undefined) panes.prReviewTab = "diff";
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
    if (openingChat) return;
    openingChat = true;
    try {
      activeChatTabId = await session.openPrReviewChat(pr, activeChatTabId);
    } finally {
      openingChat = false;
    }
    requestInputFocus();
  }

  function exit() {
    session.exitPrReview();
    requestInputFocus();
  }

  const prUrl = $derived(`https://${pr.host}/${pr.owner}/${pr.repo}/pull/${pr.number}`);

  function openPr() {
    void window.solus.openExternal(prUrl);
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

<section class="flex h-full min-h-0 flex-col bg-(--solus-container-bg)">
  {#if !headless}
    <header
      class="flex h-[var(--solus-chrome-row-h,2.5rem)] shrink-0 items-center gap-2 border-b border-[color:var(--solus-chrome-row-border,color-mix(in_srgb,var(--solus-container-border)_50%,transparent))] pr-2 pl-[max(0.75rem,var(--solus-chrome-lead-inset,0px))]"
    >
    <Tabs.Root
      value={sub}
      onValueChange={(value) => select(value as ContentTab)}
      class="contents"
    >
      <Tabs.List
        aria-label="PR review tabs"
        class="h-auto gap-0.5 rounded-lg bg-(--solus-accent-light) p-0.5"
      >
        {#each TABS as t (t.id)}
          <Tabs.Trigger
            value={t.id}
            disabled={t.id === "guide" && showingFullDiff}
            title={t.id === "guide" && showingFullDiff ? "Guides cover the stacked view" : undefined}
            class="h-auto flex-none rounded-md border-0 px-2.5 py-1 text-xs font-medium text-(--solus-text-tertiary) hover:text-(--solus-text-secondary) data-active:bg-(--solus-container-bg) data-active:text-(--solus-text-primary) data-active:shadow-sm"
            onclick={requestInputFocus}
          >
            {t.label}
          </Tabs.Trigger>
        {/each}
      </Tabs.List>
    </Tabs.Root>

    <div class="flex min-w-0 flex-1 items-center text-xs text-(--solus-text-tertiary)">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        class="-ml-1 font-semibold text-(--solus-text-secondary) hover:bg-(--solus-surface-hover) hover:text-(--solus-accent)"
        onclick={openPr}
        title={"Open PR on " + pr.host}
      >
        #{pr.number}
        <ArrowSquareOutIcon size={12} weight="bold" />
      </Button>
      <span class="px-1">·</span>
      <span class="truncate">{pr.title}</span>
    </div>

    <PrChecksChip
      summary={session.prsStore.checksFor(pr.number)}
      headSha={pr.headSha}
      loadFailed={session.prsStore.checksLoadFailed}
    />

    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      class="relative text-(--solus-text-tertiary) transition-[background-color,color,scale] hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] after:absolute after:size-10"
      onclick={onToggleSecondaryMaximize}
      aria-label={panes.maximized ? "Restore review split" : "Expand review"}
      title={panes.maximized ? "Restore review split" : "Expand review"}
    >
      {#if panes.maximized}
        <ArrowsInSimpleIcon size={14} weight="bold" />
      {:else}
        <ArrowsOutSimpleIcon size={14} weight="bold" />
      {/if}
    </Button>

    <Button
      type="button"
      variant="ghost"
      size="xs"
      class={`relative gap-1.5 transition-[background-color,color,scale] active:scale-[0.96] after:absolute after:h-10 after:w-full ${activeChatTabId ? "bg-(--solus-accent-soft) text-(--solus-accent)" : "text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)"}`}
      onclick={openChat}
      disabled={openingChat}
      title={activeChatTabId ? "Focus agent chat" : "Open agent chat"}
    >
      <ChatCircleIcon size={14} weight="bold" />
      Chat
    </Button>

    {#if sub === "guide" && !showingFullDiff}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        class="text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)"
        aria-label="Regenerate review guide"
        title="Regenerate review"
        onclick={() => guideLoader.refresh()}
      >
        <ArrowsClockwiseIcon size={15} />
      </Button>
    {/if}

    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      class="text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)"
      aria-label="Exit PR review"
      onclick={exit}
    >
      <XIcon size={15} />
    </Button>
    </header>
  {/if}

  <div class="relative min-h-0 flex-1">
    {#if mountedGuide}
      <div
        class="absolute inset-0 flex flex-col"
        class:hidden={sub !== "guide"}
      >
        {#if !guideEnabled}
          <div class="grid h-full place-items-center px-8 text-center">
            <div class="max-w-sm">
              <p class="text-sm font-semibold text-(--solus-text-primary)">Guide skipped for this quick review</p>
              <p class="mt-1 text-pretty text-xs leading-relaxed text-(--solus-text-tertiary)">
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
          />
        {/if}
      </div>
    {/if}
    {#if mountedDiff}
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
            maximized={panes.maximized}
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
          {pr}
          threads={reviewThreads}
          threadsFailed={threadsLoadFailed}
          getCtx={prCtx}
          onAddressComments={() => session.startPrCommentsFixSession(pr)}
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

{#if showSubmit}
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
