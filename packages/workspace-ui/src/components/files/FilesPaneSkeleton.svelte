<script lang="ts">
  interface Props {
    /** `tree` mirrors the file-tree column, `editor` the code surface. */
    variant: "tree" | "editor";
  }

  let { variant }: Props = $props();

  // Deterministic widths/indents so the placeholder reads like a real tree
  // instead of a uniform bar stack, and never reshuffles between renders.
  const TREE_ROWS = Array.from({ length: 14 }, (_, i) => ({
    indent: [0, 0.75, 1.5, 0.75, 1.5, 1.5, 0, 0.75, 0.75, 1.5, 2.25, 0.75, 0, 0.75][i],
    width: 38 + ((i * 23) % 46),
  }));
  const EDITOR_ROWS = Array.from({ length: 18 }, (_, i) => ({
    indent: [0, 0, 1, 1, 2, 2, 1, 0, 0, 1, 1, 1, 2, 1, 0, 0, 1, 1][i],
    width: 22 + ((i * 29) % 55),
  }));
</script>

<!-- One pulse for the whole block. A shimmer per bar sweeps each bar at a
     speed set by its own width, so dozens of small bars flicker out of step. -->
{#if variant === "tree"}
  <div class="flex flex-col gap-1.5 px-2.5 pt-2.5 motion-safe:animate-pulse" aria-hidden="true">
    <div class="mb-1.5 mr-[2.125rem] h-5 rounded bg-(--solus-surface-secondary)"></div>
    {#each TREE_ROWS as row, i (i)}
      <div class="flex items-center gap-2 py-[0.1875rem]" style="padding-left:{row.indent}rem">
        <div class="size-[0.6875rem] shrink-0 rounded-[0.1875rem] bg-(--solus-surface-secondary)"></div>
        <div
          class="h-[0.6875rem] shrink-0 rounded-[0.1875rem] bg-(--solus-surface-secondary)"
          style="width:{row.width}%"
        ></div>
      </div>
    {/each}
  </div>
{:else}
  <div class="flex flex-1 flex-col gap-[0.375rem] px-3 py-3 motion-safe:animate-pulse" aria-hidden="true">
    {#each EDITOR_ROWS as row, i (i)}
      <div class="flex items-center gap-3">
        <div class="h-[0.6875rem] w-4 shrink-0 rounded-[0.1875rem] bg-(--solus-surface-secondary) opacity-60"></div>
        <div
          class="h-[0.6875rem] shrink-0 rounded-[0.1875rem] bg-(--solus-surface-secondary)"
          style="width:{row.width}%;margin-left:{row.indent * 1.25}rem"
        ></div>
      </div>
    {/each}
  </div>
{/if}
