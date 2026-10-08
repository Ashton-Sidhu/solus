<script lang="ts">
  /** How this host is reached, and who reaches it: its Solus Cloud link, the
   *  organizations it stands in, its network, pairing, the devices with
   *  access, and the hosts it paired with. `connectionsStore` is read for this host by the Hosts page. Only a
   *  local owner (the desktop on the machine or a paired device) may change how
   *  the host is reached; anyone else sees the state and where to change it. */
  import {
    Check as CheckIcon,
    Copy as CopyIcon,
    Monitor as MonitorIcon,
    Trash2 as TrashIcon,
  } from "@lucide/svelte";
  import { connectionsStore } from "../../contexts";
  import { Button } from "../ui/button";
  import { Switch } from "../ui/switch";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import { relativeTime } from "../../lib/relative-time";
  import PairCodePanel from "./PairCodePanel.svelte";
  import UplinkSection from "./UplinkSection.svelte";
  import OrganizationsSection from "./OrganizationsSection.svelte";
  import PairedHostsSection from "./PairedHostsSection.svelte";

  interface Props {
    serverId: string;
  }

  let { serverId }: Props = $props();

  const connections = connectionsStore;
  let addressCopied = $state(false);

  const info = $derived(connections.serverInfo);
  // Pairing does not exist on a managed host or the workspace service: Solus cloud owns how they are reached.
  const hasPairing = $derived(info?.hostKind === "personal");
  const canChangeNetwork = $derived(info?.principal === "local-owner");
  const networkDescription = $derived(
    info
      ? `Listening on ${info.host}:${info.port} · ${info.allowLan ? "reachable on your network" : "this computer only"}${canChangeNetwork ? "" : ". Change these from the host itself or from a paired device."}`
      : "Reading this host…",
  );

  // The address worth handing to another device is the one that isn't loopback:
  // copying 127.0.0.1 to a phone pairs it with the phone.
  const reachableAddress = $derived.by(() => {
    const endpoint =
      connections.endpoints.find((candidate) => candidate.kind !== "loopback") ??
      connections.endpoints[0];
    return endpoint ? `http://${endpoint.host}:${endpoint.port}` : "";
  });

  async function toggleRemoteAccess() {
    if (!info || connections.refreshing || connections.remoteAccessUpdating) return;
    await connections.setRemoteAccess(serverId, !info.remoteAccess);
  }

  async function toggleTrustLocalNetwork() {
    if (!info || connections.refreshing || connections.trustLocalNetworkUpdating) return;
    await connections.setTrustLocalNetwork(serverId, !info.trustLocalNetwork);
  }

  function copyAddress() {
    void navigator.clipboard.writeText(reachableAddress);
    addressCopied = true;
    setTimeout(() => (addressCopied = false), 1500);
  }
</script>

<UplinkSection {serverId} />

<!-- Where this host stands in each organization, and its Insights choice
     (organization-scope §6.1). Keyed so another host is read afresh. -->
{#key serverId}
  <OrganizationsSection {serverId} />
{/key}

{#if hasPairing}
  <SettingsSection label="Network" description={networkDescription}>
    <SettingsRow
      label="Allow remote connections"
      description="Bind to your network interfaces. Remote devices must pair before connecting."
    >
      {#snippet control()}
        <Switch
          checked={info?.remoteAccess ?? false}
          onclick={toggleRemoteAccess}
          disabled={!canChangeNetwork || connections.refreshing || connections.remoteAccessUpdating}
          size="default"
          aria-label="Allow remote connections"
        />
      {/snippet}
    </SettingsRow>

    <SettingsRow
      label="Trust my local network"
      description="Devices on your local network connect without a pairing code. Only enable on a network you control."
      visible={info?.remoteAccess ?? false}
    >
      {#snippet control()}
        <Switch
          checked={info?.trustLocalNetwork ?? false}
          onclick={toggleTrustLocalNetwork}
          disabled={!canChangeNetwork || connections.refreshing || connections.trustLocalNetworkUpdating}
          size="default"
          aria-label="Trust my local network"
        />
      {/snippet}
    </SettingsRow>

    <SettingsRow
      label="Network address"
      description={reachableAddress}
      visible={(info?.remoteAccess ?? false) && !!reachableAddress}
    >
      {#snippet control()}
        <Button
          variant="ghost"
          size="icon-sm"
          onclick={copyAddress}
          class="text-(--solus-text-tertiary)"
          aria-label="Copy network address"
        >
          {#if addressCopied}
            <CheckIcon size={13} class="text-(--solus-status-complete)" />
          {:else}
            <CopyIcon size={13} />
          {/if}
        </Button>
      {/snippet}
    </SettingsRow>
  </SettingsSection>

  {#if canChangeNetwork}
    <SettingsSection label="Pairing">
      <PairCodePanel {serverId} />
      <SettingsRow
        label="Approve new devices"
        description="Ask before a paired device is allowed to connect."
        comingSoon
      >
        {#snippet control()}
          <Switch checked={false} size="default" aria-label="Approve new devices" />
        {/snippet}
      </SettingsRow>
    </SettingsSection>
  {/if}
{/if}

<SettingsSection label="Devices with access">
  {#if connections.sessions.length === 0}
    <p class="px-4 py-6 text-center text-[0.875em] text-(--solus-text-tertiary)">
      No devices are connected to this host.
    </p>
  {:else}
    {#each connections.sessions as session (session.id)}
      <div
        class="group flex items-center gap-3 px-4 py-2.5"
      >
        <div
          class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-(--solus-surface-hover)"
        >
          <MonitorIcon size={14} class="text-(--solus-text-tertiary)" />
        </div>
        <div class="min-w-0 flex-1">
          <p class="truncate text-workspace-chrome font-medium text-(--solus-text-primary)">
            {session.deviceLabel}
          </p>
          <p class="text-[0.875em] text-(--solus-text-tertiary)">
            {relativeTime(session.connectedAt)}
            {#if session.connectionCount > 1}
              &middot; {session.connectionCount} connections
            {/if}
          </p>
        </div>
        {#if session.deviceId}
          <Button
            variant="ghost"
            size="sm"
            onclick={() => void connections.revokeDevice(serverId, session.deviceId!)}
            class="text-(--solus-text-tertiary) opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 hover:text-(--solus-status-error)"
          >
            <TrashIcon size={13} />
            Revoke
          </Button>
        {/if}
      </div>
    {/each}
  {/if}
</SettingsSection>

<PairedHostsSection {serverId} />
