<script lang="ts">
  import { Columns2 as SplitIcon, Rows2 as UnifiedIcon } from "@lucide/svelte";
  import * as TooltipUI from "../ui/tooltip";
  import type { DiffStyle } from "../../lib/diff-view-preferences.svelte";

  /**
   * Stacked or side by side, as a segmented control of two icons. The active
   * one is raised, so the layout on screen reads without hovering; the name is
   * the tooltip and the accessible label. The diff panel's toolbar and the Insights
   * result both draw it.
   */
  interface Props {
    diffStyle: DiffStyle;
    onSetStyle: (style: DiffStyle) => void;
  }

  let { diffStyle, onSetStyle }: Props = $props();

  const OPTIONS = [
    { style: "unified", label: "Unified", icon: UnifiedIcon },
    { style: "split", label: "Split", icon: SplitIcon },
  ] satisfies Array<{ style: DiffStyle; label: string; icon: typeof SplitIcon }>;
</script>

<div class="view-toggle" role="group" aria-label="Diff layout">
  {#each OPTIONS as option (option.style)}
    <TooltipUI.Root>
      <TooltipUI.Trigger>
        {#snippet child({ props: tooltipProps })}
          <button
            {...tooltipProps}
            type="button"
            class="view-toggle-btn"
            class:is-active={diffStyle === option.style}
            onclick={() => onSetStyle(option.style)}
            aria-pressed={diffStyle === option.style}
            aria-label={option.label}
          >
            <option.icon size={14} aria-hidden="true" />
          </button>
        {/snippet}
      </TooltipUI.Trigger>
      <TooltipUI.Content value={option.label} />
    </TooltipUI.Root>
  {/each}
</div>

<style>
  .view-toggle {
    display: flex;
    align-items: center;
    height: 1.75rem;
    padding: 0.125rem;
    border-radius: 0.5rem;
    background: var(--solus-surface-hover);
    flex-shrink: 0;
  }
  .view-toggle-btn {
    display: inline-flex;
    align-items: center;
    height: 100%;
    padding: 0 0.4375rem;
    border: 0;
    border-radius: 0.375rem;
    background: transparent;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    transition:
      color 120ms ease,
      background-color 120ms ease;
  }
  .view-toggle-btn:hover {
    color: var(--solus-text-secondary);
  }
  .view-toggle-btn.is-active {
    background: var(--solus-container-bg);
    color: var(--solus-text-primary);
    box-shadow: 0 0.0625rem 0.125rem rgba(0, 0, 0, 0.07);
  }
  .view-toggle-btn:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.0625rem;
  }
</style>
