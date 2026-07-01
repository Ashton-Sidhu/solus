<script lang="ts">
  import { fly } from 'svelte/transition'
  import { SpinnerGapIcon } from 'phosphor-svelte'
  import { getPopoverLayer } from '../popoverLayer.svelte'
  import { portal } from '../portal'
  import type { Work } from '../../../shared/types'

  interface Props {
    works: Work[]
    isLoading?: boolean
    selectedIndex: number
    onSelect: (work: Work) => void
    anchorRect: DOMRect | null
    /** Whether the menu grows upward (above the cursor) or downward. */
    placement?: 'up' | 'down'
  }

  let { works, isLoading = false, selectedIndex, onSelect, anchorRect, placement = 'up' }: Props = $props()

  const layer = getPopoverLayer()
  const scrollThumb = `color-mix(in srgb, var(--solus-text-tertiary) 40%, transparent)`

  const WORK_ICON_PATHS = [
    'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z',
    'M14 2v6h6',
    'M16 13H8',
    'M16 17H8',
    'M10 9H8',
  ]

  let listEl: HTMLDivElement | null = $state(null)

  $effect(() => {
    if (!listEl) return
    const item = listEl.children[selectedIndex] as HTMLElement | undefined
    item?.scrollIntoView({ block: 'nearest' })
  })
</script>

{#if (works.length > 0 || isLoading) && anchorRect && layer.el}
  <div
    use:portal={layer.el}
    transition:fly={{ y: placement === 'down' ? 3 : -3, duration: 80 }}
    style="position:fixed;pointer-events:auto;{placement === 'down' ? `top:${anchorRect.bottom + 4}px` : `bottom:${window.innerHeight - anchorRect.top + 4}px`};left:{anchorRect.left + 12}px;right:{window.innerWidth - anchorRect.right + 12}px"
  >
    <div
      bind:this={listEl}
      class="overflow-y-auto rounded-xl border border-(--solus-popover-border) bg-(--solus-popover-bg) py-0.5 [&::-webkit-scrollbar]:w-[0.1875rem] [&::-webkit-scrollbar-thumb]:rounded [&::-webkit-scrollbar-thumb]:bg-(--scroll-thumb) [&::-webkit-scrollbar-track]:bg-transparent"
      style="max-height:12.25rem;backdrop-filter:blur(1.25rem);box-shadow:var(--solus-popover-shadow);--scroll-thumb:{scrollThumb}"
    >
      {#if isLoading && works.length === 0}
        <div class="flex items-center gap-2 px-3 py-[0.4375rem] text-(--solus-text-tertiary)">
          <SpinnerGapIcon size={13} class="animate-spin flex-shrink-0" />
          <span class="text-[0.75rem]">Loading works...</span>
        </div>
      {:else}
        {#each works as work, i (work.id)}
          {@const isSelected = i === selectedIndex}
          <button
            onclick={() => onSelect(work)}
            class="w-full flex items-center gap-2 px-3 py-[0.3125rem] text-left hover:bg-(--solus-accent-light)"
            style="background:{isSelected ? 'var(--solus-accent-light)' : 'transparent'};box-shadow:{isSelected ? 'inset 0.125rem 0 0 var(--solus-accent)' : 'none'}"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="flex-shrink-0 w-[0.8125rem] h-[0.8125rem]"
              style="stroke:var(--solus-work-token);stroke-width:2.2"
            >
              {#each WORK_ICON_PATHS as d}
                <path {d} />
              {/each}
            </svg>
            <div class="min-w-0 flex-1 flex items-baseline gap-1.5 overflow-hidden">
              <span class="text-[0.75rem] font-medium shrink-0 truncate {isSelected ? 'text-(--solus-accent)' : 'text-(--solus-text-primary)'}" style="max-width:70%">
                {work.title}
              </span>
              <span class="text-[0.625rem] font-mono truncate text-(--solus-text-tertiary)">
                {work.type}
              </span>
            </div>
          </button>
        {/each}
      {/if}
    </div>
  </div>
{/if}
