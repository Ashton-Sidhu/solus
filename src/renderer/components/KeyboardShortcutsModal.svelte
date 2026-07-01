<script lang="ts">
  import { XIcon, MagnifyingGlassIcon } from 'phosphor-svelte'
  import Kbd from './ui/Kbd.svelte'
  import { bindingsForScope } from '../lib/keybindings/manifest'
  import { defaultCombo, formatCombo } from '../lib/keybindings/match'
  import { getKeybindingsContext } from '../lib/keybindings/dispatcher.svelte'
  import { useScope, useKeybinding } from '../lib/keybindings/use-keybinding.svelte'
  import { requestInputFocus } from '../lib/inputFocus'
  import type { Scope } from '../lib/keybindings/types'

  interface Props {
    open: boolean
    activeScopes: Scope[]
  }

  let { open = $bindable(), activeScopes }: Props = $props()

  const kb = getKeybindingsContext()

  const SCOPE_META: Record<Scope, { label: string; order: number }> = {
    'global':            { label: 'Global',             order: 10 },
    'diff-panel':        { label: 'Diff Panel',         order: 20 },
    'file-editor':       { label: 'File Editor',        order: 25 },
    'files-pane':        { label: 'Files Pane',         order: 27 },
    'plan-modal':        { label: 'Plan Modal',         order: 30 },
    'document-modal':    { label: 'Document Modal',     order: 40 },
    'plan-gallery':      { label: 'Plan Gallery',       order: 50 },
    'folio-gallery':     { label: 'Folio Gallery',      order: 60 },
    'automations':       { label: 'Automations',        order: 65 },
    'tasks':             { label: 'Tasks',              order: 66 },
    'prs':               { label: 'Pull Requests',     order: 67 },
    'design-annotation': { label: 'Design Annotation',  order: 70 },
    'plan-action-bar':   { label: 'Plan Review',        order: 80 },
    'attachment-preview':{ label: 'Attachment Preview', order: 90 },
    'diagram':           { label: 'Diagram',            order: 95 },
    'command-palette':   { label: 'Command Palette',    order: 98 },
    'shortcuts-help':    { label: 'Shortcuts Help',     order: 100 },
  }

  const ALL_SCOPES: Scope[] = [
    'global', 'diff-panel', 'file-editor', 'files-pane',
    'plan-modal', 'document-modal', 'plan-gallery', 'folio-gallery',
    'design-annotation', 'plan-action-bar', 'attachment-preview', 'diagram',
  ]

  let query = $state('')
  let searchEl: HTMLInputElement | null = $state(null)

  useScope('shortcuts-help', { exclusive: true, active: () => open })
  useKeybinding('shortcuts-help.close', () => { close() })

  function close() {
    open = false
    requestInputFocus()
  }

  function groupBindings(scope: Scope): Array<{ title: string; items: Array<[string, string[]]> }> {
    const entries = bindingsForScope(scope)
    const map = new Map<string, Array<[string, string[]]>>()
    for (const [id, def] of entries) {
      const combo = kb.overrides[id] ?? defaultCombo(def)
      const keys = formatCombo(combo)
      let arr = map.get(def.group)
      if (!arr) { arr = []; map.set(def.group, arr) }
      arr.push([def.label, keys])
    }
    return Array.from(map.entries()).map(([title, items]) => ({ title, items }))
  }

  const orderedScopes = $derived.by(() => {
    const active = new Set(activeScopes)
    const inactive = ALL_SCOPES
      .filter(s => !active.has(s))
      .sort((a, b) => SCOPE_META[a].order - SCOPE_META[b].order)
    return { active: activeScopes, inactive }
  })

  function filterGroups(
    groups: Array<{ title: string; items: Array<[string, string[]]> }>,
    scopeLabel: string,
    q: string,
  ): Array<{ title: string; items: Array<[string, string[]]> }> {
    if (!q) return groups
    const lower = q.toLowerCase()
    if (scopeLabel.toLowerCase().includes(lower)) return groups
    return groups
      .map(g => ({
        title: g.title,
        items: g.items.filter(
          ([label, keys]) =>
            label.toLowerCase().includes(lower) ||
            g.title.toLowerCase().includes(lower) ||
            keys.join('').toLowerCase().includes(lower),
        ),
      }))
      .filter(g => g.items.length > 0)
  }

  const scopeSections = $derived.by(() => {
    const q = query.trim()
    const result: Array<{ scope: Scope; groups: Array<{ title: string; items: Array<[string, string[]]> }>; active: boolean }> = []

    for (const scope of orderedScopes.active) {
      const groups = filterGroups(groupBindings(scope), SCOPE_META[scope].label, q)
      if (groups.length > 0) result.push({ scope, groups, active: true })
    }
    for (const scope of orderedScopes.inactive) {
      const groups = filterGroups(groupBindings(scope), SCOPE_META[scope].label, q)
      if (groups.length > 0) result.push({ scope, groups, active: false })
    }
    return result
  })

  const hasResults = $derived(scopeSections.length > 0)
  const totalCount = $derived(
    scopeSections.reduce(
      (n, s) => n + s.groups.reduce((m, g) => m + g.items.length, 0),
      0,
    ),
  )

  $effect(() => {
    if (open) {
      query = ''
      // Autofocus search after next microtask so the scope is established
      Promise.resolve().then(() => searchEl?.focus())
    }
  })
