<script lang="ts">
  import { untrack } from "svelte";
  import { Apple, RefreshCw, RotateCw, Smartphone } from "@lucide/svelte";
  import type { DeviceState, DeviceSummary } from "@solus/contracts/device-types";
  import { devicesStore, deviceErrorMessage } from "../../contexts/devices/devices.store.svelte";
  import { Skeleton } from "../ui/skeleton";
  import * as TooltipUI from "../ui/tooltip";
  import { addableDevices, unavailablePlatformReasons } from "./lib/device-pane";

  /**
   * Installed devices that can be added to this session, grouped by device
   * host. Device identities come from the host; viewport presets do not
   * apply here.
   */

  interface Props {
    serverId: string;
    deviceState: DeviceState | undefined;
    sessionId: string;
    opening: string | null;
    onOpen: (device: DeviceSummary) => void;
    /** Set when a device is already open behind this: leaving has to be possible. */
    onCancel?: (() => void) | undefined;
  }

  let { serverId, deviceState, sessionId, opening, onOpen, onCancel }: Props = $props();

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

  const groups = $derived(addableDevices(deviceState, sessionId));
  const reasons = $derived(unavailablePlatformReasons(deviceState));
  const connected = $derived(deviceState?.devices.filter((device) => device.physical).length ?? 0);
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
      <div class="mb-2 flex items-center justify-between">
        <h2 class="text-(--solus-text-primary)">Simulators and emulators</h2>
        {#if onCancel}
          <button type="button" class="mr-1 ml-auto rounded-md px-2 py-0.5 text-(--solus-text-tertiary) transition-colors hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)" onclick={onCancel}>
            Cancel
          </button>
        {/if}
        <TooltipUI.Root>
          <TooltipUI.Trigger>
            {#snippet child({ props })}
              <button {...props} type="button"
                class="flex size-6 items-center justify-center rounded-md text-(--solus-text-tertiary) transition-colors hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)"
                aria-label="Scan again" onclick={discover}>
                <RefreshCw class="size-3.5 {discovering ? 'animate-spin' : ''}" />
              </button>
            {/snippet}
          </TooltipUI.Trigger>
          <TooltipUI.Content side="bottom" value="Scan again" />
        </TooltipUI.Root>
      </div>

      {#if groups.length}
        <div class="flex flex-col gap-3">
          {#each groups as group (group.deviceHostId)}
            <section class="flex flex-col gap-1" aria-label={group.label}>
              {#if groups.length > 1}<p class="px-1 text-(--solus-text-tertiary)">{group.label}</p>{/if}
              {#each group.devices as device (device.deviceId)}
                {@const key = `${device.deviceHostId}:${device.deviceId}`}
                <button
                  type="button"
                  class="flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-md border border-(--solus-container-border) px-3 py-2 text-left transition-colors hover:bg-(--solus-surface-hover) disabled:hover:bg-transparent"
                  disabled={opening !== null}
                  onclick={() => onOpen(device)}
                >
                  {#if device.platform === "ios"}
                    <Apple class="size-3.5 shrink-0 text-(--solus-text-tertiary)" aria-hidden="true" />
                  {:else}
                    <Smartphone class="size-3.5 shrink-0 text-(--solus-text-tertiary)" aria-hidden="true" />
                  {/if}
                  <span class="min-w-0 flex-1 truncate text-(--solus-text-primary)">{device.name}</span>
                  {#if opening === key}
                    <RotateCw class="size-3 shrink-0 animate-spin text-(--solus-text-tertiary)" aria-hidden="true" />
                    <span class="shrink-0 text-(--solus-text-tertiary)">Opening…</span>
                  {:else}
                    {#if device.booted}<span class="size-1.5 shrink-0 rounded-full bg-[var(--success)]" title="Running"></span><span class="sr-only">running</span>{/if}
                    <span class="shrink-0 text-(--solus-text-tertiary) tabular-nums">{device.version}</span>
                  {/if}
                </button>
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
          {#if discoveryError}
            {discoveryError}
          {:else if deviceState?.devices.some((device) => !device.physical)}
            Every device is already open in this session.
          {:else}
            No simulators or emulators were found.
          {/if}
        </p>
      {/if}

      {#if connected > 0}
        <p class="mt-3 text-(--solus-text-tertiary)">{connected} connected device{connected === 1 ? "" : "s"}. Install builds on {connected === 1 ? "it" : "them"} from Builds.</p>
      {/if}
      {#each reasons as reason (reason)}
        <p class="mt-1 text-(--solus-text-tertiary)">{reason}</p>
      {/each}
    </div>
  </div>
</div>
