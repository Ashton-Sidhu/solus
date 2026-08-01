<script lang="ts">
  /** The pairing act, as rows inside a `SettingsSection`: an invitation to
   *  generate a code, and then the live code with its QR and direct links.
   *  One component because both the Connections list and a host's Access tab
   *  hand out access to the same server. */
  import {
    ArrowsClockwiseIcon,
    CheckIcon,
    CopyIcon,
    GlobeIcon,
    HouseIcon,
    PlusIcon,
    WifiHighIcon,
  } from "phosphor-svelte";
  import { connectionsStore, type ConnectionEndpoint } from "../../contexts";
  import { Button } from "../ui/button";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import { pairQrSvgPath } from "./lib/qrcode";
  import { liveActivityClock } from "../../lib/shared-clock";

  const connections = connectionsStore;
  let copiedField = $state<string | null>(null);

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

  function pairLinkFor(endpoint: ConnectionEndpoint): string {
    const pair = connections.activePair;
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

  let _now = $state(Date.now());
  $effect(() => {
    if (!connections.activePair) return;
    return liveActivityClock.subscribe((value) => { _now = value; });
  });

  let pairMsLeft = $derived(
    connections.activePair ? connections.activePair.expiresAt - _now : 0,
  );
  let pairExpired = $derived(connections.activePair ? pairMsLeft <= 0 : false);
  let pairCountdown = $derived(
    connections.activePair ? formatTimeRemaining(pairMsLeft) : "",
  );
  let bestEndpoint = $derived(
    [...connections.endpoints].sort(
      (a, b) => endpointPriority[a.kind] - endpointPriority[b.kind],
    )[0] ?? null,
  );
  let bestPairLink = $derived(bestEndpoint ? pairLinkFor(bestEndpoint) : "");
  let bestPairQr = $derived.by(() => {
    if (!bestPairLink) return null;
    try {
      return pairQrSvgPath(bestPairLink);
    } catch {
      return null;
    }
  });
</script>

{#if !connections.activePair}
  <SettingsRow
    label="Generate a pair code"
    description="Use a one-time code for web, mobile, or environments without SSH."
  >
    {#snippet control()}
      <Button size="sm" onclick={() => void connections.generatePairToken()}>
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
          onclick={() => void connections.generatePairToken()}
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
              class="min-w-0 flex-1 truncate text-[0.6875rem] font-secondary text-(--solus-text-secondary)"
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
          {@const link = pairLinkFor(endpoint)}
          {@const PairIcon = endpointIcon[endpoint.kind]}
          <div
            class="group flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-(--solus-surface-hover)"
          >
            <PairIcon size={11} class="shrink-0 text-(--solus-text-tertiary)" />
            <code
              class="min-w-0 flex-1 truncate text-[0.6875rem] font-secondary text-(--solus-text-secondary)"
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
