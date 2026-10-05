<script lang="ts">
  import {
    Clock as ClockIcon,
    Moon as MoonIcon,
    Square as StopIcon,
    ArrowUp as ArrowUpIcon,
  } from "@lucide/svelte";
  import { getSessionSidebarStore, getWorkspaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { formatResetClock } from "../../lib/sessionUtils";
  import { toasts } from "../../lib/toasts";
  import { limitResetSnoozeUntil } from "../session/lib/task-snooze";
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
  import { presenceStore } from "../../contexts/presence/presence.store.svelte";
  import { canDriveSession } from "../../contexts/sharing/session-drive";
  import { limitTitle } from "../presence/lib/actor-name";

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
  // The decision is an editor's; a member who may only read sees the limit.
  const canDrive = $derived(canDriveSession(sess?.run.serverId, sess?.id));
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

  const sidebarStore = getSessionSidebarStore();
  // Only a session's own row can be snoozed; a task's session never is alone.
  const sessionRow = $derived(sidebarStore.allTasks.find((row) => row.key === tabId));
  // Offered only when the provider said when the window reopens.
  const snoozeUntil = $derived(
    sessionRow && sidebarStore.canShelve(sessionRow) && resetsAt
      ? limitResetSnoozeUntil(resetsAt * 1000, now)
      : null,
  );

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

  function handleSnooze() {
    if (!snoozeUntil) return;
    sidebarStore.snoozeRow(tabId, snoozeUntil);
    toasts.undo(`Session snoozed until ${formatResetClock(snoozeUntil)}`, () =>
      sidebarStore.snoozeRow(tabId, null),
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
    title={limitTitle(limitWindow, rateLimitInfo?.turnAuthor, sess ? presenceStore.currentUserId(sess.run.serverId) : null)}
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
      {#if !canDrive}
        <span class="text-transcript-meta text-(--muted-foreground)">Waiting for an editor</span>
      {:else}
      <TranscriptCardAction kind="ghost" onclick={handleStop}>
        <StopIcon size={13} />
        Stop &amp; discard
      </TranscriptCardAction>
      <!-- Queuing means "send it when the window opens". Once it has, the
           button would be a second Send now under a waiting label. -->
      {#if snoozeUntil}
        <TranscriptCardAction kind="ghost" onclick={handleSnooze}>
          <MoonIcon size={13} />
          Snooze until limit resets
        </TranscriptCardAction>
      {/if}
      {#if !hasReopened}
        <TranscriptCardAction kind="ghost" onclick={handleQueueIt}>Queue prompt</TranscriptCardAction>
      {/if}
      <TranscriptCardAction kind="filled" onclick={handleSendNow}>
        <ArrowUpIcon size={13} />
        Send now
      </TranscriptCardAction>
      {/if}
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
