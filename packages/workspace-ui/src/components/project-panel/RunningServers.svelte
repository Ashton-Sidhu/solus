<script lang="ts">
  import PanelSection from './PanelSection.svelte';
  import { Copy, Check, Globe, Bot, SquareTerminal, Square, Cable, Unplug, LoaderCircle } from '@lucide/svelte';
  import type { Component } from 'svelte';
  import * as Tooltip from '../ui/tooltip';
  import ProviderMark from '../ui/ProviderMark.svelte';
  import { providerMark } from '../insights/lib/provider';
  import { sessionListStore } from '../../contexts/workspace/session-list.store.svelte';
  import { hostPathBaseName } from '@solus/contracts/host-path';
  import { stopRefusalText, type ServerEndpoint } from '@solus/contracts/running-servers';
  import type { RunningServers, RunningServersRow } from '@solus/client-core/running-servers';
  import { hostSettingsStore } from '../../contexts/app/host-settings.store.svelte';
  import { hosts, getWorkspaceContext } from '../../contexts';
  import { browserStore } from '../../contexts/browser/browser.store.svelte';
  import { splitHostKey } from '@solus/client-core/host-key';
  import { requestInputFocus } from '../../lib/inputFocus';
  import { copyText, toasts } from '../../lib/toasts';

  let { hostId, rows, otherCheckoutCount, isShowingOther, onToggleOther, initialRowCount, collapsed, onToggle, onResizePointerDown }: {
    hostId: string;
    rows: readonly RunningServersRow[];
    otherCheckoutCount: number;
    isShowingOther: boolean;
    onToggleOther: () => void;
    initialRowCount: number;
    collapsed: boolean;
    onToggle: () => void;
    onResizePointerDown: (event: PointerEvent) => void;
  } = $props();
  const workspace = getWorkspaceContext();
  const host = $derived(hosts.get(hostId));
  const forwardingEnabled = $derived(hostSettingsStore.states.get(host.id)?.previewTunnelEnabled !== false);
  let busy = $state<string | null>(null);
  /** The one row action in flight or just confirmed, as `action:endpointId`. */
  let pendingAction = $state<string | null>(null);
  let copiedAction = $state<string | null>(null);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => () => clearTimeout(copiedTimer));
  let expanded = $state(false);
  const extraRowCount = $derived(rows.length - initialRowCount);
  const visibleRows = $derived(expanded ? rows : rows.slice(0, initialRowCount));

  async function external(server: RunningServers, endpoint: ServerEndpoint) {
    try { await server.openExternal(endpoint, { isLocalHost: host === hosts.device }); }
    catch (error) { toasts.error('Cannot open system browser', { description: error instanceof Error ? error.message : String(error) }); }
    finally { requestInputFocus(); }
  }
  async function forward(server: RunningServers, endpoint: ServerEndpoint) {
    pendingAction = `forward:${endpoint.endpointId}`;
    try {
      const forwarded = await server.forward(endpoint);
      toasts.success(`Port ${endpoint.port} forwarded`, { description: forwarded.url });
    }
    catch (error) { toasts.error('Cannot forward port', { description: error instanceof Error ? error.message : String(error) }); }
    finally { pendingAction = null; requestInputFocus(); }
  }
  async function stopForward(server: RunningServers, endpoint: ServerEndpoint, forwardId: string) {
    pendingAction = `forward:${endpoint.endpointId}`;
    try { await server.stopForward(forwardId); }
    catch (error) { toasts.error('Cannot stop forwarding', { description: error instanceof Error ? error.message : String(error) }); }
    finally { pendingAction = null; requestInputFocus(); }
  }

  async function open(server: RunningServers, endpoint: ServerEndpoint) {
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

  async function copy(endpoint: ServerEndpoint, url: string) {
    try {
      await copyText(url);
      copiedAction = `copy:${endpoint.endpointId}`;
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => (copiedAction = null), 1500);
    }
    catch { toasts.error('Cannot copy the server URL'); }
    finally { requestInputFocus(); }
  }

  async function stop(server: RunningServers, endpoint: ServerEndpoint) {
    busy = server.serverId;
    pendingAction = `stop:${endpoint.endpointId}`;
    try {
      const result = await server.stop();
      if (result.status === 'refused') toasts.error('The server cannot be stopped', { description: stopRefusalText(result.reason) });
    } catch (error) { toasts.error('Cannot stop server', { description: error instanceof Error ? error.message : String(error) }); }
    finally { busy = null; pendingAction = null; requestInputFocus(); }
  }
</script>

