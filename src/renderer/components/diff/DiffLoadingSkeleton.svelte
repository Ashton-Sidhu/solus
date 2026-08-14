<script lang="ts">
  import { Skeleton } from "../ui/skeleton";

  interface Props {
    variant?: "diff" | "preview" | "map";
  }

  let { variant = "diff" }: Props = $props();

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
</script>

<div class="flex-1 min-h-0 overflow-hidden p-2 flex flex-col gap-1.5">
  {#if variant === "map"}
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
  {:else if variant === "preview"}
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
  {:else}
    {#each Array(3) as _, i (i)}
      <div class="diff-skel-slot" style="background:transparent">
        <div
          class="flex items-center gap-2 px-3 border-b border-(--solus-file-slot-divider)"
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
  {/if}
</div>
