<script lang="ts">
  /**
   * The host refused a prompt because its author has no seat for this provider
   * (Step 2 plan §3.3, exit criterion 2). That is an interrupt like any other:
   * the turn did not start and only the member can make it possible, so it takes
   * the interrupt chassis at the tail of the transcript and offers the same
   * connect flow as Settings. Once the seat is connected, the message is sent
   * again from the failed bubble.
   */
  import { X as XIcon, CircleCheck as CheckCircleIcon } from "@lucide/svelte";
  import { seatsStore } from "../../contexts/seats/seats.store.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import InterruptCard from "../conversation/InterruptCard.svelte";
  import TranscriptChip from "../conversation/TranscriptChip.svelte";
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
    <InterruptCard
      eyebrow={seatLabel(request.provider)}
      title={connected ? "Your seat is connected" : `Connect your ${seatLabel(request.provider)} account to run this turn`}
      testId="seat-connect-card"
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
            <CheckCircleIcon size={15} weight="fill" class="shrink-0 text-(--solus-status-complete)" />
            <span>Connected. Send your message again to run it on your own login.</span>
          </div>
        {:else}
          <p class="text-sm text-muted-foreground">
            Turns on a shared host run on the seat of whoever wrote the prompt. {seatDescription(status, seatsStore.errorFor(request.serverId, request.provider))}
          </p>
          <SeatConnectPanel serverId={request.serverId} provider={request.provider} autofocus />
        {/if}
      </div>

      {#snippet footer()}
        <button type="button" class="interrupt-btn" onclick={dismiss}>
          {connected ? "Done" : "Not now"}
        </button>
        <div class="flex-1"></div>
      {/snippet}
    </InterruptCard>
  </div>
{/if}
