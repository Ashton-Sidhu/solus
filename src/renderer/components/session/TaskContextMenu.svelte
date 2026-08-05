<script lang="ts">
  import {
    ArrowSquareOutIcon,
    ChatCircleDotsIcon,
    CheckIcon,
    CopyIcon,
    ListChecksIcon,
    PlayIcon,
    PencilSimpleIcon,
    StopCircleIcon,
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
