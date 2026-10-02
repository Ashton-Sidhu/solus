<script lang="ts">
  import { Highlighter as HighlighterIcon } from "@lucide/svelte";
  import * as TooltipUI from "../ui/tooltip";
  import { PAGE_SOFT_ICON_BTN } from "../../lib/page-chrome";

  /**
   * Word-level highlighting inside a changed line, on or off. The diff panel's
   * toolbar and the Insights result both draw it; the key hint is the panel's.
   */
  interface Props {
    tokenHighlight: boolean;
    onToggle: () => void;
    /** The shortcut named in the tooltip, where the surface binds one. */
    shortcutHint?: string;
  }

  let { tokenHighlight, onToggle, shortcutHint }: Props = $props();

  const hint = $derived(shortcutHint ? ` (${shortcutHint})` : "");
</script>

<TooltipUI.Root>
  <TooltipUI.Trigger>
    {#snippet child({ props: tooltipProps })}
      <button
        {...tooltipProps}
        type="button"
        onclick={onToggle}
        aria-label={tokenHighlight ? "Disable token highlighting" : "Enable token highlighting"}
        aria-pressed={tokenHighlight}
        class="{PAGE_SOFT_ICON_BTN} {tokenHighlight ? 'bg-[var(--wash-3)]! text-foreground!' : ''}"
      >
        <HighlighterIcon size={15} strokeWidth={1.5} />
      </button>
    {/snippet}
  </TooltipUI.Trigger>
  <TooltipUI.Content value={tokenHighlight ? `Token highlighting on${hint}` : `Token highlighting off${hint}`} />
</TooltipUI.Root>
