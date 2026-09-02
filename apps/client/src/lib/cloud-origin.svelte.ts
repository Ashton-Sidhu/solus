/**
 * What the boot probe learned about the origin serving this client (decision U8):
 * the Solus account origin serves the bundle under `/app/`, and there the account
 * cookie is the way into the host directory. Anywhere else this stays `not-cloud`.
 */
export type CloudOriginKind = 'unknown' | 'signed-in' | 'signed-out' | 'not-cloud'

class CloudOriginState {
  kind = $state<CloudOriginKind>('unknown')

  /** The website's sign-in page, returning to this client afterwards. */
  get signInUrl(): string {
    return `${location.origin}/sign-in?next=${encodeURIComponent(import.meta.env.BASE_URL)}`
  }
}

export const cloudOrigin = new CloudOriginState()
