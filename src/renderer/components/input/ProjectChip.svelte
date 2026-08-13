<script lang="ts">
  import { CheckIcon, FolderIcon, HouseIcon, PlusIcon } from "phosphor-svelte";
  import { mergeProps } from "bits-ui";
  import { getWorkspaceContext, serversStore } from "../../contexts";
  import { isWorkspaceDir, projectDirLabel } from "../../lib/paths";
  import { projectHostId } from "../servers/run-on";
  import type { RecentProject, RunConfig } from "../../../shared/types";
  import { comboHint } from "../../lib/keybindings/manifest";
  import * as TooltipUI from "@renderer/components/ui/tooltip";
  import * as Popover from "../ui/popover";
  import * as Command from "../ui/command";
  import { Button } from "../ui/button";
  import { MenuFooter, MenuSearch } from "../ui/menu";

  interface Props {
    /** Where the next session will run. Read for its host, never written here. */
    run: RunConfig;
    /** The directory the next session starts in — the repo root, not a worktree. */
    projectDir: string;
    label: string;
    onSelect: (path: string) => void;
    /** Open the full project browser: remote hosts and folders not in recents. */
    onBrowse: () => void;
    /** Return focus to the composer once the menu closes. */
    onDismiss: () => void;
  }
  let { run, projectDir, label, onSelect, onBrowse, onDismiss }: Props = $props();

  const session = getWorkspaceContext();
  const workspacePath = $derived(session.staticInfo?.workspacePath ?? null);
  // Recents follow the run-on picker: the run names where its project lives, and
  // that host's projects are the ones worth offering. Its own machine is where
  // "My Workspace" and the current checkout make sense; a remote host lists only
  // what it already has.
  const hostId = $derived(projectHostId(run));
  const hostIsLocal = $derived(serversStore.hostFor(hostId)?.local ?? true);
  const onWorkspace = $derived(hostIsLocal && isWorkspaceDir(projectDir, workspacePath));
  // The current checkout is offered even when it has aged out of recents — but
  // only while it lives on the host being listed. A pending "open a project over
  // there" points at a host the current directory is not on, so it is left out.
  const canOfferCurrent = $derived(
    hostIsLocal && run.pendingHostDispatch?.intent !== "open-project",
  );

  let open = $state(false);
  let tooltipOpen = $state(false);
  let triggerEl = $state<HTMLButtonElement | null>(null);
  let query = $state("");
  let recents = $state<RecentProject[]>([]);
  // Bumped per load so a slow reply for the host you just switched away from is
  // dropped instead of painting one host's projects under another's name.
  let loadToken = 0;

  const projects = $derived(
    canOfferCurrent && !recents.some((project) => project.path === projectDir)
      ? [
          { path: projectDir, folderName: label, lastOpened: new Date().toISOString() },
          ...recents,
        ].slice(0, 3)
      : recents.slice(0, 3),
  );

  async function loadRecents() {
    const requestedHost = hostId;
    const token = ++loadToken;
    try {
      const list = await serversStore.recentProjectsFor(requestedHost);
      if (token === loadToken) recents = list;
    } catch {
      if (token === loadToken) recents = [];
    }
  }

  function handleOpenChange(next: boolean) {
    open = next;
    if (next) {
      tooltipOpen = false;
      query = "";
      void loadRecents();
      return;
    }
  }

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

  function activate(path: string) {
    open = false;
    if (path === projectDir) return;
    onSelect(path);
  }

  function newProject() {
    open = false;
    onBrowse();
  }
</script>

<Popover.Root bind:open onOpenChange={handleOpenChange}>
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
              class="group relative h-auto min-w-0 shrink gap-1.5 rounded-lg px-2 py-1 text-[0.8125rem] font-normal transition-[background-color,color,scale] duration-[var(--duration-quick)] ease-(--ease-premium) active:scale-[0.96] focus-visible:outline-none focus-visible:ring-0 after:absolute after:left-0 after:top-1/2 after:h-10 after:w-full after:-translate-y-1/2 after:content-[''] {open
 ? 'bg-(--solus-surface-hover) text-(--solus-text-primary)'
 : 'text-(--solus-text-tertiary) hover:bg-[color-mix(in_srgb,var(--solus-surface-hover)_60%,transparent)] hover:text-(--solus-text-secondary) focus-visible:bg-(--solus-surface-hover) focus-visible:text-(--solus-text-secondary)'}"
              style="max-width:12rem"
            >
              <FolderIcon
                size={14}
                class="shrink-0 text-(--solus-text-tertiary) transition-opacity duration-[var(--duration-quick)] group-hover:opacity-100 {open
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
       `lg:text-menu` restates the size for the `lg:` breakpoint: Popover.Content
       ships `lg:text-sm`, and a breakpoint-prefixed class is a separate
       merge group, so the bare `text-menu` leaves it standing and the 15px wins
       above 1024px. -->
  <Popover.Content
    data-solus-ui
    customAnchor={triggerEl}
    side="top"
    align="start"
    sideOffset={6}
    collisionPadding={8}
    onCloseAutoFocus={handleCloseAutoFocus}
    class="menu-surface z-[10002] w-[288px] gap-0 rounded-2xl bg-(--solus-menu-bg) p-0 text-menu lg:text-menu shadow-[shadow:var(--solus-menu-shadow)] ring-0"
  >
    <Command.Root>
      <MenuSearch bind:value={query} placeholder="Search projects" />
      <Command.List class="max-h-[256px] overflow-y-auto p-1.5">
        <Command.Empty
          class="px-2.5 py-3 text-center text-xs text-(--solus-text-tertiary)"
        >
          No projects match
        </Command.Empty>
        <Command.Group heading="Recent">
          {#each projects as project (project.path)}
            <Command.Item
              value="{project.folderName} {project.path}"
              onSelect={() => activate(project.path)}
              data-menu-current={project.path === projectDir ? "" : undefined}
              class="menu-item-stagger"
            >
              <FolderIcon
                size={13}
                class="shrink-0 text-(--solus-text-tertiary)"
              />
              <span class="min-w-0 flex-1 truncate">
                {projectDirLabel(project.path, workspacePath)}
              </span>
              {#if project.path === projectDir}
                <CheckIcon size={12} class="shrink-0 text-(--solus-accent)" />
              {/if}
            </Command.Item>
          {/each}
        </Command.Group>

        <div class="mx-1 my-1.5 h-px bg-(--solus-menu-hairline)"></div>

        <Command.Item value="new project open folder clone" onSelect={newProject}>
          <PlusIcon size={13} class="shrink-0 text-(--solus-text-tertiary)" />
          <span class="min-w-0 flex-1 truncate">New project</span>
        </Command.Item>
        {#if workspacePath && hostIsLocal}
          <Command.Item
            value="my workspace"
            onSelect={() => activate(workspacePath)}
            data-menu-current={onWorkspace ? "" : undefined}
          >
            <HouseIcon
              size={13}
              class="shrink-0 text-(--solus-text-tertiary)"
            />
            <span class="min-w-0 flex-1 truncate">My Workspace</span>
            {#if onWorkspace}
              <CheckIcon size={12} class="shrink-0 text-(--solus-accent)" />
            {/if}
          </Command.Item>
        {/if}
      </Command.List>
    </Command.Root>
    <MenuFooter hints={[["⏎", "open"]]} summary="{projects.length} projects" />
  </Popover.Content>
</Popover.Root>
