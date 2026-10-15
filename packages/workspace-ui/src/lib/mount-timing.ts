import { onMount } from 'svelte'

/** Prefix of the measures this module writes; the session-open benchmark reads them. */
export const MOUNT_MEASURE_PREFIX = 'solus.mount.'

/** Off unless asked for: the browser keeps every measure for the life of the
 *  page, and a transcript item writes one each time it mounts. The
 *  session-open benchmark turns it on (docs/plans/session-open-performance.md). */
const isOn = (() => {
  try {
    return globalThis.localStorage?.getItem('solus.mount-timing') === '1'
  } catch {
    return false
  }
})()

/**
 * Record when a component mounted, children included: from its script running
 * to its mount callback. A mount callback runs when its whole batch has
 * mounted, so read these as spans on the open's timeline, not as costs to add.
 * Call once at the top of the component's script.
 */
export function measureMount(name: string): void {
  if (!isOn) return
  const start = performance.now()
  onMount(() => {
    performance.measure(MOUNT_MEASURE_PREFIX + name, { start, end: performance.now() })
  })
}

/** Record one step of a session open, from `start` to now. */
export function measureOpenStep(name: string, start: number): void {
  if (isOn) performance.measure(`solus.open.${name}`, { start, end: performance.now() })
}
