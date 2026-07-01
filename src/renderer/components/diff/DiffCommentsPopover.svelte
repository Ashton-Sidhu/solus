<script lang="ts">
  import { fly } from 'svelte/transition'
  import { ChatCircleTextIcon, XIcon, CheckCircleIcon } from 'phosphor-svelte'
  import type { DiffComment } from '../../../shared/types'
  import type { ReviewThread } from '../../../shared/providers'
  import { getPopoverLayer, useClickOutside } from '../popoverLayer.svelte'
  import { portal } from '../portal'
  import { MONO_FONT } from '../../lib/diffTheme'

  interface Props {
    open: boolean
    comments: DiffComment[]
    /** Line-anchored GitHub review threads, navigable alongside local comments. */
    threads?: ReviewThread[]
    anchor: HTMLElement | null
    onClose: () => void
    onNavigate: (c: DiffComment) => void
    onNavigateThread?: (t: ReviewThread) => void
  }

  let {
    open,
    comments,
    threads = [],
    anchor,
    onClose,
    onNavigate,
    onNavigateThread,
  }: Props = $props()

  const totalCount = $derived(comments.length + threads.length)

  const layer = getPopoverLayer()

  let popoverEl: HTMLDivElement | null = $state(null)
  let position = $state<{ top: number; right: number } | null>(null)

  useClickOutside(
    () => open,
    () => [popoverEl, anchor],
    () => onClose(),
  )

  function recomputePosition() {
    if (!open || !anchor) return
    const rect = anchor.getBoundingClientRect()
    position = {
      top: rect.bottom + 6,
      right: Math.max(8, window.innerWidth - rect.right),
    }
  }

  $effect(() => {
    if (!open) return
    recomputePosition()
    window.addEventListener('resize', recomputePosition)
    window.addEventListener('scroll', recomputePosition, true)
    return () => {
      window.removeEventListener('resize', recomputePosition)
      window.removeEventListener('scroll', recomputePosition, true)
    }
  })

  function fileName(p: string): string {
    const i = p.lastIndexOf('/')
    return i === -1 ? p : p.slice(i + 1)
  }

  function fileDir(p: string): string {
    const i = p.lastIndexOf('/')
    return i === -1 ? '' : p.slice(0, i)
  }

  function rangeLabel(c: DiffComment): string {
    return c.startLine === c.endLine ? `L${c.startLine}` : `L${c.startLine}–L${c.endLine}`
  }

  type Entry =
    | { kind: 'comment'; comment: DiffComment }
    | { kind: 'thread'; thread: ReviewThread }

  // Merge local comments and review threads into one list grouped by file,
  // preserving first-seen path order (comments first, then threads).
  const grouped = $derived.by((): { path: string; entries: Entry[] }[] => {
    const map = new Map<string, Entry[]>()
    const push = (path: string, entry: Entry) => {
      if (!map.has(path)) map.set(path, [])
      map.get(path)!.push(entry)
    }
    for (const comment of comments) push(comment.filePath, { kind: 'comment', comment })
    for (const thread of threads) push(thread.filePath, { kind: 'thread', thread })
    return Array.from(map, ([path, entries]) => ({ path, entries }))
  })

  function handleSelectComment(c: DiffComment) {
    onNavigate(c)
    onClose()
  }

  function handleSelectThread(t: ReviewThread) {
    onNavigateThread?.(t)
    onClose()
  }

  function handleKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
    }
  }
</script>

