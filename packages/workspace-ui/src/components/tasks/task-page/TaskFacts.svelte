<script lang="ts">
  import {
    CalendarDays as CalendarIcon,
    Columns3 as ColumnIcon,
    ExternalLink as ExternalLinkIcon,
    Layers as EpicIcon,
    Tag as TagIcon,
    UserRound as AssigneeIcon,
  } from "@lucide/svelte";
  import type { Issue, IssueAssigneeCandidate, IssueUpdatePatch } from "@solus/contracts/task-types";
  import { SourceLogo } from "../../ui/list-page";
  import LabelPicker from "../../ui/labels/LabelPicker.svelte";
  import { PROVIDER_NAMES, taskRef, type TaskPlacementLabel } from "../lib/tasks-api";
  import TaskAssigneeMenu from "./TaskAssigneeMenu.svelte";
  import type { TaskFieldLocks } from "./lib/task-page";
  import { taskEpicRow } from "./lib/task-epic";

  /**
   * The task's facts under its title, where the pane is too narrow for the
   * rail's column — the pull request page's facts list (`PrChangeFacts`) for a
   * task. Captioned rows in one two-column list, each caption led by its
   * glyph, so the eye reads down one edge of captions and across to the
   * facts. Every fact the rail edits is edited here in place.
   *
   * Status and priority are not here: the line above the title holds them.
   * Metadata, so it reads at the meta rung (`text-xs`).
   */
  interface Props {
    task: Issue;
    /** Why each field editor is disabled (`taskFieldLocks`). */
    locks: TaskFieldLocks;
    /** The task's column in each source that lists it. */
    placements: TaskPlacementLabel[];
    labelCandidates: string[];
    assigneeCandidates: IssueAssigneeCandidate[];
    assigneeCandidatesLoading: boolean;
    assigneeCandidatesError: string | null;
    /** Answers false when the provider refused the change. */
    onSave: (patch: IssueUpdatePatch) => Promise<boolean>;
    onOpenExternal: (url: string) => void;
    onOpenAssigneeMenu: () => void;
  }

  let {
    task,
    locks,
    placements,
    labelCandidates,
    assigneeCandidates,
    assigneeCandidatesLoading,
    assigneeCandidatesError,
    onSave,
    onOpenExternal,
    onOpenAssigneeMenu,
  }: Props = $props();

  // Issue labels are names alone; the picker draws them in the accent.
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

<!-- Captions take a fixed column so the facts share one left edge. -->
<dl
  class="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-7 gap-y-1.5 text-xs text-muted-foreground"
