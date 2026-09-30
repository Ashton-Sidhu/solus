<script lang="ts">
  import type { Snippet } from "svelte";
  import { ChevronDown as ChevronDownIcon, Search as SearchIcon } from "@lucide/svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import {
    TURN_SORT_CHOICES,
    TURN_STATUS_CHOICES,
    sortChoiceFor,
    statusFilterFor,
    statusFilterLabel,
  } from "./lib/rail-filters";
  import type { TurnSort, TurnStatusFilter } from "./lib/turn-rows";

  /** The rail's narrowing row, folded into the crumb line once the rail
   *  scrolls past it: `Insights / All turns ▾ / Newest first ▾`, then a search
   *  button that unfolds the row again with the field focused — the pull
   *  request list's fold. Each crumb is the same radio menu as its menu in the
   *  row, so the fold never takes a choice away. */
  interface Props {
    sort: TurnSort;
    onSortChange: (sort: TurnSort) => void;
    statusFilter: TurnStatusFilter | null;
    onStatusFilterChange: (status: TurnStatusFilter | null) => void;
    onSearch: () => void;
  }
  let { sort, onSortChange, statusFilter, onStatusFilterChange, onSearch }: Props = $props();

  const sortChoice = $derived(sortChoiceFor(sort));
</script>

{#snippet crumb(label: string, ariaLabel: string, menu: Snippet)}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class="flex h-[26px] min-w-0 shrink cursor-pointer items-center gap-1 overflow-hidden rounded-md border-0 bg-transparent px-2 text-workspace-chrome text-foreground hover:bg-[var(--wash-2)] pointer-coarse:h-9"
          aria-label={ariaLabel}
        >
          <span class="truncate">{label}</span>
          <ChevronDownIcon size={12} class="shrink-0 text-muted-foreground" />
        </button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content side="bottom" align="start" sideOffset={6} class="w-[min(15rem,calc(100vw-2rem))]">
      {@render menu()}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/snippet}

{#snippet statusMenu()}
  <DropdownMenu.RadioGroup
    value={statusFilter ?? "all"}
    onValueChange={(value) => onStatusFilterChange(statusFilterFor(value))}
  >
    <DropdownMenu.RadioItem value="all">All turns</DropdownMenu.RadioItem>
    {#each TURN_STATUS_CHOICES as status (status.value)}
      <DropdownMenu.RadioItem value={status.value}>{status.label}</DropdownMenu.RadioItem>
    {/each}
  </DropdownMenu.RadioGroup>
{/snippet}

{#snippet sortMenu()}
  <DropdownMenu.RadioGroup
    value={sortChoice?.value ?? ""}
    onValueChange={(value) => {
      const choice = TURN_SORT_CHOICES.find((candidate) => candidate.value === value);
      if (choice) onSortChange(choice.sort);
    }}
  >
    {#each TURN_SORT_CHOICES as choice (choice.value)}
      <DropdownMenu.RadioItem value={choice.value}>{choice.label}</DropdownMenu.RadioItem>
    {/each}
  </DropdownMenu.RadioGroup>
{/snippet}

{@render crumb(statusFilterLabel(statusFilter), `Status: ${statusFilterLabel(statusFilter)}`, statusMenu)}
<span class="shrink-0 px-px text-[15px] text-muted-foreground opacity-30" aria-hidden="true">/</span>
{@render crumb(sortChoice?.label ?? "Sorted", `Sort: ${sortChoice?.label ?? "by a table column"}`, sortMenu)}
<button
  type="button"
  class="ml-1 flex size-[26px] shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground hover:bg-[var(--wash-2)] hover:text-foreground pointer-coarse:size-9"
  onclick={onSearch}
  aria-label="Search turns"
  title="Search"
>
  <SearchIcon size={14} />
</button>
