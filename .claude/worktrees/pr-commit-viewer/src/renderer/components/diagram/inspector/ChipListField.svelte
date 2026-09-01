<script lang="ts">
  import { Input } from '../../ui/input'

  interface Props {
    label: string
    /** Chips as persisted. The parent owns the value; this emits whole lists. */
    values: string[]
    onChange: (values: string[]) => void
    placeholder: string
    /** Badges ride the node's accent; tags read as muted metadata. */
    tone: 'accent' | 'muted'
  }

  let { label, values, onChange, placeholder, tone }: Props = $props()

  // Only the half-typed chip is local — a committed list round-trips through the
  // document, so there is no mirror to keep in sync.
  let draft = $state('')

  function add() {
    const value = draft.trim()
    if (!value) return
    draft = ''
    onChange([...values, value])
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key !== 'Enter') return
    // The canvas listens for Enter too — stop it before it edits the selection.
    e.preventDefault()
    e.stopPropagation()
    add()
  }
</script>

<div class="inspector-field">
  <span class="inspector-label">{label}</span>
  {#if values.length}
    <div class="chips">
      {#each values as value, i (`${i}-${value}`)}
        <span class="chip" class:chip--muted={tone === 'muted'}>
          {value}
          <button
            type="button"
            class="chip__x"
            onclick={() => onChange(values.filter((_, idx) => idx !== i))}
            aria-label="Remove {label} {value}"
          >✕</button>
        </span>
      {/each}
    </div>
  {/if}
  <Input class="inspector-input" bind:value={draft} onkeydown={onKeydown} {placeholder} />
</div>

<style>
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3125rem;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    padding: 0.125rem 0.25rem 0.125rem 0.5rem;
    border-radius: 0.5rem;
    background: color-mix(in srgb, var(--solus-accent) 10%, transparent);
    color: var(--solus-text-secondary);
    font-size: 0.75rem;
    font-weight: 500;
  }

  .chip--muted {
    background: var(--solus-surface-hover);
    color: var(--solus-text-tertiary);
  }

  .chip__x {
    display: grid;
    place-items: center;
    width: 0.875rem;
    height: 0.875rem;
    border: none;
    border-radius: 0.25rem;
    background: transparent;
    color: inherit;
    font-size: 0.75rem;
    cursor: pointer;
    opacity: 0.7;
    transition:
      opacity var(--duration-quick) var(--ease-premium),
      background var(--duration-quick) var(--ease-premium);
  }

  .chip__x:hover {
    opacity: 1;
    background: color-mix(in srgb, var(--solus-status-error) 18%, transparent);
    color: var(--solus-status-error);
  }

  .chip__x:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.0625rem;
  }

  @media (prefers-reduced-motion: reduce) {
    .chip__x { transition: none; }
  }
</style>
