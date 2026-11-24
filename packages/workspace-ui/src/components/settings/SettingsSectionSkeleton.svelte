<script lang="ts">
  import { Skeleton } from "../ui/skeleton";

  // Cards of rows, shaped like a real section so the content replaces them without a jump.
  const ROW_WIDTHS = [72, 88, 61, 79];
</script>

<div class="flex flex-col gap-8">
  {#each ROW_WIDTHS as width, i (i)}
    <div class="flex flex-col gap-2.5">
      <Skeleton class="ml-4 h-2.5 w-24 rounded-[0.1875rem] opacity-45" />
      <div
        class="flex flex-col overflow-hidden rounded-xl border border-border/60 bg-background [&>*+*]:border-t [&>*+*]:border-border/50"
      >
        {#each [0, 1] as row (row)}
          <div class="flex items-center justify-between gap-4 px-4 py-3">
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
