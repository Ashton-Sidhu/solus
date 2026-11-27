<script lang="ts">
  import {
    Copy as CopyIcon,
    FilePlus as FilePlusIcon,
    FolderPlus as FolderPlusIcon,
    Pen as PencilSimpleIcon,
    Trash2 as TrashIcon,
  } from "@lucide/svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { copyText, toasts } from "../../lib/toasts";
  import * as ContextMenu from "../ui/context-menu";
  import FileOpenMenuItems from "./FileOpenMenuItems.svelte";
  import type { FileOpenAction, FileOpenRoute } from "./lib/file-open-actions";
  import type { FileTreeEntryKind } from "./lib/file-tree-mutations";

  interface Props {
    x: number;
    y: number;
    /** Row the menu was opened on, for the destructive item's label. */
    name: string;
    openRoute: FileOpenRoute | null;
    absolutePath: string | null;
    copyPath: string | null;
    isFolder: boolean;
    onOpen: (action: FileOpenAction) => void;
    canWrite: boolean;
    onCreate: (kind: FileTreeEntryKind) => void;
    onRename: () => void;
    onDelete: () => void;
    onClose: () => void;
  }

  let { x, y, name, openRoute, absolutePath, copyPath, isFolder, onOpen, canWrite, onCreate, onRename, onDelete, onClose }: Props = $props();

  function select(action: () => void) {
    action();
    onClose();
  }

  async function copyPathToClipboard() {
    if (!copyPath) return;
    const write = copyText(copyPath);
    onClose();
    requestInputFocus();
    const copied = await write;
    if (copied) toasts.success("Path copied");
    else toasts.error("Could not copy path");
  }
</script>

<!-- The tree closes its own menu on any outside pointerdown; this marker tells
     it that the portaled menu is not outside. -->
<ContextMenu.Root onOpenChange={(open) => { if (!open) onClose(); }}>
  <ContextMenu.PointTrigger {x} {y} />
  <ContextMenu.Content
    class="min-w-48"
    data-file-tree-context-menu-root="true"
    onCloseAutoFocus={(event) => event.preventDefault()}
  >
    {#if openRoute && absolutePath}
      <FileOpenMenuItems route={openRoute} path={absolutePath} {isFolder} onSelect={(action) => select(() => onOpen(action))} />
    {/if}
    {#if copyPath}
      <ContextMenu.Item onSelect={copyPathToClipboard}>
        <CopyIcon />
        Copy path
      </ContextMenu.Item>
    {/if}
    {#if canWrite}
      {#if copyPath || (openRoute && absolutePath)}<ContextMenu.Separator />{/if}
      <ContextMenu.Item onSelect={() => select(() => onCreate("file"))}>
        <FilePlusIcon />
        New file
      </ContextMenu.Item>
      <ContextMenu.Item onSelect={() => select(() => onCreate("folder"))}>
        <FolderPlusIcon />
        New folder
      </ContextMenu.Item>
      <ContextMenu.Separator />
      <ContextMenu.Item onSelect={() => select(onRename)}>
        <PencilSimpleIcon />
        Rename
      </ContextMenu.Item>
      <ContextMenu.Item variant="destructive" onSelect={() => select(onDelete)}>
        <TrashIcon />
        Delete “{name}”
      </ContextMenu.Item>
    {/if}
  </ContextMenu.Content>
</ContextMenu.Root>
