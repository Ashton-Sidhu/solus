<script lang="ts">
  import type { DiagramEdge } from '../../../shared/diagram-types'
  import DiagramDrawerShell from './DiagramDrawerShell.svelte'
  import {
    DIAGRAM_GREEN,
    DIAGRAM_AMBER,
    DIAGRAM_RED,
    DIAGRAM_BLUE,
    DIAGRAM_PURPLE,
    DIAGRAM_GRAY,
  } from './diagram-colors'

  interface Props {
    edge: Pick<DiagramEdge, 'id' | 'source' | 'target' | 'label' | 'kind' | 'color' | 'width' | 'arrows' | 'shape' | 'cardinality'>
    sourceLabel: string
    targetLabel: string
    onClose: () => void
    onUpdateLabel: (id: string, label: string) => void
    onUpdateKind: (id: string, kind: NonNullable<DiagramEdge['kind']>) => void
    onUpdateColor: (id: string, color: string | undefined) => void
    onUpdateWidth: (id: string, width: number | undefined) => void
    onUpdateArrows: (id: string, arrows: NonNullable<DiagramEdge['arrows']>) => void
    onUpdateShape: (id: string, shape: NonNullable<DiagramEdge['shape']>) => void
    onUpdateCardinality: (id: string, cardinality: DiagramEdge['cardinality']) => void
    // When opened via an explicit edit intent ("Edit edge") we focus the label
    // input. On plain selection we don't, so canvas keyboard shortcuts keep working.
    autoFocus?: boolean
  }

  let { edge, sourceLabel, targetLabel, onClose, onUpdateLabel, onUpdateKind, onUpdateColor, onUpdateWidth, onUpdateArrows, onUpdateShape, onUpdateCardinality, autoFocus = false }: Props = $props()

  // Edge weight (stroke width in px). Bounds and step for the slider; the
  // default mirrors the base CSS stroke so an untouched edge sits mid-low.
  const WIDTH_MIN = 1
  const WIDTH_MAX = 6
  const WIDTH_STEP = 0.5
  const WIDTH_DEFAULT = 1.5

  const KINDS: { kind: NonNullable<DiagramEdge['kind']>; label: string; hint: string }[] = [
    { kind: 'sync', label: 'Sync', hint: 'Direct, synchronous call' },
    { kind: 'async', label: 'Async', hint: 'Animated, dashed — async/event flow' },
    { kind: 'data', label: 'Data', hint: 'Thicker line — data transfer' },
  ]

  // Routing style. Each preview traces the path shape the edge takes on canvas.
  const SHAPES: { shape: NonNullable<DiagramEdge['shape']>; label: string; hint: string; path: string }[] = [
    { shape: 'smooth', label: 'Smooth', hint: 'Rounded orthogonal step', path: 'M3 9h12a3 3 0 003-3V3' },
    { shape: 'step', label: 'Step', hint: 'Sharp orthogonal corners', path: 'M3 9h15V3' },
    { shape: 'straight', label: 'Straight', hint: 'Direct line', path: 'M3 9L18 3' },
  ]

  // Curated, theme-aligned palette (mirrors the node status hues for visual
  // coherence). `undefined` = the default accent stroke. The swatch colour is a
  // CSS string applied both as the dot fill and the selected ring.
  const COLORS: { value: string | undefined; label: string; swatch: string }[] = [
    { value: undefined, label: 'Default', swatch: 'var(--solus-accent)' },
    { value: DIAGRAM_GREEN, label: 'Green', swatch: DIAGRAM_GREEN },
    { value: DIAGRAM_AMBER, label: 'Amber', swatch: DIAGRAM_AMBER },
    { value: DIAGRAM_RED, label: 'Red', swatch: DIAGRAM_RED },
    { value: DIAGRAM_BLUE, label: 'Blue', swatch: DIAGRAM_BLUE },
    { value: DIAGRAM_PURPLE, label: 'Purple', swatch: DIAGRAM_PURPLE },
    { value: DIAGRAM_GRAY, label: 'Gray', swatch: DIAGRAM_GRAY },
  ]

  // Arrowhead placement options. Each preview draws a short line with heads on
  // the matching ends, mirroring how the edge renders on the canvas. The SVG
  // markers are defined once below and referenced per option.
  const ARROWS: { value: NonNullable<DiagramEdge['arrows']>; label: string; hint: string; start: boolean; end: boolean }[] = [
    { value: 'end', label: 'End', hint: 'Arrow at the target', start: false, end: true },
    { value: 'start', label: 'Start', hint: 'Arrow at the source', start: true, end: false },
    { value: 'both', label: 'Both', hint: 'Arrows on both ends', start: true, end: true },
    { value: 'none', label: 'None', hint: 'Plain line, no arrows', start: false, end: false },
  ]

  // Relationship cardinality (source → target). 'none' clears it; the four
  // crow's-foot values mirror DiagramEdge's per-end markers. `sMany`/`tMany`
  // drive the endpoint previews (one bar vs. crow's foot).
  const CARDINALITIES: { value: NonNullable<DiagramEdge['cardinality']> | 'none'; label: string; hint: string; sMany: boolean; tMany: boolean }[] = [
    { value: 'none', label: 'None', hint: 'No cardinality markers', sMany: false, tMany: false },
    { value: '1-1', label: '1:1', hint: 'One to one', sMany: false, tMany: false },
    { value: '1-n', label: '1:N', hint: 'One to many', sMany: false, tMany: true },
    { value: 'n-1', label: 'N:1', hint: 'Many to one', sMany: true, tMany: false },
    { value: 'n-n', label: 'N:N', hint: 'Many to many', sMany: true, tMany: true },
  ]

  // Undefined cardinality means no markers, reflected as 'none'.
  const activeCardinality = $derived(edge.cardinality ?? 'none')

  // Undefined arrows renders as 'end' (the canvas default), so reflect that.
  const activeArrows = $derived(edge.arrows ?? 'end')

  // Undefined kind renders identically to 'sync', so reflect that in the control.
  const activeKind = $derived(edge.kind ?? 'sync')

  // Undefined shape renders as the smooth step default.
  const activeShape = $derived(edge.shape ?? 'smooth')

  // Undefined colour = the default accent swatch.
  const activeColor = $derived(edge.color)

  // Undefined width = the base default stroke. The slider always shows a
  // concrete value; dragging back to the default clears the override.
  const activeWidth = $derived(edge.width ?? WIDTH_DEFAULT)

  // A colour that isn't one of the presets came from the custom picker, so the
  // custom swatch owns the active ring and seeds the native input with it.
  const isCustomColor = $derived(
    activeColor != null && !COLORS.some((c) => c.value === activeColor),
  )

  // Local editable mirror of the label. Resynced only when the drawer switches
  // to a different edge (see $effect) so typing never fights the live round-trip.
  let label = $state('')

  let syncedId = $state<string | null>(null)
  $effect(() => {
    if (edge.id !== syncedId) {
      syncedId = edge.id
      label = edge.label ?? ''
    }
  })

  function onLabelInput() {
    onUpdateLabel(edge.id, label.trim())
  }

  function onWidthInput(value: number) {
    // Snapping back to the default clears the override so the kind-based width
    // (e.g. the thicker "data" stroke) applies again.
    onUpdateWidth(edge.id, value === WIDTH_DEFAULT ? undefined : value)
  }
