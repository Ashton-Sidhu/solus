<script lang="ts">
  import { fly } from 'svelte/transition'
  import { ClockIcon, StopIcon, ArrowUpIcon } from 'phosphor-svelte'
  import { getWorkspaceContext } from '../../contexts'
  import { requestInputFocus } from '../../lib/inputFocus'
  import { sendRateLimitedNow, cancelRateLimitedMessages, queueRateLimitedWait } from '../../lib/rate-limit-actions'
  import { formatClock, formatReleaseTime } from './lib/queued-prompts'
  import TranscriptChip from './TranscriptChip.svelte'

  interface Props {
    tabId: string
  }

  let { tabId }: Props = $props()

  const session = getWorkspaceContext()
  const sess = $derived(session.sessionFor(tabId))
  const rateLimitInfo = $derived(sess?.rateLimitInfo)
  const resetsAt = $derived(rateLimitInfo?.resetsAt)
  const rateLimitType = $derived(rateLimitInfo?.rateLimitType)

  let userChoseQueue = $state(false)

  $effect(() => {
    if (sess?.status !== 'rate_limited') userChoseQueue = false
  })

  // Purely a decision surface. Once the prompt is queued — by choice here, or by
  // the 'queue' strategy that never asks — the queued bubbles state it instead,
  // so the card leaves rather than repeating them.
  const isVisible = $derived(rateLimitInfo != null && sess?.status === 'rate_limited' && !userChoseQueue)
  let now = $state(Date.now())
  const secondsLeft = $derived(resetsAt ? Math.max(0, Math.ceil(resetsAt - now / 1000)) : 0)
  // The countdown is the card's only graphic, and it is set in type, not
  // drawn — so it needs a fixed-width clock face, not a prose duration.
  const clockFace = $derived(formatClock(secondsLeft))
  const releaseClock = $derived(resetsAt ? formatReleaseTime(resetsAt) : '')

  $effect(() => {
    if (!isVisible || !resetsAt || secondsLeft <= 0) return
    const timer = setInterval(() => {
      now = Date.now()
    }, 1000)
    return () => clearInterval(timer)
  })

  async function handleQueueIt() {
    userChoseQueue = true
    await queueRateLimitedWait(session.apiFor(tabId), session.ctxFor(tabId), sess?.status === 'rate_limited', (err) => session.handleError(tabId, err))
    requestInputFocus()
  }

  async function handleSendNow() {
    await sendRateLimitedNow(session.apiFor(tabId), session.ctxFor(tabId), sess?.status === 'rate_limited', (err) => session.handleError(tabId, err))
    requestInputFocus()
  }

  function handleStop() {
    cancelRateLimitedMessages(session.apiFor(tabId), session.ctxFor(tabId), (err) => session.handleError(tabId, err))
    requestInputFocus()
  }
</script>

{#if isVisible}
  <!-- §11 — nothing has been decided yet, so this gets the card chassis: what
       stopped, until when, and the three ways out. -->
  <div transition:fly={{ y: 8, duration: 200 }} class="mx-auto my-2 w-[88%]" data-testid="rate-limit-card">
    <div class="interrupt-card overflow-hidden rounded-xl">
      <div class="flex items-start gap-3 px-[1.0625rem] pt-[0.9375rem] pb-3">
        <div class="min-w-0 flex-1">
          <div class="interrupt-kicker">Rate limited</div>
          <div class="flex min-w-0 items-center gap-2">
            <span class="truncate text-[0.875rem] leading-tight font-semibold tracking-[-0.012em]">
              Reached the {rateLimitType ?? 'usage'} limit
            </span>
            <TranscriptChip state="warning">Paused</TranscriptChip>
          </div>
          <div class="mt-[0.1875rem] truncate text-[0.71875rem] text-(--muted-foreground)">
            Resets at
            <span class="font-mono text-(--solus-text-primary)">{releaseClock}</span>
          </div>
        </div>
        <div class="flex shrink-0 flex-col items-end">
          <span class="limit-clock font-mono">{clockFace}</span>
          <span class="limit-clock-caption">Until reset</span>
        </div>
      </div>

      <div class="px-4">
        <div class="flex items-center gap-2 text-[0.71875rem] text-(--muted-foreground)">
          <ClockIcon size={12} class="shrink-0 opacity-50" />
          <span>Nothing runs until you choose. Queuing sends it the moment the window opens.</span>
        </div>
      </div>

      <!-- Escape hatch left, affirmative right. Never the reverse. -->
      <div class="interrupt-footer mt-3 flex items-center gap-2 px-3 pt-[0.6875rem] pb-3">
        <button type="button" class="interrupt-btn" onclick={handleStop}>
          <StopIcon size={11} weight="bold" />
          Stop &amp; discard
        </button>
        <span class="flex-1"></span>
        <button type="button" class="interrupt-btn interrupt-btn--soft" onclick={handleQueueIt}>
          Queue until reset
        </button>
        <button type="button" class="interrupt-btn interrupt-btn--primary" onclick={handleSendNow}>
          <ArrowUpIcon size={12} weight="bold" />
          Send now
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* .interrupt-card / .interrupt-btn chrome is shared with PermissionCard.
     This card has no header rule — the countdown closes the header instead —
     so .interrupt-header is deliberately absent. */
  .interrupt-card {
    background: var(--card);
    box-shadow: var(--solus-tx-card-shadow);
  }

  .interrupt-kicker {
    margin-bottom: 0.3125rem;
    font-size: 0.59375rem;
    font-weight: 500;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted-foreground);
    opacity: 0.7;
  }

  .interrupt-footer {
    border-top: 0.0625rem solid var(--solus-tx-rule);
  }

  /* Set in type, not drawn. */
  .limit-clock {
    font-size: 1.1875rem;
    line-height: 1.05;
    letter-spacing: -0.03em;
    font-variant-numeric: tabular-nums;
  }
  .limit-clock-caption {
    margin-top: 0.1875rem;
    font-size: 0.53125rem;
    font-weight: 500;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: var(--muted-foreground);
    opacity: 0.65;
  }
</style>
