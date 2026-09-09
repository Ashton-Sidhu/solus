<script lang="ts">
  import { MessagesSquare as ChatsIcon } from "@lucide/svelte";
  import type { Task, TaskLink } from "@solus/contracts/task-types";
  import type { SessionMeta, SessionSearchHit } from "@solus/contracts/types";
  import type { SidebarSessionChild } from "../../../contexts/workspace/session-sidebar.store.svelte";
  import type { HitWindow, PreviewExtraction } from "../../../lib/sessionPreviewMessages";
  import { BottomSheet } from "../../ui/bottom-sheet";
  import TaskStatusGlyph from "../../tasks/TaskStatusGlyph.svelte";
  import { relativeTime } from "../../tasks/lib/tasks-api";
  import SessionPreview from "../SessionPreview.svelte";
  import PickerActionBar from "./PickerActionBar.svelte";
  import TaskPreviewPane from "./TaskPreviewPane.svelte";
  import { conversationTitle, type ConversationHit } from "./lib/picker-rows";

  /**
   * The phone's preview.
   *
   * Tapping a row on a phone raises this sheet because the desktop preview
   * column is hidden. It carries exactly the content of that desktop pane,
   * raised over the list it came from, so dismissing it returns to the same
   * scroll position rather than to the top of a list.
   */
  interface Props {
    target:
      | { kind: "task"; task: Task }
      | { kind: "session"; session: SidebarSessionChild; task: Task }
      | { kind: "conversation"; meta: SessionMeta; hit: ConversationHit };
    /** The task's sessions, for the roll inside a task peek. */
    sessions: SidebarSessionChild[];
    sessionPreview: PreviewExtraction | null;
    /** The passage a search hit sits in, when the row was found by its words. */
    sessionHitWindow?: HitWindow | null;
    additionalMatches?: readonly SessionSearchHit[];
    previewLoading: boolean;
    /** The whole transcript's size, once the preview has read it. */
    messageCount?: number;
    query: string;
    projectLabel: string;
    portalTarget: HTMLElement | null;
    onClose: () => void;
    onResumeConversation: (meta: SessionMeta) => void;
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
    sessionHitWindow = null,
    additionalMatches = [],
    previewLoading,
    messageCount,
    query,
    projectLabel,
    portalTarget,
    onClose,
    onResumeConversation,
    onStartDraft,
    onOpenTask,
    onOpenSource,
    onSelectSession,
    onOpenLink,
    onOpenExternal,
    onUnlink,
  }: Props = $props();

  const label = $derived.by(() => {
    if (target.kind === "task") return target.task.title;
    if (target.kind === "session") return target.session.label;
    return conversationTitle(target.meta);
  });
  // Dated by the hit when the row was found by its words, as the row is.
  const timeAgo = $derived.by(() => {
    if (target.kind === "task") return relativeTime(target.task.updatedAt);
    if (target.kind === "session") return relativeTime(target.session.lastActivityAt || target.task.updatedAt);
    return relativeTime(target.hit.ts);
  });
</script>

{#snippet actions()}
  {#if target.kind === "session"}
    {@const picked = target.session}
    <PickerActionBar
      task={target.task}
      {portalTarget}
      primaryLabel="Resume session"
      onPrimary={() => onSelectSession(picked)}
      showTaskControls={false}
      {onOpenTask}
      {onOpenSource}
    />
  {:else if target.kind === "conversation"}
    <!-- No task to edit or open, so the bar is its one leaving action. -->
    {@const meta = target.meta}
    <PickerActionBar
      task={null}
      {portalTarget}
      primaryLabel="Resume session"
      onPrimary={() => onResumeConversation(meta)}
      showTaskControls={false}
      {onOpenTask}
      {onOpenSource}
    />
  {:else}
    <!-- A tap on the row already opened the task, so the sheet's primary says
         the same thing: the peek is what you read *before* committing, and its
         button is the commit. A draft is the other way in, always offered —
         a task with no sessions has no other. -->
    {@const task = target.task}
    <PickerActionBar
      {task}
      {portalTarget}
      primaryLabel="Open task"
      onPrimary={() => onOpenTask(task)}
      secondaryLabel="New draft"
      onSecondary={() => onStartDraft(task)}
      {onOpenTask}
      {onOpenSource}
    />
  {/if}
{/snippet}

<!-- How big the transcript is and when it last moved. The body shows two or
     three messages out of many, and the header is the one place on a phone
     that dates them: without the age, a short sheet reads as a live
     conversation whatever its age. -->
{#snippet transcriptSize()}
  {#if messageCount !== undefined}
    <span class="shrink-0 whitespace-nowrap font-mono text-micro tabular-nums"
      >{messageCount} {messageCount === 1 ? "message" : "messages"}</span
    >
  {/if}
  <span class="shrink-0 opacity-50" aria-hidden="true">·</span>
  <span class="shrink-0 whitespace-nowrap text-micro tabular-nums">{timeAgo}</span>
{/snippet}

<BottomSheet {label} {onClose} {portalTarget} footer={actions}>
  {#snippet header()}
    <div class="flex items-center gap-2 overflow-hidden text-muted-foreground">
      {#if target.kind === "session"}
        <ChatsIcon size={13} class="shrink-0" />
        <span class="shrink-0 text-micro font-medium tracking-[0.12em] uppercase">Session</span>
        <!-- Which task this session belongs to. A session is only legible
             against the work it was started for, and the sheet is the one
             place on a phone with room to say so. -->
        <span class="min-w-0 flex-1 truncate font-mono text-micro">{target.task.title}</span>
        {@render transcriptSize()}
      {:else if target.kind === "conversation"}
        <!-- No task claims this session, so the project it ran in stands
             where the task would. -->
        <ChatsIcon size={13} class="shrink-0" />
        <span class="shrink-0 text-micro font-medium tracking-[0.12em] uppercase">Session</span>
        <span class="min-w-0 flex-1 truncate font-mono text-micro">{projectLabel}</span>
        {@render transcriptSize()}
      {:else}
        <TaskStatusGlyph status={target.task.status} size={12} />
        <span class="shrink-0 text-micro font-medium tracking-[0.12em] uppercase">Task</span>
        <span class="min-w-0 flex-1 truncate font-mono text-micro">{projectLabel}</span>
        <span class="shrink-0 opacity-50" aria-hidden="true">·</span>
        <span class="shrink-0 whitespace-nowrap text-micro tabular-nums">{timeAgo}</span>
      {/if}
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
        {query}
      />
    {:else}
      <!-- The title carries the same weight it does in a task peek, and the
           header line above already names the task and the transcript's size —
           so the preview renders its body only, with no second header. -->
      <h3 class="mb-1 px-[1.125rem] text-[1.1875rem] leading-[1.3] font-semibold tracking-[-0.016em] text-pretty text-foreground">
        {label}
      </h3>
      <SessionPreview
        preview={sessionPreview}
        hitWindow={sessionHitWindow}
        {additionalMatches}
        loading={previewLoading}
        {timeAgo}
        {query}
      />
    {/if}
  </div>
</BottomSheet>
