<script lang="ts">
  import type { Snippet } from "svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";

  interface Props {
    title: string;
    ariaLabel: string;
    minWidth?: string | number;
    maxHeight?: number;
    // The trigger button's inner icon.
    icon: Snippet;
    // Menu items. Callers compose the shared dropdown primitives directly.
    children: Snippet;
  }

  let { title, ariaLabel, minWidth = "9rem", maxHeight, icon, children }: Props = $props();

  let open = $state(false);
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
    <DropdownMenu.Content side="top" align="start" sideOffset={6} collisionPadding={8}
      class={maxHeight ? "w-auto overscroll-contain" : "w-auto"}
      style={`min-width:${typeof minWidth === "number" ? `${minWidth}px` : minWidth};${maxHeight ? `max-height:min(${maxHeight}px,var(--bits-floating-available-height,calc(100dvh - 16px)))` : ""}`}>
      {@render children()}
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
</style>
