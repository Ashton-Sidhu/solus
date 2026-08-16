/**
 * The wakeup taxonomy (dispatch-client step 3): one owner of the window's
 * `online`/`visibilitychange` events, classifying each before any supervisor
 * acts on it. Two signals exist:
 *
 * - `resume` — visibility returned after a meaningful suspension (the mobile
 *   background case). The only wake that may reset a retry ladder.
 * - `activation` — everything else: a tab switch, a brief occlusion, the
 *   network stack announcing itself. Never resets a ladder; a supervisor may
 *   at most pull an already-scheduled dial forward.
 */

export type WakeSignal = 'resume' | 'activation'

export const MEANINGFUL_SUSPENSION_MS = 30_000

type WakeListener = (signal: WakeSignal) => void

const listeners = new Set<WakeListener>()
let installed = false
let hiddenAt: number | null = null

function emit(signal: WakeSignal): void {
  for (const listener of listeners) listener(signal)
}

function installWindowListeners(): void {
  if (installed || !('window' in globalThis)) return
  if (typeof window.addEventListener !== 'function') return
  installed = true
  window.addEventListener('online', () => emit('activation'))
  if ('document' in globalThis) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now()
        return
      }
      const suspendedMs = hiddenAt === null ? 0 : Date.now() - hiddenAt
      hiddenAt = null
      emit(suspendedMs >= MEANINGFUL_SUSPENSION_MS ? 'resume' : 'activation')
    })
  }
}

export function onWakeSignal(listener: WakeListener): () => void {
  installWindowListeners()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Test seam: classify a visibility return without a real document. */
export function classifyVisibilityReturn(suspendedMs: number): WakeSignal {
  return suspendedMs >= MEANINGFUL_SUSPENSION_MS ? 'resume' : 'activation'
}