</script>

<DiagramDrawerShell title="Edit edge" ariaLabel="Edit edge" {onClose} {autoFocus}>
    <!-- Connection summary -->
    <div class="diagram-drawer__field">
      <span class="diagram-drawer__label">Connection</span>
      <div class="diagram-edge-conn">
        <span class="diagram-edge-conn__node" title={sourceLabel}>{sourceLabel}</span>
        <svg class="diagram-edge-conn__arrow" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M2.5 8h10M9 4.5L12.5 8 9 11.5" />
        </svg>
        <span class="diagram-edge-conn__node" title={targetLabel}>{targetLabel}</span>
      </div>
    </div>

    <!-- Label -->
    <label class="diagram-drawer__field">
      <span class="diagram-drawer__label">Label</span>
      <input
        class="diagram-drawer__input diagram-drawer__name-input"
        bind:value={label}
        oninput={onLabelInput}
        placeholder="Optional edge label"
      />
    </label>

    <!-- Type -->
    <div class="diagram-drawer__field">
      <span class="diagram-drawer__label">Type</span>
      <div class="diagram-edge-seg" role="group" aria-label="Edge type">
        {#each KINDS as { kind, label: kindLabel, hint }}
          <button
            type="button"
            class="diagram-edge-seg__btn"
            class:diagram-edge-seg__btn--active={activeKind === kind}
            aria-pressed={activeKind === kind}
            title={hint}
            onclick={() => onUpdateKind(edge.id, kind)}
          >
            <!-- Swatch mirrors how the edge actually renders on the canvas:
                 sync = thin solid, async = dashed + flowing, data = thicker. -->
            <svg
              class="diagram-edge-seg__preview diagram-edge-seg__preview--{kind}"
              viewBox="0 0 40 12"
              width="40"
              height="12"
              fill="none"
              stroke="currentColor"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <path d="M3 6h34" />
            </svg>
            <span class="diagram-edge-seg__name">{kindLabel}</span>
          </button>
        {/each}
      </div>
    </div>

    <!-- Routing -->
    <div class="diagram-drawer__field">
      <span class="diagram-drawer__label">Routing</span>
      <div class="diagram-edge-seg" role="group" aria-label="Edge routing">
        {#each SHAPES as { shape, label: shapeLabel, hint, path }}
          <button
            type="button"
            class="diagram-edge-seg__btn"
            class:diagram-edge-seg__btn--active={activeShape === shape}
            aria-pressed={activeShape === shape}
            title={hint}
            onclick={() => onUpdateShape(edge.id, shape)}
          >
            <svg
              class="diagram-edge-seg__preview"
              viewBox="0 0 21 12"
              width="40"
              height="12"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d={path} />
            </svg>
            <span class="diagram-edge-seg__name">{shapeLabel}</span>
          </button>
        {/each}
      </div>
    </div>

    <!-- Color -->
    <div class="diagram-drawer__field">
      <span class="diagram-drawer__label">Color</span>
      <div class="diagram-edge-color" role="group" aria-label="Edge color">
        {#each COLORS as { value, label: colorLabel, swatch }}
          <button
            type="button"
            class="diagram-edge-color__swatch"
            class:diagram-edge-color__swatch--active={activeColor === value}
            style="--swatch: {swatch}"
            aria-pressed={activeColor === value}
            aria-label={colorLabel}
            title={colorLabel}
            onclick={() => onUpdateColor(edge.id, value)}
          ></button>
        {/each}

        <!-- Custom colour: the swatch shows a spectrum until a custom colour is
             picked, then mirrors it. Clicking opens the OS colour picker. -->
        <label
          class="diagram-edge-color__swatch diagram-edge-color__swatch--custom"
          class:diagram-edge-color__swatch--active={isCustomColor}
          style="--swatch: {isCustomColor ? activeColor : 'transparent'}"
          title="Custom color"
        >
          <input
            type="color"
            class="diagram-edge-color__custom-input"
            value={activeColor ?? '#d97757'}
            oninput={(e) => onUpdateColor(edge.id, e.currentTarget.value)}
            aria-label="Custom color"
          />
        </label>
      </div>
    </div>

    <!-- Weight -->
    <div class="diagram-drawer__field">
      <span class="diagram-drawer__label">Weight</span>
      <div class="diagram-edge-weight">
        <!-- Live preview: a line whose thickness tracks the slider, so the
             weight reads at a glance before it's applied on the canvas. -->
        <span
          class="diagram-edge-weight__preview"
          style="--weight: {activeWidth}px"
          aria-hidden="true"
        ></span>
        <input
          type="range"
          class="diagram-edge-weight__slider"
          min={WIDTH_MIN}
          max={WIDTH_MAX}
          step={WIDTH_STEP}
          value={activeWidth}
          oninput={(e) => onWidthInput(Number(e.currentTarget.value))}
          aria-label="Edge weight"
        />
        <span class="diagram-edge-weight__value">{activeWidth}px</span>
      </div>
    </div>

    <!-- Arrows -->
    <div class="diagram-drawer__field">
      <span class="diagram-drawer__label">Arrows</span>
      <div class="diagram-edge-seg" role="group" aria-label="Edge arrows">
        {#each ARROWS as { value, label: arrowLabel, hint, start, end }}
          <button
            type="button"
            class="diagram-edge-seg__btn"
            class:diagram-edge-seg__btn--active={activeArrows === value}
            aria-pressed={activeArrows === value}
            title={hint}
            onclick={() => onUpdateArrows(edge.id, value)}
          >
            <!-- Preview mirrors the canvas: a line with heads on the chosen ends. -->
            <svg
              class="diagram-edge-seg__preview"
              viewBox="0 0 40 12"
              width="40"
              height="12"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M3 6H37" />
              {#if start}
                <path d="M7 3L3 6l4 3" />
              {/if}
              {#if end}
                <path d="M33 3l4 3-4 3" />
              {/if}
            </svg>
            <span class="diagram-edge-seg__name">{arrowLabel}</span>
          </button>
        {/each}
      </div>
    </div>

    <!-- Cardinality -->
    <div class="diagram-drawer__field">
      <span class="diagram-drawer__label">Cardinality</span>
      <div class="diagram-edge-seg" role="group" aria-label="Relationship cardinality">
        {#each CARDINALITIES as { value, label: cardLabel, hint, sMany, tMany }}
          <button
            type="button"
            class="diagram-edge-seg__btn"
            class:diagram-edge-seg__btn--active={activeCardinality === value}
            aria-pressed={activeCardinality === value}
            title={hint}
            onclick={() => onUpdateCardinality(edge.id, value === 'none' ? undefined : value)}
          >
            <!-- Preview mirrors the canvas: a line with a "one" bar or a crow's
                 foot at each end. The foot's prongs spread at the entity. -->
            <svg
              class="diagram-edge-seg__preview"
              viewBox="0 0 40 12"
              width="40"
              height="12"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M3 6H37" />
              {#if value !== 'none'}
                {#if sMany}
                  <path d="M13 6L3 1M13 6L3 6M13 6L3 11" />
                {:else}
                  <path d="M10 1V11" />
                {/if}
                {#if tMany}
                  <path d="M27 6L37 1M27 6L37 6M27 6L37 11" />
                {:else}
                  <path d="M30 1V11" />
                {/if}
              {/if}
            </svg>
            <span class="diagram-edge-seg__name">{cardLabel}</span>
          </button>
        {/each}
      </div>
    </div>
</DiagramDrawerShell>

<style>
  /* Connection summary — a read-only A→B display. Kept borderless with the two
     endpoints as static chips so it never reads as an editable input like the
     label field below it. */
  .diagram-edge-conn {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    min-width: 0;
  }

  .diagram-edge-conn__node {
    flex: 1;
    min-width: 0;
    padding: 0.25rem 0.5rem;
    border-radius: 0.375rem;
    background: var(--solus-surface-hover);
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--solus-text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: center;
  }

  .diagram-edge-conn__arrow {
    flex-shrink: 0;
    color: var(--solus-accent);
  }

  /* Segmented type control */
  .diagram-edge-seg {
    display: flex;
    gap: 0.25rem;
    padding: 0.1875rem;
    border-radius: 0.5rem;
    border: 0.0625rem solid var(--solus-tool-border);
    background: var(--solus-surface-primary);
  }

  .diagram-edge-seg__btn {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.3125rem;
    padding: 0.4375rem 0.375rem;
    border: none;
    border-radius: 0.375rem;
    background: transparent;
    color: var(--solus-text-secondary);
    font-size: 0.6875rem;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    transition: background 0.12s ease, color 0.12s ease;
  }

  .diagram-edge-seg__name {
    line-height: 1;
  }

  /* Edge swatches — stroke inherits the segment's text colour (accent when
     selected) so the preview tracks the active state. */
  .diagram-edge-seg__preview {
    width: 100%;
    height: 0.75rem;
  }

  .diagram-edge-seg__preview path {
    stroke-width: 1.5;
  }

  .diagram-edge-seg__preview--async path {
    stroke-dasharray: 5 3;
    animation: edge-seg-flow 0.6s linear infinite;
  }

  .diagram-edge-seg__preview--data path {
    stroke-width: 2.5;
  }

  @keyframes edge-seg-flow {
    to {
      stroke-dashoffset: -8;
    }
  }

  .diagram-edge-seg__btn:hover {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }

  .diagram-edge-seg__btn:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.125rem;
  }

  /* Selected segment reads as a lifted thumb: stronger accent wash, a hairline
     accent ring (inset shadow so it adds no width), a faint drop shadow, and a
     heavier label — all accent-relative so it holds up in light and dark. */
  .diagram-edge-seg__btn--active,
  .diagram-edge-seg__btn--active:hover {
    background: var(--solus-accent-soft);
    color: var(--solus-accent);
    font-weight: 600;
    box-shadow:
      inset 0 0 0 0.0625rem var(--solus-accent-border),
      0 0.0625rem 0.125rem rgba(0, 0, 0, 0.06);
  }

  /* Colour swatches */
  .diagram-edge-color {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4375rem;
  }

  .diagram-edge-color__swatch {
    flex-shrink: 0;
    width: 1.375rem;
    height: 1.375rem;
    padding: 0;
    border-radius: 50%;
    border: 0.0625rem solid color-mix(in srgb, var(--solus-text-primary) 14%, transparent);
    background: var(--swatch);
    cursor: pointer;
    transition: transform 0.12s ease, box-shadow 0.12s ease;
  }

  .diagram-edge-color__swatch:hover {
    transform: scale(1.12);
  }

  /* Selected swatch gets a ring in its own colour, separated from the dot by a
     container-bg gap — the conventional "active colour" affordance. */
  .diagram-edge-color__swatch--active {
    box-shadow:
      0 0 0 0.125rem var(--solus-container-bg),
      0 0 0 0.21875rem var(--swatch);
  }

  .diagram-edge-color__swatch:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.125rem;
  }

  /* Custom-colour swatch: a label wrapping a hidden native colour input. Shows a
     spectrum wheel until a custom colour is chosen, then mirrors that colour. */
  .diagram-edge-color__swatch--custom {
    position: relative;
    display: inline-grid;
    place-items: center;
    overflow: hidden;
    background:
      conic-gradient(
        from 90deg,
        #f87171,
        #fbbf24,
        #4ade80,
        #60a5fa,
        #a78bfa,
        #f87171
      );
  }

  /* Once active, the inline --swatch (the chosen colour) takes over the fill. */
  .diagram-edge-color__swatch--custom.diagram-edge-color__swatch--active {
    background: var(--swatch);
  }

  .diagram-edge-color__swatch--custom:focus-within {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.125rem;
  }

  .diagram-edge-color__custom-input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    border: none;
    opacity: 0;
    cursor: pointer;
  }

  /* Weight slider */
  .diagram-edge-weight {
    display: flex;
    align-items: center;
    gap: 0.625rem;
  }

  /* Preview swatch: a fixed-length rounded line whose thickness mirrors the
     chosen weight, drawn in the accent so it reads as "this is the edge". */
  .diagram-edge-weight__preview {
    flex-shrink: 0;
    width: 1.75rem;
    height: var(--weight);
    border-radius: 999px;
    background: var(--solus-accent);
    transition: height 0.12s ease;
  }

  .diagram-edge-weight__slider {
    flex: 1;
    min-width: 0;
    height: 1rem;
    margin: 0;
    background: transparent;
    cursor: pointer;
    -webkit-appearance: none;
    appearance: none;
  }

  .diagram-edge-weight__slider:focus-visible {
    outline: none;
  }

  /* Track */
  .diagram-edge-weight__slider::-webkit-slider-runnable-track {
    height: 0.25rem;
    border-radius: 999px;
    background: var(--solus-tool-border);
  }
  .diagram-edge-weight__slider::-moz-range-track {
    height: 0.25rem;
    border-radius: 999px;
    background: var(--solus-tool-border);
  }

  /* Thumb */
  .diagram-edge-weight__slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    margin-top: -0.3125rem;
    width: 0.875rem;
    height: 0.875rem;
    border-radius: 50%;
    background: var(--solus-accent);
    border: 0.125rem solid var(--solus-sidebar-bg-left);
    box-shadow: 0 0.0625rem 0.125rem rgba(0, 0, 0, 0.18);
    cursor: pointer;
    transition: transform 0.12s ease;
  }
  .diagram-edge-weight__slider::-moz-range-thumb {
    width: 0.875rem;
    height: 0.875rem;
    border-radius: 50%;
    background: var(--solus-accent);
    border: 0.125rem solid var(--solus-sidebar-bg-left);
    box-shadow: 0 0.0625rem 0.125rem rgba(0, 0, 0, 0.18);
    cursor: pointer;
    transition: transform 0.12s ease;
  }

  .diagram-edge-weight__slider:hover::-webkit-slider-thumb,
  .diagram-edge-weight__slider:focus-visible::-webkit-slider-thumb {
    transform: scale(1.15);
  }
  .diagram-edge-weight__slider:hover::-moz-range-thumb,
  .diagram-edge-weight__slider:focus-visible::-moz-range-thumb {
    transform: scale(1.15);
  }

  .diagram-edge-weight__slider:focus-visible::-webkit-slider-thumb {
    box-shadow: 0 0 0 0.1875rem var(--solus-accent-soft);
  }
  .diagram-edge-weight__slider:focus-visible::-moz-range-thumb {
    box-shadow: 0 0 0 0.1875rem var(--solus-accent-soft);
  }

  /* Value readout: fixed-width so the row doesn't reflow as the number changes. */
  .diagram-edge-weight__value {
    flex-shrink: 0;
    width: 2.25rem;
    text-align: right;
    font-size: 0.6875rem;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    color: var(--solus-text-secondary);
  }

  @media (prefers-reduced-motion: reduce) {
    .diagram-edge-seg__preview--async path { animation: none; }
  }
</style>
