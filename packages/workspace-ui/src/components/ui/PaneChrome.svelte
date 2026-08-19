<script lang="ts">
  import type { Snippet } from "svelte";
  import { XIcon, ArrowsOutIcon, ArrowsInIcon } from "phosphor-svelte";
  import { PAGE_ICON_BTN } from "../../lib/page-chrome";
  import { comboHint, type BindingId } from "../../lib/keybindings/manifest";
  import * as TooltipUI from "@solus/workspace-ui/components/ui/tooltip";
  import PaneSwapButton from "./PaneSwapButton.svelte";

  /** The pane's only chrome: a floating icon cluster over the top-right of the
   *  content. Every surface below the top rail is content now, so pane-level
   *  controls (open-in-split, maximize, close) live here instead of in a
   *  per-surface header bar. Mirrors PageShell's corner chrome, and the room it
   *  occupies is published as `--solus-pane-chrome-inset` by the pane columns so
   *  an in-content top strip can reserve space for it.
   *
   *  Hosts must render this AFTER the surface content, not before it. Window
   *  drag rects are collected in DOM order and applied union-then-subtract in
   *  that same order, so a `workspace-titlebar` row rendered after this cluster
   *  re-covers its no-drag holes and swallows every click as a window move. */
  interface Props {
    onClose: () => void;
    /** Present when the content can move between panes. */
    onOpenInSplit?: () => void;
    /** Whether this pane leads the row — the only positional fact the chrome
     *  needs, so the move action can name its direction. */
    isLeading?: boolean;
    /** Present when the pane can be maximized over the window. */
    onToggleMaximize?: (() => void) | null;
    maximized?: boolean;
    /** The binding the tooltip names. Defaults to the shared pane key; a surface
     *  whose own scope claims that key passes its own binding instead, so the
     *  tooltip never names a key that does something else in this pane. */
    maximizeBinding?: BindingId;
    /** Surface-specific extras rendered before the shared controls. */
    trailing?: Snippet;
    closeLabel?: string;
    closeTestId?: string;
  }

  let {
    onClose,
    onOpenInSplit,
    isLeading = true,
    onToggleMaximize,
    maximized = false,
    maximizeBinding = "pane.maximize",
    trailing,
    closeLabel = "Close pane",
    closeTestId,
  }: Props = $props();

  const maximizeHint = $derived(comboHint(maximizeBinding));
  const maximizeTooltip = $derived(
    `${maximized ? "Restore panel" : "Maximize"}${maximizeHint ? ` (${maximizeHint})` : ""}`,
  );
</script>

<!-- Pinned to the chrome row and centred inside it, not offset by a fixed inset:
     the cluster has to sit on the same optical line as whatever in-content top
     strip reserves room for it (the diff toolbar, the tab strip), and those are
     all --solus-chrome-row-h tall. A fixed top-2.5 put the 26px buttons' centre
     at 23px against the row's 20px. -->
<div
  class="no-drag pointer-events-auto absolute right-2.5 top-0 z-30 flex h-(--solus-chrome-row-h,2.5rem) items-center gap-1"
>
  {#if trailing}{@render trailing()}{/if}

  {#if onOpenInSplit}
    <PaneSwapButton {isLeading} onMove={onOpenInSplit} />
  {/if}

  {#if onToggleMaximize}
    <TooltipUI.Root>
      <TooltipUI.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            type="button"
            class={PAGE_ICON_BTN}
            onclick={onToggleMaximize}
            aria-label={maximized ? "Restore panel size" : "Maximize panel"}
          >
            {#if maximized}
              <ArrowsInIcon size={15} />
            {:else}
              <ArrowsOutIcon size={15} />
            {/if}
          </button>
        {/snippet}
      </TooltipUI.Trigger>
      <TooltipUI.Content value={maximizeTooltip} />
    </TooltipUI.Root>
  {/if}

  <button
    type="button"
    class={PAGE_ICON_BTN}
    onclick={onClose}
    aria-label={closeLabel}
    data-testid={closeTestId}
  >
    <XIcon size={16} />
  </button>
</div>
