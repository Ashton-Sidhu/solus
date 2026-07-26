<script lang="ts">
  import { onMount } from "svelte";
  import {
    ArrowsClockwiseIcon,
    CheckCircleIcon,
    CircleNotchIcon,
    DesktopTowerIcon,
    GlobeSimpleIcon,
    TrashIcon,
    WifiHighIcon,
  } from "phosphor-svelte";
  import { serversStore } from "../../contexts";
  import { Button } from "../ui/button";
  import { discoveredServerUrl } from "./discovery";
  import { relativeTime } from "./lib/relative-time";
  import { hostStatusLabel } from "./lib/host-affinity";
  import { hostReadinessSummary } from "./lib/host-onboarding";
  import { hostOnboardingStore } from "./host-onboarding.store.svelte";

  // The registry can point at a host that is no longer saved, so trust the
  // resolved active server rather than the stored id.
  const activeServerId = $derived(serversStore.activeServer?.id ?? null);

  onMount(() => {
    void serversStore.probeRunOnServers();
  });

  // Readiness is network-free on the host, so a row can afford to ask rather
  // than hide "needs setup" behind a click.
  $effect(() => {
    for (const server of serversStore.servers) {
      if (serversStore.statusFor(server.id) !== "online") continue;
      if (hostOnboardingStore.hasProbed(server.id)) continue;
      void hostOnboardingStore.probeHost(server.id);
    }
  });
</script>

