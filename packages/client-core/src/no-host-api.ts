import type { LocalApi } from './host-api'

type GeneratedApiMethod = (() => () => void) | (() => Promise<never>)

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
