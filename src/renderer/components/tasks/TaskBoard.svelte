<script lang="ts">
  import { PlusIcon } from "phosphor-svelte";
  import type { Task, TaskStatus } from "../../../shared/task-types";
  import { buildBoard, STATUS_META, type TaskSort } from "./lib/tasks-api";
  import TaskCard from "./TaskCard.svelte";

  interface Props {
    /** The project's tasks (already assignee-scoped server-side). */
    tasks: Task[];
    /** Free-text filter; the status filter is implicit in the columns. */
    query: string;
    /** Ordering within each column. */
    sort: TaskSort;
    onOpen: (task: Task) => void;
    onStart: (task: Task) => void;
    onOpenLink: (task: Task) => void;
    onSetStatus: (task: Task, status: TaskStatus) => void;
    onResume: (task: Task) => void;
    sessionsFor: (taskId: string) => number;
    /** Open the composer pre-set to a column's status (undefined hides the +). */
    onAddInColumn?: (status: TaskStatus) => void;
  }
  let {
    tasks,
    query,
    sort,
    onOpen,
    onStart,
    onOpenLink,
    onSetStatus,
    onResume,
    sessionsFor,
    onAddInColumn,
  }: Props = $props();

  const columns = $derived(buildBoard(tasks, query, sort));

  // Drag-to-restatus: the card being dragged and the column hovered over. Status
  // change is just an onSetStatus write — the same path the dropdown/keys use.
  let dragId = $state<string | null>(null);
  let overStatus = $state<TaskStatus | null>(null);

  function endDrag() {
    dragId = null;
    overStatus = null;
  }

  function drop(status: TaskStatus) {
    const task = tasks.find((t) => t.id === dragId);
    if (task && task.status !== status) onSetStatus(task, status);
    endDrag();
  }
</script>

<div class="flex h-full min-h-0 gap-3 overflow-x-auto pb-1 [scrollbar-width:thin]">
  {#each columns as col (col.status)}
    {@const isOver = overStatus === col.status}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="group/col flex min-h-0 min-w-[15.5rem] max-w-[20rem] flex-1 flex-col rounded-xl border border-transparent transition-colors duration-100 {isOver
        ? 'border-(--solus-accent)/40 bg-(--solus-accent-light)/40'
        : 'bg-(--solus-surface-hover)/35'}"
      ondragover={(e) => {
        if (!dragId) return;
        e.preventDefault();
        overStatus = col.status;
      }}
      ondragleave={() => {
        if (overStatus === col.status) overStatus = null;
      }}
      ondrop={(e) => {
        e.preventDefault();
        drop(col.status);
      }}
    >
      <!-- Column header -->
      <div class="flex items-center gap-2 px-3 pb-1.5 pt-2.5">
        <span class="block size-2 rounded-full {STATUS_META[col.status].dotClass}"></span>
        <span class="text-[0.75rem] font-semibold text-(--solus-text-primary)">{col.label}</span>
        <span class="text-[0.6875rem] text-(--solus-text-tertiary) tabular-nums">{col.tasks.length}</span>
        {#if onAddInColumn}
          <button
            type="button"
            class="ml-auto inline-flex size-[1.375rem] cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-(--solus-text-tertiary) opacity-0 transition-[background-color,color,opacity] duration-100 ease-in-out hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:opacity-100 focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary) focus-visible:outline-none group-hover/col:opacity-100"
            onclick={() => onAddInColumn?.(col.status)}
            aria-label={`Add task to ${col.label}`}
            title={`Add task to ${col.label}`}
          >
            <PlusIcon size={13} weight="bold" />
          </button>
        {/if}
      </div>

      <!-- Cards -->
      <div class="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-1.5 pb-2 [scrollbar-width:thin]">
        {#each col.tasks as task (task.id)}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            draggable="true"
            class="rounded-[0.625rem] border border-(--solus-popover-border)/80 bg-(--solus-popover-bg) shadow-[0_1px_2px_rgba(0,0,0,0.05),0_1px_1px_rgba(0,0,0,0.03)] transition-[box-shadow,border-color,opacity] duration-100 ease-in-out hover:border-(--solus-container-border) hover:shadow-[0_4px_12px_rgba(0,0,0,0.10)] {dragId ===
            task.id
              ? 'opacity-40'
              : ''}"
            ondragstart={() => (dragId = task.id)}
            ondragend={endDrag}
          >
            <TaskCard
              {task}
              board
              {onOpen}
              {onStart}
              {onOpenLink}
              {onSetStatus}
              {onResume}
              activeSessions={sessionsFor(task.id)}
            />
          </div>
        {/each}
        {#if col.tasks.length === 0}
          <div
            class="m-1 flex flex-1 items-center justify-center rounded-[0.625rem] border border-dashed px-2 py-6 text-center text-[0.6875rem] transition-colors duration-100 {isOver
              ? 'border-(--solus-accent)/50 text-(--solus-accent)'
              : 'border-(--solus-container-border)/70 text-(--solus-text-tertiary)'}"
          >
            {isOver ? `Drop to mark ${col.label}` : "Nothing here"}
          </div>
        {/if}
      </div>
    </div>
  {/each}
</div>
