import type { LocalApi } from './host-api'

/** The raw bridge is allowed only at this client-shell boundary. */
export const localApi: LocalApi = new Proxy(
  // SAFETY: The get trap handles every LocalApi read, so the stable proxy target needs no properties.
  {} as LocalApi,
  {
    get(_target, property) {
      // SAFETY: Proxy reads originate from the LocalApi contract, so each property is a LocalApi key.
      const key = property as keyof LocalApi
      return globalThis.window.solus[key]
    },
  },
)
