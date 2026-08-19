<script lang="ts">
  import type { DiagramEdge } from '@solus/contracts/diagram-types'
  import { EDGE_ROUTES, type EdgeUpdates } from '../lib/inspector-model'

  interface Props {
    edge: Pick<DiagramEdge, 'id' | 'source' | 'target' | 'route'>
    sourceLabel: string
    targetLabel: string
    update: EdgeUpdates
    /** Endpoint rows are navigation as well as fields. */
    onOpenEndpoint: (nodeId: string) => void
    onReverse: () => void
  }

  let { edge, sourceLabel, targetLabel, update, onOpenEndpoint, onReverse }: Props = $props()

  const activeRoute = $derived(edge.route ?? 'smooth')
</script>

<div class="inspector-field">
  <span class="inspector-label">Routing</span>
  <div class="inspector-segments" role="group" aria-label="Routing">
    {#each EDGE_ROUTES as { route, label, hint, path } (route)}
      <button
        type="button"
        class="inspector-segment"
        class:inspector-segment--active={activeRoute === route}
        aria-pressed={activeRoute === route}
        title={hint}
        onclick={() => update.route(edge.id, route)}
      >
        <svg viewBox="0 0 21 12" width="34" height="10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d={path} />
        </svg>
        {label}
      </button>
    {/each}
  </div>
</div>

<div class="inspector-field">
  <span class="inspector-label">Endpoints</span>
  <div class="endpoints">
    <!-- Clicking an end selects that node and hands the rail back to the node
         inspector: the two panels are one selection, never two. -->
    <button type="button" class="endpoint" onclick={() => onOpenEndpoint(edge.source)}>
      <span class="endpoint__role">source</span>
      <span class="endpoint__node">{sourceLabel}</span>
      <span class="endpoint__go" aria-hidden="true">›</span>
    </button>
    <button type="button" class="endpoint" onclick={() => onOpenEndpoint(edge.target)}>
      <span class="endpoint__role">target</span>
      <span class="endpoint__node">{targetLabel}</span>
      <span class="endpoint__go" aria-hidden="true">›</span>
    </button>
  </div>
  <button type="button" class="reverse" onclick={onReverse}>⇄ Reverse direction</button>
</div>

<style>
  .endpoints {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .endpoint {
    display: flex;
    align-items: center;
    gap: 0.5625rem;
    padding: 0.5rem 0.625rem;
    border: none;
    border-radius: 0.625rem;
    background: var(--solus-surface-hover);
    box-shadow: inset 0 0 0 0.0625rem color-mix(in srgb, var(--solus-text-primary) 6%, transparent);
    text-align: left;
    cursor: pointer;
    transition:
      box-shadow var(--duration-base) var(--ease-premium),
      background var(--duration-base) var(--ease-premium);
  }

  .endpoint:hover {
    background: var(--solus-surface-active);
    box-shadow: inset 0 0 0 0.0625rem var(--solus-tool-border);
  }

  .endpoint:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.125rem;
  }

  /* The role is a label on the row, not a value in it — pinned to a fixed
     column so source and target line up whatever they are called. */
  .endpoint__role {
    flex: none;
    width: 2.875rem;
    font-size: 0.6875rem;
    font-weight: 500;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--solus-text-tertiary);
  }

  .endpoint__node {
    flex: 1;
    min-width: 0;
    font-size: var(--text-sm);
    color: var(--solus-text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .endpoint__go {
    flex: none;
    font-size: var(--text-sm);
    color: var(--solus-text-tertiary);
    transition:
      color var(--duration-base) var(--ease-premium),
      translate var(--duration-base) var(--ease-premium);
  }

  .endpoint:hover .endpoint__go {
    color: var(--solus-accent);
    translate: 0.125rem 0;
  }

  .reverse {
    padding: 0.5rem 0.625rem;
    border: 0.0625rem dashed var(--solus-tool-border);
    border-radius: 0.625rem;
    background: transparent;
    color: var(--solus-text-tertiary);
    font-size: var(--text-xs);
    font-weight: 500;
    text-align: center;
    cursor: pointer;
    transition:
      border-color var(--duration-quick) var(--ease-premium),
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium);
  }

  .reverse:hover {
    border-color: var(--solus-accent-border-medium);
    background: var(--solus-accent-light);
    color: var(--solus-accent);
  }

  .reverse:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.125rem;
  }

  @media (prefers-reduced-motion: reduce) {
    .endpoint, .reverse, .endpoint__go { transition: none; }
    .endpoint:hover .endpoint__go { translate: none; }
  }
</style>
