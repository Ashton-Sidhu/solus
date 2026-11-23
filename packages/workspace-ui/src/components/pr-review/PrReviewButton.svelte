<script lang="ts">
  import { mergeProps } from "bits-ui";
  import * as Tooltip from "../ui/tooltip";
  import type { Snippet } from "svelte";
  import { ChevronDown, MessageSquareCheck as ReviewIcon } from "@lucide/svelte";
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
      <Tooltip.Root disabled={open}>
        <Tooltip.Trigger>
          {#snippet child({ props: tooltipProps })}
            <Button
              {...mergeProps(tooltipProps, props)}
              type="button"
              variant="ghost"
              size="xs"
              class="h-7 shrink-0 gap-1.5 rounded-full px-2.5 text-workspace-chrome font-normal text-foreground hover:bg-[var(--wash-1)] aria-expanded:bg-[var(--wash-1)] pointer-coarse:tap-area @max-[54rem]/band:px-[5px] @max-[54rem]/band:pointer-coarse:px-[12.5px]"
              aria-label={draftCount > 0 ? `Review, ${draftCount} pending comments` : "Review"}
            >
              <ReviewIcon class="hidden size-4 @max-[54rem]/band:block" strokeWidth={1.5} aria-hidden="true" />
              <span class="@max-[54rem]/band:hidden">Review</span>
              {#if draftCount > 0}
                <span class="tabular-nums text-muted-foreground">{draftCount}</span>
              {/if}
              <ChevronDown class="size-3 text-muted-foreground @max-[54rem]/band:hidden" aria-hidden="true" />
            </Button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content
          side="bottom"
          value={hint ? `Submit a review (${hint} to approve)` : "Submit a review"}
        />
      </Tooltip.Root>
    {/snippet}
  </Popover.Trigger>
  <Popover.Content
    data-solus-ui
    side="bottom"
    align="end"
    sideOffset={6}
    collisionPadding={8}
    class="z-[10002] w-[min(25rem,calc(100vw-1rem))] gap-0 rounded-2xl border-[0.0313rem] border-(--solus-popover-border) bg-(--solus-popover-bg) p-0 text-workspace-chrome lg:text-workspace-chrome shadow-[shadow:var(--solus-popover-shadow)] ring-0"
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
