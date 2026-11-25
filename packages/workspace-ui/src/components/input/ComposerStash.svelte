<script lang="ts">
  import { Bookmark, FileText, Paperclip, X } from '@lucide/svelte'
  import { tick } from 'svelte'
  import * as Popover from '../ui/popover'
  import { comboHint } from '../../lib/keybindings/manifest'
  import { stashPreview } from './lib/prompt-stash'
  import type { usePromptStash } from './lib/prompt-stash.store.svelte'

  let { stash, refocus }: { stash: ReturnType<typeof usePromptStash>; refocus: () => void } = $props()

  let menu = $state<HTMLElement | null>(null)

  function move(event: KeyboardEvent) {
    if (event.isComposing || event.keyCode === 229) return
    const rows = Array.from(menu?.querySelectorAll<HTMLButtonElement>('[data-stash-restore]:enabled') ?? [])
    const current = rows.findIndex((row) => row === document.activeElement)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!rows.length) return
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      const index = current < 0 ? (direction > 0 ? 0 : rows.length - 1) : current + direction
      rows[(index + rows.length) % rows.length]?.focus()
    } else if (event.key === 'Backspace' && (event.metaKey || event.ctrlKey) && current >= 0) {
      event.preventDefault()
      erase(current)
    }
  }

  function erase(index: number) {
    const entry = stash.entries[index]
    if (!entry) return
    stash.remove(entry)
    void tick().then(() => {
      const rows = menu?.querySelectorAll<HTMLButtonElement>('[data-stash-restore]:enabled')
      const row = rows?.[Math.min(index, rows.length - 1)]
      if (row) row.focus()
      else menu?.focus()
    })
  }

</script>

<Popover.Root open={stash.open} onOpenChange={stash.setOpen}>
  <Popover.Trigger
    aria-label="Stashed prompts ({stash.entries.length})"
    title="Stashed prompts"
    class="flex h-7 w-fit items-center gap-1 rounded-md px-2 text-xs tabular-nums text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-ring {stash.entries.length === 0 && !stash.open ? 'sr-only' : ''}"
    tabindex={stash.entries.length === 0 ? -1 : 0}
  >
    <Bookmark size={14} aria-hidden="true" />
    {stash.entries.length}
  </Popover.Trigger>
  <Popover.Content
    bind:ref={menu}
    side="top"
    align="start"
    tabindex={-1}
    aria-label="Stashed prompts"
    class="w-[min(25rem,calc(100vw-2rem))] gap-1.5"
    onkeydown={move}
    onEscapeKeydown={(event) => {
      event.preventDefault()
      stash.close()
      refocus()
    }}
    onOpenAutoFocus={(event) => {
      event.preventDefault()
      const first = menu?.querySelector<HTMLButtonElement>('[data-stash-restore]')
      if (first) first.focus()
      else menu?.focus()
    }}
    onCloseAutoFocus={(event) => event.preventDefault()}
  >
    <div class="flex items-center gap-2 px-2 py-1 text-muted-foreground">
      <Bookmark size={14} aria-hidden="true" />
      <span class="flex-1">Stash</span>
      <span class="tabular-nums">{stash.entries.length}</span>
      <button type="button" aria-label="Close stash" class="rounded p-1 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" onclick={() => { stash.close(); refocus(); }}>
        <X size={14} />
      </button>
    </div>
    {#if stash.entries.length}
      <ul class="max-h-64 overflow-y-auto" aria-label="Stashed prompts">
        {#each stash.entries as entry, index (entry.id)}
          {@const label = stashPreview(entry.prompt)}
          <li class="flex items-center gap-1 rounded-md hover:bg-accent focus-within:bg-accent">
            <button
              type="button"
              data-stash-restore
              aria-label="Restore stashed prompt: {label}"
              disabled={stash.isRestoring}
              onclick={() => void stash.restore(entry)}
              class="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:opacity-60"
            >
              <FileText size={14} class="shrink-0 text-muted-foreground" aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate">{label}</span>
              {#if entry.prompt.attachments.length}
                <span class="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  <Paperclip size={12} aria-hidden="true" /> {entry.prompt.attachments.length}
                </span>
              {/if}
            </button>
            <button
              type="button"
              aria-label="Delete stashed prompt: {label}"
              disabled={stash.isRestoring}
              onclick={() => erase(index)}
              class="mr-1 shrink-0 rounded p-1.5 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              <X size={14} />
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="px-2 pb-1 text-muted-foreground">
        Nothing stashed yet. Press {comboHint('global.prompt-stash')} with a prompt in the composer to stash it.
      </p>
    {/if}
  </Popover.Content>
</Popover.Root>
