export type CloudOriginKind = 'unknown' | 'signed-in' | 'signed-out' | 'not-cloud'

class CloudOriginState {
  kind = $state<CloudOriginKind>('unknown')

  /** The website's sign-in page, returning to this client afterwards. */
  get signInUrl(): string {
    return this.signInUrlReturningTo(import.meta.env.BASE_URL)
  }

  /** The same door, returning to one page of this client — an organization's tasks, say. */
  signInUrlReturningTo(next: string): string {
    return `${location.origin}/sign-in?next=${encodeURIComponent(next)}`
  }
}

export const cloudOrigin = new CloudOriginState()
