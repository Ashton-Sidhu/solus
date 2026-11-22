<script lang="ts">
  import { Dialog } from 'bits-ui';
  import { Square } from '@lucide/svelte';
  import { hosts, serversStore } from '../../contexts';
  import { portForwards } from '../../contexts/running-servers/port-forwards.store.svelte';
  import { runningServers } from '../../contexts/running-servers/running-servers.store.svelte';
  import { requestInputFocus } from '../../lib/inputFocus';
  import { useScope } from '../../lib/keybindings/use-keybinding.svelte';
  import { Button } from '../ui/button';

  let { preferredHostId, onClose }: { preferredHostId: string; onClose: () => void } = $props();
  let hostId = $state('');
  let port = $state<number | undefined>(undefined);
  let busy = $state(false);
  let error = $state<string | null>(null);
  const remoteHosts = $derived(serversStore.servers.filter((host) => !host.local));
  const eligibleHosts = $derived(remoteHosts.filter((host) =>
    host.readiness === 'ready' && hosts.get(host.id).me.may('host.admin')
  ));
  const selectedHostId = $derived(hostId || eligibleHosts.find((host) => host.id === preferredHostId)?.id || eligibleHosts[0]?.id || '');
  const canStart = $derived(eligibleHosts.some((host) => host.id === selectedHostId));
  const discovered = $derived(runningServers.stores.flatMap((store) => store.servers.flatMap((server) =>
    server.endpoints.flatMap((endpoint) => {
      const forward = server.forwarded(endpoint);
      return forward ? [{ hostId: store.hostId, remotePort: endpoint.port, forward, server }] : [];
    })
  )));
  useScope('modal-dialog', { exclusive: true, pre: true });

  function hostName(id: string) {
    return serversStore.hostFor(id)?.label ?? id;
  }

  async function run(operation: () => Promise<void>) {
    if (busy) return;
    busy = true;
    error = null;
    try { await operation(); }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    finally { busy = false; }
  }

  function start(event: SubmitEvent) {
    event.preventDefault();
    const remotePort = port;
    if (!canStart || remotePort === undefined) return;
    hostId = selectedHostId;
    const selected = selectedHostId;
    void run(async () => {
      await portForwards.start(selected, remotePort);
      port = undefined;
    });
  }
</script>

{#snippet row(id: string, remotePort: number, localPort: number, stop: () => Promise<void>)}
  <li class="flex items-center justify-between gap-2 py-1">
    <span class="min-w-0">
      <span class="block truncate">{hostName(id)} · {remotePort}</span>
      <span class="select-text text-chrome-dense text-(--solus-text-secondary)">127.0.0.1:{localPort}</span>
    </span>
    <Button size="icon-sm" variant="destructive" title="Stop forwarding" aria-label={`Stop forwarding ${hostName(id)} port ${remotePort}`} disabled={busy} onclick={() => void run(stop)}>
      <Square size={16} class="fill-current" />
    </Button>
  </li>
{/snippet}

<Dialog.Root open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 modal-backdrop" />
    <Dialog.Content data-solus-ui onCloseAutoFocus={(event) => { event.preventDefault(); requestInputFocus(); }} class="no-drag fixed inset-0 z-50 m-auto flex h-fit max-h-[75vh] w-[min(29rem,calc(100vw-2rem))] flex-col gap-4 overflow-auto rounded-2xl border border-(--solus-tool-border) bg-(--solus-container-bg) p-6 text-workspace-chrome shadow-(--solus-popover-shadow)">
      <Dialog.Title class="font-medium">Forwarded ports</Dialog.Title>
      <Dialog.Description class="text-(--solus-text-secondary)">Reach a remote TCP service from apps on this computer.</Dialog.Description>

      {#if remoteHosts.length}
        <form class="flex flex-col gap-3" onsubmit={start}>
          <div class="flex flex-wrap items-end gap-2">
            <label class="flex min-w-32 flex-1 flex-col gap-1">
              <span>Host</span>
              <select value={selectedHostId} onchange={(event) => { hostId = event.currentTarget.value; }} disabled={busy} class="h-8 rounded-md border border-(--solus-tool-border) bg-(--solus-container-bg) px-2">
                {#if !selectedHostId}<option value="" disabled>Select a host</option>{/if}
                {#each remoteHosts as host (host.id)}
                  <option value={host.id} disabled={!eligibleHosts.includes(host)}>{host.label}</option>
                {/each}
              </select>
            </label>
            <label class="flex w-24 flex-col gap-1">
              <span>Remote port</span>
              <input bind:value={port} type="number" min="1" max="65535" step="1" required placeholder="5432" disabled={busy} class="h-8 rounded-md border border-(--solus-tool-border) bg-(--solus-container-bg) px-2 tabular-nums" />
            </label>
            <Button type="submit" size="sm" disabled={busy || !canStart || port === undefined}>Forward</Button>
          </div>
        </form>
      {/if}
      {#if !eligibleHosts.length}
        <p class="text-(--solus-text-secondary)">Connect to a remote host you administer to forward a port.</p>
      {/if}

      {#if error}<p role="alert" class="text-(--solus-status-error)">{error}</p>{/if}
      {#if portForwards.rows.length || discovered.length}
        <ul aria-label="Active forwards" class="divide-y divide-(--solus-tool-border)">
          {#each portForwards.rows as forward (`${forward.hostId}:${forward.remotePort}`)}
            {@render row(forward.hostId, forward.remotePort, forward.localPort, () => portForwards.stop(forward.hostId, forward.remotePort))}
          {/each}
          {#each discovered as entry (entry.forward.forwardId)}
            {@render row(entry.hostId, entry.remotePort, entry.forward.localPort, () => entry.server.stopForward(entry.forward.forwardId))}
          {/each}
        </ul>
      {/if}
      <div class="flex justify-end"><Button variant="ghost" disabled={busy} onclick={onClose}>Done</Button></div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