{#snippet rowAction(tip: string, Icon: Component<{ size?: number; class?: string }>, isPending: boolean, isDanger: boolean, isDisabled: boolean, onclick: () => void)}
  <Tooltip.Root delayDuration={150} ignoreNonKeyboardFocus>
    <Tooltip.Trigger aria-label={tip} disabled={isDisabled || isPending} aria-busy={isPending} {onclick}
      class="flex size-6 cursor-pointer items-center justify-center rounded-md text-(--solus-text-tertiary) transition-[color,background-color,transform] duration-100 active:scale-90 focus-visible:outline-2 disabled:cursor-default disabled:opacity-40 aria-busy:opacity-100 pointer-coarse:tap-area {isDanger ? 'hover:bg-(--solus-status-error-bg) hover:text-(--solus-status-error)' : 'hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)'}">
      {#if isPending}<LoaderCircle size={16} class="animate-spin motion-reduce:animate-none" />{:else}<Icon size={16} />{/if}
    </Tooltip.Trigger>
    <Tooltip.Content value={tip} />
  </Tooltip.Root>
{/snippet}

<PanelSection title="Running servers" {collapsed} {onToggle} {onResizePointerDown}>
<section class="flex flex-col gap-0.5 px-1.5" aria-label="Running servers">
    {#each visibleRows as row (`${row.server.serverId}:${row.endpoint.endpointId}`)}
      {@const { server, endpoint } = row}
      {@const forwarded = server.forwarded(endpoint)}
      {@const copied = copiedAction === `copy:${endpoint.endpointId}`}
      {@const agentMark = server.startedBy.kind === 'agent' && server.startedBy.sessionId ? providerMark(sessionListStore.listed(server.startedBy.sessionId)?.opensWith.provider) : null}
      {@const SourceIcon = server.startedBy.kind === 'agent' ? Bot : server.startedBy.kind === 'terminal' ? SquareTerminal : Globe}
      {@const folder = server.location.projectRoot ?? row.checkoutPath}
      {@const detail = [folder ? hostPathBaseName(folder) : null, forwarded ? `localhost:${forwarded.localPort}` : null].filter(Boolean).join(' · ')}
      <div class="group flex items-center rounded-md hover:bg-(--solus-surface-hover)" data-active={copied || pendingAction?.endsWith(`:${endpoint.endpointId}`) || undefined}>
        <button type="button" title={`${endpoint.url}\n${server.sourceLabel} · ${server.process.name}${row.checkoutPath ? `\n${row.checkoutPath}` : ''}`} class="flex min-h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1.5 focus-visible:outline-2"
          onclick={(event) => void ((forwardingEnabled || host === hosts.device) && (event.metaKey || event.ctrlKey || event.shiftKey) ? external(server, endpoint) : open(server, endpoint))}
          onauxclick={(event) => { if (event.button === 1) { event.preventDefault(); void (forwardingEnabled || host === hosts.device ? external(server, endpoint) : open(server, endpoint)); } }}>
          <span class="flex size-4 shrink-0 items-center justify-center text-(--solus-text-tertiary)" aria-hidden="true">
            {#if agentMark}<ProviderMark mark={agentMark} size={14} transparent />{:else}<SourceIcon size={16} />{/if}
          </span>
          <span class="min-w-0 flex-1 truncate text-left">
            {endpoint.response?.pageTitle || server.process.name}
            {#if detail}<span class="ml-1 text-chrome-dense text-(--solus-text-tertiary)">{detail}</span>{/if}
          </span>
          <span class="shrink-0 pr-0.5 text-chrome-dense text-(--solus-text-tertiary) tabular-nums group-hover:hidden group-has-[:focus-visible]:hidden group-data-[active]:hidden">{row.label}</span>
        </button>
        <div class="hidden shrink-0 items-center gap-0.5 pr-1 group-hover:flex group-has-[:focus-visible]:flex group-data-[active]:flex pointer-coarse:flex pointer-coarse:gap-2">
          {@render rowAction(copied ? 'Copied' : forwarded ? 'Copy forwarded URL' : 'Copy URL', copied ? Check : Copy, false, false, false, () => void copy(endpoint, forwarded?.url ?? endpoint.url))}
          {#if server.canForward && host !== hosts.device && (forwarded || forwardingEnabled)}
            {@render rowAction(forwarded ? `Stop forwarding localhost:${forwarded.localPort}` : 'Forward to this computer', forwarded ? Unplug : Cable, pendingAction === `forward:${endpoint.endpointId}`, false, false, () => void (forwarded ? stopForward(server, endpoint, forwarded.forwardId) : forward(server, endpoint)))}
          {/if}
          {#if server.actions.canStop && host.me.may('host.admin')}
            {@render rowAction('Stop server', Square, pendingAction === `stop:${endpoint.endpointId}`, true, busy !== null, () => void stop(server, endpoint))}
          {/if}
        </div>
      </div>
    {/each}
    {#if extraRowCount > 0 || otherCheckoutCount > 0}
      <div class="flex items-center gap-3 px-1.5 pt-0.5 text-chrome-dense text-(--solus-text-tertiary)">
        {#if extraRowCount > 0}
          <button type="button" class="cursor-pointer rounded py-1 hover:text-(--solus-text-primary) focus-visible:outline-2" onclick={() => { expanded = !expanded; requestInputFocus(); }}>{expanded ? 'Show less' : `Show ${extraRowCount} more`}</button>
        {/if}
        {#if otherCheckoutCount > 0}
          <button type="button" class="cursor-pointer rounded py-1 hover:text-(--solus-text-primary) focus-visible:outline-2" onclick={() => { onToggleOther(); requestInputFocus(); }}>{isShowingOther ? 'Session folders' : `${otherCheckoutCount} in other checkouts`}</button>
        {/if}
      </div>
    {/if}
</section>
</PanelSection>
