<script lang="ts">
  import type { Snippet } from "svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";

  interface Props {
    title: string;
    ariaLabel: string;
    minWidth?: string | number;
    // The trigger button's inner icon.
    icon: Snippet;
    // Menu items. Receives a `close` callback so an item can dismiss the menu.
    children: Snippet<[() => void]>;
  }

  let { title, ariaLabel, minWidth = "9rem", icon, children }: Props = $props();

  let open = $state(false);
  function close() {
    open = false;
  }
</script>

<div class="popover">
  <DropdownMenu.Root bind:open>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <button {...props} type="button" class="canvas-toolbar__btn" class:popover__btn--active={open} {title} aria-label={ariaLabel}>
          {@render icon()}
        </button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content side="bottom" align="start" sideOffset={6} style={`min-width:${typeof minWidth === "number" ? `${minWidth}px` : minWidth}`}>
    <div class="popover__menu" role="menu">
      {@render children(close)}
    </div>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
</div>

<style>
  .popover {
    display: flex;
  }

  .popover__btn--active {
    background: var(--solus-accent-light);
    color: var(--solus-text-primary);
  }

  .popover__menu {
    padding: 0.25rem;
  }

  /* Item + divider primitives — rendered inside slotted menu content, so they're
     declared :global to be the single source for both menus. */
  :global(.popover__item) {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.375rem 0.5rem;
    border: none;
    border-radius: 0.375rem;
    background: transparent;
    color: var(--solus-text-secondary);
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
    transition:
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium);
    text-align: left;
  }

  :global(.popover__item:hover) {
    background: color-mix(in srgb, var(--solus-accent) 7%, transparent);
    color: var(--solus-text-primary);
  }

  :global(.popover__divider) {
    display: block;
    height: 0.0625rem;
    margin: 0.1875rem 0.25rem;
    background: var(--solus-container-border);
  }
</style>
