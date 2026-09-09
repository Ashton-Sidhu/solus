<script lang="ts">
  import type { Snippet } from "svelte";
  import { Search as MagnifyingGlassIcon } from "@lucide/svelte";
  import ListFilterMenu from "./ListFilterMenu.svelte";
  import type { ListFilterSpec } from "./list-page";
  import * as DropdownMenu from "../dropdown-menu";

  /** Search and presentation controls stay visible; membership filters share a menu. */
  interface Props {
    query: string;
    placeholder: string;
    filters?: ListFilterSpec[];
    compactText?: boolean;
    filterContent?: Snippet;
    activeCount?: number;
    /** Presentation controls between search and Filters. */
    trailing?: Snippet;
    searchEl?: HTMLInputElement | null;
  }
  let {
    query = $bindable(),
    placeholder,
    filters = [],
    compactText = false,
    trailing,
    filterContent,
    activeCount = 0,
    searchEl = $bindable(null),
  }: Props = $props();
</script>

<!-- Sits inside the page's narrowing row rather than owning a band of its own,
     so the view switch before it and the creating action after it share one
     baseline. The row's bottom measure belongs to `ListPage`. -->
<div
  class="flex min-w-0 flex-1 items-center gap-2 @max-[30rem]/pane:order-3 @max-[30rem]/pane:basis-full {compactText ? 'text-workspace-chrome' : ''}"
>
  <div class="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg bg-card px-2.5 text-workspace-chrome shadow-[shadow:var(--elev-ring)] focus-within:shadow-[0_0_0_1px_color-mix(in_oklch,var(--primary)_45%,transparent)] @max-[30rem]/pane:h-10 @max-[30rem]/pane:text-base">
    <MagnifyingGlassIcon size={16} class="shrink-0 text-muted-foreground" />
    <input
      bind:this={searchEl}
      bind:value={query}
      type="text"
      {placeholder}
      class="w-full min-w-0 border-0 bg-transparent caret-[var(--primary)] outline-none placeholder:text-muted-foreground"
      aria-label={placeholder}
    />
  </div>

  {#if trailing}{@render trailing()}{/if}
  {#if filters.length > 0 || filterContent}
  <ListFilterMenu activeCount={activeCount + filters.filter((filter) => filter.active).length}>
  {#each filters as filter (filter.key)}
    {@const Icon = filter.icon}
    <DropdownMenu.CheckboxItem checked={filter.active} closeOnSelect={false} onCheckedChange={filter.toggle}>
      {#if Icon}<Icon size={14} class="shrink-0 text-muted-foreground" />{/if}
      <span class="min-w-0 flex-1 truncate">{filter.label}</span>
      {#if filter.count !== undefined}<span class="mr-1 tabular-nums text-muted-foreground">{filter.count}</span>{/if}
    </DropdownMenu.CheckboxItem>
  {/each}
  {#if filterContent}{@render filterContent()}{/if}
  </ListFilterMenu>
  {/if}

</div>
