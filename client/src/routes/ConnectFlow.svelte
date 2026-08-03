<script lang="ts">
  import { loadServers, removeServer, type SavedServer } from "@client-core/server-registry";
  import { defaultDeviceLabel, urlHost } from "@client-core/pairing";
  import { classifyConnectInput, probeServer } from "../lib/connect";
  import { addHostFromInput } from "../lib/add-host";
  import { toasts } from "../lib/toast.store.svelte";

  interface Props {
    onConnect: (server: SavedServer) => Promise<void>;
    /** Prefills the address form — used by the /claim deep link. */
    initialAddress?: string;
  }
  let { onConnect, initialAddress }: Props = $props();

  let servers = $state<SavedServer[]>(loadServers());

  type View = "servers" | "add";
  // initialAddress is a boot-time seed (the /claim deep link) — reading only
  // its initial value here is the point, not an oversight.
  // svelte-ignore state_referenced_locally
  let view = $state<View>(loadServers().length === 0 || initialAddress ? "add" : "servers");

  // svelte-ignore state_referenced_locally
  let smartInput = $state(initialAddress ?? "");
  let codeInput = $state("");
  let labelInput = $state("");
  let busy = $state(false);
  let connectingServer = $state<string | null>(null);

  // One smart field: a pasted pairing link pairs directly; an address needs the
  // 6-digit code shown beside the QR in Settings → Connections on the server.
  const classified = $derived(classifyConnectInput(smartInput));
  const needsCode = $derived(classified.kind === "address");

  // ── Live status for saved servers ──
  let statuses = $state<Record<string, "checking" | "online" | "offline">>({});

  $effect(() => {
    if (view !== "servers") return;
    for (const server of servers) {
      statuses[server.id] = "checking";
      void probeServer(server.url, 2_500).then((health) => {
        statuses[server.id] = health.ok ? "online" : "offline";
      });
    }
  });

  async function handleSubmit(e: Event) {
    e.preventDefault();
    // The connecting overlay replaces the whole form, so only a submission
    // that has a host to dial earns it.
    if (classified.kind !== "empty") {
      busy = true;
      connectingServer = labelInput.trim() || urlHost(classified.url);
    }
    try {
      const server = await addHostFromInput({
        input: smartInput,
        code: codeInput,
        serverLabel: labelInput,
      });
      servers = loadServers();
      resetForm();
      view = "servers";
      await onConnect(server);
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : String(err));
    } finally {
      busy = false;
      connectingServer = null;
    }
  }

  function resetForm() {
    smartInput = "";
    codeInput = "";
    labelInput = "";
    connectingServer = null;
  }

  function switchToAdd() {
    resetForm();
    view = "add";
  }

  function switchToServers() {
    resetForm();
    view = "servers";
  }

  function forget(id: string) {
    removeServer(id);
    servers = loadServers();
    if (servers.length === 0) view = "add";
  }

  async function handleServerConnect(server: SavedServer) {
    if (busy) return;
    busy = true;
    connectingServer = server.label;
    try {
      await onConnect(server);
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : String(err));
    } finally {
      busy = false;
      connectingServer = null;
    }
  }

  function relativeTime(ts: number): string {
    const diff = Date.now() - ts;
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function handleKeydown(e: KeyboardEvent) {
    if (view === "add" && e.key === "Escape" && servers.length > 0) {
      e.preventDefault();
      switchToServers();
    }
  }

  let smartInputEl: HTMLInputElement | undefined = $state();

  $effect(() => {
    if (view === "add") {
      setTimeout(() => smartInputEl?.focus(), 80);
    }
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="cf-root">
  <div class="cf-container">
    <!-- Header -->
    <header class="cf-header">
      <svg class="cf-logo" viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <circle cx="16" cy="16" r="6.6" fill="#B45A3C" />
        <g stroke="#D97757" stroke-width="2.2" stroke-linecap="round">
          <path d="M16,5 A11,11 0 0 1 27,16" />
          <path d="M25.24,23.48 A11,11 0 0 1 12.48,26.56" />
          <path d="M6.76,23.48 A11,11 0 0 1 5,12.48" />
        </g>
      </svg>
      <h1 class="cf-title">Solus</h1>
      <p class="cf-subtitle">
        {#if view === "servers"}
          Choose a server to work on
        {:else}
          Connect a server
        {/if}
      </p>
    </header>

    <!-- Connecting overlay -->
    {#if busy}
      <div class="cf-connecting">
        <div class="cf-spinner"></div>
        <p class="cf-connecting-label">Connecting to {connectingServer}...</p>
      </div>
    {:else}

      <!-- Saved Servers View -->
      {#if view === "servers" && servers.length > 0}
        <div class="cf-section">
          <div class="cf-servers-list">
            {#each servers as server (server.id)}
              <div class="cf-server-row">
                <button
                  class="cf-server-btn"
                  onclick={() => handleServerConnect(server)}
                >
                  <span
                    class="cf-dot cf-dot--{statuses[server.id] ?? 'checking'}"
                    aria-label={statuses[server.id] ?? "checking"}
                  ></span>
                  <div class="cf-server-info">
                    <span class="cf-server-label">{server.label}</span>
                    <span class="cf-server-url">{urlHost(server.url)}</span>
                  </div>
                  <div class="cf-server-meta">
                    <span class="cf-server-time">{relativeTime(server.lastConnected)}</span>
                    <svg class="cf-server-arrow" viewBox="0 0 16 16" fill="none">
                      <path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                  </div>
                </button>
                <button
                  class="cf-server-remove"
                  onclick={() => forget(server.id)}
                  aria-label="Remove {server.label}"
                >
                  <svg viewBox="0 0 16 16" fill="none" width="14" height="14">
                    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                  </svg>
                </button>
              </div>
            {/each}
          </div>

          <button
            class="cf-add-btn"
            onclick={switchToAdd}
          >
            <svg viewBox="0 0 16 16" fill="none" width="14" height="14">
              <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
            Connect another server
          </button>
        </div>

      <!-- Add Server View -->
      {:else}
        <div class="cf-section">
          <form class="cf-form" onsubmit={handleSubmit}>
            <div class="cf-hint">
              On your computer, open Solus and go to
              <strong>Settings &rarr; Connections</strong>. Scan the QR code with
              your camera, or paste the pairing link or server address here.
            </div>

            <label class="cf-field">
              <span class="cf-label">Pairing link or address</span>
              <input
                bind:this={smartInputEl}
                type="text"
                placeholder="192.168.1.42:51234 or pairing link"
                bind:value={smartInput}
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                class="cf-input"
              />
            </label>

            {#if needsCode}
              <label class="cf-field">
                <span class="cf-label">Code</span>
                <input
                  type="text"
                  inputmode="numeric"
                  maxlength="6"
                  placeholder="000000"
                  bind:value={codeInput}
                  autocomplete="one-time-code"
                  class="cf-input cf-input--code"
                />
              </label>
            {/if}

            <label class="cf-field">
              <span class="cf-label">Device name <span class="cf-optional">optional</span></span>
              <input
                type="text"
                placeholder={defaultDeviceLabel()}
                bind:value={labelInput}
                autocomplete="off"
                class="cf-input"
              />
            </label>

            <div class="cf-actions">
              {#if servers.length > 0}
                <button
                  type="button"
                  class="cf-btn-secondary"
                  onclick={switchToServers}
                >
                  Back
                </button>
              {/if}
              <button type="submit" class="cf-btn-primary" disabled={busy}>
                Connect
              </button>
            </div>
          </form>
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .cf-root {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    width: 100%;
    background: var(--solus-container-bg);
    padding: 1.5rem;
  }

  .cf-container {
    width: 100%;
    max-width: 25rem;
  }

  /* ── Header ── */
  .cf-header {
    text-align: center;
    margin-bottom: 2rem;
  }

  .cf-logo {
    width: 2.75rem;
    height: 2.75rem;
    margin: 0 auto 0.875rem;
  }

  .cf-title {
    font-size: 1.125rem;
    font-weight: 600;
    letter-spacing: -0.02em;
    color: var(--solus-text-primary);
    margin: 0 0 0.25rem;
  }

  .cf-subtitle {
    font-size: 0.8125rem;
    color: var(--solus-text-tertiary);
    margin: 0;
  }

  /* ── Section ── */
  .cf-section {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  /* ── Servers List ── */
  .cf-servers-list {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .cf-server-row {
    display: flex;
    align-items: stretch;
    border-radius: 0.625rem;
    background: var(--solus-surface-hover);
    overflow: hidden;
  }

  .cf-server-btn {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 0.875rem;
    border: none;
    background: transparent;
    cursor: pointer;
    text-align: left;
    color: var(--solus-text-primary);
    font-family: inherit;
    min-width: 0;
  }

  .cf-server-btn:hover {
    background: var(--solus-surface-active);
  }

  .cf-server-btn:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: -0.125rem;
    border-radius: 0.625rem 0 0 0.625rem;
  }

  .cf-dot {
    flex-shrink: 0;
    width: 0.4375rem;
    height: 0.4375rem;
    border-radius: 50%;
    background: var(--solus-text-quaternary);
  }

  .cf-dot--checking {
    animation: cf-pulse 1.1s ease-in-out infinite;
  }

  .cf-dot--online {
    background: var(--solus-status-complete);
  }

  .cf-dot--offline {
    background: var(--solus-text-quaternary);
    opacity: 0.5;
  }

  @keyframes cf-pulse {
    50% { opacity: 0.35; }
  }

  .cf-server-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
  }

  .cf-server-label {
    font-size: 0.8125rem;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cf-server-url {
    font-size: 0.6875rem;
    color: var(--solus-text-tertiary);
    font-family: "Geist Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cf-server-meta {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    flex-shrink: 0;
  }

  .cf-server-time {
    font-size: 0.6875rem;
    color: var(--solus-text-tertiary);
    white-space: nowrap;
  }

  .cf-server-arrow {
    width: 0.875rem;
    height: 0.875rem;
    color: var(--solus-text-tertiary);
    opacity: 0;
  }

  .cf-server-btn:hover .cf-server-arrow {
    opacity: 1;
  }

  .cf-server-remove {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.375rem;
    border: none;
    background: transparent;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    flex-shrink: 0;
    opacity: 0;
  }

  .cf-server-row:hover .cf-server-remove,
  .cf-server-remove:focus-visible {
    opacity: 1;
  }

  .cf-server-remove:hover {
    color: var(--solus-status-error);
    background: rgba(196, 112, 96, 0.08);
  }

  .cf-server-remove:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: -0.125rem;
  }

  /* ── Add Button ── */
  .cf-add-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
    padding: 0.625rem 1rem;
    border: 0.0625rem dashed var(--solus-container-border);
    border-radius: 0.625rem;
    background: transparent;
    color: var(--solus-text-tertiary);
    font-size: 0.8125rem;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
  }

  .cf-add-btn:hover {
    color: var(--solus-text-secondary);
    border-color: var(--solus-text-tertiary);
    background: var(--solus-surface-hover);
  }

  .cf-add-btn:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.125rem;
  }

  /* ── Form ── */
  .cf-form {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
  }

  .cf-hint {
    font-size: 0.75rem;
    line-height: 1.5;
    color: var(--solus-text-tertiary);
    padding: 0.625rem 0.75rem;
    border-radius: 0.5rem;
    background: var(--solus-surface-hover);
  }

  .cf-hint strong {
    color: var(--solus-text-secondary);
    font-weight: 500;
  }

  .cf-field {
    display: flex;
    flex-direction: column;
    gap: 0.3125rem;
  }

  .cf-label {
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--solus-text-secondary);
  }

  .cf-optional {
    font-weight: 400;
    color: var(--solus-text-tertiary);
  }

  .cf-input {
    background: var(--solus-surface-hover);
    border: 0.0625rem solid var(--solus-container-border);
    border-radius: 0.5rem;
    padding: 0.5625rem 0.75rem;
    font-size: 0.875rem;
    color: var(--solus-text-primary);
    font-family: inherit;
  }

  .cf-input:focus {
    outline: none;
    border-color: var(--solus-input-focus-border);
    background: var(--solus-surface-active);
    box-shadow: 0 0 0 0.1875rem var(--solus-input-focus-ring);
  }

  .cf-input::placeholder {
    color: var(--solus-placeholder);
  }

  .cf-input--code {
    font-family: "Geist Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
    letter-spacing: 0.2em;
    font-size: 1rem;
  }

  /* ── Actions ── */
  .cf-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    padding-top: 0.25rem;
  }

  .cf-btn-primary {
    padding: 0.5625rem 1.25rem;
    border: none;
    border-radius: 0.5rem;
    background: var(--solus-accent);
    color: var(--solus-text-on-accent);
    font-size: 0.8125rem;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
  }

  .cf-btn-primary:hover:not(:disabled) {
    background: var(--solus-send-hover);
  }

  .cf-btn-primary:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.125rem;
  }

  .cf-btn-primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .cf-btn-secondary {
    padding: 0.5625rem 1rem;
    border: 0.0625rem solid var(--solus-container-border);
    border-radius: 0.5rem;
    background: transparent;
    color: var(--solus-text-secondary);
    font-size: 0.8125rem;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
  }

  .cf-btn-secondary:hover {
    background: var(--solus-surface-hover);
  }

  .cf-btn-secondary:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.125rem;
  }

  /* ── Connecting State ── */
  .cf-connecting {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    padding: 2.5rem 0;
  }

  .cf-spinner {
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    border: 0.1563rem solid var(--solus-surface-hover);
    border-top-color: var(--solus-accent);
    animation: cf-spin 0.7s linear infinite;
  }

  .cf-connecting-label {
    font-size: 0.8125rem;
    color: var(--solus-text-tertiary);
    margin: 0;
  }

  @keyframes cf-spin {
    to { transform: rotate(360deg); }
  }

  /* ── Mobile ── */
  @media (max-width: 767px) {
    .cf-root {
      padding: 1.25rem 1rem;
      align-items: flex-start;
      padding-top: max(env(safe-area-inset-top, 2.5rem), 2.5rem);
    }

    .cf-container {
      max-width: 100%;
    }

    .cf-actions {
      flex-direction: column-reverse;
    }

    .cf-btn-primary,
    .cf-btn-secondary {
      width: 100%;
      padding: 0.75rem 1.25rem;
      text-align: center;
      min-height: 2.75rem;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .cf-server-btn {
      padding: 0.875rem 1rem;
      min-height: 3rem;
    }

    .cf-server-remove {
      width: 3rem;
      opacity: 1;
    }

    .cf-add-btn {
      padding: 0.875rem 1rem;
      min-height: 2.75rem;
    }

    .cf-input {
      padding: 0.75rem;
      font-size: 1rem;
    }

    .cf-input--code {
      font-size: 1.125rem;
    }
  }
</style>
