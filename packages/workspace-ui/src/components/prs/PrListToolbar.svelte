<script lang="ts">
  import type { Snippet } from "svelte";
  import {
    ArrowUpDown as ArrowUpDownIcon,
    ListFilter as ListFilterIcon,
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
   *  Refresh lives on the crumb line above, which stays on screen beside an
   *  open detail panel too.
   *
   *  ── The ladder ──
   *  Measured on the list (`listpage`), not the pane, so it holds beside an
   *  open detail panel. Between 32rem and 40rem the menus drop their labels and
   *  keep their glyphs, so the search field keeps a usable measure. Under 32rem
   *  the search takes a line of its own and the menus, labelled again, sit
   *  under it. At the pane's record rung (30rem) the
   *  controls also take a thumb-height. Nothing unmounts. */
  interface Props {
    query: string;
    searchEl?: HTMLInputElement | null;
    placeholder?: string;
    sortMode: PrSortMode;
    sortOptions: { value: PrSortMode; label: string }[];
    filterGroups: PrFilterGroup[];
    /** The project scope group, after the facet groups. */
    projectFilter?: Snippet;
    /** Counts the project scope into the active filters. */
    projectFilterActive?: boolean;
    /** Whether the search field holds focus — the page keeps this row
     *  unfolded while someone is typing in it. */
    onSearchFocusChange?: (focused: boolean) => void;
  }

  let {
    query = $bindable(),
    searchEl = $bindable(null),
    placeholder = "Search pull requests, or label:bug",
    sortMode = $bindable(),
    sortOptions,
    filterGroups,
    projectFilter,
    projectFilterActive = false,
    onSearchFocusChange,
  }: Props = $props();

  let sortOpen = $state(false);
  let filtersOpen = $state(false);
  const activeFilterCount = $derived(
    filterGroups.filter((group) => group.active).length + Number(projectFilterActive),
  );
</script>

<div
  class="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-workspace-chrome @max-[32rem]/listpage:basis-full @max-[30rem]/pane:order-3 @max-[30rem]/pane:basis-full"
>
  <div
    class="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg bg-card px-2.5 @max-[32rem]/listpage:basis-full shadow-[shadow:var(--elev-ring)] focus-within:shadow-[0_0_0_1px_color-mix(in_oklch,var(--primary)_45%,transparent)] @max-[30rem]/pane:h-10 @max-[30rem]/pane:text-base"
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
      onfocus={() => onSearchFocusChange?.(true)}
      onblur={() => onSearchFocusChange?.(false)}
    />
  </div>

  <DropdownMenu.Root bind:open={sortOpen}>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class="relative flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-card px-2 text-foreground shadow-[shadow:var(--elev-ring)] hover:bg-[var(--wash-1)] @min-[40rem]/listpage:pr-3 @max-[32rem]/listpage:pr-3 @max-[30rem]/pane:h-10"
          aria-label="Sort pull requests"
          title="Sort"
        >
          <ArrowUpDownIcon size={16} class="shrink-0 text-muted-foreground" />
          <span class="@max-[40rem]/listpage:@min-[32rem]/listpage:hidden">Sort</span>
          <span
            class="pointer-events-none absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
            aria-hidden="true"
          ></span>
        </button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-[170px]">
      <DropdownMenu.RadioGroup bind:value={sortMode}>
        {#each sortOptions as option (option.value)}
          <DropdownMenu.RadioItem value={option.value}>
            {option.label}
          </DropdownMenu.RadioItem>
        {/each}
      </DropdownMenu.RadioGroup>
    </DropdownMenu.Content>
  </DropdownMenu.Root>

  <DropdownMenu.Root bind:open={filtersOpen}>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class="relative flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 shadow-[shadow:var(--elev-ring)] hover:bg-[var(--wash-1)] @min-[40rem]/listpage:pr-3 @max-[32rem]/listpage:pr-3 @max-[30rem]/pane:h-10 bg-card text-foreground data-[state=open]:bg-[var(--wash-1)]"
          aria-label={activeFilterCount > 0
            ? `Filter pull requests (${activeFilterCount} active)`
            : "Filter pull requests"}
          title="Filters"
        >
          <ListFilterIcon size={16} class="shrink-0 text-muted-foreground" />
          <span class="@max-[40rem]/listpage:@min-[32rem]/listpage:hidden">Filters</span>
          {#if activeFilterCount > 0}
            <!-- The count is the only sign of a narrowed list, so it shows at every width. -->
            <span class="text-xs text-muted-foreground tabular-nums">{activeFilterCount}</span>
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
      class="w-64"
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
      {#if projectFilter}
        <DropdownMenu.Separator />
        {@render projectFilter()}
      {/if}
    </DropdownMenu.Content>
  </DropdownMenu.Root>

</div>
