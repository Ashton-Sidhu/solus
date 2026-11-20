<script lang="ts">
  import PanelSection from './PanelSection.svelte';
  import { Copy, Globe, Square, Cable, Unplug } from '@lucide/svelte';
  import { hostPathBaseName } from '@solus/contracts/host-path';
  import { SERVER_LIST_PAGE_SIZE, type ServerEndpoint } from '@solus/contracts/running-servers';
  import { runningServers } from '../../contexts/running-servers/running-servers.store.svelte';
  import type { Server } from '@solus/client-core/running-servers';
  import { hosts, getWorkspaceContext } from '../../contexts';
  import { browserStore } from '../../contexts/browser/browser.store.svelte';
  import { splitHostKey } from '@solus/client-core/host-key';
  import { requestInputFocus } from '../../lib/inputFocus';
  import { copyText, toasts } from '../../lib/toasts';

  let { hostId, checkoutPath, collapsed, onToggle, onResizePointerDown }: {
    hostId: string;
    checkoutPath: string | null;
    collapsed: boolean;
    onToggle: () => void;
    onResizePointerDown: (event: PointerEvent) => void;
  } = $props();
  const workspace = getWorkspaceContext();
  const host = $derived(hosts.get(hostId));
  const store = $derived(runningServers.forHost(hostId));
  let showAll = $state(false);
  let busy = $state<string | null>(null);
  let expanded = $state(false);
  const rows = $derived(store.rows(showAll ? undefined : checkoutPath));
  const visibleRows = $derived(expanded ? rows : rows.slice(0, SERVER_LIST_PAGE_SIZE));
  $effect(() => { if (host.me.may('host.use')) return store.retainCheckout(checkoutPath); });

  async function external(server: Server, endpoint: ServerEndpoint) {
    try { await server.openExternal(endpoint); }
    catch (error) { toasts.error('Cannot open system browser', { description: error instanceof Error ? error.message : String(error) }); }
    finally { requestInputFocus(); }
  }
  async function forward(server: Server, endpoint: ServerEndpoint) {
    try { await server.forward(endpoint); }
    catch (error) { toasts.error('Cannot forward port', { description: error instanceof Error ? error.message : String(error) }); }
    finally { requestInputFocus(); }
  }
  async function stopForward(server: Server, forwardId: string) {
    try { await server.stopForward(forwardId); }
    catch (error) { toasts.error('Cannot stop forwarding', { description: error instanceof Error ? error.message : String(error) }); }
    finally { requestInputFocus(); }
  }

  async function open(server: Server, endpoint: ServerEndpoint) {
    try {
      const key = await browserStore.open(hostId, { target: {
        kind: 'url', url: endpoint.url,
        projectRoot: server.location.projectRoot ?? undefined,
        worktreePath: server.location.worktreePath ?? undefined,
        branch: server.location.branch ?? undefined,
      }});
      workspace.openBrowser(splitHostKey(key).path, hostId);
    } catch (error) { toasts.error('Cannot open server', { description: error instanceof Error ? error.message : String(error) }); }
    finally { requestInputFocus(); }
  }

  async function copy(url: string) {
    try { await copyText(url); }
    catch { toasts.error('Cannot copy the server URL'); }
    finally { requestInputFocus(); }
  }

  async function stop(server: Server) {
    busy = server.serverId;
    try {
      const result = await server.stop();
      if (result.status === 'refused') toasts.error('The server cannot be stopped', { description: result.reason === 'identity-changed' ? 'The process changed. Read the server list again.' : 'This process is not eligible to stop.' });
    } catch (error) { toasts.error('Cannot stop server', { description: error instanceof Error ? error.message : String(error) }); }
    finally { busy = null; requestInputFocus(); }
  }
</script>

