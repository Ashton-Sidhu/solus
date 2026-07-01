<script lang="ts">
  import { fly } from 'svelte/transition'
  import { SpinnerGapIcon } from 'phosphor-svelte'
  import { getPopoverLayer } from '../popoverLayer.svelte'
  import { portal } from '../portal'
  import type { PlanDescriptor } from '../../../shared/types'

  interface Props {
    plans: PlanDescriptor[]
    isLoading?: boolean
    selectedIndex: number
    onSelect: (descriptor: PlanDescriptor) => void
    anchorRect: DOMRect | null
    /** Whether the menu grows upward (above the cursor) or downward. */
    placement?: 'up' | 'down'
  }

  let { plans, isLoading = false, selectedIndex, onSelect, anchorRect, placement = 'up' }: Props = $props()

  const layer = getPopoverLayer()

  let listEl: HTMLDivElement | null = $state(null)

  $effect(() => {
    if (!listEl) return
    const item = listEl.children[selectedIndex] as HTMLElement | undefined
    item?.scrollIntoView({ block: 'nearest' })
  })

  const STATUS_COLORS: Record<string, string> = {
    pending: 'var(--solus-accent)',
    accepted: 'var(--solus-status-complete)',
    rejected: 'var(--solus-text-tertiary)',
  }

  const scrollThumb = `color-mix(in srgb, var(--solus-text-tertiary) 40%, transparent)`

  // list-checks / check / x — mirrors TOKEN_ICONS in tokenStyle.ts
  const STATUS_ICON_PATHS: Record<string, string[]> = {
    pending: ['m3 17 2 2 4-4', 'm3 7 2 2 4-4', 'M13 6h8', 'M13 12h8', 'M13 18h8'],
    accepted: ['M20 6 9 17l-5-5'],
    rejected: ['M18 6 6 18', 'm6 6 12 12'],
  }
</script>

{#if (plans.length > 0 || isLoading) && anchorRect && layer.el}
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
      {#if isLoading && plans.length === 0}
        <div class="flex items-center gap-2 px-3 py-[0.4375rem] text-(--solus-text-tertiary)">
          <SpinnerGapIcon size={13} class="animate-spin flex-shrink-0" />
          <span class="text-[0.75rem]">Loading plans...</span>
        </div>
      {:else}
        {#each plans as plan, i (plan.planToolUseId)}
          {@const isSelected = i === selectedIndex}
          <button
            onclick={() => onSelect(plan)}
            class="w-full flex items-center gap-2 px-3 py-[0.3125rem] text-left hover:bg-(--solus-accent-light)"
            style="background:{isSelected ? 'var(--solus-accent-light)' : 'transparent'};box-shadow:{isSelected ? 'inset 0.125rem 0 0 var(--solus-accent)' : 'none'}"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="flex-shrink-0 w-[0.8125rem] h-[0.8125rem]"
              style="stroke:{STATUS_COLORS[plan.status] ?? 'var(--solus-text-tertiary)'};stroke-width:2.2"
            >
              {#each STATUS_ICON_PATHS[plan.status] ?? STATUS_ICON_PATHS.pending as d}
                <path {d} />
              {/each}
            </svg>
            <div class="min-w-0 flex-1 flex items-baseline gap-1.5 overflow-hidden">
              <span class="text-[0.75rem] font-medium shrink-0 truncate {isSelected ? 'text-(--solus-accent)' : 'text-(--solus-text-primary)'}" style="max-width:70%">
                {plan.title}
              </span>
              <span class="text-[0.625rem] font-mono truncate text-(--solus-text-tertiary)">
                {plan.status}
              </span>
            </div>
          </button>
        {/each}
      {/if}
    </div>
  </div>
{/if}
