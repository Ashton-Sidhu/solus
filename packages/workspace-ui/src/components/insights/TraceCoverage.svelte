<script lang="ts">
  import { ChevronDown as CaretDownIcon } from "@lucide/svelte";
  import * as TooltipUI from "../ui/tooltip";
  import type { CoverageEntry, CoverageReading } from "./lib/coverage-readings";
  import { formatDuration, formatPercent } from "./lib/format";
  import {
    PROVIDER_WAIT_CAUSES,
    PROVIDER_WAIT_EXPLANATION,
    PROVIDER_WAIT_KIND,
  } from "./lib/span-palette";
  import { spanDetailLabel, type TraceView } from "./lib/waterfall";

  /**
   * How much of the turn its spans account for, above the waterfall they
   * explain.
   *
   * The bar and its legend are one reading of the same union — a kind's slice is
   * the time covered by its spans, counted once even when two of them
   * overlapped. Provider wait is the remaining coverage remainder after the
   * lead-in to a reported thinking span has been counted as Thinking.
   *
   * The same bar also answers who the turn was waiting on and, when the turn
   * reported a cost, where that cost went. One bar at a time, chosen from the
   * Trace header's menu: three bars stacked over the waterfall read as three
   * plots, when they are three cuts of one interval.
   *
   * Full width, beside the plot it describes rather than shrunk into the rail:
   * a share bar is a picture of the same interval the waterfall draws, and the
   * two only read as one statement when they share an edge.
   */
  interface Props {
    trace: TraceView;
    /** The reading the header's menu chose. */
    reading: CoverageReading;
  }

  let { trace, reading }: Props = $props();

  let gapsOpen = $state(false);

  const gapSegments = $derived(
    trace.gapSummaries.reduce((total, gap) => total + gap.segments, 0),
  );
  const gapMs = $derived(trace.gapSummaries.reduce((total, gap) => total + gap.ms, 0));
</script>