{#snippet scopeControl()}
    <button type="button" class="cursor-pointer rounded px-1 text-chrome-dense hover:text-(--solus-text-primary) focus-visible:outline-2" onclick={() => { showAll = !showAll; expanded = false; requestInputFocus(); }}>
      {showAll ? 'This checkout' : 'All on host'}
    </button>
{/snippet}

{#if host.me.may('host.use') && rows.length > 0}
<PanelSection title="Running servers" {collapsed} {onToggle} {onResizePointerDown} headerExtra={scopeControl}>
<section class="flex flex-col gap-1 px-1.5 text-workspace-chrome" aria-label="Running servers">
    {#each visibleRows as row, index (`${row.server.serverId}:${row.endpoint.endpointId}`)}
      {@const { server, endpoint } = row}
      {@const forwarded = server.forwarded(endpoint)}
      {#if showAll && (index === 0 || row.checkoutPath !== visibleRows[index - 1].checkoutPath)}
        <span class="mt-1 truncate text-chrome-dense text-(--solus-text-tertiary)" title={row.checkoutPath ?? undefined}>{row.checkoutPath ? hostPathBaseName(row.checkoutPath) : 'Unassigned'}</span>
      {/if}
      <div class="flex items-center gap-1">
        <button type="button" title={`${endpoint.url}\n${server.sourceLabel} · ${server.process.name}`} class="flex min-h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1 hover:bg-(--solus-surface-hover) focus-visible:outline-2"
          onclick={(event) => void (event.metaKey || event.ctrlKey || event.shiftKey ? external(server, endpoint) : open(server, endpoint))}
          onauxclick={(event) => { if (event.button === 1) { event.preventDefault(); void external(server, endpoint); } }}>
          <Globe size={16} class="shrink-0 text-(--solus-text-tertiary)" />
          <span class="min-w-0 flex-1 text-left">
            <span class="block truncate">{endpoint.response?.pageTitle || server.process.name}</span>
            <span class="block truncate text-chrome-dense text-(--solus-text-tertiary)">{server.sourceLabel}{forwarded ? ` · localhost:${forwarded.localPort}` : ''}</span>
          </span>
          <span class="shrink-0 text-chrome-dense text-(--solus-text-tertiary)">{row.label}</span>
        </button>
        <button type="button" aria-label={`Copy URL for port ${endpoint.port}`} title={forwarded ? 'Copy forwarded URL' : 'Copy host URL'} class="flex size-7 cursor-pointer items-center justify-center rounded-md text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) focus-visible:outline-2" onclick={() => void copy(forwarded?.url ?? endpoint.url)}><Copy size={16} /></button>
        {#if server.canForward}
          <button type="button" aria-label={forwarded ? `Stop forwarding port ${endpoint.port}` : `Forward port ${endpoint.port} to this computer`} title={forwarded ? `Forwarded to localhost:${forwarded.localPort}. Stop forwarding` : 'Forward port to this computer'} class="flex size-7 cursor-pointer items-center justify-center rounded-md text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) focus-visible:outline-2" onclick={() => void (forwarded ? stopForward(server, forwarded.forwardId) : forward(server, endpoint))}>{#if forwarded}<Unplug size={16} />{:else}<Cable size={16} />{/if}</button>
        {/if}
        {#if server.actions.canStop && host.me.may('host.admin')}
          <button type="button" aria-label={`Stop ${server.process.name} on port ${endpoint.port}`} title="Stop server" disabled={busy !== null} class="flex size-7 cursor-pointer items-center justify-center rounded-md text-(--solus-status-error) hover:bg-(--solus-status-error-bg) focus-visible:outline-2 disabled:opacity-40" onclick={() => void stop(server)}><Square size={16} /></button>
        {/if}
      </div>
    {/each}
    {#if rows.length > SERVER_LIST_PAGE_SIZE}
      <button type="button" class="cursor-pointer rounded px-1 py-1 text-left text-chrome-dense text-(--solus-text-tertiary) hover:text-(--solus-text-primary) focus-visible:outline-2" onclick={() => { expanded = !expanded; requestInputFocus(); }}>{expanded ? 'Show less' : `Show ${rows.length - SERVER_LIST_PAGE_SIZE} more`}</button>
    {/if}
</section>
</PanelSection>
{/if}
