<script lang="ts">
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
        <span class="skel-block shrink-0 overflow-hidden rounded-[0.1875rem] bg-(--solus-surface-secondary)" style="width:7.5rem;height:0.625rem"></span>
        <span class="flex-1"></span>
        <span class="skel-block shrink-0 overflow-hidden rounded-[0.1875rem] bg-(--solus-surface-secondary)" style="width:2rem;height:0.625rem"></span>
      </div>
      <div class="flex flex-col gap-1 px-3 py-2.5">
        {#each Array(8) as _, j (j)}
          <div class="flex items-center gap-2">
            <span class="skel-block shrink-0 overflow-hidden rounded-[0.1875rem] bg-(--solus-surface-secondary)" style="width:1.125rem;height:0.625rem"></span>
            <span
              class="skel-block shrink-0 overflow-hidden rounded-[0.1875rem] bg-(--solus-surface-secondary)"
              style="width:{35 + ((j * 13) % 55)}%;height:0.625rem"
            ></span>
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
          <span class="skel-block shrink-0 overflow-hidden rounded-[0.1875rem] bg-(--solus-surface-secondary)" style="width:0.625rem;height:0.625rem"></span>
          <span
            class="skel-block shrink-0 overflow-hidden rounded-[0.1875rem] bg-(--solus-surface-secondary)"
            style="width:{80 + i * 30}px;height:0.625rem"
          ></span>
          <span class="flex-1"></span>
          <span class="skel-block shrink-0 overflow-hidden rounded-[0.1875rem] bg-(--solus-surface-secondary)" style="width:1.25rem;height:0.625rem"></span>
          <span class="skel-block shrink-0 overflow-hidden rounded-[0.1875rem] bg-(--solus-surface-secondary)" style="width:1.25rem;height:0.625rem"></span>
        </div>
        <div class="flex flex-col gap-1 px-3 py-2.5">
          {#each Array(3 + i) as _, j (j)}
            <div class="flex items-center gap-2">
              <span class="skel-block shrink-0 overflow-hidden rounded-[0.1875rem] bg-(--solus-surface-secondary)" style="width:1.125rem;height:0.625rem"></span>
              <span class="skel-block shrink-0 overflow-hidden rounded-[0.1875rem] bg-(--solus-surface-secondary)" style="width:1.125rem;height:0.625rem"></span>
              <span
                class="skel-block shrink-0 overflow-hidden rounded-[0.1875rem] bg-(--solus-surface-secondary)"
                style="width:{30 + ((j * 17 + i * 13) % 55)}%;height:0.625rem;margin-left:{(j * 11) % 24}px"
              ></span>
            </div>
          {/each}
        </div>
      </div>
    {/each}
  {/if}
</div>

<style>
  .skel-block {
    position: relative;
  }
  .skel-block::after {
    content: "";
    position: absolute;
    inset: 0;
    background: linear-gradient(
      90deg,
      transparent 0%,
      var(--solus-surface-hover) 50%,
      transparent 100%
    );
    transform: translateX(-100%);
    animation: diff-skel-shimmer 1.4s ease-in-out infinite;
  }
  @keyframes diff-skel-shimmer {
    0% {
      transform: translateX(-100%);
    }
    100% {
      transform: translateX(100%);
    }
  }
</style>
