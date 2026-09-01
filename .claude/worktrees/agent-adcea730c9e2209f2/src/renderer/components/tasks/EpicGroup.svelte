<script lang="ts">
  import { fade } from "svelte/transition";
  import { CaretDownIcon, StackIcon, PlusIcon } from "phosphor-svelte";
  import type { Task, TaskStatus } from "../../../shared/task-types";
  import TaskCard from "./TaskCard.svelte";

  interface Props {
    epic: Task;
    childTasks: Task[];
    onOpen: (task: Task) => void;
    /** Open the epic's own detail page (title/description/status live there). */
    onOpenEpic?: (epic: Task) => void;
    onStart: (task: Task) => void;
    onOpenLink: (task: Task) => void;
    onSetStatus: (task: Task, status: TaskStatus) => void;
    onResume?: (task: Task) => void;
    /** Sessions started from a given task id — drives the back-link badge. */
    sessionsFor?: (taskId: string) => number;
    /** Gates the "add child task" affordance (provider supports create). */
    canCreate?: boolean;
    onAddChild?: (epic: Task) => void;
    /** List-view multi-select: child cards read the shared selection store from
     *  context; this only gates whether they show the checkbox. */
    selectable?: boolean;
  }
  let {
    epic,
    childTasks,
    onOpen,
    onOpenEpic,
    onStart,
    onOpenLink,
    onSetStatus,
    onResume,
    sessionsFor,
    canCreate = false,
    onAddChild,
    selectable = false,
  }: Props = $props();

  let expanded = $state(true);

  const doneCount = $derived(
    childTasks.filter((c) => c.status === "done").length,
  );
  const pct = $derived(
    childTasks.length ? Math.round((doneCount / childTasks.length) * 100) : 0,
  );
</script>

<div class="flex flex-col">
  <!-- Epic header, split into two controls: the caret discloses, the title
       opens the epic's own detail page (where it can be edited, moved, started,
       or deleted like any task). -->
  <div
    class="group flex items-center gap-2 rounded-[0.625rem] px-2 py-2 transition-colors duration-150 ease-in-out hover:bg-(--solus-surface-hover)"
  >
    <button
      type="button"
      class="relative grid size-[1.125rem] shrink-0 place-items-center rounded border-0 bg-transparent cursor-pointer after:absolute after:-inset-1.5 focus-visible:outline-none focus-visible:bg-(--solus-accent-light)"
      onclick={() => (expanded = !expanded)}
      aria-expanded={expanded}
      aria-label={expanded ? "Collapse epic" : "Expand epic"}
      title={expanded ? "Collapse" : "Expand"}
    >
      <CaretDownIcon
        size={12}
        weight="bold"
        class="text-(--solus-text-tertiary) transition-transform duration-150 {expanded
          ? ''
          : '-rotate-90'}"
      />
    </button>
    <button
      type="button"
      class="flex min-w-0 flex-1 items-center gap-2 rounded-md border-0 bg-transparent text-left cursor-pointer focus-visible:outline-none focus-visible:bg-(--solus-accent-light)"
      onclick={() => (onOpenEpic ?? onOpen)(epic)}
      title="Open epic"
    >
      <StackIcon size={14} class="shrink-0 text-(--solus-accent)" />
      <span
        class="truncate text-[0.8125rem] font-semibold tracking-[-0.01em] text-(--solus-text-primary)"
        >{epic.title}</span
      >
      {#if childTasks.length}
        <span
          class="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-(--solus-surface-hover)"
          title={`${doneCount} of ${childTasks.length} done`}
        >
          <span
            class="block h-full rounded-full bg-(--solus-accent) transition-[width] duration-300"
            style:width={`${pct}%`}
          ></span>
        </span>
      {/if}
      <span class="shrink-0 text-[0.6875rem] text-(--solus-text-tertiary) tabular-nums">
        {doneCount}/{childTasks.length}
      </span>
    </button>
    {#if canCreate && onAddChild}
      <button
        type="button"
        class="relative shrink-0 grid size-[1.625rem] place-items-center rounded-[0.4375rem] border-0 bg-transparent text-(--solus-text-tertiary) opacity-0 transition-[opacity,background-color,color] duration-100 ease-in-out after:absolute after:-inset-1 group-hover:opacity-100 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:opacity-100 focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary) focus-visible:outline-none"
        onclick={() => onAddChild?.(epic)}
        aria-label="Add task to epic"
        title="Add task to this epic"
      >
        <PlusIcon size={13} weight="bold" />
      </button>
    {/if}
  </div>

  {#if expanded}
    {#if childTasks.length === 0}
      <p class="ml-5 px-3 py-2 text-[0.75rem] text-(--solus-text-tertiary)">
        No tasks in this epic yet.
      </p>
    {:else}
      <ul class="flex flex-col gap-0" role="list" aria-label={epic.title}>
        {#each childTasks as child (child.id)}
          <li out:fade={{ duration: 120 }}>
            <TaskCard
              task={child}
              {onOpen}
              {onStart}
              {onOpenLink}
              {onSetStatus}
              {onResume}
              activeSessions={sessionsFor?.(child.id) ?? 0}
              nested
              {selectable}
            />
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>
