<script lang="ts">
  import { Highlighter as HighlighterIcon } from "@lucide/svelte";
  import * as TooltipUI from "../ui/tooltip";
  import { PAGE_PILL_ICON_BTN, PAGE_SOFT_ICON_BTN } from "../../lib/page-chrome";
  import { Button } from "../ui/button";

  /**
   * Word-level highlighting inside a changed line, on or off. The diff panel's
   * toolbar and the Insights result both draw it; the key hint is the panel's.
   */
  interface Props {
    tokenHighlight: boolean;
    onToggle: () => void;
    /** The shortcut named in the tooltip, where the surface binds one. */
    shortcutHint?: string;
    /** Sits inside a PAGE_PILL_GROUP rather than standing alone. */
    inPill?: boolean;
  }

  let { tokenHighlight, onToggle, shortcutHint, inPill = false }: Props = $props();

  const hint = $derived(shortcutHint ? ` (${shortcutHint})` : "");
</script>

<TooltipUI.Root>
  <TooltipUI.Trigger>
    {#snippet child({ props: tooltipProps })}
      {#if inPill}
      <Button
        {...tooltipProps}
        variant="ghost"
        size="icon-sm"
        onclick={onToggle}
        aria-label={tokenHighlight ? "Disable token highlighting" : "Enable token highlighting"}
        aria-pressed={tokenHighlight}
        class={PAGE_PILL_ICON_BTN}
      >
        <HighlighterIcon strokeWidth={1.5} class="size-4" />
      </Button>
      {:else}
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
      {/if}
    {/snippet}
  </TooltipUI.Trigger>
  <TooltipUI.Content value={tokenHighlight ? `Token highlighting on${hint}` : `Token highlighting off${hint}`} />
</TooltipUI.Root>
