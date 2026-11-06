import { onMount } from 'svelte'

/** Prefix of the measures this module writes; the session-open benchmark reads them. */
export const MOUNT_MEASURE_PREFIX = 'solus.mount.'

// Temporarily always enabled while profiling cold transcript opens.

/**
 * Record when a component mounted, children included: from its script running
 * to its mount callback. A mount callback runs when its whole batch has
 * mounted, so read these as spans on the open's timeline, not as costs to add.
 * Call once at the top of the component's script.
 */
export function measureMount(name: string): void {
  const start = performance.now()
  onMount(() => {
    performance.measure(MOUNT_MEASURE_PREFIX + name, { start, end: performance.now() })
  })
}

/** Record one step of a session open, from `start` to now. */
export function measureOpenStep(name: string, start: number, detail?: { sessionId: string; tabId?: string; olderPage?: boolean; messageCount?: number }): void {
  performance.measure(`solus.open.${name}`, { start, end: performance.now(), detail })
}

/** Observe the first visible rows of this mounted transcript. Two frames give
 * a paint opportunity, not a GPU presentation timestamp. Hidden tabs do not
 * report a paint, and unmounted views cancel their pending frames. */
export function transcriptPaintProfiler(): (tabId: string) => (() => void) | undefined {
  const startedAt = performance.now()
  let painted = false
  return (tabId) => {
    if (painted) return
    let frame: number | undefined
    const stop = () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      document.removeEventListener('visibilitychange', schedule)
    }
    const schedule = () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      if (document.visibilityState !== 'visible') return
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          if (document.visibilityState !== 'visible') return
          painted = true
          performance.measure('solus.open.transcriptPaint', {
            start: startedAt, end: performance.now(), detail: { tabId },
          })
          stop()
        })
      })
    }
    document.addEventListener('visibilitychange', schedule)
    schedule()
    return stop
  }
}
