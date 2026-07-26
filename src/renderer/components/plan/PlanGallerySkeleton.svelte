<script lang="ts">
  import { Skeleton } from "../ui/skeleton";

  interface Props {
    compact?: boolean;
  }

  let { compact = false }: Props = $props();

  const CARD_COUNT = 12;
  const ROW_COUNT = 10;
  const TITLE_WIDTHS = [68, 82, 57, 74, 63, 78];
  const EXCERPT_WIDTHS = [91, 76, 86, 68, 81, 73];
</script>

{#if compact}
  <div class="flex flex-col py-2" role="status" aria-label="Loading plans">
    <div class="flex h-7 items-end px-3.5 pb-1">
      <Skeleton class="h-2 w-16 rounded-[0.1875rem] opacity-65" />
    </div>
    {#each Array(ROW_COUNT) as _, i (i)}
      <div class="flex h-[3.375rem] items-center gap-2.5 px-3">
        <Skeleton class="size-5 shrink-0 rounded-[0.4375rem] opacity-70" />
        <Skeleton class="size-2.5 shrink-0 rounded-full opacity-55" />
        <div class="flex min-w-0 flex-1 flex-col gap-1.5">
          <Skeleton
            class="h-2.5 rounded-[0.25rem] opacity-85"
            style="width:{TITLE_WIDTHS[i % TITLE_WIDTHS.length]}%"
          />
          <Skeleton
            class="h-2 rounded-[0.1875rem] opacity-55"
            style="width:{EXCERPT_WIDTHS[i % EXCERPT_WIDTHS.length]}%"
          />
        </div>
        <Skeleton class="h-2 w-10 shrink-0 rounded-[0.1875rem] opacity-45" />
      </div>
    {/each}
  </div>
{:else}
  <div role="status" aria-label="Loading plans">
    <div class="flex h-8 items-end pb-2">
      <Skeleton class="h-2 w-20 rounded-[0.1875rem] opacity-65" />
    </div>
    <div class="skeleton-grid">
      {#each Array(CARD_COUNT) as _, i (i)}
        <div class="flex min-h-[6.5rem] overflow-hidden rounded-[0.625rem] bg-(--solus-container-bg) shadow-[0_0.0625rem_0.1875rem_rgba(0,0,0,0.04),0_0.0625rem_0.125rem_rgba(0,0,0,0.02)]">
          <Skeleton class="w-[0.1875rem] shrink-0 rounded-none opacity-55" />
          <div class="flex min-w-0 flex-1 flex-col gap-2.5 px-3 py-2.5">
            <div class="flex items-center gap-1.5">
              <Skeleton class="size-4 shrink-0 rounded-[0.3125rem] opacity-70" />
              <Skeleton class="h-2 w-14 rounded-[0.1875rem] opacity-50" />
              <Skeleton class="h-2 w-8 rounded-[0.1875rem] opacity-40" />
            </div>
            <Skeleton
              class="h-3 rounded-[0.25rem] opacity-85"
              style="width:{TITLE_WIDTHS[i % TITLE_WIDTHS.length]}%"
            />
            <div class="flex flex-col gap-1.5">
              <Skeleton
                class="h-2 rounded-[0.1875rem] opacity-55"
                style="width:{EXCERPT_WIDTHS[i % EXCERPT_WIDTHS.length]}%"
              />
              <Skeleton
                class="h-2 rounded-[0.1875rem] opacity-45"
                style="width:{Math.max(42, EXCERPT_WIDTHS[i % EXCERPT_WIDTHS.length] - 24)}%"
              />
            </div>
          </div>
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  .skeleton-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.5rem;
  }

  @container plans-gallery (max-width: 56.25rem) {
    .skeleton-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @container plans-gallery (max-width: 40rem) {
    .skeleton-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
