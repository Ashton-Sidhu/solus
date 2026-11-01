<script lang="ts">
  import { ArrowLeft, ArrowRight } from "@lucide/svelte";
  import { getWorkspaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { comboHint } from "../../lib/keybindings/manifest";
  import { Button } from "../ui/button";
  import * as TooltipUI from "../ui/tooltip";

  // Back and forward through the workspace's route history: the same history
  // the shortcuts, the mouse side buttons, and the trackpad swipe drive.
  const router = getWorkspaceContext().router;
</script>

<TooltipUI.Root>
  <TooltipUI.Trigger>
    {#snippet child({ props })}
      <!-- The span stays hoverable while the button is disabled. -->
      <span {...props} class="inline-flex shrink-0">
        <Button
          variant="ghost"
          size="icon-xs"
          class="text-(--solus-text-tertiary) hover:text-(--solus-text-primary)"
          aria-label="Go back"
          disabled={!router.canGoBack}
          onclick={() => { if (router.back()) requestInputFocus(); }}
        >
          <ArrowLeft size={16} />
        </Button>
      </span>
    {/snippet}
  </TooltipUI.Trigger>
  <TooltipUI.Content value={`Go back (${comboHint("global.history-back")})`} />
</TooltipUI.Root>
<TooltipUI.Root>
  <TooltipUI.Trigger>
    {#snippet child({ props })}
      <span {...props} class="inline-flex shrink-0">
        <Button
          variant="ghost"
          size="icon-xs"
          class="text-(--solus-text-tertiary) hover:text-(--solus-text-primary)"
          aria-label="Go forward"
          disabled={!router.canGoForward}
          onclick={() => { if (router.forward()) requestInputFocus(); }}
        >
          <ArrowRight size={16} />
        </Button>
      </span>
    {/snippet}
  </TooltipUI.Trigger>
  <TooltipUI.Content value={`Go forward (${comboHint("global.history-forward")})`} />
</TooltipUI.Root>
