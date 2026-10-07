<script lang="ts">
  /**
   * The host refused a prompt because its author has no seat for this provider
   * (Step 2 plan §3.3, exit criterion 2), or the person asked to sign in with
   * `/login`. Only the member can make the turn possible, so it stands at the
   * tail of the transcript as the provider's own sign-in panel: the provider's
   * mark, two plain steps, and one action (docs/transcript-cards.md, "Sign-in
   * panel"). Once the seat is connected, it collapses to the quiet resolved
   * line, and the message is sent again from the failed bubble.
   */
  import { X as XIcon } from "@lucide/svelte";
  import { usesCloudAgentSeats } from "../../contexts/seats/cloud-agent-seats.store.svelte";
  import { seatsStore } from "../../contexts/seats/seats.store.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import AttentionCard from "../conversation/AttentionCard.svelte";
  import TranscriptCardAction from "../conversation/TranscriptCardAction.svelte";
  import ProviderMark from "../ui/ProviderMark.svelte";
  import SeatConnectPanel from "./SeatConnectPanel.svelte";
  import SignInSteps from "./SignInSteps.svelte";
  import { seatAction, seatLabel } from "./lib/seat-copy";
  import { signInCodeFlow, signInLead } from "@solus/client-core/sign-in-steps";

  const request = $derived(seatsStore.required);
  const status = $derived(request ? seatsStore.statusFor(request.serverId, request.provider) : undefined);
  const connected = $derived(status?.state === "connected");
  /** A requested card stays open on a seat that was already connected, until a new login ends. */
  const resolved = $derived(connected && (!request?.requested || request.completed === true));
  const verification = $derived(request ? seatsStore.verificationFor(request.serverId, request.provider) : undefined);
  const action = $derived(seatAction(status));

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
  {@const label = seatLabel(request.provider)}
  {@const codeFlow = signInCodeFlow(request.provider)}
  <div bind:this={cardEl}>
    {#if resolved}
      <AttentionCard
        title={request.requested ? `You're signed in to ${label}` : `${label} is connected`}
        type={request.requested ? "ready to go" : "send your message again"}
        resolved
        testId="seat-connect-card"
      >
        {#snippet icon()}<ProviderMark mark={request.provider === "claude-code" ? "claude" : "codex"} transparent />{/snippet}
        {#snippet actions()}
          <TranscriptCardAction onclick={dismiss}>Done</TranscriptCardAction>
        {/snippet}
      </AttentionCard>
    {:else}
      <div class="animate-msg-in-side py-1">
        <section
          class="overflow-hidden rounded-(--tx-card-radius) bg-(--solus-tx-card-bg) shadow-[shadow:var(--solus-tx-attention-shadow)]"
          aria-label="Sign in to {label}"
          data-testid="seat-connect-card"
        >
          <header class="flex items-center gap-3 px-3.5 pt-3.5 pb-3">
            <span class="inline-flex size-9 shrink-0 items-center justify-center rounded-[0.625rem] bg-card shadow-[shadow:var(--solus-tx-hairline)]">
              <ProviderMark mark={request.provider === "claude-code" ? "claude" : "codex"} size={18} transparent />
            </span>
            <div class="flex min-w-0 flex-1 flex-col">
              <h3 class="m-0 truncate text-transcript-card font-semibold text-(--solus-text-primary)">Sign in to {label}</h3>
              <p class="m-0 truncate text-transcript-meta text-(--muted-foreground)">
                {request.refused ? `${label} refused the login for this turn. Sign in again, then retry.` : request.requested ? `So Solus can work for you with your ${label} account` : `Connect your ${label} account to send this message`}
              </p>
            </div>
            <TranscriptCardAction kind="icon" label="Close" class="self-start" onclick={dismiss}>
              <XIcon size={13} />
            </TranscriptCardAction>
          </header>
          <div class="flex flex-col gap-2.5 px-3.5 pb-3">
            {#if usesCloudAgentSeats(request.serverId)}
              <SeatConnectPanel serverId={request.serverId} provider={request.provider} />
            {:else}
              {#if !verification}
                <p class="m-0 text-pretty text-activity-label text-(--solus-text-primary)">{signInLead(label, codeFlow)}</p>
              {/if}
              <SignInSteps
                {label}
                {codeFlow}
                {verification}
                starting={seatsStore.isBusy(request.serverId, request.provider)}
                error={seatsStore.errorFor(request.serverId, request.provider)}
                startLabel={request.refused ? "Sign in again" : action === "switch" ? "Switch account" : undefined}
                onstart={() => void seatsStore.connect(request.serverId, request.provider)}
                onsubmit={(code) => seatsStore.submitCode(request.serverId, request.provider, code)}
                oncancel={() => void seatsStore.cancel(request.serverId, request.provider)}
                ondismiss={dismiss}
                autofocus
              />
            {/if}
          </div>
        </section>
      </div>
    {/if}
  </div>
{/if}
