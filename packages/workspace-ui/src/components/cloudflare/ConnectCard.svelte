<script lang="ts">
  import { localApi } from "@solus/client-core/local-api";
  /**
   * The agent asked for the Cloudflare profile mid-turn. That is an interrupt
   * like any other — something stopped and only the user can restart it — so it
   * takes the interrupt chassis and stands at the tail of the transcript beside
   * the permission and question cards, not in a chrome banner of its own.
   */
  import {
    ArrowSquareOutIcon,
    CheckCircleIcon,
    CloudIcon,
    XIcon,
  } from "phosphor-svelte";
  import {
    cloudflareStore,
    getWorkspaceContext,
    CLOUDFLARE_TOKEN_URL,
  } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import InterruptCard from "../conversation/InterruptCard.svelte";
  import TranscriptChip from "../conversation/TranscriptChip.svelte";
  import CloudflareConnectForm from "./CloudflareConnectForm.svelte";

  interface Props {
    tabId: string;
  }

  let { tabId }: Props = $props();

  const session = getWorkspaceContext();
  const serverId = $derived(session.sessionFor(tabId)?.run.serverId);
  const connected = $derived(cloudflareStore.connected);

  let cardEl = $state<HTMLDivElement | null>(null);

  function dismiss() {
    cloudflareStore.dismissConnectRequest();
    requestInputFocus();
  }

  // The turn is still waiting on the agent's side, so the way back in is a
  // prompt, not a silent resume.
  function continueRun() {
    session.sendMessage("Cloudflare connected — continue", undefined, tabId);
    cloudflareStore.dismissConnectRequest();
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

<div bind:this={cardEl}>
  <InterruptCard
    eyebrow="Cloudflare"
    title="Connect Cloudflare"
    testId="cloudflare-connect-card"
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
          <span
            >Connected{cloudflareStore.accountName
              ? ` as ${cloudflareStore.accountName}`
              : ""}.</span
          >
        </div>
      {:else}
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p class="text-sm text-muted-foreground">
            Needed to put this online. Free — no credit card.
          </p>
          <button
            type="button"
            class="interrupt-btn interrupt-btn--secondary"
            onclick={() => void localApi.openExternal(CLOUDFLARE_TOKEN_URL)}
          >
            <CloudIcon size={12} weight="fill" />
            Create API token
            <ArrowSquareOutIcon size={11} />
          </button>
        </div>

        {#if serverId}
          <CloudflareConnectForm {serverId} autofocus />
        {/if}

        <p class="text-xs text-muted-foreground opacity-80">
          Paste the token here, not into the chat.
        </p>
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
