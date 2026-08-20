<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import { SvelteMap, SvelteSet } from "svelte/reactivity";
  import {
    CircleCheck as CheckCircleIcon,
    MessageSquareText as ChatTextIcon,
    Clock as ClockIcon,
    CircleAlert as WarningCircleIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import type { PrReviewTarget, PullRequestSummary } from "@solus/contracts/providers";
  import type { IpcContext } from "@solus/contracts/types";
  import type { ReviewOutcome } from "@solus/contracts/review-session-types";
  import { getWorkspaceContext } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { Button } from "../ui/button";
  import PrChecksChip from "../prs/PrChecksChip.svelte";
  import PrReviewPane from "../pr-review/PrReviewPane.svelte";
  import QueueRail from "./QueueRail.svelte";
  import { reviewSessionStore } from "./review-session.store.svelte";
  import { createReviewDispositionPoster } from "./lib/review-disposition-poster";
  import {
    defaultReviewModeView,
    deriveQueueRows,
    type ReviewModeQueueItem,
    type ReviewModeView,
  } from "./lib/review-mode-model";
  import { HOLD_MS } from "./lib/review-session-core";
  import type { ReviewQueueItem } from "./lib/review-queue-order";

  const session = getWorkspaceContext();
  const store = reviewSessionStore;

  interface PreparedReview {
    pr: PrReviewTarget;
  }

  const prepared = new SvelteMap<number, PreparedReview>();
  const preparing = new SvelteSet<number>();
  const prepareErrors = new SvelteMap<number, string>();
  const visited = new SvelteSet<number>();
  const views = new SvelteMap<number, ReviewModeView>();
  const unresolvedByPr = new SvelteMap<number, number>();

  let items = $state<ReviewModeQueueItem[]>([]);
  let initializing = $state(true);
  let now = $state(Date.now());
  let flushing = $state(false);
  let composerOutcome = $state<"changes_requested" | "commented" | null>(null);
  let composerBody = $state("");
  let composerEl = $state<HTMLTextAreaElement | null>(null);
  let started = false;
  let disposed = false;
  let postingContext = $state<IpcContext | null>(null);
  let viewer = $state<string | null>(null);

  // Review mode is entered through `beginReviewMode`, which always names the
  // host its queue was built on; a mount without that stamp has nothing to review.
  const reviewServerId = $derived(session.prsStore.reviewModeServerId);
  const reviewApi = $derived(
    reviewServerId ? serverConnections.apiFor(reviewServerId) : null,
  );

  const state = $derived(store.state);
  const currentEntry = $derived(store.currentEntry);
  const currentItem = $derived(
    currentEntry
      ? (items.find((item) => item.number === currentEntry.prNumber) ?? null)
      : null,
  );
  const currentPrepared = $derived(
    currentEntry ? (prepared.get(currentEntry.prNumber) ?? null) : null,
  );
  const rows = $derived(
    state
      ? deriveQueueRows(
          items,
          state.entries,
          state.pending,
          state.cursor,
          unresolvedByPr,
          now,
        )
      : [],
  );
  const settledCount = $derived(
    state?.entries.filter((entry) => entry.outcome !== null).length ?? 0,
  );

  function findSummary(number: number): PullRequestSummary | null {
    return session.prsStore.get(number)
      ?? session.prsStore.needsReviewItems.find((item) => item.number === number)
      ?? null;
  }

  async function prepare(number: number): Promise<void> {
    if (!reviewServerId) return;
    if (prepared.has(number) || preparing.has(number)) return;
    preparing.add(number);
    prepareErrors.delete(number);
    try {
      const result = await session.preparePrReview(number, {
        ctx: postingContext ?? session.prsStore.reviewModeContext ?? session.ctx,
        serverId: reviewServerId,
      });
      if (disposed) return;
      prepared.set(number, result);
    } catch (error) {
      prepareErrors.set(number, error instanceof Error ? error.message : String(error));
    } finally {
      preparing.delete(number);
    }
  }

  $effect(() => {
    const entry = currentEntry;
    if (!entry) return;
    visited.add(entry.prNumber);
    if (!views.has(entry.prNumber)) {
      const item = items.find((candidate) => candidate.number === entry.prNumber);
      views.set(entry.prNumber, defaultReviewModeView(item?.effort));
    }
    void prepare(entry.prNumber);
  });

  function selectView(view: ReviewModeView): void {
    if (!currentEntry) return;
    views.set(currentEntry.prNumber, view);
  }

  function visit(index: number): void {
    if (!started) return;
    cancelComposer();
    store.visit(index);
  }

  function move(direction: 1 | -1): void {
    if (!started) return;
    cancelComposer();
    if (direction === 1) {
      if (!state || state.cursor >= state.entries.length - 1) return;
      store.next();
    }
    else store.prev();
  }

  function canDisposition(): boolean {
    return !!currentEntry
      && currentEntry.outcome === null
      && !store.pendingFor(currentEntry.prNumber)
      && !!currentPrepared;
  }

  function isOwnPullRequest(): boolean {
    return !!viewer && currentItem?.author.toLowerCase() === viewer.toLowerCase();
  }

  function canApprove(): boolean {
    return canDisposition() && !isOwnPullRequest();
  }

  function disposeCurrent(outcome: Exclude<ReviewOutcome, "skipped">, body?: string): void {
    if (!currentEntry || !canDisposition()) return;
    if (outcome === "approved" && isOwnPullRequest()) {
      toasts.error("GitHub doesn't allow you to approve your own pull request");
      return;
    }
    try {
      const disposition = store.dispose(currentEntry.prNumber, outcome, body);
      cancelComposer();
      // Approval is an explicit final action and should reach GitHub now. Keep
      // the short undo window for text-heavy comments/change requests only.
      if (outcome === "approved") {
        void store.flush(disposition.prNumber);
      }
      if (!store.currentEntry) void finish();
    } catch (error) {
      toasts.error(error instanceof Error ? error.message : String(error));
    }
  }

  function openComposer(outcome: "changes_requested" | "commented"): void {
    if (!canDisposition()) return;
    composerOutcome = outcome;
    composerBody = "";
    void tick().then(() => composerEl?.focus());
  }

  function cancelComposer(): void {
    composerOutcome = null;
    composerBody = "";
  }

  function submitComposer(): void {
    const body = composerBody.trim();
    if (!composerOutcome || !body) return;
    disposeCurrent(composerOutcome, body);
  }

  function undoLatest(): void {
    if (!state) return;
    const latest = [...state.pending]
      .reverse()
      .find((disposition) => disposition.heldAt + HOLD_MS > Date.now());
    if (!latest || !store.undo(latest.prNumber)) return;
    cancelComposer();
  }

  async function finish(): Promise<void> {
    if (flushing) return;
    flushing = true;
    try {
      if (started) await store.flushAll();
      session.openPrs();
    } finally {
      flushing = false;
    }
  }

  function isEditableTarget(target: EventTarget | null): boolean {
    return target instanceof Element
      && !!target.closest("input, textarea, select, [contenteditable='true']");
  }

  function onWindowKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if (isEditableTarget(event.target)) return;

    const key = event.key.toLowerCase();
    if (key === "u") {
      event.preventDefault();
      undoLatest();
      return;
    }
    if (key === "escape") {
      event.preventDefault();
      void finish();
      return;
    }
    if (event.repeat) return;

    if (key === "j") {
      event.preventDefault();
      move(1);
    } else if (key === "k") {
      event.preventDefault();
      move(-1);
    } else if (key === "a") {
      event.preventDefault();
      disposeCurrent("approved");
    } else if (key === "r") {
      event.preventDefault();
      openComposer("changes_requested");
    } else if (key === "c") {
      event.preventDefault();
      openComposer("commented");
    } else if (key === "d") {
      event.preventDefault();
      disposeCurrent("deferred");
    } else if (key === "1") {
      event.preventDefault();
      selectView("activity");
    } else if (key === "2") {
      event.preventDefault();
      selectView("guide");
    } else if (key === "3") {
      event.preventDefault();
      selectView("diff");
    }
  }

  function onComposerKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelComposer();
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitComposer();
    }
  }

  onMount(() => {
    // Snapshotted for the mount's closures: the stamp never moves while the
    // queue is open, and the narrowed locals keep every callback host-typed.
    const api = reviewApi;
    const serverId = reviewServerId;
    if (!api || !serverId) return;
    const launchNumbers = [...session.prsStore.reviewModeNumbers];
    items = launchNumbers.map((number) => {
      const item = findSummary(number);
      if (!item) return { number, title: `Pull request #${number}`, author: "Unknown" };
      const queueItem: ReviewModeQueueItem = { number, title: item.title, author: item.author };
      if (item.effort) queueItem.effort = item.effort;
      return queueItem;
    });
    postingContext = structuredClone(session.prsStore.reviewModeContext ?? session.ctx);
    const context = postingContext;
    let cancelled = false;
    void session.prsStore.loadViewer(api, serverId, context).then((login) => {
      if (!cancelled) viewer = login;
    }).catch(() => {});

    void session.stacksStore.load(api, serverId, context)
      .catch(() => session.stacksStore.graphFor(serverId, context.session.projectPath))
      .then((stackGraph) => {
      if (cancelled) return;
      const basePoster = createReviewDispositionPoster({
        getContext: () => context,
        getReview: (number) => prepared.get(number)?.pr ?? null,
        submit: (ctx, number, review) =>
          api.prSubmitReview(ctx, number, review),
      });
      store.start({
        items: items.map((item) => {
          const queueItem: ReviewQueueItem = { number: item.number };
          if (item.effort) queueItem.effort = item.effort;
          return queueItem;
        }),
        stackGraph,
        minutesFor: (number) => findSummary(number)?.effort?.minutes
          ?? items.find((item) => item.number === number)?.effort?.minutes,
        poster: {
          async post(disposition) {
            try {
              await basePoster.post(disposition);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              toasts.error(`Couldn't post review for #${disposition.prNumber}`, {
                description: message,
              });
              throw error;
            }
          },
        },
      });
      started = true;
      initializing = false;
      if (!store.currentEntry) void finish();
    });

    const progressTimer = window.setInterval(() => { now = Date.now(); }, 100);
    const dwellTimer = window.setInterval(() => {
      if (started) store.heartbeat();
    }, 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(progressTimer);
      window.clearInterval(dwellTimer);
    };
  });

  onDestroy(() => {
    disposed = true;
    if (started) void store.flushAll();
  });
