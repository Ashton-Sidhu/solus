<script lang="ts">
  import { Bookmark, ChevronDown, File, FileText, X } from '@lucide/svelte'
  import { tick } from 'svelte'
  import { getPopoverLayer } from '../popoverLayer.svelte'
  import { portal } from '../portal'
  import { getSettingsContext } from '../../contexts'
  import { effectiveCombo } from '../../lib/keybindings/editing'
  import { formatComboText } from '../../lib/keybindings/match'
  import { relativeTime } from '../../lib/relative-time'
  import { stashPreview } from './lib/prompt-stash'
  import { positionStashDrawer } from './lib/stash-drawer'
  import type { usePromptStash } from './lib/prompt-stash.store.svelte'

  let { stash, anchor, refocus }: {
    stash: ReturnType<typeof usePromptStash>
    anchor: HTMLElement
    refocus: () => void
  } = $props()

  const layer = getPopoverLayer()
  const settings = getSettingsContext()
  const combo = $derived(effectiveCombo('global.prompt-stash', settings.keybindings))
  let menu = $state<HTMLElement | null>(null)
  let highlightedId = $state<string | null>(null)
  const highlighted = $derived(stash.entries.find((entry) => entry.id === highlightedId) ?? stash.entries[0])

  function close() {
    stash.close()
    refocus()
  }

  function selectRow(index: number, moveFocus = !!menu?.contains(document.activeElement)) {
    const row = menu?.querySelectorAll<HTMLButtonElement>('[data-stash-restore]')[index]
    highlightedId = stash.entries[index]?.id ?? null
    if (moveFocus) {
      if (row) row.focus({ preventScroll: true })
      else refocus()
    }
    row?.scrollIntoView({ block: 'nearest' })
  }

  function erase(index: number) {
    const entry = stash.entries[index]
    if (!entry) return
    const moveFocus = !!menu?.contains(document.activeElement)
    stash.remove(entry)
    if (!stash.entries.length) {
      close()
      return
    }
    void tick().then(() => selectRow(Math.min(index, stash.entries.length - 1), moveFocus))
  }

  function dismissOutside(event: PointerEvent) {
    if (!(event.target instanceof Element)) return
    if (menu?.contains(event.target)) return
    if (event.target.closest('[data-session-action="prompt-stash"]')) return
    stash.close()
  }

  function isComposerEditor(target: EventTarget | null): boolean {
    return target instanceof Element && anchor.contains(target) &&
      target.matches('textarea, [contenteditable="true"]')
  }

  function move(event: KeyboardEvent) {
    const target = event.target
    if (event.isComposing || event.keyCode === 229 || !(target instanceof Element)) return
    const inEditor = isComposerEditor(target)
    if (!inEditor && !menu?.contains(target) && !target.closest('[data-session-action="prompt-stash"]')) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    const length = stash.entries.length
    if (!length || stash.isRestoring) return
    const index = stash.entries.findIndex((entry) => entry.id === highlighted?.id)
    if (event.key === 'Tab' && inEditor && !event.shiftKey) {
      event.preventDefault()
      event.stopPropagation()
      selectRow(index, true)
      return
    }
    if (event.key === 'Backspace' && (event.metaKey || event.ctrlKey) && index >= 0) {
      event.preventDefault()
      event.stopPropagation()
      erase(index)
      return
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      selectRow((index + direction + length) % length)
    } else if (event.key === 'Enter' && inEditor && highlighted) {
      event.preventDefault()
      event.stopPropagation()
      void stash.restore(highlighted)
    }
  }

  $effect(() => {
    if (!anchor.contains(document.activeElement)) refocus()
  })
</script>

<svelte:window
  onkeydowncapture={move}
  oninputcapture={(event) => { if (isComposerEditor(event.target)) stash.close() }}
  onblur={stash.close}
/>
<svelte:document onpointerdowncapture={dismissOutside} />

{#if layer.el}
  <div
    bind:this={menu}
    use:portal={layer.el}
    use:positionStashDrawer={anchor}
    role="dialog"
    aria-label="Stashed prompts"
    tabindex={-1}
    data-composer-stash-drawer
    class="stash-drawer @container/stash pointer-events-auto fixed z-30 flex min-h-0 flex-col overflow-hidden rounded-t-2xl border-x border-t border-(--solus-popover-border) bg-(--solus-popover-bg) p-1 text-workspace-chrome text-(--solus-text-primary) shadow-[0_-4px_16px_-8px_rgb(0_0_0/20%)] outline-hidden dark:shadow-none"
  >
    <button
      type="button"
      aria-label="Close stash"
      aria-expanded="true"
      onpointerdown={(event) => event.preventDefault()}
      onclick={close}
      class="flex min-h-8 shrink-0 items-center gap-2 rounded-xl px-2 text-left font-medium text-(--solus-text-secondary) hover:bg-(--solus-surface-hover) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11"
    >
      <Bookmark size={16} class="shrink-0" aria-hidden="true" />
      <span class="min-w-0 flex-1 truncate">Stashed prompts</span>
      <span class="min-w-6 text-center font-medium tabular-nums">{stash.entries.length}</span>
      <ChevronDown size={16} class="shrink-0" aria-hidden="true" />
    </button>

    {#if stash.entries.length}
      <ul role="list" aria-label="Stashed prompts" class="mt-1 grid min-h-0 max-h-[min(24rem,40dvh)] gap-px overflow-y-auto overscroll-contain border-t border-(--solus-container-border) pt-1">
        {#each stash.entries as entry, index (entry.id)}
          {@const label = stashPreview(entry.prompt)}
          {@const images = entry.prompt.attachments.filter((attachment) => attachment.type === 'image' && !!attachment.dataUrl).slice(0, 3)}
          {@const fileCount = entry.prompt.attachments.filter((attachment) => attachment.type === 'file').length}
          <li
            class="flex min-w-0 items-center gap-1 rounded-lg text-(--solus-text-primary) data-highlighted:bg-(--solus-surface-active)"
            data-highlighted={highlighted?.id === entry.id ? '' : undefined}
            onpointerenter={() => (highlightedId = entry.id)}
          >
            <button
              type="button"
              data-stash-restore
              aria-label="Restore stashed prompt: {label}"
              disabled={stash.isRestoring}
              onpointerdown={(event) => event.preventDefault()}
              onfocus={() => (highlightedId = entry.id)}
              onclick={() => void stash.restore(entry)}
              class="flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:opacity-60 pointer-coarse:min-h-11"
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
              onpointerdown={(event) => event.preventDefault()}
              onfocus={() => (highlightedId = entry.id)}
              onclick={() => erase(index)}
              class="mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:size-11"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="px-8 py-2 text-(--solus-text-secondary)">
        Nothing stashed yet.
        {#if combo}Press {formatComboText(combo)} with a prompt in the composer to stash it.{/if}
      </p>
    {/if}
  </div>
{/if}

<style>
  .stash-drawer {
    /* The drawer is inset from both shoulders. Its bottom edge meets the card
       so they read as one surface, even while the transcript scrolls. */
    --stash-inset: min(1.375rem, calc(var(--stash-card-width) / 10));
    left: calc(var(--stash-card-left) + var(--stash-inset));
    width: calc(var(--stash-card-width) - var(--stash-inset) * 2);
    bottom: var(--stash-bottom);
    max-height: var(--stash-max-height);
  }
</style>
