<script lang="ts">
  import type {
    Task,
    TaskAssigneeCandidate,
    TaskMoveTarget,
    TaskUpdatePatch,
  } from "@solus/contracts/task-types";
  import { GROUP, ROW, ROW_LABEL, VALUE, VALUE_BUTTON } from "./lib/sidebar-styles";
  import ProjectFavicon from "../../ui/ProjectFavicon.svelte";
  import { SourceLogo } from "../../ui/list-page";
  import {
    CATEGORY_META,
    PROVIDER_NAMES,
    relativeTime,
    taskRef,
    type TaskPlacementLabel,
  } from "../lib/tasks-api";
  import TaskPriorityMenu from "./TaskPriorityMenu.svelte";
  import TaskStatusMenu from "./TaskStatusMenu.svelte";
  import TaskAssigneeMenu from "./TaskAssigneeMenu.svelte";
  import {
    priorityBars,
    priorityLabel,
    statusTextColor,
    taskStateLabel,
    type TaskFieldLocks,
  } from "./lib/task-page";
  import { taskEpicRow } from "./lib/task-epic";
  import type { TaskMoveGroup } from "./lib/task-move";
  import LabelPicker from "../../ui/labels/LabelPicker.svelte";

  interface Props {
    task: Task;
    /** Which of the sidebar's homes this is: the rail beside the task, or a
     *  panel opened under the task's title where the rail has folded. The panel
     *  takes the column's rhythm. */
    variant?: "column" | "panel";
    /** The task's project, as a person reads it. Null when no project of this
     *  client lists the task. */
    projectLabel: string | null;
    /** The task's project, as `projectsStore` keys it. */
    projectKey?: string | null;
    /** Why each field editor is disabled (`taskFieldLocks`). */
    locks: TaskFieldLocks;
    /** The task's column in each source that lists it. */
    placements: TaskPlacementLabel[];
    /** What the move menu offers (`taskMoveGroups`). */
    moveGroups: TaskMoveGroup[];
    labelCandidates: string[];
    assigneeCandidates: TaskAssigneeCandidate[];
    assigneeCandidatesLoading: boolean;
    assigneeCandidatesError: string | null;
    onMove: (target: TaskMoveTarget) => void;
    /** Answers false when the provider refused the change. */
    onSave: (patch: TaskUpdatePatch) => Promise<boolean>;
    onOpenExternal: (url: string) => void;
    onOpenAssigneeMenu: () => void;
  }

  let {
    task,
    variant = "column",
    projectLabel,
    projectKey,
    locks,
    placements,
    moveGroups,
    labelCandidates,
    assigneeCandidates,
    assigneeCandidatesLoading,
    assigneeCandidatesError,
    onMove,
    onSave,
    onOpenExternal,
    onOpenAssigneeMenu,
  }: Props = $props();

  // The panel spans the task's column, which can be three rails wide. One list
  // of 34px rows there leaves every value against the left edge and the rest
  // of the card empty, so where a row still gets a rail's width the rows pair
  // up into two columns.
  const panel = $derived(variant === "panel");

  const bars = $derived(priorityBars(task.priority));
  // Task labels are names alone; the picker draws them in the accent.
  const taskLabels = $derived(task.labels.map((name) => ({ name })));
  const labelCandidateOptions = $derived(labelCandidates.map((name) => ({ name })));
  const epic = $derived(taskEpicRow(task));

  /** The date input holds what the person chose. When the provider refuses
   *  the change, the input takes the task's date back. */
  async function saveDueDate(input: HTMLInputElement): Promise<void> {
    const saved = await onSave({ dueDate: input.value || null });
    if (!saved) input.value = task.dueDate ?? "";
  }
</script>


