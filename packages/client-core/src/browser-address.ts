/** What a person types in a browser address bar, as every client reads it (desktop, web, and mobile). */

/**
 * Schemes that never name a page. Each is listed because a digit after it reads
 * as a port (`tel:5551234`) or because it must not run (`javascript://`).
 * `about:blank` is here too: it is the guest's mount scaffolding, its report is
 * dropped, and a page sent there would stay loading.
 */
const NON_WEB_SCHEME = /^(?:about|blob|data|javascript|mailto|sms|tel|vbscript|view-source):/i

/**
 * Why a typed address cannot open, or null when it can.
 *
 * `mailto:alice@example.com` would otherwise gain `https://` and open
 * example.com with `mailto` and `alice` as credentials. `localhost:3000` and
 * `example.com:8080` look like schemes too; the port is what clears them.
 */
export function addressProblem(input: string): string | null {
  const address = input.trim()
  const scheme = /^[a-z][a-z\d+.-]*:/i.exec(address)?.[0]
  if (!scheme) return null
  const rest = address.slice(scheme.length)
  const isWeb = !NON_WEB_SCHEME.test(scheme) && /^(?:\/\/|\d*(?:[/?#]|$))/.test(rest)
  return isWeb ? null : `${scheme} is not a web address.`
}

/**
 * Turn what a person types into an address Electron can navigate to.
 *
 * Chromium's address bar accepts `twitter.com`; `WebContents.loadURL` does not
 * and rejects it as an invalid URL. Public hosts default to HTTPS. Loopback
 * hosts default to HTTP because that is where local dev servers normally live.
 */
export function navigableAddress(input: string): string {
  const address = input.trim()
  if (!address || /^[a-z][a-z\d+.-]*:\/\//i.test(address)) return address
  const loopback = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(address)
  return `${loopback ? 'http' : 'https'}://${address}`
}
