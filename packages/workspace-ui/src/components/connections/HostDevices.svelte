<script lang="ts">
  import { untrack } from "svelte";
  import { getWorkspaceContext } from "../../contexts";
  import { devicesStore } from "../../contexts/devices/devices.store.svelte";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import { settingsHost } from "../settings/lib/settings-host.svelte";
  import { connectionsNav } from "./connections-nav.svelte";
  import { Button } from "../ui/button";

  /**
   * Devices on this host (Connections → host → Environment → Devices): the
   * current state, and the way to Settings → Devices on this host, which
   * owns the device settings.
   */

  let { serverId }: { serverId: string } = $props();

  const session = getWorkspaceContext();

  $effect(() => {
    const hostId = serverId;
    untrack(() => void devicesStore.load(hostId));
  });

  const deviceState = $derived(devicesStore.state(serverId));
  const unavailable = $derived(devicesStore.unavailable.get(serverId));

  function openDeviceSettings() {
    settingsHost.serverId = serverId;
    session.selectSettingsTab("devices");
    connectionsNav.back();
  }
</script>

<SettingsRow
  label="Devices"
  description={unavailable ?? (deviceState
    ? (deviceState.settings.enabled
      ? `Device previews are on. Agent access is ${deviceState.settings.agentAccessEnabled ? "on" : "off"}.`
      : "Device previews are off.")
    : "Checking devices…")}
  testId="host-devices"
>
  {#snippet control()}
    {#if deviceState}
      <Button variant="outline" size="sm" onclick={openDeviceSettings}>Device settings</Button>
    {/if}
  {/snippet}
</SettingsRow>
