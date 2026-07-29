<script lang="ts">
  import type { DiagramNode } from '../../../../shared/diagram-types'
  import IconPicker from '../IconPicker.svelte'
  import {
    DIAGRAM_GREEN,
    DIAGRAM_AMBER,
    DIAGRAM_RED,
    DIAGRAM_BLUE,
    DIAGRAM_PURPLE,
    DIAGRAM_GRAY,
    diagramAccent,
  } from '../diagram-colors'
  import { getSettingsContext } from '../../../contexts'
  import {
    DIAGRAM_NODE_SHAPE_OPTIONS,
    isDecorativeNodeShape,
    isSimpleShapeNode,
  } from '../diagram-node-shapes'

  interface Props {
    node: DiagramNode
    onUpdateNode: (id: string, patch: Partial<DiagramNode>) => void
  }

  let { node, onUpdateNode }: Props = $props()

  const theme = getSettingsContext()
  const isGroup = $derived(!!node.group)

  // `undefined` = the default theme accent.
  const COLORS: { value: string | undefined; label: string; swatch: string }[] = [
    { value: undefined, label: 'Default', swatch: 'var(--solus-accent)' },
    { value: DIAGRAM_GREEN, label: 'Green', swatch: DIAGRAM_GREEN },
    { value: DIAGRAM_AMBER, label: 'Amber', swatch: DIAGRAM_AMBER },
    { value: DIAGRAM_RED, label: 'Red', swatch: DIAGRAM_RED },
    { value: DIAGRAM_BLUE, label: 'Blue', swatch: DIAGRAM_BLUE },
    { value: DIAGRAM_PURPLE, label: 'Purple', swatch: DIAGRAM_PURPLE },
    { value: DIAGRAM_GRAY, label: 'Gray', swatch: DIAGRAM_GRAY },
  ]

  // A colour outside the preset palette came from the custom picker, so the
  // custom swatch owns the active ring and seeds the native input.
  const isCustomColor = $derived(node.color != null && !COLORS.some((c) => c.value === node.color))

  // Card outline picker. 'rectangle' is the implicit default, so selecting it
  // clears the field rather than persisting the default value.
  const canUseDecorativeShape = $derived(isSimpleShapeNode(node))
  const shapeOptions = $derived(
    DIAGRAM_NODE_SHAPE_OPTIONS.filter((shape) => canUseDecorativeShape || !shape.decorative),
  )
  const activeShape = $derived(
    isDecorativeNodeShape(node.shape) && !canUseDecorativeShape ? 'rectangle' : (node.shape ?? 'rectangle'),
  )

  function commit(patch: Partial<DiagramNode>) {
    onUpdateNode(node.id, patch)
  }
</script>

<div class="inspector-field">
  <span class="inspector-label">Accent</span>
  <div class="inspector-swatches" role="group" aria-label="Node accent">
    {#each COLORS as { value, label: colorLabel, swatch } (colorLabel)}
      <button
        type="button"
        class="inspector-swatch"
        class:inspector-swatch--active={node.color === value}
        style="--swatch: {swatch}"
        aria-pressed={node.color === value}
        aria-label={colorLabel}
        title={colorLabel}
        onclick={() => commit({ color: value })}
      ></button>
    {/each}
    <label
      class="inspector-swatch inspector-swatch--custom"
      class:inspector-swatch--active={isCustomColor}
      style="--swatch: {isCustomColor ? node.color : 'transparent'}"
      title="Custom colour"
    >
      <input
        type="color"
        class="inspector-swatch__input"
        value={node.color ?? diagramAccent(theme.isDark)}
        oninput={(e) => commit({ color: e.currentTarget.value })}
        aria-label="Custom colour"
      />
    </label>
  </div>
</div>

<!-- Icon is appearance, not identity: it sits with the accent it inherits. -->
<div class="inspector-field">
  <span class="inspector-label">Icon</span>
  <IconPicker value={node.icon} onChange={(icon) => commit({ icon })} />
</div>

{#if !isGroup}
  <div class="inspector-field">
    <span class="inspector-label">Shape</span>
    <div class="node-shape" role="group" aria-label="Node shape">
      {#each shapeOptions as { value, label: shapeLabel }}
        <button
          type="button"
          class="node-shape__btn"
          class:node-shape__btn--active={activeShape === value}
          aria-pressed={activeShape === value}
          aria-label={shapeLabel}
          title={shapeLabel}
          onclick={() => commit({ shape: value === 'rectangle' ? undefined : value })}
        >
          <span class="node-shape__preview node-shape__preview--{value}"></span>
          <span class="node-shape__name">{shapeLabel}</span>
        </button>
      {/each}
    </div>
  </div>
{/if}

<style>
  /* The accent swatch row is shared with the edge Style tab and lives in
     DiagramShell.css. Only the shape picker is this tab's own. */
  .node-shape {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.375rem;
  }

  .node-shape__btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    padding: 0.5rem 0.25rem;
    border: 0.0625rem solid transparent;
    border-radius: 0.5rem;
    background: var(--solus-surface-hover);
    color: var(--solus-text-tertiary);
    cursor: pointer;
    transition:
      border-color var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium);
  }

  .node-shape__btn:hover {
    border-color: var(--solus-tool-border);
    color: var(--solus-text-secondary);
  }

  .node-shape__btn--active {
    border-color: var(--solus-accent);
    color: var(--solus-accent);
  }

  .node-shape__btn:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.125rem;
  }

  /* The preview is a small block tinted to the current colour, clipped/rounded
     to match the shape it represents. */
  .node-shape__preview {
    width: 1.5rem;
    height: 1.125rem;
    background: currentColor;
    opacity: 0.85;
  }
  .node-shape__preview--rectangle { border-radius: 0.25rem; }
  /* Circle and diamond read best from a square preview. */
  .node-shape__preview--circle {
    width: 1.125rem;
    border-radius: 50%;
  }
  .node-shape__preview--diamond {
    width: 1.125rem;
    clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%);
  }

  .node-shape__name {
    font-size: 0.625rem;
    font-weight: 500;
    line-height: 1;
  }

  @media (prefers-reduced-motion: reduce) {
    .node-shape__btn { transition: none; }
  }
</style>
