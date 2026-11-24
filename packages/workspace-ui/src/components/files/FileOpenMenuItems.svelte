<script lang="ts">
  import { ArrowUpRight, FolderOpen } from "@lucide/svelte";
  import AppLogo from "../settings/AppLogo.svelte";
  import * as ContextMenu from "../ui/context-menu";
  import { fileOpenEditors, type FileOpenAction, type FileOpenRoute } from "./lib/file-open-actions";

  let { route, path, isFolder = false, onSelect }: { route: FileOpenRoute; path: string; isFolder?: boolean; onSelect: (action: FileOpenAction) => void } = $props();
  const editors = $derived(fileOpenEditors(route, path));
</script>

{#if route.kind === "local"}
  <ContextMenu.Item onSelect={() => onSelect("open")}><ArrowUpRight /> Open</ContextMenu.Item>
  <ContextMenu.Item onSelect={() => onSelect("reveal")}><FolderOpen /> Reveal in file manager</ContextMenu.Item>
{:else if route.canCopyFile && !isFolder}
  <ContextMenu.Item onSelect={() => onSelect("open")}><ArrowUpRight /> Open local copy</ContextMenu.Item>
  <ContextMenu.Item onSelect={() => onSelect("reveal")}><FolderOpen /> Reveal local copy</ContextMenu.Item>
{/if}
{#if editors.length}
  <ContextMenu.Sub>
    <ContextMenu.SubTrigger>Open with</ContextMenu.SubTrigger>
    <ContextMenu.SubContent data-file-tree-context-menu-root="true">
      {#each editors as editor (editor.id)}
        <ContextMenu.Item onSelect={() => onSelect({ editorId: editor.id })}>
          <AppLogo id={editor.id} kind="editor" size={16} />
          {editor.name}
        </ContextMenu.Item>
      {/each}
    </ContextMenu.SubContent>
  </ContextMenu.Sub>
{/if}
