<script lang="ts">
  import { isProviderUpdateActive } from '@solus/contracts/host-update-types';
  import { hostUpdatesStore } from '../../contexts/updates/host-updates.store.svelte';
  import { hosts } from '../../contexts/hosts/hosts.svelte';
  import type { HostSetupSession } from '../servers/host-setup.store.svelte';
  import { updatesLock } from '../settings/policy/managed-setting.svelte';
  import SettingsSection from '../settings/SettingsSection.svelte';
  import SettingsRow from '../settings/SettingsRow.svelte';
  import { Button } from '../ui/button';
  import { agentInstallationRows } from './lib/host-update-rows';

  let { setup }: { setup: HostSetupSession } = $props();
  const status = $derived(hostUpdatesStore.hostUpdateFor(setup.serverId));
  const mayEdit = $derived(hosts.get(setup.serverId).me.may('host.admin'));
  const managed = $derived(updatesLock(setup.serverId));
  const rows = $derived(status ? agentInstallationRows(status.providers) : []);
</script>

{#if status && status.install !== 'cloud' && rows.length}
  <SettingsSection label="Agent installations">
    {#each rows as row (row.agent)}
      {@const provider = status.providers.find((item) => item.agent === row.agent)}
      {@const busy = isProviderUpdateActive(provider?.update) || !!setup.providerStages[row.agent]}
      {@const switchTo = row.switchTo}
      {#if switchTo}
        <SettingsRow label={row.label} description={row.description} {managed} disabled={!mayEdit}>
          {#snippet control()}
            <Button variant="outline" size="sm" disabled={busy || !mayEdit} onclick={() => void setup.selectProviderInstallation(row.agent, switchTo)}>
              {busy ? 'Updating…' : switchTo === 'existing' ? 'Use existing installation' : 'Use native installation'}
            </Button>
          {/snippet}
        </SettingsRow>
      {:else}
        <SettingsRow label={row.label} description={row.description} />
      {/if}
    {/each}
  </SettingsSection>
{/if}
