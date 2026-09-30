<script lang="ts">
  /**
   * The host refused a prompt because its author has no seat for this provider
   * (Step 2 plan §3.3, exit criterion 2). That is an interrupt like any other:
   * the turn did not start and only the member can make it possible, so it takes
   * the attention shell at the tail of the transcript and offers the same
   * connect flow as Settings. Once the seat is connected, the card collapses to
   * a quiet line, and the message is sent again from the failed bubble.
   */
  import { X as XIcon } from "@lucide/svelte";
  import { seatsStore } from "../../contexts/seats/seats.store.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import AttentionCard from "../conversation/AttentionCard.svelte";
  import TranscriptCardAction from "../conversation/TranscriptCardAction.svelte";
  import ProviderMark from "../ui/ProviderMark.svelte";
  import SeatConnectPanel from "./SeatConnectPanel.svelte";
  import { seatDescription, seatLabel } from "./lib/seat-copy";

  const request = $derived(seatsStore.required);
  const status = $derived(request ? seatsStore.statusFor(request.serverId, request.provider) : undefined);
  const connected = $derived(status?.state === "connected");

  let cardEl = $state<HTMLDivElement | null>(null);

  function dismiss() {
    seatsStore.dismiss();
    requestInputFocus();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    if (!(event.target instanceof Node) || !cardEl?.contains(event.target)) return;
    event.preventDefault();
    dismiss();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if request}
  <div bind:this={cardEl}>
    <AttentionCard
      title={connected ? `${seatLabel(request.provider)} seat connected` : `Connect your ${seatLabel(request.provider)} seat`}
      type={connected ? "send your message again" : "to run this turn"}
      resolved={connected}
      testId="seat-connect-card"
    >
      {#snippet icon()}
        <span class="inline-flex size-5 items-center justify-center rounded-md bg-card shadow-[shadow:var(--solus-tx-hairline)]">
          <ProviderMark mark={request.provider === "claude-code" ? "claude" : "codex"} transparent />
        </span>
      {/snippet}

      {#snippet actions()}
        {#if connected}
          <TranscriptCardAction onclick={dismiss}>Done</TranscriptCardAction>
        {:else}
          <TranscriptCardAction kind="icon" label="Dismiss" onclick={dismiss}>
            <XIcon size={13} />
          </TranscriptCardAction>
        {/if}
      {/snippet}

      <p class="m-0 text-(--muted-foreground)">
        Turns on a shared host run on the seat of whoever wrote the prompt. {seatDescription(status, seatsStore.errorFor(request.serverId, request.provider))}
      </p>
      <SeatConnectPanel serverId={request.serverId} provider={request.provider} autofocus />
      <div>
        <TranscriptCardAction kind="ghost" class="-ml-2.5" onclick={dismiss}>Not now</TranscriptCardAction>
      </div>
    </AttentionCard>
  </div>
{/if}
