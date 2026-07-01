<script lang="ts">
  import { untrack } from 'svelte'
  import { MagnifyingGlassIcon, CaretRightIcon, CaretLeftIcon } from 'phosphor-svelte'
  import Kbd from '../ui/Kbd.svelte'
  import VirtualizedList from '../ui/VirtualizedList.svelte'
  import { useScope, useKeybinding } from '../../lib/keybindings/use-keybinding.svelte'
  import { requestInputFocus } from '../../lib/inputFocus'
  import { filterCommands, groupCommands, type Command } from './lib/commands'

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

  type DisplayRow =
    | { kind: 'header'; title: string }
    | { kind: 'command'; cmd: Command; commandIndex: number }

  let query = $state('')
  let selected = $state(0)
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
  // Flat list in *render* order (grouped), so arrow-key nav matches what the
  // user sees. `filtered` is in raw command order, which differs once grouped.
  const ordered = $derived(groups.flatMap((g) => g.items))
  const hasResults = $derived(ordered.length > 0)
  const rows = $derived.by<DisplayRow[]>(() => {
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
    rows.findIndex((row) => row.kind === 'command' && row.commandIndex === selected),
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
  useKeybinding('command-palette.next', () => move(1))
  useKeybinding('command-palette.prev', () => move(-1))
  useKeybinding('command-palette.select', () => {
    const cmd = ordered[selected]
    if (cmd) run(cmd)
  })

  function move(delta: 1 | -1) {
    if (ordered.length === 0) return
    selected = (selected + delta + ordered.length) % ordered.length
  }

  function onRowPointerMove(e: MouseEvent, commandIndex: number) {
    if (e.clientX === lastPointerX && e.clientY === lastPointerY) return
    lastPointerX = e.clientX
    lastPointerY = e.clientY
    selected = commandIndex
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
    selected = 0
    Promise.resolve().then(() => searchEl?.focus())
  }

  function back() {
    page = null
    query = ''
    selected = 0
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

  function onWindowKeydownCapture(e: KeyboardEvent) {
    if (!open) return
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    e.stopPropagation()
    move(e.key === 'ArrowDown' ? 1 : -1)
  }

  // Reset query + selection each time the palette opens, honoring an `initialPage`
  // so callers can open straight into a sub-page; autofocus the search after the
  // scope is established (next microtask). Reads of initialPage are untracked so
  // clearing it here doesn't re-run this effect and wipe the page back to root.
  $effect(() => {
    if (open) {
      query = ''
      selected = 0
      untrack(() => {
        page = initialPage
        if (initialPage) initialPage = null
      })
      Promise.resolve().then(() => searchEl?.focus())
    }
  })

  // Keep the selection in range as the result set changes while typing.
  $effect(() => {
    if (!open) return
    void ordered.length
    if (selected > ordered.length - 1) selected = 0
  })
</script>

<svelte:window onkeydowncapture={onWindowKeydownCapture} />

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
        <input
          bind:this={searchEl}
          bind:value={query}
          onkeydown={onSearchKeydown}
          type="search"
          name="command-palette-search"
          aria-label={page ? `Search ${page.title}` : 'Search commands'}
          placeholder={page ? `Search ${page.title.toLowerCase()}…` : 'Type a command or search…'}
          class="flex-1 bg-transparent border-none outline-none text-sm tracking-[-0.005em] text-(--solus-text-primary) caret-(--solus-accent) placeholder:text-(--solus-text-tertiary) [&::-webkit-search-cancel-button]:hidden"
          autocomplete="off"
          spellcheck="false"
        />
      </div>

      <!-- Results -->
      <div
        class="flex-1 overflow-hidden pt-1.5 px-1.5 pb-2 overscroll-y-contain [scrollbar-width:thin]"
      >
        {#if !hasResults}
          <div class="flex flex-col items-center justify-center gap-2.5 py-11 px-6 text-center text-[0.8125rem] text-(--solus-text-tertiary)">
            <MagnifyingGlassIcon size={18} weight="light" class="text-(--solus-text-tertiary)" />
            <span>
              {#if activeCommands.length === 0}
                {page ? "Nothing here yet" : "No commands available yet"}
              {:else}
                No commands match “{query.trim()}”
              {/if}
            </span>
          </div>
        {:else}
          <VirtualizedList
            height={listHeight}
            itemCount={rows.length}
            itemSize={rowSize}
            overscanCount={6}
            scrollToIndex={selectedRowIndex >= 0 ? selectedRowIndex : 0}
            scrollToAlignment="auto"
            scrollToBehaviour="instant"
          >
            {#snippet item({ style, index })}
              {@const row = rows[index]}
              <div {style}>
                {#if row.kind === 'header'}
                  <div class="flex h-full items-end px-3.5 pb-[0.3125rem] pt-[0.1875rem] text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-(--solus-text-secondary) select-none pointer-events-none">{row.title}</div>
                {:else}
                  {@const cmd = row.cmd}
                  {@const isSelected = row.commandIndex === selected}
                  <!-- svelte-ignore a11y_mouse_events_have_key_events -->
                  <button
                    type="button"
                    class="flex h-full items-center gap-2.5 w-full px-3.5 border-none rounded-lg cursor-pointer text-left transition-colors duration-100 {isSelected ? 'bg-(--solus-accent-light) text-(--solus-text-primary)' : 'bg-transparent text-(--solus-text-secondary)'}"
                    onmousemove={(e) => onRowPointerMove(e, row.commandIndex)}
                    onclick={() => run(cmd)}
                  >
                    {#if cmd.icon}
                      {@const Icon = cmd.icon}
                      <Icon size={15} weight="regular" class="flex-shrink-0 {isSelected ? 'text-(--solus-accent)' : 'text-(--solus-text-tertiary)'}" />
                    {/if}
                    <span class="flex-1 text-[0.8125rem] tracking-[-0.005em]">{cmd.label}</span>
                    {#if cmd.hint}
                      <span class="flex-shrink-0 text-[0.6875rem] tabular-nums tracking-[0.02em] text-(--solus-text-tertiary)">{cmd.hint}</span>
                    {/if}
                    {#if cmd.children}
                      <CaretRightIcon size={13} weight="bold" class="flex-shrink-0 {isSelected ? 'text-(--solus-text-secondary)' : 'text-(--solus-text-tertiary)'}" />
                    {/if}
                  </button>
                {/if}
              </div>
            {/snippet}
          </VirtualizedList>
        {/if}
      </div>

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
