<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import type { AgentId } from "@solus/contracts/types";
  import type { Task, TaskMoveTarget, TaskPriority } from "@solus/contracts/task-types";
  import { getAgentContext, getSurfaceContext } from "../../../contexts";
  import DocumentPromptEditor from "../../editor/DocumentPromptEditor.svelte";
  import GithubMarkdown from '../../github-markdown/GithubMarkdown.svelte';
  import { Input } from "../../ui/input";
  import { CATEGORY_META, relativeTime } from "../lib/tasks-api";
  import {
    priorityBars,
    priorityLabel,
    statusTextColor,
    taskStateLabel,
    type TaskFieldLocks,
  } from "./lib/task-page";
  import type { TaskMoveGroup } from "./lib/task-move";
  import TaskPriorityMenu from "./TaskPriorityMenu.svelte";
  import TaskStatusMenu from "./TaskStatusMenu.svelte";

  interface Props {
    task: Task;
    /** Why each field editor is disabled (`taskFieldLocks`). */
    locks: TaskFieldLocks;
    /** Each save answers false when the provider refused the change. */
    onSaveTitle: (title: string) => Promise<boolean>;
    onSaveBody: (body: string) => Promise<boolean>;
    /** What the move menu offers (`taskMoveGroups`). */
    moveGroups: TaskMoveGroup[];
    onMove: (target: TaskMoveTarget) => void;
    onSavePriority: (priority: TaskPriority | null) => void;
    /** The folded rung's stand-in for the rail: a Details disclosure at the end
     *  of the status line, and the panel it opens under the title. Both are
     *  absent wherever the rail's column is actually on screen. */
    detailsTrigger?: Snippet;
    detailsPanel?: Snippet;
  }

  let {
    task,
    locks,
    onSaveTitle,
    onSaveBody,
    moveGroups,
    onMove,
    onSavePriority,
    detailsTrigger,
    detailsPanel,
  }: Props = $props();

  // The description reuses the document editor so a task can embed @files,
  // /skills, #plans, %docs and !PRs; refs round-trip through the saved markdown.
  const session = getSurfaceContext();
  const agentContext = getAgentContext();
  const editorProvider = $derived<AgentId>(
    agentContext.activeMetadata?.id ?? "claude-code",
  );
  const editorCwd = $derived(session.tasksProjectCwd ?? undefined);

  const bars = $derived(priorityBars(task.priority));
  const openedAt = $derived(task.createdAt ? relativeTime(task.createdAt) : "");

  let titleDraft = $state(untrack(() => task.title));
  let bodyDraft = $state(untrack(() => task.body));
  // The body editor completes @ and # references against the workspace; a
  // client without one (the cloud console) reads the body and edits the rest.
  const canEditBody = $derived(locks.body === null && !!session.workspace);
  let bodyEditor: DocumentPromptEditor | undefined = $state();
  // Re-seed when the route swaps to another task: the same component instance
  // is reused, so drafts must follow the id rather than the mount.
  let seededId = untrack(() => task.id);
  $effect(() => {
    if (task.id === seededId) return;
    seededId = task.id;
    titleDraft = task.title;
    bodyDraft = task.body;
  });

  // The provider takes the change before the task does, so each draft stays on
  // screen while the write is on its way. A refused write puts the task's own
  // value back: the page must not show text the provider does not have.
  async function commitTitle() {
    const next = titleDraft.trim();
    if (!next || next === task.title) {
      titleDraft = task.title;
      return;
    }
    await onSaveTitle(next);
    titleDraft = task.title;
  }

  // Reads the editor itself rather than the draft: `onValueChange` is
  // debounced, so the last keystrokes before the blur may not be in it yet.
  async function commitBody() {
    const next = bodyEditor?.getMarkdown() ?? bodyDraft;
    bodyDraft = next;
    if (next === task.body) return;
    await onSaveBody(next);
    bodyDraft = task.body;
  }
</script>

