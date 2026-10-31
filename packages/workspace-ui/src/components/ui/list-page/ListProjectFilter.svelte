<script lang="ts">
  import { MediaQuery } from "svelte/reactivity";
  import { FolderGit2 as FolderIcon } from "@lucide/svelte";
  import * as DropdownMenu from "../dropdown-menu";
  import ListProjectRows from "./ListProjectRows.svelte";
  import type { ListProjectOption } from "./list-page";

  /**
   * The project scope, as one group of a list page's Filters menu. Tasks, Pull
   * requests, Automations and the Workspace all place it there, so a person
   * scopes the same way on every page and the page title above states only
   * which page is on screen.
   */
  interface Props {
    projects: ListProjectOption[];
    /** The scoped project's `key` (host-qualified); `""` when there is none. */
    activeKey?: string;
    /** Stands in when nothing is scoped yet. */
    emptyLabel?: string;
    onSelect?: (option: ListProjectOption) => void;
    /** Forgets a catalog-only project. Files and sessions are untouched. */
    onRemoveProject?: (option: ListProjectOption) => void;
    /** When set, an "All projects" row leads the group and clears the scope. */
    onSelectAll?: () => void;
    allLabel?: string;
    /** When set, a "Current project" row scopes the page to the project the
     *  input bar is in — one explicit step, never automatic
     *  (docs/plans/project-model.md §5). */
    onSelectCurrent?: () => void;
    /** What the page does to the rest of its controls when the scope changes. */
    footerNote?: string;
  }
  let {
    projects,
    activeKey,
    emptyLabel = "No project",
    onSelect,
    onRemoveProject,
    onSelectAll,
    allLabel = "All projects",
    onSelectCurrent,
    footerNote = "Switching clears search and filters",
  }: Props = $props();

  const narrowViewport = new MediaQuery("(max-width: 40rem)");

  const active = $derived(projects.find((project) => project.key === activeKey));
  const allActive = $derived(!!onSelectAll && !activeKey);
  const valueLabel = $derived(active?.label ?? (allActive ? allLabel : emptyLabel));
</script>

<DropdownMenu.Sub>
  <DropdownMenu.SubTrigger data-testid="project-filter">
    <FolderIcon size={14} class="shrink-0 text-muted-foreground" />
    <span class="min-w-0 flex-1 truncate">Project</span>
    <span class="max-w-24 truncate text-muted-foreground">{valueLabel}</span>
  </DropdownMenu.SubTrigger>
  <DropdownMenu.SubContent
    side={narrowViewport.current ? "bottom" : "right"}
    align={narrowViewport.current ? "end" : "start"}
    collisionPadding={8}
    class="flex max-h-[min(32rem,calc(var(--bits-dropdown-menu-content-available-height,36rem)-1rem))] w-72 max-w-[calc(100vw-1rem)] flex-col overflow-hidden p-2"
  >
    <div class="px-2 pt-0.5 pb-1.5 text-menu text-muted-foreground">Project</div>
    <ListProjectRows
      {projects}
      {activeKey}
      {onSelect}
      {onRemoveProject}
      {onSelectAll}
      {allLabel}
      {onSelectCurrent}
    />
    <div class="px-2 pt-1.5 pb-0.5 text-xs text-muted-foreground">{footerNote}</div>
  </DropdownMenu.SubContent>
</DropdownMenu.Sub>
