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
          >
            <svg viewBox="0 0 16 16" width="8" height="8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
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
    gap: 0.25rem;
    padding: 0.1875rem 0.25rem 0.1875rem 0.5625rem;
    border-radius: 9999px;
    background: var(--solus-accent-light);
    box-shadow: inset 0 0 0 0.0625rem var(--solus-accent-border);
    color: var(--solus-text-secondary);
    font-size: var(--text-xs);
    font-weight: 500;
  }

  .chip--muted {
    background: var(--solus-surface-hover);
    box-shadow: inset 0 0 0 0.0625rem color-mix(in srgb, var(--solus-text-primary) 7%, transparent);
    color: var(--solus-text-tertiary);
  }

  /* The remove target stays quiet until the chip is under the pointer, so a
     list of badges reads as content rather than as a row of close buttons. */
  .chip__x {
    display: grid;
    place-items: center;
    width: 1rem;
    height: 1rem;
    border: none;
    border-radius: 9999px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    opacity: 0.45;
    transition:
      opacity var(--duration-quick) var(--ease-premium),
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium);
  }

  .chip:hover .chip__x { opacity: 0.8; }

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