<!-- Status and priority are the two facts in this row that are also decisions,
     so they are the menus that make them. The negative inline margin keeps each
     label optically where it sat as plain text while giving the control a
     padded hit area, and a task whose provider will not take a change of the
     priority keeps the label and loses only the affordance. The row is workspace chrome, so it
     sets `text-workspace-chrome` once and every label and control in it — the
     Details disclosure too — inherits the one size. It wraps in a narrow pane. -->
<div class="flex flex-wrap items-center gap-x-[13px] gap-y-1 pb-[11px] text-workspace-chrome">
  <TaskStatusMenu
    groups={moveGroups}
    onSelect={onMove}
    triggerClass="-mx-1.5 inline-flex h-[26px] cursor-pointer items-center gap-1.5 rounded-md px-1.5 font-normal transition-colors hover:bg-[var(--wash-2)] disabled:cursor-default disabled:hover:bg-transparent"
  >
    {#snippet trigger()}
      <span
        class="inline-flex items-center gap-1.5"
        style="color:{statusTextColor(task.category)}"
      >
        <!-- The class carries the size, not the attributes: a CSS width beats
             the presentation attribute, which is what lets the glyph step. -->
        <svg
          width="13"
          height="13"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          stroke-width="0.875"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="size-[13px] shrink-0"
          aria-hidden="true"><path d={CATEGORY_META[task.category].glyph} /></svg
        >
        {taskStateLabel(task)}
      </span>
    {/snippet}
  </TaskStatusMenu>

  <span
    class="h-[11px] w-px bg-[var(--hairline-strong)]"
    aria-hidden="true"
  ></span>

  <TaskPriorityMenu
    priority={task.priority}
    lock={locks.priority}
    onSelect={onSavePriority}
    triggerClass="-mx-1.5 inline-flex h-[26px] cursor-pointer items-center gap-1.5 rounded-md px-1.5 font-normal text-muted-foreground transition-colors hover:bg-[var(--wash-2)] disabled:cursor-default disabled:hover:bg-transparent"
  >
    {#snippet trigger()}
      <span
        class="flex h-[9px] shrink-0 items-end gap-[1.5px]"
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
      class="h-[11px] w-px bg-[var(--hairline-strong)]"
      aria-hidden="true"
    ></span>
    <span class="text-muted-foreground opacity-75">opened {openedAt}</span>
  {/if}

  <!-- No rule before Details: the row wraps in a narrow pane, and a rule
       there is left dangling at the end of the first line. It sits at the
       row's end edge instead, where the folded rail would be, so it does not
       read as part of the "opened" text before it. -->
  {#if detailsTrigger}
    <span class="ml-auto flex min-w-0">
      {@render detailsTrigger()}
    </span>
  {/if}
</div>

{#if locks.title === null}
  <Input
    class="m-0 h-auto w-full rounded-none border-0 bg-transparent! p-0 text-2xl leading-[1.25] font-medium text-pretty shadow-none outline-none focus-visible:ring-0 dark:bg-transparent!"
    bind:value={titleDraft}
    onblur={() => void commitTitle()}
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
  <h1 class="m-0 text-2xl leading-[1.25] font-medium text-pretty" title={locks.title}>
    {task.title}
  </h1>
{/if}

{#if detailsPanel}
  {@render detailsPanel()}
{/if}

<!-- The description is edited where it is read, like the title above it: no
     edit mode, no Save or Cancel. It saves when focus leaves it. The editor and
     the rendered body both use the prose style, so reading and editing are one
     surface. -->
<div class="task-description-prose pt-[18px]">
  {#if canEditBody}
    <DocumentPromptEditor
      bind:this={bodyEditor}
      value={bodyDraft}
      onValueChange={(v) => (bodyDraft = v)}
      onBlur={() => void commitBody()}
      dragHandle={false}
      placeholder="Describe the work…"
      dictation
      pluginCommands={session.pluginCommands}
      provider={editorProvider}
      workingDirectory={editorCwd}
      menuPlacement="down"
      maxHeight={4000}
    />
  {:else if task.body.trim()}
    <div class="prose max-w-[104ch]" title={locks.body ?? undefined}>
      <GithubMarkdown source={task.body} policy="local" />
    </div>
  {/if}
</div>
