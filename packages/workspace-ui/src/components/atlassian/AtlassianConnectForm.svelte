<script lang="ts">
  /**
   * The browser sign-in, shared by the Settings row and the onboarding row so
   * the two can never disagree about what a failure means.
   *
   * No credential passes through the renderer at all: the host opens the flow,
   * the browser completes it, and the host announces the result.
   */
  import { localApi } from "@solus/client-core/local-api";
  import {
    ExternalLink as ArrowSquareOutIcon,
    LoaderCircle as SpinnerGapIcon,
  } from "@lucide/svelte";
  import { atlassianStore, ATLASSIAN_SIGNUP_URL } from "../../contexts";
  import { Button } from "../ui/button";

  interface Props {
    serverId: string;
    /** Fires once the sign-in is connected. */
    onconnected?: () => void;
  }

  let { serverId, onconnected }: Props = $props();

  const failure = $derived(atlassianStore.failure(serverId));

  $effect(() => {
    if (atlassianStore.connected(serverId)) onconnected?.();
  });
</script>

<div class="flex flex-col gap-2.5">
  {#if atlassianStore.oauthAvailable(serverId)}
    <Button
      disabled={atlassianStore.connecting(serverId) || atlassianStore.awaitingBrowser(serverId)}
      onclick={() => void atlassianStore.startOAuth(serverId)}
    >
      {#if atlassianStore.awaitingBrowser(serverId)}
        <SpinnerGapIcon size={14} class="animate-spin" />
        Waiting for your browser…
      {:else}
        Connect with Atlassian
        <ArrowSquareOutIcon size={13} />
      {/if}
    </Button>

    {#if atlassianStore.awaitingBrowser(serverId)}
      <!-- Cancelling has to reach the host: the sign-in holds a fixed loopback
           port while it waits, and leaving it bound blocks the next attempt. -->
      <button
        type="button"
        class="h-7 self-start rounded-md text-muted-foreground transition-colors duration-150 hover:text-foreground"
        onclick={() => void atlassianStore.cancelBrowserWait(serverId)}
      >
        Cancel
      </button>
    {/if}
  {:else}
    <p class="text-pretty text-xs text-muted-foreground">
      This build of Solus ships no Atlassian sign-in, so it cannot connect to
      Confluence or Jira.
    </p>
  {/if}

  {#if failure}
    <p
      class="cursor-text select-text text-pretty text-xs text-(--solus-status-error)"
      role="alert"
    >
      {failure.message}
    </p>
  {/if}

  {#if atlassianStore.oauthAvailable(serverId)}
    <div
      class="rounded-lg bg-muted px-3 py-2.5 text-pretty text-xs leading-[1.55] text-muted-foreground"
    >
      <p class="font-medium text-foreground">What Solus will ask for</p>
      <p class="mt-0.5">
        Read and write access to Confluence pages and Jira issues on one
        Atlassian site, acting as you. Atlassian shows the exact list before you
        approve, and you can revoke it from your Atlassian account at any time.
      </p>
      <p class="mt-2.5 border-t border-border/60 pt-2">
        No Atlassian site?
        <button
          type="button"
          class="-my-2 inline-flex min-h-10 items-center gap-0.5 text-(--solus-accent) underline-offset-2 hover:underline"
          onclick={() => void localApi.openExternal(ATLASSIAN_SIGNUP_URL)}
        >
          Create one free<ArrowSquareOutIcon size={10} />
        </button>
      </p>
    </div>
  {/if}
</div>
