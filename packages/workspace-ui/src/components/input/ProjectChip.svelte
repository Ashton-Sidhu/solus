<script lang="ts">
  import {
    FolderOpen as FolderOpenIcon,
    MessageCircle as ChatIcon,
    Plus as PlusIcon,
  } from "@lucide/svelte";
  import { mergeProps } from "bits-ui";
  import {
    serversStore,
    projectsStore,
    type ProjectRef,
  } from "../../contexts";
  import { isChat, NEW_CHAT_DIRECTORY } from "@solus/contracts/chat";
  import { projectHostId } from "../servers/run-on";
  import type { RunConfig } from "@solus/contracts/types";
  import { comboHint } from "../../lib/keybindings/manifest";
  import * as TooltipUI from "@solus/workspace-ui/components/ui/tooltip";
  import * as Popover from "../ui/popover";
  import * as Command from "../ui/command";
  import { Button } from "../ui/button";
  import ProjectRowAction from "../ui/ProjectRowAction.svelte";
  import ProjectFavicon from "../ui/ProjectFavicon.svelte";
  import { MenuSearch } from "../ui/menu";
  import {
    projectChipOptions,
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
    /** Open the project dialog, which also offers project creation. */
    onNewProject: () => void;
    /** Return focus to the composer once the menu closes. */
    onDismiss: () => void;
    /** Bound where another control opens the same list — the draft headline names
     *  the project too, and one menu answers for both. */
    open?: boolean;
    /** When set, drop the open list from this external project control. */
    anchor?: HTMLElement | null;
    /** Which side of `anchor` the list opens on: below the draft headline,
     *  above the composer's + button. */
    anchorSide?: "top" | "bottom";
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
    anchorSide = "bottom",
  }: Props = $props();

  // The host the project lives on, and the host the run is headed for. They
  // differ for a dispatch, whose project stays home while the agent moves.
  const hostId = $derived(projectHostId(run));
  const selectedHostId = $derived(run.pendingHostDispatch?.serverId ?? run.serverId);
  // A chat draws no chip (its list opens from the + menu); a project's list
  // offers the way back to a chat.
  const inChat = $derived(isChat(projectDir));
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
      !inChat &&
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

  // The chip is no longer the only way in, so the list loads off the open state
  // itself rather than off this trigger's click.
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

  function activate(checkout: ProjectRef) {
    open = false;
    if (checkout.serverId === hostId && checkout.projectRoot === projectDir) return;
    onSelect(checkout);
  }

  function removeProject(project: ProjectChipOption) {
    projectsStore.removeProject(project.key);
    projectsStore.remove(project.checkout);
    commandEl?.querySelector<HTMLInputElement>("[data-slot=command-input]")?.focus();
  }

  /** Open the shared project dialog on its home screen. */
  function openNewProjectFlow() {
    open = false;
    onNewProject();
  }

  function browse() {
    open = false;
    onBrowse();
  }

  /** Drop the project: the draft becomes a new chat on the host it is headed for. */
  function switchToChat() {
    open = false;
    onSelect({ serverId: selectedHostId, projectRoot: NEW_CHAT_DIRECTORY });
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
              class="group relative h-auto min-w-0 shrink gap-1.5 rounded-lg px-2 py-1 text-workspace-chrome font-medium transition-[background-color,color,scale] duration-[var(--duration-quick)] ease-(--ease-premium) active:scale-[0.96] focus-visible:outline-none focus-visible:ring-0 after:absolute after:left-0 after:top-1/2 after:h-10 after:w-full after:-translate-y-1/2 after:content-[''] {open
 ? 'bg-(--solus-surface-hover) text-(--solus-text-primary)'
 : 'text-(--solus-text-tertiary) hover:bg-[color-mix(in_srgb,var(--solus-surface-hover)_60%,transparent)] hover:text-(--solus-text-secondary) focus-visible:bg-(--solus-surface-hover) focus-visible:text-(--solus-text-secondary)'}"
              style="max-width:12rem"
            >
              <ProjectFavicon
                projectRoot={projectDir}
                serverId={hostId}
                class="size-4 shrink-0 text-(--solus-text-tertiary) transition-opacity duration-[var(--duration-quick)] group-hover:opacity-100 {open
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
    side={anchor ? anchorSide : "top"}
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
            {@const isCurrent = project.key === currentKey}
            <Command.Item
              value="{project.label} {project.key}"
              onSelect={() => activate(project.checkout)}
              data-menu-current={isCurrent ? "" : undefined}
              class="group/project-row relative menu-item-stagger pr-9 pointer-coarse:pr-11"
            >
              <ProjectFavicon
                projectRoot={project.checkout.projectRoot}
                serverId={project.checkout.serverId}
                class="size-[13px]"
              />
              <span class="min-w-0 flex-1 truncate">
                {project.label}
              </span>
              {#if project.hostLabel}
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

        <Command.Item value="new project create" onSelect={openNewProjectFlow}>
          <PlusIcon size={13} class="shrink-0 text-(--solus-text-tertiary)" />
          <span class="min-w-0 flex-1 truncate">New project…</span>
        </Command.Item>
        <Command.Item value="open project folder clone" onSelect={browse}>
          <FolderOpenIcon size={13} class="shrink-0 text-(--solus-text-tertiary)" />
          <span class="min-w-0 flex-1 truncate">Open project…</span>
        </Command.Item>
        {#if !inChat}
          <div class="mx-1 my-1.5 h-px bg-(--solus-menu-hairline)"></div>
          <Command.Item value="switch to chat no project" onSelect={switchToChat}>
            <ChatIcon size={13} class="shrink-0 text-(--solus-text-tertiary)" />
            <span class="min-w-0 flex-1 truncate">Switch to chat</span>
          </Command.Item>
        {/if}
      </Command.List>
    </Command.Root>
  </Popover.Content>
</Popover.Root>
