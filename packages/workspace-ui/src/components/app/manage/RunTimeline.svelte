<script lang="ts">
  import type { RunTimeline } from "./lib/run-graph";

  /**
   * The run on a time axis, plain under the canvas: one lane for each step
   * that ran, a bar for each try, and a dashed line for the wait between two
   * tries. The try that ended the step in failure is the strong colour.
   */
  interface Props {
    timeline: RunTimeline;
    selectedStep: string | null;
    onSelectStep: (name: string) => void;
  }
  let { timeline, selectedStep, onSelectStep }: Props = $props();
</script>

<section class="flex min-w-0 flex-col gap-1.5 px-1 pt-2.5 pb-4" aria-label="Timeline" data-testid="app-run-timeline">
  <div class="flex h-6 shrink-0 items-center gap-3">
    <h3 class="m-0 w-35 shrink-0 text-[15px] leading-4.5 font-semibold text-foreground @max-[48rem]/pane:w-24">Timeline</h3>
    <div class="relative h-4 min-w-0 flex-1" aria-hidden="true">
      {#each timeline.ticks as tick (tick.at)}
        <span
          class="absolute top-0 text-xs text-(--solus-text-tertiary) tabular-nums {tick.at === 0 ? '' : tick.at === 100 ? '-translate-x-full' : '-translate-x-1/2'}"
          style:left="{tick.at}%">{tick.label}</span
        >
      {/each}
    </div>
  </div>
  {#each timeline.lanes as lane (lane.name)}
    {@const isSelected = lane.name === selectedStep}
    <button
      type="button"
      class="flex h-6.5 w-full min-w-0 shrink-0 cursor-pointer items-center gap-3 overflow-hidden rounded-md border-0 bg-transparent p-0 text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:h-10"
      aria-pressed={isSelected}
      onclick={() => onSelectStep(lane.name)}
    >
      <span class="w-35 shrink-0 truncate text-[13px] leading-4 @max-[48rem]/pane:w-24 {isSelected ? 'font-medium text-foreground' : 'text-(--solus-text-secondary)'}">{lane.name}</span>
      <span class="relative h-2.5 min-w-0 flex-1">
        {#each lane.gaps as gap (gap.key)}
          <span class="absolute top-1/2 h-0 border-t-[1.5px] border-dashed border-[var(--hairline-strongest)]" style:left="{gap.left}%" style:width="{gap.width}%"></span>
        {/each}
        {#each lane.bars as bar (bar.key)}
          <span
            class="absolute top-0 h-2.5 min-w-[3px] rounded-[4px] {bar.tone === 'final'
              ? 'bg-(--failure)'
              : bar.tone === 'failed'
                ? 'bg-[color-mix(in_oklch,var(--failure)_40%,transparent)]'
                : bar.tone === 'running'
                  ? 'bg-[color-mix(in_oklch,var(--running)_55%,transparent)]'
                  : 'bg-[color-mix(in_oklch,var(--success)_60%,transparent)]'}"
            style:left="{bar.left}%"
            style:width="{bar.width}%"
          ></span>
        {/each}
      </span>
    </button>
  {/each}
</section>
