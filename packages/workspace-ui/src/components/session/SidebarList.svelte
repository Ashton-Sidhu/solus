<script module lang="ts">
  import type { Snippet } from "svelte";
  import type { PinnedSession } from "@solus/contracts/types";
  import type { DraftRow as DraftRowModel } from "./lib/draft-list";
  import type { SidebarSection } from "./lib/sidebar-list-items";
  import type { SidebarTask } from "./lib/task-list";

  /** What both sidebar views hand the list unchanged: how a row renders and
   *  what the rows' own actions do. */
  export interface SidebarListShared {
    scrollEl: HTMLElement | undefined;
    motionMs: number;
    isLoading: boolean;
    /** Draws a row; the flag says it sits in a project folder. */
    taskRow: Snippet<[SidebarTask, boolean]>;
    /** Draws a row of the Pinned section. */
    pinnedRow: Snippet<[PinnedSession]>;
    onOpenDraft: (draft: DraftRowModel) => void;
    onDiscardDraft: (draft: DraftRowModel) => void;
    onToggleSection: (section: SidebarSection) => void;
    /** ⌫ on a row: the row's X. `taskKey` is absent on a session listed
     *  under a row. */
    onCloseRow: (target: { taskKey?: string; tabId?: string }) => void;
    /** → and ← on a row that started sessions: unfold or fold them. */
    onNestedOpenChange: (taskKey: string, isOpen: boolean) => void;
  }
</script>

<script lang="ts">
  import { requestInputFocus } from "../../lib/inputFocus";
  import DraftRow from "./DraftRow.svelte";
  import SidebarSectionHeader from "./SidebarSectionHeader.svelte";
  import TaskListSkeleton from "./TaskListSkeleton.svelte";
  import type { SidebarFolder } from "./lib/sidebar-project-folders";
  import { sidebarListMotion } from "./lib/sidebar-list-motion.svelte";
  import { sidebarListOrderKey, type SidebarListItem } from "./lib/sidebar-list-items";
  import { treeKeyIntent, type TreeRowState } from "./lib/task-tree-keys";

  /**
   * The sidebar's one list, as both views draw it: drafts, rows, section
   * headers, and in the project view the folder headers. A view decides the
   * entries; this draws them, animates a change of order, and answers the keys.
   */
  interface Props extends SidebarListShared {
    items: SidebarListItem[];
    /** The project view's folder header. */
    folderHeader?: Snippet<[SidebarFolder]>;
    onFolderOpenChange?: (folderKey: string, isOpen: boolean) => void;
  }
  let {
    items,
    scrollEl,
    motionMs,
    isLoading,
    taskRow,
    pinnedRow,
    folderHeader,
    onOpenDraft,
    onDiscardDraft,
    onToggleSection,
    onCloseRow,
    onNestedOpenChange,
    onFolderOpenChange,
  }: Props = $props();

  let treeEl: HTMLDivElement | undefined = $state();

  /** Where ← lands, or -1. A session listed under a row has no key of its
   *  own; its parent is the nearest row above it. A row or a draft in a
   *  project folder climbs to the folder. A folder and a top-level row have
   *  no parent. */
  function parentRowIndex(rows: HTMLElement[], focused: HTMLElement, index: number): number {
    if (focused.dataset.folderKey !== undefined) return -1;
    if (focused.dataset.nestedSession !== undefined) {
      return rows.findLastIndex((row, at) => at < index && row.dataset.taskKey !== undefined);
    }
    const memberOf = focused.closest<HTMLElement>("[data-folder]")?.dataset.folder;
    return memberOf === undefined ? -1 : rows.findIndex((row) => row.dataset.folderKey === memberOf);
  }

  /** What the focused row says about itself, read off the DOM. A folder and a
   *  row that started sessions both carry `aria-expanded`; the folder key or
   *  the task key says which it is. */
  function focusedRowState(rows: HTMLElement[], focused: HTMLElement, index: number): TreeRowState {
    const parentIndex = parentRowIndex(rows, focused, index);
    const expanded = focused.getAttribute("aria-expanded");
    const isOpen = expanded === null ? undefined : expanded === "true";
    return {
      index,
      parentIndex: parentIndex < 0 ? null : parentIndex,
      folderOpen: focused.dataset.folderKey === undefined ? undefined : isOpen,
      nestedOpen: focused.dataset.taskKey === undefined ? undefined : isOpen,
    };
  }

  /** The list drives itself off the DOM rather than a mirrored index: the rows
   *  it can move between are exactly the ones currently rendered, so a
   *  collapsed section, a closed folder, or a filtered project needs no
   *  bookkeeping here. */
  function handleTreeKeydown(event: KeyboardEvent) {
    if (event.metaKey || event.ctrlKey || event.altKey || !treeEl) return;

    const rows = [...treeEl.querySelectorAll<HTMLElement>('[role="treeitem"]')];
    const focused =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>('[role="treeitem"]')
        : null;
    const index = focused ? rows.indexOf(focused) : -1;
    if (index < 0) return;

    const taskKey = focused!.dataset.taskKey;
    const folderKey = focused!.dataset.folderKey;
    const intent = treeKeyIntent(event.key, focusedRowState(rows, focused!, index), rows.length);
    if (!intent) return;
    event.preventDefault();

    switch (intent.kind) {
      case "focus":
        rows[intent.index]?.focus();
        break;
      case "enterPane":
        requestInputFocus();
        break;
      case "close":
        onCloseRow({ taskKey, tabId: focused!.dataset.tabId });
        break;
      case "setFolderOpen":
        if (folderKey !== undefined) onFolderOpenChange?.(folderKey, intent.isOpen);
        break;
      case "setNestedOpen":
        if (taskKey !== undefined) onNestedOpenChange(taskKey, intent.isOpen);
        break;
    }
  }
