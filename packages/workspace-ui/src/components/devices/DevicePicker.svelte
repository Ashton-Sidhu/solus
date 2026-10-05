<script lang="ts">
  import { Apple, Smartphone } from "@lucide/svelte";
  import type { DeviceState, DeviceSummary } from "@solus/contracts/device-types";
  import { devicesStore, deviceErrorMessage } from "../../contexts/devices/devices.store.svelte";
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
  }

  let { serverId, deviceState, sessionId, opening, onOpen }: Props = $props();

  // The host snapshot lists only devices found so far; a restarted host has
  // found none. Discover before saying there are none.
  let discovering = $state(true);
  let discoveryError = $state<string | null>(null);
  $effect(() => {
    discovering = true;
    discoveryError = null;
    devicesStore.refresh(serverId)
      .catch((cause: unknown) => { discoveryError = deviceErrorMessage(cause); })
      .finally(() => { discovering = false; });
  });

  const groups = $derived(addableDevices(deviceState, sessionId));
  const reasons = $derived(unavailablePlatformReasons(deviceState));
  const connected = $derived(deviceState?.devices.filter((device) => device.physical).length ?? 0);
</script>

<div class="flex flex-col gap-3 text-chrome-dense" data-testid="device-picker">
  {#each groups as group (group.deviceHostId)}
    <section class="flex flex-col gap-1" aria-label={group.label}>
      <p class="text-muted-foreground">{group.label}</p>
      {#each group.devices as device (device.deviceId)}
        {@const key = `${device.deviceHostId}:${device.deviceId}`}
        <button
          type="button"
          class="flex min-w-0 items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-none disabled:opacity-50"
          disabled={opening !== null}
          onclick={() => onOpen(device)}
        >
          {#if device.platform === "ios"}<Apple class="size-4 shrink-0" />{:else}<Smartphone class="size-4 shrink-0" />{/if}
          <span class="min-w-0 flex-1 truncate">{device.name}</span>
          <span class="shrink-0 text-muted-foreground">{opening === key ? "Opening…" : `${device.version}${device.booted ? " · running" : ""}`}</span>
        </button>
      {/each}
    </section>
  {:else}
    <p class="text-muted-foreground" role="status">
      {#if discovering}
        Looking for simulators and emulators…
      {:else if discoveryError}
        {discoveryError}
      {:else if deviceState?.devices.some((device) => !device.physical)}
        Every device is already open in this session.
      {:else}
        No simulators or emulators were found.
      {/if}
    </p>
  {/each}
  {#if connected > 0}
    <p class="text-muted-foreground">{connected} connected device{connected === 1 ? "" : "s"}. Install builds on {connected === 1 ? "it" : "them"} from Builds.</p>
  {/if}
  {#each reasons as reason (reason)}
    <p class="text-muted-foreground">{reason}</p>
  {/each}
</div>
