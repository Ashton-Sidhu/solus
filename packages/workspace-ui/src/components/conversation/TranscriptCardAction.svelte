<script lang="ts">
  import type { Snippet } from "svelte";
  import { menuRowVariants } from "../ui/menu";

  /**
   * A button on a transcript card line, or a row in its ⋯ menu. It stops the
   * click at the button, so the card under it never opens as well.
   *
   * - `primary`: 6% fill. Open, Report, Read, Done.
   * - `filled`: solid, only when the card waits on the user. Review, Connect.
   * - `ghost`: no fill. Pause, Annotate, Stop, Not now.
   * - `icon`: a 24px square for split, dismiss, and the like.
   * - `item`: a row inside the card's ⋯ menu.
   */
  interface Props {
    kind?: "primary" | "filled" | "ghost" | "icon" | "item";
    /** Accessible name and tooltip; required for `icon`. */
    label?: string;
    disabled?: boolean;
    destructive?: boolean;
    class?: string;
    "data-testid"?: string;
    onclick: () => void;
    children: Snippet;
  }

  let {
    kind = "primary",
    label,
    disabled = false,
    destructive = false,
    class: extraClass = "",
    "data-testid": dataTestId,
    onclick,
    children,
  }: Props = $props();
</script>

<button
  type="button"
  class="{kind === 'item'
    ? menuRowVariants({ class: 'w-full cursor-pointer text-left' })
    : 'tx-card-action'} {extraClass}"
  class:is-filled={kind === "filled"}
  class:is-ghost={kind === "ghost"}
  class:is-icon={kind === "icon"}
  class:text-destructive={destructive}
  aria-label={label}
  title={label}
  {disabled}
  data-testid={dataTestId}
  onclick={(e) => {
    e.stopPropagation();
    onclick();
  }}
>
  {@render children()}
</button>

<style>
  :global(.tx-card-action) {
    display: inline-flex;
    height: 1.5rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
    border: none;
    border-radius: 0.4375rem;
    background: color-mix(in oklch, var(--foreground) 6%, transparent);
    padding: 0 0.625rem;
    white-space: nowrap;
    color: var(--solus-text-secondary);
    font-size: var(--text-transcript-meta);
    font-weight: 500;
    cursor: pointer;
    transition:
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium),
      transform 80ms var(--ease-premium);
  }

  :global(.tx-card-action:hover) {
    background: color-mix(in oklch, var(--foreground) 11%, transparent);
    color: var(--solus-text-primary);
  }

  :global(.tx-card-action.is-filled) {
    background: var(--solus-text-primary);
    color: var(--solus-container-bg);
  }

  :global(.tx-card-action.is-filled:hover) {
    background: color-mix(in oklch, var(--solus-text-primary) 88%, transparent);
    color: var(--solus-container-bg);
  }

  :global(.tx-card-action.is-ghost),
  :global(.tx-card-action.is-icon) {
    border-radius: 0.375rem;
    background: transparent;
    padding: 0 0.5rem;
    color: var(--muted-foreground);
    font-weight: 400;
  }

  :global(.tx-card-action.is-icon) {
    width: 1.5rem;
    padding: 0;
  }

  :global(.tx-card-action.is-ghost:hover),
  :global(.tx-card-action.is-icon:hover) {
    background: color-mix(in oklch, var(--foreground) 6%, transparent);
    color: var(--solus-text-primary);
  }

  :global(.tx-card-action:active) {
    transform: scale(0.96);
  }

  :global(.tx-card-action:disabled) {
    cursor: default;
    opacity: 0.5;
  }

  :global(.tx-card-action:focus-visible) {
    outline: 0.125rem solid var(--solus-accent-border-medium);
    outline-offset: 0.125rem;
  }

  /* Geometry only. A finger gets a 32px target. */
  @media (pointer: fine) {
    :global(html.is-laptop-display .tx-card-action) {
      height: 1.375rem;
      padding: 0 0.5rem;
    }
    :global(html.is-laptop-display .tx-card-action.is-icon) {
      width: 1.375rem;
      padding: 0;
    }
  }

  @media (pointer: coarse) {
    :global(.tx-card-action) {
      height: 2rem;
    }
    :global(.tx-card-action.is-icon) {
      width: 2rem;
    }
  }
</style>
