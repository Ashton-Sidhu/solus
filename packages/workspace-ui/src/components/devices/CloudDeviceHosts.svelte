<script lang="ts">
  import type { CloudDeviceHostConfig, DeviceHostSummary, DeviceHostTestResult, DeviceHostStatusEntry } from "@solus/contracts/device-types";
  import { cloudDeviceHostConfigSchema, DEVICE_SECRET_SAVED } from "@solus/contracts/device-types";
  import { cloudDeviceHostLimits, newCloudDeviceHost } from "@solus/client-core/device-host-draft";
  import { devicesStore, deviceErrorMessage } from "../../contexts/devices/devices.store.svelte";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";

  let { serverId, hosts, statuses }: { serverId: string; hosts: DeviceHostSummary[]; statuses: DeviceHostStatusEntry[] } = $props();
  let draft = $state<CloudDeviceHostConfig | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let checked = $state<DeviceHostTestResult | null>(null);
  const canCheck = $derived(draft ? cloudDeviceHostConfigSchema.safeParse(draft).success : false);
  const valid = $derived(canCheck && !!draft);

  function edit(config: CloudDeviceHostConfig) { draft = structuredClone(config); checked = null; error = null; }
  async function run(work: () => Promise<void>) {
    busy = true; error = null;
    try { await work(); } catch (cause) { error = deviceErrorMessage(cause); } finally { busy = false; }
  }
  function check() {
    if (!draft || !canCheck) return;
    const value = cloudDeviceHostConfigSchema.parse(draft);
    void run(async () => { checked = await devicesStore.testHost(serverId, value); });
  }
  function save() {
    if (!draft || !valid) return;
    const value = cloudDeviceHostConfigSchema.parse(draft);
    void run(async () => { await devicesStore.saveHost(serverId, value); draft = null; });
  }
</script>

<SettingsSection label="Cloud devices" description="Lease devices from your Simlock pool.">
  {#snippet action()}
    <div class="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={busy || !!draft} onclick={() => edit(newCloudDeviceHost(`simlock-${crypto.randomUUID()}`))}>Add Simlock pool</Button>
    </div>
  {/snippet}
  {#if error}<p class="px-4 py-3 text-workspace-chrome text-destructive" role="alert">{error}</p>{/if}
  {#if !hosts.length && !draft}<p class="px-4 py-3 text-workspace-chrome text-muted-foreground">No cloud device sources.</p>{/if}
  {#each hosts as host (host.deviceHostId)}
    {@const status = statuses.find((entry) => entry.deviceHostId === host.deviceHostId)}
    <div class="flex items-center gap-3 px-4 py-3">
      <div class="min-w-0 flex-1">
        <p class="truncate text-workspace-chrome font-medium">{host.label} <span class="font-normal text-muted-foreground">Simlock · Alpha</span></p>
        {#if host.config}<p class="text-workspace-chrome text-muted-foreground">{cloudDeviceHostLimits(host.config)}</p>{/if}
        {#if status?.detail}<p class="break-words text-workspace-chrome text-muted-foreground" role="status">{status.detail}</p>{/if}
      </div>
      {#if host.config}<Button size="sm" variant="ghost" disabled={busy || !!draft} onclick={() => host.config && edit(host.config)}>Edit</Button>{/if}
      <Button size="sm" variant="ghost" disabled={busy} onclick={() => void run(() => devicesStore.removeHost(serverId, host.deviceHostId))}>Remove</Button>
    </div>
  {/each}
  {#if draft}
    <form class="flex flex-col gap-4 px-4 py-4 text-workspace-chrome" onsubmit={(event) => { event.preventDefault(); save(); }} oninput={() => { checked = null; }}>
      <p class="font-medium">Simlock pool (alpha)</p>
      <p class="text-muted-foreground">This Solus host connects to your gateway. Set up Simlock and its workers first. Use an agent token for this host.</p>
      <label class="flex flex-col gap-1.5"><span>Name</span><Input aria-label="Name" name="label" bind:value={draft.label} disabled={busy} /></label>
      <label class="flex flex-col gap-1.5"><span>Gateway URL</span><Input aria-label="Gateway URL" name="gatewayUrl" type="url" bind:value={draft.gatewayUrl} placeholder="https://gateway.example.ts.net:4700" disabled={busy} /></label>
      <label class="flex flex-col gap-1.5"><span>Agent token</span><Input aria-label="Agent token" name="agentToken" type="password" autocomplete="off" bind:value={draft.agentToken} placeholder="Optional when the host environment supplies it" disabled={busy} /></label>
      {#if draft.agentToken === DEVICE_SECRET_SAVED}<p class="text-muted-foreground">A token is saved. Keep it, replace it, or clear the field to use the host environment.</p>{/if}
      <p class="text-muted-foreground">Create an agent token with <code>simlock --gateway token create --role agent</code>. A blank token uses the host’s agent-device environment only when it names this gateway.</p>
      <div class="grid grid-cols-2 gap-3">
        <label class="flex flex-col gap-1.5"><span>Devices at once</span><Input aria-label="Devices at once" name="maxLeases" type="number" min={1} max={20} bind:value={draft.maxLeases} disabled={busy} /></label>
        <label class="flex flex-col gap-1.5"><span>Lease minutes</span><Input aria-label="Lease minutes" name="maxLeaseMinutes" type="number" min={5} max={240} bind:value={draft.maxLeaseMinutes} disabled={busy} /></label>
      </div>
      <p class="text-muted-foreground">A lease ends at this limit, even while in use. Closing the last preview returns the device to the pool. The gateway and workers must allow screen streaming and input.</p>
      <p class="text-muted-foreground">Saving changes to a source stops its current leases.</p>
      {#if checked}
        <div role="status" class="flex flex-col gap-1 rounded-lg border border-border p-3">
          {#each checked.checks as check (check.name)}<p class={check.ok ? "text-muted-foreground" : "text-destructive"}>{check.detail ?? (check.ok ? "Connection checked." : "Connection failed.")}</p>{/each}
        </div>
      {/if}
      <div class="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" size="sm" disabled={busy || !canCheck} onclick={check}>Check connection</Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onclick={() => { draft = null; }}>Cancel</Button>
        <Button type="submit" size="sm" disabled={busy || !valid}>{busy ? "Working…" : "Save source"}</Button>
      </div>
    </form>
  {/if}
</SettingsSection>
