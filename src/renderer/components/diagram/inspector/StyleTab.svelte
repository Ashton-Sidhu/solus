<script lang="ts">
  import type { DiagramNode } from '../../../../shared/diagram-types'
  import IconPicker from '../IconPicker.svelte'
  import AccentField from './AccentField.svelte'
  import {
    DIAGRAM_NODE_SILHOUETTE_OPTIONS,
    isDecorativeNodeSilhouette,
    isSimpleDiagramNode,
  } from '../diagram-node-shapes'

  interface Props {
    node: DiagramNode
    onUpdateNode: (id: string, patch: Partial<DiagramNode>) => void
  }

  let { node, onUpdateNode }: Props = $props()

  const isGroup = $derived(!!node.group)

  // Card outline picker. 'rectangle' is the implicit default, so selecting it
  // clears the field rather than persisting the default value.
  const canUseDecorativeSilhouette = $derived(isSimpleDiagramNode(node))
  const silhouetteOptions = $derived(
    DIAGRAM_NODE_SILHOUETTE_OPTIONS.filter(
      (option) => canUseDecorativeSilhouette || !option.decorative,
    ),
  )
  const activeSilhouette = $derived(
    isDecorativeNodeSilhouette(node.silhouette) && !canUseDecorativeSilhouette
      ? 'rectangle'
      : (node.silhouette ?? 'rectangle'),
  )

  function commit(patch: Partial<DiagramNode>) {
    onUpdateNode(node.id, patch)
  }
</script>

<AccentField
  value={node.color}
  defaultLabel="Default"
  defaultSwatch="var(--solus-accent)"
  groupLabel="Node accent"
  onSelect={(color) => commit({ color })}
/>

<!-- Icon is appearance, not identity: it sits with the accent it inherits. -->
<div class="inspector-field">
  <span class="inspector-label">Icon</span>
  <IconPicker value={node.icon} onChange={(icon) => commit({ icon })} />
</div>

{#if !isGroup}
  <div class="inspector-field">
    <span class="inspector-label">Shape</span>
    <div class="node-shape" role="group" aria-label="Node shape">
      {#each silhouetteOptions as { value, label: silhouetteLabel }}
        <button
          type="button"
          class="node-shape__btn"
          class:node-shape__btn--active={activeSilhouette === value}
          aria-pressed={activeSilhouette === value}
          aria-label={silhouetteLabel}
          title={silhouetteLabel}
          onclick={() => commit({ silhouette: value === 'rectangle' ? undefined : value })}
        >
          <span class="node-shape__preview node-shape__preview--{value}"></span>
          <span class="node-shape__name">{silhouetteLabel}</span>
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

  /* A tile per silhouette: the preview is the product, so the chrome is an
     inset hairline that only becomes an accent ring on the chosen one. */
  .node-shape__btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.375rem;
    padding: 0.625rem 0.25rem 0.5rem;
    border: none;
    border-radius: 0.75rem;
    background: var(--solus-surface-hover);
    box-shadow: inset 0 0 0 0.0625rem color-mix(in srgb, var(--solus-text-primary) 6%, transparent);
    color: var(--solus-text-tertiary);
    cursor: pointer;
    transition:
      box-shadow var(--duration-base) var(--ease-premium),
      background var(--duration-base) var(--ease-premium),
      color var(--duration-base) var(--ease-premium),
      scale var(--duration-quick) var(--ease-premium);
  }

  .node-shape__btn:hover {
    box-shadow: inset 0 0 0 0.0625rem var(--solus-tool-border);
    color: var(--solus-text-secondary);
  }

  .node-shape__btn:active { scale: 0.97; }

  .node-shape__btn--active {
    background: var(--solus-accent-light);
    box-shadow: inset 0 0 0 0.0625rem var(--solus-accent-border-medium);
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
    transition: scale var(--duration-base) var(--ease-premium);
  }

  .node-shape__btn:hover .node-shape__preview { scale: 1.06; }
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
    font-size: var(--text-xs);
    font-weight: 500;
    line-height: 1;
  }

  @media (prefers-reduced-motion: reduce) {
    .node-shape__btn,
    .node-shape__preview {
      transition: none;
    }
    .node-shape__btn:hover .node-shape__preview { scale: 1; }
  }
</style>
