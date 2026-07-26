<script lang="ts">
  import {
    ArrowsClockwiseIcon,
    CheckIcon,
    DesktopTowerIcon,
    GlobeSimpleIcon,
    PlusIcon,
    TrashIcon,
    WifiHighIcon,
  } from "phosphor-svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { tooltip } from "../../lib/tooltip";
  import { requestInputFocus } from "../../lib/inputFocus";
  import {
    serversStore,
    toasts,
    type ServerItem,
    type ServerItemStatus,
  } from "../../contexts";
  import { hostStatusLabel } from "./lib/host-affinity";
  import { hostOnboardingStore } from "./host-onboarding.store.svelte";

  const active = $derived(serversStore.activeServer);

  function dotClass(status: ServerItemStatus): string {
    if (status === "online") return "bg-(--solus-status-complete)";
    if (status === "connecting") return "bg-(--solus-accent)";
    if (status === "offline") return "bg-(--solus-status-error)";
    return "bg-(--solus-text-quaternary)";
  }

  function switchTo(server: ServerItem) {
    serversStore.switcherOpen = false;
    serversStore.switchTo(server.id);
  }

  function remove(event: MouseEvent, server: ServerItem) {
    event.stopPropagation();
    event.preventDefault();
    serversStore.remove(server.id);
  }

  function addServer() {
    serversStore.switcherOpen = false;
    serversStore.openAddServer();
  }

  async function scanServers() {
    const result = await serversStore.scanForServers();
    if (result && "error" in result) {
      toasts.error(`Server scan failed: ${result.error}`);
    }
  }
</script>

<DropdownMenu.Root
  bind:open={serversStore.switcherOpen}
  onOpenChange={(next) => {
    if (!next) requestInputFocus();
  }}
