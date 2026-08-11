<script lang="ts">
  import type { DiagramNode, DiagramField } from '../../../../shared/diagram-types'
  import ChipListField from './ChipListField.svelte'
  import { Input } from '../../ui/input'
  import { CARD_FIELD_LIMIT } from '../lib/node-card'

  interface Props {
    node: DiagramNode
    onUpdateNode: (id: string, patch: Partial<DiagramNode>) => void
  }

  let { node, onUpdateNode }: Props = $props()

  // Groups are pure containers — they carry only a label and an icon, so
  // neither columns, metrics nor tags mean anything on one.
  const isGroup = $derived(!!node.group)

  // Key cycles none → pk → fk → unique on click; the glyph mirrors the node's
  // field table so the editor and canvas read identically.
  const FIELD_KEY_CYCLE: (DiagramField['key'] | undefined)[] = [undefined, 'pk', 'fk', 'unique']
  const FIELD_KEY_GLYPH = { pk: 'PK', fk: 'FK', unique: 'UQ' } as const

  let fields = $state<DiagramField[]>([])
  let metrics = $state<{ k: string; v: string }[]>([])

  let syncedId = $state<string | null>(null)
  $effect(() => {
    if (node.id !== syncedId) {
      syncedId = node.id
      fields = (node.fields ?? []).map((f) => ({ ...f }))
      metrics = Object.entries(node.metrics ?? {}).map(([k, v]) => ({ k, v }))
    }
  })

  function commit(patch: Partial<DiagramNode>) {
    onUpdateNode(node.id, patch)
  }

  // Nameless rows are dropped from the commit (kept locally so a half-typed row
  // doesn't vanish), and empty optional values are stripped so they don't
  // persist as empty strings.
  function commitFields() {
    const clean: DiagramField[] = []
    for (const f of fields) {
      const name = f.name.trim()
      if (!name) continue
      const row: DiagramField = { name }
      const type = f.type?.trim()
      if (type) row.type = type
      if (f.key) row.key = f.key
      if (f.nullable) row.nullable = true
      const ref = f.ref?.trim()
      if (ref) row.ref = ref
      clean.push(row)
    }
    commit({ fields: clean.length ? clean : undefined })
  }
  function addField() {
    fields = [...fields, { name: '' }]
  }
  function removeField(i: number) {
    fields = fields.filter((_, idx) => idx !== i)
    commitFields()
  }
  function cycleFieldKey(i: number) {
    const cur = FIELD_KEY_CYCLE.indexOf(fields[i].key)
    fields[i].key = FIELD_KEY_CYCLE[(cur + 1) % FIELD_KEY_CYCLE.length]
    commitFields()
  }

  function commitMetrics() {
    const obj: Record<string, string> = {}
    for (const { k, v } of metrics) {
      const key = k.trim()
      if (key) obj[key] = v
    }
    commit({ metrics: Object.keys(obj).length ? obj : undefined })
  }
  function addMetric() {
    metrics = [...metrics, { k: '', v: '' }]
  }
  function removeMetric(i: number) {
    metrics = metrics.filter((_, idx) => idx !== i)
    commitMetrics()
  }

  function onFieldKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      addField()
    }
  }
</script>

{#if isGroup}
  <p class="note">A group is a container — give its members fields, metrics and tags instead.</p>
{:else}
<div class="inspector-field">
  <span class="inspector-label">Metrics</span>
  {#each metrics as metric, i}
    <div class="row">
      <Input class="inspector-input metric-key" bind:value={metric.k} oninput={commitMetrics} placeholder="Key" />
      <Input class="inspector-input" bind:value={metric.v} oninput={commitMetrics} placeholder="Value" />
      <button type="button" class="inspector-icon-btn" onclick={() => removeMetric(i)} aria-label="Remove metric">
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 8h8" /></svg>
      </button>
    </div>
  {/each}
  <button type="button" class="inspector-add-row" onclick={addMetric}>
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8 4v8M4 8h8" /></svg>
    Add metric
  </button>
</div>

<div class="inspector-field">
  <span class="inspector-label">Fields</span>
  {#each fields as field, i}
    <div class="row-group">
      <div class="row">
        <button
          type="button"
          class="key-btn"
          class:key-btn--set={!!field.key}
          onclick={() => cycleFieldKey(i)}
          title="Key: none → PK → FK → unique"
          aria-label="Field key: {field.key ?? 'none'}"
        >{field.key ? FIELD_KEY_GLYPH[field.key] : '—'}</button>
        <Input
          class="inspector-input"
          bind:value={field.name}
          oninput={commitFields}
          onkeydown={onFieldKeydown}
          placeholder="Column name"
        />
        <button type="button" class="inspector-icon-btn" onclick={() => removeField(i)} aria-label="Remove field">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 8h8" /></svg>
        </button>
      </div>
      <div class="row">
        <Input class="inspector-input" bind:value={field.type} oninput={commitFields} placeholder="Type" />
        <Input class="inspector-input" bind:value={field.ref} oninput={commitFields} placeholder="Ref, e.g. users.id" />
        <label class="nullable">
          <input type="checkbox" bind:checked={field.nullable} onchange={commitFields} />
          null
        </label>
      </div>
    </div>
  {/each}
  {#if fields.length > CARD_FIELD_LIMIT}
    <!-- Tells the author why the canvas card isn't showing everything here. -->
    <p class="note">The card shows the first {CARD_FIELD_LIMIT} and collapses the rest to “+n more”.</p>
  {/if}
  <button type="button" class="inspector-add-row" onclick={addField}>
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8 4v8M4 8h8" /></svg>
    Add field
  </button>
</div>

<!-- Keyed so a half-typed chip doesn't follow you to the next node. -->
{#key node.id}
  <ChipListField
    label="Tags"
    values={node.tags ?? []}
    onChange={(next) => commit({ tags: next.length ? next : undefined })}
    placeholder="Add tag, press Enter"
    tone="muted"
  />
{/key}
{/if}

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    min-width: 0;
  }

  .row-group {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.5rem;
    border-radius: 0.5rem;
    background: color-mix(in srgb, var(--solus-surface-hover) 55%, transparent);
  }

  .key-btn {
    flex-shrink: 0;
    width: 2.25rem;
    height: 1.75rem;
    border: 0.0625rem solid transparent;
    border-radius: 0.375rem;
    background: var(--solus-surface-hover);
    color: var(--solus-text-tertiary);
    font-size: 0.625rem;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    transition:
      color var(--duration-quick) var(--ease-premium),
      background var(--duration-quick) var(--ease-premium);
  }

  .key-btn--set {
    color: var(--solus-accent);
    background: color-mix(in srgb, var(--solus-accent) 12%, transparent);
  }

  .key-btn:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.125rem;
  }

  /* :global because the class rides through the Input primitive — Svelte's
     scoper can't see a class it never renders itself. */
  .row :global(.metric-key) { flex: 0 0 7rem; }

  .nullable {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.6875rem;
    color: var(--solus-text-secondary);
    cursor: pointer;
    user-select: none;
  }

  .nullable input {
    accent-color: var(--solus-accent);
    cursor: pointer;
  }

  .note {
    margin: 0;
    font-size: 0.6875rem;
    line-height: 1.5;
    color: var(--solus-text-tertiary);
  }
</style>
