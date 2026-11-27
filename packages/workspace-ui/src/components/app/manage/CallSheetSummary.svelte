<script lang="ts">
  import MarkdownAlert from "../../ui/MarkdownAlert.svelte";
  import type { CallSheetFact } from "./lib/call-sheet";

  /**
   * The top of a call in the call sheet: its key facts in one row, then its
   * error as a callout band with the stack under it.
   */
  interface Props {
    facts: CallSheetFact[];
    error: string | null;
    stack?: string | null;
  }
  let { facts, error, stack = null }: Props = $props();
</script>

<div class="flex min-w-0 flex-col gap-5.5 px-6">
  <dl class="m-0 flex min-w-0 flex-wrap gap-x-7 gap-y-3" aria-label="Key facts">
    {#each facts as fact (fact.label)}
      <div class="flex min-w-0 flex-col gap-0.75">
        <dt class="text-xs text-(--solus-text-tertiary)">{fact.label}</dt>
        <dd class="m-0 truncate text-foreground select-text {fact.mono ? 'font-mono text-[13px] leading-4.75' : 'text-sm leading-4.75'}" title={fact.value}>{fact.value}</dd>
        {#if fact.detail}
          <dd class="m-0 truncate text-xs text-(--solus-text-tertiary)" title={fact.detail}>{fact.detail}</dd>
        {/if}
      </div>
    {/each}
  </dl>
  {#if error}
    <!-- An error is a callout band, not a tinted card. The integrator names this kind Error later. -->
    <div class="min-w-0 select-text" role="alert">
      <MarkdownAlert alertType="error">
        {#snippet content()}
          <p class="m-0 text-[13.5px] text-foreground text-pretty">{error}</p>
          {#if stack}
            <pre class="m-0 mt-1.5 max-h-40 overflow-auto font-mono text-[11.5px] leading-4.25 whitespace-pre text-(--solus-text-tertiary)" aria-label="Stack">{stack}</pre>
          {/if}
        {/snippet}
      </MarkdownAlert>
    </div>
  {/if}
</div>
