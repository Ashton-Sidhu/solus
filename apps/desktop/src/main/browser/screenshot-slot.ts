/**
 * One surface copy in flight per guest.
 *
 * Chromium below 157 crashes the whole app when a guest's renderer exits while
 * a screenshot copy is in flight (crbug.com/567321049). Overlapping copies make
 * that far likelier, and a capture its caller gave up on stays pending inside
 * Chromium, because a CDP command cannot be cancelled. So each guest gets one
 * copy at a time, and later ones wait for it.
 *
 * A timeout rejects its caller but keeps the slot until the copy itself
 * settles. A copy still pending when the guest commits a new document can stay
 * unanswered for good, so a new document, or the guest going away, frees the
 * slot too. A capture whose caller gave up while it waited is never sent.
 *
 * The slot belongs to the guest, not to a driver: a guest that is attached
 * again (DevTools, a pane that moved) can still hold a copy the old driver sent.
 */

/** The guest events a slot listens to. */
export interface ScreenshotGuest {
  isDestroyed(): boolean
  on(event: 'did-navigate' | 'destroyed', listener: () => void): void
}

interface ScreenshotSlot {
  /** The copy that holds the slot. Compared by identity, so a copy that a new
   *  document already passed over cannot free the slot of the next one. */
  holder: object | null
  readonly waiting: (() => void)[]
}

const slots = new WeakMap<ScreenshotGuest, ScreenshotSlot>()

function slotFor(guest: ScreenshotGuest): ScreenshotSlot {
  const existing = slots.get(guest)
  if (existing) return existing
  const slot: ScreenshotSlot = { holder: null, waiting: [] }
  const passOver = (): void => {
    if (slot.holder !== null) passTurn(slot)
  }
  guest.on('did-navigate', passOver)
  guest.on('destroyed', () => {
    // Every waiting capture starts and fails at once on the destroyed guest.
    slot.holder = null
    for (const start of slot.waiting.splice(0)) start()
  })
  slots.set(guest, slot)
  return slot
}

function passTurn(slot: ScreenshotSlot): void {
  slot.holder = null
  slot.waiting.shift()?.()
}

/**
 * Run `copy` when the guest has no other copy in flight. Rejects after
 * `timeoutMs`, counted from the call, whether the capture waited or ran.
 */
export function captureInTurn<T>(
  guest: ScreenshotGuest,
  method: string,
  timeoutMs: number,
  copy: () => Promise<T>,
): Promise<T> {
  const slot = slotFor(guest)
  return new Promise<T>((resolve, reject) => {
    let gaveUp = false
    const timer = setTimeout(() => {
      gaveUp = true
      reject(new Error(`The browser guest did not answer ${method} within ${timeoutMs}ms.`))
    }, timeoutMs)

    const start = (): void => {
      if (gaveUp) {
        passTurn(slot)
        return
      }
      if (guest.isDestroyed()) {
        clearTimeout(timer)
        reject(new Error('The browser guest went away before it could be captured.'))
        passTurn(slot)
        return
      }
      const holder = {}
      slot.holder = holder
      let pending: Promise<T>
      try {
        pending = copy()
      } catch (error) {
        pending = Promise.reject(error)
      }
      pending
        .finally(() => {
          clearTimeout(timer)
          if (slot.holder === holder) passTurn(slot)
        })
        .then(resolve, reject)
    }

    if (slot.holder === null) start()
    else slot.waiting.push(start)
  })
}
