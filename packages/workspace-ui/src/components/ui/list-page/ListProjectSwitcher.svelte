<script lang="ts">
  import {
    ChevronDown as CaretDownIcon,
    Search as MagnifyingGlassIcon,
    Check as CheckIcon,
    Trash2 as TrashIcon,
    FolderPlus as FolderPlusIcon,
  } from "@lucide/svelte";
  import ProjectFavicon from "../ProjectFavicon.svelte";
  import { abbreviateHome, projectDirLabel } from "../../../lib/paths";
  import {
    projectRefKey,
    type ProjectRef,
  } from "../../../contexts/projects/project-catalog";
  import type { ListProjectOption } from "./list-page";

  /**
   * The scope control every page-level surface uses. It is the leading crumb of
   * the page title — `<project> / <page>` — so the scope is stated where the
   * page names itself and changed in that same place. Quiet until hovered: it
   * is a label first and a button second. Tasks, Pull requests, Automations and
   * the Workspace all share it, so a person scopes the same way on every page.
   *
   * The menu is anchored against its trigger, so its width and its side are the
   * window's business rather than the pane's. A fixed 308px hung from the right
   * edge of a chip 18px in from the left painted the whole menu off-screen at
   * 393px: it opened, and nothing appeared to happen. It is clamped to the
   * window and flips to the leading edge below the phone rung.
   */
  interface Props {
    projects: ListProjectOption[];
    /** `crumb` is the page title's leading crumb; `chip` is the standalone
     *  control for surfaces that have no title band to lead. */
    variant?: "crumb" | "chip";
    /** The scoped project's `key` (host-qualified); `""` when there is none. */
    activeKey?: string;
    /** Stands in when nothing is scoped yet. */
    emptyLabel?: string;
    onSelect?: (option: ListProjectOption) => void;
    /** Forgets a catalog-only project. Files and sessions are untouched. */
    onRemoveHistory?: (option: ListProjectOption) => void;
    /** When set, an "All projects" row leads the menu and clears the scope —
     *  every page but Tasks uses this; Tasks always needs one project. */
    onSelectAll?: () => void;
    allLabel?: string;
    /** What the page does to the rest of its controls when the scope changes. */
    footerNote?: string;
  }
  let {
    projects,
    variant = "chip",
    activeKey,
    emptyLabel = "No project",
    onSelect,
    onRemoveHistory,
    onSelectAll,
    allLabel = "All projects",
    footerNote = "Switching clears search and filters",
  }: Props = $props();

  let menuOpen = $state(false);
  let query = $state("");
  let queryEl = $state<HTMLInputElement | null>(null);

  const active = $derived(projects.find((p) => p.key === activeKey));
  const allActive = $derived(!!onSelectAll && !activeKey);
  // A handful of projects is a list you read; past that it is one you search.
  const showFilter = $derived(projects.length > 6);
  const matches = $derived(
    projects.filter(
      (project) =>
        !query.trim() ||
        project.label.toLowerCase().includes(query.trim().toLowerCase()),
    ),
  );

  function toggle() {
    menuOpen = !menuOpen;
    query = "";
    if (menuOpen) void Promise.resolve().then(() => queryEl?.focus());
  }

  // Esc backs out of the menu before the page's own Esc gets a turn, so the
  // first press never closes the list underneath an open switcher. The page
  // dispatcher listens on document while bubbling; this has to win, hence
  // capture.
  $effect(() => {
    if (!menuOpen) return;
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      menuOpen = false;
    };
    document.addEventListener("keydown", onKeydown, true);
    return () => document.removeEventListener("keydown", onKeydown, true);
  });

  function pick(option: ListProjectOption) {
    if (!option.available) return;
    menuOpen = false;
    query = "";
    if (onSelect) onSelect(option);
  }

  function pickAll() {
    menuOpen = false;
    query = "";
    onSelectAll?.();
  }

  // A project only reaches this menu once something happened in it, which
  // leaves no way to scope a page to a folder that is on disk but has never
  // been opened. The app shell owns the one directory picker on both desktop
  // and web, so the row asks it to browse with the "add a project" intent
  // rather than mounting a second picker on every list page.
  function addProject() {
    menuOpen = false;
    query = "";
    window.dispatchEvent(
      new CustomEvent("solus:open-directory-picker", {
        detail: {
          intent: "add-project",
          onProjectAdded: (project: ProjectRef) => {
            onSelect?.({
              key: projectRefKey(project),
              projectKey: project.projectRoot,
              serverId: project.serverId,
              label: projectDirLabel(project.projectRoot, null),
              available: true,
              historyOnly: true,
            });
          },
        },
      }),
    );
  }
