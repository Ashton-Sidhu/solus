<script lang="ts">
  import { Skeleton } from "../ui/skeleton";

  interface Props {
    variant?: "diff" | "preview" | "map";
    /** See DiffEmptyState. Defaults false: the review surface renders this at
     *  full width and has no pane to measure. */
    stacked?: boolean;
  }

  let { variant = "diff", stacked = false }: Props = $props();

  // In a narrow pane the skeleton is the whole view, so a skeleton alone reads as
  // a page that failed rather than one that is loading. A 2px seam and the word
  // say what is happening — the same seam the header uses for a running turn,
  // and never a spinner over a blank pane.
  const isPhone = $derived(stacked);

  // Treemap tile layout, mirroring the heat map's few large cells over many
  // small ones so the skeleton reads as the same view before the data lands.
  const mapTiles = [
    "col-span-2 row-span-2",
    "col-span-2",
    "",
    "",
    "col-span-2",
    "",
    "",
  ];

  const treeRows = [
    { indent: "", width: "w-24" },
    { indent: "ml-4", width: "w-32" },
    { indent: "ml-4", width: "w-24" },
    { indent: "", width: "w-28" },
    { indent: "ml-4", width: "w-36" },
    { indent: "ml-4", width: "w-20" },
  ];
</script>

{#if variant === "map"}
  <div class="flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden p-2">
    <div class="flex h-full min-h-0 flex-1 flex-col gap-3 p-2">
      <div class="flex items-center justify-between gap-4">
        <Skeleton class="h-[0.625rem] w-24 shrink-0 rounded-[0.1875rem]" />
        <div class="flex items-center gap-3">
          <Skeleton class="h-[0.625rem] w-28 shrink-0 rounded-[0.1875rem]" />
          <Skeleton class="h-1.5 w-16 shrink-0 rounded-full" />
        </div>
      </div>
      <div class="grid min-h-0 flex-1 grid-cols-4 grid-rows-3 gap-1.5">
        {#each mapTiles as span, i (i)}
          <Skeleton class="rounded-md {span}" />
        {/each}
      </div>
    </div>
  </div>
{:else if variant === "preview"}
  <div class="flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden p-2">
    <div class="diff-skel-slot" style="background:transparent">
      <div
        class="flex items-center gap-2 px-3 border-b border-(--solus-file-slot-divider)"
        style="height:2rem"
      >
        <Skeleton class="h-[0.625rem] w-[7.5rem] shrink-0 rounded-[0.1875rem]" />
        <span class="flex-1"></span>
        <Skeleton class="h-[0.625rem] w-8 shrink-0 rounded-[0.1875rem]" />
      </div>
      <div class="flex flex-col gap-1 px-3 py-2.5">
        {#each Array(8) as _, j (j)}
          <div class="flex items-center gap-2">
            <Skeleton class="h-[0.625rem] w-[1.125rem] shrink-0 rounded-[0.1875rem]" />
            <Skeleton class="h-[0.625rem] shrink-0 rounded-[0.1875rem]" style="width:{35 + ((j * 13) % 55)}%" />
          </div>
        {/each}
      </div>
    </div>
  </div>
{:else if isPhone}
  <div class="flex min-h-0 flex-1 flex-col px-4 pt-4">
    <div class="overflow-hidden rounded-2xl bg-(--card) shadow-[shadow:var(--elev-ring)]">
      <div class="flex items-center gap-2.5 px-4 py-3.5">
        <span class="shrink-0 text-xs font-medium" style="color:color-mix(in oklch, var(--running) 72%, var(--foreground))">
          reading diff
        </span>
        <span class="relative h-0.5 flex-1 overflow-hidden rounded-full" style="background:color-mix(in oklch, var(--foreground) 8%, transparent)">
          <span class="diff-seam absolute top-0 h-0.5 rounded-full" style="background:var(--running)"></span>
        </span>
      </div>
      <div class="flex flex-col gap-[0.6875rem] px-4 pb-4">
        {#each ["78%", "56%", "66%", "44%"] as width, i (i)}
          <Skeleton class="h-3 rounded" style="width:{width}" />
        {/each}
      </div>
    </div>
  </div>
{:else}
  <div
    class="@container flex min-h-0 min-w-0 flex-1 overflow-hidden"
  >
    <!-- Match DiffResizableContent's default 290px file-tree column and its
         640px auto-open threshold. A container query applies on the first
         layout pass; measuring clientWidth in Svelte made the tree pop in one
         frame after the rest of the skeleton. -->
    <div
      class="relative flex w-[18.125rem] min-w-48 max-w-[40%] shrink-0 flex-col border-r border-(--solus-container-border) px-3 pt-12 @max-[39.999rem]:hidden"
      aria-hidden="true"
    >
      <Skeleton class="absolute top-3.5 left-3 size-5 rounded" />
      <div class="flex flex-col gap-3">
        {#each treeRows as row, i (i)}
          <div class="flex h-3 items-center gap-2 {row.indent}">
            <Skeleton class="size-2.5 shrink-0 rounded-[0.1875rem]" />
            <Skeleton class="h-2.5 {row.width} rounded-[0.1875rem]" />
          </div>
        {/each}
      </div>
    </div>

    <div class="flex min-h-0 min-w-0 flex-1 flex-col gap-1.5 overflow-hidden p-2">
      {#each Array(3) as _, i (i)}
        <div class="diff-skel-slot" style="background:transparent">
          <div
            class="flex items-center gap-2 border-b border-(--solus-file-slot-divider) px-3"
            style="height:2rem"
          >
            <Skeleton class="size-[0.625rem] shrink-0 rounded-[0.1875rem]" />
            <Skeleton class="h-[0.625rem] shrink-0 rounded-[0.1875rem]" style="width:{80 + i * 30}px" />
            <span class="flex-1"></span>
            <Skeleton class="h-[0.625rem] w-5 shrink-0 rounded-[0.1875rem]" />
            <Skeleton class="h-[0.625rem] w-5 shrink-0 rounded-[0.1875rem]" />
          </div>
          <div class="flex flex-col gap-1 px-3 py-2.5">
            {#each Array(3 + i) as _, j (j)}
              <div class="flex items-center gap-2">
                <Skeleton class="h-[0.625rem] w-[1.125rem] shrink-0 rounded-[0.1875rem]" />
                <Skeleton class="h-[0.625rem] w-[1.125rem] shrink-0 rounded-[0.1875rem]" />
                <Skeleton
                  class="h-[0.625rem] shrink-0 rounded-[0.1875rem]"
                  style="width:{30 + ((j * 17 + i * 13) % 55)}%;margin-left:{(j * 11) % 24}px"
                />
              </div>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  /* Indeterminate: a diff read has no total to be a fraction of. */
  .diff-seam {
    animation: diff-seam 1.4s ease-in-out infinite;
  }

  @keyframes diff-seam {
    from {
      left: -40%;
      width: 40%;
    }
    to {
      left: 100%;
      width: 40%;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .diff-seam {
      animation: none;
      left: 0;
      width: 100%;
      opacity: 0.55;
    }
  }
</style>
