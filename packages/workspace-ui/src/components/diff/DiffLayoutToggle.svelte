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
    /** Sits inside a PAGE_PILL_GROUP: a raised pill on a raised pill does not
     *  read, so the active one takes the pill's pressed wash instead. */
    inPill?: boolean;
  }

  let { diffStyle, onSetStyle, inPill = false }: Props = $props();

  const OPTIONS = [
    { style: "unified", label: "Unified", icon: UnifiedIcon },
    { style: "split", label: "Split", icon: SplitIcon },
  ] satisfies Array<{ style: DiffStyle; label: string; icon: typeof SplitIcon }>;
</script>

<div class="view-toggle" class:in-pill={inPill} role="group" aria-label="Diff layout">
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
            <option.icon size={15} strokeWidth={1.5} aria-hidden="true" />
          </button>
        {/snippet}
      </TooltipUI.Trigger>
      <TooltipUI.Content value={option.label} />
    </TooltipUI.Root>
  {/each}
</div>

<style>
  /* No track behind the pair: the raised active pill carries the cue. */
  .view-toggle {
    display: flex;
    align-items: center;
    gap: 0.125rem;
    height: 1.625rem;
    flex-shrink: 0;
  }
  .view-toggle-btn {
    display: inline-flex;
    align-items: center;
    height: 100%;
    padding: 0 0.5rem;
    border: 0;
    border-radius: 9999px;
    background: transparent;
    color: var(--muted-foreground);
    cursor: pointer;
    transition:
      color 120ms ease,
      background-color 120ms ease;
  }
  .view-toggle-btn:hover {
    background: var(--wash-1);
    color: var(--foreground);
  }
  .view-toggle-btn.is-active {
    background: var(--background);
    color: var(--foreground);
    font-weight: 500;
    box-shadow:
      0 0 0 0.5px color-mix(in oklch, var(--foreground) 5%, transparent),
      0 1px 6px color-mix(in oklch, var(--foreground) 6%, transparent);
  }
  .view-toggle-btn.is-active:hover {
    background: var(--wash-1);
  }
  .in-pill {
    height: 1.75rem;
  }
  .in-pill .view-toggle-btn {
    width: 1.75rem;
    justify-content: center;
    padding: 0;
    color: color-mix(in oklch, var(--foreground) 75%, transparent);
  }
  .in-pill .view-toggle-btn.is-active {
    background: var(--wash-3);
    font-weight: inherit;
    box-shadow: none;
  }
  .view-toggle-btn:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.0625rem;
  }
</style>
