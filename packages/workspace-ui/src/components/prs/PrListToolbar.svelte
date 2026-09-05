<script lang="ts">
  import {
    ArrowUpDown as ArrowUpDownIcon,
    ListFilter as ListFilterIcon,
    RefreshCw as RefreshIcon,
    Search as SearchIcon,
  } from "@lucide/svelte";
  import type { PrSortMode } from "./lib/pr-utils";
  import type { PrFilterGroup } from "./lib/pr-filter-menu";
  import PrFilterSubmenu from "./PrFilterSubmenu.svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";

  /** The pull request list's narrowing row, the same in every shape the list
   *  takes: the full page, the navigation column beside an open detail, and a
   *  phone-width pane. One search field, then two menus — Sort, and Filters
   *  holding the same facet groups in every scope —
   *  so the row never has to fit five chips and can never push one off the
   *  pane with no scrollbar to say so.
   *
   *  Refresh is on the row only where the crumb line that normally carries it
   *  is gone (the split column); the full page keeps it beside the sync stamp.
   *
   *  ── The ladder ──
   *  Under 40rem of pane the menus drop their labels and keep their glyphs, so
   *  the search field keeps a usable measure. At the record
   *  rung (30rem) the page wraps this row onto a full-width second line and the
   *  controls take a thumb-height. Nothing unmounts. */
  interface Props {
    query: string;
    searchEl?: HTMLInputElement | null;
    placeholder?: string;
    sortMode: PrSortMode;
    /** Absent where the list orders itself (the inbox). */
    sortOptions?: { value: PrSortMode; label: string }[];
    filterGroups: PrFilterGroup[];
    onRefresh?: () => void;
    refreshing?: boolean;
  }

  let {
    query = $bindable(),
    searchEl = $bindable(null),
    placeholder = "Search pull requests, branches, authors…",
    sortMode = $bindable(),
    sortOptions,
    filterGroups,
    onRefresh,
    refreshing = false,
  }: Props = $props();

  let sortOpen = $state(false);
  let filtersOpen = $state(false);
  const activeFilterCount = $derived(filterGroups.filter((group) => group.active).length);
</script>

<div
  class="flex min-w-0 flex-1 items-center gap-2 text-workspace-chrome @max-[30rem]/pane:order-3 @max-[30rem]/pane:basis-full"
>
  <div
    class="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg bg-card px-2.5 shadow-[shadow:var(--elev-ring)] focus-within:shadow-[0_0_0_1px_color-mix(in_oklch,var(--primary)_45%,transparent)] @max-[30rem]/pane:h-10 @max-[30rem]/pane:text-base"
  >
    <SearchIcon size={16} class="shrink-0 text-muted-foreground" />
    <input
      bind:this={searchEl}
      bind:value={query}
      type="text"
      name="pull-request-search"
      {placeholder}
      class="w-full min-w-0 border-0 bg-transparent caret-[var(--primary)] outline-none placeholder:text-muted-foreground"
      aria-label={placeholder}
    />
  </div>

  {#if sortOptions}
    <DropdownMenu.Root bind:open={sortOpen}>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            type="button"
            class="relative flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-card px-2 text-foreground shadow-[shadow:var(--elev-ring)] hover:bg-[var(--wash-1)] @min-[40rem]/pane:pr-3 @max-[30rem]/pane:h-10"
            aria-label="Sort pull requests"
            title="Sort"
          >
            <ArrowUpDownIcon size={16} class="shrink-0 text-muted-foreground" />
            <span class="@max-[40rem]/pane:hidden">Sort</span>
            <span
              class="pointer-events-none absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
              aria-hidden="true"
            ></span>
          </button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-[150px]">
        <DropdownMenu.RadioGroup bind:value={sortMode}>
          {#each sortOptions as option (option.value)}
            <DropdownMenu.RadioItem value={option.value}>
              {option.label}
            </DropdownMenu.RadioItem>
          {/each}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {/if}

  <DropdownMenu.Root bind:open={filtersOpen}>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class="relative flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 shadow-[shadow:var(--elev-ring)] hover:bg-[var(--wash-1)] @min-[40rem]/pane:pr-3 @max-[30rem]/pane:h-10 {activeFilterCount > 0
            ? 'bg-[color-mix(in_oklch,var(--primary)_13%,var(--card))] text-[color:color-mix(in_oklch,var(--primary)_82%,var(--foreground))]'
            : 'bg-card text-foreground'}"
          aria-label={activeFilterCount > 0
            ? `Filter pull requests (${activeFilterCount} active)`
            : "Filter pull requests"}
          title="Filters"
        >
          <ListFilterIcon size={16} class="shrink-0 text-muted-foreground" />
          <span class="@max-[40rem]/pane:hidden">Filters</span>
          {#if activeFilterCount > 0}
            <!-- The count stands in for the label once the label is gone, so a
                 narrowed list still says so on its face. -->
            <span class="text-xs tabular-nums @min-[40rem]/pane:hidden">{activeFilterCount}</span>
          {/if}
          <span
            class="pointer-events-none absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
            aria-hidden="true"
          ></span>
        </button>
      {/snippet}
    </DropdownMenu.Trigger>
    <!-- Reserve the widest submenu to the right of this column. Without the
         alignment offset, the filter trigger sits at the window edge
         and Floating UI correctly flips every submenu to the left. -->
    <DropdownMenu.Content
      side="bottom"
      align="end"
      alignOffset={400}
      sideOffset={6}
      class="w-64 pointer-fine:[.is-laptop-display_&]:w-56"
    >
      {#each filterGroups as group, index (group.key)}
        {@const Icon = group.icon}
        {#if index === 2}<DropdownMenu.Separator />{/if}
        <DropdownMenu.Sub>
          <DropdownMenu.SubTrigger>
            <Icon size={14} class="shrink-0 text-muted-foreground" />
            <span class="min-w-0 flex-1 truncate">{group.label}</span>
            <span class="max-w-24 truncate text-muted-foreground">{group.valueLabel}</span>
          </DropdownMenu.SubTrigger>
          <PrFilterSubmenu {group} />
        </DropdownMenu.Sub>
      {/each}
    </DropdownMenu.Content>
  </DropdownMenu.Root>

  {#if onRefresh}
    <button
      type="button"
      class="relative flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-card text-muted-foreground shadow-[shadow:var(--elev-ring)] hover:bg-[var(--wash-1)] hover:text-foreground disabled:pointer-events-none disabled:opacity-40 @max-[30rem]/pane:size-10"
      onclick={onRefresh}
      disabled={refreshing}
      aria-label={refreshing ? "Refreshing pull requests" : "Refresh pull requests"}
      title={refreshing ? "Refreshing…" : "Refresh"}
    >
      <RefreshIcon
        size={16}
        class="shrink-0 {refreshing
          ? 'animate-spin [animation-duration:0.9s] motion-reduce:animate-none'
          : ''}"
      />
      <span
        class="pointer-events-none absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
        aria-hidden="true"
      ></span>
    </button>
  {/if}
</div>
