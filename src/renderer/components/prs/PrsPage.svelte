<script lang="ts">
  import { tick, untrack } from "svelte";
  import {
    XIcon,
    MagnifyingGlassIcon,
    CircleNotchIcon,
    GitPullRequestIcon,
    ArrowsClockwiseIcon,
    CaretDownIcon,
    QueueIcon,
  } from "phosphor-svelte";
  import type {
    PullRequestSummary,
    PullRequestDetail,
    PrCommit,
    PrReviewer,
  } from "../../../shared/providers";
  import type { ChangedFileStat } from "../../../shared/types";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import {
    useKeybinding,
    useScope,
  } from "../../lib/keybindings/use-keybinding.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { runtime } from "../../contexts/runtime.svelte";
  import { tooltip } from "../../lib/tooltip";
  import Input from "../ui/Input.svelte";
  import Dropdown from "../ui/Dropdown.svelte";
  import DropdownItem from "../ui/DropdownItem.svelte";
  import PrDetailPane from "./PrDetailPane.svelte";
  import PrStateIcon from "./PrStateIcon.svelte";
  import MergeQueuePanel from "./MergeQueuePanel.svelte";
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
  let sortMenuOpen = $state(false);
  let sortTriggerEl = $state<HTMLButtonElement | null>(null);
  let searchEl = $state<HTMLInputElement | HTMLTextAreaElement | null>(null);
  let selectedNumber = $state<number | null>(null);
  let listEl = $state<HTMLDivElement | undefined>();

  // ── Detail state ──
  let detail = $state<PullRequestDetail | null>(null);
  let commits = $state<PrCommit[]>([]);
  let reviewers = $state<PrReviewer[]>([]);
  let changedFiles = $state<ChangedFileStat[]>([]);
  let detailLoading = $state(false);
  let commitsLoading = $state(false);
  let reviewersLoading = $state(false);
  let filesLoading = $state(false);
  // Provider failures are shown explicitly (with retry) instead of reading as
  // "no pull requests" / an empty detail pane.
  let listLoadFailed = $state(false);
  let detailLoadFailed = $state(false);

  const SORT_OPTIONS: { value: PrSortMode; label: string }[] = [
    { value: "updated", label: "Updated" },
    { value: "created", label: "Created" },
  ];

  const sortLabel = $derived(
    SORT_OPTIONS.find((o) => o.value === sortMode)?.label ?? "",
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

  const selectedPr = $derived(
    selectedNumber
      ? store.items.find((p) => p.number === selectedNumber) ?? null
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
      detail = null;
      store.filter = { state: "open" };
      loadList();
      // Catch up on a queue started before this open (or from another client).
      void mergeQueue.refresh(session.ctx);
      if (!runtime.shouldSuppressFocus) {
        void tick().then(() => searchEl?.focus());
      }
    });
  });

  function loadList(force = false) {
    listLoadFailed = false;
    void store.loadAll(session.ctx, { force }).catch(() => {
      listLoadFailed = true;
    });
  }

  // A finished run changes PR states (merged PRs leave the open list) — reload.
  let lastRunStatus: string | null = null;
  $effect(() => {
    const status = mergeQueue.state?.status ?? null;
    if (status === lastRunStatus) return;
    const wasActive = lastRunStatus === "running" || lastRunStatus === "waiting";
    lastRunStatus = status;
    if (wasActive && (status === "done" || status === "cancelled")) {
      loadList(true);
    }
  });

  function toggleQueued(pr: PullRequestSummary) {
    if (pr.state !== "open" || pr.draft) return;
    mergeQueue.toggle(pr.number);
  }

  function loadDetail(number: number) {
    const n = number;
    detail = null;
    commits = [];
    reviewers = [];
    changedFiles = [];
    detailLoadFailed = false;
    detailLoading = commitsLoading = reviewersLoading = filesLoading = true;

    store
      .loadOverview(session.ctx, n)
      .then((overview) => {
        if (selectedNumber === n) {
          detail = overview.detail;
          commits = overview.commits;
          reviewers = overview.reviewers;
          commitsLoading = false;
          reviewersLoading = false;
          window.solus
            .prChangedFiles(session.ctx, overview.detail.baseSha)
            .then((f) => {
              if (selectedNumber === n) changedFiles = f;
            })
            .catch(() => {
              if (selectedNumber === n) detailLoadFailed = true;
            })
            .finally(() => {
              if (selectedNumber === n) filesLoading = false;
            });
        }
      })
      .catch(() => {
        if (selectedNumber === n) detailLoadFailed = true;
      })
      .finally(() => {
        if (selectedNumber === n) {
          detailLoading = false;
          commitsLoading = false;
          reviewersLoading = false;
          if (!detail) filesLoading = false;
        }
      });
  }

  // Detail loads touch multiple GitHub endpoints. Arrow nav fires one selection
  // per keystroke, so loading eagerly spams the API and trips GitHub's rate
  // limit. Highlight immediately, but debounce the fetch so only the PR you land
  // on actually loads.
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
    loadDetail(pr.number);
  }

  function selectPrDebounced(pr: PullRequestSummary) {
    cancelPendingDetail();
    selectedNumber = pr.number;
    detailDebounce = setTimeout(() => {
      detailDebounce = null;
      if (selectedNumber === pr.number) loadDetail(pr.number);
    }, 200);
  }

  function deselectPr() {
    cancelPendingDetail();
    selectedNumber = null;
    detail = null;
  }

  function openReview() {
    if (!selectedNumber || !selectedPr) return;
    void session.enterPrReview(selectedNumber, selectedPr.title);
  }

  function refreshList() {
    store.filter = { state: stateFilter };
    loadList(true);
  }

  function onStateFilterChange(state: PrStateFilter) {
    stateFilter = state;
    store.filter = { state };
    loadList();
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

  function close() {
    session.prsOpen = false;
    requestInputFocus();
  }

  // ── List keyboard nav ──
  function focusSelectedRow() {
    const row = listEl?.querySelector<HTMLElement>(
      selectedNumber ? `[data-pr="${selectedNumber}"]` : "[data-pr]",
    );
    row?.focus();
    row?.scrollIntoView({ block: "nearest" });
  }

  // ArrowDown in the auto-focused search field drops into the list instead of
  // doing nothing (keyboard-first: search → arrows → Enter with no mouse).
  function onSearchKeydown(e: KeyboardEvent) {
    if (e.key !== "ArrowDown") return;
    e.preventDefault();
    if (!selectedNumber && filtered[0]) selectPrDebounced(filtered[0]);
    void tick().then(focusSelectedRow);
  }

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
      if (filtered[next]) {
        selectPrDebounced(filtered[next]);
        void tick().then(focusSelectedRow);
      }
    } else if (e.key === "Enter" && selectedNumber) {
      openReview();
    }
  }

  // ── Shared styles ──
  const iconBtnClass =
    "relative inline-flex size-[1.625rem] cursor-pointer items-center justify-center rounded-[0.4375rem] border-0 bg-transparent text-(--solus-text-tertiary) transition-[background-color,color] duration-100 ease-in-out disabled:cursor-not-allowed disabled:opacity-35 [&:hover:not(:disabled)]:bg-(--solus-surface-hover) [&:hover:not(:disabled)]:text-(--solus-text-primary) focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary) focus-visible:outline-none";
