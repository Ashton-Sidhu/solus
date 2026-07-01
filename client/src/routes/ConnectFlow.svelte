<script lang="ts">
  import { loadServers, upsertServer, removeServer, type SavedServer } from "../transport/server-registry";
  import { uuid } from "../../../src/shared/uuid";

  interface Props {
    onConnect: (server: SavedServer) => void;
  }
  let { onConnect }: Props = $props();

  let servers = $state<SavedServer[]>(loadServers());

  type View = 'servers' | 'add';
  type AddTab = 'link' | 'manual';
  let view = $state<View>(loadServers().length === 0 ? 'add' : 'servers');
  let addTab = $state<AddTab>('link');

  let urlInput = $state("");
  let codeInput = $state("");
  let pasteInput = $state("");
  let labelInput = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);
  let connectingServer = $state<string | null>(null);

  function parsePairLink(link: string): { url: string; token: string } | null {
    try {
      const u = new URL(link);
      const fragment = u.hash.startsWith("#") ? u.hash.slice(1) : u.hash;
      const params = new URLSearchParams(fragment);
      const token = params.get("token");
      if (!token) return null;
      const url = `${u.protocol}//${u.host}`;
      return { url, token };
    } catch {
      return null;
    }
  }

  async function pair(url: string, tokenOrCode: string, label: string) {
    busy = true;
    error = null;
    try {
      const resp = await fetch(`${url}/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pairToken: tokenOrCode, deviceLabel: label || browserLabel() }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body?.error ?? `Pair failed (${resp.status})`);
      }
      const { sessionToken, installationId } = await resp.json();
      const id = installationId ?? uuid();
      const server: SavedServer = {
        id,
        label: label || urlHost(url),
        url,
        sessionToken,
        installationId,
        lastConnected: Date.now(),
      };
      upsertServer(server);
      servers = loadServers();
      resetForm();
      view = 'servers';
      onConnect(server);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
      connectingServer = null;
    }
  }

  async function handleLinkSubmit(e: Event) {
    e.preventDefault();
    if (!pasteInput.trim()) {
      error = "Paste a pairing link to continue";
      return;
    }
    const parsed = parsePairLink(pasteInput.trim());
    if (!parsed) {
      error = "Couldn't parse that pairing link — check the format";
      return;
    }
    connectingServer = labelInput.trim() || urlHost(parsed.url);
    await pair(parsed.url, parsed.token, labelInput.trim());
  }

  async function handleManualSubmit(e: Event) {
    e.preventDefault();
    if (!urlInput || !codeInput) {
      error = "Both server URL and pair code are required";
      return;
    }
    let url = urlInput.trim();
    if (!/^https?:\/\//.test(url)) url = "http://" + url;
    connectingServer = labelInput.trim() || urlHost(url);
    await pair(url, codeInput.trim(), labelInput.trim());
  }

  function resetForm() {
    pasteInput = "";
    urlInput = "";
    codeInput = "";
    labelInput = "";
    error = null;
    connectingServer = null;
  }

  function switchToAdd() {
    resetForm();
    view = 'add';
  }

  function switchToServers() {
    resetForm();
    view = 'servers';
  }

  function urlHost(url: string): string {
    try { return new URL(url).host } catch { return url }
  }

  function browserLabel(): string {
    const ua = navigator.userAgent;
    if (/Chrome/.test(ua)) return `Chrome on ${guessOs()}`;
    if (/Firefox/.test(ua)) return `Firefox on ${guessOs()}`;
    if (/Safari/.test(ua)) return `Safari on ${guessOs()}`;
    return "Web browser";
  }

  function guessOs(): string {
    const ua = navigator.userAgent;
    if (/iPhone|iPad/.test(ua)) return "iOS";
    if (/Android/.test(ua)) return "Android";
    if (/Mac OS/.test(ua)) return "macOS";
    if (/Windows/.test(ua)) return "Windows";
    if (/Linux/.test(ua)) return "Linux";
    return "device";
  }

  function disconnect(id: string) {
    removeServer(id);
    servers = loadServers();
    if (servers.length === 0) view = 'add';
  }

  function handleServerConnect(server: SavedServer) {
    connectingServer = server.label;
    onConnect(server);
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
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function handleKeydown(e: KeyboardEvent) {
    if (view === 'add' && e.key === 'Escape' && servers.length > 0) {
      e.preventDefault();
      switchToServers();
    }
  }

  let linkInputEl: HTMLInputElement | undefined = $state();
  let urlInputEl: HTMLInputElement | undefined = $state();

  $effect(() => {
    if (view === 'add') {
      setTimeout(() => {
        if (addTab === 'link') linkInputEl?.focus();
        else urlInputEl?.focus();
      }, 80);
    }
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="cf-root">
  <div class="cf-container">
    <!-- Header -->
    <header class="cf-header">
      <div class="cf-logo">S</div>
      <h1 class="cf-title">Solus</h1>
      <p class="cf-subtitle">
        {#if view === 'servers'}
          Choose a server to connect
        {:else}
          Register a new server
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
      {#if view === 'servers' && servers.length > 0}
        <div class="cf-section">
          <div class="cf-servers-list">
            {#each servers as server (server.id)}
              <div class="cf-server-row">
                <button
                  class="cf-server-btn"
                  onclick={() => handleServerConnect(server)}
                >
                  <div class="cf-server-info">
                    <span class="cf-server-label">{server.label}</span>
                    <span class="cf-server-url">{server.url}</span>
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
                  onclick={() => disconnect(server.id)}
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
            Add server
          </button>
        </div>

      <!-- Add Server View -->
      {:else}
        <div class="cf-section">
          <!-- Tabs -->
          <div class="cf-tabs" role="tablist">
            <button
              role="tab"
              class="cf-tab"
              class:cf-tab--active={addTab === 'link'}
              aria-selected={addTab === 'link'}
              onclick={() => { addTab = 'link'; error = null; }}
            >
              Pairing link
            </button>
            <button
              role="tab"
              class="cf-tab"
              class:cf-tab--active={addTab === 'manual'}
              aria-selected={addTab === 'manual'}
              onclick={() => { addTab = 'manual'; error = null; }}
            >
              Manual setup
            </button>
          </div>

          <!-- Link Tab -->
          {#if addTab === 'link'}
            <form class="cf-form" onsubmit={handleLinkSubmit}>
              <div class="cf-hint">
                Open the Solus desktop app, go to <strong>Settings &rarr; Connections</strong> and copy the pairing link.
              </div>

              <label class="cf-field">
                <span class="cf-label">Pairing link</span>
                <input
                  bind:this={linkInputEl}
                  type="text"
                  placeholder="http://192.168.1.42:51234/pair#token=..."
                  bind:value={pasteInput}
                  autocomplete="off"
                  class="cf-input"
                />
              </label>

              <label class="cf-field">
                <span class="cf-label">Device name <span class="cf-optional">optional</span></span>
                <input
                  type="text"
                  placeholder={browserLabel()}
                  bind:value={labelInput}
                  autocomplete="off"
                  class="cf-input"
                />
              </label>

              {#if error}
                <div class="cf-error">{error}</div>
              {/if}

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

          <!-- Manual Tab -->
          {:else}
            <form class="cf-form" onsubmit={handleManualSubmit}>
              <div class="cf-hint">
                Enter the server address and 6-digit code shown in the Solus desktop app.
              </div>

              <label class="cf-field">
                <span class="cf-label">Server address</span>
                <input
                  bind:this={urlInputEl}
                  type="text"
                  placeholder="192.168.1.42:51234"
                  bind:value={urlInput}
                  autocomplete="off"
                  class="cf-input"
                />
              </label>

              <label class="cf-field">
                <span class="cf-label">Pair code</span>
                <input
                  type="text"
                  inputmode="numeric"
                  maxlength="6"
                  placeholder="000000"
                  bind:value={codeInput}
                  autocomplete="off"
                  class="cf-input cf-input--code"
                />
              </label>

              <label class="cf-field">
                <span class="cf-label">Device name <span class="cf-optional">optional</span></span>
                <input
                  type="text"
                  placeholder={browserLabel()}
                  bind:value={labelInput}
                  autocomplete="off"
                  class="cf-input"
                />
              </label>

              {#if error}
                <div class="cf-error">{error}</div>
              {/if}

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
          {/if}
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
    border-radius: 0.75rem;
    background: var(--solus-accent);
    color: var(--solus-text-on-accent);
    font-size: 1.25rem;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: center;
    letter-spacing: -0.02em;
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
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.75rem 0.875rem;
    border: none;
    background: transparent;
    cursor: pointer;
    text-align: left;
    color: var(--solus-text-primary);
    font-family: inherit;
  }

  .cf-server-btn:hover {
    background: var(--solus-surface-active);
  }

  .cf-server-btn:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: -0.125rem;
    border-radius: 0.625rem 0 0 0.625rem;
  }

  .cf-server-info {
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
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
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

  /* ── Tabs ── */
  .cf-tabs {
    display: flex;
    gap: 0.125rem;
    padding: 0.1875rem;
    border-radius: 0.625rem;
    background: var(--solus-surface-hover);
  }

  .cf-tab {
    flex: 1;
    padding: 0.4375rem 0.75rem;
    border: none;
    border-radius: 0.4375rem;
    background: transparent;
    color: var(--solus-text-tertiary);
    font-size: 0.8125rem;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
  }

  .cf-tab:hover:not(.cf-tab--active) {
    color: var(--solus-text-secondary);
  }

  .cf-tab--active {
    background: var(--solus-container-bg);
    color: var(--solus-text-primary);
    box-shadow: 0 0.0625rem 0.1875rem rgba(0, 0, 0, 0.06);
  }

  .cf-tab:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: -0.125rem;
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
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
    letter-spacing: 0.2em;
    font-size: 1rem;
  }

  /* ── Error ── */
  .cf-error {
    font-size: 0.8125rem;
    padding: 0.5625rem 0.75rem;
    border-radius: 0.5rem;
    color: var(--solus-status-error);
    background: var(--solus-status-error-bg);
    border: 0.0625rem solid rgba(196, 112, 96, 0.2);
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

    .cf-tab {
      padding: 0.625rem 0.75rem;
      min-height: 2.5rem;
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
