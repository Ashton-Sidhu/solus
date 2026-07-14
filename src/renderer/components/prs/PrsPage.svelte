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
    CaretDownIcon,
    CaretUpIcon,
    PlayIcon,
    QueueIcon,
    WarningCircleIcon,
  } from "phosphor-svelte";
  import type {
    PullRequestSummary,
    ReviewThread,
  } from "../../../shared/providers";
  import type {
    MergeMethod,
    MergeOrderMode,
    MergeQueueEntry,
  } from "../../../shared/types";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import {
    useKeybinding,
    useScope,
  } from "../../lib/keybindings/use-keybinding.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { runtime } from "../../contexts/runtime.svelte";
  import { tooltip } from "../../lib/tooltip";
  import SearchField from "../ui/search-field";
  import SegmentedControl from "../ui/SegmentedControl.svelte";
  import SortMenu from "../ui/SortMenu.svelte";
  import Kbd from "../ui/Kbd.svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { Skeleton } from "../ui/skeleton";
  import {
    PAGE_GHOST_BTN,
    PAGE_ICON_BTN,
    PAGE_PRIMARY_BTN,
  } from "../../lib/page-chrome";
  import { ENTRY_STATUS_LABELS } from "../../lib/merge-queue-utils";
  import { frameChrome } from "../../contexts/frame-chrome.store.svelte";
  import ActivityFeed from "../pr-review/ActivityFeed.svelte";
  import type { PrActivityTarget } from "../pr-review/lib/activity-data";
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
  let orderMode = $state<MergeOrderMode>("auto");
  let method = $state<MergeMethod>("merge");
  let methodMenuOpen = $state(false);
  let methodTriggerEl = $state<HTMLButtonElement | null>(null);
  let resolvingNumber = $state<number | null>(null);
  let draggingNumber = $state<number | null>(null);
  let dropTargetNumber = $state<number | null>(null);
  let dropPlacement = $state<"before" | "after">("before");

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

  const METHOD_OPTIONS: { value: MergeMethod; label: string }[] = [
    { value: "merge", label: "Merge commit" },
    { value: "squash", label: "Squash" },
    { value: "rebase", label: "Rebase" },
  ];
  const methodLabel = $derived(
    METHOD_OPTIONS.find((option) => option.value === method)?.label ??
      "Merge commit",
  );

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

  const run = $derived(mergeQueue.state);
  const runActive = $derived(mergeQueue.active);
  const queueNumbers = $derived(
    run && mergeQueue.queued.length === 0
      ? run.entries.map((entry) => entry.number)
      : mergeQueue.queued,
  );
  const queuedPrs = $derived(
    queueNumbers
      .map((number) => store.get(number))
      .filter((pr): pr is PullRequestSummary => !!pr),
  );
  const unqueuedFiltered = $derived(
    filtered.filter((pr) => !queueNumbers.includes(pr.number)),
  );
  const listNavigationItems = $derived([...queuedPrs, ...unqueuedFiltered]);
  const stagedItems = $derived(
    mergeQueue.queued
      .map((number) => store.get(number))
      .filter((pr): pr is PullRequestSummary => !!pr),
  );
  const currentEntry = $derived(
    run && run.currentIndex >= 0
      ? (run.entries[run.currentIndex] ?? null)
      : null,
  );
  const settledCount = $derived(
    run?.entries.filter(
      (entry) =>
        entry.status === "merged" ||
        entry.status === "skipped" ||
        entry.status === "failed",
    ).length ?? 0,
  );
  const mergedCount = $derived(
    run?.entries.filter((entry) => entry.status === "merged").length ?? 0,
  );
  const progressPct = $derived(
    run && run.entries.length > 0
      ? Math.round((settledCount / run.entries.length) * 100)
      : 0,
  );
  const finishedRun = $derived(
    run && (run.status === "done" || run.status === "cancelled"),
  );

  const selectedPr = $derived(
    selectedNumber
      ? (store.items.find((p) => p.number === selectedNumber) ?? null)
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
          host: selectedPr.baseRepo?.host,
          remoteOwner: selectedPr.baseRepo?.owner,
          repo: selectedPr.baseRepo?.repo,
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
      store.filter = { state: "open" };
      void store.loadAll(session.ctx);
      // Catch up on a queue started before this open or from another client.
      void mergeQueue.refresh(session.ctx);
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
      const ctxCwd =
        session.ctx.session.projectPath || session.ctx.session.workingDirectory;
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
    selectedNumber = pr.number;
    activeNumber = pr.number;
  }

  function selectPrDebounced(pr: PullRequestSummary) {
    cancelPendingDetail();
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

  function startQueuedRun() {
    void mergeQueue.start(
      session.ctx,
      stagedItems.map((pr) => ({ number: pr.number, title: pr.title })),
      orderMode,
      method,
    );
  }

  function focusQueue() {
    const number = currentEntry?.number ?? queueNumbers[0];
    if (!number) return;
    const pr = store.get(number);
    if (pr) selectPr(pr);
  }

  function clearQueueDragState() {
    draggingNumber = null;
    dropTargetNumber = null;
    dropPlacement = "before";
  }

  function moveQueuedTo(
    sourceNumber: number,
    targetNumber: number,
    placement: "before" | "after",
  ) {
    if (sourceNumber === targetNumber) return;
    const from = mergeQueue.queued.indexOf(sourceNumber);
    const target = mergeQueue.queued.indexOf(targetNumber);
    if (from < 0 || target < 0) return;

    let destination = target + (placement === "after" ? 1 : 0);
    if (from < destination) destination -= 1;

    let current = from;
    while (current < destination) {
      mergeQueue.move(sourceNumber, 1);
      current += 1;
    }
    while (current > destination) {
      mergeQueue.move(sourceNumber, -1);
      current -= 1;
    }
  }

  function onQueueDragStart(
    e: DragEvent,
    pr: PullRequestSummary,
    queuePos: number,
  ) {
    if (runActive || queuePos < 0) {
      e.preventDefault();
      return;
    }
    draggingNumber = pr.number;
    dropTargetNumber = pr.number;
    dropPlacement = "before";
    e.dataTransfer?.setData("text/plain", String(pr.number));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  }

  function onQueueDragOver(
    e: DragEvent,
    pr: PullRequestSummary,
    queuePos: number,
  ) {
    if (
      runActive ||
      queuePos < 0 ||
      !draggingNumber ||
      draggingNumber === pr.number
    )
      return;
    e.preventDefault();
    const row = e.currentTarget as HTMLElement;
    const rect = row.getBoundingClientRect();
    dropTargetNumber = pr.number;
    dropPlacement = e.clientY < rect.top + rect.height / 2 ? "before" : "after";
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  }

  function onQueueDrop(e: DragEvent, pr: PullRequestSummary, queuePos: number) {
    if (runActive || queuePos < 0) return;
    e.preventDefault();
    const transferred = Number(e.dataTransfer?.getData("text/plain"));
    const sourceNumber =
      draggingNumber ?? (Number.isFinite(transferred) ? transferred : null);
    if (sourceNumber !== null)
      moveQueuedTo(sourceNumber, pr.number, dropPlacement);
    clearQueueDragState();
  }

  async function resolveWithAgent(entry: MergeQueueEntry) {
    resolvingNumber = entry.number;
    try {
      await session.startConflictResolverSession({
        number: entry.number,
        title: entry.title,
      });
    } finally {
      resolvingNumber = null;
    }
    requestInputFocus();
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
      if (selectedNumber) deselectPr();
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
  useKeybinding("prs.queueView", focusQueue, { enabled: () => open });

  function close() {
    session.prsOpen = false;
    requestInputFocus();
  }

  // ── List keyboard nav ──
  function onListKeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const idx = selectedNumber
        ? listNavigationItems.findIndex((p) => p.number === selectedNumber)
        : -1;
      const next =
        e.key === "ArrowDown"
          ? Math.min(idx + 1, listNavigationItems.length - 1)
          : Math.max(idx - 1, 0);
      if (listNavigationItems[next])
        selectPrDebounced(listNavigationItems[next]);
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
    <GitMergeIcon
      size={14}
      weight="bold"
      class="shrink-0 text-(--solus-accent)"
    />
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

{#snippet queueEntryStatus(entry: MergeQueueEntry)}
  {#if entry.status === "merging"}
    <CircleNotchIcon
      size={13}
      class="shrink-0 animate-spin text-(--solus-accent) [animation-duration:0.9s]"
    />
  {:else if entry.status === "conflicts"}
    <WarningCircleIcon
      size={13}
      weight="fill"
      class="shrink-0 text-(--solus-art-negative)"
    />
  {:else if entry.status === "merged"}
    <GitMergeIcon
      size={13}
      weight="bold"
      class="shrink-0 text-(--solus-art-positive)"
    />
  {:else}
    <span
      class="grid size-[13px] shrink-0 place-items-center"
      aria-hidden="true"
    >
      <span class="size-1.5 rounded-full bg-(--solus-art-border)"></span>
    </span>
  {/if}
{/snippet}

{#snippet prListRow(
  pr: PullRequestSummary,
  queuePos: number,
  entry: MergeQueueEntry | null,
)}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="group flex cursor-pointer flex-col rounded-[0.625rem] px-2.5 py-2.5 {selectedNumber ===
    pr.number
      ? 'bg-(--solus-accent-light)'
      : entry?.status === 'merging'
        ? 'bg-[color-mix(in_srgb,var(--solus-accent-light)_72%,transparent)]'
        : 'hover:bg-(--solus-surface-hover)'} {queuePos >= 0 && !runActive
      ? 'cursor-grab active:cursor-grabbing'
      : ''} {draggingNumber === pr.number
      ? 'opacity-45'
      : ''} {dropTargetNumber === pr.number && draggingNumber !== pr.number
      ? dropPlacement === 'before'
        ? 'shadow-[inset_0_0.125rem_0_var(--solus-accent)]'
        : 'shadow-[inset_0_-0.125rem_0_var(--solus-accent)]'
      : ''}"
    role="button"
    tabindex="0"
    draggable={queuePos >= 0 && !runActive}
    onclick={() => selectPr(pr)}
    onkeydown={(e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectPr(pr);
      }
    }}
    ondragstart={(e) => onQueueDragStart(e, pr, queuePos)}
    ondragover={(e) => onQueueDragOver(e, pr, queuePos)}
    ondragleave={() => {
      if (dropTargetNumber === pr.number) dropTargetNumber = null;
    }}
    ondrop={(e) => onQueueDrop(e, pr, queuePos)}
    ondragend={clearQueueDragState}
  >
    <div class="flex items-start gap-2.5">
      {#if queuePos >= 0}
        <span
          class="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-(--solus-accent) text-[0.6875rem] font-semibold tabular-nums text-(--solus-text-on-accent,#fff) shadow-[0_0.0625rem_0.125rem_rgba(0,0,0,0.08)] ring-1 ring-(--solus-accent) dark:shadow-none"
          aria-label={`#${queuePos + 1} in merge queue`}
        >
          {queuePos + 1}
        </span>
      {:else}
        <span class="mt-0.5 inline-flex shrink-0">
          {@render prStateIcon(pr)}
        </span>
      {/if}

      <div class="min-w-0 flex-1">
        <div class="flex min-w-0 items-start gap-2">
          <p
            class="min-w-0 flex-1 text-[0.8125rem] leading-4 font-medium text-(--solus-text-primary) line-clamp-2"
          >
            {pr.title}
          </p>
          {#if entry}
            <span
              class="mt-0.5 inline-flex shrink-0 items-center gap-1 text-[0.625rem] font-medium text-(--solus-text-tertiary)"
              aria-label={ENTRY_STATUS_LABELS[entry.status]}
            >
              {@render queueEntryStatus(entry)}
            </span>
          {/if}
        </div>
        <div
          class="mt-1 flex items-center gap-1.5 text-[0.6875rem] text-(--solus-text-tertiary)"
        >
          <span class="tabular-nums">#{pr.number}</span>
          <span aria-hidden="true">·</span>
          <span class="truncate">{pr.author}</span>
          <span aria-hidden="true">·</span>
          <span class="shrink-0 tabular-nums">{relativeTime(pr.updatedAt)}</span
          >
          {#if pr.draft}
            <span
              class="inline-flex shrink-0 items-center rounded-full bg-(--solus-art-raised) px-1.5 py-px font-medium"
            >
              Draft
            </span>
          {/if}
        </div>
        {#if pr.labels.length > 0}
          <div class="mt-1.5 flex flex-wrap gap-1">
            {#each pr.labels.slice(0, 2) as label (label.name)}
              <span
                class="inline-flex items-center rounded-full px-1.5 py-px text-[0.5625rem] font-medium leading-3"
                style="color: #{label.color}; background: #{label.color}1a;"
              >
                {label.name}
              </span>
            {/each}
          </div>
        {/if}
      </div>

      <div class="flex shrink-0 items-start gap-1">
        {#if pr.additions > 0 || pr.deletions > 0}
          <div
            class="mt-0.5 flex shrink-0 items-center gap-1 text-[0.625rem] tabular-nums"
          >
            <span class="text-(--solus-art-positive)">+{pr.additions}</span>
            <span class="text-(--solus-art-negative)">-{pr.deletions}</span>
          </div>
        {/if}
        {#if pr.state === "open" && !pr.draft && !runActive}
          {#if queuePos >= 0}
            <div
              class="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
            >
              <button
                type="button"
                class="inline-flex size-5 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:opacity-100 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-35"
                disabled={queuePos === 0}
                onclick={(e) => {
                  e.stopPropagation();
                  mergeQueue.move(pr.number, -1);
                }}
                aria-label="Move up"
                use:tooltip={"Move up"}
              >
                <CaretUpIcon size={12} weight="bold" />
              </button>
              <button
                type="button"
                class="inline-flex size-5 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:opacity-100 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-35"
                disabled={queuePos === queueNumbers.length - 1}
                onclick={(e) => {
                  e.stopPropagation();
                  mergeQueue.move(pr.number, 1);
                }}
                aria-label="Move down"
                use:tooltip={"Move down"}
              >
                <CaretDownIcon size={12} weight="bold" />
              </button>
              <button
                type="button"
                class="inline-flex size-5 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:opacity-100 focus-visible:outline-none"
                onclick={(e) => {
                  e.stopPropagation();
                  toggleQueued(pr);
                }}
                aria-label="Remove from merge queue"
                use:tooltip={"Remove from merge queue"}
              >
                <XIcon size={12} />
              </button>
            </div>
          {:else}
            <button
              type="button"
              class="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-(--solus-text-tertiary) opacity-0 group-hover:opacity-100 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:opacity-100 focus-visible:outline-none"
              onclick={(e) => {
                e.stopPropagation();
                toggleQueued(pr);
              }}
              aria-label="Add to merge queue"
              use:tooltip={"Add to merge queue (⌥Q)"}
            >
              <QueueIcon size={13} />
            </button>
          {/if}
        {/if}
      </div>
    </div>

    {#if entry?.status === "conflicts"}
      <div class="mt-2 flex items-center gap-1.5 pl-7 text-[0.6875rem]">
        <span class="min-w-0 flex-1 truncate text-(--solus-text-tertiary)">
          {entry.conflictFiles?.length ?? 0} conflicted
          {(entry.conflictFiles?.length ?? 0) === 1 ? "file" : "files"}
        </span>
        <button
          type="button"
          class="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md border-0 bg-(--solus-accent-light) px-2 py-1 font-medium text-(--solus-accent) hover:bg-(--solus-accent-soft) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] disabled:cursor-not-allowed disabled:opacity-50"
          disabled={resolvingNumber === entry.number}
          onclick={(e) => {
            e.stopPropagation();
            void resolveWithAgent(entry);
          }}
        >
          <GitMergeIcon size={11} weight="bold" class="shrink-0" />
          {resolvingNumber === entry.number ? "Opening…" : "Resolve"}
        </button>
      </div>
    {/if}
  </div>
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
      class="flex w-[22rem] shrink-0 flex-col border-r border-(--solus-popover-border) @min-[84rem]:w-[23.5rem] @max-[44rem]:w-full {selectedNumber
        ? '@max-[44rem]:hidden'
        : ''}"
    >
      <!-- Header -->
      <!-- This header sits in the macOS titlebar band (the page reserves no drag
           strip). When the sidebar is collapsed the frame floats the traffic
           lights and session-expand button over its top-left. Rather than inset
           the content sideways (which shoves the title, search, and filters off
           the left gutter), drop the header below the band so every row stays
           left-aligned and the floating chrome fills the empty strip above — the
           same approach PageShell takes. Open (sidebar covers the band) or off-mac
           collapses back to the tight top gutter. -->
      <div
        class="shrink-0 border-b border-(--solus-popover-border) px-3 pb-3 {frameChrome.sidebarOpen
          ? 'pt-3'
          : 'pt-[max(1.875rem,var(--solus-titlebar-height,0px))]'}"
      >
        <div class="flex items-center justify-between gap-3 pb-2.5">
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
                class={store.loading
                  ? "animate-spin [animation-duration:0.9s]"
                  : ""}
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
            bind:ref={searchEl}
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

        {#if runActive && run}
          <div
            class="mt-3 rounded-[0.625rem] border border-(--solus-accent-border) bg-(--solus-accent-light) p-2"
          >
            <div class="flex items-start gap-2">
              <CircleNotchIcon
                size={14}
                class="mt-0.5 shrink-0 animate-spin text-(--solus-accent) [animation-duration:0.9s]"
              />
              <div class="min-w-0 flex-1">
                <div class="flex items-center justify-between gap-2">
                  <p
                    class="truncate text-[0.75rem] font-semibold text-(--solus-text-primary)"
                  >
                    Merging {run.entries.length} pull {run.entries.length === 1
                      ? "request"
                      : "requests"}
                  </p>
                  <span
                    class="shrink-0 text-[0.625rem] tabular-nums text-(--solus-text-tertiary)"
                  >
                    {mergedCount}/{run.entries.length}
                  </span>
                </div>
                <div
                  class="mt-1.5 h-1 overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--solus-accent)_14%,transparent)]"
                >
                  <div
                    class="h-full rounded-full bg-(--solus-accent) w-(--queue-progress)"
                    style="--queue-progress: {progressPct}%"
                  ></div>
                </div>
                {#if currentEntry}
                  <div
                    class="mt-1.5 flex min-w-0 items-center gap-1.5 text-[0.6875rem]"
                  >
                    <span class="truncate text-(--solus-text-secondary)">
                      {currentEntry.title}
                    </span>
                    <span
                      aria-hidden="true"
                      class="text-(--solus-text-tertiary)">·</span
                    >
                    <span
                      class="shrink-0 font-medium {currentEntry.status ===
                      'conflicts'
                        ? 'text-(--solus-art-negative)'
                        : 'text-(--solus-accent)'}"
                    >
                      {ENTRY_STATUS_LABELS[currentEntry.status]}
                    </span>
                  </div>
                {/if}
              </div>
            </div>
            <div class="mt-2 flex items-center gap-1.5">
              {#if currentEntry?.status === "conflicts"}
                {@const conflictEntry = currentEntry}
                <button
                  type="button"
                  class="inline-flex cursor-pointer items-center gap-1 rounded-md border-0 bg-(--solus-input-pill-bg) px-2 py-1 text-[0.6875rem] font-medium text-(--solus-accent) ring-1 ring-(--solus-accent-border) hover:bg-(--solus-accent-soft) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]"
                  onclick={() => void resolveWithAgent(conflictEntry)}
                >
                  <GitMergeIcon size={11} weight="bold" class="shrink-0" />
                  Resolve with agent
                </button>
                <button
                  type="button"
                  class="{PAGE_GHOST_BTN} px-2 py-1"
                  onclick={() => void mergeQueue.skip(session.ctx)}
                >
                  Skip
                </button>
              {/if}
              <button
                type="button"
                class="{PAGE_GHOST_BTN} ml-auto px-2 py-1"
                onclick={() => void mergeQueue.cancel(session.ctx)}
              >
                Cancel
              </button>
            </div>
          </div>
        {:else if stagedItems.length > 0}
          <div
            class="mt-3 rounded-[0.625rem] border border-(--solus-art-border) bg-(--solus-art-surface) p-2"
          >
            <div class="flex items-center gap-2">
              <QueueIcon
                size={14}
                weight="bold"
                class="shrink-0 text-(--solus-accent)"
              />
              <p
                class="min-w-0 flex-1 truncate text-[0.75rem] font-semibold text-(--solus-text-primary)"
              >
                Merge queue
                <span
                  class="font-medium tabular-nums text-(--solus-text-tertiary)"
                >
                  {stagedItems.length}
                </span>
              </p>
              <button
                type="button"
                class="{PAGE_PRIMARY_BTN} py-1 pl-2 pr-2.5 text-[0.6875rem] disabled:cursor-not-allowed disabled:opacity-50"
                disabled={mergeQueue.starting}
                onclick={startQueuedRun}
              >
                <PlayIcon size={11} weight="fill" class="shrink-0" />
                {mergeQueue.starting ? "Starting…" : "Start"}
              </button>
            </div>
            <div class="mt-2 flex flex-wrap items-center gap-1.5">
              <div
                class="flex shrink-0 items-center gap-0.5 rounded-full bg-(--solus-surface-hover) p-0.5"
                role="group"
                aria-label="Merge order"
              >
                {#each [{ value: "auto" as MergeOrderMode, label: "Auto order" }, { value: "manual" as MergeOrderMode, label: "Queued order" }] as opt (opt.value)}
                  <button
                    type="button"
                    class="inline-flex cursor-pointer items-center rounded-full border-0 px-2 py-1 text-[0.625rem] font-medium focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] {orderMode ===
                    opt.value
                      ? 'bg-(--solus-input-pill-bg) text-(--solus-text-primary) shadow-[0_0.0625rem_0.1875rem_rgba(0,0,0,0.08)] ring-1 ring-black/5 dark:shadow-none dark:ring-white/10'
                      : 'bg-transparent text-(--solus-text-tertiary) hover:text-(--solus-text-secondary)'}"
                    onclick={() => (orderMode = opt.value)}
                    aria-pressed={orderMode === opt.value}
                  >
                    {opt.label}
                  </button>
                {/each}
              </div>
              <div class="relative flex shrink-0 items-center">
                <button
                  type="button"
                  bind:this={methodTriggerEl}
                  class="{PAGE_GHOST_BTN} px-2 py-1"
                  aria-label="Merge method"
                  aria-haspopup="listbox"
                  aria-expanded={methodMenuOpen}
                  onclick={() => (methodMenuOpen = !methodMenuOpen)}
                >
                  <span>{methodLabel}</span>
                  <CaretDownIcon size={9} class="shrink-0" />
                </button>
                <DropdownMenu.Root bind:open={methodMenuOpen}>
                  <DropdownMenu.Content customAnchor={methodTriggerEl} side="bottom" align="start" sideOffset={6} class="w-[180px]">
                  <div class="py-1" role="listbox" aria-label="Merge method">
                    {#each METHOD_OPTIONS as opt (opt.value)}
                      <DropdownMenu.Item
                        class={method === opt.value ? "font-semibold" : undefined}
                        onSelect={() => {
                          method = opt.value;
                          methodMenuOpen = false;
                        }}
                      >
                        <span
                          class="text-[0.6875rem] text-(--solus-text-primary)"
                        >
                          {opt.label}
                        </span>
                      </DropdownMenu.Item>
                    {/each}
                  </div>
                  </DropdownMenu.Content>
                </DropdownMenu.Root>
              </div>
            </div>
            {#if mergeQueue.error}
              <p
                class="mt-2 text-[0.6875rem] leading-4 text-(--solus-art-negative)"
              >
                {mergeQueue.error}
              </p>
            {/if}
          </div>
        {:else if finishedRun && run}
          <div
            class="mt-3 flex items-center gap-2 rounded-[0.625rem] border border-(--solus-art-border) bg-(--solus-art-surface) p-2"
          >
            <GitMergeIcon
              size={14}
              weight="bold"
              class="shrink-0 text-(--solus-art-positive)"
            />
            <p
              class="min-w-0 flex-1 truncate text-[0.75rem] font-medium text-(--solus-text-primary)"
            >
              {run.status === "cancelled"
                ? "Run cancelled"
                : `${mergedCount} merged`}
            </p>
            {#if mergeQueue.failedNumbers.length > 0}
              <button
                type="button"
                class="{PAGE_GHOST_BTN} px-2 py-1"
                onclick={() => mergeQueue.requeueFailed()}
              >
                Re-queue failed
              </button>
            {/if}
            <button
              type="button"
              class="{PAGE_GHOST_BTN} px-2 py-1"
              onclick={() => mergeQueue.clear()}
            >
              Clear
            </button>
          </div>
        {/if}
      </div>

      <!-- PR list body -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        bind:this={listEl}
        class="min-h-0 flex-1 overflow-y-auto overscroll-y-contain [scrollbar-width:thin]"
        onkeydown={onListKeydown}
      >
        {#if store.loading && filtered.length === 0}
          <div class="flex flex-col p-2" aria-hidden="true">
            {#each SKELETON_ROWS as width, i (i)}
              <div
                class="flex items-start gap-2.5 px-2.5 py-3 opacity-(--row-fade)"
                style="--row-fade: {100 - i * 12}%"
              >
                <Skeleton class="mt-px size-3.5 shrink-0 rounded-full bg-(--solus-art-border)" />
                <div class="flex min-w-0 flex-1 flex-col gap-2">
                  <Skeleton
                    class="h-3 rounded bg-(--solus-art-border) w-(--line-w)"
                    style="--line-w: {width}%"
                  />
                  <Skeleton class="h-2.5 w-24 rounded bg-(--solus-art-border)" />
                </div>
              </div>
            {/each}
          </div>
        {:else if store.items.length === 0}
          <div
            class="flex flex-col items-center justify-center gap-1 px-4 py-16 text-center"
          >
            <GitPullRequestIcon
              size={36}
              weight="fill"
              class="mb-3 text-(--solus-text-tertiary) opacity-40"
            />
            <p
              class="text-[0.8125rem] font-semibold text-(--solus-text-primary)"
            >
              No pull requests
            </p>
          </div>
        {:else if filtered.length === 0 && queuedPrs.length === 0}
          <div
            class="flex flex-col items-center justify-center gap-1 px-4 py-16 text-center"
          >
            <p
              class="text-[0.8125rem] font-semibold text-(--solus-text-primary)"
            >
              No matches
            </p>
            <p class="text-[0.75rem] text-(--solus-text-tertiary)">
              Try a different search or filter.
            </p>
          </div>
        {:else}
          <div class="flex flex-col p-2">
            {#if queuedPrs.length > 0}
              <div
                class="px-2.5 pt-1 pb-1 text-[0.625rem] font-medium tracking-wide text-(--solus-text-tertiary)"
              >
                Queued
              </div>
              <ol
                class="flex flex-col"
                role="list"
                aria-label="Queued pull requests"
              >
                {#each queuedPrs as pr, i (pr.number)}
                  <li class="relative">
                    {#if i < queuedPrs.length - 1}
                      <span
                        class="pointer-events-none absolute top-8 bottom-0 left-[1.375rem] w-px bg-(--solus-art-border)"
                        aria-hidden="true"
                      ></span>
                    {/if}
                    {@render prListRow(
                      pr,
                      i,
                      run?.entries.find(
                        (entry) => entry.number === pr.number,
                      ) ?? null,
                    )}
                  </li>
                {/each}
              </ol>
            {/if}
            {#if unqueuedFiltered.length > 0}
              {#if queuedPrs.length > 0}
                <div
                  class="px-2.5 pt-3 pb-1 text-[0.625rem] font-medium tracking-wide text-(--solus-text-tertiary)"
                >
                  Open
                </div>
              {/if}
              <ul class="flex flex-col" role="list" aria-label="Pull requests">
                {#each unqueuedFiltered as pr (pr.number)}
                  <li>
                    {@render prListRow(pr, -1, null)}
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/if}
      </div>
    </div>

    <!-- ════════════════════════════════════════════════════════════════════════ -->
    <!-- RIGHT PANE: PR DETAIL                                                   -->
    <!-- ════════════════════════════════════════════════════════════════════════ -->
    {#if selectedNumber && selectedPr}
      <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
        <!-- Detail header breadcrumb -->
        <div
          class="flex shrink-0 items-center justify-between gap-3 border-b border-(--solus-popover-border) px-4 py-2"
        >
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
                <span class="text-(--solus-art-positive)"
                  >+{selectedPr.additions}</span
                >
                <span class="text-(--solus-art-negative)"
                  >-{selectedPr.deletions}</span
                >
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
              showRemoteLink
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
      <div
        class="hidden min-w-0 flex-1 items-center justify-center @min-[44rem]:flex"
      >
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
          <div
            class="mt-3.5 flex items-center gap-3.5 text-[0.6875rem] text-(--solus-text-tertiary)"
          >
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
