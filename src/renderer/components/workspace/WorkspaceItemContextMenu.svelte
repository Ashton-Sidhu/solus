<script lang="ts">
  import {
    ArrowSquareOutIcon,
    ColumnsIcon,
    CopyIcon,
    FolderOpenIcon,
    PushPinIcon,
    TrashIcon,
  } from "phosphor-svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import * as ContextMenu from "../ui/context-menu";
  import type { WorkspaceItem } from "./lib/workspace-items";

  let {
    x,
    y,
    item,
    onOpen,
    onOpenSplit,
    onTogglePin,
    onOpenSession,
    onOpenSessionSplit,
    onDelete,
    onClose,
  }: {
    x: number;
    y: number;
    item: WorkspaceItem;
    onOpen: () => void;
    onOpenSplit?: () => void;
    onTogglePin: () => void;
    onOpenSession?: () => void;
    onOpenSessionSplit?: () => void;
    onDelete?: () => void;
    onClose: () => void;
  } = $props();

  function select(action: () => void) {
    action();
    onClose();
  }

  async function copyId() {
    const itemId = item.id;
    onClose();
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(itemId);
      else {
        const textarea = document.createElement("textarea");
        textarea.value = itemId;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      toasts.success("Workspace item ID copied");
    } catch {
      toasts.error("Couldn't copy workspace item ID");
    }
    requestInputFocus();
  }
</script>

<ContextMenu.Root onOpenChange={(open) => { if (!open) onClose(); }}>
  <ContextMenu.PointTrigger {x} {y} />
  <ContextMenu.Content class="min-w-48">
    <ContextMenu.Item onSelect={() => select(onOpen)}>
      <FolderOpenIcon />
      Open {item.type === "plan" ? "plan" : item.type === "diagram" ? "diagram" : "document"}
    </ContextMenu.Item>
    {#if onOpenSplit}
      <ContextMenu.Item onSelect={() => select(onOpenSplit)}>
        <ColumnsIcon />
        Open in split
      </ContextMenu.Item>
    {/if}
    {#if onOpenSession}
      <ContextMenu.Item onSelect={() => select(onOpenSession)}>
        <ArrowSquareOutIcon />
        Open source session
      </ContextMenu.Item>
    {/if}
    {#if onOpenSessionSplit}
      <ContextMenu.Item onSelect={() => select(onOpenSessionSplit)}>
        <ColumnsIcon />
        Open source session in split
      </ContextMenu.Item>
    {/if}
    <ContextMenu.Item onSelect={() => select(onTogglePin)}>
      <PushPinIcon />
      {item.pinned ? "Unpin" : "Pin"}
    </ContextMenu.Item>

    <ContextMenu.Separator />
    <ContextMenu.Item onSelect={() => void copyId()}>
      <CopyIcon />
      Copy item ID
    </ContextMenu.Item>
    {#if onDelete}
      <ContextMenu.Item variant="destructive" onSelect={() => select(onDelete)}>
        <TrashIcon />
        Delete {item.type === "diagram" ? "diagram" : "document"}
      </ContextMenu.Item>
    {/if}
  </ContextMenu.Content>
</ContextMenu.Root>
