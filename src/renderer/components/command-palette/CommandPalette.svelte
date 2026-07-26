<script lang="ts">
  import { tick, untrack } from 'svelte'
  import { MagnifyingGlassIcon, CaretRightIcon, CaretLeftIcon } from 'phosphor-svelte'
  import Kbd from '../ui/Kbd.svelte'
  import * as CommandMenu from '../ui/command'
  import { useScope, useKeybinding } from '../../lib/keybindings/use-keybinding.svelte'
  import { requestInputFocus } from '../../lib/inputFocus'
  import {
    filterCommands,
    groupCommands,
    retainCommandSelection,
    type Command,
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
  let userSelectionRevision = 0
  let listChangeVersion = 0
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

  function trackKeyboardSelection(e: KeyboardEvent) {
    const navigates =
      e.key === 'ArrowDown' ||
      e.key === 'ArrowUp' ||
      e.key === 'Home' ||
      e.key === 'End' ||
      (e.ctrlKey && ['n', 'j', 'p', 'k'].includes(e.key.toLowerCase()))
    if (navigates) userSelectionRevision += 1
  }

  function trackPointerSelection() {
    userSelectionRevision += 1
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

  // Bits UI selects the first item when a live command registers. Restore the
  // previous selection after registration settles, unless the user navigated
  // in the meantime. Normal keyboard changes remain entirely inside Bits UI,
  // preserving its native scroll-into-view behavior.
  async function restoreSelectionAfterListChange(
    commandId: string,
    userRevision: number,
    changeVersion: number,
  ) {
    await tick()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    if (
      !open ||
      userSelectionRevision !== userRevision ||
      listChangeVersion !== changeVersion ||
      !ordered.some((command) => command.id === commandId) ||
      selectedValue === commandId
    ) return

    selectedValue = commandId
    await tick()
    scrollCommandIntoView(commandId)
  }

  function run(cmd: Command) {
    if (cmd.children) {
      enterPage(cmd.id, cmd.label)
      return
    }
    open = false
    page = null
    query = ''
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
      return
    }

    const changeVersion = ++listChangeVersion
    void restoreSelectionAfterListChange(
      selectionBeforeListChange,
      userSelectionRevision,
      changeVersion,
    )
  })

</script>

