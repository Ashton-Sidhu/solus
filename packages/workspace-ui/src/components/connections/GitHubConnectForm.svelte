<script lang="ts">
  /**
   * The GitHub device-code sign-in, sized for the connect card.
   *
   * `GitHubConnect.svelte` is the Settings surface for the same flow: it also
   * owns scope repair, the account row, and disconnect. This is the interrupt
   * form — one button, then the code to type — and nothing else.
   */
  import { onMount } from "svelte";
  import { localApi } from "@solus/client-core/local-api";
  import {
    ExternalLink as ArrowSquareOutIcon,
    Copy as CopyIcon,
    Check as CheckIcon,
    LoaderCircle as SpinnerGapIcon,
  } from "@lucide/svelte";
  import { connectionsStore, getWorkspaceContext } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import { Button } from "../ui/button";

  interface Props {
    serverId: string;
    /** Fires once the account is connected. */
    onconnected?: () => void;
  }

  let { serverId, onconnected }: Props = $props();

  const session = getWorkspaceContext();
  const connections = connectionsStore;

  let copied = $state(false);

  const prompt = $derived(connections.providerPrompt);

  $effect(() => {
    if (connections.providerLoaded && connections.providerStatus?.connected) onconnected?.();
  });

  // The device code arrives mid-`connectProvider` as a broadcast, so it can be
  // shown while the connect promise keeps polling.
  onMount(() => connections.listenForProviderDeviceCodes());

  async function connect() {
    try {
      await connections.connectProvider(serverId, session.ctx);
    } catch (error) {
      toasts.error("Couldn't connect to GitHub", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function copyCode() {
    if (!prompt) return;
    void navigator.clipboard.writeText(prompt.userCode);
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }
</script>

<div class="flex flex-col gap-2.5">
  {#if prompt}
    <div class="flex flex-wrap items-center gap-2">
      <button
        type="button"
        class="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-sm tracking-widest shadow-xs transition-colors hover:bg-muted"
        onclick={copyCode}
        aria-label="Copy the device code"
      >
        {prompt.userCode}
        {#if copied}
          <CheckIcon size={12} />
        {:else}
          <CopyIcon size={12} class="opacity-60" />
        {/if}
      </button>
      <Button
        variant="outline"
        size="sm"
        onclick={() => void localApi.openExternal(prompt.verificationUri)}
      >
        Enter it on GitHub
        <ArrowSquareOutIcon size={11} />
      </Button>
    </div>
    <p class="text-xs text-muted-foreground">
      Waiting for you to finish in the browser…
    </p>
  {:else}
    <Button
      class="self-start"
      disabled={connections.providerConnecting}
      onclick={() => void connect()}
    >
      {#if connections.providerConnecting}
        <SpinnerGapIcon size={14} class="animate-spin" />
        Starting sign-in…
      {:else}
        Sign in with GitHub
      {/if}
    </Button>
  {/if}
</div>
