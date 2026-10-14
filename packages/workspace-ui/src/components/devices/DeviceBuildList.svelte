<script lang="ts">
  import { Check, ChevronRight, CircleAlert, Download, Ellipsis, LoaderCircle, Smartphone, Trash2 } from "@lucide/svelte";
  import type { DeviceBuild, DeviceState, DeviceSummary } from "@solus/contracts/device-types";
  import { buildRunsOn } from "@solus/client-core/device-builds";
  import { getWorkspaceContext } from "../../contexts";
  import { devicesStore, deviceErrorMessage } from "../../contexts/devices/devices.store.svelte";
  import { relativeTime } from "../../lib/relative-time";
  import { toasts } from "../../lib/toasts";
  import AppleLogoIcon from "../ui/AppleLogoIcon.svelte";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { RowCard } from "../ui/row-card";
  import { Toggle } from "../ui/toggle";
  import { buildSize, buildSourceLabel, buildTargetLabel, installSummary } from "./lib/build-list";
  import { runDeviceBuild } from "./lib/run-build";
  import type { RunApp } from "./lib/run-app.svelte";

  /**
   * Every app build on the host, newest first, whoever made it. Open one to
   * pick the devices it can go on and install it on all of them at once; each
   * device shows how its install went, and a toast sums it up. A build's menu
   * downloads an APK or deletes the build.
   */
  interface Props { serverId: string; sessionId: string | null; deviceState: DeviceState; runApp: RunApp; onInstalled: () => void }
  let { serverId, sessionId, deviceState, runApp, onInstalled }: Props = $props();
  const workspace = getWorkspaceContext();
  const listId = $props.id();
  const localDevices = $derived(deviceState.devices.filter((device) => device.deviceHostId === 'local'));
  let pairing = $state<string | null>(null);

  function targetsFor(build: DeviceBuild): DeviceSummary[] {
    return localDevices.filter((device) => buildRunsOn(build, device));
  }

  function isInstalling(build: DeviceBuild): boolean {
    return targetsFor(build).some((device) => runApp.installStatus(build.buildId, device.deviceId)?.state === 'installing');
  }

  function toggleDevice(deviceId: string, pressed: boolean) {
    if (pressed) runApp.installDeviceIds.add(deviceId);
    else runApp.installDeviceIds.delete(deviceId);
  }

  async function install(build: DeviceBuild) {
    const devices = targetsFor(build).filter((device) => runApp.installDeviceIds.has(device.deviceId) && !device.unavailableReason);
    if (!devices.length || isInstalling(build)) return;
    const results = await runApp.install(build, devices, async (device) => { await runDeviceBuild(workspace, serverId, sessionId, build, device); }, deviceErrorMessage);
    toasts.show(installSummary(build, results));
    if (results.some((result) => result.error === null)) onInstalled();
  }

  async function pair(device: DeviceSummary) {
    pairing = device.deviceId;
    try { await devicesStore.pair(serverId, device); }
    catch (cause) { toasts.error(`Could not pair ${device.name}`, { description: deviceErrorMessage(cause) }); }
    finally { pairing = null; }
  }

  async function download(build: DeviceBuild) {
    try {
      const link = document.createElement("a");
      link.href = await devicesStore.buildDownloadUrl(serverId, build);
      link.download = build.name;
      link.click();
    } catch (cause) { toasts.error("Could not download the APK", { description: deviceErrorMessage(cause) }); }
  }

  async function remove(build: DeviceBuild) {
    if (!confirm(`Delete ${build.name} (${buildTargetLabel(build)}, ${relativeTime(build.createdAt)})? Apps already installed stay on their devices.`)) return;
    try {
      await devicesStore.removeBuild(serverId, build.buildId);
      if (runApp.openBuildId === build.buildId) runApp.toggleBuild(build.buildId);
      toasts.success(`Deleted ${build.name}`);
    } catch (cause) { toasts.error(`Could not delete ${build.name}`, { description: deviceErrorMessage(cause) }); }
  }
</script>

