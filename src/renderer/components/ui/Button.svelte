<script lang="ts">
  import type { Snippet } from 'svelte'
  import Kbd from './Kbd.svelte'

  interface Props {
    variant?: 'ghost' | 'primary' | 'soft' | 'danger' | 'outline'
    size?: 'sm' | 'md' | 'lg'
    icon?: boolean
    disabled?: boolean
    kbd?: string
    type?: 'button' | 'submit' | 'reset'
    class?: string
    'data-testid'?: string
    onclick?: (e: MouseEvent) => void
    children: Snippet
  }

  let {
    variant = 'ghost',
    size = 'md',
    icon = false,
    disabled = false,
    kbd,
    type = 'button',
    class: extraClass = '',
    'data-testid': dataTestId,
    onclick,
    children,
  }: Props = $props()
</script>

<button
  {type}
  {disabled}
  {onclick}
  data-testid={dataTestId}
  class="btn btn--{variant} btn--{size} {icon ? 'btn--icon' : ''} {extraClass}"
>
  {@render children()}
  {#if kbd}
    <Kbd variant="inline" class="ml-1">{kbd}</Kbd>
  {/if}
</button>

<style>
  .btn {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 0.0625rem solid transparent;
    cursor: pointer;
    white-space: nowrap;
    font-family: inherit;
    transition:
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium),
      border-color var(--duration-quick) var(--ease-premium),
      opacity var(--duration-quick) var(--ease-premium),
      transform 80ms var(--ease-premium);
  }

  .btn:active {
    transform: scale(0.97);
  }

  .btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    pointer-events: none;
  }

  .btn:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border);
    outline-offset: 0.125rem;
  }

  /* Sizes */
  .btn--sm {
    height: 1.5rem;
    padding: 0.25rem 0.5rem;
    font-size: 0.6875rem;
    border-radius: 0.375rem;
    gap: 0.25rem;
  }
  .btn--md {
    height: 1.75rem;
    padding: 0.375rem 0.625rem;
    font-size: 0.75rem;
    border-radius: 0.4375rem;
    gap: 0.3125rem;
  }
  .btn--lg {
    height: 2.25rem;
    padding: 0.5rem 0.875rem;
    font-size: 0.8125rem;
    border-radius: 0.5rem;
    gap: 0.375rem;
  }

  /* Icon-only: square */
  .btn--icon.btn--sm { width: 1.5rem; padding: 0; }
  .btn--icon.btn--md { width: 1.75rem; padding: 0; }
  .btn--icon.btn--lg { width: 2.25rem; padding: 0; }

  @media (pointer: coarse) {
    .btn--sm::before,
    .btn--md::before,
    .btn--icon::before {
      content: "";
      position: absolute;
      top: 50%;
      left: 50%;
      width: max(100%, 3rem);
      height: max(100%, 3rem);
      transform: translate(-50%, -50%);
    }
  }

  /* ghost */
  .btn--ghost {
    background: transparent;
    color: var(--solus-text-secondary);
    font-weight: var(--solus-font-weight-secondary);
  }
  .btn--ghost:hover:not(:disabled) {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }

  /* primary */
  .btn--primary {
    background: var(--solus-accent);
    color: #fff;
    font-weight: 500;
  }
  .btn--primary:hover:not(:disabled) {
    background: var(--solus-send-hover);
  }

  /* soft */
  .btn--soft {
    background: var(--solus-accent-light);
    color: var(--solus-accent);
    border-color: var(--solus-accent-border);
  }
  .btn--soft:hover:not(:disabled) {
    background: var(--solus-accent-soft);
    border-color: var(--solus-accent-border-medium);
  }

  /* danger */
  .btn--danger {
    background: transparent;
    color: var(--solus-text-secondary);
    font-weight: var(--solus-font-weight-secondary);
    border-color: var(--solus-tool-border);
  }
  .btn--danger:hover:not(:disabled) {
    background: var(--solus-surface-hover);
    color: var(--solus-error);
    border-color: color-mix(in srgb, var(--solus-error) 30%, var(--solus-tool-border));
  }

  /* outline */
  .btn--outline {
    background: transparent;
    color: var(--solus-text-secondary);
    font-weight: var(--solus-font-weight-secondary);
    border-color: var(--solus-tool-border);
  }
  .btn--outline:hover:not(:disabled) {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }
</style>
