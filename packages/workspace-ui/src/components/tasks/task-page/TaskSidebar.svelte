<script lang="ts">
  import type { Task, TaskAssigneeCandidate, TaskStatus, TaskUpdatePatch } from "@solus/contracts/task-types";
  import { GROUP, ROW, ROW_LABEL, VALUE, VALUE_BUTTON } from "./lib/sidebar-styles";
  import { RefreshCw as ArrowsClockwiseIcon, LoaderCircle as CircleNotchIcon, Folder as FolderIcon } from "@lucide/svelte";
  import ProjectFavicon from "../../ui/ProjectFavicon.svelte";
  import { SourceLogo } from "../../ui/list-page";
  import { relativeTime, STATUS_META } from "../lib/tasks-api";
  import TaskPriorityMenu from "./TaskPriorityMenu.svelte";
  import TaskStatusMenu from "./TaskStatusMenu.svelte";
  import TaskAssigneeMenu from "./TaskAssigneeMenu.svelte";
  import { priorityBars, priorityLabel, statusTextColor } from "./lib/task-page";
  import {
    syncToneColor,
    taskEpicRow,
    type TaskPublishTarget,
    type TaskUpstreamState,
  } from "./lib/task-upstream";
  import { Switch } from "../../ui/switch";
  import LabelPicker from "../../ui/labels/LabelPicker.svelte";

  interface Props {
    task: Task;
    /** Which of the sidebar's homes this is: the rail beside the task, or a
     *  panel opened under the task's title where the rail has folded. The panel
     *  takes the column's rhythm. */
    variant?: "column" | "panel";
    projectLabel: string;
    projectRoot?: string;
    serverId?: string | null;
    canEdit: boolean;
    canEditPlanningFields: boolean;
    canEditPriority: boolean;
    canEditLabels: boolean;
    labelCandidates: string[];
    canEditAssignee: boolean;
    assigneeCandidates: TaskAssigneeCandidate[];
    assigneeCandidatesLoading: boolean;
    assigneeCandidatesError?: string;
    editableStatuses: TaskStatus[];
    /** Null for a task with no upstream: the whole group is then absent, rather
     *  than present and empty. */
    upstream: TaskUpstreamState | null;
    /** Where this task could be filed when it has no ticket yet. Null when the
     *  project has no provider, or when it already has one. */
    publishTarget: TaskPublishTarget | null;
    syncing: boolean;
    /** The project posts every comment upstream. Null when the setting cannot
     *  be read or written from here, which hides the toggle. */
    autoPost: boolean | null;
    onSyncNow: () => void;
    onSetAutoPost: (next: boolean) => void;
    onPublishAll: () => void;
    onPublishTask: () => void;
    onOpenUpstream: (url: string) => void;
    onSave: (patch: TaskUpdatePatch) => Promise<void> | void;
    onOpenAssigneeMenu: () => void;
  }

  let {
    task,
    variant = "column",
    projectLabel,
    projectRoot,
    serverId,
    canEdit,
    canEditPlanningFields,
    canEditPriority,
    canEditLabels,
    labelCandidates,
    canEditAssignee,
    assigneeCandidates,
    assigneeCandidatesLoading,
    assigneeCandidatesError,
    editableStatuses,
    upstream,
    publishTarget,
    syncing,
    autoPost,
    onSyncNow,
    onSetAutoPost,
    onPublishAll,
    onPublishTask,
    onOpenUpstream,
    onSave,
    onOpenAssigneeMenu,
  }: Props = $props();

  // The panel spans the task's column, which can be three rails wide. One list
  // of 34px rows there leaves every value against the left edge and the rest
  // of the card empty, so where a row still gets a rail's width the rows pair
  // up into two columns.
  const panel = $derived(variant === "panel");
  const ROWS = $derived(
    panel
      ? "grid grid-cols-1 gap-x-8 gap-y-1 @[40rem]:grid-cols-2"
      : "flex flex-col gap-1",
  );

  const status = $derived(STATUS_META[task.status]);
  const bars = $derived(priorityBars(task.priority));
  // Task labels are names alone; the picker draws them in the accent.
  const taskLabels = $derived(task.labels.map((name) => ({ name })));
  const labelCandidateOptions = $derived(labelCandidates.map((name) => ({ name })));
  const epic = $derived(taskEpicRow(task));
</script>


<div
  class={panel
    ? "@container flex w-full flex-col rounded-xl bg-card shadow-[shadow:var(--elev-ring)]"
    : "sticky top-0 flex w-[var(--task-rail-width)] [--task-rail-width:308px] shrink-0 flex-col rounded-2xl bg-card shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_11%,transparent),0_1px_2px_-1px_rgba(0,0,0,.05),0_12px_28px_-12px_rgba(0,0,0,.14)]"}
