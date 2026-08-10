import type { LocalApi } from './host-api'

/** The raw bridge is allowed only at this client-shell boundary. */
export const localApi: LocalApi = new Proxy({} as LocalApi, {
  get(_target, property) {
    if (typeof window === 'undefined') return undefined
    return window.solus[property as keyof typeof window.solus]
  },
})
