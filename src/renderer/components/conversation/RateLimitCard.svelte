<script lang="ts">
  import { fly } from 'svelte/transition'
  import { ClockIcon } from 'phosphor-svelte'
  import { getWorkspaceContext } from '../../contexts/workspace.context.svelte'
  import { requestInputFocus } from '../../lib/inputFocus'
  import { sendRateLimitedNow, cancelRateLimitedMessages, queueRateLimitedWait } from '../../lib/rate-limit-actions'

  interface Props {
    tabId: string
  }

  let { tabId }: Props = $props()

  const session = getWorkspaceContext()
  const sess = $derived(session.sessionFor(tabId))
  const rateLimitInfo = $derived(sess?.rateLimitInfo)
  const rateLimitStrategy = $derived(sess?.rateLimitStrategy)
  const queuedPrompts = $derived((sess?.serverQueuedPrompts ?? []).filter((prompt) => prompt.reason === 'rate_limit'))
  const totalQueuedCount = $derived(queuedPrompts.length)

  let userChoseQueue = $state(false)

  $effect(() => {
    if (sess?.status !== 'rate_limited') userChoseQueue = false
  })

  const showAskUI = $derived(rateLimitStrategy === 'ask' && !userChoseQueue)
  const showQueueUI = $derived(rateLimitStrategy === 'queue' || userChoseQueue)
  const isVisible = $derived(
    (showAskUI && sess?.status === 'rate_limited') || (showQueueUI && (sess?.status === 'rate_limited' || totalQueuedCount > 0))
  )
  let now = $state(Date.now())
  const secondsLeft = $derived(rateLimitInfo ? Math.max(0, Math.ceil(rateLimitInfo.resetsAt - now / 1000)) : 0)
  const countdownText = $derived(formatCountdown(secondsLeft))
  const statusText = $derived(secondsLeft <= 0 ? 'Sending momentarily' : `Sending in ${countdownText}`)

  $effect(() => {
    if (!isVisible || !rateLimitInfo || secondsLeft <= 0) return
    const timer = setInterval(() => {
      now = Date.now()
    }, 1000)
    return () => clearInterval(timer)
  })

  function formatCountdown(seconds: number) {
    if (seconds <= 0) return 'momentarily'
    const d = Math.floor(seconds / 86400)
    const h = Math.floor((seconds % 86400) / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = seconds % 60
    if (d > 0) return `${d}d ${h}h ${m}m`
    if (h > 0) return `${h}h ${m}m`
    if (m > 0) return `${m}m ${s}s`
    return `${s}s`
  }

  async function handleQueueIt() {
    userChoseQueue = true
    await queueRateLimitedWait(session.ctxFor(tabId), sess?.status === 'rate_limited', (err) => session.handleError(tabId, err))
    requestInputFocus()
  }

  async function handleSendNow() {
    await sendRateLimitedNow(session.ctxFor(tabId), sess?.status === 'rate_limited', (err) => session.handleError(tabId, err))
    requestInputFocus()
  }

  function handleStop() {
    cancelRateLimitedMessages(session.ctxFor(tabId), (err) => session.handleError(tabId, err))
    requestInputFocus()
  }
</script>

{#if isVisible}
  <div transition:fly={{ y: 8, duration: 200 }} class="mx-4 mt-2 mb-2" data-testid="rate-limit-card">
    <div
      class="overflow-hidden bg-(--solus-container-bg) border border-(--solus-permission-border)"
      style="border-radius:0.75rem;box-shadow:var(--solus-permission-shadow)"
    >
      <div
        class="flex items-center gap-1.5 px-3 py-1.5 bg-(--solus-permission-header-bg) border-b border-(--solus-permission-header-border)"
      >
        <ClockIcon size={12} class="text-(--solus-accent)" />
        <span class="text-xs sm:text-[0.6875rem] font-semibold text-(--solus-accent)">
          Rate limited{rateLimitInfo?.rateLimitType ? ` · ${rateLimitInfo.rateLimitType}` : ''}
        </span>
        <span class="ml-auto text-xs sm:text-[0.6875rem] text-(--solus-text-tertiary)">
          {showQueueUI ? statusText : `Resets in ${countdownText}`}
        </span>
      </div>

      <div class="px-3 py-2.5 flex flex-col gap-2.5">
        {#if showAskUI}
          <div class="text-sm sm:text-[0.75rem] text-(--solus-text-secondary)">
            {rateLimitInfo?.prompt ?? "You've been rate limited. What would you like to do?"}
          </div>
          <div class="flex items-center gap-2">
            <button
              onclick={handleQueueIt}
              class="text-xs sm:text-[0.6875rem] font-medium px-2.5 py-1 rounded-full cursor-pointer bg-(--solus-accent-light) text-(--solus-accent)"
              style="border:0.0625rem solid var(--solus-accent-soft)"
              onmouseenter={(e) => {
                (e.currentTarget as HTMLElement).style.background = 'var(--solus-accent-soft)'
              }}
              onmouseleave={(e) => {
                (e.currentTarget as HTMLElement).style.background = 'var(--solus-accent-light)'
              }}
            >
              Queue it
            </button>
            <button
              onclick={handleSendNow}
              class="text-[0.6875rem] font-medium px-2.5 py-1 rounded-full cursor-pointer text-(--solus-text-secondary) hover:text-(--solus-text-primary)"
              style="background:transparent;border:0.0625rem solid var(--solus-permission-border)"
            >
              Send now
            </button>
            <button
              onclick={handleStop}
              class="text-[0.6875rem] font-medium px-2.5 py-1 rounded-full cursor-pointer text-(--solus-text-tertiary) hover:text-(--solus-text-secondary)"
              style="background:transparent;border:0.0625rem solid transparent"
            >
              Stop
            </button>
          </div>
        {:else}
          <div class="text-[0.75rem] text-(--solus-text-secondary)">
            {totalQueuedCount === 0
              ? rateLimitInfo?.queuedPrompt ?? 'Waiting to send this message.'
              : totalQueuedCount === 1
              ? '1 message queued.'
              : `${totalQueuedCount} messages queued.`}
          </div>
          <div class="flex items-center gap-2">
            <button
              onclick={handleSendNow}
              class="text-[0.6875rem] font-medium px-2.5 py-1 rounded-full cursor-pointer bg-(--solus-accent-light) text-(--solus-accent)"
              style="border:0.0625rem solid var(--solus-accent-soft)"
              onmouseenter={(e) => {
                (e.currentTarget as HTMLElement).style.background = 'var(--solus-accent-soft)'
              }}
              onmouseleave={(e) => {
                (e.currentTarget as HTMLElement).style.background = 'var(--solus-accent-light)'
              }}
            >
              Send anyway
            </button>
            <button
              onclick={handleStop}
              class="text-[0.6875rem] font-medium px-2.5 py-1 rounded-full cursor-pointer text-(--solus-text-tertiary) hover:text-(--solus-text-secondary)"
              style="background:transparent;border:0.0625rem solid transparent"
            >
              Stop
            </button>
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}
