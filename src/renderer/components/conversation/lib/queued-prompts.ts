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

const NUMBER_WORDS: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6',
  seven: '7', eight: '8', nine: '9', ten: '10', twelve: '12',
}

/** Providers name their windows however they like — `five_hour`, `Codex 5h`,
 *  `seven_day`. Reduce them to the duration a person would say out loud, and to
 *  nothing at all when there is no window in there to find: a blank is better
 *  than printing a provider's internal key at someone. */
export function formatLimitWindow(rateLimitType?: string): string {
  const raw = rateLimitType?.toLowerCase().replace(/[_-]+/g, ' ').trim()
  if (!raw) return ''

  const digits = raw.match(/(\d+)\s*(w|wk|wks|week|weeks|h|hr|hrs|hour|hours|d|day|days|m|min|mins|minute|minutes)\b/)
  if (digits) return windowLabel(Number(digits[1]), digits[2][0])

  const words = raw.match(/\b([a-z]+)\s+(week|weeks|hour|hours|day|days|minute|minutes)\b/)
  const spelled = words && NUMBER_WORDS[words[1]]
  if (spelled) return windowLabel(Number(spelled), words[2][0])

  // A window named only in words ("weekly", "week") still has one duration.
  return raw.includes('week') ? 'weekly' : ''
}

/** "weekly" reads better than "1w"; every other count keeps its number. */
function windowLabel(count: number, unit: string): string {
  if (unit === 'w') return count === 1 ? 'weekly' : `${count}w`
  return `${count}${unit === 'h' ? 'h' : unit === 'd' ? 'd' : 'm'}`
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
  /** The provider's raw name for the window that ran out ("Codex 5h",
   *  "five_hour"). Reduced by `formatLimitWindow` and named in the caption, so
   *  the wait reads as a known quantity rather than an unexplained pause. */
  rateLimitType?: string
  /** Epoch ms. */
  now: number
}

/** One caption for the whole queue. The bubbles carry order and content; this
 *  line carries count, cause and the single escape — stated once, at the end. */
export function queuedCaption(
  prompts: OutboundPrompt[],
  { isRateLimited, resetsAt, rateLimitType, now }: QueuedCaptionInput,
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
    const window = formatLimitWindow(rateLimitType)
    return {
      label,
      detail: `${window ? `${window} ` : ''}rate limit resets ${formatReleaseTime(resetsAt)}`,
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
