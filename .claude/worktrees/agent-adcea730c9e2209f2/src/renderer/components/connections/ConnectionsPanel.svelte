<script lang="ts">
  import {
    CopyIcon,
    CheckIcon,
    TrashIcon,
    ArrowsClockwiseIcon,
    MonitorIcon,
    PlusIcon,
    GlobeIcon,
    HouseIcon,
    WifiHighIcon,
  } from "phosphor-svelte";
  import { onMount } from "svelte";
  import { connectionsStore, type ConnectionEndpoint } from "../../contexts/connections.store.svelte";
  import { pairQrSvgPath } from "./lib/qrcode";

  const connections = connectionsStore;
  let copiedField = $state<string | null>(null);

  async function refresh() {
    await connections.refreshServerMetadata();
  }

  async function generatePairToken() {
    await connections.generatePairToken();
  }

  async function revoke(deviceId: string | null) {
    if (!deviceId) return;
    await connections.revokeDevice(deviceId);
  }

  async function toggleRemoteAccess() {
    if (!connections.serverInfo || connections.refreshing) return;
    await connections.setRemoteAccess(!connections.serverInfo.remoteAccess);
  }

  function pairLinkFor(endpoint: ConnectionEndpoint, pair = connections.activePair): string {
    if (!pair) return "";
    return `http://${endpoint.host}:${endpoint.port}/pair#token=${pair.token}`;
  }

  function copy(value: string, field: string) {
    void navigator.clipboard.writeText(value);
    copiedField = field;
    setTimeout(() => {
      if (copiedField === field) copiedField = null;
    }, 1500);
  }

  function formatTimeRemaining(ms: number): string {
    if (ms <= 0) return "expired";
    const mins = Math.floor(ms / 60_000);
    const secs = Math.floor((ms % 60_000) / 1000);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  }

  function relativeTime(ts: number): string {
    const diff = Date.now() - ts;
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  }

  const endpointIcon = {
    loopback: HouseIcon,
    lan: WifiHighIcon,
    tailnet: GlobeIcon,
  } as const;

  const endpointPriority: Record<ConnectionEndpoint["kind"], number> = {
    tailnet: 0,
    lan: 1,
    loopback: 2,
  };

  function bestPairEndpoint(endpoints: ConnectionEndpoint[]): ConnectionEndpoint | null {
    return [...endpoints].sort((a, b) => endpointPriority[a.kind] - endpointPriority[b.kind])[0] ?? null;
  }

  onMount(() => {
    void refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  });

  let _now = $state(Date.now());
  $effect(() => {
    if (!connections.activePair) return;
    const tick = setInterval(() => { _now = Date.now(); }, 1000);
    return () => clearInterval(tick);
  });

  let pairMsLeft = $derived(connections.activePair ? connections.activePair.expiresAt - _now : 0);
  let pairExpired = $derived(connections.activePair ? pairMsLeft <= 0 : false);
  let pairCountdown = $derived(connections.activePair ? formatTimeRemaining(pairMsLeft) : "");
  let bestEndpoint = $derived(bestPairEndpoint(connections.endpoints));
  let bestPairLink = $derived(bestEndpoint ? pairLinkFor(bestEndpoint, connections.activePair) : "");
  let bestPairQr = $derived.by(() => {
    if (!bestPairLink) return null;
    try {
      return pairQrSvgPath(bestPairLink);
    } catch {
      return null;
    }
  });
</script>

