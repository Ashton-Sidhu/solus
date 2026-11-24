<script lang="ts">
  import { ArrowUpRight, FolderOpen } from "@lucide/svelte";
  import AppLogo from "../settings/AppLogo.svelte";
  import * as ContextMenu from "../ui/context-menu";
  import type { FileOpenAction, FileOpenRoute } from "./lib/file-open-actions";

  let { route, onSelect }: { route: FileOpenRoute; onSelect: (action: FileOpenAction) => void } = $props();
</script>

{#if route.kind === "local"}
  <ContextMenu.Item onSelect={() => onSelect("open")}><ArrowUpRight /> Open</ContextMenu.Item>
  <ContextMenu.Item onSelect={() => onSelect("reveal")}><FolderOpen /> Reveal in file manager</ContextMenu.Item>
{/if}
{#if route.editors.length}
  <ContextMenu.Sub>
    <ContextMenu.SubTrigger>Open with</ContextMenu.SubTrigger>
    <ContextMenu.SubContent data-file-tree-context-menu-root="true">
      {#each route.editors as editor (editor.id)}
        <ContextMenu.Item onSelect={() => onSelect({ editorId: editor.id })}>
          <AppLogo id={editor.id} kind="editor" size={16} />
          {editor.name}
        </ContextMenu.Item>
      {/each}
    </ContextMenu.SubContent>
  </ContextMenu.Sub>
{/if}
