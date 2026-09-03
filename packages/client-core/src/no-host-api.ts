import type { LocalApi } from './host-api'
import { NATIVE_ONLY_SOLUS_METHODS } from './native-api-overlay'

type GeneratedApiMethod = (() => () => void) | (() => Promise<never>)

const NATIVE_ONLY_METHODS = new Set<string>(NATIVE_ONLY_SOLUS_METHODS)

export function createNoHostSolusApi(): LocalApi {
  const overrides: Partial<LocalApi> = {
    getPlatform: () => 'web',
    getPathForFile: () => '',
    setQuoteContext: () => {},
    onQuoteSelection: () => () => {},
    onAskSelectionInNewSession: () => () => {},
    openExternal: (url: string): Promise<boolean> => {
      window.open(url, '_blank', 'noopener')
      return Promise.resolve(true)
    },
  }
  const generated = new Map<string, GeneratedApiMethod>()

  const proxy = new Proxy(overrides, {
    get(target, property) {
      const propertyName = String(property)
      const override = Object.entries(target).find(([key]) => key === propertyName)?.[1]
      if (override instanceof Function) return override

      // The hostless web shell has no native bridge. Keep unsupported native
      // methods absent so workspace modules loaded during pairing do not cache
      // a false capability before the connected host API replaces this proxy.
      if (NATIVE_ONLY_METHODS.has(propertyName)) return undefined

      const cached = generated.get(propertyName)
      if (cached) return cached

      const method = propertyName.startsWith('on')
        ? () => () => {}
        // Matches WsTransport's pre-first-connect queue: activation reloads
        // the page, so pending boot work is discarded without error toasts.
        : () => new Promise<never>(() => {})
      generated.set(propertyName, method)
      return method
    },
  })
  // SAFETY: The proxy returns a callable fallback for every method that is not in `overrides`.
  return proxy as LocalApi
}
