<script lang="ts">
  import { tick, untrack } from 'svelte'
  import { MagnifyingGlassIcon, CaretRightIcon, CaretLeftIcon } from 'phosphor-svelte'
  import Kbd from '../ui/Kbd.svelte'
  import { menuRowVariants } from '../ui/menu/menu-row'
  import { useScope, useKeybinding } from '../../lib/keybindings/use-keybinding.svelte'
  import { comboHint } from '../../lib/keybindings/manifest'
  import { requestInputFocus } from '../../lib/inputFocus'
  import { track } from '../../lib/analytics'
  import { sanitizeCommandId } from '../../../shared/analytics-events'
  import { cn } from '../../lib/utils'
  import {
    filterCommands,
    groupCommands,
    moveCommandSelection,
    retainCommandSelection,
    type Command,
    type CommandSelectionMove,
  } from './lib/commands'

  interface Props {
    open: boolean
    commands: Command[]
    /**
     * When set, the palette opens drilled straight into this sub-page instead of
     * the root list. Consumed (and cleared) the moment the palette opens.
     */
    initialPage?: { id: string; title: string } | null
  }

  let { open = $bindable(), commands, initialPage = $bindable(null) }: Props = $props()

  let query = $state('')
  let selectedValue = $state('')
  let searchEl: HTMLInputElement | null = $state(null)
  let commandRootEl: HTMLDivElement | null = $state(null)
  let previousQuery = ''
  let previousPageId: string | null = null
  // When set, we're drilled into a parent command's children sub-page. We hold
  // the parent's id (not a snapshot of its children) so the sub-page re-derives
  // its list from the live `commands` prop — children that load in the
  // background after drilling in show up without re-entering the page.
  let page = $state<{ id: string; title: string } | null>(null)

  const activeCommands = $derived.by(() => {
    if (!page) return commands
    return commands.find((c) => c.id === page!.id)?.children ?? []
  })
  const filtered = $derived(filterCommands(activeCommands, query))
  const groups = $derived(groupCommands(filtered))
  const ordered = $derived(groups.flatMap((group) => group.items))
  const orderedCommandIds = $derived(ordered.map((command) => command.id).join('\u0000'))
  const hasResults = $derived(filtered.length > 0)

  useScope('command-palette', { exclusive: true, active: () => open })
  useKeybinding('command-palette.close', () => close())

  function keyboardMove(e: KeyboardEvent): CommandSelectionMove | null {
    if (e.key === 'Home') return 'first'
    if (e.key === 'End') return 'last'

    const isNext =
      e.key === 'ArrowDown' ||
      (e.ctrlKey && ['n', 'j'].includes(e.key.toLowerCase()))
    if (isNext) {
      if (e.metaKey) return 'last'
      if (e.altKey) return 'next-group'
      return 'next'
    }

    const isPrevious =
      e.key === 'ArrowUp' ||
      (e.ctrlKey && ['p', 'k'].includes(e.key.toLowerCase()))
    if (isPrevious) {
      if (e.metaKey) return 'first'
      if (e.altKey) return 'previous-group'
      return 'previous'
    }

    return null
  }

  function onPaletteKeydown(e: KeyboardEvent) {
    const move = keyboardMove(e)
    if (move) {
      e.preventDefault()
      selectedValue = moveCommandSelection(ordered, selectedValue, move, true)
      void tick().then(() => scrollCommandIntoView(selectedValue))
      return
    }

    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return
    const selectedCommand = ordered.find((command) => command.id === selectedValue)
    if (!selectedCommand) return
    e.preventDefault()
    run(selectedCommand)
  }

  function scrollCommandIntoView(commandId: string) {
    const items = commandRootEl?.querySelectorAll<HTMLElement>('[data-command-item]')
    if (!items) return
    for (const item of items) {
      if (item.dataset.value !== commandId) continue
      item.scrollIntoView({ block: 'nearest' })
      return
    }
  }

  function run(cmd: Command) {
    if (cmd.children) {
      enterPage(cmd.id, cmd.label)
      return
    }
    open = false
    page = null
    query = ''
    track('palette_command_run', { command_id: sanitizeCommandId(cmd.id) })
    cmd.run?.()
  }

  function enterPage(id: string, title: string) {
    page = { id, title }
    query = ''
    selectedValue = commands.find((command) => command.id === id)?.children?.[0]?.id ?? ''
    Promise.resolve().then(() => searchEl?.focus())
  }

  function back() {
    page = null
    query = ''
    selectedValue = commands[0]?.id ?? ''
    Promise.resolve().then(() => searchEl?.focus())
  }

  // Esc / the close keybinding steps out of a sub-page first, then dismisses.
  function close() {
    if (page) {
      back()
      return
    }
    open = false
    requestInputFocus()
  }

  // Backspace on an empty query also steps back out of a sub-page.
  function onSearchKeydown(e: KeyboardEvent) {
    if (e.key === 'Backspace' && query === '' && page) {
      e.preventDefault()
      back()
    }
  }

  // Reset query + selection each time the palette opens, honoring an `initialPage`
  // so callers can open straight into a sub-page; autofocus the search after the
  // scope is established (next microtask). Reads of initialPage are untracked so
  // clearing it here doesn't re-run this effect and wipe the page back to root.
  $effect.pre(() => {
    if (open) {
      query = ''
      untrack(() => {
        page = initialPage
        const initialCommands = page
          ? commands.find((command) => command.id === page!.id)?.children ?? []
          : commands
        selectedValue = initialCommands[0]?.id ?? ''
        if (initialPage) initialPage = null
      })
      Promise.resolve().then(() => searchEl?.focus())
    }
  })

  $effect(() => {
    if (!open) return
    void orderedCommandIds
    const pageId = page?.id ?? null
    const contextChanged = query !== previousQuery || pageId !== previousPageId
    previousQuery = query
    previousPageId = pageId

    const selectionBeforeListChange = untrack(() => selectedValue)
    const retainedSelection = retainCommandSelection(ordered, selectionBeforeListChange)
    if (contextChanged || retainedSelection !== selectionBeforeListChange) {
      selectedValue = ordered[0]?.id ?? ''
    }
  })