</script>

<!-- The crumb's optical inset is taken here rather than on the button: a
     negative margin on the button is inside the box that `max-w-full` measures,
     so it silently clipped the label by its own width at every row size. -->
<div
  class="relative min-w-0 text-workspace-chrome {variant === 'crumb'
    ? '-ml-2.5 shrink @max-[30rem]/pane:min-w-[6.5rem]'
    : 'shrink-0'}"
>
  <!-- The scrim closes the menu on the next click anywhere, so the trigger has
       no dismissal logic of its own. -->
  {#if menuOpen}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="fixed inset-0 z-30" onclick={() => (menuOpen = false)}></div>
  {/if}

  <button
    type="button"
    class="relative z-40 flex max-w-full cursor-pointer items-center overflow-hidden border-0 transition-colors duration-150 hover:bg-[var(--wash-2)] {variant ===
 'crumb'
 ? 'h-[31px] gap-2 rounded-[9px] px-2.5 pointer-coarse:h-9 [.is-laptop-display_&]:h-[27px] [.is-laptop-display_&]:px-2'
 : 'h-[26px] gap-2 rounded-md px-[7px] @max-[30rem]/pane:h-8 @max-[30rem]/pane:rounded-full'} {menuOpen ? 'bg-[var(--wash-2)]' : 'bg-transparent'}"
    title="Switch project"
    aria-label="Switch project"
    aria-haspopup="menu"
    aria-expanded={menuOpen}
    data-testid="project-switcher"
    onclick={toggle}
  >
    {#if active}
      {#key active.projectKey}
        <ProjectFavicon
          projectRoot={active.projectKey}
          serverId={active.serverId}
          class="shrink-0 {variant === 'crumb'
            ? 'size-4 [.is-laptop-display_&]:size-3.5'
            : 'size-3.5'}"
        />
      {/key}
    {/if}
    <!-- A named project is where you are, so it reads at full contrast beside
         the page crumb. "All projects" is the absence of a scope rather than a
         place, and stays muted. -->
    <span
      class="truncate {variant === 'crumb'
        ? `font-semibold tracking-[-0.013em] ${active ? '' : 'text-muted-foreground'}`
        : 'max-w-[180px] font-normal'}"
    >
      {active?.label ?? (allActive ? allLabel : emptyLabel)}
    </span>
    <CaretDownIcon
      size={variant === "crumb" ? 12 : 14}
      class="shrink-0 text-muted-foreground opacity-50 transition-transform duration-200 {variant ===
      'crumb'
        ? '[.is-laptop-display_&]:size-[11px]'
        : ''} {menuOpen ? 'rotate-180' : ''}"
    />
  </button>

  {#if menuOpen}
    <div
      class="menu-surface absolute top-full z-40 mt-[5px] w-[min(19.25rem,calc(100vw-2rem))] p-[5px] text-workspace-chrome {variant ===
      'crumb'
        ? 'left-0'
        : 'right-0 max-[30rem]:right-auto max-[30rem]:left-0'}"
      role="menu"
      tabindex="-1"
    >
      {#if showFilter}
        <div
          class="mx-px mt-px mb-[3px] flex h-[30px] items-center gap-2 rounded-lg bg-[var(--wash-1)] px-[9px]"
        >
          <MagnifyingGlassIcon
            size={14}
            class="shrink-0 text-muted-foreground opacity-70"
          />
          <input
            bind:this={queryEl}
            bind:value={query}
            class="w-full border-0 bg-transparent outline-none"
            placeholder="Find a project…"
          />
        </div>
      {/if}

      {#if onSelectAll}
        <button
          type="button"
          class="flex h-[34px] w-full cursor-pointer items-center gap-[9px] rounded-lg border-0 px-[9px] text-left transition-colors duration-150 hover:bg-[var(--wash-2)] {allActive
 ? 'bg-[var(--wash-2)]'
 : 'bg-transparent'}"
          onclick={pickAll}
        >
          <span
            class="min-w-0 flex-1 truncate {allActive
 ? 'font-medium'
 : ''}"
          >
            {allLabel}
          </span>
          <span class="flex w-3 shrink-0 justify-end">
            {#if allActive}
              <CheckIcon size={14} class="text-primary" />
            {/if}
          </span>
        </button>
      {/if}

      <div
        class="px-[9px] pt-[5px] pb-1 text-xs font-normal text-muted-foreground uppercase"
      >
        Projects
      </div>

      {#each matches as project (project.key)}
        {@const isActive = project.key === activeKey}
        <div class="group/row flex items-center gap-0.5">
          <button
            type="button"
            class="flex h-[34px] min-w-0 flex-1 overflow-hidden items-center gap-[9px] rounded-lg border-0 px-[9px] text-left transition-colors duration-150 {project.available
 ? 'cursor-pointer hover:bg-[var(--wash-2)]'
 : 'cursor-not-allowed opacity-50'} {isActive ? 'bg-[var(--wash-2)]' : 'bg-transparent'}"
            title={project.available
              ? abbreviateHome(project.projectKey)
              : `${abbreviateHome(project.projectKey)} — host unavailable`}
            disabled={!project.available}
            onclick={() => pick(project)}
          >
            <ProjectFavicon
              projectRoot={project.projectKey}
              serverId={project.serverId}
              class="size-3.5"
            />
            <span
              class="min-w-0 flex-1 truncate {isActive
 ? 'font-medium'
 : ''}"
            >
              {project.label}
            </span>
            <span class="flex w-3 shrink-0 justify-end">
              {#if isActive}
                <CheckIcon size={14} class="text-primary" />
              {/if}
            </span>
          </button>
          {#if project.historyOnly && onRemoveHistory}
            <button
              type="button"
              class="flex size-[34px] shrink-0 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-muted-foreground opacity-0 transition-opacity duration-150 hover:bg-[var(--wash-2)] hover:text-foreground group-hover/row:opacity-100 pointer-coarse:opacity-100"
              title="Remove from history"
              aria-label="Remove {project.label} from history"
              onclick={() => onRemoveHistory(project)}
            >
              <TrashIcon size={13} />
            </button>
          {/if}
        </div>
      {/each}

      {#if matches.length === 0}
        <div class="px-[9px] pt-3 pb-3.5 text-muted-foreground">
          No project matches.
        </div>
      {/if}

      <button
        type="button"
        class="mt-0.5 flex h-[34px] w-full cursor-pointer items-center gap-[9px] rounded-lg border-0 bg-transparent px-[9px] text-left transition-colors duration-150 hover:bg-[var(--wash-2)]"
        data-testid="project-switcher-add"
        onclick={addProject}
      >
        <FolderPlusIcon size={14} class="shrink-0 text-muted-foreground" />
        <span class="min-w-0 flex-1 truncate">Add project…</span>
      </button>

      <div
        class="mt-0.5 flex items-center border-t border-[var(--hairline)] px-[9px] pt-[7px] pb-1 text-xs text-muted-foreground"
      >
        {footerNote}
      </div>
    </div>
  {/if}
</div>
