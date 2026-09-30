<script lang="ts">
  import { hostCapabilitiesStore } from '../../contexts/connections/host-capabilities.store.svelte';
  import type { ServerItem } from '../../contexts/connections/servers.store.svelte';
  import { modelProfilesStore } from '../../contexts/updates/model-profiles.store.svelte';
  import { modelProfilesLine } from './lib/model-profiles-line';
  import SettingsRow from './SettingsRow.svelte';
  import { Button } from '../ui/button';
  let { host }: { host: ServerItem } = $props();
  const status = $derived(modelProfilesStore.statusFor(host.id));
  const busy = $derived(modelProfilesStore.refreshing.has(host.id) || status?.checking === true);
  const error = $derived(modelProfilesStore.errors.get(host.id) ?? status?.error ?? null);
</script>

{#if hostCapabilitiesStore.supports(host.id, 'modelProfiles')}
  <SettingsRow label="Model list" description={modelProfilesLine(status)} bodyVisible={!!error}>
    {#snippet control()}
      <Button variant="outline" size="sm" disabled={host.status !== 'online' || busy} onclick={() => void modelProfilesStore.refresh(host.id)}>
        {busy ? 'Refreshing…' : 'Clear cache and refresh'}
      </Button>
    {/snippet}
    {#snippet body()}
      <p class="text-workspace-chrome text-muted-foreground" aria-live="polite">{error}</p>
    {/snippet}
  </SettingsRow>
{/if}