{#snippet commandContent(cmd: Command, isSelected: boolean | null)}
  {#if cmd.icon}
    {@const Icon = cmd.icon}
    <Icon
      size={15}
      weight="regular"
      class="flex-shrink-0 {isSelected === true ? 'text-(--solus-accent)' : isSelected === false ? 'text-(--solus-text-tertiary)' : 'text-(--solus-text-tertiary) group-data-[selected]/command-item:text-(--solus-accent)'}"
    />
  {/if}
  <span class="flex-1 text-[0.8125rem] tracking-[-0.005em]">{cmd.label}</span>
  {#if cmd.hint}
    <CommandMenu.Shortcut class="flex-shrink-0 text-[0.6875rem] tabular-nums tracking-[0.02em] text-(--solus-text-tertiary)">{cmd.hint}</CommandMenu.Shortcut>
  {/if}
  {#if cmd.children}
    <CaretRightIcon
      size={13}
      weight="bold"
      class="flex-shrink-0 {isSelected === true ? 'text-(--solus-text-secondary)' : isSelected === false ? 'text-(--solus-text-tertiary)' : 'text-(--solus-text-tertiary) group-data-[selected]/command-item:text-(--solus-text-secondary)'}"
    />
  {/if}
{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  data-solus-ui
  class="fixed inset-0 z-[10020] flex items-start justify-center pt-[12vh] pointer-events-auto"
  class:hidden={!open}
  aria-hidden={!open}
  inert={!open}
  role="presentation"
  onclick={(e) => { if (e.target === e.currentTarget) close() }}
>
  <div
    class="w-[clamp(22rem,56vw,40rem)] max-w-[calc(100vw-3rem)] max-h-[60vh] outline-none flex flex-col rounded-[1.125rem] border-[0.0625rem] border-(--solus-popover-border) bg-(--solus-popover-bg) shadow-[var(--solus-popover-shadow),inset_0_0.0625rem_0_rgba(255,255,255,0.14)] [.dark_&]:shadow-[var(--solus-popover-shadow),inset_0_0.0625rem_0_rgba(255,255,255,0.06)] overflow-hidden origin-top"
    class:command-palette-enter={open}
    role="dialog"
    aria-label="Command palette"
    aria-modal="true"
  >
    <CommandMenu.Root
        bind:ref={commandRootEl}
        bind:value={selectedValue}
        shouldFilter={false}
        loop
        disableInitialScroll
        onkeydowncapture={trackKeyboardSelection}
        onpointermovecapture={trackPointerSelection}
        class="h-auto"
        label="Command palette"
      >
      <!-- Search -->
      <div
        class="flex items-center gap-2.5 px-[1.125rem] h-[3.25rem] flex-shrink-0 relative after:content-[''] after:absolute after:left-[1.125rem] after:right-[1.125rem] after:bottom-0 after:h-[0.0625rem] after:bg-(--solus-popover-border) after:opacity-[0.35]"
      >
        {#if page}
          <button
            type="button"
            class="inline-flex items-center justify-center size-[1.375rem] flex-shrink-0 border-none rounded-[0.4375rem] bg-(--solus-surface-hover) text-(--solus-text-secondary) cursor-pointer transition-colors duration-100 hover:text-(--solus-text-primary)"
            aria-label="Back"
            onclick={back}
          >
            <CaretLeftIcon size={14} weight="bold" />
          </button>
          <span class="flex-shrink-0 text-[0.8125rem] font-semibold tracking-[-0.005em] text-(--solus-text-primary)">{page.title}</span>
        {:else}
          <MagnifyingGlassIcon size={15} class="flex-shrink-0 text-(--solus-text-tertiary)" />
        {/if}
        <CommandMenu.Input
          bind:ref={searchEl}
          bind:value={query}
          onkeydown={onSearchKeydown}
          type="search"
          name="command-palette-search"
          aria-label={page ? `Search ${page.title}` : 'Search commands'}
          placeholder={page ? `Search ${page.title.toLowerCase()}…` : 'Type a command or search…'}
          class="flex-1 h-auto bg-transparent border-none outline-none text-sm tracking-[-0.005em] text-(--solus-text-primary) caret-(--solus-accent) placeholder:text-(--solus-text-tertiary) [&::-webkit-search-cancel-button]:hidden"
          autocomplete="off"
          spellcheck="false"
        />
      </div>

      <!-- Results -->
      <CommandMenu.List
        class="flex-1 max-h-[24.875rem] overflow-hidden"
      >
        <CommandMenu.Viewport
          class="max-h-96 overflow-x-hidden overflow-y-auto overscroll-y-contain pt-1.5 px-1.5 pb-2 [scrollbar-width:thin]"
        >
          {#if !hasResults}
            <CommandMenu.Empty forceMount class="flex flex-col items-center justify-center gap-2.5 py-11 px-6 text-center text-[0.8125rem] text-(--solus-text-tertiary)">
              <MagnifyingGlassIcon size={18} weight="light" class="text-(--solus-text-tertiary)" />
              <span>
                {#if activeCommands.length === 0}
                  {page ? "Nothing here yet" : "No commands available yet"}
                {:else}
                  No commands match “{query.trim()}”
                {/if}
              </span>
            </CommandMenu.Empty>
          {:else}
            {#each groups as group (group.title)}
              <CommandMenu.Group
                heading={group.title}
                class="p-0 text-(--solus-text-primary) [&_[data-command-group-heading]]:flex [&_[data-command-group-heading]]:h-7 [&_[data-command-group-heading]]:items-end [&_[data-command-group-heading]]:px-3.5 [&_[data-command-group-heading]]:pb-[0.3125rem] [&_[data-command-group-heading]]:pt-[0.1875rem] [&_[data-command-group-heading]]:text-[0.6875rem] [&_[data-command-group-heading]]:font-semibold [&_[data-command-group-heading]]:uppercase [&_[data-command-group-heading]]:tracking-[0.08em] [&_[data-command-group-heading]]:text-(--solus-text-secondary) [&_[data-command-group-heading]]:select-none [&_[data-command-group-heading]]:pointer-events-none"
              >
                {#each group.items as cmd (cmd.id)}
                  <CommandMenu.Item
                    value={cmd.id}
                    keywords={[cmd.label, cmd.group, ...(cmd.keywords ?? [])]}
                    class="h-9 gap-2.5 w-full px-3.5 border-none rounded-lg cursor-pointer text-left bg-transparent text-(--solus-text-secondary) data-[selected]:bg-(--solus-accent-light) data-[selected]:text-(--solus-text-primary)"
                    onSelect={() => run(cmd)}
                  >
                    {@render commandContent(cmd, null)}
                  </CommandMenu.Item>
                {/each}
              </CommandMenu.Group>
            {/each}
          {/if}
        </CommandMenu.Viewport>
      </CommandMenu.List>

      <!-- Footer -->
      <div class="flex items-center gap-4 px-[1.125rem] h-9 flex-shrink-0 relative text-xs text-(--solus-text-tertiary) before:content-[''] before:absolute before:left-[1.125rem] before:right-[1.125rem] before:top-0 before:h-[0.0625rem] before:bg-(--solus-popover-border) before:opacity-[0.35]">
        <span class="inline-flex items-center gap-1.5">
          <Kbd variant="hint">↑</Kbd>
          <Kbd variant="hint">↓</Kbd>
          to navigate
        </span>
        <span class="inline-flex items-center gap-1.5">
          <Kbd variant="hint">↵</Kbd>
          to run
        </span>
        <span class="inline-flex items-center gap-1.5">
          <Kbd variant="hint">esc</Kbd>
          {page ? 'to go back' : 'to close'}
        </span>
      </div>
    </CommandMenu.Root>
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
