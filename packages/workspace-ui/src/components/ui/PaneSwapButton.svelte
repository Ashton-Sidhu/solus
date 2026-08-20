<script lang="ts">
  import { ExternalLink as ArrowSquareOutIcon } from "@lucide/svelte";
  import { PAGE_ICON_BTN } from "../../lib/page-chrome";
  import * as TooltipUI from "@solus/workspace-ui/components/ui/tooltip";

  /** The one control that moves a surface between the leading pane and the
   *  companion beside it. It is a single button, not a pair: the direction is
   *  already decided by where the surface currently sits, so the label names
   *  where the click sends it — "Open in split" out, "Open as page" back. */
  interface Props {
    /** Whether the surface leads the row — the only positional fact the control
     *  needs to name its direction. */
    isLeading?: boolean;
    onMove: () => void;
    iconSize?: number;
    /** Override the chrome when the host row has its own button recipe. */
    class?: string;
  }

  let {
    isLeading = true,
    onMove,
    iconSize = 15,
    class: className = PAGE_ICON_BTN,
  }: Props = $props();

  const label = $derived(isLeading ? "Open in split" : "Open as page");
</script>

<TooltipUI.Root>
  <TooltipUI.Trigger>
    {#snippet child({ props })}
      <button
        {...props}
        type="button"
        class={className}
        onclick={onMove}
        data-testid={isLeading ? "open-in-split" : "open-as-page"}
        aria-label={label}
      >
        <ArrowSquareOutIcon size={iconSize} />
      </button>
    {/snippet}
  </TooltipUI.Trigger>
  <TooltipUI.Content value={label} />
</TooltipUI.Root>
