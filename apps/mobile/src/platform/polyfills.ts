/**
 * Shared Solus code calls `AbortSignal.timeout`, a web platform static that
 * React Native's AbortSignal may lack. This adds only that method, only where
 * it is missing; it is not a DOM shim.
 */
if (!Reflect.has(AbortSignal, 'timeout')) {
  Reflect.set(AbortSignal, 'timeout', (ms: number): AbortSignal => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('The operation timed out.')), ms)
    return controller.signal
  })
}
