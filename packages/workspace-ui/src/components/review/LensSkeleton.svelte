<script lang="ts">
  import { Skeleton } from "../ui/skeleton";

  /** `canvasOnly` is the lens body alone, for a lens whose header and composer
   *  are already there while its HTML still loads. */
  let { canvasOnly = false }: { canvasOnly?: boolean } = $props();
</script>

{#snippet canvas()}
  <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-[clamp(20px,2.6cqi,56px)] py-6" aria-hidden="true">
    <Skeleton class="h-6 w-[46%] max-w-[28rem] rounded-md opacity-80" />
    <Skeleton class="h-3 w-[72%] rounded-[0.1875rem] opacity-60" />
    <Skeleton class="h-3 w-[58%] rounded-[0.1875rem] opacity-60" />
    <div class="mt-3 grid grid-cols-1 gap-3 @min-[36rem]/pane:grid-cols-2">
      <Skeleton class="h-32 rounded-xl opacity-55" />
      <Skeleton class="h-32 rounded-xl opacity-55" />
    </div>
    <Skeleton class="mt-2 h-3 w-[64%] rounded-[0.1875rem] opacity-50" />
    <Skeleton class="h-3 w-[40%] rounded-[0.1875rem] opacity-50" />
  </div>
{/snippet}

<!-- The ready lens's geometry — header, canvas, edit composer — so the lens
     lands in place instead of pushing the page around when it arrives. -->
<div class="flex h-full min-h-0 w-full flex-col" role="status" aria-busy="true" aria-label="Loading lens">
  {#if canvasOnly}
    {@render canvas()}
  {:else}
    <div class="flex h-11 shrink-0 items-center gap-2 border-b border-(--solus-container-border) pr-2.5 pl-4 pointer-coarse:h-13" aria-hidden="true">
      <Skeleton class="h-3 w-40 max-w-[40%] rounded-[0.1875rem]" />
      <Skeleton class="h-2.5 w-28 rounded-[0.1875rem] opacity-60 @max-[30rem]/pane:hidden" />
      <span class="flex-1"></span>
      <div class="flex shrink-0 items-center gap-1.5">
        <Skeleton class="size-6 rounded-md opacity-70" />
        <Skeleton class="size-6 rounded-md opacity-70" />
        <Skeleton class="size-6 rounded-md opacity-70" />
        <span class="mx-0.5 h-4 w-px bg-(--hairline)"></span>
        <Skeleton class="size-6 rounded-md opacity-70" />
        <Skeleton class="size-6 rounded-md opacity-70" />
      </div>
    </div>

    {@render canvas()}

    <div class="shrink-0 px-3 pt-2 pb-3" aria-hidden="true">
      <div class="flex h-[4.5rem] flex-col justify-between rounded-2xl border border-(--solus-container-border) bg-(--solus-popover-bg) px-3 py-2.5">
        <Skeleton class="h-3 w-44 rounded-[0.1875rem] opacity-50" />
        <div class="flex items-center justify-between">
          <Skeleton class="h-5 w-24 rounded-full opacity-50" />
          <Skeleton class="h-6 w-14 rounded-md opacity-60" />
        </div>
      </div>
    </div>
  {/if}
</div>
