<script lang="ts">
  /**
   * An agent asked for an external account mid-turn. That is an interrupt like
   * any other — something stopped and only the user can restart it — so it takes
   * the interrupt chassis and stands at the tail of the transcript beside the
   * permission and question cards, not in a chrome banner of its own.
   *
   * One card for every provider. What genuinely differs is the body and the
   * completion signal: Cloudflare is a token pasted here, and the rest are
   * browser sign-ins whose answer arrives on a host event. The chassis, the
   * dismissal, and the continue are the same either way.
   */
  import { X as XIcon, CircleCheck as CheckCircleIcon } from "@lucide/svelte";
  import {
    atlassianStore,
    cloudflareStore,
    connectionsStore,
    connectRequestStore,
    getWorkspaceContext,
  } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import InterruptCard from "../conversation/InterruptCard.svelte";
  import TranscriptChip from "../conversation/TranscriptChip.svelte";
  import CloudflareConnectForm from "../cloudflare/CloudflareConnectForm.svelte";
  import AtlassianConnectForm from "../atlassian/AtlassianConnectForm.svelte";
  import GitHubConnectForm from "./GitHubConnectForm.svelte";
  import { connectCardCopy } from "./lib/connect-card-copy";

  interface Props {
    tabId: string;
  }

  let { tabId }: Props = $props();

  const session = getWorkspaceContext();
  const request = $derived(connectRequestStore.request);
  const serverId = $derived(session.sessionFor(tabId)?.run.serverId);
  const copy = $derived(
    request ? connectCardCopy(request.provider, request.reason) : null,
  );

  const connected = $derived.by(() => {
    if (!request || !serverId) return false;
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
    if (copy) session.sendMessage(`${copy.eyebrow} connected — continue`, undefined, tabId);
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
    <InterruptCard
      eyebrow={copy.eyebrow}
      title={copy.title}
      testId="connection-connect-card"
    >
      {#snippet chip()}
        {#if connected}
          <TranscriptChip state="positive">Connected</TranscriptChip>
        {/if}
      {/snippet}

      {#snippet headerAside()}
        <button
          type="button"
          class="-mr-1 -mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
          aria-label="Dismiss"
          onclick={dismiss}
        >
          <XIcon size={12} weight="bold" />
        </button>
      {/snippet}

      <div class="flex flex-col gap-3 px-[1.125rem] py-[0.875rem]">
        {#if connected}
          <div class="flex items-center gap-2 text-sm">
            <CheckCircleIcon
              size={15}
              weight="fill"
              class="shrink-0 text-(--solus-status-complete)"
            />
            <span>Connected.</span>
          </div>
        {:else}
          <p class="text-sm text-muted-foreground">{copy.purpose}</p>

          {#if serverId}
            {#if request.provider === "cloudflare"}
              <CloudflareConnectForm {serverId} autofocus />
            {:else if request.provider === "atlassian"}
              <AtlassianConnectForm {serverId} />
            {:else if request.provider === "github"}
              <GitHubConnectForm {serverId} />
            {:else}
              <p class="text-sm text-muted-foreground">
                Connect this account in Settings, then continue.
              </p>
            {/if}
          {/if}

          {#if copy.note}
            <p class="text-xs text-muted-foreground opacity-80">{copy.note}</p>
          {/if}
          {#if request.provider === "cloudflare"}
            <p class="text-xs text-muted-foreground opacity-80">
              Paste the token here, not into the chat.
            </p>
          {/if}
        {/if}
      </div>

      {#snippet footer()}
        <button type="button" class="interrupt-btn" onclick={dismiss}>
          Not now
        </button>
        <div class="flex-1"></div>
        {#if connected}
          <button
            type="button"
            class="interrupt-btn interrupt-btn--primary"
            onclick={continueRun}
          >
            Continue
          </button>
        {/if}
      {/snippet}
    </InterruptCard>
  </div>
{/if}