</script>

{#if open}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    data-solus-ui
    class="shortcuts-backdrop"
    role="presentation"
    onclick={(e) => { if (e.target === e.currentTarget) close() }}
  >
    <div
      class="shortcuts-modal"
      role="dialog"
      aria-label="Keyboard shortcuts"
      aria-modal="true"
    >
      <!-- Header -->
      <div class="shortcuts-header">
        <MagnifyingGlassIcon size={14} class="flex-shrink-0 text-(--solus-text-tertiary)" />
        <input
          bind:this={searchEl}
          bind:value={query}
          type="search"
          name="shortcuts-search"
          aria-label="Search shortcuts"
          placeholder="Search shortcuts…"
          class="shortcuts-search"
          autocomplete="off"
          spellcheck="false"
        />
        <button
          type="button"
          onclick={close}
          aria-label="Close"
          class="shortcuts-close-btn"
        >
          <XIcon size={14} />
        </button>
      </div>

      <!-- Body -->
      <div class="shortcuts-body" style="scrollbar-width:thin">
        {#if !hasResults}
          <div class="shortcuts-empty">
            <MagnifyingGlassIcon size={18} weight="light" class="text-(--solus-text-tertiary)" />
            <span>No shortcuts match “{query.trim()}”</span>
          </div>
        {:else}
          {#each scopeSections as section, i}
            {#if !section.active && i > 0 && scopeSections[i - 1].active}
              <div class="shortcuts-divider"></div>
            {/if}
            <div class="shortcuts-scope" class:is-inactive={!section.active}>
              <div class="shortcuts-scope-header">
                <span class="shortcuts-scope-label">{SCOPE_META[section.scope].label}</span>
                {#if section.active}
                  <span class="shortcuts-active-dot">Active</span>
                {/if}
              </div>
              {#each section.groups as group}
                <div class="shortcuts-group">
                  <div class="shortcuts-group-title">{group.title}</div>
                  {#each group.items as [label, keys]}
                    <div class="shortcuts-row">
                      <span class="shortcuts-row-label">{label}</span>
                      <span class="shortcuts-row-keys">
                        {#each keys as k}
                          <Kbd variant="standalone" class={k === '⇧' ? 'kbd-shift' : ''}>{k}</Kbd>
                        {/each}
                      </span>
                    </div>
                  {/each}
                </div>
              {/each}
            </div>
          {/each}
        {/if}
      </div>

      <!-- Footer -->
      <div class="shortcuts-footer">
        <span class="shortcuts-count">
          {#if hasResults}
            {totalCount} shortcut{totalCount === 1 ? '' : 's'}
          {:else}
            No matches
          {/if}
        </span>
        <span class="shortcuts-footer-hint">
          <Kbd variant="hint">esc</Kbd>
          to close
        </span>
      </div>
    </div>
  </div>
{/if}

<style>
  .shortcuts-backdrop {
    position: fixed;
    inset: 0;
    z-index: 10020;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: auto;
    background: rgba(0, 0, 0, 0.04);
    animation: shortcuts-backdrop-in 180ms ease both;
  }

  :global(.dark) .shortcuts-backdrop {
    background: rgba(0, 0, 0, 0.28);
  }

  @keyframes shortcuts-backdrop-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .shortcuts-modal {
    width: clamp(20rem, 72vw, 38rem);
    max-width: calc(100vw - 3rem);
    max-height: 55vh;
    outline: none;
    display: flex;
    flex-direction: column;
    border-radius: 1.125rem;
    border: 0.0625rem solid var(--solus-popover-border);
    background:
      linear-gradient(var(--solus-popover-bg), var(--solus-popover-bg)),
      var(--solus-popover-bg);
    box-shadow:
      var(--solus-popover-shadow),
      inset 0 0.0625rem 0 rgba(255, 255, 255, 0.14);
    overflow: hidden;
    animation: shortcuts-enter 180ms cubic-bezier(0.22, 1, 0.36, 1) both;
    transform-origin: center top;
  }

  :global(.dark) .shortcuts-modal {
    box-shadow:
      var(--solus-popover-shadow),
      inset 0 0.0625rem 0 rgba(255, 255, 255, 0.06);
  }

  @keyframes shortcuts-enter {
    from {
      opacity: 0;
      transform: translate3d(0, 0.25rem, 0) scale(0.985);
    }
    to {
      opacity: 1;
      transform: translate3d(0, 0, 0) scale(1);
    }
  }

  .shortcuts-header {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0 1.125rem;
    height: 3rem;
    flex-shrink: 0;
    position: relative;
  }

  .shortcuts-header::after {
    content: "";
    position: absolute;
    left: 1.125rem;
    right: 1.125rem;
    bottom: 0;
    height: 0.0625rem;
    background: var(--solus-popover-border);
    opacity: 0.35;
  }

  .shortcuts-search {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    font-size: 0.8125rem;
    letter-spacing: -0.005em;
    color: var(--solus-text-primary);
    caret-color: var(--solus-accent);
  }

  .shortcuts-search::placeholder {
    color: var(--solus-text-tertiary);
  }

  .shortcuts-search::-webkit-search-cancel-button {
    display: none;
  }

  .shortcuts-close-btn {
    position: relative;
    width: 1.5rem;
    height: 1.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 0.375rem;
    border: none;
    background: transparent;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.1s ease, color 0.1s ease;
  }

  @media (pointer: coarse) {
    .shortcuts-close-btn::before {
      content: "";
      position: absolute;
      top: 50%;
      left: 50%;
      width: max(100%, 3rem);
      height: max(100%, 3rem);
      transform: translate(-50%, -50%);
    }
  }

  @media (min-width: 768px) and (max-width: 1100px) {
    .shortcuts-modal {
      width: min(42rem, calc(100vw - 2rem));
      max-height: 70vh;
    }
  }

  .shortcuts-close-btn:hover {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }

  .shortcuts-body {
    flex: 1;
    overflow-y: auto;
    padding: 0 0.375rem 0.5rem;
    overscroll-behavior-y: contain;
  }

  .shortcuts-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.625rem;
    padding: 2.75rem 1.5rem;
    text-align: center;
    font-size: 0.75rem;
    color: var(--solus-text-tertiary);
  }

  .shortcuts-divider {
    margin: 0.375rem 1.125rem;
    border-top: 0.0625rem solid var(--solus-popover-border);
    opacity: 0.4;
  }

  .shortcuts-scope {
    padding: 0 0 0.5rem;
  }

  .shortcuts-scope.is-inactive {
    opacity: 0.62;
  }

  .shortcuts-scope-header {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.9375rem 0.625rem 0.4375rem 1.125rem;
    background:
      linear-gradient(var(--solus-popover-bg), var(--solus-popover-bg)),
      var(--solus-popover-bg);
  }

  .shortcuts-scope-header::after {
    content: "";
    position: absolute;
    left: 1.125rem;
    right: 1.125rem;
    bottom: 0.1875rem;
    height: 0.0625rem;
    background: var(--solus-popover-border);
    opacity: 0.5;
  }

  .shortcuts-scope-label {
    font-size: 0.75rem;
    font-weight: 650;
    letter-spacing: -0.005em;
    color: var(--solus-text-primary);
    user-select: none;
    pointer-events: none;
  }

  .shortcuts-active-dot {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--solus-accent);
  }

  .shortcuts-active-dot::before {
    content: "";
    width: 0.3125rem;
    height: 0.3125rem;
    border-radius: 50%;
    background: var(--solus-accent);
    box-shadow: 0 0 0 0.1875rem color-mix(in srgb, var(--solus-accent) 18%, transparent);
  }

  .shortcuts-group {
    padding: 0;
    margin-top: 0.875rem;
  }

  .shortcuts-scope-header + .shortcuts-group {
    margin-top: 0.25rem;
  }

  .shortcuts-group-title {
    padding: 0.1875rem 1.125rem 0.3125rem;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--solus-text-secondary);
    user-select: none;
    pointer-events: none;
  }

  .shortcuts-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.1875rem 1.125rem;
    border-radius: 0.375rem;
    transition: background 100ms;
  }

  .shortcuts-row:hover {
    background: var(--solus-surface-hover);
  }

  .shortcuts-row-label {
    font-size: 0.6875rem;
    color: var(--solus-text-secondary);
  }

  .shortcuts-row-keys {
    display: flex;
    align-items: center;
    gap: 0.1875rem;
    flex-shrink: 0;
  }

  .shortcuts-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0 1.125rem;
    height: 2.25rem;
    flex-shrink: 0;
    position: relative;
    font-size: 0.75rem;
    color: var(--solus-text-tertiary);
  }

  .shortcuts-footer::before {
    content: "";
    position: absolute;
    left: 1.125rem;
    right: 1.125rem;
    top: 0;
    height: 0.0625rem;
    background: var(--solus-popover-border);
    opacity: 0.35;
  }

  .shortcuts-count {
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.01em;
  }

  .shortcuts-footer-hint {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
  }
</style>
