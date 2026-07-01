<script lang="ts">
  import { tick, untrack } from "svelte";
  import {
    XIcon,
    MagnifyingGlassIcon,
    CircleNotchIcon,
    GitPullRequestIcon,
    GitMergeIcon,
    GitBranchIcon,
    ArrowsClockwiseIcon,
    CheckCircleIcon,
    ArrowsCounterClockwiseIcon,
    ChatCircleIcon,
    CaretDownIcon,
    FileIcon,
    ArrowSquareOutIcon,
  } from "phosphor-svelte";
  import Icon from "@iconify/svelte";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
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
  import { markdownSanitizeUrl } from "../../lib/markdownSanitize";
  import { tooltip } from "../../lib/tooltip";
  import { fileTypeIcon } from "../../lib/fileTypeIcon";
  import { ensureIconCollections } from "../diagram/iconify";
  import CodeSpan from "../ui/CodeSpan.svelte";
  import Input from "../ui/Input.svelte";
  import Dropdown from "../ui/Dropdown.svelte";
  import DropdownItem from "../ui/DropdownItem.svelte";
  import {
    filterPrs,
    sortPrs,
    relativeTime,
    type PrStateFilter,
    type PrSortMode,
  } from "./lib/pr-utils";

  ensureIconCollections();

  const session = getWorkspaceContext();
  const store = session.prsStore;

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
  let filesExpanded = $state(false);

  const markdownRenderers = { codespan: CodeSpan };
  const FILES_PREVIEW = 6;
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

  const visibleFiles = $derived(
    filesExpanded ? changedFiles : changedFiles.slice(0, FILES_PREVIEW),
  );
  const moreFiles = $derived(Math.max(0, changedFiles.length - FILES_PREVIEW));
  const totalAdds = $derived(
    changedFiles.reduce((sum, f) => sum + f.additions, 0),
  );
  const totalDels = $derived(
    changedFiles.reduce((sum, f) => sum + f.deletions, 0),
  );

  const statusBadge = $derived.by(() => {
    if (!detail) return null;
    if (detail.draft && detail.state === "open")
      return {
        label: "Draft",
        Icon: GitBranchIcon,
        tone: "var(--solus-text-tertiary)",
      };
    if (detail.state === "merged")
      return {
        label: "Merged",
        Icon: GitMergeIcon,
        tone: "var(--solus-accent)",
      };
    if (detail.state === "closed")
      return {
        label: "Closed",
        Icon: GitPullRequestIcon,
        tone: "var(--solus-art-negative)",
      };
    return {
      label: "Open",
      Icon: GitPullRequestIcon,
      tone: "var(--solus-art-positive)",
    };
  });

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
      void store.loadAll(session.ctx);
      if (!runtime.shouldSuppressFocus) {
        void tick().then(() => searchEl?.focus());
      }
    });
  });

  function loadDetail(number: number) {
    const n = number;
    detail = null;
    commits = [];
    reviewers = [];
    changedFiles = [];
    filesExpanded = false;
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
            .catch(() => {})
            .finally(() => {
              if (selectedNumber === n) filesLoading = false;
            });
        }
      })
      .catch(() => {})
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

  // ── Shared styles ──
  const iconBtnClass =
    "relative inline-flex size-[1.625rem] cursor-pointer items-center justify-center rounded-[0.4375rem] border-0 bg-transparent text-(--solus-text-tertiary) transition-[background-color,color] duration-100 ease-in-out disabled:cursor-not-allowed disabled:opacity-35 [&:hover:not(:disabled)]:bg-(--solus-surface-hover) [&:hover:not(:disabled)]:text-(--solus-text-primary) focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary) focus-visible:outline-none";
</script>

{#snippet avatar(name: string, size: string)}
  <span
    class="grid shrink-0 place-items-center rounded-full bg-(--solus-accent) font-semibold text-(--solus-on-accent,#fff) {size}"
  >
    {name
      .split(/[\s_-]/)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? "")
      .join("")}
  </span>
{/snippet}

