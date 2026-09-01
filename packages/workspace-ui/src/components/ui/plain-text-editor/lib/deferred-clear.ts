interface DeferredClearOptions {
  readValue: () => string
  clear: () => void
  requestFrame: (callback: FrameRequestCallback) => number
  now: () => number
  durationMs?: number
}

/**
 * Keep a programmatically cleared editor empty while a mobile composition can
 * still restore the text that was present before the clear.
 *
 * The guard only removes that exact value and expires quickly. New text with a
 * different value is never changed.
 */
export function guardDeferredCompositionClear({
  readValue,
  clear,
  requestFrame,
  now,
  durationMs = 250,
}: DeferredClearOptions): () => void {
  const removedValue = readValue()
  clear()
  if (!removedValue) return () => {}

  const deadline = now() + durationMs
  let isCancelled = false

  const reassertClear = () => {
    if (isCancelled) return
    if (readValue() === removedValue) clear()
    if (now() < deadline) requestFrame(reassertClear)
  }

  requestFrame(reassertClear)
  return () => {
    isCancelled = true
  }
}
