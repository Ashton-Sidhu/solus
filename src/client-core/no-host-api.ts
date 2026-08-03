import type { SolusAPI } from '../preload'

type ApiMethod = (...args: unknown[]) => unknown

export function createNoHostSolusApi(): SolusAPI {
  const overrides: Record<string, unknown> = {
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
  const generated = new Map<string, ApiMethod>()

  return new Proxy(overrides, {
    get(target, property) {
      if (typeof property !== 'string') return Reflect.get(target, property)
      const override = target[property]
      if (typeof override === 'function') return override

      const cached = generated.get(property)
      if (cached) return cached

      const method = property.startsWith('on')
        ? () => () => {}
        // Matches WsTransport's pre-first-connect queue: activation reloads
        // the page, so pending boot work is discarded without error toasts.
        : () => new Promise<never>(() => {})
      generated.set(property, method)
      return method
    },
  }) as unknown as SolusAPI
}