</script>



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
      class="flex w-[20rem] shrink-0 flex-col border-r border-(--solus-popover-border) @max-[44rem]:w-full {selectedNumber ? '@max-[44rem]:hidden' : ''}"
    >
      <!-- Header -->
      <div class="shrink-0 border-b border-(--solus-popover-border)">
        <div class="flex items-center justify-between gap-3 px-4 py-2">
          <div class="flex min-w-0 items-center gap-2">
            <GitPullRequestIcon
              size={15}
              weight="fill"
              class="text-(--solus-accent)"
            />
            <span
              class="whitespace-nowrap text-[0.8125rem] font-semibold text-(--solus-text-primary)"
            >Pull Requests</span>
          </div>
          <div class="flex items-center gap-1">
            <button
              type="button"
              class={iconBtnClass}
              onclick={refreshList}
              aria-label="Refresh"
              use:tooltip={"Refresh"}
            >
              <ArrowsClockwiseIcon size={14} />
            </button>
            <button
              type="button"
              class={iconBtnClass}
              onclick={close}
              aria-label="Close"
            >
              <XIcon size={16} />
            </button>
          </div>
        </div>

        <!-- Search + filters -->
        <div class="flex flex-col gap-2 px-4 pb-2.5">
          <div class="flex min-w-0 items-center gap-2">
            <MagnifyingGlassIcon
              size={14}
              class="text-(--solus-text-tertiary) shrink-0"
            />
            <Input
              bind:el={searchEl}
              bind:value={query}
              type="text"
              variant="bare"
              size="md"
              placeholder="Search pull requests…"
              class="[@media(pointer:coarse)]:text-[16px]"
              onkeydown={onSearchKeydown}
            />
          </div>
          <div class="flex items-center gap-1.5">
            <div class="flex min-w-0 gap-0.5">
              {#each [
                { value: "open" as PrStateFilter, label: "Open", count: counts.open },
                { value: "closed" as PrStateFilter, label: "Closed", count: counts.closed },
                { value: "all" as PrStateFilter, label: "All", count: counts.all },
              ] as tab (tab.value)}
                <button
                  type="button"
                  class="inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-lg border-0 px-[0.5625rem] py-1 text-[0.6875rem] transition-[background-color,color] duration-100 ease-in-out {stateFilter ===
                  tab.value
                    ? 'bg-(--solus-accent-light) text-(--solus-accent)'
                    : 'bg-transparent text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-secondary)'}"
                  onclick={() => onStateFilterChange(tab.value)}
                  aria-pressed={stateFilter === tab.value}
                >
                  {tab.label}
                  <span class="tabular-nums opacity-70">{tab.count}</span>
                </button>
              {/each}
            </div>
            <div class="ml-auto relative flex shrink-0 items-center">
              <button
                type="button"
                bind:this={sortTriggerEl}
                class="inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-md border border-(--solus-container-border) bg-(--solus-input-bg-soft) px-2 py-[0.1875rem] text-[0.6875rem] text-(--solus-text-secondary) outline-none transition-[border-color] duration-100 ease-in-out focus-visible:border-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]"
                aria-label="Sort"
                onclick={() => (sortMenuOpen = !sortMenuOpen)}
              >
                <span>{sortLabel}</span>
                <CaretDownIcon
                  size={9}
                  class="shrink-0 text-(--solus-text-tertiary)"
                />
              </button>
              <Dropdown
                bind:open={sortMenuOpen}
                triggerEl={sortTriggerEl}
                align="top"
                anchor="right"
                width={120}
              >
                <div class="py-1" role="listbox" aria-label="Sort PRs">
                  {#each SORT_OPTIONS as opt (opt.value)}
                    <DropdownItem
                      selected={sortMode === opt.value}
                      onclick={() => {
                        sortMode = opt.value;
                        sortMenuOpen = false;
                      }}
                    >
                      {opt.label}
                    </DropdownItem>
                  {/each}
                </div>
              </Dropdown>
            </div>
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
          <div class="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <CircleNotchIcon
              size={20}
              class="animate-spin text-(--solus-text-tertiary) [animation-duration:0.9s]"
            />
            <p class="text-[0.75rem] text-(--solus-text-tertiary)">
              Loading pull requests…
            </p>
          </div>
        {:else if listLoadFailed && store.items.length === 0}
          <div class="flex flex-col items-center justify-center gap-1 px-4 py-16 text-center">
            <GitPullRequestIcon
              size={36}
              weight="fill"
              class="mb-3 text-(--solus-art-negative) opacity-60"
            />
            <p class="text-[0.8125rem] font-semibold text-(--solus-text-primary)">
              Couldn't load pull requests
            </p>
            <p class="max-w-[18rem] text-[0.75rem] leading-relaxed text-(--solus-text-tertiary)">
              Check your connection or provider sign-in, then try again.
            </p>
            <button
              type="button"
              class="mt-3 inline-flex items-center gap-1.5 rounded-md bg-(--solus-accent-light) px-2.5 py-1 text-[0.6875rem] font-semibold text-(--solus-accent) transition-[background-color] duration-100 hover:bg-[color-mix(in_srgb,var(--solus-accent-light)_100%,var(--solus-accent)_14%)]"
              onclick={refreshList}
            >
              <ArrowsClockwiseIcon size={12} weight="bold" />
              Retry
            </button>
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
          <ul class="flex flex-col py-1" role="list" aria-label="Pull requests">
            {#each filtered as pr (pr.number)}
              <li>
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <div
                  class="group flex cursor-pointer items-start gap-2.5 px-4 py-2.5 transition-colors duration-100 hover:bg-(--solus-surface-hover) {selectedNumber ===
                  pr.number
                    ? 'bg-(--solus-accent-light)'
                    : ''}"
                  role="button"
                  tabindex="0"
                  data-pr={pr.number}
                  onclick={() => selectPr(pr)}
                  onkeydown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      // Don't bubble to the container handler — one Enter used
                      // to both select here and open the review there.
                      e.stopPropagation();
                      if (e.key === "Enter" && selectedNumber === pr.number) openReview();
                      else selectPr(pr);
                    }
                  }}
                >
                  <PrStateIcon {pr} />
                  <div class="min-w-0 flex-1">
                    <div class="flex items-start justify-between gap-2">
                      <p class="min-w-0 text-[0.8125rem] leading-snug font-medium text-(--solus-text-primary) line-clamp-2">
                        {pr.title}
                      </p>
                    </div>
                    <div class="mt-1 flex items-center gap-1.5 text-[0.6875rem] text-(--solus-text-tertiary)">
                      <span class="tabular-nums">#{pr.number}</span>
                      <span aria-hidden="true">·</span>
                      <span>{pr.author}</span>
                      <span aria-hidden="true">·</span>
                      <span class="tabular-nums">{relativeTime(pr.updatedAt)}</span>
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
                    {#if pr.draft}
                      <span class="mt-1 inline-flex items-center rounded-full px-1.5 py-0.5 text-[0.5625rem] font-medium text-(--solus-text-tertiary) bg-(--solus-art-raised)">
                        Draft
                      </span>
                    {/if}
                  </div>
                  {#if pr.additions > 0 || pr.deletions > 0}
                    <div class="mt-0.5 flex shrink-0 items-center gap-1 text-[0.625rem] tabular-nums">
                      <span class="text-(--solus-art-positive)">+{pr.additions}</span>
                      <span class="text-(--solus-art-negative)">-{pr.deletions}</span>
                    </div>
                  {/if}
                  {#if pr.state === "open" && !pr.draft}
                    {@const queued = mergeQueue.isQueued(pr.number)}
                    <button
                      type="button"
                      class="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent transition-[background-color,color,opacity] duration-100 focus-visible:opacity-100 {queued
                        ? 'text-(--solus-accent)'
                        : 'text-(--solus-text-tertiary) opacity-0 group-hover:opacity-100 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)'}"
                      onclick={(e) => {
                        e.stopPropagation();
                        toggleQueued(pr);
                      }}
                      aria-pressed={queued}
                      aria-label={queued
                        ? "Remove from merge queue"
                        : "Add to merge queue"}
                      use:tooltip={queued
                        ? "Remove from merge queue"
                        : "Add to merge queue (⌥Q)"}
                    >
                      <QueueIcon size={13} weight={queued ? "fill" : "regular"} />
                    </button>
                  {/if}
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      <MergeQueuePanel />
    </div>

    <!-- ════════════════════════════════════════════════════════════════════════ -->
    <!-- RIGHT PANE: PR DETAIL                                                   -->
    <!-- ════════════════════════════════════════════════════════════════════════ -->
    {#if selectedNumber && selectedPr}
      <PrDetailPane
        pr={selectedPr}
        {detail}
        {commits}
        {reviewers}
        {changedFiles}
        {detailLoading}
        {commitsLoading}
        {reviewersLoading}
        {filesLoading}
        {detailLoadFailed}
        onRetry={() => selectedNumber && loadDetail(selectedNumber)}
        onBack={deselectPr}
        onOpenReview={openReview}
      />
    {:else}
      <!-- Empty detail pane -->
      <div class="hidden min-w-0 flex-1 items-center justify-center @min-[44rem]:flex">
        <div class="flex flex-col items-center gap-2 text-center">
          <GitPullRequestIcon
            size={32}
            class="text-(--solus-text-tertiary) opacity-30"
          />
          <p class="text-[0.8125rem] text-(--solus-text-tertiary)">
            Select a pull request to view details
          </p>
        </div>
      </div>
    {/if}
  </div>
{/if}
