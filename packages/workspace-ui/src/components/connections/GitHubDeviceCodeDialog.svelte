<script lang="ts">
  /** The GitHub device-code prompt: the code to type at github.com, shown while
   *  `connectProvider` polls. The code arrives mid-connect as a broadcast, so
   *  this listens for it whenever it is mounted. Esc or Cancel aborts the poll. */
  import Icon from "@iconify/svelte";
  import { onMount } from "svelte";
  import { localApi } from "@solus/client-core/local-api";
  import {
    ExternalLink as ArrowSquareOutIcon,
    Copy as CopyIcon,
    Check as CheckIcon,
  } from "@lucide/svelte";
  import { getWorkspaceContext, connectionsStore } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { useScope } from "../../lib/keybindings/use-keybinding.svelte";
  import { PROVIDER_LOGOS } from "../settings/lib/provider-logos";
  import { Button } from "../ui/button";

  let { serverId }: { serverId: string } = $props();

  const session = getWorkspaceContext();
  const connections = connectionsStore;
  let copied = $state(false);
  let modalEl = $state<HTMLDivElement | null>(null);

  // Focus-trap the prompt modal so Esc reaches its keydown handler immediately.
  $effect(() => {
    if (connections.providerPrompt)
      Promise.resolve().then(() => modalEl?.focus());
  });

  onMount(() => {
    return connections.listenForProviderDeviceCodes();
  });

  // The store swallows the expected cancellation rejection from connect().
  async function cancel() {
    await connections.cancelProviderConnect(serverId, session.ctx);
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
      void localApi.openExternal(
        connections.providerPrompt.verificationUri,
      );
  }

  function onModalKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  }

  // A modal: shortcuts behind it stay quiet while it is open.
  useScope("modal-dialog", { exclusive: true, pre: true, active: () => !!connections.providerPrompt });
</script>

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
          class="size-11 rounded-lg bg-(--solus-surface-hover) flex items-center justify-center"
        >
          <Icon
            icon={PROVIDER_LOGOS.github}
            width={22}
            height={22}
            class="text-(--solus-text-primary)"
          />
        </div>
        <p class="text-sm font-medium text-(--solus-text-primary)">
          Authorize Solus on GitHub
        </p>
        <p class="text-xs text-(--solus-text-tertiary)">
          Enter this code at github.com/login/device
        </p>
      </div>

      <div class="flex items-center justify-center gap-2">
        <code
          class="text-2xl font-medium text-(--solus-text-primary) tabular-nums"
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
