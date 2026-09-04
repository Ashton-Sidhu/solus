<script lang="ts">
  import { Paperclip as PaperclipIcon, SquarePen as SquarePenIcon, X as XIcon } from "@lucide/svelte";
  import ProjectFavicon from "../ui/ProjectFavicon.svelte";
  import type { DraftRow } from "./lib/draft-list";

  interface Props {
    row: DraftRow;
    onSelect: () => void;
    onDiscard: () => void;
  }
  let { row, onSelect, onDiscard }: Props = $props();
</script>

<!--
  A draft uses the same title and project hierarchy as an open task. Its pencil
  leads the project favicon and label on the second line.

  There is no selected state either: a draft is listed only once no pane is
  composing it, so the row you are looking at is never the prompt you are in.
-->
<div
  class="group/draft relative -mx-2 flex h-[3.875rem] cursor-pointer items-center rounded-lg pr-2 pl-[0.625rem] transition-[background,box-shadow] duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring hover:bg-card hover:shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_10%,transparent),0_2px_6px_color-mix(in_oklch,var(--foreground)_8%,transparent)] dark:hover:bg-[color-mix(in_oklch,var(--card)_94%,white)]"
  role="option"
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
  <span class="flex min-w-0 flex-1 flex-col">
    <span class="flex h-[1.1875rem] items-center gap-[0.5625rem] @max-[15rem]:gap-1.5">
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
    </span>

    <span
      class="mt-[0.375rem] flex h-5 min-w-0 max-w-full items-center gap-[0.375rem] text-xs text-[color-mix(in_oklch,var(--foreground)_64%,transparent)] @max-[15rem]:gap-1"
    >
      <span
        class="flex size-4 shrink-0 items-center justify-center text-(--solus-text-tertiary)"
        role="img"
        aria-label="Draft"
        title="Draft"
      >
        <SquarePenIcon size={14} />
      </span>
      <ProjectFavicon
        projectRoot={row.projectKey}
        serverId={row.serverId}
        class="size-4 @max-[15rem]:size-[0.875rem] pointer-fine:[.is-laptop-display_&]:[&_svg]:size-3.5"
      />
      <span class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
        >{row.projectLabel}</span
      >
    </span>
  </span>
</div>
