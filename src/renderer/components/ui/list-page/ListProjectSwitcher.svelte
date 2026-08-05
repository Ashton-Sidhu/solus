<script lang="ts">
  import { CaretDownIcon, MagnifyingGlassIcon, CheckIcon } from "phosphor-svelte";
  import ProjectFavicon from "../ProjectFavicon.svelte";
  import { abbreviateHome } from "../../../lib/paths";
  import type { ListProjectOption } from "./list-page";

  /**
   * The list page's scope control. It sits at the head of the action cluster
   * rather than on its own row above the title, so the scope stays stated and
   * changeable without spending a band of vertical space on it. Quiet until
   * hovered — it is a label first and a button second — and both list pages
   * share it so Tasks and Pull requests scope the same way.
   */
  interface Props {
    projects: ListProjectOption[];
    /** Repo root of the project on screen; `""` when there is none. */
    activeProjectKey: string;
    /** Stands in when nothing is scoped yet. */
    emptyLabel?: string;
    onSelect: (projectKey: string) => void;
  }
  let {
    projects,
    activeProjectKey,
    emptyLabel = "No project",
    onSelect,
  }: Props = $props();

  let menuOpen = $state(false);
  let query = $state("");
  let queryEl = $state<HTMLInputElement | null>(null);

  const active = $derived(projects.find((p) => p.projectKey === activeProjectKey));
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

  function pick(projectKey: string) {
    menuOpen = false;
    query = "";
    onSelect(projectKey);
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
    aria-haspopup="menu"
    aria-expanded={menuOpen}
    onclick={toggle}
  >
    {#if active}
      {#key active.projectKey}
        <ProjectFavicon projectRoot={active.projectKey} class="size-3.5" />
      {/key}
    {/if}
    <span
      class="max-w-[180px] truncate text-[13px] font-[450] tracking-[-.005em]"
    >
      {active?.label ?? emptyLabel}
    </span>
    <CaretDownIcon
      size={11}
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
            size={12}
            class="shrink-0 text-muted-foreground opacity-70"
          />
          <input
            bind:this={queryEl}
            bind:value={query}
            class="w-full border-0 bg-transparent text-[13px] outline-none"
            placeholder="Find a project…"
          />
        </div>
      {/if}

      <div
        class="px-[9px] pt-[5px] pb-1 text-[10px] font-[450] tracking-[.09em] text-muted-foreground uppercase"
      >
        Projects
      </div>

      {#each matches as project (project.projectKey)}
        {@const isActive = project.projectKey === activeProjectKey}
        <button
          type="button"
          class="flex h-[34px] w-full cursor-pointer items-center gap-[9px] rounded-lg border-0 px-[9px] text-left transition-colors duration-150 hover:bg-[var(--wash-2)] {isActive
            ? 'bg-[var(--wash-2)]'
            : 'bg-transparent'}"
          title={abbreviateHome(project.projectKey)}
          onclick={() => pick(project.projectKey)}
        >
          <ProjectFavicon projectRoot={project.projectKey} class="size-3.5" />
          <span
            class="min-w-0 flex-1 truncate text-[13px] tracking-[-.005em] {isActive
              ? 'font-medium'
              : ''}"
          >
            {project.label}
          </span>
          <span class="flex w-3 shrink-0 justify-end">
            {#if isActive}
              <CheckIcon size={12} class="text-primary" />
            {/if}
          </span>
        </button>
      {/each}

      {#if matches.length === 0}
        <div class="px-[9px] pt-3 pb-3.5 text-[13px] text-muted-foreground">
          No project matches.
        </div>
      {/if}

      <div
        class="mt-0.5 flex items-center border-t border-[var(--hairline)] px-[9px] pt-[7px] pb-1 text-[12px] text-muted-foreground"
      >
        Switching clears search and filters
      </div>
    </div>
  {/if}
</div>
