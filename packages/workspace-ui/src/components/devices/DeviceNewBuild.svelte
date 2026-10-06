<script lang="ts">
  import { ChevronDown, Hammer } from "@lucide/svelte";
  import type { DeviceRunProfile } from "@solus/contracts/device-types";
  import { newBuildsRunning, profileTargetLabel } from "@solus/client-core/device-builds";
  import { devicesStore, deviceErrorMessage } from "../../contexts/devices/devices.store.svelte";
  import { toasts } from "../../lib/toasts";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";

  /**
   * New build on the Builds page (plan 016, S02): build one of the project's
   * saved profiles in the conversation's checkout and add the output under
   * Builds. It installs nowhere; Run does that. With no profile saved, it
   * opens the profile editor instead.
   */
  interface Props {
    serverId: string;
    sessionId: string | null;
    /** The conversation's checkout; builds run there. */
    checkoutPath: string | null;
    onEditProfiles: () => void;
  }

  let { serverId, sessionId, checkoutPath, onEditProfiles }: Props = $props();

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

{#if !checkoutPath}
  <Button size="sm" variant="outline" disabled title="Open a conversation in a project to build it"><Hammer />New build</Button>
{:else if profiles === undefined}
  <Button size="sm" variant="outline" disabled><Hammer />New build</Button>
{:else if !profiles?.length}
  <Button size="sm" variant="outline" title="Save how this project builds, then build it from here" onclick={onEditProfiles}><Hammer />Set up a build…</Button>
{:else}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <Button {...props} size="sm" variant="outline" disabled={starting}><Hammer />New build<ChevronDown /></Button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="end" class="w-[min(17rem,calc(100vw-2rem))]">
      {#each profiles as profile (profile.name)}
        <DropdownMenu.Item disabled={building.has(profile.name)} onSelect={() => void start(profile)}>
          <span class="min-w-0 flex-1 truncate">{profile.name}</span>
          <span class="shrink-0 text-muted-foreground">{building.has(profile.name) ? "Building…" : profileTargetLabel(profile)}</span>
        </DropdownMenu.Item>
      {/each}
      <DropdownMenu.Separator />
      <DropdownMenu.Item onSelect={onEditProfiles}>Edit build profiles…</DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/if}
