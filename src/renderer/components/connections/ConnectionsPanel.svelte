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
  import {
    connectionsStore,
    type ConnectionEndpoint,
  } from "../../contexts";
  import HostDirectory from "../servers/HostDirectory.svelte";
  import { relativeTime } from "../servers/lib/relative-time";
  import { pairQrSvgPath } from "./lib/qrcode";
  import { Switch } from "../ui/switch";
  import { Button } from "../ui/button";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import SettingsRow from "../settings/SettingsRow.svelte";

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
    if (
      !connections.serverInfo ||
      connections.refreshing ||
      connections.remoteAccessUpdating
    )
      return;
    await connections.setRemoteAccess(!connections.serverInfo.remoteAccess);
  }

  function pairLinkFor(
    endpoint: ConnectionEndpoint,
    pair = connections.activePair,
  ): string {
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

  function bestPairEndpoint(
    endpoints: ConnectionEndpoint[],
  ): ConnectionEndpoint | null {
    return (
      [...endpoints].sort(
        (a, b) => endpointPriority[a.kind] - endpointPriority[b.kind],
      )[0] ?? null
    );
  }

  onMount(() => {
    void refresh();
    const interval = setInterval(refresh, 5000);
    return () => {
      clearInterval(interval);
    };
  });

  let _now = $state(Date.now());
  $effect(() => {
    if (!connections.activePair) return;
    const tick = setInterval(() => {
      _now = Date.now();
    }, 1000);
    return () => clearInterval(tick);
  });

  let pairMsLeft = $derived(
    connections.activePair ? connections.activePair.expiresAt - _now : 0,
  );
  let pairExpired = $derived(connections.activePair ? pairMsLeft <= 0 : false);
  let pairCountdown = $derived(
    connections.activePair ? formatTimeRemaining(pairMsLeft) : "",
  );
  let bestEndpoint = $derived(bestPairEndpoint(connections.endpoints));
  let bestPairLink = $derived(
    bestEndpoint ? pairLinkFor(bestEndpoint, connections.activePair) : "",
  );
  let bestPairQr = $derived.by(() => {
    if (!bestPairLink) return null;
    try {
      return pairQrSvgPath(bestPairLink);
    } catch {
      return null;
    }
  });

  const serverDescription = $derived(
    connections.serverInfo
      ? `Running on ${connections.serverInfo.host}:${connections.serverInfo.port} · ${connections.serverInfo.allowLan ? "reachable on your LAN" : "local only"}`
      : "",
  );
</script>

{#if connections.serverInfo}
  <SettingsSection label="Server">
    <SettingsRow label="Status" description={serverDescription}>
      {#snippet labelExtra()}
        <span class="ml-2 inline-block size-2 rounded-full bg-(--solus-status-complete) align-middle"></span>
      {/snippet}
      {#snippet control()}
        <Button
          variant="ghost"
          size="icon-sm"
          onclick={refresh}
          class="text-(--solus-text-tertiary)"
          aria-label="Refresh server status"
        >
          <ArrowsClockwiseIcon size={13} class={connections.refreshing ? "animate-spin" : undefined} />
        </Button>
      {/snippet}
    </SettingsRow>

    <SettingsRow
      label="Allow remote connections"
      description="Bind to your network interfaces. Remote devices must pair before connecting."
    >
      {#snippet control()}
        <Switch
          checked={connections.serverInfo?.remoteAccess ?? false}
          onclick={toggleRemoteAccess}
          disabled={connections.refreshing || connections.remoteAccessUpdating}
          size="default"
          aria-label="Allow remote connections"
        />
      {/snippet}
    </SettingsRow>
  </SettingsSection>
{/if}

<SettingsSection label="Reachable from" visible={connections.endpoints.length > 0}>
  {#each connections.endpoints as endpoint (endpoint.host)}
    {@const EndpointIcon = endpointIcon[endpoint.kind]}
    <div
      class="flex items-center gap-2.5 border-t border-border px-4 py-2.5 first:border-t-0"
    >
      <EndpointIcon size={13} class="shrink-0 text-(--solus-text-tertiary)" />
      <code
        class="min-w-0 flex-1 truncate text-[0.75rem] text-(--solus-text-primary)"
        style="font-family: 'Geist Mono', ui-monospace, monospace"
        >{endpoint.host}:{endpoint.port}</code
      >
      <span class="shrink-0 text-[0.6875rem] text-(--solus-text-tertiary)">{endpoint.label}</span>
    </div>
  {/each}
</SettingsSection>

<HostDirectory />

<SettingsSection label="Pairing fallback">
  {#if !connections.activePair}
    <SettingsRow
      label="Generate a pair code"
      description="Use a one-time code for web, mobile, or environments without SSH."
    >
      {#snippet control()}
        <Button size="sm" onclick={generatePairToken}>
          <PlusIcon size={14} weight="bold" />
          Generate pair code
        </Button>
      {/snippet}
    </SettingsRow>
  {:else}
    <div class="flex flex-col gap-4 p-4">
      <!-- Code display -->
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-3">
          <code
            class="text-[1.75rem] font-semibold tracking-[0.15em] text-(--solus-text-primary) tabular-nums"
            class:opacity-40={pairExpired}
            style="font-family: 'Geist Mono', ui-monospace, monospace"
            >{connections.activePair.code}</code
          >
          <Button
            variant="ghost"
            size="icon-sm"
            onclick={() => copy(connections.activePair!.code, "code")}
            class="text-(--solus-text-tertiary)"
            aria-label="Copy code"
          >
            {#if copiedField === "code"}
              <CheckIcon size={13} class="text-(--solus-status-complete)" />
            {:else}
              <CopyIcon size={13} />
            {/if}
          </Button>
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
          <Button
            variant="ghost"
            size="icon-sm"
            onclick={generatePairToken}
            class="text-(--solus-text-tertiary)"
            aria-label={pairExpired
              ? "Generate new pair code"
              : "Regenerate pair code"}
          >
            <ArrowsClockwiseIcon size={13} />
          </Button>
        </div>
      </div>

      {#if bestPairLink && bestEndpoint && bestPairQr}
        {@const BestIcon = endpointIcon[bestEndpoint.kind]}
        <div
          class="flex flex-col gap-3 rounded-2xl border border-border bg-(--solus-container-bg) p-3 sm:flex-row"
        >
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
              <p class="text-[0.8125rem] font-medium text-(--solus-text-primary)">
                Scan to pair
              </p>
              <p class="mt-1 text-[0.6875rem] leading-4 text-(--solus-text-tertiary)">
                Opens the web client with this one-time token.
              </p>
            </div>
            <div
              class="flex min-w-0 items-center gap-2 rounded-lg bg-(--solus-surface-hover) py-1.5 pl-2.5 pr-1.5"
            >
              <BestIcon size={12} class="shrink-0 text-(--solus-text-tertiary)" />
              <code
                class="min-w-0 flex-1 truncate text-[0.6875rem] text-(--solus-text-secondary)"
                style="font-family: 'Geist Mono', ui-monospace, monospace"
                >{bestPairLink}</code
              >
              <Button
                variant="ghost"
                size="icon-sm"
                onclick={() => copy(bestPairLink, "best-link")}
                class="shrink-0 text-(--solus-text-tertiary)"
                aria-label="Copy best pair link"
              >
                {#if copiedField === "best-link"}
                  <CheckIcon size={12} class="text-(--solus-status-complete)" />
                {:else}
                  <CopyIcon size={12} />
                {/if}
              </Button>
            </div>
          </div>
        </div>
      {/if}

      <!-- Pair links per endpoint -->
      {#if connections.endpoints.length > 0}
        <div class="flex flex-col gap-1.5">
          <p class="text-[0.6875rem] text-(--solus-text-tertiary)">
            Other direct links:
          </p>
          {#each connections.endpoints as endpoint (endpoint.host)}
            {@const link = pairLinkFor(endpoint, connections.activePair)}
            {@const PairIcon = endpointIcon[endpoint.kind]}
            <div
              class="group flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-(--solus-surface-hover)"
            >
              <PairIcon size={11} class="shrink-0 text-(--solus-text-tertiary)" />
              <code
                class="min-w-0 flex-1 truncate text-[0.6875rem] text-(--solus-text-secondary)"
                style="font-family: 'Geist Mono', ui-monospace, monospace"
                >{link}</code
              >
              <Button
                variant="ghost"
                size="icon-xs"
                onclick={() => copy(link, endpoint.host)}
                class="text-(--solus-text-tertiary) opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                aria-label="Copy link"
              >
                {#if copiedField === endpoint.host}
                  <CheckIcon size={11} class="text-(--solus-status-complete)" />
                {:else}
                  <CopyIcon size={11} />
                {/if}
              </Button>
            </div>
          {/each}
        </div>
      {/if}

      <Button
        variant="outline"
        size="sm"
        class="self-start"
        onclick={() => {
          connections.activePair = null;
        }}
      >
        Dismiss
      </Button>
    </div>
  {/if}
</SettingsSection>

<SettingsSection label="Connected devices">
  {#if connections.sessions.length === 0}
    <div class="flex flex-col items-center justify-center gap-2 py-8">
      <div
        class="flex size-10 items-center justify-center rounded-xl bg-(--solus-surface-hover)"
      >
        <MonitorIcon size={20} class="text-(--solus-text-tertiary)" />
      </div>
      <p class="text-[0.8125rem] text-(--solus-text-tertiary)">
        No devices connected
      </p>
      <p class="text-[0.6875rem] text-(--solus-text-tertiary) opacity-70">
        Pair a device to get started
      </p>
    </div>
  {:else}
    {#each connections.sessions as session (session.id)}
      <div
        class="group flex items-center gap-3 border-t border-border px-4 py-2.5 first:border-t-0"
      >
        <div
          class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-(--solus-surface-hover)"
        >
          <MonitorIcon size={14} class="text-(--solus-text-tertiary)" />
        </div>
        <div class="min-w-0 flex-1">
          <p class="truncate text-[0.8125rem] font-medium text-(--solus-text-primary)">
            {session.deviceLabel}
          </p>
          <p class="text-[0.6875rem] text-(--solus-text-tertiary)">
            {relativeTime(session.connectedAt)}
            {#if session.connectionCount > 1}
              &middot; {session.connectionCount} connections
            {/if}
          </p>
        </div>
        {#if session.deviceId}
          <Button
            variant="ghost"
            size="icon-sm"
            onclick={() => revoke(session.deviceId)}
            class="text-(--solus-text-tertiary) opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-(--solus-status-error)/10 hover:text-(--solus-status-error)"
            aria-label="Revoke device"
          >
            <TrashIcon size={13} />
          </Button>
        {/if}
      </div>
    {/each}
  {/if}
</SettingsSection>
