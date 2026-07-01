<script lang="ts">
  import type { Snippet } from 'svelte'
  import Kbd from './Kbd.svelte'

  interface Props {
    selected?: boolean
    focused?: boolean
    danger?: boolean
    disabled?: boolean
    kbd?: string
    'data-testid'?: string
    onclick?: () => void
    children: Snippet
    trailing?: Snippet
  }

  let {
    selected = false,
    focused = false,
    danger = false,
    disabled = false,
    kbd,
    'data-testid': dataTestId,
    onclick,
    children,
    trailing,
  }: Props = $props()
</script>

<button
  type="button"
  {disabled}
  {onclick}
  data-testid={dataTestId}
  class="dd-item"
  class:dd-item--selected={selected}
  class:dd-item--focused={focused}
  class:dd-item--danger={danger}
>
  <span class="dd-item__content">
    {@render children()}
  </span>
  {#if trailing || kbd}
    <span class="dd-item__trailing">
      {#if trailing}{@render trailing()}{/if}
      {#if kbd}<Kbd variant="inline">{kbd}</Kbd>{/if}
    </span>
  {/if}
</button>

<style>
  .dd-item {
    position: relative;
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.375rem 0.75rem;
    font-size: 0.6875rem;
    font-family: inherit;
    color: var(--solus-text-secondary);
    font-weight: var(--solus-font-weight-secondary);
    background: transparent;
    border: none;
    cursor: pointer;
    text-align: left;
    transition: background var(--duration-quick) var(--ease-premium),
                color var(--duration-quick) var(--ease-premium);
  }

  @media (pointer: coarse) {
    .dd-item {
      min-height: 3rem;
    }
  }

  .dd-item:hover:not(:disabled),
  .dd-item--focused {
    background: var(--solus-accent-light);
    color: var(--solus-text-primary);
  }

  .dd-item--selected {
    color: var(--solus-text-primary);
    font-weight: 600;
  }

  .dd-item--danger:hover:not(:disabled),
  .dd-item--danger.dd-item--focused {
    color: var(--solus-error);
    background: var(--solus-accent-light);
  }

  .dd-item:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .dd-item:disabled:hover {
    background: transparent;
    color: var(--solus-text-secondary);
  }

  .dd-item:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border-medium);
    outline-offset: -0.125rem;
  }

  .dd-item__content {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    flex: 1;
  }

  .dd-item__trailing {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    flex-shrink: 0;
  }

</style>
