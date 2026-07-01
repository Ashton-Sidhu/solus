<script lang="ts">
  const TITLE_WIDTHS = [72, 54, 81, 46, 68, 58, 77, 50];
  const META_WIDTHS = [38, 28, 44, 32, 40, 30, 46, 34];

  // Shimmer sweep applied to every skeleton bar via an ::after gradient.
  const SHIMMER =
    "after:absolute after:inset-0 after:-translate-x-full after:animate-[picker-skeleton-shimmer_1.4s_ease-in-out_infinite] after:bg-[linear-gradient(90deg,transparent_0%,var(--solus-surface-hover)_50%,transparent_100%)] after:content-['']";
</script>

<div class="flex flex-col pb-1 pt-2" role="status" aria-label="Loading sessions">
  <div class="flex h-[1.625rem] items-end px-5 pb-1 pt-2.5">
    <span
      class="relative block h-2 w-[22%] overflow-hidden rounded-[0.1875rem] bg-[var(--solus-surface-secondary)] opacity-70 {SHIMMER}"
    ></span>
  </div>
  {#each Array(5) as _, i (i)}
    <div class="flex h-[2.875rem] items-center px-2">
      <span
        class="relative ml-3 mr-2.5 inline-flex h-[0.875rem] w-[0.875rem] flex-shrink-0 overflow-hidden rounded-full bg-[var(--solus-surface-secondary)] opacity-60 {SHIMMER}"
      ></span>
      <div class="flex min-w-0 flex-1 flex-col gap-1.5 pr-3">
        <span
          class="relative block h-[0.6875rem] overflow-hidden rounded-[0.25rem] bg-[var(--solus-surface-secondary)] opacity-85 {SHIMMER}"
          style="width:{TITLE_WIDTHS[i % TITLE_WIDTHS.length]}%"
        ></span>
        <span
          class="relative block h-[0.5625rem] overflow-hidden rounded-[0.1875rem] bg-[var(--solus-surface-secondary)] opacity-55 {SHIMMER}"
          style="width:{META_WIDTHS[i % META_WIDTHS.length]}%"
        ></span>
      </div>
    </div>
  {/each}
  <div class="flex h-[1.625rem] items-end px-5 pb-1 pt-2.5">
    <span
      class="relative block h-2 overflow-hidden rounded-[0.1875rem] bg-[var(--solus-surface-secondary)] opacity-70 {SHIMMER}"
      style="width:34%"
    ></span>
  </div>
  {#each Array(3) as _, i (i)}
    <div class="flex h-[2.875rem] items-center px-2">
      <span
        class="relative ml-3 mr-2.5 inline-flex h-[0.875rem] w-[0.875rem] flex-shrink-0 overflow-hidden rounded-full bg-[var(--solus-surface-secondary)] opacity-60 {SHIMMER}"
      ></span>
      <div class="flex min-w-0 flex-1 flex-col gap-1.5 pr-3">
        <span
          class="relative block h-[0.6875rem] overflow-hidden rounded-[0.25rem] bg-[var(--solus-surface-secondary)] opacity-85 {SHIMMER}"
          style="width:{TITLE_WIDTHS[(i + 3) % TITLE_WIDTHS.length]}%"
        ></span>
        <span
          class="relative block h-[0.5625rem] overflow-hidden rounded-[0.1875rem] bg-[var(--solus-surface-secondary)] opacity-55 {SHIMMER}"
          style="width:{META_WIDTHS[(i + 3) % META_WIDTHS.length]}%"
        ></span>
      </div>
    </div>
  {/each}
</div>
