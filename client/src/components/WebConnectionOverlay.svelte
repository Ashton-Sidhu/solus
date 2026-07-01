<script lang="ts">
  import { fade } from "svelte/transition";
  import { webState } from "../lib/web-state.svelte";

  const serverLabel = $derived(webState.connectedServer?.label ?? "server");
  const isDisconnected = $derived(
    webState.connectionStatus === "disconnected" ||
    webState.connectionStatus === "reconnecting"
  );

  let showOverlay = $state(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    if (isDisconnected) {
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
      <div class="pulse-ring"></div>

      <h2 class="text-sm font-medium" style="color:var(--solus-text-primary)">
        Reconnecting to {serverLabel}...
      </h2>

      {#if webState.connectionAttempt > 0}
        <p class="text-xs" style="color:var(--solus-text-tertiary)">
          Attempt {webState.connectionAttempt}
        </p>
      {/if}

      <div class="flex gap-2 mt-4">
        <button
          class="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          style="color:var(--solus-text-secondary);border:0.0625rem solid var(--solus-container-border);background:transparent"
          onclick={handleSwitchServer}
        >
          Switch Server
        </button>
        <button
          class="px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors"
          style="background:var(--solus-accent)"
          onclick={handleRetry}
        >
          Retry Now
        </button>
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

  @keyframes ring-pulse {
    0%, 100% { opacity: 0.5; box-shadow: 0 0 0 0 rgba(220, 170, 60, 0.4); }
    50% { opacity: 1; box-shadow: 0 0 0 0.5rem rgba(220, 170, 60, 0); }
  }
</style>
