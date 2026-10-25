import { lookUpHost, type BridgeMachine } from './pairing-bridge'

const LOOKUP_DEBOUNCE_MS = 300

/**
 * The host behind the address a pairing form holds, read as it is typed or
 * pasted, so the person sees which machine they are about to pair with before
 * they press Pair. Call during component setup; `host` is null until the read
 * for the current address lands.
 */
export interface HostLookup {
  readonly host: BridgeMachine | null
}

export function useHostLookup(targetUrl: () => string): HostLookup {
  let lookup = $state<{ url: string; host: BridgeMachine } | null>(null)

  $effect(() => {
    const url = targetUrl()
    if (!url) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void lookUpHost(url, controller.signal).then((host) => {
        if (!controller.signal.aborted) lookup = { url, host }
      })
    }, LOOKUP_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  })

  return {
    get host() {
      return lookup && lookup.url === targetUrl() ? lookup.host : null
    },
  }
}
