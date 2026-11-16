<script lang="ts">
  import {
    ArrowUp as ArrowUpIcon,
    ChevronLeft as CaretLeftIcon,
    ChevronRight as CaretRightIcon,
  } from "@lucide/svelte";
  import { Button } from "../ui/button";
  import { formatComboText } from "../../lib/keybindings/match";
  import type { PathCrumb } from "./lib/browse-path";

  interface Props {
    /** The folder being listed, one crumb for each level. */
    crumbs: PathCrumb[];
    canGoBack: boolean;
    canGoForward: boolean;
    canGoUp: boolean;
    onBack: () => void;
    onForward: () => void;
    onUp: () => void;
    onNavigate: (path: string) => void;
  }

  let { crumbs, canGoBack, canGoForward, canGoUp, onBack, onForward, onUp, onNavigate }: Props = $props();

  let trailEl: HTMLElement | null = $state(null);

  // The crumb trail can outgrow the field, and what matters is always its tail:
  // the folder being browsed.
  $effect(() => {
    void crumbs;
    if (trailEl) trailEl.scrollLeft = trailEl.scrollWidth;
  });
</script>

<!-- Kept out of the tab order, and a press never takes focus: the tree is
     walked with the keys below from the filter, which never loses focus. -->
<div class="-ml-1.5 flex shrink-0 items-center gap-0.5">
  <Button
    variant="ghost"
    size="icon-sm"
    tabindex={-1}
    class="text-muted-foreground"
    disabled={!canGoBack}
    onmousedown={(e) => e.preventDefault()}
    onclick={onBack}
    title={`Back (${formatComboText({ mod: true, code: "BracketLeft" })})`}
    aria-label="Back"
  >
    <CaretLeftIcon size={16} />
  </Button>
  <Button
    variant="ghost"
    size="icon-sm"
    tabindex={-1}
    class="text-muted-foreground"
    disabled={!canGoForward}
    onmousedown={(e) => e.preventDefault()}
    onclick={onForward}
    title={`Forward (${formatComboText({ mod: true, code: "BracketRight" })})`}
    aria-label="Forward"
  >
    <CaretRightIcon size={16} />
  </Button>
  <Button
    variant="ghost"
    size="icon-sm"
    tabindex={-1}
    class="text-muted-foreground"
    disabled={!canGoUp}
    onmousedown={(e) => e.preventDefault()}
    onclick={onUp}
    title="Up one folder (←)"
    aria-label="Up one folder"
  >
    <ArrowUpIcon size={16} />
  </Button>
</div>

<nav
  bind:this={trailEl}
  class="crumb-strip flex h-8 min-w-0 flex-[3_1_8rem] items-center gap-0.5 overflow-x-auto"
  aria-label="Path breadcrumbs"
>
  {#each crumbs as crumb, i (crumb.path)}
    {#if i > 0}
      <CaretRightIcon size={14} class="shrink-0 text-muted-foreground/60" />
    {/if}
    <button
      type="button"
      tabindex={-1}
      class="min-h-6 shrink-0 whitespace-nowrap rounded-[0.3125rem] px-1.5 text-[0.8125rem] outline-none
        hover:bg-muted
        {i === crumbs.length - 1 ? 'font-medium' : 'text-muted-foreground'}"
      onmousedown={(e) => e.preventDefault()}
      onclick={() => onNavigate(crumb.path)}
      title={crumb.path}
    >
      {crumb.label}
    </button>
  {/each}
</nav>

<style>
  /* The trail auto-scrolls to its tail on every path change, so a bar under it
     would only eat into the row's height — it is swiped instead. */
  .crumb-strip {
    scrollbar-width: none;
    touch-action: pan-x;
  }
  .crumb-strip::-webkit-scrollbar {
    display: none;
  }
</style>