<section class="flex flex-col gap-3" aria-labelledby="{listId}-title">
  <div class="flex min-h-7 items-center justify-between gap-4">
    <h3 id="{listId}-title" class="text-sm font-medium text-foreground">Builds</h3>
    {#if deviceState.builds.length}<span class="text-chrome-dense tabular-nums text-(--solus-text-tertiary)">{deviceState.builds.length}</span>{/if}
  </div>
  {#if !deviceState.builds.length}
    <RowCard>
      <p class="px-4 py-6 text-center text-[13px] text-(--solus-text-secondary)">No builds yet. Build one above, or ask an agent to build the app.</p>
    </RowCard>
  {:else}
    <RowCard>
      {#each deviceState.builds as build (build.buildId)}
        {@const open = runApp.openBuildId === build.buildId}
        {@const targets = open ? targetsFor(build) : []}
        {@const installing = open && isInstalling(build)}
        {@const chosen = targets.filter((device) => runApp.installDeviceIds.has(device.deviceId) && !device.unavailableReason).length}
        <div>
          <div class="flex min-w-0 items-center gap-1 pr-2">
            <button type="button" class="flex min-w-0 flex-1 items-center gap-3 overflow-hidden rounded-lg py-3 pl-4 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--ring)] pointer-coarse:py-3.5"
              aria-expanded={open} aria-controls="{listId}-{build.buildId}" onclick={() => runApp.toggleBuild(build.buildId)}>
              <ChevronRight class="size-3.5 shrink-0 text-(--solus-text-tertiary) transition-transform motion-reduce:transition-none {open ? 'rotate-90' : ''}" />
              <span class="flex size-4 shrink-0 items-center justify-center text-(--solus-text-secondary)">
                {#if build.platform === 'ios'}<AppleLogoIcon size={14} />{:else}<Smartphone class="size-4" />{/if}
              </span>
              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="truncate text-[13px] font-medium text-foreground pointer-coarse:text-sm">{build.name} <span class="font-normal text-(--solus-text-secondary)">· {buildTargetLabel(build)}</span></span>
                <span class="text-chrome-dense truncate text-(--solus-text-tertiary)">{buildSourceLabel(build, deviceState.runs)} · {relativeTime(build.createdAt)} · {buildSize(build.sizeBytes)}</span>
              </span>
            </button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger>
                {#snippet child({ props })}
                  <Button {...props} size="icon-sm" variant="ghost" class="shrink-0 text-(--solus-text-tertiary)" aria-label="Actions for {build.name}"><Ellipsis /></Button>
                {/snippet}
              </DropdownMenu.Trigger>
              <DropdownMenu.Content align="end">
                {#if build.assetId}<DropdownMenu.Item onSelect={() => void download(build)}><Download />Download APK</DropdownMenu.Item>{/if}
                <DropdownMenu.Item variant="destructive" onSelect={() => void remove(build)}><Trash2 />Delete build</DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Root>
          </div>
          {#if open}
            <div id="{listId}-{build.buildId}" class="flex flex-col gap-3 pr-4 pb-4 pl-[4.375rem]">
              {#if targets.length}
                <div role="group" aria-label="Install on" class="flex min-w-0 gap-1.5 overflow-x-auto [scrollbar-width:none]">
                  {#each targets as device (device.deviceId)}
                    {@const status = runApp.installStatus(build.buildId, device.deviceId)}
                    <Toggle size="sm" variant="outline" class="min-w-24 max-w-48 shrink overflow-hidden font-normal data-[state=on]:border-[var(--primary)] data-[state=on]:bg-[color-mix(in_oklch,var(--primary)_10%,transparent)] data-[state=on]:text-foreground"
                      pressed={runApp.installDeviceIds.has(device.deviceId)} onPressedChange={(pressed) => toggleDevice(device.deviceId, pressed)}
                      disabled={installing || !!device.unavailableReason} title={device.unavailableReason ?? `${device.name} · ${device.version}`}>
                      {#if status?.state === 'installing'}<LoaderCircle class="animate-spin motion-reduce:animate-none" />
                      {:else if status?.state === 'installed'}<Check class="text-[var(--success)]" />
                      {:else if status?.state === 'failed'}<CircleAlert class="text-destructive" />
                      {:else if runApp.installDeviceIds.has(device.deviceId)}<Check />{/if}
                      <span class="truncate">{device.name}</span>
                    </Toggle>
                  {/each}
                </div>
                {#each targets as device (device.deviceId)}
                  {@const status = runApp.installStatus(build.buildId, device.deviceId)}
                  {#if status?.state === 'failed'}
                    <p role="alert" class="text-chrome-dense -mt-1 truncate text-destructive" title="{device.name}: {status.error}">{device.name}: {status.error}</p>
                  {:else if device.unavailableReason}
                    <div class="text-chrome-dense -mt-1 flex min-w-0 items-center gap-2 text-(--solus-text-secondary)">
                      <span class="min-w-0 truncate" title={device.unavailableReason}>{device.name}: {pairing === device.deviceId ? `Unlock ${device.name} and tap Trust.` : device.unavailableReason}</span>
                      {#if device.needsPairing}<Button size="xs" variant="outline" class="shrink-0" disabled={pairing !== null} onclick={() => void pair(device)}>{pairing === device.deviceId ? 'Waiting…' : 'Pair'}</Button>{/if}
                    </div>
                  {/if}
                {/each}
                <div class="flex min-w-0 items-center gap-3">
                  <Button size="sm" class="shrink-0" disabled={!chosen || installing} onclick={() => void install(build)}>
                    {#if installing}<LoaderCircle class="animate-spin motion-reduce:animate-none" />{/if}
                    {installing ? 'Installing…' : chosen > 1 ? `Install on ${chosen} devices` : 'Install'}
                  </Button>
                  {#if !chosen && !installing}<span class="text-chrome-dense truncate text-(--solus-text-tertiary)">Choose one or more devices.</span>{/if}
                </div>
              {:else}
                <p class="text-chrome-dense text-(--solus-text-secondary)">No {buildTargetLabel(build)} devices on this host. Start a simulator or connect a phone.</p>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </RowCard>
  {/if}
</section>
