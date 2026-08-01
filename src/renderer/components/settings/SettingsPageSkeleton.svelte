<script lang="ts">
  import { Skeleton } from "../ui/skeleton";

  // Nav groups, sized like the real tab list so the rail doesn't jump width.
  const NAV_GROUPS = [
    { label: 9, items: [4, 5, 3] },
    { label: 7, items: [5, 4, 6, 4] },
    { label: 11, items: [4, 5] },
  ];
  const ROW_WIDTHS = [72, 88, 61, 79];
</script>

<div
  class="flex h-full overflow-hidden [--settings-header-height:2.875rem]"
  role="status"
  aria-label="Loading settings"
>
  <div
    class="hidden w-[clamp(14.75rem,13vw,17rem)] shrink-0 flex-col bg-sidebar border-r border-r-sidebar-border md:flex"
  >
    <div class="px-3 pb-3">
      <div class="h-(--settings-header-height) shrink-0"></div>
      <Skeleton class="h-7 w-full rounded-md opacity-70" />
    </div>
    <div class="flex flex-1 min-h-0 flex-col gap-px overflow-hidden px-3 pb-4">
      {#each NAV_GROUPS as group, g (g)}
        <Skeleton
          class="mt-4 mb-1.5 ml-2 h-2 rounded-[0.1875rem] opacity-45"
          style="width:{group.label * 0.375}rem"
        />
        {#each group.items as item, i (i)}
          <div class="flex h-8 items-center gap-2 px-2">
            <Skeleton class="size-4 shrink-0 rounded-[0.25rem] opacity-60" />
            <Skeleton
              class="h-2.5 rounded-[0.1875rem] opacity-70"
              style="width:{item * 1.125}rem"
            />
          </div>
        {/each}
      {/each}
    </div>
  </div>

  <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
    <header
      class="flex h-(--settings-header-height) shrink-0 items-center justify-between gap-3 border-b border-b-border px-[clamp(2rem,3vw,3rem)]"
    >
      <div class="flex items-center gap-2">
        <Skeleton class="h-2.5 w-12 rounded-[0.1875rem] opacity-50" />
        <Skeleton class="h-2.5 w-16 rounded-[0.1875rem] opacity-70" />
      </div>
      <Skeleton class="size-4 shrink-0 rounded-[0.25rem] opacity-50" />
    </header>

    <div class="flex-1 overflow-hidden px-[clamp(2rem,3vw,3rem)]">
      <div class="mx-auto w-full max-w-[clamp(45rem,66vw,72rem)] pt-8 pb-16">
        <Skeleton class="h-5 w-44 rounded-[0.25rem] opacity-80" />
        <Skeleton class="mt-2.5 h-2.5 w-72 rounded-[0.1875rem] opacity-50" />
        <div class="mt-8 flex flex-col gap-7">
          {#each ROW_WIDTHS as width, i (i)}
            <div class="flex flex-col gap-3">
              <Skeleton class="h-2.5 w-24 rounded-[0.1875rem] opacity-45" />
              <div
                class="flex flex-col gap-px overflow-hidden rounded-lg border border-border"
              >
                {#each [0, 1] as row (row)}
                  <div class="flex items-center justify-between gap-4 px-4 py-3.5">
                    <div class="flex min-w-0 flex-1 flex-col gap-2">
                      <Skeleton
                        class="h-2.5 rounded-[0.1875rem] opacity-70"
                        style="width:{width / 3}%"
                      />
                      <Skeleton
                        class="h-2 rounded-[0.1875rem] opacity-45"
                        style="width:{width}%"
                      />
                    </div>
                    <Skeleton class="h-6 w-11 shrink-0 rounded-full opacity-60" />
                  </div>
                {/each}
              </div>
            </div>
          {/each}
        </div>
      </div>
    </div>
  </div>
</div>
