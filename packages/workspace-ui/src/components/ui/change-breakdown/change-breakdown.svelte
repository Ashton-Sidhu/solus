<script lang="ts">
  import type { ChangeBreakdownPart, ChangeTotals } from "@solus/client-core/change-breakdown";
  import { churnShares } from "./change-breakdown";

  /** A change's lines by kind — Code, Tests, Mocks, Generated, Docs. Each row
   *  is a quiet label, a bar of its share of the churn, and its counts; with
   *  `total`, a hairline and a Total row close it. The pull request header
   *  and list show it in the tooltip of their churn. A zero count is muted,
   *  so it reads as absence rather than as data. */
  let { parts, total }: { parts: readonly ChangeBreakdownPart[]; total?: ChangeTotals } = $props();

  const shares = $derived(churnShares(parts));
</script>

{#snippet counts(additions: number, deletions: number)}
  <span class="text-right {additions ? 'text-(--solus-art-positive)' : 'text-(--solus-text-tertiary)'}">
    {additions ? `+${additions}` : "0"}
  </span>
  <span class="text-right {deletions ? 'text-(--solus-art-negative)' : 'text-(--solus-text-tertiary)'}">
    {deletions ? `−${deletions}` : "0"}
  </span>
{/snippet}

<div class="grid grid-cols-[auto_3.5rem_auto_auto] items-center gap-x-2.5 gap-y-1.5 px-1 py-1.5 font-normal tabular-nums">
  {#each parts as part, index (part.kind)}
    <span class="text-(--solus-text-secondary)">{part.label}</span>
    <span class="h-1 overflow-hidden rounded-full bg-[var(--wash-2)]" aria-hidden="true">
      <span class="block h-full rounded-full bg-(--solus-text-tertiary)" style:width="{shares[index]}%"></span>
    </span>
    {@render counts(part.additions, part.deletions)}
  {/each}
  {#if total}
    <span class="col-span-4 my-px h-px bg-[var(--hairline)]" aria-hidden="true"></span>
    <span class="font-medium text-(--solus-text-primary)">Total</span>
    <span></span>
    {@render counts(total.additions, total.deletions)}
  {/if}
</div>
