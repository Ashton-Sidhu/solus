<script lang="ts">
  import {
    PanelLeftOpen as OpenPrimaryPaneIcon,
    PanelRightOpen as OpenCompanionPaneIcon,
  } from "@lucide/svelte";
  import { PAGE_ICON_BTN } from "../../lib/page-chrome";
  import * as TooltipUI from "@solus/workspace-ui/components/ui/tooltip";

  /** The one control that moves a surface between the leading pane and the
   *  companion beside it. It is a single button, not a pair: the direction is
   *  already decided by where the surface currently sits, so the label names
   *  where the click sends it. Page headers use "Open as page"; pane chrome
   *  names the actual pane move instead. */
  interface Props {
    /** Whether the surface leads the row — the only positional fact the control
     *  needs to name its direction. */
    isLeading?: boolean;
    onMove: () => void;
    iconSize?: number;
    /** What the surface becomes when it moves back to the leading pane. */
    leadingDestination?: "page" | "pane";
    /** Override the chrome when the host row has its own button recipe. */
    class?: string;
  }

  let {
    isLeading = true,
    onMove,
    iconSize = 15,
    leadingDestination = "page",
    class: className = PAGE_ICON_BTN,
  }: Props = $props();

  const label = $derived(
    isLeading
      ? "Open in split"
      : leadingDestination === "page"
        ? "Open as page"
        : "Move to primary pane",
  );
</script>

<TooltipUI.Root>
  <TooltipUI.Trigger>
    {#snippet child({ props })}
      <button
        {...props}
        type="button"
        class={className}
        onclick={onMove}
        data-testid={isLeading
          ? "open-in-split"
          : leadingDestination === "page"
            ? "open-as-page"
            : "move-to-primary-pane"}
        aria-label={label}
      >
        {#if isLeading}
          <OpenCompanionPaneIcon size={iconSize} />
        {:else}
          <OpenPrimaryPaneIcon size={iconSize} />
        {/if}
      </button>
    {/snippet}
  </TooltipUI.Trigger>
  <TooltipUI.Content value={label} />
</TooltipUI.Root>
