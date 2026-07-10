<script lang="ts">
  import {
    CheckIcon,
    DesktopTowerIcon,
    GlobeSimpleIcon,
    MagnifyingGlassIcon,
    PlusIcon,
    TrashIcon,
  } from "phosphor-svelte";
  import {
    connectionStatusLabel,
    presentedConnectionStatus,
  } from "@client-core/connection-display";
  import Dropdown from "../ui/Dropdown.svelte";
  import { tooltip } from "../../lib/tooltip";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { serversStore, type ServerItem, type ServerItemStatus } from "./servers.store.svelte";

  let open = $state(false);
  let triggerEl: HTMLButtonElement | null = $state(null);
  const active = $derived(serversStore.activeServer);
  const activePresentedStatus = $derived(
    presentedConnectionStatus(serversStore.connectionStatus, {
      attempt: serversStore.reconnectAttempt,
      hasConnected: serversStore.hasConnected,
    }),
  );
  const activeStatusLabel = $derived(
    connectionStatusLabel(serversStore.connectionStatus, {
      attempt: serversStore.reconnectAttempt,
      hasConnected: serversStore.hasConnected,
    }),
  );

  function statusLabel(server: ServerItem): string {
    if (server.id === serversStore.activeServerId) return activeStatusLabel;
    const status = server.status;
    if (status === "online") return "Online";
    if (status === "connecting") return "Reconnecting";
    if (status === "offline") return "Offline";
    return "Saved";
  }

  function dotClass(status: ServerItemStatus): string {
    if (status === "online") return "bg-(--solus-status-complete)";
    if (status === "connecting") return "bg-(--solus-accent)";
    if (status === "offline") return "bg-(--solus-status-error)";
    return "bg-(--solus-text-quaternary)";
  }

  function switchTo(server: ServerItem) {
    open = false;
    serversStore.switchTo(server.id);
  }

  function remove(event: MouseEvent, server: ServerItem) {
    event.stopPropagation();
    event.preventDefault();
    serversStore.remove(server.id);
  }

  function addServer() {
    open = false;
    serversStore.openAddServer();
  }

  function scanServers() {
    open = false;
    void serversStore.scanForServers({ manual: true });
    requestInputFocus();
  }

  function closeAndFocus() {
    open = false;
    requestInputFocus();
  }
</script>

<button
  bind:this={triggerEl}
  type="button"
  class="group relative inline-flex h-7 max-w-[11rem] items-center gap-1.5 rounded-lg px-2 text-[0.75rem] text-(--solus-text-tertiary) transition-[background-color,color,transform] hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--solus-input-focus-ring)"
  aria-haspopup="menu"
  aria-expanded={open}
  onclick={() => (open = !open)}
  use:tooltip={active ? `${active.label} · ${activeStatusLabel}` : "Servers"}
>
  <span class="relative flex h-3 w-3 shrink-0 items-center justify-center">
    <span
      class={`h-2 w-2 rounded-full ${active ? dotClass(active.status) : "bg-(--solus-text-quaternary)"} ${activePresentedStatus === "connecting" || activePresentedStatus === "reconnecting" ? "animate-pulse" : ""}`}
    ></span>
  </span>
  <span class="truncate">{active?.label ?? "Servers"}</span>
</button>

<Dropdown bind:open {triggerEl} width={284} anchor="right">
  <div class="py-1" role="menu" aria-label="Servers">
    {#each serversStore.servers as server (server.id)}
      <div class="group/item flex items-center">
        <button
          type="button"
          role="menuitem"
          class="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-[0.75rem] transition-[background-color,color] hover:bg-(--solus-accent-light) focus-visible:bg-(--solus-accent-light) focus-visible:outline-none"
          onclick={() => switchTo(server)}
        >
          <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-(--solus-surface-hover) text-(--solus-text-tertiary)">
            {#if server.local}
              <DesktopTowerIcon size={14} />
            {:else}
              <GlobeSimpleIcon size={14} />
            {/if}
          </span>
          <span class="min-w-0 flex-1">
            <span class="flex min-w-0 items-center gap-1.5">
              <span class="truncate font-medium text-(--solus-text-primary)">{server.label}</span>
              <span
                class="h-1.5 w-1.5 shrink-0 rounded-full {dotClass(server.status)}"
                title={statusLabel(server)}
              ></span>
            </span>
            <span class="mt-0.5 block truncate font-mono text-[0.625rem] text-(--solus-text-tertiary)">{server.url}</span>
          </span>
          {#if server.id === serversStore.activeServerId}
            <CheckIcon size={13} class="text-(--solus-status-complete)" />
          {/if}
        </button>
        {#if !server.local}
          <button
            type="button"
            aria-label="Remove {server.label}"
            class="mr-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-(--solus-text-quaternary) opacity-0 transition-[background-color,color,opacity,transform] hover:bg-(--solus-status-error-bg) hover:text-(--solus-status-error) active:scale-[0.96] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--solus-input-focus-ring) group-hover/item:opacity-100"
            onclick={(event) => remove(event, server)}
          >
            <TrashIcon size={13} />
          </button>
        {/if}
      </div>
    {/each}

    <div class="my-1 h-px bg-(--solus-popover-border)"></div>

    <button
      type="button"
      role="menuitem"
      class="flex w-full items-center gap-2 px-3 py-2 text-[0.75rem] font-medium text-(--solus-text-secondary) transition-[background-color,color] hover:bg-(--solus-accent-light) hover:text-(--solus-text-primary) focus-visible:bg-(--solus-accent-light) focus-visible:outline-none"
      onclick={addServer}
    >
      <PlusIcon size={13} />
      <span>Add server...</span>
    </button>

    <button
      type="button"
      role="menuitem"
      class="flex w-full items-center gap-2 px-3 py-2 text-[0.75rem] font-medium text-(--solus-text-secondary) transition-[background-color,color] hover:bg-(--solus-accent-light) hover:text-(--solus-text-primary) focus-visible:bg-(--solus-accent-light) focus-visible:outline-none"
      onclick={scanServers}
    >
      <MagnifyingGlassIcon size={13} />
      <span>{serversStore.discoveryBusy ? "Scanning..." : "Scan for servers"}</span>
    </button>
  </div>
</Dropdown>

<svelte:window onkeydown={(event) => { if (open && event.key === "Escape") closeAndFocus(); }} />
