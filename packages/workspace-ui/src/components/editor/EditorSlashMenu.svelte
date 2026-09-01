<script lang="ts">
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
    const buttons = listEl.querySelectorAll<HTMLButtonElement>('button')
    const btn = buttons[selectedIndex]
    btn?.scrollIntoView({ block: 'nearest' })
  })

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
    class="z-30"
    style={posStyle}
  >
    <div
      bind:this={listEl}
      role="listbox"
      class="menu-surface slash-block-menu text-workspace-chrome max-h-[17.5rem] w-[15.75rem] max-w-[calc(100vw-1rem)] overflow-y-auto p-1.5 font-(family-name:--solus-font-family) pointer-fine:[.is-laptop-display_&]:max-h-60 pointer-fine:[.is-laptop-display_&]:w-56 pointer-fine:[.is-laptop-display_&]:rounded-xl pointer-fine:[.is-laptop-display_&]:p-1"
    >
      {#each commands as cmd, i (cmd.id)}
        {#if i > 0 && cmd.group !== commands[i - 1].group}
          <div class="mx-1.5 my-1 h-px bg-(--solus-menu-hairline)"></div>
        {/if}
        {@const isSelected = i === selectedIndex}
        {@const Comp = cmd.icon}
        <button
          type="button"
          role="option"
          aria-selected={isSelected}
          data-selected={isSelected ? true : undefined}
          onclick={() => onSelect(cmd)}
          onmouseenter={() => onHover(i)}
          class="menu-row slash-block-menu__item"
          class:slash-block-menu__item--accent={cmd.accent}
        >
          <span class="slash-block-menu__icon">
            <Comp size={14} />
          </span>
          <div class="min-w-0 flex-1">
            <div class="slash-block-menu__label">{cmd.label}</div>
            <div class="truncate text-[0.875em] leading-tight text-(--solus-text-tertiary)">
              {cmd.description}
            </div>
          </div>
        </button>
      {/each}
    </div>
  </div>
{/if}

<style>
  .slash-block-menu__item {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.375rem 0.5625rem;
    border-radius: 0.4375rem;
    text-align: left;
    background: transparent;
    border: none;
    cursor: pointer;
  }
  .slash-block-menu__icon {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    color: var(--solus-text-tertiary);
    transition: color var(--duration-quick, 120ms) var(--ease-premium, cubic-bezier(0.16, 1, 0.3, 1));
  }
  .slash-block-menu__item[data-selected] .slash-block-menu__icon {
    color: var(--solus-text-secondary);
  }
  .slash-block-menu__label {
    font-size: inherit;
    font-weight: 500;
    line-height: 1.25;
    color: var(--solus-text-primary);
    transition: color var(--duration-quick, 120ms) var(--ease-premium, cubic-bezier(0.16, 1, 0.3, 1));
  }
  .slash-block-menu__item[data-selected] .slash-block-menu__label {
    color: var(--solus-text-primary);
  }
  /* The one entry that reaches the agent rather than inserting a block reads
     accent even when it isn't the selected row. */
  .slash-block-menu__item--accent .slash-block-menu__label,
  .slash-block-menu__item--accent .slash-block-menu__icon {
    color: var(--solus-accent);
  }

  @media (pointer: fine) {
    :global(.is-laptop-display) .slash-block-menu__item {
      gap: 0.5rem;
      min-height: 2rem;
      padding: 0.25rem 0.4375rem;
    }

    :global(.is-laptop-display) .slash-block-menu__icon :global(svg) {
      width: 0.8125rem;
      height: 0.8125rem;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .slash-block-menu__item,
    .slash-block-menu__icon,
    .slash-block-menu__label {
      transition: none !important;
    }
  }
</style>
