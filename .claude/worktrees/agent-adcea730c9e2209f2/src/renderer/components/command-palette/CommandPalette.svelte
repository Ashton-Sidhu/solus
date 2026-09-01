<script lang="ts">
  import { untrack } from 'svelte'
  import { MagnifyingGlassIcon, CaretRightIcon, CaretLeftIcon } from 'phosphor-svelte'
  import Kbd from '../ui/Kbd.svelte'
  import VirtualizedList from '../ui/VirtualizedList.svelte'
  import * as CommandMenu from '../ui/command'
  import { useScope, useKeybinding } from '../../lib/keybindings/use-keybinding.svelte'
  import { requestInputFocus } from '../../lib/inputFocus'
  import {
    filterCommands,
    groupCommands,
    visibleCommandEdge,
    type Command,
    type CommandDisplayRow,
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

  const GROUP_HEADER_HEIGHT = 28
  const COMMAND_ROW_HEIGHT = 36
  const MAX_LIST_HEIGHT = 384
  // Bits UI navigation scans every mounted item. Keep its native path for
  // ordinary palettes, and window only provider-backed pages large enough for
  // that DOM work to become noticeable.
  const VIRTUALIZE_COMMAND_COUNT = 80

  let query = $state('')
  let selectedValue = $state('')
  let virtualSelected = $state(0)
  let virtualScrollOffset = 0
  let searchEl: HTMLInputElement | null = $state(null)
  // Distinguishes a real pointer move from the mouseenter the browser fires
  // when keyboard nav scrolls a different row under a stationary cursor —
  // without this, that scroll-triggered hover fight the arrow keys for
  // `selected` on every move.
  let lastPointerX = -1
  let lastPointerY = -1
  // When set, we're drilled into a parent command's children sub-page. We hold
  // the parent's id (not a snapshot of its children) so the sub-page re-derives
  // its list from the live `commands` prop — children that load in the
  // background after drilling in show up without re-entering the page.
  let page = $state<{ id: string; title: string } | null>(null)

  const activeCommands = $derived.by(() => {
    if (!open) return []
    if (!page) return commands
    return commands.find((c) => c.id === page!.id)?.children ?? []
  })
  const filtered = $derived(filterCommands(activeCommands, query))
  const groups = $derived(groupCommands(filtered))
  const ordered = $derived(groups.flatMap((group) => group.items))
  const hasResults = $derived(filtered.length > 0)
  const isVirtualized = $derived(activeCommands.length >= VIRTUALIZE_COMMAND_COUNT)
  const rows = $derived.by<CommandDisplayRow[]>(() => {
    let commandIndex = 0
    const result: DisplayRow[] = []
    for (const group of groups) {
      result.push({ kind: 'header', title: group.title })
      for (const cmd of group.items) {
        result.push({ kind: 'command', cmd, commandIndex })
        commandIndex += 1
      }
    }
    return result
  })
  const selectedRowIndex = $derived(
    rows.findIndex(
      (row) => row.kind === 'command' && row.commandIndex === virtualSelected,
    ),
  )
  const listHeight = $derived(
    Math.min(
      rows.reduce(
        (height, row) =>
          height + (row.kind === 'header' ? GROUP_HEADER_HEIGHT : COMMAND_ROW_HEIGHT),
        0,
      ),
      MAX_LIST_HEIGHT,
    ),
  )

  useScope('command-palette', { exclusive: true, active: () => open })
  useKeybinding('command-palette.close', () => close())
  useKeybinding('command-palette.next', () => moveVirtualSelection(1), {
    enabled: () => open && isVirtualized,
  })
  useKeybinding('command-palette.prev', () => moveVirtualSelection(-1), {
    enabled: () => open && isVirtualized,
  })
  useKeybinding('command-palette.select', () => {
    const cmd = ordered[virtualSelected]
    if (cmd) run(cmd)
  }, {
    enabled: () => open && isVirtualized,
  })

  function onRowPointerMove(e: PointerEvent, commandId: string) {
    if (e.clientX === lastPointerX && e.clientY === lastPointerY) return
    lastPointerX = e.clientX
    lastPointerY = e.clientY
    selectedValue = commandId
  }

  function onVirtualRowPointerMove(e: MouseEvent, commandIndex: number) {
    if (e.clientX === lastPointerX && e.clientY === lastPointerY) return
    lastPointerX = e.clientX
    lastPointerY = e.clientY
    virtualSelected = commandIndex
  }

  function moveVirtualSelection(delta: 1 | -1) {
    if (ordered.length === 0) return

    const visibleEdge = visibleCommandEdge(
      rows,
      virtualSelected,
      virtualScrollOffset,
      listHeight,
      GROUP_HEADER_HEIGHT,
      COMMAND_ROW_HEIGHT,
      delta,
    )
    if (visibleEdge !== null) {
      virtualSelected = visibleEdge
      return
    }

    virtualSelected =
      (virtualSelected + delta + ordered.length) % ordered.length
  }

  function onVirtualScroll(detail: { offset: number }) {
    virtualScrollOffset = detail.offset
  }

  function onVirtualKeydownCapture(e: KeyboardEvent) {
    if (!isVirtualized) return

    const next =
      e.key === 'ArrowDown' ||
      (e.ctrlKey && (e.key.toLowerCase() === 'n' || e.key.toLowerCase() === 'j'))
    const previous =
      e.key === 'ArrowUp' ||
      (e.ctrlKey && (e.key.toLowerCase() === 'p' || e.key.toLowerCase() === 'k'))

    if (next || previous) {
      e.preventDefault()
      e.stopPropagation()
      moveVirtualSelection(next ? 1 : -1)
      return
    }
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      e.stopPropagation()
      virtualSelected = e.key === 'Home' ? 0 : Math.max(ordered.length - 1, 0)
      return
    }
    if (e.key === 'Enter') {
      const cmd = ordered[virtualSelected]
      if (!cmd || e.isComposing || e.keyCode === 229) return
      e.preventDefault()
      e.stopPropagation()
      run(cmd)
    }
  }

  function rowSize(index: number) {
    return rows[index]?.kind === 'header' ? GROUP_HEADER_HEIGHT : COMMAND_ROW_HEIGHT
  }

  function run(cmd: Command) {
    if (cmd.children) {
      enterPage(cmd.id, cmd.label)
      return
    }
    open = false
    cmd.run?.()
  }

  function enterPage(id: string, title: string) {
    page = { id, title }
    query = ''
    selectedValue = commands.find((command) => command.id === id)?.children?.[0]?.id ?? ''
    virtualSelected = 0
    virtualScrollOffset = 0
    Promise.resolve().then(() => searchEl?.focus())
  }

  function back() {
    page = null
    query = ''
    selectedValue = commands[0]?.id ?? ''
    virtualSelected = 0
    virtualScrollOffset = 0
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
      virtualSelected = 0
      virtualScrollOffset = 0
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
    if (!open || !isVirtualized) return
    void ordered.length
    if (virtualSelected > ordered.length - 1) virtualSelected = 0
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

{#if open}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    data-solus-ui
    class="fixed inset-0 z-[10020] flex items-start justify-center pt-[12vh] pointer-events-auto bg-black/[0.04] [.dark_&]:bg-black/[0.28] [animation:cmdk-backdrop-in_160ms_ease_both]"
    role="presentation"
    onclick={(e) => { if (e.target === e.currentTarget) close() }}
  >
    <div
      class="w-[clamp(22rem,56vw,40rem)] max-w-[calc(100vw-3rem)] max-h-[60vh] outline-none flex flex-col rounded-[1.125rem] border-[0.0625rem] border-(--solus-popover-border) bg-(--solus-popover-bg) shadow-[var(--solus-popover-shadow),inset_0_0.0625rem_0_rgba(255,255,255,0.14)] [.dark_&]:shadow-[var(--solus-popover-shadow),inset_0_0.0625rem_0_rgba(255,255,255,0.06)] overflow-hidden origin-top [animation:cmdk-enter_180ms_cubic-bezier(0.22,1,0.36,1)_both]"
      role="dialog"
      aria-label="Command palette"
      aria-modal="true"
    >
      <CommandMenu.Root
        bind:value={selectedValue}
        shouldFilter={false}
        loop
        disablePointerSelection
        disableInitialScroll
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
          onkeydowncapture={onVirtualKeydownCapture}
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
        style={hasResults ? `height: ${listHeight + 14}px` : undefined}
        class="flex-1 max-h-none overflow-x-hidden overflow-y-auto pt-1.5 px-1.5 pb-2 overscroll-y-contain [scrollbar-width:thin]"
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
          {#if isVirtualized}
            <VirtualizedList
              height={listHeight}
              itemCount={rows.length}
              itemSize={rowSize}
              overscanCount={6}
              scrollToIndex={selectedRowIndex >= 0 ? selectedRowIndex : 0}
              scrollToAlignment="auto"
              scrollToBehaviour="instant"
              onAfterScroll={onVirtualScroll}
            >
              {#snippet item({ style, index })}
                {@const row = rows[index]}
                <div {style}>
                  {#if row.kind === 'header'}
                    <div class="flex h-full items-end px-3.5 pb-[0.3125rem] pt-[0.1875rem] text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-(--solus-text-secondary) select-none pointer-events-none">{row.title}</div>
                  {:else}
                    {@const cmd = row.cmd}
                    {@const isSelected = row.commandIndex === virtualSelected}
                    <!-- svelte-ignore a11y_mouse_events_have_key_events -->
                    <button
                      type="button"
                      class="flex h-full items-center gap-2.5 w-full px-3.5 border-none rounded-lg cursor-pointer text-left {isSelected ? 'bg-(--solus-accent-light) text-(--solus-text-primary)' : 'bg-transparent text-(--solus-text-secondary)'}"
                      onmousemove={(e) => onVirtualRowPointerMove(e, row.commandIndex)}
                      onclick={() => run(cmd)}
                    >
                      {@render commandContent(cmd, isSelected)}
                    </button>
                  {/if}
                </div>
              {/snippet}
            </VirtualizedList>
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
                    onpointermove={(e) => onRowPointerMove(e, cmd.id)}
                    onSelect={() => run(cmd)}
                  >
                    {@render commandContent(cmd, null)}
                  </CommandMenu.Item>
                {/each}
              </CommandMenu.Group>
            {/each}
          {/if}
        {/if}
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
{/if}

<style>
  /* Keyframes can't be expressed as Tailwind utilities; referenced via
     [animation:…] on the backdrop and panel above. */
  @keyframes cmdk-backdrop-in {
    from { opacity: 0; }
    to { opacity: 1; }
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