<div class="flex flex-col gap-6">
  <!-- Server status bar -->
  {#if connections.serverInfo}
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-2.5">
        <div class="size-2 rounded-full bg-(--solus-status-complete) shrink-0"></div>
        <p class="text-[0.8125rem] text-(--solus-text-secondary)">
          Server running on <code class="text-[0.75rem] font-medium px-1.5 py-0.5 rounded bg-(--solus-surface-hover) text-(--solus-text-primary)" style="font-family: 'Geist Mono', ui-monospace, monospace">{connections.serverInfo.host}:{connections.serverInfo.port}</code>
        </p>
      </div>
      <div class="flex items-center gap-2">
        {#if connections.serverInfo.allowLan}
          <span class="text-[0.6875rem] font-medium px-2 py-0.5 rounded-full bg-(--solus-status-complete-bg) text-(--solus-status-complete)">LAN</span>
        {:else}
          <span class="text-[0.6875rem] font-medium px-2 py-0.5 rounded-full bg-(--solus-surface-hover) text-(--solus-text-tertiary)">Local only</span>
        {/if}
        <button
          type="button"
          onclick={refresh}
          class="size-7 flex items-center justify-center rounded-lg text-(--solus-text-tertiary) hover:text-(--solus-text-primary) hover:bg-(--solus-surface-hover)"
          class:animate-spin={connections.refreshing}
          aria-label="Refresh"
        >
          <ArrowsClockwiseIcon size={13} />
        </button>
      </div>
    </div>

    <div class="flex items-center justify-between gap-4 rounded-lg border border-(--solus-container-border) bg-(--solus-surface-hover) px-3 py-2.5">
      <div class="min-w-0">
        <p class="text-[0.8125rem] font-medium text-(--solus-text-primary)">Allow remote connections</p>
        <p class="mt-0.5 text-[0.6875rem] leading-4 text-(--solus-text-tertiary)">
          Bind to your network interfaces. Remote devices must pair before connecting.
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={connections.serverInfo.remoteAccess}
        onclick={toggleRemoteAccess}
        disabled={connections.refreshing}
        class="relative h-6 w-11 shrink-0 rounded-full border border-(--solus-container-border) bg-(--solus-surface-active) transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent) disabled:opacity-60"
        class:bg-(--solus-accent)={connections.serverInfo.remoteAccess}
        aria-label="Allow remote connections"
      >
        <span
          class="absolute left-0.5 top-0.5 size-[1.125rem] rounded-full bg-(--solus-container-bg) shadow-sm transition-transform"
          class:translate-x-5={connections.serverInfo.remoteAccess}
        ></span>
      </button>
    </div>
  {/if}

  <!-- Reachable endpoints -->
  {#if connections.endpoints.length > 0}
    <div class="flex flex-col gap-2">
      <p class="text-[0.6875rem] font-medium uppercase tracking-wider text-(--solus-text-tertiary)">Reachable from</p>
      <div class="flex flex-col gap-1">
        {#each connections.endpoints as endpoint (endpoint.host)}
          {@const EndpointIcon = endpointIcon[endpoint.kind]}
          <div class="flex items-center gap-2.5 py-1.5 px-2.5 rounded-lg hover:bg-(--solus-surface-hover) group">
            <EndpointIcon size={13} class="text-(--solus-text-tertiary) shrink-0" />
            <code class="text-[0.75rem] text-(--solus-text-primary) flex-1 truncate" style="font-family: 'Geist Mono', ui-monospace, monospace">{endpoint.host}:{endpoint.port}</code>
            <span class="text-[0.6875rem] text-(--solus-text-tertiary)">{endpoint.label}</span>
          </div>
        {/each}
      </div>
    </div>
  {/if}

  <div class="h-px bg-(--solus-container-border)"></div>

  <!-- Pair a new device -->
  <div class="flex flex-col gap-3">
    <div class="flex items-center justify-between">
      <p class="text-[0.6875rem] font-medium uppercase tracking-wider text-(--solus-text-tertiary)">Pair a new device</p>
    </div>

    {#if !connections.activePair}
      <div class="flex flex-col gap-2.5">
        <button
          type="button"
          onclick={generatePairToken}
          class="self-start flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-[0.8125rem] font-medium bg-(--solus-accent) text-(--solus-text-on-accent) hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
        >
          <PlusIcon size={14} weight="bold" />
          Generate pair code
        </button>
        <p class="text-[0.6875rem] text-(--solus-text-tertiary)">
          Creates a one-time code valid for 5 minutes. Share it with the device you want to connect.
        </p>
      </div>
    {:else}
      <div class="flex flex-col gap-4 p-4 rounded-xl bg-(--solus-surface-hover) border border-(--solus-container-border)">
        <!-- Code display -->
        <div class="flex items-center justify-between gap-3">
          <div class="flex items-center gap-3">
            <code
              class="text-[1.75rem] font-semibold tracking-[0.15em] text-(--solus-text-primary) tabular-nums"
              class:opacity-40={pairExpired}
              style="font-family: 'Geist Mono', ui-monospace, monospace"
            >{connections.activePair.code}</code>
            <button
              type="button"
              onclick={() => copy(connections.activePair!.code, 'code')}
              class="size-7 flex items-center justify-center rounded-lg text-(--solus-text-tertiary) hover:text-(--solus-text-primary) hover:bg-(--solus-surface-active)"
              aria-label="Copy code"
            >
              {#if copiedField === 'code'}
                <CheckIcon size={13} class="text-(--solus-status-complete)" />
              {:else}
                <CopyIcon size={13} />
              {/if}
            </button>
          </div>
          <div class="flex items-center gap-2">
            <span
              class="text-[0.75rem] font-medium tabular-nums"
              class:text-red-500={pairExpired}
              class:text-(--solus-text-tertiary)={!pairExpired}
              style="font-family: 'Geist Mono', ui-monospace, monospace"
            >
              {pairCountdown}
            </span>
            <button
              type="button"
              onclick={generatePairToken}
              class="size-7 flex items-center justify-center rounded-lg text-(--solus-text-tertiary) hover:text-(--solus-text-primary) hover:bg-(--solus-surface-active) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
              aria-label={pairExpired ? "Generate new pair code" : "Regenerate pair code"}
            >
              <ArrowsClockwiseIcon size={13} />
            </button>
          </div>
        </div>

        {#if bestPairLink && bestEndpoint && bestPairQr}
          {@const BestIcon = endpointIcon[bestEndpoint.kind]}
          <div class="flex flex-col gap-3 rounded-2xl bg-(--solus-container-bg) p-3 shadow-[0_0_0_1px_var(--solus-container-border)] sm:flex-row">
            <div class="shrink-0">
              <svg
                class="mx-auto block size-40 max-w-full rounded-lg bg-(--solus-container-bg) p-2 text-(--solus-text-primary) shadow-[0_0_0_1px_var(--solus-container-border)] sm:mx-0"
                viewBox={bestPairQr.viewBox}
                role="img"
                aria-label={`QR code for pairing using ${bestEndpoint.label}`}
                shape-rendering="crispEdges"
                focusable="false"
              >
                <path d={bestPairQr.path} fill="currentColor" />
              </svg>
            </div>
            <div class="flex min-w-0 flex-1 flex-col justify-between gap-3">
              <div class="min-w-0">
                <p class="text-[0.8125rem] font-medium text-(--solus-text-primary)">Scan to pair</p>
                <p class="mt-1 text-[0.6875rem] leading-4 text-(--solus-text-tertiary)">
                  Opens the web client with this one-time token.
                </p>
              </div>
              <div class="flex min-w-0 items-center gap-2 rounded-lg bg-(--solus-surface-hover) py-1.5 pl-2.5 pr-1.5">
                <BestIcon size={12} class="shrink-0 text-(--solus-text-tertiary)" />
                <code class="min-w-0 flex-1 truncate text-[0.6875rem] text-(--solus-text-secondary)" style="font-family: 'Geist Mono', ui-monospace, monospace">{bestPairLink}</code>
                <button
                  type="button"
                  onclick={() => copy(bestPairLink, 'best-link')}
                  class="size-7 flex shrink-0 items-center justify-center rounded-md text-(--solus-text-tertiary) transition-colors hover:bg-(--solus-surface-active) hover:text-(--solus-text-primary) active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
                  aria-label="Copy best pair link"
                >
                  {#if copiedField === 'best-link'}
                    <CheckIcon size={12} class="text-(--solus-status-complete)" />
                  {:else}
                    <CopyIcon size={12} />
                  {/if}
                </button>
              </div>
            </div>
          </div>
        {/if}

        <!-- Pair links per endpoint -->
        {#if connections.endpoints.length > 0}
          <div class="flex flex-col gap-1.5">
            <p class="text-[0.6875rem] text-(--solus-text-tertiary)">Other direct links:</p>
            {#each connections.endpoints as endpoint (endpoint.host)}
              {@const link = pairLinkFor(endpoint, connections.activePair)}
              {@const PairIcon = endpointIcon[endpoint.kind]}
              <div class="flex items-center gap-2 py-1 px-2 rounded-lg hover:bg-(--solus-surface-active) group">
                <PairIcon size={11} class="text-(--solus-text-tertiary) shrink-0" />
                <code class="text-[0.6875rem] text-(--solus-text-secondary) flex-1 truncate" style="font-family: 'Geist Mono', ui-monospace, monospace">{link}</code>
                <button
                  type="button"
                  onclick={() => copy(link, endpoint.host)}
                  class="size-6 flex items-center justify-center rounded text-(--solus-text-tertiary) opacity-0 group-hover:opacity-100 hover:text-(--solus-text-primary) hover:bg-(--solus-surface-hover)"
                  aria-label="Copy link"
                >
                  {#if copiedField === endpoint.host}
                    <CheckIcon size={11} class="text-(--solus-status-complete)" />
                  {:else}
                    <CopyIcon size={11} />
                  {/if}
                </button>
              </div>
            {/each}
          </div>
        {/if}

        <button
          type="button"
          onclick={() => { connections.activePair = null; }}
          class="self-start text-[0.75rem] font-medium py-1.5 px-3 rounded-lg border border-(--solus-container-border) text-(--solus-text-secondary) hover:text-(--solus-text-primary) hover:bg-(--solus-surface-hover)"
        >
          Dismiss
        </button>
      </div>
    {/if}
  </div>

  <div class="h-px bg-(--solus-container-border)"></div>

  <!-- Connected devices -->
  <div class="flex flex-col gap-3">
    <div class="flex items-center justify-between">
      <p class="text-[0.6875rem] font-medium uppercase tracking-wider text-(--solus-text-tertiary)">Connected devices</p>
      {#if connections.sessions.length > 0}
        <span class="text-[0.6875rem] tabular-nums font-medium px-1.5 py-0.5 rounded-full bg-(--solus-surface-hover) text-(--solus-text-tertiary)">{connections.sessions.length}</span>
      {/if}
    </div>

    {#if connections.sessions.length === 0}
      <div class="flex flex-col items-center justify-center py-8 gap-2">
        <div class="size-10 rounded-xl bg-(--solus-surface-hover) flex items-center justify-center">
          <MonitorIcon size={20} class="text-(--solus-text-tertiary)" />
        </div>
        <p class="text-[0.8125rem] text-(--solus-text-tertiary)">No devices connected</p>
        <p class="text-[0.6875rem] text-(--solus-text-tertiary) opacity-70">Pair a device to get started</p>
      </div>
    {:else}
      <div class="flex flex-col gap-1">
        {#each connections.sessions as session (session.id)}
          <div class="flex items-center gap-3 py-2 px-2.5 rounded-lg hover:bg-(--solus-surface-hover) group">
            <div class="size-8 rounded-lg bg-(--solus-surface-hover) flex items-center justify-center shrink-0">
              <MonitorIcon size={14} class="text-(--solus-text-tertiary)" />
            </div>
            <div class="flex-1 min-w-0">
              <p class="text-[0.8125rem] font-medium text-(--solus-text-primary) truncate">{session.deviceLabel}</p>
              <p class="text-[0.6875rem] text-(--solus-text-tertiary)">
                {relativeTime(session.connectedAt)}
                {#if session.connectionCount > 1}
                  - {session.connectionCount} connections
                {/if}
              </p>
            </div>
            {#if session.deviceId}
              <button
                type="button"
                onclick={() => revoke(session.deviceId)}
                class="size-7 flex items-center justify-center rounded-lg text-(--solus-text-tertiary) opacity-0 group-hover:opacity-100 hover:bg-red-500/10 hover:text-red-500"
                aria-label="Revoke device"
              >
                <TrashIcon size={13} />
              </button>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
