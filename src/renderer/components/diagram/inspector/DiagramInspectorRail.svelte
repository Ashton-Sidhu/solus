<script lang="ts">
  import type { Snippet } from 'svelte'
  import { fly } from 'svelte/transition'
  import { quintOut } from 'svelte/easing'

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  interface Props {
    /** One word for what is selected: the node's kind, or simply "Edge". */
    kindWord: string
    /** Runs vertically down the rail. Truncates rather than shrinking the type. */
    label: string
    /** The identity tile's tint — the one place selection colour appears. */
    tint: string
    /** The same tab names the open panel shows, in the same order. */
    tabs: readonly string[]
    tab: string
    /** Marks the bubble icon when Solus has spoken in a thread here. */
    hasUnreadThreads: boolean
    /** Reopen the panel. A tab is passed when a tab icon was the hit target. */
    onExpand: (tab?: string) => void
    /** The 16px glyph inside the identity tile. */
    tile: Snippet
  }

  let { kindWord, label, tint, tabs, tab, hasUnreadThreads, onExpand, tile }: Props = $props()

  const TAB_LABELS: Record<string, string> = {
    identity: 'Identity',
    style: 'Style',
    data: 'Data',
    links: 'Links',
    route: 'Route',
    comments: 'Comments',
  }

  function handleRailKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onExpand()
    }
  }
</script>

<!-- The whole rail is one hit target — a collapse, not a dismiss, so getting
     back should never require aiming. Clicking a tab icon reopens on that tab. -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="diagram-rail"
  role="button"
  tabindex="0"
  aria-label="Expand inspector for {label}"
  onclick={() => onExpand()}
  onkeydown={handleRailKeydown}
  in:fly|global={{ x: 16, duration: reduceMotion ? 0 : 180, easing: quintOut }}
  out:fly|global={{ x: 10, duration: reduceMotion ? 0 : 120, easing: quintOut }}
