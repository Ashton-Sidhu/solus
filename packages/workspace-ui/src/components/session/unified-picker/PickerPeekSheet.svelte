<script lang="ts">
  import type { Task, TaskLink } from "@solus/contracts/task-types";
  import type { SidebarSessionChild } from "../../../contexts/workspace/session-sidebar.store.svelte";
  import type { PreviewExtraction } from "../../../lib/sessionPreviewMessages";
  import { BottomSheet } from "../../ui/bottom-sheet";
  import TaskStatusGlyph from "../../tasks/TaskStatusGlyph.svelte";
  import { relativeTime } from "../../tasks/lib/tasks-api";
  import SessionPreview from "../SessionPreview.svelte";
  import SessionStatusGlyph from "../SessionStatusGlyph.svelte";
  import PickerActionBar from "./PickerActionBar.svelte";
  import TaskPreviewPane from "./TaskPreviewPane.svelte";

  /**
   * The phone's preview.
   *
   * Tapping a row on a phone does the thing — opens the task, resumes the
   * session — so the preview needs a gesture of its own, and a press-and-hold
   * is the one a thumb already has. It carries exactly the content of the
   * desktop pane, raised over the list it came from, so dismissing it returns
   * to the same scroll position rather than to the top of a list.
   */
  interface Props {
    target:
      | { kind: "task"; task: Task }
      | { kind: "session"; session: SidebarSessionChild; task: Task };
    /** The task's sessions, for the roll inside a task peek. */
    sessions: SidebarSessionChild[];
    sessionPreview: PreviewExtraction | null;
    previewLoading: boolean;
    hiddenCount: number;
    query: string;
    projectLabel: string;
    portalTarget: HTMLElement | null;
    onClose: () => void;
    onOpen: (task: Task) => void;
    onStartDraft: (task: Task) => void;
    onOpenTask: (task: Task) => void;
    onOpenSource: (task: Task) => void;
    onSelectSession: (session: SidebarSessionChild) => void;
    onOpenLink: (task: Task, link: TaskLink) => void;
    onOpenExternal: (url: string) => void;
    onUnlink: (link: TaskLink) => void;
  }
  let {
    target,
    sessions,
    sessionPreview,
    previewLoading,
    hiddenCount,
    query,
    projectLabel,
    portalTarget,
    onClose,
    onOpen,
    onStartDraft,
    onOpenTask,
    onOpenSource,
    onSelectSession,
    onOpenLink,
    onOpenExternal,
    onUnlink,
  }: Props = $props();

  const label = $derived(
    target.kind === "task" ? target.task.title : target.session.label,
  );
  const timeAgo = $derived(
    relativeTime(
      target.kind === "task"
        ? target.task.updatedAt
        : target.session.lastActivityAt || target.task.updatedAt,
    ),
  );
</script>

{#snippet actions()}
  {#if target.kind === "session"}
    {@const picked = target.session}
    <PickerActionBar
      task={target.task}
      {portalTarget}
      primaryLabel="Resume session"
      onPrimary={() => onSelectSession(picked)}
      {onOpenTask}
      {onOpenSource}
    />
  {:else}
    {@const task = target.task}
    <PickerActionBar
      {task}
      {portalTarget}
      primaryLabel={sessions.length ? "Resume latest" : "Open new draft"}
      onPrimary={() => onOpen(task)}
      secondaryLabel={sessions.length ? "New draft" : undefined}
      onSecondary={sessions.length ? () => onStartDraft(task) : undefined}
      {onOpenTask}
      {onOpenSource}
    />
  {/if}
{/snippet}

<BottomSheet {label} {onClose} {portalTarget} footer={actions}>
  {#snippet header()}
    <div class="flex items-center gap-2 text-muted-foreground">
      {#if target.kind === "session"}
        <SessionStatusGlyph attention={target.session.attention} />
      {:else}
        <TaskStatusGlyph status={target.task.status} size={12} />
      {/if}
      <span class="text-[0.59375rem] font-medium tracking-[0.12em] uppercase"
        >{target.kind === "task" ? "Task" : "Session"}</span
      >
      <span class="font-mono text-[0.6875rem]">{projectLabel}</span>
      <span class="opacity-50" aria-hidden="true">·</span>
      <span class="shrink-0 whitespace-nowrap text-[0.71875rem] tabular-nums">{timeAgo}</span>
    </div>
  {/snippet}

  <div class="pt-1 pb-2">
    {#if target.kind === "task"}
      <TaskPreviewPane
        task={target.task}
        {sessions}
        {onSelectSession}
        onOpenLink={(link) => onOpenLink(target.task, link)}
        {onOpenExternal}
        {onUnlink}
      />
    {:else}
      <SessionPreview
        preview={sessionPreview}
        loading={previewLoading}
        title={target.session.label}
        byline={target.task.title}
        {timeAgo}
        {hiddenCount}
        {query}
      />
    {/if}
  </div>
</BottomSheet>