>
  <div class={panel ? `${ROWS} px-3.5 pt-[15px] pb-4` : GROUP}>
    <div class={ROW}>
      <span class={ROW_LABEL}>Status</span>
      <TaskStatusMenu
        status={task.status}
        options={editableStatuses}
        onSelect={(next) => onSave({ status: next })}
        align="start"
        triggerClass={VALUE_BUTTON}
      >
        {#snippet trigger()}
          <svg
            width="12"
            height="12"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            stroke-width="1.45"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="shrink-0"
            style="color:{statusTextColor(task.status)}"
            aria-hidden="true"><path d={status.glyph} /></svg
          >
          {status.label}
        {/snippet}
      </TaskStatusMenu>
    </div>

    <div class={ROW}>
      <span class={ROW_LABEL}>Priority</span>
      <TaskPriorityMenu
        priority={task.priority}
        disabled={!canEditPriority}
        onSelect={(next) => onSave({ priority: next })}
        align="start"
        triggerClass={VALUE_BUTTON}
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
        disabled={!canEditAssignee}
        align="start"
        triggerClass={canEditAssignee ? VALUE_BUTTON : VALUE}
        onOpen={onOpenAssigneeMenu}
        onSelect={(assignee) => onSave({ assignee })}
      />
    </div>

    <div class={ROW}>
      <span class={ROW_LABEL}>Project</span>
      <span class="{VALUE} min-w-0">
        {#if projectRoot}
          <ProjectFavicon {serverId} projectRoot={projectRoot} class="size-3" />
        {:else}
          <FolderIcon size={12} class="shrink-0 text-(--solus-text-tertiary)" />
        {/if}
        <span class="truncate">{projectLabel}</span>
      </span>
    </div>

    <!-- Read-only: the epic comes with the upstream ticket, and Solus never
         moves a task between epics. Its description is agent context, so the
         row only names it and opens it upstream. -->
    {#if epic}
      {@const epicUrl = epic.url}
      <div class={ROW}>
        <span class={ROW_LABEL}>Epic</span>
        <button
          type="button"
          class="{VALUE_BUTTON} min-w-0 overflow-hidden"
          onclick={() => onOpenUpstream(epicUrl)}
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

    <div class="flex min-h-[34px] items-center">
      <span class={ROW_LABEL}>Labels</span>
      <span class="flex min-w-0 flex-1 items-center pl-2">
        <LabelPicker
          labels={taskLabels}
          candidates={labelCandidateOptions}
          allowCreate
          align="start"
          menuLabel="Edit task labels"
          onSet={canEditLabels ? (labels) => onSave({ labels }) : undefined}
        />
      </span>
    </div>

    <div class={ROW}>
      <span class={ROW_LABEL}>Target</span>
      {#if canEditPlanningFields}
        <input
          type="date"
          class="h-[34px] cursor-pointer rounded-md bg-transparent text-muted-foreground outline-none hover:bg-[var(--wash-2)] hover:text-foreground flex-1 px-2"
          value={task.dueDate ?? ""}
          onchange={(e) => onSave({ dueDate: e.currentTarget.value || null })}
          aria-label="Target date"
        />
      {:else}
        <span class="flex h-[34px] flex-1 items-center px-2  text-muted-foreground">
          {task.dueDate ?? "None"}
        </span>
      {/if}
    </div>
  </div>

  {#if upstream}
    {@const tone = syncToneColor(upstream.tone)}
    <div
      class="flex flex-col gap-[11px] border-t-[.5px] border-[var(--hairline)] px-3.5 pt-[15px] pb-4"
    >
      <span class="pl-0.5 font-normal text-muted-foreground uppercase">Upstream</span>
      <div class={ROWS}>
        <div class={ROW}>
          <span class={ROW_LABEL}>Provider</span>
          {#if upstream.url}
            {@const url = upstream.url}
            <button
              type="button"
              class="{VALUE_BUTTON} min-w-0 overflow-hidden"
              onclick={() => onOpenUpstream(url)}
              title="Open {upstream.provider} {upstream.ref} in the browser"
            >
              <SourceLogo source={upstream.providerId} />
              <span class="truncate">{upstream.provider}</span>
              <span class="flex-1"></span>
              <span class="shrink-0  text-muted-foreground opacity-80">
                {upstream.ref}
              </span>
            </button>
          {:else}
            <span class="{VALUE} min-w-0">
              <SourceLogo source={upstream.providerId} />
              <span class="truncate">{upstream.provider}</span>
            </span>
          {/if}
        </div>

        <div class={ROW}>
          <span class={ROW_LABEL}>State</span>
          <span
            class="{VALUE} min-w-0"
            title={upstream.title}
          >
            <span class="size-[6px] shrink-0 rounded-full" style="background:{tone}"></span>
            <span class="truncate" style="color:{tone}">{upstream.label}</span>
          </span>
        </div>

        {#if upstream.canSync && autoPost !== null}
          <div class={ROW}>
            <span class={ROW_LABEL}>Auto-post</span>
            <span class="{VALUE} min-w-0">
              <Switch
                size="sm"
                checked={autoPost}
                onCheckedChange={onSetAutoPost}
                aria-label="Post every comment to {upstream.provider}"
              />
              <span class="truncate {autoPost ? '' : 'text-muted-foreground'}">
                {autoPost ? "Every comment" : "Off"}
              </span>
            </span>
          </div>
        {/if}

        {#if upstream.canSync}
          <div class={ROW}>
            <span class={ROW_LABEL}>Pending</span>
            <span class="{VALUE} min-w-0">
              <span
                class="truncate {upstream.pendingCount ? '' : 'text-muted-foreground'}"
                title={upstream.title}
              >
                {upstream.pendingLabel}
              </span>
              <span class="flex-1"></span>
              {#if upstream.heldBackCount}
                <button
                  type="button"
                  class="flex h-[22px] shrink-0 cursor-pointer items-center rounded-md px-2  font-medium text-muted-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)] transition-colors hover:text-primary hover:shadow-[0_0_0_.5px_color-mix(in_oklch,var(--primary)_45%,transparent)]"
                  onclick={onPublishAll}
                  title="Publish {upstream.heldBackCount} held-back comment{upstream.heldBackCount ===
                  1
                    ? ''
                    : 's'} to {upstream.provider}"
                >
                  Publish all
                </button>
              {/if}
              <!-- The engine pushes on its own debounce; this is the user saying
                   don't wait — after repairing auth, or before trusting the page. -->
              <button
                type="button"
                class="flex h-[22px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2  font-medium text-muted-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)] transition-colors hover:text-primary hover:shadow-[0_0_0_.5px_color-mix(in_oklch,var(--primary)_45%,transparent)] disabled:pointer-events-none disabled:opacity-45"
                onclick={onSyncNow}
                disabled={syncing}
              >
                {#if syncing}
                  <CircleNotchIcon
                    size={11}
                    class="animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                  Syncing
                {:else}
                  <ArrowsClockwiseIcon size={11} aria-hidden="true" />
                  Sync now
                {/if}
              </button>
            </span>
          </div>
        {/if}
      </div>
    </div>

  {/if}

  {#if publishTarget}
    <!-- A local task in a project that files tickets: the page says where it
         would go and offers to put it there, rather than leaving the provider
         reachable only from the Tasks list. -->
    <div
      class="flex flex-col gap-[11px] border-t-[.5px] border-[var(--hairline)] px-3.5 pt-[15px] pb-4"
    >
      <span class="pl-0.5 font-normal text-muted-foreground uppercase">Upstream</span>
      <div class={ROWS}>
        <div class={ROW}>
          <span class={ROW_LABEL}>Provider</span>
          <!-- Only the provider: the repository is the project this page is
               already in, so naming it here spends the row's width on something
               the user knows. It rides the Publish button's title instead. -->
          <span
            class="{VALUE} min-w-0"
            title={publishTarget.scope ?? undefined}
          >
            <SourceLogo source={publishTarget.providerId} />
            <span class="truncate">{publishTarget.provider}</span>
          </span>
        </div>
        <div class={ROW}>
          <span class={ROW_LABEL}>State</span>
          <span class="{VALUE} min-w-0">
            <span class="truncate text-muted-foreground">Solus only</span>
            <span class="flex-1"></span>
            <button
              type="button"
              class="flex h-[22px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2  font-medium text-muted-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)] transition-colors hover:text-primary hover:shadow-[0_0_0_.5px_color-mix(in_oklch,var(--primary)_45%,transparent)] disabled:pointer-events-none disabled:opacity-45"
              onclick={onPublishTask}
              disabled={syncing}
              title="Create an issue in {publishTarget.scope ??
                publishTarget.provider} for this task and keep the two in sync"
            >
              {#if syncing}
                <CircleNotchIcon
                  size={11}
                  class="animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
                Publishing
              {:else}
                Publish
              {/if}
            </button>
          </span>
        </div>
      </div>
    </div>
  {/if}

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
