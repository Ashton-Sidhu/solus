<script lang="ts">
  import {
    CaretDownIcon,
    MagnifyingGlassIcon,
    CheckIcon,
    TrashIcon,
  } from "phosphor-svelte";
  import ProjectFavicon from "../ProjectFavicon.svelte";
  import { abbreviateHome } from "../../../lib/paths";
  import type { ListProjectOption } from "./list-page";

  /**
   * The scope control every page-level surface uses. It sits at the head of the
   * action cluster rather than on its own row above the title, so the scope
   * stays stated and changeable without spending a band of vertical space on
   * it. Quiet until hovered — it is a label first and a button second — and
   * Tasks, Pull requests, Automations and the Workspace all share it, so a
   * person scopes the same way on every page.
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
    /** When set, an "All projects" row leads the menu and clears the scope —
     *  every page but Tasks uses this; Tasks always needs one project. */
    onSelectAll?: () => void;
    allLabel?: string;
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
</script>

<div class="relative shrink-0">
  <!-- The scrim closes the menu on the next click anywhere, so the trigger has
       no dismissal logic of its own. -->
  {#if menuOpen}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="fixed inset-0 z-30" onclick={() => (menuOpen = false)}></div>
  {/if}

  <button
    type="button"
    class="relative z-40 flex h-[26px] max-w-full cursor-pointer items-center gap-2 rounded-md border-0 px-[7px] transition-colors duration-150 hover:bg-[var(--wash-1)] {menuOpen
 ? 'bg-[var(--wash-2)]'
 : 'bg-transparent'}"
    title="Switch project"
    aria-label="Switch project"
    aria-haspopup="menu"
    aria-expanded={menuOpen}
    data-testid="project-switcher"
    onclick={toggle}
  >
    {#if active}
      {#key active.projectKey}
        <ProjectFavicon projectRoot={active.projectKey} class="size-3.5" />
      {/key}
    {/if}
    <span
      class="max-w-[180px] truncate font-normal "
    >
      {active?.label ?? (allActive ? allLabel : emptyLabel)}
    </span>
    <CaretDownIcon
      size={14}
      class="shrink-0 text-muted-foreground opacity-50 transition-transform duration-200 {menuOpen
 ? 'rotate-180'
 : ''}"
    />
  </button>

  {#if menuOpen}
    <div
      class="menu-surface absolute top-[31px] right-0 z-40 w-[308px] p-[5px]"
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
            class="flex h-[34px] min-w-0 flex-1 items-center gap-[9px] rounded-lg border-0 px-[9px] text-left transition-colors duration-150 {project.available
 ? 'cursor-pointer hover:bg-[var(--wash-2)]'
 : 'cursor-not-allowed opacity-50'} {isActive ? 'bg-[var(--wash-2)]' : 'bg-transparent'}"
            title={project.available
              ? abbreviateHome(project.projectKey)
              : `${abbreviateHome(project.projectKey)} — host unavailable`}
            disabled={!project.available}
            onclick={() => pick(project)}
          >
            <ProjectFavicon projectRoot={project.projectKey} class="size-3.5" />
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

      <div
        class="mt-0.5 flex items-center border-t border-[var(--hairline)] px-[9px] pt-[7px] pb-1 text-xs text-muted-foreground"
      >
        {footerNote}
      </div>
    </div>
  {/if}
</div>
