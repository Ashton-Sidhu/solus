<script lang="ts">
  import { Skeleton } from "../skeleton";
  import type { NavPage } from "../../../lib/page-nav";
  import ListSkeleton from "./ListSkeleton.svelte";
  import PageCrumbLine from "./PageCrumbLine.svelte";

  /**
   * The loading silhouette of `ListPage` itself — the title line, the narrowing
   * row, and the rows beneath them.
   *
   * Most list pages are reached by a lazy import, and moving one between panes
   * remounts them, so this is what the user actually looks at on each swap. It
   * mirrors `ListPage`'s own measures (the same container width, the same head
   * padding) so the real page lands on the geometry
   * the skeleton drew instead of settling a second time.
   *
   * Which controls a page's head holds is stated per page rather than assumed:
   * drawing a refresh chip for a page that has none is the same reflow the
   * skeleton exists to prevent.
   */
  interface Props {
    /** The page whose title the crumb line states while the page loads. */
    page: NavPage;
    /** Names what is loading, for assistive technology. */
    label: string;
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
    page,
    label,
    hasViewSwitcher = true,
    hasRefresh = true,
    hasPrimaryAction = false,
    filterSlots = 2,
    toolbarFilters = false,
    identWidth = 62,
    plan,
  }: Props = $props();
</script>

<!-- The refresh chip and the close control the real crumb line ends with. -->
{#snippet windowControls()}
  {#if hasRefresh}
    <Skeleton class="h-[26px] w-28 rounded-full opacity-45" />
  {/if}
  <Skeleton class="size-[26px] rounded-full opacity-40" />
{/snippet}

<div
  class="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background"
  role="status"
  aria-busy="true"
  aria-label={label}
>
  <div
    class="mx-auto flex min-h-0 w-full max-w-[72rem] flex-1 flex-col px-8 @min-[90rem]:max-w-[82rem] @min-[110rem]:max-w-[94rem] @max-[44rem]:px-5 @max-[34rem]:px-4"
  >
    <!-- Row 1. The page's own crumb line, so the title is drawn by one
         component while the page loads and after, and does not change when the
         page arrives. Only the window controls are placeholders. Each bar sits
         in a box the height of the control's own line — the 31px crumb, the
         26px chips — or the row below lands at a different y. -->
    <div
      class="box-content flex h-[31px] shrink-0 items-center pt-[42px] pb-[13px] pointer-coarse:h-9 @max-[30rem]/pane:h-11! @max-[30rem]/pane:pb-2.5!"
    >
      <PageCrumbLine {page} actions={windowControls} />
    </div>

    <div
      aria-hidden="true"
      class="box-content flex shrink-0 items-center gap-2 {toolbarFilters
        ? 'h-8 pb-[14px]'
        : 'h-[30px] pb-[14px]'}"
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
          class="h-[30px] w-32 shrink-0 rounded-lg opacity-60"
        />
      {/if}
    </div>

    <div class="min-h-0 flex-1 overflow-hidden" aria-hidden="true">
      <ListSkeleton {identWidth} {plan} />
    </div>
  </div>
</div>
