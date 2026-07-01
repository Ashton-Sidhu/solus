<script lang="ts">
  import type { LayoutDirection } from '../../../shared/diagram-layout'
  import PopoverMenu from './PopoverMenu.svelte'

  interface Props {
    onLayout: (direction: LayoutDirection) => void
    current: LayoutDirection | null
  }

  let { onLayout, current }: Props = $props()

  // Each option pairs a dagre direction with a label and an arrow path that
  // points the way the graph will flow.
  const OPTIONS: { dir: LayoutDirection; label: string; arrow: string }[] = [
    { dir: 'LR', label: 'Horizontal', arrow: 'M3 8h10M9 4l4 4-4 4' },
    { dir: 'TB', label: 'Vertical', arrow: 'M8 3v10M4 9l4 4 4-4' },
    { dir: 'RL', label: 'Right to left', arrow: 'M13 8H3M7 4L3 8l4 4' },
    { dir: 'BT', label: 'Bottom to top', arrow: 'M8 13V3M4 7l4-4 4 4' },
  ]
</script>

<PopoverMenu title="Arrange layout" ariaLabel="Arrange layout" minWidth="10rem">
  {#snippet icon()}
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <rect x="2" y="6" width="4" height="4" rx="1" />
      <rect x="10" y="2.5" width="4" height="4" rx="1" />
      <rect x="10" y="9.5" width="4" height="4" rx="1" />
      <path d="M6 8h2.5M8.5 8V4.5H10M8.5 8v3.5H10" />
    </svg>
  {/snippet}

  {#snippet children(close)}
    {#each OPTIONS as opt (opt.dir)}
      <button
        type="button"
        class="popover__item"
        class:text-(--solus-text-primary)={current === opt.dir}
        role="menuitemradio"
        aria-checked={current === opt.dir}
        onclick={() => {
          onLayout(opt.dir)
          close()
        }}
      >
        <svg class="shrink-0 fill-none stroke-current stroke-[1.5] [stroke-linecap:round] [stroke-linejoin:round]" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d={opt.arrow} />
        </svg>
        <span class="flex-1">{opt.label}</span>
        {#if current === opt.dir}
          <svg class="shrink-0 fill-none stroke-(--solus-accent) stroke-[1.8] [stroke-linecap:round] [stroke-linejoin:round]" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <path d="M3.5 8.5l3 3 6-7" />
          </svg>
        {/if}
      </button>
    {/each}
  {/snippet}
</PopoverMenu>
