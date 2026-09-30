<script lang="ts">
  import { Highlighter as HighlighterIcon } from "@lucide/svelte";
  import * as TooltipUI from "../ui/tooltip";
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
  }

  let { tokenHighlight, onToggle, shortcutHint }: Props = $props();

  const hint = $derived(shortcutHint ? ` (${shortcutHint})` : "");
</script>

<TooltipUI.Root>
  <TooltipUI.Trigger>
    {#snippet child({ props: tooltipProps })}
      <span {...tooltipProps} class="inline-flex">
        <Button
          variant="ghost"
          size="icon-sm"
          type="button"
          onclick={onToggle}
          aria-label={tokenHighlight ? "Disable token highlighting" : "Enable token highlighting"}
          aria-pressed={tokenHighlight}
          class="rounded-lg [&_svg:not([class*='size-'])]:size-3.5 pointer-coarse:size-10 {tokenHighlight
            ? 'bg-(--solus-accent-light) text-(--solus-accent) hover:bg-(--solus-accent-light) dark:hover:bg-(--solus-accent-light) hover:text-(--solus-accent)'
            : 'text-(--solus-text-tertiary)'}"
        >
          <HighlighterIcon size={14} />
        </Button>
      </span>
    {/snippet}
  </TooltipUI.Trigger>
  <TooltipUI.Content value={tokenHighlight ? `Token highlighting on${hint}` : `Token highlighting off${hint}`} />
</TooltipUI.Root>
