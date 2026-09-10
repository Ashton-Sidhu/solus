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
    footerClass="rate-limit-footer"
  >
    {#snippet meta()}
      {#if releaseClock}
        <span class="shrink-0">{hasReopened ? "Reset at" : "Resets at"}</span>
        <span class="text-transcript-meta font-medium text-(--foreground)"
          >{releaseClock}</span
        >
      {:else}
        <span class="shrink-0">Reset time unknown</span>
      {/if}
    {/snippet}

    <!-- No reset means no countdown to draw. A clock reading 00:00 would say
         the window opens now, which is the one thing we do not know. -->
    {#snippet headerAside()}
      {#if releaseClock}
        <div class="flex shrink-0 flex-col items-end">
          <span class="limit-clock">{hasReopened ? "Open" : clockFace}</span>
          <span class="limit-clock-caption"
            >{hasReopened ? "Window" : "Until reset"}</span
          >
        </div>
      {/if}
    {/snippet}

    <div
      class="flex items-center gap-2 px-[1.125rem] py-[0.875rem] text-transcript-meta text-(--muted-foreground) pointer-fine:[.is-laptop-display_&]:px-3.5 pointer-fine:[.is-laptop-display_&]:py-2.5"
    >
      <ClockIcon size={14} class="shrink-0 opacity-50" />
      <span>
        {#if hasReopened}
          The window reopened while this waited. Nothing has run — your prompt
          is still here, and still yours to send or discard.
        {:else if releaseClock}
          Nothing runs until you choose. Queuing sends it the moment the window
          opens.
        {:else}
          Nothing runs until you choose. This provider did not say when the
          window reopens, so a queued prompt waits for you to send it.
        {/if}
      </span>
    </div>

    {#snippet footer()}
      <button type="button" class="interrupt-btn" onclick={handleStop}>
        <StopIcon size={13} weight="bold" />
        Stop &amp; discard
      </button>
      <div class="flex-1"></div>
      <!-- Queuing means "send it when the window opens". Once it has, the
           button would be a second Send now under a waiting label. -->
      {#if !hasReopened}
        <button
          type="button"
          class="interrupt-btn interrupt-btn--secondary"
          onclick={handleQueueIt}
        >
          Queue prompt
        </button>
      {/if}
      <button
        type="button"
        class="interrupt-btn interrupt-btn--primary"
        onclick={handleSendNow}
      >
        <ArrowUpIcon size={13} weight="bold" />
        Send now
      </button>
    {/snippet}
  </InterruptCard>
{/if}

<style>
  /* Set in type, not drawn. */
  .limit-clock {
    font-size: var(--text-2xl);
    line-height: 1.05;
    font-variant-numeric: tabular-nums;
  }
  .limit-clock-caption {
    margin-top: 0.1875rem;
    font-size: var(--text-transcript-meta);
    font-weight: 500;

    text-transform: uppercase;
    color: var(--muted-foreground);
    opacity: 0.65;
  }

  :global(.rate-limit-footer) {
    gap: 0.375rem;
    padding-top: 0.5rem;
    padding-right: 0.75rem;
    padding-bottom: 0.5rem;
    padding-left: 0.875rem;
  }
  :global(.rate-limit-footer .interrupt-btn) {
    height: 1.75rem;
    gap: 0.3125rem;
    padding-right: 0.4375rem;
    padding-left: 0.4375rem;
    font-size: var(--text-transcript-meta);
  }
  :global(.rate-limit-footer .interrupt-btn--secondary) {
    padding-right: 0.5625rem;
    padding-left: 0.5625rem;
  }
  :global(.rate-limit-footer .interrupt-btn--primary) {
    padding-right: 0.625rem;
    padding-left: 0.625rem;
  }

  @media (pointer: fine) {
    :global(html.is-laptop-display) .limit-clock {
      font-size: var(--text-xl);
    }
    :global(html.is-laptop-display .rate-limit-footer) {
      padding: 0.375rem 0.625rem 0.375rem 0.75rem;
    }
    :global(html.is-laptop-display .rate-limit-footer .interrupt-btn) {
      height: 1.5rem;
    }
  }
</style>
