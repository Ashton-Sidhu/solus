<script lang="ts">
  import {
    Check as CheckIcon,
    ChevronDown as CaretDownIcon,
    CircleDashed as CircleDashedIcon,
    Dot as DotOutlineIcon,
    Trash2 as TrashIcon,
  } from "@lucide/svelte";
  import type { TaskStatusCategory } from "@solus/contracts/task-sources";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import TaskStatusGlyph from "./TaskStatusGlyph.svelte";

  /**
   * The bulk action bar: it floats over the task list while a selection is
   * held.
   *
   * ── The record rung (`@max-[30rem]/pane`) ──
   * Many controls on one line is a desktop pill. In a narrow pane it was wider
   * than the pane. The ladder: the count and Clear take a line of their own,
   * the move buttons collapse into one Move menu, and the remaining actions
   * wrap rather than clip — a control that does not fit gets its own line, it
   * never loses its label.
   */
  interface Props {
    count: number;
    /** The columns of the view on screen that a task can be moved to. */
    moveOptions: { id: string; label: string; category: TaskStatusCategory }[];
    onClear: () => void;
    onComplete: () => void;
    /** Absent where the surface has no read marks. */
    onMarkUnread?: () => void;
    onMove: (columnId: string) => void;
    /** Absent when no selected task is a draft: only a draft can be deleted. */
    onDelete?: () => void;
  }
  let { count, moveOptions, onClear, onComplete, onMarkUnread, onMove, onDelete }: Props = $props();

  // More columns than a pill has room for go to the menu at every width.
  const inlineMoves = $derived(moveOptions.length <= 4);
</script>

<div
  class="pointer-events-none absolute inset-x-0 bottom-14 z-10 flex justify-center px-4 @max-[30rem]/pane:bottom-0 @max-[30rem]/pane:px-2 @max-[30rem]/pane:pb-[max(0.5rem,env(safe-area-inset-bottom,0px))]"
