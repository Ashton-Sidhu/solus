<script lang="ts">
  import {
    CalendarDays as CalendarIcon,
    ChevronDown as CaretDownIcon,
    Tag as TagIcon,
  } from "@lucide/svelte";
  import { authorInitials } from "../lib/tasks-api";
  import type { TaskDetailsSummary } from "./lib/task-page";

  /**
   * Where the rail has folded, the status line ends in a Details disclosure,
   * drawn like the status and priority menus beside it: text and a chevron, a
   * wash only under the pointer. It leads with what a reader looks for first:
   * who has it, when it is due, how it is labelled, and only what is set;
   * status and priority are already on the line. A narrow pane sheds the
   * labels, then the due date, so the assignee keeps its room. It opens the
   * rail's fields under the title.
   */
  interface Props {
    summary: TaskDetailsSummary;
    assigneeAvatarUrl?: string;
    open: boolean;
    /** The id of the panel this control opens. */
    controls: string;
    onToggle: () => void;
  }

  let { summary, assigneeAvatarUrl, open, controls, onToggle }: Props = $props();

  let button = $state<HTMLButtonElement | null>(null);

  /** Take focus back when Escape closes the panel. */
  export function focus() {
    button?.focus();
  }
</script>

<button
  bind:this={button}
  type="button"
  class="-mx-1.5 inline-flex h-[26px] max-w-full min-w-0 cursor-pointer items-center gap-2.5 overflow-hidden rounded-md border-0 bg-transparent px-1.5 font-normal text-muted-foreground outline-none transition-colors hover:bg-[var(--wash-2)] hover:text-foreground focus-visible:bg-[var(--wash-2)] focus-visible:text-foreground aria-expanded:text-foreground pointer-coarse:h-9 [-webkit-tap-highlight-color:transparent]"
  onclick={onToggle}
  aria-controls={controls}
  aria-expanded={open}
>
  {#if summary.assignee}
    <span class="inline-flex min-w-0 items-center gap-1.5 text-foreground">
      {#if assigneeAvatarUrl}
        <img src={assigneeAvatarUrl} alt="" class="size-4 shrink-0 rounded-full" />
      {:else}
        <span
          class="flex size-4 shrink-0 items-center justify-center rounded-full text-[0.5625rem] font-semibold"
          style="background:color-mix(in oklch, var(--chart-1) 22%, transparent);color:color-mix(in oklch, var(--chart-1) 74%, var(--foreground))"
          aria-hidden="true">{authorInitials(summary.assignee)}</span
        >
      {/if}
      <span class="truncate">{summary.assignee}</span>
    </span>
  {/if}
  {#if summary.due}
    <span
      class="inline-flex shrink-0 items-center gap-1 whitespace-nowrap @max-[26rem]:hidden {summary.due.tone === 'overdue'
        ? 'text-[color-mix(in_oklch,var(--failure)_72%,var(--foreground))]'
        : summary.due.tone === 'soon'
          ? 'text-foreground'
          : ''}"
    >
      <CalendarIcon size={13} class="shrink-0 opacity-70" aria-hidden="true" />
      <span class="sr-only">Due</span>{summary.due.label}
    </span>
  {/if}
  {#if summary.labels}
    <span class="inline-flex min-w-0 items-center gap-1 @max-[34rem]:hidden">
      <TagIcon size={13} class="shrink-0 opacity-70" aria-hidden="true" />
      <span class="sr-only">Labels</span><span class="truncate">{summary.labels}</span>
    </span>
  {/if}
  <span class="inline-flex shrink-0 items-center gap-1">
    Details
    <CaretDownIcon
      size={13}
      class="shrink-0 opacity-70 transition-transform duration-150 motion-reduce:transition-none {open
        ? 'rotate-180'
        : ''}"
      aria-hidden="true"
    />
  </span>
</button>
