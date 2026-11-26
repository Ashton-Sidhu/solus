<script lang="ts">
  /** What one policy does, in words: each rule it sets and its value. */
  import type { PolicyRule } from "./lib/policy-rules";

  let { rules }: { rules: PolicyRule[] | null } = $props();
</script>

{#if rules === null}
  <p class="text-xs text-muted-foreground">This Solus version cannot read this policy. Update Solus to see its rules.</p>
{:else if rules.length === 0}
  <p class="text-xs text-muted-foreground">Sets no rules.</p>
{:else}
  <dl class="grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-1.5 text-xs">
    {#each rules as rule (rule.label)}
      <dt class="min-w-0 truncate text-muted-foreground">{rule.label}</dt>
      <dd class="max-w-64 truncate text-right text-foreground" title={rule.value}>{rule.value}</dd>
    {/each}
  </dl>
{/if}
