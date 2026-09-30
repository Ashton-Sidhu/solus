/**
 * When this client tells a host that its person is typing
 * (docs/plans/multiplayer-presence.md). The first keystroke after a pause is
 * reported at once, and a keystroke is reported again only when the last report
 * is `TYPING_REPEAT_MS` old, so a burst of typing costs one message per interval.
 * The host clears the mark when the reports stop (`TYPING_EXPIRY_MS` in the
 * presence manager), so this side sends a stop only when typing ends on
 * purpose: the prompt was sent or cleared, or the bar left the session.
 */

/** How often a keystroke is reported again while the person keeps typing; shorter than the host's expiry. */
export const TYPING_REPEAT_MS = 3_000

export class TypingReporter {
  /** Room key → when this client last reported typing there. */
  private readonly lastReportedAt = new Map<string, number>()

  constructor(
    private readonly send: (key: string, isTyping: boolean) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** A keystroke in the room: report it when this is a new burst or the last report is due again. */
  keystroke(key: string): void {
    const at = this.now()
    const last = this.lastReportedAt.get(key)
    if (last !== undefined && at - last < TYPING_REPEAT_MS) return
    this.lastReportedAt.set(key, at)
    this.send(key, true)
  }

  /** Typing ended on purpose; nothing is sent when the room never heard a start. */
  stop(key: string): void {
    if (!this.lastReportedAt.delete(key)) return
    this.send(key, false)
  }

  /** Forget every room without sending, for a client that stops listening. */
  clear(): void {
    this.lastReportedAt.clear()
  }
}
