<script lang="ts">
  import { Skeleton } from "../ui/skeleton";

  /**
   * What the frame shows while a page has nothing to paint yet.
   *
   * A browser page is blank on purpose until the host has emulated it and sent
   * it somewhere, and a streamed one is blank until the first frame lands. Both
   * gaps used to be an unexplained white rectangle, which is what "slow"
   * actually felt like.
   *
   * Both surfaces share it, so a page loading on a phone and the same page
   * loading on the desktop wait in the same way.
   */

  interface Props {
    /** The page being waited for. Named for screen readers, because a pane can
     *  hold several pages and only one of them is loading. */
    label: string;
  }

  let { label }: Props = $props();

  // Deterministic widths so the placeholder reads like a page rather than a
  // uniform bar stack, and never reshuffles between renders.
  const ROWS = [72, 46, 61, 38, 55, 66, 42, 58, 34, 50];
</script>

<div
  class="absolute inset-0 flex flex-col gap-3 overflow-hidden bg-(--solus-container-bg) px-5 py-4"
  role="status"
  aria-label="Loading {label}"
>
  <div class="flex items-center gap-2" aria-hidden="true">
    <Skeleton class="h-[0.625rem] w-20 shrink-0 rounded-[0.1875rem]" />
    <span class="flex-1"></span>
    <Skeleton class="h-[0.625rem] w-10 shrink-0 rounded-[0.1875rem]" />
    <Skeleton class="h-[0.625rem] w-10 shrink-0 rounded-[0.1875rem]" />
  </div>

  <div class="flex flex-col gap-2.5" aria-hidden="true">
    {#each ROWS as width, i (i)}
      <Skeleton
        class="h-[0.625rem] shrink-0 rounded-[0.1875rem]"
        style="width:{width}%;animation-delay:{i * 45}ms"
      />
    {/each}
  </div>
</div>
