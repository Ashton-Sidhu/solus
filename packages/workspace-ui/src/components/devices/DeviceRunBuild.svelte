<script lang="ts">
  import { ChevronDown, Hammer, Play, ScrollText, Smartphone, X } from "@lucide/svelte";
  import { isDeviceRunActive, type DeviceBuild, type DeviceRunProfile, type DeviceSummary } from "@solus/contracts/device-types";
  import { buildsForDevice } from "@solus/client-core/device-builds";
  import { getWorkspaceContext } from "../../contexts";
  import { devicesStore, deviceErrorMessage } from "../../contexts/devices/devices.store.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import * as TooltipUI from "../ui/tooltip";
  import { deviceViewState } from "./lib/device-view-state.svelte";
  import { runDeviceBuild } from "./lib/run-build";
  import { phoneTarget, profilesForDevice, runStageLabel, shownRun } from "./lib/run-profiles";

  /**
   * Build & run on the device on screen (plan 016, S02). One click builds the
   * project's first fitting profile in the conversation's checkout, installs
   * the app here and opens it. While it runs, the status replaces the button
   * and Cancel stops the build. The arrow lists the other profiles, the
   * builds that already fit this device, and the profile editor. On a
   * simulator, a second button builds the device profile and pushes it to a
   * connected phone.
   */
  interface Props {
    serverId: string;
    sessionId: string | null;
    device: DeviceSummary;
    /** The conversation's checkout; builds run there. */
    checkoutPath: string | null;
    onShowLog: (runId: string) => void;
    onEditProfiles: () => void;
  }

  let { serverId, sessionId, device, checkoutPath, onShowLog, onEditProfiles }: Props = $props();
  const session = getWorkspaceContext();

  const savedProfiles = $derived(checkoutPath ? devicesStore.runProfiles(serverId, checkoutPath) : null);
  const profiles = $derived(profilesForDevice(savedProfiles, device));
  const pushTarget = $derived(phoneTarget(devicesStore.state(serverId)?.devices ?? [], savedProfiles, device));
  const phoneRun = $derived(pushTarget ? shownRun(devicesStore.runs(serverId), pushTarget.phone) : null);
  const builds = $derived(buildsForDevice(devicesStore.state(serverId), device));
  const run = $derived(shownRun(devicesStore.runs(serverId), device));
  const isRunning = $derived(!!run && isDeviceRunActive(run));
  let starting = $state(false);
  /** The saved build going onto this device. Opening and installing take a while. */
  let installing = $state<string | null>(null);

  async function buildAndRun(profile: DeviceRunProfile, target: DeviceSummary = device) {
    if (!checkoutPath || starting || installing) return;
    starting = true;
    try {
      const started = await devicesStore.startRun(
        serverId,
        { checkoutPath, profileName: profile.name, deviceHostId: target.deviceHostId, deviceId: target.deviceId, ...(sessionId ? { sessionId } : {}) },
        (question) => confirm(question),
      );
      if (started) onShowLog(started.runId);
    } catch (cause) {
      toasts.error(`Couldn't start ${profile.name}`, { description: deviceErrorMessage(cause) });
    } finally {
      starting = false;
      requestInputFocus();
    }
  }

  async function runBuild(build: DeviceBuild) {
    if (starting || installing) return;
    installing = build.name;
    try {
      await runDeviceBuild(session, serverId, sessionId, build, device);
    } catch (cause) {
      toasts.error(`${build.name} did not run on ${device.name}`, { description: deviceErrorMessage(cause) });
    } finally {
      installing = null;
      requestInputFocus();
    }
  }

  function cancel() {
    if (run) void devicesStore.cancelRun(serverId, run.runId).catch((cause: unknown) => toasts.error("Couldn't cancel the build", { description: deviceErrorMessage(cause) }));
  }
</script>

