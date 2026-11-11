<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";
  import type { TaskMoveTarget } from "@solus/contracts/task-types";
  import type { Task } from "../../contexts/tasks/task.svelte";
  import {
    ListGroup,
    ListRailRow,
    ListRow,
    ListSelectCheckbox,
    VirtualList,
    LIST_GROUP_HEADER_HEIGHT,
    listRowHeight,
    virtualGroupItems,
    type ListGroupSpec,
    type ListRowSpec,
    type ListSelection,
  } from "../ui/list-page";
  import TaskListRow from "./TaskListRow.svelte";

  /**
   * The grouped task list of the Tasks page: one section for each column of
   * the view on screen, virtualised. It draws one of three rows by the room it
   * has: the drawer row in a narrow pane, the rail row beside an open task,
   * else the table row.
   */
  interface Props {
    groups: ListGroupSpec[];
    height: number;
    /** A narrow pane: the fixed-height drawer row, with its swipe controls. */
    recordRows: boolean;
    /** The list is the rail beside an open task. */
    split: boolean;
    /** The page's multi-select: each row draws its checkbox from it. */
    selection: ListSelection;
    selectedKey: string | null;
    taskFor: (taskId: string) => Task | undefined;
    onOpen: (task: Task) => void;
    onMove: (task: Task, target: TaskMoveTarget) => void;
    onContextMenu: (event: MouseEvent, task: Task) => void;
  }
  let { groups, height, recordRows, split, selection, selectedKey, taskFor, onOpen, onMove, onContextMenu }: Props =
    $props();

  const collapsedGroups = new SvelteSet<string>();
  let revealedTaskId = $state<string | null>(null);

  const items = $derived(
    virtualGroupItems<ListGroupSpec, ListRowSpec>(
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
      : listRowHeight({ record: recordRows, split, drawerRow: true })}
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
        {#if recordRows}
          <!-- The drawer row, not the three-line record: a task's title is
               nearly the whole row, and a fixed height is what keeps the
               painted row inside the slot the virtualiser gave it. Its swipe
               controls move the task to a status category; the host chooses
               the column of each source. -->
          <TaskListRow
            row={item.row}
            category={task?.category ?? "open"}
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
        {:else if split}
          <ListRailRow
            row={item.row}
            fallbackAvatar="solus"
            responsiveTitle
            showTime={false}
            {selected}
            onSelect={() => {
              if (task) onOpen(task);
            }}
            onContextMenu={(event) => {
              if (task) onContextMenu(event, task);
            }}
          >
            {#snippet leading()}
              <ListSelectCheckbox {selection} id={item.row.key} noun="task" class="mr-2" />
            {/snippet}
          </ListRailRow>
        {:else}
          <ListRow
            row={item.row}
            identWidth={62}
            fallbackAvatar="solus"
            responsiveTitle
            {selected}
            onSelect={() => {
              if (task) onOpen(task);
            }}
            onContextMenu={(event) => {
              if (task) onContextMenu(event, task);
            }}
          >
            {#snippet leading()}
              <ListSelectCheckbox {selection} id={item.row.key} noun="task" class="mr-2" />
            {/snippet}
          </ListRow>
        {/if}
      {/if}
    </div>
  {/snippet}
</VirtualList>