<!-- One key entry: a slice of the bar, not a dot — the mark is literally a piece
     of the thing it explains, cut to the same shape. `hinted` marks the entry
     whose meaning is on hover, so the name says it can be asked. -->
{#snippet legendEntry(entry: CoverageEntry, hinted: boolean)}
  <span
    class="h-[3px] w-2 shrink-0 translate-y-[-2px] rounded-full"
    style="background:{entry.color}"
    aria-hidden="true"
  ></span>
  <span
    class="truncate {hinted
      ? 'underline decoration-muted-foreground/50 decoration-dotted underline-offset-4'
      : ''}">{entry.label}</span
  >
  <span class="shrink-0 tabular-nums text-foreground">{entry.value}</span>
  {#if entry.secondary}
    <span class="shrink-0 tabular-nums">{entry.secondary}</span>
  {/if}
{/snippet}

<!-- The bar, then its key on one line. The legend names a handful of entries,
     and a column of them would be as tall as the waterfall it introduces. -->
<div class="flex flex-col gap-2 text-insights-chrome">
  <div
    class="flex h-1.5 gap-px overflow-hidden rounded-full"
    role="img"
    aria-label={reading.description}
  >
    {#each reading.entries as entry (entry.key)}
      <span
        class="transition-[flex-grow] duration-300"
        style="flex:{Math.max(0.4, entry.share * 100)} 0 0;background:{entry.color}"
        title={entry.title}
      ></span>
    {/each}
  </div>

  <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
    {#each reading.entries as entry (entry.key)}
      {#if reading.id === "kind" && entry.key === PROVIDER_WAIT_KIND}
        <!-- The one entry that is a remainder rather than a measurement, so it
             is the one entry a reader has to be told the meaning of. -->
        <TooltipUI.Root>
          <TooltipUI.Trigger>
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                class="flex min-w-0 cursor-help items-baseline gap-1.5 rounded-sm border-0 bg-transparent p-0 text-left text-insights-chrome text-muted-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--primary)"
              >
                {@render legendEntry(entry, true)}
              </button>
            {/snippet}
          </TooltipUI.Trigger>
          <TooltipUI.Content
            side="bottom"
            align="start"
            class="max-w-80 items-stretch p-0 text-left font-normal whitespace-normal"
          >
            <div class="flex max-w-80 min-w-0 flex-col gap-1.5 p-2.5">
              <div class="font-medium text-(--solus-text-primary)">{entry.label}</div>
              <p class="m-0 text-(--solus-text-secondary) text-pretty">
                {PROVIDER_WAIT_EXPLANATION}
              </p>
              <ul class="m-0 flex list-disc flex-col gap-0.5 pl-3.5 text-(--solus-text-tertiary)">
                {#each PROVIDER_WAIT_CAUSES as cause (cause)}
                  <li class="text-pretty">{cause}</li>
                {/each}
              </ul>
            </div>
          </TooltipUI.Content>
        </TooltipUI.Root>
      {:else}
        <span
          class="flex min-w-0 items-baseline gap-1.5 text-muted-foreground"
          title={entry.title}
        >
          {@render legendEntry(entry, false)}
        </span>
      {/if}
    {/each}

    {#if reading.note}
      <span class="text-muted-foreground">{reading.note}</span>
    {/if}

    <span class="flex-1"></span>

    {#if reading.id === "kind" && trace.gapSummaries.length > 0}
      <!-- A quiet text disclosure, not a card: the gaps are a footnote to the
           bar above them, and a filled band would out-weigh the picture. -->
      <button
        type="button"
        class="flex shrink-0 cursor-pointer items-center gap-1 rounded-sm text-muted-foreground outline-none transition-colors select-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--primary)"
        aria-expanded={gapsOpen}
        onclick={() => (gapsOpen = !gapsOpen)}
      >
        <CaretDownIcon
          size={9}
          style="flex-shrink:0;opacity:0.6;transition:transform 150ms ease;transform:rotate({gapsOpen
            ? 0
            : -90}deg)"
        />
        <span class="tabular-nums"
          >{gapSegments} {gapSegments === 1 ? "gap" : "gaps"} · {formatDuration(gapMs)}</span
        >
      </button>
    {/if}
  </div>

  {#if reading.id === "kind" && gapsOpen && trace.gapSummaries.length > 0}
    <div class="flex flex-col gap-1 border-t border-[var(--hairline)] pt-2">
      <p class="m-0 max-w-[70ch] text-muted-foreground text-pretty">
        These rows locate time outside recorded spans. They do not establish its cause.
      </p>
      {#each trace.gapSummaries as gap (gap.category)}
        <div class="flex items-baseline gap-3 text-muted-foreground" title={gap.description}>
          <span class="min-w-0 flex-1 truncate">{gap.label}</span>
          <span class="shrink-0 tabular-nums">×{gap.segments}</span>
          <span class="w-9 shrink-0 text-right tabular-nums">{formatPercent(gap.share)}</span>
          <span class="w-12 shrink-0 text-right tabular-nums text-foreground"
            >{formatDuration(gap.ms)}</span
          >
        </div>
      {/each}
    </div>
  {/if}

  <!-- A refusal is time the turn spent waiting on a person, so it belongs with
       the coverage it explains rather than in a card elsewhere on the page. -->
  {#if trace.deniedPermissions.length > 0}
    <div
      class="flex flex-col gap-0.5 border-l-2 pl-2.5"
      style="border-color:color-mix(in oklch, var(--warning) 55%, transparent)"
    >
      <span style="color:var(--warning)"
        >{trace.deniedPermissions.length === 1
          ? "Permission denied"
          : `${trace.deniedPermissions.length} permissions denied`}</span
      >
      {#each trace.deniedPermissions as denial (denial.spanId)}
        <span class="text-muted-foreground">
          {denial.name}{#if spanDetailLabel(denial)}
            — {spanDetailLabel(denial)}{/if} · waited {formatDuration(denial.durationMs)}
        </span>
      {/each}
    </div>
  {/if}
</div>
