<script lang="ts">
  import {
    Copy as CopyIcon,
    ExternalLink as ExternalLinkIcon,
    FolderPlus as FolderPlusIcon,
    Pen as PencilSimpleIcon,
    Trash2 as TrashIcon,
  } from "@lucide/svelte";
  import * as ContextMenu from "../ui/context-menu";
  import type { DirectoryEntry } from "@solus/contracts/types";

  interface Props {
    x: number;
    y: number;
    /** The row the menu opened on; null when it opened on the folder itself. */
    entry: DirectoryEntry | null;
    /** Set when the browsed host is this machine, so a file manager can show it. */
    fileManagerName: string | null;
    /** The picker's own layer. The body sits under it, so a menu there opens hidden. */
    portalTarget: HTMLElement | null;
    onNewFolder: () => void;
    onRename: (entry: DirectoryEntry) => void;
    onTrash: (entry: DirectoryEntry) => void;
    onCopyPath: () => void;
    onOpenInFileManager: () => void;
    onClose: () => void;
  }

  let {
    x,
    y,
    entry,
    fileManagerName,
    portalTarget,
    onNewFolder,
    onRename,
    onTrash,
    onCopyPath,
    onOpenInFileManager,
    onClose,
  }: Props = $props();

  function select(action: () => void) {
    action();
    onClose();
  }
</script>

<ContextMenu.Root onOpenChange={(open) => { if (!open) onClose(); }}>
  <ContextMenu.PointTrigger {x} {y} />
  <ContextMenu.Content
    class="min-w-48"
    portalProps={{ to: portalTarget ?? undefined }}
    onCloseAutoFocus={(event) => event.preventDefault()}
  >
    <ContextMenu.Item onSelect={() => select(onNewFolder)}>
      <FolderPlusIcon />
      New folder
      <ContextMenu.Shortcut>⌥N</ContextMenu.Shortcut>
    </ContextMenu.Item>
    {#if entry}
      {@const target = entry}
      <ContextMenu.Item onSelect={() => select(() => onRename(target))}>
        <PencilSimpleIcon />
        Rename
        <ContextMenu.Shortcut>F2</ContextMenu.Shortcut>
      </ContextMenu.Item>
      <ContextMenu.Item variant="destructive" onSelect={() => select(() => onTrash(target))}>
        <TrashIcon />
        Move to Trash
        <ContextMenu.Shortcut>⌘⌫</ContextMenu.Shortcut>
      </ContextMenu.Item>
    {/if}
    <ContextMenu.Separator />
    <ContextMenu.Item onSelect={() => select(onCopyPath)}>
      <CopyIcon />
      Copy path
    </ContextMenu.Item>
    {#if fileManagerName}
      <ContextMenu.Item onSelect={() => select(onOpenInFileManager)}>
        <ExternalLinkIcon />
        Open in {fileManagerName}
      </ContextMenu.Item>
    {/if}
  </ContextMenu.Content>
</ContextMenu.Root>
