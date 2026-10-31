<script lang="ts">
  import { untrack } from "svelte";
  import { changeProjectProviderOverride, providerProjectOverride, type ProjectProviderChange } from "@solus/contracts/provider-instance-models";
  import { PROVIDERS } from "@solus/contracts/provider-model-settings";
  import { providerInstancesStore } from "./provider-instances.store.svelte";
  import SettingsSelect from "./SettingsSelect.svelte";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";
  import { Button } from "../ui/button";
  let { serverId, cwd }: { serverId: string; cwd: string } = $props();
  const client = $derived(providerInstancesStore.client(serverId));
  const view = $derived(providerInstancesStore.view(serverId));
  const override = $derived(view.snapshot ? providerProjectOverride(view.snapshot.projects, cwd) : undefined);
  $effect(() => { const hostId = serverId; return untrack(() => providerInstancesStore.watch(hostId)); });
  function save(change: ProjectProviderChange) {
    const snapshot = view.snapshot;
    if (!snapshot) return;
    void client.write({ expectedRevision: snapshot.revision, change: { kind: "project", override: changeProjectProviderOverride(snapshot, cwd, change) } });
  }
</script>

<SettingsSection label="Providers for this project">
  <p class="px-4 pb-3 text-sm text-muted-foreground">Your private choices on this host. Inherit uses your host settings. These choices apply to all worktrees of this project.</p>
  {#if view.loading}<p role="status" class="px-4 text-sm text-muted-foreground">Loading provider settings…</p>{/if}
  {#if view.error}<p role="alert" class="px-4 text-sm text-destructive">{view.error}</p>{/if}
  {#if view.snapshot && view.snapshot.configurationVersion !== 2}<p role="status" class="px-4 text-sm text-muted-foreground">Update this host to use project provider overrides. Existing host settings still apply.</p>{/if}
  {#if view.snapshot?.configurationVersion === 2}
    {#each PROVIDERS as provider (provider.id)}
      <SettingsRow label="{provider.label} instance" description="Instance for new sessions. Existing sessions keep their instance.">
        {#snippet control()}<SettingsSelect disabled={view.saving} options={[{ value: "", label: "Inherit host choice" }, ...view.snapshot!.instances.filter((instance) => instance.provider === provider.id).map((instance) => ({ value: instance.id, label: instance.displayName }))]} value={override?.selected[provider.id] ?? ""} onSelect={(value) => save({ kind: "selected", provider: provider.id, instanceId: value || null })} ariaLabel="Project {provider.label} instance" />{/snippet}
      </SettingsRow>
    {/each}
    {#each view.snapshot.instances as instance (instance.id)}
      <SettingsRow label={instance.displayName} description="Host setting: {instance.enabled ? 'enabled' : 'disabled'}. A project override controls new turns here.">
        {#snippet control()}<SettingsSelect disabled={view.saving} options={[{ value: "inherit", label: "Inherit host setting" }, { value: "enabled", label: "Enabled for this project" }, { value: "disabled", label: "Disabled for this project" }]} value={override?.enabled[instance.id] === undefined ? "inherit" : override.enabled[instance.id] ? "enabled" : "disabled"} onSelect={(value) => save({ kind: "enabled", instanceId: instance.id, enabled: value === "inherit" ? null : value === "enabled" })} ariaLabel="Project availability for {instance.displayName}" />{/snippet}
      </SettingsRow>
    {/each}
    <SettingsRow label="Reset provider overrides" description="Use your host's instance choices and enablement for this project.">
      {#snippet control()}<Button variant="outline" size="sm" disabled={!override || view.saving} onclick={() => save({ kind: "reset" })}>Reset to host settings</Button>{/snippet}
    </SettingsRow>
  {/if}
</SettingsSection>
