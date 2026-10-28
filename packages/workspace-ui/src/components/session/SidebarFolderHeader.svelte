<script lang="ts">
  import { ChevronRight as CaretRightIcon, Plus as PlusIcon } from "@lucide/svelte";
  import ProjectFavicon from "../ui/ProjectFavicon.svelte";
  import type { SidebarFolder } from "./lib/sidebar-project-folders";

  /** A project folder's header in the sidebar's project view. It is a row of
   *  the keyboard tree: → and ← open and close it, Enter toggles it. */
  interface Props {
    folder: SidebarFolder;
    onToggle: () => void;
    /** Starts a session in this project. Absent when this person cannot start
     *  one there now. */
    onNewSession?: () => void;
    onContextMenu: (event: MouseEvent) => void;
  }
  let { folder, onToggle, onNewSession, onContextMenu }: Props = $props();
</script>

<!-- Sessions sit below their folder, so a folder takes the gap of a section
     header and none above the first entry. -->
<div class="mt-2 first:mt-0">
  <div
    class="group/folder -mx-2 flex h-8 cursor-pointer items-center gap-[0.5625rem] overflow-hidden rounded-lg pr-2 pl-[0.625rem] text-foreground transition-[background] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_3.5%,transparent)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
    role="treeitem"
    tabindex="0"
    aria-selected="false"
    aria-expanded={folder.isOpen}
    aria-label={folder.hasHiddenAttention
      ? `${folder.label}, ${folder.count} sessions, one needs you`
      : `${folder.label}, ${folder.count} sessions`}
    title={folder.project?.projectKey}
    data-folder-key={folder.key}
    onclick={onToggle}
    oncontextmenu={onContextMenu}
    onkeydown={(event) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onToggle();
    }}
  >
    <ProjectFavicon projectKey={folder.key} class="size-4 shrink-0 pointer-fine:[&_.lucide-icon]:size-[82%]" />
    <span class="min-w-0 flex-1 truncate text-left text-workspace-chrome font-medium">{folder.label}</span>
    {#if !folder.isOpen}
      <span class="shrink-0 text-chrome-shelf text-muted-foreground tabular-nums">{folder.count}</span>
    {/if}
    {#if onNewSession}
      <button
        type="button"
        class="hidden size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-[background-color,color] duration-150 group-hover/folder:flex group-focus-within/folder:flex hover:bg-[color-mix(in_oklch,var(--foreground)_8%,transparent)] hover:text-foreground focus-visible:flex focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:flex"
        aria-label="New session in {folder.label}"
        title="New session in {folder.label}"
        onclick={(event) => {
          event.stopPropagation();
          onNewSession();
        }}
      >
        <PlusIcon size={14} />
      </button>
    {/if}
    <span class="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
      <CaretRightIcon size={14} class="transition-transform duration-150 {folder.isOpen ? 'rotate-90' : ''}" />
    </span>
  </div>
</div>
