<script lang="ts">
  import { PlusIcon } from "phosphor-svelte";
  import { fade } from "svelte/transition";
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
  const dragTask = $derived(tasks.find((t) => t.id === dragId) ?? null);

  function endDrag() {
    dragId = null;
    overStatus = null;
  }

  function drop(status: TaskStatus) {
    if (dragTask && dragTask.status !== status) onSetStatus(dragTask, status);
    endDrag();
  }
</script>

<!-- Columns are separated by whitespace alone — cards carry their own bounds, so
     a permanent column fill would just add mud. The well appears only when it
     means something: faintly on every valid target while a drag is live, and in
     accent on the hovered column. -->
<div class="-mx-1.5 flex gap-3 overflow-x-auto pb-2 [scrollbar-width:thin]">
  {#each columns as col (col.status)}
    {@const isOver = overStatus === col.status}
    {@const isSource = dragTask?.status === col.status}
    {@const isTarget = !!dragId && !isSource}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="group/col flex min-w-[15.5rem] max-w-[20rem] flex-1 flex-col rounded-2xl p-1.5 {isOver && isTarget
        ? 'bg-(--solus-accent-light)'
        : isTarget
          ? 'bg-(--solus-surface-hover)/40'
          : ''}"
      ondragover={(e) => {
        if (!dragId) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        overStatus = col.status;
      }}
      ondragleave={(e) => {
        // Ignore leaves into our own children — only a true exit clears the target.
        if (overStatus !== col.status) return;
        const to = e.relatedTarget;
        if (to instanceof Node && e.currentTarget.contains(to)) return;
        overStatus = null;
      }}
      ondrop={(e) => {
        e.preventDefault();
        drop(col.status);
      }}
    >
      <!-- Column header -->
      <div class="flex items-center gap-2 px-2 pb-2.5 pt-1">
        <span class="block size-2 shrink-0 rounded-full {STATUS_META[col.status].dotClass}"></span>
        <span class="text-[0.8125rem] font-semibold tracking-[-0.01em] text-(--solus-text-primary)">{col.label}</span>
        <span
          class="min-w-[1.375rem] rounded-full bg-(--solus-surface-hover) px-1.5 py-0.5 text-center text-[0.6875rem] font-medium leading-none text-(--solus-text-tertiary) tabular-nums"
          >{col.tasks.length}</span
        >
        {#if onAddInColumn}
          <button
            type="button"
            class="relative ml-auto inline-flex size-[1.375rem] cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-(--solus-text-tertiary) opacity-0 transition-opacity duration-100 ease-in-out after:absolute after:-inset-1.5 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:opacity-100 focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary) focus-visible:outline-none group-hover/col:opacity-100"
            onclick={() => onAddInColumn?.(col.status)}
            aria-label={`Add task to ${col.label}`}
            title={`Add task to ${col.label}`}
          >
            <PlusIcon size={13} weight="bold" />
          </button>
        {/if}
      </div>

      <!-- Cards -->
      <div class="flex flex-1 flex-col gap-2">
        {#each col.tasks as task (task.id)}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            draggable="true"
            class="rounded-[0.625rem] bg-(--solus-popover-bg) shadow-[0_1px_2px_rgba(0,0,0,0.04),0_2px_8px_rgba(0,0,0,0.04)] ring-1 ring-black/5 transition-[transform,box-shadow,opacity] duration-150 ease-out hover:-translate-y-px hover:shadow-[0_2px_4px_rgba(0,0,0,0.05),0_10px_24px_rgba(0,0,0,0.09)] hover:ring-black/10 has-[:focus-visible]:ring-(--solus-accent)/50 dark:shadow-none dark:ring-white/10 dark:hover:shadow-none dark:hover:ring-white/15 {dragId ===
            task.id
              ? 'opacity-40'
              : ''}"
            ondragstart={(e) => {
              if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", task.id);
              }
              dragId = task.id;
            }}
            ondragend={endDrag}
            in:fade={{ duration: 150 }}
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

        {#if isOver && isTarget && col.tasks.length > 0}
          <!-- Insertion slot: where the dragged card will land on drop. -->
          <div
            class="rounded-[0.625rem] border border-dashed border-(--solus-accent)/45 bg-(--solus-accent)/5 py-2.5 text-center text-[0.6875rem] font-semibold text-(--solus-accent)"
            in:fade={{ duration: 100 }}
          >
            Move to {col.label}
          </div>
        {/if}

        {#if col.tasks.length === 0}
          <div
            class="flex flex-1 items-center justify-center rounded-xl border border-dashed px-3 py-10 text-center text-xs {isOver && isTarget
              ? 'border-(--solus-accent)/50 text-(--solus-accent)'
              : 'border-(--solus-container-border)/60 text-(--solus-text-tertiary)'}"
          >
            {isOver && isTarget ? `Move to ${col.label}` : "Nothing here"}
          </div>
        {/if}

        {#if onAddInColumn}
          <!-- Always-visible add affordance at the column foot — the header's
               hover-revealed + serves long columns; this one is discoverable. -->
          <button
            type="button"
            class="flex cursor-pointer items-center gap-1.5 rounded-[0.625rem] border-0 bg-transparent px-3 py-2 text-left text-xs font-medium text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-secondary) focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary) focus-visible:outline-none"
            onclick={() => onAddInColumn?.(col.status)}
          >
            <PlusIcon size={12} weight="bold" />
            New task
          </button>
        {/if}
      </div>
    </div>
  {/each}
</div>
