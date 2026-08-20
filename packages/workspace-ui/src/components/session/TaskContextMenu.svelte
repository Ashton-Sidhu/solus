<script lang="ts">
  import {
    ExternalLink as ArrowSquareOutIcon,
    ChartBar as ChartBarIcon,
    MessageCircleMore as ChatCircleDotsIcon,
    MessagesSquare as ChatsIcon,
    Check as CheckIcon,
    Copy as CopyIcon,
    GitFork as GitForkIcon,
    ListChecks as ListChecksIcon,
    Play as PlayIcon,
    Pen as PencilSimpleIcon,
    CircleStop as StopCircleIcon,
    GitFork as TreeStructureIcon,
    Trash2 as TrashIcon,
    X as XIcon,
    Moon as MoonIcon,
    Sun as SunIcon,
  } from "@lucide/svelte";
  import type { Task, TaskStatus } from "@solus/contracts/task-types";
  import { getWorkspaceContext } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import * as ContextMenu from "../ui/context-menu";
  import TaskStatusGlyph from "../tasks/TaskStatusGlyph.svelte";
  import { STATUS_META } from "../tasks/lib/tasks-api";

  const TASK_STATUSES: TaskStatus[] = [
    "inbox",
    "todo",
    "in_progress",
    "in_review",
    "done",
    "dropped",
  ];

  interface Props {
    x: number;
    y: number;
    task: Task;
    hasLinkedSession: boolean;
    isRunning: boolean;
    lifecycleBlocked?: boolean;
    onStart: () => void;
    onResume?: () => void;
    onStop?: () => void;
    onOpenTask: () => void;
    onOpenSource?: () => void;
    onStartRename?: () => void;
    onSetStatus?: (status: TaskStatus) => void;
    onSnooze?: () => void;
    onWake?: () => void;
    onMarkUnread?: () => void;
    onRemove?: () => void;
    onDelete?: () => void;
    /** Session-level actions for a task with no nested subtasks: the row *is* a
     *  single session, so it earns the same session menu items a loose session
     *  row gets. Each is omitted when it doesn't apply to this leaf. */
    sessionId?: string | null;
    onFork?: () => void;
    onContinueWorktree?: () => void;
    isContinuingWorktree?: boolean;
    onOpenInSplit?: () => void;
    onCloseSplit?: () => void;
    isSplit?: boolean;
    onClose: () => void;
  }

  let {
    x,
    y,
    task,
    hasLinkedSession,
    isRunning,
    lifecycleBlocked = false,
    onStart,
    onResume,
    onStop,
    onOpenTask,
    onOpenSource,
    onStartRename,
    onSetStatus,
    onSnooze,
    onWake,
    onMarkUnread,
    onRemove,
    onDelete,
    sessionId = null,
    onFork,
    onContinueWorktree,
    isContinuingWorktree = false,
    onOpenInSplit,
    onCloseSplit,
    isSplit = false,
    onClose,
  }: Props = $props();

  const session = getWorkspaceContext();

  /** Every turn the task's sessions ran, in Insights. A task nothing has worked
   *  on yet has no turns to show, so the item appears once one attempt exists. */
  function openInInsights() {
    const taskId = task.id;
    onClose();
    session.openInsightsForTask(taskId);
  }

  async function copyTaskId() {
    const id = task.id;
    onClose();
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(id);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = id;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      toasts.success("Task ID copied");
    } catch {
      toasts.error("Couldn't copy task ID");
    }
    requestInputFocus();
  }

  async function copySessionId() {
    const id = sessionId;
    onClose();
    if (!id) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(id);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = id;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      toasts.success("Session ID copied");
    } catch {
      toasts.error("Couldn't copy session ID");
    }
    requestInputFocus();
  }

  function select(action: () => void) {
    action();
    onClose();
  }
</script>

<ContextMenu.Root
  onOpenChange={(open) => {
    if (!open) onClose();
  }}