{#snippet avatarImg(url: string, name: string, size: string)}
  {#if url}
    <img
      src={url}
      alt={name}
      class="shrink-0 rounded-full object-cover outline-1 -outline-offset-1 outline-black/5 dark:outline-white/10 {size}"
    />
  {:else}
    {@render avatar(name, size)}
  {/if}
{/snippet}

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

{#snippet reviewStateBadge(state: PrReviewer['state'])}
  {#if state === 'APPROVED'}
    <span class="inline-flex items-center gap-1 rounded-full py-0.5 pr-1.5 pl-1 text-[0.625rem] font-medium leading-none text-(--solus-art-positive) bg-[color:color-mix(in_srgb,var(--solus-art-positive)_12%,transparent)]">
      <CheckCircleIcon size={10} weight="fill" />
      Approved
    </span>
  {:else if state === 'CHANGES_REQUESTED'}
    <span class="inline-flex items-center gap-1 rounded-full py-0.5 pr-1.5 pl-1 text-[0.625rem] font-medium leading-none text-(--solus-art-negative) bg-[color:color-mix(in_srgb,var(--solus-art-negative)_12%,transparent)]">
      <ArrowsCounterClockwiseIcon size={10} weight="bold" />
      Changes
    </span>
  {:else if state === 'COMMENTED'}
    <span class="inline-flex items-center gap-1 rounded-full py-0.5 pr-1.5 pl-1 text-[0.625rem] font-medium leading-none text-(--solus-text-tertiary) bg-(--solus-art-raised)">
      <ChatCircleIcon size={10} weight="fill" />
      Commented
    </span>
  {:else}
    <span class="inline-flex items-center rounded-full px-1.5 py-0.5 text-[0.625rem] font-medium leading-none text-(--solus-text-tertiary) bg-(--solus-art-raised)">
      Pending
    </span>
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
                  onclick={() => selectPr(pr)}
                  onkeydown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      selectPr(pr);
                    }
                  }}
                >
                  {@render prStateIcon(pr)}
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
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </div>

    <!-- ════════════════════════════════════════════════════════════════════════ -->
    <!-- RIGHT PANE: PR DETAIL                                                   -->
    <!-- ════════════════════════════════════════════════════════════════════════ -->
    {#if selectedNumber && selectedPr}
      <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
        <!-- Detail header breadcrumb -->
        <div class="flex shrink-0 items-center justify-between gap-3 border-b border-(--solus-popover-border) px-5 py-2">
          <div class="flex min-w-0 items-center gap-2 text-[0.8125rem]">
            <button
              type="button"
              class="hidden text-(--solus-text-tertiary) hover:text-(--solus-text-primary) @max-[44rem]:inline-flex"
              onclick={deselectPr}
              aria-label="Back to list"
            >
              ←
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
          <button
            type="button"
            class="inline-flex cursor-pointer items-center gap-1.5 rounded-[0.4375rem] border-0 bg-(--solus-accent-light) px-2.5 py-[0.3125rem] text-[0.6875rem] font-semibold text-(--solus-accent) transition-[background-color] duration-100 hover:bg-[color-mix(in_srgb,var(--solus-accent-light)_100%,var(--solus-accent)_14%)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]"
            onclick={openReview}
          >
            <ArrowSquareOutIcon size={13} weight="bold" />
            <span>Review</span>
          </button>
        </div>

        <!-- Detail body: scrollable -->
        <div class="h-full min-h-0 overflow-y-auto [scrollbar-width:thin]">
          <div class="mx-auto flex w-full max-w-[64rem] gap-8 px-6 py-7">
            <!-- Main column -->
            <main class="flex min-w-0 flex-1 flex-col">
              <!-- Title -->
              <h1 class="text-[1.25rem] leading-tight font-semibold tracking-tight text-(--solus-text-primary)">
                {selectedPr.title}
              </h1>

              <!-- Author / branch meta -->
              <div class="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem] text-(--solus-text-tertiary)">
                {@render avatarImg(selectedPr.authorAvatarUrl, selectedPr.author, "size-5")}
                <span class="font-medium text-(--solus-text-secondary)">{selectedPr.author}</span>
                <span aria-hidden="true">·</span>
                <span class="tabular-nums">#{selectedPr.number}</span>
                {#if detail}
                  <span aria-hidden="true">·</span>
                  <GitBranchIcon size={13} class="shrink-0" />
                  <span class="font-mono text-[0.75rem]">{detail.baseRef}</span>
                  <span aria-hidden="true">←</span>
                  <span class="font-mono text-[0.75rem] truncate">{detail.headRef}</span>
                {/if}
              </div>

              <!-- Description -->
              {#if detailLoading}
                <div class="mt-8 flex animate-pulse flex-col gap-2.5 motion-reduce:animate-none">
                  <div class="h-3 w-full rounded bg-(--solus-art-border)"></div>
                  <div class="h-3 w-11/12 rounded bg-(--solus-art-border)"></div>
                  <div class="h-3 w-3/4 rounded bg-(--solus-art-border)"></div>
                </div>
              {:else if detail?.body?.trim()}
                <div class="mt-6">
                  <h2 class="text-[0.75rem] font-semibold tracking-wide text-(--solus-text-tertiary) uppercase">
                    Description
                  </h2>
                  <div class="prose-cloud mt-3 text-[0.875rem] leading-relaxed text-(--solus-text-primary) [--solus-font-weight-body:400]">
                    <SvelteMarkdown
                      source={detail.body}
                      renderers={markdownRenderers}
                      sanitizeUrl={markdownSanitizeUrl}
                    />
                  </div>
                </div>
              {/if}

              <!-- Activity: opened event + commits -->
              <h2 class="mt-8 mb-4 text-[0.75rem] font-semibold tracking-wide text-(--solus-text-tertiary) uppercase">
                Activity
              </h2>

              <ol class="flex flex-col">
                <!-- Opened event -->
                <li class="relative flex gap-3">
                  <div class="flex flex-col items-center">
                    <span class="grid size-5 shrink-0 place-items-center text-(--solus-art-positive)">
                      <GitPullRequestIcon size={15} weight="bold" />
                    </span>
                    {#if commits.length > 0}
                      <span class="w-px flex-1 bg-(--solus-art-border)"></span>
                    {/if}
                  </div>
                  <p class="-mt-0.5 pb-5 text-[0.8125rem] text-(--solus-text-secondary)">
                    <span class="font-medium text-(--solus-text-primary)">
                      {detail?.author ?? selectedPr.author}
                    </span>
                    opened this pull request
                    <span class="text-(--solus-text-tertiary)">
                      · {relativeTime(selectedPr.createdAt)}
                    </span>
                  </p>
                </li>

                <!-- Commits -->
                {#if commitsLoading}
                  <li class="flex gap-3 pb-4">
                    <div class="flex flex-col items-center">
                      <CircleNotchIcon
                        size={15}
                        class="animate-spin text-(--solus-text-tertiary) [animation-duration:0.9s]"
                      />
                    </div>
                    <span class="-mt-0.5 text-[0.8125rem] text-(--solus-text-tertiary)">Loading commits…</span>
                  </li>
                {:else if commits.length > 0}
                  <li class="relative flex gap-3">
                    <div class="flex flex-col items-center">
                      <span class="grid size-5 shrink-0 place-items-center text-(--solus-text-tertiary)">
                        <GitBranchIcon size={15} weight="bold" />
                      </span>
                    </div>
                    <div class="-mt-0.5 min-w-0 flex-1 pb-5">
                      <p class="text-[0.8125rem] text-(--solus-text-secondary)">
                        <span class="font-medium text-(--solus-text-primary)">{detail?.author ?? selectedPr.author}</span>
                        added {commits.length} {commits.length === 1 ? "commit" : "commits"}
                        <span class="text-(--solus-text-tertiary)">· {relativeTime(commits[commits.length - 1].committedAt)}</span>
                      </p>
                      <ul class="mt-2.5 flex flex-col gap-px overflow-hidden rounded-xl border border-(--solus-art-border) bg-(--solus-art-surface)">
                        {#each commits as commit (commit.sha)}
                          <li class="flex items-center gap-2.5 px-3 py-2">
                            <GitBranchIcon size={13} weight="bold" class="shrink-0 text-(--solus-text-tertiary)" />
                            <span class="min-w-0 flex-1 truncate text-[0.8125rem] text-(--solus-text-secondary)">{commit.message}</span>
                            <code class="shrink-0 text-[0.6875rem] tabular-nums text-(--solus-text-tertiary)">{commit.sha.slice(0, 7)}</code>
                          </li>
                        {/each}
                      </ul>
                    </div>
                  </li>
                {/if}
              </ol>
            </main>

            <!-- Right sidebar -->
            <aside class="hidden w-56 shrink-0 flex-col gap-6 @min-[50rem]:flex">
              <!-- Status -->
              {#if statusBadge}
                <div>
                  <h3 class="mb-2 text-[0.6875rem] font-semibold tracking-wide text-(--solus-text-tertiary) uppercase">
                    Status
                  </h3>
                  <span
                    class="inline-flex items-center gap-1.5 text-[0.8125rem] font-medium"
                    style="color: {statusBadge.tone}"
                  >
                    <statusBadge.Icon size={14} weight="bold" />
                    {statusBadge.label}
                  </span>
                </div>
              {/if}

              <!-- Reviewers -->
              <div>
                <h3 class="mb-2 text-[0.6875rem] font-semibold tracking-wide text-(--solus-text-tertiary) uppercase">
                  Reviewers
                </h3>
                {#if reviewersLoading}
                  <div class="flex animate-pulse flex-col gap-2 motion-reduce:animate-none">
                    <div class="h-4 w-24 rounded bg-(--solus-art-border)"></div>
                  </div>
                {:else if reviewers.length === 0}
                  <p class="text-[0.75rem] text-(--solus-text-tertiary)">No reviewers</p>
                {:else}
                  <ul class="flex flex-col gap-2" role="list">
                    {#each reviewers as reviewer (reviewer.login)}
                      <li class="flex items-center gap-2">
                        {@render avatar(reviewer.login, "size-5 text-[0.5625rem]")}
                        <span class="min-w-0 flex-1 truncate text-[0.8125rem] text-(--solus-text-secondary)">
                          {reviewer.login}
                        </span>
                        {@render reviewStateBadge(reviewer.state)}
                      </li>
                    {/each}
                  </ul>
                {/if}
              </div>

              <!-- Files changed -->
              <div>
                <h3 class="mb-2 text-[0.6875rem] font-semibold tracking-wide text-(--solus-text-tertiary) uppercase">
                  {changedFiles.length} files changed
                </h3>
                {#if filesLoading}
                  <div class="flex animate-pulse flex-col gap-1.5 motion-reduce:animate-none">
                    {#each Array(3) as _}
                      <div class="h-4 w-full rounded bg-(--solus-art-border)"></div>
                    {/each}
                  </div>
                {:else}
                  {#if totalAdds + totalDels > 0}
                    <div class="mb-3 flex items-center gap-2 text-[0.6875rem] tabular-nums">
                      <span class="text-(--solus-art-positive)">+{totalAdds}</span>
                      <span class="text-(--solus-art-negative)">-{totalDels}</span>
                    </div>
                  {/if}
                  <ul class="flex flex-col gap-0.5" role="list">
                    {#each visibleFiles as file (file.path)}
                      {@const icon = fileTypeIcon(file.path)}
                      <li class="flex items-center gap-1.5 py-0.5">
                        {#if icon}
                          <Icon icon={icon} class="size-3.5 shrink-0" />
                        {:else}
                          <FileIcon size={14} class="shrink-0 text-(--solus-text-tertiary)" />
                        {/if}
                        <span class="min-w-0 flex-1 truncate text-[0.75rem] text-(--solus-text-secondary)"
                          use:tooltip={file.path}
                        >
                          {file.path.split("/").pop()}
                        </span>
                        <span class="shrink-0 text-[0.625rem] tabular-nums text-(--solus-art-positive)">+{file.additions}</span>
                        <span class="shrink-0 text-[0.625rem] tabular-nums text-(--solus-art-negative)">-{file.deletions}</span>
                      </li>
                    {/each}
                  </ul>
                  {#if moreFiles > 0}
                    <button
                      type="button"
                      class="mt-1.5 cursor-pointer border-0 bg-transparent p-0 text-[0.75rem] text-(--solus-accent) hover:underline"
                      onclick={() => (filesExpanded = !filesExpanded)}
                    >
                      {filesExpanded ? "Show fewer" : `${moreFiles} more files`}
                    </button>
                  {/if}
                {/if}
              </div>
            </aside>
          </div>
        </div>
      </div>
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
