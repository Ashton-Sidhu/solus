<script lang="ts">
  import {
    GithubLogoIcon,
    ArrowSquareOutIcon,
    CopyIcon,
    CheckIcon,
    SignOutIcon,
    SpinnerGapIcon,
  } from "phosphor-svelte";
  import { onMount } from "svelte";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { connectionsStore } from "../../contexts/connections.store.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";

  const session = getWorkspaceContext();
  const connections = connectionsStore;

  let copied = $state(false);
  let modalEl = $state<HTMLDivElement | null>(null);

  // Tokens minted before the `project` scope existed can't read/write Projects v2
  // fields (due date, priority, status). Prompt those users to reconnect.
  const needsProjectScope = $derived(
    !!connections.providerStatus?.connected && !connections.providerStatus.scopes?.includes("project"),
  );

  // Focus-trap the prompt modal so Esc reaches its keydown handler immediately.
  $effect(() => {
    if (connections.providerPrompt) Promise.resolve().then(() => modalEl?.focus());
  });

  async function refresh() {
    await connections.refreshProviderStatus(session.ctx);
  }

  // The device code arrives mid-`providerConnect` as a broadcast, so the modal
  // can show it while the connect promise keeps polling.
  onMount(() => {
    void refresh();
    return connections.listenForProviderDeviceCodes();
  });

  async function connect() {
    await connections.connectProvider(session.ctx);
  }

  // Esc/Cancel aborts the main-side poll immediately; the store swallows the
  // expected cancellation rejection from connect().
  async function cancel() {
    await connections.cancelProviderConnect(session.ctx);
    requestInputFocus();
  }

  async function disconnect() {
    await connections.disconnectProvider(session.ctx);
    requestInputFocus();
  }

  function copyCode() {
    if (!connections.providerPrompt) return;
    void navigator.clipboard.writeText(connections.providerPrompt.userCode);
    copied = true;
    setTimeout(() => { copied = false; }, 1500);
  }

  function openVerification() {
    if (connections.providerPrompt) void window.solus.openExternal(connections.providerPrompt.verificationUri);
  }

  function onModalKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  }
</script>

<div class="flex flex-col gap-3">
  <div class="flex items-center gap-3 py-2.5 px-3 rounded-xl border border-(--solus-container-border) bg-(--solus-surface-hover)">
    <div class="size-9 rounded-lg bg-(--solus-surface-active) flex items-center justify-center shrink-0">
      <GithubLogoIcon size={18} weight="fill" class="text-(--solus-text-primary)" />
    </div>
    <div class="flex-1 min-w-0">
      <p class="text-[0.8125rem] font-medium text-(--solus-text-primary)">GitHub</p>
      {#if !connections.providerLoaded || connections.providerLoading}
        <p class="text-[0.6875rem] text-(--solus-text-tertiary)">Checking…</p>
      {:else if connections.providerStatus?.connected}
        <p class="text-[0.6875rem] text-(--solus-text-tertiary) truncate">
          Connected{connections.providerStatus.login ? ` as @${connections.providerStatus.login}` : ""}
        </p>
      {:else}
        <p class="text-[0.6875rem] text-(--solus-text-tertiary)">Review pull requests, manage project boards, and comment as yourself.</p>
      {/if}
    </div>

    {#if connections.providerStatus?.connected}
      <button
        type="button"
        onclick={disconnect}
        class="flex items-center gap-1.5 py-1.5 px-2.5 rounded-lg text-[0.75rem] font-medium text-(--solus-text-secondary) border border-(--solus-container-border) hover:text-(--solus-text-primary) hover:bg-(--solus-surface-active) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
      >
        <SignOutIcon size={13} />
        Disconnect
      </button>
    {:else}
      <button
        type="button"
        onclick={connect}
        disabled={connections.providerConnecting}
        class="flex items-center gap-1.5 py-1.5 px-3 rounded-lg text-[0.8125rem] font-medium bg-(--solus-accent) text-(--solus-text-on-accent) hover:opacity-90 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
      >
        {#if connections.providerConnecting}
          <SpinnerGapIcon size={14} class="animate-spin" />
          Connecting…
        {:else}
          <GithubLogoIcon size={14} weight="fill" />
          Connect GitHub
        {/if}
      </button>
    {/if}
  </div>

  {#if needsProjectScope}
    <div class="flex items-center gap-2 py-2 px-3 rounded-lg border border-(--solus-container-border) bg-(--solus-surface-hover)">
      <p class="flex-1 text-[0.6875rem] text-(--solus-text-tertiary)">
        Reconnect to grant project access and enable due date, priority &amp; status on GitHub tasks.
      </p>
      <button
        type="button"
        onclick={connect}
        disabled={connections.providerConnecting}
        class="shrink-0 py-1 px-2.5 rounded-lg text-[0.75rem] font-medium text-(--solus-text-secondary) border border-(--solus-container-border) hover:text-(--solus-text-primary) hover:bg-(--solus-surface-active) disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
      >
        Reconnect
      </button>
    </div>
  {/if}

  {#if connections.providerError}
    <p class="text-[0.6875rem] text-red-500">{connections.providerError}</p>
  {/if}
</div>

<!-- Device-code prompt -->
{#if connections.providerPrompt}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center p-4"
    role="dialog"
    aria-modal="true"
    aria-label="Connect GitHub"
    tabindex="-1"
    bind:this={modalEl}
    onkeydown={onModalKeydown}
  >
    <div class="w-full max-w-sm flex flex-col gap-5 p-6 rounded-2xl bg-(--solus-container-bg) border border-(--solus-container-border) shadow-xl">
      <div class="flex flex-col items-center gap-2 text-center">
        <div class="size-11 rounded-xl bg-(--solus-surface-hover) flex items-center justify-center">
          <GithubLogoIcon size={22} weight="fill" class="text-(--solus-text-primary)" />
        </div>
        <p class="text-[0.9375rem] font-semibold text-(--solus-text-primary)">Authorize Solus on GitHub</p>
        <p class="text-[0.75rem] text-(--solus-text-tertiary)">Enter this code at github.com/login/device</p>
      </div>

      <div class="flex items-center justify-center gap-2">
        <code
          class="text-[1.625rem] font-semibold tracking-[0.18em] text-(--solus-text-primary) tabular-nums"
          style="font-family: 'Geist Mono', ui-monospace, monospace"
        >{connections.providerPrompt.userCode}</code>
        <button
          type="button"
          onclick={copyCode}
          class="size-7 flex items-center justify-center rounded-lg text-(--solus-text-tertiary) hover:text-(--solus-text-primary) hover:bg-(--solus-surface-hover)"
          aria-label="Copy code"
        >
          {#if copied}
            <CheckIcon size={14} class="text-(--solus-status-complete)" />
          {:else}
            <CopyIcon size={14} />
          {/if}
        </button>
      </div>

      <button
        type="button"
        onclick={openVerification}
        class="flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-[0.8125rem] font-medium bg-(--solus-accent) text-(--solus-text-on-accent) hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
      >
        <ArrowSquareOutIcon size={14} />
        Open github.com/login/device
      </button>

      <button
        type="button"
        onclick={cancel}
        class="self-center text-[0.75rem] font-medium text-(--solus-text-tertiary) hover:text-(--solus-text-primary)"
      >
        Cancel
      </button>
    </div>
  </div>
{/if}
