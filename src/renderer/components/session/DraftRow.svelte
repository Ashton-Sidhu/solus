<script lang="ts">
  import { NotePencilIcon, PaperclipIcon, XIcon } from "phosphor-svelte";
  import type { DraftRow } from "./lib/draft-list";

  interface Props {
    row: DraftRow;
    /** The project name under the title — only when the list spans projects. */
    showProjectLine: boolean;
    onSelect: () => void;
    onDiscard: () => void;
  }
  let { row, showProjectLine, onSelect, onDiscard }: Props = $props();
</script>

<!--
  A draft row is a task row with everything a session would have taken away:
  no disclosure, no status glyph, no clock, no PR. The pencil sits in the column
  a task spends on its disclosure, so both lists keep one title edge — and it is
  the whole of what the row reports, because "unsent" is a draft's only state.

  There is no selected state either: a draft is listed only once no pane is
  composing it, so the row you are looking at is never the prompt you are in.
-->
<div
  class="group/draft relative -mr-1 flex cursor-pointer items-center gap-[0.5625rem] rounded-[0.6875rem] pr-2 pl-[0.125rem] transition-[background] duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring hover:bg-[color-mix(in_oklch,var(--foreground)_3.5%,transparent)] {showProjectLine
    ? 'h-[3.25rem]'
    : 'h-[2.125rem]'}"
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
  <span
    class="-mr-[0.375rem] flex size-4 shrink-0 items-center justify-center text-(--solus-text-tertiary) {showProjectLine
      ? 'mt-2 self-start'
      : ''}"
    aria-hidden="true"
  >
    <NotePencilIcon size={12} />
  </span>

  <span class="flex min-w-0 flex-1 flex-col">
    <span class="flex h-[1.1875rem] items-center gap-[0.5625rem]">
      <span
        class="min-w-0 flex-1 overflow-hidden text-[0.84375rem] leading-[1.1875rem] tracking-[-0.008em] text-ellipsis whitespace-nowrap text-(--solus-text-secondary)"
        title={row.title}>{row.title}</span
      >

      <!-- Files are the one thing the title cannot say, so they get the margin
           a task spends on its state. It steps aside for the discard action on
           hover, exactly as a task's PR chip does. -->
      {#if row.hasAttachments}
        <span
          class="flex shrink-0 items-center text-(--solus-text-tertiary) group-hover/draft:hidden"
          role="img"
          aria-label="Has attachments"
          title="Has attachments"
        >
          <PaperclipIcon size={12} />
        </span>
      {/if}

      <button
        type="button"
        class="hidden size-6 shrink-0 cursor-pointer items-center justify-center rounded-[0.4375rem] text-muted-foreground transition-[color,background] duration-[120ms] group-hover/draft:flex group-focus-within/draft:flex hover:bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)] hover:text-foreground"
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

    {#if showProjectLine}
      <span
        class="mt-[0.1875rem] overflow-hidden text-[0.6875rem] text-ellipsis whitespace-nowrap text-(--solus-text-tertiary)"
        >{row.projectLabel}</span
      >
    {/if}
  </span>
</div>
