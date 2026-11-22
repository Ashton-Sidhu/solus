import type { LocalApi } from './host-api'

/** The raw bridge is allowed only at this client-shell boundary. */
export const localApi: LocalApi = new Proxy(
  // SAFETY: The get trap handles every LocalApi read, so the stable proxy target needs no properties.
  {} as LocalApi,
  {
    get(_target, property) {
      // SAFETY: Proxy reads originate from the LocalApi contract, so each property is a LocalApi key.
      const key = property as keyof LocalApi
      const clientWindow = globalThis.window as (Window & {
        solus?: LocalApi
        solusNative?: Pick<LocalApi, 'getPlatform'>
      }) | undefined
      // Desktop creates its first connection before it installs `window.solus`.
      // The preload bridge already knows the client platform at that point.
      if (key === 'getPlatform' && !clientWindow?.solus?.getPlatform) return clientWindow?.solusNative?.getPlatform
      return clientWindow?.solus?.[key]
    },
  },
)
