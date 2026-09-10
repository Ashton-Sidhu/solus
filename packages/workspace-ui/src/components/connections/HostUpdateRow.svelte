<script lang="ts">
  import { isServerUpdateActive } from '@solus/contracts/server-update';
  import { serverUpdateText } from '../../contexts/updates/server-update-text';
  import { hostCapabilitiesStore } from '../../contexts/connections/host-capabilities.store.svelte';
  import type { ServerItem } from '../../contexts/connections/servers.store.svelte';
  import { serversStore } from '../../contexts/connections/servers.store.svelte';
  import { hostUpdatesStore } from '../../contexts/updates/host-updates.store.svelte';
  import { updatesStore } from '../../contexts/updates/updates.store.svelte';
  import { hostUpdateLine } from './lib/host-update-rows';
  import { updateCommandFor, updateStatusLine } from '../settings/lib/update-status-text';
  import SettingsRow from '../settings/SettingsRow.svelte';
  import { Button } from '../ui/button';
  let { host }: { host: ServerItem } = $props();
  const status = $derived(hostUpdatesStore.hostUpdateFor(host.id));
  const operation = $derived(hostUpdatesStore.operations.get(host.id));
  const updating = $derived(isServerUpdateActive(operation));
  const desktop = $derived(host.local && updatesStore.isAvailable);
  const command = $derived(desktop ? updateCommandFor(updatesStore.state) : null);
  const skew = $derived(serversStore.versionSkewNoticeFor(host.id));
  async function checkHost() {
    await Promise.allSettled([hostUpdatesStore.check(host.id), ...(desktop ? [updatesStore.check()] : [])]);
  }
  function runDesktopCommand() {
    if (command?.command === 'restart') updatesStore.restart();
    else if (command?.command === 'download') void updatesStore.download();
    else void updatesStore.check();
  }
</script>

<SettingsRow label="Solus version" description={hostUpdateLine(status)} bodyVisible>
  {#snippet control()}
    <div class="flex flex-col items-end gap-2">
    {#if desktop && command && command.command !== 'check'}
      <Button variant="outline" size="sm" onclick={runDesktopCommand}>{command.label}</Button>
    {/if}
    {#if !desktop && status?.serverUpdate?.supported}
      {#if operation?.phase === 'waiting'}
        <Button variant="outline" size="sm" disabled={host.status !== 'online' || hostUpdatesStore.updateRequests.has(host.id)} onclick={() => void hostUpdatesStore.cancelUpdate(host.id)}>Cancel update</Button>
      {:else if status.check.kind === 'available' || updating}
        <Button variant="outline" size="sm" disabled={host.status !== 'online' || updating || hostUpdatesStore.updateRequests.has(host.id)} onclick={() => void hostUpdatesStore.install(host.id)}>{updating ? 'Updating Solus…' : 'Update Solus'}</Button>
      {/if}
    {/if}
    {#if hostCapabilitiesStore.supports(host.id, 'hostUpdates')}
      <Button variant="outline" size="sm" disabled={host.status !== 'online' || updating || status?.check.kind === 'checking' || status?.providers.some((p) => p.check.kind === 'checking')} onclick={() => void checkHost()}>Check for updates</Button>
    {/if}
    </div>
  {/snippet}
  {#snippet body()}
    <div class="text-workspace-chrome text-muted-foreground" aria-live="polite">
      {#if operation}<p>{serverUpdateText(operation, host.label, host.status === 'online')}</p>{#if operation.message}<p>{operation.message}</p>{/if}{/if}
      {#if desktop}<p>{updateStatusLine(updatesStore.state)}</p>{/if}
      {#if status?.check.kind === 'available'}
        {#if !status.serverUpdate?.supported}<p>{status.remediation}</p><p>{status.serverUpdate?.reason}</p>{/if}
        {#if status.releaseUrl}<a class="underline" href={status.releaseUrl} target="_blank" rel="noreferrer">Release notes</a>{/if}
      {/if}
      {#if hostUpdatesStore.errors.get(host.id)}<p>{hostUpdatesStore.errors.get(host.id)}</p>{/if}
      {#if skew}<p>{skew.remediation}</p>{/if}
    </div>
  {/snippet}
</SettingsRow>
