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
  import { getWorkspaceContext, connectionsStore, toasts } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Button } from "../ui/button";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import SettingsRow from "../settings/SettingsRow.svelte";

  const session = getWorkspaceContext();
  const connections = connectionsStore;

  let copied = $state(false);
  let modalEl = $state<HTMLDivElement | null>(null);

  // Tokens minted before the `project` scope existed can't read/write Projects v2
  // fields (due date, priority, status). Prompt those users to reconnect.
  const needsProjectScope = $derived(
    !!connections.providerStatus?.connected &&
      !connections.providerStatus.scopes?.includes("project"),
  );

  const accountDescription = $derived.by(() => {
    if (!connections.providerLoaded || connections.providerLoading) return "Checking…";
    if (!connections.providerStatus?.connected)
      return "Review pull requests, manage project boards, and comment as yourself.";
    const { login } = connections.providerStatus;
    return login ? `Connected as @${login}` : "Connected";
  });

  // Focus-trap the prompt modal so Esc reaches its keydown handler immediately.
  $effect(() => {
    if (connections.providerPrompt)
      Promise.resolve().then(() => modalEl?.focus());
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
    try {
      await connections.connectProvider(session.ctx);
    } catch (error) {
      toasts.error(
        `Couldn't connect to GitHub: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
    setTimeout(() => {
      copied = false;
    }, 1500);
  }

  function openVerification() {
    if (connections.providerPrompt)
      void window.solus.openExternal(
        connections.providerPrompt.verificationUri,
      );
  }

  function onModalKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  }
</script>

<SettingsSection label="GitHub">
  <SettingsRow label="GitHub account" description={accountDescription}>
    {#snippet control()}
      {#if connections.providerStatus?.connected}
        <Button variant="outline" size="sm" onclick={disconnect}>
          <SignOutIcon size={13} />
          Disconnect
        </Button>
      {:else}
        <Button size="sm" onclick={connect} disabled={connections.providerConnecting}>
          {#if connections.providerConnecting}
            <SpinnerGapIcon size={14} class="animate-spin" />
            Connecting…
          {:else}
            <GithubLogoIcon size={14} weight="fill" />
            Connect GitHub
          {/if}
        </Button>
      {/if}
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Project access"
    description="Reconnect to grant project access and enable due date, priority & status on GitHub tasks."
    visible={needsProjectScope}
  >
    {#snippet control()}
      <Button
        variant="outline"
        size="sm"
        onclick={connect}
        disabled={connections.providerConnecting}
      >
        Reconnect
      </Button>
    {/snippet}
  </SettingsRow>
</SettingsSection>

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
    <div
      class="w-full max-w-sm flex flex-col gap-5 p-6 rounded-2xl bg-card border border-border shadow-xl"
    >
      <div class="flex flex-col items-center gap-2 text-center">
        <div
          class="size-11 rounded-xl bg-(--solus-surface-hover) flex items-center justify-center"
        >
          <GithubLogoIcon
            size={22}
            weight="fill"
            class="text-(--solus-text-primary)"
          />
        </div>
        <p class="text-[0.9375rem] font-semibold text-(--solus-text-primary)">
          Authorize Solus on GitHub
        </p>
        <p class="text-[0.75rem] text-(--solus-text-tertiary)">
          Enter this code at github.com/login/device
        </p>
      </div>

      <div class="flex items-center justify-center gap-2">
        <code
          class="text-[1.625rem] font-semibold tracking-[0.18em] text-(--solus-text-primary) tabular-nums"
          style="font-family: 'Geist Mono', ui-monospace, monospace"
          >{connections.providerPrompt.userCode}</code
        >
        <Button
          variant="ghost"
          size="icon-sm"
          onclick={copyCode}
          class="text-(--solus-text-tertiary)"
          aria-label="Copy code"
        >
          {#if copied}
            <CheckIcon size={14} class="text-(--solus-status-complete)" />
          {:else}
            <CopyIcon size={14} />
          {/if}
        </Button>
      </div>

      <Button onclick={openVerification}>
        <ArrowSquareOutIcon size={14} />
        Open github.com/login/device
      </Button>

      <Button
        variant="ghost"
        size="sm"
        onclick={cancel}
        class="self-center text-(--solus-text-tertiary)"
      >
        Cancel
      </Button>
    </div>
  </div>
{/if}
