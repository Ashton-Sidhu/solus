import { localApi } from '@solus/client-core/local-api'

/** Client-shell state only: never sends device badges to a remote host. */
export function createActivityBadge(): (sessionKeys: string[]) => void {
  let favicon: HTMLLinkElement | null = null
  let previousCount = -1
  return (sessionKeys) => {
    if (localApi.setActivityBadge) {
      void localApi.setActivityBadge(sessionKeys).catch(() => {})
      return
    }
    const count = sessionKeys.length
    if (count === previousCount) return
    previousCount = count
    const update = count > 0 ? navigator.setAppBadge?.(count) : navigator.clearAppBadge?.()
    void update?.catch(() => {})
    if (count === 0) {
      favicon?.remove()
      favicon = null
      return
    }
    if (!favicon) {
      favicon = document.createElement('link')
      favicon.rel = 'icon'
      favicon.type = 'image/svg+xml'
      document.head.appendChild(favicon)
    }
    const label = count > 99 ? '99+' : String(count)
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#b42318"/><text x="16" y="22" text-anchor="middle" font-family="sans-serif" font-size="18" font-weight="bold" fill="white">${label}</text></svg>`
    favicon.href = `data:image/svg+xml,${encodeURIComponent(svg)}`
  }
}
