<script lang="ts">
  import { fade } from "svelte/transition";
  import { connectionStatusLabel } from "@client-core/connection-display";
  import { webState } from "../lib/web-state.svelte";

  const serverLabel = $derived(webState.connectedServer?.label ?? "server");
  const statusLabel = $derived(
    connectionStatusLabel(webState.connectionStatus, {
      attempt: webState.connectionAttempt,
      hasConnected: webState.hasConnected,
    }),
  );
  const isDisconnected = $derived(
    webState.connectionStatus === "disconnected" ||
    webState.connectionStatus === "connecting" ||
    webState.connectionStatus === "reconnecting" ||
    webState.connectionStatus === "blocked"
  );

  let showOverlay = $state(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    if (webState.connectionStatus === "blocked") {
      if (timer) clearTimeout(timer);
      timer = null;
      showOverlay = true;
    } else if (isDisconnected) {
      timer = setTimeout(() => { showOverlay = true }, 5000);
    } else {
      if (timer) clearTimeout(timer);
      timer = null;
      showOverlay = false;
    }
    return () => { if (timer) clearTimeout(timer) };
  });

  function handleSwitchServer() {
    document.dispatchEvent(new CustomEvent("solus:logout"));
  }

  function handleRetry() {
    window.location.reload();
  }
</script>

{#if showOverlay}
  <div class="overlay" transition:fade={{ duration: 200 }} data-solus-ui>
    <div class="overlay-card">
      <div
        class="pulse-ring"
        class:blocked-ring={webState.connectionStatus === "blocked"}
      ></div>

      <h2 class="text-sm font-medium" style="color:var(--solus-text-primary)">
        {statusLabel}
      </h2>

      <p class="text-xs" style="color:var(--solus-text-tertiary)">
        {webState.connectionStatus === "blocked" ? "Re-pair this server to continue" : `To ${serverLabel}`}
      </p>

      <div class="flex gap-2 mt-4">
        <button
          class="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          style="color:var(--solus-text-secondary);border:0.0625rem solid var(--solus-container-border);background:transparent"
          onclick={handleSwitchServer}
        >
          Switch Server
        </button>
        {#if webState.connectionStatus !== "blocked"}
          <button
            class="px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors"
            style="background:var(--solus-accent)"
            onclick={handleRetry}
          >
            Retry Now
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 200;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in oklab, var(--solus-container-bg) 85%, transparent);
    backdrop-filter: blur(0.5rem);
    -webkit-backdrop-filter: blur(0.5rem);
  }

  .overlay-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.375rem;
    padding: 2rem 3rem;
    border-radius: 1rem;
    border: 0.0625rem solid var(--solus-container-border);
    background: var(--solus-container-bg);
    box-shadow: 0 0.5rem 2rem rgba(0, 0, 0, 0.15);
    text-align: center;
  }

  .pulse-ring {
    width: 0.75rem;
    height: 0.75rem;
    border-radius: 50%;
    background: rgb(220, 170, 60);
    margin-bottom: 0.5rem;
    animation: ring-pulse 1.6s ease-in-out infinite;
  }

  .blocked-ring {
    background: var(--solus-status-error);
    animation: none;
    opacity: 1;
  }

  @keyframes ring-pulse {
    0%, 100% { opacity: 0.5; box-shadow: 0 0 0 0 rgba(220, 170, 60, 0.4); }
    50% { opacity: 1; box-shadow: 0 0 0 0.5rem rgba(220, 170, 60, 0); }
  }
</style>
