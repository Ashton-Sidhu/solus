<script lang="ts">
  import {
    ArrowLeft as ArrowLeftIcon,
    Check as CheckIcon,
    CircleAlert as CircleAlertIcon,
    FolderOpen as FolderOpenIcon,
    LoaderCircle as LoaderIcon,
    Plus as PlusIcon,
  } from "@lucide/svelte";
  import { mergeProps } from "bits-ui";
  import { serverConnections } from "@solus/client-core/server-connections";
  import {
    connectionsStore,
    serversStore,
    projectsStore,
    type ProjectRef,
  } from "../../contexts";
  import { isChatFolder, SCRATCHPAD_LABEL } from "../../lib/paths";
  import { projectHostId } from "../servers/run-on";
  import NewProjectNameField from "../servers/NewProjectNameField.svelte";
  import { newProjectPath } from "../servers/lib/open-project-flow";
  import { messageFor } from "../servers/lib/setup-rpc";
  import { toasts } from "../../lib/toasts";
  import type { RunConfig } from "@solus/contracts/types";
  import { comboHint } from "../../lib/keybindings/manifest";
  import * as TooltipUI from "@solus/workspace-ui/components/ui/tooltip";
  import * as Popover from "../ui/popover";
  import * as Command from "../ui/command";
  import { Button } from "../ui/button";
  import ProjectRowAction from "../ui/ProjectRowAction.svelte";
  import ProjectFavicon from "../ui/ProjectFavicon.svelte";
  import { MenuFooter, MenuSearch } from "../ui/menu";
  import {
    projectChipOptions,
    scratchpadCheckout,
    type ProjectChipOption,
  } from "./lib/project-chip-options";

  interface Props {
    /** Where the next session will run. Read for its host, never written here. */
    run: RunConfig;
    /** The directory the next session starts in — the repo root, not a worktree. */
    projectDir: string;
    label: string;
    /** Open the project in this checkout. The checkout can be on another host:
     *  the run then moves there. */
    onSelect: (checkout: ProjectRef) => void;
    /** Open the full project browser: remote hosts and folders not in the catalog. */
    onBrowse: () => void;
    /** Create a project from nothing on the run's host, then open it here. */
    onNewProject: () => void;
    /** Return focus to the composer once the menu closes. */
    onDismiss: () => void;
    /** Bound where another control opens the same list — the draft headline names
     *  the project too, and one menu answers for both. */
    open?: boolean;
    /** When set, drop the open list from this external project control. */
    anchor?: HTMLElement | null;
  }
  let {
    run,
    projectDir,
    label,
    onSelect,
    onBrowse,
    onNewProject,
    onDismiss,
    open = $bindable(false),
    anchor = null,
  }: Props = $props();

  // The host the project lives on, and the host the run is headed for. They
  // differ for a dispatch, whose project stays home while the agent moves.
  const hostId = $derived(projectHostId(run));
  const selectedHostId = $derived(run.pendingHostDispatch?.serverId ?? run.serverId);
  // Scratchpad on the host the run is headed for, on every client; absent
  // when that host offers none.
  const scratchpad = $derived(
    scratchpadCheckout(run, (serverId) => connectionsStore.chatFolderFor(serverId)),
  );
  const inScratchpad = $derived(
    isChatFolder(projectDir, connectionsStore.chatFolderFor(hostId)),
  );
  const currentKey = $derived(projectsStore.projectKeyFor(hostId, projectDir));
  // One row per project across every host. The current folder is offered even
  // before the catalog knows it, unless a person removed it from the list.
  const projects = $derived.by((): ProjectChipOption[] => {
    const options = projectChipOptions(
      projectsStore.logicalProjects([]),
      selectedHostId,
      (serverId) => serversStore.statusFor(serverId) === "online",
      (serverId) => serversStore.hostFor(serverId)?.label ?? serverId,
    );
    const offersCurrent =
      !!projectDir &&
      projectDir !== "~" &&
      !inScratchpad &&
      !options.some((option) => option.key === currentKey) &&
      !projectsStore.isRemoved({ serverId: hostId, projectRoot: projectDir });
    return offersCurrent
      ? [{ key: currentKey, label, checkout: { serverId: hostId, projectRoot: projectDir }, hostLabel: null }, ...options]
      : options;
  });

  let tooltipOpen = $state(false);
  let triggerEl = $state<HTMLButtonElement | null>(null);
  let query = $state("");
  let commandEl = $state<HTMLDivElement | null>(null);

  // "New project…" is a step inside this menu rather than a dialog over it:
  // the name is typed where the list was, and Escape goes back to the list.
  let view = $state<"list" | "new">("list");
  let newProjectName = $state("");
  let creatingProject = $state(false);
  // The failure is told once as a toast; the icon marks the field only until
  // the name that failed is edited.
  let createFailure = $state<{ name: string; message: string } | null>(null);
  const failure = $derived(createFailure?.name === newProjectName ? createFailure : null);
  let nameInputEl = $state<HTMLInputElement | HTMLTextAreaElement | null>(null);

  const capabilities = $derived(connectionsStore.capabilitiesFor(hostId));
  const projectsRoot = $derived(capabilities?.projectsBaseDirectory ?? "~/projects");
  const canCreate = $derived(
    !creatingProject && !!newProjectPath(projectsRoot, newProjectName, capabilities?.platform),
  );

  // The chip is no longer the only way in, so the list loads off the open state
  // itself rather than off this trigger's click.
  $effect(() => {
    if (!open) return;
    tooltipOpen = false;
    query = "";
    view = "list";
    newProjectName = "";
    createFailure = null;
    void projectsStore.loadRecentProjects(hostId);
  });

  function handleCloseAutoFocus(event: Event) {
    event.preventDefault();
    onDismiss();
  }

  function getTooltipOpen() {
    return tooltipOpen && !open;
  }

  function setTooltipOpen(next: boolean) {
    tooltipOpen = next && !open;
  }

  function activate(checkout: ProjectRef) {
    open = false;
    if (checkout.serverId === hostId && checkout.projectRoot === projectDir) return;
    onSelect(checkout);
  }

  function removeProject(project: ProjectChipOption) {
    projectsStore.removeProject(project.key);
    if (project.checkout) projectsStore.remove(project.checkout);
    commandEl?.querySelector<HTMLInputElement>("[data-slot=command-input]")?.focus();
  }

  function showNewProject() {
    view = "new";
    // The name field needs the host's projects folder, which may not be read yet.
    if (!capabilities) void connectionsStore.refreshCapabilities({ serverId: hostId });
    requestAnimationFrame(() => nameInputEl?.focus());
  }

  function showList() {
    view = "list";
    createFailure = null;
    requestAnimationFrame(() =>
      commandEl?.querySelector<HTMLInputElement>("[data-slot=command-input]")?.focus(),
    );
  }

  /** Escape steps back to the list before it closes the menu. */
  function handleEscape(event: KeyboardEvent) {
    if (view !== "new") return;
    event.preventDefault();
    showList();
  }

  async function createProject() {
    if (!canCreate) return;
    const name = newProjectName;
    creatingProject = true;
    createFailure = null;
    try {
      const api = serverConnections.apiFor(hostId);
      const result = await api.setupCreateProject({ name: name.trim() });
      projectsStore.addProject(hostId, api, result.path);
      activate({ serverId: hostId, projectRoot: result.path });
    } catch (err) {
      const message = messageFor(err);
      createFailure = { name, message };
      toasts.error("Could not create project", { description: message });
      nameInputEl?.focus();
    } finally {
      creatingProject = false;
    }
  }

  /** The full flow, for a location other than the host's projects folder. */
  function openNewProjectFlow() {
    open = false;
    onNewProject();
  }

  function browse() {
    open = false;
    onBrowse();
  }
