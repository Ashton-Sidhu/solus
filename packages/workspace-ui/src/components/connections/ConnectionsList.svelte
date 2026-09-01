<script lang="ts">
  /** Connections at rest: this server, the hosts it knows, and who can reach it. */
  import {
    RefreshCw as ArrowsClockwiseIcon,
    Check as CheckIcon,
    Copy as CopyIcon,
    Monitor as MonitorIcon,
    Trash2 as TrashIcon,
  } from "@lucide/svelte";
  import { connectionsStore } from "../../contexts";
  import HostDirectory from "../servers/HostDirectory.svelte";
  import { relativeTime } from "../../lib/relative-time";
  import { Switch } from "../ui/switch";
  import { Button } from "../ui/button";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import PairCodePanel from "./PairCodePanel.svelte";

  interface Props {
    serverId: string;
  }

  let { serverId }: Props = $props();

  const connections = connectionsStore;
  let addressCopied = $state(false);

  const serverDescription = $derived(
    connections.serverInfo
      ? `Running on ${connections.serverInfo.host}:${connections.serverInfo.port} · ${connections.serverInfo.allowLan ? "reachable on your LAN" : "local only"}`
      : "",
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
    if (
      !connections.serverInfo ||
      connections.refreshing ||
      connections.remoteAccessUpdating
    )
      return;
    await connections.setRemoteAccess(serverId, !connections.serverInfo.remoteAccess);
  }

  async function toggleTrustLocalNetwork() {
    if (
      !connections.serverInfo ||
      connections.refreshing ||
      connections.trustLocalNetworkUpdating
    )
      return;
    await connections.setTrustLocalNetwork(serverId,
      !connections.serverInfo.trustLocalNetwork,
    );
  }

  function copyAddress() {
    void navigator.clipboard.writeText(reachableAddress);
    addressCopied = true;
    setTimeout(() => (addressCopied = false), 1500);
  }
</script>

{#if connections.serverInfo}
  <SettingsSection label="Server">
    <SettingsRow label="Status" description={serverDescription}>
      {#snippet labelExtra()}
        <span class="ml-2 inline-block size-2 rounded-full bg-(--solus-status-complete) align-middle"></span>
      {/snippet}
      {#snippet control()}
        <Button
          variant="ghost"
          size="icon-sm"
          onclick={() => void connections.refreshServerMetadata(serverId)}
          class="text-(--solus-text-tertiary)"
          aria-label="Refresh server status"
        >
          <ArrowsClockwiseIcon size={13} class={connections.refreshing ? "animate-spin" : undefined} />
        </Button>
      {/snippet}
    </SettingsRow>

    <SettingsRow
      label="Restart server"
      description="Reload the Solus server without quitting the app."
      comingSoon
    >
      {#snippet control()}
        <Button variant="outline" size="sm">Restart</Button>
      {/snippet}
    </SettingsRow>

    <SettingsRow
      label="Allow remote connections"
      description="Bind to your network interfaces. Remote devices must pair before connecting."
    >
      {#snippet control()}
        <Switch
          checked={connections.serverInfo?.remoteAccess ?? false}
          onclick={toggleRemoteAccess}
          disabled={connections.refreshing || connections.remoteAccessUpdating}
          size="default"
          aria-label="Allow remote connections"
        />
      {/snippet}
    </SettingsRow>

    <SettingsRow
      label="Trust my local network"
      description="Devices on your local network connect without a pairing code. Only enable on a network you control."
      visible={connections.serverInfo?.remoteAccess ?? false}
    >
      {#snippet control()}
        <Switch
          checked={connections.serverInfo?.trustLocalNetwork ?? false}
          onclick={toggleTrustLocalNetwork}
          disabled={connections.refreshing || connections.trustLocalNetworkUpdating}
          size="default"
          aria-label="Trust my local network"
        />
      {/snippet}
    </SettingsRow>

    <SettingsRow
      label="Network address"
      description={reachableAddress}
      visible={(connections.serverInfo?.remoteAccess ?? false) && !!reachableAddress}
    >
      {#snippet control()}
        <div class="flex items-center gap-1.5">
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
          <Button
            variant="outline"
            size="sm"
            onclick={() => void connections.generatePairToken(serverId)}
          >
            Pair a device
          </Button>
        </div>
      {/snippet}
    </SettingsRow>
  </SettingsSection>
{/if}

<!-- Pairing sits against the Server card because that card's "Pair a device"
     button is what fills it in: the code has to appear where the click was,
     not two sections further down the page. -->
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

<SettingsSection label="Connected devices">
  {#if connections.sessions.length === 0}
    <div class="flex flex-col items-center justify-center gap-2 py-8 [.is-laptop-display_&]:py-6">
      <div
        class="flex size-10 items-center justify-center rounded-lg bg-(--solus-surface-hover)"
      >
        <MonitorIcon size={20} class="text-(--solus-text-tertiary)" />
      </div>
      <p class="text-workspace-chrome text-(--solus-text-tertiary)">
        No devices connected
      </p>
      <p class="text-[0.875em] text-(--solus-text-tertiary) opacity-70">
        Pair a device to get started
      </p>
    </div>
  {:else}
    {#each connections.sessions as session (session.id)}
      <div
        class="group flex items-center gap-3 border-t border-border px-4 py-2.5 first:border-t-0 [.is-laptop-display_&]:gap-2.5 [.is-laptop-display_&]:px-3.5 [.is-laptop-display_&]:py-2"
      >
        <div
          class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-(--solus-surface-hover) [.is-laptop-display_&]:size-7 [.is-laptop-display_&]:rounded-md"
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
            size="icon-sm"
            onclick={() => void connections.revokeDevice(serverId, session.deviceId!)}
            class="text-(--solus-text-tertiary) opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 hover:bg-(--solus-status-error)/10 hover:text-(--solus-status-error)"
            aria-label="Revoke device"
          >
            <TrashIcon size={13} />
          </Button>
        {/if}
      </div>
    {/each}
  {/if}
</SettingsSection>

<HostDirectory />
