<script lang="ts">
  import { onDestroy } from 'svelte'
  import Icon from '@iconify/svelte'
  import { ICON_SVG, isIconifyName, CURATED_ICONS } from './diagram-icons'
  import { ensureIconCollections } from './iconify'
  import { Input } from '../ui/input'

  // Code-split, idempotent brand-icon registration (see DiagramNode).
  ensureIconCollections()

  interface Props {
    value?: string
    onChange: (icon: string) => void
  }

  let { value, onChange }: Props = $props()

  const SEARCH_LIMIT = 48
  const DEBOUNCE_MS = 220
  // Bring full-colour brand logos and clean monochrome glyphs to the front of
  // mixed Iconify search results; everything else keeps its relevance order.
  const PREFIX_RANK: Record<string, number> = {
    logos: 0,
    'simple-icons': 1,
    'skill-icons': 2,
    devicon: 3,
  }

  let query = $state('')
  let results = $state<string[]>([])
  let searching = $state(false)
  // True when the last search failed (offline, API error) — distinct from a
  // genuine empty result so the user isn't told "no icons found" while offline.
  let searchFailed = $state(false)
  let searchInput = $state<HTMLInputElement | null>(null)

  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let activeController: AbortController | undefined

  // A drawer close mid-search must not leave a timer poised to fire or a fetch
  // in flight against a torn-down component.
  onDestroy(() => {
    clearTimeout(debounceTimer)
    activeController?.abort()
  })

  const hasQuery = $derived(query.trim().length >= 2)

  function selectIcon(icon: string) {
    onChange(icon)
    // Keep focus on the search box so the user can keep refining (see CLAUDE.md).
    searchInput?.focus()
  }

  function rank(name: string): number {
    return PREFIX_RANK[name.split(':')[0]] ?? 9
  }

  /** `logos:aws-s3` → `aws s3` for tooltips/aria. */
  function labelFor(name: string): string {
    return (name.split(':')[1] ?? name).replace(/-/g, ' ')
  }

  function runSearch(raw: string) {
    const q = raw.trim()
    activeController?.abort()
    if (q.length < 2) {
      results = []
      searching = false
      return
    }
    const controller = new AbortController()
    activeController = controller
    searching = true
    searchFailed = false
    fetch(
      `https://api.iconify.design/search?query=${encodeURIComponent(q)}&limit=${SEARCH_LIMIT}`,
      { signal: controller.signal },
    )
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { icons?: string[] }) => {
        if (controller.signal.aborted) return
        const icons = Array.isArray(data.icons) ? data.icons : []
        results = [...icons].sort((a, b) => rank(a) - rank(b))
        searching = false
      })
      .catch(() => {
        if (controller.signal.aborted) return
        results = []
        searching = false
        searchFailed = true
      })
  }

  function onQueryInput() {
    clearTimeout(debounceTimer)
    const q = query.trim()
    if (q.length < 2) {
      activeController?.abort()
      results = []
      searching = false
      return
    }
    // Show the loading state immediately so the grid never flashes "no results"
    // during the debounce window.
    searching = true
    const snapshot = query
    debounceTimer = setTimeout(() => runSearch(snapshot), DEBOUNCE_MS)
  }

  function clearQuery() {
    clearTimeout(debounceTimer)
    activeController?.abort()
    query = ''
    results = []
    searching = false
    searchInput?.focus()
  }

  function onQueryKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault()
      clearTimeout(debounceTimer)
      const trimmed = query.trim()
      if (results.length) selectIcon(results[0])
      else if (isIconifyName(trimmed)) selectIcon(trimmed)
      else runSearch(trimmed)
    } else if (e.key === 'Escape' && query) {
      e.stopPropagation()
      clearQuery()
    }
  }
</script>

