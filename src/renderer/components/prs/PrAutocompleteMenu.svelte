<script lang="ts">
  import { fly } from 'svelte/transition'
  import { GitPullRequestIcon, SpinnerGapIcon } from 'phosphor-svelte'
  import { getPopoverLayer } from '../popoverLayer.svelte'
  import { portal } from '../portal'
  import type { PullRequestSummary } from '../../../shared/providers'

  interface Props {
    pullRequests: PullRequestSummary[]
    isLoading?: boolean
    selectedIndex: number
    onSelect: (pullRequest: PullRequestSummary) => void
    anchorRect: DOMRect | null
    placement?: 'up' | 'down'
  }

  let {
    pullRequests,
    isLoading = false,
    selectedIndex,
    onSelect,
    anchorRect,
    placement = 'up',
  }: Props = $props()

  const layer = getPopoverLayer()
  const scrollThumb = `color-mix(in srgb, var(--solus-text-tertiary) 40%, transparent)`
  let listEl: HTMLDivElement | null = $state(null)

  $effect(() => {
    if (!listEl) return
    const item = listEl.children[selectedIndex] as HTMLElement | undefined
    item?.scrollIntoView({ block: 'nearest' })
  })
</script>

{#if (pullRequests.length > 0 || isLoading) && anchorRect && layer.el}
  <div
    use:portal={layer.el}
    transition:fly={{ y: placement === 'down' ? 3 : -3, duration: 80 }}
    style="position:fixed;pointer-events:auto;{placement === 'down' ? `top:${anchorRect.bottom + 4}px` : `bottom:${window.innerHeight - anchorRect.top + 4}px`};left:{anchorRect.left + 12}px;right:{window.innerWidth - anchorRect.right + 12}px"
  >
    <div
      bind:this={listEl}
      role="listbox"
      aria-label="Pull requests"
      class="pr-menu-list overflow-y-auto rounded-xl border border-(--solus-popover-border) bg-(--solus-popover-bg) py-0.5 [&::-webkit-scrollbar]:w-[0.1875rem] [&::-webkit-scrollbar-thumb]:rounded [&::-webkit-scrollbar-thumb]:bg-(--scroll-thumb) [&::-webkit-scrollbar-track]:bg-transparent"
      style="max-height:12.25rem;backdrop-filter:blur(1.25rem);box-shadow:var(--solus-popover-shadow);--scroll-thumb:{scrollThumb}"
    >
      {#if isLoading && pullRequests.length === 0}
        <div class="flex items-center gap-2 px-3 py-[0.4375rem] text-(--solus-text-tertiary)">
          <SpinnerGapIcon size={13} class="animate-spin flex-shrink-0" />
          <span class="text-[0.75rem]">Loading pull requests...</span>
        </div>
      {:else}
        {#each pullRequests as pullRequest, index (pullRequest.number)}
          {@const isSelected = index === selectedIndex}
          <button
            type="button"
            role="option"
            onclick={() => onSelect(pullRequest)}
            aria-selected={isSelected}
            class="pr-menu-row flex w-full items-center gap-2 px-3 py-[0.3125rem] text-left hover:bg-(--solus-surface-hover)"
            style="background:{isSelected ? 'var(--solus-accent-light)' : 'transparent'};box-shadow:{isSelected ? 'inset 0.125rem 0 0 var(--solus-accent)' : 'none'}"
          >
            <GitPullRequestIcon
              size={13}
              weight="bold"
              class="shrink-0 text-(--solus-accent)"
            />
            <div class="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden">
              <span class="shrink-0 font-mono text-[0.625rem] text-(--solus-text-tertiary)">
                #{pullRequest.number}
              </span>
              <span class="truncate text-[0.75rem] font-medium {isSelected ? 'text-(--solus-accent)' : 'text-(--solus-text-primary)'}">
                {pullRequest.title}
              </span>
              <span class="ml-auto shrink-0 truncate text-[0.625rem] text-(--solus-text-tertiary)">
                {pullRequest.author}
              </span>
            </div>
          </button>
        {/each}
      {/if}
    </div>
  </div>
{/if}
