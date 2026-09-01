<script lang="ts">
  import { untrack } from 'svelte'
  import { X as XIcon, Search as MagnifyingGlassIcon } from "@lucide/svelte";
  import Kbd from './ui/Kbd.svelte'
  import { Input } from './ui/input'
  import { bindingsForScope, type BindingId } from '../lib/keybindings/manifest'
  import { formatCombo } from '../lib/keybindings/match'
  import {
    ALL_LISTED_SCOPES,
    KEYBINDING_CATEGORIES,
    conflictLabels,
    effectiveCombo,
    groupsForScope,
    isOverridden,
    matchesQuery,
    scopeLabel,
    withBinding,
  } from '../lib/keybindings/editing'
  import { bindingCapture } from '../lib/keybindings/capture.svelte'
  import { useScope, useKeybinding } from '../lib/keybindings/use-keybinding.svelte'
  import { requestInputFocus } from '../lib/inputFocus'
  import { getSettingsContext } from '../contexts'
  import type { BindingDef, Scope } from '../lib/keybindings/types'

  interface Props {
    open: boolean
    activeScopes: Scope[]
  }

  let { open = $bindable(), activeScopes }: Props = $props()

  // The overlay reads and writes the same binding store the settings editor
  // does — a rebind here is the same edit as a rebind there.
  const settings = getSettingsContext()

  // Counts are real: the pill reports every row its category contains, never
  // the filtered subset. The manifest is static, so this is computed once.
  const CATEGORY_PILLS = KEYBINDING_CATEGORIES.map((category) => ({
    ...category,
    count: category.scopes.reduce((n, scope) => n + bindingsForScope(scope).length, 0),
  }))

  let query = $state('')
  let searchEl: HTMLInputElement | null = $state(null)
  let selectedCategory = $state(KEYBINDING_CATEGORIES[0].key)

  useScope('shortcuts-help', { exclusive: true, active: () => open })
  useKeybinding('shortcuts-help.close', () => { close() })

  function close() {
    bindingCapture.cancel()
    open = false
    requestInputFocus()
  }

  const conflicts = $derived(conflictLabels(settings.keybindings))

  // Search spans every category: a shortcut the user cannot name the home of is
  // exactly the one they open this overlay to find. Without a query the
  // selected pill decides, and a merged category splits by scope.
  const sections = $derived.by(() => {
    const q = query.trim()
    const overrides = settings.keybindings
    if (q) {
      return ALL_LISTED_SCOPES
        .map((scope) => ({
          key: scope as string,
          label: scopeLabel(scope),
          rows: bindingsForScope(scope)
            .map(([id, def]) => ({ id, def }))
            .filter(({ id, def }) => matchesQuery(def, effectiveCombo(id, overrides), q)),
        }))
        .filter((section) => section.rows.length > 0)
    }
    const category = KEYBINDING_CATEGORIES.find((c) => c.key === selectedCategory) ?? KEYBINDING_CATEGORIES[0]
    if (category.scopes.length > 1) {
      return category.scopes
        .map((scope) => ({
          key: scope as string,
          label: scopeLabel(scope),
          rows: bindingsForScope(scope).map(([id, def]) => ({ id, def })),
        }))
        .filter((section) => section.rows.length > 0)
    }
    return groupsForScope(category.scopes[0]).map((g) => ({ key: g.group, label: g.group, rows: g.rows }))
  })

  const hasResults = $derived(sections.length > 0)
  const totalCount = $derived(sections.reduce((n, section) => n + section.rows.length, 0))

  /** The category a live scope belongs to, so opening the overlay lands on the
   *  shortcuts of whatever surface the user is already in. */
  function categoryForActiveScopes(scopes: Scope[]): string {
    for (const scope of scopes) {
      const category = KEYBINDING_CATEGORIES.find((c) => c.scopes.includes(scope))
      if (category) return category.key
    }
    return KEYBINDING_CATEGORIES[0].key
  }

  function selectCategory(key: string): void {
    // Scope is a filter, never a mode: it cancels an in-flight capture and
    // clears the query the pill would otherwise be hidden behind.
    bindingCapture.cancel()
    selectedCategory = key
    query = ''
    searchEl?.focus()
  }

  function rebind(id: BindingId): void {
    if (bindingCapture.id === id) {
      bindingCapture.cancel()
      return
    }
    bindingCapture.start(id, (combo) => {
      settings.update({ keybindings: withBinding(id, combo, settings.keybindings) })
    })
  }

  $effect(() => {
    if (open) {
      query = ''
      // `untrack`: the opening scopes seed the selection once. Reading them
      // reactively would reset the user's pill mid-session if a surface behind
      // the overlay pushed or popped a scope.
      selectedCategory = categoryForActiveScopes(untrack(() => activeScopes))
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
    class="shortcuts-backdrop fixed inset-0 z-[10020] flex items-center justify-center bg-black/5 dark:bg-black/30"
    role="presentation"
    onclick={(e) => { if (e.target === e.currentTarget) close() }}
  >
    <div
      class="shortcuts-modal flex max-h-[70vh] w-[41.25rem] max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-[1.125rem] border border-(--solus-popover-border) bg-(--solus-popover-bg) text-chrome-dense"
      role="dialog"
      aria-label="Keyboard shortcuts"
      aria-modal="true"
    >
      <!-- Header -->
      <div class="flex shrink-0 items-center gap-2.5 px-4 pt-3.5 pb-3">
        <MagnifyingGlassIcon size={15} class="shrink-0 text-(--solus-text-tertiary)" />
        <Input
          bind:ref={searchEl}
          bind:value={query}
          type="text"
          name="shortcuts-search"
          aria-label="Search shortcuts"
          placeholder="Search shortcuts…"
          class="shortcuts-search h-auto min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 shadow-none caret-(--solus-accent) focus-visible:ring-0 dark:bg-transparent"
          autocomplete="off"
          spellcheck="false"
        />
        <button
          type="button"
          onclick={close}
          aria-label="Close"
          class="flex size-6 shrink-0 items-center justify-center rounded-md text-(--solus-text-tertiary) transition-colors [@media(hover:hover)]:hover:bg-(--solus-surface-hover) [@media(hover:hover)]:hover:text-(--solus-text-primary)"
        >
          <XIcon size={12} />
        </button>
      </div>

      <!-- Scope pills -->
      <div class="flex shrink-0 flex-wrap items-center gap-1.5 px-4 pb-3">
        {#each CATEGORY_PILLS as category (category.key)}
          {@const active = !query.trim() && selectedCategory === category.key}
          <button
            type="button"
            class="shortcuts-scope-pill flex h-6 shrink-0 items-center gap-2 overflow-hidden rounded-full px-2.5 font-medium tracking-[-0.005em] transition-colors
 {active
 ? 'bg-[color-mix(in_oklch,var(--primary)_13%,transparent)] text-[color:color-mix(in_oklch,var(--primary)_82%,var(--foreground))] shadow-[shadow:0_0_0_0.03125rem_color-mix(in_oklch,var(--primary)_32%,transparent)]'
 : 'text-muted-foreground shadow-[shadow:0_0_0_0.03125rem_color-mix(in_oklch,var(--foreground)_10%,transparent)] [@media(hover:hover)]:hover:text-(--solus-text-primary)'}"
            aria-pressed={active}
            onclick={() => selectCategory(category.key)}
          >
            <span class="truncate">{category.label}</span>
            <span class="shrink-0 font-mono text-micro tabular-nums opacity-55">{category.count}</span>
          </button>
        {/each}
      </div>

      <!-- Body -->
      <div class="flex-1 overflow-y-auto overscroll-y-contain border-t border-[color-mix(in_oklch,var(--foreground)_8%,transparent)] px-2 pt-1 pb-2.5">
        {#if !hasResults}
          <div class="px-3 pt-8 pb-7 text-center text-(--solus-text-tertiary)">
            No shortcut matches “{query.trim()}”
          </div>
        {:else}
          {#each sections as section (section.key)}
            <div class="menu-heading flex items-center gap-3">
              <!-- The group label has to stay a step under the rows it heads.
                   `menu-heading` sizes itself against a 14px menu row; this
                   surface took the dense rung, which closed that gap. -->
              <span class="shortcuts-scope-label shrink-0 text-micro tracking-[0.12em]">{section.label}</span>
              <span class="h-px flex-1 bg-(--hairline)"></span>
            </div>
            {#each section.rows as { id, def } (id)}
              {@render shortcutRow(id, def)}
            {/each}
          {/each}
        {/if}
      </div>

      <!-- Footer -->
      <div class="flex shrink-0 items-center gap-5 border-t border-[color-mix(in_oklch,var(--foreground)_8%,transparent)] bg-(--wash-1) px-4 py-2.5 text-muted-foreground">
        <span class="shortcuts-count font-mono tabular-nums">
          {#if hasResults}
            {totalCount} shortcut{totalCount === 1 ? '' : 's'}
          {:else}
            No matches
          {/if}
        </span>
        <span class="flex-1"></span>
        <span class="inline-flex items-center gap-1.5">
          <Kbd variant="keycap">↵</Kbd>
          rebind
        </span>
        <span class="inline-flex items-center gap-1.5">
          <Kbd variant="keycap">esc</Kbd>
          to close
        </span>
      </div>
    </div>
  </div>
{/if}

<!-- One row of the shared shortcut vocabulary: label, status in words, keycaps.
     The whole row is the rebind control, so ↵ on the focused row starts a
     capture without a separate affordance. -->
{#snippet shortcutRow(id: BindingId, def: BindingDef)}
  {@const combo = effectiveCombo(id, settings.keybindings)}
  {@const capturing = bindingCapture.id === id}
  {@const conflict = conflicts.get(id)}
  <button
    type="button"
    class="shortcuts-row flex h-9 w-full items-center gap-4 overflow-hidden rounded-[0.625rem] px-2.5 text-left transition-colors [@media(hover:hover)]:hover:shadow-[shadow:inset_0_0_0_999px_var(--wash-2)]
 {capturing ? 'bg-[color-mix(in_oklch,var(--primary)_8%,transparent)]' : ''}"
    aria-label={combo ? `Rebind ${def.label}` : `Assign a shortcut to ${def.label}`}
    onclick={() => rebind(id)}
  >
    <span class="shortcuts-row-label min-w-0 flex-1 truncate font-medium tracking-[-0.005em] text-(--solus-text-primary)">{def.label}</span>
    {#if conflict}
      <span class="min-w-0 truncate text-[color:color-mix(in_oklch,var(--destructive)_62%,var(--foreground))]">conflicts with {conflict}</span>
    {/if}
    {#if !capturing && isOverridden(id, settings.keybindings)}
      <span class="shrink-0 text-micro font-medium text-[color:color-mix(in_oklch,var(--primary)_82%,var(--foreground))]">changed</span>
    {/if}
    <span class="shortcuts-row-keys flex shrink-0 items-center gap-1">
      {#if capturing}
        <span class="flex items-center gap-2 rounded-[0.625rem] bg-[color-mix(in_oklch,var(--primary)_13%,transparent)] px-2.5 py-1 shadow-[shadow:0_0_0_0.03125rem_color-mix(in_oklch,var(--primary)_45%,transparent)]">
          <span class="font-mono text-micro font-medium tracking-[0.04em] text-[color:color-mix(in_oklch,var(--primary)_82%,var(--foreground))]">{bindingCapture.pendingText}</span>
          <span class="kb-caret h-[0.6875rem] w-px bg-(--solus-accent)"></span>
        </span>
      {:else if combo}
        {#each formatCombo(combo) as k}
          <Kbd variant="keycap">{k}</Kbd>
        {/each}
      {:else}
        <span class="text-muted-foreground">Unassigned</span>
      {/if}
    </span>
  </button>
{/snippet}

<style>
  .shortcuts-backdrop {
    animation: shortcuts-backdrop-in 180ms ease both;
  }

  @keyframes shortcuts-backdrop-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .shortcuts-modal {
    box-shadow:
      var(--solus-popover-shadow),
      inset 0 0.0625rem 0 rgba(255, 255, 255, 0.14);
    /* `backwards`, not `both`: a retained end transform keeps the whole list on
       its own compositing layer and blurs its text. */
    animation: shortcuts-enter 180ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
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

  /* The capture caret is the only signal that the row is listening; it stops as
     soon as the combo commits or Escape cancels. */
  .kb-caret {
    animation: kb-caret-blink 1.1s step-end infinite;
  }

  @keyframes kb-caret-blink {
    50% { opacity: 0; }
  }

  @media (prefers-reduced-motion: reduce) {
    .shortcuts-backdrop,
    .shortcuts-modal,
    .kb-caret {
      animation: none;
    }
  }

  :global(.shortcuts-search::placeholder) {
    color: var(--solus-text-tertiary);
  }

  :global(.shortcuts-search::-webkit-search-cancel-button) {
    display: none;
  }

  @media (min-width: 768px) and (max-width: 1100px) {
    .shortcuts-modal {
      width: min(42rem, calc(100vw - 2rem));
    }
  }
</style>
