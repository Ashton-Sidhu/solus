<script lang="ts">
  import { ChevronDown, Download, Smartphone } from "@lucide/svelte";
  import type { DeviceBuild, DeviceState, DeviceSummary } from "@solus/contracts/device-types";
  import { buildDownloadName, buildSummary, deviceBuildTargets, lastInstallLabel } from "@solus/client-core/device-builds";
  import { getWorkspaceContext } from "../../contexts";
  import { devicesStore, deviceErrorMessage } from "../../contexts/devices/devices.store.svelte";
  import { toasts } from "../../lib/toasts";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { runDeviceBuild } from "./lib/run-build";

  /**
   * App builds agents handed to Solus (plan 016, S02). Run one on the best
   * device in one click, pick another device, or download an APK in a
   * phone's browser.
   */

  interface Props {
    serverId: string;
    sessionId: string | null;
    deviceState: DeviceState;
    onInstalled: () => void;
  }

  let { serverId, sessionId, deviceState, onInstalled }: Props = $props();
  const session = getWorkspaceContext();

  let installing = $state<string | null>(null);
  const now = Date.now();

  // A phone may have been plugged in since the last discovery.
  $effect(() => {
    void devicesStore.refresh(serverId).catch(() => {});
  });

  async function install(build: DeviceBuild, device: DeviceSummary) {
    installing = build.buildId;
    try {
      const shown = await runDeviceBuild(session, serverId, sessionId, build, device);
      if (shown.physical) toasts.success(`${build.name} is open on ${shown.name}`);
      onInstalled();
    } catch (cause) {
      toasts.error(`${build.name} did not run on ${device.name}`, { description: deviceErrorMessage(cause) });
    } finally {
      installing = null;
    }
  }

  async function download(build: DeviceBuild) {
    try {
      const link = document.createElement("a");
      link.href = await devicesStore.buildDownloadUrl(serverId, build);
      link.download = buildDownloadName(build);
      link.click();
    } catch (cause) {
      toasts.error("Couldn't download the build", { description: deviceErrorMessage(cause) });
    }
  }
</script>

<div class="flex flex-col gap-1 text-chrome-dense" data-testid="device-builds">
  {#each deviceState.builds as build (build.buildId)}
    {@const targets = deviceBuildTargets(deviceState, build, { canBoot: !!sessionId })}
    {@const installed = lastInstallLabel(build, now)}
    <div class="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted">
      <div class="flex min-w-0 flex-1 flex-col">
        <span class="truncate text-workspace-chrome">{build.name}</span>
        <span class="truncate text-muted-foreground">{buildSummary(build, now)}</span>
        {#if installed}<span class="truncate text-muted-foreground">{installed}</span>{/if}
      </div>
      {#if build.assetId}
        <Button size="icon-xs" variant="ghost" aria-label="Download {build.name}" title="Download the APK. Open this in your phone's browser to install it there." onclick={() => void download(build)}>
          <Download />
        </Button>
      {/if}
      {#if targets[0]}
        {@const best = targets[0]}
        <Button size="xs" variant="outline" disabled={installing !== null} onclick={() => void install(build, best)}>
          {installing === build.buildId ? "Running…" : `Run on ${best.name}`}
        </Button>
      {/if}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button {...props} size="icon-xs" variant="ghost" aria-label="Run {build.name} on another device" disabled={installing !== null}>
              <ChevronDown />
            </Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end" class="w-[min(18rem,calc(100vw-2rem))]">
          {#each targets as device (`${device.deviceHostId}:${device.deviceId}`)}
            <DropdownMenu.Item onSelect={() => void install(build, device)}>
              <Smartphone class="size-4" />
              <span class="min-w-0 flex-1 truncate">{device.name}</span>
              <span class="text-muted-foreground">{device.physical ? "connected" : device.booted ? "running" : "starts it"}</span>
            </DropdownMenu.Item>
          {:else}
            <p class="px-2 py-1.5 text-muted-foreground">
              No device can take this build. Connect a phone, or add a {build.platform === "ios" ? "simulator" : "emulator"} on this host.
            </p>
          {/each}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>
  {:else}
    <p class="text-muted-foreground">
      No builds yet. Ask the agent to build the app and put it on your phone or a simulator; its builds appear here.
    </p>
  {/each}
  {#each deviceState.devices.filter((device) => device.physical && device.unavailableReason) as device (`${device.deviceHostId}:${device.deviceId}`)}
    <p class="px-2 text-muted-foreground">{device.unavailableReason}</p>
  {/each}
</div>