</script>

<svelte:window onkeydown={onWindowKeydown} />

<section class="flex h-full min-h-0 flex-col bg-(--solus-container-bg) antialiased" aria-label="Review mode">
  <header class="workspace-titlebar flex h-(--solus-chrome-row-h) shrink-0 items-center gap-3 border-b border-(--solus-container-border) pr-3 pl-[max(0.75rem,var(--solus-chrome-lead-inset,0px))]">
    <span class="rounded-md bg-(--solus-accent-light) px-2 py-1 text-xs font-medium text-(--solus-accent) uppercase ring-1 ring-inset ring-(--solus-accent-border)">
      Review mode
    </span>
    <span class="text-xs font-secondary text-(--solus-text-secondary) tabular-nums">
      {settledCount + (state?.pending.length ?? 0)} of {state?.entries.length ?? items.length} reviewed
      {#if currentEntry} · viewing <strong class="font-medium text-(--solus-text-primary)">{store.position}</strong>{/if}
    </span>
    <span class="ml-auto hidden text-xs text-(--solus-text-tertiary) xl:inline">Single-key controls are active outside text fields</span>
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Exit review mode"
      disabled={flushing}
      onclick={() => void finish()}
    >
      <XIcon />
    </Button>
  </header>

  {#if initializing}
    <div class="grid min-h-0 flex-1 place-items-center text-xs text-(--solus-text-tertiary)" role="status">
      Preparing review queue…
    </div>
  {:else if state && reviewApi && reviewServerId}
    <div class="flex min-h-0 flex-1">
      <QueueRail
        {rows}
        remainingMinutes={store.remainingMinutes}
        totalMinutes={store.totalMinutes}
        onSelect={visit}
      />

      <div class="flex min-w-0 flex-1 flex-col">
        {#if currentItem && currentEntry}
          {@const source = findSummary(currentItem.number)}
          {@const selectedView = views.get(currentItem.number) ?? defaultReviewModeView(currentItem.effort)}
          <div class="flex min-h-14 shrink-0 items-center gap-3 border-b border-(--solus-container-border) px-4">
            <div class="min-w-0 flex-1">
              <h1 class="truncate text-sm font-medium text-(--solus-text-primary)">{currentItem.title}</h1>
              <div class="mt-1 flex items-center gap-2 text-xs text-(--solus-text-tertiary)">
                <span class="tabular-nums">#{currentItem.number}</span>
                <span aria-hidden="true">·</span>
                <span>{currentItem.author}</span>
                {#if currentItem.effort?.band}
                  <span class="rounded px-1.5 py-px text-xs font-medium ring-1 ring-inset {currentItem.effort.band === 'quick'
 ? 'text-(--solus-art-positive) ring-[color:color-mix(in_srgb,var(--solus-art-positive)_28%,transparent)]'
 : currentItem.effort.band === 'involved'
 ? 'text-(--solus-art-negative) ring-[color:color-mix(in_srgb,var(--solus-art-negative)_24%,transparent)]'
 : 'text-(--solus-accent) ring-(--solus-accent-border)'}">
                    {currentItem.effort.band}
                  </span>
                {/if}
                {#if currentItem.effort?.minutes != null}
                  <span class="tabular-nums">~{currentItem.effort.minutes} min</span>
                {/if}
                {#if source && source.additions + source.deletions > 0}
                  <span aria-hidden="true">·</span>
                  <span class="tabular-nums">{source.additions + source.deletions} changed lines</span>
                {/if}
              </div>
            </div>

            {#if source}
              <PrChecksChip
                summary={session.prsStore.checksFor(reviewServerId, postingContext ?? session.ctx, source.number)}
                headSha={source.headSha}
                loadFailed={session.prsStore.checksLoadFailedFor(reviewServerId, postingContext ?? session.ctx)}
              />
            {/if}

            <div class="inline-flex shrink-0 rounded-lg bg-(--solus-accent-light) p-0.5" role="tablist" aria-label="Review views">
              {#each [["activity", "Activity", "1"], ["guide", "Guide", "2"], ["diff", "Diff", "3"]] as tab (tab[0])}
                <button
                  type="button"
                  role="tab"
                  aria-selected={selectedView === tab[0]}
                  class="min-h-7 rounded-md px-2.5 text-xs font-medium transition-[background-color,color,box-shadow] duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--solus-accent-border) {selectedView === tab[0]
 ? 'bg-(--solus-container-bg) text-(--solus-text-primary) shadow-sm'
 : 'text-(--solus-text-tertiary) hover:text-(--solus-text-primary)'}"
                  onclick={() => selectView(tab[0] as ReviewModeView)}
                >
                  {tab[1]} <span class="ml-1 text-xs opacity-60">{tab[2]}</span>
                </button>
              {/each}
            </div>
          </div>
        {/if}

        <div class="relative min-h-0 flex-1">
          {#each state.entries as entry (entry.prNumber)}
            {#if visited.has(entry.prNumber)}
              <div class="absolute inset-0" class:hidden={currentEntry?.prNumber !== entry.prNumber}>
                {#if prepared.has(entry.prNumber)}
                  {@const ready = prepared.get(entry.prNumber)!}
                  {@const item = items.find((candidate) => candidate.number === entry.prNumber)}
                  <PrReviewPane
                    pr={ready.pr}
                    api={reviewApi}
                    serverId={reviewServerId}
                    target={ready.pr}
                    targetCtx={postingContext ?? session.ctx}
                    activeTab={views.get(entry.prNumber) ?? defaultReviewModeView(item?.effort)}
                    onActiveTabChange={(view) => views.set(entry.prNumber, view)}
                    guideEnabled={item?.effort?.band !== "quick"}
                    onUnresolvedCountChange={(count) => unresolvedByPr.set(entry.prNumber, count)}
                    headless
                  />
                {:else if prepareErrors.has(entry.prNumber)}
                  <div class="grid h-full place-items-center px-6 text-center">
                    <div class="max-w-md">
                      <p class="text-sm font-medium text-(--solus-text-primary)">Couldn’t prepare PR #{entry.prNumber}</p>
                      <p class="mt-1 text-pretty text-xs text-(--solus-text-tertiary)">{prepareErrors.get(entry.prNumber)}</p>
                      <Button class="mt-4" size="sm" variant="outline" onclick={() => void prepare(entry.prNumber)}>Try again</Button>
                    </div>
                  </div>
                {:else}
                  <div class="grid h-full place-items-center text-xs text-(--solus-text-tertiary)" role="status">
                    Checking out PR #{entry.prNumber}…
                  </div>
                {/if}
              </div>
            {/if}
          {/each}
        </div>

        {#if composerOutcome}
          <div class="flex shrink-0 items-end gap-2 border-t border-(--solus-accent-border) bg-(--solus-accent-light) px-3 py-2">
            <div class="min-w-0 flex-1">
              <label for="review-mode-summary" class="mb-1 block text-xs font-medium text-(--solus-text-secondary)">
                {composerOutcome === "changes_requested" ? "Why are you requesting changes?" : "Leave a review comment"}
              </label>
              <textarea
                id="review-mode-summary"
                bind:this={composerEl}
                bind:value={composerBody}
                rows="2"
                class="block max-h-28 min-h-14 w-full resize-y rounded-lg border border-(--solus-accent-border) bg-(--solus-container-bg) px-3 py-2 text-xs font-normal text-(--solus-text-primary) outline-none placeholder:text-(--solus-text-tertiary) focus:border-(--solus-accent) focus:ring-2 focus:ring-(--solus-accent-border)"
                placeholder="Review summary…"
                onkeydown={onComposerKeydown}
              ></textarea>
            </div>
            <Button variant="outline" size="sm" onclick={cancelComposer}>Cancel</Button>
            <Button size="sm" disabled={!composerBody.trim()} onclick={submitComposer}>Hold & continue</Button>
          </div>
        {:else}
          <div class="flex min-h-12 shrink-0 items-center gap-1.5 border-t border-(--solus-container-border) px-3">
            <Button
              size="sm"
              disabled={!canApprove()}
              title={isOwnPullRequest() ? "GitHub doesn't allow authors to approve their own pull requests" : undefined}
              onclick={() => disposeCurrent("approved")}
              class="bg-(--solus-status-complete) text-white hover:bg-(--solus-status-complete)/85"
            >
              <CheckCircleIcon data-icon="inline-start" weight="fill" /> Approve <kbd class="ml-1 text-xs opacity-70">a</kbd>
            </Button>
            <Button variant="outline" size="sm" disabled={!canDisposition()} onclick={() => openComposer("changes_requested")} class="text-(--solus-status-error) hover:text-(--solus-status-error)">
              <WarningCircleIcon data-icon="inline-start" /> Request changes <kbd class="ml-1 text-xs opacity-70">r</kbd>
            </Button>
            <Button variant="outline" size="sm" disabled={!canDisposition()} onclick={() => openComposer("commented")}>
              <ChatTextIcon data-icon="inline-start" /> Comment <kbd class="ml-1 text-xs opacity-70">c</kbd>
            </Button>
            <Button variant="ghost" size="sm" disabled={!canDisposition()} onclick={() => disposeCurrent("deferred")} class="text-(--solus-text-tertiary)">
              <ClockIcon data-icon="inline-start" /> Defer <kbd class="ml-1 text-xs opacity-70">d</kbd>
            </Button>
            <span class="ml-auto hidden items-center gap-2 text-xs text-(--solus-text-tertiary) 2xl:flex">
              <span><kbd class="">j</kbd>/<kbd class="">k</kbd> next / prev</span>
              <span><kbd class="">u</kbd> undo</span>
            </span>
          </div>
        {/if}
      </div>
    </div>

  {/if}
</section>
