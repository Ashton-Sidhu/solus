<script lang="ts">
  import {
    Check as CheckIcon,
    House as HouseIcon,
    Plus as PlusIcon,
  } from "@lucide/svelte";
  import { mergeProps } from "bits-ui";
  import {
    getWorkspaceContext,
    serversStore,
    projectsStore,
    mergeProjectOptions,
    type ProjectRef,
  } from "../../contexts";
  import { isWorkspaceDir } from "../../lib/paths";
  import { projectHostId } from "../servers/run-on";
  import type { RunConfig } from "@solus/contracts/types";
  import { comboHint } from "../../lib/keybindings/manifest";
  import * as TooltipUI from "@solus/workspace-ui/components/ui/tooltip";
  import * as Popover from "../ui/popover";
  import * as Command from "../ui/command";
  import { Button } from "../ui/button";
  import ProjectRowAction from "../ui/ProjectRowAction.svelte";
  import ProjectFavicon from "../ui/ProjectFavicon.svelte";
  import { MenuFooter, MenuSearch } from "../ui/menu";

  interface Props {
    /** Where the next session will run. Read for its host, never written here. */
    run: RunConfig;
    /** The directory the next session starts in — the repo root, not a worktree. */
    projectDir: string;
    label: string;
    onSelect: (path: string) => void;
    /** Open the full project browser: remote hosts and folders not in the catalog. */
    onBrowse: () => void;
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
    onDismiss,
    open = $bindable(false),
    anchor = null,
  }: Props = $props();

  const session = getWorkspaceContext();
  const workspacePath = $derived(session.staticInfo?.workspacePath ?? null);
  // Projects follow the run-on picker: the run names where its project lives, and
  // that host's projects are the ones worth offering. Its own machine is where
  // "My Workspace" and the current checkout make sense; a remote host lists only
  // what it already has.
  const hostId = $derived(projectHostId(run));
  const hostIsLocal = $derived(serversStore.hostFor(hostId)?.local ?? true);
  const onWorkspace = $derived(hostIsLocal && isWorkspaceDir(projectDir, workspacePath));
  // The current checkout is offered even when it is not in the catalog — but
  // only while it lives on the host being listed. A pending "open a project over
  // there" points at a host the current directory is not on, so it is left out.
  const canOfferCurrent = $derived(
    hostIsLocal &&
      run.pendingHostDispatch?.intent !== "open-project" &&
      !projectsStore.isRemoved({ serverId: hostId, projectRoot: projectDir }),
  );

  let tooltipOpen = $state(false);
  let triggerEl = $state<HTMLButtonElement | null>(null);
  let query = $state("");
  let commandEl = $state<HTMLDivElement | null>(null);
  const projects = $derived(
    mergeProjectOptions(
      [
        canOfferCurrent
          ? [{ serverId: hostId, projectRoot: projectDir, label }]
          : [],
        projectsStore.entries.filter((project) => project.serverId === hostId),
      ],
      (serverId) => serversStore.statusFor(serverId) !== "offline",
      (serverId) => serversStore.hostFor(serverId)?.label ?? serverId,
    ),
  );

  // The chip is no longer the only way in, so the list loads off the open state
  // itself rather than off this trigger's click. Reads `hostId` through the
  // load, which keeps an open menu on the host the run-on picker now names.
  $effect(() => {
    if (!open) return;
    tooltipOpen = false;
    query = "";
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

  function activate(path: string) {
    open = false;
    if (path === projectDir) return;
    onSelect(path);
  }

  function removeProject(project: ProjectRef) {
    projectsStore.remove(project);
    commandEl?.querySelector<HTMLInputElement>("[data-slot=command-input]")?.focus();
  }

  function newProject() {
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
    class="menu-surface z-[10002] w-[288px] gap-0 rounded-2xl bg-(--solus-menu-bg) p-0 text-workspace-chrome lg:text-workspace-chrome shadow-[shadow:var(--solus-menu-shadow)] ring-0 [&_.menu-row]:text-workspace-chrome [&_[data-slot=command-input]]:text-workspace-chrome"
  >
    <Command.Root bind:ref={commandEl}>
      <MenuSearch bind:value={query} placeholder="Search projects" />
      <Command.List class="max-h-[256px] overflow-y-auto p-1.5">
        <Command.Empty
          class="px-2.5 py-3 text-center text-xs text-(--solus-text-tertiary)"
        >
          No projects match
        </Command.Empty>
        <Command.Group heading="Projects">
          {#each projects as project (project.key)}
            <Command.Item
              value="{project.label} {project.projectRoot}"
              onSelect={() => activate(project.projectRoot)}
              data-menu-current={project.projectRoot === projectDir ? "" : undefined}
              class="group/project-row relative menu-item-stagger pr-9 pointer-coarse:pr-11 pointer-fine:[.is-laptop-display_&]:pr-9"
            >
              <ProjectFavicon
                projectRoot={project.projectRoot}
                serverId={project.serverId}
                class="size-[13px]"
              />
              <span class="min-w-0 flex-1 truncate">
                {project.label}
              </span>
              <ProjectRowAction
                selected={project.projectRoot === projectDir}
                label={project.label}
                onRemove={() => removeProject(project)}
              />
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
