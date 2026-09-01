<script lang="ts">
  import { formatDuration } from "./lib/format";
  import type { ToolTotal } from "./lib/waterfall";

  /**
   * The turn's tool calls, longest first.
   *
   * A card of its own beside the session summary: it measures this turn, while
   * the neighbouring card answers a different question at session depth.
   */
  interface Props {
    totals: ToolTotal[];
  }

  let { totals }: Props = $props();

  // Five is a list a reader takes in at a glance; past that the ranking is
  // reading matter of its own, and the trace below already holds every call.
  const visible = $derived(totals.slice(0, 5));
  const maxMs = $derived(Math.max(1, ...visible.map((total) => total.ms)));
</script>

{#if visible.length > 0}
  <section
    class="flex flex-col overflow-hidden rounded-xl bg-card shadow-[shadow:var(--insights-card-shadow)]"
    aria-label="Longest tool calls"
  >
    <header class="flex h-9 shrink-0 items-center gap-2 pr-1.5 pl-3">
      <h2 class="m-0 text-insights-chrome font-normal text-muted-foreground uppercase">
        Longest tool calls
      </h2>
      <span class="text-insights-chrome tabular-nums text-muted-foreground opacity-60"
        >{totals.length}</span
      >
    </header>

    <div class="flex flex-col gap-px px-1.5 pb-2">
      {#each visible as total (total.tool)}
        <!-- The bar is the row's own background rather than a column of its
             own: a separate track leaves the tool name too narrow to read,
             which is the one thing the list exists to say. -->
        <div
          class="relative flex h-6 items-center gap-2 overflow-hidden rounded-md px-2 text-insights-summary"
          title="{total.tool} · ×{total.calls} · {formatDuration(total.ms)}"
        >
          <span
            class="absolute inset-y-0 left-0 rounded-md transition-[width] duration-300"
            style="width:{(total.ms / maxMs) *
              100}%;background:color-mix(in oklch, var(--solus-art-4) 22%, transparent)"
            aria-hidden="true"
          ></span>
          <span class="relative min-w-0 flex-1 truncate select-text">{total.tool}</span>
          <span class="relative shrink-0 text-muted-foreground tabular-nums opacity-70"
            >×{total.calls}</span
          >
          <span class="relative w-11 shrink-0 text-right tabular-nums select-text"
            >{formatDuration(total.ms)}</span
          >
        </div>
      {/each}
    </div>
  </section>
{/if}
