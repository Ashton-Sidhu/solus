<script lang="ts">
  import { SmilePlus as AddReactionIcon } from "@lucide/svelte";
  import { PR_REACTIONS } from "@solus/client-core/pr-social";
  import type { PrReactions } from "@solus/contracts/pr-social";
  import * as Popover from "../ui/popover";
  import { getPrReactions } from "./lib/pr-reactions.svelte";

  // The add-reaction control: a smiley that opens GitHub's eight reactions.
  // A reaction the viewer already made shows pressed, and choosing it again
  // takes it back. Absent where the viewer may not react. The trigger's look
  // belongs to where it sits, so the caller passes its classes.
  let {
    targetId,
    reactions: read,
    class: triggerClass = "",
  }: { targetId: string | null; reactions: PrReactions | undefined; class?: string } = $props();

  const page = getPrReactions();
  const reactions = $derived(page?.shown(targetId, read));
  let open = $state(false);
</script>

{#if page?.canWrite && reactions?.viewerCanReact}
  <Popover.Root bind:open>
    <Popover.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          aria-label="Add reaction"
          title="Add reaction"
          class="grid shrink-0 cursor-pointer place-items-center rounded-full text-muted-foreground transition-[opacity,color,background-color] hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none data-[state=open]:bg-muted data-[state=open]:text-foreground data-[state=open]:opacity-100 {triggerClass}"
        >
          <AddReactionIcon size={14} aria-hidden="true" />
        </button>
      {/snippet}
    </Popover.Trigger>
    <Popover.Content
      data-solus-ui
      side="top"
      align="start"
      sideOffset={6}
      collisionPadding={8}
      aria-label="Reactions"
      class="menu-surface z-[10002] w-auto flex-row gap-0.5 rounded-xl bg-(--solus-menu-bg) p-1 shadow-[shadow:var(--solus-menu-shadow)] ring-0"
    >
      {#each PR_REACTIONS as choice (choice.content)}
        {@const held = reactions.groups.some(
          (group) => group.content === choice.content && group.viewerHasReacted,
        )}
        <button
          type="button"
          aria-label={choice.name}
          title={choice.name}
          aria-pressed={held}
          class="grid size-8 cursor-pointer place-items-center rounded-lg text-base transition-[background-color,scale] hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:scale-90 motion-reduce:active:scale-100 pointer-coarse:size-10 {held
            ? 'bg-primary/12'
            : ''}"
          onclick={() => {
            page.toggle(targetId, choice.content, read);
            open = false;
          }}>{choice.label}</button
        >
      {/each}
    </Popover.Content>
  </Popover.Root>
{/if}
