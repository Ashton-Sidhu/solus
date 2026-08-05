<script lang="ts">
  import type { ListKeyHint } from "./list-page";

  /**
   * The footer rail: what the keyboard does here, and how much there is. Shared
   * by the list page and the pull-request detail it opens into, so the two read
   * as one surface — the keys change, the band does not.
   */
  let {
    hints = [],
    count,
    fullWidth = false,
  }: {
    /** Four hints maximum; the set changes with the view, never with hover. */
    hints?: ListKeyHint[];
    /** Right-aligned tally ("9 pull requests", "#411 · 2 of 9"). */
    count?: string;
    /** Let detail surfaces use the whole pane rather than the list measure. */
    fullWidth?: boolean;
  } = $props();
</script>

<!-- Full-bleed, but its contents repeat the inner column. -->
<div class="shrink-0 border-t border-[var(--hairline)] bg-[var(--wash-1)]">
  <div
    class="mx-auto flex w-full items-center gap-3.5 py-[9px] {fullWidth
      ? 'px-4'
      : 'max-w-[72rem] px-8 @min-[90rem]:max-w-[82rem] @min-[110rem]:max-w-[94rem] @max-[44rem]:px-5 @max-[34rem]:px-4'}"
  >
    {#each hints as hint (hint.key)}
      <span class="flex items-center gap-1.5">
        <span
          class="rounded-md bg-[var(--wash-2)] px-[7px] py-[3px] font-mono text-[10.5px] tracking-[.04em] shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_12%,transparent),inset_0_-1px_0_color-mix(in_oklch,var(--foreground)_9%,transparent)]"
          >{hint.key}</span
        >
        <span class="text-[11px] text-muted-foreground">{hint.label}</span>
      </span>
    {/each}
    <span class="flex-1"></span>
    {#if count}
      <span class="font-mono text-[10.5px] tabular-nums text-muted-foreground opacity-75">
        {count}
      </span>
    {/if}
  </div>
</div>
