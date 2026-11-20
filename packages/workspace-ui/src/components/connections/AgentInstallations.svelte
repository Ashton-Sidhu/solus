<script lang="ts">
  import { isProviderUpdateActive } from '@solus/contracts/host-update-types';
  import { hostUpdatesStore } from '../../contexts/updates/host-updates.store.svelte';
  import { hosts } from '../../contexts/hosts/hosts.svelte';
  import type { HostSetupSession } from '../servers/host-setup.store.svelte';
  import { updatesLock } from '../settings/policy/managed-setting.svelte';
  import SettingsSection from '../settings/SettingsSection.svelte';
  import SettingsRow from '../settings/SettingsRow.svelte';
  import { Button } from '../ui/button';

  let { setup }: { setup: HostSetupSession } = $props();
  const status = $derived(hostUpdatesStore.hostUpdateFor(setup.serverId));
  const mayEdit = $derived(hosts.get(setup.serverId).me.may('host.admin'));
  const managed = $derived(updatesLock(setup.serverId));
  const choices = $derived(status?.providers.filter((provider) => provider.installation && provider.installation.method !== 'absent' && (!provider.installation.managed || provider.installation.existingPath)) ?? []);
</script>

{#if status && status.install !== 'cloud' && choices.length}
  <SettingsSection label="Agent installations">
    {#each choices as provider (provider.agent)}
      {@const installation = provider.installation}
      {@const busy = isProviderUpdateActive(provider.update) || !!setup.providerStages[provider.agent]}
      {#if installation && installation.method !== 'absent' && (!installation.managed || installation.existingPath)}
        <SettingsRow label={provider.agent === 'claude' ? 'Claude Code' : 'Codex'} description={installation.managed ? 'Return to the installation on this host’s PATH. Active turns continue with their current version.' : 'Use a verified native package managed by Solus. Keep the existing installation so you can return to it.'} {managed} disabled={!mayEdit}>
          {#snippet control()}
            <Button variant="outline" size="sm" disabled={busy || !mayEdit} onclick={() => void setup.selectProviderInstallation(provider.agent, installation.managed ? 'existing' : 'native')}>
              {busy ? 'Updating…' : installation.managed ? 'Use existing installation' : 'Use native installation'}
            </Button>
          {/snippet}
        </SettingsRow>
      {/if}
    {/each}
  </SettingsSection>
{/if}
