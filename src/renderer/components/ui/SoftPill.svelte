<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    onclick?: (e: MouseEvent) => void;
    /** Visual variant: neutral surface, accent-active, or accent-filled primary. */
    variant?: "default" | "active" | "primary";
    title?: string;
    ariaLabel?: string;
    disabled?: boolean;
    testid?: string;
    children: Snippet;
  }

  let {
    onclick,
    variant = "default",
    title,
    ariaLabel,
    disabled = false,
    testid,
    children,
  }: Props = $props();
</script>

<button
  type="button"
  class="soft-pill"
  class:soft-pill--active={variant === "active"}
  class:soft-pill--primary={variant === "primary"}
  {onclick}
  {title}
  {disabled}
  aria-label={ariaLabel}
  data-testid={testid}
>
  {@render children()}
</button>

<style>
  .soft-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    padding: 0.3125rem 0.625rem;
    font-size: 0.6875rem;
    font-weight: 500;
    border-radius: 0.4375rem;
    background: var(--solus-surface-hover);
    color: var(--solus-text-secondary);
    border: none;
    cursor: pointer;
    transition:
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium),
      transform 80ms var(--ease-premium);
  }
  :global(.dark) .soft-pill {
    background: color-mix(in srgb, var(--solus-surface-hover) 80%, transparent);
  }
  .soft-pill:hover {
    background: color-mix(in srgb, var(--solus-surface-hover) 100%, var(--solus-text-tertiary) 8%);
    color: var(--solus-text-primary);
  }
  .soft-pill:active {
    transform: scale(0.97);
  }
  .soft-pill:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border);
    outline-offset: 0.0625rem;
  }
  .soft-pill:disabled {
    cursor: default;
    opacity: 0.6;
  }
  .soft-pill--active {
    background: var(--solus-accent-light);
    color: var(--solus-accent);
  }
  .soft-pill--active:hover {
    background: var(--solus-accent-soft);
    color: var(--solus-accent);
  }
  .soft-pill--primary {
    background: var(--solus-accent);
    color: #fff;
  }
  .soft-pill--primary:hover {
    background: var(--solus-send-hover);
    color: #fff;
  }
</style>
