<script lang="ts">
  import { hostSettingsStore } from '../../contexts/app/host-settings.store.svelte';
  import { hostUpdatesStore } from '../../contexts/updates/host-updates.store.svelte';
  import { hosts } from '../../contexts/hosts/hosts.svelte';
  import { updatesLock } from '../settings/policy/managed-setting.svelte';
  import SettingsSection from '../settings/SettingsSection.svelte';
  import SettingsRow from '../settings/SettingsRow.svelte';
  import { Switch } from '../ui/switch';

  let { serverId }: { serverId: string } = $props();
  const settings = $derived(hostSettingsStore.states.get(serverId));
  const status = $derived(hostUpdatesStore.hostUpdateFor(serverId));
  const managed = $derived(updatesLock(serverId));
  const mayEdit = $derived(hosts.get(serverId).me.may('host.admin'));
</script>

{#if settings && status?.install !== 'cloud' && status?.providers.some((provider) => provider.installation)}
  <SettingsSection label="Agent updates">
    <SettingsRow label="Automatic agent updates" description="Update native agents installed through Solus on this host. Active turns keep their current version. Other installations keep their existing package manager." {managed} disabled={!mayEdit}>
      {#snippet control()}
        <Switch checked={settings.agentAutoUpdates} disabled={settings.saving || !mayEdit} aria-label="Automatic agent updates" onCheckedChange={(enabled) => void hostSettingsStore.setAgentAutoUpdates(serverId, enabled)} />
      {/snippet}
    </SettingsRow>
    {#if settings.error}<p class="px-4 pb-3 text-workspace-chrome text-destructive" role="alert">{settings.error}</p>{/if}
  </SettingsSection>
{/if}
