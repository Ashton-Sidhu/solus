<script lang="ts">
  import { MessageSquareCheck as ReviewIcon } from "@lucide/svelte";
  import { comboHint } from "../../lib/keybindings/manifest";
  import { Button } from "../ui/button";

  // Opens the submit-review modal. Drafts written on Diff and Guide are
  // counted here, so the band says how much is waiting to go out.
  let { draftCount, onclick }: {
    draftCount: number;
    onclick: () => void;
  } = $props();

  const hint = comboHint("pr-review.approve");
</script>

<Button
  type="button"
  variant="outline"
  size="xs"
  class="h-[26px] shrink-0 gap-1.5 px-2.5 text-workspace-chrome pointer-coarse:h-10 pointer-coarse:px-3.5 pointer-fine:[.is-laptop-display_&]:h-6 pointer-fine:[.is-laptop-display_&]:px-2 @max-[40rem]/band:px-2"
  {onclick}
  aria-label={draftCount > 0 ? `Review, ${draftCount} pending comments` : "Review"}
  title={hint ? `Submit a review (${hint} to approve)` : "Submit a review"}
>
  <ReviewIcon class="size-3" aria-hidden="true" />
  <span class="@max-[40rem]/band:hidden">Review</span>
  {#if draftCount > 0}
    <span class="tabular-nums text-muted-foreground">{draftCount}</span>
  {/if}
</Button>
