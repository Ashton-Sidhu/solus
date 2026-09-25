<script lang="ts">
  import type { Snippet } from "svelte";
  import { MessageSquareCheck as ReviewIcon } from "@lucide/svelte";
  import { comboHint } from "../../lib/keybindings/manifest";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Button } from "../ui/button";
  import * as Popover from "../ui/popover";

  // The Review button and the review form that hangs from it. Drafts written
  // on Diff and Guide are counted here, so the band says how much is waiting
  // to go out. The form is a popover, not a modal: the diff stays in view.
  let { draftCount, open = $bindable(false), form }: {
    draftCount: number;
    open?: boolean;
    /** Mounted only while open, so its keybinding scope lives with it. */
    form: Snippet;
  } = $props();

  const hint = comboHint("pr-review.approve");
</script>

<Popover.Root bind:open>
  <Popover.Trigger>
    {#snippet child({ props })}
      <Button
        {...props}
        type="button"
        variant="outline"
        size="xs"
        class="h-[26px] shrink-0 gap-1.5 px-2.5 text-workspace-chrome pointer-coarse:h-10 pointer-coarse:px-3.5 @max-[40rem]/band:px-2"
        aria-label={draftCount > 0 ? `Review, ${draftCount} pending comments` : "Review"}
        title={hint ? `Submit a review (${hint} to approve)` : "Submit a review"}
      >
        <ReviewIcon class="size-3" aria-hidden="true" />
        <span class="@max-[40rem]/band:hidden">Review</span>
        {#if draftCount > 0}
          <span class="tabular-nums text-muted-foreground">{draftCount}</span>
        {/if}
      </Button>
    {/snippet}
  </Popover.Trigger>
  <Popover.Content
    data-solus-ui
    side="bottom"
    align="end"
    sideOffset={6}
    collisionPadding={8}
    class="menu-surface z-[10002] w-[min(26rem,calc(100vw-1rem))] gap-0 rounded-2xl bg-(--solus-menu-bg) p-0 text-workspace-chrome lg:text-workspace-chrome shadow-[shadow:var(--solus-menu-shadow)] ring-0"
    aria-label="Submit review"
    onOpenAutoFocus={(e) => e.preventDefault()}
    onCloseAutoFocus={(e) => {
      // Return to the composer after a submit or Escape, but leave focus
      // alone when the user dismissed by clicking into something else.
      e.preventDefault();
      if (!document.activeElement || document.activeElement === document.body) requestInputFocus();
    }}
  >
    {@render form()}
  </Popover.Content>
</Popover.Root>
