<script lang="ts">
  import {
    Check as CheckIcon,
    Settings as GearIcon,
    Database as HardDrivesIcon,
    Plus as PlusIcon,
    Wifi as WifiHighIcon,
  } from "@lucide/svelte";
  import {
    discoveredServerUrl,
    getWorkspaceContext,
    hostStatusLabel,
    serversStore,
  } from "@solus/workspace-ui/contexts";
  import { hostOnboardingStore } from "@solus/workspace-ui/components/servers/host-onboarding.store.svelte";
  import { urlHost } from "@solus/client-core/pairing";
  import MobileSheet from "./MobileSheet.svelte";
  import HostOperatingSystemIcon from "@solus/workspace-ui/components/servers/HostOperatingSystemIcon.svelte";

  interface Props {
    open: boolean;
    onClose: () => void;
  }
  let { open, onClose }: Props = $props();

  const session = getWorkspaceContext();

  $effect(() => {
    if (open) void serversStore.probeHosts();
  });

  const activeId = $derived(serversStore.activeServer?.id ?? null);

  function connect(serverId: string) {
    onClose();
    // Same-server taps no-op inside switchTo; a real switch reloads into it.
    serversStore.switchTo(serverId);
  }

  function pairNearby(installationId: string) {
    const host = serversStore.nearby.get(installationId);
    if (!host) return;
    onClose();
    hostOnboardingStore.openForDiscovered(host.server);
  }

  function manageServers() {
    onClose();
    session.showSettings("api-access");
  }

  function addServer() {
    onClose();
    serversStore.openAddServer();
  }

</script>

{#snippet statusDot(status: "online" | "connecting" | "offline" | "saved" | "different-server")}
  <span
    class="shrink-0 w-2 h-2 rounded-full {status === 'online'
      ? 'bg-(--solus-status-complete)'
      : status === 'connecting'
        ? 'bg-(--solus-accent) animate-pulse'
        : status === 'different-server'
          ? 'bg-(--solus-status-error)'
        : 'bg-(--solus-text-quaternary) opacity-60'}"
    aria-label={hostStatusLabel(status)}
  ></span>
{/snippet}

<MobileSheet {open} {onClose} title="Servers">
  <div class="px-4">
  <div class="flex flex-col overflow-hidden rounded-2xl border border-(--solus-container-border) bg-(--solus-surface-hover)">
    {#each serversStore.servers as server, index (server.id)}
      {#if index > 0}
        <div class="ml-12 h-px bg-(--solus-container-border) opacity-60"></div>
      {/if}
      <button class="flex w-full min-h-12 cursor-pointer items-center gap-3.5 border-0 bg-transparent px-3.5 py-3 text-left transition-colors duration-[120ms] ease-[cubic-bezier(0.16,1,0.3,1)] active:bg-(--solus-accent-light) disabled:cursor-default disabled:opacity-40 disabled:active:bg-transparent [-webkit-tap-highlight-color:transparent]" onclick={() => connect(server.id)}>
        <span class="flex w-5 shrink-0 items-center justify-center font-secondary text-(--solus-text-secondary)">
          <!-- The OS logo marks a machine you dispatch to; the host you are
               on keeps the plain device glyph. -->
          {#if server.local}
            <HardDrivesIcon size={14} />
          {:else}
            <HostOperatingSystemIcon os={server.os} size={14} />
          {/if}
        </span>
        <span class="flex-1 min-w-0 flex flex-col gap-px">
          <span class="truncate text-sm font-medium text-(--solus-text-primary)">{server.label}</span>
          <span class="truncate text-xs text-(--solus-text-tertiary)" style="font-family: 'Geist Mono', ui-monospace, monospace">
            {urlHost(server.url)} · {hostStatusLabel(server.status)}
          </span>
        </span>
        {#if server.id === activeId}
          <CheckIcon size={14} class="shrink-0 text-(--solus-accent)" />
        {:else}
          {@render statusDot(server.status)}
        {/if}
      </button>
    {/each}
  </div>

  {#if serversStore.nearbyHosts.length > 0}
    <span class="mt-3 mb-1 block px-1 text-xs font-semibold tracking-[0.03em] uppercase text-(--solus-text-tertiary)">Nearby</span>
    <div class="flex flex-col overflow-hidden rounded-2xl border border-(--solus-container-border) bg-(--solus-surface-hover)">
      {#each serversStore.nearbyHosts as host, index (host.server.installationId)}
        {#if index > 0}
          <div class="ml-12 h-px bg-(--solus-container-border) opacity-60"></div>
        {/if}
        <button class="flex w-full min-h-12 cursor-pointer items-center gap-3.5 border-0 bg-transparent px-3.5 py-3 text-left transition-colors duration-[120ms] ease-[cubic-bezier(0.16,1,0.3,1)] active:bg-(--solus-accent-light) disabled:cursor-default disabled:opacity-40 disabled:active:bg-transparent [-webkit-tap-highlight-color:transparent]" onclick={() => pairNearby(host.server.installationId)}>
          <span class="flex w-5 shrink-0 items-center justify-center font-secondary text-(--solus-text-secondary)"><WifiHighIcon size={14} /></span>
          <span class="flex-1 min-w-0 flex flex-col gap-px">
            <span class="truncate text-sm font-medium text-(--solus-text-primary)">{host.server.name}</span>
            <span class="truncate text-xs text-(--solus-text-tertiary)" style="font-family: 'Geist Mono', ui-monospace, monospace">
              {urlHost(discoveredServerUrl(host.server))}
            </span>
          </span>
          <span class="shrink-0 text-sm font-medium text-(--solus-accent)">Connect</span>
        </button>
      {/each}
    </div>
  {/if}

  <div class="mt-3 flex flex-col overflow-hidden rounded-2xl border border-(--solus-container-border) bg-(--solus-surface-hover)">
    <button class="flex w-full min-h-12 cursor-pointer items-center gap-3.5 border-0 bg-transparent px-3.5 py-3 text-left transition-colors duration-[120ms] ease-[cubic-bezier(0.16,1,0.3,1)] active:bg-(--solus-accent-light) disabled:cursor-default disabled:opacity-40 disabled:active:bg-transparent [-webkit-tap-highlight-color:transparent]" onclick={addServer}>
      <span class="flex w-5 shrink-0 items-center justify-center font-secondary text-(--solus-text-secondary)"><PlusIcon size={14} /></span>
      <span class="flex-1 min-w-0 truncate text-sm font-medium text-(--solus-text-primary)">Add server</span>
    </button>
    <div class="ml-12 h-px bg-(--solus-container-border) opacity-60"></div>
    <button class="flex w-full min-h-12 cursor-pointer items-center gap-3.5 border-0 bg-transparent px-3.5 py-3 text-left transition-colors duration-[120ms] ease-[cubic-bezier(0.16,1,0.3,1)] active:bg-(--solus-accent-light) disabled:cursor-default disabled:opacity-40 disabled:active:bg-transparent [-webkit-tap-highlight-color:transparent]" onclick={manageServers}>
      <span class="flex w-5 shrink-0 items-center justify-center font-secondary text-(--solus-text-secondary)"><GearIcon size={14} /></span>
      <span class="flex-1 min-w-0 truncate text-sm font-medium text-(--solus-text-primary)">Manage servers</span>
    </button>
  </div>
  </div>
</MobileSheet>
