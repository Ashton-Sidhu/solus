<script lang="ts" generics="T extends string | number | null">
  import { CaretDownIcon, CheckIcon } from 'phosphor-svelte'
  import Dropdown from './Dropdown.svelte'
  import DropdownItem from './DropdownItem.svelte'

  interface Option {
    value: T
    label: string
    disabled?: boolean
  }

  interface Props {
    value: T
    options: Option[]
    onChange?: (value: T) => void
    placeholder?: string
    ariaLabel?: string
    disabled?: boolean
    align?: 'bottom' | 'top'
    anchor?: 'left' | 'right'
    /** 'ghost' renders a borderless, auto-width trigger that lifts on hover —
     *  for dense metadata rows where a boxed field would be too heavy. */
    variant?: 'default' | 'ghost'
    class?: string
  }

  let {
    value = $bindable(),
    options,
    onChange,
    placeholder = 'Select…',
    ariaLabel,
    disabled = false,
    align = 'bottom',
    anchor = 'left',
    variant = 'default',
    class: extraClass = '',
  }: Props = $props()

  let open = $state(false)
  let triggerEl: HTMLButtonElement | null = $state(null)

  const selectedLabel = $derived(options.find((o) => o.value === value)?.label)
  // Match the trigger width so the menu lines up with the field, but keep a
  // floor so borderless/auto-width triggers (e.g. ghost selects) don't produce
  // a cramped menu.
  const menuWidth = $derived(Math.max(triggerEl?.offsetWidth ?? 0, 176))

  function select(next: T) {
    value = next
    onChange?.(next)
    open = false
  }
</script>

<button
  bind:this={triggerEl}
  type="button"
  {disabled}
  aria-label={ariaLabel}
  aria-haspopup="listbox"
  aria-expanded={open}
  onclick={() => { if (!disabled) open = !open }}
  class="sel-trigger {extraClass}"
  class:sel-trigger--ghost={variant === 'ghost'}
  class:sel-trigger--placeholder={selectedLabel === undefined}
>
  <span class="sel-trigger__label">{selectedLabel ?? placeholder}</span>
  <CaretDownIcon size={11} class="sel-trigger__caret" />
</button>

<Dropdown bind:open {triggerEl} {align} {anchor} width={menuWidth}>
  <div class="py-1" role="listbox">
    {#each options as opt (opt.value)}
      <DropdownItem
        selected={opt.value === value}
        disabled={opt.disabled}
        onclick={() => select(opt.value)}
      >
        <span class="min-w-0 truncate">{opt.label}</span>
        {#snippet trailing()}
          {#if opt.value === value}<CheckIcon size={12} class="shrink-0 text-(--solus-accent)" />{/if}
        {/snippet}
      </DropdownItem>
    {/each}
  </div>
</Dropdown>

<style>
  .sel-trigger {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    width: 100%;
    font-size: 0.8125rem;
    color: var(--solus-text-primary);
    background: var(--solus-input-bg-soft, var(--solus-container-bg));
    border-radius: 0.5rem;
    padding: 0.5rem 0.625rem;
    border: none;
    outline: 0.0625rem solid var(--solus-container-border);
    outline-offset: 0;
    cursor: pointer;
    text-align: left;
    transition: outline-color 0.12s ease, background 0.1s ease;
  }
  .sel-trigger:hover:not(:disabled) {
    background: var(--solus-surface-hover);
  }
  .sel-trigger:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .sel-trigger:focus-visible {
    outline: 0.125rem solid color-mix(in srgb, var(--solus-accent) 55%, transparent);
  }
  /* Touch/tablet: a comfortable tap target and 16px label (avoids iOS zoom). */
  @media (pointer: coarse) {
    .sel-trigger {
      min-height: 2.75rem;
      font-size: 1rem;
    }
  }
  /* Ghost: borderless until hover/focus, auto-width, right-aligned in dense rows. */
  .sel-trigger--ghost {
    width: auto;
    max-width: 11rem;
    gap: 0.25rem;
    padding: 0.25rem 0.375rem;
    font-size: 0.75rem;
    background: transparent;
    outline-color: transparent;
  }
  .sel-trigger--ghost:hover:not(:disabled) {
    background: var(--solus-surface-hover);
  }
  .sel-trigger--ghost:focus-visible {
    outline-color: color-mix(in srgb, var(--solus-accent) 55%, transparent);
  }
  @media (pointer: coarse) {
    .sel-trigger--ghost {
      min-height: 2.75rem;
      max-width: 14rem;
      padding: 0.5rem 0.625rem;
      font-size: 0.9375rem;
    }
  }
  .sel-trigger--placeholder .sel-trigger__label {
    color: var(--solus-text-tertiary);
  }
  .sel-trigger__label {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .sel-trigger :global(.sel-trigger__caret) {
    flex-shrink: 0;
    color: var(--solus-text-tertiary);
  }
</style>
