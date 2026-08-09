<script lang="ts">
  import {
    ArrowSquareOutIcon,
    ChatCircleDotsIcon,
    ChatsIcon,
    CheckIcon,
    CopyIcon,
    GitForkIcon,
    ListChecksIcon,
    PlayIcon,
    PencilSimpleIcon,
    StopCircleIcon,
    TreeStructureIcon,
    TrashIcon,
    XIcon,
  } from "phosphor-svelte";
  import type { Task } from "../../../shared/task-types";
  import { toasts } from "../../lib/toasts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import * as ContextMenu from "../ui/context-menu";

  interface Props {
    x: number;
    y: number;
    task: Task;
    hasLinkedSession: boolean;
    isRunning: boolean;
    onStart: () => void;
    onResume?: () => void;
    onStop?: () => void;
    onOpenTask: () => void;
    onOpenSource?: () => void;
    onStartRename?: () => void;
    onToggleDone: () => void;
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
    onStart,
    onResume,
    onStop,
    onOpenTask,
    onOpenSource,
    onStartRename,
    onToggleDone,
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

    <ContextMenu.Separator />

    {#if isRunning && onStop}
      <ContextMenu.Item onSelect={() => select(onStop)}>
        <StopCircleIcon />
        Stop run
      </ContextMenu.Item>
    {/if}
    <ContextMenu.Item onSelect={() => select(onToggleDone)}>
      <CheckIcon />
      {task.status === "done" ? "Reopen task" : "Mark done"}
    </ContextMenu.Item>

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
