<script lang="ts">
  import {
    ChevronDown as CaretDownIcon,
    Search as MagnifyingGlassIcon,
    Check as CheckIcon,
    FolderPlus as FolderPlusIcon,
  } from "@lucide/svelte";
  import ProjectRowAction from "../ProjectRowAction.svelte";
  import { menuRowVariants } from "../menu/menu-row";
  import { cn } from "../../../lib/tw";
  import ProjectFavicon from "../ProjectFavicon.svelte";
  import { abbreviateHome } from "../../../lib/paths";
  import { openAddProjectPicker } from "./add-project";
  import type { ListProjectOption } from "./list-page";

  /**
   * The unified picker's scope control: a quiet crumb before its search field.
   * Quiet until hovered: it is a label first and a button second. The list
   * pages scope from their Filters menu instead (`ListProjectFilter`).
   *
   * The menu is anchored against its trigger, so its width and its side are the
   * window's business rather than the pane's. A fixed 308px hung from the right
   * edge of a chip 18px in from the left painted the whole menu off-screen at
   * 393px: it opened, and nothing appeared to happen. It is clamped to the
   * window and flips to the leading edge below the phone rung.
   */
  interface Props {
    projects: ListProjectOption[];
    /** The scoped project's `key` (host-qualified); `""` when there is none. */
    activeKey?: string;
    /** Stands in when nothing is scoped yet. */
    emptyLabel?: string;
    onSelect?: (option: ListProjectOption) => void;
    /** When set, an "All projects" row leads the menu and clears the scope. */
    onSelectAll?: () => void;
    /** What the page does to the rest of its controls when the scope changes. */
    footerNote?: string;
    menuOpen?: boolean;
  }
  let {
    projects,
    activeKey,
    emptyLabel = "No project",
    onSelect,
    onSelectAll,
    footerNote = "Switching clears search and filters",
    menuOpen = $bindable(false),
  }: Props = $props();

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

  function addProject() {
    menuOpen = false;
    query = "";
    openAddProjectPicker(onSelect);
  }
</script>

<!-- The crumb's optical inset is taken here rather than on the button: a
     negative margin on the button is inside the box that `max-w-full` measures,
     so it silently clipped the label by its own width at every row size. -->
<div
  class="relative -ml-2.5 min-w-0 shrink text-workspace-chrome @max-[30rem]/pane:ml-0 @max-[30rem]/pane:max-w-[9.5rem] @max-[30rem]/pane:shrink-0"
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
    class="relative z-40 flex h-[31px] max-w-full cursor-pointer items-center gap-2 overflow-hidden rounded-[9px] border-0 px-2.5 transition-colors duration-150 hover:bg-[var(--wash-2)] pointer-coarse:h-9 @max-[30rem]/pane:h-8! @max-[30rem]/pane:gap-1.5 @max-[30rem]/pane:rounded-full @max-[30rem]/pane:px-3 @max-[30rem]/pane:shadow-[shadow:var(--elev-ring)] {menuOpen ? 'bg-[var(--wash-2)]' : 'bg-transparent'}"
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
          class="size-4 shrink-0"
        />
      {/key}
    {/if}
    <span
      class="truncate text-[length:calc(var(--text-workspace-chrome)+2px)] font-normal tracking-[-0.013em] text-muted-foreground @max-[30rem]/pane:text-sm"
    >
      {active?.label ?? (allActive ? "All projects" : emptyLabel)}
    </span>
    <CaretDownIcon
      size={12}
      class="shrink-0 text-muted-foreground opacity-50 transition-transform duration-200 {menuOpen ? 'rotate-180' : ''}"
    />
  </button>

  {#if menuOpen}
    <div
      class="menu-surface absolute top-full left-0 z-40 mt-[5px] w-[min(19.25rem,calc(100vw-2rem))] p-[5px] text-workspace-chrome"
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
            All projects
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
        <div class="group/project-row relative rounded-lg hover:bg-(--solus-surface-hover)">
          <button
            type="button"
            class={cn(
              menuRowVariants({ stagger: false }),
              "w-full pr-9 text-left text-workspace-chrome pointer-coarse:pr-11",
              !project.available && "cursor-not-allowed opacity-50",
            )}
            data-menu-current={isActive ? "" : undefined}
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
          </button>
          <ProjectRowAction selected={isActive} label={project.label} />
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
