<script lang="ts">
  import { Skeleton } from "../skeleton";
  import ListSkeleton from "./ListSkeleton.svelte";

  /**
   * The loading silhouette of `ListPage` itself — the head band, the filter
   * row, and the rows beneath them.
   *
   * Every list page is reached by a lazy import, and moving one between panes
   * remounts it, so this is what the user actually looks at on each swap. It
   * mirrors `ListPage`'s own measures (the same container width, the same head
   * padding including the laptop rungs) so the real page lands on the geometry
   * the skeleton drew instead of settling a second time.
   *
   * Which controls a page's action cluster holds is stated per page rather than
   * assumed: drawing a refresh button for a page that has none is the same
   * reflow the skeleton exists to prevent.
   */
  interface Props {
    /** Names what is loading, for assistive technology. */
    label: string;
    /** Stat placeholders under the title. */
    summaryCount?: number;
    hasProjectSwitcher?: boolean;
    hasViewSwitcher?: boolean;
    hasRefresh?: boolean;
    hasPrimaryAction?: boolean;
    /** Trailing controls on the filter row (status segments, sort). */
    filterSlots?: number;
    /** Same value the page passes to `ListRow`. */
    identWidth?: number;
    /** Row title widths, grouped as they render. */
    plan?: number[][];
  }

  let {
    label,
    summaryCount = 2,
    hasProjectSwitcher = true,
    hasViewSwitcher = true,
    hasRefresh = true,
    hasPrimaryAction = false,
    filterSlots = 2,
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
    <div
      class="workspace-titlebar flex shrink-0 items-end justify-between gap-8 pt-[42px] pb-[22px] [.is-laptop-display_&]:pt-8 [.is-laptop-display_&]:pb-4"
    >
      <div class="flex min-w-0 flex-col gap-[9px]">
        <Skeleton class="h-6 w-36 rounded opacity-70" />
        <div class="flex items-center gap-2">
          {#each Array(summaryCount) as _, index (index)}
            <Skeleton
              class="h-2.5 rounded-[0.1875rem] {index === 0
                ? 'w-16 opacity-60'
                : 'w-24 opacity-45'}"
            />
          {/each}
        </div>
      </div>

      <div class="flex shrink-0 items-center gap-2">
        {#if hasProjectSwitcher}
          <Skeleton
            class="h-[26px] w-24 rounded-full opacity-50 @max-[44rem]:hidden"
          />
        {/if}
        {#if hasViewSwitcher}
          <Skeleton class="h-[30px] w-48 rounded-full opacity-60" />
        {/if}
        {#if hasRefresh}
          <Skeleton class="size-[26px] rounded-full opacity-50" />
        {/if}
        {#if hasPrimaryAction}
          <Skeleton
            class="h-[30px] w-32 rounded-lg opacity-60 [.is-laptop-display_&]:h-[26px]"
          />
        {/if}
      </div>
    </div>

    <div class="flex shrink-0 items-center gap-2 pb-3.5">
      <Skeleton class="h-7 min-w-0 flex-1 rounded-lg opacity-55" />
      {#each Array(filterSlots) as _, index (index)}
        <Skeleton
          class="h-7 rounded-lg opacity-45 {index === 0
            ? 'w-20 @max-[34rem]:hidden'
            : 'w-16 @max-[44rem]:hidden'}"
        />
      {/each}
    </div>

    <div class="min-h-0 flex-1 overflow-hidden">
      <ListSkeleton {identWidth} {plan} />
    </div>
  </div>
</div>
