<script lang="ts">
  import { untrack } from "svelte";
  import { RefreshCw, RotateCw, Smartphone, Square } from "@lucide/svelte";
  import AppleLogoIcon from "../ui/AppleLogoIcon.svelte";
  import type { DeviceState, DeviceSummary } from "@solus/contracts/device-types";
  import { devicesStore, deviceErrorMessage } from "../../contexts/devices/devices.store.svelte";
  import { Skeleton } from "../ui/skeleton";
  import * as TooltipUI from "../ui/tooltip";
  import { pickerDevices, unavailablePlatforms } from "./lib/device-pane";

  /**
   * Installed simulators and emulators, grouped by device host. One already
   * open in this session goes to its tab. Device identities come from the
   * host; viewport presets do not apply here.
   */

  interface Props {
    serverId: string;
    deviceState: DeviceState | undefined;
    sessionId: string;
    opening: string | null;
    onOpen: (device: DeviceSummary) => void;
    /** Goes to the tab of a device that is already open in this session. */
    onSelect: (devicePreviewId: string) => void;
    /** Opens Device setup, where a missing platform is fixed. */
    onSetup: () => void;
    /** Set when a device is already open behind this: leaving has to be possible. */
    onCancel?: (() => void) | undefined;
  }

  let { serverId, deviceState, sessionId, opening, onOpen, onSelect, onSetup, onCancel }: Props = $props();

  // The host snapshot lists only devices found so far; a restarted host has
  // found none. Discover before saying there are none.
  let discovering = $state(true);
  let discoveryError = $state<string | null>(null);
  function discover() {
    discovering = true;
    discoveryError = null;
    devicesStore.refresh(serverId)
      .catch((cause: unknown) => { discoveryError = deviceErrorMessage(cause); })
      .finally(() => { discovering = false; });
  }

  $effect(() => {
    void serverId;
    untrack(discover);
  });

  const groups = $derived(pickerDevices(deviceState, sessionId));
  const unavailable = $derived(unavailablePlatforms(deviceState));
  const connected = $derived(deviceState?.devices.filter((device) => device.physical).length ?? 0);
  const running = $derived(devicesStore.runningVirtualDevices(serverId));
  const isStopping = $derived(devicesStore.isStoppingFromList(serverId));
  const stopFailures = $derived(devicesStore.stopFailures.get(serverId));

  function stop(devices: readonly DeviceSummary[], question: string) {
    if (opening !== null || isStopping || discovering || !devices.length || !confirm(question)) return;
    void devicesStore.stopFromList(serverId, devices);
  }
</script>

<div
  class="text-workspace-chrome flex min-h-0 flex-1 flex-col"
  data-testid="device-picker"
  role="presentation"
  onkeydown={(event) => {
    // With a device behind it, Escape goes back to that device. The empty
    // picker lets the press through, where it closes the pane.
    if (event.key !== "Escape" || !onCancel) return;
    event.stopPropagation();
    onCancel();
  }}
