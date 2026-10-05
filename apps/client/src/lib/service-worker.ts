/** Where this bundle is mounted; `/` on a host and on the account origin alike. */
const BASE = import.meta.env.BASE_URL

/** Registers the one service worker at the client root. A system notification
 *  falls back to it where the page cannot construct `Notification` (Android
 *  Chrome), and it routes a notification click back to an open tab. */
export function registerServiceWorker(): void {
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return
  void navigator.serviceWorker.register(`${BASE}sw.js`, { scope: BASE }).catch((error) => {
    console.warn('[solus:service-worker] registration failed', error)
  })
}