{#snippet action(label: string, onclick: () => void, Icon: typeof Hammer, options: { pressed?: boolean; disabled?: boolean } = {})}
  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props: trigger })}
        <button {...trigger} type="button"
          class="flex size-8 shrink-0 items-center justify-center rounded-full text-(--solus-text-secondary) transition-colors hover:bg-[var(--wash-2)] hover:text-(--solus-text-primary) disabled:pointer-events-none disabled:opacity-30 {options.pressed
            ? 'bg-[color-mix(in_oklch,var(--primary)_14%,transparent)] text-[var(--primary)] hover:bg-[color-mix(in_oklch,var(--primary)_14%,transparent)] hover:text-[var(--primary)]'
            : ''}"
          aria-label={label} disabled={options.disabled} {onclick}>
          <Icon class="size-4" />
        </button>
      {/snippet}
    </TooltipUI.Trigger>
    <TooltipUI.Content side="left" value={label} />
  </TooltipUI.Root>
{/snippet}

<!-- A column in the device pill: the main action, then the menu of the
     other ways to run an app (or Cancel while a build runs). -->
<div class="flex shrink-0 flex-col items-center" data-testid="device-run-build">
  {#if run && isRunning}
    <span class="sr-only" role="status" aria-live="polite">{runStageLabel(run)}</span>
    {@render action(`${runStageLabel(run)}. Show the build log`, () => onShowLog(run.runId), Hammer, { pressed: true })}
    {@render action("Cancel the build", cancel, X)}
  {:else if installing}
    {@const status = `Installing ${installing} on ${device.name}…`}
    <span class="sr-only" role="status" aria-live="polite">{status}</span>
    {@render action(status, () => {}, Play, { pressed: true, disabled: true })}
  {:else}
    {#if profiles[0]}
      {@const profile = profiles[0]}
      {@render action(starting ? "Starting…" : `Build ${profile.name} in this conversation's checkout, then install and open it on ${device.name}`, () => void buildAndRun(profile), Hammer, { disabled: starting })}
    {:else if builds[0]}
      {@const latest = builds[0]}
      {@render action(`Install ${latest.name} on ${device.name} and open it`, () => void runBuild(latest), Play)}
    {:else}
      {@render action(checkoutPath ? "Set up Build & run: save how this project builds, then build and run it in one click" : "Open a conversation in a project to build it", onEditProfiles, Hammer, { disabled: !checkoutPath })}
    {/if}
    {#if pushTarget}
      {@const { phone, profile } = pushTarget}
      {#if phoneRun && isDeviceRunActive(phoneRun)}
        {@render action(`${runStageLabel(phoneRun)}. Show the build log`, () => onShowLog(phoneRun.runId), Smartphone, { pressed: true })}
      {:else}
        {@render action(phone.unavailableReason ?? `Build ${profile.name}, then install and open it on ${phone.name}`, () => void buildAndRun(profile, phone), Smartphone, { disabled: starting || !!phone.unavailableReason })}
      {/if}
    {/if}
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <button {...props} type="button" class="flex h-4 w-8 shrink-0 items-center justify-center rounded-full text-(--solus-text-tertiary) transition-colors hover:bg-[var(--wash-2)] hover:text-(--solus-text-primary)"
            aria-label="More ways to run an app on {device.name}">
            <ChevronDown class="size-3" />
          </button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content side="left" align="start" class="w-[min(20rem,calc(100vw-2rem))]">
        {#if profiles.length}
          <DropdownMenu.Label>Build & run</DropdownMenu.Label>
          {#each profiles as profile (profile.name)}
            <DropdownMenu.Item disabled={starting} onSelect={() => void buildAndRun(profile)}>
              <Hammer class="size-4" /><span class="min-w-0 flex-1 truncate">{profile.name}</span>
            </DropdownMenu.Item>
          {/each}
        {/if}
        {#if builds.length}
          <DropdownMenu.Label>Run a build</DropdownMenu.Label>
          {#each builds.slice(0, 5) as build (build.buildId)}
            <DropdownMenu.Item onSelect={() => void runBuild(build)}>
              <Play class="size-4" /><span class="min-w-0 flex-1 truncate">{build.name}</span>
            </DropdownMenu.Item>
          {/each}
        {/if}
        <DropdownMenu.Separator />
        {#if run}
          <DropdownMenu.Item onSelect={() => onShowLog(run.runId)}><ScrollText class="size-4" />Show the last build log</DropdownMenu.Item>
        {/if}
        <DropdownMenu.Item disabled={!checkoutPath} onSelect={onEditProfiles}>Edit build profiles…</DropdownMenu.Item>
        <DropdownMenu.Item onSelect={() => deviceViewState.showBuilds(serverId, true)}>All builds</DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {/if}
</div>