<div
  class={panel
    ? "@container flex w-full flex-col rounded-xl bg-card shadow-[shadow:var(--elev-ring)]"
    : "sticky top-0 flex w-[var(--task-rail-width)] [--task-rail-width:308px] shrink-0 flex-col rounded-2xl bg-card shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_11%,transparent),0_1px_2px_-1px_rgba(0,0,0,.05),0_12px_28px_-12px_rgba(0,0,0,.14)]"}
>
  <div class={panel ? "grid grid-cols-1 gap-x-8 gap-y-1 px-3.5 pt-[15px] pb-4 @[40rem]:grid-cols-2" : GROUP}>
    <div class={ROW}>
      <span class={ROW_LABEL}>Status</span>
      <TaskStatusMenu
        groups={moveGroups}
        onSelect={onMove}
        align="start"
        triggerClass="{VALUE_BUTTON} min-w-0 overflow-hidden"
      >
        {#snippet trigger()}
          <svg
            width="12"
            height="12"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            stroke-width="0.875"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="shrink-0"
            style="color:{statusTextColor(task.category)}"
            aria-hidden="true"><path d={CATEGORY_META[task.category].glyph} /></svg
          >
          <span class="truncate">{taskStateLabel(task)}</span>
        {/snippet}
      </TaskStatusMenu>
    </div>

    <!-- The task's column in each source that lists it. The Status menu above
         moves the task; these rows only say where it is. -->
    {#each placements as placement (placement.sourceKey)}
      <div class={ROW}>
        <span class={ROW_LABEL}>Column</span>
        <span
          class="{VALUE} min-w-0"
          title="{placement.sourceLabel}: {placement.columnName ?? 'No column'}"
        >
          <span class="truncate {placement.columnName ? '' : 'text-muted-foreground'}">
            {placement.columnName ?? "No column"}
          </span>
          <span class="flex-1"></span>
          <span class="max-w-[50%] shrink-0 truncate text-muted-foreground opacity-80">
            {placement.sourceLabel}
          </span>
        </span>
      </div>
    {/each}

    <div class={ROW}>
      <span class={ROW_LABEL}>Priority</span>
      <TaskPriorityMenu
        priority={task.priority}
        lock={locks.priority}
        onSelect={(next) => void onSave({ priority: next })}
        align="start"
        triggerClass="{VALUE_BUTTON} disabled:cursor-default disabled:hover:bg-transparent"
      >
        {#snippet trigger()}
          <span class="flex h-[9px] shrink-0 items-end gap-[1.5px]" aria-hidden="true">
            {#each bars as bar (bar.height)}
              <span
                class="w-[2.5px] rounded-[0.0625rem]"
                style="height:{bar.height};background:{bar.background}"
              ></span>
            {/each}
          </span>
          {priorityLabel(task.priority)}
        {/snippet}
      </TaskPriorityMenu>
    </div>

    <div class={ROW}>
      <span class={ROW_LABEL}>Assignee</span>
      <TaskAssigneeMenu
        assignee={task.assignee}
        assigneeAvatarUrl={task.assigneeAvatarUrl ?? assigneeCandidates.find((candidate) => candidate.login === task.assignee)?.avatarUrl}
        candidates={assigneeCandidates}
        loading={assigneeCandidatesLoading}
        error={assigneeCandidatesError}
        lock={locks.assignee}
        align="start"
        triggerClass={locks.assignee === null ? VALUE_BUTTON : VALUE}
        onOpen={onOpenAssigneeMenu}
        onSelect={(assignee) => void onSave({ assignee })}
      />
    </div>

    {#if projectLabel}
      <div class={ROW}>
        <span class={ROW_LABEL}>Project</span>
        <span class="{VALUE} min-w-0">
          {#if projectKey}
            <ProjectFavicon {projectKey} class="size-3" />
          {/if}
          <span class="truncate">{projectLabel}</span>
        </span>
      </div>
    {/if}

    <div class={ROW}>
      <span class={ROW_LABEL}>Provider</span>
      {#if task.url}
        {@const url = task.url}
        <button
          type="button"
          class="{VALUE_BUTTON} min-w-0 overflow-hidden"
          onclick={() => onOpenExternal(url)}
          title="Open {task.reference ?? 'this task'} in {PROVIDER_NAMES[task.providerId]}"
        >
          <SourceLogo source={task.providerId} />
          <span class="truncate">{PROVIDER_NAMES[task.providerId]}</span>
          <span class="flex-1"></span>
          <span class="shrink-0 text-muted-foreground opacity-80">{taskRef(task)}</span>
        </button>
      {:else}
        <!-- A draft is on a board only: it has no page on the provider. -->
        <span class="{VALUE} min-w-0">
          <SourceLogo source={task.providerId} />
          <span class="truncate">{PROVIDER_NAMES[task.providerId]}</span>
          <span class="flex-1"></span>
          <span class="shrink-0 text-muted-foreground opacity-80">{taskRef(task)}</span>
        </span>
      {/if}
    </div>

    <!-- Read-only: the epic comes with the task from its provider, and Solus
         never moves a task between epics. Its description is agent context, so
         the row only names it and opens it on the provider. -->
    {#if epic}
      {@const epicUrl = epic.url}
      <div class={ROW}>
        <span class={ROW_LABEL}>Epic</span>
        <button
          type="button"
          class="{VALUE_BUTTON} min-w-0 overflow-hidden"
          onclick={() => onOpenExternal(epicUrl)}
          disabled={!epicUrl}
          title={epic.hint}
        >
          <SourceLogo source={epic.providerId} />
          <span class="truncate">{epic.title}</span>
          <span class="flex-1"></span>
          <span class="shrink-0 text-muted-foreground opacity-80">{epic.ref}</span>
        </button>
      </div>
    {/if}

    <div class="flex min-h-[34px] items-center" title={locks.labels ?? undefined}>
      <span class={ROW_LABEL}>Labels</span>
      <span class="flex min-w-0 flex-1 items-center pl-2">
        <LabelPicker
          labels={taskLabels}
          candidates={labelCandidateOptions}
          allowCreate
          align="start"
          menuLabel="Edit task labels"
          onSet={locks.labels === null ? async (labels) => { await onSave({ labels }); } : undefined}
        />
      </span>
    </div>

    <div class={ROW}>
      <span class={ROW_LABEL}>Due</span>
      {#if locks.dueDate === null}
        <input
          type="date"
          class="h-[34px] flex-1 cursor-pointer rounded-md bg-transparent px-2 text-muted-foreground outline-none hover:bg-[var(--wash-2)] hover:text-foreground focus-visible:bg-[var(--wash-2)] focus-visible:text-foreground"
          value={task.dueDate ?? ""}
          onchange={(event) => void saveDueDate(event.currentTarget)}
          aria-label="Due date"
        />
      {:else}
        <span
          class="flex h-[34px] flex-1 items-center px-2 text-muted-foreground"
          title={locks.dueDate}
        >
          {task.dueDate ?? "None"}
        </span>
      {/if}
    </div>
  </div>

  <div
    class="flex items-center gap-2 border-t-[.5px] border-[var(--hairline)] px-4 pt-[13px] pb-3.5"
  >
    <span class="text-muted-foreground opacity-80">Created</span>
    <span class="text-muted-foreground opacity-65">
      {task.createdAt ? relativeTime(task.createdAt) : "—"}
    </span>
    <!-- Across the panel's width the two dates would sit a card apart; they
         are one fact about the record, so there they stay together. -->
    {#if panel}
      <span class="mx-1 h-[11px] w-px bg-[var(--hairline-strong)]" aria-hidden="true"></span>
    {:else}
      <span class="flex-1"></span>
    {/if}
    <span class="text-muted-foreground opacity-80">Updated</span>
    <span class="text-muted-foreground opacity-65">
      {relativeTime(task.updatedAt)}
    </span>
  </div>
</div>
