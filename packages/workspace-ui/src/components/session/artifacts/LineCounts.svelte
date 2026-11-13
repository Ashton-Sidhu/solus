<script lang="ts">
  /**
   * Added and deleted line counts, in the diff's own green and red, as the
   * conversation's changed-files card writes them. A side with nothing is left out, so a new
   * file shows only what it adds and a deleted one only what it removes.
   * With `columns`, each side has its own column of one width, so the counts
   * of a list line up under each other: additions under additions, deletions
   * under deletions.
   */
  interface Props {
    additions: number;
    deletions: number;
    columns?: boolean;
    class?: string;
  }
  let { additions, deletions, columns = false, class: className = "" }: Props = $props();
</script>

{#if columns}
  <span class="grid shrink-0 grid-cols-[6ch_6ch] text-right text-xs tabular-nums {className}">
    <span class="text-(--solus-diff-added-text-vivid)">{additions > 0 ? `+${additions}` : ""}</span>
    <span class="text-(--solus-diff-removed-text-vivid)">{deletions > 0 ? `−${deletions}` : ""}</span>
  </span>
{:else}
  <span class="shrink-0 text-xs tabular-nums {className}">
    {#if additions > 0}<span class="text-(--solus-diff-added-text-vivid)">+{additions}</span>{/if}
    {#if deletions > 0}<span class="text-(--solus-diff-removed-text-vivid)">−{deletions}</span>{/if}
  </span>
{/if}