>
  <ContextMenu.PointTrigger {x} {y} />
  <ContextMenu.Content class="min-w-48">
    <ContextMenu.Item onSelect={() => select(onOpenTask)}>
      <ListChecksIcon />
      Open task
    </ContextMenu.Item>
    {#if onOpenSource && task.url}
      <ContextMenu.Item onSelect={() => select(onOpenSource)}>
        <ArrowSquareOutIcon />
        Open source ticket
      </ContextMenu.Item>
    {/if}
    {#if hasLinkedSession}
      <ContextMenu.Item onSelect={openInInsights}>
        <ChartBarIcon />
        Open in Insights
      </ContextMenu.Item>
    {/if}

    <ContextMenu.Separator />

    {#if isRunning && onStop}
      <ContextMenu.Item onSelect={() => select(onStop)}>
        <StopCircleIcon />
        Stop run
      </ContextMenu.Item>
    {/if}
    {#if onSetStatus}
      <ContextMenu.Sub>
        <ContextMenu.SubTrigger>
          <TaskStatusGlyph status={task.status} size={14} />
          Set status
        </ContextMenu.SubTrigger>
        <ContextMenu.SubContent>
          {#each TASK_STATUSES as status}
            <ContextMenu.Item onSelect={() => select(() => onSetStatus?.(status))}>
              <TaskStatusGlyph {status} size={14} />
              {STATUS_META[status].label}
              {#if task.status === status}
                <CheckIcon class="ml-auto" />
              {/if}
            </ContextMenu.Item>
          {/each}
        </ContextMenu.SubContent>
      </ContextMenu.Sub>
    {/if}
    {#if onWake}
      <ContextMenu.Item onSelect={() => select(onWake)}>
        <SunIcon />
        Wake now
      </ContextMenu.Item>
    {:else if onSnooze}
      <ContextMenu.Item disabled={lifecycleBlocked} onSelect={() => select(onSnooze)}>
        <MoonIcon />
        Snooze…
      </ContextMenu.Item>
    {/if}
    {#if onMarkUnread}
      <ContextMenu.Item onSelect={() => select(onMarkUnread)}>
        <span
          class="flex size-3.5 shrink-0 items-center justify-center"
          aria-hidden="true"
        >
          <span class="size-1.5 rounded-full bg-current"></span>
        </span>
        Mark unread
      </ContextMenu.Item>
    {/if}

    {#if onFork || onContinueWorktree}
      <ContextMenu.Separator />
      {#if onFork}
        <ContextMenu.Item onSelect={() => select(onFork)}>
          <GitForkIcon />
          Fork session
        </ContextMenu.Item>
      {/if}
      {#if onContinueWorktree}
        <ContextMenu.Item
          disabled={isContinuingWorktree}
          onSelect={() => select(onContinueWorktree)}
        >
          <TreeStructureIcon
            class={isContinuingWorktree ? "tab-status-spin" : ""}
          />
          {isContinuingWorktree ? "Creating worktree…" : "Continue in worktree"}
        </ContextMenu.Item>
      {/if}
    {/if}

    <ContextMenu.Separator />

    {#if onStartRename}
      <ContextMenu.Item onSelect={() => select(onStartRename)}>
        <PencilSimpleIcon />
        Rename task
      </ContextMenu.Item>
    {/if}
    <ContextMenu.Item onSelect={copyTaskId}>
      <CopyIcon />
      Copy task ID
    </ContextMenu.Item>
    {#if sessionId}
      <ContextMenu.Item onSelect={copySessionId}>
        <CopyIcon />
        Copy session ID
      </ContextMenu.Item>
    {/if}
    {#if isSplit && onCloseSplit}
      <ContextMenu.Item onSelect={() => select(onCloseSplit)}>
        <ChatsIcon />
        Close split
      </ContextMenu.Item>
    {:else if onOpenInSplit}
      <ContextMenu.Item onSelect={() => select(onOpenInSplit)}>
        <ChatsIcon />
        Open in split
      </ContextMenu.Item>
    {/if}
    {#if onRemove}
      <ContextMenu.Item variant="destructive" onSelect={() => select(onRemove)}>
        <XIcon />
        Remove from sidebar
      </ContextMenu.Item>
    {/if}
    {#if onDelete}
      <ContextMenu.Item variant="destructive" onSelect={() => select(onDelete)}>
        <TrashIcon />
        Delete task
      </ContextMenu.Item>
    {/if}
  </ContextMenu.Content>
</ContextMenu.Root>
