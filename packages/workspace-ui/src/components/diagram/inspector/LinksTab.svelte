<script lang="ts">
  import type { DiagramNode } from '@solus/contracts/diagram-types'
  import type { NodeLink } from '../lib/inspector-model'
  import * as DropdownMenu from '../../ui/dropdown-menu'
  import { Input } from '../../ui/input'

  // Only the genuinely user-authorable actions the canvas handles are surfaced:
  // open a URL, or focus the node's neighbours. 'none' clears the action.
  type ClickKind = 'none' | 'openUrl' | 'focus'

  interface Props {
    node: DiagramNode
    links: NodeLink[]
    onUpdateNode: (id: string, patch: Partial<DiagramNode>) => void
    /** Swap the inspector for the edge editor. */
    onOpenEdge: (edgeId: string) => void
    /** Whether this node may own a detail sub-diagram (top-level, non-group). */
    canDetail: boolean
    hasDetail: boolean
    onOpenDetail: () => void
    onRemoveDetail: () => void
  }

  let {
    node,
    links,
    onUpdateNode,
    onOpenEdge,
    canDetail,
    hasDetail,
    onOpenDetail,
    onRemoveDetail,
  }: Props = $props()

  const isGroup = $derived(!!node.group)

  const CLICK_OPTIONS: { value: ClickKind; label: string }[] = [
    { value: 'none', label: 'Nothing' },
    { value: 'openUrl', label: 'Open a URL…' },
    { value: 'focus', label: 'Focus connections' },
  ]

  let clickKind = $state<ClickKind>('none')
  let clickValue = $state('')
  let clickMenuOpen = $state(false)
  let clickTriggerEl = $state<HTMLButtonElement | null>(null)
  let clickTriggerW = $state(0)

  const clickLabel = $derived(CLICK_OPTIONS.find((o) => o.value === clickKind)?.label ?? 'Nothing')

  let syncedId = $state<string | null>(null)
  $effect(() => {
    if (node.id !== syncedId) {
      syncedId = node.id
      const click = node.actions?.find((a) => a.on === 'click')?.action
      if (click?.do === 'openUrl') { clickKind = 'openUrl'; clickValue = click.url }
      else if (click?.do === 'focus') { clickKind = 'focus'; clickValue = '' }
      else { clickKind = 'none'; clickValue = '' }
    }
  })

  function commit(patch: Partial<DiagramNode>) {
    onUpdateNode(node.id, patch)
  }

  // openUrl needs a value — an empty one clears the action rather than persist
  // a no-op.
  function commitAction() {
    if (clickKind === 'none') { commit({ actions: undefined }); return }
    if (clickKind === 'focus') { commit({ actions: [{ on: 'click', action: { do: 'focus' } }] }); return }
    const v = clickValue.trim()
    if (!v) { commit({ actions: undefined }); return }
    commit({ actions: [{ on: 'click', action: { do: 'openUrl', url: v } }] })
  }
</script>

