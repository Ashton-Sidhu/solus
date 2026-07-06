<script lang="ts">
  import { tick, untrack } from "svelte";
  import {
    XIcon,
    CircleNotchIcon,
    GitPullRequestIcon,
    GitMergeIcon,
    GitBranchIcon,
    ArrowsClockwiseIcon,
    ArrowLeftIcon,
    ArrowSquareOutIcon,
    QueueIcon,
  } from "phosphor-svelte";
  import type { PullRequestSummary, ReviewThread } from "../../../shared/providers";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import {
    useKeybinding,
    useScope,
  } from "../../lib/keybindings/use-keybinding.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { runtime } from "../../contexts/runtime.svelte";
  import { tooltip } from "../../lib/tooltip";
  import SearchField from "../ui/SearchField.svelte";
  import SegmentedControl from "../ui/SegmentedControl.svelte";
  import SortMenu from "../ui/SortMenu.svelte";
  import Kbd from "../ui/Kbd.svelte";
  import { PAGE_ICON_BTN } from "../../lib/page-chrome";
  import ActivityFeed from "../pr-review/ActivityFeed.svelte";
  import type { PrActivityTarget } from "../pr-review/lib/activity-data";
  import MergeQueueTrigger from "./MergeQueueTrigger.svelte";
  import MergeQueueView from "./MergeQueueView.svelte";
  import {
    filterPrs,
    sortPrs,
    relativeTime,
    type PrStateFilter,
    type PrSortMode,
  } from "./lib/pr-utils";

  const session = getWorkspaceContext();
  const store = session.prsStore;
  const mergeQueue = session.mergeQueueStore;

  const open = $derived(session.prsOpen);

  // ── List state ──
  let query = $state("");
  let stateFilter = $state<PrStateFilter>("open");
  let sortMode = $state<PrSortMode>("updated");
  let searchEl = $state<HTMLInputElement | HTMLTextAreaElement | null>(null);
  let selectedNumber = $state<number | null>(null);
  let listEl = $state<HTMLDivElement | undefined>();
  /** The merge queue's dedicated view, shown in the main pane instead of a PR. */
  let queueViewOpen = $state(false);

  // ── Detail state ──
  // The detail pane renders the shared <ActivityFeed> (same view as the review
  // pane); it fetches its own detail/commits/reviewers/files. `activeNumber` is
  // the PR whose feed is mounted — debounced apart from `selectedNumber` so
  // arrow-nav highlights instantly without spawning a fetch per keystroke.
  let activeNumber = $state<number | null>(null);
  let reviewThreads = $state<ReviewThread[]>([]);

  const SORT_OPTIONS: { value: PrSortMode; label: string }[] = [
    { value: "updated", label: "Updated" },
    { value: "created", label: "Created" },
  ];

  const STATE_TABS: { value: PrStateFilter; label: string }[] = [
    { value: "open", label: "Open" },
    { value: "closed", label: "Closed" },
    { value: "all", label: "All" },
  ];

  const counts = $derived.by(() => {
    let openCount = 0;
    let closed = 0;
    for (const pr of store.items) {
      if (pr.state === "open") openCount++;
      else closed++;
    }
    return { all: store.items.length, open: openCount, closed };
  });

  const filtered = $derived(
    sortPrs(filterPrs(store.items, query, stateFilter), sortMode),
  );

  const selectedPr = $derived(
    selectedNumber
      ? store.items.find((p) => p.number === selectedNumber) ?? null
      : null,
  );

  // The minimal identity <ActivityFeed> needs; it fetches the rest from `detail`.
  // Author + avatar come straight from the list summary so the header paints
  // before the detail request resolves.
  const activityTarget = $derived<PrActivityTarget | null>(
    activeNumber && selectedPr && selectedPr.number === activeNumber
      ? {
          number: selectedPr.number,
          title: selectedPr.title,
          owner: selectedPr.author,
          authorAvatarUrl: selectedPr.authorAvatarUrl,
        }
      : null,
  );

  // ── Data loading ──

  // Open is the only trigger this effect should react to. `session.ctx` reads
  // reactive git state (gitContext, changedFiles) that the git watcher churns on
  // every on-disk change, so tracking it here would re-run the open-effect on
  // each broadcast — re-firing loadAll (flipping `loading` back on) and wiping
  // the user's selection, which reads as a frozen, forever-loading page. Untrack
  // the body so the page resets filters and loads exactly once per open, matching
  // the command palette's PR-list effect.
  $effect(() => {
    if (!open) return;
    untrack(() => {
      query = "";
      stateFilter = "open";
      sortMode = "updated";
      selectedNumber = null;
      activeNumber = null;
      queueViewOpen = false;
      store.filter = { state: "open" };
      void store.loadAll(session.ctx);
      // Catch up on a queue started before this open (or from another client) —
      // and if a run is in flight, land straight on the queue view.
      void mergeQueue.refresh(session.ctx).then(() => {
        if (mergeQueue.active) queueViewOpen = true;
      });
      if (!runtime.shouldSuppressFocus) {
        void tick().then(() => searchEl?.focus());
      }
    });
  });

  function toggleQueued(pr: PullRequestSummary) {
    if (pr.state !== "open" || pr.draft) return;
    mergeQueue.toggle(pr.number);
  }

  // Existing inline review threads for the mounted PR, shared with <ActivityFeed>
  // (which owns reply/resolve, mutating these in place — same as the review pane).
  function loadThreads(n: number, force = false) {
    void store
      .loadThreads(session.ctx, n, { force })
      .then((t) => {
        if (activeNumber === n) reviewThreads = t;
      })
      .catch(() => {});
  }
  $effect(() => {
    const n = activeNumber;
    reviewThreads = [];
    if (n) loadThreads(n);
  });

  $effect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = window.solus.onPrsChanged((changedCwd) => {
      if (!open) return;
      const ctxCwd = session.ctx.session.projectPath || session.ctx.session.workingDirectory;
      if (changedCwd !== ctxCwd) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        refreshList();
        if (activeNumber) loadThreads(activeNumber, true);
      }, 500);
    });
    return () => {
      unsub();
      clearTimeout(timer);
    };
  });

  // Mounting <ActivityFeed> fires its own GitHub fetches. Arrow nav fires one
  // selection per keystroke, so mounting eagerly spams the API and trips
  // GitHub's rate limit. Highlight (`selectedNumber`) immediately, but debounce
  // the mount (`activeNumber`) so only the PR you land on actually loads.
  let detailDebounce: ReturnType<typeof setTimeout> | null = null;

  function cancelPendingDetail() {
    if (detailDebounce) {
      clearTimeout(detailDebounce);
      detailDebounce = null;
    }
  }

  function selectPr(pr: PullRequestSummary) {
    cancelPendingDetail();
    queueViewOpen = false;
    selectedNumber = pr.number;
    activeNumber = pr.number;
  }

  function selectPrDebounced(pr: PullRequestSummary) {
    cancelPendingDetail();
    queueViewOpen = false;
    selectedNumber = pr.number;
    detailDebounce = setTimeout(() => {
      detailDebounce = null;
      if (selectedNumber === pr.number) activeNumber = pr.number;
    }, 200);
  }

  function deselectPr() {
    cancelPendingDetail();
    selectedNumber = null;
    activeNumber = null;
  }

  function openReview() {
    if (!selectedNumber || !selectedPr) return;
    void session.enterPrReview(selectedNumber, selectedPr.title);
  }

  function toggleQueueView() {
    queueViewOpen = !queueViewOpen;
    if (queueViewOpen) deselectPr();
  }

  function refreshList() {
    store.filter = { state: stateFilter };
    void store.loadAll(session.ctx, { force: true });
  }

  function onStateFilterChange(state: PrStateFilter) {
    stateFilter = state;
    store.filter = { state };
    void store.loadAll(session.ctx);
  }

  // ── Keybindings ──
  useScope("prs", { active: () => open });
  useKeybinding(
    "prs.close",
    () => {
      if (queueViewOpen) queueViewOpen = false;
      else if (selectedNumber) deselectPr();
      else close();
    },
    { enabled: () => open },
  );
  useKeybinding(
    "prs.queue",
    () => {
      if (selectedPr) toggleQueued(selectedPr);
    },
    { enabled: () => open && !!selectedPr },
  );
  useKeybinding("prs.queueView", toggleQueueView, { enabled: () => open });

  function close() {
    session.prsOpen = false;
    requestInputFocus();
  }

  // ── List keyboard nav ──
  function onListKeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const idx = selectedNumber
        ? filtered.findIndex((p) => p.number === selectedNumber)
        : -1;
      const next =
        e.key === "ArrowDown"
          ? Math.min(idx + 1, filtered.length - 1)
          : Math.max(idx - 1, 0);
      if (filtered[next]) selectPrDebounced(filtered[next]);
    } else if (e.key === "Enter" && selectedNumber) {
      openReview();
    }
  }

  // Skeleton rows fade toward the bottom; widths vary so the shimmer reads as
  // real content rather than a repeated block.
  const SKELETON_ROWS = [88, 64, 76, 52, 70, 60];
