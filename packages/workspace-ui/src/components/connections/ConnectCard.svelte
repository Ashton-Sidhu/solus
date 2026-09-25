<script lang="ts">
  /**
   * An agent asked for an external account mid-turn. That is an interrupt like
   * any other — something stopped and only the user can restart it — so it takes
   * the attention shell and stands at the tail of the transcript beside the
   * permission and question cards, not in a chrome banner of its own. Once the
   * account is connected, it collapses to a quiet line that offers Continue.
   *
   * One card for every provider. What genuinely differs is the body and the
   * completion signal: Cloudflare is a token pasted here, and the rest are
   * browser sign-ins whose answer arrives on a host event. The shell, the
   * dismissal, and the continue are the same either way.
   */
  import { localApi } from "@solus/client-core/local-api";
  import Icon from "@iconify/svelte";
  import {
    atlassianStore,
    cloudflareStore,
    connectionsStore,
    connectRequestStore,
    getWorkspaceContext,
  } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import AttentionCard from "../conversation/AttentionCard.svelte";
  import TranscriptCardAction from "../conversation/TranscriptCardAction.svelte";
  import { ensureIconCollections } from "../diagram/iconify";
  import { PROVIDER_LOGOS } from "../settings/lib/provider-logos";
  import CloudflareConnectForm from "../cloudflare/CloudflareConnectForm.svelte";
  import AtlassianConnectForm from "../atlassian/AtlassianConnectForm.svelte";
  import GitHubConnectForm from "./GitHubConnectForm.svelte";
  import { connectCardCopy } from "./lib/connect-card-copy";

  interface Props {
    tabId: string;
  }

  let { tabId }: Props = $props();

  ensureIconCollections();

  const session = getWorkspaceContext();
  const request = $derived(connectRequestStore.request);
  const serverId = $derived(session.sessionFor(tabId)?.run.serverId);
  const copy = $derived(
    request ? connectCardCopy(request.provider, request.reason) : null,
  );

  const connected = $derived.by(() => {
    if (!request || !serverId || request.accountConnectionsUrl) return false;
    if (request.provider === "cloudflare") return cloudflareStore.connected;
    if (request.provider === "atlassian") return atlassianStore.connected(serverId);
    if (request.provider === "github")
      return (
        connectionsStore.providerLoaded &&
        !!connectionsStore.providerStatus?.connected
      );
    return false;
  });

  let cardEl = $state<HTMLDivElement | null>(null);

  function dismiss() {
    connectRequestStore.dismiss();
    requestInputFocus();
  }

  // The turn is still waiting on the agent's side, so the way back in is a
  // prompt, not a silent resume.
  function continueRun() {
    if (copy) session.dispatch.sendMessage(`${copy.providerLabel} connected — continue`, undefined, tabId);
    connectRequestStore.dismiss();
    requestInputFocus();
  }

  // Escape belongs to whatever owns focus. While the caret is in this card it
  // is the card's; the conversation's own Escape bindings keep it otherwise.
  function handleKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    if (!(event.target instanceof Node) || !cardEl?.contains(event.target)) return;
    event.preventDefault();
    dismiss();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if request && copy}
  <div bind:this={cardEl}>
    <AttentionCard
      title={connected ? `${copy.providerLabel} connected` : copy.title}
      type={connected ? "continue the turn" : copy.reason}
      resolved={connected}
      testId="connection-connect-card"
    >
      {#snippet icon()}
        <span class="inline-flex size-5 items-center justify-center rounded-md bg-card shadow-[shadow:var(--solus-tx-hairline)]">
          <Icon icon={PROVIDER_LOGOS[request.provider]} aria-hidden="true" />
        </span>
      {/snippet}

      {#snippet actions()}
        {#if connected}
          <TranscriptCardAction kind="ghost" onclick={dismiss}>Done</TranscriptCardAction>
          <TranscriptCardAction onclick={continueRun}>Continue</TranscriptCardAction>
        {:else}
          <div class="flex flex-wrap items-end justify-end gap-2">
            <TranscriptCardAction kind="ghost" onclick={dismiss}>Not now</TranscriptCardAction>
            {#if serverId}
              {#if request.accountConnectionsUrl}
                <TranscriptCardAction kind="filled" onclick={() => void localApi.openExternal(request!.accountConnectionsUrl!)}>
                  Open account connections
                </TranscriptCardAction>
                <TranscriptCardAction onclick={continueRun}>Continue</TranscriptCardAction>
              {:else if request.provider === "cloudflare"}
                <div class="min-w-0 flex-1"><CloudflareConnectForm {serverId} autofocus /></div>
              {:else if request.provider === "atlassian"}
                <AtlassianConnectForm {serverId} />
              {:else if request.provider === "github"}
                <GitHubConnectForm {serverId} />
              {/if}
            {/if}
          </div>
        {/if}
      {/snippet}

      <p class="m-0 text-(--muted-foreground)">{copy.purpose}</p>

      {#if request.accountConnectionsUrl}
        <p class="m-0 text-xs text-(--muted-foreground)">Connect your account, then return here and continue.</p>
      {:else if serverId && request.provider === "google"}
        <p class="m-0 text-xs text-(--muted-foreground)">Connect this account in Settings, then continue.</p>
      {/if}
      {#if copy.note}
        <p class="m-0 text-xs text-(--muted-foreground) opacity-80">{copy.note}</p>
      {/if}
      {#if request.provider === "cloudflare"}
        <p class="m-0 text-xs text-(--muted-foreground) opacity-80">
          Paste the token here, not into the chat.
        </p>
      {/if}
    </AttentionCard>
  </div>
{/if}
