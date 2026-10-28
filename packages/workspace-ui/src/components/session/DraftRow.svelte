<script lang="ts">
  import { Paperclip as PaperclipIcon, SquarePen as SquarePenIcon, X as XIcon } from "@lucide/svelte";
  import ProjectFavicon from "../ui/ProjectFavicon.svelte";
  import type { DraftRow } from "./lib/draft-list";

  interface Props {
    row: DraftRow;
    /** The row sits in a project folder: one line, with the pencil where a
     *  slim row keeps its project mark, because the folder names the project. */
    inFolder?: boolean;
    onSelect: () => void;
    onDiscard: () => void;
  }
  let { row, inFolder = false, onSelect, onDiscard }: Props = $props();
</script>

{#snippet pencil()}
  <span
    class="flex size-4 shrink-0 items-center justify-center text-(--solus-text-tertiary)"
    role="img"
    aria-label="Draft"
    title="Draft"
  >
    <SquarePenIcon size={14} />
  </span>
{/snippet}

{#snippet titleLine()}
  <span
    class="min-w-0 flex-1 overflow-hidden text-workspace-chrome text-ellipsis whitespace-nowrap text-[color-mix(in_oklch,var(--solus-text-secondary)_84%,transparent)]"
    title={row.title}>{row.title}</span
  >

  {#if row.hasAttachments}
    <span
      class="flex shrink-0 items-center text-(--solus-text-tertiary) group-hover/draft:hidden group-focus-within/draft:hidden pointer-coarse:hidden"
      role="img"
      aria-label="Has attachments"
      title="Has attachments"
    >
      <PaperclipIcon size={12} />
    </span>
  {/if}

  <button
    type="button"
    class="hidden size-6 shrink-0 cursor-pointer items-center justify-center rounded-[0.4375rem] text-muted-foreground transition-[color,background] duration-[120ms] group-hover/draft:flex group-focus-within/draft:flex hover:bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)] hover:text-foreground pointer-coarse:flex"
    title="Discard draft"
    aria-label="Discard draft"
    onclick={(event) => {
      event.stopPropagation();
      onDiscard();
    }}
  >
    <XIcon size={12} weight="bold" />
  </button>
{/snippet}

<!--
  A draft uses the same title and project hierarchy as an open task. Its pencil
  leads the project favicon and label on the second line. In a folder the row
  is one line, and the pencil alone says it is a draft.

  There is no selected state either: a draft is listed only once no pane is
  composing it, so the row you are looking at is never the prompt you are in.
-->
<div
  class="group/draft relative -mx-2 flex cursor-pointer items-center rounded-lg pr-2 pl-[0.625rem] transition-[background,box-shadow] duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring hover:bg-card hover:shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_10%,transparent),0_2px_6px_color-mix(in_oklch,var(--foreground)_8%,transparent)] dark:hover:bg-[color-mix(in_oklch,var(--card)_94%,white)] {inFolder
    ? 'h-[2.25rem] gap-[0.5625rem] @max-[15rem]:gap-1.5'
    : 'h-[3.875rem]'}"
  role="treeitem"
  tabindex="0"
  aria-selected="false"
  aria-label="{row.title} — unsent draft"
  onclick={onSelect}
  onkeydown={(event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelect();
  }}
>
  {#if inFolder}
    <!-- The pencil takes the gutter a slim row keeps for its project mark,
         so the title lines up with the session titles under the folder. -->
    {@render pencil()}
    {@render titleLine()}
  {:else}
    <span class="flex min-w-0 flex-1 flex-col">
      <span class="flex h-[1.1875rem] items-center gap-[0.5625rem] @max-[15rem]:gap-1.5">
        {@render titleLine()}
      </span>

      <span
        class="mt-[0.375rem] flex h-5 min-w-0 max-w-full items-center gap-[0.375rem] text-xs text-[color-mix(in_oklch,var(--foreground)_64%,transparent)] @max-[15rem]:gap-1"
      >
        {@render pencil()}
        <ProjectFavicon
          projectKey={row.groupKey}
          class="size-4 @max-[15rem]:size-[0.875rem] pointer-fine:[&_.lucide-icon]:size-[82%]"
        />
        <span class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
          >{row.projectLabel}</span
        >
      </span>
    </span>
  {/if}
</div>
