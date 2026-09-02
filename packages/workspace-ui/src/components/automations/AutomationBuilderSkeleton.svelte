<script lang="ts">
  import { Skeleton } from "../ui/skeleton";

  /**
   * The builder's silhouette: the breadcrumb band, the title block and stat
   * strip down the main column, and the settings rail beside them.
   *
   * The builder is reached by a lazy import and it also waits for the store to
   * carry the automation it was asked for, so there are two moments before it
   * can draw. Both land here, and moving the pane across replays them — which
   * is why this mirrors the real two-column measures rather than centring a
   * word on an empty pane.
   */
  const railRows = [64, 78, 52, 70, 58];
</script>

<div
  class="@container flex h-full min-h-0 flex-1 flex-col bg-[color:color-mix(in_srgb,var(--solus-container-bg)_90%,color-mix(in_srgb,var(--solus-input-pill-bg)_70%,var(--solus-surface-primary))_10%)]"
  role="status"
  aria-busy="true"
  aria-label="Loading automation"
>
  <div
    class="workspace-titlebar flex h-(--solus-chrome-row-h) shrink-0 items-center gap-[0.4375rem] border-b border-border/45 pr-[max(0.875rem,var(--solus-pane-chrome-inset,0px))] pl-[max(1.25rem,var(--solus-chrome-lead-inset,0px))]"
    aria-hidden="true"
  >
    <Skeleton class="h-3 w-24 rounded-[0.1875rem] opacity-60" />
    <span class="text-muted-foreground/45">/</span>
    <Skeleton class="h-3 w-32 rounded-[0.1875rem] opacity-50" />
  </div>

  <div
    class="flex min-h-0 flex-1 items-start justify-center gap-16 overflow-hidden px-14 pt-12 pb-18 pointer-fine:[.is-laptop-display_&]:gap-10 pointer-fine:[.is-laptop-display_&]:px-9 pointer-fine:[.is-laptop-display_&]:pt-8 pointer-fine:[.is-laptop-display_&]:pb-12 pointer-coarse:gap-7.5 pointer-coarse:px-5 pointer-coarse:pt-5.5 pointer-coarse:pb-9 @max-[65rem]:flex-col @max-[65rem]:items-stretch @max-[65rem]:justify-start @max-[65rem]:gap-7.5 @max-[65rem]:px-7 @max-[65rem]:pt-7 @max-[65rem]:pb-11"
    aria-hidden="true"
  >
    <main
      class="flex w-full min-w-0 max-w-[53.75rem] flex-1 flex-col @max-[65rem]:max-w-none @max-[65rem]:flex-none"
    >
      <div
        class="flex items-start justify-between gap-7 @max-[43.75rem]:flex-col @max-[43.75rem]:gap-3.5"
      >
        <div class="flex min-w-0 flex-1 flex-col gap-2.5">
          <div class="flex items-center gap-2">
            <Skeleton class="h-2.5 w-14 rounded-[0.1875rem] opacity-55" />
            <Skeleton class="h-2.5 w-28 rounded-[0.1875rem] opacity-40" />
          </div>
          <Skeleton class="h-[30px] w-[62%] max-w-[26rem] rounded-md opacity-70" />
        </div>
        <div class="flex shrink-0 items-center gap-1.5 pt-4 @max-[43.75rem]:pt-0">
          <Skeleton
            class="h-[2.0625rem] w-24 rounded-full opacity-50 [.is-laptop-display_&]:h-[1.875rem]"
          />
          <Skeleton
            class="h-[2.0625rem] w-28 rounded-full opacity-60 [.is-laptop-display_&]:h-[1.875rem]"
          />
        </div>
      </div>

      <div
        class="mt-6 grid grid-cols-[auto_auto_1fr] items-center gap-x-10 gap-y-3.5 rounded-2xl bg-muted/60 px-4.5 py-4 [.is-laptop-display_&]:mt-5 [.is-laptop-display_&]:gap-x-8 [.is-laptop-display_&]:py-3.5 @max-[43.75rem]:grid-cols-1 @max-[43.75rem]:gap-4"
      >
        {#each [0, 1] as column (column)}
          <div class="flex min-w-0 flex-col gap-1">
            <Skeleton class="h-2.5 w-16 rounded-[0.1875rem] opacity-45" />
            <Skeleton class="h-3 w-24 rounded-[0.1875rem] opacity-55" />
          </div>
        {/each}
        <div
          class="flex min-w-0 flex-col gap-1.5 justify-self-end @max-[43.75rem]:justify-self-start"
        >
          <Skeleton class="h-2.5 w-14 rounded-[0.1875rem] opacity-45" />
          <Skeleton class="h-3.5 w-26 rounded-[0.1875rem] opacity-50" />
        </div>
      </div>

      <div
        class="mt-8.5 flex flex-col gap-4.5 [.is-laptop-display_&]:mt-7 [.is-laptop-display_&]:gap-4"
      >
        <Skeleton class="h-3 w-28 rounded-[0.1875rem] opacity-55" />
        <div class="flex flex-col gap-2.5">
          {#each [96, 88, 91, 64] as width, index (index)}
            <Skeleton
              class="h-3 rounded-[0.1875rem] opacity-45"
              style="width:{width}%; animation-delay:{index * 80}ms"
            />
          {/each}
        </div>
      </div>
    </main>

    <aside
      class="w-[21.25rem] shrink-0 [.is-laptop-display_&]:w-[19rem] @max-[65rem]:w-auto"
    >
      <div
        class="flex flex-col gap-6.5 rounded-2xl border border-border/55 bg-card p-5 [.is-laptop-display_&]:gap-5 [.is-laptop-display_&]:p-4 @max-[65rem]:flex-row @max-[65rem]:flex-wrap @max-[65rem]:gap-x-10 @max-[65rem]:gap-y-6.5"
      >
        <div class="flex min-w-0 flex-1 flex-col gap-3 [.is-laptop-display_&]:gap-2.5">
          {#each railRows as width, index (index)}
            <div class="flex items-center gap-3">
              <Skeleton class="h-2.5 w-14 shrink-0 rounded-[0.1875rem] opacity-40" />
              <Skeleton
                class="h-3 rounded-[0.1875rem] opacity-50"
                style="width:{width}%; animation-delay:{140 + index * 55}ms"
              />
            </div>
          {/each}
        </div>
      </div>
    </aside>
  </div>
</div>
