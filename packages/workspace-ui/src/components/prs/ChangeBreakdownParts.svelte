<script lang="ts">
  import type { ChangeBreakdownPart } from "@solus/client-core/change-breakdown";

  /** A change's lines by kind — Code, Tests, Mocks, Generated, Docs — each
   *  with its own added and deleted counts. The pull request header shows it
   *  under Changes; a list row shows it in the tooltip of its churn. */
  let { parts }: { parts: readonly ChangeBreakdownPart[] } = $props();
</script>

<span class="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 tabular-nums">
  {#each parts as part (part.kind)}
    <span class="whitespace-nowrap">
      {part.label}
      <span class="font-mono">
        <span class="text-(--solus-art-positive)">+{part.additions}</span>
        <span class="text-(--solus-art-negative)">−{part.deletions}</span>
      </span>
    </span>
  {/each}
</span>
