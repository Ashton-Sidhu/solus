<script lang="ts">
  import { ChevronDown as ChevronDownIcon, Search as SearchIcon } from "@lucide/svelte";
  import type { PrFilterGroup } from "./lib/pr-filter-menu";
  import * as DropdownMenu from "../ui/dropdown-menu";

  /** The narrowing row, folded into the crumb line once the list scrolls past
   *  it: `Pull requests / Open ▾ / All ▾`, then a search button that unfolds
   *  the row again with the field focused. Each crumb is the same radio menu
   *  as its Filters row, so the fold never takes a choice away. */
  interface Props {
    /** The State and Involvement filter groups, in crumb order. */
    groups: PrFilterGroup[];
    onSearch: () => void;
  }
  let { groups, onSearch }: Props = $props();
</script>

{#each groups as group, index (group.key)}
  {#if index > 0}
    <span class="shrink-0 px-px text-[15px] text-muted-foreground opacity-30" aria-hidden="true">/</span>
  {/if}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class="flex h-[26px] min-w-0 shrink cursor-pointer items-center gap-1 overflow-hidden rounded-md border-0 bg-transparent px-2 text-workspace-chrome text-foreground hover:bg-[var(--wash-2)] pointer-coarse:h-9"
          aria-label={`${group.label}: ${group.valueLabel}`}
        >
          <span class="truncate">{group.valueLabel}</span>
          <ChevronDownIcon size={12} class="shrink-0 text-muted-foreground" />
        </button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content side="bottom" align="start" sideOffset={6} class="w-[min(15rem,calc(100vw-2rem))]">
      <DropdownMenu.RadioGroup value={group.value} onValueChange={group.select}>
        {#each group.options as option (option.value)}
          <DropdownMenu.RadioItem value={option.value}>{option.label}</DropdownMenu.RadioItem>
        {/each}
      </DropdownMenu.RadioGroup>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/each}
<button
  type="button"
  class="ml-1 flex size-[26px] shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground hover:bg-[var(--wash-2)] hover:text-foreground pointer-coarse:size-9"
  onclick={onSearch}
  aria-label="Search pull requests"
  title="Search"
>
  <SearchIcon size={14} />
</button>
