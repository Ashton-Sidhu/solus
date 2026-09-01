<script lang="ts">
  import type { DiagramNode } from '@solus/contracts/diagram-types'
  import ChipListField from './ChipListField.svelte'
  import { Input } from '../../ui/input'
  import { Textarea } from '../../ui/textarea'

  interface Props {
    node: DiagramNode
    onUpdateNode: (id: string, patch: Partial<DiagramNode>) => void
  }

  let { node, onUpdateNode }: Props = $props()

  const isGroup = $derived(!!node.group)

  // Local editable mirror, resynced only when the inspector switches to a
  // different node — within a node the form owns the values so typing never
  // fights the live patch round-trip.
  let label = $state('')
  let subtitle = $state('')
  let body = $state('')

  let syncedId = $state<string | null>(null)
  $effect(() => {
    // Only the node.id read is tracked when the guard is false, so this resyncs
    // exactly once per node switch — not on every live patch.
    if (node.id !== syncedId) {
      syncedId = node.id
      label = node.label
      subtitle = node.subtitle ?? ''
      body = node.body ?? ''
    }
  })

  function commit(patch: Partial<DiagramNode>) {
    onUpdateNode(node.id, patch)
  }
</script>

<label class="inspector-field">
  <span class="inspector-label">Label</span>
  <Input
    class="inspector-input inspector-name-input"
    bind:value={label}
    oninput={() => commit({ label: label.trim() })}
    placeholder="Node label"
  />
</label>

{#if !isGroup}
  <!-- "Kind" is the design vocabulary — the card renders this as its kind row
       and the rail as its kind word. It persists as `subtitle`, which existing
       documents already carry. -->
  <label class="inspector-field">
    <span class="inspector-label">Kind</span>
    <Input
      class="inspector-input"
      bind:value={subtitle}
      oninput={() => commit({ subtitle: subtitle.trim() || undefined })}
      placeholder="e.g. Service, Datastore, Agent"
    />
  </label>

  <label class="inspector-field">
    <span class="inspector-label">Body</span>
    <Textarea
      class="inspector-textarea"
      bind:value={body}
      oninput={() => commit({ body: body.trim() || undefined })}
      rows="4"
      placeholder="Optional description"
    />
  </label>

  <!-- Keyed so a half-typed chip doesn't follow you to the next node. -->
  {#key node.id}
    <ChipListField
      label="Badges"
      values={node.badges ?? []}
      onChange={(next) => commit({ badges: next.length ? next : undefined })}
      placeholder="Add badge, press Enter"
      tone="accent"
    />
  {/key}
{/if}