>
  <dt class="flex items-center gap-2">
    <AssigneeIcon size={12} class="shrink-0 opacity-80" aria-hidden="true" />
    Assignee
  </dt>
  <dd class="flex min-h-6 min-w-0 items-center">
    <TaskAssigneeMenu
      assignee={task.assignee}
      assignees={task.assignees}
      onSelectMany={task.providerId === "github" ? (assignees) => void onSave({ assignees }) : undefined}
      assigneeAvatarUrl={task.assigneeAvatarUrl ??
        assigneeCandidates.find((candidate) => candidate.login === task.assignee)?.avatarUrl}
      candidates={assigneeCandidates}
      loading={assigneeCandidatesLoading}
      error={assigneeCandidatesError}
      lock={locks.assignee}
      align="start"
      triggerClass="-mx-1.5 flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 overflow-hidden rounded-md px-1.5 py-0.5 text-foreground transition-colors hover:bg-[var(--wash-2)] disabled:cursor-default disabled:hover:bg-transparent"
      onOpen={onOpenAssigneeMenu}
      onSelect={(assignee) => void onSave({ assignee })}
    />
  </dd>

  <dt class="flex items-center gap-2" title={locks.labels ?? undefined}>
    <TagIcon size={12} class="shrink-0 opacity-80" aria-hidden="true" />
    Labels
  </dt>
  <dd class="flex min-h-6 min-w-0 items-center">
    <LabelPicker
      labels={taskLabels}
      candidates={labelCandidateOptions}
      allowCreate
      align="start"
      menuLabel="Edit issue labels"
      onSet={locks.labels === null
        ? async (labels) => {
            await onSave({ labels });
          }
        : undefined}
    />
  </dd>

  <dt class="flex items-center gap-2">
    <CalendarIcon size={12} class="shrink-0 opacity-80" aria-hidden="true" />
    Due
  </dt>
  <dd class="flex min-h-6 min-w-0 items-center">
    {#if locks.dueDate === null}
      <input
        type="date"
        class="-mx-1.5 h-6 cursor-pointer rounded-md bg-transparent px-1.5 text-foreground outline-none hover:bg-[var(--wash-2)] focus-visible:bg-[var(--wash-2)]"
        value={task.dueDate ?? ""}
        onchange={(event) => void saveDueDate(event.currentTarget)}
        aria-label="Due date"
      />
    {:else}
      <span class="text-foreground" title={locks.dueDate}>{task.dueDate ?? "None"}</span>
    {/if}
  </dd>

  <!-- The task's column in each source that lists it. The status menu on the
       line above moves the task; these rows only say where it is. -->
  {#each placements as placement (placement.sourceKey)}
    <dt class="flex items-center gap-2">
      <ColumnIcon size={12} class="shrink-0 opacity-80" aria-hidden="true" />
      Column
    </dt>
    <dd
      class="flex min-h-6 min-w-0 items-center gap-1.5"
      title="{placement.sourceLabel}: {placement.columnName ?? 'No column'}"
    >
      <span class="truncate {placement.columnName ? 'text-foreground' : ''}">
        {placement.columnName ?? "No column"}
      </span>
      <span class="shrink-0 opacity-60" aria-hidden="true">·</span>
      <span class="min-w-0 truncate">{placement.sourceLabel}</span>
    </dd>
  {/each}

  {#if epic}
    {@const epicUrl = epic.url}
    <!-- Read-only: the epic comes with the task from its provider. -->
    <dt class="flex items-center gap-2">
      <EpicIcon size={12} class="shrink-0 opacity-80" aria-hidden="true" />
      Epic
    </dt>
    <dd class="flex min-h-6 min-w-0 items-center">
      <button
        type="button"
        class="-mx-1.5 flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 overflow-hidden rounded-md px-1.5 py-0.5 text-left text-foreground transition-colors hover:bg-[var(--wash-2)] disabled:cursor-default disabled:hover:bg-transparent"
        onclick={() => epicUrl && onOpenExternal(epicUrl)}
        disabled={!epicUrl}
        title={epic.hint}
      >
        <SourceLogo source={epic.providerId} />
        <span class="truncate">{epic.title}</span>
        <span class="shrink-0 text-muted-foreground">{epic.ref}</span>
      </button>
    </dd>
  {/if}

  <dt class="flex items-center gap-2">
    <ExternalLinkIcon size={12} class="shrink-0 opacity-80" aria-hidden="true" />
    Provider
  </dt>
  <dd class="flex min-h-6 min-w-0 items-center">
    {#if task.url}
      {@const url = task.url}
      <button
        type="button"
        class="-mx-1.5 flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 overflow-hidden rounded-md px-1.5 py-0.5 text-left text-foreground transition-colors hover:bg-[var(--wash-2)]"
        onclick={() => onOpenExternal(url)}
        title="Open {task.reference ?? 'this issue'} in {PROVIDER_NAMES[task.providerId]}"
      >
        <SourceLogo source={task.providerId} />
        <span class="truncate">{PROVIDER_NAMES[task.providerId]}</span>
        <span class="shrink-0 font-mono text-muted-foreground">{taskRef(task)}</span>
      </button>
    {:else}
      <!-- A draft is on a board only: it has no page on the provider. -->
      <span class="flex min-w-0 items-center gap-1.5 text-foreground">
        <SourceLogo source={task.providerId} />
        <span class="truncate">{PROVIDER_NAMES[task.providerId]}</span>
        <span class="shrink-0 font-mono text-muted-foreground">{taskRef(task)}</span>
      </span>
    {/if}
  </dd>
</dl>
