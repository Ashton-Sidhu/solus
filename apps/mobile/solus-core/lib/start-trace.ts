/**
 * The steps of one app start and when each one ended, in milliseconds after
 * this module loaded. Only a build made with `EXPO_PUBLIC_SOLUS_START_TRACE=1`
 * records them; it keeps the last start on the device under
 * `START_TRACE_KEY`, so a person can read it after a launch. It names no
 * session or host.
 */
const enabled = process.env.EXPO_PUBLIC_SOLUS_START_TRACE === '1'
const loadedAt = Date.now()
/** `performance.now()` when this module loaded: on React Native, the time since the runtime started. */
const runtimeAge = Math.round(performance.now())
const steps: Array<[step: string, ms: number]> = []
let write: ((value: string) => void) | null = null

export const START_TRACE_KEY = 'solus.mobile.startTrace'

const snapshot = () => JSON.stringify({ loadedAt, runtimeAge, steps })

/** One step of the start ended. */
export function markStart(step: string): void {
  if (!enabled) return
  steps.push([step, Date.now() - loadedAt])
  write?.(snapshot())
}

/** Where the trace is kept: each later step writes it again. */
export function keepStartTrace(store: (value: string) => void): void {
  if (!enabled) return
  write = store
  store(snapshot())
}
