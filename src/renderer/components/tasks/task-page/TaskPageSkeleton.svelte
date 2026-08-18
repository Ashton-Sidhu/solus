<script lang="ts">
  import { Skeleton } from "../../ui/skeleton";

  const sidebarRows = [54, 48, 58, 52, 62, 44];
  const activityRows = [78, 64];
</script>

<div
  class="@container relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background"
  role="status"
  aria-label="Loading task"
>
  <div
    class="workspace-titlebar flex h-(--solus-chrome-row-h,2.75rem) shrink-0 items-center gap-2 pr-3.5 pl-[max(1.125rem,var(--solus-chrome-lead-inset,0px))]"
    aria-hidden="true"
  >
    <Skeleton class="size-4 shrink-0 rounded-[0.25rem] opacity-60" />
    <Skeleton class="h-3 w-20 rounded-[0.1875rem] opacity-65" />
    <span class="px-0.5 text-sm opacity-15">/</span>
    <Skeleton class="h-3 w-10 rounded-[0.1875rem] opacity-55" />
    <span class="px-0.5 text-sm opacity-15">/</span>
    <Skeleton class="h-3 w-[4.5rem] rounded-[0.1875rem] opacity-50" />

    <span class="flex-1"></span>

    <Skeleton class="mr-2 h-[26px] w-32 rounded-full opacity-55 @max-[42rem]:hidden" />
    {#each Array(4) as _, index}
      <Skeleton
        class="size-[26px] rounded-full opacity-45"
        style="animation-delay:{120 + index * 55}ms"
      />
    {/each}
  </div>

  <div class="min-h-0 flex-1 overflow-hidden" aria-hidden="true">
    <div
      class="mx-auto flex w-full max-w-[1420px] items-start gap-[34px] px-[52px] pt-6 @max-[60rem]:flex-col @max-[60rem]:gap-6 @max-[60rem]:px-6 @max-[42rem]:px-4"
    >
      <div class="flex min-w-0 flex-1 flex-col">
        <div class="flex items-center gap-[13px] pb-[11px]">
          <Skeleton class="h-3 w-[4.5rem] rounded-[0.1875rem] opacity-60" />
          <span class="h-[11px] w-px bg-[var(--hairline-strong)]"></span>
          <Skeleton class="h-3 w-14 rounded-[0.1875rem] opacity-50" />
          <span class="h-[11px] w-px bg-[var(--hairline-strong)]"></span>
          <Skeleton class="h-2.5 w-24 rounded-[0.1875rem] opacity-40" />
        </div>

        <Skeleton class="h-[30px] w-[68%] max-w-[660px] rounded-md opacity-70" />
        <div class="flex flex-col gap-2.5 pt-[22px]">
          <Skeleton class="h-3 w-[94%] rounded-[0.1875rem] opacity-55" />
          <Skeleton class="h-3 w-[83%] rounded-[0.1875rem] opacity-50" />
          <Skeleton class="h-3 w-[57%] rounded-[0.1875rem] opacity-45" />
        </div>

        <div class="mt-9 flex items-center gap-2 pb-3">
          <Skeleton class="h-3 w-20 rounded-[0.1875rem] opacity-55" />
          <Skeleton class="h-[18px] w-5 rounded-full opacity-40" />
        </div>
        <div
          class="overflow-hidden rounded-xl shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_10%,transparent)]"
        >
          {#each [74, 58, 66] as width, index}
            <div
              class="flex h-11 items-center gap-3 px-3.5 {index ? 'border-t-[.5px] border-[var(--hairline)]' : ''}"
            >
              <Skeleton class="size-5 shrink-0 rounded-[0.3125rem] opacity-50" />
              <Skeleton
                class="h-2.5 rounded-[0.1875rem] opacity-50"
                style="width:{width}%"
              />
              <Skeleton class="ml-auto h-2.5 w-12 rounded-[0.1875rem] opacity-35" />
            </div>
          {/each}
        </div>

        <div class="mt-9 flex items-center gap-2 pb-3">
          <Skeleton class="h-3 w-16 rounded-[0.1875rem] opacity-55" />
        </div>
        <div class="flex flex-col gap-4">
          {#each activityRows as width, index}
            <div class="flex gap-3" style="animation-delay:{260 + index * 70}ms">
              <Skeleton class="size-7 shrink-0 rounded-full opacity-50" />
              <div class="flex min-w-0 flex-1 flex-col gap-2 pt-1">
                <Skeleton class="h-2.5 w-28 rounded-[0.1875rem] opacity-50" />
                <Skeleton
                  class="h-3 rounded-[0.1875rem] opacity-40"
                  style="width:{width}%"
                />
              </div>
            </div>
          {/each}
        </div>
      </div>

      <div
        class="sticky top-0 flex w-[var(--task-rail-width)] [--task-rail-width:308px] shrink-0 flex-col overflow-hidden rounded-2xl bg-card shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_11%,transparent),0_1px_2px_-1px_rgba(0,0,0,.05),0_12px_28px_-12px_rgba(0,0,0,.14)] [.is-laptop-display_&]:[--task-rail-width:260px] @max-[60rem]:static @max-[60rem]:w-full"
      >
        <div class="flex flex-col gap-1 px-3.5 py-[15px]">
          {#each sidebarRows as width, index}
            <div class="flex h-[34px] items-center">
              <Skeleton class="ml-0.5 h-2.5 w-14 rounded-[0.1875rem] opacity-40" />
              <Skeleton
                class="ml-6 h-3 rounded-[0.1875rem] opacity-50"
                style="width:{width}% ; animation-delay:{180 + index * 45}ms"
              />
            </div>
          {/each}
        </div>
        <div class="border-t-[.5px] border-[var(--hairline)] px-3.5 py-4">
          <Skeleton class="mb-4 h-2.5 w-16 rounded-[0.1875rem] opacity-45" />
          <div class="flex h-[34px] items-center gap-3">
            <Skeleton class="h-2.5 w-14 rounded-[0.1875rem] opacity-40" />
            <Skeleton class="h-3 w-32 rounded-[0.1875rem] opacity-50" />
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
