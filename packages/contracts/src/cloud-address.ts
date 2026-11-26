/**
 * The Solus Cloud address: the origin of the control plane that a client signs in
 * to (docs/solus-cloud-address.md). The hosted one is the
 * default; an organization that hosts its own control plane gives its people
 * another one. The address is a choice of one device. It is not a host setting and
 * not a personal setting, and a client never sends it to a host as configuration.
 */

/** The hosted control plane. */
export const DEFAULT_CLOUD_ORIGIN = 'https://app.solus.sh'

/** Why a typed address is not a Solus Cloud address. */
export type CloudAddressRefusal = 'empty' | 'not-a-url' | 'not-https' | 'has-credentials' | 'has-path'

export type CloudAddressParse =
  | { ok: true; origin: string }
  | { ok: false; refusal: CloudAddressRefusal }

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Reads a typed address as an origin. The rule is the same on every client: `https:`
 * only, and `http:` only for this device itself (`localhost`, `127.0.0.1`, `[::1]`);
 * no user name or password; nothing after the host and port. An address with no
 * scheme is read as `https:`.
 */
export function parseCloudAddress(input: string): CloudAddressParse {
  const text = input.trim()
  if (!text) return { ok: false, refusal: 'empty' }
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return { ok: false, refusal: 'not-a-url' }
  }
  if (!url.hostname) return { ok: false, refusal: 'not-a-url' }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname))) {
    return { ok: false, refusal: 'not-https' }
  }
  if (url.username || url.password) return { ok: false, refusal: 'has-credentials' }
  if (url.pathname !== '/' || url.search || url.hash) return { ok: false, refusal: 'has-path' }
  return { ok: true, origin: url.origin }
}

/** The line a client shows under the field when it refuses an address. */
export function cloudAddressRefusalText(refusal: CloudAddressRefusal): string {
  switch (refusal) {
    case 'empty':
      return 'Enter the address of your Solus Cloud, for example https://solus.example.com.'
    case 'not-a-url':
      return 'This is not an address. Enter one like https://solus.example.com.'
    case 'not-https':
      return 'The address must start with https://. Only an address on this device (localhost) can use http://.'
    case 'has-credentials':
      return 'Remove the user name and password from the address.'
    case 'has-path':
      return 'Enter only the address, with nothing after it, for example https://solus.example.com.'
  }
}

/** The line a client shows when a sign-in could not read the control plane at this address. */
export function cloudUnreachableText(origin: string): string {
  return `Could not reach Solus Cloud at ${origin.replace(/^https?:\/\//, '')}. Check the address and your connection, then try again.`
}

/** What chose the address: the hosted default, this device's setting, or the environment of the process. */
export type CloudAddressSource = 'default' | 'setting' | 'environment'

/** The Solus Cloud address a device signs in to, and what chose it. */
export interface CloudAddressState {
  origin: string
  /** `environment`: `SOLUS_CLOUD_URL` chose it, and the setting cannot change it. */
  source: CloudAddressSource
}

/**
 * The address in effect: the environment (development and staging) before this
 * device's setting, and the setting before the hosted default. An environment value
 * that is not an address is the developer's mistake and throws; a stored setting that
 * is not one is ignored.
 */
export function resolveCloudAddress(sources: { environment?: string | null; setting?: string | null }): CloudAddressState {
  const environment = sources.environment?.trim()
  if (environment) {
    const parsed = parseCloudAddress(environment)
    if (!parsed.ok) throw new Error(`SOLUS_CLOUD_URL is not a Solus Cloud address. ${cloudAddressRefusalText(parsed.refusal)}`)
    return { origin: parsed.origin, source: 'environment' }
  }
  const setting = sources.setting ? parseCloudAddress(sources.setting) : null
  if (setting?.ok && setting.origin !== DEFAULT_CLOUD_ORIGIN) return { origin: setting.origin, source: 'setting' }
  return { origin: DEFAULT_CLOUD_ORIGIN, source: 'default' }
}

/** Why a change of this device's address did not happen. */
export type CloudAddressChangeRefusal =
  | CloudAddressRefusal
  /** A sign-in is held or runs: the address can change only while signed out. */
  | 'signed-in'
  /** The environment chose the address. */
  | 'environment'
  /** This device could not keep the choice. */
  | 'not-saved'

export type CloudAddressChange =
  | { ok: true; address: CloudAddressState }
  | { ok: false; refusal: CloudAddressChangeRefusal }

/** The line a client shows when the address cannot change, or did not. */
export function cloudAddressChangeRefusalText(refusal: CloudAddressChangeRefusal): string {
  switch (refusal) {
    case 'signed-in':
      return 'Sign out to change the address.'
    case 'environment':
      return 'The SOLUS_CLOUD_URL environment variable sets this address. Start Solus without it to change the address here.'
    case 'not-saved':
      return 'This device could not save the address. Try again.'
    default:
      return cloudAddressRefusalText(refusal)
  }
}