>
  <span class="diagram-rail__tile" style="--tile-tint:{tint}" aria-hidden="true">
    {@render tile()}
  </span>

  <span class="diagram-rail__kind">{kindWord}</span>

  <span class="diagram-rail__rule" aria-hidden="true"></span>

  <div class="diagram-rail__tabs">
    {#each tabs as name (name)}
      <button
        type="button"
        class="diagram-rail__tab"
        class:diagram-rail__tab--active={tab === name}
        onclick={(e) => { e.stopPropagation(); onExpand(name) }}
        title={TAB_LABELS[name]}
        aria-label="Open {TAB_LABELS[name]} tab"
      >
        {#if name === 'identity'}
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">
            <path d="M3 4.5h7M3 8h10M3 11.5h5.5" />
            <circle cx="12.5" cy="4.5" r="1.4" />
          </svg>
        {:else if name === 'style'}
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true">
            <path d="M9.5 2.6 13.4 6.5 6.8 13.1a2.5 2.5 0 0 1-1.4.7l-2.7.4.4-2.7c.07-.5.32-1 .7-1.4L9.5 2.6Z" />
          </svg>
        {:else if name === 'data'}
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
            <path d="M2.5 6.5h11M6.5 6.5v7" />
          </svg>
        {:else if name === 'links'}
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">
            <path d="M6.5 9.5a2.8 2.8 0 0 0 4 0l2-2a2.83 2.83 0 0 0-4-4l-.6.6" />
            <path d="M9.5 6.5a2.8 2.8 0 0 0-4 0l-2 2a2.83 2.83 0 0 0 4 4l.6-.6" />
          </svg>
        {:else if name === 'route'}
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">
            <path d="M2.5 4h5a2 2 0 0 1 2 2v6" />
            <circle cx="2.5" cy="4" r="1.3" />
            <path d="M7.5 10l2 2 2-2" />
          </svg>
        {:else}
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true">
            <path d="M2.6 4.2A1.6 1.6 0 0 1 4.2 2.6h7.6a1.6 1.6 0 0 1 1.6 1.6v4.8a1.6 1.6 0 0 1-1.6 1.6H6.6L3.6 13.2v-2.6h.6a1.6 1.6 0 0 1-1.6-1.6z" />
          </svg>
          {#if hasUnreadThreads}
            <span class="diagram-rail__unread" aria-label="Unread threads"></span>
          {/if}
        {/if}
      </button>
    {/each}
  </div>

  <span class="diagram-rail__rule" aria-hidden="true"></span>

  <span class="diagram-rail__label">{label}</span>

  <span class="diagram-rail__expand" aria-hidden="true">
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
      <path d="M2.5 3v10M12 8H5.5M9 5L6 8l3 3" />
    </svg>
  </span>
</div>

<style>
  /* Same radius and border as the open panel; a lighter shadow because it
     carries less. */
  .diagram-rail {
    position: absolute;
    right: 1rem;
    top: 1rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.625rem;
    width: 3rem;
    padding: 0.5rem 0 0.4375rem;
    background: var(--solus-container-bg);
    border: 0.0625rem solid var(--solus-container-border);
    border-radius: 0.875rem;
    box-shadow:
      0 1.125rem 2.75rem -1.125rem rgba(60, 40, 25, 0.34),
      0 0.0625rem 0.1875rem rgba(60, 40, 25, 0.08);
    z-index: 9;
    cursor: pointer;
  }

  .diagram-rail:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.125rem;
  }

  .diagram-rail__tile {
    display: grid;
    place-items: center;
    width: 2rem;
    height: 2rem;
    border-radius: 0.5625rem;
    font-size: 0.875rem;
    line-height: 1;
    color: var(--tile-tint);
    background: linear-gradient(
      155deg,
      color-mix(in srgb, var(--tile-tint) 24%, transparent),
      color-mix(in srgb, var(--tile-tint) 7%, transparent)
    );
    box-shadow: inset 0 0 0 0.0625rem color-mix(in srgb, var(--tile-tint) 34%, transparent);
  }

  .diagram-rail__kind {
    max-width: 100%;
    padding: 0 0.125rem;
    font-size: 0.5rem;
    font-weight: 650;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--solus-text-tertiary);
    opacity: 0.85;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .diagram-rail__rule {
    width: 1.25rem;
    height: 0.0625rem;
    background: var(--solus-container-border);
  }

  .diagram-rail__tabs {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
  }

  .diagram-rail__tab {
    position: relative;
    display: grid;
    place-items: center;
    width: 1.875rem;
    height: 1.75rem;
    border: none;
    border-radius: 0.375rem;
    background: transparent;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    transition:
      color var(--duration-base) var(--ease-premium),
      background var(--duration-base) var(--ease-premium);
  }

  .diagram-rail__tab:hover {
    color: var(--solus-text-primary);
    background: var(--solus-surface-hover);
  }

  .diagram-rail__tab--active {
    color: var(--solus-accent);
    background: color-mix(in srgb, var(--solus-accent) 11%, transparent);
  }

  /* The collapsed rail's one piece of new information: Solus has spoken. */
  .diagram-rail__unread {
    position: absolute;
    top: 0.125rem;
    right: 0.1875rem;
    width: 0.3125rem;
    height: 0.3125rem;
    border-radius: 999px;
    background: var(--solus-art-2);
  }

  .diagram-rail__tab:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: -0.125rem;
  }

  /* Truncates at ~112px of vertical run — the type never shrinks to fit. */
  .diagram-rail__label {
    writing-mode: vertical-rl;
    max-height: 7rem;
    font-size: 0.65625rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    color: var(--solus-text-tertiary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .diagram-rail__expand {
    display: grid;
    place-items: center;
    width: 1.75rem;
    height: 1.5rem;
    color: var(--solus-text-tertiary);
  }

  .diagram-rail:hover .diagram-rail__expand { color: var(--solus-text-primary); }

  @media (prefers-reduced-motion: reduce) {
    .diagram-rail__tab { transition: none; }
  }
</style>