</script>

<div bind:this={treeEl} role="tree" tabindex="-1" aria-label="Sessions" onkeydown={handleTreeKeydown}>
  <div
    class="relative flex flex-col gap-[0.1875rem]"
    {@attach sidebarListMotion(
      () => sidebarListOrderKey(items),
      () => motionMs,
      () => scrollEl,
    )}
  >
    {#each items as item, index (item.key)}
      {#if item.kind === "draft"}
        <div data-folder={item.folderKey}>
          <DraftRow
            row={item.draft}
            inFolder={item.folderKey !== undefined}
            onSelect={() => onOpenDraft(item.draft)}
            onDiscard={() => onDiscardDraft(item.draft)}
          />
        </div>
      {:else if item.kind === "drafts-divider"}
        <div class="my-[0.3125rem] h-px bg-sidebar-border/50" aria-hidden="true"></div>
      {:else if item.kind === "header"}
        <SidebarSectionHeader
          section={item.section}
          count={item.count}
          isOpen={item.isOpen}
          canToggle={item.canToggle}
          followsHeader={items[index - 1]?.kind === "header"}
          hasRowsBelow={items[index + 1]?.kind === "task" || items[index + 1]?.kind === "pinned"}
          onToggle={() => onToggleSection(item.section)}
        />
      {:else if item.kind === "folder"}
        {@render folderHeader?.(item.folder)}
      {:else if item.kind === "pinned"}
        <div data-sidebar-section="pinned" class="-mx-2 px-2">
          {@render pinnedRow(item.pin)}
        </div>
      {:else}
        <!-- `content-visibility: auto` contains each row, so a change in
             one row never lays out the whole window, and rows below the
             fold skip style and layout. The intrinsic size matches the
             row, so a row does not shift the list when it paints. The row
             reaches past this box (`-mx-2`, hover shadow, focus ring); the
             padding and the clip margin keep that inside paint
             containment. -->
        <div
          data-folder={item.folderKey}
          data-sidebar-section={item.section}
          class="-mx-2 px-2 [content-visibility:auto] [overflow-clip-margin:0.5rem] {item.folderKey === undefined && (item.section === 'sessions' ||
          item.section === 'shared' ||
          item.section === 'working' ||
          (item.section === 'pinned' && item.key.endsWith(':card')))
            ? '[contain-intrinsic-size:auto_62px]'
            : '[contain-intrinsic-size:auto_36px]'} {item.section === 'completed' ? 'opacity-80' : ''}"
        >
          {@render taskRow(item.task, item.folderKey !== undefined)}
        </div>
      {/if}
    {/each}
  </div>
  {#if isLoading}
    <TaskListSkeleton />
  {/if}
</div>
