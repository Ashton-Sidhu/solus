<script lang="ts">
  import type { Snippet } from "svelte";
  import { Search as MagnifyingGlassIcon } from "@lucide/svelte";
  import type { ListFilterSpec } from "./list-page";
  import {
    FILTER_CHIP,
    FILTER_CHIP_COUNT,
    FILTER_CHIP_OFF,
    FILTER_CHIP_ON,
    FILTER_CHIP_ROW,
    FILTER_SEARCH_FIELD,
    FILTER_SEARCH_ICON,
    FILTER_SEARCH_INPUT,
    FILTER_SEARCH_KEYCAP,
  } from "./filter-styles";

  /** One 28px line: an elastic search field, then a fixed run of filter chips.
   *  Toggle chips filter immediately and carry a count while off — once a chip
   *  is on it drops the count, because the number is then the list itself.
   *  Menu-backed chips (label pickers, the sort control) go in `trailing`, and
   *  the sort control is labelled with the current sort rather than "Sort".
   *
   *  ── The record rung (`@max-[30rem]/pane`) ──
   *  One line cannot hold a search field and five chips at 393px: the chips
   *  simply ran off the pane, and the last of them — a status menu, a sort — was
   *  unreachable with no scrollbar to say so. The band becomes two lines
   *  instead: the field at the card height every other phone search takes, then
   *  the chips as one scrolling row. */
  interface Props {
    query: string;
    placeholder: string;
    filters?: ListFilterSpec[];
    compactText?: boolean;
    /** Menu chips that own their own popover — rendered after the toggles. */
    trailing?: Snippet;
    searchEl?: HTMLInputElement | null;
  }
  let {
    query = $bindable(),
    placeholder,
    filters = [],
    compactText = false,
    trailing,
    searchEl = $bindable(null),
  }: Props = $props();
</script>

<!-- Sits inside the page's narrowing row rather than owning a band of its own,
     so the view switch before it and the creating action after it share one
     baseline. The row's bottom measure belongs to `ListPage`. -->
<div
  class="flex min-w-0 flex-1 items-center gap-2 @max-[30rem]/pane:order-3 @max-[30rem]/pane:basis-full @max-[30rem]/pane:flex-col @max-[30rem]/pane:items-stretch @max-[30rem]/pane:gap-2.5 {compactText ? 'text-xs' : ''}"
>
  <div class={FILTER_SEARCH_FIELD}>
    <MagnifyingGlassIcon size={14} class={FILTER_SEARCH_ICON} />
    <input
      bind:this={searchEl}
      bind:value={query}
      type="text"
      {placeholder}
      class={FILTER_SEARCH_INPUT}
      aria-label={placeholder}
    />
    <span class={FILTER_SEARCH_KEYCAP} aria-hidden="true">/</span>
  </div>

  <div class={FILTER_CHIP_ROW}>
  {#each filters as filter (filter.key)}
    {@const Icon = filter.icon}
    <button
      type="button"
      class="{FILTER_CHIP} {filter.active ? FILTER_CHIP_ON : FILTER_CHIP_OFF}"
      onclick={filter.toggle}
      aria-pressed={filter.active}
    >
      {#if Icon}<Icon size={14} class="shrink-0 opacity-75" />{/if}
      {filter.label}
      {#if filter.count !== undefined && !filter.active}
        <span class={FILTER_CHIP_COUNT}>{filter.count}</span>
      {/if}
    </button>
  {/each}

  {#if trailing}{@render trailing()}{/if}
  </div>
</div>
