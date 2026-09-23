<script lang="ts">
  import { untrack } from 'svelte';
  import { browserRuntimeStore } from './browser-runtime.store.svelte';
  import SettingsRow from '../settings/SettingsRow.svelte';
  import { Button } from '../ui/button';

  let { serverId }: { serverId: string } = $props();
  $effect(() => {
    const hostId = serverId;
    return untrack(() => browserRuntimeStore.watch(hostId));
  });
  const entry = $derived(browserRuntimeStore.entries.get(serverId));
  const status = $derived(entry?.status);
  const installing = $derived(status?.phase === 'installing');
  const canInstall = $derived(status?.phase === 'missing' || status?.phase === 'failed');
</script>

<SettingsRow
  label="Browser"
  description={entry?.error || status?.message || 'Checking browser setup…'}
  testId="host-browser-runtime"
>
  {#snippet control()}
    {#if canInstall && !entry?.error}
      <Button variant="outline" size="sm" disabled={entry?.pending} onclick={() => void browserRuntimeStore.refresh(serverId, true)}>
        {entry?.pending ? 'Starting…' : status?.phase === 'failed' ? 'Retry install' : 'Install browser'}
      </Button>
    {:else if installing && !entry?.error}
      <span role="status" class="text-workspace-chrome text-muted-foreground">Installing…</span>
    {:else}
      <Button variant="ghost" size="sm" disabled={entry?.pending} onclick={() => void browserRuntimeStore.refresh(serverId)}>
        {entry?.pending ? 'Checking…' : 'Check again'}
      </Button>
    {/if}
  {/snippet}
  {#snippet body()}
    {#if status?.manualCommand && !entry?.error}
      <div class="mt-2 space-y-2 text-workspace-chrome text-muted-foreground">
        <p>Run this command on the host as the user that runs Solus. Linux libraries can require an administrator password. Then select Check again.</p>
        <code class="block select-text whitespace-pre-wrap break-all rounded-md bg-muted p-2">{status.manualCommand}</code>
        <Button variant="ghost" size="sm" disabled={entry?.pending} onclick={() => void browserRuntimeStore.refresh(serverId)}>Check again</Button>
      </div>
    {/if}
  {/snippet}
</SettingsRow>
