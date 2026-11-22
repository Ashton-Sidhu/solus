/** The subscribe half of `useSyncExternalStore`, shared by the native stores. */
export class Listeners {
  private readonly listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  notify(): void {
    // A snapshot: a listener that subscribes during notify waits for the next one.
    for (const listener of Array.from(this.listeners)) listener()
  }
}
