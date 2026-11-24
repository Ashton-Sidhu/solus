<script lang="ts">
  import {
    FilePlus as FilePlusIcon,
    FolderPlus as FolderPlusIcon,
    Pen as PencilSimpleIcon,
    Trash2 as TrashIcon,
  } from "@lucide/svelte";
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
    onOpen: (action: FileOpenAction) => void;
    canWrite: boolean;
    onCreate: (kind: FileTreeEntryKind) => void;
    onRename: () => void;
    onDelete: () => void;
    onClose: () => void;
  }

  let { x, y, name, openRoute, onOpen, canWrite, onCreate, onRename, onDelete, onClose }: Props = $props();

  function select(action: () => void) {
    action();
    onClose();
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
    {#if openRoute}
      <FileOpenMenuItems route={openRoute} onSelect={(action) => select(() => onOpen(action))} />
    {/if}
    {#if canWrite}
      {#if openRoute}<ContextMenu.Separator />{/if}
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