</script>

{#snippet commandContent(cmd: Command)}
  {#if cmd.icon}
    {@const Icon = cmd.icon}
    <span
      class="inline-flex size-[1.625rem] flex-shrink-0 items-center justify-center rounded-lg bg-(--solus-surface-hover) text-(--solus-text-tertiary) transition-colors duration-100 group-data-[selected]/command-item:bg-(--solus-accent-soft) group-data-[selected]/command-item:text-(--solus-accent)"
    >
      <Icon size={14} weight="regular" />
    </span>
  {:else}
    <span class="size-[1.625rem] flex-shrink-0"></span>
  {/if}
  <span class="min-w-0 flex-1 truncate text-[length:calc(0.90625rem*var(--solus-font-scale,1))] tracking-[-0.01em]">{cmd.label}</span>
  {#if cmd.hint}
    <Kbd variant="keycap" class="flex-shrink-0">{cmd.hint}</Kbd>
  {/if}
  {#if cmd.children}
    <CaretRightIcon
      size={14}
      weight="bold"
      class="flex-shrink-0 text-(--solus-text-tertiary) opacity-50 group-data-[selected]/command-item:opacity-70"
    />
  {/if}
{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  data-solus-ui
  class="fixed inset-0 z-[10020] flex items-start justify-center pt-[12vh] pointer-events-auto bg-[color-mix(in_srgb,var(--solus-modal-scrim)_55%,transparent)] motion-safe:animate-[backdrop-fade_140ms_ease-out]"
  class:hidden={!open}
  aria-hidden={!open}
  inert={!open}
  role="presentation"
  onclick={(e) => { if (e.target === e.currentTarget) close() }}
>
  <div
    class="w-[clamp(22rem,56vw,38.75rem)] max-w-[calc(100vw-3rem)] max-h-[60vh] outline-none flex flex-col rounded-2xl border-[0.0625rem] border-(--solus-popover-border) bg-(--solus-popover-bg) shadow-[shadow:var(--solus-popover-shadow),inset_0_0.0625rem_0_rgba(255,255,255,0.14),0_1.75rem_3.125rem_-1.125rem_rgba(0,0,0,0.24),0_4.375rem_8.125rem_-3.125rem_rgba(0,0,0,0.34)] [.dark_&]:shadow-[shadow:var(--solus-popover-shadow),inset_0_0.0625rem_0_rgba(255,255,255,0.06),0_1.75rem_3.125rem_-1.125rem_rgba(0,0,0,0.45),0_4.375rem_8.125rem_-3.125rem_rgba(0,0,0,0.55)] overflow-hidden origin-top"
    class:command-palette-enter={open}
    role="dialog"
    aria-label="Command palette"
    aria-modal="true"
  >
    <div
      bind:this={commandRootEl}
      class="flex h-auto w-full flex-col overflow-hidden"
      role="application"
      aria-label="Command palette"
      onkeydown={onPaletteKeydown}
    >
      <!-- Search -->
      <div
        class="flex items-center gap-3 px-5 h-[3.3125rem] flex-shrink-0 border-b border-(--solus-menu-hairline)"
      >
        {#if page}
          <button
            type="button"
            class="inline-flex items-center justify-center size-[1.375rem] flex-shrink-0 border-none rounded-lg bg-(--solus-surface-hover) font-secondary text-(--solus-text-secondary) cursor-pointer transition-colors duration-100 hover:text-(--solus-text-primary)"
            aria-label="Back"
            onclick={back}
          >
            <CaretLeftIcon size={14} weight="bold" />
          </button>
          <span class="flex-shrink-0 text-[length:calc(0.96875rem*var(--solus-font-scale,1))] font-semibold tracking-[-0.012em] text-(--solus-text-primary)">{page.title}</span>
        {:else}
          <MagnifyingGlassIcon size={14} class="flex-shrink-0 text-(--solus-text-tertiary) opacity-65" />
        {/if}
        <input
          bind:this={searchEl}
          bind:value={query}
          onkeydown={onSearchKeydown}
          type="search"
          name="command-palette-search"
          aria-label={page ? `Search ${page.title}` : 'Search commands'}
          aria-controls="command-palette-results"
          aria-expanded="true"
          aria-activedescendant={selectedValue ? `command-palette-option-${selectedValue}` : undefined}
          role="combobox"
          placeholder={page ? `Search ${page.title.toLowerCase()}…` : 'Type a command or search…'}
          class="flex-1 min-w-0 h-auto bg-transparent border-none outline-none text-[length:calc(0.96875rem*var(--solus-font-scale,1))] tracking-[-0.012em] text-(--solus-text-primary) caret-(--solus-accent) placeholder:text-(--solus-text-tertiary) [&::-webkit-search-cancel-button]:hidden"
          autocomplete="off"
          spellcheck="false"
        />
        {#if !page}
          <Kbd variant="keycap" class="flex-shrink-0">{comboHint('global.command-palette')}</Kbd>
        {/if}
      </div>

      <!-- Results -->
      <div
        id="command-palette-results"
        role="listbox"
        aria-label={page ? page.title : 'Commands'}
        class="flex-1 max-h-[26rem] overflow-hidden"
      >
        <div
          class="max-h-[26rem] overflow-x-hidden overflow-y-auto overscroll-y-contain p-2"
        >
          {#if !hasResults}
            <div role="status" class="flex flex-col items-center justify-center gap-2.5 py-11 px-6 text-center text-[length:calc(0.8125rem*var(--solus-font-scale,1))] text-(--solus-text-tertiary)">
              <MagnifyingGlassIcon size={14} weight="light" class="text-(--solus-text-tertiary)" />
              <span>
                {#if activeCommands.length === 0}
                  {page ? "Nothing here yet" : "No commands available yet"}
                {:else}
                  No commands match “{query.trim()}”
                {/if}
              </span>
            </div>
          {:else}
            {#each groups as group, groupIndex (group.title)}
              <div
                role="group"
                aria-labelledby={`command-palette-group-${groupIndex}`}
                class="overflow-hidden p-0 text-(--solus-text-primary) [&_[data-command-group-heading]]:flex [&_[data-command-group-heading]]:items-center [&_[data-command-group-heading]]:gap-3 [&_[data-command-group-heading]]:px-3 [&_[data-command-group-heading]]:pt-3 [&_[data-command-group-heading]]:pb-[0.4375rem] [&_[data-command-group-heading]]:text-[length:calc(0.59375rem*var(--solus-font-scale,1))] [&_[data-command-group-heading]]:font-medium [&_[data-command-group-heading]]:uppercase [&_[data-command-group-heading]]:tracking-[0.13em] [&_[data-command-group-heading]]:text-(--solus-text-tertiary) [&_[data-command-group-heading]]:select-none [&_[data-command-group-heading]]:pointer-events-none [&_[data-command-group-heading]]:after:content-[''] [&_[data-command-group-heading]]:after:flex-1 [&_[data-command-group-heading]]:after:h-[0.0625rem] [&_[data-command-group-heading]]:after:bg-(--solus-menu-hairline)"
              >
                <div
                  id={`command-palette-group-${groupIndex}`}
                  data-command-group-heading
                >
                  {group.title}
                </div>
                {#each group.items as cmd (cmd.id)}
                  <button
                    id={`command-palette-option-${cmd.id}`}
                    type="button"
                    role="option"
                    aria-selected={selectedValue === cmd.id}
                    data-command-item
                    data-slot="command-item"
                    data-value={cmd.id}
                    data-selected={selectedValue === cmd.id ? '' : undefined}
                    class={cn(
                      menuRowVariants({ stagger: false }),
                      'group/command-item h-[2.625rem] gap-3 w-full px-3 border-none rounded-lg cursor-pointer text-left bg-transparent font-normal text-(--solus-text-secondary) data-[selected]:text-(--solus-text-primary) data-[selected]:shadow-[shadow:inset_0_0_0_62rem_var(--solus-accent-light)]!',
                    )}
                    onpointermove={() => (selectedValue = cmd.id)}
                    onclick={() => run(cmd)}
                  >
                    {@render commandContent(cmd)}
                  </button>
                {/each}
              </div>
            {/each}
          {/if}
        </div>
      </div>

      <!-- Footer -->
      <div class="flex items-center gap-5 px-4 h-10 flex-shrink-0 border-t border-(--solus-menu-hairline) bg-(--solus-menu-footer-bg) text-[length:calc(0.71875rem*var(--solus-font-scale,1))] text-(--solus-text-tertiary)">
        <span class="inline-flex items-center gap-1.5">
          <Kbd variant="keycap">↑</Kbd>
          <Kbd variant="keycap">↓</Kbd>
          navigate
        </span>
        <span class="inline-flex items-center gap-1.5">
          <Kbd variant="keycap">↵</Kbd>
          run
        </span>
        <span class="inline-flex items-center gap-1.5">
          <Kbd variant="keycap">esc</Kbd>
          {page ? 'back' : 'close'}
        </span>
        <span class="ml-auto tabular-nums">
          {filtered.length === 1 ? '1 command' : `${filtered.length} commands`}
        </span>
      </div>
    </div>
  </div>
</div>

<style>
  /* Keyframes can't be expressed as Tailwind utilities; referenced via
     [animation:…] on the panel above. */
  .command-palette-enter {
    animation: cmdk-enter 180ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }

  @keyframes cmdk-enter {
    from {
      opacity: 0;
      transform: translate3d(0, 0.25rem, 0) scale(0.985);
    }
    to {
      opacity: 1;
      transform: translate3d(0, 0, 0) scale(1);
    }
  }
</style>
