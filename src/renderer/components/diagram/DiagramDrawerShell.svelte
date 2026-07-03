<script lang="ts">
  import type { Snippet } from "svelte";
  import { fly } from "svelte/transition";
  import { quintOut } from "svelte/easing";
  import { XIcon } from "phosphor-svelte";

  // Svelte transitions don't consult prefers-reduced-motion on their own —
  // zero the durations so reduced-motion users get an instant swap.
  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  interface Props {
    title: string;
    ariaLabel: string;
    onClose: () => void;
    // Optional status dot shown before the title (node status colour).
    statusColor?: string | null;
    // Focus the first `.diagram-drawer__name-input` on mount — set only when the
    // drawer is opened via an explicit edit intent, so plain selection leaves
    // keyboard focus on the canvas and canvas shortcuts keep working.
    autoFocus?: boolean;
    children: Snippet;
    footer?: Snippet;
  }

  let {
    title,
    ariaLabel,
    onClose,
    statusColor = null,
    autoFocus = false,
    children,
    footer,
  }: Props = $props();

  let drawerEl = $state<HTMLDivElement | undefined>();

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
  }

  $effect(() => {
    if (autoFocus && drawerEl) {
      drawerEl
        .querySelector<HTMLElement>(".diagram-drawer__name-input")
        ?.focus();
    }
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- `|global` so the transitions also play when the parent's {#if} removes the
     whole drawer component, not just this element's own block. The exit is
     deliberately softer than the enter: shorter, with a smaller offset. -->
<div
  class="diagram-drawer"
  bind:this={drawerEl}
  role="complementary"
  aria-label={ariaLabel}
  in:fly|global={{ x: 24, duration: reduceMotion ? 0 : 200, easing: quintOut }}
  out:fly|global={{ x: 12, duration: reduceMotion ? 0 : 140, easing: quintOut }}
>
  <div class="diagram-drawer__header">
    <div class="diagram-drawer__title-group">
      {#if statusColor}
        <span
          class="diagram-drawer__status-dot"
          style="background:{statusColor}"
          aria-hidden="true"
        ></span>
      {/if}
      <span class="diagram-drawer__title">{title}</span>
    </div>
    <button
      type="button"
      class="diagram-drawer__close"
      onclick={onClose}
      title="Close (Esc)"
      aria-label="Close"
    >
      <XIcon size={13} />
    </button>
  </div>

  <div class="diagram-drawer__content">
    {@render children()}
  </div>

  {#if footer}
    <div class="diagram-drawer__footer">
      {@render footer()}
    </div>
  {/if}
</div>

<style>
  /* Floating canvas overlay that reads as one of the app's side panels: same
     sidebar background, 1rem radius, container border and soft shadow as
     SidePanel.svelte, just absolutely positioned over the diagram and inset from
     the board edges. */
  .diagram-drawer {
    position: absolute;
    right: 0.5rem;
    top: 0.5rem;
    bottom: 0.5rem;
    width: clamp(18rem, 34vw, 21rem);
    max-width: calc(100% - 1rem);
    display: flex;
    flex-direction: column;
    background: var(--solus-sidebar-bg-left);
    border: 0.0625rem solid var(--solus-container-border);
    border-radius: 1rem;
    box-shadow: var(--solus-card-shadow-collapsed);
    z-index: 10;
    overflow: hidden;
  }

  /* Header mirrors SidePanel: uppercase micro-caps title + a ghost icon button. */
  .diagram-drawer__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.75rem 0.75rem 0.625rem 1rem;
    flex-shrink: 0;
  }

  .diagram-drawer__title-group {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .diagram-drawer__status-dot {
    display: inline-block;
    flex-shrink: 0;
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
  }

  .diagram-drawer__title {
    font-size: 0.625rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    opacity: 0.8;
    color: var(--solus-text-tertiary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .diagram-drawer__close {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 1.625rem;
    height: 1.625rem;
    border: none;
    border-radius: 0.375rem;
    background: transparent;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    transition:
      color var(--duration-base) var(--ease-premium),
      background-color var(--duration-base) var(--ease-premium),
      scale var(--duration-quick) var(--ease-premium);
  }

  @media (hover: hover) {
    .diagram-drawer__close:hover {
      color: var(--solus-text-primary);
      background: color-mix(in srgb, var(--solus-accent) 7%, transparent);
    }
  }

  .diagram-drawer__close:active {
    background: color-mix(in srgb, var(--solus-accent) 12%, transparent);
    scale: 0.96;
  }

  .diagram-drawer__close:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.0625rem;
  }

  .diagram-drawer__content {
    flex: 1;
    overflow-y: auto;
    padding: 0.25rem 1rem 0.875rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .diagram-drawer__footer {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    border-top: 0.0625rem solid
      color-mix(in srgb, var(--solus-text-tertiary) 14%, transparent);
    flex-shrink: 0;
  }

  /* Shared field primitives — rendered inside the slotted content of both
     drawers (DiagramDetailsDrawer / DiagramEdgeDrawer), so they're declared
     :global here to be the single source instead of copied into each drawer. */
  :global(.diagram-drawer__field) {
    display: flex;
    flex-direction: column;
    gap: 0.3125rem;
    min-width: 0;
  }

  :global(.diagram-drawer__label) {
    font-size: 0.625rem;
    font-weight: 600;
    color: var(--solus-text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  :global(.diagram-drawer__input),
  :global(.diagram-drawer__select),
  :global(.diagram-drawer__textarea) {
    width: 100%;
    padding: 0.4375rem 0.5rem;
    border-radius: 0.5rem;
    border: 0.0625rem solid var(--solus-tool-border);
    background: var(--solus-surface-primary);
    color: var(--solus-text-primary);
    font-size: 0.75rem;
    font-family: inherit;
    outline: none;
    transition:
      border-color var(--duration-base) var(--ease-premium),
      box-shadow var(--duration-base) var(--ease-premium);
  }

  :global(.diagram-drawer__input:focus),
  :global(.diagram-drawer__select:focus),
  :global(.diagram-drawer__textarea:focus) {
    border-color: var(--solus-accent-border);
    box-shadow: 0 0 0 0.125rem var(--solus-accent-soft);
  }

  /* Shared button primitive used by drawer footers (mirrored from DiagramShell). */
  :global(.diagram-drawer .diagram-btn) {
    font-size: 0.6875rem;
    padding: 0.25rem 0.625rem;
    border-radius: 0.375rem;
    border: 0.0625rem solid var(--solus-accent-border);
    background: var(--solus-accent-light);
    color: var(--solus-accent);
    cursor: pointer;
    transition:
      opacity var(--duration-base) var(--ease-premium),
      scale var(--duration-quick) var(--ease-premium);
    font-weight: 500;
  }

  :global(.diagram-drawer .diagram-btn:hover) {
    opacity: 0.8;
  }

  :global(.diagram-drawer .diagram-btn:active) {
    scale: 0.96;
  }

  :global(.diagram-drawer .diagram-btn:focus-visible) {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.125rem;
  }

  :global(.diagram-drawer .diagram-btn--ghost) {
    border-color: var(--solus-tool-border);
    background: transparent;
    color: var(--solus-text-secondary);
  }

</style>