{#if open && layer.el && position}
  <div
    bind:this={popoverEl}
    use:portal={layer.el}
    role="dialog"
    aria-label="Diff comments"
    tabindex="-1"
    onkeydown={handleKey}
    transition:fly={{ y: -4, duration: 140, opacity: 0 }}
    class="flex flex-col overflow-hidden rounded-xl border border-(--solus-popover-border)"
    style="position:fixed;top:{position.top}px;right:{position.right}px;width:20rem;max-height:min(27.5rem, 70vh);backdrop-filter:blur(1.5rem);-webkit-backdrop-filter:blur(1.5rem);background:var(--solus-popover-bg);box-shadow:var(--solus-popover-shadow);z-index:9000;"
  >
    <div
      class="flex items-center justify-between px-3 py-2 border-b border-(--solus-popover-border)"
    >
      <div class="flex items-center gap-1.5">
        <ChatCircleTextIcon size={11} class="text-(--solus-accent)" weight="fill" />
        <span class="text-[0.6875rem] font-medium text-(--solus-text-primary)">
          Comments
        </span>
        <span
          class="text-[0.625rem] text-(--solus-text-tertiary)"
          style="font-variant-numeric:tabular-nums"
        >
          · {totalCount}
        </span>
      </div>
      <button
        type="button"
        onclick={onClose}
        aria-label="Close comments"
        class="relative flex h-5 w-5 cursor-pointer items-center justify-center rounded text-(--solus-text-tertiary) transition-colors hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
      >
        <span class="absolute top-1/2 left-1/2 size-[max(100%,2.75rem)] -translate-1/2 pointer-fine:hidden" aria-hidden="true"></span>
        <XIcon size={11} />
      </button>
    </div>

    {#if totalCount === 0}
      <div class="flex-1 flex items-center justify-center px-4 py-6">
        <span class="text-[0.6875rem] text-(--solus-text-tertiary)">
          No comments yet
        </span>
      </div>
    {:else}
      <div class="flex-1 overflow-y-auto" style="scrollbar-width:thin">
        {#each grouped as group (group.path)}
          <div class="border-t border-(--solus-popover-border) first:border-t-0">
            <div
              class="sticky top-0 px-3 py-1.5 flex items-baseline gap-1.5"
              style="background:var(--solus-popover-bg);z-index:1"
            >
              <span
                class="text-[0.6563rem] font-medium text-(--solus-text-secondary) truncate"
                style="font-family:{MONO_FONT}"
              >
                {fileName(group.path)}
              </span>
              {#if fileDir(group.path)}
                <span
                  class="text-[0.625rem] text-(--solus-text-tertiary) truncate min-w-0"
                  style="font-family:{MONO_FONT}"
                >
                  {fileDir(group.path)}
                </span>
              {/if}
              <span class="flex-1"></span>
              <span
                class="text-[0.625rem] text-(--solus-text-tertiary)"
                style="font-variant-numeric:tabular-nums"
              >
                {group.entries.length}
              </span>
            </div>
            {#each group.entries as entry (entry.kind === 'comment' ? entry.comment.id : entry.thread.id)}
              {#if entry.kind === 'comment'}
                <button
                  type="button"
                  onclick={() => handleSelectComment(entry.comment)}
                  class="flex w-full cursor-pointer flex-col gap-0.5 border-t border-(--solus-popover-border) px-3 py-2 text-left transition-colors first:border-t-0 hover:bg-(--solus-surface-hover) focus-visible:bg-(--solus-accent-light) focus-visible:outline-none"
                >
                  <span
                    class="text-[0.625rem] font-medium text-(--solus-accent)"
                    style="font-family:{MONO_FONT};font-variant-numeric:tabular-nums"
                  >
                    {rangeLabel(entry.comment)}
                  </span>
                  <p
                    class="text-[0.6563rem] text-(--solus-text-primary) leading-snug line-clamp-2"
                  >
                    {entry.comment.comment}
                  </p>
                </button>
              {:else}
                <button
                  type="button"
                  onclick={() => handleSelectThread(entry.thread)}
                  class="flex w-full cursor-pointer flex-col gap-0.5 border-t border-(--solus-popover-border) px-3 py-2 text-left transition-colors first:border-t-0 hover:bg-(--solus-surface-hover) focus-visible:bg-(--solus-accent-light) focus-visible:outline-none"
                >
                  <span class="flex items-center gap-1.5">
                    <span
                      class="text-[0.625rem] font-medium text-(--solus-accent)"
                      style="font-family:{MONO_FONT};font-variant-numeric:tabular-nums"
                    >
                      L{entry.thread.line}
                    </span>
                    {#if entry.thread.isResolved}
                      <span class="inline-flex items-center gap-0.5 text-[0.5625rem] font-semibold text-(--solus-art-positive)">
                        <CheckCircleIcon size={9} weight="fill" /> Resolved
                      </span>
                    {/if}
                    <span class="flex-1"></span>
                    <span class="text-[0.5625rem] text-(--solus-text-tertiary)" style="font-variant-numeric:tabular-nums">
                      {entry.thread.comments.length} comment{entry.thread.comments.length === 1 ? '' : 's'}
                    </span>
                  </span>
                  <p
                    class="text-[0.6563rem] text-(--solus-text-primary) leading-snug line-clamp-2"
                  >
                    {entry.thread.comments[0]?.body ?? ''}
                  </p>
                </button>
              {/if}
            {/each}
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}
