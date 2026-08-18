<script lang="ts">
  import type { Snippet } from "svelte";
  import { MagnifyingGlassIcon } from "phosphor-svelte";
  import type { ListFilterSpec } from "./list-page";

  /** One 28px line: an elastic search field, then a fixed run of filter chips.
   *  Toggle chips filter immediately and carry a count while off — once a chip
   *  is on it drops the count, because the number is then the list itself.
   *  Menu-backed chips (label pickers, the sort control) go in `trailing`, and
   *  the sort control is labelled with the current sort rather than "Sort". */
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

<div
  class="flex shrink-0 items-center gap-2 pb-3.5 {compactText
    ? 'text-xs'
    : 'text-sm'}"
>
  <div
    class="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-lg px-[9px] shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)] focus-within:shadow-[0_0_0_.5px_color-mix(in_oklch,var(--primary)_45%,transparent)]"
  >
    <MagnifyingGlassIcon size={14} class="shrink-0 text-muted-foreground opacity-70" />
    <input
      bind:this={searchEl}
      bind:value={query}
      type="text"
      {placeholder}
      class="w-full border-0 bg-transparent text-workspace-chrome caret-[var(--primary)] outline-none placeholder:text-muted-foreground"
      aria-label={placeholder}
    />
    <span
      class="shrink-0 rounded-md bg-[var(--wash-2)] px-[7px] py-[3px] text-xs text-muted-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_12%,transparent),inset_0_-1px_0_color-mix(in_oklch,var(--foreground)_9%,transparent)]"
      aria-hidden="true">/</span
    >
  </div>

  {#each filters as filter (filter.key)}
    {@const Icon = filter.icon}
    <button
      type="button"
      class="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border-0 px-2.5 transition-colors duration-150 {filter.active
 ? 'bg-[color-mix(in_oklch,var(--primary)_13%,transparent)] text-[color-mix(in_oklch,var(--primary)_82%,var(--foreground))]'
 : 'bg-transparent text-muted-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)]'}"
      onclick={filter.toggle}
      aria-pressed={filter.active}
    >
      {#if Icon}<Icon size={14} class="shrink-0 opacity-75" />{/if}
      {filter.label}
      {#if filter.count !== undefined && !filter.active}
        <span class="text-xs tabular-nums opacity-60">{filter.count}</span>
      {/if}
    </button>
  {/each}

  {#if trailing}{@render trailing()}{/if}
</div>
