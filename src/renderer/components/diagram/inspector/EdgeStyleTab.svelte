<script lang="ts">
  import type { DiagramEdge } from '../../../../shared/diagram-types'
  import AccentField from './AccentField.svelte'
  import { effectiveEdgeDash } from '../lib/flow-builders'
  import type { EdgeUpdates } from '../lib/inspector-model'

  interface Props {
    // `kind` is read-only here — it is what the Line control resolves its
    // default against, so the segments show what the edge actually draws.
    edge: Pick<DiagramEdge, 'id' | 'kind' | 'color' | 'width' | 'dash' | 'arrows'>
    update: EdgeUpdates
  }

  let { edge, update }: Props = $props()

  // Bounds and step for the weight slider. The default mirrors the base CSS
  // stroke, so an untouched edge sits mid-low.
  const WIDTH_MIN = 1
  const WIDTH_MAX = 6
  const WIDTH_STEP = 0.5
  const WIDTH_DEFAULT = 1.5

  const DASHES: {
    value: NonNullable<DiagramEdge['dash']>
    label: string
    hint: string
    /** Preview stroke pattern, scaled for the 36px-wide swatch. */
    pattern: string
  }[] = [
    { value: 'solid', label: 'Solid', hint: 'Unbroken line', pattern: 'none' },
    { value: 'dashed', label: 'Dashed', hint: 'Dashed line', pattern: '5 4' },
    { value: 'dotted', label: 'Dotted', hint: 'Dotted line', pattern: '0.1 4' },
  ]

  const ARROWS: {
    value: NonNullable<DiagramEdge['arrows']>
    label: string
    hint: string
    start: boolean
    end: boolean
  }[] = [
    { value: 'end', label: 'Target', hint: 'Arrow at the target', start: false, end: true },
    { value: 'start', label: 'Source', hint: 'Arrow at the source', start: true, end: false },
    { value: 'both', label: 'Both', hint: 'Arrows on both ends', start: true, end: true },
    { value: 'none', label: 'None', hint: 'Plain line, no arrows', start: false, end: false },
  ]

  // Resolved through the shared helper rather than a second copy of the rule,
  // so an untouched async edge shows Dashed as active.
  const activeDash = $derived(effectiveEdgeDash(edge.kind, edge.dash))
  const kindDash = $derived(effectiveEdgeDash(edge.kind, undefined))
  const activeArrows = $derived(edge.arrows ?? 'end')
  const activeWidth = $derived(edge.width ?? WIDTH_DEFAULT)
</script>

<div class="inspector-field">
  <span class="inspector-label">Line</span>
  <div class="inspector-segments" role="group" aria-label="Line style">
    {#each DASHES as { value, label, hint, pattern } (value)}
      <button
        type="button"
        class="inspector-segment"
        class:inspector-segment--active={activeDash === value}
        aria-pressed={activeDash === value}
        title={hint}
        onclick={() => update.dash(edge.id, value === kindDash ? undefined : value)}
      >
        <svg viewBox="0 0 40 12" width="36" height="10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
          <path d="M3 6H37" stroke-dasharray={pattern} />
        </svg>
        {label}
      </button>
    {/each}
  </div>
</div>

<div class="inspector-field">
  <span class="inspector-label">Arrowheads</span>
  <div class="inspector-segments" role="group" aria-label="Arrowheads">
    {#each ARROWS as { value, label, hint, start, end } (value)}
      <button
        type="button"
        class="inspector-segment"
        class:inspector-segment--active={activeArrows === value}
        aria-pressed={activeArrows === value}
        title={hint}
        onclick={() => update.arrows(edge.id, value)}
      >
        <svg viewBox="0 0 40 12" width="36" height="10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 6H37" />
          {#if start}<path d="M7 3L3 6l4 3" />{/if}
          {#if end}<path d="M33 3l4 3-4 3" />{/if}
        </svg>
        {label}
      </button>
    {/each}
  </div>
</div>

<AccentField
  value={edge.color}
  defaultLabel="Neutral"
  defaultSwatch="var(--diagram-edge-stroke)"
  groupLabel="Edge accent"
  onSelect={(color) => update.color(edge.id, color)}
/>

<div class="inspector-field">
  <span class="inspector-label">Weight</span>
  <div class="weight">
    <!-- Live preview: a line whose thickness tracks the slider, so the weight
         reads before it lands on the canvas. -->
    <span class="weight__preview" style="--weight: {activeWidth}px" aria-hidden="true"></span>
    <input
      type="range"
      class="weight__slider"
      min={WIDTH_MIN}
      max={WIDTH_MAX}
      step={WIDTH_STEP}
      value={activeWidth}
      oninput={(e) => {
        const next = Number(e.currentTarget.value)
        // Snapping back to the default clears the override, so the kind-based
        // width (the thicker "data" stroke) applies again.
        update.width(edge.id, next === WIDTH_DEFAULT ? undefined : next)
      }}
      aria-label="Edge weight"
    />
    <span class="weight__value">{activeWidth}px</span>
  </div>
</div>

<style>
  /* The swatch row is shared with the node Style tab and lives in
     DiagramShell.css. Only the weight slider is this tab's own. */
  .weight {
    display: flex;
    align-items: center;
    gap: 0.625rem;
  }

  .weight__preview {
    flex: none;
    width: 2.25rem;
    height: var(--weight);
    border-radius: 9999px;
    background: var(--diagram-edge-stroke);
    transition: height var(--duration-quick) var(--ease-premium);
  }

  /* Drawn rather than left to `accent-color`: the stock control is the one thing
     in the panel that would still look like a browser default. */
  .weight__slider {
    flex: 1;
    min-width: 0;
    appearance: none;
    -webkit-appearance: none;
    height: 0.875rem;
    margin: 0;
    background: transparent;
    cursor: pointer;
  }

  .weight__slider::-webkit-slider-runnable-track {
    height: 0.25rem;
    border-radius: 9999px;
    background: var(--solus-surface-active);
  }

  .weight__slider::-moz-range-track {
    height: 0.25rem;
    border-radius: 9999px;
    background: var(--solus-surface-active);
  }

  .weight__slider::-webkit-slider-thumb {
    appearance: none;
    -webkit-appearance: none;
    width: 0.875rem;
    height: 0.875rem;
    margin-top: -0.3125rem;
    border: none;
    border-radius: 9999px;
    background: var(--solus-accent);
    box-shadow:
      0 0 0 0.125rem var(--solus-container-bg),
      0 0.0625rem 0.1875rem rgba(0, 0, 0, 0.25);
  }

  .weight__slider::-moz-range-thumb {
    width: 0.875rem;
    height: 0.875rem;
    border: none;
    border-radius: 9999px;
    background: var(--solus-accent);
    box-shadow:
      0 0 0 0.125rem var(--solus-container-bg),
      0 0.0625rem 0.1875rem rgba(0, 0, 0, 0.25);
  }

  .weight__slider:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.25rem;
    border-radius: 9999px;
  }

  .weight__value {
    flex: none;
    font-family: var(--solus-code-font-family);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    color: var(--solus-text-tertiary);
  }

  @media (prefers-reduced-motion: reduce) {
    .weight__preview { transition: none; }
  }
</style>
