<script lang="ts">
  import {
    CheckIcon,
    GearIcon,
    HardDrivesIcon,
    PlusIcon,
    WifiHighIcon,
  } from "phosphor-svelte";
  import {
    discoveredServerUrl,
    getWorkspaceContext,
    hostStatusLabel,
    serversStore,
  } from "@renderer/contexts";
  import { hostOnboardingStore } from "@renderer/components/servers/host-onboarding.store.svelte";
  import { urlHost } from "@client-core/pairing";
  import MobileSheet from "./MobileSheet.svelte";
  import HostOperatingSystemIcon from "@renderer/components/servers/HostOperatingSystemIcon.svelte";

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

  const groupCard = "flex flex-col rounded-2xl overflow-hidden border border-(--solus-container-border) bg-(--solus-surface-hover)";
  const listRow =
    "flex items-center gap-3.5 w-full min-h-12 px-3.5 py-3 border-0 bg-transparent text-left cursor-pointer transition-colors duration-[120ms] ease-[cubic-bezier(0.16,1,0.3,1)] active:bg-(--solus-accent-light) disabled:opacity-40 disabled:cursor-default disabled:active:bg-transparent [-webkit-tap-highlight-color:transparent]";
  const listIcon = "w-5 flex items-center justify-center shrink-0 font-secondary text-(--solus-text-secondary)";
  const rowDivider = "h-px bg-(--solus-container-border) opacity-60 ml-12";
  const sectionLabel = "block px-1 mb-1 mt-3 text-xs font-semibold tracking-[0.03em] uppercase text-(--solus-text-tertiary)";
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
  <div class={groupCard}>
    {#each serversStore.servers as server, index (server.id)}
      {#if index > 0}
        <div class={rowDivider}></div>
      {/if}
      <button class={listRow} onclick={() => connect(server.id)}>
        <span class={listIcon}>
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
    <span class={sectionLabel}>Nearby</span>
    <div class={groupCard}>
      {#each serversStore.nearbyHosts as host, index (host.server.installationId)}
        {#if index > 0}
          <div class={rowDivider}></div>
        {/if}
        <button class={listRow} onclick={() => pairNearby(host.server.installationId)}>
          <span class={listIcon}><WifiHighIcon size={14} /></span>
          <span class="flex-1 min-w-0 flex flex-col gap-px">
            <span class="truncate text-sm font-medium text-(--solus-text-primary)">{host.server.name}</span>
            <span class="truncate text-xs text-(--solus-text-tertiary)" style="font-family: 'Geist Mono', ui-monospace, monospace">
              {urlHost(discoveredServerUrl(host.server))}
            </span>
          </span>
          <span class="shrink-0 text-[0.8125rem] font-medium text-(--solus-accent)">Connect</span>
        </button>
      {/each}
    </div>
  {/if}

  <div class="mt-3 {groupCard}">
    <button class={listRow} onclick={addServer}>
      <span class={listIcon}><PlusIcon size={14} /></span>
      <span class="flex-1 min-w-0 truncate text-sm font-medium text-(--solus-text-primary)">Add server</span>
    </button>
    <div class={rowDivider}></div>
    <button class={listRow} onclick={manageServers}>
      <span class={listIcon}><GearIcon size={14} /></span>
      <span class="flex-1 min-w-0 truncate text-sm font-medium text-(--solus-text-primary)">Manage servers</span>
    </button>
  </div>
</MobileSheet>
