<script lang="ts">
  import {
    CircleX,
    Cpu,
    DatabaseZap,
    Gauge,
    Repeat2,
    ShieldX,
    UserRound,
  } from "@lucide/svelte";
  import type { FindingKind, TurnFinding } from "./lib/turn-analysis";
  import FindingRow from "./FindingRow.svelte";

  /**
   * What to look at first.
   *
   * The trace is a record; this is the reading of it. A failed span with its
   * error text, a denied permission, a command run three times, a turn that
   * mostly waited, a cache written and never read, a top-tier model spent on
   * a lookup — each one a line, in the order a reader should take them, and
   * each one a way into the span it is about. Absent when there is nothing
   * to say: a card that reads "no findings" is a card that cost the reader a
   * glance for nothing.
   *
   * The icon names what the finding is about; its tint says how much it
   * matters, the same badge the stat tiles use for their verdicts.
   */
  interface Props {
    findings: TurnFinding[];
    /** Lands the waterfall on the finding's first span. */
    onOpenSpan: (spanId: string) => void;
  }

  let { findings, onOpenSpan }: Props = $props();

  const KIND_ICONS = {
    failure: CircleX,
    denied: ShieldX,
    repeat: Repeat2,
    "user-wait": UserRound,
    "cache-miss": DatabaseZap,
    "context-fill": Gauge,
    "model-choice": Cpu,
  } satisfies Record<FindingKind, typeof CircleX>;

  function toneColor(tone: TurnFinding["tone"]): string | null {
    if (tone === "failure") return "var(--failure)";
    if (tone === "warning") return "var(--warning)";
    return null;
  }
</script>

{#if findings.length > 0}
  <section
    class="flex flex-col overflow-hidden rounded-xl bg-card shadow-[shadow:var(--insights-card-shadow)]"
    aria-label="Findings"
  >
    <header class="mt-2 flex h-7 shrink-0 items-baseline gap-2 pr-3 pl-4">
      <h2 class="m-0 text-insights-summary font-medium">Findings</h2>
      <span class="text-insights-chrome tabular-nums text-muted-foreground">{findings.length}</span>
    </header>
    <ul class="m-0 flex list-none flex-col gap-px px-2 pb-2">
      {#each findings as finding (finding.id)}
        {@const spanId = finding.spanIds[0]}
        <li class="m-0">
          <!-- A finding with a span is a way into the trace; one without is a
               statement about the whole turn, and stays a line of text. -->
          <FindingRow
            icon={KIND_ICONS[finding.kind]}
            color={toneColor(finding.tone)}
            title={finding.title}
            detail={finding.detail}
            onOpen={spanId ? () => onOpenSpan(spanId) : undefined}
          />
        </li>
      {/each}
    </ul>
  </section>
{/if}
