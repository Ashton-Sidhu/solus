<script lang="ts">
  import { MediaQuery } from "svelte/reactivity";
  import {
    Check as CheckIcon,
    FolderGit2 as FolderIcon,
    FolderPlus as FolderPlusIcon,
    Layers as AllIcon,
    Search as SearchIcon,
  } from "@lucide/svelte";
  import * as DropdownMenu from "../dropdown-menu";
  import ProjectFavicon from "../ProjectFavicon.svelte";
  import ProjectRowAction from "../ProjectRowAction.svelte";
  import { abbreviateHome } from "../../../lib/paths";
  import { openAddProjectPicker } from "./add-project";
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
    onRemoveHistory?: (option: ListProjectOption) => void;
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
    onRemoveHistory,
    onSelectAll,
    allLabel = "All projects",
    onSelectCurrent,
    footerNote = "Switching clears search and filters",
  }: Props = $props();

  const narrowViewport = new MediaQuery("(max-width: 40rem)");
  let query = $state("");

  const active = $derived(projects.find((project) => project.key === activeKey));
  const allActive = $derived(!!onSelectAll && !activeKey);
  const valueLabel = $derived(active?.label ?? (allActive ? allLabel : emptyLabel));
  // A handful of projects is a list you read; past that it is one you search.
  const showFind = $derived(projects.length > 6);
  const matches = $derived(
    projects.filter(
      (project) =>
        !query.trim() ||
        project.label.toLowerCase().includes(query.trim().toLowerCase()),
    ),
  );
</script>

<DropdownMenu.Sub onOpenChange={() => (query = "")}>
  <DropdownMenu.SubTrigger data-testid="project-filter">
    <FolderIcon size={14} class="shrink-0 text-muted-foreground" />
    <span class="min-w-0 flex-1 truncate">Project</span>
    <span class="max-w-24 truncate text-muted-foreground">{valueLabel}</span>
  </DropdownMenu.SubTrigger>
  <DropdownMenu.SubContent
    side={narrowViewport.current ? "bottom" : "right"}
    align={narrowViewport.current ? "end" : "start"}
    collisionPadding={8}
    class="flex max-h-[min(32rem,calc(var(--bits-dropdown-menu-content-available-height,36rem)-1rem))] w-72 max-w-[calc(100vw-1rem)] flex-col overflow-hidden p-2 pointer-fine:[.is-laptop-display_&]:w-60"
  >
    <div class="px-2 pt-0.5 pb-1.5 text-menu text-muted-foreground">Project</div>
    {#if showFind}
      <div
        class="mb-1.5 flex h-9 items-center gap-2 rounded-lg bg-card px-2.5 shadow-[shadow:var(--elev-ring)] focus-within:shadow-[0_0_0_2px_color-mix(in_oklch,var(--primary)_70%,transparent)] pointer-fine:[.is-laptop-display_&]:h-8 pointer-fine:[.is-laptop-display_&]:rounded-md pointer-fine:[.is-laptop-display_&]:px-2"
      >
        <SearchIcon size={16} class="shrink-0 text-muted-foreground" />
        <!-- The group is long enough that it opens to be searched, so focus
             belongs in the field instead of on the first row. -->
        <!-- svelte-ignore a11y_autofocus -->
        <input
          bind:value={query}
          autofocus
          type="text"
          onkeydown={(event) => event.stopPropagation()}
          placeholder="Find a project…"
          aria-label="Find a project"
          class="min-w-0 flex-1 bg-transparent text-menu outline-none placeholder:text-muted-foreground"
        />
      </div>
    {/if}
    <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {#if onSelectAll && !query.trim()}
        <DropdownMenu.Item
          onSelect={onSelectAll}
          data-menu-current={allActive ? "" : undefined}
        >
          <AllIcon size={15} class="shrink-0" />
          <span class="min-w-0 flex-1 truncate">{allLabel}</span>
          {#if allActive}<CheckIcon size={13} class="mr-1.5 shrink-0 text-(--solus-accent)" />{/if}
        </DropdownMenu.Item>
      {/if}
      {#if onSelectCurrent && !query.trim()}
        <DropdownMenu.Item onSelect={onSelectCurrent}>
          <span class="min-w-0 flex-1 truncate">Current project</span>
          <kbd class="mr-1 shrink-0 font-sans text-muted-foreground opacity-70">⌥C</kbd>
        </DropdownMenu.Item>
      {/if}
      {#each matches as project (project.key)}
        {@const isActive = project.key === activeKey}
        <div class="group/project-row relative">
          <DropdownMenu.Item
            class="pr-9 pointer-coarse:pr-11 {project.available ? '' : 'cursor-not-allowed opacity-50'}"
            disabled={!project.available}
            data-menu-current={isActive ? "" : undefined}
            title={project.available
              ? abbreviateHome(project.projectKey)
              : `${abbreviateHome(project.projectKey)} — host unavailable`}
            onSelect={() => onSelect?.(project)}
          >
            <ProjectFavicon
              projectRoot={project.projectKey}
              serverId={project.serverId}
              class="size-3.5"
            />
            <span class="min-w-0 flex-1 truncate {isActive ? 'font-medium' : ''}">
              {project.label}
            </span>
          </DropdownMenu.Item>
          <ProjectRowAction
            selected={isActive}
            label={project.label}
            onRemove={project.historyOnly && onRemoveHistory
              ? () => onRemoveHistory?.(project)
              : undefined}
          />
        </div>
      {/each}
      {#if matches.length === 0}
        <div class="px-2 py-3 text-menu text-muted-foreground">No project matches.</div>
      {/if}
    </div>
    <DropdownMenu.Separator />
    <DropdownMenu.Item data-testid="project-filter-add" onSelect={() => openAddProjectPicker(onSelect)}>
      <FolderPlusIcon size={14} class="shrink-0 text-muted-foreground" />
      <span class="min-w-0 flex-1 truncate">Add project…</span>
    </DropdownMenu.Item>
    <div class="px-2 pt-1.5 pb-0.5 text-xs text-muted-foreground">{footerNote}</div>
  </DropdownMenu.SubContent>
</DropdownMenu.Sub>
