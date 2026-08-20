<script lang="ts">
  import type { RankingBar } from "./lib/chart-shape";
  import { formatMeasure } from "./lib/format";

  /**
   * One measure across a categorical dimension — the answer to "which tool,
   * which model, which project", which is what most of the shipped presets ask.
   *
   * Bars run horizontally because the labels are text a reader has to read:
   * tool names, model ids, and project roots do not fit under a vertical bar
   * and should not be turned on their side to make a chart's geometry work.
   *
   * Magnitude is one hue, not six: these bars are lengths of the same quantity,
   * not identities to tell apart, so a categorical ramp here would encode a
   * difference that is not in the data. Every bar carries its value as a direct
   * label, which is also what relieves the ramp's contrast against the card.
   *
   * The order is the query's own — `order by total_ms desc` is the reader's
   * ranking, and re-sorting would answer a question they did not ask.
   */
  interface Props {
    bars: RankingBar[];
    valueFormat: "duration" | "number";
    /** Bars below the cut; stated rather than dropped in silence. */
    hiddenBars?: number;
  }

  let { bars, valueFormat, hiddenBars = 0 }: Props = $props();

  /** Bars are read against the largest, so a zero or negative maximum has no
   *  scale to draw on and every bar collapses to its baseline. */
  const largest = $derived(bars.reduce((max, bar) => Math.max(max, bar.value), 0));

  function widthOf(value: number): string {
    if (largest <= 0) return "0%";
    return `${Math.max(0, (value / largest) * 100)}%`;
  }
</script>

<ul class="flex flex-col">
  <!-- Keyed by position: a query that did not group can return the same label
       twice, and a duplicate key is a crash rather than a wrong chart. -->
  {#each bars as bar, index (index)}
    <li
      class="group flex min-h-10 items-center gap-2.5 rounded-md py-2 text-insights-summary transition-colors hover:bg-[var(--wash-1)] sm:min-h-8 sm:py-1 sm:[@media(min-height:1000px)]:min-h-10 sm:[@media(min-height:1000px)]:py-2"
    >
      <span
        class="w-24 shrink-0 truncate pl-1 text-right text-muted-foreground transition-colors group-hover:text-foreground sm:w-36"
        title={bar.label}
        >{bar.label}</span
      >
      <!-- The track is the full scale, drawn once so every bar is read against
           the same length rather than against whatever the neighbours happen to
           be. It is a wash, never mistakable for a measured quantity. -->
      <span
        class="relative h-6 min-w-0 flex-1 rounded-r-[4px] bg-[var(--wash-1)] sm:h-5 sm:[@media(min-height:1000px)]:h-6"
        aria-hidden="true"
      >
        <!-- Flat, and softened against the card like every other chart mark: a
             gradient along a length reads as a second quantity, and the length
             is the only one being stated. -->
        <span
          class="absolute inset-y-0 left-0 rounded-r-[4px]"
          style="width:{widthOf(
            bar.value,
          )};background:color-mix(in oklch, var(--solus-art-1) 72%, var(--card))"
        ></span>
      </span>
      <span class="w-16 shrink-0 pr-1 text-right font-medium tabular-nums"
        >{formatMeasure(bar.value, valueFormat)}</span
      >
    </li>
  {/each}
</ul>
{#if hiddenBars > 0}
  <!-- Aligned to where the bars start: label width plus the gap. -->
  <p class="pl-26.5 text-insights-summary text-muted-foreground opacity-70 sm:pl-38.5">
    +{hiddenBars} more, in the table below
  </p>
{/if}
