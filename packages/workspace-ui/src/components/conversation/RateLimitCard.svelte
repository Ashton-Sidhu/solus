<script lang="ts">
  import {
    Clock as ClockIcon,
    Square as StopIcon,
    ArrowUp as ArrowUpIcon,
  } from "@lucide/svelte";
  import { getWorkspaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import {
    sendRateLimitedNow,
    cancelRateLimitedMessages,
    queueRateLimitedWait,
  } from "../../lib/rate-limit-actions";
  import {
    needsRateLimitDecision,
    formatClock,
    formatLimitWindow,
    formatReleaseTime,
  } from "./lib/queued-prompts";
  import AttentionCard from "./AttentionCard.svelte";
  import TranscriptCardAction from "./TranscriptCardAction.svelte";
  import { liveActivityClock } from "../../lib/shared-clock";

  interface Props {
    tabId: string;
  }

  let { tabId }: Props = $props();

  const session = getWorkspaceContext();
  const sess = $derived(session.sessionFor(tabId));
  const rateLimitInfo = $derived(sess?.rateLimitInfo);
  const resetsAt = $derived(rateLimitInfo?.resetsAt);
  const limitWindow = $derived(formatLimitWindow(rateLimitInfo?.rateLimitType));

  const isVisible = $derived(needsRateLimitDecision(sess));
  let now = $state(Date.now());
  const secondsLeft = $derived(
    resetsAt ? Math.max(0, Math.ceil(resetsAt - now / 1000)) : 0,
  );
  // The countdown is the card's only graphic, and it is set in type, not
  // drawn — so it needs a fixed-width clock face, not a prose duration.
  const clockFace = $derived(formatClock(secondsLeft));
  const releaseClock = $derived(resetsAt ? formatReleaseTime(resetsAt) : "");
  // A window that reopens while the card is still asking does not answer it:
  // the held prompt stays held. Saying 00:00 would report a countdown still
  // running, so the clock face states the fact it arrived at instead.
  const hasReopened = $derived(!!resetsAt && secondsLeft <= 0);

  $effect(() => {
    if (!isVisible || !resetsAt || secondsLeft <= 0) return;
    return liveActivityClock.subscribe((value) => {
      now = value;
    });
  });

  async function handleQueueIt() {
    await queueRateLimitedWait(
      session.apiFor(tabId),
      session.ctxFor(tabId),
      sess?.status === "rate_limited",
      (err) => session.eventReducer.handleError(sess!.id, err),
    );
    requestInputFocus();
  }

  async function handleSendNow() {
    await sendRateLimitedNow(
      session.apiFor(tabId),
      session.ctxFor(tabId),
      sess?.status === "rate_limited",
      (err) => session.eventReducer.handleError(sess!.id, err),
    );
    requestInputFocus();
  }

  function handleStop() {
    cancelRateLimitedMessages(
      session.apiFor(tabId),
      session.ctxFor(tabId),
      (err) => session.eventReducer.handleError(sess!.id, err),
    );
    requestInputFocus();
  }
</script>

{#if isVisible}
  <!-- §11 — nothing has been decided yet, so this gets the attention shell:
       what stopped, until when, and the three ways out. The card leaves once
       the user decides, so it has no resolved line. -->
  <AttentionCard
    title="Reached the {limitWindow || 'usage'} limit"
    type={hasReopened ? "window open" : "rate limited"}
    testId="rate-limit-card"
  >
    {#snippet icon()}<ClockIcon />{/snippet}

    <!-- No reset means no countdown. A clock reading 00:00 would say the window
         opens now, which is the one thing we do not know. -->
    {#snippet rail()}
      {#if releaseClock}
        <span>{releaseClock}</span>
        {#if !hasReopened}<span class="tabular-nums">{clockFace}</span>{/if}
      {/if}
    {/snippet}

    {#snippet actions()}
      <TranscriptCardAction kind="ghost" onclick={handleStop}>
        <StopIcon size={13} />
        Stop &amp; discard
      </TranscriptCardAction>
      <!-- Queuing means "send it when the window opens". Once it has, the
           button would be a second Send now under a waiting label. -->
      {#if !hasReopened}
        <TranscriptCardAction kind="ghost" onclick={handleQueueIt}>Queue prompt</TranscriptCardAction>
      {/if}
      <TranscriptCardAction kind="filled" onclick={handleSendNow}>
        <ArrowUpIcon size={13} />
        Send now
      </TranscriptCardAction>
    {/snippet}

    <p class="m-0 text-(--muted-foreground)">
      {#if hasReopened}
        The window reopened while this waited. Nothing has run — your prompt
        is still here, and still yours to send or discard.
      {:else if releaseClock}
        Nothing runs until you choose. Queuing sends it the moment the window
        opens at {releaseClock}.
      {:else}
        Nothing runs until you choose. This provider did not say when the
        window reopens, so a queued prompt waits for you to send it.
      {/if}
    </p>
  </AttentionCard>
{/if}
