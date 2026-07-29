<script lang="ts">
  import type { DiagramEdge } from '../../../../shared/diagram-types'
  import { getSettingsContext } from '../../../contexts'
  import {
    DIAGRAM_GREEN,
    DIAGRAM_AMBER,
    DIAGRAM_RED,
    DIAGRAM_BLUE,
    DIAGRAM_PURPLE,
    DIAGRAM_GRAY,
    diagramAccent,
  } from '../diagram-colors'
  import { effectiveEdgeDash } from '../lib/flow-builders'
  import type { EdgeUpdates } from '../lib/inspector-model'

  interface Props {
    // `kind` is read-only here — it is what the Line control resolves its
    // default against, so the segments show what the edge actually draws.
    edge: Pick<DiagramEdge, 'id' | 'kind' | 'color' | 'width' | 'dash' | 'arrows'>
    update: EdgeUpdates
  }

  let { edge, update }: Props = $props()

  const theme = getSettingsContext()

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

  // Accent defaults to the neutral stroke — an edge only takes a tint when it
  // means something, otherwise the graph turns into bunting.
  const COLORS: { value: string | undefined; label: string; swatch: string }[] = [
    { value: undefined, label: 'Neutral', swatch: 'var(--diagram-edge-stroke)' },
    { value: DIAGRAM_GREEN, label: 'Green', swatch: DIAGRAM_GREEN },
    { value: DIAGRAM_AMBER, label: 'Amber', swatch: DIAGRAM_AMBER },
    { value: DIAGRAM_RED, label: 'Red', swatch: DIAGRAM_RED },
    { value: DIAGRAM_BLUE, label: 'Blue', swatch: DIAGRAM_BLUE },
    { value: DIAGRAM_PURPLE, label: 'Purple', swatch: DIAGRAM_PURPLE },
    { value: DIAGRAM_GRAY, label: 'Gray', swatch: DIAGRAM_GRAY },
  ]

  // Resolved through the shared helper rather than a second copy of the rule,
  // so an untouched async edge shows Dashed as active.
  const activeDash = $derived(effectiveEdgeDash(edge.kind, edge.dash))
  const kindDash = $derived(effectiveEdgeDash(edge.kind, undefined))
  const activeArrows = $derived(edge.arrows ?? 'end')
  const activeColor = $derived(edge.color)
  const activeWidth = $derived(edge.width ?? WIDTH_DEFAULT)
  // A colour outside the presets came from the custom picker, so the custom
  // swatch owns the active ring and seeds the native input with it.
  const isCustomColor = $derived(activeColor != null && !COLORS.some((c) => c.value === activeColor))
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

<div class="inspector-field">
  <span class="inspector-label">Accent</span>
  <div class="inspector-swatches" role="group" aria-label="Edge accent">
    {#each COLORS as { value, label, swatch } (label)}
      <button
        type="button"
        class="inspector-swatch"
        class:inspector-swatch--active={activeColor === value}
        style="--swatch: {swatch}"
        aria-pressed={activeColor === value}
        aria-label={label}
        title={label}
        onclick={() => update.color(edge.id, value)}
      ></button>
    {/each}

    <!-- Shows a spectrum until a custom colour is picked, then mirrors it. -->
    <label
      class="inspector-swatch inspector-swatch--custom"
      class:inspector-swatch--active={isCustomColor}
      style="--swatch: {isCustomColor ? activeColor : 'transparent'}"
      title="Custom colour"
    >
      <input
        type="color"
        class="inspector-swatch__input"
        value={activeColor ?? diagramAccent(theme.isDark)}
        oninput={(e) => update.color(edge.id, e.currentTarget.value)}
        aria-label="Custom colour"
      />
    </label>
  </div>
</div>

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
    border-radius: 999px;
    background: var(--diagram-edge-stroke);
  }

  .weight__slider { flex: 1; min-width: 0; accent-color: var(--solus-accent); }

  .weight__value {
    flex: none;
    font-family: var(--solus-code-font-family);
    font-size: 0.6875rem;
    font-variant-numeric: tabular-nums;
    color: var(--solus-text-tertiary);
  }
</style>
