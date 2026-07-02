<script lang="ts">
  interface Props {
    x: number
    y: number
    type: 'node' | 'edge'
    onDelete: () => void
    onEditDetails: () => void
    onClose: () => void
    /** Shown only for a node that is nested inside a group. */
    showRemoveFromGroup?: boolean
    onRemoveFromGroup?: () => void
    /** Shown for a top-level node: open (or create) its nested detail diagram. */
    showDetail?: boolean
    /** True when the node already has a detail diagram (changes the label). */
    hasDetail?: boolean
    onOpenDetail?: () => void
    /** True when the node is already pinned to the back (flips the label). */
    sentToBack?: boolean
    onSendToBack?: () => void
    onBringToFront?: () => void
  }

  let {
    x,
    y,
    type,
    onDelete,
    onEditDetails,
    onClose,
    showRemoveFromGroup = false,
    onRemoveFromGroup,
    showDetail = false,
    hasDetail = false,
    onOpenDetail,
    sentToBack = false,
    onSendToBack,
    onBringToFront,
  }: Props = $props()

  const isMac = navigator.platform.includes('Mac')
  const layerShortcut = $derived(
    sentToBack
      ? isMac ? '⌘⇧]' : 'Ctrl+Shift+]'
      : isMac ? '⌘⇧[' : 'Ctrl+Shift+[',
  )

  let menuEl: HTMLDivElement | undefined

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose()
  }

  // Portal a wrapper to document.body so position:fixed is always viewport-relative,
  // not relative to a CSS-contained ancestor (contain:layout / content-visibility:auto).
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
  <!-- Backdrop: catches outside clicks without interfering with menu clicks -->
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
      onclick={() => { onEditDetails(); onClose() }}
    >
      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M11.5 2.5l2 2-8 8H3.5v-2z" />
        <path d="M9.5 4.5l2 2" />
      </svg>
      {type === 'edge' ? 'Edit edge' : 'Edit details'}
    </button>

    {#if showDetail && onOpenDetail}
      <button
        type="button"
        class="ctx-menu__item"
        role="menuitem"
        onclick={() => { onOpenDetail(); onClose() }}
      >
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="2" y="2.5" width="7" height="5" rx="1" />
          <rect x="7" y="8.5" width="7" height="5" rx="1" />
          <path d="M5.5 7.5v1.5a1 1 0 001 1h1" />
        </svg>
        {hasDetail ? 'Open detail' : 'Add detail diagram'}
      </button>
    {/if}

    {#if showRemoveFromGroup && onRemoveFromGroup}
      <button
        type="button"
        class="ctx-menu__item"
        role="menuitem"
        onclick={() => { onRemoveFromGroup(); onClose() }}
      >
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M2 5.5V4a1 1 0 011-1h3l1.5 1.5H13a1 1 0 011 1V12a1 1 0 01-1 1H3a1 1 0 01-1-1" />
          <path d="M6 9h4" />
        </svg>
        Remove from group
      </button>
    {/if}

    {#if type === 'node' && (onSendToBack || onBringToFront)}
      <button
        type="button"
        class="ctx-menu__item"
        role="menuitem"
        onclick={() => { (sentToBack ? onBringToFront : onSendToBack)?.(); onClose() }}
      >
        {#if sentToBack}
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="2.5" y="2.5" width="8" height="8" rx="1" />
            <path d="M10.5 6.5H13a.5.5 0 01.5.5v6a.5.5 0 01-.5.5H7a.5.5 0 01-.5-.5V10.5" />
          </svg>
          Bring to front
        {:else}
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
            <path d="M5.5 9.5H3a.5.5 0 01-.5-.5V3a.5.5 0 01.5-.5h6a.5.5 0 01.5.5v2.5" />
          </svg>
          Send to back
        {/if}
        <span class="ctx-menu__shortcut">{layerShortcut}</span>
      </button>
    {/if}

    <button
      type="button"
      class="ctx-menu__item ctx-menu__item--danger"
      role="menuitem"
      onclick={() => { onDelete(); onClose() }}
    >
      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 4.5h10M6.5 4.5V3a1 1 0 011-1h1a1 1 0 011 1v1.5" />
        <path d="M4 4.5l.5 8.5a1 1 0 001 1h5a1 1 0 001-1l.5-8.5" />
        <path d="M6.5 7v4M9.5 7v4" />
      </svg>
      Delete
      <span class="ctx-menu__shortcut">{isMac ? '⌫' : 'Del'}</span>
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
    min-width: 8.5rem;
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

  .ctx-menu__item--danger:hover {
    background: color-mix(in srgb, var(--solus-status-error) 12%, transparent);
    color: var(--solus-status-error);
  }

  .ctx-menu__shortcut {
    margin-left: auto;
    font-size: 0.625rem;
    color: var(--solus-text-tertiary);
    font-weight: 400;
  }
</style>
