<script lang="ts">
  import { Skeleton } from "../ui/skeleton";

  /**
   * The shape of an answer that has not arrived yet: the histogram card above,
   * the listing below. It holds the geometry both real surfaces use, so the
   * page does not settle a second time when the rows land.
   *
   * Bar heights are fixed rather than random: a placeholder that re-shuffles on
   * every render reads as data.
   */
  const BAR_HEIGHTS = Array.from(
    { length: 80 },
    (_, index) => 12 + ((index * 29 + 17) % 43) + (index % 19 === 0 ? 18 : 0),
  );
  const ROWS = [0, 1, 2, 3, 4, 5, 6, 7];
</script>

<section
  class="flex shrink-0 flex-col gap-2 rounded-xl bg-card px-4 py-3 shadow-[shadow:var(--insights-card-shadow)]"
  aria-hidden="true"
>
  <header class="flex flex-wrap items-center gap-x-3 gap-y-1">
    <Skeleton class="h-3 w-40 rounded opacity-70" />
    <span class="flex-1"></span>
    <Skeleton class="h-2.5 w-16 rounded opacity-45" />
    <Skeleton class="h-2.5 w-16 rounded opacity-45" />
  </header>
  <div class="flex h-52 w-full pr-3 pb-5 pl-11 sm:h-44 sm:[@media(min-height:1000px)]:h-52">
    <div class="relative flex min-w-0 flex-1">
      <!-- One shimmer fills the plot. Animating every one of the responsive
           bars would multiply paint work while an expensive query is running.
           Each column paints the card colour over its gaps and the space above
           its bar, so the shimmer shows through the bars alone. -->
      <Skeleton class="absolute inset-0 rounded-none opacity-70" />
      {#each BAR_HEIGHTS as height, index (index)}
        <span
          class="relative min-w-0 flex-1 border-x border-card {index >= 48
            ? '@max-[70rem]/pane:hidden'
            : index >= 16
              ? '@max-[30rem]/pane:hidden'
              : ''}"
        >
          <span class="block bg-card" style="height:{100 - height}%"></span>
        </span>
      {/each}
    </div>
  </div>
</section>

<section class="flex min-h-35 flex-1 flex-col overflow-hidden" aria-hidden="true">
  <header
    class="flex min-h-13 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 shadow-[inset_0_-0.5px_0_var(--hairline-strong)]"
  >
    <Skeleton class="h-3 w-20 rounded opacity-70" />
    <Skeleton class="h-2.5 w-14 rounded opacity-45" />
    <span class="flex-1"></span>
    <Skeleton class="h-7 w-40 rounded-full opacity-45" />
  </header>
  <div class="min-h-0 flex-1 overflow-hidden">
    {#each ROWS as row (row)}
      {@const delay = `animation-delay:${row * 70}ms`}
      <div class="flex h-10 items-center gap-3 px-3">
        <Skeleton class="h-2.5 w-14 shrink-0 rounded opacity-50" style={delay} />
        <Skeleton class="h-2.5 min-w-0 flex-1 rounded opacity-60" style={delay} />
        <Skeleton class="h-2.5 w-24 shrink-0 rounded opacity-40 max-sm:hidden" style={delay} />
        <Skeleton class="h-2.5 w-16 shrink-0 rounded opacity-40" style={delay} />
        <Skeleton class="h-2.5 w-12 shrink-0 rounded opacity-35" style={delay} />
      </div>
    {/each}
  </div>
</section>
