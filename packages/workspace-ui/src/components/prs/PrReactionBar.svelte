<script lang="ts">
  import { reactionSummary, shownReactions } from "@solus/client-core/pr-social";
  import type { PrReactions } from "@solus/contracts/pr-social";
  import * as TooltipUI from "../ui/tooltip";
  import { getPrReactions } from "./lib/pr-reactions.svelte";
  import PrReactionPicker from "./PrReactionPicker.svelte";

  // The reactions under the description (`targetId` null) or a comment: one
  // pill for each reaction someone made, with its count, and the names of who
  // made it on hover. A pill the viewer made is tinted; pressing a pill adds
  // or takes back the viewer's reaction. A comment with no reactions shows
  // nothing here, since its header holds the add control. Where the viewer
  // may not react, or outside a pull request page, the pills only show.
  let { targetId, reactions: read }: { targetId: string | null; reactions: PrReactions | undefined } =
    $props();

  const page = getPrReactions();
  const reactions = $derived(page ? page.shown(targetId, read) : read);
  const shown = $derived(shownReactions(reactions));
  const canReact = $derived(!!page?.canWrite && !!reactions?.viewerCanReact);
</script>

{#if reactions && (shown.length > 0 || (targetId === null && canReact))}
  <div class="mt-2 flex flex-wrap items-center gap-1.5" role="group" aria-label="Reactions">
    {#each shown as reaction (reaction.content)}
      <TooltipUI.Root>
        <TooltipUI.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              type="button"
              aria-pressed={reaction.viewerHasReacted}
              aria-disabled={!canReact}
              aria-label={reactionSummary(reaction)}
              class="inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs font-medium tabular-nums transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-coarse:h-8 pointer-coarse:px-2.5 {reaction.viewerHasReacted
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-border text-muted-foreground'} {canReact
                ? reaction.viewerHasReacted
                  ? 'cursor-pointer hover:bg-primary/15'
                  : 'cursor-pointer hover:bg-muted hover:text-foreground'
                : 'cursor-default'}"
              onclick={() => {
                if (canReact) page?.toggle(targetId, reaction.content, read);
              }}
            >
              <span class="text-sm leading-none" aria-hidden="true">{reaction.label}</span>
              <span>{reaction.count}</span>
            </button>
          {/snippet}
        </TooltipUI.Trigger>
        <TooltipUI.Content value={reactionSummary(reaction)} />
      </TooltipUI.Root>
    {/each}
    <PrReactionPicker
      {targetId}
      reactions={read}
      class="size-6 border border-border pointer-coarse:size-8"
    />
  </div>
{/if}
