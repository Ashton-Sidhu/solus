<script lang="ts">
  // Deterministic widths so the rows read like list entries and never reshuffle.
  const ROW_WIDTHS = [34, 22, 28, 41, 19, 36, 26, 31];
</script>

<!-- One pulse for the whole block, so the bars never flicker out of step. -->
<div class="flex flex-col p-2 motion-safe:animate-pulse" role="status" aria-label="Loading">
  {#each ROW_WIDTHS as width, i (i)}
    <div class="flex h-[2.25rem] items-center gap-2.5 px-3" aria-hidden="true">
      <div class="size-3.5 shrink-0 rounded-[0.1875rem] bg-(--solus-surface-secondary)"></div>
      <div class="h-2.5 rounded-[0.1875rem] bg-(--solus-surface-secondary)" style="width:{width}%"></div>
    </div>
  {/each}
</div>
