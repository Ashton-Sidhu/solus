<script lang="ts">
  import {
    Check as CheckIcon,
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
  import { formatComboText } from "../../../lib/keybindings/match";

  const currentKey = formatComboText({ alt: true, code: "KeyC" });

  /**
   * The project rows of a scope menu. A list page's Filters menu shows them in
   * its "Project" group, and the session sidebar's funnel shows them in its own
   * menu, so a person picks a project the same way in both places. Render them
   * inside a `DropdownMenu` content.
   */
  interface Props {
    /** A `count` shows beside the project's label. */
    projects: readonly (ListProjectOption & { count?: number })[];
    /** The scoped project's `key` (host-qualified); `""` when there is none. */
    activeKey?: string;
    onSelect?: (option: ListProjectOption) => void;
    /** Forgets a catalog-only project. Files and sessions are untouched. */
    onRemoveProject?: (option: ListProjectOption) => void;
    /** When set, an "All projects" row leads the list and clears the scope. */
    onSelectAll?: () => void;
    allLabel?: string;
    /** When set, a "Current project" row scopes the page to the project the
     *  input bar is in — one explicit step, never automatic
     *  (docs/plans/project-model.md §5). */
    onSelectCurrent?: () => void;
  }
  let {
    projects,
    activeKey,
    onSelect,
    onRemoveProject,
    onSelectAll,
    allLabel = "All projects",
    onSelectCurrent,
  }: Props = $props();

  let query = $state("");

  const allActive = $derived(!!onSelectAll && !activeKey);
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

{#if showFind}
  <div
    class="mb-1.5 flex h-9 shrink-0 items-center gap-2 rounded-lg bg-card px-2.5 shadow-[shadow:var(--elev-ring)] focus-within:shadow-[0_0_0_2px_color-mix(in_oklch,var(--primary)_70%,transparent)]"
  >
    <SearchIcon size={16} class="shrink-0 text-muted-foreground" />
    <!-- The list is long enough that it opens to be searched, so focus
         belongs in the field instead of on the first row. -->
    <!-- svelte-ignore a11y_autofocus -->
    <input
      bind:value={query}
      autofocus
      type="text"
      data-project-find
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
      <kbd class="mr-1 shrink-0 font-sans text-muted-foreground opacity-70">{currentKey}</kbd>
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
          : `${abbreviateHome(project.projectKey)} — ${project.unavailableNote ?? "host unavailable"}`}
        onSelect={() => onSelect?.(project)}
      >
        <ProjectFavicon projectKey={project.key} class="size-3.5" />
        <span class="min-w-0 flex-1 truncate {isActive ? 'font-medium' : ''}">
          {project.label}
        </span>
        {#if project.count !== undefined}
          <span class="shrink-0 text-xs text-muted-foreground tabular-nums">{project.count}</span>
        {/if}
      </DropdownMenu.Item>
      <ProjectRowAction
        selected={isActive}
        label={project.label}
        onRemove={project.removable && onRemoveProject
          ? () => onRemoveProject?.(project)
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
  <span class="min-w-0 flex-1 truncate">Open project…</span>
</DropdownMenu.Item>