<div class="inspector-field">
  <span class="inspector-label">Connections</span>
  {#if links.length}
    <div class="links">
      <!-- Keyed by direction too: a self-edge appears as both an out and an in. -->
      {#each links as link (`${link.edgeId}-${link.direction}`)}
        <button type="button" class="link" onclick={() => onOpenEdge(link.edgeId)}>
          <span class="link__dir" class:link__dir--in={link.direction === 'in'} aria-hidden="true">
            {link.direction === 'out' ? '→' : '←'}
          </span>
          <span class="link__node">{link.otherLabel}</span>
          {#if link.label}
            <span class="link__label">{link.label}</span>
          {/if}
        </button>
      {/each}
    </div>
  {:else}
    <p class="empty">Nothing wired to this node yet. Drag from any edge of the card to connect it.</p>
  {/if}
</div>

{#if canDetail}
  <div class="inspector-field">
    <span class="inspector-label">Detail diagram</span>
    <div class="detail-row">
      <button type="button" class="detail-btn" onclick={onOpenDetail}>
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="2" y="2.5" width="7" height="5" rx="1" />
          <rect x="7" y="8.5" width="7" height="5" rx="1" />
          <path d="M5.5 7.5v1.5a1 1 0 001 1h1" />
        </svg>
        {hasDetail ? 'Open detail diagram' : 'Add detail diagram'}
      </button>
      {#if hasDetail}
        <button
          type="button"
          class="inspector-icon-btn"
          onclick={onRemoveDetail}
          title="Remove detail diagram"
          aria-label="Remove detail diagram"
        >
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 4.5h10M6.5 4.5V3a1 1 0 011-1h1a1 1 0 011 1v1.5" />
            <path d="M4 4.5l.5 8.5a1 1 0 001 1h5a1 1 0 001-1l.5-8.5" />
          </svg>
        </button>
      {/if}
    </div>
  </div>
{/if}

{#if !isGroup}
  <div class="inspector-field">
    <span class="inspector-label">On click</span>
    <div class="select-wrap">
      <button
        type="button"
        bind:this={clickTriggerEl}
        bind:clientWidth={clickTriggerW}
        class="inspector-input select"
        aria-haspopup="listbox"
        aria-expanded={clickMenuOpen}
        onclick={() => (clickMenuOpen = !clickMenuOpen)}
      >
        {clickLabel}
      </button>
      <svg class="select__chevron" class:select__chevron--open={clickMenuOpen} viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M4 6.5l4 4 4-4" />
      </svg>
      <DropdownMenu.Root bind:open={clickMenuOpen}>
        <DropdownMenu.Content customAnchor={clickTriggerEl} side="top" align="start" sideOffset={6} style={`width:${clickTriggerW}px`}>
          <div class="py-1">
            {#each CLICK_OPTIONS as opt (opt.value)}
              <DropdownMenu.Item
                class={clickKind === opt.value ? 'font-medium' : undefined}
                onSelect={() => {
                  clickKind = opt.value
                  clickValue = ''
                  commitAction()
                  clickMenuOpen = false
                }}
              >
                {opt.label}
              </DropdownMenu.Item>
            {/each}
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>
    {#if clickKind === 'openUrl'}
      <Input class="inspector-input" bind:value={clickValue} oninput={commitAction} placeholder="https://…" />
    {/if}
  </div>
{/if}

<style>
  .links {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  /* Each row is navigation, so it leans toward the panel edge it will open from
     rather than lighting up in place. */
  .link {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.4375rem 0.5rem;
    border: none;
    border-radius: 0.625rem;
    background: transparent;
    text-align: left;
    cursor: pointer;
    transition:
      background var(--duration-quick) var(--ease-premium),
      translate var(--duration-base) var(--ease-premium);
  }

  .link:hover {
    background: var(--solus-surface-hover);
    translate: 0.125rem 0;
  }

  .link:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: -0.125rem;
  }

  /* The direction glyph rides a tinted disc: outbound in the accent, inbound
     quiet, so a fan-out is readable without reading a single label. */
  .link__dir {
    display: grid;
    place-items: center;
    flex: none;
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 9999px;
    background: var(--solus-accent-light);
    color: var(--solus-accent);
    font-size: var(--text-xs);
    line-height: 1;
  }

  .link__dir--in {
    background: var(--solus-surface-hover);
    color: var(--solus-text-tertiary);
  }

  .link__node {
    flex: 1;
    min-width: 0;
    font-size: var(--text-sm);
    color: var(--solus-text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .link__label {
    flex: 0 1 auto;
    min-width: 0;
    padding: 0.0625rem 0.375rem;
    border-radius: 9999px;
    background: var(--solus-surface-hover);
    font-size: var(--text-xs);
    color: var(--solus-text-tertiary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* An empty state is a surface, not a stray sentence: the same dashed outline
     the Add slots wear, so "nothing here yet" looks deliberate. */
  .empty {
    margin: 0;
    padding: 0.75rem 0.875rem;
    border: 0.0625rem dashed var(--solus-tool-border);
    border-radius: 0.75rem;
    font-size: var(--text-xs);
    line-height: 1.55;
    color: var(--solus-text-tertiary);
    text-wrap: pretty;
  }

  .detail-row {
    display: flex;
    gap: 0.375rem;
  }

  .detail-btn {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.4375rem;
    padding: 0.5625rem 0.75rem;
    border: none;
    border-radius: 0.625rem;
    background: var(--solus-surface-hover);
    box-shadow: inset 0 0 0 0.0625rem color-mix(in srgb, var(--solus-text-primary) 6%, transparent);
    color: var(--solus-text-secondary);
    font-size: var(--text-xs);
    font-weight: 500;
    cursor: pointer;
    transition:
      background var(--duration-base) var(--ease-premium),
      box-shadow var(--duration-base) var(--ease-premium),
      color var(--duration-base) var(--ease-premium),
      scale var(--duration-quick) var(--ease-premium);
  }

  .detail-btn:hover {
    background: var(--solus-accent-light);
    box-shadow: inset 0 0 0 0.0625rem var(--solus-accent-border-medium);
    color: var(--solus-accent);
  }

  .detail-btn:active { scale: 0.985; }

  .detail-btn:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.125rem;
  }

  .select-wrap {
    position: relative;
    display: flex;
  }

  .select {
    cursor: pointer;
    text-align: left;
    appearance: none;
    /* Drop the native arrow so we can place a perfectly centred custom one. */
    -webkit-appearance: none;
    padding-right: 1.75rem;
  }

  .select__chevron {
    position: absolute;
    right: 0.5rem;
    top: 50%;
    transform: translateY(-50%);
    color: var(--solus-text-tertiary);
    pointer-events: none;
    transition:
      rotate var(--duration-base) var(--ease-premium),
      color var(--duration-base) var(--ease-premium);
  }

  /* The menu opens upward (side="top"), so the chevron turns to point at it. */
  .select__chevron--open {
    rotate: 180deg;
    color: var(--solus-accent);
  }

  .select-wrap:hover .select__chevron { color: var(--solus-text-secondary); }

  @media (prefers-reduced-motion: reduce) {
    .link,
    .detail-btn,
    .select__chevron {
      transition: none;
    }
    .link:hover { translate: none; }
  }
</style>
