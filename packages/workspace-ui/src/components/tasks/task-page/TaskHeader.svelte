<script lang="ts">
  import type { AgentId } from "@solus/contracts/types";
  import type { Task } from "@solus/contracts/task-types";
  import { getAgentContext, getWorkspaceContext } from "../../../contexts";
  import DocumentPromptEditor from "../../editor/DocumentPromptEditor.svelte";
  import { relativeTime, STATUS_META } from "../lib/tasks-api";
  import { priorityBars, priorityLabel, statusTextColor } from "./lib/task-page";

  interface Props {
    task: Task;
    canEdit: boolean;
    onSaveTitle: (title: string) => void;
    onSaveBody: (body: string) => void;
  }

  let { task, canEdit, onSaveTitle, onSaveBody }: Props = $props();

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

  let titleDraft = $state(task.title);
  let bodyDraft = $state(task.body);
  // Re-seed when the route swaps to another task: the same component instance
  // is reused, so drafts must follow the id rather than the mount.
  let seededId = task.id;
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

<div class="flex items-center gap-[13px] pb-[11px]">
  <span
    class="inline-flex items-center gap-1.5  font-normal "
    style="color:{statusTextColor(task.status)}"
  >
    <svg
      width="13"
      height="13"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      stroke-width="1.45"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"><path d={status.glyph} /></svg
    >
    {status.label}
  </span>
  <span class="h-[11px] w-px bg-[var(--hairline-strong)]" aria-hidden="true"></span>
  <span class="inline-flex items-center gap-1.5  text-muted-foreground">
    <span class="flex h-[9px] shrink-0 items-end gap-[1.5px]" aria-hidden="true">
      {#each bars as bar (bar.height)}
        <span
          class="w-[2.5px] rounded-[0.0625rem]"
          style="height:{bar.height};background:{bar.background}"
        ></span>
      {/each}
    </span>
    {priorityLabel(task.priority)}
  </span>
  {#if openedAt}
    <span class="h-[11px] w-px bg-[var(--hairline-strong)]" aria-hidden="true"></span>
    <span class="text-xs text-muted-foreground opacity-75">opened {openedAt}</span>
  {/if}
</div>

{#if canEdit}
  <input
    class="m-0 w-full bg-transparent text-2xl leading-[1.25] font-medium text-pretty outline-none"
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
    pluginCommands={session.pluginCommands}
    provider={editorProvider}
    workingDirectory={editorCwd}
    menuPlacement="down"
    maxHeight={4000}
  />
</div>
