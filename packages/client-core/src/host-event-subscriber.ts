import { isHostEvent, type HostEvent, type HostEventMap, type HostEventName } from '@solus/contracts/host-events'

type HostEventListener<K extends HostEventName> = (
  payload: HostEventMap[K],
  event: HostEvent<K>,
) => void
type HostEventDispatch = (event: HostEvent) => void

/** Typed event subscriptions belonging to exactly one ServerConnection. */
export class HostEventSubscriber {
  private readonly listeners = new Map<HostEventName, Set<HostEventDispatch>>()

  subscribe<K extends HostEventName>(type: K, listener: HostEventListener<K>): () => void {
    let listeners = this.listeners.get(type)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(type, listeners)
    }
    const dispatch: HostEventDispatch = (event) => {
      if (event.type !== type) return
      // SAFETY: The runtime discriminant check above proves this event matches the subscription's type parameter.
      const typedEvent = event as HostEvent<K>
      listener(typedEvent.payload, typedEvent)
    }
    listeners.add(dispatch)
    return () => {
      listeners!.delete(dispatch)
      if (listeners!.size === 0) this.listeners.delete(type)
    }
  }

  receive(value: Parameters<typeof isHostEvent>[0]): void {
    if (!isHostEvent(value)) {
      console.warn('[solus:events] ignored malformed host event', value)
      return
    }
    const listeners = this.listeners.get(value.type)
    if (!listeners) return
    for (const listener of Array.from(listeners)) {
      try {
        listener(value)
      } catch (error) {
        console.error('[solus:events] subscriber threw', error)
      }
    }
  }

  clear(): void {
    this.listeners.clear()
  }
}
