<script lang="ts">
  import { Bookmark, ChevronDown, File, FileText, X } from '@lucide/svelte'
  import { tick } from 'svelte'
  import * as Popover from '../ui/popover'
  import { getSettingsContext } from '../../contexts'
  import { effectiveCombo } from '../../lib/keybindings/editing'
  import { formatComboText } from '../../lib/keybindings/match'
  import { relativeTime } from '../../lib/relative-time'
  import { stashPreview } from './lib/prompt-stash'
  import type { usePromptStash } from './lib/prompt-stash.store.svelte'

  let { stash, anchor, refocus }: {
    stash: ReturnType<typeof usePromptStash>
    anchor: HTMLElement
    refocus: () => void
  } = $props()

  const settings = getSettingsContext()
  const combo = $derived(effectiveCombo('global.prompt-stash', settings.keybindings))
  let menu = $state<HTMLElement | null>(null)
  let highlightedId = $state<string | null>(null)
  const highlighted = $derived(stash.entries.find((entry) => entry.id === highlightedId) ?? stash.entries[0])

  function close() {
    stash.close()
    refocus()
  }

  function focusRow(index: number) {
    const rows = menu?.querySelectorAll<HTMLButtonElement>('[data-stash-restore]:enabled')
    const row = rows?.[Math.min(index, rows.length - 1)]
    if (row) {
      row.focus({ preventScroll: true })
      row.scrollIntoView({ block: 'nearest' })
    } else {
      menu?.focus()
    }
  }

  function erase(index: number) {
    const entry = stash.entries[index]
    if (!entry) return
    stash.remove(entry)
    void tick().then(() => focusRow(index))
  }

  function move(event: KeyboardEvent) {
    if (event.isComposing || event.keyCode === 229 || stash.isRestoring) return
    const length = stash.entries.length
    if (!length) return
    const index = stash.entries.findIndex((entry) => entry.id === highlighted?.id)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      focusRow((index + direction + length) % length)
    } else if (event.key === 'Backspace' && (event.metaKey || event.ctrlKey) && index >= 0) {
      event.preventDefault()
      erase(index)
    }
  }
</script>

<Popover.Root open={stash.open} onOpenChange={stash.setOpen}>
  <Popover.Content
    bind:ref={menu}
    customAnchor={anchor}
    side="top"
    align="center"
    sideOffset={2}
    collisionPadding={12}
    tabindex={-1}
    aria-label="Stashed prompts"
    class="@container/stash z-[10002] w-[calc(var(--bits-popover-anchor-width)-0.5rem)] max-w-(--bits-popover-content-available-width) max-h-(--bits-popover-content-available-height) min-h-0 gap-0 overflow-hidden rounded-t-2xl rounded-b-md bg-(--solus-input-pill-bg) p-1 dark:shadow-none motion-reduce:animate-none"
    onkeydown={move}
    onEscapeKeydown={(event) => {
      event.preventDefault()
      close()
    }}
    onInteractOutside={(event) => {
      if (event.target instanceof Element && event.target.closest('[data-session-action="prompt-stash"]')) {
        event.preventDefault()
      }
    }}
    onOpenAutoFocus={(event) => {
      event.preventDefault()
      requestAnimationFrame(() => focusRow(0))
    }}
    onCloseAutoFocus={(event) => event.preventDefault()}
  >
    <button
      type="button"
      aria-label="Close stash"
      aria-expanded="true"
      onclick={close}
      class="flex min-h-8 shrink-0 items-center gap-2 rounded-xl px-2 text-left text-muted-foreground hover:bg-foreground/5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11"
    >
      <Bookmark size={16} class="shrink-0" aria-hidden="true" />
      <span class="min-w-0 flex-1 truncate">Stash</span>
      <span class="min-w-5 text-center tabular-nums">{stash.entries.length}</span>
      <ChevronDown size={16} class="shrink-0" aria-hidden="true" />
    </button>

    {#if stash.entries.length}
      <ul role="list" aria-label="Stashed prompts" class="grid min-h-0 max-h-[min(24rem,40dvh)] gap-px overflow-y-auto overscroll-contain">
        {#each stash.entries as entry, index (entry.id)}
          {@const label = stashPreview(entry.prompt)}
          {@const images = entry.prompt.attachments.filter((attachment) => attachment.type === 'image' && !!attachment.dataUrl).slice(0, 3)}
          {@const fileCount = entry.prompt.attachments.filter((attachment) => attachment.type === 'file').length}
          <li
            class="flex min-w-0 items-center gap-1 rounded-md text-foreground/80 data-highlighted:bg-accent data-highlighted:text-accent-foreground"
            data-highlighted={highlighted?.id === entry.id ? '' : undefined}
            onpointerenter={() => (highlightedId = entry.id)}
          >
            <button
              type="button"
              data-stash-restore
              aria-label="Restore stashed prompt: {label}"
              disabled={stash.isRestoring}
              onfocus={() => (highlightedId = entry.id)}
              onclick={() => void stash.restore(entry)}
              class="flex min-h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:opacity-60 pointer-coarse:min-h-11"
            >
              <FileText size={16} class="shrink-0 text-muted-foreground" aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate">{label}</span>
              {#if images.length}
                <span class="hidden shrink-0 items-center -space-x-1 @min-[14rem]/stash:flex" aria-hidden="true">
                  {#each images as image (image.id)}
                    <img src={image.dataUrl} alt="" class="size-4 rounded-sm object-cover outline-1 -outline-offset-1 outline-black/10 dark:outline-white/15" />
                  {/each}
                </span>
              {/if}
              {#if fileCount}
                <span class="flex shrink-0 items-center gap-1 tabular-nums text-muted-foreground" aria-label="{fileCount} {fileCount === 1 ? 'file' : 'files'}">
                  <File size={14} aria-hidden="true" /> {fileCount}
                </span>
              {/if}
              <time datetime={new Date(entry.createdAt).toISOString()} class="hidden shrink-0 tabular-nums text-muted-foreground @min-[22rem]/stash:inline">
                {relativeTime(entry.createdAt)}
              </time>
            </button>
            <button
              type="button"
              aria-label="Delete stashed prompt: {label}"
              disabled={stash.isRestoring}
              onfocus={() => (highlightedId = entry.id)}
              onclick={() => erase(index)}
              class="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:size-11"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="px-8 pt-0.5 pb-2 text-muted-foreground">
        Nothing stashed yet.
        {#if combo}Press {formatComboText(combo)} with a prompt in the composer to stash it.{/if}
      </p>
    {/if}
  </Popover.Content>
</Popover.Root>
