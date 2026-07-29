<script lang="ts">
  import type { Snippet } from "svelte";
  import {
    XIcon,
    ArrowsOutIcon,
    ArrowsInIcon,
    ArrowSquareOutIcon,
    ArrowsOutSimpleIcon,
  } from "phosphor-svelte";
  import { PAGE_ICON_BTN } from "../../lib/page-chrome";
  import * as TooltipUI from "@renderer/components/ui/tooltip";
  import FrameExpandButton from "../layout/FrameExpandButton.svelte";
  import type { PaneSlot } from "../../contexts/workspace/pane-view.store.svelte";

  /** The pane's only chrome: a floating icon cluster over the top-right of the
   *  content. Every surface below the top rail is content now, so pane-level
   *  controls (open-in-split, maximize, close) live here instead of in a
   *  per-surface header bar. Mirrors PageShell's corner chrome, and the room it
   *  occupies is published as `--solus-pane-chrome-inset` by the pane columns so
   *  an in-content top strip can reserve space for it. */
  interface Props {
    onClose: () => void;
    /** Present when the content can move between the two slots. */
    onOpenInSplit?: () => void;
    slot?: PaneSlot;
    /** Present when the pane can be maximized over the window. */
    onToggleMaximize?: (() => void) | null;
    maximized?: boolean;
    /** Surface-specific extras rendered before the shared controls. */
    trailing?: Snippet;
    closeLabel?: string;
    closeTestId?: string;
  }

  let {
    onClose,
    onOpenInSplit,
    slot = "primary",
    onToggleMaximize,
    maximized = false,
    trailing,
    closeLabel = "Close pane",
    closeTestId,
  }: Props = $props();
</script>

<!-- Pinned to the chrome row and centred inside it, not offset by a fixed inset:
     the cluster has to sit on the same optical line as whatever in-content top
     strip reserves room for it (the diff toolbar, the tab strip), and those are
     all --solus-chrome-row-h tall. A fixed top-2.5 put the 26px buttons' centre
     at 23px against the row's 20px. -->
<div
  class="no-drag absolute right-2.5 top-0 z-30 flex h-(--solus-chrome-row-h,2.5rem) items-center gap-1"
>
  {#if trailing}{@render trailing()}{/if}

  {#if onOpenInSplit}
    <TooltipUI.Root>
      <TooltipUI.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            type="button"
            class={PAGE_ICON_BTN}
            onclick={onOpenInSplit}
            data-testid="open-in-split"
            aria-label={slot === "secondary" ? "Move to main pane" : "Open in split"}
          >
            {#if slot === "secondary"}
              <ArrowsOutSimpleIcon size={15} />
            {:else}
              <ArrowSquareOutIcon size={15} />
            {/if}
          </button>
        {/snippet}
      </TooltipUI.Trigger>
      <TooltipUI.Content
        value={slot === "secondary" ? "Move to main pane" : "Open in split"}
      />
    </TooltipUI.Root>
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
      <TooltipUI.Content value={maximized ? "Restore panel (⌥M)" : "Maximize (⌥M)"} />
    </TooltipUI.Root>
  {/if}

  <FrameExpandButton variant="projectPanel" />

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