</script>

<Popover.Root bind:open>
  <Popover.Trigger>
    {#snippet child({ props })}
      <TooltipUI.Root
        bind:open={getTooltipOpen, setTooltipOpen}
        disabled={open}
      >
        <TooltipUI.Trigger>
          {#snippet child({ props: tooltipProps })}
            <Button
              {...mergeProps(tooltipProps, props)}
              bind:ref={triggerEl}
              variant="ghost"
              class="group relative h-auto min-w-0 shrink gap-1.5 rounded-lg px-2 py-1 text-workspace-chrome font-normal transition-[background-color,color,scale] duration-[var(--duration-quick)] ease-(--ease-premium) active:scale-[0.96] focus-visible:outline-none focus-visible:ring-0 after:absolute after:left-0 after:top-1/2 after:h-10 after:w-full after:-translate-y-1/2 after:content-[''] {open
 ? 'bg-(--solus-surface-hover) text-(--solus-text-primary)'
 : 'text-(--solus-text-tertiary) hover:bg-[color-mix(in_srgb,var(--solus-surface-hover)_60%,transparent)] hover:text-(--solus-text-secondary) focus-visible:bg-(--solus-surface-hover) focus-visible:text-(--solus-text-secondary)'}"
              style="max-width:12rem"
            >
              <ProjectFavicon
                projectRoot={projectDir}
                serverId={hostId}
                class="size-3.5 shrink-0 text-(--solus-text-tertiary) transition-opacity duration-[var(--duration-quick)] group-hover:opacity-100 {open
 ? 'opacity-100'
 : 'opacity-70'}"
              />
              <span class="truncate">{label}</span>
            </Button>
          {/snippet}
        </TooltipUI.Trigger>
        <TooltipUI.Content
          value={{
            label: "Change the project for this chat",
            shortcut: comboHint("global.select-project"),
          }}
        />
      </TooltipUI.Root>
    {/snippet}
  </Popover.Trigger>
  <!-- The composer is bottom-anchored, so the list opens over the transcript.
       `lg:text-workspace-chrome` restates the size for the `lg:` breakpoint: Popover.Content
       ships `lg:text-sm`, and a breakpoint-prefixed class is a separate
       merge group. Nested rows and the search field otherwise keep their own
       fixed menu rung, so this surface opts all three into the display rung. -->
  <Popover.Content
    data-solus-ui
    customAnchor={anchor ?? triggerEl}
    side={anchor ? "bottom" : "top"}
    align="start"
    sideOffset={6}
    collisionPadding={8}
    onCloseAutoFocus={handleCloseAutoFocus}
    onEscapeKeydown={handleEscape}
    class="menu-surface z-[10002] w-[288px] gap-0 rounded-2xl bg-(--solus-menu-bg) p-0 text-workspace-chrome lg:text-workspace-chrome shadow-[shadow:var(--solus-menu-shadow)] ring-0 [&_.menu-row]:text-workspace-chrome [&_[data-slot=command-input]]:text-workspace-chrome"
  >
    {#if view === "new"}
      <!-- The name takes the place of the search field: the same header row,
           typed as the end of its own path, so the step reads as this menu. -->
      <div
        class="flex items-center gap-2 border-b border-(--solus-menu-hairline) px-3 pb-2 pt-2.5 text-(--solus-text-tertiary)"
      >
        <button
          type="button"
          class="-m-1 flex size-5 shrink-0 items-center justify-center rounded-md hover:bg-(--solus-surface-hover) hover:text-(--solus-text-secondary) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--solus-accent)"
          aria-label="Back to projects"
          onclick={showList}
        >
          <ArrowLeftIcon size={13} />
        </button>
        <NewProjectNameField
          bind:value={newProjectName}
          bind:inputEl={nameInputEl}
          parent={projectsRoot}
          platform={capabilities?.platform}
          disabled={creatingProject}
          onsubmit={() => void createProject()}
          class="h-4 leading-4"
        />
        {#if creatingProject}
          <LoaderIcon size={13} class="shrink-0 animate-spin" aria-label="Creating" />
        {:else if failure}
          <span class="shrink-0 text-(--solus-status-error)" title={failure.message}>
            <CircleAlertIcon size={13} aria-label="Could not create project" />
          </span>
        {/if}
      </div>
      <MenuFooter hints={[["⏎", "create"], ["esc", "back"]]}>
        <button
          type="button"
          class="shrink-0 text-xs text-(--solus-text-tertiary) hover:text-(--solus-text-secondary) focus-visible:underline focus-visible:outline-none"
          onclick={openNewProjectFlow}
        >
          Other location…
        </button>
      </MenuFooter>
    {:else}
    <Command.Root bind:ref={commandEl}>
      <MenuSearch bind:value={query} placeholder="Search projects" />
      <Command.List class="max-h-[256px] overflow-y-auto p-1.5">
        <Command.Empty
          class="px-2.5 py-3 text-center text-xs text-(--solus-text-tertiary)"
        >
          No projects match
        </Command.Empty>
        <!-- Scratchpad leads: the one place that needs no project. -->
        {#if scratchpad}
          <Command.Item
            value="scratchpad just chat"
            onSelect={() => activate(scratchpad)}
            data-menu-current={inScratchpad ? "" : undefined}
          >
            <ProjectFavicon
              projectRoot={scratchpad.projectRoot}
              serverId={scratchpad.serverId}
              class="size-[13px]"
            />
            <span class="min-w-0 flex-1 truncate">{SCRATCHPAD_LABEL}</span>
            {#if inScratchpad}
              <CheckIcon size={12} class="shrink-0 text-(--solus-accent)" />
            {/if}
          </Command.Item>
          <div class="mx-1 my-1.5 h-px bg-(--solus-menu-hairline)"></div>
        {/if}
        <Command.Group heading="Projects">
          {#each projects as project (project.key)}
            {@const isCurrent = project.key === currentKey}
            <Command.Item
              value="{project.label} {project.key}"
              disabled={!project.checkout}
              onSelect={() => project.checkout && activate(project.checkout)}
              data-menu-current={isCurrent ? "" : undefined}
              class="group/project-row relative menu-item-stagger pr-9 pointer-coarse:pr-11"
            >
              <ProjectFavicon
                projectRoot={project.checkout?.projectRoot ?? project.key}
                serverId={project.checkout?.serverId ?? hostId}
                class="size-[13px]"
              />
              <span class="min-w-0 flex-1 truncate">
                {project.label}
              </span>
              {#if !project.checkout}
                <span class="shrink-0 text-xs text-(--solus-text-tertiary)">Offline</span>
              {:else if project.hostLabel}
                <span class="max-w-24 shrink-0 truncate text-xs text-(--solus-text-tertiary)">{project.hostLabel}</span>
              {/if}
              <ProjectRowAction
                selected={isCurrent}
                label={project.label}
                onRemove={() => removeProject(project)}
              />
            </Command.Item>
          {/each}
        </Command.Group>

        <div class="mx-1 my-1.5 h-px bg-(--solus-menu-hairline)"></div>

        <Command.Item value="new project create" onSelect={showNewProject}>
          <PlusIcon size={13} class="shrink-0 text-(--solus-text-tertiary)" />
          <span class="min-w-0 flex-1 truncate">New project…</span>
        </Command.Item>
        <Command.Item value="open project folder clone" onSelect={browse}>
          <FolderOpenIcon size={13} class="shrink-0 text-(--solus-text-tertiary)" />
          <span class="min-w-0 flex-1 truncate">Open project…</span>
        </Command.Item>
      </Command.List>
    </Command.Root>
    <MenuFooter hints={[["⏎", "open"]]} summary="{projects.length} projects" />
    {/if}
  </Popover.Content>
</Popover.Root>