<div class="flex flex-col gap-5">
  <section class="flex flex-col gap-2">
    <div class="flex min-h-7 items-center justify-between gap-3">
      <p
        class="text-[0.6875rem] font-medium uppercase tracking-wider text-(--solus-text-tertiary)"
      >
        Saved hosts
      </p>
    </div>

    {#if serversStore.servers.length === 0}
      <p
        class="rounded-xl border border-dashed border-(--solus-container-border) px-3 py-5 text-pretty text-center text-[0.75rem] text-(--solus-text-tertiary)"
      >
        No hosts have been saved yet.
      </p>
    {:else}
      <div
        class="overflow-hidden rounded-xl border border-(--solus-container-border)"
      >
        {#each serversStore.servers as server (server.id)}
          {@const status = serversStore.statusFor(server.id)}
          {@const isActive = server.id === activeServerId}
          {@const readiness = hostOnboardingStore.hasProbed(server.id)
              ? hostReadinessSummary(
                hostOnboardingStore.stepsFor(server.id),
              )
            : null}
          <div
            class="group flex items-center gap-3 border-b border-(--solus-container-border)/60 px-3 py-2.5 transition-[background-color] last:border-b-0 hover:bg-(--solus-surface-hover) {isActive
              ? 'bg-[color-mix(in_srgb,var(--solus-accent)_6%,transparent)]'
              : ''}"
          >
            <span
              class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-(--solus-surface-hover) text-(--solus-text-tertiary)"
            >
              {#if server.local}
                <DesktopTowerIcon size={15} />
              {:else}
                <GlobeSimpleIcon size={15} />
              {/if}
            </span>
            <div class="min-w-0 flex-1">
              <p
                class="truncate text-[0.8125rem] font-medium text-(--solus-text-primary)"
              >
                {server.label}
              </p>
              <div
                class="mt-0.5 flex min-w-0 items-center gap-2 text-[0.6875rem] text-(--solus-text-tertiary)"
              >
                <code
                  class="truncate"
                  style="font-family: 'Geist Mono', ui-monospace, monospace"
                >
                  {server.url}
                </code>
                <span aria-hidden="true">·</span>
                <span
                  class="shrink-0 {status === 'offline'
                    ? 'text-(--solus-status-error)'
                    : ''}">{hostStatusLabel(status)}</span
                >
                {#if readiness}
                  <span aria-hidden="true">·</span>
                  <span
                    class="shrink-0 {readiness.ready
                      ? ''
                      : 'text-(--solus-accent)'}"
                  >
                    {readiness.ready ? "Ready" : "Needs setup"}
                  </span>
                {/if}
              </div>
            </div>
            <div class="flex shrink-0 items-center gap-1">
              {#if status === "online" && (!readiness || !readiness.ready)}
                <Button
                  variant="ghost"
                  size="sm"
                  class="text-(--solus-accent) hover:text-(--solus-accent)"
                  title="Finish setting up {server.label} so it can clone, run a session and push it back"
                  onclick={() =>
                    hostOnboardingStore.open({
                      id: server.id,
                      label: server.label,
                    })}
                >
                  Set up
                </Button>
              {/if}
              {#if isActive && status === "online"}
                <span
                  class="inline-flex h-8 items-center gap-1.5 px-1 text-[0.75rem] font-medium text-(--solus-status-complete)"
                >
                  <CheckCircleIcon size={14} weight="fill" />
                  Connected
                </span>
              {:else if isActive && status === "connecting"}
                <span
                  class="inline-flex h-8 items-center gap-1.5 px-1 text-[0.75rem] font-medium text-(--solus-text-tertiary)"
                >
                  <CircleNotchIcon size={13} class="animate-spin" />
                  Connecting…
                </span>
              {:else if isActive}
                <Button
                  variant="outline"
                  onclick={() => serversStore.retryActive()}
                >
                  <ArrowsClockwiseIcon size={13} />
                  Retry
                </Button>
              {:else}
                <Button
                  variant="outline"
                  class="text-(--solus-text-secondary)"
                  onclick={() => serversStore.switchTo(server.id)}
                >
                  Switch
                </Button>
              {/if}
              {#if server.local}
                <span class="size-7 shrink-0"></span>
              {:else}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Forget {server.label}"
                  title="Forget this host — you'll need to pair again"
                  class="text-(--solus-text-quaternary) opacity-0 transition-[opacity,color] hover:text-(--solus-status-error) focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
                  onclick={() => serversStore.remove(server.id)}
                >
                  <TrashIcon size={13} />
                </Button>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </section>

  <section class="flex flex-col gap-2">
    <div class="flex min-h-7 items-center justify-between gap-3">
      <p
        class="text-[0.6875rem] font-medium uppercase tracking-wider text-(--solus-text-tertiary)"
      >
        Nearby
      </p>
      <Button
        variant="ghost"
        size="sm"
        class="text-(--solus-text-tertiary) hover:text-(--solus-text-primary)"
        disabled={serversStore.discoveryBusy}
        aria-label="Scan for nearby hosts"
        onclick={() => void serversStore.scanForServers()}
      >
        <ArrowsClockwiseIcon
          size={13}
          class={serversStore.discoveryBusy ? "animate-spin" : ""}
        />
        {serversStore.discoveryBusy ? "Scanning…" : "Scan"}
      </Button>
    </div>

    {#if serversStore.nearbyHosts.length === 0}
      <div
        class="rounded-xl border border-dashed border-(--solus-container-border) px-3 py-5 text-pretty text-center text-[0.75rem] leading-5 text-(--solus-text-tertiary)"
      >
        No nearby hosts found. A host must have <em
          class="font-medium not-italic text-(--solus-text-secondary)"
          >Allow remote connections</em
        >
        turned on to be discoverable.
      </div>
    {:else}
      <div
        class="overflow-hidden rounded-xl border border-(--solus-container-border)"
      >
        {#each serversStore.nearbyHosts as host (host.server.installationId)}
          <div
            class="group flex items-center gap-3 border-b border-(--solus-container-border)/60 px-3 py-2.5 transition-[background-color] last:border-b-0 hover:bg-(--solus-surface-hover)"
          >
            <span
              class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-(--solus-surface-hover) text-(--solus-text-tertiary)"
            >
              <WifiHighIcon size={15} />
            </span>
            <div class="min-w-0 flex-1">
              <div class="flex min-w-0 items-center gap-2">
                <p
                  class="truncate text-[0.8125rem] font-medium text-(--solus-text-primary)"
                >
                  {host.server.name}
                </p>
                <span
                  class="shrink-0 rounded-full bg-(--solus-surface-active) px-1.5 py-0.5 text-[0.5625rem] font-medium uppercase tracking-wide text-(--solus-text-tertiary)"
                >
                  {host.server.source === "lan" ? "LAN" : "Tailnet"}
                </span>
              </div>
              <div
                class="mt-0.5 flex min-w-0 items-center gap-2 text-[0.6875rem] text-(--solus-text-tertiary)"
              >
                <code
                  class="truncate"
                  style="font-family: 'Geist Mono', ui-monospace, monospace"
                >
                  {discoveredServerUrl(host.server)}
                </code>
                <span aria-hidden="true">·</span>
                <span class="shrink-0 tabular-nums"
                  >{relativeTime(host.lastSeenAt)}</span
                >
              </div>
            </div>
            <div class="flex shrink-0 items-center gap-1">
              <Button
                aria-label={`Connect to ${host.server.name}`}
                onclick={() => hostOnboardingStore.openForDiscovered(host.server)}
              >
                Connect
              </Button>
              <span class="size-7 shrink-0"></span>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </section>
</div>
