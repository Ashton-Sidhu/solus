<script lang="ts">
  import { tick, untrack } from "svelte";
  import { fly } from "svelte/transition";
  import { SvelteSet } from "svelte/reactivity";
  import {
    XIcon,
    ArrowLeftIcon,
    GitPullRequestIcon,
    ArrowsClockwiseIcon,
    BookOpenTextIcon,
    CircleNotchIcon,
    PlayIcon,
  } from "phosphor-svelte";
  import type { PullRequestSummary } from "../../../shared/providers";
  import type { IpcContext } from "../../../shared/types";
  import { getWorkspaceContext, getSettingsContext, toasts, runtime, getSessionSidebarStore } from "../../contexts";
  import {
    useKeybinding,
    useScope,
  } from "../../lib/keybindings/use-keybinding.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import * as TooltipUI from "@renderer/components/ui/tooltip";
  import PageShell from "../ui/PageShell.svelte";
  import SearchField from "../ui/search-field";
  import SegmentedControl from "../ui/SegmentedControl.svelte";
  import SortMenu from "../ui/SortMenu.svelte";
  import { Skeleton } from "../ui/skeleton";
  import { Button } from "../ui/button";
  import PageEmpty from "../ui/PageEmpty.svelte";
  import PrListRow from "./PrListRow.svelte";
  import PrProjectSwitcher from "./PrProjectSwitcher.svelte";
  import {
    filterPrs,
    sortPrs,
    prInboxFacts,
    reviewEffortSummary,
    type PrStateFilter,
    type PrSortMode,
  } from "./lib/pr-utils";
  import { groupStackedPrRows } from "./lib/stack-grouping";
  import { getOuterScrollbarContext } from "../layout/lib/outer-scrollbar.context";

  const session = getWorkspaceContext();
  const settings = getSettingsContext();
  const sessionSidebar = getSessionSidebarStore();
  const store = session.prsStore;
  const stacks = session.stacksStore;
  const outerScrollbar = getOuterScrollbarContext();

  const open = $derived(session.prsOpen);

  // ── List state ──
  let query = $state("");
  let stateFilter = $state<PrStateFilter>("open");
  let sortMode = $state<PrSortMode>("updated");
  let searchEl = $state<HTMLInputElement | HTMLTextAreaElement | null>(null);
  let selectedNumber = $state<number | null>(null);
  let listEl = $state<HTMLDivElement | undefined>();
  let stacksReady = $state(false);

  $effect(() => {
    if (!selectedNumber || !outerScrollbar || !listEl) return;
    return outerScrollbar.register(listEl);
  });

  // ── Review multi-select ──
  // Checked PRs narrow the Review action: with any checked, the header button
  // opens Review Mode over just those instead of every filtered PR.
  const reviewSelection = new SvelteSet<number>();

  // ── Project scope ──
  // The inbox is scoped to one project at a time. `null` follows the project
  // currently being worked in (the default); a string pins another project
  // chosen from the switcher. Every PR fetch goes through `prsCtx()` so data
  // and cache keys stay consistent with the chosen project. Review and PR
  // actions use that same context, regardless of which workspace tab is active.
  let selectedProjectPath = $state<string | null>(null);

  const currentProjectPath = $derived(
    sessionSidebar.activeProjectKey === "~"
      ? ""
      : sessionSidebar.activeProjectKey,
  );
  const activeProjectPath = $derived(selectedProjectPath ?? currentProjectPath);
  function prsCtx(): IpcContext {
    return activeProjectPath === currentProjectPath || !activeProjectPath
      ? session.ctx
      : session.ctxForDirectory(activeProjectPath);
  }

  const projectOptions = $derived.by(() => {
    return sessionSidebar.projectBranchGroups
      .filter((project) => project.projectKey !== "~")
      .map((project) => ({
        path: project.projectKey,
        name: project.projectLabel,
      }));
  });

  // ── Detail state ──
  // `activeNumber` is the PR whose canonical secondary review is mounted —
  // debounced apart from `selectedNumber` so arrow navigation highlights
  // instantly without spawning a checkout per keystroke.
  let activeNumber = $state<number | null>(null);

  const SORT_OPTIONS: { value: PrSortMode; label: string }[] = [
    { value: "updated", label: "Updated" },
    { value: "created", label: "Created" },
    { value: "effort", label: "Effort" },
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
    sortPrs(
      filterPrs(
        store.needsReviewOnly
          ? store.items.filter((pr) => pr.needsMyReview)
          : store.items,
        query,
        stateFilter,
      ),
      sortMode,
    ),
  );
  const effortSummary = $derived(reviewEffortSummary(filtered));
  // The masthead's three facts. Open count comes from the whole fetch (so the
  // Closed tab doesn't restate closed PRs as open); the effort clause and the
  // sync stamp are omitted entirely when they'd be a guess — see prInboxFacts.
  const facts = $derived(
    prInboxFacts({
      items: store.items,
      filtered,
      listLoadedAt: store.listLoadedAt,
    }),
  );
  // The repo the inbox is reading. `baseRepo` is per-item and optional, so fall
  // back to the project folder's own name rather than rendering a blank eyebrow.
  const repoLabel = $derived.by(() => {
    const repo = store.items.find((pr) => pr.baseRepo)?.baseRepo;
    if (repo) return `${repo.owner} / ${repo.repo}`;
    return activeProjectPath.split("/").filter(Boolean).pop() ?? "";
  });

  const stackGraph = $derived(settings.stackedPrsEnabled && stacksReady ? stacks.graphFor() : null);
  const groupedRows = $derived(groupStackedPrRows(filtered, stackGraph));
  const listNavigationItems = $derived(groupedRows.map((row) => row.pr));

  const selectedPr = $derived(
    selectedNumber
      ? (store.items.find((p) => p.number === selectedNumber) ?? null)
      : null,
  );
  // With a review open the inbox is a narrow sidebar beside it, so its rows
  // drop to the compact density.
  const dockedInbox = $derived(!!(selectedNumber && selectedPr));

  // ── Data loading ──

  // Opening the page and explicitly targeting a project are the only triggers
  // this effect should react to. `session.ctx` reads reactive git state
  // (gitContext, changedFiles) that the git watcher churns on every on-disk
  // change, so tracking it here would re-fire loadAll (flipping `loading` back
  // on) and wipe the user's selection. Untrack the body so normal git updates
  // cannot reset the page.
  $effect(() => {
    const requestedProjectPath = session.prsProjectTarget?.path ?? null;
    if (!open) return;
    untrack(() => {
      query = "";
      stateFilter = "open";
      sortMode = "updated";
      selectedNumber = null;
      activeNumber = null;
      selectedProjectPath =
        requestedProjectPath && requestedProjectPath !== currentProjectPath
          ? requestedProjectPath
          : null;
      reviewSelection.clear();
      store.filter = { state: "open" };
      void store.loadAll(prsCtx());
      stacksReady = false;
      void stacks.load(prsCtx()).then(
        () => {
          stacksReady = true;
        },
        () => {
          stacksReady = false;
        },
      );
      if (!runtime.shouldSuppressFocus) {
        void tick().then(() => searchEl?.focus());
      }
    });
  });

  // Stack detection can change which cached guide belongs to a PR. Refresh the
  // local metadata after each graph update so target and own-delta guides never
  // borrow one another's timestamp.
  $effect(() => {
    if (!open || !stackGraph) return;
    untrack(() => void store.loadGuideMetadata(prsCtx(), store.items).catch(() => {}));
  });

  $effect(() => {
    const number = activeNumber;
    if (!open || number === null) return;
    const pr = store.get(number);
    if (!pr) return;
    untrack(() => void session.dockPrReview(number, pr.title, { ctx: prsCtx() }));
  });

  // The review owns its close button, while this page owns the selected row and
  // docked-vs-centered layout. Remember the review that reached secondary so
  // closing it can clear the matching selection without mistaking the brief
  // debounce between arrow-key selection and docking for a dismissal.
  let dockedReviewNumber = $state<number | null>(null);
  $effect(() => {
    const secondary = session.panes.secondaryContent;
    const reviewNumber =
      secondary.kind === "pr-review" ? secondary.target.number : null;

    if (reviewNumber !== null) {
      dockedReviewNumber = reviewNumber;
      return;
    }

    const closedReviewNumber = dockedReviewNumber;
    dockedReviewNumber = null;
    if (closedReviewNumber === null || selectedNumber !== closedReviewNumber) return;
    cancelPendingDetail();
    selectedNumber = null;
    activeNumber = null;
  });

  function selectProject(path: string) {
    const next = path === currentProjectPath ? null : path;
    if (next === selectedProjectPath) return;
    selectedProjectPath = next;
    reviewSelection.clear();
    cancelPendingDetail();
    selectedNumber = null;
    activeNumber = null;
    query = "";
    stateFilter = "open";
    store.needsReviewOnly = false;
    store.filter = { state: "open" };
    void store.loadAll(prsCtx());
    stacksReady = false;
    void stacks.load(prsCtx()).then(
      () => {
        stacksReady = true;
      },
      () => {
        stacksReady = false;
      },
    );
    void tick().then(() => searchEl?.focus());
  }

  $effect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = window.solus.onPrsChanged((changedCwd) => {
      if (!open) return;
      const scopedCtx = prsCtx().session;
      const ctxCwd = scopedCtx.projectPath || scopedCtx.workingDirectory;
      if (changedCwd !== ctxCwd) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        refreshList();
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
    // Re-selecting the highlighted row must reopen a review the user closed;
    // assigning the same activeNumber would not retrigger the docking effect.
    void session.dockPrReview(pr.number, pr.title, { ctx: prsCtx() });
    void store.loadEfforts(prsCtx(), [pr.number]);
  }

  function selectPrDebounced(pr: PullRequestSummary) {
    cancelPendingDetail();
    selectedNumber = pr.number;
    void store.loadEfforts(prsCtx(), [pr.number]);
    detailDebounce = setTimeout(() => {
      detailDebounce = null;
      if (selectedNumber === pr.number) activeNumber = pr.number;
    }, 200);
  }

  function deselectPr() {
    const number = selectedNumber;
    cancelPendingDetail();
    selectedNumber = null;
    activeNumber = null;
    const review = session.panes.secondaryContent;
    if (review.kind === "pr-review" && review.target.number === number) {
      session.panes.closeSlot("secondary");
    }
  }

  // Checked PRs in the list order they're shown; stale checks (filtered out or
  // no longer loaded) simply drop out.
  const selected = $derived(
    filtered.filter((pr) => reviewSelection.has(pr.number)),
  );

  function toggleReviewSelect(pr: PullRequestSummary) {
    if (reviewSelection.has(pr.number)) reviewSelection.delete(pr.number);
    else reviewSelection.add(pr.number);
  }

  function clearReviewSelection() {
    reviewSelection.clear();
    requestInputFocus();
  }

  function openReviewMode() {
    const items = selected.length > 0 ? selected : filtered;
    if (items.length === 0) return;
    void session.openReviewMode(items, prsCtx());
  }

  // ── Opt-in guide generation ──
  // Guides no longer generate automatically; this queues them in the
  // background for the checked PRs so they're ready by the time each review
  // opens.
  const guideEligible = $derived(
    selected.filter((pr) => pr.state === "open" && !pr.draft),
  );
  const guidesInFlight = $derived(
    [...store.guideStatus.values()].filter(
      (status) => status === "queued" || status === "generating",
    ).length,
  );

  function generateGuides() {
    const numbers = guideEligible.map((pr) => pr.number);
    if (numbers.length === 0) return;
    const projectPath = activeProjectPath;
    void store
      .requestGuides(prsCtx(), numbers, {
        onSettled: ({ total, failed }) => {
          const toastOptions = {
            action: {
              label: "View",
              onAction: () => session.openPrs(projectPath),
            },
          };
          if (failed > 0) {
            toasts.error(
              failed === total
                ? `Couldn't generate ${total === 1 ? "the review guide" : `${total} review guides`}`
                : `${total - failed} of ${total} review guides ready; ${failed} failed`,
              toastOptions,
            );
            return;
          }
          toasts.success(
            total === 1
              ? `Review guide for PR #${numbers[0]} is ready.`
              : `${total} review guides are ready. Open a pull request to start reviewing.`,
            toastOptions,
          );
        },
      })
      .catch((error) => {
        toasts.error(
          `Couldn't queue review guides: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  function refreshList() {
    store.filter = { state: stateFilter };
    void store.loadAll(prsCtx(), { force: true });
  }

  function onStateFilterChange(state: PrStateFilter) {
    store.needsReviewOnly = false;
    stateFilter = state;
    store.filter = { state };
    void store.loadAll(prsCtx());
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
  function close() {
    if (selectedNumber) deselectPr();
    session.prsOpen = false;
    requestInputFocus();
  }

  async function expandSelectedReview() {
    const pr = selectedPr;
    if (!pr) return;
    await session.dockPrReview(pr.number, pr.title, { ctx: prsCtx() });
    const review = session.panes.secondaryContent;
    if (review.kind === "pr-review" && review.target.number === pr.number) {
      session.panes.maximized = true;
      requestInputFocus();
    }
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
      void expandSelectedReview();
    } else if (
      (e.key === "x" || e.key === "X") &&
      selectedPr
    ) {
      // x checks the highlighted PR for review — keyboard-first multi-select,
      // matching the tasks list.
      e.preventDefault();
      toggleReviewSelect(selectedPr);
    }
  }

  // Viewport-rooted so it works in both homes of the list: the docked pane's
  // own scroller and PageShell's page scroll (clipping ancestors still apply).
  function observeEffort(node: HTMLElement, number: number) {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void store.loadEfforts(prsCtx(), [number]);
          observer.disconnect();
        }
      },
      { rootMargin: "240px 0px" },
    );
    observer.observe(node);
    return { destroy: () => observer.disconnect() };
  }

  // Selecting (or deselecting) a PR swaps the inbox between the centered page
  // and the split pane, remounting the list DOM and dropping focus mid
  // arrow-nav. Restore it after the swap: the highlighted row when entering the
  // split, the search field when returning to the inbox (mirroring page open).
  let wasSplit = false;
  $effect(() => {
    const split = selectedNumber !== null;
    if (split === wasSplit) return;
    wasSplit = split;
    void tick().then(() => {
      if (split) {
        listEl?.querySelector<HTMLElement>('[data-selected="true"]')?.focus();
      } else if (!runtime.shouldSuppressFocus) {
        searchEl?.focus();
      }
    });
  });

  // Auto-load the next page as the list tail approaches. A sentinel (rather
  // than an onscroll handler) because the list scrolls in different containers
  // per mode — the docked pane's own scroller vs PageShell's page scroll.
  function loadMoreSentinel(node: HTMLElement) {
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        if (store.hasMore && !store.loadingMore) void store.loadMore(prsCtx());
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(node);
    return { destroy: () => observer.disconnect() };
  }

  // Skeleton rows fade toward the bottom; widths vary so the shimmer reads as
  // real content rather than a repeated block.
  const SKELETON_ROWS = [88, 64, 76, 52, 70, 60];
</script>

{#snippet inboxRow(pr: PullRequestSummary, stackParent: number | null)}
  <PrListRow
    {pr}
    {stackParent}
    selected={selectedNumber === pr.number}
    checksSummary={store.checksFor(pr.number)}
    checksLoadFailed={store.checksLoadFailed}
    guideMetadata={store.guideMetadataFor(pr.number)}
    guideStatus={store.guideStatusFor(pr.number)}
    selectable
    reviewSelected={reviewSelection.has(pr.number)}
    selectionActive={reviewSelection.size > 0}
    compact={dockedInbox}
    onToggleReviewSelect={() => toggleReviewSelect(pr)}
    onSelect={() => selectPr(pr)}
  />
{/snippet}

{#snippet listBody()}
  <div class="flex flex-col {dockedInbox ? 'px-2.5 pb-4' : 'py-1'}">
    {#if filtered.length > 0}
      <ul class="flex flex-col" role="list" aria-label="Pull requests">
        {#each groupedRows as row (row.pr.number)}
          <li
            class="relative [content-visibility:auto] {dockedInbox
              ? '[contain-intrinsic-size:auto_58px]'
              : '[contain-intrinsic-size:auto_70px]'} {row.depth > 0
              ? 'pl-(--stack-indent)'
              : ''}"
            style="--stack-indent: {row.depth * 1.25}rem"
            use:observeEffort={row.pr.number}
          >
            {#if row.depth > 0}
              <span
                class="pointer-events-none absolute top-0 bottom-1 left-[calc(var(--stack-indent)-0.625rem)] w-px bg-border"
                aria-hidden="true"
              ></span>
              <span
                class="pointer-events-none absolute left-[calc(var(--stack-indent)-0.625rem)] h-px w-3 bg-border {dockedInbox
                  ? 'top-5'
                  : 'top-7'}"
                aria-hidden="true"
              ></span>
            {/if}
            {@render inboxRow(row.pr, row.parent)}
          </li>
        {/each}
      </ul>
      {#if store.hasMore || store.loadingMore}
        <div use:loadMoreSentinel class="h-px" aria-hidden="true"></div>
        <div class="flex items-center justify-center px-3 py-3">
          <Button
            type="button"
            class="inline-flex h-8 cursor-pointer items-center rounded-lg border-0 bg-muted px-3 text-[12.5px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            disabled={store.loadingMore}
            onclick={() => void store.loadMore(prsCtx())}
          >
            {store.loadingMore ? "Loading…" : "Load more pull requests"}
          </Button>
        </div>
      {/if}
    {/if}
  </div>
{/snippet}

{#snippet reviewActions()}
  {#if selected.length > 0}
    <div
      class="flex items-center gap-1.5"
      transition:fly={{ y: -4, duration: 160 }}
    >
      <span
        class="font-mono text-[10px] tabular-nums whitespace-nowrap text-muted-foreground @max-[28rem]:hidden"
      >
        {selected.length} selected
      </span>
      <Button
        type="button"
        class="inline-flex h-[30px] shrink-0 cursor-pointer items-center rounded-lg border-0 bg-transparent px-2 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground @max-[28rem]:hidden"
        onclick={clearReviewSelection}
        aria-label={`Clear ${selected.length} selected pull requests`}
      >
        Clear
      </Button>
      <Button
        type="button"
        class="inline-flex h-[30px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-muted px-2.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        disabled={guideEligible.length === 0}
        onclick={generateGuides}
        aria-label={`Generate ${guideEligible.length} ${guideEligible.length === 1 ? "review guide" : "review guides"} in the background`}
        title={guideEligible.length === 0
          ? "No selected pull requests are eligible for guides"
          : `Generate ${guideEligible.length} ${guideEligible.length === 1 ? "review guide" : "review guides"}`}
      >
        {#if guidesInFlight > 0}
          <CircleNotchIcon
            size={12}
            class="shrink-0 animate-spin [animation-duration:0.9s]"
          />
        {:else}
          <BookOpenTextIcon size={12} class="shrink-0" />
        {/if}
        <span class="@max-[20rem]:sr-only">Guides</span>
      </Button>
      <Button
        type="button"
        onclick={openReviewMode}
        class="inline-flex h-[30px] shrink-0 cursor-pointer items-center gap-2 rounded-lg border-0 bg-primary px-3 text-[12.5px] font-medium text-primary-foreground transition-[filter] duration-100 hover:brightness-[1.07]"
      >
        <PlayIcon size={12} weight="fill" class="shrink-0" />
        <span class="@max-[20rem]:sr-only">Review</span>
      </Button>
    </div>
  {/if}
  <Button
    type="button"
    class="flex size-[30px] shrink-0 cursor-pointer items-center justify-center rounded-lg border border-transparent bg-transparent text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    onclick={refreshList}
    aria-label="Refresh"
    title="Refresh"
  >
    <ArrowsClockwiseIcon
      size={14}
      class={store.loading ? "animate-spin [animation-duration:0.9s]" : ""}
    />
  </Button>
{/snippet}

<!-- ══════════════════════════════════════════════════════════════════════════ -->
<!-- THE INBOX                                                                  -->
<!-- With nothing selected it renders as a centered page (PageShell + its own    -->
<!-- masthead); with a PR open it docks left as this resizable list pane.       -->
<!-- ══════════════════════════════════════════════════════════════════════════ -->
{#snippet inboxPane()}
  <div
    class="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-sidebar"
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
      class="@container shrink-0 px-4 pt-4 pb-3 [.workspace-body.sidebar-collapsed_&]:pt-[calc(var(--solus-titlebar-height,0px)+1rem)]"
    >
      <!-- With a review open, the sidebar's job is getting back out of it: the
             title row becomes the way up, with the visible row count as the
             only other fact. -->
      <div class="flex items-center justify-between gap-2">
        <Button
          type="button"
          class="-ml-1.5 inline-flex min-w-0 cursor-pointer items-center gap-2 rounded-lg border-0 bg-transparent px-1.5 py-1 text-[12.5px] font-medium text-foreground transition-colors hover:bg-muted"
          onclick={deselectPr}
          aria-label="Back to all pull requests"
        >
          <ArrowLeftIcon
            size={12}
            weight="bold"
            class="shrink-0 text-muted-foreground"
          />
          <span class="truncate">All pull requests</span>
        </Button>
        <div class="flex shrink-0 items-center gap-1.5">
          <span
            class="font-mono text-[10px] tabular-nums text-muted-foreground"
          >
            {filtered.length}
          </span>
          {@render reviewActions()}
          <Button
            type="button"
            class="flex size-[30px] shrink-0 cursor-pointer items-center justify-center rounded-lg border border-transparent bg-transparent text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onclick={close}
            aria-label="Close"
          >
            <XIcon size={14} />
          </Button>
        </div>
      </div>

      <div class="mt-3 flex flex-col gap-2">
        <!-- basis-* is restated at the field's own breakpoint: its
             `@max-[44rem]:basis-full` is a separate merge group, and in this
             column flex-basis would set the height. -->
        <SearchField
          bind:ref={searchEl}
          bind:value={query}
          placeholder="Search"
          class="h-[30px] w-full flex-none basis-auto rounded-lg border-0 bg-muted px-2.5 py-0 @max-[44rem]:basis-auto"
        />
        <div class="flex min-w-0 flex-wrap items-center gap-1.5">
          <PrProjectSwitcher
            options={projectOptions}
            activePath={activeProjectPath}
            currentPath={currentProjectPath}
            compact
            onSelect={selectProject}
          />
          {@render filterControls()}
        </div>
      </div>
    </div>

    <!-- PR list body -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      bind:this={listEl}
      class="min-h-0 flex-1 overflow-y-auto overscroll-y-contain"
      class:outer-scroll-source={!!outerScrollbar}
      onkeydown={onListKeydown}
    >
      {@render inboxBody()}
    </div>
  </div>
{/snippet}

<!-- Loading / empty / list states, shared by both homes of the inbox. -->
{#snippet inboxBody()}
      {#if store.loading && filtered.length === 0}
        <div
          class="flex flex-col {dockedInbox ? 'px-2.5 pb-4' : 'py-1'}"
          aria-hidden="true"
        >
          {#each SKELETON_ROWS as width, i (i)}
            <div
              class="flex items-start opacity-(--row-fade) {dockedInbox
                ? 'gap-2.5 px-2.5 py-2.5'
                : 'gap-3.5 px-4 py-3.5'}"
              style="--row-fade: {100 - i * 12}%"
            >
              <Skeleton
                class="mt-px shrink-0 rounded-full bg-muted {dockedInbox
                  ? 'size-5'
                  : 'size-7'}"
              />
              <div class="flex min-w-0 flex-1 flex-col gap-2.5 py-0.5">
                <Skeleton
                  class="h-3 rounded bg-muted w-(--line-w)"
                  style="--line-w: {width}%"
                />
                <Skeleton class="h-2.5 w-28 rounded bg-muted" />
              </div>
            </div>
          {/each}
        </div>
      {:else if store.items.length === 0}
        <PageEmpty icon={GitPullRequestIcon} title="No pull requests yet.">
          Open pull requests from this project's remote will show up here.
          {#snippet actions()}
            <Button
              type="button"
              class="inline-flex h-[34px] cursor-pointer items-center gap-2 rounded-lg border-0 bg-muted px-3 text-[12.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
              onclick={refreshList}
            >
              <ArrowsClockwiseIcon size={13} class="shrink-0" />
              Refresh
            </Button>
          {/snippet}
        </PageEmpty>
      {:else if filtered.length === 0}
        <!-- Filter-miss: the design's washed panel rather than a bare column,
             so the miss reads as a state of the list, not an empty page. -->
        <div
          class="rounded-2xl bg-[color-mix(in_oklab,var(--muted)_50%,transparent)]"
        >
          <PageEmpty title="No pull requests match.">
            Try a different search or switch to All.
            {#snippet actions()}
              <Button
                type="button"
                class="inline-flex h-[34px] cursor-pointer items-center rounded-lg border-0 bg-muted px-3 text-[12.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                onclick={() => {
                  query = "";
                  stateFilter = "open";
                }}
              >
                Clear filters
              </Button>
            {/snippet}
          </PageEmpty>
        </div>
      {:else}
        {@render listBody()}
      {/if}
{/snippet}

<!-- State filter, the needs-review pin, and sort — the cluster both homes of
     the inbox share, after each has placed its own search field. -->
{#snippet filterControls()}
  <SegmentedControl
    variant="bar"
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
  {#if store.needsReviewOnly}
    <Button
      type="button"
      class="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border-0 bg-secondary px-3 text-[12.5px] font-medium text-secondary-foreground transition-colors hover:brightness-[1.05]"
      onclick={() => (store.needsReviewOnly = false)}
      aria-label="Clear the needs-your-review filter"
    >
      Needs your review
      <XIcon size={11} />
    </Button>
  {/if}
  <div class="ml-auto flex shrink-0 items-center gap-2.5">
    <SortMenu
      bind:value={sortMode}
      options={SORT_OPTIONS}
      ariaLabel="Sort pull requests"
      class="h-8 gap-1.5 bg-muted px-2.5 py-0 text-[12.5px] font-normal text-muted-foreground hover:bg-(--solus-surface-active) hover:text-foreground @max-[16rem]:gap-1 @max-[16rem]:px-1.5 @max-[16rem]:text-[11.5px]"
    />
  </div>
{/snippet}

<!-- The centered page's masthead: the repo the inbox is reading, the surface
     name, and three facts that are all true of the data on screen. The action
     cluster sits bottom-aligned against the block so it lands on the facts
     line rather than floating beside the title. -->
{#snippet masthead()}
  <div class="flex items-end justify-between gap-4 pb-[clamp(16px,2vw,28px)]">
    <div class="flex min-w-0 flex-col gap-2">
      <div
        class="flex min-w-0 items-center gap-2 font-mono text-[9.5px] tracking-widest text-muted-foreground uppercase"
      >
        <GitPullRequestIcon size={11} class="shrink-0 text-primary" />
        <span class="min-w-0 truncate">{repoLabel}</span>
      </div>

      <h1 class="text-[26px] font-semibold tracking-[-0.02em]">
        Pull Requests
      </h1>

      <p
        class="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] text-muted-foreground"
      >
        <span class="flex items-center gap-1.5">
          <span
            class="size-1.5 shrink-0 rounded-full bg-(--solus-art-positive)"
            aria-hidden="true"
          ></span>
          <span class="tabular-nums">{facts.openCount} open</span>
        </span>
        {#if facts.effortMinutes !== null && effortSummary}
          <span class="opacity-40" aria-hidden="true">·</span>
          <TooltipUI.Root>
            <TooltipUI.Trigger>
              {#snippet child({ props: tooltipProps })}
                <span {...tooltipProps} class="tabular-nums">
                  ≈ {facts.effortMinutes} min to review
                </span>
              {/snippet}
            </TooltipUI.Trigger>
            <TooltipUI.Content value={`${effortSummary.count} ${effortSummary.count === 1 ? "pull request" : "pull requests"} · about ${effortSummary.minutes} min of review${effortSummary.knownCount < effortSummary.count ? ` (estimate covers ${effortSummary.knownCount})` : ""}`} />
          </TooltipUI.Root>
        {/if}
        {#if facts.syncedLabel}
          <span class="opacity-40" aria-hidden="true">·</span>
          <span class="tabular-nums">{facts.syncedLabel}</span>
        {/if}
      </p>
    </div>

    <div class="mb-0.5 flex shrink-0 items-center gap-1.5">
      {@render reviewActions()}
      <Button
        type="button"
        class="flex size-[30px] shrink-0 cursor-pointer items-center justify-center rounded-lg border border-transparent bg-transparent text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        onclick={close}
        aria-label="Close"
      >
        <XIcon size={14} />
      </Button>
    </div>
  </div>
{/snippet}

{#if open}
  <div
    class="@container relative flex min-h-0 flex-1 overflow-hidden bg-card focus:outline-none"
    role="dialog"
    aria-label="Pull Requests"
    tabindex="-1"
  >
    <!-- The inbox stays in the primary pane. Selecting a PR docks the canonical
         review in WorkspaceBody's secondary pane, so Expand and Chat can change
         placement without destroying or recreating the review surface. -->
    {#if selectedNumber && selectedPr}
      {@render inboxPane()}
    {:else}
      <!-- No selection: the inbox is the standard library page. -->
      <div class="flex min-h-0 min-w-0 flex-1 flex-col">
        <!-- No PageShell close: the masthead owns the action cluster, so the
             page would otherwise carry two close buttons. -->
        <!-- Use the same responsive content measure as the other library pages. -->
        <PageShell>
          {@render masthead()}

          <div class="flex min-w-0 flex-wrap items-center gap-2.5 pt-1 pb-4">
            <PrProjectSwitcher
              options={projectOptions}
              activePath={activeProjectPath}
              currentPath={currentProjectPath}
              onSelect={selectProject}
            />
            <SearchField
              bind:ref={searchEl}
              bind:value={query}
              placeholder="Search pull requests, authors, branches…"
              class="h-8 min-w-0 flex-1 basis-0 rounded-lg border-0 bg-muted px-3 py-0 @max-[44rem]:basis-0"
            />
            {@render filterControls()}
          </div>

          <!-- Rows sit in a slightly narrower gutter than the masthead, so
               each row's hover fill reads as an inset surface rather than a
               full-bleed band. -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="-mx-[clamp(6px,0.4vw,8px)]"
            onkeydown={onListKeydown}
          >
            {@render inboxBody()}
          </div>
        </PageShell>
      </div>
    {/if}
  </div>
{/if}
