<script lang="ts">
  import {
    ArrowUpDown as ArrowUpDownIcon,
    ListFilter as ListFilterIcon,
    Search as SearchIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import {
    TURN_SORT_CHOICES,
    TURN_STATUS_CHOICES,
    sortChoiceFor,
    statusFilterFor,
  } from "./lib/rail-filters";
  import { turnHostValue, type TurnHostChoice } from "./lib/turn-hosts";
  import type {
    TurnSort,
    TurnStatusCounts,
    TurnStatusFilter,
  } from "./lib/turn-rows";

  /** The rail's narrowing row, built as the pull request list's is: one
   *  search field, then Sort and Filters. It drives the same search, sort,
   *  and status the full-width turn list holds, so closing the panel lands on
   *  the list the rail was showing.
   *
   *  ── The ladder ──
   *  Measured on the list (`listpage`). Between 32rem and 40rem the menus keep
   *  their glyphs and drop their labels, so the search keeps a usable measure
   *  in the 380px rail. Nothing unmounts. */
  interface Props {
    search: string;
    /** The field itself, so the folded crumb's search button can focus it. */
    searchEl?: HTMLInputElement | null;
    /** Whether the field holds focus — the rail keeps this row unfolded while
     *  someone is typing in it. */
    onSearchFocusChange?: (focused: boolean) => void;
    onSearchChange: (search: string) => void;
    sort: TurnSort;
    onSortChange: (sort: TurnSort) => void;
    statusFilter: TurnStatusFilter | null;
    onStatusFilterChange: (status: TurnStatusFilter | null) => void;
    counts: TurnStatusCounts;
    /** The Host filter's choices; shown only when turns ran on more than one host. */
    hostChoices?: TurnHostChoice[];
    hostFilter?: string | null;
    onHostFilterChange?: (hostId: string | null | undefined) => void;
  }

  let {
    search,
    searchEl = $bindable(null),
    onSearchFocusChange,
    onSearchChange,
    sort,
    onSortChange,
    statusFilter,
    onStatusFilterChange,
    counts,
    hostChoices = [],
    hostFilter,
    onHostFilterChange,
  }: Props = $props();

  const hostValue = $derived(turnHostValue(hostFilter));
  const activeFilters = $derived((statusFilter ? 1 : 0) + (hostFilter !== undefined ? 1 : 0));

  const sortValue = $derived(sortChoiceFor(sort)?.value ?? "");
</script>

<div
  class="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-workspace-chrome @max-[32rem]/listpage:basis-full @max-[30rem]/pane:order-3 @max-[30rem]/pane:basis-full"
>
  <div
    class="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg bg-card px-2.5 shadow-[shadow:var(--elev-ring)] focus-within:shadow-[0_0_0_1px_color-mix(in_oklch,var(--primary)_45%,transparent)] @max-[32rem]/listpage:basis-full @max-[30rem]/pane:h-10 @max-[30rem]/pane:text-base"
  >
    <SearchIcon size={16} class="shrink-0 text-muted-foreground" />
    <input
      bind:this={searchEl}
      value={search}
      onfocus={() => onSearchFocusChange?.(true)}
      onblur={() => onSearchFocusChange?.(false)}
      oninput={(event) => onSearchChange(event.currentTarget.value)}
      type="text"
      name="turn-search"
      placeholder="Search prompts, models, sessions"
      class="w-full min-w-0 border-0 bg-transparent caret-[var(--primary)] outline-none placeholder:text-muted-foreground"
      aria-label="Search turns"
    />
    {#if search}
      <button
        type="button"
        class="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-(--primary)"
        aria-label="Clear the search"
        title="Clear the search"
        onclick={() => onSearchChange("")}
      >
        <XIcon size={12} />
      </button>
    {/if}
  </div>

  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-card px-2 text-foreground shadow-[shadow:var(--elev-ring)] hover:bg-[var(--wash-1)] data-[state=open]:bg-[var(--wash-1)] @min-[40rem]/listpage:pr-3 @max-[32rem]/listpage:pr-3 @max-[30rem]/pane:h-10"
          aria-label="Sort turns"
          title="Sort"
        >
          <ArrowUpDownIcon size={16} class="shrink-0 text-muted-foreground" />
          <span class="@max-[40rem]/listpage:@min-[32rem]/listpage:hidden">Sort</span>
        </button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-[170px]">
      <DropdownMenu.RadioGroup
        value={sortValue}
        onValueChange={(value) => {
          const option = TURN_SORT_CHOICES.find((candidate) => candidate.value === value);
          if (option) onSortChange(option.sort);
        }}
      >
        {#each TURN_SORT_CHOICES as option (option.value)}
          <DropdownMenu.RadioItem value={option.value}>{option.label}</DropdownMenu.RadioItem>
        {/each}
      </DropdownMenu.RadioGroup>
    </DropdownMenu.Content>
  </DropdownMenu.Root>

  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-card px-2 text-foreground shadow-[shadow:var(--elev-ring)] hover:bg-[var(--wash-1)] data-[state=open]:bg-[var(--wash-1)] @min-[40rem]/listpage:pr-3 @max-[32rem]/listpage:pr-3 @max-[30rem]/pane:h-10"
          aria-label={activeFilters > 0 ? `Filter turns (${activeFilters} active)` : "Filter turns"}
          title="Filters"
        >
          <ListFilterIcon size={16} class="shrink-0 text-muted-foreground" />
          <span class="@max-[40rem]/listpage:@min-[32rem]/listpage:hidden">Filters</span>
          {#if activeFilters > 0}
            <!-- The count is the only sign of a narrowed rail, so it shows at every width. -->
            <span class="text-xs text-muted-foreground tabular-nums">{activeFilters}</span>
          {/if}
        </button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-56">
      <DropdownMenu.Label>Status</DropdownMenu.Label>
      <DropdownMenu.RadioGroup
        value={statusFilter ?? "all"}
        onValueChange={(value) => onStatusFilterChange(statusFilterFor(value))}
      >
        <DropdownMenu.RadioItem value="all">All turns</DropdownMenu.RadioItem>
        {#each TURN_STATUS_CHOICES as status (status.value)}
          <DropdownMenu.RadioItem value={status.value}>
            <span class="min-w-0 flex-1 truncate">{status.label}</span>
            <span class="text-muted-foreground tabular-nums">{counts[status.value]}</span>
          </DropdownMenu.RadioItem>
        {/each}
      </DropdownMenu.RadioGroup>
      {#if hostChoices.length > 2 && onHostFilterChange}
        <DropdownMenu.Separator />
        <DropdownMenu.Label>Host</DropdownMenu.Label>
        <DropdownMenu.RadioGroup
          value={hostValue}
          onValueChange={(value) => onHostFilterChange(hostChoices.find((choice) => choice.value === value)?.hostId)}
        >
          {#each hostChoices as choice (choice.value)}
            <DropdownMenu.RadioItem value={choice.value}>
              <span class="min-w-0 flex-1 truncate">{choice.label}</span>
              {#if choice.count !== null}<span class="text-muted-foreground tabular-nums">{choice.count}</span>{/if}
            </DropdownMenu.RadioItem>
          {/each}
        </DropdownMenu.RadioGroup>
      {/if}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
</div>
