<script lang="ts">
  import { ClockIcon, StopIcon, ArrowUpIcon } from "phosphor-svelte";
  import { getWorkspaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import {
    sendRateLimitedNow,
    cancelRateLimitedMessages,
    queueRateLimitedWait,
  } from "../../lib/rate-limit-actions";
  import {
    formatClock,
    formatLimitWindow,
    formatReleaseTime,
  } from "./lib/queued-prompts";
  import InterruptCard from "./InterruptCard.svelte";
  import TranscriptChip from "./TranscriptChip.svelte";
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

  // A held prompt is the decision, already made and durable across a reload —
  // so it, not a local flag, is what retires the card. The flag only covers the
  // gap between the click and the prompt_queued event landing.
  const hasQueuedPrompt = $derived(
    (sess?.outboundPrompts ?? []).some(
      (prompt) => prompt.state === "queued" && prompt.reason === "rate_limit",
    ),
  );
  let userChoseQueue = $state(false);

  $effect(() => {
    if (sess?.status !== "rate_limited") userChoseQueue = false;
  });

  // Purely a decision surface. Once the prompt is queued — by choice here, or by
  // the 'queue' strategy that never asks — the queued bubbles state it instead,
  // so the card leaves rather than repeating them.
  const isVisible = $derived(
    rateLimitInfo != null &&
      sess?.status === "rate_limited" &&
      !userChoseQueue &&
      !hasQueuedPrompt,
  );
  let now = $state(Date.now());
  const secondsLeft = $derived(
    resetsAt ? Math.max(0, Math.ceil(resetsAt - now / 1000)) : 0,
  );
  // The countdown is the card's only graphic, and it is set in type, not
  // drawn — so it needs a fixed-width clock face, not a prose duration.
  const clockFace = $derived(formatClock(secondsLeft));
  const releaseClock = $derived(resetsAt ? formatReleaseTime(resetsAt) : "");

  $effect(() => {
    if (!isVisible || !resetsAt || secondsLeft <= 0) return;
    return liveActivityClock.subscribe((value) => { now = value; });
  });

  async function handleQueueIt() {
    userChoseQueue = true;
    await queueRateLimitedWait(
      session.apiFor(tabId),
      session.ctxFor(tabId),
      sess?.status === "rate_limited",
      (err) => session.handleError(sess!.id, err),
    );
    requestInputFocus();
  }

  async function handleSendNow() {
    await sendRateLimitedNow(
      session.apiFor(tabId),
      session.ctxFor(tabId),
      sess?.status === "rate_limited",
      (err) => session.handleError(sess!.id, err),
    );
    requestInputFocus();
  }

  function handleStop() {
    cancelRateLimitedMessages(
      session.apiFor(tabId),
      session.ctxFor(tabId),
      (err) => session.handleError(sess!.id, err),
    );
    requestInputFocus();
  }
</script>

{#if isVisible}
  <!-- §11 — nothing has been decided yet, so this gets the card chassis: what
       stopped, until when, and the three ways out. -->
  <InterruptCard
    eyebrow="Rate limited"
    title="Reached the {limitWindow || 'usage'} limit"
    testId="rate-limit-card"
  >
    {#snippet chip()}
      <TranscriptChip state="warning">Paused</TranscriptChip>
    {/snippet}

    {#snippet meta()}
      <span class="shrink-0">Resets at</span>
      <span class="font-mono text-[0.71875rem] font-medium text-(--foreground)"
        >{releaseClock}</span
      >
    {/snippet}

    {#snippet headerAside()}
      <div class="flex shrink-0 flex-col items-end">
        <span class="limit-clock font-mono">{clockFace}</span>
        <span class="limit-clock-caption">Until reset</span>
      </div>
    {/snippet}

    <div
      class="flex items-center gap-2 px-[1.125rem] py-[0.875rem] text-[0.71875rem] text-(--muted-foreground)"
    >
      <ClockIcon size={14} class="shrink-0 opacity-50" />
      <span
        >Nothing runs until you choose. Queuing sends it the moment the window
        opens.</span
      >
    </div>

    {#snippet footer()}
      <button type="button" class="interrupt-btn" onclick={handleStop}>
        <StopIcon size={14} weight="bold" />
        Stop &amp; discard
      </button>
      <div class="flex-1"></div>
      <button
        type="button"
        class="interrupt-btn interrupt-btn--secondary"
        onclick={handleQueueIt}
      >
        Queue prompt
      </button>
      <button
        type="button"
        class="interrupt-btn interrupt-btn--primary"
        onclick={handleSendNow}
      >
        <ArrowUpIcon size={14} weight="bold" />
        Send now
      </button>
    {/snippet}
  </InterruptCard>
{/if}

<style>
  /* Set in type, not drawn. */
  .limit-clock {
    font-size: 1.1875rem;
    line-height: 1.05;
    font-variant-numeric: tabular-nums;
  }
  .limit-clock-caption {
    margin-top: 0.1875rem;
    font-size: 0.53125rem;
    font-weight: 500;

    text-transform: uppercase;
    color: var(--muted-foreground);
    opacity: 0.65;
  }
</style>
