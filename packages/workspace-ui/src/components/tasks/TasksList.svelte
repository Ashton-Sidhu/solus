<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";
  import type { IssueMoveTarget } from "@solus/contracts/task-types";
  import type { Issue } from "../../contexts/tasks/task.svelte";
  import {
    ListGroup,
    ListSelectCheckbox,
    VirtualList,
    LIST_GROUP_HEADER_HEIGHT,
    virtualGroupItems,
    type ListGroupSpec,
    type ListSelection,
  } from "../ui/list-page";
  import { TASK_LIST_ROW_HEIGHT, TASK_LIST_SPLIT_ROW_HEIGHT, type TaskRowSpec } from "./lib/tasks-list-view";
  import TaskListRow from "./TaskListRow.svelte";

  /**
   * The grouped task list of the Tasks page: one section for each column of
   * the view on screen, virtualised. One row at every width, in the pull
   * request row's shape; beside an open task it is taller and sheds facts by
   * its own width (see `TaskListRow`).
   */
  interface Props {
    groups: ListGroupSpec<TaskRowSpec>[];
    height: number;
    /** The list is the rail beside an open task. */
    split: boolean;
    /** The page's multi-select: each row draws its checkbox from it. */
    selection: ListSelection;
    selectedKey: string | null;
    taskFor: (taskId: string) => Issue | undefined;
    onOpen: (task: Issue) => void;
    onMove: (task: Issue, target: IssueMoveTarget) => void;
    onContextMenu: (event: MouseEvent, task: Issue) => void;
  }
  let { groups, height, split, selection, selectedKey, taskFor, onOpen, onMove, onContextMenu }: Props =
    $props();

  const collapsedGroups = new SvelteSet<string>();
  let revealedTaskId = $state<string | null>(null);

  const items = $derived(
    virtualGroupItems<ListGroupSpec<TaskRowSpec>, TaskRowSpec>(
      groups,
      (row) => row.key,
      (group) => !collapsedGroups.has(group.key),
    ),
  );
  const activeKey = $derived(
    items.find((item) => item.kind === "row" && item.row.key === selectedKey)?.key ?? null,
  );

  function toggleGroup(key: string) {
    if (!collapsedGroups.delete(key)) collapsedGroups.add(key);
  }
</script>

<VirtualList
  {items}
  {height}
  itemSize={(index) =>
    items[index].kind === "header"
      ? LIST_GROUP_HEADER_HEIGHT
      : split
        ? TASK_LIST_SPLIT_ROW_HEIGHT
        : TASK_LIST_ROW_HEIGHT}
  keyOf={(item) => item.key}
  {activeKey}
>
  {#snippet children(item, _index, style)}
    <div {style}>
      {#if item.kind === "header"}
        <ListGroup
          label={item.group.label}
          count={item.group.rows.length}
          open={!collapsedGroups.has(item.group.key)}
          onToggle={() => toggleGroup(item.group.key)}
        >
          {#snippet children()}{/snippet}
        </ListGroup>
      {:else}
        {@const task = taskFor(item.row.key)}
        {@const selected = selectedKey === item.row.key || selection.has(item.row.key)}
        <TaskListRow
          row={item.row}
          {split}
          {selected}
          onSelect={() => {
            if (task) onOpen(task);
          }}
          onSetCategory={(category) => {
            revealedTaskId = null;
            if (task) onMove(task, { category });
          }}
          revealed={revealedTaskId === item.row.key}
          onRevealChange={(revealed) => (revealedTaskId = revealed ? item.row.key : null)}
          onContextMenu={(event) => {
            if (task) onContextMenu(event, task);
          }}
        >
          {#snippet leading()}
            <ListSelectCheckbox {selection} id={item.row.key} noun="task" class="mr-2" />
          {/snippet}
        </TaskListRow>
      {/if}
    </div>
  {/snippet}
</VirtualList>
