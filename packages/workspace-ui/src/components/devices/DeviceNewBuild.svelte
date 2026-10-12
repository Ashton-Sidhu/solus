<script lang="ts">
  import { Check, ChevronDown, FolderGit2, Hammer } from "@lucide/svelte";
  import type { DeviceRunProfile } from "@solus/contracts/device-types";
  import type { ProjectEntry } from "@solus/contracts/types";
  import { newBuildsRunning, profileTargetLabel } from "@solus/client-core/device-builds";
  import { devicesStore, deviceErrorMessage } from "../../contexts/devices/devices.store.svelte";
  import { PAGE_PRIMARY_BTN } from "../../lib/page-chrome";
  import { abbreviateHome } from "../../lib/paths";
  import { toasts } from "../../lib/toasts";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import ProjectFavicon from "../ui/ProjectFavicon.svelte";
  import { groupKeyFor } from "../../contexts";

  /**
   * New build on the Builds page (plan 016, S02): build one of the project's
   * saved profiles in the conversation's checkout and add the output under
   * Builds. It installs nowhere; Run does that. Without a conversation the
   * person chooses one of the host's projects first; with no profile saved,
   * it offers the profile editor.
   */
  interface Props {
    serverId: string;
    sessionId: string | null;
    /** The conversation's checkout; builds run there. */
    checkoutPath: string | null;
    /** The host's projects, to choose what to build. */
    projects: ProjectEntry[];
    onChooseProject: (path: string) => void;
    onEditProfiles: () => void;
    /** The menu's open state; Builds opens it again after profiles are saved. */
    open?: boolean;
  }

  let { serverId, sessionId, checkoutPath, projects, onChooseProject, onEditProfiles, open = $bindable(false) }: Props = $props();
  const projectName = $derived(checkoutPath ? (checkoutPath.split(/[\\/]/).filter(Boolean).at(-1) ?? checkoutPath) : null);

  const profiles = $derived(checkoutPath ? devicesStore.runProfiles(serverId, checkoutPath) : null);
  /** Profiles building in this checkout now: a second start would only watch the same build. */
  const building = $derived(newBuildsRunning(devicesStore.runs(serverId), checkoutPath));
  let starting = $state(false);

  async function start(profile: DeviceRunProfile) {
    if (!checkoutPath || starting) return;
    starting = true;
    try {
      const request: Parameters<typeof devicesStore.startRun>[1] = { checkoutPath, profileName: profile.name };
      if (sessionId) request.sessionId = sessionId;
      await devicesStore.startRun(serverId, request, (question) => confirm(question));
    } catch (cause) {
      toasts.error(`Couldn't start ${profile.name}`, { description: deviceErrorMessage(cause) });
    } finally {
      starting = false;
    }
  }

  // Choosing a project is half the question: open the menu again on its profiles, so the next step is in view.
  function chooseProject(path: string) {
    onChooseProject(path);
    setTimeout(() => (open = true));
  }
</script>

{#snippet projectItems()}
  <!-- The folder path under each name: two checkouts can share a folder name. -->
  {#each projects as project (project.path)}
    {@const isCurrent = project.path === checkoutPath}
    <DropdownMenu.Item data-menu-current={isCurrent ? "" : undefined} title={abbreviateHome(project.path)} onSelect={() => chooseProject(project.path)}>
      <ProjectFavicon projectKey={groupKeyFor(serverId, project.path)} class="size-3.5" />
      <span class="flex min-w-0 flex-1 flex-col">
        <span class="truncate {isCurrent ? 'font-medium' : ''}">{project.folderName}</span>
        <span class="truncate text-xs text-muted-foreground">{abbreviateHome(project.path)}</span>
      </span>
      {#if isCurrent}<Check size={13} class="mr-1.5 shrink-0 text-(--solus-accent)" />{/if}
    </DropdownMenu.Item>
  {:else}
    <p class="px-2 py-3 text-menu text-muted-foreground">No projects on this host yet. Open one in a conversation first.</p>
  {/each}
{/snippet}

<DropdownMenu.Root bind:open>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <button {...props} type="button" class="{PAGE_PRIMARY_BTN} disabled:cursor-not-allowed disabled:opacity-50" disabled={starting}>
        <Hammer size={14} />New build<ChevronDown size={14} class="-mr-0.5 opacity-80" />
      </button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align="end" class="w-[min(18rem,calc(100vw-2rem))]">
    {#if !checkoutPath}
      <div class="px-2 pt-0.5 pb-1.5 text-menu text-muted-foreground">Build which project?</div>
      {@render projectItems()}
    {:else}
      <div class="truncate px-2 pt-0.5 pb-1.5 text-menu text-muted-foreground">Build {projectName} with</div>
      {#if profiles === undefined}
        <DropdownMenu.Item disabled>Reading build profiles…</DropdownMenu.Item>
      {:else if !profiles?.length}
        <DropdownMenu.Item onSelect={onEditProfiles}>
          <span class="flex min-w-0 flex-1 flex-col">
            <span>Set up a build profile…</span>
            <span class="text-xs text-muted-foreground">This project has none yet</span>
          </span>
        </DropdownMenu.Item>
      {:else}
        {#each profiles as profile (profile.name)}
          <DropdownMenu.Item disabled={building.has(profile.name)} onSelect={() => void start(profile)}>
            <span class="min-w-0 flex-1 truncate">{profile.name}</span>
            <span class="shrink-0 text-muted-foreground">{building.has(profile.name) ? "Building…" : profileTargetLabel(profile)}</span>
          </DropdownMenu.Item>
        {/each}
        <DropdownMenu.Item onSelect={onEditProfiles}>Edit build profiles…</DropdownMenu.Item>
      {/if}
      <DropdownMenu.Separator />
      <DropdownMenu.Sub>
        <DropdownMenu.SubTrigger>
          <FolderGit2 size={14} class="shrink-0 text-muted-foreground" />
          <span class="min-w-0 flex-1 truncate">Other project</span>
        </DropdownMenu.SubTrigger>
        <DropdownMenu.SubContent class="flex max-h-[min(32rem,calc(var(--bits-dropdown-menu-content-available-height,36rem)-1rem))] w-72 max-w-[calc(100vw-1rem)] flex-col overflow-y-auto p-2">
          <div class="px-2 pt-0.5 pb-1.5 text-menu text-muted-foreground">Project</div>
          {@render projectItems()}
        </DropdownMenu.SubContent>
      </DropdownMenu.Sub>
    {/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>
