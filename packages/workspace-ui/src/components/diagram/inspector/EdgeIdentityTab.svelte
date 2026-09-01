<script lang="ts">
  import type { DiagramEdge } from '@solus/contracts/diagram-types'
  import { Input } from '../../ui/input'
  import { Textarea } from '../../ui/textarea'
  // The relationship is what the canvas label describes, so it lives beside the
  // label rather than in Style — the line's character follows from it. Its
  // vocabulary is shared with the panel header.
  import { EDGE_KINDS, type EdgeUpdates } from '../lib/inspector-model'

  interface Props {
    edge: Pick<DiagramEdge, 'id' | 'label' | 'body' | 'kind' | 'cardinality'>
    update: EdgeUpdates
  }

  let { edge, update }: Props = $props()

  // 'none' clears the markers; the four crow's-foot values mirror the canvas.
  const CARDINALITIES: {
    value: NonNullable<DiagramEdge['cardinality']> | 'none'
    label: string
    hint: string
  }[] = [
    { value: 'none', label: 'None', hint: 'No cardinality markers' },
    { value: '1-1', label: '1:1', hint: 'One to one' },
    { value: '1-n', label: '1:N', hint: 'One to many' },
    { value: 'n-1', label: 'N:1', hint: 'Many to one' },
    { value: 'n-n', label: 'N:N', hint: 'Many to many' },
  ]

  const activeKind = $derived(edge.kind ?? 'sync')
  const activeCardinality = $derived(edge.cardinality ?? 'none')

  // Local mirror, resynced only when the panel switches edges, so typing never
  // fights the live round-trip through the document.
  let label = $state('')
  let body = $state('')
  let syncedId = $state<string | null>(null)
  $effect(() => {
    if (edge.id !== syncedId) {
      syncedId = edge.id
      label = edge.label ?? ''
      body = edge.body ?? ''
    }
  })
</script>

<label class="inspector-field">
  <span class="inspector-label">Label</span>
  <Input
    class="inspector-input inspector-name-input"
    bind:value={label}
    oninput={() => update.label(edge.id, label.trim())}
    placeholder="Optional edge label"
  />
</label>

<div class="inspector-field">
  <span class="inspector-label">Relationship</span>
  <div class="inspector-segments" role="group" aria-label="Relationship">
    {#each EDGE_KINDS as { kind, label: kindLabel, hint } (kind)}
      <button
        type="button"
        class="inspector-segment"
        class:inspector-segment--active={activeKind === kind}
        aria-pressed={activeKind === kind}
        title={hint}
        onclick={() => update.kind(edge.id, kind)}
      >
        <!-- Swatch mirrors how the edge actually renders: sync thin solid,
             async dashed, data thicker. -->
        <svg
          class="kind-preview kind-preview--{kind}"
          viewBox="0 0 40 12"
          width="36"
          height="10"
          fill="none"
          stroke="currentColor"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M3 6h34" />
        </svg>
        {kindLabel}
      </button>
    {/each}
  </div>
</div>

<!-- The only prose an edge has: `label` always paints on the canvas, so
     documenting a connection would otherwise mean adding a chip to the graph. -->
<label class="inspector-field">
  <span class="inspector-label">Body</span>
  <Textarea
    class="inspector-textarea"
    bind:value={body}
    oninput={() => update.body(edge.id, body.trim() || undefined)}
    rows="4"
    placeholder="What crosses this edge"
  />
</label>

<div class="inspector-field">
  <span class="inspector-label">Cardinality</span>
  <div class="inspector-segments" role="group" aria-label="Relationship cardinality">
    {#each CARDINALITIES as { value, label: cardLabel, hint } (value)}
      <button
        type="button"
        class="inspector-segment"
        class:inspector-segment--active={activeCardinality === value}
        aria-pressed={activeCardinality === value}
        title={hint}
        onclick={() => update.cardinality(edge.id, value === 'none' ? undefined : value)}
      >
        {cardLabel}
      </button>
    {/each}
  </div>
</div>

<style>
  .kind-preview { stroke-width: 1.4; }
  .kind-preview--async { stroke-dasharray: 4 3; }
  .kind-preview--data { stroke-width: 2.4; }
</style>
