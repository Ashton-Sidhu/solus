<script lang="ts">
  import { fly } from 'svelte/transition'
  import { getPopoverLayer } from '../popoverLayer.svelte'
  import { portal } from '../portal'
  import type { EditorBlockCommand } from './slashCommands'

  interface Props {
    commands: EditorBlockCommand[]
    selectedIndex: number
    onSelect: (cmd: EditorBlockCommand) => void
    onHover: (index: number) => void
    anchorCoords: { left: number; top: number; bottom: number }
  }

  let { commands, selectedIndex, onSelect, onHover, anchorCoords }: Props = $props()

  const layer = getPopoverLayer()
  let listEl: HTMLDivElement | null = $state(null)

  $effect(() => {
    if (!listEl) return
    const buttons = listEl.querySelectorAll('button')
    const btn = buttons[selectedIndex] as HTMLElement | undefined
    btn?.scrollIntoView({ block: 'nearest' })
  })

  const scrollThumb = `color-mix(in srgb, var(--solus-text-tertiary) 40%, transparent)`

  const posStyle = $derived.by(() => {
    const spaceBelow = window.innerHeight - anchorCoords.bottom
    if (spaceBelow >= 200) {
      return `position:fixed;top:${anchorCoords.bottom + 4}px;left:${anchorCoords.left}px`
    }
    return `position:fixed;bottom:${window.innerHeight - anchorCoords.top + 4}px;left:${anchorCoords.left}px`
  })
</script>

{#if layer.el}
  <div
    use:portal={layer.el}
    transition:fly={{ y: 4, duration: 140, opacity: 0 }}
    style={posStyle}
  >
    <div
      bind:this={listEl}
      class="slash-block-menu overflow-y-auto rounded-xl py-1.5 px-1 bg-(--solus-popover-bg) border border-(--solus-popover-border)"
      style="max-height:17.5rem;min-width:13.75rem;backdrop-filter:blur(1.25rem) saturate(1.1);-webkit-backdrop-filter:blur(1.25rem) saturate(1.1);box-shadow:var(--solus-popover-shadow);--scroll-thumb:{scrollThumb}"
    >
      {#each commands as cmd, i (cmd.id)}
        {#if i > 0 && cmd.group !== commands[i - 1].group}
          <div class="mx-1.5 my-1 h-px bg-(--solus-container-border)"></div>
        {/if}
        {@const isSelected = i === selectedIndex}
        {@const Comp = cmd.icon}
        <button
          onclick={() => onSelect(cmd)}
          onmouseenter={() => onHover(i)}
          class="slash-block-menu__item"
          class:slash-block-menu__item--selected={isSelected}
        >
          <span class="slash-block-menu__icon">
            <Comp size={14} />
          </span>
          <div class="min-w-0 flex-1">
            <div class="slash-block-menu__label">{cmd.label}</div>
            <div class="text-[0.625rem] truncate leading-tight text-(--solus-text-tertiary)">
              {cmd.description}
            </div>
          </div>
        </button>
      {/each}
    </div>
  </div>
{/if}

<style>
  .slash-block-menu::-webkit-scrollbar {
    width: 0.1875rem;
  }
  .slash-block-menu::-webkit-scrollbar-track {
    background: transparent;
  }
  .slash-block-menu::-webkit-scrollbar-thumb {
    background: var(--scroll-thumb);
    border-radius: 0.25rem;
  }
  .slash-block-menu__item {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.375rem 0.5625rem;
    border-radius: 0.375rem;
    text-align: left;
    background: transparent;
    border: none;
    cursor: pointer;
    transition: background var(--duration-quick, 120ms) var(--ease-premium, cubic-bezier(0.16, 1, 0.3, 1)),
                color var(--duration-quick, 120ms) var(--ease-premium, cubic-bezier(0.16, 1, 0.3, 1));
  }
  .slash-block-menu__item:hover {
    background: var(--solus-surface-hover);
  }
  .slash-block-menu__item--selected,
  .slash-block-menu__item--selected:hover {
    background: var(--solus-accent-light);
  }
  .slash-block-menu__icon {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    color: var(--solus-text-tertiary);
    transition: color var(--duration-quick, 120ms) var(--ease-premium, cubic-bezier(0.16, 1, 0.3, 1));
  }
  .slash-block-menu__item--selected .slash-block-menu__icon {
    color: var(--solus-accent);
  }
  .slash-block-menu__label {
    font-size: 0.75rem;
    font-weight: 500;
    line-height: 1.25;
    color: var(--solus-text-primary);
    transition: color var(--duration-quick, 120ms) var(--ease-premium, cubic-bezier(0.16, 1, 0.3, 1));
  }
  .slash-block-menu__item--selected .slash-block-menu__label {
    color: var(--solus-accent);
  }

  @media (prefers-reduced-motion: reduce) {
    .slash-block-menu__item,
    .slash-block-menu__icon,
    .slash-block-menu__label {
      transition: none !important;
    }
  }
</style>
