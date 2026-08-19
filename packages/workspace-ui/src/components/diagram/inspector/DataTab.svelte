<script lang="ts">
  import type { DiagramNode, DiagramField } from '@solus/contracts/diagram-types'
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
        <!-- A toggle chip rather than a checkbox: the row is already three
             controls wide, and this reads the same as the key badge beside it. -->
        <button
          type="button"
          class="nullable"
          class:nullable--set={!!field.nullable}
          aria-pressed={!!field.nullable}
          title={field.nullable ? 'Nullable' : 'Not null'}
          onclick={() => {
            field.nullable = !field.nullable
            commitFields()
          }}
        >null</button>
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

  /* A field is one card of two rows, so the name and its type/ref/null line
     never read as two separate fields stacked by accident. */
  .row-group {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.5rem;
    border-radius: 0.75rem;
    background: color-mix(in srgb, var(--solus-surface-hover) 55%, transparent);
    box-shadow: inset 0 0 0 0.0625rem color-mix(in srgb, var(--solus-text-primary) 5%, transparent);
    transition: box-shadow var(--duration-base) var(--ease-premium);
  }

  .row-group:focus-within {
    box-shadow: inset 0 0 0 0.0625rem var(--solus-accent-border);
  }

  /* Key and null are the row's two badges: same height, same mono type, both
     lighting up in the accent when set. */
  .key-btn,
  .nullable {
    flex-shrink: 0;
    /* Matches the Input primitive's h-8 beside it, so a field row reads as one
       control strip rather than a tall box with two short chips bolted on. */
    height: 2rem;
    border: none;
    border-radius: 0.5rem;
    background: var(--solus-surface-hover);
    box-shadow: inset 0 0 0 0.0625rem color-mix(in srgb, var(--solus-text-primary) 6%, transparent);
    color: var(--solus-text-tertiary);
    font-family: var(--solus-code-font-family);
    font-size: var(--text-xs);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    transition:
      color var(--duration-quick) var(--ease-premium),
      background var(--duration-quick) var(--ease-premium),
      box-shadow var(--duration-quick) var(--ease-premium);
  }

  .key-btn { width: 2.375rem; }

  .key-btn:hover,
  .nullable:hover {
    color: var(--solus-text-secondary);
    box-shadow: inset 0 0 0 0.0625rem var(--solus-tool-border);
  }

  .key-btn--set,
  .nullable--set {
    color: var(--solus-accent);
    background: var(--solus-accent-light);
    box-shadow: inset 0 0 0 0.0625rem var(--solus-accent-border-medium);
  }

  .key-btn:focus-visible,
  .nullable:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.125rem;
  }

  /* :global because the class rides through the Input primitive — Svelte's
     scoper can't see a class it never renders itself. */
  .row :global(.metric-key) { flex: 0 0 7rem; }

  .nullable {
    padding: 0 0.5625rem;
    user-select: none;
  }

  /* Guidance, not a field: indented off the label column and set in the tertiary
     tone so it never reads as another row. */
  .note {
    margin: 0;
    padding-left: 0.125rem;
    font-size: var(--text-xs);
    line-height: 1.55;
    color: var(--solus-text-tertiary);
    text-wrap: pretty;
  }

  @media (prefers-reduced-motion: reduce) {
    .row-group,
    .key-btn,
    .nullable {
      transition: none;
    }
  }
</style>
