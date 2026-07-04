<script lang="ts">
  interface Props {
    x: number
    y: number
    /** Whether the diagram clipboard holds something to paste. */
    canPaste: boolean
    onAddNode: () => void
    onAddGroup: () => void
    onPaste: () => void
    onSelectAll: () => void
    onFitView: () => void
    onAutoLayout: () => void
    onClose: () => void
  }

  let {
    x,
    y,
    canPaste,
    onAddNode,
    onAddGroup,
    onPaste,
    onSelectAll,
    onFitView,
    onAutoLayout,
    onClose,
  }: Props = $props()

  const isMac = navigator.platform.includes('Mac')
  const mod = isMac ? '⌘' : 'Ctrl+'

  let menuEl: HTMLDivElement | undefined

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose()
  }

  // Portal to document.body so position:fixed is viewport-relative, not relative
  // to a CSS-contained ancestor (matches ContextMenu).
  function portalToBody(node: HTMLElement) {
    document.body.appendChild(node)
    return { destroy() { node.remove() } }
  }

  $effect(() => {
    requestAnimationFrame(() => menuEl?.focus())
  })
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div use:portalToBody class="ctx-root" data-solus-ui>
  <div
    class="ctx-backdrop"
    role="presentation"
    onmousedown={(e) => { e.stopPropagation(); onClose() }}
  ></div>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    bind:this={menuEl}
    class="ctx-menu"
    style:left="{x}px"
    style:top="{y}px"
    role="menu"
    tabindex="-1"
    onkeydown={handleKeydown}
  >
    <button
      type="button"
      class="ctx-menu__item"
      role="menuitem"
      onclick={() => { onAddNode(); onClose() }}
    >
      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" />
        <path d="M8 5.5v5M5.5 8h5" />
      </svg>
      Add node here
    </button>

    <button
      type="button"
      class="ctx-menu__item"
      role="menuitem"
      onclick={() => { onAddGroup(); onClose() }}
    >
      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="1.75" y="3.5" width="12.5" height="10" rx="2" stroke-dasharray="2.2 1.8" />
        <path d="M8 7v3M6.5 8.5h3" />
      </svg>
      Add group here
    </button>

    <span class="ctx-menu__divider" aria-hidden="true"></span>

    <button
      type="button"
      class="ctx-menu__item"
      class:ctx-menu__item--disabled={!canPaste}
      role="menuitem"
      disabled={!canPaste}
      onclick={() => { onPaste(); onClose() }}
    >
      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3.5" y="3" width="9" height="11" rx="1.5" />
        <path d="M6 3V2a1 1 0 011-1h2a1 1 0 011 1v1" />
      </svg>
      Paste
      <span class="ctx-menu__shortcut">{mod}V</span>
    </button>

    <button
      type="button"
      class="ctx-menu__item"
      role="menuitem"
      onclick={() => { onSelectAll(); onClose() }}
    >
      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="2.5" y="2.5" width="11" height="11" rx="2" stroke-dasharray="2.4 1.8" />
        <path d="M5.5 8l1.75 1.75L10.5 6" />
      </svg>
      Select all
      <span class="ctx-menu__shortcut">{mod}A</span>
    </button>

    <span class="ctx-menu__divider" aria-hidden="true"></span>

    <button
      type="button"
      class="ctx-menu__item"
      role="menuitem"
      onclick={() => { onFitView(); onClose() }}
    >
      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M5 2H2v3M11 2h3v3M5 14H2v-3M11 14h3v-3" />
      </svg>
      Fit view
    </button>

    <button
      type="button"
      class="ctx-menu__item"
      role="menuitem"
      onclick={() => { onAutoLayout(); onClose() }}
    >
      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="2" y="6" width="4" height="4" rx="1" />
        <rect x="10" y="2.5" width="4" height="4" rx="1" />
        <rect x="10" y="9.5" width="4" height="4" rx="1" />
        <path d="M6 8h2.5M8.5 8V4.5H10M8.5 8v3.5H10" />
      </svg>
      Auto-layout
    </button>
  </div>
</div>

<style>
  .ctx-root {
    position: fixed;
    inset: 0;
    z-index: 999;
  }

  .ctx-backdrop {
    position: absolute;
    inset: 0;
  }

  .ctx-menu {
    position: absolute;
    z-index: 1;
    min-width: 9.5rem;
    padding: 0.25rem;
    border-radius: 0.625rem;
    background: var(--solus-container-bg);
    border: 0.0625rem solid var(--solus-container-border);
    box-shadow: 0 0.25rem 1.5rem rgba(0, 0, 0, 0.18), 0 0.0625rem 0.25rem rgba(0, 0, 0, 0.08);
    outline: none;
    transform-origin: top left;
    animation: ctx-menu-in var(--duration-quick) var(--ease-premium);
  }

  @keyframes ctx-menu-in {
    from {
      opacity: 0;
      scale: 0.98;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .ctx-menu {
      animation: none;
    }
  }

  .ctx-menu__item {
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
    transition: background var(--duration-quick) var(--ease-premium), color var(--duration-quick) var(--ease-premium);
    text-align: left;
  }

  .ctx-menu__item:hover,
  .ctx-menu__item:focus-visible {
    background: color-mix(in srgb, var(--solus-accent) 7%, transparent);
    color: var(--solus-text-primary);
    outline: none;
  }

  .ctx-menu__item--disabled {
    opacity: 0.4;
    pointer-events: none;
  }

  .ctx-menu__divider {
    display: block;
    height: 0.0625rem;
    margin: 0.25rem 0.25rem;
    background: var(--solus-container-border);
  }

  .ctx-menu__shortcut {
    margin-left: auto;
    font-size: 0.625rem;
    color: var(--solus-text-tertiary);
    font-weight: 400;
  }
</style>
