<script lang="ts">
  /** Auto balance is a choice about hosts, so it lives with the list of them. It
   *  appears once there are two to choose between. Choices are personal: they
   *  follow the person to each client (docs/plans/resource-telemetry.md D5). */
  import { HOST_BALANCE_LABELS, hostBalancePreference, withHostBalancePreference } from "@solus/client-core/host-balance";
  import { HOST_BALANCE_PREFERENCES, type HostBalancePreference } from "@solus/contracts/settings";
  import { getSettingsContext, serversStore, type ServerItem } from "../../contexts";
  import { Switch } from "../ui/switch";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import SettingsSelect from "../settings/SettingsSelect.svelte";

  const settings = getSettingsContext();
  const balancing = $derived(settings.hostBalancing);
  const servers = $derived(serversStore.executionServers);
  const options = HOST_BALANCE_PREFERENCES.map((value) => ({ value, label: HOST_BALANCE_LABELS[value] }));

  function setEnabled(enabled: boolean) {
    settings.setPersonal("hostBalancing", { ...balancing, enabled });
  }

  function setPreference(server: ServerItem, preference: HostBalancePreference) {
    settings.setPersonal("hostBalancing", withHostBalancePreference(balancing, server, preference));
  }
</script>

{#if servers.length >= 2}
  <SettingsSection label="Auto balance">
    <SettingsRow
      label="Balance new sessions"
      description="A new session chooses among the hosts that hold its project, from their CPU and memory. Choosing a host, branch, or worktree overrides it. Existing sessions stay where they started."
    >
      {#snippet control()}
        <Switch checked={balancing.enabled} onCheckedChange={setEnabled} aria-label="Balance new sessions" />
      {/snippet}
    </SettingsRow>
    {#if balancing.enabled}
      {#each servers as server (server.id)}
        <SettingsRow label={server.label}>
          {#snippet control()}
            <SettingsSelect
              {options}
              value={hostBalancePreference(balancing, server)}
              onSelect={(preference) => setPreference(server, preference)}
              ariaLabel={`Auto balance preference for ${server.label}`}
            />
          {/snippet}
        </SettingsRow>
      {/each}
    {/if}
  </SettingsSection>
{/if}