>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <button
        {...props}
        type="button"
        class="group relative inline-flex h-8 max-w-[11rem] items-center gap-1.5 rounded-lg px-2 text-[0.8125rem] text-(--solus-text-tertiary) transition-[background-color,color,transform] hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--solus-input-focus-ring)"
        use:tooltip={active
          ? `${active.label} · ${hostStatusLabel(active.status)}`
          : "Servers"}
      >
        <span
          class="relative flex h-3 w-3 shrink-0 items-center justify-center"
        >
          <span
            class={`h-2 w-2 rounded-full ${active ? dotClass(active.status) : "bg-(--solus-text-quaternary)"} ${active?.status === "connecting" ? "animate-pulse" : ""}`}
          ></span>
        </span>
        <span class="truncate">{active?.label ?? "Servers"}</span>
      </button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content
    side="bottom"
    align="end"
    sideOffset={6}
    class="w-[288px]"
    aria-label="Servers"
  >
    <div
      class="px-3 pb-1 pt-1.5 text-[0.625rem] font-medium uppercase tracking-[0.08em] text-(--solus-text-quaternary)"
    >
      Servers
    </div>

    {#each serversStore.servers as server (server.id)}
      <DropdownMenu.Item
        class="group/item gap-2.5 py-2 text-[0.75rem]"
        onSelect={() => switchTo(server)}
      >
        <span
          class="relative flex size-7 shrink-0 items-center justify-center rounded-lg bg-(--solus-surface-hover) text-(--solus-text-tertiary) transition-[background-color,color] group-hover/item:bg-(--solus-surface-active) group-hover/item:text-(--solus-text-secondary)"
        >
          {#if server.local}
            <DesktopTowerIcon class="size-3.5" />
          {:else}
            <GlobeSimpleIcon class="size-3.5" />
          {/if}
          <span
            class="absolute -bottom-px -right-px size-2 rounded-full ring-2 ring-(--solus-popover-bg) {dotClass(
              server.status,
            )}"
            title={hostStatusLabel(server.status)}
          ></span>
        </span>
        <span class="min-w-0 flex-1">
          <span class="block truncate font-medium text-(--solus-text-primary)"
            >{server.label}</span
          >
          <span
            class="mt-0.5 block truncate font-mono text-[0.625rem] tabular-nums text-(--solus-text-quaternary)"
            >{server.url}</span
          >
        </span>
        {#if server.id === serversStore.activeServerId}
          <CheckIcon class="size-3.5 shrink-0 text-(--solus-accent)" />
        {/if}
        {#if !server.local}
          <button
            type="button"
            aria-label="Remove {server.label}"
            class="relative -mr-1 flex size-7 shrink-0 items-center justify-center rounded-lg text-(--solus-text-quaternary) opacity-0 transition-[background-color,color,opacity,scale] hover:bg-(--solus-status-error-bg) hover:text-(--solus-status-error) active:scale-[0.96] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--solus-input-focus-ring) group-hover/item:opacity-100 after:absolute after:left-1/2 after:top-1/2 after:size-10 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']"
            onpointerdown={(event) => event.stopPropagation()}
            onpointerup={(event) => event.stopPropagation()}
            onclick={(event) => remove(event, server)}
          >
            <TrashIcon class="size-3.5" />
          </button>
        {/if}
      </DropdownMenu.Item>
    {/each}

    <div class="flex items-center justify-between gap-2 px-3 pb-1 pt-2.5">
      <span
        class="text-[0.625rem] font-medium uppercase tracking-[0.08em] text-(--solus-text-quaternary)"
      >
        Nearby
      </span>
      <button
        type="button"
        aria-label="Scan for nearby hosts"
        disabled={serversStore.discoveryBusy}
        class="relative -mr-1 flex size-6 items-center justify-center rounded-lg text-(--solus-text-quaternary) transition-[background-color,color,scale] hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--solus-input-focus-ring) disabled:pointer-events-none disabled:text-(--solus-text-quaternary) after:absolute after:left-1/2 after:top-1/2 after:size-10 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']"
        onclick={() => void scanServers()}
        use:tooltip={serversStore.discoveryBusy
          ? "Scanning…"
          : "Scan for servers"}
      >
        <ArrowsClockwiseIcon
          class="size-3 {serversStore.discoveryBusy ? 'animate-spin' : ''}"
        />
      </button>
    </div>

    {#if serversStore.nearbyHosts.length === 0}
      <div
        class="px-3 pb-2 pt-0.5 text-[0.6875rem] text-(--solus-text-quaternary)"
      >
        {serversStore.discoveryBusy
          ? "Looking for Solus hosts…"
          : "No other Solus hosts found"}
      </div>
    {:else}
      {#each serversStore.nearbyHosts as host (host.server.installationId)}
        <DropdownMenu.Item
          class="group/item gap-2.5 py-2 text-[0.75rem]"
          onSelect={(event) => event.preventDefault()}
        >
          <span
            class="flex size-7 shrink-0 items-center justify-center rounded-lg border border-dashed border-(--solus-popover-border) text-(--solus-text-quaternary) transition-colors group-hover/item:text-(--solus-text-tertiary)"
            title="Nearby host"
          >
            <WifiHighIcon class="size-3.5" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="flex min-w-0 items-center gap-1.5">
              <span class="truncate font-medium text-(--solus-text-primary)"
                >{host.server.name}</span
              >
              <span
                class="shrink-0 rounded-full bg-(--solus-surface-hover) px-1.5 py-px text-[0.5625rem] font-medium uppercase tracking-[0.06em] text-(--solus-text-quaternary)"
              >
                {host.server.source === "lan" ? "LAN" : "Tailnet"}
              </span>
            </span>
            <span
              class="mt-0.5 block truncate font-mono text-[0.625rem] tabular-nums text-(--solus-text-quaternary)"
            >
              {host.server.host}:{host.server.port}
            </span>
          </span>
          <button
            type="button"
            aria-label={`Connect to ${host.server.name}`}
            class="relative -mr-1 inline-flex h-6 shrink-0 items-center rounded-full bg-(--solus-accent-light) px-2.5 text-[0.6875rem] font-medium text-(--solus-accent) transition-[background-color,scale] hover:bg-(--solus-accent) hover:text-(--solus-text-on-accent) active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--solus-input-focus-ring) after:absolute after:left-1/2 after:top-1/2 after:h-10 after:w-full after:min-w-10 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']"
            onpointerdown={(event) => event.stopPropagation()}
            onclick={(event) => {
              event.stopPropagation();
              hostOnboardingStore.openForDiscovered(host.server);
            }}
          >
            Connect
          </button>
        </DropdownMenu.Item>
      {/each}
    {/if}

    <DropdownMenu.Separator class="bg-(--solus-popover-border)" />

    <DropdownMenu.Item
      class="gap-2.5 py-2 text-[0.75rem] font-medium"
      onSelect={addServer}
    >
      <span
        class="flex size-7 shrink-0 items-center justify-center text-(--solus-text-tertiary)"
      >
        <PlusIcon class="size-3.5" />
      </span>
      <span>Add server…</span>
    </DropdownMenu.Item>
  </DropdownMenu.Content>
</DropdownMenu.Root>
