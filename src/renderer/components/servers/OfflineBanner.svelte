<script lang="ts">
  import { ArrowClockwiseIcon, WifiXIcon } from "phosphor-svelte";
  import { connectionStatusLabel } from "@client-core/connection-display";
  import { serversStore } from "../../contexts";

  const active = $derived(serversStore.activeServer);
  const show = $derived(!!active && !active.local && active.status !== "online");
  const statusLabel = $derived(
    connectionStatusLabel(serversStore.connectionStatus, {
      attempt: serversStore.reconnectAttempt,
      hasConnected: serversStore.hasConnected,
    }),
  );
</script>

{#if show}
  <div class="pointer-events-auto fixed left-1/2 top-3 z-[10018] flex -translate-x-1/2 items-center gap-2 rounded-full border border-(--solus-popover-border) bg-(--solus-popover-bg) px-3 py-1.5 text-[0.75rem] text-(--solus-text-secondary) shadow-(--solus-popover-shadow) backdrop-blur-xl">
    <WifiXIcon size={14} class="shrink-0 text-(--solus-accent)" />
    <span class="max-w-[18rem] truncate">{active?.label} · {statusLabel}</span>
    {#if serversStore.connectionStatus !== "blocked"}
      <button
        type="button"
        class="ml-1 flex h-7 w-7 items-center justify-center rounded-full text-(--solus-text-tertiary) transition-[background-color,color,transform] hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--solus-input-focus-ring)"
        aria-label="Retry connection"
        onclick={() => serversStore.retryActive()}
      >
        <ArrowClockwiseIcon size={13} />
      </button>
    {/if}
  </div>
{/if}
