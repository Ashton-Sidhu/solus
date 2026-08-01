import { describe, expect, it } from 'bun:test'
import { formatClock, formatLimitWindow, formatWaited, queuedCaption } from '../../src/renderer/components/conversation/lib/queued-prompts'
import type { OutboundPrompt } from '../../src/shared/types'

const NOW = 1_700_000_000_000

function heldPrompt(overrides: Partial<OutboundPrompt> = {}): OutboundPrompt {
  return {
    clientPromptId: `p-${Math.random()}`,
    queueId: 'q-1',
    text: 'Restyle the rate-limit card.',
    state: 'queued',
    enqueuedAt: NOW - 60_000,
    reason: 'rate_limit',
    ...overrides,
  }
}

describe('queuedCaption', () => {
  // One caption for the whole queue is the point of the redesign: if this ever
  // returns per-prompt state again, the transcript is back to saying it twice.
  it('counts every held prompt in a single caption', () => {
    const caption = queuedCaption([heldPrompt(), heldPrompt(), heldPrompt()], {
      isRateLimited: true,
      resetsAt: NOW / 1000 + 1812,
      now: NOW,
    })
    expect(caption?.label).toBe('3 queued')
    expect(caption?.detail).toStartWith('rate limit resets ')
    expect(caption?.clock).toBe('30:12')
    expect(caption?.canSendNow).toBe(true)
  })

  // Which window ran out decides whether the wait is worth sitting through: a
  // 5h reset is a coffee break, a weekly one is not. Naming it is the whole
  // difference between an informed wait and an unexplained pause.
  it('names the window that ran out ahead of "rate limit"', () => {
    const weekly = queuedCaption([heldPrompt()], {
      isRateLimited: true,
      resetsAt: NOW / 1000 + 60,
      rateLimitType: 'weekly',
      now: NOW,
    })
    expect(weekly?.detail).toStartWith('weekly rate limit resets ')

    // The provider's own prefix is not the user's business — only the window is.
    const fiveHour = queuedCaption([heldPrompt()], {
      isRateLimited: true,
      resetsAt: NOW / 1000 + 60,
      rateLimitType: 'Codex 5h',
      now: NOW,
    })
    expect(fiveHour?.detail).toStartWith('5h rate limit resets ')
  })

  // A provider that reports no window must not leave a gap where the label was.
  it('omits the window rather than printing an empty one', () => {
    const caption = queuedCaption([heldPrompt()], {
      isRateLimited: true,
      resetsAt: NOW / 1000 + 60,
      rateLimitType: '   ',
      now: NOW,
    })
    expect(caption?.detail).toStartWith('rate limit resets ')
  })

  // The countdown only earns its place while there is a reset to count to.
  // Once the limit lifts the queue drains one prompt per turn, so the caption
  // has to re-word from a clock to a condition — and admit the release already
  // took one, which is what "still" carries.
  it('drops the clock and says "still queued" once the limit lifts', () => {
    const caption = queuedCaption([heldPrompt()], {
      isRateLimited: false,
      resetsAt: NOW / 1000 - 10,
      now: NOW,
    })
    expect(caption?.label).toBe('1 still queued')
    expect(caption?.detail).toBe('runs when this turn ends')
    expect(caption?.clock).toBe('')
    // Nothing to release — the limit is already gone.
    expect(caption?.canSendNow).toBe(false)
  })

  it('offers no clock for a queue that a busy turn is holding, not a limit', () => {
    const caption = queuedCaption([heldPrompt({ reason: 'busy' }), heldPrompt({ reason: 'busy' })], {
      isRateLimited: false,
      now: NOW,
    })
    expect(caption).toEqual({
      label: '2 queued',
      detail: 'runs when this turn ends',
      clock: '',
      canSendNow: false,
    })
  })

  // A steer is one message being delivered, not a queue waiting on something.
  it('names a lone steer instead of counting it', () => {
    const caption = queuedCaption([heldPrompt({ state: 'steering', reason: undefined })], {
      isRateLimited: false,
      now: NOW,
    })
    expect(caption?.label).toBe('Steering')
    expect(caption?.detail).toBe('')
  })

  it('has nothing to say when nothing is held', () => {
    expect(queuedCaption([], { isRateLimited: true, resetsAt: NOW / 1000 + 60, now: NOW })).toBeNull()
  })

  // A live limit with no reset time can't be counted against, so the caption
  // must fall back to the condition rather than print a zeroed clock.
  it('falls back to the condition when the reset time is unknown', () => {
    const caption = queuedCaption([heldPrompt()], { isRateLimited: true, now: NOW })
    expect(caption?.clock).toBe('')
    expect(caption?.detail).toBe('runs when this turn ends')
  })
})

describe('formatLimitWindow', () => {
  // Providers name their windows for their own plumbing. Whatever they send,
  // what reaches the transcript has to be the duration a person would say.
  it('reduces every provider spelling to the same spoken duration', () => {
    expect(formatLimitWindow('five_hour')).toBe('5h')
    expect(formatLimitWindow('Codex 5h')).toBe('5h')
    expect(formatLimitWindow('5-hour')).toBe('5h')
    expect(formatLimitWindow('weekly')).toBe('weekly')
    expect(formatLimitWindow('seven_day')).toBe('7d')
    expect(formatLimitWindow('Codex secondary weekly')).toBe('weekly')
  })

  // The Codex normalizer emits multi-week windows as `Nw`, so a one-week window
  // has two spellings that must land on the same word.
  it('says "weekly" for a single week however it arrives, and counts the rest', () => {
    expect(formatLimitWindow('Codex secondary 1w')).toBe('weekly')
    expect(formatLimitWindow('Codex secondary 2w')).toBe('2w')
  })

  // Printing an unrecognised internal key at someone is worse than saying
  // nothing — the caption reads fine without a window, and lying is not an
  // option, so an unknown one resolves to empty.
  it('yields nothing rather than echoing a key it cannot read', () => {
    expect(formatLimitWindow('opus')).toBe('')
    expect(formatLimitWindow(undefined)).toBe('')
    expect(formatLimitWindow('   ')).toBe('')
  })
})

describe('formatClock', () => {
  it('keeps a fixed-width face so the countdown does not reflow each second', () => {
    expect(formatClock(1812)).toBe('30:12')
    expect(formatClock(9)).toBe('00:09')
    expect(formatClock(3661)).toBe('1:01:01')
    expect(formatClock(0)).toBe('00:00')
    expect(formatClock(-5)).toBe('00:00')
  })
})

describe('formatWaited', () => {
  it('states a finished wait coarsely — it is a fact, not a countdown', () => {
    expect(formatWaited(27 * 60_000)).toBe('27m')
    expect(formatWaited(64 * 60_000)).toBe('1h 4m')
    expect(formatWaited(120 * 60_000)).toBe('2h')
    expect(formatWaited(5_000)).toBe('<1m')
  })
})
