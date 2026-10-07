<script lang="ts">
  import { Check, ChevronDown, Hammer } from "@lucide/svelte";
  import type { DeviceRunProfile } from "@solus/contracts/device-types";
  import type { ProjectEntry } from "@solus/contracts/types";
  import { newBuildsRunning, profileTargetLabel } from "@solus/client-core/device-builds";
  import { devicesStore, deviceErrorMessage } from "../../contexts/devices/devices.store.svelte";
  import { toasts } from "../../lib/toasts";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";

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
  }

  let { serverId, sessionId, checkoutPath, projects, onChooseProject, onEditProfiles }: Props = $props();
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
</script>

{#snippet projectItems()}
  {#each projects as project (project.path)}
    <DropdownMenu.Item onSelect={() => onChooseProject(project.path)}>
      <span class="min-w-0 flex-1 truncate">{project.folderName}</span>
      {#if project.path === checkoutPath}<Check class="size-4 shrink-0" />{/if}
    </DropdownMenu.Item>
  {:else}
    <p class="px-2 py-1.5 text-muted-foreground">No projects on this host yet. Open one in a conversation first.</p>
  {/each}
{/snippet}

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <Button {...props} size="sm" variant="outline" disabled={starting}><Hammer />New build<ChevronDown /></Button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align="end" class="w-[min(17rem,calc(100vw-2rem))]">
    {#if !checkoutPath}
      <p class="px-2 pt-1.5 pb-1 text-muted-foreground">Build which project?</p>
      {@render projectItems()}
    {:else}
      {#if profiles === undefined}
        <DropdownMenu.Item disabled>Reading build profiles…</DropdownMenu.Item>
      {:else if !profiles?.length}
        <DropdownMenu.Item onSelect={onEditProfiles}>Set up a build…</DropdownMenu.Item>
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
          <span class="min-w-0 flex-1 truncate">Project: {projectName}</span>
        </DropdownMenu.SubTrigger>
        <DropdownMenu.SubContent class="w-[min(16rem,calc(100vw-2rem))]">
          {@render projectItems()}
        </DropdownMenu.SubContent>
      </DropdownMenu.Sub>
    {/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>
