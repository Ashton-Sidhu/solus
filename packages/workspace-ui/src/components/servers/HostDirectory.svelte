<script lang="ts">
  import { onMount } from "svelte";
  import {
    ArrowsClockwiseIcon,
    CaretRightIcon,
    DesktopTowerIcon,
    PlusIcon,
    WifiHighIcon,
  } from "phosphor-svelte";
  import { discoveredServerUrl, hostStatusLabel, serversStore } from "../../contexts";
  import { Button } from "../ui/button";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import { connectionsNav } from "../connections/connections-nav.svelte";
  import { relativeTime } from "../../lib/relative-time";
  import { hostReadinessSummary } from "./lib/host-onboarding";
  import { hostSetupStore } from "./host-setup.store.svelte";
  import { hostOnboardingStore } from "./host-onboarding.store.svelte";
  import HostOperatingSystemIcon from "./HostOperatingSystemIcon.svelte";

  // The registry can point at a host that is no longer saved, so trust the
  // resolved active server rather than the stored id.
  const activeServerId = $derived(serversStore.activeServer?.id ?? null);

  onMount(() => {
    void serversStore.probeHosts().then(() =>
      hostSetupStore.probeUnprobedOnline(serversStore.servers),
    );
  });

  /** The one line under a host name: where it answers, and what it can do. */
  function hostMeta(serverId: string, url: string): string {
    const status = hostStatusLabel(serversStore.statusFor(serverId));
    if (!hostSetupStore.hasProbed(serverId)) return `${url} · ${status}`;
    const summary = hostReadinessSummary(hostSetupStore.stepsFor(serverId));
    return `${url} · ${status} · ${summary.ready ? "Ready" : "Needs setup"}`;
  }
</script>

<SettingsSection label="Hosts">
  {#snippet action()}
    <Button
      variant="ghost"
      size="sm"
      class="-my-1 text-(--solus-text-tertiary) hover:text-(--solus-text-primary)"
      onclick={() => serversStore.openAddServer()}
    >
      <PlusIcon size={13} weight="bold" />
      Add host
    </Button>
  {/snippet}

  {#if serversStore.servers.length === 0}
    <p class="px-4 py-6 text-center text-xs text-(--solus-text-tertiary)">
      No hosts have been saved yet.
    </p>
  {:else}
    {#each serversStore.servers as server (server.id)}
      {@const isActive = server.id === activeServerId}
      <button
        type="button"
        class="flex w-full items-center gap-3 border-t border-border px-4 py-3 text-left transition-colors first:border-t-0 [@media(hover:hover)]:hover:bg-muted"
        onclick={() => connectionsNav.open(server.id)}
      >
        <span
          class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-(--solus-surface-hover) text-(--solus-text-tertiary)"
        >
          <!-- The OS logo marks a machine you dispatch to; the host you are
               on keeps the plain device glyph. -->
          {#if server.local}
            <DesktopTowerIcon size={15} />
          {:else}
            <HostOperatingSystemIcon os={server.os} size={15} />
          {/if}
        </span>
        <span class="min-w-0 flex-1">
          <span
            class="flex min-w-0 items-center gap-2 text-sm font-medium text-(--solus-text-primary)"
          >
            <span class="truncate">{server.label}</span>
            {#if isActive}
              <span
                class="shrink-0 whitespace-nowrap rounded-full bg-(--solus-accent-light) px-1.5 py-0.5 text-xs leading-[1.4] font-medium uppercase tracking-[0.04em] text-(--solus-accent) sm:text-xs"
              >
                Running sessions
              </span>
            {/if}
          </span>
          <span
            class="mt-0.5 block truncate text-xs text-(--solus-text-tertiary)"
            style="font-family: 'Geist Mono', ui-monospace, monospace"
          >
            {hostMeta(server.id, server.url)}
          </span>
        </span>
        <CaretRightIcon size={13} class="shrink-0 text-(--solus-text-quaternary)" />
      </button>
    {/each}
  {/if}
</SettingsSection>

<SettingsSection label="Nearby">
  {#snippet action()}
    <Button
      variant="ghost"
      size="sm"
      class="-my-1 text-(--solus-text-tertiary) hover:text-(--solus-text-primary)"
      disabled={serversStore.discoveryBusy}
      onclick={() => void serversStore.scanForServers()}
    >
      <ArrowsClockwiseIcon
        size={13}
        class={serversStore.discoveryBusy ? "animate-spin" : ""}
      />
      {serversStore.discoveryBusy ? "Scanning…" : "Scan again"}
    </Button>
  {/snippet}

  {#each serversStore.nearbyHosts as host (host.server.installationId)}
    <div class="flex items-center gap-3 border-t border-border px-4 py-3 first:border-t-0">
      <span
        class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-(--solus-surface-hover) text-(--solus-text-tertiary)"
      >
        <WifiHighIcon size={15} />
      </span>
      <div class="min-w-0 flex-1">
        <div class="flex min-w-0 items-center gap-2">
          <p class="truncate text-sm font-medium text-(--solus-text-primary)">
            {host.server.name}
          </p>
          <span
            class="shrink-0 whitespace-nowrap rounded-full bg-(--solus-surface-active) px-1.5 py-0.5 text-xs leading-[1.4] font-medium uppercase tracking-[0.04em] text-(--solus-text-tertiary) sm:text-xs"
          >
            {host.server.source === "lan" ? "LAN" : "Tailnet"}
          </span>
        </div>
        <p
          class="mt-0.5 truncate text-xs text-(--solus-text-tertiary)"
          style="font-family: 'Geist Mono', ui-monospace, monospace"
        >
          {discoveredServerUrl(host.server)} · {relativeTime(host.lastSeenAt)}
        </p>
      </div>
      <Button
        class="shrink-0"
        aria-label={`Connect to ${host.server.name}`}
        onclick={() => hostOnboardingStore.openForDiscovered(host.server)}
      >
        Connect
      </Button>
    </div>
  {/each}

  <!-- Always present, whether or not anything was found: discovery failing
       silently is the same picture as a network with no hosts on it, and this
       is the only place that says which one the user is looking at. -->
  <div class="border-t border-border px-4 py-3 first:border-t-0">
    <p class="text-pretty text-xs leading-5 text-(--solus-text-tertiary)">
      {#if serversStore.nearbyHosts.length === 0}
        No nearby hosts found.
      {/if}
      A host must have <em class="font-medium not-italic text-(--solus-text-secondary)"
        >Allow remote connections</em
      > turned on to be discoverable.
      <button
        type="button"
        class="text-(--solus-accent) hover:underline"
        onclick={() => serversStore.openAddServer()}
      >
        Add one by address
      </button>
      instead.
    </p>
  </div>
</SettingsSection>
