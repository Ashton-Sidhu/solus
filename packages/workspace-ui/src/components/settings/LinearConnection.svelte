<script lang="ts">
  import { untrack } from 'svelte';
  import Icon from '@iconify/svelte';
  import { settingsDefinitions } from '@solus/client-core/settings-definitions';
  import { accountStore } from '../../contexts/account/account.store.svelte';
  import { hosts } from '../../contexts/hosts/hosts.svelte';
  import { requestInputFocus } from '../../lib/inputFocus';
  import { keyConnectionFor } from './key-connections.store';
  import SettingsRow from './SettingsRow.svelte';
  import ProviderConnectedCheck from './ProviderConnectedCheck.svelte';
  import { PROVIDER_LOGOS } from './lib/provider-logos';
  import { Button } from '../ui/button';
  import { Input } from '../ui/input';

  let { serverId }: { serverId: string } = $props();
  const connection = $derived(keyConnectionFor(serverId, { kind: 'provider', provider: 'linear' }));
  let linear = $state(connection.current);
  let key = $state('');
  let editing = $state(false);
  const canManage = $derived(linear.location === 'account' ? accountStore.isSignedIn : linear.location === 'host' && hosts.get(serverId).me.may('host.admin.connections'));

  $effect(() => {
    const store = connection;
    linear = store.current;
    return store.subscribe(() => { linear = store.current; });
  });
  $effect(() => {
    const store = connection;
    const account = accountStore.state;
    const identity = account.kind === 'signed-in' ? `${account.consoleUrl}:${account.identity.sub}` : account.kind;
    void identity;
    key = '';
    editing = false;
    untrack(() => { store.reset(); void store.load(); });
  });

  async function save(event: SubmitEvent) {
    event.preventDefault();
    const draft = key;
    key = '';
    if (await connection.save(draft)) {
      editing = false;
      requestInputFocus();
    }
  }
  async function disconnect() {
    key = '';
    if (await connection.disconnect()) { editing = false; requestInputFocus(); }
  }
</script>

<SettingsRow
  {...settingsDefinitions['integrations.linear']}
  description={linear.loading ? 'Checking connection…' : linear.connected ? `Connected${linear.label ? ` as ${linear.label}` : ''}${linear.location === 'account' ? ' in your Solus account.' : ' on this host.'}` : 'Read and update Linear issues from Tasks.'}
  testId="connections-row-linear"
>
  {#snippet icon()}<Icon icon={PROVIDER_LOGOS.linear} width={16} height={16} />{/snippet}
  {#snippet labelExtra()}<ProviderConnectedCheck connected={linear.connected} provider="Linear" />{/snippet}
  {#snippet control()}
    {#if linear.connected}
      <Button variant="outline" size="sm" disabled={!canManage || linear.pending} onclick={() => { editing = !editing; key = ''; }}>Replace key</Button>
      <Button variant="outline" size="sm" disabled={!canManage || linear.pending} onclick={() => void disconnect()}>Disconnect</Button>
    {/if}
    <Button variant="ghost" size="sm" disabled={linear.loading || linear.pending} onclick={() => void connection.load()}>Refresh</Button>
  {/snippet}
  {#snippet body()}
    {#if canManage && (!linear.connected || editing)}
      <form class="flex flex-col gap-2" onsubmit={save}>
        <label for="linear-key-{serverId}" class="text-workspace-chrome font-medium">API key</label>
        <div class="flex gap-2">
          <Input id="linear-key-{serverId}" type="password" bind:value={key} autocomplete="new-password" maxlength={4096} disabled={linear.pending} class="text-workspace-chrome" />
          <Button type="submit" size="sm" disabled={!key.trim() || linear.pending}>{linear.pending ? 'Saving…' : 'Connect'}</Button>
        </div>
        <p class="text-xs text-muted-foreground">Create a personal API key in Linear Settings → Security &amp; access.
          {linear.location === 'account' ? 'Solus saves it in your account vault for use on your hosts.' : 'Solus saves it in the secure vault on this host.'}
        </p>
      </form>
    {/if}
    {#if linear.error}<p role="alert" class="mt-2 text-workspace-chrome text-destructive">{linear.error}</p>{/if}
  {/snippet}
</SettingsRow>