</script>

{#snippet prStateIcon(pr: PullRequestSummary)}
  {#if pr.state === "merged"}
    <GitMergeIcon size={14} weight="bold" class="shrink-0 text-(--solus-accent)" />
  {:else if pr.state === "closed"}
    <GitPullRequestIcon
      size={14}
      weight="bold"
      class="shrink-0 text-(--solus-art-negative)"
    />
  {:else if pr.draft}
    <GitBranchIcon
      size={14}
      weight="bold"
      class="shrink-0 text-(--solus-text-tertiary)"
    />
  {:else}
    <GitPullRequestIcon
      size={14}
      weight="bold"
      class="shrink-0 text-(--solus-art-positive)"
    />
  {/if}
{/snippet}

{#if open}
  <div
    class="@container relative flex min-h-0 flex-1 overflow-hidden bg-(--solus-container-bg) focus:outline-none"
    role="dialog"
    aria-label="Pull Requests"
    tabindex="-1"
  >
    <!-- ════════════════════════════════════════════════════════════════════════ -->
    <!-- LEFT PANE: PR LIST                                                      -->
    <!-- ════════════════════════════════════════════════════════════════════════ -->
    <div
      class="flex w-[20rem] shrink-0 flex-col border-r border-(--solus-popover-border) @max-[44rem]:w-full {selectedNumber || queueViewOpen ? '@max-[44rem]:hidden' : ''}"
    >
      <!-- Header -->
      <div class="shrink-0 border-b border-(--solus-popover-border) pr-3 pl-[max(0.75rem,var(--solus-chrome-lead-inset,0px))] pt-3 pb-3">
        <div class="flex items-center justify-between gap-3 pb-2.5 pl-1">
          <div class="flex min-w-0 items-center gap-2.5">
            <span
              class="grid size-7 shrink-0 place-items-center rounded-lg bg-(--solus-accent-light) text-(--solus-accent)"
              aria-hidden="true"
            >
              <GitPullRequestIcon size={14} weight="fill" />
            </span>
            <h1
              class="truncate text-[0.8125rem] font-semibold tracking-[-0.01em] text-(--solus-text-primary)"
            >
              Pull Requests
            </h1>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <button
              type="button"
              class={PAGE_ICON_BTN}
              onclick={refreshList}
              aria-label="Refresh"
              use:tooltip={"Refresh"}
            >
              <ArrowsClockwiseIcon
                size={14}
                class={store.loading ? "animate-spin [animation-duration:0.9s]" : ""}
              />
            </button>
            <button
              type="button"
              class={PAGE_ICON_BTN}
              onclick={close}
              aria-label="Close"
            >
              <XIcon size={16} />
            </button>
          </div>
        </div>

        <!-- Search + filters -->
        <div class="flex min-w-0 items-center">
          <SearchField
            bind:el={searchEl}
            bind:value={query}
            placeholder="Search pull requests…"
          />
        </div>
        <div class="mt-2 flex flex-wrap items-center gap-1.5">
          <SegmentedControl
            options={STATE_TABS.map((t) => ({
              ...t,
              // Items are fetched per state filter, so only the active tab's
              // count reflects reality — the others would read as zero.
              count: stateFilter === t.value ? counts[t.value] : undefined,
            }))}
            isActive={(v) => stateFilter === v}
            onSelect={onStateFilterChange}
            ariaLabel="Filter by state"
          />
          <div class="ml-auto">
            <SortMenu
              bind:value={sortMode}
              options={SORT_OPTIONS}
              ariaLabel="Sort pull requests"
            />
          </div>
        </div>
      </div>

      <!-- PR list body -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        bind:this={listEl}
        class="min-h-0 flex-1 overflow-y-auto overscroll-y-contain [scrollbar-width:thin]"
        onkeydown={onListKeydown}
      >
        {#if store.loading && filtered.length === 0}
          <div class="flex animate-pulse flex-col p-2 motion-reduce:animate-none" aria-hidden="true">
            {#each SKELETON_ROWS as width, i (i)}
              <div
                class="flex items-start gap-2.5 px-2.5 py-3 opacity-(--row-fade)"
                style="--row-fade: {100 - i * 12}%"
              >
                <span class="mt-px size-3.5 shrink-0 rounded-full bg-(--solus-art-border)"></span>
                <div class="flex min-w-0 flex-1 flex-col gap-2">
                  <span
                    class="h-3 rounded bg-(--solus-art-border) w-(--line-w)"
                    style="--line-w: {width}%"
                  ></span>
                  <span class="h-2.5 w-24 rounded bg-(--solus-art-border)"></span>
                </div>
              </div>
            {/each}
          </div>
        {:else if store.items.length === 0}
          <div class="flex flex-col items-center justify-center gap-1 px-4 py-16 text-center">
            <GitPullRequestIcon
              size={36}
              weight="fill"
              class="mb-3 text-(--solus-text-tertiary) opacity-40"
            />
            <p class="text-[0.8125rem] font-semibold text-(--solus-text-primary)">
              No pull requests
            </p>
            <p class="max-w-[18rem] text-[0.75rem] leading-relaxed text-(--solus-text-tertiary)">
              Connect a GitHub repo to see pull requests here.
            </p>
          </div>
        {:else if filtered.length === 0}
          <div class="flex flex-col items-center justify-center gap-1 px-4 py-16 text-center">
            <p class="text-[0.8125rem] font-semibold text-(--solus-text-primary)">
              No matches
            </p>
            <p class="text-[0.75rem] text-(--solus-text-tertiary)">
              Try a different search or filter.
            </p>
          </div>
        {:else}
          <ul class="flex flex-col p-2" role="list" aria-label="Pull requests">
            {#each filtered as pr (pr.number)}
              <li>
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <div
                  class="group flex cursor-pointer items-start gap-2.5 rounded-[0.625rem] px-2.5 py-2.5 transition-colors duration-100 {selectedNumber ===
                  pr.number
                    ? 'bg-(--solus-accent-light)'
                    : 'hover:bg-(--solus-surface-hover)'}"
                  role="button"
                  tabindex="0"
                  onclick={() => selectPr(pr)}
                  onkeydown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      selectPr(pr);
                    }
                  }}
                >
                  <span class="mt-0.5 inline-flex shrink-0">
                    {@render prStateIcon(pr)}
                  </span>
                  <div class="min-w-0 flex-1">
                    <p class="min-w-0 text-[0.8125rem] leading-snug font-medium text-(--solus-text-primary) line-clamp-2">
                      {pr.title}
                    </p>
                    <div class="mt-1 flex items-center gap-1.5 text-[0.6875rem] text-(--solus-text-tertiary)">
                      <span class="tabular-nums">#{pr.number}</span>
                      <span aria-hidden="true">·</span>
                      <span class="truncate">{pr.author}</span>
                      <span aria-hidden="true">·</span>
                      <span class="shrink-0 tabular-nums">{relativeTime(pr.updatedAt)}</span>
                      {#if pr.draft}
                        <span class="inline-flex shrink-0 items-center rounded-full bg-(--solus-art-raised) px-1.5 py-px font-medium">
                          Draft
                        </span>
                      {/if}
                    </div>
                    {#if pr.labels.length > 0}
                      <div class="mt-1.5 flex flex-wrap gap-1">
                        {#each pr.labels.slice(0, 3) as label (label.name)}
                          <span
                            class="inline-flex items-center rounded-full px-1.5 py-px text-[0.5625rem] font-medium leading-tight"
                            style="color: #{label.color}; background: #{label.color}1a;"
                          >
                            {label.name}
                          </span>
                        {/each}
                      </div>
                    {/if}
                  </div>
                  {#if pr.additions > 0 || pr.deletions > 0}
                    <div class="mt-0.5 flex shrink-0 items-center gap-1 text-[0.625rem] tabular-nums">
                      <span class="text-(--solus-art-positive)">+{pr.additions}</span>
                      <span class="text-(--solus-art-negative)">-{pr.deletions}</span>
                    </div>
                  {/if}
                  {#if pr.state === "open" && !pr.draft}
                    {@const queuePos = mergeQueue.queued.indexOf(pr.number)}
                    <button
                      type="button"
                      class="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent transition-[background-color,color,opacity] duration-100 focus-visible:opacity-100 {queuePos >= 0
                        ? ''
                        : 'text-(--solus-text-tertiary) opacity-0 group-hover:opacity-100 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)'}"
                      onclick={(e) => {
                        e.stopPropagation();
                        toggleQueued(pr);
                      }}
                      aria-pressed={queuePos >= 0}
                      aria-label={queuePos >= 0
                        ? "Remove from merge queue"
                        : "Add to merge queue"}
                      use:tooltip={queuePos >= 0
                        ? `#${queuePos + 1} in merge queue — click to remove`
                        : "Add to merge queue (⌥Q)"}
                    >
                      {#if queuePos >= 0}
                        <span
                          class="grid size-4 place-items-center rounded-full bg-(--solus-accent) text-[0.5625rem] font-semibold tabular-nums text-(--solus-on-accent,#fff)"
                        >
                          {queuePos + 1}
                        </span>
                      {:else}
                        <QueueIcon size={13} />
                      {/if}
                    </button>
                  {/if}
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      <MergeQueueTrigger active={queueViewOpen} onclick={toggleQueueView} />
    </div>

    <!-- ════════════════════════════════════════════════════════════════════════ -->
    <!-- RIGHT PANE: MERGE QUEUE / PR DETAIL                                     -->
    <!-- ════════════════════════════════════════════════════════════════════════ -->
    {#if queueViewOpen}
      <MergeQueueView onClose={() => (queueViewOpen = false)} />
    {:else if selectedNumber && selectedPr}
      <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
        <!-- Detail header breadcrumb -->
        <div class="flex shrink-0 items-center justify-between gap-3 border-b border-(--solus-popover-border) px-4 py-2">
          <div class="flex min-w-0 items-center gap-2 text-[0.8125rem]">
            <button
              type="button"
              class="{PAGE_ICON_BTN} @min-[44rem]:hidden"
              onclick={deselectPr}
              aria-label="Back to list"
            >
              <ArrowLeftIcon size={14} />
            </button>
            {@render prStateIcon(selectedPr)}
            <span class="truncate font-medium text-(--solus-text-primary)">
              {selectedPr.title}
            </span>
            <span class="shrink-0 text-(--solus-text-tertiary) tabular-nums">
              #{selectedPr.number}
            </span>
            {#if selectedPr.additions > 0 || selectedPr.deletions > 0}
              <span class="shrink-0 text-[0.6875rem] tabular-nums">
                <span class="text-(--solus-art-positive)">+{selectedPr.additions}</span>
                <span class="text-(--solus-art-negative)">-{selectedPr.deletions}</span>
              </span>
            {/if}
          </div>
          <div class="flex shrink-0 items-center gap-1.5">
            {#if selectedPr.state === "open" && !selectedPr.draft}
              {@const queued = mergeQueue.isQueued(selectedPr.number)}
              <button
                type="button"
                class="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border-0 px-2.5 py-[0.3125rem] text-[0.6875rem] font-semibold transition-[background-color,color] duration-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] {queued
                  ? 'bg-(--solus-accent-light) text-(--solus-accent)'
                  : 'bg-transparent text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)'}"
                onclick={() => toggleQueued(selectedPr)}
                aria-pressed={queued}
                use:tooltip={queued
                  ? "Remove from merge queue (⌥Q)"
                  : "Add to merge queue (⌥Q)"}
              >
                <QueueIcon size={13} weight={queued ? "fill" : "bold"} />
                <span>{queued ? "Queued" : "Queue"}</span>
              </button>
            {/if}
            <button
              type="button"
              class="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-(--solus-accent-light) px-2.5 py-[0.3125rem] text-[0.6875rem] font-semibold text-(--solus-accent) transition-[background-color] duration-100 hover:bg-[color-mix(in_srgb,var(--solus-accent-light)_100%,var(--solus-accent)_14%)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]"
              onclick={openReview}
            >
              <ArrowSquareOutIcon size={13} weight="bold" />
              <span>Review</span>
            </button>
          </div>
        </div>

        <!-- Detail body: the shared PR activity view — the same <ActivityFeed>
             the review pane renders, so the list preview and the full review
             never drift. It fetches its own detail/commits/reviewers/files. -->
        {#if activityTarget}
          {#key activityTarget.number}
            <ActivityFeed
              pr={activityTarget}
              threads={reviewThreads}
              onRefreshThreads={() =>
                activeNumber !== null && loadThreads(activeNumber, true)}
              onJump={() => openReview()}
            />
          {/key}
        {:else}
          <div class="flex h-full min-h-0 items-center justify-center">
            <CircleNotchIcon
              size={20}
              class="animate-spin text-(--solus-text-tertiary) [animation-duration:0.9s]"
            />
          </div>
        {/if}
      </div>
    {:else}
      <!-- Empty detail pane -->
      <div class="hidden min-w-0 flex-1 items-center justify-center @min-[44rem]:flex">
        <div class="flex flex-col items-center gap-1 px-6 text-center">
          <GitPullRequestIcon
            size={32}
            weight="fill"
            class="mb-2 text-(--solus-text-tertiary) opacity-30"
          />
          <p class="text-[0.8125rem] font-semibold text-(--solus-text-primary)">
            No pull request selected
          </p>
          <p class="text-[0.75rem] text-(--solus-text-tertiary)">
            Pick one from the list to see its activity.
          </p>
          <div class="mt-3.5 flex items-center gap-3.5 text-[0.6875rem] text-(--solus-text-tertiary)">
            <span class="inline-flex items-center gap-1.5">
              <Kbd variant="hint">↑↓</Kbd> navigate
            </span>
            <span class="inline-flex items-center gap-1.5">
              <Kbd variant="hint">↵</Kbd> review
            </span>
            <span class="inline-flex items-center gap-1.5">
              <Kbd variant="hint">⌥Q</Kbd> queue
            </span>
          </div>
        </div>
      </div>
    {/if}
  </div>
{/if}
