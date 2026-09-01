<script lang="ts">
  import { Skeleton } from "../ui/skeleton";

  interface Props {
    variant?: "diff" | "preview";
  }

  let { variant = "diff" }: Props = $props();
</script>

<div class="flex-1 min-h-0 overflow-hidden p-2 flex flex-col gap-1.5">
  {#if variant === "preview"}
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
