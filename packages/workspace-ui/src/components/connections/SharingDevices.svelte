<script lang="ts">
  /** "Devices" on Settings › Sharing & access: the phones and computers that
   *  use Solus on this host, with Revoke; "Pair a device", which makes a
   *  pairing code; and the machines that ask to pair without a code. The
   *  host's owner reads its pairings; anyone else sees the devices connected
   *  now. Outside apps are in the directory above, not here. */
  import { Monitor as MonitorIcon, Smartphone as PhoneIcon } from "@lucide/svelte";
  import { connectionsStore, pairApprovalsStore } from "../../contexts";
  import { relativeTime } from "../../lib/relative-time";
  import { Button } from "../ui/button";
  import { RowCard } from "../ui/row-card";
  import ManagedSettingNote from "../settings/policy/ManagedSettingNote.svelte";
  import { pairingLock } from "../settings/policy/managed-setting.svelte";
  import { pairCodeRequest } from "./lib/access-tab-requests.svelte";
  import { devicesWithAccess, isPhoneLabel, pairedDeviceDetail } from "./lib/paired-devices";
  import PairApprovalRows from "./PairApprovalRows.svelte";
  import PairCodePanel from "./PairCodePanel.svelte";

  interface Props {
    serverId: string;
    /** This client may make a pairing code: a local owner of a personal host. */
    showsPairCode: boolean;
    /** This person may decide the host's approval requests. */
    showsApprovals: boolean;
    /** This person reads the host's pairings (its owner). */
    showsPairedDevices: boolean;
  }

  let { serverId, showsPairCode, showsApprovals, showsPairedDevices }: Props = $props();

  const connections = connectionsStore;
  let isPairing = $state(false);
  /** Rows before "Show more": a host with many devices keeps the page short. */
  const DEVICE_ROWS_SHOWN = 5;
  let isShowingAllDevices = $state(false);

  const pairingLocked = $derived(pairingLock(serverId));
  const showsPanel = $derived(showsPairCode && !pairingLocked && (isPairing || !!connections.activePair || pairCodeRequest.serverId === serverId));
  const connectedDeviceIds = $derived(new Set(connections.sessions.map((session) => session.deviceId)));
  const devices = $derived(devicesWithAccess(connections.pairedDevices));
  const deviceCount = $derived(showsPairedDevices ? devices.length : connections.sessions.length);
  const shownCount = $derived(isShowingAllDevices ? deviceCount : Math.min(deviceCount, DEVICE_ROWS_SHOWN));
  const approvals = $derived(showsApprovals ? pairApprovalsStore.forHost(serverId)?.approvals ?? [] : []);

  $effect(() => {
    if (showsApprovals) void pairApprovalsStore.load(serverId);
  });

  function pair() {
    isPairing = true;
    void connections.generatePairToken(serverId);
  }
</script>

{#snippet deviceRow(label: string, detail: string, deviceId: string | null)}
  {@const Icon = isPhoneLabel(label) ? PhoneIcon : MonitorIcon}
  <div class="flex items-center gap-3 border-b border-border py-3 last:border-b-0">
    <span aria-hidden="true" class="flex size-7 shrink-0 items-center justify-center rounded-[0.4375rem] bg-muted">
      <Icon size={15} class="text-(--solus-text-secondary)" />
    </span>
    <span class="flex min-w-0 flex-1 flex-col gap-0.5">
      <span class="truncate text-[0.875rem] leading-4.5 font-medium text-(--solus-text-primary)">{label}</span>
      <span class="truncate text-[0.8125rem] leading-4 text-(--solus-text-tertiary)">{detail}</span>
    </span>
    {#if deviceId}
      <Button variant="destructive" size="sm" class="shrink-0 pointer-coarse:min-h-11" aria-label={`Revoke ${label}`} onclick={() => void connections.revokeDevice(serverId, deviceId)}>
        Revoke
      </Button>
    {/if}
  </div>
{/snippet}

<section class="flex flex-col gap-1" aria-labelledby="sharing-devices-title">
  <div class="flex items-end justify-between gap-4 border-b border-border pb-3">
    <div class="flex min-w-0 flex-col gap-1">
      <h2 id="sharing-devices-title" class="text-[0.9375rem] leading-4.5 font-semibold text-(--solus-text-primary)">Devices</h2>
      <p class="text-[0.8125rem] leading-[1.45] text-(--solus-text-tertiary)">Phones and computers that use Solus on this host.</p>
    </div>
    {#if showsPairCode && !pairingLocked}
      <Button variant="outline" size="sm" class="shrink-0 pointer-coarse:min-h-11" onclick={pair}>Pair a device</Button>
    {/if}
  </div>

  {#if showsPairCode && pairingLocked}
    <div class="py-3"><ManagedSettingNote note={pairingLocked} /></div>
  {/if}
  {#if showsPanel}
    <div class="py-3"><RowCard><PairCodePanel {serverId} /></RowCard></div>
  {/if}
  {#if approvals.length > 0}
    <div class="py-3"><RowCard><PairApprovalRows {serverId} /></RowCard></div>
  {/if}

  {#if showsPairedDevices}
    {#if connections.pairedDevicesError}
      <p role="alert" class="py-3 text-[0.8125rem] text-(--solus-status-error)">{connections.pairedDevicesError}</p>
    {:else if !connections.pairedDevicesLoaded}
      <p class="py-3 text-[0.8125rem] text-(--solus-text-tertiary)">Reading devices…</p>
    {:else if devices.length === 0}
      <p class="py-3 text-[0.8125rem] text-(--solus-text-tertiary)">No device is paired with this host.</p>
    {:else}
      {#each devices.slice(0, shownCount) as device (device.deviceId)}
        {@render deviceRow(device.deviceLabel, pairedDeviceDetail(device, connectedDeviceIds.has(device.deviceId)), device.deviceId)}
      {/each}
    {/if}
  {:else if connections.sessions.length === 0}
    <p class="py-3 text-[0.8125rem] text-(--solus-text-tertiary)">No device is connected to this host.</p>
  {:else}
    {#each connections.sessions.slice(0, shownCount) as session (session.id)}
      {@render deviceRow(session.deviceLabel, `Connected ${relativeTime(session.connectedAt)}${session.connectionCount > 1 ? ` · ${session.connectionCount} connections` : ""}`, session.deviceId ?? null)}
    {/each}
  {/if}
  {#if deviceCount > DEVICE_ROWS_SHOWN}
    <div class="pt-2">
      <Button variant="ghost" size="sm" class="text-muted-foreground pointer-coarse:min-h-11" aria-expanded={isShowingAllDevices} onclick={() => (isShowingAllDevices = !isShowingAllDevices)}>
        {isShowingAllDevices ? "Show fewer" : `Show ${deviceCount - DEVICE_ROWS_SHOWN} more`}
      </Button>
    </div>
  {/if}
</section>
