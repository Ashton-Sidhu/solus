<script lang="ts">
  import { MagnifyingGlassIcon, PushPinIcon } from "phosphor-svelte";
  import WorkspaceProjectSwitcher from "./WorkspaceProjectSwitcher.svelte";
  import type { TimeFilter, TypeFilter, WorkspaceFilter } from "./lib/workspace-items";

  /** The facet rail: the project scope, then the axes that partition it (Type,
   *  Time) plus saved views. It navigates — filter state itself lives on the
   *  page's `filter`. */
  interface Props {
    filter: WorkspaceFilter;
    projectOptions: { key: string; label: string; count: number }[];
    /** null = all open projects. */
    projectScope: string | null;
    onSelectProject: (key: string | null) => void;
    typeCounts: Record<Exclude<TypeFilter, "all">, number> & { all: number };
    timeCounts: Record<Exclude<TimeFilter, "all">, number>;
    pinnedCount: number;
    needsReviewCount: number;
    totalCount: number;
    /** Item count across every open project — the "All projects" tally. */
    allProjectsCount: number;
  }

  let {
    filter,
    projectOptions,
    projectScope,
    onSelectProject,
    typeCounts,
    timeCounts,
    pinnedCount,
    needsReviewCount,
    totalCount,
    allProjectsCount,
  }: Props = $props();

  const TYPE_OPTIONS: { value: TypeFilter; label: string }[] = [
    { value: "all", label: "Everything" },
    { value: "plan", label: "Plans" },
    { value: "doc", label: "Docs" },
    { value: "diagram", label: "Diagrams" },
  ];

  const TIME_OPTIONS: { value: Exclude<TimeFilter, "all">; label: string }[] = [
    { value: "today", label: "Today" },
    { value: "yesterday", label: "Yesterday" },
    { value: "week", label: "This week" },
    { value: "older", label: "Older" },
  ];

  const pinnedActive = $derived(filter.pinnedOnly);
  const needsReviewActive = $derived(filter.status === "pending");

  function typeCount(value: TypeFilter): number {
    return value === "all" ? typeCounts.all : typeCounts[value];
  }

  function selectTime(value: Exclude<TimeFilter, "all">) {
    filter.time = filter.time === value ? "all" : value;
  }

  function togglePinnedView() {
    filter.pinnedOnly = !filter.pinnedOnly;
  }

  function toggleNeedsReview() {
    if (needsReviewActive) {
      filter.status = "any";
    } else {
      filter.status = "pending";
      filter.type = "plan";
    }
  }
</script>

{#snippet railRow(label: string, count: number, active: boolean, onclick: () => void, icon?: "pin" | "search")}
  <button type="button" class="rail-row" class:active {onclick} aria-pressed={active}>
    {#if icon === "pin"}
      <PushPinIcon size={11} weight={active ? "fill" : "regular"} class="shrink-0" />
    {:else if icon === "search"}
      <MagnifyingGlassIcon size={11} class="shrink-0" />
    {/if}
    <span class="rail-row-label">{label}</span>
    <span class="rail-row-count">{count}</span>
  </button>
{/snippet}

<div class="rail">
  <div class="rail-header">
    <span class="rail-eyebrow">Workspace</span>
    <WorkspaceProjectSwitcher
      options={projectOptions}
      value={projectScope}
      allCount={allProjectsCount}
      onSelect={onSelectProject}
      testId="workspace-project-switcher"
    />
  </div>

  <div class="rail-facets">
    <div class="rail-section">
      <div class="rail-section-label">Type</div>
      {#each TYPE_OPTIONS as opt (opt.value)}
        {@render railRow(opt.label, typeCount(opt.value), filter.type === opt.value, () => (filter.type = opt.value))}
      {/each}
    </div>

    <div class="rail-section">
      <div class="rail-section-label">Time</div>
      {#each TIME_OPTIONS as opt (opt.value)}
        {@render railRow(opt.label, timeCounts[opt.value], filter.time === opt.value, () => selectTime(opt.value))}
      {/each}
    </div>

    <div class="rail-section">
      <div class="rail-section-label">Saved</div>
      {@render railRow("Pinned", pinnedCount, pinnedActive, togglePinnedView, "pin")}
      {@render railRow("Needs review", needsReviewCount, needsReviewActive, toggleNeedsReview, "search")}
    </div>
  </div>

  <div class="rail-footer">{totalCount} {totalCount === 1 ? "item" : "items"}</div>
</div>

<style>
  .rail {
    flex: 0 0 13rem;
    display: flex;
    flex-direction: column;
    gap: 1.375rem;
    padding: 1.5rem 0.875rem 1.25rem;
    border-right: 0.0625rem solid color-mix(in srgb, var(--solus-container-border) 55%, transparent);
    background: color-mix(in srgb, var(--muted) 26%, var(--solus-container-bg));
    overflow: hidden;
  }

  /* Once the session sidebar steps away, this rail becomes the window's
     leading surface. Keep its title below the macOS traffic-light row instead
     of letting the two pieces of chrome compete for the same band. The
     titlebar variable is zero on web and non-mac surfaces, so their existing
     spacing is unchanged. */
  :global(.workspace-body.sidebar-collapsed) .rail {
    padding-top: max(
      1.5rem,
      calc(var(--solus-titlebar-height, 0px) + 1rem)
    );
  }

  /* The project scope and the footer tally stay put; only the facets scroll, so
     the scope the counts belong to is never scrolled off. */
  .rail-header {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .rail-eyebrow {
    padding: 0 0.5rem;
    font-size: 0.625rem;
    font-weight: 500;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--solus-text-tertiary);
  }

  .rail-facets {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 1.375rem;
    overflow-y: auto;
    scrollbar-width: thin;
  }

  .rail-section {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }
  .rail-section-label {
    padding: 0 0.5rem 0.4375rem;
    font-size: 0.625rem;
    font-weight: 500;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: color-mix(in srgb, var(--solus-text-tertiary) 82%, transparent);
  }

  .rail-row {
    height: 1.9375rem;
    display: flex;
    align-items: center;
    gap: 0.5625rem;
    padding: 0 0.5625rem;
    border: none;
    border-radius: 0.5rem;
    background: transparent;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    transition:
      background 0.12s ease,
      color 0.12s ease;
  }
  .rail-row:hover {
    background: color-mix(in srgb, var(--muted) 70%, transparent);
    color: var(--solus-text-primary);
  }
  /* Selected facet: card background + 600 weight — no dot or accent bar. */
  .rail-row.active {
    background: var(--solus-container-bg);
    box-shadow: 0 0.0625rem 0.125rem color-mix(in srgb, var(--solus-text-primary) 7%, transparent);
    color: var(--solus-text-primary);
  }
  .rail-row.active .rail-row-label {
    font-weight: 600;
  }
  .rail-row-label {
    flex: 1 1 auto;
    min-width: 0;
    text-align: left;
    font-size: 0.7813rem;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rail-row-count {
    font-size: 0.6875rem;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-variant-numeric: tabular-nums;
    opacity: 0.75;
  }

  .rail-footer {
    flex: 0 0 auto;
    padding: 0 0.5625rem;
    font-size: 0.6875rem;
    line-height: 1.5;
    color: color-mix(in srgb, var(--solus-text-tertiary) 85%, transparent);
  }
</style>
