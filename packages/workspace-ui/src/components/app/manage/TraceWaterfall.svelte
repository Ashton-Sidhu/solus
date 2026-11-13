<script lang="ts">
  import type { AppSpan } from "@solus/contracts/apps";
  import { formatDuration } from "../../insights/lib/format";
  import { spanKindLabel, traceWaterfall } from "./lib/trace";

  /** The trace of one call (docs/plans/apps.md §9.2): each thing the call waited for, as a bar on the call's own time line. */
  interface Props {
    spans: AppSpan[];
    /** How long the call took; null while it runs. */
    durationMs: number | null;
  }
  let { spans, durationMs }: Props = $props();

  const waterfall = $derived(traceWaterfall(spans, durationMs));
</script>

<ul class="m-0 flex list-none flex-col gap-1 p-0" aria-label="Trace, {formatDuration(waterfall.totalMs)} in all" data-testid="app-call-trace">
  {#each waterfall.rows as row, index (index)}
    {@const span = row.span}
    <li
      class="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_3.5rem] items-center gap-2 text-xs"
      title="{spanKindLabel(span.kind)} · {span.name} · starts at {formatDuration(span.startMs)}, takes {formatDuration(span.durationMs)}{span.detail ? ` · ${span.detail}` : ''}"
    >
      <span class="flex min-w-0 items-baseline gap-1.5">
        <span class="shrink-0 text-muted-foreground">{spanKindLabel(span.kind)}</span>
        <span class="min-w-0 truncate font-mono {span.ok ? 'text-foreground' : 'text-destructive'}">{span.name}</span>
      </span>
      <span class="relative h-3 min-w-0 rounded-sm bg-[var(--wash-2)]" aria-hidden="true">
        <span
          class="absolute inset-y-0.5 rounded-sm {span.ok ? 'bg-[color-mix(in_oklch,var(--foreground)_45%,transparent)]' : 'bg-destructive'}"
          style="left:{row.leftPercent}%;width:{row.widthPercent}%"
        ></span>
      </span>
      <span class="text-right tabular-nums text-muted-foreground">{formatDuration(span.durationMs)}{span.ok ? "" : " failed"}</span>
    </li>
  {/each}
</ul>