>
  <div class="flex min-h-0 flex-1 justify-center overflow-y-auto px-6 py-8">
    <div class="my-auto w-full max-w-md">
      <div class="mb-2 flex flex-wrap items-center gap-1">
        <h2 class="mr-auto text-(--solus-text-primary)">Simulators and emulators</h2>
        {#if running.length || isStopping}
          <button type="button"
            class="rounded-md px-2 py-0.5 text-(--solus-text-tertiary) transition-colors hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) disabled:opacity-50"
            disabled={opening !== null || isStopping || discovering}
            onclick={() => stop(running, "Stop all running simulators and emulators on this host? This also closes their open previews.")}>
            Stop all
          </button>
        {/if}
        {#if onCancel}
          <button type="button" class="rounded-md px-2 py-0.5 text-(--solus-text-tertiary) transition-colors hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)" onclick={onCancel}>
            Cancel
          </button>
        {/if}
        <TooltipUI.Root>
          <TooltipUI.Trigger>
            {#snippet child({ props })}
              <button {...props} type="button"
                class="flex size-6 items-center justify-center rounded-md text-(--solus-text-tertiary) transition-colors hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)"
                aria-label="Scan again" disabled={isStopping} onclick={discover}>
                <RefreshCw class="size-3.5 {discovering ? 'animate-spin' : ''}" />
              </button>
            {/snippet}
          </TooltipUI.Trigger>
          <TooltipUI.Content side="bottom" value="Scan again" />
        </TooltipUI.Root>
      </div>

      {#if isStopping}
        <p class="mb-2 text-(--solus-text-tertiary)" role="status">Stopping devices…</p>
      {/if}
      {#if stopFailures?.length}
        <div class="mb-2 text-[var(--failure)]" role="alert">
          <p>Could not stop these devices.</p>
          <ul class="list-disc pl-5">
            {#each stopFailures as failure}
              <li>{failure}</li>
            {/each}
          </ul>
        </div>
      {/if}

      {#if groups.length}
        <div class="flex flex-col gap-3">
          {#each groups as group (group.deviceHostId)}
            <section class="flex flex-col gap-1" aria-label={group.label}>
              {#if groups.length > 1}<p class="px-1 text-(--solus-text-tertiary)">{group.label}</p>{/if}
              {#each group.devices as entry (entry.device.deviceId)}
                {@const device = entry.device}
                {@const devicePreviewId = entry.devicePreviewId}
                {@const key = `${device.deviceHostId}:${device.deviceId}`}
                <div class="flex min-w-0 items-center rounded-md border border-(--solus-container-border)">
                  <button
                    type="button"
                    class="flex min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-md px-3 py-2 text-left transition-colors hover:bg-(--solus-surface-hover) disabled:hover:bg-transparent"
                    disabled={opening !== null || isStopping}
                    onclick={() => (devicePreviewId ? onSelect(devicePreviewId) : onOpen(device))}
                  >
                    {#if device.platform === "ios"}
                      <AppleLogoIcon size={14} class="shrink-0 text-(--solus-text-tertiary)" />
                    {:else}
                      <Smartphone class="size-3.5 shrink-0 text-(--solus-text-tertiary)" aria-hidden="true" />
                    {/if}
                    <span class="min-w-0 flex-1 truncate text-(--solus-text-primary)">{device.name}</span>
                    {#if opening === key}
                      <RotateCw class="size-3 shrink-0 animate-spin text-(--solus-text-tertiary)" aria-hidden="true" />
                      <span class="shrink-0 text-(--solus-text-tertiary)">Opening…</span>
                    {:else}
                      {#if device.booted}<span class="size-1.5 shrink-0 rounded-full bg-[var(--success)]" title="Running"></span><span class="sr-only">running</span>{/if}
                      {#if devicePreviewId}
                        <span class="shrink-0 text-(--solus-text-tertiary)">Open</span>
                      {:else}
                        <span class="shrink-0 text-(--solus-text-tertiary) tabular-nums">{device.version}</span>
                      {/if}
                    {/if}
                  </button>
                  {#if device.booted}
                    <TooltipUI.Root>
                      <TooltipUI.Trigger>
                        {#snippet child({ props })}
                          <button {...props} type="button"
                            class="mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-(--solus-text-tertiary) transition-colors hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) disabled:opacity-50 pointer-coarse:size-9"
                            aria-label={`Stop ${device.name}`}
                            disabled={opening !== null || isStopping || discovering}
                            onclick={() => stop([device], `Stop ${device.name}? This also closes its open previews.`)}>
                            <Square class="size-3.5" aria-hidden="true" />
                          </button>
                        {/snippet}
                      </TooltipUI.Trigger>
                      <TooltipUI.Content side="bottom" value={`Stop ${device.name}`} />
                    </TooltipUI.Root>
                  {/if}
                </div>
              {/each}
            </section>
          {/each}
        </div>
      {:else if discovering}
        <!-- A scan in flight is not an empty result. -->
        <ul class="flex flex-col gap-3 py-2" aria-label="Looking for simulators and emulators">
          {#each [0, 90, 180] as delay (delay)}
            <li class="flex items-center gap-2" aria-hidden="true">
              <Skeleton class="h-[0.625rem] min-w-0 flex-1 rounded-[0.1875rem]" style="animation-delay:{delay}ms" />
              <Skeleton class="h-[0.625rem] w-10 shrink-0 rounded-[0.1875rem]" style="animation-delay:{delay}ms" />
            </li>
          {/each}
        </ul>
      {:else}
        <p class="text-(--solus-text-tertiary)" role="status">
          {discoveryError ?? "No simulators or emulators found."}
        </p>
      {/if}

      <!-- One quiet line: phones take builds from Builds, and a missing
           platform names its fix in a tooltip and opens Device setup. -->
      {#if connected > 0 || unavailable.length}
        <p class="mt-3 flex flex-wrap items-center gap-x-1.5 text-(--solus-text-tertiary)">
          {#if connected > 0}<span>{connected} connected device{connected === 1 ? "" : "s"}</span>{/if}
          {#each unavailable as entry, index (entry.platform)}
            {#if connected > 0 || index > 0}<span aria-hidden="true">·</span>{/if}
            <TooltipUI.Root>
              <TooltipUI.Trigger>
                {#snippet child({ props })}
                  <button {...props} type="button" class="rounded-sm underline decoration-dotted underline-offset-2 transition-colors hover:text-(--solus-text-primary)"
                    aria-label={`${entry.platform} unavailable: ${entry.reason} Open device setup.`} onclick={onSetup}>
                    {entry.platform} unavailable
                  </button>
                {/snippet}
              </TooltipUI.Trigger>
              <TooltipUI.Content side="bottom" value={entry.reason} />
            </TooltipUI.Root>
          {/each}
        </p>
      {/if}
    </div>
  </div>
</div>
