<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import type { AgentId } from "@solus/contracts/types";
  import type { Task, TaskPriority, TaskStatus } from "@solus/contracts/task-types";
  import { getAgentContext, getWorkspaceContext } from "../../../contexts";
  import DocumentPromptEditor from "../../editor/DocumentPromptEditor.svelte";
  import { Input } from "../../ui/input";
  import { relativeTime, STATUS_META } from "../lib/tasks-api";
  import { priorityBars, priorityLabel, statusTextColor } from "./lib/task-page";
  import TaskPriorityMenu from "./TaskPriorityMenu.svelte";
  import TaskStatusMenu from "./TaskStatusMenu.svelte";

  interface Props {
    task: Task;
    canEdit: boolean;
    onSaveTitle: (title: string) => void;
    onSaveBody: (body: string) => void;
    /** The statuses this task's provider accepts. Empty leaves the status chip
     *  as the label it always was, rather than a control that cannot act. */
    editableStatuses: TaskStatus[];
    canEditPriority: boolean;
    onSaveStatus: (status: TaskStatus) => void;
    onSavePriority: (priority: TaskPriority | null) => void;
    /** Who owns the task, which branch it runs on, and which ticket it mirrors —
     *  one row between the title and the body. It is the record rung's stand-in
     *  for the sidebar's top three fields, so it is absent wherever that column
     *  is actually on screen. */
    identity?: Snippet;
  }

  let {
    task,
    canEdit,
    onSaveTitle,
    onSaveBody,
    editableStatuses,
    canEditPriority,
    onSaveStatus,
    onSavePriority,
    identity,
  }: Props = $props();

  // The description reuses the document editor so a task can embed @files,
  // /skills, #plans, %docs and !PRs; refs round-trip through the saved markdown.
  const session = getWorkspaceContext();
  const agentContext = getAgentContext();
  const editorProvider = $derived<AgentId>(
    agentContext.activeMetadata?.id ?? "claude-code",
  );
  const editorCwd = $derived(session.tasksProjectCwd ?? undefined);

  const status = $derived(STATUS_META[task.status]);
  const bars = $derived(priorityBars(task.priority));
  const openedAt = $derived(task.createdAt ? relativeTime(task.createdAt) : "");

  let titleDraft = $state(untrack(() => task.title));
  let bodyDraft = $state(untrack(() => task.body));
  // Re-seed when the route swaps to another task: the same component instance
  // is reused, so drafts must follow the id rather than the mount.
  let seededId = untrack(() => task.id);
  $effect(() => {
    if (task.id === seededId) return;
    seededId = task.id;
    titleDraft = task.title;
    bodyDraft = task.body;
  });

  function commitTitle() {
    const next = titleDraft.trim();
    if (!next || next === task.title) {
      titleDraft = task.title;
      return;
    }
    onSaveTitle(next);
  }
</script>

<!-- Status and priority are the two facts in this row that are also decisions,
     so they are the menus that make them. The negative inline margin keeps each
     label optically where it sat as plain text while giving the control a
     padded hit area, and a task whose provider will not take the change keeps
     the label and loses only the affordance. -->
<div class="flex items-center gap-[13px] pb-[11px] [.is-laptop-display_&]:gap-2.5 [.is-laptop-display_&]:pb-2">
  <TaskStatusMenu
    status={task.status}
    options={editableStatuses}
    onSelect={onSaveStatus}
    triggerClass="-mx-1.5 inline-flex h-[26px] cursor-pointer items-center gap-1.5 rounded-md px-1.5 font-normal transition-colors hover:bg-[var(--wash-2)] disabled:cursor-default disabled:hover:bg-transparent [.is-laptop-display_&]:h-[22px]"
  >
    {#snippet trigger()}
      <span
        class="inline-flex items-center gap-1.5"
        style="color:{statusTextColor(task.status)}"
      >
        <!-- The class carries the size, not the attributes: a CSS width beats
             the presentation attribute, which is what lets the glyph step. -->
        <svg
          width="13"
          height="13"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          stroke-width="1.45"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="size-[13px] shrink-0 [.is-laptop-display_&]:size-3"
          aria-hidden="true"><path d={status.glyph} /></svg
        >
        {status.label}
      </span>
    {/snippet}
  </TaskStatusMenu>

  <span
    class="h-[11px] w-px bg-[var(--hairline-strong)] [.is-laptop-display_&]:h-2.5"
    aria-hidden="true"
  ></span>

  <TaskPriorityMenu
    priority={task.priority}
    disabled={!canEditPriority}
    onSelect={onSavePriority}
    triggerClass="-mx-1.5 inline-flex h-[26px] cursor-pointer items-center gap-1.5 rounded-md px-1.5 font-normal text-muted-foreground transition-colors hover:bg-[var(--wash-2)] disabled:cursor-default disabled:hover:bg-transparent [.is-laptop-display_&]:h-[22px]"
  >
    {#snippet trigger()}
      <span
        class="flex h-[9px] shrink-0 items-end gap-[1.5px] [.is-laptop-display_&]:h-2"
        aria-hidden="true"
      >
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

  {#if openedAt}
    <span
      class="h-[11px] w-px bg-[var(--hairline-strong)] [.is-laptop-display_&]:h-2.5"
      aria-hidden="true"
    ></span>
    <span class="text-xs text-muted-foreground opacity-75">opened {openedAt}</span>
  {/if}
</div>

{#if canEdit}
  <Input
    class="m-0 h-auto w-full rounded-none border-0 bg-transparent! p-0 text-2xl leading-[1.25] font-medium text-pretty shadow-none outline-none focus-visible:ring-0 dark:bg-transparent!"
    bind:value={titleDraft}
    onblur={commitTitle}
    onkeydown={(e) => {
      if (e.key === "Enter") e.currentTarget.blur();
      if (e.key === "Escape") {
        titleDraft = task.title;
        e.currentTarget.blur();
      }
    }}
    aria-label="Task title"
  />
{:else}
  <h1 class="m-0 text-2xl leading-[1.25] font-medium text-pretty">
    {task.title}
  </h1>
{/if}

{#if identity}
  <div class="pt-[14px]">{@render identity()}</div>
{/if}

<div class="task-description-prose pt-[18px]">
  <DocumentPromptEditor
    value={bodyDraft}
    onValueChange={(v) => (bodyDraft = v)}
    onBlur={() => {
      if (bodyDraft !== task.body) onSaveBody(bodyDraft);
    }}
    readOnly={!canEdit}
    dragHandle={false}
    placeholder="Describe the work…"
    dictation
    pluginCommands={session.pluginCommands}
    provider={editorProvider}
    workingDirectory={editorCwd}
    menuPlacement="down"
    maxHeight={4000}
  />
</div>
