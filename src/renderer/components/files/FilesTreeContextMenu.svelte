<script lang="ts">
  import {
    FilePlusIcon,
    FolderPlusIcon,
    PencilSimpleIcon,
    TrashIcon,
  } from "phosphor-svelte";
  import * as ContextMenu from "../ui/context-menu";
  import type { FileTreeEntryKind } from "./lib/file-tree-mutations";

  interface Props {
    x: number;
    y: number;
    /** Row the menu was opened on, for the destructive item's label. */
    name: string;
    onCreate: (kind: FileTreeEntryKind) => void;
    onRename: () => void;
    onDelete: () => void;
    onClose: () => void;
  }

  let { x, y, name, onCreate, onRename, onDelete, onClose }: Props = $props();

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
  </ContextMenu.Content>
</ContextMenu.Root>
