<script lang="ts">
  /** How this host is reached, and who reaches it: its Solus Cloud link, the
   *  organizations it stands in, its network, one card for every way a device
   *  or machine comes to it (pair code, approval requests, SSH forwards), and
   *  the devices with access. Machine links are on the host map (FleetView). `connectionsStore` is read for this host by the Hosts page. Only a
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
  import { Input } from "../ui/input";
  import { Switch } from "../ui/switch";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import SettingsSelect from "../settings/SettingsSelect.svelte";
  import ShowMoreRow from "../settings/ShowMoreRow.svelte";
  import { pageOf } from "../settings/lib/list-page";
  import { relativeTime } from "../../lib/relative-time";
  import PairCodePanel from "./PairCodePanel.svelte";
  import UplinkSection from "./UplinkSection.svelte";
  import OrganizationsSection from "./OrganizationsSection.svelte";
  import ForwardedHostRows from "./ForwardedHostRows.svelte";
  import PairApprovalRows from "./PairApprovalRows.svelte";
  import { forwardedHostsStore } from "./forwarded-hosts.store.svelte";
  import { hosts } from "../../contexts/hosts/hosts.svelte";
  import ManagedSettingNote from "../settings/policy/ManagedSettingNote.svelte";
  import { hostLock, pairingLock } from "../settings/policy/managed-setting.svelte";
  import type { RemoteAccessMode } from "@solus/contracts/host-api";
  import { tailscaleServePreview, tailscaleServeStateText } from './lib/tailscale-serve';
  import { pairedDeviceDetail } from './lib/paired-devices';

  interface Props {
    serverId: string;
  }

  let { serverId }: Props = $props();

  const connections = connectionsStore;
  // Machine-wide keys a policy locks on this host (plans/030 §6.7).
  const remoteAccessLock = $derived(hostLock(serverId, "remoteAccess"));
  const trustLocalNetworkLock = $derived(hostLock(serverId, "trustLocalNetwork"));
  const pairingLocked = $derived(pairingLock(serverId));
  let addressCopied = $state(false);
  let servePort = $state(443);
  let connectedExpanded = $state(false);
  let pairedExpanded = $state(false);

  const info = $derived(connections.serverInfo);
  $effect(() => { if (info?.tailscaleServe) servePort = info.tailscaleServe.port; });
  const servePreview = $derived(tailscaleServePreview(info?.tailscaleServe?.url ?? null, servePort));
  // Pairing does not exist on a managed host or the workspace service: Solus cloud owns how they are reached.
  const hasPairing = $derived(info?.hostKind === "personal");
  const canChangeNetwork = $derived(info?.principal === "local-owner");
  // Only the host's owner may read and revoke its pairings (plans/033 §4.4).
  const showsPairedDevices = $derived(hasPairing && (info?.principal === "local-owner" || info?.principal === "remote-owner"));
  // Only a principal with host.local.reach may list and decide approval requests.
  const showsApprovals = $derived(hasPairing && info?.principal !== undefined && !!hosts.get(serverId)?.me.may("host.local.reach"));
  const connectedDeviceIds = $derived(new Set(connections.sessions.map((session) => session.deviceId)));
  const connectedPage = $derived(pageOf(connections.sessions, connectedExpanded));
  const pairedPage = $derived(pageOf(connections.pairedDevices, pairedExpanded));
  // Watched here, not in its rows: the pairing card shows once the forwards are read.
  $effect(() => forwardedHostsStore.watch(serverId));
  const forwarded = $derived(forwardedHostsStore.hostsFor(serverId));
  const showsPairCode = $derived(hasPairing && canChangeNetwork);
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

  const REMOTE_ACCESS_OPTIONS: ReadonlyArray<{ value: RemoteAccessMode; label: string }> = [
    { value: "off", label: "Off" },
    { value: "private", label: "Private networks only" },
    { value: "any", label: "Anyone who can reach this host" },
  ];

  async function changeRemoteAccess(remoteAccess: RemoteAccessMode) {
    if (!info || connections.refreshing || connections.remoteAccessUpdating) return;
    await connections.setRemoteAccess(serverId, remoteAccess);
  }

  async function toggleTrustLocalNetwork() {
    if (!info || connections.refreshing || connections.trustLocalNetworkUpdating) return;
    await connections.setTrustLocalNetwork(serverId, !info.trustLocalNetwork);
  }

  async function toggleTailscaleServe() {
    if (!info?.tailscaleServe) return;
    const enabled = !info.tailscaleServe.enabled;
    if (!enabled && !window.confirm('Turn off Tailscale HTTPS for this host?')) return;
    await connections.setTailscaleServe(serverId, enabled, servePort);
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
      label="Remote access"
      description="Choose which devices can reach this host. Remote devices must pair before connecting."
      managed={remoteAccessLock}
    >
      {#snippet control()}
        <SettingsSelect
          options={REMOTE_ACCESS_OPTIONS}
          value={info?.remoteAccess ?? 'any'}
          onSelect={changeRemoteAccess}
          disabled={!canChangeNetwork || connections.refreshing || connections.remoteAccessUpdating}
          ariaLabel="Remote access"
        />
      {/snippet}
    </SettingsRow>
    {#if connections.remoteAccessError}
      <p role="alert" class="text-workspace-chrome text-(--solus-status-error)">{connections.remoteAccessError}</p>
    {/if}
    {#if info?.remoteAccess === 'private'}
      <p class="text-workspace-chrome text-(--solus-text-secondary)">Only devices on your local network or tailnet can connect.</p>
    {/if}
    {#if info?.cloudWithoutTailnet}
      <p class="text-workspace-chrome text-(--solus-text-secondary)">This host is on a cloud network. Install Tailscale on it, or use the Solus tunnel, to reach it from other devices.</p>
    {/if}

    <SettingsRow label="Tailscale HTTPS" description="Use a secure tailnet address for this host." managed={info?.remoteAccess === 'off' ? remoteAccessLock : undefined}>
      {#snippet control()}
        <Switch checked={info?.tailscaleServe?.enabled ?? false} onclick={toggleTailscaleServe}
          disabled={!canChangeNetwork || info?.remoteAccess === 'off' || connections.refreshing || connections.tailscaleServeUpdating}
          size="default" aria-label="Tailscale HTTPS" />
      {/snippet}
      {#snippet body()}
        <div class="flex flex-col gap-2">
          <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
            <label for="tailscale-port-{serverId}" class="text-chrome-dense text-(--solus-text-secondary)">HTTPS port</label>
            <Input id="tailscale-port-{serverId}" type="number" min="1" max="65535" bind:value={servePort}
              disabled={!canChangeNetwork || connections.tailscaleServeUpdating || info?.tailscaleServe?.enabled}
              dictation={false}
              class="h-8 w-24 text-workspace-chrome tabular-nums" />
            {#if servePreview}
              <code class="min-w-0 truncate font-mono text-chrome-dense text-(--solus-text-tertiary)">{servePreview}</code>
            {/if}
          </div>
          {#if info?.tailscaleServe?.enabled}
            <p class="text-chrome-dense text-(--solus-text-secondary)">Tailscale HTTPS: {tailscaleServeStateText(info.tailscaleServe.state)}.</p>
          {/if}
          {#if info?.tailscaleServe?.error || connections.tailscaleServeError}
            <p role="alert" class="text-chrome-dense text-(--solus-status-error)">{connections.tailscaleServeError ?? info?.tailscaleServe?.error}</p>
          {/if}
        </div>
      {/snippet}
    </SettingsRow>

    <SettingsRow
      label="Trust my local network"
      description="Devices on your local network connect without a pairing code. Only enable on a network you control."
      visible={info?.remoteAccess !== 'off'}
      managed={trustLocalNetworkLock}
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
      visible={info?.remoteAccess !== 'off' && !!reachableAddress}
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
{/if}

<!-- Every way a device or machine comes to this host, in one card. After the
     network setting on purpose: a forward needs no open port (D4, D7). -->
<SettingsSection
  label="Pair and link"
  description="Pair a device with a code, approve a machine that asks, or reach one over SSH. Link the machines you own from the host map."
  visible={showsPairCode || showsApprovals || !!forwarded}
>
  <!-- Keyed so another host's lists are read afresh. -->
  {#key serverId}
    {#if showsPairCode}
      {#if pairingLocked}
        <div class="px-4 py-3.5"><ManagedSettingNote note={pairingLocked} /></div>
      {:else}
        <PairCodePanel {serverId} />
      {/if}
      <SettingsRow
        label="Approve new devices"
        description="Ask before a paired device is allowed to connect."
        comingSoon
      >
        {#snippet control()}
          <Switch checked={false} size="default" aria-label="Approve new devices" />
        {/snippet}
      </SettingsRow>
    {/if}
    {#if showsApprovals}
      <PairApprovalRows {serverId} />
    {/if}
    <ForwardedHostRows {serverId} />
  {/key}
</SettingsSection>

<SettingsSection label="Devices with access">
  {#if connections.sessions.length === 0}
    <p class="px-4 py-6 text-center text-[0.875em] text-(--solus-text-tertiary)">
      No devices are connected to this host.
    </p>
  {:else}
    {#each connectedPage.rows as session (session.id)}
      <div
        class="group flex items-center gap-3 px-4 py-2.5"
      >
        <MonitorIcon size={16} class="shrink-0 text-foreground" />
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
    <ShowMoreRow hiddenCount={connectedPage.hiddenCount} expanded={connectedExpanded} noun="devices" onToggle={() => (connectedExpanded = !connectedExpanded)} />
  {/if}
</SettingsSection>

{#if showsPairedDevices}
  <SettingsSection label="Paired devices" description="Every device that paired with this host, connected or not. Revoke one to end its access.">
    {#if connections.pairedDevicesError}
      <p role="alert" class="px-4 py-3.5 text-workspace-chrome text-(--solus-status-error)">{connections.pairedDevicesError}</p>
    {:else if !connections.pairedDevicesLoaded}
      <p class="px-4 py-6 text-center text-[0.875em] text-(--solus-text-tertiary)">Reading paired devices…</p>
    {:else if connections.pairedDevices.length === 0}
      <p class="px-4 py-6 text-center text-[0.875em] text-(--solus-text-tertiary)">
        No devices are paired with this host.
      </p>
    {:else}
      {#each pairedPage.rows as device (device.deviceId)}
        <div class="group flex items-center gap-3 px-4 py-2.5">
          <MonitorIcon size={16} class={["shrink-0", device.revokedAt === null ? "text-foreground" : "text-(--solus-text-tertiary)"]} />
          <div class="min-w-0 flex-1">
            <p class={["truncate text-workspace-chrome font-medium", device.revokedAt === null ? "text-(--solus-text-primary)" : "text-(--solus-text-tertiary)"]}>
              {device.deviceLabel}
            </p>
            <p class="truncate text-[0.875em] text-(--solus-text-tertiary)">
              {pairedDeviceDetail(device, connectedDeviceIds.has(device.deviceId))}
            </p>
          </div>
          {#if device.revokedAt === null}
            <Button
              variant="ghost"
              size="sm"
              onclick={() => void connections.revokeDevice(serverId, device.deviceId)}
              aria-label={`Revoke ${device.deviceLabel}`}
              class="text-(--solus-text-tertiary) opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 hover:text-(--solus-status-error)"
            >
              <TrashIcon size={13} />
              Revoke
            </Button>
          {/if}
        </div>
      {/each}
      <ShowMoreRow hiddenCount={pairedPage.hiddenCount} expanded={pairedExpanded} noun="devices" onToggle={() => (pairedExpanded = !pairedExpanded)} />
    {/if}
  </SettingsSection>
{/if}
