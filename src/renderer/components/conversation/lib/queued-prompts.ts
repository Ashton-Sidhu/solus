import type { OutboundPrompt } from '../../../../shared/types'

/** Fixed-width clock face. The countdown is set in type, not drawn, so it needs
 *  a stable glyph count rather than a prose duration. */
export function formatClock(seconds: number): string {
  if (seconds <= 0) return '00:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/** How long a released prompt sat in the queue. Coarse on purpose — the caption
 *  is a fact about the past, not something to count against. */
export function formatWaited(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000))
  if (mins < 1) return '<1m'
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

export interface QueuedCaption {
  /** "2 queued" / "1 still queued" / "Steering" — the kicker. */
  label: string
  /** What decides when it goes out: a reset time, or the end of this turn. */
  detail: string
  /** Live countdown, empty unless a limit is still holding the queue. */
  clock: string
  canSendNow: boolean
}

export interface QueuedCaptionInput {
  isRateLimited: boolean
  resetsAt?: number
  /** Epoch ms. */
  now: number
}

/** One caption for the whole queue. The bubbles carry order and content; this
 *  line carries count, cause and the single escape — stated once, at the end. */
export function queuedCaption(
  prompts: OutboundPrompt[],
  { isRateLimited, resetsAt, now }: QueuedCaptionInput,
): QueuedCaption | null {
  if (prompts.length === 0) return null

  // A lone in-flight steer is not a queue — it is one message being delivered.
  if (prompts.length === 1 && prompts[0].state === 'steering') {
    return { label: 'Steering', detail: '', clock: '', canSendNow: false }
  }
  if (prompts.length === 1 && prompts[0].state === 'failed') {
    return { label: 'Failed to send', detail: '', clock: '', canSendNow: false }
  }

  const label = `${prompts.length} queued`
  const heldByLimit = prompts.some((prompt) => prompt.reason === 'rate_limit')

  if (isRateLimited && heldByLimit && resetsAt) {
    const secondsLeft = Math.max(0, Math.ceil(resetsAt - now / 1000))
    return {
      label,
      detail: `rate limit resets ${formatReleaseTime(resetsAt)}`,
      clock: formatClock(secondsLeft),
      canSendNow: true,
    }
  }

  // The limit lifted and the queue is draining one prompt per turn. There is no
  // longer a time to count to, so the caption states the condition instead —
  // and says "still" because these are the ones the release did not reach.
  if (heldByLimit) {
    return { label: `${prompts.length} still queued`, detail: 'runs when this turn ends', clock: '', canSendNow: false }
  }

  return { label, detail: 'runs when this turn ends', clock: '', canSendNow: false }
}

/** Epoch seconds → "3:10 AM". */
export function formatReleaseTime(resetsAt: number): string {
  return new Date(resetsAt * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
