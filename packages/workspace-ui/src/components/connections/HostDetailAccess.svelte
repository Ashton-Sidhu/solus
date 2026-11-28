<script lang="ts">
  /** How this host is reached, below the outside apps, addresses, and devices
   *  of Sharing & access: its network and the machines it reaches over SSH or
   *  that reach it. `connectionsStore` is read for this host by the page. Its
   *  Solus Cloud link and organizations are on Settings → Solus Cloud
   *  (`SolusCloudPage`). Only a
   *  local owner (the desktop on the machine or a paired device) may change how
   *  the host is reached; anyone else sees the state and where to change it. */
  import { Check as CheckIcon, Copy as CopyIcon } from "@lucide/svelte";
  import { connectionsStore } from "../../contexts";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import { Switch } from "../ui/switch";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import SettingsSelect from "../settings/SettingsSelect.svelte";
  import ForwardedHostRows from "./ForwardedHostRows.svelte";
  import ReachedMachinesSection from "./ReachedMachinesSection.svelte";
  import { forwardedHostsStore } from "./forwarded-hosts.store.svelte";
  import { hostLock } from "../settings/policy/managed-setting.svelte";
  import type { RemoteAccessMode } from "@solus/contracts/host-api";
  import { tailscaleServePreview, tailscaleServeStateText } from './lib/tailscale-serve';

  interface Props {
    serverId: string;
    hasPairing: boolean;
    canChangeNetwork: boolean;
  }

  let { serverId, hasPairing, canChangeNetwork }: Props = $props();

  const connections = connectionsStore;
  // Machine-wide keys a policy locks on this host (plans/030 §6.7).
  const remoteAccessLock = $derived(hostLock(serverId, "remoteAccess"));
  const trustLocalNetworkLock = $derived(hostLock(serverId, "trustLocalNetwork"));
  let addressCopied = $state(false);
  let servePort = $state(443);

  const info = $derived(connections.serverInfo);
  $effect(() => { if (info?.tailscaleServe) servePort = info.tailscaleServe.port; });
  const servePreview = $derived(tailscaleServePreview(info?.tailscaleServe?.url ?? null, servePort));
  // Watched here, not in its rows: the SSH card shows once the forwards are read.
  $effect(() => forwardedHostsStore.watch(serverId));
  const forwarded = $derived(forwardedHostsStore.hostsFor(serverId));
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
          class="text-muted-foreground pointer-coarse:tap-area"
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

<!-- The machines this host reaches through a forward, over SSH or into WSL.
     After the network setting on purpose: a forward needs no open port (D4,
     D7). Pair codes and approval requests are under Devices above. -->
<SettingsSection
  label="Machines over SSH"
  description="Machines this host reaches over SSH or in WSL. Your other machines then reach them too."
  visible={!!forwarded}
>
  <!-- Keyed so another host's list is read afresh. -->
  {#key serverId}
    <ForwardedHostRows {serverId} />
  {/key}
</SettingsSection>

{#if hasPairing && canChangeNetwork}
  {#key serverId}<ReachedMachinesSection {serverId} />{/key}
{/if}
