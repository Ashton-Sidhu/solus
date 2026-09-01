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
  /* Mirrors the `menu-row` utility in index.css rather than composing with it:
     Svelte's scoped `.dd-item` would outrank the global utility's state rules. */
  .dd-item {
    position: relative;
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.625rem;
    height: 2rem;
    padding: 0 0.625rem;
    border-radius: 0.5rem;
    font-size: var(--text-workspace-chrome);
    font-family: inherit;
    color: var(--solus-text-secondary);
    /* One row type everywhere: regular. Weight is spent on the current row
       (`.dd-item--selected`), never on the list at rest — same contract as
       `@utility menu-surface`. */
    font-weight: 400;
    background: transparent;
    border: none;
    cursor: pointer;
    text-align: left;
    transition: box-shadow var(--duration-quick) var(--ease-premium),
                color var(--duration-quick) var(--ease-premium);
  }

  @media (pointer: coarse) {
    .dd-item {
      min-height: 3rem;
    }
  }

  /* A wash rather than a fill, so hovering the current row keeps its state. */
  .dd-item:hover:not(:disabled),
  .dd-item--focused {
    box-shadow: inset 0 0 0 62rem var(--solus-menu-hover-ink);
    color: var(--solus-text-primary);
  }

  .dd-item--selected {
    color: var(--solus-text-primary);
    font-weight: 500;
  }

  .dd-item--danger:hover:not(:disabled),
  .dd-item--danger.dd-item--focused {
    color: var(--solus-error);
  }

  .dd-item:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .dd-item:disabled:hover {
    box-shadow: none;
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
