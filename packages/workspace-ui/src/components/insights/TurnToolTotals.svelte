<script lang="ts">
  import { formatDuration, formatPercent } from "./lib/format";
  import type { ToolTotal } from "./lib/waterfall";

  /**
   * The turn's tool calls, longest first.
   *
   * A card of its own beside the session summary: it measures this turn, while
   * the neighbouring card answers a different question at session depth.
   *
   * Plain rows, not filled ones. The row's background used to be a bar of its
   * own share, and five bars of tool-call teal directly above a waterfall of
   * the same teal read as five more spans. The share is printed instead, and
   * the waterfall below keeps the picture.
   */
  interface Props {
    totals: ToolTotal[];
  }

  let { totals }: Props = $props();

  // Five is a list a reader takes in at a glance; past that the ranking is
  // reading matter of its own, and the trace below already holds every call.
  const visible = $derived(totals.slice(0, 5));
</script>

{#if visible.length > 0}
  <section
    class="flex flex-col overflow-hidden rounded-xl bg-card shadow-[shadow:var(--insights-card-shadow)]"
    aria-label="Longest tool calls"
  >
    <header class="mt-2 flex h-7 shrink-0 items-baseline gap-2 pr-3 pl-4">
      <h2 class="m-0 text-insights-summary font-medium">Longest tool calls</h2>
      <span class="text-insights-chrome tabular-nums text-muted-foreground"
        >{totals.length}</span
      >
    </header>

    <div class="flex flex-col gap-px px-2 pb-2">
      {#each visible as total (total.tool)}
        <div
          class="flex h-6 items-center gap-2 rounded-md px-2 text-insights-summary transition-colors hover:bg-[var(--wash-1)]"
          title="{total.tool} · ×{total.calls} · {formatDuration(total.ms)} · {formatPercent(
            total.share,
          )} of the turn"
        >
          <span class="min-w-0 flex-1 truncate select-text">{total.tool}</span>
          <span class="shrink-0 text-insights-chrome text-muted-foreground tabular-nums">×{total.calls}</span>
          <span class="w-8 shrink-0 text-right text-insights-chrome text-muted-foreground tabular-nums"
            >{formatPercent(total.share)}</span
          >
          <span class="w-11 shrink-0 text-right text-insights-chrome tabular-nums select-text"
            >{formatDuration(total.ms)}</span
          >
        </div>
      {/each}
    </div>
  </section>
{/if}