>
  <div
    class="pointer-events-auto flex items-center gap-1.5 rounded-full border border-(--solus-popover-border) bg-(--solus-popover-bg) px-2 py-1.5 shadow-[var(--solus-popover-shadow)] @max-[30rem]/pane:w-full @max-[30rem]/pane:flex-col @max-[30rem]/pane:items-stretch @max-[30rem]/pane:gap-2 @max-[30rem]/pane:rounded-2xl @max-[30rem]/pane:p-2.5"
    role="toolbar"
    aria-label="Bulk actions"
  >
    <!-- `contents` keeps the wide pill one flat line; at the rung this becomes
         the header line, with Clear held to the right by the `order-last` that
         also puts it at the end of the pill. -->
    <div
      class="contents @max-[30rem]/pane:flex @max-[30rem]/pane:items-center @max-[30rem]/pane:justify-between"
    >
      <span class="px-1.5 font-medium tabular-nums whitespace-nowrap">
        {count} selected
      </span>
      <button
        type="button"
        class="order-last cursor-pointer rounded-full border-0 bg-transparent px-2 py-1 text-xs font-medium whitespace-nowrap text-(--solus-text-tertiary) transition-colors duration-100 hover:bg-(--solus-surface-hover) @max-[30rem]/pane:h-9 @max-[30rem]/pane:px-3 @max-[30rem]/pane:text-workspace-chrome"
        onclick={onClear}
        title="Clear selection (Esc)"
      >
        Clear
      </button>
    </div>
    <span class="h-4 w-px bg-(--solus-container-border) @max-[30rem]/pane:hidden" aria-hidden="true"></span>
    <div
      class="contents @max-[30rem]/pane:flex @max-[30rem]/pane:flex-wrap @max-[30rem]/pane:items-center @max-[30rem]/pane:gap-1.5"
    >
      <button
        type="button"
        class="inline-flex cursor-pointer items-center gap-1 rounded-full border-0 bg-transparent px-2 py-1 text-xs font-medium whitespace-nowrap text-(--solus-text-secondary) transition-colors duration-100 hover:bg-(--solus-surface-hover) @max-[30rem]/pane:h-9 @max-[30rem]/pane:gap-1.5 @max-[30rem]/pane:px-2.5 @max-[30rem]/pane:text-workspace-chrome"
        onclick={onComplete}
        ><CheckIcon size={14} class="shrink-0" />Complete</button
      >
      {#if onMarkUnread}
        <button
          type="button"
          class="inline-flex cursor-pointer items-center gap-1 rounded-full border-0 bg-transparent px-2 py-1 text-xs font-medium whitespace-nowrap text-(--solus-text-secondary) transition-colors duration-100 hover:bg-(--solus-surface-hover) @max-[30rem]/pane:h-9 @max-[30rem]/pane:gap-1.5 @max-[30rem]/pane:px-2.5 @max-[30rem]/pane:text-workspace-chrome"
          onclick={onMarkUnread}
          ><DotOutlineIcon size={14} class="shrink-0" />Unread</button
        >
      {/if}
      <span class="h-4 w-px bg-(--solus-container-border) @max-[30rem]/pane:hidden" aria-hidden="true"></span>
      {#if inlineMoves}
        {#each moveOptions as option (option.id)}
          <button
            type="button"
            class="inline-flex max-w-[9rem] cursor-pointer items-center gap-1 overflow-hidden rounded-full border-0 bg-transparent px-2 py-1 text-xs font-medium whitespace-nowrap text-(--solus-text-secondary) transition-colors duration-100 hover:bg-(--solus-surface-hover) @max-[30rem]/pane:hidden"
            onclick={() => onMove(option.id)}
            title={`Move to ${option.label}`}
          >
            <TaskStatusGlyph category={option.category} />
            <span class="truncate">{option.label}</span>
          </button>
        {/each}
      {/if}
      <!-- The columns as one menu: at the record rung, and whenever a source
           has more columns than the pill has room for. -->
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              type="button"
              class="cursor-pointer items-center gap-1.5 rounded-full border-0 bg-transparent px-2.5 text-xs font-medium whitespace-nowrap text-(--solus-text-secondary) transition-colors duration-100 hover:bg-(--solus-surface-hover) @max-[30rem]/pane:inline-flex @max-[30rem]/pane:h-9 @max-[30rem]/pane:text-workspace-chrome {inlineMoves
                ? 'hidden'
                : 'inline-flex py-1'}"
              aria-label="Move the selected tasks"
            >
              <CircleDashedIcon size={14} class="shrink-0 opacity-75" />
              Move
              <CaretDownIcon size={9} class="shrink-0 opacity-60" />
            </button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content side="top" align="start" sideOffset={6} class="w-[min(14rem,calc(100vw-2rem))]">
          {#each moveOptions as option (option.id)}
            <DropdownMenu.Item onSelect={() => onMove(option.id)}>
              <TaskStatusGlyph category={option.category} />
              <span class="min-w-0 flex-1 truncate">{option.label}</span>
            </DropdownMenu.Item>
          {/each}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
      {#if onDelete}
        <span class="h-4 w-px bg-(--solus-container-border) @max-[30rem]/pane:hidden" aria-hidden="true"></span>
        <button
          type="button"
          class="inline-flex cursor-pointer items-center gap-1 rounded-full border-0 bg-transparent px-2 py-1 text-xs font-medium whitespace-nowrap text-[#cf222e] transition-colors duration-100 hover:bg-[#cf222e]/10 @max-[30rem]/pane:h-9 @max-[30rem]/pane:gap-1.5 @max-[30rem]/pane:px-2.5 @max-[30rem]/pane:text-workspace-chrome [.dark_&]:text-[#f85149] [.dark_&]:hover:bg-[#f85149]/10"
          onclick={onDelete}
          title="Delete the selected draft items"
        >
          <TrashIcon size={14} class="shrink-0" />
          Delete drafts
        </button>
      {/if}
    </div>
  </div>
</div>