<div class="icon-picker">
  <div class="icon-picker__search">
    <svg class="icon-picker__search-icon" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </svg>
    <Input
      bind:ref={searchInput}
      class="icon-picker__input"
      bind:value={query}
      oninput={onQueryInput}
      onkeydown={onQueryKeydown}
      placeholder="Search icons — try “S3” or “AWS”"
      aria-label="Search icons"
      spellcheck="false"
      autocomplete="off"
    />
    {#if query}
      <button
        type="button"
        class="icon-picker__clear"
        onclick={clearQuery}
        title="Clear search (Esc)"
        aria-label="Clear search"
      >
        <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    {/if}
  </div>

  {#if hasQuery}
    {#if results.length}
      <div class="icon-picker__grid" role="group" aria-label="Search results">
        {#each results as name (name)}
          {@const isSelected = value === name}
          <button
            type="button"
            class="icon-picker__item"
            class:icon-picker__item--selected={isSelected}
            title={labelFor(name)}
            aria-label={labelFor(name)}
            aria-pressed={isSelected}
            onclick={() => selectIcon(name)}
          >
            <Icon icon={name} width="14" height="14" />
          </button>
        {/each}
      </div>
    {:else if searching}
      <div class="icon-picker__status" role="status">Searching…</div>
    {:else if searchFailed}
      <div class="icon-picker__status icon-picker__status--error" role="status">
        Icon search unavailable — check your connection.
        <button type="button" class="icon-picker__retry" onclick={() => runSearch(query)}>
          Retry
        </button>
      </div>
    {:else}
      <div class="icon-picker__status">No icons found for “{query.trim()}”</div>
    {/if}
  {:else}
    <div class="icon-picker__grid" role="group" aria-label="Select icon">
      {#each CURATED_ICONS as item}
        {@const isSelected = value === item.icon}
        {@const iconifySrc = isIconifyName(item.icon) ? item.icon : null}
        {@const svgPath = ICON_SVG[item.icon] ?? null}
        <button
          type="button"
          class="icon-picker__item"
          class:icon-picker__item--selected={isSelected}
          title={item.label}
          aria-label={item.label}
          aria-pressed={isSelected}
          onclick={() => selectIcon(item.icon)}
        >
          {#if iconifySrc}
            <Icon icon={iconifySrc} width="14" height="14" />
          {:else if svgPath}
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              {@html svgPath}
            </svg>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .icon-picker {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .icon-picker__grid {
    display: grid;
    grid-template-columns: repeat(8, 1fr);
    gap: 0.1875rem;
    max-height: 11rem;
    overflow-y: auto;
  }

  .icon-picker__item {
    display: grid;
    place-items: center;
    width: 100%;
    aspect-ratio: 1;
    border-radius: 0.375rem;
    border: 0.0625rem solid transparent;
    background: transparent;
    color: var(--solus-text-secondary);
    cursor: pointer;
    padding: 0.1875rem;
    transition: background var(--duration-quick) var(--ease-premium), border-color var(--duration-quick) var(--ease-premium), color var(--duration-quick) var(--ease-premium);
  }

  .icon-picker__item:hover {
    background: var(--solus-surface-hover);
    color: var(--solus-accent);
    border-color: color-mix(in srgb, var(--solus-accent) 20%, transparent);
  }

  .icon-picker__item--selected {
    background: color-mix(in srgb, var(--solus-accent) 16%, transparent);
    border-color: color-mix(in srgb, var(--solus-accent) 40%, transparent);
    color: var(--solus-accent);
  }

  .icon-picker__item:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.0625rem;
  }

  .icon-picker__search {
    position: relative;
    display: flex;
    align-items: center;
  }

  .icon-picker__search-icon {
    position: absolute;
    left: 0.5rem;
    color: var(--solus-text-tertiary);
    pointer-events: none;
  }

  :global(.icon-picker__input) {
    flex: 1;
    min-width: 0;
    padding: 0.4375rem 1.75rem;
    border-radius: 0.5rem;
    border: 0.0625rem solid var(--solus-tool-border);
    background: var(--solus-surface-primary);
    color: var(--solus-text-primary);
    font-size: 0.75rem;
    font-family: inherit;
    outline: none;
    transition: border-color var(--duration-base) var(--ease-premium), box-shadow var(--duration-base) var(--ease-premium);
  }

  :global(.icon-picker__input:focus) {
    border-color: var(--solus-accent-border);
    box-shadow: 0 0 0 0.125rem var(--solus-accent-soft);
  }

  :global(.icon-picker__input::placeholder) {
    color: var(--solus-text-tertiary);
    opacity: 0.7;
  }

  .icon-picker__clear {
    position: absolute;
    right: 0.375rem;
    display: grid;
    place-items: center;
    width: 1.125rem;
    height: 1.125rem;
    border: none;
    border-radius: 0.3125rem;
    background: transparent;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    transition: color var(--duration-quick) var(--ease-premium), background var(--duration-quick) var(--ease-premium);
  }

  .icon-picker__clear:hover {
    color: var(--solus-text-secondary);
    background: var(--solus-surface-hover);
  }

  .icon-picker__clear:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.0625rem;
  }

  .icon-picker__status {
    padding: 0.75rem 0.25rem;
    text-align: center;
    font-size: 0.6875rem;
    color: var(--solus-text-tertiary);
  }

  .icon-picker__status--error {
    color: var(--solus-status-error);
  }

  .icon-picker__retry {
    margin-left: 0.25rem;
    border: none;
    background: transparent;
    padding: 0.0625rem 0.25rem;
    border-radius: 0.25rem;
    font-size: inherit;
    font-weight: 600;
    color: var(--solus-accent);
    cursor: pointer;
    transition: background var(--duration-quick) var(--ease-premium);
  }

  .icon-picker__retry:hover {
    background: var(--solus-surface-hover);
  }
</style>
