<script lang="ts">
  import { Skeleton } from "../ui/skeleton";

  /**
   * The turn detail's silhouette: the identity block, the waterfall card, and
   * the attributes rail beside it.
   *
   * The open turn lives in the route's params, so it survives the pane it was
   * read in — moving the console across re-reads the trace, and this is what
   * stands in while that happens.
   */
  const waterfallRows = [92, 64, 78, 45, 83, 38, 70];
</script>

<div
  class="mx-auto flex w-full max-w-[87.5rem] flex-col gap-4.5 py-6"
  role="status"
  aria-busy="true"
  aria-label="Loading the turn’s spans"
>
  <div class="flex flex-wrap items-start justify-between gap-6" aria-hidden="true">
    <div class="flex min-w-0 flex-col gap-1.5">
      <Skeleton class="h-4 w-[26rem] max-w-full rounded opacity-65" />
      <Skeleton class="h-2.5 w-72 max-w-full rounded-[0.1875rem] opacity-45" />
    </div>
    <Skeleton class="h-7.5 w-36 shrink-0 rounded-lg opacity-50" />
  </div>

  <div class="flex flex-col gap-2.5 @4xl:flex-row" aria-hidden="true">
    <div class="flex min-w-0 flex-1 flex-col gap-2.5">
      <section class="overflow-hidden rounded-xl bg-card">
        <header class="flex h-11 items-center gap-3 px-5">
          <Skeleton class="h-3 w-24 rounded-[0.1875rem] opacity-55" />
          <span class="flex-1"></span>
          <Skeleton class="h-2.5 w-40 rounded-[0.1875rem] opacity-40" />
        </header>

        <div class="px-5 pt-3.5 pb-3 shadow-[inset_0_-0.5px_0_var(--hairline)]">
          <Skeleton class="h-2 w-full rounded-full opacity-40" />
        </div>

        <!-- The waterfall's own shape: each bar starts where its parent left
             off, so the placeholder staggers its offsets rather than drawing a
             stack of equal rows that the real plot would then rearrange. -->
        <div class="flex flex-col gap-2 px-5 pt-3 pb-4">
          {#each waterfallRows as width, index (index)}
            <div class="flex items-center gap-3">
              <Skeleton class="h-2.5 w-24 shrink-0 rounded-[0.1875rem] opacity-40" />
              <div class="min-w-0 flex-1">
                <Skeleton
                  class="h-3 rounded-[0.1875rem] opacity-50"
                  style="width:{width}%; margin-left:{index * 4}%; animation-delay:{index * 65}ms"
                />
              </div>
            </div>
          {/each}
        </div>
      </section>
    </div>

    <aside class="flex w-full shrink-0 flex-col gap-2.5 @4xl:w-[19.25rem]">
      <div class="flex flex-col gap-3 rounded-xl bg-card px-4 py-3.5">
        {#each [58, 74, 46, 66, 52, 70] as width, index (index)}
          <div class="flex items-center gap-3">
            <Skeleton class="h-2.5 w-16 shrink-0 rounded-[0.1875rem] opacity-40" />
            <Skeleton
              class="h-2.5 rounded-[0.1875rem] opacity-50"
              style="width:{width}%; animation-delay:{150 + index * 50}ms"
            />
          </div>
        {/each}
      </div>
    </aside>
  </div>
</div>
