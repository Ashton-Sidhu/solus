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
  import { ListBulkAction, ListBulkBar, type ListSelection } from "../ui/list-page";
  import TaskStatusGlyph from "./TaskStatusGlyph.svelte";

  /**
   * The actions of the Tasks page over a held selection, in the shared
   * `ListBulkBar`. The move buttons are this page's rung: more labels than the
   * narrow bar has room for collapse into one Move menu.
   */
  interface Props {
    selection: ListSelection;
    /** The columns of the view on screen that a task can be moved to. */
    moveOptions: { id: string; label: string; category: TaskStatusCategory }[];
    onComplete: () => void;
    /** Absent where the surface has no read marks. */
    onMarkUnread?: () => void;
    onMove: (columnId: string) => void;
    /** Absent when no selected task is a draft: only a draft can be deleted. */
    onDelete?: () => void;
  }
  let { selection, moveOptions, onComplete, onMarkUnread, onMove, onDelete }: Props = $props();

  // More columns than a pill has room for go to the menu at every width.
  const inlineMoves = $derived(moveOptions.length <= 4);
</script>

<ListBulkBar {selection}>
  <ListBulkAction onclick={onComplete}>
    <CheckIcon size={14} class="shrink-0" />Complete
  </ListBulkAction>
  {#if onMarkUnread}
    <ListBulkAction onclick={onMarkUnread}>
      <DotOutlineIcon size={14} class="shrink-0" />Unread
    </ListBulkAction>
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
  <!-- The columns as one menu: at the record rung, and whenever a source has
       more columns than the pill has room for. -->
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
</ListBulkBar>
