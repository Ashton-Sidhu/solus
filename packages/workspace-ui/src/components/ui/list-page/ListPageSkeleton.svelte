<script lang="ts">
  import { Skeleton } from "../skeleton";
  import ListSkeleton from "./ListSkeleton.svelte";

  /**
   * The loading silhouette of `ListPage` itself — the crumb line, the narrowing
   * row, and the rows beneath them.
   *
   * Most list pages are reached by a lazy import, and moving one between panes
   * remounts them, so this is what the user actually looks at on each swap. It
   * mirrors `ListPage`'s own measures (the same container width, the same head
   * padding including the laptop rungs) so the real page lands on the geometry
   * the skeleton drew instead of settling a second time.
   *
   * Which controls a page's head holds is stated per page rather than assumed:
   * drawing a refresh chip for a page that has none is the same reflow the
   * skeleton exists to prevent.
   */
  interface Props {
    /** Names what is loading, for assistive technology. */
    label: string;
    hasProjectSwitcher?: boolean;
    hasViewSwitcher?: boolean;
    hasRefresh?: boolean;
    hasPrimaryAction?: boolean;
    /** Trailing controls on the narrowing row (status segments, sort). */
    filterSlots?: number;
    /** The page passes `toolbarFilters` to `ListPage`: its narrowing row is
     *  the 32px toolbar, not the 28px chip band. */
    toolbarFilters?: boolean;
    /** Same value the page passes to `ListRow`. */
    identWidth?: number;
    /** Row title widths, grouped as they render. */
    plan?: number[][];
  }

  let {
    label,
    hasProjectSwitcher = true,
    hasViewSwitcher = true,
    hasRefresh = true,
    hasPrimaryAction = false,
    filterSlots = 2,
    toolbarFilters = false,
    identWidth = 62,
    plan,
  }: Props = $props();
</script>

<div
  class="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background"
  role="status"
  aria-busy="true"
  aria-label={label}
>
  <div
    class="mx-auto flex min-h-0 w-full max-w-[72rem] flex-1 flex-col px-8 @min-[90rem]:max-w-[82rem] @min-[110rem]:max-w-[94rem] @max-[44rem]:px-5 @max-[34rem]:px-4"
    aria-hidden="true"
  >
    <!-- Row 1. The bars are thinner than the controls they stand in for, so
         each sits in a box the height of the control's own line — the 31px
         crumb, the 26px chips — or the row below lands at a different y when
         the real page arrives. -->
    <div
      class="box-content flex h-[31px] shrink-0 items-center gap-2 pt-[42px] pb-[13px] pointer-coarse:h-9 pointer-fine:[.is-laptop-display_&]:h-[27px] [.is-laptop-display_&]:pt-8 [.is-laptop-display_&]:pb-2.5 @max-[30rem]/pane:h-11! @max-[30rem]/pane:pb-2.5!"
    >
      {#if hasProjectSwitcher}
        <Skeleton class="h-[15px] w-32 rounded opacity-60" />
        <Skeleton class="h-[15px] w-1.5 rounded opacity-25" />
      {/if}
      <Skeleton class="h-[15px] w-20 rounded opacity-60" />
      <span class="flex-1"></span>
      {#if hasRefresh}
        <Skeleton class="h-[26px] w-28 rounded-full opacity-45" />
      {/if}
      <Skeleton class="size-[26px] rounded-[0.4375rem] opacity-40" />
    </div>

    <!-- Row 2. -->
    <div
      class="box-content flex shrink-0 items-center gap-2 {toolbarFilters
        ? 'h-8 pb-[14px]'
        : 'h-[30px] pb-[14px] [.is-laptop-display_&]:h-[26px] [.is-laptop-display_&]:pb-3'}"
    >
      {#if hasViewSwitcher}
        <Skeleton class="h-[30px] w-48 shrink-0 rounded-full opacity-60" />
      {/if}
      <Skeleton class="min-w-0 flex-1 rounded-lg opacity-55 {toolbarFilters ? 'h-8' : 'h-7'}" />
      {#each Array(filterSlots) as _, index (index)}
        <Skeleton
          class="shrink-0 rounded-lg opacity-45 {toolbarFilters ? 'h-8' : 'h-7'} {index === 0
            ? 'w-20 @max-[34rem]:hidden'
            : 'w-16 @max-[44rem]:hidden'}"
        />
      {/each}
      {#if hasPrimaryAction}
        <Skeleton
          class="h-[30px] w-32 shrink-0 rounded-lg opacity-60 [.is-laptop-display_&]:h-[26px]"
        />
      {/if}
    </div>

    <div class="min-h-0 flex-1 overflow-hidden">
      <ListSkeleton {identWidth} {plan} />
    </div>
  </div>
</div>
