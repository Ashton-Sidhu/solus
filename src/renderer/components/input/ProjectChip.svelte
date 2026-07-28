<script lang="ts">
  import { CheckIcon, FolderIcon, HouseIcon, PlusIcon } from "phosphor-svelte";
  import { mergeProps } from "bits-ui";
  import { getWorkspaceContext, projectsStore, serversStore } from "../../contexts";
  import { isWorkspaceDir, projectDirLabel } from "../../lib/paths";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { comboHint } from "../../lib/keybindings/manifest";
  import * as TooltipUI from "@renderer/components/ui/tooltip";
  import * as Popover from "../ui/popover";
  import * as Command from "../ui/command";
  import { Button } from "../ui/button";
  import { MenuFooter, MenuSearch } from "../ui/menu";

  interface Props {
    tabId: string;
    /** The directory the next session starts in — the repo root, not a worktree. */
    projectDir: string;
    label: string;
  }
  let { tabId, projectDir, label }: Props = $props();

  const session = getWorkspaceContext();
  const workspacePath = $derived(session.staticInfo?.workspacePath ?? null);
  // Recents are this machine's. A session bound for another host must pick its
  // project over there, which is what the full open-project flow is for.
  const onRemoteHost = $derived.by(() => {
    const target = session.sessionFor(tabId);
    if (!target) return false;
    const serverId = target.pendingHostDispatch?.serverId ?? target.serverId;
    return serversStore.hostFor(serverId)?.local === false;
  });
  const onWorkspace = $derived(isWorkspaceDir(projectDir, workspacePath));
  // The current project is always offered, even when it has aged out of recents.
  const projects = $derived(
    projectsStore.recentProjects.some((project) => project.path === projectDir)
      ? projectsStore.recentProjects.slice(0, 3)
      : [
          { path: projectDir, folderName: label, lastOpened: new Date().toISOString() },
          ...projectsStore.recentProjects,
        ].slice(0, 3),
  );

  let open = $state(false);
  let tooltipOpen = $state(false);
  let triggerEl = $state<HTMLButtonElement | null>(null);
  let query = $state("");

  function handleOpenChange(next: boolean) {
    if (next && onRemoteHost) {
      newProject();
      return;
    }
    open = next;
    if (next) {
      tooltipOpen = false;
      query = "";
      void projectsStore.loadRecentProjects();
      return;
    }
    requestInputFocus({ tabId });
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
    void session.setBaseDirectory(path, tabId).then(
      () => requestInputFocus({ tabId }),
      () => {},
    );
  }

  function newProject() {
    open = false;
    window.dispatchEvent(
      new CustomEvent("solus:open-project", { detail: { tabId } }),
    );
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
              class="group relative h-auto min-w-0 shrink gap-1.5 rounded-lg px-2 py-1 text-[0.8125rem] font-normal tracking-[-0.006em] transition-[background-color,color,scale] duration-[var(--duration-quick)] ease-(--ease-premium) active:scale-[0.96] focus-visible:outline-none focus-visible:ring-0 after:absolute after:left-0 after:top-1/2 after:h-10 after:w-full after:-translate-y-1/2 after:content-[''] {open
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
       ships `lg:text-[0.9375rem]`, and a breakpoint-prefixed class is a separate
       merge group, so the bare `text-menu` leaves it standing and the 15px wins
       above 1024px. -->
  <Popover.Content
    data-solus-ui
    customAnchor={triggerEl}
    side="top"
    align="start"
    sideOffset={6}
    collisionPadding={8}
    class="menu-surface z-[10002] w-[288px] gap-0 rounded-2xl bg-(--solus-menu-bg) p-0 text-menu lg:text-menu shadow-[shadow:var(--solus-menu-shadow)] ring-0"
  >
    <Command.Root>
      <MenuSearch bind:value={query} placeholder="Search projects" />
      <Command.List class="max-h-[256px] overflow-y-auto p-1.5">
        <Command.Empty
          class="px-2.5 py-3 text-center text-[0.75rem] text-(--solus-text-tertiary)"
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
        {#if workspacePath}
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
